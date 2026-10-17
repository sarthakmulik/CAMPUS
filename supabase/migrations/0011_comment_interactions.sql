-- =============================================================================
-- CAMPUS migration 0011 — Comment interactions
--
-- Instagram-style comment threads on every post kind:
--   1. post_comments.parent_id — replies to comments, exactly ONE level deep
--      (a reply can never be a reply-to-a-reply; trigger enforces it).
--   2. post_comments.pinned_at — the post author (or a platform admin) can
--      pin one comment to the top of a thread via set_comment_pinned().
--   3. comment_likes table — members like comments; counts ride along in
--      the thread loader.
--   4. list_post_comments() rewritten to return the full thread shape:
--      parent links, pinned state, like count and liked-by-me.
--
-- Safe to re-run statement by statement.
-- =============================================================================

-- 1. Thread columns -------------------------------------------------------------

alter table public.post_comments add column if not exists parent_id uuid;
alter table public.post_comments add column if not exists pinned_at timestamptz;

do $$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'post_comments_parent_fk' and conrelid = 'public.post_comments'::regclass
  ) then
    -- cleaned separately if the parent row goes away, keep the fk loose
    execute 'alter table public.post_comments add constraint post_comments_parent_fk foreign key (parent_id) references public.post_comments(id) on delete cascade';
  end if;
end $$;

create index if not exists post_comments_parent_idx on public.post_comments (parent_id);

-- One level of replies, server-enforced (nothing hierarchical drifts in).
drop trigger if exists comment_reply_depth on public.post_comments;
create or replace function public.enforce_comment_reply_depth()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if new.parent_id is not null then
    if exists (
      select 1 from public.post_comments pc where pc.id = new.parent_id and pc.parent_id is not null
    ) then
      raise exception 'Replies go one level deep — reply to a comment, not to a reply.'
        using errcode = '23514';
    end if;
    if exists (
      select 1 from public.post_comments pc where pc.id = new.parent_id and pc.post_id <> new.post_id
    ) then
      raise exception 'A reply belongs to the conversation of its parent comment.'
        using errcode = '23514';
    end if;
  end if;
  return new;
end;
$$;

create trigger comment_reply_depth
  before insert or update on public.post_comments
  for each row
  execute function public.enforce_comment_reply_depth();

-- 2. Comment likes ----------------------------------------------------------------

create table if not exists public.comment_likes (
  comment_id uuid not null references public.post_comments(id) on delete cascade,
  user_id uuid not null references public.profiles(id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (comment_id, user_id)
);

alter table public.comment_likes enable row level security;

drop policy if exists "comment likes readable by everyone" on public.comment_likes;
create policy "comment likes readable by everyone"
  on public.comment_likes for select
  using (true);

drop policy if exists "members like as themselves" on public.comment_likes;
create policy "members like as themselves"
  on public.comment_likes for insert
  to authenticated
  with check (user_id = auth.uid());

drop policy if exists "members unlike their own likes" on public.comment_likes;
create policy "members unlike their own likes"
  on public.comment_likes for delete
  to authenticated
  using (user_id = auth.uid());

-- 3. Pinning -----------------------------------------------------------------------

create or replace function public.set_comment_pinned(
  p_comment uuid,
  p_pinned boolean
)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  comment_post uuid;
  post_author uuid;
  viewer_is_admin boolean;
begin
  select pc.post_id, ps.author_id into comment_post, post_author
    from public.post_comments pc
    join public.posts ps on ps.id = pc.post_id
    where pc.id = p_comment;

  if comment_post is null then
    raise exception 'That comment no longer exists.' using errcode = '23505';
  end if;

  select coalesce(p.role = 'admin', true) into viewer_is_admin
    from public.profiles p where p.id = auth.uid();

  if post_author is distinct from auth.uid() and not coalesce(viewer_is_admin, false) then
    raise exception 'Only the post author can pin comments.'
      using errcode = '42501';
  end if;

  if p_pinned then
    -- one pinned comment per thread: the new pin replaces the old
    update public.post_comments set pinned_at = null
      where post_id = comment_post and pinned_at is not null and id <> p_comment;
    update public.post_comments set pinned_at = now() where id = p_comment;
  else
    update public.post_comments set pinned_at = null
      where id = p_comment and pinned_at is not null;
  end if;
end;
$$;
revoke all on function public.set_comment_pinned(uuid, boolean) from public, anon;
grant execute on function public.set_comment_pinned(uuid, boolean) to authenticated;

-- 4. Thread loader -------------------------------------------------------------------

drop function if exists public.list_post_comments(uuid);

create or replace function public.list_post_comments(p_post_id uuid)
returns table (
  id uuid,
  post_id uuid,
  parent_id uuid,
  body text,
  created_at timestamptz,
  edited_at timestamptz,
  pinned_at timestamptz,
  author_id uuid,
  author_display_name text,
  author_username text,
  author_avatar_url text,
  author_is_verified boolean,
  like_count bigint,
  liked_by_me boolean
)
language sql
stable
security definer
set search_path = ''
as $$
  select
    c.id,
    c.post_id,
    c.parent_id,
    c.body,
    c.created_at,
    c.edited_at,
    c.pinned_at,
    c.author_id,
    pr.display_name,
    pr.username,
    pr.avatar_url,
    pr.is_verified,
    (select count(*) from public.comment_likes cl where cl.comment_id = c.id),
    coalesce(
      (select true from public.comment_likes cl where cl.comment_id = c.id and cl.user_id = auth.uid()),
      false
    )
  from public.post_comments c
  left join public.profiles pr on pr.id = c.author_id
  where c.post_id = p_post_id
  order by c.created_at asc
  limit 300;
$$;

revoke all on function public.list_post_comments(uuid) from public;
grant execute on function public.list_post_comments(uuid) to anon, authenticated;
