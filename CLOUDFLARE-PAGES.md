# Cloudflare Pages — hosting the CAMPUS web app (free, no card)

Status: **config committed; do the dashboard connect once (5 minutes).**
Vercel keeps running untouched until Pages answers 200 on its own domain —
only then flip DNS (if you even use a custom domain; Vercel's *.vercel.app
URL can simply stay as a fallback forever).

## Why Pages (one paragraph)

Unlimited bandwidth on free tier (Vercel meters ~100 GB/mo), same CDN class,
and it puts the web shell in the same network as R2 media + future Workers —
one dashboard, cache rules that line up (`public/_headers`). CAMPUS is
hash-routed (`#p/…`, `#e/…`), so there is no server routing to migrate:
the only server behavior Pages needs is serving `dist/` as-is.

## Do this once

1. Sign in at https://dash.cloudflare.com (the same account you will use for
   R2 later — no card needed for Pages).
2. **Workers & Pages → Create → Pages → Connect to Git**, pick this repo.
3. Build settings:
   - Framework preset: **Vite**
   - Build command: `npm run build`
   - Build output directory: `dist`
   - Deploy command: `npx wrangler deploy` (the repo carries `wrangler.jsonc`,
     so setup is deterministic — never interactive)
   - Environment variables (Production and Preview):
     - `VITE_SUPABASE_URL` = the URL from `.env`
     - `VITE_SUPABASE_ANON_KEY` = the anon key from `.env`
     (only these two — service keys must never be here; the Android push
     build flag is computed from `android/app/google-services.json`, which
     lives in the repo, so no extra var is needed)
4. Deploy. First build proves everything; later commits auto-deploy.

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

## Verification checklist after the first deploy

1. `https://<project>.pages.dev` loads, sign-in works, feed images mint.
2. Deep link: open `https://<project>.pages.dev/#e/<some-event-slug>` —
   should land on the event detail directly (hash routing = no server rules).
3. DevTools → Network: `/assets/` entries show `(disk cache)` or `immutable`
   on second load.
4. Web push still works (SW scope `/` on the pages.dev origin).

## Known parity notes (deliberate, not oversights)

- `public/mobile-harness.html` and `public/design/` deploy to Pages exactly
  as they do to Vercel today. The harness is a test tool; if you want it
  prod-hidden later, add `/mobile-harness.html` handling then — not during
  the migration.
- The Android APK is unaffected either way: it bundles the SPA at build time.

## Rollout order (same discipline as every CAMPUS round)

1. Pages live + verified (this doc) → **Vercel stays as-is**.
2. `0055_r2_media.sql` + `r2-sign` deployed dark → stub-mode gate battery.
3. R2 account when the card exists → real secrets → client switch constant.
