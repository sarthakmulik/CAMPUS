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

## 6. Native (Capacitor) push — Android/iOS

Native builds cannot use web push (no service worker in the WebView).
The client registers a platform token (`src/platform/nativePush.ts`), stored
in `device_tokens` (migration 0054), and `push-deliver` routes by platform:

- **Android** tokens are FCM registration tokens → delivered over **FCM HTTP v1**
  (one Firebase project).
- **iOS** tokens are **raw APNs device tokens** — the Capacitor 8 iOS plugin
  uses plain APNs, no Firebase — delivered over **APNs HTTP/2** with your .p8
  auth key (ES256 provider JWT). Development builds register sandbox tokens;
  the function falls back to the sandbox endpoint on `BadDeviceToken`, so dev
  and TestFlight/App Store builds coexist.

The queue, prefs, quiet hours and dedupe are unchanged.

**Status: code complete, NOT live-verified.** Activation requires all of:

1. SQL editor: run `supabase/migrations/0054_device_tokens.sql` once
   (additive + idempotent; recreates `notifications_enqueue_push` with the
   native-token gate — apply the whole file in one run).
2. **Android:** Firebase console → create a project → add an Android app with
   package `com.campus.app` → download `google-services.json` into
   `android/app/`. Then Project settings → Service accounts → generate a
   private key and set it as ONE secret (JSON, single line) — never in the repo:
   ```bash
   supabase secrets set FCM_SERVICE_ACCOUNT='<full service-account JSON>'
   ```
3. **iOS:** Apple Developer → Certificates, IDs & Profiles → Keys → create an
   APNs auth key (.p8). Note the Key ID and your Team ID. No Firebase app is
   needed for iOS. Set the secrets (the .p8 contents as one quoted value):
   ```bash
   supabase secrets set APNS_AUTH_KEY='<full AuthKey_XXXX.p8 contents>' \
     APNS_KEY_ID=<10-char Key ID> APNS_TEAM_ID=<10-char Team ID>
   # optional: APNS_TOPIC defaults to com.campus.app
   ```
   The iOS build needs the push entitlement (already wired:
   `ios/App/App/App.entitlements`, `aps-environment=development`; Xcode flips it
   to `production` for distribution) and a provisioning profile that includes
   push.
4. `supabase functions deploy push-deliver`, then rebuild the app
   (`npm run cap:sync` + native build — the Android Firebase flag is baked at
   `vite build` time), sign in, Notification settings → Push notifications →
   Enable. `device_tokens` gains a row.
5. Real-device test (emulator push is unreliable): from another account
   send a DM; check `push_queue.status = delivered`, then confirm the OS
   notification actually appeared and tapping it opens the chat.

A platform whose provider secret is unset is skipped honestly (the in-app
notification still exists); an Android build without `google-services.json`
reports "not configured" and never calls the crash-prone native register().
No push provider secret, service-account key or .p8 key ever ships inside the
app bundle.

## Key rotation (service key leaked → rotated)

1. Dashboard → Settings → API Keys → roll/rotate the service key.
2. `supabase secrets set CAMPUS_DELIVERY_TOKEN=<new key>`
3. SQL editor: update `push_delivery_config` row 1 with the new token
   (see step 2 above — the same statement).
4. If the anon/public key changed too: update `.env` `VITE_SUPABASE_ANON_KEY`
   and the Vercel env var, then redeploy.
