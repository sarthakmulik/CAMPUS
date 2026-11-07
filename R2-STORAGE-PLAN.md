# R2 STORAGE PLAN — moving the heavy bytes to Cloudflare, keeping Supabase for the rest

Status: **plan — not yet implemented.** Read alongside `0051_media_lockdown.sql` (the
isolation model this must preserve) and `IMPLEMENTATION-NOTES.md`.

---

## 0. The one thing to get right

This is a **storage split, not a database split.** CAMPUS keeps ONE database
(Supabase Postgres: auth, profiles, posts, RPCs, gates, RLS). Only the *bulk binary
files* gain a second home. Every authorization decision stays server-side in
Supabase, exactly like 0051–0053 built it. R2 is dumb bytes; it never decides who
may see an object.

Why R2: free tier = **10 GB-month storage + 1M writes + 10M reads per month, and
egress ("how many GB were served to viewers") is free at *any* usage**. That last
part is the real unlock: on Supabase free, serving video burns the quota; on R2 a
range-requested 40 MB reel costs zero bytes of Supabase bandwidth.

---

## 1. What actually eats the quota today

| Surface | Bucket today | Written by | Relative weight |
|---|---|---|---|
| Post images | `media` | composer + community composer | high (many, medium size) |
| Reels / video posts | `media` (client-compressed first, `src/lib/media.ts`) | ReelTrim + composer | **highest (largest objects, re-read often)** |
| Chat attachments | `chat-media` | Chats share/upload | medium |
| Community resources / large files | `resources` (`communities…` minimal) | community pages | low count, large size |
| Avatars | `avatars` | signup/profile | small, cached hard |
| Ads media | `ad-media` | ads admin | small |
| Legacy media (everything already uploaded) | `media` | — | already paid for |

## 2. The assignment (your split, in this vocabulary)

**To R2 (new writes only):**
- post images and reels/videos → bucket `media` uploads that are images/video
- chat attachments → new chat uploads
- large files → community/resource uploads above a size floor (proposal: > 2 MB)

**Stays in Supabase:**
- avatars (`avatars` bucket) — small, hard-cached, already everywhere
- small documents / resources ≤ 2 MB
- **every object that already exists** — legacy media keeps its current Supabase
  URLs and gate behavior untouched; zero migration, zero re-upload, zero risk to
  the isolation work we verified live

Migration is therefore **dual-write forward, never move backward**: old objects
age out of the bill naturally as they get deleted by their authors.

---

## 3. Isolation on R2 (the core design)

0051 made the `media` bucket private and its storage RLS the authorization act:
"you may mint a signed URL only if the 0049 rule says you can see the post that
references the object" — the query hops `post_media_gate → posts →
post_visible_to / club membership / staff allowance` (extended by 0053).

R2 has no RLS, so the same *act* moves behind a function we control:

```
client ("mint me this source") ──JWT──▶ Supabase Edge Function `r2-sign`
                                          │ 1. verify caller = logged-in user
                                          │ 2. call DB (service role):
                                          │    public.can_view_media_source(p_key, p_op)
                                          │    └─ SAME gate join as 0051/0053:
                                          │       gate row → posts → audience /
                                          │       club / staff / chat membership
                                          │ 3. if allowed → AWS SigV4 presign
                                          ▼
client gets short-lived presigned GET URL (direct from R2, Ctrl+C out of dead
CDN tiers — the bytes never pass through Supabase bandwidth)
```

Rules encoded there:
- **R2 objects are never public.** No public bucket URL, no `r2.dev` access.
- Mint = auth, same principle as 0051: a signed URL can never reach someone the
  post is hidden from.
- The gate row is created **when the post row is created** (trigger extension),
  so a draft upload is inert: presign-PUT exists to *put into draft*, presign-GET
  requires a referencing, still-visible post row (or the owner / staff paths).
- Staff allowance reaches R2 identically (0053 branch re-used) — a reviewer can
  mint the media of a hidden college post during the live battery.
- Visitors: same as today. A public post's media mints for anon.

### 2.1 Canonical form in the database
DB keeps storing **canonical URIs** in `media_urls` (never presigned, never
secret-bearing): R2 objects are written as

    r2://campus-media/<uid>/<ts>.<ext>

`post_media_gate_sync` gains a branch for those (same gate table, name column
holds the R2 key, no Supabase storage object exists behind it).

---

## 4. Client changes (all in one module)

New `src/lib/mediaStore.ts` — the single routing point (no component decides):

```ts
routeForUpload(kind, size) → 'supabase' | 'r2'
  r2 if kind is image/video and (size > R2_FLOOR or kind === 'reel'
     or surface === 'chat' or surface === 'community-resource-over-2mb')
```

- `signedMedia.ts` learns the `r2://` scheme: mint via `POST /functions/v1/r2-sign`
  (with the caller's Supabase JWT) instead of storage `createSignedUrl`. The
  cache/listener shape stays exactly as built in 0051.
- `uploadMedia(userId, file)` keeps its signature; under the hood it presigns a
  PUT and normalizes to `r2://…` (or stays on the current flow for the
  Supabase side). **Composer preview is preserved**: the presigned PUT happens at
  pick-time, post insert later links it — same lifecycles we verified in the 0051
  round.
- Chat share-sheet preview, Bookmarks thumbs, Profile grid, Discover reel slide,
  community composer — all already funnel through `signedMedia`/`PostCard`, so
  they inherit R2 support without per-surface edits.

## 5. Supabase-side artifacts

| Artifact | What it does |
|---|---|
| `0054_r2_media.sql` | extends `post_media_gate_sync` + backfill-safe wrapper `can_view_media_source(p_key, p_action)` (wraps today's `can_view_media_object` logic; adds `chat` gate rows via `messages.media` join + conversation membership; adds `club resources` membership path for R2 resource keys). Include the RPC the edge function calls, service-role-executable. |
| Edge Function `r2-sign` | verifies JWT, calls the wrapper, SigV4-presigns GET (15 min) / PUT (10 min) with `aws4fetch`; R2 keys never leave server secrets. Reuses the anon JWT the client already sends (standard `Authorization: Bearer` handling = `verify_jwt = true`). |
| Secrets (server only) | `R2_ACCOUNT_ID`, `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY`, `R2_BUCKET` set via `supabase secrets set`. **Never in `.env`, never in the client bundle.** |

Open question to resolve at build time: whether chat attachments live in
`messages.media_urls` (then the gate join is trivial) or a message-object table —
the migration reads the real chat schema first.

## 6. Rollout phases (mirror the isolation rounds' discipline)

1. **0054 + edge function**, no client switch — deploy dark; probe the function
   with the probe account: allowed mint ✓, outsider/anon on college object ✗
   (404-equivalent "no existence leak"), staff mint of hidden object ✓.
2. **Client routing switch** behind one constant (`MEDIA_SPLIT_V1 = true`):
   new reels + chat uploads go R2; post images follow after the first day's
   smoke test. tsc/build/22 pulse tests + full signed-media in-app pass.
3. **Live battery** (same hygiene as 0051): create probe reel → confirm R2 key,
   gate row, mint paths per role; hide via staff console (needs the campus login
   anyway — the pending 0053 battery) → staff still mints, member stops; unpublish
   behavior identical.
4. **Watch both bills** for a week; only then consider pointing resources at R2.

Rollback is honest and cheap: flip the constant off (new uploads return to
Supabase); existing R2 objects keep rendering as long as the edge function runs.
Nothing deletes, nothing re-uploads.

## 7. Account setup — for someone who has never touched Cloudflare

1. **Sign up**: https://dash.cloudflare.com/sign-up — email + password, choose the
   **Free plan**. (Workers/R2 free tier does not nerf anything for this use.)
2. **Enable R2**: dashboard → left nav **R2 Object Storage** → *Purchase R2* /
   *Get started* → accepts terms. **Cloudflare may require a card on file to
   switch R2 on** (abuse prevention). Nothing is charged while under the free
   limits — the free allowance is deducted automatically and usage over it is
   billed per-GB, so keep the dashboard's usage chart in mind.
3. **Create the bucket**: R2 → *Create bucket* → name `campus-media` → Location
   **APAC** (India audience) → Defaults private. Do **not** enable the public
   access option.
4. **Create S3-compatible API keys**: R2 → *Manage API Tokens* → *Create token* →
   Permissions **Object Read & Write**, scope to `campus-media` only (optionally
   TTL 90d) → note **Access Key ID** and **Secret Access Key** (shown once).
5. **Copy the account id / endpoint**: R2 overview shows
   `<ACCOUNT_ID>.r2.cloudflarestorage.com`. These four values are the secrets
   listed in §5.
6. **CORS** (only if the client ever fetches via `fetch`/XHR — `<img>`/`<video>`
   playback of presigned URLs needs none): bucket → Settings → CORS policy →
   allow `GET, HEAD, PUT` from the app origins (`http://localhost:*`,
   your production domain).
7. **Hand the four secrets to me** (paste privately) → I set them with
   `supabase secrets set` and build §5–6.

## 8. What this does NOT change

- Supabase Postgres, auth, RPCs, RLS, staff console, moderation, pulse — all stay
  exactly as they are. No "second database" exists in the plan.
- The 0049–0053 isolation guarantees — they extend, they don't weaken (same gate
  join, one more key-space).
- Legacy media — untouched, still gated, still free of migration.

## 9. The number that matters

Supabase free storage ceiling is 5 GB and every served byte also counts against
bandwidth. The average CAMPUS test asset is: post image ~0.5–2 MB, reel
5–15 MB *after* client compression. One month of building (~100 assets, mostly
reels) ≈ 3–6 GB — precisely the freeze zone. R2 splits that 10 GB free allowance
across the heavy half and stops charging egress for it entirely, which is
normally 80–90% of the burn.
