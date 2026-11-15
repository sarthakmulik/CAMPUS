# Phase B — Social Graph Engine

The recommendation engine's relationship layer: who knows whom, how closely, and
why. Built on the graph the product already had. No second social system.

**Status:** implemented. `supabase/migrations/0065_social_graph.sql` is applied.
`supabase/migrations/0066_social_graph_grants.sql` tightens the function grants
and must be applied too — Supabase's default privileges give EXECUTE on every new
function to `anon`, so 0065's `revoke … from public` alone left both functions
callable by an anonymous caller (they returned zero rows, so no data was exposed,
but the grant was wider than the design). Apply 0060 → 0066 in order.

---

## 1. What already existed (reused, not duplicated)

| Thing | Where | How this phase uses it |
| --- | --- | --- |
| `follows (follower_id, followed_id)` | 0008 | the only source of truth for follow edges |
| `user_blocks`, `user_mutes` | 0001 | blocked pairs have no relationship |
| `club_members (club_id, user_id, status)` | 0016 | shared *active* communities |
| `post_likes`, `post_comments` | 0001 / 0005 | interaction signals |
| `profiles` (college_id, department_id, campus_id, account_status) | 0001 / 0043 / 0057 | institution and suspension gates |
| `leaderboard_point_events` | 0027 | engagement ledger — read by later phases, untouched here |

No new engagement table, no second follower model, no client-side score.

## 2. What this phase adds

**Indexes** — the lookups the graph actually performs:

- `post_likes (user_id, created_at desc)`
- `post_comments (author_id, created_at desc)`
- `club_members (user_id, club_id) where status = 'active'`

`follows` needed nothing: its PK is `(follower_id, followed_id)` and 0008
already has `(followed_id)`.

**`social_mutual_counts`** — one row per member: how many of *their own* follows
are mutual. This is the one aggregate that is genuinely O(followers) to derive,
and it is asked for on the screen members open constantly (a profile header).
It is maintained incrementally by an `AFTER INSERT/DELETE` trigger on `follows`
(O(1) per event), backfilled once from `follows` (so it is also the repair path),
and readable only by its owner under RLS.

**`social_relation_of(p_other)`** — the pairwise relation for the caller in one
round trip: one-way / mutual, mutual total, common followed, common followers,
shared active communities, same college / department / campus, likes + comments
in either direction in the last 30 days, and a capped score.

**`social_mutual_list(p_other, limit, offset)`** — the identities behind "N
mutual connections", paginated (default 12, clamped to 50), ordered by display
name, with the caller, the other member, suspended accounts and blocked pairs
filtered out.

## 3. Score model

Every component is capped, so no single signal can dominate:

| Signal | Cap | Source |
| --- | --- | --- |
| Mutual follow | 18 | `follows` in both directions |
| Common followed accounts | 22 | capped at 10 accounts |
| Common followers | 12 | capped at 10 accounts |
| Shared active communities | 14 | capped at 5 communities |
| Same college | 8 | `profiles.college_id` |
| Same department | 6 | `profiles.department_id` |
| Meaningful interactions (30 days) | 16 | capped at 20 |
| Interaction in the last 7 days | 4 | recency |

Ceiling 100. The score is computed **in SQL**, never in the browser: it decides
what a member sees, so it must not be a client-supplied number, and a second
implementation would drift from the one that is enforced.

Declared interests are deliberately **not** in the model yet. They enter through
the interest engine (Phase E), which keeps the weight testable on its own.

## 4. Access rules (enforced in SQL)

- Caller identity is `auth.uid()`; an anonymous caller gets **no rows at all**.
- Suspended accounts are excluded on both sides.
- A mutual block removes the relationship in both directions.
- Only public profile columns leave the functions.
- `social_relation_of` and `social_mutual_list` are `stable`, `security definer`,
  `set search_path = ''`, revoked from `public`, granted to `authenticated` only.

## 5. Client

`src/lib/socialGraph.ts` — the typed service (fetch, map, error messages via
`friendlyMessage`). The pure half (types, labels, explanations, published
weights) lives in `src/lib/socialGraphCopy.ts` so it can be tested without a
browser or a network; `socialGraph.ts` re-exports it, so callers import one
module.

Rules the UI follows:

- A label is only ever one of `Mutual`, `Follows you`, `Following`, `Suggested`
  — never "Friends", and a one-way follow never reads as a two-way one.
- Every explanation line is backed by a real returned number. No line is
  rendered for a signal that is zero, and none is inferred from behaviour.

`src/components/Profile.tsx` renders the relation as a chip row in the header
(`Follows you`, `N mutual connections` → opens the paginated mutual list, shared
communities, college, department) and the member-list panel gained a `mutuals`
mode. The row is absent when there is nothing true to say.

## 6. Tests

**SQL** — `supabase/tests/0065_social_graph.sql`. Run it in the SQL editor after
0065 **and** 0066. It is self-checking (`raise exception` on failure), and the
write-path checks (trigger, block, suspension) run inside a transaction that is
rolled back, so production data is untouched. It covers: the stored mutual count
equals the truth for every member; one-way follows move no counter; a mutual
follow moves both; un-following moves them back; the relation agrees with direct
counts; the score is an integer in 0..100; anon gets nothing; a blocked pair has
no relation and never appears in a mutual list; a suspended member has no graph
presence; the mutual list paginates without repeats and only lists people the
caller also follows; RLS hides other members' counters (with `force row level
security`, because the SQL editor runs as the table owner and would otherwise
bypass the policy); and anon has no EXECUTE on either function.

**Presentation** — `src/lib/socialGraph.test.ts` (node:test, bundled with
esbuild, same convention as `src/lib/pulse/engine.test.ts`):

```
npx esbuild src/lib/socialGraph.test.ts --bundle --platform=node \
  --format=cjs --outfile=temp-social-graph-tests.cjs && node temp-social-graph-tests.cjs
```

13 tests, all passing. They cover the labels (one-way never reads as mutual,
"Friends" never appears), that every explanation line is backed by a signal,
singular/plural wording, and that the published weights sum to the server's
ceiling.

## 7. Deliberately not done

- No `friends` concept: CAMPUS follows, it does not friend.
- No client-supplied score, no client-side ranking.
- No interests in the score (Phase E).
- No new notification, chat or engagement surface.

## 8. Next

Phase C (people recommendation) consumes `social_relation_of` and
`social_mutual_list` rather than inventing its own ranking; Phase E folds declared
interests into the same score instead of adding a parallel one.