/**
 * Relationship presentation — pure, no runtime imports.
 *
 * Split out of socialGraph.ts on purpose: this is the part that can be wrong
 * without anyone noticing (a label that reads as a two-way follow when it is
 * one-way, an explanation line for a signal that does not exist), and it is the
 * part a test can check without a browser, a network, or a database.
 *
 * socialGraph.ts re-exports all of it, so callers keep importing one module.
 */

export type SocialRelation = {
  iFollow: boolean
  followsMe: boolean
  mutual: boolean
  /** how many of the member's own follows are mutual (their aggregate row) */
  mutualTotal: number
  /** accounts both members follow */
  commonFollowing: number
  /** accounts that follow both members */
  commonFollowers: number
  /** active communities they both belong to */
  sharedClubs: number
  sameCollege: boolean
  sameDepartment: boolean
  sameCampus: boolean
  /** likes + comments between the two, in either direction, last 30 days */
  interactions30d: number
  lastInteractionAt: string | null
  /** 0-100, server-computed, capped per signal */
  score: number
}

/** A relation with every signal at rest - used by callers that only need shape. */
export function emptyRelation(): SocialRelation {
  return {
    iFollow: false,
    followsMe: false,
    mutual: false,
    mutualTotal: 0,
    commonFollowing: 0,
    commonFollowers: 0,
    sharedClubs: 0,
    sameCollege: false,
    sameDepartment: false,
    sameCampus: false,
    interactions30d: 0,
    lastInteractionAt: null,
    score: 0,
  }
}

/** True when the two follow each other - a real mutual, not "you both follow X". */
export function isMutual(relation: SocialRelation | null): boolean {
  return relation?.mutual === true
}

/**
 * Explanation lines for the profile header and people cards.
 *
 * Every line is backed by a number the server returned. "Follows you" comes from
 * follows_me, "N mutual connections" from common_following (the accounts you both
 * follow - the same thing a member means when they read that phrase), and the
 * shared-community / college / department lines only appear when the count or
 * flag is real. Nothing here infers a characteristic from behaviour.
 */
export function relationshipExplanation(relation: SocialRelation | null): string[] {
  if (!relation) return []
  const lines: string[] = []

  if (relation.followsMe || relation.mutual) lines.push('Follows you')
  else if (relation.iFollow) lines.push('You follow them')

  if (relation.commonFollowing > 0) {
    lines.push(
      relation.commonFollowing === 1
        ? '1 mutual connection'
        : `${relation.commonFollowing} mutual connections`,
    )
  }
  if (relation.commonFollowers > 0) {
    lines.push(
      relation.commonFollowers === 1
        ? '1 shared follower'
        : `${relation.commonFollowers} shared followers`,
    )
  }
  if (relation.sharedClubs > 0) {
    lines.push(
      relation.sharedClubs === 1
        ? '1 shared community'
        : `${relation.sharedClubs} shared communities`,
    )
  }
  if (relation.sameCollege) lines.push('From your college')
  else if (relation.sameCampus) lines.push('From your campus')
  if (relation.sameDepartment) lines.push('Same department')

  if (relation.interactions30d > 0) {
    lines.push(
      relation.interactions30d === 1
        ? 'You interacted recently'
        : `${relation.interactions30d} interactions recently`,
    )
  }

  return lines
}

/**
 * Short label for the relationship itself. Deliberately four states, not a
 * score bucket: "Friends" is not a thing on CAMPUS, and a one-way follow must
 * never read as one.
 */
export function relationshipLabel(relation: SocialRelation | null): string | null {
  if (!relation) return null
  if (relation.mutual) return 'Mutual'
  if (relation.followsMe) return 'Follows you'
  if (relation.iFollow) return 'Following'
  if (relation.commonFollowing > 0) return 'Suggested'
  return null
}

/**
 * The parts of the server score, for the rules sheet in Settings. These are the
 * published caps, so the number a member sees can be explained line by line
 * instead of being an opaque ranking.
 */
export const SCORE_WEIGHTS = [
  { key: 'mutual', label: 'Mutual follow', max: 18 },
  { key: 'commonFollowing', label: 'Mutual connections', max: 22 },
  { key: 'commonFollowers', label: 'Shared followers', max: 12 },
  { key: 'sharedClubs', label: 'Shared communities', max: 14 },
  { key: 'sameCollege', label: 'Same college', max: 8 },
  { key: 'sameDepartment', label: 'Same department', max: 6 },
  { key: 'interactions30d', label: 'Recent interactions', max: 16 },
  { key: 'recency', label: 'Interaction in the last 7 days', max: 4 },
] as const

/** Sum of the caps. Published so the ceiling is checkable in one place. */
export const SCORE_CEILING = SCORE_WEIGHTS.reduce((total, part) => total + part.max, 0)