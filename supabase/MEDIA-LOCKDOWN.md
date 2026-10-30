# Media lockdown deployment note — migration 0051 (private media bucket)

The last documented audience limitation: while `media` was public-read, a
guessable URL of a college-scoped post's image/reel could be fetched by anyone.

## What 0051 changes

1. **The `media` bucket flips private** — `/object/public/…` URLs stop serving.
2. **Storage RLS becomes the gate**, exactly mirroring the post audience rule:
   - the **owner** (uploader) always reads their own object, so in-composer
     previews of not-yet-published uploads keep working;
   - **anyone** (anon included) may read an object that is referenced by a post
     the caller is allowed to see per 0049's `post_visible_to`. Resolution goes
     through `post_media_gate` (an object-name index maintained by a trigger on
     `posts`), then checks the LIVE posts row — unpublising or re-scoping a
     post hides its media **immediately**, no staleness. The check runs inside
     `can_view_media_object()`, a security-definer function, because a policy
     subquery otherwise evaluates under the caller's role which has no grant
     on the gate table (kept closed on purpose).
3. **The client renders media through short-lived signed URLs** it mints per
   source (lib/signedMedia.ts, 6-hour TTL, cached module-side). Minting itself
   requires the caller to pass the same policy, so a signed URL can never
   become a bypass.
4. Unaffected buckets stay as they are: `avatars`, `chat-media` (already
   signed URLs), `ad-media`, `resources`, community covers/logos.

## 1. Apply `0051_media_lockdown.sql` (SQL editor, once)

Run the whole file. It:
- creates `post_media_gate` + sync trigger + backfills every existing post
  (community-scoped posts excluded on purpose);
- **drops existing media-bucket SELECT policies it finds** (the permissive
  ones the dashboard created when the bucket was public) — policies whose
  USING clause mentions `media`;
- creates the owner + gate-driven SELECT policies;
- sets `storage.buckets.public = false` for `media`.

## 2. Verify after applying

As **anon** (browser incognito, raw URL):

```text
GET  https://ggjdhqokzdidmucvxrgz.supabase.co/storage/v1/object/public/media/<path>
→ must NOT serve (empty/404)

GET  .../object/sign/media/<path> (supabase-js, anon key, a PUBLIC post's reel)
→ 200, signed URL serves for 6 h

GET  .../object/sign/media/<path> for a COLLEGE-scoped post as an outsider account
→ must be denied
```

In-app: public posts/reels render normally for everyone; a college-only post's
media renders for the author + same-college members and is unreachable for
outsiders even via the raw URL.

## Known behavior changes (intentional)

- Browser caching of feed media is shorter (signed URLs expire); bandwidth is
  unchanged, one extra sign request per unique source per session.
- Media pasted into Chats uses the separate `chat-media` pipeline — untouched.
- Object URLs from uploads are still stored canonically (public-shaped); only
  presentation rewrites them — flipping back only needs `public = true`.

## Verified live (applied + re-run with the definer wrapper)

- Raw `/object/public/media/…` → 400 "Bucket not found" for every path.
- Anon mint of a **public** post's object → signed URL serves the bytes.
- Anon + outsider (-college) mint of a **college-only** post's object → denied,
  surfaced as 404 "Object not found" (no existence leak; the storage API
  reports mint denials as missing objects, not 403s).
- Author re-scope `college → public` → anon mint starts working immediately
  (live-posts join, no staleness); unpublish → instant denial; re-publish →
  back. Owner mint of an own **unpublished** upload still works (composer).
- In-app (built bundle): visitor feed images + reel render signed; Discover
  reel slide renders signed; Profile grid tiles render signed as member; a
  college-only post's media renders for its COEP author; Bookmarks thumb and
  the chat share-sheet preview render signed; outsiders see no COEP card
  anywhere in their feeds.
