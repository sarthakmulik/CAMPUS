/**
 * Social graph presentation tests — node:test, executed by bundling with esbuild
 * and running under Node (the repo has no test framework; see engine.test.ts).
 * Run: npx esbuild src/lib/socialGraph.test.ts --bundle --platform=node
 *      --format=cjs --outfile=temp-social-graph-tests.cjs && node temp-social-graph-tests.cjs
 *
 * These cover the half that can be silently wrong: a label that reads as a
 * two-way follow when it is one-way, or an explanation line for a signal that
 * does not exist. The SQL side is covered by supabase/tests/0065_social_graph.sql.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import {
  SCORE_CEILING,
  SCORE_WEIGHTS,
  emptyRelation,
  isMutual,
  relationshipExplanation,
  relationshipLabel,
} from './socialGraphCopy'
import type { SocialRelation } from './socialGraphCopy'

function relation(overrides: Partial<SocialRelation> = {}): SocialRelation {
  return { ...emptyRelation(), ...overrides }
}

// --- labels -----------------------------------------------------------------

test('no relation has no label and no explanation', () => {
  assert.equal(relationshipLabel(null), null)
  assert.deepEqual(relationshipExplanation(null), [])
  assert.equal(isMutual(null), false)
})

test('a one-way follow never reads as mutual', () => {
  const onlyMe = relation({ iFollow: true })
  assert.equal(relationshipLabel(onlyMe), 'Following')
  assert.equal(isMutual(onlyMe), false)

  const onlyThem = relation({ followsMe: true })
  assert.equal(relationshipLabel(onlyThem), 'Follows you')
  assert.equal(isMutual(onlyThem), false)

  const mutual = relation({ iFollow: true, followsMe: true, mutual: true })
  assert.equal(relationshipLabel(mutual), 'Mutual')
  assert.equal(isMutual(mutual), true)
})

test('two strangers with a shared follow are suggested, not following', () => {
  assert.equal(relationshipLabel(relation()), null)
  assert.equal(relationshipLabel(relation({ commonFollowing: 3 })), 'Suggested')
})

test('"Friends" is never a label', () => {
  for (const candidate of [
    relation(),
    relation({ iFollow: true }),
    relation({ followsMe: true }),
    relation({ mutual: true }),
    relation({ commonFollowing: 9, sameCollege: true, sameDepartment: true }),
  ]) {
    assert.notEqual(relationshipLabel(candidate), 'Friends')
  }
})

// --- explanations -----------------------------------------------------------

test('every explanation line is backed by a real signal', () => {
  const lines = relationshipExplanation(
    relation({
      mutual: true,
      commonFollowing: 3,
      commonFollowers: 1,
      sharedClubs: 2,
      sameCollege: true,
      sameDepartment: true,
      interactions30d: 4,
    }),
  )
  assert.deepEqual(lines, [
    'Follows you',
    '3 mutual connections',
    '1 shared follower',
    '2 shared communities',
    'From your college',
    'Same department',
    '4 interactions recently',
  ])
})

test('an empty relation explains nothing', () => {
  assert.deepEqual(relationshipExplanation(relation()), [])
})

test('singular counts are singular', () => {
  assert.deepEqual(relationshipExplanation(relation({ commonFollowing: 1 })), ['1 mutual connection'])
  assert.deepEqual(relationshipExplanation(relation({ sharedClubs: 1 })), ['1 shared community'])
  assert.deepEqual(relationshipExplanation(relation({ interactions30d: 1 })), ['You interacted recently'])
})

test('zero signals are omitted, not shown as zero', () => {
  const lines = relationshipExplanation(
    relation({ commonFollowing: 0, commonFollowers: 0, sharedClubs: 0, interactions30d: 0 }),
  )
  assert.deepEqual(lines, [])
})

test('campus is not claimed when the two share no college', () => {
  assert.deepEqual(relationshipExplanation(relation({ sameCampus: true })), ['From your campus'])
  assert.deepEqual(relationshipExplanation(relation({ sameCollege: true, sameCampus: true })), [
    'From your college',
  ])
})

test('"Follows you" wins over "You follow them" for a mutual pair', () => {
  const lines = relationshipExplanation(relation({ mutual: true, iFollow: true, followsMe: true }))
  assert.equal(lines[0], 'Follows you')
  assert.ok(!lines.includes('You follow them'))
})

// --- published score --------------------------------------------------------

test('the published weights sum to the ceiling the server can reach', () => {
  assert.equal(SCORE_CEILING, 100)
  assert.equal(
    SCORE_CEILING,
    SCORE_WEIGHTS.reduce((total, part) => total + part.max, 0),
  )
})

test('each published weight has a label and a positive cap', () => {
  const keys = new Set<string>()
  for (const part of SCORE_WEIGHTS) {
    assert.ok(part.label.length > 0, `${part.key} needs a label for the rules sheet`)
    assert.ok(part.max > 0, `${part.key} needs a positive cap`)
    assert.ok(!keys.has(part.key), `${part.key} is published twice`)
    keys.add(part.key)
  }
})

test('the published keys match the signals the explanation can report', () => {
  const keys = SCORE_WEIGHTS.map(part => part.key)
  for (const expected of ['mutual', 'commonFollowing', 'commonFollowers', 'sharedClubs', 'sameCollege', 'sameDepartment', 'interactions30d']) {
    assert.ok(keys.includes(expected), `${expected} is scored but not published`)
  }
})