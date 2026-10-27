# CAMPUS PULSE — delivery summary

Daily deterministic self-operating engagement. **No external AI APIs, no paid dependencies** — every insight, question pick, quiz score and leaderboard ordering is computed by deterministic SQL (supabase) mirrored by a TypeScript engine for testability.

## What shipped

| Piece | File(s) | Status |
|---|---|---|
| Schema + RLS + all RPCs | `supabase/migrations/0048_campus_pulse.sql` | **applied & live** |
| Content library + config seed | `supabase/migrations/0048b_pulse_seed.sql` | **applied & live** |
| Deterministic engine (TS mirror) | `src/lib/pulse/engine.ts`, `src/lib/pulse/config.ts` | committed |
| Engine tests (esbuild + node) | `src/lib/pulse/engine.test.ts` | **22/22 pass** |
| DB wrappers | `src/lib/db.ts` (pulse RPC wrappers) | committed |
| Main page | `src/components/Pulse.tsx` + `src/App.tsx` wiring | committed |
| Admin console tab | `src/components/StaffConsole.tsx` (`has_op('pulse.admin')`) | committed |
| Styles | `src/styles.ui4.css` (end) | committed |
| Statement reporting | `ReportDialog.tsx` `statementId` + `pulse_report_statement` RPC | committed |

## Formulas (server-authoritative, mirrored in TS for tests)

- **Daily selection — `pulse_pick_daily`**: damped participation Wilson lower bound + week-freshness + evergreen penalty + daily seeded tie-break (bigint `hashtext`, int32 overflow-safe), weighted across active-season categories.
- **Fairness engagement weight**: `(votes / (votes + skips + prior)) * daily-seed`, population-level; one row per user per table (unique keys) so nobody is double-counted.
- **Statement deck**: seeded shuffle → finite cut of `pulse.statementDeck` (5) → slots 1..N over exactly what shows; rotates by campus day.
- **Quiz score**: highest trait count; ties deterministically to the lowest result key.
- **Insights**: participation-based only. **No impression tracking exists in CAMPUS — sentiment/mood insights are computed from votes, reactions and quiz results, never from views.** Known and documented limitation.
- **Privacy threshold**: islands with fewer than `pulse.minSample` (default 10) participants show only an honest empty state. Nothing is estimated or invented.
- **Campus day**: `Asia/Kolkata`.

## What was live-probed (real server, real account)

- Daily card, vote recorded (`1 of 10` honest threshold state; option-index-0 fix verified), session reconnect → vote persists.
- Statement deck renders exactly 5, rotates by day; reactions set / change / clear verified, counts move server-side, `mine` highlight tracks.
- ReportDialog opens for a statement with the new `statementId` routing.
- Quiz full funnel: 5 questions → server-scored result ("The Canteen Regular"); retake with a different answer pattern → different deterministic result ("The Night-Owl Student"); quit-midway saves nothing.
- Share button → real composer prefill ("🍛 The Canteen Regular — …"), Post enabled, cancel clean.
- Milestones awarded server-side from real participation: First Pulse, Campus Voice, Challenge Participant.
- Participation insight renders ("1 vote cast on this campus this week") with the How-this-was-calculated explainer.
- Visitor gate: menu-level `restrictedNav`, `requireAuth` flash "Join CAMPUS to answer today's Pulse" + auth dialog, Pulse RPCs return `signin`.

## Bugs found and fixed during the live probe

1. `pulse_statements` deck json/jsonb coalesce mixing → cast to jsonb, wrap with `to_json`.
2. `hashtext(...) + 2^31` int32 overflow ("integer out of range") → bigint arithmetic in deck + daily tie-break.
3. Deck slots computed before `limit` → finite cut first, `row_number()` after.
4. `pulse_admin_jobs` LIMIT inside aggregate ORDER BY → limiting subquery.
5. Inline `UNIQUE` expression not valid in `CREATE TABLE` → unique expression index.
6. Season month read from `p_date + 1` → the campus day itself.
7. `create policy` not re-runnable → all 14 policies guarded with `drop policy if exists` (Supabase SQL editor autocommits per statement, so partial-run state persists).
8. `Pulse.tsx` `[state, setState]` falsy-zero: `!daily.myVote` treats option index 0 as unvoted → compare `=== null`.

## Scripted verification

- `npx tsc -b` → 0 errors.
- `npx esbuild src/lib/pulse/engine.test.ts … && node temp-pulse-tests.cjs` → **22/22 pass**.
- `npm run build` → clean (5.9s–11s).

## Applied migrations status

Both `0048_campus_pulse.sql` and `0048b_pulse_seed.sql` are applied to the live database. If a partial run had happened (per-statement autocommit), simply re-running `0048_campus_pulse.sql` is safe — policies drop-guarded, functions recreated, tables/indexes "if not exists"/guarded, seeds unique-keyed.

## Staff console (live-probed with the owner session)

Signed in as the super_admin (auto-lands on Staff Console) and verified:

- **Pulse tab visible** for the owner session (`has_op('pulse.admin')` → super_admin implicit `*`).
- **Overview tiles** show live totals: 1 vote/7d, 1 vote/today, 0 reactions, 1 quiz attempt, 0 skips; library count 28 approved.
- **Content library list** + status filters (all/draft/approved/paused/rejected) render from `pulse_admin_list`.
- **Engine config editor** renders all 11 adjustable keys from `pulse_admin_config_get`; values intact vs seed (safe roundtrip).
- **Job log** shows real `pulse_job_runs`: `pulse.ensure_daily` and `pulse.insights` ok, keyed by campus day.

### Bug found and fixed during staff probing

9. **Every pulse admin WRITE was broken at runtime.** All three `log_staff_action` calls in 0048 (`set_status`, `create_quiz`, `config_set`) passed `(action, jsonb)` while the 0043 signature is `(action, target_type text, target_id uuid, metadata jsonb)` — signature resolution failed ("function public.log_staff_action(unknown, jsonb) does not exist"). The exception aborted the whole transaction, so status changes, quiz creation and config saves all failed (UI flashed the error; read paths unaffected). Fixed to the proper 4-arg call (`'pulse_item', v_item` targets; config logs key/value metadata). **Re-run `0048_campus_pulse.sql` once to pick up the fix** (idempotent).

## Remaining (honest)

- **Mood/top-statement insight copy** needs ≥ 10 participants on a campus — by design these messages cannot honestly fire at team-of-1 scale. Empty states verified instead.
- Pulse admin writes + audit trail rows: verify a set-status/config save once 0048 is re-run (fix above).

## Honest limitations

- No impression tracking exists in CAMPUS → no reach/completion insight; participation-only by design.
- Insight accuracy grows with sample: below the minimum sample, islands show nothing rather than an estimate.
- Quiz results are deterministic entertainment, never a psychology read (stated in-product).
