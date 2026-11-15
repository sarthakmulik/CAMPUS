# Android push (FCM) — diagnostic runbook

The pipeline has four links. A notification arriving on Android requires ALL of them:

```
event → notifications row (in-app) → push_queue row (enqueue trigger)
      → instant webhook / cron sweep invokes push-deliver
      → FCM HTTP v1 → the device
```

The in-app side is always true before a push is attempted (0029/0033); a push
failure never loses the notification. So if the bell shows it but Android
shows nothing, the gap is in links 3 or 4.

## 1. Run the four SQL checks (Supabase SQL editor)

```sql
-- A. Is the queue moving at all? Rows stuck 'pending' with attempts=0 mean
--    the webhook + sweep never fired (link 3 broken).
select status, count(*), max(created_at) as newest
from push_queue group by status;

select id, status, attempts, last_error, created_at
from push_queue order by created_at desc limit 15;

-- B. Is the instant-delivery webhook configured? (Bearer token it POSTs with.)
--    token_len 0 → instant path is off; only the cron sweep could deliver.
select length(bearer_token) as token_len, left(bearer_token, 12) as prefix
from push_delivery_config;

-- C. Does the retry sweep exist and run? (0029b is OPTIONAL — a fresh
--    database may simply not have it.)
select jobname, schedule, active from cron.job where jobname = 'campus push sweep';

-- D. Does the server actually hold Android tokens? Empty = registration
--    never reached the DB (link 2 / client side).
select platform, count(*), max(created_at) as newest
from device_tokens group by platform;
```

Interpretation:
- `pending, attempts=0, last_error=null` → nothing is invoking the function → fix B/C.
- `failed, last_error='FCM is not configured...'` → secret missing (fix 2).
- `delivered` but the phone shows nothing → secret present but wrong, or the
  device token is stale — redeploy the hardened function first; it now fails
  rows loudly instead of reporting false success.
- `device_tokens` has android rows with old `created_at` → token likely
  rotated; open the app once (self-heal re-registers) and re-check.

## 2. Redeploy the function + set the secret

The hardened push-deliver (commit 71951cc) logs its provider state at boot and
never reports a false delivery. From the repo root:

```
supabase functions deploy push-deliver
supabase secrets set FCM_SERVICE_ACCOUNT='<contents of the service-account JSON>'
```

The JSON is one line, quoted exactly as Firebase emits it (Project settings →
Service accounts → Generate new private key). A pasted secret with mangled
quotes/newlines is now reported in the function logs at boot.

Verify in Dashboard → Edge Functions → push-deliver → Logs; the boot line is:

```
[push-deliver] providers: {"vapid":true,"fcm":true,"fcmProject":"campus-8095b","apns":false}
```

`fcm:false` = the secret never reached this deployment. `fcmProject` must read
`campus-8095b` (the same project google-services.json ships — a sender-id
mismatch fails every send as SENDER_ID_MISMATCH).

## 3. Confirm the wiring (only if check B/C was broken)

- Instant path: Dashboard → Database → Webhooks → a hook on `push_queue`
  INSERT POSTing `{ "record": { "id": ... } }` to
  `https://ggjdhqokzdidmucvxrgz.supabase.co/functions/v1/push-deliver` with the
  service-role key as Bearer — OR apply `0031_push_webhook_trigger.sql`, which
  wires it from the `push_delivery_config` row (pg_net).
- Sweep: apply `0029b_push_sweep_cron.sql` with the real project ref +
  service-role key substituted.

## 4. Firebase / app-side checklist (already verified in repo)

- `android/app/google-services.json`: package `com.campus.app`, project
  `campus-8095b` — matches `applicationId`. ✔
- `com.google.gms.google-services` Gradle plugin applied when the JSON exists. ✔
- `@capacitor/push-notifications` registered; `POST_NOTIFICATIONS` permission
  in the manifest (Android 13+ asks at enable time). ✔
- Notification channel `campus_default` is created at app boot. ✔
- versionCode 4 / versionName 1.0.3 ships the FCM-enabled build. ✔

## 5. When the server says "delivered" but the phone stays silent

Then it is the device, not the pipeline:

1. **Battery optimization / OEM task killers** (Xiaomi, Oppo, Vivo, Realme,
   Samsung): Settings → Apps → CAMPUS → Battery → Unrestricted. These ROMs
   aggressively kill FCM handlers; no server change fixes them.
2. **Permission revoked**: Settings → Apps → CAMPUS → Notifications.
3. **Data saver / force-closed app**: FCM high priority delivers to
   Doze, but a force-closed app on some OEMs stays silent until relaunched.
4. Test with the app in background (not force-closed) first — that isolates
   OEM behavior from pipeline behavior.

## What the hardened function changes

Old behavior: Android rows skipped silently when FCM was unset, and the row
was still marked `delivered` — "push is broken" looked like "push is fine".

New behavior:
- Boot log states which providers are live.
- Rows for recipients with an Android token fail loudly into
  `push_queue.last_error` with the missing secret named (and retry — 1/5/30
  min backoff, max 3 attempts).
- A malformed `FCM_SERVICE_ACCOUNT` JSON is called out at boot.
