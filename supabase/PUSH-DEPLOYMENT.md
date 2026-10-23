# CAMPUS browser-push runbook (verified configuration)

Interactive-but-out-of-band steps that cannot be performed from the SQL
editor or the repo alone. Everything else (schema, triggers, prefs, queue,
reliability fixes) is already in the migrations.

## 0. How delivery works end-to-end

```
chat_messages / social actions
  → notify_member()                 (dedupe: bump-on-unread, 0032)
  → notifications row               (in-app truth always exists first)
  → notifications_enqueue_push      (prefs + quiet-hours + device gate)
  → push_queue row
      ├─ instant: push_delivery_webhook trigger → net.http_post → edge fn (0031)
      └─ retry:   cron 'campus push sweep' every minute → edge fn sweep
  → push-deliver edge function      (VAPID web-push per device)
      ├─ 200 from push service  → push_queue: delivered   (≈sub-second)
      └─ 404/410 (dead device)  → delete push_subscriptions row, retry others
```

- `delivered` = the push service accepted the message for that device.
  It is NOT proof the phone displayed it (permission, OS channel, and
  battery policies on the device decide that).
- Migrations, in order: 0029 → 0029b → 0029c → 0030 → 0031 → 0032.

## 1. Secrets (once)

```bash
npx web-push generate-vapid-keys
```
- PUBLIC key → `.env` as `VITE_VAPID_PUBLIC_KEY` (public by design) and
  on Vercel as an environment variable (redeploy after adding).
- PRIVATE key → Supabase secrets only, never in the repo.

```bash
supabase functions deploy push-deliver
supabase secrets set VAPID_PUBLIC_KEY=<public> VAPID_PRIVATE_KEY=<private> VAPID_SUBJECT=mailto:<real-email>
```

Delivery auth: the edge function accepts `CAMPUS_DELIVERY_TOKEN`
(preferred — set with the service key you rotate; rotation steps below):

```bash
supabase secrets set CAMPUS_DELIVERY_TOKEN=<new-service-key>
```

## 2. Database wiring (SQL editor; no secrets pasted here)

1. Store the current signer token (one line, run after any key rotation):
   ```sql
   insert into public.push_delivery_config (id, bearer_token) values (1, '<SERVICE_KEY>')
   on conflict (id) do update set bearer_token = excluded.bearer_token;
   ```
2. Run `supabase/migrations/0031_push_webhook_trigger.sql` — creates
   `push_delivery_config` if missing, the instant-delivery trigger
   (`push_delivery_webhook` on `push_queue` INSERT, via pg_net), and the
   every-minute cron sweep. The token is read from the config table at
   run time — the SQL file contains none.
3. Run `supabase/migrations/0032_push_dedupe_bump.sql` — fixes silent
   swallow of repeated events: an existing unread notification is bumped
   (new actor + timestamp) and its push re-enqueued.

pg_net lives in schema `net` — call `net.http_post`, never
`extensions.net.http_post`.

## 3. Client behavior (what to expect)

- Permission is requested only from a user gesture (notification sheet →
  Enable). A denied browser is never re-prompted programmatically.
- Logging out unsubscribes the device (server row + browser
  subscription). Push stops by design when logged out.
- **Self-healing** (0032 client + `sw.js`): if the browser rotates the
  subscription or the server row is lost, the next signed-in app start
  (or the SW's `pushsubscriptionchange` ping, when a tab is open)
  re-subscribes and re-saves silently — only for opted-in devices.
- DM requests (`pending`) intentionally never notify; the recipient
  gets pushes only after accepting the chat.

## 4. Multi-device notes (Android/iOS)

- Android Chrome works even with the browser closed, IF Chrome's app
  notifications are ON (Phone Settings → Apps → Chrome) and Chrome isn't
  swiped away by battery managers.
- Best/native look + dedicated OS channel: install the site as an app
  (Chrome ⋮ → Add to Home screen → Install), then Enable inside the app.
- iOS Safari: web push requires iOS 16.4+ AND Add-to-Home-Screen
  installation; a plain Safari tab can never receive web push.
- Install as app first, then Enable, then test with the app closed.

## 5. Verify end-to-end

1. Enable push on a device as a member; `push_subscriptions` gains a row.
2. From another account send a DM, then send a SECOND message without
   opening the chat — both must push (0032 bump).
3. Check `push_queue`: `status = delivered`, sub-second for new devices.
4. Click the toast → opens the conversation deep link.

## Honest-verification note

Every layer above is verified against the live project (see final
report). `delivered` remains "accepted by the push service" until the
device is checked by hand.

## Key rotation (service key leaked → rotated)

1. Dashboard → Settings → API Keys → roll/rotate the service key.
2. `supabase secrets set CAMPUS_DELIVERY_TOKEN=<new key>`
3. SQL editor: update `push_delivery_config` row 1 with the new token
   (see step 2 above — the same statement).
4. If the anon/public key changed too: update `.env` `VITE_SUPABASE_ANON_KEY`
   and the Vercel env var, then redeploy.
