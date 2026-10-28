var __create = Object.create;
var __defProp = Object.defineProperty;
var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __getProtoOf = Object.getPrototypeOf;
var __hasOwnProp = Object.prototype.hasOwnProperty;
var __copyProps = (to, from, except, desc) => {
  if (from && typeof from === "object" || typeof from === "function") {
    for (let key of __getOwnPropNames(from))
      if (!__hasOwnProp.call(to, key) && key !== except)
        __defProp(to, key, { get: () => from[key], enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable });
  }
  return to;
};
var __toESM = (mod, isNodeMode, target) => (target = mod != null ? __create(__getProtoOf(mod)) : {}, __copyProps(
  // If the importer is in node compatibility mode or this is not an ESM
  // file that has been converted to a CommonJS file using a Babel-
  // compatible transform (i.e. "__esModule" has not been set), then set
  // "default" to the CommonJS "module.exports" for node compatibility.
  isNodeMode || !mod || !mod.__esModule ? __defProp(target, "default", { value: mod, enumerable: true }) : target,
  mod
));

// src/lib/pulse/engine.test.ts
var import_node_test = __toESM(require("node:test"), 1);
var import_strict = __toESM(require("node:assert/strict"), 1);

// src/lib/pulse/config.ts
var DEFAULT_WEIGHTS = {
  relevance: 0.3,
  quality: 0.25,
  freshness: 0.2,
  engagement: 0.15,
  diversity: 0.1
};
var PERSONALIZATION_WEIGHTS = {
  collegeRelevance: 0.4,
  explicitInterestMatch: 0.25,
  formatPreference: 0.2,
  freshness: 0.15
};
var THRESHOLDS = {
  /** minimum distinct participants before any aggregate result is shown */
  minSample: 10,
  /** minimum percentage-point lift before a "trending" claim */
  trendMinLiftPts: 5,
  /** content shown to a scope within this many days is excluded (freshness) */
  freshnessDays: 14,
  /** smoothed engagement prior (Ig/dirichlet-style): strength + baseline rate */
  engagementPriorStrength: 20,
  engagementBaseline: 0.6,
  /** Wilson z for one-sided 95% on insight floors */
  wilsonZ: 1.645,
  /** finite daily statement deck size */
  statementDeck: 5
};
var MILESTONES = {
  first_pulse: { emoji: "\u26A1", label: "First Pulse", hint: "You answered your first daily Pulse." },
  streak_3: { emoji: "\u{1F525}", label: "Three-Day Streak", hint: "Voted on 3 campus days in a row \u2014 optional, nothing lost if you skip a day." },
  campus_voice: { emoji: "\u{1F4E3}", label: "Campus Voice", hint: "You reacted to a relatable statement." },
  challenge_participant: { emoji: "\u{1F3AF}", label: "Challenge Participant", hint: "You completed a Campus Personality quiz." }
};
var MILESTONE_KEYS = Object.keys(MILESTONES);

// src/lib/pulse/engine.ts
function wilsonLb(successes, total, z = THRESHOLDS.wilsonZ) {
  if (!Number.isFinite(successes) || !Number.isFinite(total) || total <= 0 || successes < 0) return 0;
  const phat = successes / total;
  const zz = z * z;
  const centre = phat + zz / (2 * total);
  const spread = z * Math.sqrt((phat * (1 - phat) + zz / (4 * total)) / total);
  return Math.max(0, (centre - spread) / (1 + zz / total));
}
function smoothedEngagement(votes, skips, priorStrength = THRESHOLDS.engagementPriorStrength, baseline = THRESHOLDS.engagementBaseline) {
  const v = Math.max(0, votes || 0);
  const s = Math.max(0, skips || 0);
  const denom = v + s + priorStrength;
  if (denom <= 0) return baseline;
  return (v + priorStrength * baseline) / denom;
}
function trendGate(input) {
  const minLift = input.minLiftPts ?? THRESHOLDS.trendMinLiftPts;
  const total = input.currentTotal;
  const nowShare = total > 0 ? input.currentSuccesses * 100 / total : 0;
  const lift = nowShare - input.baselineSharePct;
  const floor = wilsonLb(input.currentSuccesses, total) * 100;
  const holds = total > 0 && input.baselineSharePct >= 0 && lift >= minLift && floor > input.baselineSharePct;
  return { lift: round1(lift), nowShare: round1(nowShare), holds };
}
function hashText(text, seed = 0) {
  let h = seed | 0;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = h * 16777619 >>> 0;
  }
  return h | 0;
}
function seededJitter(scopeKey, dateKey, itemId) {
  const h = hashText(scopeKey + ":" + dateKey + ":" + itemId);
  return (h + 2147483647) % 1e3 / 1e5;
}
function seasonCategoriesFor(month, rules) {
  const out = [];
  for (const r of rules ?? []) {
    if (r.months.includes(month)) out.push(...r.categories);
  }
  return out;
}
function dateNum(iso) {
  const ym = /^(\d{4})-(\d{2})-(\d{2})/.exec(iso);
  if (!ym) return null;
  const d = new Date(Date.UTC(Number(ym[1]), Number(ym[2]) - 1, Number(ym[3])));
  return Number.isNaN(d.getTime()) ? null : d.getTime() / 864e5;
}
function daysBetween(a, b) {
  const da = dateNum(a);
  const db = dateNum(b);
  if (da === null || db === null) return null;
  return db - da;
}
function scoreDaily(input, candidates) {
  const pool = candidates ?? input.candidates;
  const w = input.weights ?? DEFAULT_WEIGHTS;
  const freshDays = input.freshnessDays ?? THRESHOLDS.freshnessDays;
  const month = Number(input.date.slice(5, 7));
  const seasons = seasonCategoriesFor(month, input.seasonCategories);
  const scored = [];
  for (const c of pool) {
    const gap = c.lastShown === null ? null : daysBetween(c.lastShown, input.date);
    if (gap !== null && gap < freshDays) continue;
    const relevance = seasons.includes(c.category) ? 1 : c.evergreen ? 0.75 : 0.5;
    const quality = 0.5;
    const freshness = gap === null ? 1 : Math.max(0.1, 1 - gap / freshDays);
    const engagement = smoothedEngagement(c.votes, c.skips);
    const diversity = !input.prevDayCategory || c.category !== input.prevDayCategory ? 1 : 0;
    const parts = {
      relevance: relevance * w.relevance,
      quality: quality * w.quality,
      freshness: freshness * w.freshness,
      engagement: engagement * w.engagement,
      diversity: diversity * w.diversity
    };
    const score = parts.relevance + parts.quality + parts.freshness + parts.engagement + parts.diversity + seededJitter(input.scopeKey, input.date, c.id);
    scored.push({ ...c, score, parts });
  }
  return scored.sort((a, b) => b.score - a.score);
}
function selectDaily(input, candidates) {
  const pool = input.candidates ?? candidates ?? [];
  if (pool.length === 0) return null;
  const scored = scoreDaily(input, pool);
  return scored[0] ?? null;
}
function pickStatementDeck(statements, scopeKey, date, deckSize = THRESHOLDS.statementDeck) {
  const n = Math.max(1, Math.min(deckSize, statements.length));
  return statements.map((s) => ({ s, jitter: seededJitter(scopeKey, date, s.id) })).sort((a, b) => a.jitter - b.jitter).slice(0, n).map((x) => x.s);
}
function pickQuizOrder(input) {
  const w = PERSONALIZATION_WEIGHTS;
  const freshDays = input.freshnessDays ?? THRESHOLDS.freshnessDays;
  return input.quizzes.map((q) => {
    const gap = q.lastShown === null ? null : daysBetween(q.lastShown, input.date);
    const collegeRelevance = 0.5 + Math.min(0.5, q.engagement / 10);
    const interestMatch = q.interests.includes(q.category) ? 1 : 0.5;
    const formatPreference = q.preferredFormats.includes("quiz") ? 1 : 0.5;
    const freshness = gap === null ? 1 : Math.max(0.1, 1 - gap / freshDays);
    return {
      ...q,
      score: collegeRelevance * w.collegeRelevance + interestMatch * w.explicitInterestMatch + formatPreference * w.formatPreference + freshness * w.freshness + seededJitter(input.scopeKey, input.date, q.id)
    };
  }).sort((a, b) => b.score - a.score).map((q) => ({ id: q.id, category: q.category, engagement: q.engagement, interests: q.interests, preferredFormats: q.preferredFormats, lastShown: q.lastShown }));
}
function quizScore(questions, answers, resultCount) {
  if (answers.length !== questions.length || resultCount < 1) return null;
  const scores = new Array(resultCount).fill(0);
  for (let i = 0; i < questions.length; i++) {
    const opt = questions[i].options[answers[i]];
    if (!opt) return null;
    const trait = Math.trunc(opt.trait);
    if (!(trait >= 0 && trait < resultCount)) return null;
    scores[trait]++;
  }
  let best = 0;
  for (let k = 1; k < scores.length; k++) {
    if (scores[k] > scores[best]) best = k;
  }
  return best;
}
function pct(n) {
  const num = typeof n === "number" ? n : Number(n);
  return Number.isFinite(num) ? `${Math.round(num * 10) / 10}%` : "";
}
function formatInsight(data) {
  const sample = Number(data.sample ?? 0);
  const min = Number(data.min ?? THRESHOLDS.minSample);
  const explain = String(data.explain ?? "");
  const period = String(data.period ?? "");
  switch (data.key) {
    case "mood_now": {
      const label = String(data.topLabel ?? "");
      const emoji = String(data.topEmoji ?? "");
      const share = pct(data.share);
      if (!label || !share) return null;
      return {
        key: "mood_now",
        icon: emoji || "\u{1FAC2}",
        title: `Today's campus mood`,
        body: `Most students say ${label} (${share} of responders, ${period}).`,
        explain,
        sample,
        min
      };
    }
    case "mood_shift_up": {
      const now = pct(data.nowShare);
      const base = pct(data.baseShare);
      if (!now || !base) return null;
      return {
        key: "mood_shift_up",
        icon: "\u{1F4C8}",
        title: `Campus mood is lifting`,
        body: `Compared to yesterday, that leading choice moved from ${base} to ${now} of responses.`,
        explain,
        sample,
        min
      };
    }
    case "top_statement_week": {
      const statement = String(data.statement ?? "");
      if (!statement) return null;
      return {
        key: "top_statement_week",
        icon: "\u{1F525}",
        title: `Most relatable this week`,
        body: `\u201C${statement}\u201D drew the most reactions on your campus ${period}.`,
        explain,
        sample,
        min
      };
    }
    case "participation": {
      const today = Number(data.today ?? 0);
      const week = Number(data.week ?? 0);
      if (week <= 0) return null;
      return {
        key: "participation",
        icon: "\u26A1",
        title: `Campus Pulse participation`,
        body: `${week} vote${week === 1 ? "" : "s"} cast on this campus ${period}${today > 0 ? `, ${today} today` : ""}.`,
        explain,
        sample,
        min
      };
    }
    default:
      return null;
  }
}
function round1(n) {
  return Math.round(n * 10) / 10;
}

// src/lib/pulse/engine.test.ts
(0, import_node_test.default)("wilsonLb returns 0 for empty/invalid samples", () => {
  import_strict.default.equal(wilsonLb(0, 0), 0);
  import_strict.default.equal(wilsonLb(5, 0), 0);
  import_strict.default.equal(wilsonLb(-1, 10), 0);
  import_strict.default.equal(wilsonLb(Number.NaN, 10), 0);
});
(0, import_node_test.default)("wilsonLb is lower than the raw share and tightens with sample size", () => {
  const raw = 5 / 10;
  const small = wilsonLb(5, 10);
  const large = wilsonLb(50, 100);
  import_strict.default.ok(small < raw, "floor must undercut the plain share");
  import_strict.default.ok(large > small, "same proportion, MORE evidence \u2192 tighter (higher) floor");
  import_strict.default.ok(wilsonLb(50, 55) > wilsonLb(5, 10), "denser evidence lifts the floor");
  import_strict.default.ok(wilsonLb(10, 10) > 0.6, "unanimous sample has a high floor");
});
(0, import_node_test.default)("smoothedEngagement keeps tiny samples near the baseline", () => {
  const base = THRESHOLDS.engagementBaseline;
  import_strict.default.equal(smoothedEngagement(0, 0), base, "no data \u2192 exactly the baseline");
  const soft = smoothedEngagement(1, 9);
  import_strict.default.ok(Math.abs(soft - base) < 0.2, `10 events (prior 20) move it moderately: ${soft}`);
  import_strict.default.ok(soft < base, `a weak sample (10% rate) still pulls DOWN toward it, from ${base}`);
  const big = smoothedEngagement(200, 40);
  import_strict.default.ok(big > 0.8 && big < 1, "a strong large-sample rate stays high and < 1");
  import_strict.default.equal(smoothedEngagement(0, 500), 12 / 520, "all skips \u2192 small but nonzero (prior\xD7baseline survives)");
});
(0, import_node_test.default)("trendGate requires BOTH the lift threshold and the Wilson floor", () => {
  const small = trendGate({ currentSuccesses: 12, currentTotal: 30, baselineSharePct: 30, minLiftPts: 5 });
  import_strict.default.equal(small.holds, false, "Wilson floor of 12/30 cannot clear 30%");
  const big = trendGate({ currentSuccesses: 120, currentTotal: 300, baselineSharePct: 30, minLiftPts: 5 });
  import_strict.default.equal(big.holds, true);
  const noLift = trendGate({ currentSuccesses: 33, currentTotal: 100, baselineSharePct: 30, minLiftPts: 5 });
  import_strict.default.equal(noLift.holds, false);
  import_strict.default.equal(trendGate({ currentSuccesses: 0, currentTotal: 0, baselineSharePct: 10 }).holds, false);
});
(0, import_node_test.default)("season categories map by month", () => {
  const rules = [{ months: [10, 11, 12, 1], categories: ["exams"] }, { months: [2, 3], categories: ["fests"] }];
  import_strict.default.deepEqual(seasonCategoriesFor(11, rules), ["exams"]);
  import_strict.default.deepEqual(seasonCategoriesFor(3, rules), ["fests"]);
  import_strict.default.deepEqual(seasonCategoriesFor(7, rules), []);
});
var CANDIDATES = [
  { id: "a", category: "exams", evergreen: false, lastShown: null, votes: 0, skips: 0 },
  { id: "b", category: "campus_life", evergreen: true, lastShown: null, votes: 100, skips: 20 },
  { id: "c", category: "food", evergreen: false, lastShown: "2026-10-20", votes: 0, skips: 0 },
  { id: "d", category: "campus_life", evergreen: false, lastShown: null, votes: 0, skips: 0 }
];
function select(date, pool = CANDIDATES) {
  return selectDaily({
    scopeKey: "11111111-1111-1111-1111-111111111111",
    date,
    candidates: pool,
    seasonCategories: [{ months: [10, 11, 12, 1], categories: ["exams"] }],
    prevDayCategory: null
  });
}
(0, import_node_test.default)("selectDaily hard-excludes recently shown content", () => {
  const pick = select("2026-10-28");
  import_strict.default.ok(pick && pick.id !== "c", "excluded item must never win");
  const scores = scoreDaily({
    scopeKey: "x",
    date: "2026-10-28",
    candidates: CANDIDATES
  });
  import_strict.default.ok(scores.every((s) => s.id !== "c"));
});
(0, import_node_test.default)("selectDaily is deterministic: same inputs \u2192 same pick across runs", () => {
  const first = select("2026-10-28");
  const second = select("2026-10-28");
  import_strict.default.deepEqual(first?.id, second?.id);
  import_strict.default.equal(second?.id !== void 0, true);
});
(0, import_node_test.default)("selectDaily rotates across days (freshness window widens the pool)", () => {
  const pickA = select("2026-09-20", [
    { id: "a", category: "exams", evergreen: false, lastShown: null, votes: 0, skips: 0 },
    { id: "z1", category: "food", evergreen: true, lastShown: "2026-09-15", votes: 0, skips: 0 }
  ]);
  import_strict.default.equal(pickA?.id, "a", "never-shown candidate beats recently shown");
  const pickB = select("2026-09-20", [
    { id: "a", category: "exams", evergreen: false, lastShown: "2026-09-18", votes: 0, skips: 0 },
    { id: "z1", category: "food", evergreen: true, lastShown: null, votes: 0, skips: 0 }
  ]);
  import_strict.default.equal(pickB?.id, "z1", "recently-shown a is excluded; only z1 remains");
});
(0, import_node_test.default)("selectDaily prefers the in-season category through relevance weight", () => {
  const pick = select("2026-10-28", [CANDIDATES[0], CANDIDATES[3]]);
  import_strict.default.equal(pick?.id, "a");
});
(0, import_node_test.default)("selectDaily returns null on an empty pool (honest empty state)", () => {
  import_strict.default.equal(select("2026-10-28", []), null);
});
(0, import_node_test.default)("selectDaily diversity: picking a different category beats yesterday\u2019s", () => {
  const pick = selectDaily({
    scopeKey: "x",
    date: "2026-10-28",
    candidates: [CANDIDATES[0], CANDIDATES[3]],
    // exams vs campus_life
    prevDayCategory: "campus_life"
  });
  import_strict.default.equal(pick?.id, "a", "the diversity axis + season both favor exams");
});
(0, import_node_test.default)("malformed inputs in selection never throw", () => {
  const bad = [{ id: "x", category: "", evergreen: true, lastShown: "not-a-date", votes: -5, skips: Number.NaN }];
  const pick = selectDaily({ scopeKey: "x", date: "2026-13-45", candidates: bad });
  import_strict.default.ok(typeof pick === "object");
});
(0, import_node_test.default)("seededJitter is stable within a day and rotates across days", () => {
  const day1 = seededJitter("s", "2026-10-28", "q1");
  const day1again = seededJitter("s", "2026-10-28", "q1");
  const day2 = seededJitter("s", "2026-10-29", "q1");
  import_strict.default.equal(day1, day1again);
  import_strict.default.notEqual(day1, day2);
  import_strict.default.ok(day1 >= 0 && day1 < 0.01, "jitter stays an order below the weights");
});
(0, import_node_test.default)("pickStatementDeck is finite, seeded and rotates", () => {
  const library = Array.from({ length: 14 }, (_, i) => ({ id: `st${i}`, text: `S${i}` }));
  const deck1 = pickStatementDeck(library, "s", "2026-10-28", 5);
  const deck1again = pickStatementDeck(library, "s", "2026-10-28", 5);
  const deck2 = pickStatementDeck(library, "s", "2026-10-29", 5);
  import_strict.default.equal(deck1.length, 5, "deck is capped at the configured size");
  import_strict.default.deepEqual(deck1, deck1again, "stable within the day");
  const overlap = deck1.filter((d) => deck2.includes(d));
  import_strict.default.ok(overlap.length < 5, "a new day shuffles the lineup");
});
(0, import_node_test.default)("pickStatementDeck caps the deck to the library size, never under 1", () => {
  import_strict.default.equal(pickStatementDeck([], "s", "2026-10-28").length, 0);
  const single = pickStatementDeck([{ id: "only", text: "x" }], "s", "2026-10-28");
  import_strict.default.equal(single.length, 1);
});
var QUIZ = [
  { id: "q1", prompt: "p1", options: [{ text: "a", trait: 0 }, { text: "b", trait: 1 }, { text: "c", trait: 2 }] },
  { id: "q2", prompt: "p2", options: [{ text: "a", trait: 0 }, { text: "b", trait: 1 }, { text: "c", trait: 2 }] },
  { id: "q3", prompt: "p3", options: [{ text: "a", trait: 0 }, { text: "b", trait: 1 }, { text: "c", trait: 2 }] },
  { id: "q4", prompt: "p4", options: [{ text: "a", trait: 0 }, { text: "b", trait: 1 }, { text: "c", trait: 2 }] }
];
(0, import_node_test.default)("quizScore sums trait counts, ties resolve to the LOWEST key", () => {
  import_strict.default.equal(quizScore(QUIZ, [0, 0, 2, 2], 3), 0, "0:2 vs 2:2 tie \u2192 lowest key");
  import_strict.default.equal(quizScore(QUIZ, [1, 1, 1, 0], 3), 1);
  import_strict.default.equal(quizScore(QUIZ, [2, 2, 2, 0], 3), 2);
  import_strict.default.equal(quizScore(QUIZ, [0, 0, 0, 0], 3), 0);
});
(0, import_node_test.default)("quizScore rejects invalid answers server-style", () => {
  import_strict.default.equal(quizScore(QUIZ, [0, 1, 2], 3), null, "answer count mismatch");
  import_strict.default.equal(quizScore(QUIZ, [0, 1, 2, 9], 3), null, "option index out of range");
  import_strict.default.equal(quizScore(QUIZ, [0, 1, -1, 0], 3), null, "negative option index");
  import_strict.default.equal(quizScore(QUIZ, [0, 1, 2, 0], 2), null, "a trait outside the result space is rejected");
});
(0, import_node_test.default)("quizScore fuzz: random answer arrays either score a valid key or null", () => {
  let scored = 0;
  for (let i = 0; i < 200; i++) {
    const n = Math.floor(Math.random() * 6);
    const answers = Array.from({ length: n }, () => Math.floor(Math.random() * 6) - 1);
    const result = quizScore(QUIZ, answers, 3);
    if (result !== null) {
      scored++;
      import_strict.default.ok(result >= 0 && result < 3);
    }
  }
  import_strict.default.ok(scored > 0, "the fuzz produced valid scores too, not only rejects");
});
(0, import_node_test.default)("pickQuizOrder ranks explicit-interest matches first and is deterministic", () => {
  const quizzes = [
    { id: "qA", category: "exams", engagement: 0, interests: ["exams"], preferredFormats: [], lastShown: null },
    { id: "qB", category: "food", engagement: 0, interests: ["exams"], preferredFormats: [], lastShown: null }
  ];
  const order = pickQuizOrder({ scopeKey: "s", date: "2026-10-28", quizzes });
  import_strict.default.equal(order[0].id, "qA");
  const again = pickQuizOrder({ scopeKey: "s", date: "2026-10-28", quizzes });
  import_strict.default.deepEqual(order.map((q) => q.id), again.map((q) => q.id));
});
(0, import_node_test.default)("pickQuizOrder without history still yields a complete ordering", () => {
  const quizzes = [
    { id: "x1", category: "exams", engagement: 0, interests: [], preferredFormats: [], lastShown: null },
    { id: "x2", category: "food", engagement: 0, interests: [], preferredFormats: [], lastShown: null },
    { id: "x3", category: "fests", engagement: 0, interests: [], preferredFormats: [], lastShown: null }
  ];
  const order = pickQuizOrder({ scopeKey: "s", date: "2026-10-28", quizzes });
  import_strict.default.equal(order.length, 3);
  import_strict.default.ok(new Set(order.map((q) => q.id)).size === 3, "no duplicates");
});
(0, import_node_test.default)("formatInsight renders ONLY whitelisted keys", () => {
  import_strict.default.ok(formatInsight({ key: "mood_now", topLabel: "Just surviving", topEmoji: "\u{1F972}", share: 62.5, period: "today", sample: 12, min: 10, explain: "x" }));
  import_strict.default.ok(formatInsight({ key: "mood_shift_up", baseShare: 30, nowShare: 45, sample: 25, min: 10, period: "", explain: "x" }));
  import_strict.default.ok(formatInsight({ key: "top_statement_week", statement: "wifi is fake", sample: 20, min: 10, period: "last 7 days", explain: "x" }));
  import_strict.default.ok(formatInsight({ key: "participation", today: 3, week: 40, sample: 40, min: 10, period: "this week", explain: "x" }));
  import_strict.default.equal(formatInsight({ key: "vendor_promo", text: "buy now" }), null);
  import_strict.default.equal(formatInsight({ key: "<script>alert(1)</script>" }), null);
  import_strict.default.equal(formatInsight({ key: "mood_now", topLabel: "", topEmoji: "\u{1F972}", share: 50 }), null, "missing required data \u2192 honest empty");
});
(0, import_node_test.default)("formatInsight participation hides zero weeks (no fabricated engagement)", () => {
  import_strict.default.equal(formatInsight({ key: "participation", today: 0, week: 0, sample: 0, min: 10, period: "this week", explain: "" }), null);
});
