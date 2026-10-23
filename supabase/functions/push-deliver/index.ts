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

const MAX_ATTEMPTS = 3
/** Deliver only rows whose scheduled attempt time has arrived. */
const RETRY_BACKOFF_MINUTES = [1, 5, 30]

async function deliverRow(row: QueueRow): Promise<boolean> {
  const { data: subs, error: subError } = await supabase
    .from('push_subscriptions')
    .select('endpoint, p256dh, auth_key')
    .eq('user_id', row.recipient_id)
    .returns<SubscriptionRow[]>()
  if (subError) throw subError

  const stale: string[] = []
  let broadlyFailed = false

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

  if (stale.length > 0) {
    await supabase.from('push_subscriptions').delete().in('endpoint', stale)
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
  if (!VAPID_PUBLIC_KEY || !VAPID_PRIVATE_KEY) {
    return new Response(JSON.stringify({ error: 'VAPID keys not configured' }), {
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
