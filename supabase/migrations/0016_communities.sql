-- 0016 - Communities: global interest communities + college-specific communities
--
-- The original schema.sql already shipped clubs / club_members / events /
-- event_rsvps / notifications / reports but no feature used them. This
-- migration evolves those legacy tables into the Communities system instead
-- of creating parallel tables:
--
--   clubs             → communities (scope derived: no college = global)
--   club_members      → membership with roles owner/moderator/member and
--                       statuses active/pending/banned
--   posts.community_id→ community feed posts (comments + likes reuse 0005)
--   club_pinned_posts → pinned posts per community
--   conversations     → community chat (kind = 'club', one per community)
--   events + rsvps    → community events
--   community_resources → files + links in the new private 'resources' bucket
--   reports           → community reports (club_id added)
--
-- All mutations that need authority (roles, bans, ownership, requests,
-- invitations) go through security-definer RPCs; dangerous direct writes are
-- RLS-closed. Every statement is re-runnable from a partial state.

/* ------------------------------------------------------------------ */
/* 0. Shared helper: honest updated_at                                 */
/* ------------------------------------------------------------------ */

create or replace function public.touch_updated_at()
returns trigger
language plpgsql as $$
begin
  new.updated_at := now();
  return new;
end $$;

revoke all on function public.touch_updated_at() from public;

/* ------------------------------------------------------------------ */
/* 1. The communities table (legacy `clubs`, evolved)                  */
/* ------------------------------------------------------------------ */

alter table public.clubs
  add column if not exists slug text,
  add column if not exists category text not null default 'Other',
  add column if not exists privacy text not null default 'public',
  add column if not exists rules text not null default '',
  add column if not exists cover_image_url text,
  add column if not exists archived_at timestamptz,
  add column if not exists updated_at timestamptz not null default now();

/* derived scope: a NULL college means global — the two scopes are mutually
   exclusive by construction */
alter table public.clubs
  add column if not exists scope text
  generated always as (case when college_id is null then 'global' else 'college' end) stored;

/* backfill slugs for any legacy rows */
update public.clubs
  set slug = lower(regexp_replace(btrim(name), '[^a-z0-9]+', '-', 'g')) || '-' || left(id::text, 8)
where slug is null;

alter table public.clubs alter column slug set not null;

create unique index if not exists clubs_slug_unique on public.clubs (lower(slug));

alter table public.clubs drop constraint if exists clubs_privacy_check;
alter table public.clubs add constraint clubs_privacy_check
  check (privacy in ('public', 'private', 'hidden'));

alter table public.clubs drop constraint if exists clubs_category_check;
alter table public.clubs add constraint clubs_category_check
  check (category in (
    'Academics', 'Technology', 'Projects', 'Careers and Placements',
    'Clubs and Societies', 'Campus Life', 'Gaming', 'Arts and Creativity',
    'Sports and Fitness', 'Lifestyle', 'Other'
  ));

alter table public.clubs drop constraint if exists clubs_slug_shape_check;
alter table public.clubs add constraint clubs_slug_shape_check
  check (slug ~ '^[a-z0-9]+(-[a-z0-9]+)*$');

create index if not exists clubs_discovery_idx on public.clubs (privacy, archived_at, created_at desc);
create index if not exists clubs_category_idx on public.clubs (category);
create index if not exists clubs_college_idx on public.clubs (college_id);
create index if not exists clubs_owner_idx on public.clubs (created_by);

drop trigger if exists clubs_touch_updated_at on public.clubs;
create trigger clubs_touch_updated_at
  before update on public.clubs
  for each row execute function public.touch_updated_at();

/* Community metadata is readable by everyone EXCEPT hidden communities,
   which only their members may even see, and archived ones, which vanish. */
drop policy if exists "communities readable per privacy" on public.clubs;
drop policy if exists "clubs readable" on public.clubs;
drop policy if exists "public communities readable" on public.clubs;
create policy "communities readable per privacy" on public.clubs
  for select using (
    archived_at is null
    and (
      privacy <> 'hidden'
      -- through the SECURITY DEFINER helper: a policy's own subqueries run as
      -- the invoking user, and club_members has no select policy by design —
      -- an inline EXISTS over club_members would see zero rows for everyone
      or public.is_club_active_member(public.clubs.id, auth.uid())
    )
  );

/* insert / update / delete: none. Creation happens through create_club(), the
   lifecycle through the moderation RPCs — direct writes stay closed. */
alter table public.clubs enable row level security;

/* ------------------------------------------------------------------ */
/* 2. Membership (legacy `club_members`, evolved)                      */
/* ------------------------------------------------------------------ */

alter table public.club_members
  add column if not exists status text not null default 'active';

/* legacy rows keep their role; 'admin' treated as owner alias in RPCs */
alter table public.club_members drop constraint if exists club_members_role_check;
alter table public.club_members add constraint club_members_role_check
  check (role in ('member', 'moderator', 'admin', 'owner'));

alter table public.club_members drop constraint if exists club_members_status_check;
alter table public.club_members add constraint club_members_status_check
  check (status in ('active', 'pending', 'banned'));

/* exactly one owner per community */
create unique index if not exists club_members_owner_unique
  on public.club_members (club_id) where role = 'owner';

/* eligibility helpers shared by policies and RPCs */
create or replace function public.club_member_ctx(p_club uuid, p_user uuid)
returns table (member_status text, member_role text)
language sql stable security definer set search_path = public as $$
  select cm.status, cm.role
  from public.club_members cm
  where cm.club_id = p_club and cm.user_id = p_user
  limit 1
$$;

revoke all on function public.club_member_ctx(uuid, uuid) from public;

create or replace function public.is_club_moderator(p_club uuid, p_user uuid)
returns boolean
language sql stable security definer set search_path = public as $$
  select exists (
    select 1 from public.club_members cm
    where cm.club_id = p_club and cm.user_id = p_user
      and cm.status = 'active'
      and cm.role in ('owner', 'moderator', 'admin')
  )
$$;

create or replace function public.is_club_owner(p_club uuid, p_user uuid)
returns boolean
language sql stable security definer set search_path = public as $$
  select exists (
    select 1 from public.club_members cm
    where cm.club_id = p_club and cm.user_id = p_user
      and cm.status = 'active'
      and cm.role in ('owner', 'admin')
  )
$$;

create or replace function public.is_club_active_member(p_club uuid, p_user uuid)
returns boolean
language sql stable security definer set search_path = public as $$
  select exists (
    select 1 from public.club_members cm
    where cm.club_id = p_club and cm.user_id = p_user and cm.status = 'active'
  )
$$;

/* who may join, answered verbatim (never throws) — same rules as join_club() */
create or replace function public.club_join_rule(p_club uuid)
returns text
language plpgsql stable security definer set search_path = public as $$
declare
  v_privacy text;
  v_scope text;
  v_college uuid;
  v_mine text;
begin
  select c.privacy, c.scope, c.college_id into v_privacy, v_scope, v_college
  from public.clubs c where c.id = p_club and c.archived_at is null;
  if v_privacy is null then
    return 'This community does not exist or is no longer active.';
  end if;
  select member_status into v_mine from public.club_member_ctx(p_club, auth.uid());
  if v_mine = 'banned' then
    return 'You were removed from this community and cannot rejoin.';
  end if;
  if v_mine = 'active' then
    return 'You are already a member of this community.';
  end if;
  if v_mine = 'pending' then
    return 'Your request is already waiting for a moderator.';
  end if;
  if v_scope = 'college' then
    if (select p.college_id from public.profiles p where p.id = auth.uid()) is distinct from v_college then
      return 'This community belongs to another college. Your declared college does not match.';
    end if;
  end if;
  if v_privacy = 'public' then
    return 'ok';
  end if;
  if v_privacy = 'private' then
    return 'request'; /* join = leave a pending request */
  end if;
  return 'hidden communities are invitation-only.';
end $$;

/* Direct self-service inserts: OPEN with the same rules the RPC uses —
   your own row only, plain member role, public communities join directly,
   private ones leave a pending request, hidden ones accept nobody directly. */
drop policy if exists "users join clubs as self" on public.club_members;
create policy "open self-service membership" on public.club_members
  for insert to authenticated
  with check (
    auth.uid() = user_id
    and role = 'member'
    and status in ('active', 'pending')
    and exists (
      select 1
      from public.clubs c
      join public.profiles p on p.id = auth.uid()
      where c.id = public.club_members.club_id
        and c.archived_at is null
        and (
          (c.privacy = 'public'
           and status = 'active'
           and (c.college_id is null or c.college_id = p.college_id))
          or
          (c.privacy = 'private' and status = 'pending'
           and (c.college_id is null or c.college_id = p.college_id))
        )
    )
  );

/* updates: only through respond/set-role/remove RPCs → no UPDATE policy.
   deletes: leaving and cancelling happen through leave_club() → no DELETE policy.
   reads: the member RPC covers directories; direct REST reads stay closed. */
drop policy if exists "members readable" on public.club_members;
drop policy if exists "club members readable" on public.club_members;
drop policy if exists "club memberships readable" on public.club_members;
drop policy if exists "users join clubs as self" on public.club_members;
drop policy if exists "users access clubs they hold membership" on public.club_members;

alter table public.club_members enable row level security;

/* ------------------------------------------------------------------ */
/* 3. Community posts (the existing posts table, extended)             */
/* ------------------------------------------------------------------ */

alter table public.posts
  add column if not exists community_id uuid;

alter table public.posts
  drop constraint if exists posts_community_fk;
alter table public.posts
  add constraint posts_community_fk
  foreign key (community_id) references public.clubs (id) on delete cascade;

create index if not exists posts_community_idx on public.posts (community_id, created_at desc);

/* direct insert into the main feed is unchanged; community posts additionally
   require an ACTIVE membership, a live community, and identity (no anonymous
   confessions inside communities) */
drop policy if exists "signed in users create posts" on public.posts;
drop policy if exists "members create posts" on public.posts;
create policy "members create posts" on public.posts
  for insert to authenticated
  with check (
    auth.uid() = author_id
    and is_published = true
    and (
      community_id is null
      or (
        not is_anonymous
        -- membership + live community checked through definer helpers/policy-
        -- safe EXISTS; see the note on the clubs select policy above
        and public.is_club_active_member(public.posts.community_id, auth.uid())
        and exists (
          select 1
          from public.clubs c
          where c.id = public.posts.community_id
            and c.archived_at is null
        )
      )
    )
  );

/* community posts keep the privacy of their community: public ones readable
   by anyone, private/hidden ones only by active members, archived invisible */
drop policy if exists "published posts readable" on public.posts;
create policy "published posts readable" on public.posts
  for select using (
    is_published = true
    and (
      community_id is null
      or exists (
        select 1
        from public.clubs c
        where c.id = public.posts.community_id
          and c.archived_at is null
          and (
            c.privacy = 'public'
            or public.is_club_active_member(c.id, auth.uid())
          )
      )
    )
  );

/* and the 0003 update policy gains the same community rule: an author may
   never swing their post into a community they cannot already post in
   (would otherwise inject arbitrary content into private/hidden ones) */
drop policy if exists "authors update own posts" on public.posts;
create policy "authors update own posts" on public.posts
  for update to authenticated
  using (author_id = auth.uid() and is_anonymous = false)
  with check (
    author_id = auth.uid()
    and is_anonymous = false
    and (
      community_id is null
      or (
        public.is_club_active_member(public.posts.community_id, auth.uid())
        and exists (
          select 1
          from public.clubs c
          where c.id = public.posts.community_id
            and c.archived_at is null
        )
      )
    )
  );

/* feed/search RPCs are security definer and bypass RLS, so community posts
   must be excluded there explicitly — they surface only inside the community */
drop function if exists public.list_public_posts(integer, integer, uuid);
create function public.list_public_posts(
  p_limit integer default 20,
  p_offset integer default 0,
  p_college_id uuid default null
)
returns table (
  id uuid,
  body text,
  kind public.post_kind,
  media_urls text[],
  is_anonymous boolean,
  created_at timestamptz,
  edited_at timestamptz,
  author_id uuid,
  author_display_name text,
  author_username text,
  author_avatar_url text,
  author_is_verified boolean,
  college_id uuid,
  college_short_name text,
  like_count bigint,
  comment_count bigint,
  liked_by_me boolean
)
language sql stable security definer set search_path = '' as $$
  select
    p.id,
    p.body,
    p.kind,
    p.media_urls,
    p.is_anonymous,
    p.created_at,
    p.edited_at,
    case when p.is_anonymous then null else p.author_id end,
    case when p.is_anonymous then null else pr.display_name end,
    case when p.is_anonymous then null else pr.username end,
    case when p.is_anonymous then null else pr.avatar_url end,
    case when p.is_anonymous then null else pr.is_verified end,
    p.college_id,
    c.short_name,
    (select count(*) from public.post_likes l where l.post_id = p.id),
    (select count(*) from public.post_comments cc where cc.post_id = p.id),
    coalesce(
      (select true from public.post_likes l where l.post_id = p.id and l.user_id = auth.uid()),
      false
    )
  from public.posts p
  left join public.profiles pr on pr.id = p.author_id
  left join public.colleges c on c.id = p.college_id
  where p.is_published = true
    and p.community_id is null
    and (p_college_id is null or p.college_id = p_college_id)
  order by p.created_at desc
  limit least(greatest(coalesce(p_limit, 20), 1), 50)
  offset greatest(coalesce(p_offset, 0), 0)
$$;

revoke all on function public.list_public_posts(integer, integer, uuid) from public;
grant execute on function public.list_public_posts(integer, integer, uuid) to anon, authenticated;

/* members' profile grids never surface community posts: each community owns
   its posts */
drop function if exists public.list_member_posts(uuid, text, integer);
create function public.list_member_posts(
  p_profile uuid,
  p_kind text default 'post',
  p_limit integer default 24
)
returns table (
  id uuid,
  body text,
  kind public.post_kind,
  media_urls text[],
  is_anonymous boolean,
  created_at timestamptz,
  edited_at timestamptz,
  author_id uuid,
  author_display_name text,
  author_username text,
  author_avatar_url text,
  college_id uuid,
  college_short_name text,
  like_count bigint,
  comment_count bigint,
  liked_by_me boolean
)
language sql stable security definer set search_path = '' as $$
  select
    p.id, p.body, p.kind, p.media_urls, p.is_anonymous, p.created_at, p.edited_at,
    case when p.is_anonymous then null else p.author_id end,
    case when p.is_anonymous then null else pr.display_name end,
    case when p.is_anonymous then null else pr.username end,
    case when p.is_anonymous then null else pr.avatar_url end,
    p.college_id, c.short_name,
    (select count(*) from public.post_likes l where l.post_id = p.id),
    (select count(*) from public.post_comments cc where cc.post_id = p.id),
    coalesce((select true from public.post_likes l where l.post_id = p.id and l.user_id = auth.uid()), false)
  from public.posts p
  left join public.profiles pr on pr.id = p.author_id
  left join public.colleges c on c.id = p.college_id
  where p.is_published = true
    and p.is_anonymous = false
    and p.community_id is null
    and p.author_id = p_profile
    and p.kind = (coalesce(nullif(btrim(p_kind), ''), 'post'))::public.post_kind
  order by p.created_at desc
  limit least(greatest(coalesce(p_limit, 24), 1), 50)
$$;

revoke all on function public.list_member_posts(uuid, text, integer) from public;
grant execute on function public.list_member_posts(uuid, text, integer) to anon, authenticated;

/* Discover reels: same exclusion */
drop function if exists public.list_public_reels(integer, integer);
create function public.list_public_reels(
  p_limit integer default 20,
  p_offset integer default 0
)
returns table (
  id uuid,
  body text,
  kind public.post_kind,
  media_urls text[],
  is_anonymous boolean,
  created_at timestamptz,
  edited_at timestamptz,
  author_id uuid,
  author_display_name text,
  author_username text,
  author_avatar_url text,
  college_id uuid,
  college_short_name text,
  like_count bigint,
  comment_count bigint,
  liked_by_me boolean
)
language sql stable security definer set search_path = '' as $$
  select
    p.id,
    p.body,
    p.kind,
    p.media_urls,
    p.is_anonymous,
    p.created_at,
    p.edited_at,
    case when p.is_anonymous then null else p.author_id end,
    case when p.is_anonymous then null else pr.display_name end,
    case when p.is_anonymous then null else pr.username end,
    case when p.is_anonymous then null else pr.avatar_url end,
    p.college_id,
    c.short_name,
    (select count(*) from public.post_likes l where l.post_id = p.id),
    (select count(*) from public.post_comments cc where cc.post_id = p.id),
    coalesce((select true from public.post_likes l where l.post_id = p.id and l.user_id = auth.uid()), false)
  from public.posts p
  left join public.profiles pr on pr.id = p.author_id
  left join public.colleges c on c.id = p.college_id
  where p.is_published = true
    and p.kind = 'reel'
    and p.community_id is null
    and coalesce(array_length(p.media_urls, 1), 0) > 0
  order by p.created_at desc
  limit least(greatest(coalesce(p_limit, 20), 1), 100)
  offset greatest(coalesce(p_offset, 0), 0)
$$;

revoke all on function public.list_public_reels(integer, integer) from public;
grant execute on function public.list_public_reels(integer, integer) to anon, authenticated;

/* post search excludes community posts — they are searched inside the
   community itself */
drop function if exists public.search_posts(text, integer);
create function public.search_posts(
  p_query text,
  p_limit integer default 10
)
returns table (
  id uuid,
  body text,
  kind public.post_kind,
  media_urls text[],
  is_anonymous boolean,
  created_at timestamptz,
  edited_at timestamptz,
  author_id uuid,
  author_display_name text,
  author_username text,
  author_avatar_url text,
  author_is_verified boolean,
  college_id uuid,
  college_short_name text,
  like_count bigint,
  comment_count bigint,
  liked_by_me boolean
)
language sql stable security definer set search_path = '' as $$
  select
    p.id,
    p.body,
    p.kind,
    p.media_urls,
    p.is_anonymous,
    p.created_at,
    p.edited_at,
    case when p.is_anonymous then null else p.author_id end,
    case when p.is_anonymous then null else pr.display_name end,
    case when p.is_anonymous then null else pr.username end,
    case when p.is_anonymous then null else pr.avatar_url end,
    case when p.is_anonymous then null else pr.is_verified end,
    p.college_id,
    c.short_name,
    (select count(*) from public.post_likes l where l.post_id = p.id),
    (select count(*) from public.post_comments cc where cc.post_id = p.id),
    coalesce(
      (select true from public.post_likes l where l.post_id = p.id and l.user_id = auth.uid()),
      false
    )
  from public.posts p
  left join public.profiles pr on pr.id = p.author_id
  left join public.colleges c on c.id = p.college_id
  where p.is_published = true
    and p.community_id is null
    and (
      p.body ilike '%' || btrim(p_query) || '%'
      or (
        btrim(p_query) <> ''
        and p.is_anonymous = false
        and (
          pr.display_name ilike '%' || btrim(p_query) || '%'
          or pr.username ilike '%' || btrim(p_query) || '%'
        )
      )
    )
  order by p.created_at desc
  limit greatest(least(coalesce(p_limit, 10), 25), 1)
$$;

revoke all on function public.search_posts(text, integer) from public;
grant execute on function public.search_posts(text, integer) to anon, authenticated;

/* ------------------------------------------------------------------ */
/* 4. Pinned posts (moderator tool, Instagram-style "pin to community") */
/* ------------------------------------------------------------------ */

create table if not exists public.club_pinned_posts (
  club_id uuid not null references public.clubs (id) on delete cascade,
  post_id uuid not null references public.posts (id) on delete cascade,
  pinned_by uuid references public.profiles (id) on delete set null,
  created_at timestamptz not null default now(),
  primary key (club_id, post_id)
);

alter table public.club_pinned_posts enable row level security;

/* ------------------------------------------------------------------ */
/* 5. Community chat (existing conversations/chat_messages, linked)    */
/* ------------------------------------------------------------------ */

alter table public.conversations
  add column if not exists club_id uuid;

/* kind is guaranteed by 0006's create; add defensively so partial states work */
alter table public.conversations
  add column if not exists kind text not null default 'dm';

alter table public.conversations
  drop constraint if exists conversations_club_fk;
alter table public.conversations
  add constraint conversations_club_fk
  foreign key (club_id) references public.clubs (id) on delete cascade;

/* one club channel at a time — 0006 already ships conversations_kind_club_uniq */

/* ------------------------------------------------------------------ */
/* 6. Resources (metadata + private storage bucket)                    */
/* ------------------------------------------------------------------ */

create table if not exists public.community_resources (
  id uuid primary key default gen_random_uuid(),
  club_id uuid not null references public.clubs (id) on delete cascade,
  uploader_id uuid not null references public.profiles (id) on delete cascade,
  title text not null check (char_length(btrim(title)) between 1 and 120),
  description text not null default '',
  link_url text not null default '',
  file_name text,
  mime_type text,
  file_size bigint,
  storage_path text,
  created_at timestamptz not null default now(),
  constraint community_resources_single_target check (
    (storage_path is not null) <> (btrim(link_url) <> '')
  ),
  constraint community_resources_size_check
    check (file_size is null or file_size <= 26214400),
  constraint community_resources_filetype_check
    check (
      storage_path is null
      or lower(split_part(file_name, '.', -1)) in (
        'pdf','doc','docx','ppt','pptx','xls','xlsx','csv','txt','md','zip',
        'png','jpg','jpeg','gif','ipynb'
      )
    )
);

create index if not exists community_resources_club_idx
  on public.community_resources (club_id, created_at desc);

/* the private bucket: only community members can read their own folder tree
   through policy-gated signed URLs — never public URLs */
insert into storage.buckets (id, name, public)
values ('resources', 'resources', false)
on conflict (id) do nothing;

drop policy if exists "resources readable by any bucket observer" on storage.objects;
drop policy if exists "resources bucket publicly inert" on storage.objects;
drop policy if exists "community members read resources" on storage.objects;
create policy "community members read resources" on storage.objects
  for select to authenticated
  using (
    bucket_id = 'resources'
    and (storage.foldername(name))[1] ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
    and public.is_club_active_member((storage.foldername(name))[1]::uuid, auth.uid())
  );

drop policy if exists "community members upload resources" on storage.objects;
create policy "community members upload resources" on storage.objects
  for insert to authenticated
  with check (
    bucket_id = 'resources'
    and (storage.foldername(name))[1] ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
    and (storage.foldername(name))[2] = auth.uid()::text
    and public.is_club_active_member((storage.foldername(name))[1]::uuid, auth.uid())
  );

drop policy if exists "resource owner or moderator deletes" on storage.objects;
create policy "resource owner or moderator deletes" on storage.objects
  for delete to authenticated
  using (
    bucket_id = 'resources'
    and (storage.foldername(name))[1] ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
    and (
      (storage.foldername(name))[2] = auth.uid()::text
      or public.is_club_moderator((storage.foldername(name))[1]::uuid, auth.uid())
    )
  );

/* RLS on the metadata table: members read; direct inserts stay closed
   (add_club_resource() validates the mirrors-the-storage-path rule);
   uploader or moderator deletes. */
alter table public.community_resources enable row level security;

drop policy if exists "community members read resource rows" on public.community_resources;
create policy "community members read resource rows" on public.community_resources
  for select to authenticated
  using (public.is_club_active_member(club_id, auth.uid()));

drop policy if exists "resource uploader deletes row" on public.community_resources;
create policy "resource uploader or moderator deletes row" on public.community_resources
  for delete to authenticated
  using (
    uploader_id = auth.uid()
    or public.is_club_moderator(club_id, auth.uid())
  );

/* ------------------------------------------------------------------ */
/* 7. Events (legacy tables, extended)                                 */
/* ------------------------------------------------------------------ */

alter table public.events
  add column if not exists registration_url text,
  add column if not exists capacity integer,
  add column if not exists cancelled_at timestamptz,
  add column if not exists updated_at timestamptz not null default now();

alter table public.events drop constraint if exists events_capacity_check;
alter table public.events add constraint events_capacity_check
  check (capacity is null or capacity > 0);

drop trigger if exists events_touch_updated_at on public.events;
create trigger events_touch_updated_at
  before update on public.events
  for each row execute function public.touch_updated_at();

create index if not exists events_club_starts_idx on public.events (club_id, starts_at);

alter table public.events enable row level security;
alter table public.event_rsvps enable row level security;

/* events keep their community's privacy: public communities expose events to
   everyone, private ones only inside; organizers always see their own */
drop policy if exists "events readable" on public.events;
create policy "community events visible by membership" on public.events
  for select using (
    created_by = auth.uid()
    or exists (
      select 1 from public.clubs c
      where c.id = public.events.club_id
        and c.archived_at is null
        and (
          c.privacy = 'public'
          or public.is_club_active_member(c.id, auth.uid())
        )
    )
  );

/* capacity counting must never be bypassed: writes happen through rsvp_event()
   under row locks; members only read/withdraw their own row directly */
drop policy if exists "users manage own rsvps" on public.event_rsvps;
create policy "rsvps readable by their owner" on public.event_rsvps
  for select to authenticated using (auth.uid() = user_id);
create policy "owners withdraw their own rsvp" on public.event_rsvps
  for delete to authenticated using (auth.uid() = user_id);

/* ------------------------------------------------------------------ */
/* 8. Invitations                                                      */
/* ------------------------------------------------------------------ */

create table if not exists public.community_invitations (
  id uuid primary key default gen_random_uuid(),
  club_id uuid not null references public.clubs (id) on delete cascade,
  inviter_id uuid not null references public.profiles (id) on delete cascade,
  invitee_id uuid not null references public.profiles (id) on delete cascade,
  created_at timestamptz not null default now(),
  unique (club_id, invitee_id)
);

create index if not exists community_invitations_invitee_idx
  on public.community_invitations (invitee_id);

alter table public.community_invitations enable row level security;

drop policy if exists "invitations handled by rpcs" on public.community_invitations;
/* every read/write of invitations flows through invite_member()/respond_invite();
   direct access stays closed even to the parties involved (no policies at all) */

/* ------------------------------------------------------------------ */
/* 9. Reports gain communities                                         */
/* ------------------------------------------------------------------ */

alter table public.reports
  add column if not exists club_id uuid;

alter table public.reports
  drop constraint if exists reports_club_fk;
alter table public.reports
  add constraint reports_club_fk
  foreign key (club_id) references public.clubs (id) on delete cascade;

alter table public.reports drop constraint if exists reports_check;
alter table public.reports add constraint reports_check
  check (post_id is not null or reported_user_id is not null or club_id is not null);

/* ------------------------------------------------------------------ */
/* 10. Community RPCs                                                   */
/* ------------------------------------------------------------------ */

-- Notify helper: dedupes unread duplicates so repeated joins/role changes do
-- not spam the bell.
create or replace function public.notify_member(
  p_recipient uuid,
  p_actor uuid,
  p_type text,
  p_entity_type text,
  p_entity_id uuid
)
returns void
language sql security definer set search_path = public as $$
  insert into public.notifications (recipient_id, actor_id, type, entity_type, entity_id)
  select p_recipient, p_actor, p_type, p_entity_type, p_entity_id
  where p_recipient is not null
    and p_recipient <> p_actor
    and not exists (
      select 1 from public.notifications n
      where n.recipient_id = p_recipient
        and n.type = p_type
        and n.entity_id is not distinct from p_entity_id
        and n.read_at is null
    )
$$;

revoke all on function public.notify_member(uuid, uuid, text, text, uuid) from public;

-- Get-or-create the community chat conversation and (optionally) seat members.
create or replace function public.ensure_club_conversation(p_club uuid)
returns uuid
language plpgsql security definer set search_path = public as $$
declare
  v_conv uuid;
  v_name text;
begin
  select id into v_conv
  from public.conversations
  where club_id = p_club
  limit 1;
  if v_conv is not null then
    return v_conv;
  end if;
  select name into v_name from public.clubs where id = p_club;
  insert into public.conversations (kind, title, status, created_by, club_id)
    values ('club', v_name, 'accepted', auth.uid(), p_club)
    returning id into v_conv;
  insert into public.conversation_members (conversation_id, user_id)
    select v_conv, user_id from public.club_members
    where club_id = p_club and status = 'active'
  on conflict do nothing;
  return v_conv;
end $$;

revoke all on function public.ensure_club_conversation(uuid) from public;

-- Create a community. The creator becomes its owner (checked server-side).
create or replace function public.create_club(
  p_name text,
  p_slug text,
  p_description text default '',
  p_category text default 'Other',
  p_college_id uuid default null,
  p_privacy text default 'public',
  p_rules text default '',
  p_logo_url text default null,
  p_cover_url text default null
)
returns uuid
language plpgsql security definer set search_path = public as $$
  #variable_conflict use_column
declare
  v_me uuid := auth.uid();
  v_slug text;
  v_id uuid;
  v_college uuid;
begin
  if v_me is null then
    raise exception 'Sign in to create a community.';
  end if;
  if p_name is null or length(btrim(p_name)) < 3 or length(btrim(p_name)) > 60 then
    raise exception 'Community name must be 3-60 characters.';
  end if;
  v_slug := lower(btrim(coalesce(p_slug, '')));
  if v_slug = '' then
    v_slug := lower(regexp_replace(btrim(p_name), '[^a-z0-9]+', '-', 'g'));
  end if;
  v_slug := regexp_replace(v_slug, '^-+|-+$', '', 'g');
  if v_slug is null or char_length(v_slug) < 3 or v_slug !~ '^[a-z0-9]+(-[a-z0-9]+)*$' then
    raise exception 'The URL slug must be lowercase letters, numbers and dashes (at least 3 characters).';
  end if;
  if p_privacy not in ('public', 'private', 'hidden') then
    raise exception 'Choose public, private or hidden.';
  end if;
  if (p_category in (
    'Academics','Technology','Projects','Careers and Placements','Clubs and Societies',
    'Campus Life','Gaming','Arts and Creativity','Sports and Fitness','Lifestyle','Other'
  )) is not true then
    raise exception 'Pick a category from the list.';
  end if;
  if p_college_id is not null and not exists (select 1 from public.colleges where id = p_college_id) then
    raise exception 'That college does not exist.';
  end if;
  if p_college_id is not null then
    -- college-specific communities belong to the creator's declared college.
    select college_id into v_college from public.profiles where id = v_me;
    if (select college_id from public.profiles where id = v_me) is distinct from p_college_id then
      raise exception 'College communities can only be created for your own declared college.';
    end if;
  end if;
  if exists (select 1 from public.clubs where lower(slug) = v_slug) then
    raise exception 'That URL slug is already taken — try another.';
  end if;

  insert into public.clubs (name, slug, description, category, privacy, rules, logo_url, cover_image_url, college_id, created_by)
  values (
    btrim(p_name), v_slug, left(btrim(coalesce(p_description, '')), 500), p_category, p_privacy,
    left(btrim(coalesce(p_rules, '')), 2000), p_logo_url, p_cover_url, p_college_id, v_me
  )
  returning id into v_id;

  insert into public.club_members (club_id, user_id, role, status)
  values (v_id, v_me, 'owner', 'active');

  perform public.ensure_club_conversation(v_id);
  return v_id;
end $$;

-- Discovery: real search + filters + pagination. Hidden communities are
-- enumerated only for their members. Anon sees public + private metadata.
create or replace function public.list_clubs(
  p_query text default '',
  p_scope text default 'any',
  p_category text default 'any',
  p_college_id uuid default null,
  p_membership text default 'any',
  p_sort text default 'popular',
  p_limit integer default 24,
  p_offset integer default 0
)
returns table (
  id uuid,
  slug text,
  name text,
  description text,
  logo_url text,
  cover_image_url text,
  category text,
  privacy text,
  scope text,
  college_id uuid,
  college_name text,
  college_short_name text,
  member_count bigint,
  recent_post_at timestamptz,
  my_status text,
  my_role text,
  created_at timestamptz,
  created_by uuid,
  creator_name text
)
language sql stable security definer set search_path = public as $$
  select
    c.id, c.slug, c.name, c.description, c.logo_url, c.cover_image_url,
    c.category, c.privacy, c.scope,
    c.college_id,
    col.name, col.short_name,
    (select count(*) from public.club_members m where m.club_id = c.id and m.status = 'active'),
    (select max(p.created_at) from public.posts p where p.community_id = c.id),
    me.status, me.role,
    c.created_at, c.created_by,
    cr.display_name
  from public.clubs c
  left join public.colleges col on col.id = c.college_id
  left join public.profiles cr on cr.id = c.created_by
  left join public.club_members me
    on me.club_id = c.id and me.user_id = auth.uid()
  where c.archived_at is null
    and (c.privacy <> 'hidden' or me.status in ('active', 'pending', 'banned'))
    and (btrim(p_query) = '' or c.name ilike '%' || btrim(p_query) || '%' or c.description ilike '%' || btrim(p_query) || '%')
    and (p_scope = 'any' or c.scope = p_scope)
    and (p_category = 'any' or c.category = p_category)
    and (p_college_id is null or c.college_id = p_college_id)
    and (p_membership <> 'member' or me.status = 'active')
  order by
    case when p_sort = 'new' then (extract(epoch from c.created_at) * -1)
      when p_sort = 'relevant' then (case when me.status = 'active' then 0 else 1 end) * 1e18 + (extract(epoch from c.created_at) * -1)
      else 0 end,
    case when p_sort = 'popular' then (select count(*) from public.club_members mm where mm.club_id = c.id and mm.status = 'active') end desc nulls last,
    c.name asc
  limit least(greatest(coalesce(p_limit, 24), 1), 60)
  offset greatest(coalesce(p_offset, 0), 0)
$$;

revoke all on function public.list_clubs(text, text, text, uuid, text, text, integer, integer) from public;
grant execute on function public.list_clubs(text, text, text, uuid, text, text, integer, integer) to anon, authenticated;

-- Community detail: real counts + the viewer's honest state.
create or replace function public.club_detail(p_club uuid)
returns table (
  id uuid,
  slug text,
  name text,
  description text,
  logo_url text,
  cover_image_url text,
  category text,
  privacy text,
  scope text,
  rules text,
  college_id uuid,
  college_name text,
  college_short_name text,
  member_count bigint,
  post_count bigint,
  event_count bigint,
  creator_id uuid,
  creator_name text,
  creator_username text,
  my_status text,
  my_role text,
  archived boolean,
  created_at timestamptz
)
language sql stable security definer set search_path = public as $$
  select
    c.id, c.slug, c.name, c.description, c.logo_url, c.cover_image_url,
    c.category, c.privacy, c.scope, c.rules,
    c.college_id, col.name, col.short_name,
    (select count(*) from public.club_members m where m.club_id = c.id and m.status = 'active'),
    (select count(*) from public.posts p where p.community_id = c.id and p.is_published = true),
    (select count(*) from public.events e where e.club_id = c.id and e.cancelled_at is null and e.starts_at > now()),
    c.created_by, cr.display_name, cr.username,
    me.status, me.role,
    c.archived_at is not null,
    c.created_at
  from public.clubs c
  left join public.colleges col on col.id = c.college_id
  left join public.profiles cr on cr.id = c.created_by
  left join public.club_members me
    on me.club_id = c.id and me.user_id = auth.uid()
  where c.id = p_club
    and (c.privacy <> 'hidden' or me.status is not null)
$$;

revoke all on function public.club_detail(uuid) from public;
grant execute on function public.club_detail(uuid) to anon, authenticated;

-- Join. Public = direct membership. Private = pending request for
-- moderators. Hidden = invitation only. College scope = self-declared
-- college match. Returns the honest resulting state.
create or replace function public.join_club(p_club uuid)
returns text
language plpgsql security definer set search_path = public as $$
declare
  v_rule text;
begin
  if auth.uid() is null then
    raise exception 'Sign in to join communities.';
  end if;
  v_rule := public.club_join_rule(p_club);
  if v_rule = 'ok' then
    insert into public.club_members (club_id, user_id, role, status)
    values (p_club, auth.uid(), 'member', 'active')
    on conflict (club_id, user_id) do nothing;
    perform public.ensure_club_conversation(p_club);
    insert into public.conversation_members (conversation_id, user_id)
    select con.id, auth.uid() from public.conversations con where con.club_id = p_club
    on conflict (conversation_id, user_id) do nothing;
    return 'joined';
  end if;
  if v_rule = 'request' then
    insert into public.club_members (club_id, user_id, role, status)
    values (p_club, auth.uid(), 'member', 'pending')
    on conflict (club_id, user_id) do nothing;
    return 'requested';
  end if;
  raise exception '%', v_rule;
end $$;

-- Leave. Owners must transfer or archive first — an owner-less community
-- would be a dead end for members.
create or replace function public.leave_club(p_club uuid)
returns void
language plpgsql security definer set search_path = public as $$
declare
  v_role text;
begin
  select member_role into v_role from public.club_member_ctx(p_club, auth.uid());
  if v_role is null then
    raise exception 'You are not a member of this community.';
  end if;
  if v_role in ('owner', 'admin') then
    raise exception 'Owners cannot leave — transfer ownership or archive the community first.';
  end if;
  delete from public.club_members where club_id = p_club and user_id = auth.uid();
  delete from public.conversation_members cm
  using public.conversations con
  where con.club_id = p_club and cm.conversation_id = con.id and cm.user_id = auth.uid();
end $$;

-- Cancel my pending request.
create or replace function public.cancel_join_request(p_club uuid)
returns void
language plpgsql security definer set search_path = public as $$
begin
  delete from public.club_members
  where club_id = p_club and user_id = auth.uid() and status = 'pending' and role = 'member';
end $$;

-- Moderators answer join requests. Accept seats the member in the chat too.
create or replace function public.respond_join_request(
  p_club uuid,
  p_user uuid,
  p_action text
)
returns void
language plpgsql security definer set search_path = public as $$
declare
  v_name text;
begin
  if not public.is_club_moderator(p_club, auth.uid()) then
    raise exception 'Only owners and moderators can answer join requests.';
  end if;
  if p_action not in ('accept', 'reject') then
    raise exception 'Unknown action.';
  end if;
  select name into v_name from public.clubs where id = p_club;

  if p_action = 'accept' then
    update public.club_members set status = 'active'
    where club_id = p_club and user_id = p_user and status = 'pending';
    if found then
      perform public.ensure_club_conversation(p_club);
      insert into public.conversation_members (conversation_id, user_id)
      select con.id, p_user from public.conversations con where con.club_id = p_club
      on conflict (conversation_id, user_id) do nothing;
      perform public.notify_member(p_user, auth.uid(), 'club_join_accepted', 'club', p_club);
    end if;
  else
    delete from public.club_members
    where club_id = p_club and user_id = p_user and status = 'pending';
    if found then
      perform public.notify_member(p_user, auth.uid(), 'club_join_rejected', 'club', p_club);
    end if;
  end if;
  if not found then
    raise exception 'That join request no longer exists.';
  end if;
end $$;

-- Members of private/hidden communities invite classmates by id.
create or replace function public.invite_member(p_club uuid, p_user uuid)
returns void
language plpgsql security definer set search_path = public as $$
declare
  v_privacy text;
  v_college uuid;
begin
  select privacy, college_id into v_privacy, v_college from public.clubs where id = p_club and archived_at is null;
  if v_privacy is null then
    raise exception 'That community no longer accepts invitations.';
  end if;
  if not public.is_club_active_member(p_club, auth.uid()) then
    raise exception 'Only members can invite classmates.';
  end if;
  if v_privacy = 'public' then
    raise exception 'This community is open — classmates can join directly.';
  end if;
  if not exists (select 1 from public.profiles where id = p_user) then
    raise exception 'No such member to invite.';
  end if;
  if v_college is not null
    and (select college_id from public.profiles where id = p_user) is distinct from v_college then
    raise exception 'You can only invite members of the same college into a college community.';
  end if;
  if exists (select 1 from public.club_member_ctx(p_club, p_user) where member_status is not null) then
    raise exception 'That classmate is already a member or has a pending request.';
  end if;
  insert into public.community_invitations (club_id, inviter_id, invitee_id)
  values (p_club, auth.uid(), p_user)
  on conflict (club_id, invitee_id) do nothing;
  perform public.notify_member(p_user, auth.uid(), 'club_invitation', 'club', p_club);
end $$;

-- The invitee answers. Accepting joins directly.
create or replace function public.respond_invite(p_invite uuid, p_accept boolean)
returns text
language plpgsql security definer set search_path = public as $$
declare
  v_row public.community_invitations;
begin
  select * into v_row from public.community_invitations where id = p_invite;
  if v_row.invitee_id is null then
    raise exception 'That invitation does not exist.';
  end if;
  if v_row.invitee_id <> auth.uid() then
    raise exception 'Only the invited classmate can answer this invitation.';
  end if;
  delete from public.community_invitations where id = p_invite;
  if p_accept then
    insert into public.club_members (club_id, user_id, role, status)
    values (v_row.club_id, auth.uid(), 'member', 'active')
    on conflict (club_id, user_id) do update set status = 'active'
    where public.club_members.status <> 'banned';
    if not exists (
      select 1 from public.club_members cm
      where cm.club_id = v_row.club_id and cm.user_id = auth.uid() and cm.status = 'active'
    ) then
      raise exception 'This invitation can no longer join you — ask a moderator.';
    end if;
    perform public.ensure_club_conversation(v_row.club_id);
    insert into public.conversation_members (conversation_id, user_id)
    select con.id, auth.uid() from public.conversations con where con.club_id = v_row.club_id
    on conflict (conversation_id, user_id) do nothing;
    return 'accepted';
  end if;
  return 'declined';
end $$;

-- Role management: owner-only, target must be active, owner never demoted.
create or replace function public.set_member_role(p_club uuid, p_user uuid, p_role text)
returns void
language plpgsql security definer set search_path = public as $$
declare
  v_target_role text;
begin
  if not public.is_club_owner(p_club, auth.uid()) then
    raise exception 'Only the owner can assign community roles.';
  end if;
  if p_role not in ('member', 'moderator') then
    raise exception 'Use the ownership transfer for a new owner.';
  end if;
  select member_role into v_target_role from public.club_member_ctx(p_club, p_user);
  if v_target_role is null then
    raise exception 'That member is not part of this community.';
  end if;
  if v_target_role in ('owner', 'admin') then
    raise exception 'The owner keeps the community — transfer ownership instead.';
  end if;
  update public.club_members set role = p_role
  where club_id = p_club and user_id = p_user and status = 'active';
  perform public.notify_member(p_user, auth.uid(), 'club_role_changed', 'club', p_club);
end $$;

-- Removal: anyone from the owner; moderators only plain members. Banned
-- members keep a row so they cannot re-seek approval themselves.
create or replace function public.remove_member(p_club uuid, p_user uuid, p_ban boolean default false)
returns void
language plpgsql security definer set search_path = public as $$
declare
  v_target_role text;
begin
  if not public.is_club_moderator(p_club, auth.uid()) then
    raise exception 'Only owners and moderators manage members.';
  end if;
  select member_role into v_target_role from public.club_member_ctx(p_club, p_user);
  if v_target_role is null then
    raise exception 'That member is not part of this community.';
  end if;
  if v_target_role in ('owner', 'admin') then
    raise exception 'The owner cannot be removed this way.';
  end if;
  if v_target_role in ('moderator', 'admin') and not public.is_club_owner(p_club, auth.uid()) then
    raise exception 'Only the owner can remove a moderator.';
  end if;
  if p_ban then
    update public.club_members set status = 'banned', role = 'member'
    where club_id = p_club and user_id = p_user;
  else
    delete from public.club_members where club_id = p_club and user_id = p_user;
  end if;
  delete from public.conversation_members cm
  using public.conversations con
  where con.club_id = p_club and cm.conversation_id = con.id and cm.user_id = p_user;
  if p_ban then
    perform public.notify_member(p_user, auth.uid(), 'club_banned', 'club', p_club);
  else
    perform public.notify_member(p_user, auth.uid(), 'club_removed', 'club', p_club);
  end if;
end $$;

-- Ownership transfer: single, atomic swap. The previous owner becomes a
-- moderator so the community never loses its history.
create or replace function public.transfer_ownership(p_club uuid, p_user uuid)
returns void
language plpgsql security definer set search_path = public as $$
declare
  v_status text;
begin
  if not public.is_club_owner(p_club, auth.uid()) then
    raise exception 'Only the owner can transfer ownership.';
  end if;
  select member_status into v_status from public.club_member_ctx(p_club, p_user);
  if v_status <> 'active' then
    raise exception 'Ownership can only pass to an active member.';
  end if;
  update public.club_members set role = 'moderator'
  where club_id = p_club and user_id = auth.uid() and role in ('owner', 'admin');
  update public.club_members set role = 'owner', status = 'active'
  where club_id = p_club and user_id = p_user;
  perform public.notify_member(p_user, auth.uid(), 'club_ownership', 'club', p_club);
end $$;

-- Lifecycle: owners archive/archive-undo. Archived communities vanish from
-- discovery and block posting/joins server-side.
create or replace function public.archive_club(p_club uuid, p_archive boolean)
returns void
language plpgsql security definer set search_path = public as $$
begin
  if not public.is_club_owner(p_club, auth.uid()) then
    raise exception 'Only the owner can archive the community.';
  end if;
  update public.clubs set archived_at = case when p_archive then now() else null end
  where id = p_club;
end $$;

-- Pinned posts: moderators only.
create or replace function public.set_club_post_pin(p_club uuid, p_post uuid, p_pinned boolean)
returns void
language plpgsql security definer set search_path = public as $$
begin
  if not public.is_club_moderator(p_club, auth.uid()) then
    raise exception 'Only owners and moderators pin posts.';
  end if;
  if not exists (select 1 from public.posts where id = p_post and community_id = p_club) then
    raise exception 'That post does not belong to this community.';
  end if;
  if p_pinned then
    insert into public.club_pinned_posts (club_id, post_id, pinned_by)
    values (p_club, p_post, auth.uid())
    on conflict (club_id, post_id) do nothing;
  else
    delete from public.club_pinned_posts where club_id = p_club and post_id = p_post;
  end if;
end $$;

-- The community feed: pinned first, then newest. Public communities are
-- readable by everyone; private stay inside; hidden even more so.
create or replace function public.list_club_posts(
  p_club uuid,
  p_limit integer default 20,
  p_offset integer default 0
)
returns table (
  id uuid,
  body text,
  kind public.post_kind,
  media_urls text[],
  is_anonymous boolean,
  created_at timestamptz,
  edited_at timestamptz,
  author_id uuid,
  author_display_name text,
  author_username text,
  author_avatar_url text,
  author_is_verified boolean,
  college_id uuid,
  college_short_name text,
  like_count bigint,
  comment_count bigint,
  liked_by_me boolean,
  is_pinned boolean
)
language sql stable security definer set search_path = public as $$
  select
    p.id, p.body, p.kind, p.media_urls, p.is_anonymous, p.created_at, p.edited_at,
    p.author_id, pr.display_name, pr.username, pr.avatar_url, pr.is_verified,
    p.college_id, c.short_name,
    (select count(*) from public.post_likes l where l.post_id = p.id),
    (select count(*) from public.post_comments cc where cc.post_id = p.id),
    coalesce((select true from public.post_likes l where l.post_id = p.id and l.user_id = auth.uid()), false),
    exists (select 1 from public.club_pinned_posts pp where pp.post_id = p.id)
  from public.posts p
  left join public.profiles pr on pr.id = p.author_id
  left join public.colleges c on c.id = p.college_id
  where p.community_id = p_club
    and p.is_published = true
    and p.is_anonymous = false
    and exists (
      select 1 from public.clubs cl
      where cl.id = p_club and cl.archived_at is null
        and (
          cl.privacy = 'public'
          or public.is_club_active_member(p_club, auth.uid())
        )
    )
  order by exists (select 1 from public.club_pinned_posts pp2 where pp2.post_id = p.id) desc,
    p.created_at desc
  limit least(greatest(coalesce(p_limit, 20), 1), 50)
  offset greatest(coalesce(p_offset, 0), 0)
$$;

revoke all on function public.list_club_posts(uuid, integer, integer) from public;
grant execute on function public.list_club_posts(uuid, integer, integer) to anon, authenticated;

-- Member directory: everyone for public communities, active members for
-- private ones, whoever an RLS-hidden community admits.
create or replace function public.list_club_members(
  p_club uuid,
  p_query text default '',
  p_limit integer default 50,
  p_offset integer default 0
)
returns table (
  user_id uuid,
  username text,
  display_name text,
  avatar_url text,
  is_verified boolean,
  role text,
  status text,
  joined_at timestamptz
)
language sql stable security definer set search_path = public as $$
  select
    cm.user_id, pr.username, pr.display_name, pr.avatar_url, pr.is_verified,
    cm.role, cm.status, cm.joined_at
  from public.club_members cm
  left join public.profiles pr on pr.id = cm.user_id
  where cm.club_id = p_club
    and cm.status = 'active'
    and (
      public.is_club_active_member(p_club, auth.uid())
      or exists (
        select 1 from public.clubs c2
        where c2.id = p_club and c2.privacy = 'public' and c2.archived_at is null
      )
    )
    and (btrim(p_query) = '' or pr.display_name ilike '%' || btrim(p_query) || '%' or pr.username ilike '%' || btrim(p_query) || '%')
  order by case cm.role when 'owner' then 0 when 'admin' then 0 when 'moderator' then 1 else 2 end,
    cm.joined_at asc
  limit least(greatest(coalesce(p_limit, 50), 1), 200)
  offset greatest(coalesce(p_offset, 0), 0)
$$;

revoke all on function public.list_club_members(uuid, text, integer, integer) from public;
grant execute on function public.list_club_members(uuid, text, integer, integer) to anon, authenticated;

-- Pending join requests: moderators only.
create or replace function public.list_join_requests(p_club uuid)
returns table (
  user_id uuid,
  username text,
  display_name text,
  avatar_url text,
  requested_at timestamptz
)
language sql stable security definer set search_path = public as $$
  select cm.user_id, pr.username, pr.display_name, pr.avatar_url, cm.joined_at
  from public.club_members cm
  left join public.profiles pr on pr.id = cm.user_id
  where cm.club_id = p_club
    and cm.status = 'pending'
    and public.is_club_moderator(p_club, auth.uid())
  order by cm.joined_at asc
$$;

revoke all on function public.list_join_requests(uuid) from public;
grant execute on function public.list_join_requests(uuid) to authenticated;

-- Open the community chat (existing chats in a separate tab of the detail
-- page; never in the personal Chats list).
create or replace function public.open_club_chat(p_club uuid)
returns uuid
language plpgsql security definer set search_path = public as $$
declare
  v_conv uuid;
begin
  if not public.is_club_active_member(p_club, auth.uid()) then
    raise exception 'Community chat is for members only.';
  end if;
  select public.ensure_club_conversation(p_club) into v_conv;
  insert into public.conversation_members (conversation_id, user_id)
  values (v_conv, auth.uid())
  on conflict (conversation_id, user_id) do nothing;
  return v_conv;
end $$;

revoke all on function public.open_club_chat(uuid) from public;
grant execute on function public.open_club_chat(uuid) to authenticated;

-- Resources: members share files (uploaded to storage first) or plain links.
create or replace function public.add_club_resource(
  p_club uuid,
  p_title text,
  p_description text default '',
  p_link_url text default '',
  p_storage_path text default null,
  p_file_name text default null,
  p_mime_type text default null,
  p_file_size bigint default null
)
returns uuid
language plpgsql security definer set search_path = public as $$
declare
  v_id uuid;
begin
  if not public.is_club_active_member(p_club, auth.uid()) then
    raise exception 'Community resources are for members.';
  end if;
  if p_title is null or length(btrim(p_title)) < 1 then
    raise exception 'Give the resource a title.';
  end if;
  if coalesce(p_storage_path, '') <> '' and coalesce(btrim(p_link_url), '') <> '' then
    raise exception 'A resource is either a file or a link.';
  end if;
  if coalesce(p_storage_path, '') = '' and coalesce(btrim(p_link_url), '') = '' then
    raise exception 'Attach a file or add a link.';
  end if;
  if coalesce(p_storage_path, '') <> '' then
    /* the storage path must sit inside the community's own folder AND the
       uploader's own sub-folder — matching the storage RLS rules exactly */
    if p_storage_path is null
      or (storage.foldername(p_storage_path))[1] <> p_club::text
      or (storage.foldername(p_storage_path))[2] <> auth.uid()::text then
      raise exception 'That storage location is not valid for this community.';
    end if;
  end if;
  insert into public.community_resources
    (club_id, uploader_id, title, description, link_url, file_name, mime_type, file_size, storage_path)
  values (
    p_club, auth.uid(), btrim(p_title), btrim(coalesce(p_description, '')),
    btrim(coalesce(p_link_url, '')), p_file_name, p_mime_type, p_file_size, p_storage_path
  )
  returning id into v_id;
  return v_id;
end $$;

revoke all on function public.add_club_resource(uuid, text, text, text, text, text, text, bigint) from public;
grant execute on function public.add_club_resource(uuid, text, text, text, text, text, text, bigint) to authenticated;

create or replace function public.list_club_resources(p_club uuid)
returns table (
  id uuid,
  title text,
  description text,
  link_url text,
  file_name text,
  mime_type text,
  file_size bigint,
  storage_path text,
  created_at timestamptz,
  uploader_id uuid,
  uploader_name text,
  uploader_username text,
  mine boolean
)
language sql stable security definer set search_path = public as $$
  select
    r.id, r.title, r.description, r.link_url, r.file_name, r.mime_type, r.file_size,
    r.storage_path, r.created_at, r.uploader_id,
    ur.display_name, ur.username,
    r.uploader_id = auth.uid()
  from public.community_resources r
  left join public.profiles ur on ur.id = r.uploader_id
  where r.club_id = p_club
    and public.is_club_active_member(p_club, auth.uid())
  order by r.created_at desc
$$;

revoke all on function public.list_club_resources(uuid) from public;
grant execute on function public.list_club_resources(uuid) to authenticated;

-- Events (legacy events table, linked to communities).
create or replace function public.save_club_event(
  p_club uuid,
  p_event uuid,
  p_title text,
  p_description text,
  p_venue text,
  p_start_at timestamptz,
  p_end_at timestamptz,
  p_cover_url text,
  p_registration_url text,
  p_capacity integer
)
returns uuid
language plpgsql security definer set search_path = public as $$
declare
  v_id uuid;
  v_creator uuid;
begin
  if not public.is_club_moderator(p_club, auth.uid()) then
    raise exception 'Only owners and moderators manage events.';
  end if;
  if p_title is null or length(btrim(p_title)) < 3 then
    raise exception 'Give the event a title.';
  end if;
  if p_start_at is null then
    raise exception 'Pick a start time.';
  end if;
  if p_end_at is not null and p_end_at < p_start_at then
    raise exception 'The end time must come after the start.';
  end if;
  if p_event is null then
    insert into public.events
      (club_id, created_by, title, description, venue, starts_at, ends_at, cover_url, registration_url, capacity)
    values
      (p_club, auth.uid(), btrim(p_title), btrim(coalesce(p_description, '')), nullif(btrim(coalesce(p_venue, '')), ''),
       p_start_at, p_end_at, p_cover_url, nullif(btrim(coalesce(p_registration_url, '')), ''), p_capacity)
    returning id into v_id;
    return v_id;
  end if;
  select created_by into v_creator from public.events where id = p_event and club_id = p_club;
  if v_creator is null then
    raise exception 'That event does not belong to this community.';
  end if;
  if v_creator <> auth.uid() and not public.is_club_owner(p_club, auth.uid()) then
    raise exception 'Only the organizer or the owner can edit an event.';
  end if;
  update public.events set
    title = btrim(p_title),
    description = btrim(coalesce(p_description, '')),
    venue = nullif(btrim(coalesce(p_venue, '')), ''),
    starts_at = p_start_at,
    ends_at = p_end_at,
    cover_url = p_cover_url,
    registration_url = nullif(btrim(coalesce(p_registration_url, '')), ''),
    capacity = p_capacity
  where id = p_event
  returning id into v_id;
  return v_id;
end $$;

revoke all on function public.save_club_event(uuid, uuid, text, text, text, timestamptz, timestamptz, text, text, integer) from public;
grant execute on function public.save_club_event(uuid, uuid, text, text, text, timestamptz, timestamptz, text, text, integer) to authenticated;

create or replace function public.delete_club_event(p_event uuid)
returns void
language plpgsql security definer set search_path = public as $$
declare
  v_club uuid;
  v_creator uuid;
begin
  if auth.uid() is null then
    raise exception 'Sign in first.';
  end if;
  select club_id, created_by into v_club, v_creator from public.events where id = p_event;
  if v_club is null then
    raise exception 'That event does not exist.';
  end if;
  if not public.is_club_moderator(v_club, auth.uid())
    and v_creator <> auth.uid() then
    raise exception 'Only the organizer or moderators can delete an event.';
  end if;
  delete from public.events where id = p_event;
end $$;

revoke all on function public.delete_club_event(uuid) from public;
grant execute on function public.delete_club_event(uuid) to authenticated;

create or replace function public.list_club_events(p_club uuid)
returns table (
  id uuid,
  title text,
  description text,
  venue text,
  cover_url text,
  registration_url text,
  starts_at timestamptz,
  ends_at timestamptz,
  capacity integer,
  going_count bigint,
  interested_count bigint,
  my_status text,
  is_organizer boolean,
  created_by uuid,
  creator_name text,
  past boolean,
  cancelled boolean
)
language sql stable security definer set search_path = public as $$
  select
    e.id, e.title, e.description, e.venue, e.cover_url, e.registration_url,
    e.starts_at, e.ends_at, e.capacity,
    (select count(*) from public.event_rsvps r where r.event_id = e.id and r.status = 'going'),
    (select count(*) from public.event_rsvps r where r.event_id = e.id and r.status = 'interested'),
    (select status from public.event_rsvps r where r.event_id = e.id and r.user_id = auth.uid()),
    (e.created_by = auth.uid()),
    e.created_by,
    cr.display_name,
    (e.starts_at < now()),
    (e.cancelled_at is not null)
  from public.events e
  left join public.profiles cr on cr.id = e.created_by
  where e.club_id = p_club
    and (
      public.is_club_active_member(p_club, auth.uid())
      or exists (
        select 1 from public.clubs c where c.id = p_club and c.privacy = 'public' and c.archived_at is null
      )
    )
  order by
    (e.cancelled_at is null) desc,
    (e.starts_at > now()) desc,
    -- one numeric key: upcoming sorts by epoch (soonest first), past by its
    -- negation (most recent first). mixing starts_at and -epoch directly
    -- fails to compile: timestamptz and numeric have no common case type.
    case when e.starts_at > now() then extract(epoch from e.starts_at)
      else -extract(epoch from e.starts_at) end asc
$$;

revoke all on function public.list_club_events(uuid) from public;
grant execute on function public.list_club_events(uuid) to anon, authenticated;

create or replace function public.rsvp_event(p_event uuid, p_status text)
returns text
language plpgsql security definer set search_path = public as $$
declare
  v_club uuid;
  v_capacity integer;
  v_going bigint;
begin
  if p_status is null or not (p_status in ('going', 'interested', 'not_going')) then
    raise exception 'Unknown RSVP.';
  end if;
  select club_id into v_club from public.events where id = p_event and cancelled_at is null;
  if v_club is null then
    raise exception 'That event does not exist.';
  end if;
  if not public.is_club_active_member(v_club, auth.uid()) then
    raise exception 'RSVPs are for community members.';
  end if;
  if p_status = 'going' then
    select capacity into v_capacity
    from public.events where id = p_event
    for update;
    if v_capacity is not null then
      select count(*) into v_going
      from public.event_rsvps
      where event_id = p_event and status = 'going' and user_id <> auth.uid();
      if v_going >= v_capacity then
        raise exception 'The event is full (% of % seats taken).', v_going, v_capacity;
      end if;
    end if;
  end if;
  if p_status = 'not_going' then
    delete from public.event_rsvps where event_id = p_event and user_id = auth.uid();
    return 'removed';
  end if;
  insert into public.event_rsvps (event_id, user_id, status)
  values (p_event, auth.uid(), p_status)
  on conflict (event_id, user_id) do update
    set status = excluded.status, created_at = now();
  return p_status;
end $$;

revoke all on function public.rsvp_event(uuid, text) from public;
grant execute on function public.rsvp_event(uuid, text) to authenticated;

-- Reporting a community (extends the legacy reports table).
create or replace function public.report_club(p_club uuid, p_reason text, p_details text default '')
returns void
language plpgsql security definer set search_path = public as $$
begin
  if auth.uid() is null then
    raise exception 'Sign in to report a community.';
  end if;
  if p_reason is null or length(btrim(p_reason)) < 3 then
    raise exception 'Describe the problem in a few words.';
  end if;
  insert into public.reports (reporter_id, club_id, reason, details)
  values (auth.uid(), p_club, btrim(p_reason), nullif(btrim(coalesce(p_details, '')), ''));
end $$;

revoke all on function public.report_club(uuid, text, text) from public;
grant execute on function public.report_club(uuid, text, text) to authenticated;

create or replace function public.list_club_reports(p_club uuid)
returns table (
  id uuid,
  reason text,
  details text,
  status text,
  created_at timestamptz,
  reporter_name text
)
language sql stable security definer set search_path = public as $$
  select r.id, r.reason, r.details, r.status::text, r.created_at, pr.display_name
  from public.reports r
  left join public.profiles pr on pr.id = r.reporter_id
  where r.club_id = p_club
    and public.is_club_moderator(p_club, auth.uid())
  order by r.created_at desc
  limit 100
$$;

revoke all on function public.list_club_reports(uuid) from public;
grant execute on function public.list_club_reports(uuid) to authenticated;

-- Community share links use the slug (#c/<slug>): resolve it to the id.
-- Hidden communities stay invisible here — their id is never handed out by
-- slug, only through a real invitation flow.
create or replace function public.club_id_by_slug(p_slug text)
returns uuid
language sql stable security definer set search_path = public as $$
  select c.id
  from public.clubs c
  where lower(btrim(p_slug)) = lower(c.slug)
    and c.archived_at is null
    and (
      c.privacy <> 'hidden'
      or exists (
        select 1 from public.club_members cm
        where cm.club_id = c.id and cm.user_id = auth.uid()
      )
    )
  limit 1
$$;

revoke all on function public.club_id_by_slug(text) from public;
grant execute on function public.club_id_by_slug(text) to anon, authenticated;

