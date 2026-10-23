/* ==================================================================== */
/* 0034 — chat hot-path optimization for heavy traffic                   */
/*                                                                       */
/* Fixes the two most expensive paths without changing any signature:    */
/*                                                                       */
/* 1. list_chat_messages paged through chat_all, which materializes the  */
/*    ENTIRE conversation (multi-join + per-row reply-count/recipients   */
/*    subqueries) before applying the page limit. Every thread open,    */
/*    every "Load earlier" and every jump-back paid O(all messages).     */
/*    New chat_page() selects the ≤100 row ids from the index first,     */
/*    then enriches ONLY those rows — pagination is O(page), always.     */
/*    list_chat_messages keeps its exact signature/shape (zero client    */
/*    changes); chat_all stays for thread/pins/search readers.           */
/*                                                                       */
/* 2. chat_page honors the reader's per-conversation clear-cutoff        */
/*    (cleared_at), so cleared histories no longer have to be            */
/*    filtered on the client, and page-size stays truthful.              */
/*                                                                       */
/* 3. Missing index: conversation_members was only indexed on user_id.   */
/*    Every per-conversation member scan (list_conversations counts,     */
/*    read receipts, member checks in send/forward) had to linear-scan.  */
/* ==================================================================== */

create index if not exists conversation_members_conv_user_idx
  on public.conversation_members (conversation_id, user_id);

create index if not exists chat_messages_conv_time_id_idx
  on public.chat_messages (conversation_id, created_at desc, id desc);

create or replace function public.chat_page(
  p_conversation uuid,
  p_before timestamptz default null,
  p_limit int default 40
)
returns setof public.chat_message_shape
language sql stable security definer set search_path = public as $$
  select
    msg.id,
    msg.conversation_id,
    msg.sender_id,
    pr.username,
    coalesce(pr.display_name, 'Student'),
    pr.avatar_url,
    msg.body,
    msg.created_at,
    msg.edited_at,
    msg.deleted_at,
    msg.deleted_by,
    msg.parent_message_id,
    case
      when msg.parent_message_id is null then null
      when par.deleted_at is not null then 'Message unsent'
      else coalesce(par_pr.display_name, par_pr.username, 'Student')
    end,
    case
      when msg.parent_message_id is null or par.deleted_at is not null then null
      else coalesce(nullif(left(par.body, 96), ''), '(attachment)')
    end,
    case when msg.deleted_at is not null then '[]'::jsonb else msg.attachments end,
    case when msg.deleted_at is not null then '{}'::jsonb else msg.reactions end,
    case when msg.deleted_at is not null then null else msg.pinned_at end,
    case when msg.deleted_at is not null then 0 else (
      select count(*) from public.chat_messages r
      where r.parent_message_id = msg.id and r.deleted_at is null
    ) end,
    /* ---- shared-content preview (resolved live for the reader) ------ */
    msg.shared_kind,
    case when msg.deleted_at is not null then null else msg.shared_id end,
    case msg.shared_kind
      when 'reel'    then coalesce(nullif(left(sp.body, 80), ''), 'Reel')
      when 'post'    then coalesce(nullif(left(sp.body, 80), ''), 'Post')
      when 'profile' then coalesce(pf.display_name, 'Student')
      when 'listing' then ml.title
      when 'event'   then ev.title
      else null
    end,
    /* accent line under the title */
    case msg.shared_kind
      when 'reel'  then coalesce(pf.display_name, pf.username, 'Anonymous')
      when 'post'  then coalesce(pf.display_name, pf.username, 'Anonymous')
      when 'profile' then '@' || coalesce(pf.username, 'student')
      when 'listing' then ml.category
      when 'event'   then coalesce(ev.venue, to_char(ev.starts_at, 'DD Mon YYYY'))
      else null
    end,
    /* original creator attribution */
    case msg.shared_kind
      when 'reel'  then case when sp.is_anonymous then null else pf.display_name end
      when 'post'  then case when sp.is_anonymous then null else pf.display_name end
      when 'listing' then coalesce(ml_pr.display_name, ml_pr.username)
      when 'event'   then coalesce(ev_pr.display_name, ev_pr.username)
      else null
    end,
    case msg.shared_kind
      when 'reel'  then sp.media_urls[1]
      when 'post'  then sp.media_urls[1]
      when 'profile' then pf.avatar_url
      when 'listing' then ml.images[1]
      when 'event'   then ev.cover_url
      else null
    end,
    case msg.shared_kind
      when 'listing' then ml.slug
      when 'event'   then ev.slug
      else null
    end,
    /* is the referenced content still available for THIS reader? */
    case msg.shared_kind
      when 'reel'  then sp.is_published
      when 'post'  then sp.is_published
      when 'profile' then coalesce(not pf.is_private or pf.id = auth.uid(), false)
      when 'listing' then ml.status = 'active' and ml.moderation_status = 'clean'
      when 'event'   then coalesce(ev.published, true)
      else false
    end,
    /* ---- read receipts: did (someone else in this chat) read it? ---- */
    case when msg.sender_id is not null then (
      select max(m2.last_read_at) from public.conversation_members m2
      where m2.conversation_id = msg.conversation_id
        and m2.user_id <> msg.sender_id
    ) end,
    case when msg.sender_id is not null then (
      select count(*) from public.conversation_members m2
      where m2.conversation_id = msg.conversation_id
        and m2.user_id <> msg.sender_id
        and m2.last_read_at >= msg.created_at
    ) else 0 end
  from public.chat_messages msg
  left join public.profiles pr on pr.id = msg.sender_id
  left join public.chat_messages par on par.id = msg.parent_message_id
  left join public.profiles par_pr on par_pr.id = par.sender_id
  /* shared-content joins — all keyed so the plain path stays cheap */
  left join public.posts sp
    on msg.shared_kind in ('reel', 'post') and sp.id = msg.shared_id
  left join public.profiles pf on pf.id = case
    when msg.shared_kind in ('reel', 'post') then sp.author_id
    when msg.shared_kind = 'profile' then msg.shared_id
  end
  left join public.marketplace_listings ml
    on msg.shared_kind = 'listing' and ml.id = msg.shared_id
  left join public.profiles ml_pr on ml_pr.id = ml.owner_id
  left join public.events ev
    on msg.shared_kind = 'event' and ev.id = msg.shared_id
  left join public.profiles ev_pr on ev_pr.id = ev.created_by
  where msg.conversation_id = p_conversation
    -- member gate (same semantics as chat_all)
    and auth.uid() in (
      select user_id from public.conversation_members
      where conversation_id = p_conversation
    )
    -- the reader's own clear-cutoff hides their older history
    and msg.created_at > coalesce(
      (select cm.cleared_at from public.conversation_members cm
       where cm.conversation_id = p_conversation
         and cm.user_id = auth.uid()),
      '-infinity'::timestamptz)
    -- bounded page: ids resolved in the index, enrichment only for these rows
    and msg.id in (
      select c2.id
      from public.chat_messages c2
      where c2.conversation_id = p_conversation
        and (p_before is null or c2.created_at < p_before)
        and c2.created_at > coalesce(
          (select cm.cleared_at from public.conversation_members cm
           where cm.conversation_id = p_conversation
             and cm.user_id = auth.uid()),
          '-infinity'::timestamptz)
      order by c2.created_at desc, c2.id desc
      limit greatest(least(coalesce(p_limit, 40), 100), 1)
    )
  order by msg.created_at desc, msg.id desc
$$;

revoke all on function public.chat_page(uuid, timestamptz, int) from public;

-- the paginated reader keeps its exact signature; internals now bounded
drop function if exists public.list_chat_messages(uuid, int, timestamptz);
create or replace function public.list_chat_messages(
  p_conversation uuid,
  p_limit int default 40,
  p_before timestamptz default null
)
returns setof public.chat_message_shape
language sql stable security definer set search_path = public as $$
  select m.* from public.chat_page(p_conversation, p_before, coalesce(p_limit, 40)) m
$$;

grant execute on function public.list_chat_messages(uuid, int, timestamptz) to authenticated;

-- sanity check
select proname, proargtypes::regtype[] as args
from pg_proc where proname in ('chat_page', 'list_chat_messages');
