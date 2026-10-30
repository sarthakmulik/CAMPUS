-- ============================================================================
-- 0050 — PROJECTION-TABLE POLICY REPAIR (post_comments)
--
-- Live testing of 0049 caught an isolation hole: 0049 dropped/created its
-- gated comment policies under names ("comments readable", "users create
-- comments") that never existed on the live table — the LIVE policies date
-- from 0005 ("comments readable by everyone", "members comment as
-- themselves"). Postgres RLS policies are permissive-OR, so the old
-- allow-all select + insert policies kept winning and outsiders could
-- comment on — and read the threads of — college-scoped posts.
--
-- Verified live before the fix (IITB outsider vs a COEP college-only post):
--   POST post_comments  → 201   (must have been 403)
--   GET  post_comments  → 200   (thread leaked)
--   anon GET            → 200
-- Posts' own RLS (feeds/deep-links/stats) verified correct; post_likes and
-- post_reposts had no pre-0049 policies, so they are already gated.
--
-- Also fixes list_post_comments(): the security-definer read RPC bypasses
-- table policies, so it now applies can_view_post itself.
--
-- Safe to re-run. Run in the Supabase SQL editor.
-- ============================================================================

-- 1. kill the 0005-era permissive policies -----------------------------------
drop policy if exists "comments readable by everyone" on public.post_comments;
drop policy if exists "members comment as themselves" on public.post_comments;
drop policy if exists "comments readable" on public.post_comments;

-- 2. read: only where the parent post is visible to the caller ----------------
drop policy if exists "comments readable within post audience" on public.post_comments;
create policy "comments readable within post audience" on public.post_comments
  for select to authenticated
  using (public.can_view_post(post_id));

-- 3. write: you may insert / edit / delete YOUR comment only while the
--    parent post is visible to you (authors always see their own posts)
drop policy if exists "authors edit own comments" on public.post_comments;
drop policy if exists "users create comments" on public.post_comments;
create policy "authors manage own comments" on public.post_comments
  for all to authenticated
  using (
    author_id = auth.uid()
    and public.can_view_post(post_id)
  )
  with check (
    author_id = auth.uid()
    and public.can_view_post(post_id)
  );

-- 4. the read RPC applies the same rule in its definer context ---------------
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
    and exists (
      select 1 from public.posts p
      where p.id = c.post_id
        and p.is_published = true
        and public.post_visible_to(p.audience, p.college_id, p.author_id)
    )
  order by c.created_at asc
  limit 200;
$$;

revoke all on function public.list_post_comments(uuid) from public;
grant execute on function public.list_post_comments(uuid) to anon, authenticated;
