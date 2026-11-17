// CAMPUS edge function: pulse-generate
//
// Campus Pulse 2.0 — AI content generation through OpenRouter.
// Generates candidate personality/topic quizzes and inserts them into the
// EXISTING pulse_items library as status='draft', so nothing reaches
// students until a campus admin approves it through the normal flow
// (pulse_admin_set_status). Scoring stays server-authoritative in
// pulse_quiz_submit; the AI never computes anyone's result.
//
// Security model:
//   * Caller must hold has_op('pulse.admin') (verified against the DB with
//     the caller's own JWT — never trusted from the request body).
//   * The OpenRouter key lives ONLY in `OPENROUTER_API_KEY` (supabase
//     secrets). It is never returned, logged, or sent to the browser.
//   * Generation is budgeted: at most pulse.ai.dailyBudget successful runs
//     per campus day (tracked in pulse_job_runs), ≤ pulse.ai.maxRetries
//     attempts per run, hard request timeout.
//   * Every candidate passes deterministic validation (schema, lengths,
//     duplicates, topic taxonomy, safety scan, scoring compatibility)
//     before insertion. Failed candidates are logged and never published.
//   * Only pseudonymous topic-level context leaves the database — never
//     user identities, private messages, or raw activity logs.
//
// Deployment (Supabase CLI):
//   supabase functions deploy pulse-generate
//   supabase secrets set OPENROUTER_API_KEY=sk-or-...
//
// Testing from the staff console or curl:
//   POST /functions/v1/pulse-generate   Authorization: Bearer <user jwt>
//   body: {} (uses config defaults) or { "topic": "technology" }

import { createClient } from 'npm:@supabase/supabase-js@2'

const CORS = {
  'access-control-allow-origin': '*',
  'access-control-allow-headers': 'authorization, x-client-info, apikey, content-type',
}

const ANON_KEY = Deno.env.get('SUPABASE_ANON_KEY') ?? ''
const SERVICE_KEY =
  Deno.env.get('CAMPUS_DELIVERY_TOKEN') ??
  Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? ''
const OPENROUTER_KEY = Deno.env.get('OPENROUTER_API_KEY') ?? ''
const OPENROUTER_URL = 'https://openrouter.ai/api/v1/chat/completions'

/* ------------------------------------------------------------------ */
/* Taxonomy + season context (mirrors public.pulse_topics / 0048)      */
/* ------------------------------------------------------------------ */
const TOPIC_LABELS: Record<string, string> = {
  campus_life: 'Campus life', exams: 'Exams & study', food: 'Food & mess',
  hostel: 'Hostel life', commute: 'Commute', fests: 'Fests & events',
  technology: 'Technology', placements: 'Placements & career',
  sports: 'Sports & fitness', entertainment: 'Entertainment',
  entrepreneurship: 'Startups & ideas',
}
const QUIZ_TYPES = ['personality', 'knowledge', 'scenario']

/* ------------------------------------------------------------------ */
/* Validation                                                          */
/* ------------------------------------------------------------------ */
type AiOption = { text?: unknown; trait?: unknown }
type AiQuestion = { question?: unknown; options?: unknown }
type AiQuiz = {
  title?: unknown; description?: unknown; topic?: unknown
  quiz_type?: unknown; questions?: unknown; results?: unknown
}
type AiResult = { label?: unknown; emoji?: unknown; blurb?: unknown }

const clean = (s: unknown) => typeof s === 'string' ? s.replace(/\s+/g, ' ').trim() : ''
const normTitle = (s: string) => s.toLowerCase().replace(/[^a-z0-9 ]+/g, ' ').replace(/\s+/g, ' ').trim()

/** reject unsafe / out-of-bounds content before it ever reaches a reviewer */
function safetyScan(text: string): string | null {
  const t = text.toLowerCase()
  if (/\b(diagnos\w*|mental illness|do you have (depression|anxiety|adhd)|are you (depressed|autistic))\b/.test(t))
    return 'psychological diagnosis claim'
  if (/\b(full name|phone number|home address|password|aadhaar|otp|credit card|date of birth)\b/.test(t))
    return 'personal data request'
  if (/\b(kill|suicide|self-harm|drugs deal|weapons?|attack)\b/.test(t))
    return 'unsafe content'
  if (/\b(f\*?ck|a\*\*hole|b\*?tch|idiot|stupid \w+ people|dumb)\b/.test(t))
    return 'disrespectful language'
  return null
}

/** token-overlap duplicate check against the existing library */
function tooSimilar(a: string, b: string): boolean {
  const na = new Set(normTitle(a).split(' '))
  const nb = new Set(normTitle(b).split(' '))
  if (na.size === 0 || nb.size === 0) return false
  let inter = 0
  for (const w of na) if (nb.has(w)) inter++
  return inter / Math.min(na.size, nb.size) > 0.8
}

function validateQuiz(q: AiQuiz, existingTitles: string[]): { ok: true; value: ValidQuiz } | { ok: false; reason: string } {
  const title = clean(q.title)
  const description = clean(q.description)
  const topic = clean(q.topic).toLowerCase()
  const quizType = clean(q.quiz_type).toLowerCase()

  if (title.length < 8 || title.length > 120) return { ok: false, reason: `title length ${title.length}` }
  if (description.length < 10 || description.length > 240) return { ok: false, reason: 'description length' }
  if (!TOPIC_LABELS[topic]) return { ok: false, reason: `unknown topic ${topic}` }
  if (!QUIZ_TYPES.includes(quizType)) return { ok: false, reason: `unknown quiz_type ${quizType}` }
  for (const bad of [title, description]) {
    const hit = safetyScan(bad)
    if (hit) return { ok: false, reason: `safety: ${hit}` }
  }
  if (existingTitles.some(t => tooSimilar(title, t))) return { ok: false, reason: 'duplicate of existing quiz' }

  if (!Array.isArray(q.questions) || q.questions.length < 3 || q.questions.length > 12)
    return { ok: false, reason: `question count ${Array.isArray(q.questions) ? q.questions.length : 'n/a'}` }
  if (!Array.isArray(q.results) || q.results.length < 2 || q.results.length > 6)
    return { ok: false, reason: `results count ${Array.isArray(q.results) ? q.results.length : 'n/a'}` }

  const results: { label: string; emoji: string; blurb: string }[] = []
  const seenLabels = new Set<string>()
  for (const r of q.results as AiResult[]) {
    const label = clean(r?.label)
    const emoji = clean(r?.emoji) || '🙂'
    const blurb = clean(r?.blurb)
    if (label.length < 3 || label.length > 60) return { ok: false, reason: 'result label length' }
    if (blurb.length < 10 || blurb.length > 400) return { ok: false, reason: 'result blurb length' }
    const hit = safetyScan(label + ' ' + blurb)
    if (hit) return { ok: false, reason: `safety: ${hit}` }
    if (seenLabels.has(normTitle(label))) return { ok: false, reason: 'duplicate result labels' }
    seenLabels.add(normTitle(label))
    results.push({ label, emoji: [...emoji][0] ?? '🙂', blurb })
  }

  const seenPrompts = new Set<string>()
  const questions: { prompt: string; options: { text: string; trait: number }[] }[] = []
  for (const qItem of q.questions as AiQuestion[]) {
    const prompt = clean(qItem?.question)
    if (prompt.length < 10 || prompt.length > 300) return { ok: false, reason: 'question prompt length' }
    const hit = safetyScan(prompt)
    if (hit) return { ok: false, reason: `safety: ${hit}` }
    const key = normTitle(prompt)
    if (seenPrompts.has(key)) return { ok: false, reason: 'duplicate question' }
    seenPrompts.add(key)
    if (!Array.isArray(qItem?.options) || qItem.options.length < 3 || qItem.options.length > 6)
      return { ok: false, reason: 'option count' }
    const options: { text: string; trait: number }[] = []
    for (let i = 0; i < qItem.options.length; i++) {
      const opt = qItem.options[i] as AiOption
      const text = clean(opt?.text)
      if (text.length < 2 || text.length > 140) return { ok: false, reason: 'option text length' }
      const hit = safetyScan(text)
      if (hit) return { ok: false, reason: `safety: ${hit}` }
      // trait must be a valid index into results; deterministic fallback keeps
      // the quiz compatible with pulse_quiz_submit either way
      let trait = Number(opt?.trait)
      if (!Number.isInteger(trait) || trait < 0 || trait >= results.length) trait = i % results.length
      options.push({ text, trait })
    }
    questions.push({ prompt, options })
  }

  return { ok: true, value: { title, description, topic, quizType, questions, results } }
}

type ValidQuiz = {
  title: string; description: string; topic: string; quizType: string
  questions: { prompt: string; options: { text: string; trait: number }[] }[]
  results: { label: string; emoji: string; blurb: string }[]
}

/* ------------------------------------------------------------------ */
/* Prompt construction — pseudonymous topic-level context only         */
/* ------------------------------------------------------------------ */
function buildPrompt(topic: string | null, recentTopics: string[], seasonHint: string): string {
  const topicLine = topic && TOPIC_LABELS[topic]
    ? `Topic: "${topic}" (${TOPIC_LABELS[topic]}).`
    : `Pick ONE topic from: ${Object.keys(TOPIC_LABELS).join(', ')}.`
  const recent = recentTopics.length
    ? `Topics already covered recently by this campus (DO NOT repeat their angle): ${[...new Set(recentTopics)].join(', ')}.`
    : ''
  return [
    'You generate fun, respectful quizzes for Indian college students on the CAMPUS app.',
    topicLine,
    recent,
    `Current season context: ${seasonHint}.`,
    'Produce STRICT JSON only (no markdown fences, no commentary) with exactly this shape:',
    '{"title": string (8-120 chars), "description": string (10-240 chars),',
    ' "topic": one of the topic keys above, "quiz_type": "personality" | "knowledge" | "scenario",',
    ` "results": [2-6 items: {"label": 3-60 chars, "emoji": one emoji, "blurb": 10-400 chars positive non-diagnostic description}],`,
    ' "questions": [3-12 items: {"question": 10-300 chars, "options": [3-6 items: {"text": 2-140 chars, "trait": index of the matching result}]}]}',
    'Rules: every option maps to one result via "trait". Ties resolve to the LOWEST trait index (the scoring engine sums trait hits).',
    'Tone: playful, campus-flavoured, inclusive. Never diagnostic, insulting, discriminatory, or asking for personal data.',
    'Nothing about mental-health diagnoses, nothing unsafe. Labels must feel like fun campus identities.',
  ].filter(Boolean).join('\n')
}

/* ------------------------------------------------------------------ */
/* OpenRouter call                                                     */
/* ------------------------------------------------------------------ */
async function callOpenRouter(model: string, prompt: string, signal: AbortSignal): Promise<{ raw: string; usage: unknown }> {
  const res = await fetch(OPENROUTER_URL, {
    method: 'POST',
    signal,
    headers: {
      authorization: `Bearer ${OPENROUTER_KEY}`,
      'content-type': 'application/json',
      'http-referer': 'https://campus.app',
      'x-title': 'CAMPUS Pulse',
    },
    body: JSON.stringify({
      model,
      max_tokens: 3000,
      temperature: 0.8,
      messages: [{ role: 'user', content: prompt }],
    }),
  })
  if (!res.ok) {
    const body = await res.text()
    throw new Error(`openrouter ${res.status}: ${body.slice(0, 300)}`)
  }
  const j = await res.json()
  const raw: string = j?.choices?.[0]?.message?.content ?? ''
  if (!raw) throw new Error('openrouter returned no content')
  return { raw, usage: j?.usage ?? null }
}

/** tolerant JSON extraction: models sometimes wrap in fences or prose */
function extractJson(raw: string): AiQuiz {
  const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)```/)
  const text = fenced ? fenced[1] : raw
  const start = text.indexOf('{')
  const end = text.lastIndexOf('}')
  if (start < 0 || end <= start) throw new Error('no JSON object in response')
  return JSON.parse(text.slice(start, end + 1)) as AiQuiz
}

/* ------------------------------------------------------------------ */
/* Handler                                                             */
/* ------------------------------------------------------------------ */
Deno.serve(async req => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS })
  if (req.method !== 'POST') return new Response('method not allowed', { status: 405, headers: CORS })

  const auth = req.headers.get('authorization') ?? ''
  const jwt = auth.replace(/^Bearer\s+/i, '')
  if (!jwt) return json({ error: 'signin' }, 401)

  const userClient = createClient(Deno.env.get('SUPABASE_URL') ?? '', ANON_KEY, {
    global: { headers: { authorization: `Bearer ${jwt}` } },
  })
  const admin = createClient(Deno.env.get('SUPABASE_URL') ?? '', SERVICE_KEY)

  try {
    // 1. admin gate — verified against the DB, not the request
    const { data: isOp, error: opErr } = await userClient.rpc('has_op', { p_op: 'pulse.admin' })
    if (opErr || isOp !== true) return json({ error: 'Only campus admins can run AI generation.' }, 403)

    // 2. config + secret presence
    const { data: cfgRows } = await admin.from('pulse_config').select('key,value')
    const cfg = new Map((cfgRows ?? []).map(r => [r.key, r.value]))
    const num = (k: string, d: number) => {
      const v = cfg.get(k)
      const n = typeof v === 'number' ? v : Number(v)
      return Number.isFinite(n) ? n : d
    }
    const aiEnabled = num('pulse.ai.enabled', 0) !== 0
    const model = typeof cfg.get('pulse.ai.model') === 'string' ? String(cfg.get('pulse.ai.model')) : ''
    const dailyBudget = num('pulse.ai.dailyBudget', 12)
    const maxRetries = num('pulse.ai.maxRetries', 2)

    if (!aiEnabled) return json({ error: 'AI generation is disabled. Turn it on in the Pulse admin panel.', state: 'disabled' }, 200)
    if (!model) return json({ error: 'No OpenRouter model configured yet.', state: 'no-model' }, 200)
    if (!OPENROUTER_KEY) return json({ error: 'OPENROUTER_API_KEY secret is not set on the server.', state: 'no-key' }, 200)

    // 3. daily budget — one successful generation per job-run row
    const today = new Date().toISOString().slice(0, 10)
    const { count: todayCount } = await admin
      .from('pulse_job_runs')
      .select('id', { count: 'exact', head: true })
      .eq('job_key', 'ai.generate')
      .eq('ok', true)
      .gte('ran_at', `${today}T00:00:00Z`)
    if ((todayCount ?? 0) >= dailyBudget) {
      await admin.rpc('pulse_log_job', { p_job: 'ai.generate', p_idem: `${today}:budget-block`, p_ok: false,
        p_detail: { reason: 'budget', attempted: todayCount } })
      return json({ error: `Daily generation budget reached (${dailyBudget}). Try again tomorrow.`, state: 'budget' }, 200)
    }

    // 4. context: recent topics + season + caller's requested topic
    let body: { topic?: string } = {}
    try { body = await req.json() } catch { /* empty body is fine */ }
    const topic = body?.topic && TOPIC_LABELS[body.topic] ? body.topic : null

    const { data: recentItems } = await admin
      .from('pulse_items').select('category,body')
      .eq('kind', 'quiz').order('created_at', { ascending: false }).limit(20)
    const recentTopics = (recentItems ?? []).map(r => r.category)
    const existingTitles = (recentItems ?? []).map(r => r.body)
    const month = new Date().getMonth() + 1
    const seasonHint =
      month === 10 || month === 11 || month === 12 || month === 1 ? 'examination season energy — study-life balance themes welcome'
      : month === 2 || month === 3 ? 'college fest season — culture, events, creativity'
      : 'regular semester — everyday campus life'

    // 5. generation + validation loop (bounded retries)
    let lastReason = 'unknown'
    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      try {
        const controller = new AbortController()
        const timer = setTimeout(() => controller.abort(), 45000)
        const { raw, usage } = await callOpenRouter(model, buildPrompt(topic, recentTopics, seasonHint), controller.signal)
        clearTimeout(timer)
        const candidate = extractJson(raw)
        const verdict = validateQuiz(candidate, existingTitles)
        if (!verdict.ok) {
          lastReason = `validation: ${verdict.reason}`
          await admin.rpc('pulse_log_job', { p_job: 'ai.generate', p_idem: `${today}:attempt-${attempt}`, p_ok: false,
            p_detail: { reason: lastReason } })
          continue
        }
        const quiz = verdict.value

        // 6. insert as DRAFT into the existing library — approval flow unchanged
        const { data: item, error: itemErr } = await admin
          .from('pulse_items')
          .insert({ kind: 'quiz', category: quiz.topic, body: quiz.title, version: 1, status: 'draft' })
          .select('id').single()
        if (itemErr || !item) throw new Error(`insert item: ${itemErr?.message ?? 'no id'}`)

        const qRows = quiz.questions.map((qq, i) => ({
          quiz_id: item.id, position: i + 1, prompt: qq.prompt,
          options: qq.options.map(o => ({ text: o.text, trait: o.trait })),
        }))
        const rRows = quiz.results.map((rr, i) => ({
          quiz_id: item.id, result_key: i, label: rr.label, emoji: rr.emoji, blurb: rr.blurb,
        }))
        const { error: qErr } = await admin.from('pulse_quiz_questions').insert(qRows)
        if (qErr) throw new Error(`insert questions: ${qErr.message}`)
        const { error: rErr } = await admin.from('pulse_quiz_results').insert(rRows)
        if (rErr) throw new Error(`insert results: ${rErr.message}`)

        await admin.rpc('pulse_log_job', { p_job: 'ai.generate', p_idem: `${today}:${item.id}`, p_ok: true,
          p_detail: { itemId: item.id, topic: quiz.topic, quizType: quiz.quizType, questions: quiz.questions.length, model, usage } })
        return json({ ok: true, itemId: item.id, topic: quiz.topic, title: quiz.title,
          note: 'Inserted as DRAFT — approve it in the Pulse admin content library.' }, 200)
      } catch (genErr) {
        lastReason = genErr instanceof Error ? genErr.message : String(genErr)
        if (lastReason.includes('The user aborted') || lastReason.includes('abort')) lastReason = 'openrouter timeout (45s)'
        await admin.rpc('pulse_log_job', { p_job: 'ai.generate', p_idem: `${today}:attempt-${attempt}`, p_ok: false,
          p_detail: { reason: lastReason.slice(0, 300) } })
      }
    }

    // 7. honest failure — the library fallback keeps Pulse fully functional
    return json({ error: `Generation failed after ${maxRetries + 1} attempt(s): ${lastReason}`, state: 'failed' }, 200)
  } catch (e) {
    return json({ error: e instanceof Error ? e.message : 'unexpected error' }, 500)
  }
})

function json(body: unknown, status: number) {
  return new Response(JSON.stringify(body), { status, headers: { ...CORS, 'content-type': 'application/json' } })
}
