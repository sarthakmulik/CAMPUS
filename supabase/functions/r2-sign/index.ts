// r2-sign — the authorization bridge between CAMPUS and Cloudflare R2.
//
// R2 has no RLS. The gate moves here: the caller's own Supabase JWT asks the
// database "may this identity see (or upload) this object?" (0055 gate
// wrappers — byte-for-byte the same checks the storage policies run), and
// only then does this function presign a short-lived URL straight to R2.
// The bytes never pass through Supabase; the decision never leaves Supabase.
//
// STUB MODE (R2_SIGN_STUB='true' or missing R2 credentials): the gate runs
// for real, but the presign step returns a marked dummy URL. This is how the
// authorization matrix is live-probed before a Cloudflare account exists —
// deploy dark, probe with the test accounts, flip stubs off when real creds
// are set. Stub mode can never touch real storage.
//
// Request:  POST { ns: 'media'|'chat'|'resource', key: string,
//                 action: 'get'|'put', size?: number, contentType?: string }
// Response: { ok: true, url, expiresIn }  or  { error } (uniform, no
//           existence leak for GET denies).
//
// Secrets (server-only, `supabase secrets set` — never in .env / client):
//   R2_ACCOUNT_ID, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY, R2_BUCKET
//   R2_SIGN_STUB ('true' during dark phase)   ALLOWED_ORIGINS (optional CSV)
//
// verify_jwt stays enabled (function config): the platform rejects requests
// whose Authorization Bearer is not a valid Supabase JWT (anon included)
// before this code runs — the gate can therefore trust the caller's token.

import { AwsClient } from 'npm:aws4fetch@1.0.20'

const GET_TTL_S = 15 * 60          // viewer URLs: short-lived, mint-per-view
const PUT_TTL_S = 10 * 60          // uploader URLs: one upload window
const PUT_MAX_BYTES = 25 * 1024 * 1024   // parity with CHAT_ATTACHMENT_MAX_BYTES / MAX_MEDIA_BYTES
const KEY_MAX_LEN = 512

const CORS = {
  'Access-Control-Allow-Origin': Deno.env.get('ALLOWED_ORIGINS') ?? '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
}

function json(status: number, body: unknown, extra: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', ...CORS, ...extra },
  })
}

// uniform deny shape for GETs: whether the object is missing, hidden, scoped
// or the namespace is unknown, the caller learns only "not available".
const DENY = () => json(404, { error: 'not_available' })

type Body = {
  ns?: string
  key?: string
  action?: string
  size?: number
  contentType?: string
}

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS })
  if (req.method !== 'POST') return json(405, { error: 'method_not_allowed' })

  const supabaseUrl = Deno.env.get('SUPABASE_URL') ?? ''
  // the CALLER's token (set by the platform after verify_jwt) — the gate
  // functions read auth.uid() from it, exactly like storage policies do
  const callerAuth = req.headers.get('Authorization') ?? ''
  const callerKey = req.headers.get('apikey') ?? ''
  if (!supabaseUrl || !callerAuth) return json(401, { error: 'no_auth' })

  let body: Body
  try {
    body = await req.json()
  } catch {
    return json(400, { error: 'bad_json' })
  }

  const { ns, key, action } = body
  if (ns !== 'media' && ns !== 'chat' && ns !== 'resource') return json(400, { error: 'bad_ns' })
  if (action !== 'get' && action !== 'put') return json(400, { error: 'bad_action' })
  if (typeof key !== 'string' || key.length === 0 || key.length > KEY_MAX_LEN
    || key.includes('../') || key.startsWith('/') || key.includes('\n')) {
    return json(400, { error: 'bad_key' })
  }
  if (action === 'put' && typeof body.size === 'number' && body.size > PUT_MAX_BYTES) {
    return json(413, { error: 'too_large' })
  }

  // ---- the gate: ask the database, with the caller's own identity ----------
  const rpc = async (fn: string): Promise<boolean> => {
    const res = await fetch(`${supabaseUrl}/rest/v1/rpc/${fn}`, {
      method: 'POST',
      headers: {
        apikey: callerKey,
        Authorization: callerAuth,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ p_ns: ns, p_key: key }),
    })
    if (!res.ok) return false
    const out = await res.json().catch(() => false)
    return out === true
  }

  if (action === 'get') {
    if (!(await rpc('can_view_media_source'))) return DENY()
  } else {
    if (!(await rpc('can_write_media_source'))) return json(403, { error: 'not_allowed' })
  }

  // ---- stub mode: the matrix is proven without touching real storage ------
  const accountId = Deno.env.get('R2_ACCOUNT_ID') ?? ''
  const accessKey = Deno.env.get('R2_ACCESS_KEY_ID') ?? ''
  const secretKey = Deno.env.get('R2_SECRET_ACCESS_KEY') ?? ''
  const bucket = Deno.env.get('R2_BUCKET') ?? ''
  const stub = Deno.env.get('R2_SIGN_STUB') === 'true'
    || !accountId || !accessKey || !secretKey || !bucket

  if (stub) {
    return json(200, {
      ok: true,
      stub: true,
      url: `https://stub.invalid/${encodeURIComponent(ns)}/${encodeURIComponent(key)}`,
      expiresIn: action === 'get' ? GET_TTL_S : PUT_TTL_S,
    }, { 'x-campus-r2-stub': 'true' })
  }

  // ---- real presign (SigV4, query-signed) ---------------------------------
  // R2's S3 endpoint parses neither service nor region from its host, so both
  // are explicit. Expiry is set BEFORE signing: the signer folds the existing
  // query params (incl. X-Amz-Expires) into the signature - adding it after
  // signing would invalidate the URL.
  const client = new AwsClient({
    accessKeyId: accessKey,
    secretAccessKey: secretKey,
    service: 's3',
    region: 'auto',
  })
  const host = `${accountId}.r2.cloudflarestorage.com`
  const path = `/${bucket}/${key.split('/').map(encodeURIComponent).join('/')}`

  if (action === 'get') {
    const target = new Request(`https://${host}${path}?X-Amz-Expires=${GET_TTL_S}`, { method: 'GET' })
    const signed = await client.sign(target, { aws: { signQuery: true } })
    return json(200, { ok: true, url: signed.url, expiresIn: GET_TTL_S })
  }

  // note: content-type is deliberately NOT bound into the signature - the
  // uploader may set its own type header; the object key's extension already
  // determines presentation (same as the Supabase flow)
  const target = new Request(`https://${host}${path}?X-Amz-Expires=${PUT_TTL_S}`, { method: 'PUT' })
  const signed = await client.sign(target, { aws: { signQuery: true } })
  return json(200, { ok: true, url: signed.url, expiresIn: PUT_TTL_S })
})
