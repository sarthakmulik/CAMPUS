# Post audience deployment note — migration 0049 (My-College-only posting)

> ## ⚠️ REQUIRED IMMEDIATE FIX (run this one line right now if 0049 is applied
> ## and publishing/read posts from the client started 403-ing)
>
> Migration **0046** (confession anonymity) narrowed SELECT on `posts` to
> **column-level grants** (everything except `author_id`). A column added
> later by 0049 inherits **no grant**, so any direct table read/write that
> mentions `audience` fails with `42501 permission denied for table posts`
> — feeds still work (they are RPCs), but publishing and direct reads break.
>
> ```sql
> grant select (audience) on public.posts to anon, authenticated;
> ```
>
> Run it once in the SQL editor. The 0049 migration file now includes this
> grant itself, so fresh setups need nothing extra.

> ## Also required: migration **0050_projection_policy_repair.sql**
>
> Live pen-testing on 0029 caught that 0049's `drop policy if exists` names
> for `post_comments` never matched the LIVE policy names from 0005
> ("members comment as themselves", "comments readable by everyone"). Since
> RLS policies are permissive-OR, the old allow-all ones kept winning —
> outsiders could **comment on and read the threads of** college-scoped
> posts. 0050 drops those names, reasserts the gated policies, and adds the
> audience filter to the security-definer read RPC `list_post_comments`.
> Re-verified after applying: outsider comment insert → 403, outsider
> comment reads (direct + RPC, anon + auth) → 0 rows, public-thread reads
> unaffected.

One out-of-band step this feature needs, modeled on MYCOLLEGE-DEPLOYMENT.md
(PUSH-DEPLOYMENT.md pattern): a supabase SQL-editor run that cannot be
performed from the app or the repo alone.

## What it delivers

A new `posts.audience` column ('public' | 'college', default 'public') and
SERVER-ENFORCED visibility. After applying:

| surface | enforcement point |
|---|---|
| Home feed + My College tab | `list_public_posts(…)` |
| Discover reels | `list_public_reels(…)` |
| Deep links `#p/<id>` (shares) | `get_public_post(uuid)` — outsiders get the graceful "not available" answer |
| Profile grids + header counts | `list_member_posts(…)`, `profile_stats(…)` |
| Confessions feed | `list_confessions(…)` |
| Polls (create / vote / results) | `create_poll(…, p_audience)`, `cast_poll_vote`, `poll_states` |
| Direct API writes (RLS) | posts/comments/likes/reposts select + insert policies |
| Mentions | `posts_notify_mentions` (no cross-college ping) |

Rules: audience `'public'` → everyone incl. signed-out visitors. `'college'`
→ the author, active staff accounts, and members of the AUTHOR's own college
(college resolved server-side from the caller's profile at publish time;
never from the request). Everything else sees nothing — no row leaks via
likes lists, repost lists, comments, notification summaries or counts.

## 1. Apply `0049_post_audience.sql` (SQL editor, once)

File: `supabase/migrations/0049_post_audience.sql` — run the whole file. It
adds the column + check constraint + a partial index, then rebuilds every
reader/writer above. All rebuilds keep the existing signatures (create_poll
gains a trailing defaulted `p_audience` arg, so 0048-era callers are
unaffected). Existing rows default to `'public'`, so nothing disappears.

## 2. Client behavior until you apply it

The app degrades honestly, never fakes isolation:

- The composer shows an "Everyone / My College only" scope picker (members
  with a real college; staff posts stay platform-wide).
- If a college-scoped publish hits a pre-0049 database, the client retries
  the legacy path and flashes: "Posted to the public feed — your college
  cannot be scoped yet (server update pending)." No post pretends to be
  private when the server is not enforcing it.

## Verify after applying

```sql
-- no stored row may fail the boundary the caller sees
select id from public.posts
  where is_published = true
    and audience = 'college'
    and not public.post_visible_to(audience, college_id, author_id);
-- expect 0 rows

-- helper sanity (run as different roles in the API: author, same-college,
-- other-college, staff):
select public.can_view_post('<a college-scoped post id>'::uuid);
```

In-app check: post with “My College only” selected → the card renders a
`MY COLLEGE` chip; an account from another college does NOT see it in Home,
Discover, profiles, confessions,Comments open/comment composer is likewise
blocked server-side (insert policy).

## Known product limitations (documented, intentional)

1. **Media URLs are public.** Storage buckets stay public-read because the
   browser renders `<img>/<video>` from public URLs; a guessed media URL of a
   college-only post is technically fetchable. The feed, threads and records
   are the security boundary here. Locking media would require signed URLs
   and a storage-serve rework.
2. **"My College" tab stays a view filter**, but after 0049 the data behind
   other-college posts simply never reaches the client in an enforceable way.
3. Reel cards in Discover do not yet carry a scope chip (posts/polls do).
4. Confessions keep displaying the anonymous card; a college-scoped
   confession is anonymous AND college-gated.
