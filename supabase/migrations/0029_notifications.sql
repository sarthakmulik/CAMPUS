/* ==================================================================== */
/* CAMPUS migration 0029 — notification center + push pipeline           */
/*                                                                       */
/* Upgrades the existing notifications system in place:                  */
/*   1. notifications gains dedup + metadata columns and indexes         */
/*   2. create_notification(): one trusted path honoring blocks, mutes,  */
/*      self-actions and per-category in-app preferences                 */
/*   3. notify_member() (existing 5-arg API) funnels through it          */
/*   4. Real events wired via triggers: follows, post likes, comment     */
/*      likes, comments / replies / mentions, post mentions, reposts.    */
/*      Anonymous confessions never leak their author: mention           */
/*      notifications are skipped for anonymous posts, and like/comment  */
/*      notifications only ever reach the (already self-known) author.   */
/*   5. list_notifications(): RLS-safe paged list for the center         */
/*   6. notification_prefs: per-category in-app/push, message preview,   */
/*      timezone-aware quiet hours; account/security always delivered    */
/*   7. push_subscriptions (own-row RLS) + push_queue (no client grants) */
/*      + enqueue trigger honoring push prefs + quiet hours server-side  */
/* Poll votes intentionally generate NO notifications.                   */
/* Idempotent and safe to re-run.                                        */
/* ==================================================================== */

/* ------------------------------------------------------------------ */
/* 1. notifications: display metadata + dedup support                  */
/* ------------------------------------------------------------------ */

alter table public.notifications
  add column if not exists metadata jsonb not null default '{}'::jsonb;

create index if not exists notifications_recipient_unread_idx
  on public.notifications (recipient_id, created_at desc)
  where read_at is null;

/* Repeated identical activity (like → unlike → like again while the
   earlier row is still unread) never duplicates a record: same event
   bumps the existing unread row's timestamp instead. Distinct actors
   stay distinct rows — grouping happens at read time. */
create unique index if not exists notifications_unread_event_dedup_idx
  on public.notifications (recipient_id, type, coalesce(entity_id::text, ''), actor_id)
  where read_at is null
    and type in (
      'post_like', 'post_repost', 'post_comment', 'post_reply',
      'comment_like', 'post_mention', 'follow'
    );

/* ------------------------------------------------------------------ */
/* 2. Category model + preferences                                     */
/* ------------------------------------------------------------------ */

create table if not exists public.notification_prefs (
  user_id uuid primary key references public.profiles(id) on delete cascade,
  like_inapp        boolean not null default true,
  like_push         boolean not null default false,  -- likes stay quiet
  comment_inapp     boolean not null default true,
  comment_push      boolean not null default true,
  follow_inapp      boolean not null default true,
  follow_push       boolean not null default true,
  mention_inapp     boolean not null default true,
  mention_push      boolean not null default true,
  message_inapp     boolean not null default true,
  message_push      boolean not null default true,
  community_inapp   boolean not null default true,
  community_push    boolean not null default true,
  event_inapp       boolean not null default true,
  event_push        boolean not null default true,
  marketplace_inapp boolean not null default true,
  marketplace_push  boolean not null default false,
  message_preview   boolean not null default true,
  quiet_enabled     boolean not null default false,
  quiet_start       text not null default '22:30',   -- 'HH:MM' local
  quiet_end         text not null default '07:30',
  timezone          text,                             -- IANA name
  updated_at        timestamptz not null default now()
);

alter table public.notification_prefs enable row level security;

drop policy if exists "prefs are the owner's" on public.notification_prefs;
create policy "prefs are the owner's" on public.notification_prefs
  for all to authenticated
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);

/* Missing row == factory defaults: triggers consult this helper instead
   of requiring an ensure-write on first ever notification. */
create or replace function public.notif_prefs_of(p_user uuid)
returns public.notification_prefs
language plpgsql stable security definer set search_path = public as $$
declare
  v_row public.notification_prefs;
begin
  if p_user is null then
    return null;
  end if;
  select * into v_row from public.notification_prefs where user_id = p_user;
  if not found then
    v_row := row(
      p_user, true, false, true, true, true, true, true, true,
      true, true, true, true, true, true, true, false,
      true, false, '22:30', '07:30', null, now()
    )::public.notification_prefs;
  end if;
  return v_row;
end $$;

/* Map a notification type onto its preference category. */
create or replace function public.notification_category(p_type text)
returns text
language sql immutable as $$
  select case
    when p_type in ('post_like', 'post_repost', 'comment_like') then 'like'
    when p_type in ('post_comment', 'post_reply')                  then 'comment'
    when p_type = 'follow'                                         then 'follow'
    when p_type in ('post_mention', 'chat_mention')                then 'mention'
    when p_type = 'chat_message'                                   then 'message'
    when p_type in ('chat_reply', 'club_join_accepted', 'club_join_rejected',
                    'club_invitation', 'club_role_changed', 'club_banned',
                    'club_removed', 'club_ownership')              then 'community'
    when p_type in ('event_updated', 'event_cancelled', 'event_registered',
                    'event_promoted')                              then 'event'
    when p_type in ('listing_removed', 'listing_restored')         then 'marketplace'
    else 'account'
  end
$$;

/* ------------------------------------------------------------------ */
/* 3. create_notification — the single trusted write path              */
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

  -- per-category in-app opt-out (account/security notices are always on)
  if v_cat <> 'account' and not public.notif_inapp_allowed(p_recipient, v_cat) then
    return null;
  end if;

  if not exists (select 1 from public.profiles pr where pr.id = p_recipient) then
    return null; -- orphaned recipient, e.g. mid-transaction rollback fallout
  end if;

  insert into public.notifications
    (recipient_id, actor_id, type, entity_type, entity_id, metadata)
  values
    (p_recipient, p_actor, p_type, p_entity_type, p_entity_id,
     coalesce(p_metadata, '{}'::jsonb))
  on conflict (recipient_id, type, coalesce(entity_id::text, ''), actor_id)
    where read_at is null
      and type in ('post_like', 'post_repost', 'post_comment', 'post_reply',
                   'comment_like', 'post_mention', 'follow')
  do update set created_at = now(), metadata = excluded.metadata
  returning id into v_id;

  return v_id;
end $$;

create or replace function public.notif_inapp_allowed(p_user uuid, p_cat text)
returns boolean
language sql stable security definer set search_path = public as $$
  select case p_cat
    when 'like'        then (public.notif_prefs_of(p_user)).like_inapp
    when 'comment'     then (public.notif_prefs_of(p_user)).comment_inapp
    when 'follow'      then (public.notif_prefs_of(p_user)).follow_inapp
    when 'mention'     then (public.notif_prefs_of(p_user)).mention_inapp
    when 'message'     then (public.notif_prefs_of(p_user)).message_inapp
    when 'community'   then (public.notif_prefs_of(p_user)).community_inapp
    when 'event'       then (public.notif_prefs_of(p_user)).event_inapp
    when 'marketplace' then (public.notif_prefs_of(p_user)).marketplace_inapp
    else true
  end
$$;

/* ------------------------------------------------------------------ */
/* 4. notify_member — legacy 5-arg API preserved, now gated            */
/*    (blocks, mutes, self, per-category in-app prefs); keeps its      */
/*    cross-actor "unread same type+entity" dedupe semantics so every  */
/*    existing caller keeps exact behavior.                            */
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
  if not public.notif_inapp_allowed(p_recipient, public.notification_category(p_type)) then
    return;
  end if;
  -- chat conversations honor the per-conversation mute switch too
  if p_entity_type in ('chat', 'dm_chat', 'group_chat') and exists (
    select 1 from public.conversation_members m
    where m.conversation_id = p_entity_id
      and m.user_id = p_recipient
      and m.muted
  ) then
    return;
  end if;
  -- legacy dedupe: one unread row per (recipient, type, entity) no matter
  -- which actor raised the event
  if exists (
    select 1 from public.notifications n
    where n.recipient_id = p_recipient
      and n.type = p_type
      and n.entity_id is not distinct from p_entity_id
      and n.read_at is null
  ) then
    return;
  end if;
  insert into public.notifications (recipient_id, actor_id, type, entity_type, entity_id)
  values (p_recipient, p_actor, p_type, p_entity_type, p_entity_id);
end $$;

revoke all on function public.notify_member(uuid, uuid, text, text, uuid) from public;

/* ------------------------------------------------------------------ */
/* 5. Social triggers — follows, likes, comments, mentions, reposts    */
/* ------------------------------------------------------------------ */

/* @username extraction — same pattern the club chat uses. */
create or replace function public.notification_mentioned_ids(p_body text)
returns setof uuid
language sql stable security definer set search_path = public as $$
  select distinct pr.id
  from regexp_matches(' ' || coalesce(p_body, ''),
                      '(?:^|[^a-zA-Z0-9_.@-])@([a-z0-9_]{3,20})', 'g') rm
  join public.profiles pr on lower(pr.username) = lower(rm[1])
$$;

/* Short, safe post summary for notification metadata / push bodies. */
create or replace function public.notif_post_summary(p_post uuid)
returns jsonb
language sql stable security definer set search_path = public as $$
  select coalesce(jsonb_build_object(
      'post_id', p.id,
      'kind', case when p.kind = 'reel' then 'reel' else 'post' end,
      'snippet', left(btrim(nullif(p.body, '')), 90),
      'thumb', p.media_urls[1],
      'anonymous', p.is_anonymous
    ), '{}'::jsonb)
  from public.posts p
  where p.id = p_post
$$;

-- follow
create or replace function public.notify_on_follow()
returns trigger
language plpgsql security definer set search_path = public as $$
begin
  perform public.create_notification(
    new.followed_id, new.follower_id, 'follow', 'profile', new.follower_id
  );
  return null;
end $$;

drop trigger if exists follows_notify on public.follows;
create trigger follows_notify
  after insert on public.follows
  for each row execute function public.notify_on_follow();

-- post likes (covers reels and polls — everything that lives in posts)
create or replace function public.notify_on_post_like()
returns trigger
language plpgsql security definer set search_path = public as $$
declare
  v_author uuid;
  v_kind text;
begin
  select author_id, kind into v_author, v_kind
  from public.posts where id = new.post_id;
  if v_author is null then
    return null;
  end if;
  perform public.create_notification(
    v_author, new.user_id, 'post_like', 'post', new.post_id,
    public.notif_post_summary(new.post_id) || jsonb_build_object('like_kind', v_kind)
  );
  return null;
end $$;

drop trigger if exists post_likes_notify on public.post_likes;
create trigger post_likes_notify
  after insert on public.post_likes
  for each row execute function public.notify_on_post_like();

-- comment likes
create or replace function public.notify_on_comment_like()
returns trigger
language plpgsql security definer set search_path = public as $$
declare
  v_author uuid;
  v_post uuid;
begin
  select author_id, post_id into v_author, v_post
  from public.post_comments where id = new.comment_id;
  if v_author is null then
    return null;
  end if;
  perform public.create_notification(
    v_author, new.user_id, 'comment_like', 'comment', new.comment_id,
    public.notif_post_summary(v_post) || jsonb_build_object('comment_id', new.comment_id)
  );
  return null;
end $$;

drop trigger if exists comment_likes_notify on public.comment_likes;
create trigger comment_likes_notify
  after insert on public.comment_likes
  for each row execute function public.notify_on_comment_like();

-- comments: author notification, reply notification, in-comment mentions
create or replace function public.notify_on_comment()
returns trigger
language plpgsql security definer set search_path = public as $$
declare
  v_post record;
  v_parent record;
  v_mention uuid;
  v_summary jsonb;
begin
  if new.author_id is null then
    return null;
  end if;
  select p.author_id, p.community_id, p.is_anonymous into v_post
  from public.posts p where p.id = new.post_id;
  if v_post is null then
    return null;
  end if;
  v_summary := public.notif_post_summary(new.post_id);

  -- the post author hears about the comment. For anonymous confessions
  -- only the (already public, on-thread) COMMENTER identity travels; the
  -- anonymous author's identity stays nowhere in the payload.
  if v_post.author_id is not null and v_post.author_id <> new.author_id then
    perform public.create_notification(
      v_post.author_id, new.author_id, 'post_comment', 'comment', new.id,
      v_summary || jsonb_build_object('comment_id', new.id)
    );
  end if;

  -- replies notify the parent's author — but not when they are also the
  -- post author (that person already got the row above).
  if new.parent_id is not null then
    select author_id into v_parent from public.post_comments where id = new.parent_id;
    if v_parent.author_id is not null
       and v_parent.author_id <> new.author_id
       and v_parent.author_id is distinct from v_post.author_id then
      perform public.create_notification(
        v_parent.author_id, new.author_id, 'post_reply', 'comment', new.id,
        v_summary || jsonb_build_object('comment_id', new.id, 'parent_id', new.parent_id)
      );
    end if;
  end if;

  -- @mentions inside comments; anonymous confessions NEVER produce
  -- mention notifications (mentioning people from an anonymous post
  -- would expose the author's identity).
  if not v_post.is_anonymous then
    for v_mention in
      select mm.id from public.notification_mentioned_ids(new.body) mm(id)
    loop
      continue when v_mention = new.author_id;      -- self-mention
      continue when v_mention = v_post.author_id;   -- author already notified above
      -- community posts only reach their members
      continue when v_post.community_id is not null
        and not public.is_club_active_member(v_post.community_id, v_mention);
      perform public.create_notification(
        v_mention, new.author_id, 'post_mention', 'comment', new.id,
        v_summary || jsonb_build_object('comment_id', new.id)
      );
    end loop;
  end if;
  return null;
end $$;

drop trigger if exists post_comments_notify on public.post_comments;
create trigger post_comments_notify
  after insert on public.post_comments
  for each row execute function public.notify_on_comment();

-- post-body mentions (anonymous confessions skip this entirely)
create or replace function public.notify_on_post_insert()
returns trigger
language plpgsql security definer set search_path = public as $$
declare
  v_mention uuid;
  v_summary jsonb;
begin
  if new.is_anonymous or new.author_id is null then
    return null;
  end if;
  v_summary := public.notif_post_summary(new.id);
  for v_mention in
    select mm.id from public.notification_mentioned_ids(new.body) mm(id)
  loop
    continue when v_mention = new.author_id;
    continue when new.community_id is not null
      and not public.is_club_active_member(new.community_id, v_mention);
    perform public.create_notification(
      v_mention, new.author_id, 'post_mention', 'post', new.id, v_summary
    );
  end loop;
  return null;
end $$;

drop trigger if exists posts_notify_mentions on public.posts;
create trigger posts_notify_mentions
  after insert on public.posts
  for each row execute function public.notify_on_post_insert();

-- reposts
create or replace function public.notify_on_repost()
returns trigger
language plpgsql security definer set search_path = public as $$
declare
  v_author uuid;
begin
  select author_id into v_author from public.posts where id = new.post_id;
  if v_author is null then
    return null;
  end if;
  perform public.create_notification(
    v_author, new.user_id, 'post_repost', 'post', new.post_id,
    public.notif_post_summary(new.post_id)
  );
  return null;
end $$;

drop trigger if exists post_reposts_notify on public.post_reposts;
create trigger post_reposts_notify
  after insert on public.post_reposts
  for each row execute function public.notify_on_repost();

/* ------------------------------------------------------------------ */
/* 6. list_notifications — paged, filtered, RLS-safe                   */
/* ------------------------------------------------------------------ */

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
                         when 'club'    then (select c.slug from public.clubs c   where c.id = n.entity_id)
                         when 'event'   then (select e.slug from public.events e where e.id = n.entity_id)
                         when 'listing' then (select l.slug from public.marketplace_listings l where l.id = n.entity_id)
                         else null
                       end,
        'title',       case n.entity_type
                         when 'club'    then (select c.name  from public.clubs c   where c.id = n.entity_id)
                         when 'event'   then (select e.title from public.events e where e.id = n.entity_id)
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

/* ------------------------------------------------------------------ */
/* 7. Preference RPCs                                                  */
/* ------------------------------------------------------------------ */

create or replace function public.ensure_notification_prefs()
returns public.notification_prefs
language plpgsql security definer set search_path = public as $$
declare
  v_me  uuid := auth.uid();
  v_row public.notification_prefs;
begin
  if v_me is null then
    raise exception 'Sign in to manage notification settings.';
  end if;
  insert into public.notification_prefs (user_id) values (v_me)
  on conflict (user_id) do nothing;
  select * into v_row from public.notification_prefs where user_id = v_me;
  return v_row;
end $$;

-- merge a whitelist of columns; returns the stored row
create or replace function public.update_notification_prefs(p_update jsonb)
returns public.notification_prefs
language plpgsql security definer set search_path = public as $$
declare
  v_me  uuid := auth.uid();
  v_key  text;
  v_val  jsonb;
  v_row  public.notification_prefs;
begin
  if v_me is null then
    raise exception 'Sign in to manage notification settings.';
  end if;
  insert into public.notification_prefs (user_id) values (v_me)
  on conflict (user_id) do nothing;

  for v_key, v_val in select * from jsonb_each(coalesce(p_update, '{}'::jsonb))
  loop
    if v_key in (
      'like_inapp','like_push','comment_inapp','comment_push',
      'follow_inapp','follow_push','mention_inapp','mention_push',
      'message_inapp','message_push','community_inapp','community_push',
      'event_inapp','event_push','marketplace_inapp','marketplace_push',
      'message_preview','quiet_enabled'
    ) then
      if jsonb_typeof(v_val) is distinct from 'boolean' then
        raise exception 'Setting % must be true or false.', v_key;
      end if;
      execute format('update public.notification_prefs set %I = %s, updated_at = now() where user_id = %L',
                     v_key, v_val::text, v_me);
    elsif v_key = 'quiet_start' or v_key = 'quiet_end' then
      if jsonb_typeof(v_val) is distinct from 'string'
         or (v_val #>> '{}') !~ '^\d{2}:\d{2}$'
         or split_part(v_val #>> '{}', ':', 1)::int > 23
         or split_part(v_val #>> '{}', ':', 2)::int > 59 then
        raise exception 'Quiet-hours time must be a valid HH:MM value.';
      end if;
      execute format('update public.notification_prefs set %I = %L, updated_at = now() where user_id = %L',
                     v_key, v_val #>> '{}', v_me);
    elsif v_key = 'timezone' then
      if jsonb_typeof(v_val) = 'null' then
        update public.notification_prefs
          set timezone = null, updated_at = now()
        where user_id = v_me;
      elsif jsonb_typeof(v_val) is distinct from 'string'
            or (select count(*) from pg_timezone_names
                where lower(name) = lower(v_val #>> '{}')) = 0 then
        raise exception 'That timezone is not valid.';
      else
        update public.notification_prefs
          set timezone = v_val #>> '{}', updated_at = now()
        where user_id = v_me;
      end if;
    else
      raise exception 'Unknown notification setting: %', v_key;
    end if;
  end loop;

  select * into v_row from public.notification_prefs where user_id = v_me;
  return v_row;
end $$;

/* ------------------------------------------------------------------ */
/* 8. Push subscriptions (own-row RLS; RPCs keep devices portable)     */
/* ------------------------------------------------------------------ */

create table if not exists public.push_subscriptions (
  id         uuid primary key default gen_random_uuid(),
  user_id    uuid not null references public.profiles(id) on delete cascade,
  endpoint   text not null unique,
  p256dh     text not null,
  auth_key   text not null,
  user_agent text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists push_subscriptions_user_idx
  on public.push_subscriptions (user_id);

alter table public.push_subscriptions enable row level security;

drop policy if exists "own push subscriptions" on public.push_subscriptions;
create policy "own push subscriptions" on public.push_subscriptions
  for all to authenticated
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);

/* A browser endpoint can only ever map to the signed-in owner: when a
   device re-subscribes under a new account, the old row is dropped at
   the same instant — account switching can never inherit devices. */
create or replace function public.save_push_subscription(
  p_endpoint text,
  p_p256dh text,
  p_auth text,
  p_user_agent text default null
)
returns uuid
language plpgsql security definer set search_path = public as $$
declare
  v_me uuid := auth.uid();
  v_id uuid;
begin
  if v_me is null then
    raise exception 'Sign in to enable notifications.';
  end if;
  if coalesce(p_endpoint, '') = '' or coalesce(p_p256dh, '') = '' or coalesce(p_auth, '') = '' then
    raise exception 'That subscription is incomplete.';
  end if;
  delete from public.push_subscriptions where endpoint = p_endpoint and user_id <> v_me;
  insert into public.push_subscriptions (user_id, endpoint, p256dh, auth_key, user_agent)
  values (v_me, p_endpoint, p_p256dh, p_auth, p_user_agent)
  on conflict (endpoint) do update
    set user_id = excluded.user_id,
        p256dh = excluded.p256dh,
        auth_key = excluded.auth_key,
        user_agent = excluded.user_agent,
        updated_at = now()
  returning id into v_id;
  return v_id;
end $$;

create or replace function public.remove_push_subscription(p_endpoint text)
returns void
language sql security definer set search_path = public as $$
  delete from public.push_subscriptions
  where user_id = auth.uid() and endpoint = p_endpoint
$$;

/* ------------------------------------------------------------------ */
/* 9. Push queue + server-side gating (quiet hours, push prefs)        */
/* ------------------------------------------------------------------ */

create table if not exists public.push_queue (
  id              uuid primary key default gen_random_uuid(),
  notification_id uuid not null references public.notifications(id) on delete cascade,
  recipient_id    uuid not null references public.profiles(id) on delete cascade,
  payload         jsonb not null,
  status          text not null default 'pending'
                  check (status in ('pending', 'delivered', 'failed')),
  attempts        int not null default 0,
  last_error      text,
  delivered_at    timestamptz,
  next_attempt_at timestamptz not null default now(),
  created_at      timestamptz not null default now()
);

create index if not exists push_queue_due_idx
  on public.push_queue (next_attempt_at)
  where status = 'pending';

alter table public.push_queue enable row level security;

/* no policies at all: clients can neither read browser endpoints nor
   forge queue rows. The edge function runs with the service role. */
revoke all on public.push_queue from anon, authenticated;

/* Quiet hours evaluated on the server, in the user's timezone. */
create or replace function public.notif_is_quiet(p_user uuid)
returns boolean
language plpgsql stable security definer set search_path = public as $$
declare
  v_prefs public.notification_prefs;
  v_local time;
begin
  v_prefs := public.notif_prefs_of(p_user);
  if not v_prefs.quiet_enabled or v_prefs.timezone is null then
    return false;
  end if;
  begin
    v_local := (now() at time zone v_prefs.timezone)::time;
  exception when others then
    return false; -- invalid timezone: do not silently eat pushes elsewhere
  end;
  if v_prefs.quiet_start <= v_prefs.quiet_end then
    return v_local >= v_prefs.quiet_start and v_local < v_prefs.quiet_end;
  end if;
  return v_local >= v_prefs.quiet_start or v_local < v_prefs.quiet_end;
end $$;

/* Human payload for one notification row. Message previews follow the
   recipient's stored preference; blocked/muted actors never make it
   here because create/notify suppressed the row at write time. */
create or replace function public.notification_push_payload(p_row public.notifications)
returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare
  v_actor     record;
  v_prefs     public.notification_prefs;
  v_cat       text;
  v_title     text;
  v_body      text;
  v_url       text := '';
  v_tag       text;
  v_post      uuid;
  v_msg       record;
  v_preview   text;
begin
  v_prefs := public.notif_prefs_of(p_row.recipient_id);
  v_cat   := public.notification_category(p_row.type);
  select username, display_name into v_actor
  from public.profiles where id = p_row.actor_id;
  v_post := coalesce(p_row.metadata ->> 'post_id', p_row.entity_id::text);

  if p_row.type = 'chat_message' then
    v_title := coalesce(v_actor.display_name, 'Someone') || ' sent a message';
    if v_prefs.message_preview then
      select b.body, b.attachments, b.shared_kind into v_msg
      from public.chat_messages b
      where b.conversation_id = p_row.entity_id
        and b.deleted_at is null
      order by b.created_at desc limit 1;
      v_preview := null;
      if found then
        if coalesce(btrim(v_msg.body), '') <> '' then
          v_preview := left(btrim(v_msg.body), 80);
        elsif v_msg.shared_kind is not null then
          v_preview := 'shared a post with you';
        elsif v_msg.attachments is not null
          and jsonb_array_length(v_msg.attachments) > 0 then
          v_preview := 'sent an attachment';
        end if;
      end if;
      if v_preview is null then
        v_body := 'New message — open to read';
      else
        v_body := v_preview;
      end if;
    else
      v_body := 'New message — open to read';
    end if;
    v_url := '#chat/' || coalesce(p_row.entity_id::text, '');
    v_tag := 'chat:' || coalesce(p_row.entity_id::text, '');
    return jsonb_build_object('title', v_title, 'body', v_body,
                              'url', v_url, 'tag', v_tag);

  elsif p_row.type = 'follow' then
    v_title := 'New follower';
    v_body  := coalesce(v_actor.display_name, 'Someone') || ' started following you';
    v_url   := case when v_actor.username is null then ''
                    else '#u/' || v_actor.username end;

  elsif p_row.type = 'post_like' then
    v_title := 'New like';
    v_body  := coalesce(v_actor.display_name, 'Someone') || ' liked your ' ||
               coalesce(p_row.metadata ->> 'kind', 'post');
    v_url   := '#p/' || coalesce(v_post, '');
  elsif p_row.type = 'post_repost' then
    v_title := 'New repost';
    v_body  := coalesce(v_actor.display_name, 'Someone') || ' reposted your ' ||
               coalesce(p_row.metadata ->> 'kind', 'post');
    v_url   := '#p/' || coalesce(v_post, '');
  elsif p_row.type = 'comment_like' then
    v_title := 'New like';
    v_body  := coalesce(v_actor.display_name, 'Someone') || ' liked your comment';
    v_url   := '#p/' || coalesce(v_post, '');

  elsif p_row.type = 'post_comment' then
    v_title := 'New comment';
    v_body  := coalesce(v_actor.display_name, 'Someone') || ' commented on your ' ||
               coalesce(p_row.metadata ->> 'kind', 'post');
    v_url   := '#p/' || coalesce(v_post, '');
  elsif p_row.type = 'post_reply' then
    v_title := 'New reply';
    v_body  := coalesce(v_actor.display_name, 'Someone') || ' replied to your comment';
    v_url   := '#p/' || coalesce(v_post, '');

  elsif p_row.type = 'post_mention' then
    v_title := 'Mention';
    v_body  := coalesce(v_actor.display_name, 'Someone') || ' mentioned you in a ' ||
               coalesce(p_row.metadata ->> 'kind', 'post');
    v_url   := '#p/' || coalesce(v_post, '');
  elsif p_row.type = 'chat_mention' then
    v_title := 'Mention';
    v_body  := coalesce(v_actor.display_name, 'Someone') || ' mentioned you in a community chat';
    v_url   := '#chat/' || coalesce(p_row.entity_id::text, '');
  elsif p_row.type = 'chat_reply' then
    v_title := 'Reply';
    v_body  := coalesce(v_actor.display_name, 'Someone') || ' replied to your message in a community chat';
    v_url   := '#chat/' || coalesce(p_row.entity_id::text, '');

  -- administrative/community/event/marketplace/system
  else
    v_title := case p_row.type
      when 'club_join_accepted' then 'Join request accepted'
      when 'club_join_rejected' then 'Join request declined'
      when 'club_invitation'    then 'Community invitation'
      when 'club_role_changed'  then 'Community role updated'
      when 'club_banned'        then 'Removed from a community'
      when 'club_removed'       then 'Removed from a community'
      when 'club_ownership'     then 'Community ownership transferred'
      when 'event_updated'      then 'Event update'
      when 'event_cancelled'    then 'Event cancelled'
      when 'event_registered'   then 'RSVP confirmed'
      when 'event_promoted'     then 'Promoted to event host'
      when 'listing_removed'    then 'Listing removed'
      when 'listing_restored'   then 'Listing restored'
      else 'CAMPUS notification'
    end;
    -- entity display names, resolved only for the recipient's own rows
    declare
      v_name text;
    begin
      if p_row.entity_type = 'club' then
        select c.name into v_name from public.clubs c where c.id = p_row.entity_id;
      elsif p_row.entity_type = 'event' then
        select e.title into v_name from public.events e where e.id = p_row.entity_id;
      elsif p_row.entity_type = 'listing' then
        select l.title into v_name from public.marketplace_listings l where l.id = p_row.entity_id;
      end if;
      v_body := case p_row.type
        when 'club_join_accepted' then 'Your request to join '     || coalesce(v_name, 'the community') || ' was accepted'
        when 'club_join_rejected' then 'Your request to join '     || coalesce(v_name, 'the community') || ' was declined'
        when 'club_invitation'    then coalesce(v_actor.display_name, 'Someone') || ' invited you to join ' || coalesce(v_name, 'a community')
        when 'club_role_changed'  then 'Your role in '             || coalesce(v_name, 'the community') || ' changed'
        when 'club_banned'        then 'You have been removed from ' || coalesce(v_name, 'a community')
        when 'club_removed'       then 'You have been removed from ' || coalesce(v_name, 'a community')
        when 'club_ownership'     then coalesce(v_name, 'A community') || ' changed ownership'
        when 'event_updated'      then coalesce(v_actor.display_name, 'Someone') || ' updated ' || coalesce(v_name, 'an event')
        when 'event_cancelled'    then coalesce(v_actor.display_name, 'Someone') || ' cancelled ' || coalesce(v_name, 'an event')
        when 'event_registered'   then 'Your spot for '            || coalesce(v_name, 'the event') || ' is confirmed'
        when 'event_promoted'     then 'You are now a host of '    || coalesce(v_name, 'the event')
        when 'listing_removed'    then 'Your listing '             || coalesce(v_name, '') || ' was removed'
        when 'listing_restored'   then 'Your listing '             || coalesce(v_name, '') || ' is live again'
        else 'Open CAMPUS to see the details'
      end;
      if p_row.entity_type = 'club' then
        select '#c/' || c.slug into v_url
        from public.clubs c where c.id = p_row.entity_id;
      elsif p_row.entity_type = 'event' then
        select '#e/' || e.slug into v_url
        from public.events e where e.id = p_row.entity_id;
      elsif p_row.entity_type = 'listing' then
        select '#m/' || l.slug into v_url
        from public.marketplace_listings l where l.id = p_row.entity_id;
      else
        v_url := '';
      end if;
    end;
  end if;

  v_tag := p_row.type || ':' || coalesce(
    p_row.metadata ->> 'comment_id',
    p_row.metadata ->> 'post_id',
    p_row.entity_id::text,
    '');
  return jsonb_build_object('title', v_title, 'body', v_body,
                            'url', coalesce(v_url, ''), 'tag', v_tag);
end $$;

-- enqueue push for eligible rows only
create or replace function public.notifications_enqueue_push()
returns trigger
language plpgsql security definer set search_path = public as $$
declare
  v_prefs public.notification_prefs;
  v_cat   text;
  v_push  boolean;
  v_payload jsonb;
begin
  v_prefs := public.notif_prefs_of(new.recipient_id);
  v_cat   := public.notification_category(new.type);
  v_push := case v_cat
    when 'like'        then v_prefs.like_push
    when 'comment'     then v_prefs.comment_push
    when 'follow'      then v_prefs.follow_push
    when 'mention'     then v_prefs.mention_push
    when 'message'     then v_prefs.message_push
    when 'community'   then v_prefs.community_push
    when 'event'       then v_prefs.event_push
    when 'marketplace' then v_prefs.marketplace_push
    else true -- account / security notices always eligible
  end;
  if not v_push or public.notif_is_quiet(new.recipient_id) then
    return null;
  end if;
  if not exists (
    select 1 from public.push_subscriptions s
    where s.user_id = new.recipient_id
  ) then
    return null; -- nothing registered: no queue churn
  end if;
  v_payload := public.notification_push_payload(new);
  insert into public.push_queue (notification_id, recipient_id, payload)
  values (new.id, new.recipient_id, v_payload);
  return null;
end $$;

drop trigger if exists notifications_enqueue_push on public.notifications;
create trigger notifications_enqueue_push
  after insert on public.notifications
  for each row execute function public.notifications_enqueue_push();

/* ------------------------------------------------------------------ */
/* 11. Realtime publication                                            */
/* ------------------------------------------------------------------ */

/* postgres_changes only fires for tables in supabase_realtime (chat_messages
   was added by 0006); the notification channel needs its own entry. */
do $$
begin
  if not exists (
    select 1 from pg_publication_tables
    where pubname = 'supabase_realtime'
      and schemaname = 'public'
      and tablename = 'notifications'
  ) then
    alter publication supabase_realtime add table public.notifications;
  end if;
end $$;

/* ------------------------------------------------------------------ */
/* 12. Grants                                                          */
/* ------------------------------------------------------------------ */

/* Table-level: push_queue stays fully closed to client roles (no RLS
   policies + explicit per-role revokes — Supabase's default privileges
   grant writes to anon/authenticated, so revoking only "public" would
   be insufficient). Everything else relies on per-own-row RLS. */

grant execute on function
  public.list_notifications(text, int, int),
  public.ensure_notification_prefs,
  public.update_notification_prefs(jsonb),
  public.save_push_subscription(text, text, text, text),
  public.remove_push_subscription(text)
  to authenticated;
