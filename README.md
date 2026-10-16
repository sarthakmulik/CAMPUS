# CAMPUS — manual rebuild

A React + Vite + TypeScript rebuild based on the supplied Base44 desktop/mobile screenshots. The first pass includes the responsive visual shell, feed interactions, tabs, search, local post creation, follow toggles, bookmarks, and a Supabase auth connection point.

## Requirements
- Node.js 20.19+ or 22.12+
- npm
- A Supabase project (optional for UI preview; required for real accounts and persisted data)

## Run locally
```bash
npm install
cp .env.example .env.local
npm run dev
```
On Windows PowerShell, use:
```powershell
Copy-Item .env.example .env.local
```
Open the local URL printed by Vite (usually http://localhost:5173).

The UI runs in preview mode without Supabase. In preview mode, posts and likes are local React state and reset on refresh. Authentication requires a configured Supabase project.

## Connect Supabase
1. Create a Supabase project.
2. In Supabase Dashboard → SQL Editor, run `supabase/schema.sql`.
3. In Project Settings → API, copy the Project URL and anon/public key.
4. Put them in `.env.local`:
   ```
   VITE_SUPABASE_URL=https://YOUR_PROJECT.supabase.co
   VITE_SUPABASE_ANON_KEY=YOUR_SUPABASE_ANON_KEY
   ```
5. Restart `npm run dev`.

Never put a Supabase `service_role` key in browser code or commit `.env.local`.

## Current implementation status
### Implemented in this first build
- Desktop three-column layout inspired by screenshots.
- Mobile top bar and bottom navigation.
- Indigo/violet/pink color system.
- Feed tabs, search filtering, sample feed.
- Like and bookmark toggles (local demo state).
- Local post/confession/poll/reel composer UI.
- Follow/unfollow buttons (local demo state).
- Supabase email/password sign-in and sign-up calls.
- Initial PostgreSQL schema for profiles, colleges, posts, likes, comments, bookmarks, follows, polls, chat, notifications, clubs, events, opportunities and reports.

### Not production-complete yet
The current feed is seeded demo data and is not yet fetched from PostgreSQL. The composer does not persist posts; comments, realtime messages, actual polls/reels/media upload, notifications, event RSVP, opportunities, admin moderation, college verification and role-based admin tools still need their own integration pass. Several secondary pages are scaffolds rather than fully functional modules. The SQL policies are a starter baseline and must be security-reviewed and tested before production. Anonymous confessions especially require a safe server-side read policy/view so clients cannot infer authorship.

## Suggested build order
1. Verify this visual shell against your screenshots.
2. Connect onboarding and profiles to `profiles` and `colleges`.
3. Replace seeded feed with secure paginated Supabase queries.
4. Persist posts, likes, comments, bookmarks and follows.
5. Add storage buckets and upload policies.
6. Implement conversations/messages with realtime and membership checks.
7. Build clubs, events, polls, opportunities and notifications.
8. Build college moderator and platform admin screens.
9. Test RLS with multiple test accounts and deploy.

## Project layout
```text
src/
  App.tsx
  main.tsx
  styles.css
  types.ts
  lib/supabase.ts
supabase/
  schema.sql
```
