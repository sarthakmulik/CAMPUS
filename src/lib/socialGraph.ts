import { supabase } from './supabase'
import { friendlyMessage } from './db'
import { emptyRelation } from './socialGraphCopy'

/**
 * Social graph service (migration 0065).
 *
 * One place for relationship facts, so no surface invents its own: the profile
 * header, the people-recommendation engine (Phase C) and every later ranking
 * model read the same numbers.
 *
 * Two rules shape this file:
 *
 *  1. The server owns the score. `relationship_score` is computed in SQL from
 *     indexed lookups, never in the browser - a client-supplied number cannot be
 *     trusted to decide what a member sees, and a second implementation would
 *     drift from the one that is enforced.
 *  2. Explanations are derived, never claimed. `relationshipExplanation()` only
 *     returns a line when the corresponding real signal is present, so the UI
 *     can never say "5 mutual connections" for a pair that has none.
 *
 * The pure half (types, labels, explanations, published weights) lives in
 * socialGraphCopy.ts so it can be tested without a browser or a network. It is
 * re-exported here: callers import this module only.
 */

export type { SocialRelation } from './socialGraphCopy'
export {
  SCORE_CEILING,
  SCORE_WEIGHTS,
  emptyRelation,
  isMutual,
  relationshipExplanation,
  relationshipLabel,
} from './socialGraphCopy'

import type { SocialRelation } from './socialGraphCopy'

export type MutualPerson = {
  id: string
  username: string | null
  displayName: string
  avatarUrl: string | null
}

type RelationRow = {
  i_follow: boolean | null
  follows_me: boolean | null
  mutual: boolean | null
  mutual_total: number | string | null
  common_following: number | string | null
  common_followers: number | string | null
  shared_clubs: number | string | null
  same_college: boolean | null
  same_department: boolean | null
  same_campus: boolean | null
  interactions_30d: number | string | null
  last_interaction_at: string | null
  relationship_score: number | string | null
}

type MutualRow = {
  id: string
  username: string | null
  display_name: string | null
  avatar_url: string | null
}

/** Postgres may hand bigint/count back as a string over the REST bridge. */
function int(value: number | string | null | undefined): number {
  if (value === null || value === undefined) return 0
  const parsed = typeof value === 'number' ? value : Number.parseInt(value, 10)
  return Number.isFinite(parsed) ? parsed : 0
}

function bool(value: boolean | null | undefined): boolean {
  return value === true
}

function mapRelation(row: RelationRow): SocialRelation {
  return {
    iFollow: bool(row.i_follow),
    followsMe: bool(row.follows_me),
    mutual: bool(row.mutual),
    mutualTotal: int(row.mutual_total),
    commonFollowing: int(row.common_following),
    commonFollowers: int(row.common_followers),
    sharedClubs: int(row.shared_clubs),
    sameCollege: bool(row.same_college),
    sameDepartment: bool(row.same_department),
    sameCampus: bool(row.same_campus),
    interactions30d: int(row.interactions_30d),
    lastInteractionAt: row.last_interaction_at ?? null,
    score: int(row.relationship_score),
  }
}

/**
 * The caller's relation to one other member, or null when there is nothing to
 * report: not signed in, the member does not exist, the account is suspended,
 * or the two blocked each other. Every caller must treat null as "no relation",
 * not as an error.
 */
export async function fetchRelation(otherId: string): Promise<SocialRelation | null> {
  if (!supabase || !otherId) return null
  const { data, error } = await supabase.rpc('social_relation_of', { p_other: otherId })
  if (error) throw new Error(friendlyMessage(error))
  const rows = (data ?? []) as RelationRow[]
  return rows.length > 0 ? mapRelation(rows[0]) : null
}

/**
 * The accounts behind "N mutual connections", one page at a time. Returns an
 * empty list when the two follow nobody in common - callers must not treat that
 * as an error either.
 */
export async function fetchMutualList(
  otherId: string,
  limit = 12,
  offset = 0,
): Promise<MutualPerson[]> {
  if (!supabase || !otherId) return []
  const { data, error } = await supabase.rpc('social_mutual_list', {
    p_other: otherId,
    p_limit: Math.min(Math.max(limit, 1), 50),
    p_offset: Math.max(offset, 0),
  })
  if (error) throw new Error(friendlyMessage(error))
  return ((data ?? []) as MutualRow[]).map(row => ({
    id: row.id,
    username: row.username ?? null,
    displayName: row.display_name?.trim() || (row.username ? `@${row.username}` : 'Campus student'),
    avatarUrl: row.avatar_url ?? null,
  }))
}

/** The relation row as an empty relation, for callers that want a full shape. */
export function relationOrEmpty(relation: SocialRelation | null): SocialRelation {
  return relation ?? emptyRelation()
}