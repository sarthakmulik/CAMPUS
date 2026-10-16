-- =============================================================================
-- CAMPUS migration 0005 — Comments
--
-- Real comments on every post kind (text, image, reel, confession):
--   1. post_comments table (idempotent: created only if it does not exist).
--   2. RLS: everyone can read; members comment as themselves; authors may
--      edit/delete their own comments.
--   3. list_post_comments(): one RPC a client calls to load a post's comment
--      thread with author profile info, oldest first.
--
-- Safe to re-run. Run in the Supabase SQL editor.
-- =============================================================================

-- 1. Table ---------------------------------------------------------------------
create table if not exists public.post_comments (
  id uuid primary key default gen_random_uuid(),
  post_id uuid not null references public.posts(id) on delete cascade,
  author_id uuid not null references public.profiles(id) on delete cascade,
  body text not null,
  created_at timestamptz not null default now(),
  edited_at timestamptz
);

-- Defensive column top-ups in case a partial table pre-exists.
alter table public.post_comments add column if not exists body text;
alter table public.post_comments add column if not exists created_at timestamptz not null default now();
alter table public.post_comments add column if not exists edited_at timestamptz;

create index if not exists post_comments_post_time_idx
  on public.post_comments (post_id, created_at);

-- 2. RLS -----------------------------------------------------------------------
alter table public.post_comments enable row level security;

drop policy if exists "comments readable by everyone" on public.post_comments;
create policy "comments readable by everyone"
  on public.post_comments for select
  using (true);

drop policy if exists "members comment as themselves" on public.post_comments;
create policy "members comment as themselves"
  on public.post_comments for insert
  to authenticated
  with check (author_id = auth.uid());

drop policy if exists "authors edit own comments" on public.post_comments;
create policy "authors edit own comments"
  on public.post_comments for update
  to authenticated
  using (author_id = auth.uid())
  with check (author_id = auth.uid());

drop policy if exists "authors delete own comments" on public.post_comments;
create policy "authors delete own comments"
  on public.post_comments for delete
  to authenticated
  using (author_id = auth.uid());

-- 3. Thread loader RPC ------------------------------------------------------------
drop function if exists public.list_post_comments(uuid);

create or replace function public.list_post_comments(p_post_id uuid)
returns table (
  id uuid,
  post_id uuid,
  body text,
  created_at timestamptz,
  edited_at timestamptz,
  author_id uuid,
  author_display_name text,
  author_username text,
  author_avatar_url text
)
language sql
stable
security definer
set search_path = ''
as $$
  select
    c.id,
    c.post_id,
    c.body,
    c.created_at,
    c.edited_at,
    c.author_id,
    pr.display_name,
    pr.username,
    pr.avatar_url
  from public.post_comments c
  left join public.profiles pr on pr.id = c.author_id
  where c.post_id = p_post_id
  order by c.created_at asc
  limit 200;
$$;

revoke all on function public.list_post_comments(uuid) from public;
grant execute on function public.list_post_comments(uuid) to anon, authenticated;
