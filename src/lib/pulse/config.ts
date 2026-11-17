/**
 * Campus Pulse — engine configuration (mirrors pulse_config in migration
 * 0048b). Values live in the database for live adjustment through the staff
 * console; these TypeScript mirrors exist for client-side previews and
 * deterministic tests. When an admin changes a pulse_config row, the RPCs
 * take effect immediately — the mirrors here are the same defaults so a
 * fresh database and a fresh client agree without a fetch.
 */

export type PulseWeights = {
  relevance: number
  quality: number
  freshness: number
  engagement: number
  diversity: number
}

export const DEFAULT_WEIGHTS: PulseWeights = {
  relevance: 0.30,
  quality: 0.25,
  freshness: 0.20,
  engagement: 0.15,
  diversity: 0.10,
}

/** Personalization weights (configurable starting assumptions, not proven):
 *  0.40 collegeRelevance + 0.25 explicitInterestMatch + 0.20 formatPreference + 0.15 freshness */
export const PERSONALIZATION_WEIGHTS = {
  collegeRelevance: 0.40,
  explicitInterestMatch: 0.25,
  formatPreference: 0.20,
  freshness: 0.15,
}

export const THRESHOLDS = {
  /** minimum distinct participants before any aggregate result is shown */
  minSample: 10,
  /** minimum percentage-point lift before a "trending" claim */
  trendMinLiftPts: 5,
  /** content shown to a scope within this many days is excluded (freshness) */
  freshnessDays: 14,
  /** smoothed engagement prior (Ig/dirichlet-style): strength + baseline rate */
  engagementPriorStrength: 20,
  engagementBaseline: 0.60,
  /** Wilson z for one-sided 95% on insight floors */
  wilsonZ: 1.645,
  /** finite daily statement deck size */
  statementDeck: 5,
}

/** The three statement reactions, fixed everywhere (SQL check constraint too). */
export const PULSE_REACTIONS = [
  { emoji: '😂', label: 'Same' },
  { emoji: '🥲', label: 'Too real' },
  { emoji: '🙅', label: 'Not me' },
] as const

/** Milestone copy (server only ever awards these four keys). */
export const MILESTONES = {
  first_pulse: { emoji: '⚡', label: 'First Pulse', hint: 'You answered your first daily Pulse.' },
  streak_3: { emoji: '🔥', label: 'Three-Day Streak', hint: 'Voted on 3 campus days in a row — optional, nothing lost if you skip a day.' },
  campus_voice: { emoji: '📣', label: 'Campus Voice', hint: 'You reacted to a relatable statement.' },
  challenge_participant: { emoji: '🎯', label: 'Challenge Participant', hint: 'You completed a Campus Personality quiz.' },
} as const

export type MilestoneKey = keyof typeof MILESTONES

export const MILESTONE_KEYS = Object.keys(MILESTONES) as MilestoneKey[]

/* ==========================================================================
 * PULSE 2.0 — TOPIC TAXONOMY + RECOMMENDATION CONFIG (mirrors 0072)
 * ========================================================================== */

/** The topic taxonomy — mirrors public.pulse_topics (seeded in 0072). */
export const TOPICS = {
  campus_life:      { label: 'Campus life',         emoji: '🎓' },
  exams:            { label: 'Exams & study',       emoji: '📚' },
  food:             { label: 'Food & mess',         emoji: '🍜' },
  hostel:           { label: 'Hostel life',         emoji: '🛏️' },
  commute:          { label: 'Commute',             emoji: '🚌' },
  fests:            { label: 'Fests & events',      emoji: '🎉' },
  technology:       { label: 'Technology',          emoji: '💻' },
  placements:       { label: 'Placements & career', emoji: '🧭' },
  sports:           { label: 'Sports & fitness',    emoji: '🏏' },
  entertainment:    { label: 'Entertainment',       emoji: '🎬' },
  entrepreneurship: { label: 'Startups & ideas',    emoji: '🚀' },
} as const

export type TopicKey = keyof typeof TOPICS
export const TOPIC_KEYS = Object.keys(TOPICS) as TopicKey[]

/** Recommendation weights (mirrors pulse.recommend.* in pulse_config). */
export const RECOMMEND_WEIGHTS = {
  interest: 0.30,
  quality: 0.20,
  freshness: 0.15,
  diversity: 0.15,
  satisfaction: 0.10,
  campus: 0.10,
  /** exploration epsilon — a small seeded bonus so strong-interest users
   *  still discover topics outside their top interests */
  exploration: 0.10,
} as const

/** Interest-learning constants (mirrors the SQL rules in 0072 exactly). */
export const INTEREST_RULES = {
  selectFloor: 0.70,
  avoidCeiling: 0.20,
  likeStep: 0.08,
  dislikeStep: 0.12,
  dismissStep: 0.05,
  neutralBaseline: 0.5,
  /** ranking reads a topic at least this interested (bounded smoothing) */
  minObservationScore: 0.3,
} as const

/** Season calendar (mirrors pulse.seasonCategories in 0048b). */
export function seasonTopics(date = new Date()): TopicKey[] {
  const m = date.getMonth() + 1
  if (m >= 10 || m <= 1) return ['exams']
  if (m === 2 || m === 3) return ['fests']
  return []
}

/** Per-topic visual identity for quiz covers / result themes — deterministic,
 *  no user data involved. [gradient, accent hue rotation for results] */
export const TOPIC_THEMES: Record<TopicKey, { grad: string; ring: string }> = {
  campus_life:      { grad: 'linear-gradient(120deg,#6654f5,#9b7bff)', ring: '#6654f5' },
  exams:            { grad: 'linear-gradient(120deg,#4f7df5,#6fb2ff)', ring: '#4f7df5' },
  food:             { grad: 'linear-gradient(120deg,#f59e4f,#ffb36b)', ring: '#f59e4f' },
  hostel:           { grad: 'linear-gradient(120deg,#8b6cff,#c99bff)', ring: '#8b6cff' },
  commute:          { grad: 'linear-gradient(120deg,#3fb98c,#7fd8b4)', ring: '#3fb98c' },
  fests:            { grad: 'linear-gradient(120deg,#f5548c,#ff9bb8)', ring: '#f5548c' },
  technology:       { grad: 'linear-gradient(120deg,#5468f5,#54b8f5)', ring: '#5468f5' },
  placements:       { grad: 'linear-gradient(120deg,#2f9e8f,#5cc9b8)', ring: '#2f9e8f' },
  sports:           { grad: 'linear-gradient(120deg,#e86a3c,#ffb35c)', ring: '#e86a3c' },
  entertainment:    { grad: 'linear-gradient(120deg,#c14ff5,#f587d8)', ring: '#c14ff5' },
  entrepreneurship: { grad: 'linear-gradient(120deg,#f5a623,#ffd166)', ring: '#f5a623' },
}
