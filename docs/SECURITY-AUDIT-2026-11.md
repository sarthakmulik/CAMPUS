# CAMPUS security audit — 2026-11-15 (deep pass)

Scope: secrets & release chain · database (RLS + definer functions + grants) · edge
functions · web app (injection surface) · Android native layer · auth/session
handling. Method: pattern sweep across all 69 migrations, both edge functions,
the full `src/` tree and the Android manifest/gradle/webview wiring, followed by
manual reads of every hit.

---

## Verdict

**No critical vulnerability found in the shipped pipeline.** One high-severity
stored-XSS vector existed in UI code (host/member-entered URLs) and was fixed
in this round, with a database-level second line of defense. Several
structurally strong properties were verified and are documented below so
future changes don't silently regress them.

---

## Fixed in this round

### 1. HIGH — Stored XSS via `javascript:` URLs (UI + DB fix)

**Where:** `EventDetail.tsx` rendered host-entered `registration_url`,
`map_url`, `online_url` straight into `href`; `CommunityDetail.tsx` passed
member-entered `resource.link_url` to `window.open`. Any club host or member
with upload rights could store `javascript:<script>` in those fields — a
victim's click executed script **inside the app origin, where the Supabase
session (and tokens) live**.

**Fix (three layers):**
- `src/lib/safeUrl.ts` — `safeHttpUrl()` returns a URL only when it parses
  with an `http:`/`https:` scheme; every navigable use now goes through it
  (3 anchors in EventDetail, `openResource` in CommunityDetail). Non-matching
  links simply don't render.
- **Migration `0069_link_scheme_hardening.sql`** — CHECK constraints on
  `events` (3 columns) and `community_resources.link_url` rejecting
  scheme-hostile values for **all future writers**, RPC or not (`NOT VALID`,
  so legacy rows can't block applying it).
- Ads were already safe: table-level `destination_url ~* '^https?://'` CHECK +
  function validation (verified).

### 2. LOW — Supabase CLI state tracked in git

`supabase/.temp/` (project ref + organization id) was committed. Untracked and
gitignored (org ids are semi-sensitive metadata; never needed in history).

---

## Verified secure (do not regress)

### Database layer
- **RLS enabled on all 51 public tables** (full diff scan; zero missing).
- **All 328 security-definer functions pin `set search_path`** — no
  search-path hijacking surface.
- `push_delivery_config` (webhook bearer) — `revoke all from anon,
  authenticated`; zero grants + no policies = postgres/service-role only.
- `push_queue` — no client grants at all; only the cron/service role touches it.
- `device_tokens` — own-row RLS; the saver reassigns a token to the *current*
  signed-in user, so account switching can never inherit a device.
- Public-read policies (`follows`, `post_comments`, directory tables) are
  **by design** (public social graph / verified directory); anonymous
  confessions never leak their author through them (0029 rule set).
- Ad campaigns: scheme CHECK at table level + function-level validation +
  staff-only write paths.

### Edge functions
- **`push-deliver`**: requires the service-role bearer (401 for anon — probed
  live); recipient-scoped payloads; failed-token cleanup; secrets only in
  Supabase secrets, never in the repo or client.
- **`r2-sign`**: platform `verify_jwt` gate → the caller's own JWT drives the
  DB gate RPCs (same checks as storage policies, byte-for-byte); object keys
  length-capped and traversal-checked (`../`, leading `/`, newlines); PUT size
  cap 25 MB; GET 15-min / PUT 10-min signed TTLs; stub mode cannot touch real
  storage; existence-denies are uniform 404s (no probing oracle).

### Web app
- **Zero script-injection surface**: no `dangerouslySetInnerHTML`, no
  `innerHTML`, no `eval`/`new Function` anywhere in `src/` (full sweep).
- The user-text linkifier (`RichText`) admits **only** `https?://` and `www.`
  tokens by regex — `javascript:` can never reach an `href` from post/bio
  text; mentions/hashtags render as inert buttons.
- No `.or(\`…\`)` template interpolation against Supabase filters (the known
  PostgREST injection trap) — all queries go through parameterized RPCs or
  builder methods.
- `localStorage` holds only non-sensitive flags/drafts; the Supabase session
  is managed by the client lib (see "known trade-offs").

### Android native layer
- `allowBackup="false"` — the WebView's localStorage (which holds the
  Supabase refresh token) can never leave via Google backup.
- No cleartext traffic; single deep-link scheme `campus://` validated against
  strict per-kind regexes before any routing; HTTPS links only from the
  public web origin.
- `POST_NOTIFICATIONS` requested only from an explicit settings gesture.
- The JS interface added in MainActivity (`CampusNativeInsets`) exposes
  **read-only integers** (inset sizes) — no sensitive surface.
- Notification PendingIntents are `FLAG_IMMUTABLE` except the RemoteInput
  one, which is `MUTABLE` because Android requires it for inline replies.
- Signing key, `keystore.properties`, `google-services.json` secrets — none
  tracked in git (release key exists only on the build machine).

### Release chain
- APK published via signed GitHub releases; permalink
  `releases/latest/download/CAMPUS.apk`; SHA-256 published in notes.

---

## Known trade-offs (accepted, documented)

1. **Refresh token in WebView localStorage** — standard supabase-js behavior.
   Mitigated by `allowBackup=false`, single-origin bundle, no external links
   opening in the same context. Long-term option: Capacitor encrypted
   Preferences storage.
2. **CORS `*` on the edge functions** — `push-deliver` is bearer-gated and
   `r2-sign` is JWT+DB gated, so wildcard CORS grants no new access. Still set
   `ALLOWED_ORIGINS` when the real R2 rollout happens.
3. **`using (true)` SELECT on directory tables** — intentional public data.

---

## Outstanding actions (owner: you)

1. **Rotate the Supabase access token (`sbp_…`) that was pasted into chat
   earlier.** Verified: it is *not* in the repo or any committed file — but it
   left the secret boundary the moment it was shared in conversation.
   Dashboard → Access tokens → revoke + issue new.
2. **Apply pending migrations** in order: `0067` (enqueue gate for native
   devices), `0068` (action-target payload), `0069` (link scheme hardening),
   then `supabase functions deploy push-deliver`.
3. **Rate limiting** (future hardening): no server-side throttle on chat
   sends / event registrations beyond DB constraints. Supabase Auth has
   built-in defaults for OTP; consider a lightweight DB-side rate table for
   chat if spam ever appears.
4. **Supabase Auth dashboard settings**: review mail domain allowlists, and
   the auth redirect allowlist (the Vercel-origin cleanup you already have
   planned).
5. Staff moderation battery (0053) still pending a campus super_admin login —
   scheduled from the earlier round.

---

## Suggested cadence

Re-run the cheap checks after every migration batch:
- table-vs-RLS diff (script in this audit's method: `create table` list vs
  `alter table … enable row level security` list),
- `security definer` without `set search_path` (must stay 0),
- `git grep -n 'dangerouslySetInnerHTML\|innerHTML\|eval(' -- src` (must stay
  empty),
- grant review on any new table (default should be "RLS on, grants only to
  authenticated, functions revoked from public").
