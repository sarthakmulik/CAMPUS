// CAMPUS edge function: push-deliver
//
// Asynchronous browser push delivery for the notification system.
// The DB trigger `notifications_enqueue_push` (migration 0029) places one row
// per eligible notification in `push_queue` (with the display payload built
// server-side respecting the recipient's preferences). This function turns
// queued rows into real web-push requests.
//
// Deployment (Supabase CLI):
//   supabase functions deploy push-deliver --no-verify-jwt=false
//   supabase secrets set VAPID_PUBLIC_KEY=...  VAPID_PRIVATE_KEY=...  VAPID_SUBJECT=mailto:you@domain
// Native (Capacitor) delivery — optional, additive, routed by platform:
//   Android tokens are FCM registration tokens → FCM HTTP v1:
//     supabase secrets set FCM_SERVICE_ACCOUNT='{"project_id":...,"client_email":...,"private_key":...}'
//     (Firebase console → Project settings → Service accounts → Generate new
//     private key.)
//   iOS tokens are RAW APNs device tokens (the Capacitor 8 iOS plugin uses
//     plain APNs, no Firebase) → APNs HTTP/2 with the .p8 auth key:
//     supabase secrets set APNS_AUTH_KEY='<AuthKey_XXXX.p8 contents>' \
//       APNS_KEY_ID=<10-char key id> APNS_TEAM_ID=<10-char team id>
//     (Apple Developer → Certificates, IDs & Profiles → Keys → APNs key.
//     Optional APNS_TOPIC overrides the default bundle id com.campus.app.)
//   Without the matching secret, that platform's device rows are skipped
//   honestly and browser push is unaffected.
// Wiring:
//   Dashboard → Database → Webhooks → on push_queue INSERT → POST to this
//   function with the service-role key as the Bearer token.
// Optional bounded retry sweep (see supabase/optional-push-sweep-cron.sql):
//   pg_cron POSTs { "run": "sweep" } with the same Bearer token.
//
// Guarantees:
//   - The in-app notification row ALWAYS exists before a push is attempted —
//     a failed push never loses the underlying event.
//   - Invalid endpoints (404/410 from the push service) are removed, so
//     stale devices stop being retried.
//   - Client roles can never read or forge the queue: it has no GRANTs and
//     no RLS policies; this function uses the service role only server-side.

import { createClient } from 'npm:@supabase/supabase-js@2'
import webpush from 'npm:web-push@3.6.7'

// Delivery bearer: prefer our own secret (set via `supabase secrets set
// CAMPUS_DELIVERY_TOKEN=<service_role key>`) so callers authenticate against a
// token we control; fall back to the platform-injected service role key.
// One token serves both the auth check and the service-role DB client.
const FUNCTION_SECRET =
  Deno.env.get('CAMPUS_DELIVERY_TOKEN') ??
  Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ??
  ''
const VAPID_PUBLIC_KEY = Deno.env.get('VAPID_PUBLIC_KEY') ?? ''
const VAPID_PRIVATE_KEY = Deno.env.get('VAPID_PRIVATE_KEY') ?? ''
const VAPID_SUBJECT = Deno.env.get('VAPID_SUBJECT') ?? 'mailto:campus@noreply.example'

/* FCM HTTP v1 (native Android/iOS tokens). The service-account JSON never
   leaves the server side; the OAuth access token is minted per hour. */
type ServiceAccount = { project_id: string; client_email: string; private_key: string }
let fcmAccount: ServiceAccount | null = null
try {
  const raw = Deno.env.get('FCM_SERVICE_ACCOUNT') ?? ''
  if (raw) {
    const parsed = JSON.parse(raw) as ServiceAccount
    if (parsed.project_id && parsed.client_email && parsed.private_key) fcmAccount = parsed
  }
} catch { /* malformed secret → native delivery stays off, web unaffected */ }
let fcmToken: { value: string; expiresAt: number } | null = null

/* APNs HTTP/2 (native iOS tokens). The .p8 key never leaves the server side;
   the ES256 provider JWT is reused for up to 50 minutes (Apple allows 60). */
type ApnsConfig = { keyPem: string; keyId: string; teamId: string; topic: string }
let apnsConfig: ApnsConfig | null = null
{
  const keyPem = Deno.env.get('APNS_AUTH_KEY') ?? ''
  const keyId = Deno.env.get('APNS_KEY_ID') ?? ''
  const teamId = Deno.env.get('APNS_TEAM_ID') ?? ''
  if (keyPem.includes('BEGIN PRIVATE KEY') && keyId && teamId) {
    apnsConfig = { keyPem, keyId, teamId, topic: Deno.env.get('APNS_TOPIC') ?? 'com.campus.app' }
  }
}
let apnsJwt: { value: string; expiresAt: number } | null = null

const supabase = createClient(
  Deno.env.get('SUPABASE_URL') ?? '',
  FUNCTION_SECRET,
  { auth: { persistSession: false, autoRefreshToken: false } },
)

if (VAPID_PUBLIC_KEY && VAPID_PRIVATE_KEY) {
  webpush.setVapidDetails(VAPID_SUBJECT, VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY)
}

type QueueRow = {
  id: string
  notification_id: string
  recipient_id: string
  payload: { title?: string; body?: string; url?: string; tag?: string }
  attempts: number
}

type SubscriptionRow = {
  endpoint: string
  p256dh: string
  auth_key: string
}

type DeviceTokenRow = {
  token: string
  platform: string
}

const MAX_ATTEMPTS = 3
/** Deliver only rows whose scheduled attempt time has arrived. */
const RETRY_BACKOFF_MINUTES = [1, 5, 30]

/* ---- FCM HTTP v1 (Android) -------------------------------------------- */

function base64url(bytes: Uint8Array): string {
  let bin = ''
  for (const b of bytes) bin += String.fromCharCode(b)
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

async function fcmAccessToken(): Promise<string> {
  if (!fcmAccount) throw new Error('FCM not configured')
  if (fcmToken && fcmToken.expiresAt > Date.now() + 60_000) return fcmToken.value
  const pem = fcmAccount.private_key
    .replace('-----BEGIN PRIVATE KEY-----', '')
    .replace('-----END PRIVATE KEY-----', '')
    .replace(/\s+/g, '')
  const der = Uint8Array.from(atob(pem), c => c.charCodeAt(0))
  const key = await crypto.subtle.importKey(
    'pkcs8', der,
    { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
    false, ['sign'],
  )
  const now = Math.floor(Date.now() / 1000)
  const enc = new TextEncoder()
  const header = base64url(enc.encode(JSON.stringify({ alg: 'RS256', typ: 'JWT' })))
  const claims = base64url(enc.encode(JSON.stringify({
    iss: fcmAccount.client_email,
    scope: 'https://www.googleapis.com/auth/firebase.messaging',
    aud: 'https://oauth2.googleapis.com/token',
    iat: now,
    exp: now + 3600,
  })))
  const signature = await crypto.subtle.sign('RSASSA-PKCS1-v1_5', key, enc.encode(`${header}.${claims}`))
  const assertion = `${header}.${claims}.${base64url(new Uint8Array(signature))}`
  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: `grant_type=${encodeURIComponent('urn:ietf:params:oauth:grant-type:jwt-bearer')}&assertion=${assertion}`,
  })
  if (!res.ok) throw new Error(`FCM auth failed: ${res.status}`)
  const json = await res.json() as { access_token: string; expires_in: number }
  fcmToken = { value: json.access_token, expiresAt: Date.now() + json.expires_in * 1000 }
  return fcmToken.value
}

/** Returns false when the token is dead (unregistered/mismatched sender). */
async function sendFcm(device: DeviceTokenRow, payload: QueueRow['payload']): Promise<'ok' | 'stale' | 'failed'> {
  if (!fcmAccount) return 'failed'
  const accessToken = await fcmAccessToken()
  const tag = String(payload.tag ?? 'campus')
  const res = await fetch(`https://fcm.googleapis.com/v1/projects/${fcmAccount.project_id}/messages:send`, {
    method: 'POST',
    headers: { authorization: `Bearer ${accessToken}`, 'content-type': 'application/json' },
    body: JSON.stringify({
      message: {
        token: device.token,
        notification: { title: String(payload.title ?? 'CAMPUS'), body: String(payload.body ?? '') },
        data: { url: String(payload.url ?? ''), tag },
        android: {
          priority: 'high',
          notification: { channel_id: 'campus_default', tag },
        },
      },
    }),
  })
  if (res.ok) return 'ok'
  if (res.status === 401) { fcmToken = null; return 'failed' }
  if (res.status === 404) return 'stale'
  if (res.status === 400) {
    const json = await res.json().catch(() => null) as { error?: { status?: string; details?: { errorCode?: string }[] } } | null
    const code = json?.error?.details?.find(d => d.errorCode)?.errorCode ?? json?.error?.status ?? ''
    if (code === 'UNREGISTERED' || code === 'SENDER_ID_MISMATCH' || code === 'THIRD_PARTY_AUTH_ERROR') return 'stale'
  }
  return 'failed'
}

/* ---- APNs HTTP/2 (iOS) ------------------------------------------------ */

async function apnsProviderToken(): Promise<string> {
  if (!apnsConfig) throw new Error('APNs not configured')
  if (apnsJwt && apnsJwt.expiresAt > Date.now() + 60_000) return apnsJwt.value
  const pem = apnsConfig.keyPem
    .replace('-----BEGIN PRIVATE KEY-----', '')
    .replace('-----END PRIVATE KEY-----', '')
    .replace(/\s+/g, '')
  const der = Uint8Array.from(atob(pem), c => c.charCodeAt(0))
  const key = await crypto.subtle.importKey(
    'pkcs8', der,
    { name: 'ECDSA', namedCurve: 'P-256' },
    false, ['sign'],
  )
  const enc = new TextEncoder()
  const header = base64url(enc.encode(JSON.stringify({ alg: 'ES256', kid: apnsConfig.keyId })))
  const claims = base64url(enc.encode(JSON.stringify({
    iss: apnsConfig.teamId,
    iat: Math.floor(Date.now() / 1000),
  })))
  // WebCrypto ECDSA output is raw r||s (64 bytes) — exactly the JWT ES256 format
  const signature = await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, key, enc.encode(`${header}.${claims}`))
  const assertion = `${header}.${claims}.${base64url(new Uint8Array(signature))}`
  apnsJwt = { value: assertion, expiresAt: Date.now() + 50 * 60_000 }
  return assertion
}

/** Returns false when the token is dead for this topic/environment. */
async function sendApns(device: DeviceTokenRow, payload: QueueRow['payload']): Promise<'ok' | 'stale' | 'failed'> {
  if (!apnsConfig) return 'failed'
  const attempt = async (host: string): Promise<{ status: number; reason: string }> => {
    const res = await fetch(`https://${host}/3/device/${device.token}`, {
      method: 'POST',
      headers: {
        authorization: `bearer ${await apnsProviderToken()}`,
        'apns-topic': apnsConfig!.topic,
        'apns-push-type': 'alert',
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        aps: {
          alert: { title: String(payload.title ?? 'CAMPUS'), body: String(payload.body ?? '') },
          sound: 'default',
        },
        url: String(payload.url ?? ''),
        tag: String(payload.tag ?? 'campus'),
      }),
    })
    if (res.ok) {
      await res.body?.cancel()
      return { status: res.status, reason: '' }
    }
    const json = await res.json().catch(() => null) as { reason?: string } | null
    return { status: res.status, reason: json?.reason ?? '' }
  }
  let out = await attempt('api.push.apple.com')
  // Development builds register sandbox tokens; production rejects them with
  // BadDeviceToken. Fall back once so dev + TestFlight/App Store coexist.
  if (out.status === 400 && out.reason === 'BadDeviceToken') {
    out = await attempt('api.sandbox.push.apple.com')
  }
  if (out.status === 200) return 'ok'
  if (out.status === 410) return 'stale' // Unregistered — token is gone
  if (out.status === 400 && ['BadDeviceToken', 'Unregistered', 'DeviceTokenNotForTopic'].includes(out.reason)) return 'stale'
  if (out.status === 403) apnsJwt = null // expired/invalid provider JWT → remint on retry
  return 'failed'
}

async function deliverRow(row: QueueRow): Promise<boolean> {
  const { data: subs, error: subError } = await supabase
    .from('push_subscriptions')
    .select('endpoint, p256dh, auth_key')
    .eq('user_id', row.recipient_id)
    .returns<SubscriptionRow[]>()
  if (subError) throw subError

  const { data: devices, error: devError } = await supabase
    .from('device_tokens')
    .select('token, platform')
    .eq('user_id', row.recipient_id)
    .returns<DeviceTokenRow[]>()
  if (devError) throw devError

  const stale: string[] = []
  const staleTokens: string[] = []
  let broadlyFailed = false

  // Browser targets are only attempted when VAPID is configured; a
  // native-only deployment must not fail every row on missing web keys.
  if (VAPID_PUBLIC_KEY && VAPID_PRIVATE_KEY) {
    for (const sub of subs ?? []) {
      try {
        await webpush.sendNotification(
          {
            endpoint: sub.endpoint,
            keys: { p256dh: sub.p256dh, auth: sub.auth_key },
          },
          JSON.stringify(row.payload ?? {}),
          { TTL: 60 * 60 * 24 },
        )
      } catch (err) {
        const statusCode = (err as { statusCode?: number }).statusCode ?? 0
        // endpoint gone (unsubscribed / expired / changed keys) → clean it up
        if (statusCode === 404 || statusCode === 410) stale.push(sub.endpoint)
        broadlyFailed = true
      }
    }
  }

  for (const device of devices ?? []) {
    // Route by token kind: iOS rows hold raw APNs tokens, Android rows hold
    // FCM tokens. A platform whose provider secret is unset is skipped
    // honestly (the in-app row still exists); it never fails the whole queue.
    const isIos = device.platform === 'ios'
    if (isIos ? !apnsConfig : !fcmAccount) continue
    try {
      const outcome = await (isIos ? sendApns(device, row.payload ?? {}) : sendFcm(device, row.payload ?? {}))
      if (outcome === 'stale') staleTokens.push(device.token)
      else if (outcome === 'failed') broadlyFailed = true
    } catch {
      broadlyFailed = true
    }
  }

  if (stale.length > 0) {
    await supabase.from('push_subscriptions').delete().in('endpoint', stale)
  }
  if (staleTokens.length > 0) {
    await supabase.from('device_tokens').delete().in('token', staleTokens)
  }
  return !broadlyFailed
}

async function handleQueueRow(row: QueueRow, seenAttempts: number): Promise<void> {
  try {
    const ok = await deliverRow(row)
    if (ok) {
      await supabase
        .from('push_queue')
        .update({ status: 'delivered', delivered_at: new Date().toISOString() })
        .eq('id', row.id)
    } else {
      throw new Error('one or more push services rejected the request')
    }
  } catch (err) {
    const attempts = seenAttempts + 1
    const message = err instanceof Error ? err.message.slice(0, 280) : 'unknown error'
    if (attempts >= MAX_ATTEMPTS) {
      await supabase
        .from('push_queue')
        .update({ status: 'failed', attempts, last_error: message })
        .eq('id', row.id)
    } else {
      const waitMin = RETRY_BACKOFF_MINUTES[Math.min(attempts, RETRY_BACKOFF_MINUTES.length) - 1] ?? 30
      await supabase
        .from('push_queue')
        .update({
          attempts,
          last_error: message,
          next_attempt_at: new Date(Date.now() + waitMin * 60_000).toISOString(),
        })
        .eq('id', row.id)
    }
  }
}

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
}

Deno.serve(async req => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS })

  // Only the service role (dashboard webhook / pg_cron) may trigger delivery.
  const auth = req.headers.get('authorization') ?? ''
  if (!FUNCTION_SECRET || auth !== `Bearer ${FUNCTION_SECRET}`) {
    return new Response(JSON.stringify({ error: 'unauthorized' }), {
      status: 401, headers: { ...CORS, 'content-type': 'application/json' },
    })
  }
  if (!(VAPID_PUBLIC_KEY && VAPID_PRIVATE_KEY) && !fcmAccount && !apnsConfig) {
    return new Response(JSON.stringify({ error: 'no push provider configured (VAPID, FCM or APNs)' }), {
      status: 503, headers: { ...CORS, 'content-type': 'application/json' },
    })
  }

  let body: { record?: { id?: string }; run?: string } = {}
  try {
    body = await req.json()
  } catch { /* empty body → sweep */ }

  const rows: QueueRow[] = []

  if (body.record?.id) {
    // single-row delivery straight from the enqueue webhook
    const { data, error } = await supabase
      .from('push_queue')
      .select('id, notification_id, recipient_id, payload, attempts, status')
      .eq('id', body.record.id)
      .eq('status', 'pending')
      .maybeSingle<QueueRow & { status: string }>()
    if (error || !data) {
      return new Response(JSON.stringify({ delivered: 0 }), {
        status: 200, headers: { ...CORS, 'content-type': 'application/json' },
      })
    }
    rows.push(data)
  }

  // sweep: bounded, backoff-aware batch (failed rows leave pending status,
  // so sweeps never loop forever and never hammer a dying provider)
  const { data: due, error } = await supabase
    .from('push_queue')
    .select('id, notification_id, recipient_id, payload, attempts, status')
    .eq('status', 'pending')
    .lte('next_attempt_at', new Date().toISOString())
    .order('next_attempt_at', { ascending: true })
    .limit(50)
    .returns<QueueRow[]>()
  if (!error && due) rows.push(...due)

  for (const row of rows) await handleQueueRow(row, row.attempts ?? 0)

  return new Response(JSON.stringify({ delivered: rows.length }), {
    headers: { ...CORS, 'content-type': 'application/json' },
  })
})
