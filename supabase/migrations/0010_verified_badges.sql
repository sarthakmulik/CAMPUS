-- 0010 — verified profiles (blue tick)
--
-- Verification is a platform decision, not a claim: only an account whose
-- profiles.role = 'admin' may turn the flag on or off, decided by three
-- independent locks:
--   1. a trigger on profiles — nobody (including the row owner) flips
--      is_verified without being an admin;
--   2. set_profile_verified(p_user, p_verified) — the RPC the admin UI uses;
--   3. the feed/search RPCs below just *(read)* the flag.
--
-- Fully idempotent: safe to re-run from any partial state (functions use
-- create-or-replace, RPC redefinitions start with drop-if-exists, and the
-- trigger name is dropped first).

alter table public.profiles add column if not exists is_verified boolean not null default false;

-- 1. lock --------------------------------------------------------------------

drop trigger if exists verification_only_admin on public.profiles;

create or replace function public.enforce_verification_admin()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  viewer_is_admin boolean;
begin
  -- No auth uid means tooling (SQL editor / service jobs) — that context is
  -- human-administered by construction and can verify. REST/anon callers
  -- always carry a real uid and are judged by their role instead.
  if auth.uid() is null then
    viewer_is_admin := true;
  else
    select coalesce(p.role = 'admin', false) into viewer_is_admin
      from public.profiles p where p.id = auth.uid();
  end if;
  if coalesce(viewer_is_admin, false) then
    return new;
  end if;
  if TG_OP = 'INSERT' then
    if new.is_verified then
      raise exception 'Only CAMPUS admins can verify a profile.'
        using errcode = '42501';
    end if;
  elsif TG_OP = 'UPDATE' and new.is_verified is distinct from old.is_verified then
    raise exception 'Only CAMPUS admins can change verification.'
      using errcode = '42501';
  end if;
  return new;
end;
$$;

create trigger verification_only_admin
  before insert or update on public.profiles
  for each row
  execute function public.enforce_verification_admin();

-- 2. admin RPC ----------------------------------------------------------------

create or replace function public.set_profile_verified(
  p_user uuid,
  p_verified boolean
)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  viewer_is_admin boolean;
begin
  if auth.uid() is null then
    viewer_is_admin := true; -- tooling context (SQL editor / service jobs)
  else
    select coalesce(p.role = 'admin', false) into viewer_is_admin
      from public.profiles p where p.id = auth.uid();
  end if;
  if not coalesce(viewer_is_admin, false) then
    raise exception 'Only CAMPUS admins can change verification.'
      using errcode = '42501';
  end if;
  update public.profiles set is_verified = p_verified where id = p_user;
end;
$$;
revoke all on function public.set_profile_verified(uuid, boolean) from public, anon;
grant execute on function public.set_profile_verified(uuid, boolean) to authenticated;

-- 3. reads --------------------------------------------------------------------
-- list_public_posts re-created with the verified flag attached to the author
-- (null for anonymous posts on purpose: a verified author's confession must
-- not advertise who wrote it).

drop function if exists public.list_public_posts(integer, integer, uuid);

create or replace function public.list_public_posts(
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
language sql stable security definer set search_path = ''
as $$
  select
    p.id,
    p.body,
    p.kind,
    p.media_urls,
    p.is_anonymous,
    p.created_at,
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
    and (p_college_id is null or p.college_id = p_college_id)
  order by p.created_at desc
  limit least(greatest(coalesce(p_limit, 20), 1), 50)
  offset greatest(coalesce(p_offset, 0), 0);
$$;

revoke all on function public.list_public_posts(integer, integer, uuid) from public;
grant execute on function public.list_public_posts(integer, integer, uuid) to anon, authenticated;

-- search_members re-created with the verified flag.

drop function if exists public.search_members(text, integer);

create or replace function public.search_members(
  p_query text,
  p_limit integer default 10
)
returns table (
  id uuid,
  username text,
  display_name text,
  avatar_url text,
  college_short_name text,
  is_private boolean,
  is_verified boolean
)
language sql stable security definer set search_path = '' as $$
  select
    pr.id,
    pr.username,
    pr.display_name,
    pr.avatar_url,
    c.short_name,
    pr.is_private,
    pr.is_verified
  from public.profiles pr
  left join public.colleges c on c.id = pr.college_id
  where btrim(p_query) <> ''
    and (
      pr.display_name ilike '%' || btrim(p_query) || '%'
      or pr.username ilike '%' || btrim(p_query) || '%'
      or pr.first_name ilike '%' || btrim(p_query) || '%'
      or pr.last_name ilike '%' || btrim(p_query) || '%'
    )
    and pr.id <> coalesce(auth.uid(), '00000000-0000-0000-0000-000000000000'::uuid)
  order by pr.display_name asc nulls last
  limit least(greatest(coalesce(p_limit, 10), 1), 25)
$$;

revoke all on function public.search_members(text, integer) from public;
grant execute on function public.search_members(text, integer) to anon, authenticated;

-- search_posts re-created with the author's verified flag (hidden when anonymous).

drop function if exists public.search_posts(text, integer);

create or replace function public.search_posts(
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
    and (
      p.body ilike '%' || btrim(p_query) || '%'
      -- posts revolving around the keyword include named authors' posts
      or (
        btrim(p_query) <> ''
        and p.is_anonymous = false
        and (
          pr.display_name ilike '%' || btrim(p_query) || '%'
          or pr.username ilike '%' || btrim(p_query) || '%'
        )
      )
    )
    -- anonymous confessions must not leak through keyword search: matched only
    -- via their own body, and self-identifying in the body is possible, but
    -- author fields still come back null (the feed RPC behaves the same).
  order by p.created_at desc
  limit least(greatest(coalesce(p_limit, 10), 1), 25)
$$;

revoke all on function public.search_posts(text, integer) from public;
grant execute on function public.search_posts(text, integer) to anon, authenticated;
