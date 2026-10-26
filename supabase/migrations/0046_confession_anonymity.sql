-- =====================================================================
-- 0046 — Confession anonymity enforced at the table layer (SEC-01).
--
-- Confirmed defect: with the public anon key, REST reads on public.posts
-- returned the raw author_id of is_anonymous rows. Anonymity was enforced
-- only inside the SECURITY DEFINER RPCs (list_public_posts, search_posts,
-- list_saved_items …); the direct table path walked straight around it —
-- meaning anyone could de-anonymize every confession from page source.
--
-- Fix shape (grants only — no schema change, no data touched):
--   1. Revoke table-level SELECT on posts from anon + authenticated.
--      (Per PostgreSQL semantics this also clears every column-level
--      SELECT grant made by the table owner.)
--   2. Re-grant SELECT on every column EXCEPT author_id, enumerated from
--     information_schema (stays correct if a later migration adds
--     columns; author_id never returns to the caller-visible path).
--   3. INSERT / UPDATE / DELETE are left as they were — RLS (0003, 0016)
--     already scopes those to the author / moderator paths, and no client
--     code reads author_id back through PostgREST: createPost() in db.ts
--     no longer requests it in its RETURNING select (shipped together
--     with this migration). UPDATE..RETURNING(id, edited_at) and
--     DELETE..RETURNING(id) only touch granted columns.
--   4. All existing read RPCs are SECURITY DEFINER — their outputs and
--     behavior are untouched by caller-level grants.
--
-- Prerequisites (same Phase A change-set, must land together):
--   * src/lib/db.ts createPost(): '.select(...)' without author_id and
--     authorId taken from input.userId locally (anonymous → null).
--
-- Apply (SQL editor or psql, once): run the whole file.
--
-- Verify after applying (SQL editor):
--   begin;
--     set local role authenticated;
--     select author_id from public.posts limit 1;   -- must FAIL (permission denied)
--     select id, body, created_at from public.posts limit 1;  -- must succeed
--     set local role anon;
--     select author_id from public.posts limit 1;   -- must FAIL
--   rollback;
--   Also from the browser (signed-in probe user):
--     GET /rest/v1/posts?select=author_id&limit=1  → 403/permission error
--     GET /rest/v1/posts?select=id,body&limit=1    → 200
--   And the app must keep working: open the Feed, Compose a text post,
--   delete it again, and read Confessions and Trending tags — all flows
--   live behind createPost/updatePost/deletePost/fetchTrendingTags.
--
-- Rollback (restores the pre-0046 state in one step):
--   grant select on public.posts to anon, authenticated;
-- =====================================================================

revoke select on public.posts from anon, authenticated;

-- Column-level SELECT grants for every column except author_id. Enumerated
-- live from information_schema rather than hard-coded, so the grant set
-- always matches the real table shape.
do $$
declare
  col record;
begin
  for col in
    select column_name
    from information_schema.columns
    where table_schema = 'public'
      and table_name = 'posts'
      and column_name <> 'author_id'
  loop
    execute format(
      'grant select (%I) on public.posts to anon, authenticated',
      col.column_name
    );
  end loop;
end $$;
