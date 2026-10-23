# CAMPUS browser-push runbook (0029)

Interactive-but-out-of-band steps that cannot be performed from the SQL
editor or the repo alone. Everything else (schema, triggers, prefs, queue)
is already in `0029_notifications.sql`.

## 0. What is already in place
- `notifications` flows: every supported event writes an in-app row first
  (RLS-protected, preference-gated server-side).
- `push_queue` rows are created by the `notifications_enqueue_push` trigger,
  honoring per-category push prefs + server-side quiet hours in the
  user's own timezone, and only when at least one device is registered.
- `public/sw.js` displays and routes pushes; `src/lib/webPush.ts` handles
  permission onboarding (never on page load) + subscription storage.

## 1. Generate VAPID keys (once)
```bash
npx web-push generate-vapid-keys
```
- PUBLIC key → also paste into `.env` as `VITE_VAPID_PUBLIC_KEY`
  (this one is public — it travels to browsers).
- PRIVATE key never leaves your terminal/Supabase secrets.

## 2. Deploy the delivery function
```bash
supabase functions deploy push-deliver
supabase secrets set VAPID_PUBLIC_KEY=<public> VAPID_PRIVATE_KEY=<private> VAPID_SUBJECT=mailto:you@yourdomain
```
Re-deploy AFTER changing secrets if anything misbehaves.

## 3. Hook the queue to the function (Dashboard)
- Supabase Dashboard → Database → Webhooks → **Create webhook**
- Table: `public.push_queue` · Events: **INSERT**
- Method: POST · URL: `https://<PROJECT_REF>.supabase.co/functions/v1/push-deliver`
- Additional header: `Authorization: Bearer <SUPABASE_SERVICE_ROLE_KEY>`
- Payload: default (full row).

## 4. Optional bounded retry sweep
Apply `supabase/migrations/0029b_push_sweep_cron.sql` (needs pg_cron +
pg_net; edit `<PROJECT_REF>` and `<SERVICE_ROLE_KEY>` inside first).

## 5. Verify end-to-end
1. Sign in on a device; open Notifications → Settings → enable push →
   accept browser permission. `push_subscriptions` should gain one row.
2. From another account, send that account a DM (message push defaults ON).
3. Browser should show a system notification; clicking opens CAMPUS on
   the conversation (`#chat/<id>`).
4. Kill the browser's network briefly or log the endpoint out — the
   in-app notification row still exists (push failure never loses it).

## Honest-verification note
Until steps 1–4 are run with real keys, browser-push DELIVERY is
implemented but not live-verified. In-app center behavior is verified
against the live project.
