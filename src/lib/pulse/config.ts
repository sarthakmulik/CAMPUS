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
