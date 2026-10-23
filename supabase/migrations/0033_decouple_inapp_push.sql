/* ==================================================================== */
/* 0033 — decouple in-app visibility from push delivery                 */
/*                                                                       */
/* BUG fixed here: notify_member/create_notification gated the WHOLE     */
/* event on notif_inapp_allowed() — a member with "in-app: off" but      */
/* "browser push: on" for a category (e.g. chat messages) received       */
/* NEITHER, even though they explicitly opted into push.                 */
/*                                                                       */
/* New model:                                                            */
/*   - a notification row always exists (blocks/mutes still drop it)     */
/*   - inapp_visible = the recipient's *_inapp pref for that category    */
/*     — the bell, the list, and the unread count only see visible rows  */
/*   - push eligibility continues to read ONLY the *_push prefs          */
/*     (quiet hours, device presence unchanged)                          */
/*                                                                       */
/* In-app opt-out now means "don't show it in the app", which is what    */
/* the settings sheet promises; push keeps working as its own opt-in.    */
/* Migration is additive + idempotent; backfill keeps all existing       */
/* rows (they were only ever created under the stricter old gate).       */
/* ==================================================================== */

alter table public.notifications
  add column if not exists inapp_visible boolean not null default true;

/* ------------------------------------------------------------------ */
/* push-pref boolean helper (single source used by notify + enqueue)   */
/* ------------------------------------------------------------------ */
create or replace function public.notif_push_allowed(p_user uuid, p_cat text)
returns boolean
language sql stable security definer set search_path = public as $$
  select case p_cat
    when 'like'        then (public.notif_prefs_of(p_user)).like_push
    when 'comment'     then (public.notif_prefs_of(p_user)).comment_push
    when 'follow'      then (public.notif_prefs_of(p_user)).follow_push
    when 'mention'     then (public.notif_prefs_of(p_user)).mention_push
    when 'message'     then (public.notif_prefs_of(p_user)).message_push
    when 'community'   then (public.notif_prefs_of(p_user)).community_push
    when 'event'       then (public.notif_prefs_of(p_user)).event_push
    when 'marketplace' then (public.notif_prefs_of(p_user)).marketplace_push
    else true -- account / security notices always eligible
  end
$$;

revoke all on function public.notif_push_allowed(uuid, text) from public, anon, authenticated;

/* enqueue helper now derives push eligibility from the shared helper   */
create or replace function public.enqueue_push_for_notification(
  p_row public.notifications
)
returns void
language plpgsql security definer set search_path = public as $$
declare
  v_prefs public.notification_prefs;
  v_cat   text;
  v_payload jsonb;
begin
  v_prefs := public.notif_prefs_of(p_row.recipient_id);
  v_cat   := public.notification_category(p_row.type);
  if not public.notif_push_allowed(p_row.recipient_id, v_cat) then
    return; -- push off for this category
  end if;
  if v_prefs.quiet_enabled then
    if public.notif_is_quiet(p_row.recipient_id) then
      return;
    end if;
  end if;
  if not exists (
    select 1 from public.push_subscriptions s
    where s.user_id = p_row.recipient_id
  ) then
    return; -- nothing registered: no queue churn
  end if;
  v_payload := public.notification_push_payload(p_row);
  insert into public.push_queue (notification_id, recipient_id, payload)
  values (p_row.id, p_row.recipient_id, v_payload);
end $$;

revoke all on function public.enqueue_push_for_notification(public.notifications) from public, anon, authenticated;

/* ------------------------------------------------------------------ */
/* notify_member — create for push even when in-app is off             */
/* ------------------------------------------------------------------ */
create or replace function public.notify_member(
  p_recipient uuid,
  p_actor uuid,
  p_type text,
  p_entity_type text,
  p_entity_id uuid
)
returns void
language plpgsql security definer set search_path = public as $$
declare
  v_row public.notifications;
  v_cat text;
  v_inapp boolean;
  v_invisible boolean;
begin
  if p_recipient is null or p_recipient = p_actor then
    return;
  end if;
  if p_actor is not null and (
    exists (select 1 from public.user_blocks b
            where (b.blocker_id = p_recipient and b.blocked_id = p_actor)
               or (b.blocker_id = p_actor and b.blocked_id = p_recipient))
    or exists (select 1 from public.user_mutes m
            where (m.blocker_id = p_recipient and m.blocked_id = p_actor)
               or (m.blocker_id = p_actor and m.blocked_id = p_recipient))
  ) then
    return;
  end if;
  v_cat   := public.notification_category(p_type);
  v_inapp := public.notif_inapp_allowed(p_recipient, v_cat);
  -- neither in-app nor push wanted: drop the event entirely
  if not v_inapp and not public.notif_push_allowed(p_recipient, v_cat) then
    return;
  end if;
  v_invisible := not v_inapp; -- hidden from the bell; push still flows
  -- chat conversations honor the per-conversation mute switch too
  if p_entity_type in ('chat', 'dm_chat', 'group_chat') and exists (
    select 1 from public.conversation_members m
    where m.conversation_id = p_entity_id
      and m.user_id = p_recipient
      and m.muted
  ) then
    return;
  end if;
  -- dedupe (post-0032): one unread row per (recipient, type, entity) —
  -- bump it and re-enqueue the push
  if exists (
    select 1 from public.notifications n
    where n.recipient_id = p_recipient
      and n.type = p_type
      and n.entity_id is not distinct from p_entity_id
      and n.read_at is null
  ) then
    update public.notifications n
      set actor_id  = coalesce(p_actor, n.actor_id),
          created_at = now(),
          inapp_visible = v_inapp
      where n.recipient_id = p_recipient
        and n.type = p_type
        and n.entity_id is not distinct from p_entity_id
        and n.read_at is null
      returning * into v_row;
    perform public.enqueue_push_for_notification(v_row);
    return;
  end if;
  insert into public.notifications
    (recipient_id, actor_id, type, entity_type, entity_id, inapp_visible)
  values
    (p_recipient, p_actor, p_type, p_entity_type, p_entity_id, v_invisible);
  -- the notifications_enqueue_push trigger handles this enqueue
end $$;

revoke all on function public.notify_member(uuid, uuid, text, text, uuid) from public;

/* ------------------------------------------------------------------ */
/* create_notification — same decoupling for social/club paths         */
/* ------------------------------------------------------------------ */
create or replace function public.create_notification(
  p_recipient uuid,
  p_actor uuid,
  p_type text,
  p_entity_type text,
  p_entity_id uuid,
  p_metadata jsonb default '{}'::jsonb
)
returns uuid
language plpgsql security definer set search_path = public as $$
declare
  v_cat text;
  v_id uuid;
  v_inapp boolean;
  v_invisible boolean;
begin
  if p_recipient is null or p_recipient = p_actor then
    return null; -- never notify yourself
  end if;
  if p_actor is not null and (
    exists (select 1 from public.user_blocks b
            where b.blocker_id = p_recipient and b.blocked_id = p_actor)
    or exists (select 1 from public.user_mutes m
            where m.blocker_id = p_recipient and m.blocked_id = p_actor)
  ) then
    return null; -- blocked or muted actors never reach the bell
  end if;

  v_cat := public.notification_category(p_type);
  v_inapp := case when v_cat = 'account' then true
                  else public.notif_inapp_allowed(p_recipient, v_cat) end;

  -- neither surface wanted: drop the event entirely
  if not v_inapp and not public.notif_push_allowed(p_recipient, v_cat) then
    return null;
  end if;
  v_invisible := not v_inapp; -- push-only event, hidden from the bell

  if not exists (select 1 from public.profiles pr where pr.id = p_recipient) then
    return null; -- orphaned recipient, e.g. mid-transaction rollback fallout
  end if;

  insert into public.notifications
    (recipient_id, actor_id, type, entity_type, entity_id, metadata, inapp_visible)
  values
    (p_recipient, p_actor, p_type, p_entity_type, p_entity_id,
     coalesce(p_metadata, '{}'::jsonb), v_invisible)
  on conflict (recipient_id, type, coalesce(entity_id::text, ''), actor_id)
    where read_at is null
      and type in ('post_like', 'post_repost', 'post_comment', 'post_reply',
                   'comment_like', 'post_mention', 'follow')
  do update set created_at = now(), metadata = excluded.metadata,
                inapp_visible = excluded.inapp_visible
  returning id into v_id;

  return v_id;
end $$;

revoke all on function public.create_notification(uuid, uuid, text, text, uuid, jsonb) from public;

/* ------------------------------------------------------------------ */
/* read paths — the bell only ever sees in-app-visible rows            */
/* ------------------------------------------------------------------ */

-- inquiry list: filter hidden rows regardless of the requested tab
create or replace function public.list_notifications(
  p_filter text default 'all',
  p_limit int default 30,
  p_offset int default 0
)
returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare
  v_me uuid := auth.uid();
begin
  if v_me is null then
    return '[]'::jsonb;
  end if;
  return coalesce(
    jsonb_agg(x.r order by x.created_at desc),
    '[]'::jsonb
  )
  from (
    select jsonb_build_object(
        'id',          n.id,
        'type',        n.type,
        'entity_type', n.entity_type,
        'entity_id',   n.entity_id,
        'metadata',    n.metadata,
        'read_at',     n.read_at,
        'created_at',  n.created_at,
        'slug',        case n.entity_type
                         when 'club'    then (select c.slug from public.clubs c                 where c.id = n.entity_id)
                         when 'event'   then (select e.slug from public.events e               where e.id = n.entity_id)
                         when 'listing' then (select l.slug from public.marketplace_listings l where l.id = n.entity_id)
                         else null
                       end,
        'title',       case n.entity_type
                         when 'club'    then (select c.name  from public.clubs c                 where c.id = n.entity_id)
                         when 'event'   then (select e.title from public.events e                where e.id = n.entity_id)
                         when 'listing' then (select l.title from public.marketplace_listings l where l.id = n.entity_id)
                         else null
                       end,
        'actor',       case when pr.id is null then null else
          jsonb_build_object(
            'id', pr.id,
            'username', pr.username,
            'name', pr.display_name,
            'avatar', pr.avatar_url
          ) end
      ) as r,
      n.created_at
    from public.notifications n
    left join public.profiles pr on pr.id = n.actor_id
    where n.recipient_id = v_me
      and n.inapp_visible
      and case p_filter
            when 'unread'    then n.read_at is null
            when 'mention'   then n.type in ('post_mention', 'chat_mention')
            when 'message'   then n.type = 'chat_message'
            when 'community' then n.type in (
              'club_join_accepted', 'club_join_rejected', 'club_invitation',
              'club_role_changed', 'club_banned', 'club_removed',
              'club_ownership', 'chat_reply', 'chat_mention')
            when 'follow'    then n.type = 'follow'
            when 'event'     then n.type in (
              'event_updated', 'event_cancelled', 'event_registered', 'event_promoted')
            when 'like'      then n.type in ('post_like', 'post_repost', 'comment_like')
            when 'comment'   then n.type in ('post_comment', 'post_reply')
            else true
          end
    limit least(greatest(coalesce(p_limit, 30), 1), 50)
    offset greatest(coalesce(p_offset, 0), 0)
  ) x;
end $$;

grant execute on function public.list_notifications(text, int, int) to authenticated;

-- sanity check: every recipient row now has in-app visibility metadata
select
  count(*) filter (where not inapp_visible) as push_only_rows,
  count(*)                                  as total_rows
from public.notifications;
