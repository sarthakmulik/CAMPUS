-- ═══════════════════════════════════════════════════════════════════
-- 0016a: COMMUNITIES RLS PATCH (applies on top of 0016)
-- ═══════════════════════════════════════════════════════════════════
-- Why this exists: a policy's subqueries run as the INVOKING user, and
-- club_members has no SELECT policy by design (all membership reads go
-- through security-definer RPCs). So any POLICY that wrote
--   exists (select 1 from public.club_members cm where cm.user_id = auth.uid() ...)
-- inline saw ZERO rows for everyone — including community owners.
-- That silently broke: community post inserts (42501 probe-verified),
-- member visibility of private/hidden community posts, and every
-- resources-bucket read/upload for members.
--
-- Fix: every membership check inside a policy goes through the existing
-- security-definer helper public.is_club_active_member(p_club, p_user),
-- exactly like the events policy already did. Six policies are rebuilt
-- below; everything else in 0016 was already correct.
--
-- Idempotent: drop-if-exists + create. Safe to run again.

-- 1) clubs: hidden communities must be visible to their own members
drop policy if exists "communities readable per privacy" on public.clubs;
create policy "communities readable per privacy" on public.clubs
  for select using (
    archived_at is null
    and (
      privacy <> 'hidden'
      or public.is_club_active_member(public.clubs.id, auth.uid())
    )
  );

-- 2) posts INSERT: community posts need an ACTIVE membership (helper) and
--    a live community. The clubs EXISTS is policy-safe: the clubs select
--    policy never references posts, so no recursion.
--    (pre-0016 the policy was named "signed in users create posts" — drop
--    both names so this stays idempotent from any prior state)
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

-- 3) posts SELECT: public communities readable by anyone; private/hidden
--    communities readable by active members (through the helper).
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

-- 4) posts UPDATE: authors may never swing community_id into a community
--    they cannot post in (same helper-based check as INSERT).
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

-- 5) storage READ: members of the community (folder segment 1 = <club uuid>)
--    may list/download its resource files — through the helper.
drop policy if exists "community members read resources" on storage.objects;
create policy "community members read resources" on storage.objects
  for select to authenticated
  using (
    bucket_id = 'resources'
    and (storage.foldername(name))[1] ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
    and public.is_club_active_member((storage.foldername(name))[1]::uuid, auth.uid())
  );

-- 6) storage UPLOAD: only into resources/<club>/<own-user-id>/ and only
--    with an ACTIVE membership — through the helper.
drop policy if exists "community members upload resources" on storage.objects;
create policy "community members upload resources" on storage.objects
  for insert to authenticated
  with check (
    bucket_id = 'resources'
    and (storage.foldername(name))[1] ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
    and (storage.foldername(name))[2] = auth.uid()::text
    and public.is_club_active_member((storage.foldername(name))[1]::uuid, auth.uid())
  );
