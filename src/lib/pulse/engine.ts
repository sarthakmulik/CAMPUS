/**
 * Campus Pulse — deterministic client-mirror engine.
 *
 * Every function here is pure, synchronous and testable. The server (RPCs in
 * migration 0048) is authoritative: the SQL functions implement the SAME
 * formulas, and these TypeScript mirrors exist so the client can unit-test
 * the rules, preview selection, and format insight copy from whitelisted
 * keys only. No external AI API — everything is arithmetic the tests can
 * reproduce exactly.
 *
 * Documented limitation (mirrors the server): the app has no impression
 * tracking, so engagement is participation-based (votes vs skips), NOT
 * exposure-adjusted. Stats here never invent sample data.
 */

import { DEFAULT_WEIGHTS, PERSONALIZATION_WEIGHTS, THRESHOLDS } from './config'

// ---------------------------------------------------------------------------
// Statistics
// ---------------------------------------------------------------------------

/** Wilson score LOWER bound for a proportion — the documented uncertainty
 *  method behind every "at least X%" claim in Pulse insights. */
export function wilsonLb(successes: number, total: number, z = THRESHOLDS.wilsonZ): number {
  if (!Number.isFinite(successes) || !Number.isFinite(total) || total <= 0 || successes < 0) return 0
  const phat = successes / total
  const zz = z * z
  const centre = phat + zz / (2 * total)
  const spread = z * Math.sqrt((phat * (1 - phat) + zz / (4 * total)) / total)
  return Math.max(0, (centre - spread) / (1 + zz / total))
}

/**
 * Fairness-aware participation rate: votes over all genuine participation
 * opportunities (votes + skips), smoothed toward the baseline with a
 * uniform prior so tiny samples stay near average instead of swinging wild.
 *   smoothedRate = (votes + priorStrength * baseline) / (votes + skips + priorStrength)
 */
export function smoothedEngagement(
  votes: number,
  skips: number,
  priorStrength = THRESHOLDS.engagementPriorStrength,
  baseline = THRESHOLDS.engagementBaseline,
): number {
  const v = Math.max(0, votes || 0)
  const s = Math.max(0, skips || 0)
  const denom = v + s + priorStrength
  if (denom <= 0) return baseline
  return (v + priorStrength * baseline) / denom
}

/**
 * Trend gate (mirrors SQL mood_shift_up): a claim may only be made when the
 * lift exceeds the configured threshold AND the Wilson floor of the recent
 * share clears the baseline share. Returns null (no claim) or the payload.
 */
export type TrendInput = {
  currentSuccesses: number
  currentTotal: number
  baselineSharePct: number   // comparison share in percent (0-100)
  minLiftPts?: number        // configurable threshold (default 5)
}

export function trendGate(input: TrendInput): { lift: number; nowShare: number; holds: boolean } {
  const minLift = input.minLiftPts ?? THRESHOLDS.trendMinLiftPts
  const total = input.currentTotal
  const nowShare = total > 0 ? (input.currentSuccesses * 100) / total : 0
  const lift = nowShare - input.baselineSharePct
  const floor = wilsonLb(input.currentSuccesses, total) * 100
  const holds =
    total > 0 &&
    input.baselineSharePct >= 0 &&
    lift >= minLift &&
    floor > input.baselineSharePct
  return { lift: round1(lift), nowShare: round1(nowShare), holds }
}

// ---------------------------------------------------------------------------
// Deterministic hashing — the seeded tie-break, mirroring SQL hashtext usage:
// stable within a (scope, date), rotates across days, identical inputs →
// identical outputs, no RNG anywhere.
// ---------------------------------------------------------------------------

/** 32-bit string hash (FNV-1a based, deterministic across engines). */
export function hashText(text: string, seed = 0): number {
  let h = seed | 0
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i)
    h = (h * 0x01000193) >>> 0 // FNV prime, keep 32-bit unsigned
  }
  // fold the unsigned value into signed range like Postgres hashtext would
  return (h | 0)
}

/** Same shape as the SQL tie-break: signed hash, +2^31, mod 1000, /100000. */
export function seededJitter(scopeKey: string, dateKey: string, itemId: string): number {
  const h = hashText(scopeKey + ':' + dateKey + ':' + itemId)
  return ((h + 2147483647) % 1000) / 100000
}

// ---------------------------------------------------------------------------
// Daily question selection (mirror of pulse_pick_daily)
// ---------------------------------------------------------------------------

export type DailyCandidate = {
  id: string
  category: string
  evergreen: boolean
  /** last date this scope showed this item, null if never */
  lastShown: string | null
  /** genuine participation so far (votes across showings) */
  votes: number
  skips: number
}

export type SeasonRule = { months: number[]; categories: string[] }

export type DailySelectInput = {
  scopeKey: string              // college uuid or 'platform'
  date: string                  // ISO date, e.g. '2026-10-28'
  candidates: DailyCandidate[]  // pre-filtered: kind=question, approved, live
  seasonCategories?: SeasonRule[]
  prevDayCategory?: string | null
  weights?: typeof DEFAULT_WEIGHTS
  freshnessDays?: number
}

export type DailyScored = DailyCandidate & { score: number; parts: Record<string, number> }

/** Active-season categories for a month (1-12). */
export function seasonCategoriesFor(month: number, rules?: SeasonRule[]): string[] {
  const out: string[] = []
  for (const r of rules ?? []) {
    if (r.months.includes(month)) out.push(...r.categories)
  }
  return out
}

/** Safe date parse for the engine: 'YYYY-MM-DD' or any ISO string. */
function dateNum(iso: string): number | null {
  const ym = /^(\d{4})-(\d{2})-(\d{2})/.exec(iso)
  if (!ym) return null
  const d = new Date(Date.UTC(Number(ym[1]), Number(ym[2]) - 1, Number(ym[3])))
  return Number.isNaN(d.getTime()) ? null : d.getTime() / 86400000
}

/** Days from `a` to `b` (b - a) for ISO date keys; null when invalid. */
function daysBetween(a: string, b: string): number | null {
  const da = dateNum(a)
  const db = dateNum(b)
  if (da === null || db === null) return null
  return db - da
}

/**
 * Score every candidate with the 0048 weighted model. Hard constraints are
 * the caller's pre-filter plus the freshness exclusion applied here
 * (recently-shown items are HARD-excluded, never merely penalized).
 */
export function scoreDaily(input: DailySelectInput, candidates?: DailyCandidate[]): DailyScored[] {
  const pool = candidates ?? input.candidates
  const w = input.weights ?? DEFAULT_WEIGHTS
  const freshDays = input.freshnessDays ?? THRESHOLDS.freshnessDays
  const month = Number(input.date.slice(5, 7))
  const seasons = seasonCategoriesFor(month, input.seasonCategories)

  const scored: DailyScored[] = []
  for (const c of pool) {
    const gap = c.lastShown === null ? null : daysBetween(c.lastShown, input.date)
    // HARD freshness exclusion: shown within the window → ineligible
    if (gap !== null && gap < freshDays) continue

    // 0.30 relevance: season hit 1.0 · evergreen 0.75 · else 0.5
    const relevance = seasons.includes(c.category) ? 1.0 : c.evergreen ? 0.75 : 0.5
    // 0.25 quality: approval IS the gate (callers pass approved-only pools)
    const quality = 0.5
    // 0.20 freshness: never shown 1.0, else linear decay with a 0.1 floor
    const freshness = gap === null ? 1.0 : Math.max(0.1, 1 - gap / freshDays)
    // 0.15 engagement: participation-based smoothing (no impression data —
    // documented limitation; the server formula is identical)
    const engagement = smoothedEngagement(c.votes, c.skips)
    // 0.10 diversity: different category than yesterday scores full
    const diversity = !input.prevDayCategory || c.category !== input.prevDayCategory ? 1.0 : 0.0

    const parts = {
      relevance: relevance * w.relevance,
      quality: quality * w.quality,
      freshness: freshness * w.freshness,
      engagement: engagement * w.engagement,
      diversity: diversity * w.diversity,
    }
    const score =
      parts.relevance + parts.quality + parts.freshness + parts.engagement + parts.diversity +
      seededJitter(input.scopeKey, input.date, c.id)
    scored.push({ ...c, score, parts })
  }
  return scored.sort((a, b) => b.score - a.score)
}

/** Pick the daily item: highest score wins; deterministic inputs → same pick. */
export function selectDaily(input: DailySelectInput, candidates?: DailyCandidate[]): DailyScored | null {
  const pool = input.candidates ?? candidates ?? []
  if (pool.length === 0) return null   // honest empty — never manufacture
  const scored = scoreDaily(input, pool)
  return scored[0] ?? null
}

// ---------------------------------------------------------------------------
// Statement deck (mirror of pulse_statements order) + quiz ordering
// ---------------------------------------------------------------------------

/**
 * Deterministic daily deck: sorted by the same seeded jitter the SQL uses —
 * stable within a (scope, day), rotates across days, FINITE size (no endless
 * feed; extra statements simply wait for another day).
 */
export function pickStatementDeck(
  statements: { id: string; text: string }[],
  scopeKey: string,
  date: string,
  deckSize = THRESHOLDS.statementDeck,
): typeof statements {
  const n = Math.max(1, Math.min(deckSize, statements.length))
  return statements
    .map(s => ({ s, jitter: seededJitter(scopeKey, date, s.id) }))
    .sort((a, b) => a.jitter - b.jitter)
    .slice(0, n)
    .map(x => x.s)
}

export type QuizCandidate = {
  id: string
  category: string
  /** how many distinct days the user engaged with this category recently */
  engagement: number
  /** preferred category list from explicit interests (empty = neutral) */
  interests: string[]
  /** which formats the user uses (e.g. 'quiz') */
  preferredFormats: string[]
  lastShown: string | null
}

export type QuizOrderInput = {
  scopeKey: string
  date: string
  quizzes: QuizCandidate[]
  freshnessDays?: number
}

/**
 * Personalization formula (weights are configurable starting assumptions):
 *   0.40 collegeRelevance + 0.25 explicitInterestMatch
 * + 0.20 formatPreference  + 0.15 freshness
 * Users with no history get the neutral fallback (all matches 0.5) — the
 * ordering then rides the deterministic jitter alone.
 */
export function pickQuizOrder(input: QuizOrderInput): QuizCandidate[] {
  const w = PERSONALIZATION_WEIGHTS
  const freshDays = input.freshnessDays ?? THRESHOLDS.freshnessDays
  return input.quizzes
    .map(q => {
      const gap = q.lastShown === null ? null : daysBetween(q.lastShown, input.date)
      // 0.40 collegeRelevance — scoped library: everyone sees the same pool,
      // so this term is uniform except for category seasonality; modeled via
      // per-user engagement history normalised to 0..1 with a neutral 0.5.
      const collegeRelevance = 0.5 + Math.min(0.5, q.engagement / 10)
      // 0.25 explicitInterestMatch
      const interestMatch = q.interests.includes(q.category) ? 1.0 : 0.5
      // 0.20 formatPreference
      const formatPreference = q.preferredFormats.includes('quiz') ? 1.0 : 0.5
      // 0.15 freshness
      const freshness = gap === null ? 1.0 : Math.max(0.1, 1 - gap / freshDays)
      return {
        ...q,
        score:
          collegeRelevance * w.collegeRelevance +
          interestMatch * w.explicitInterestMatch +
          formatPreference * w.formatPreference +
          freshness * w.freshness +
          seededJitter(input.scopeKey, input.date, q.id),
      }
    })
    .sort((a, b) => b.score - a.score)
    .map((q): QuizCandidate => ({ id: q.id, category: q.category, engagement: q.engagement, interests: q.interests, preferredFormats: q.preferredFormats, lastShown: q.lastShown }))
}

// ---------------------------------------------------------------------------
// Quiz scoring (mirror of pulse_quiz_submit): sums trait indices per answer,
// highest count wins, ties resolve to the LOWEST result key. The client
 // score is never trusted — the server re-scores; this is the shared model.
// ---------------------------------------------------------------------------

export type QuizOption = { text: string; trait: number }
export type QuizQuestion = { id: string; prompt: string; options: QuizOption[] }

/**
 * @param answers chosen option index per question, aligned to `questions`
 * @returns the winning result key, or null when an answer is invalid
 */
export function quizScore(questions: QuizQuestion[], answers: number[], resultCount: number): number | null {
  if (answers.length !== questions.length || resultCount < 1) return null
  const scores = new Array<number>(resultCount).fill(0)
  for (let i = 0; i < questions.length; i++) {
    const opt = questions[i].options[answers[i]]
    if (!opt) return null
    const trait = Math.trunc(opt.trait)
    if (!(trait >= 0 && trait < resultCount)) return null
    scores[trait]++
  }
  let best = 0
  for (let k = 1; k < scores.length; k++) {
    if (scores[k] > scores[best]) best = k   // strictly greater → ties stay LOW
  }
  return best
}

// ---------------------------------------------------------------------------
// Insight formatting — whitelist-only. formatInsight NEVER renders a key that
// is not in this list, so server payloads shape the copy, and no fabricated
// text can slip through a novel insight key (it renders as nothing and the
// UI shows the honest empty state).
// ---------------------------------------------------------------------------

export type InsightData = Record<string, unknown>

export type FormattedInsight = {
  key: string
  icon: string
  title: string
  body: string
  explain: string
  sample: number
  min: number
}

function pct(n: unknown): string {
  const num = typeof n === 'number' ? n : Number(n)
  return Number.isFinite(num) ? `${Math.round(num * 10) / 10}%` : ''
}

export function formatInsight(data: InsightData): FormattedInsight | null {
  const sample = Number(data.sample ?? 0)
  const min = Number(data.min ?? THRESHOLDS.minSample)
  const explain = String(data.explain ?? '')
  const period = String(data.period ?? '')

  switch (data.key) {
    case 'mood_now': {
      const label = String(data.topLabel ?? '')
      const emoji = String(data.topEmoji ?? '')
      const share = pct(data.share)
      if (!label || !share) return null
      return {
        key: 'mood_now',
        icon: emoji || '🫂',
        title: `Today's campus mood`,
        body: `Most students say ${label} (${share} of responders, ${period}).`,
        explain,
        sample,
        min,
      }
    }
    case 'mood_shift_up': {
      const now = pct(data.nowShare)
      const base = pct(data.baseShare)
      if (!now || !base) return null
      return {
        key: 'mood_shift_up',
        icon: '📈',
        title: `Campus mood is lifting`,
        body: `Compared to yesterday, that leading choice moved from ${base} to ${now} of responses.`,
        explain,
        sample,
        min,
      }
    }
    case 'top_statement_week': {
      const statement = String(data.statement ?? '')
      if (!statement) return null
      return {
        key: 'top_statement_week',
        icon: '🔥',
        title: `Most relatable this week`,
        body: `“${statement}” drew the most reactions on your campus ${period}.`,
        explain,
        sample,
        min,
      }
    }
    case 'participation': {
      const today = Number(data.today ?? 0)
      const week = Number(data.week ?? 0)
      if (week <= 0) return null
      return {
        key: 'participation',
        icon: '⚡',
        title: `Campus Pulse participation`,
        body: `${week} vote${week === 1 ? '' : 's'} cast on this campus ${period}${today > 0 ? `, ${today} today` : ''}.`,
        explain,
        sample,
        min,
      }
    }
    default:
      return null   // unknown server key → render nothing, no invented copy
  }
}

function round1(n: number): number {
  return Math.round(n * 10) / 10
}
