# My College deployment note — migration 0045 (verified content)

One out-of-band step this feature needs, and what degrades gracefully until
it is applied. Modeled on PUSH-DEPLOYMENT.md: interactive steps that cannot
be performed from the app or the repo alone.

## 1. Apply `0045_mycollege_scope.sql` (SQL editor, once)

File: `supabase/migrations/0045_mycollege_scope.sql` — additive only; nothing
existing is dropped or rewritten. Run the whole file in the Supabase SQL
editor (or `psql`). It does exactly two things:

1. Two indexes that college-scoped reads walk:
   - `posts_college_created_idx` on `posts (college_id, created_at desc)`
   - `profiles_college_idx` on `profiles (college_id)` (partial — non-null only)
2. Rebuilds `search_members(text, integer)` with an extra `college_id uuid`
   return column and RETAINS the existing `is_verified` column (Search hall
   and My College render the verified tick from it — the first draft of this
   file dropped it; amended before applying). Same name, same args, same
   SECURITY DEFINER visibility as 0010 — existing callers work unchanged.

Verify after applying:

```sql
select indexname from pg_indexes
  where indexname in ('posts_college_created_idx', 'profiles_college_idx');
-- expect exactly 2 rows

select * from search_members('test', 3);
-- the result grid must include the college_id column AND is_verified
```

## 2. What works before vs after (no code change needed either way)

| Surface | Before 0045 | After 0045 |
|---|---|---|
| My College all 11 tabs | fully live (verified) | identical |
| In-college search (students) | scores hits by short-name equal check | canonical `college_id` match |
| College feed/promotion reads | per-table unscoped reads | index-backed college → time walks |

Until 0045 is applied the app keeps working through the documented fallback:
`fetchCollegeStudents`/`findClassmates` compare `college_short_name` when a
payload row carries no usable `college_id`. That is honest and stable, but
short names are not unique across institutions long-term — apply 0045 when
convenient; nothing in the UI needs to change afterward.

## 2a. Companion migration 0046 (same sitting)

While applying 0045, also apply `supabase/migrations/0046_confession_anonymity.sql`
— it closes the anonymous-author leak on the `posts` table (a direct-SELECT
path around the RPC nulling) and pairs with a one-line client change already
in this commit (`createPost` no longer requests `author_id` in RETURNING).
Apply/verify/rollback instructions are in that file's header. Order within
the same session does not matter; both are instant and either can be applied
first.

## 3. Not built (documented integration point)

- **Announcements backend** — deliberately absent. The staff empty state on
  My College says platform staff reach the main feed via @campus; a college-
  scoped announcements service is a future feature, not a stub: no fake
  controls were rendered.
- **Verified-student badge** — unchanged. College choice remains a
  self-declared affiliation (charter: no student-ID/identity verification).
