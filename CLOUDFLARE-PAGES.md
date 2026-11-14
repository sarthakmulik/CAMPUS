# Cloudflare — hosting the CAMPUS web app (free, no card)

Status: **LIVE at https://campus.sarthakmulik16.workers.dev — Vercel removed.**

⚠️ 2026-11-14: the deployed bundle was built **without environment
variables** (verified: the shipped `index-*.js` contains neither the
Supabase URL nor the VAPID public key). The app shell loads but every
query answers "CAMPUS is not connected". Fix: set the three variables
below in the Cloudflare dashboard (Production **and** Preview), then
redeploy — see "Do this once", step 4.

## Why Cloudflare (one paragraph)

Unlimited bandwidth on the free tier, same CDN class as Vercel, and the
web shell lives in the same network as R2 media + future Workers — one
dashboard, cache rules that line up (`public/_headers`). CAMPUS is
hash-routed (`#p/…`, `#e/…`), so there is no server routing to migrate:
the only server behavior needed is serving `dist/` as-is.

## Do this once (was done 2026-11-14; re-do step 4 for the env vars)

1. Sign in at https://dash.cloudflare.com (the same account used for R2
   later — no card needed).
2. **Workers & Pages → Create → Pages → Connect to Git**, pick this repo.
3. Build settings:
   - Framework preset: **Vite**
   - Build command: `npm run build`
   - Build output directory: `dist`
   - Deploy command: `npx wrangler deploy` (the repo carries `wrangler.jsonc`,
     so setup is deterministic — never interactive)
4. **Environment variables — Settings → Variables and Secrets (Production
   and Preview), then trigger a new deploy:**
   - `VITE_SUPABASE_URL` = the URL from `.env`
   - `VITE_SUPABASE_ANON_KEY` = the anon key from `.env`
   - `VITE_VAPID_PUBLIC_KEY` = the public key from `.env` (web push is
     dead without it — it is baked into the bundle at build time)
   (only these three — service keys must never be here; the Android push
   build flag is computed from `android/app/google-services.json`, which
   lives in the repo, so no extra var is needed)
   A missing var does NOT fail the build — Vite inlines `undefined`, the
   bundle deploys green, and the feature silently breaks. Always verify
   the bundle after an env-var change (see checklist).

## Removing Vercel (done 2026-11-14)

1. Vercel dashboard → project CAMPUS → Settings → General → Delete
   Project (or just disconnect the Git integration if you want to keep
   the project as a cold fallback).
2. GitHub → repo Settings → Integrations/Applications → GitHub Apps →
   Vercel → Uninstall (stops Vercel's deploy hooks on every push).
3. Supabase dashboard → do **NOT** touch the organization whose id starts
   with `vercel_icfg_…`. That org was created by the Supabase–Vercel
   integration and the CAMPUS project lives inside it; disconnecting or
   deleting it could take the project down. The name is cosmetic.
4. Supabase dashboard → Auth → URL Configuration: add
   `https://campus.sarthakmulik16.workers.dev` as Site URL and as a
   Redirect URL; remove any `*.vercel.app` entries. (Auth links, email
   confirmation redirects and OAuth callbacks use these.)

## 2026-11-14 deploy-failure post-mortem (first attempt)

The first deploy failed: `Invalid _redirects configuration ... Infinite loop
detected` [code 100324]. Root cause: new Git-connected Pages projects deploy
through **Workers static assets**, where

- the SPA fallback is **native** (`assets.not_found_handling =
  "single-page-application"` in `wrangler.jsonc`) — a Pages-style
  `/* /index.html 200` `_redirects` rule is redundant AND rejected as an
  infinite loop, so `public/_redirects` was removed;
- `public/_headers` remains supported and kept (hashed bundles immutable,
  index.html + sw.js revalidate).

`wrangler.jsonc` is committed so CI never runs wrangler's interactive
auto-setup (which was what silently generated its own config last time).
No dashboard change is needed — pushing this commit redeploys and the
build should pass.

## What ships with the repo for Pages

- `public/_headers` — hashed bundles cached forever; `index.html`/`sw.js`
  revalidated so deploys propagate. (The service worker is push-only, it
  does not precache assets — these headers are authoritative.)
- `wrangler.jsonc` — the deploy config: static assets from `./dist` with
  **native** SPA fallback (`not_found_handling`). No `_redirects` exists on
  purpose — see the post-mortem below.

## Verification checklist (verify the BUNDLE, not just the page)

1. `https://campus.sarthakmulik16.workers.dev` loads, sign-in works, feed
   images mint. If anything says "CAMPUS is not connected", the build ran
   without `VITE_SUPABASE_URL`/`VITE_SUPABASE_ANON_KEY` — fix env vars,
   redeploy.
2. Web push bundle check: download
   `/assets/index-*.js` (name from page source) and confirm it contains
   your VAPID public key prefix (first 8 chars of `.env`'s
   `VITE_VAPID_PUBLIC_KEY`) and your Supabase project ref. A missing var
   builds green and fails at runtime — always check after changing vars.
3. Deep link: open `https://campus.sarthakmulik16.workers.dev/#e/<some-event-slug>`
   — should land on the event detail directly (hash routing = no server rules).
4. DevTools → Network: `/assets/` entries show `(disk cache)` or `immutable`
   on second load.
5. Web push: allow notifications, send a test push (SW scope `/` on the
   workers.dev origin). Old Vercel-origin subscriptions are dead — every
   user must re-grant on the new origin (subscriptions are per-origin;
   the stale rows fail delivery and are reconciled automatically).

## Known parity notes (deliberate, not oversights)

- `public/mobile-harness.html` and `public/design/` deploy to Cloudflare
  exactly as they did to Vercel. The harness is a test tool; if you want it
  prod-hidden later, add handling then — not during the migration.
- The Android APK is unaffected: it bundles the SPA at build time.
- Web-push subscriptions are per-origin: the workers.dev origin starts
  with zero subscriptions. The app asks users to enable push on their
  next visit; stale Vercel-origin rows fail delivery and get reconciled.

## Rollout order (same discipline as every CAMPUS round)

1. ✅ Cloudflare live (campus.sarthakmulik16.workers.dev) → Vercel removed.
2. ✅ `0055_r2_media.sql` + `r2-sign` deployed dark → stub-mode gate
   battery 15/15 green.
3. R2 account when the card exists → real secrets → client switch constant.
