/**
 * Campus Pulse engine tests — node:test, executed by bundling with esbuild
 * and running under Node (the repo has no test framework; see probe notes).
 * Run: npx esbuild src/lib/pulse/engine.test.ts --bundle --platform=node
 *      --format=cjs --outfile=temp-pulse-tests.cjs && node temp-pulse-tests.cjs
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import {
  wilsonLb,
  smoothedEngagement,
  trendGate,
  scoreDaily,
  selectDaily,
  seasonCategoriesFor,
  pickStatementDeck,
  pickQuizOrder,
  quizScore,
  formatInsight,
  seededJitter,
} from './engine'
import { MILESTONE_KEYS, THRESHOLDS } from './config'

// --- wilsonLb ---------------------------------------------------------------

test('wilsonLb returns 0 for empty/invalid samples', () => {
  assert.equal(wilsonLb(0, 0), 0)
  assert.equal(wilsonLb(5, 0), 0)
  assert.equal(wilsonLb(-1, 10), 0)
  assert.equal(wilsonLb(Number.NaN, 10), 0)
})

test('wilsonLb is lower than the raw share and tightens with sample size', () => {
  const raw = 5 / 10
  const small = wilsonLb(5, 10)
  const large = wilsonLb(50, 100)
  assert.ok(small < raw, 'floor must undercut the plain share')
  assert.ok(large > small, 'same proportion, MORE evidence → tighter (higher) floor')
  assert.ok(wilsonLb(50, 55) > wilsonLb(5, 10), 'denser evidence lifts the floor')
  assert.ok(wilsonLb(10, 10) > 0.6, 'unanimous sample has a high floor')
})

// --- smoothedEngagement ------------------------------------------------------

test('smoothedEngagement keeps tiny samples near the baseline', () => {
  const base = THRESHOLDS.engagementBaseline
  assert.equal(smoothedEngagement(0, 0), base, 'no data → exactly the baseline')
  const soft = smoothedEngagement(1, 9)
  assert.ok(Math.abs(soft - base) < 0.2, `10 events (prior 20) move it moderately: ${soft}`)
  assert.ok(soft < base, `a weak sample (10% rate) still pulls DOWN toward it, from ${base}`)
  const big = smoothedEngagement(200, 40)
  assert.ok(big > 0.8 && big < 1, 'a strong large-sample rate stays high and < 1')
  assert.equal(smoothedEngagement(0, 500), 12 / 520, 'all skips → small but nonzero (prior×baseline survives)')
})

// --- trendGate ---------------------------------------------------------------

test('trendGate requires BOTH the lift threshold and the Wilson floor', () => {
  // 12/30 = 40% now vs 30% baseline → 10-pt lift, but small sample:
  const small = trendGate({ currentSuccesses: 12, currentTotal: 30, baselineSharePct: 30, minLiftPts: 5 })
  assert.equal(small.holds, false, 'Wilson floor of 12/30 cannot clear 30%')
  // 120/300 = 40% vs 30% → lift 10 pts, floor ~35% > 30% → holds
  const big = trendGate({ currentSuccesses: 120, currentTotal: 300, baselineSharePct: 30, minLiftPts: 5 })
  assert.equal(big.holds, true)
  // insufficient lift, big sample → no claim
  const noLift = trendGate({ currentSuccesses: 33, currentTotal: 100, baselineSharePct: 30, minLiftPts: 5 })
  assert.equal(noLift.holds, false)
  assert.equal(trendGate({ currentSuccesses: 0, currentTotal: 0, baselineSharePct: 10 }).holds, false)
})

// --- seasonCategoriesFor ------------------------------------------------------

test('season categories map by month', () => {
  const rules = [{ months: [10, 11, 12, 1], categories: ['exams'] }, { months: [2, 3], categories: ['fests'] }]
  assert.deepEqual(seasonCategoriesFor(11, rules), ['exams'])
  assert.deepEqual(seasonCategoriesFor(3, rules), ['fests'])
  assert.deepEqual(seasonCategoriesFor(7, rules), [])
})

// --- daily selection ----------------------------------------------------------

const CANDIDATES = [
  { id: 'a', category: 'exams', evergreen: false, lastShown: null, votes: 0, skips: 0 },
  { id: 'b', category: 'campus_life', evergreen: true, lastShown: null, votes: 100, skips: 20 },
  { id: 'c', category: 'food', evergreen: false, lastShown: '2026-10-20', votes: 0, skips: 0 },
  { id: 'd', category: 'campus_life', evergreen: false, lastShown: null, votes: 0, skips: 0 },
]

function select(date: string, pool = CANDIDATES) {
  return selectDaily({
    scopeKey: '11111111-1111-1111-1111-111111111111',
    date,
    candidates: pool,
    seasonCategories: [{ months: [10, 11, 12, 1], categories: ['exams'] }],
    prevDayCategory: null,
  })
}

test('selectDaily hard-excludes recently shown content', () => {
  // 'c' was shown 8 days before Oct 28; window is 14 → excluded
  const pick = select('2026-10-28')
  assert.ok(pick && pick.id !== 'c', 'excluded item must never win')
  const scores = scoreDaily({
    scopeKey: 'x', date: '2026-10-28', candidates: CANDIDATES,
  })
  assert.ok(scores.every(s => s.id !== 'c'))
})

test('selectDaily is deterministic: same inputs → same pick across runs', () => {
  const first = select('2026-10-28')
  const second = select('2026-10-28')
  assert.deepEqual(first?.id, second?.id)
  assert.equal(second?.id !== undefined, true)
})

test('selectDaily rotates across days (freshness window widens the pool)', () => {
  // simulate a library where every question except evergreen 'b' has been
  // shown recently — the pick must switch once 'a' enters the window
  const pickA = select('2026-09-20', [
    { id: 'a', category: 'exams', evergreen: false, lastShown: null, votes: 0, skips: 0 },
    { id: 'z1', category: 'food', evergreen: true, lastShown: '2026-09-15', votes: 0, skips: 0 },
  ])
  assert.equal(pickA?.id, 'a', 'never-shown candidate beats recently shown')
  const pickB = select('2026-09-20', [
    { id: 'a', category: 'exams', evergreen: false, lastShown: '2026-09-18', votes: 0, skips: 0 },
    { id: 'z1', category: 'food', evergreen: true, lastShown: null, votes: 0, skips: 0 },
  ])
  assert.equal(pickB?.id, 'z1', 'recently-shown a is excluded; only z1 remains')
})

test('selectDaily prefers the in-season category through relevance weight', () => {
  // 'a' (exams, in-season October) vs 'd' (neutral): relevance alone gives
  // 'a' +0.15 over the neutral baseline; jitter (≤0.01) cannot flip that
  const pick = select('2026-10-28', [CANDIDATES[0], CANDIDATES[3]])
  assert.equal(pick?.id, 'a')
})

test('selectDaily returns null on an empty pool (honest empty state)', () => {
  assert.equal(select('2026-10-28', []), null)
})

test('selectDaily diversity: picking a different category beats yesterday’s', () => {
  const pick = selectDaily({
    scopeKey: 'x', date: '2026-10-28',
    candidates: [CANDIDATES[0], CANDIDATES[3]], // exams vs campus_life
    prevDayCategory: 'campus_life',
  })
  assert.equal(pick?.id, 'a', 'the diversity axis + season both favor exams')
})

test('malformed inputs in selection never throw', () => {
  const bad = [{ id: 'x', category: '', evergreen: true, lastShown: 'not-a-date', votes: -5, skips: Number.NaN }]
  const pick = selectDaily({ scopeKey: 'x', date: '2026-13-45', candidates: bad as typeof CANDIDATES })
  // invalid date → no day counting; NaN engagement smoothing falls back to prior
  assert.ok(typeof pick === 'object')
})

// --- seeded deterministic helpers ---------------------------------------------

test('seededJitter is stable within a day and rotates across days', () => {
  const day1 = seededJitter('s', '2026-10-28', 'q1')
  const day1again = seededJitter('s', '2026-10-28', 'q1')
  const day2 = seededJitter('s', '2026-10-29', 'q1')
  assert.equal(day1, day1again)
  assert.notEqual(day1, day2)
  assert.ok(day1 >= 0 && day1 < 0.01, 'jitter stays an order below the weights')
})

// --- statement deck ------------------------------------------------------------

test('pickStatementDeck is finite, seeded and rotates', () => {
  const library = Array.from({ length: 14 }, (_, i) => ({ id: `st${i}`, text: `S${i}` }))
  const deck1 = pickStatementDeck(library, 's', '2026-10-28', 5)
  const deck1again = pickStatementDeck(library, 's', '2026-10-28', 5)
  const deck2 = pickStatementDeck(library, 's', '2026-10-29', 5)
  assert.equal(deck1.length, 5, 'deck is capped at the configured size')
  assert.deepEqual(deck1, deck1again, 'stable within the day')
  const overlap = deck1.filter(d => deck2.includes(d))
  assert.ok(overlap.length < 5, 'a new day shuffles the lineup')
})

test('pickStatementDeck caps the deck to the library size, never under 1', () => {
  assert.equal(pickStatementDeck([], 's', '2026-10-28').length, 0)
  const single = pickStatementDeck([{ id: 'only', text: 'x' }], 's', '2026-10-28')
  assert.equal(single.length, 1)
})

// --- quiz scoring ---------------------------------------------------------------

const QUIZ: Parameters<typeof quizScore>[0] = [
  { id: 'q1', prompt: 'p1', options: [{ text: 'a', trait: 0 }, { text: 'b', trait: 1 }, { text: 'c', trait: 2 }] },
  { id: 'q2', prompt: 'p2', options: [{ text: 'a', trait: 0 }, { text: 'b', trait: 1 }, { text: 'c', trait: 2 }] },
  { id: 'q3', prompt: 'p3', options: [{ text: 'a', trait: 0 }, { text: 'b', trait: 1 }, { text: 'c', trait: 2 }] },
  { id: 'q4', prompt: 'p4', options: [{ text: 'a', trait: 0 }, { text: 'b', trait: 1 }, { text: 'c', trait: 2 }] },
]

test('quizScore sums trait counts, ties resolve to the LOWEST key', () => {
  assert.equal(quizScore(QUIZ, [0, 0, 2, 2], 3), 0, '0:2 vs 2:2 tie → lowest key')
  assert.equal(quizScore(QUIZ, [1, 1, 1, 0], 3), 1)
  assert.equal(quizScore(QUIZ, [2, 2, 2, 0], 3), 2)
  assert.equal(quizScore(QUIZ, [0, 0, 0, 0], 3), 0)
})

test('quizScore rejects invalid answers server-style', () => {
  assert.equal(quizScore(QUIZ, [0, 1, 2], 3), null, 'answer count mismatch')
  assert.equal(quizScore(QUIZ, [0, 1, 2, 9], 3), null, 'option index out of range')
  assert.equal(quizScore(QUIZ, [0, 1, -1, 0], 3), null, 'negative option index')
  assert.equal(quizScore(QUIZ, [0, 1, 2, 0], 2), null, 'a trait outside the result space is rejected')
})

test('quizScore fuzz: random answer arrays either score a valid key or null', () => {
  let scored = 0
  for (let i = 0; i < 200; i++) {
    const n = Math.floor(Math.random() * 6)      // sometimes wrong length
    const answers = Array.from({ length: n }, () => Math.floor(Math.random() * 6) - 1)
    const result = quizScore(QUIZ, answers, 3)
    if (result !== null) {
      scored++
      assert.ok(result >= 0 && result < 3)
    }
  }
  assert.ok(scored > 0, 'the fuzz produced valid scores too, not only rejects')
})

// --- quiz order (personalization) ----------------------------------------------

test('pickQuizOrder ranks explicit-interest matches first and is deterministic', () => {
  const quizzes = [
    { id: 'qA', category: 'exams', engagement: 0, interests: ['exams'], preferredFormats: [], lastShown: null },
    { id: 'qB', category: 'food', engagement: 0, interests: ['exams'], preferredFormats: [], lastShown: null },
  ]
  const order = pickQuizOrder({ scopeKey: 's', date: '2026-10-28', quizzes })
  assert.equal(order[0].id, 'qA')
  const again = pickQuizOrder({ scopeKey: 's', date: '2026-10-28', quizzes })
  assert.deepEqual(order.map(q => q.id), again.map(q => q.id))
})

test('pickQuizOrder without history still yields a complete ordering', () => {
  const quizzes = [
    { id: 'x1', category: 'exams', engagement: 0, interests: [], preferredFormats: [], lastShown: null },
    { id: 'x2', category: 'food', engagement: 0, interests: [], preferredFormats: [], lastShown: null },
    { id: 'x3', category: 'fests', engagement: 0, interests: [], preferredFormats: [], lastShown: null },
  ]
  const order = pickQuizOrder({ scopeKey: 's', date: '2026-10-28', quizzes })
  assert.equal(order.length, 3)
  assert.ok(new Set(order.map(q => q.id)).size === 3, 'no duplicates')
})

// --- insight formatting (whitelist) ---------------------------------------------

test('formatInsight renders ONLY whitelisted keys', () => {
  assert.ok(formatInsight({ key: 'mood_now', topLabel: 'Just surviving', topEmoji: '🥲', share: 62.5, period: 'today', sample: 12, min: 10, explain: 'x' }))
  assert.ok(formatInsight({ key: 'mood_shift_up', baseShare: 30, nowShare: 45, sample: 25, min: 10, period: '', explain: 'x' }))
  assert.ok(formatInsight({ key: 'top_statement_week', statement: 'wifi is fake', sample: 20, min: 10, period: 'last 7 days', explain: 'x' }))
  assert.ok(formatInsight({ key: 'participation', today: 3, week: 40, sample: 40, min: 10, period: 'this week', explain: 'x' }))
  // unknown / hostile keys → null, never invented copy
  assert.equal(formatInsight({ key: 'vendor_promo', text: 'buy now' }), null)
  assert.equal(formatInsight({ key: '<script>alert(1)</script>' }), null)
  assert.equal(formatInsight({ key: 'mood_now', topLabel: '', topEmoji: '🥲', share: 50 }), null, 'missing required data → honest empty')
})

test('formatInsight participation hides zero weeks (no fabricated engagement)', () => {
  assert.equal(formatInsight({ key: 'participation', today: 0, week: 0, sample: 0, min: 10, period: 'this week', explain: '' }), null)
})
