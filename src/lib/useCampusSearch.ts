/**
 * One search engine, two surfaces.
 *
 * The global header dropdown (SearchPanel) and the Search & Discovery page both
 * read from this hook, so the debounce, the cancellation, the RPCs, the
 * blocked/muted filtering and the honest degradation messages are written once.
 *
 * Nothing here invents data: every list comes from an existing RPC, and each
 * section falls back to the directory rows the shell already loaded when the
 * newer RPC is not applied to the database yet (pre-0057 / pre-0016 projects).
 * The server enforces visibility — private profiles, private/hidden
 * communities and college-only posts are filtered by the RPCs themselves.
 */

import { useEffect, useState } from 'react'
import * as cm from './communities'
import * as db from './db'
import type { CampusPost } from '../types'

/** Two characters: below this every RPC is an unfiltered table read. */
export const MIN_QUERY = 2

/** search_members / search_posts clamp their own limit to 25 — never ask for more. */
const RPC_CEILING = 25

export type CampusSearch = {
  people: db.PersonResult[]
  posts: CampusPost[]
  /** null when the 0057 directory RPC is absent — the caller then uses `colleges`. */
  collegeHits: db.InstitutionHit[]
  collegesFromRpc: boolean
  /** communities from list_clubs (RLS-respecting); empty when it is not applied */
  clubs: cm.CommunitySummary[]
  clubsFromRpc: boolean
  loading: boolean
  error: string | null
  searched: boolean
}

const IDLE: CampusSearch = {
  people: [],
  posts: [],
  collegeHits: [],
  collegesFromRpc: false,
  clubs: [],
  clubsFromRpc: false,
  loading: false,
  error: null,
  searched: false,
}

export type SearchArgs = {
  query: string
  caps: db.Caps
  /** directory rows already loaded by the shell — the offline fallback */
  colleges: db.College[]
  /** the shell's legacy club list — fallback when list_clubs is absent */
  clubs: db.Club[]
  blockedHandles: string[]
  mutedHandles: string[]
  limit?: number
}

/** The RPC-missing message is the same on both surfaces. */
export function searchUnavailable(): string {
  return 'Search is not connected to the database yet — apply supabase/migrations/0007_search.sql (and 0006_chats.sql for chats) in the Supabase SQL editor.'
}

function describeError(error: unknown): string {
  const raw = String((error as { message?: string } | null)?.message ?? '')
  if (/search_members|search_posts|PGRST202|Could not find the function/i.test(raw)) return searchUnavailable()
  return db.friendlyMessage(error)
}

/** Local (pre-0057) college filter — identical rule to SearchPanel's old path. */
function localColleges(colleges: db.College[], term: string): db.InstitutionHit[] {
  const needle = term.toLowerCase()
  return colleges
    .filter(college =>
      college.name.toLowerCase().includes(needle) ||
      college.short_name.toLowerCase().includes(needle))
    .slice(0, 6)
    .map(college => ({
      id: college.id,
      campus_id: null,
      name: college.name,
      short_name: college.short_name,
      institution_type: college.institution_type ?? null,
      locality: college.city || college.locality || null,
      campus_name: null,
      campus_locality: null,
      group_name: college.group_name ?? null,
      verified: college.verified,
      rank: 0,
    }))
}

function localClubs(clubs: db.Club[], term: string): cm.CommunitySummary[] {
  const needle = term.toLowerCase()
  return clubs
    .filter(club =>
      club.name.toLowerCase().includes(needle) ||
      club.description.toLowerCase().includes(needle))
    .slice(0, 6)
    .map(club => ({
      id: club.id,
      slug: club.name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, ''),
      name: club.name,
      description: club.description,
      logo_url: null,
      cover_image_url: null,
      category: '',
      privacy: 'public',
      scope: 'global',
      college_id: null,
      college_name: null,
      college_short_name: null,
      // the legacy club list carries no membership count — the UI hides the
      // number for these rows instead of printing a zero that was never read
      member_count: 0,
      recent_post_at: null,
      my_status: null,
      my_role: null,
      created_at: '',
      created_by: null,
      creator_name: null,
    }))
}

/**
 * Debounced, cancellable multi-entity search. One request set per settled
 * query; every response is dropped unless it belongs to the newest query.
 */
export function useCampusSearch({ query, caps, colleges, clubs, blockedHandles, mutedHandles, limit = 20 }: SearchArgs): CampusSearch {
  const [state, setState] = useState<CampusSearch>(IDLE)
  const term = query.trim()

  useEffect(() => {
    if (term.length < MIN_QUERY) { setState(IDLE); return }
    let cancelled = false
    const safeLimit = Math.min(Math.max(limit, 1), RPC_CEILING)
    setState(current => ({ ...current, loading: true, error: null, searched: false }))

    const timer = window.setTimeout(() => {
      const people = db.searchMembers(term, safeLimit)
      const posts = db.searchPosts(term, safeLimit)
      // search_institutions falls back to the flat directory itself when the
      // 0057 RPC is absent, so this is safe on every project and for visitors
      // (whose shell has no caps probe yet).
      const collegeQuery = db.searchInstitutions(term, caps, 6).catch(() => null)
      // list_clubs is the RLS-respecting community search; a project without it
      // (pre-0016) keeps the shell's own club rows.
      const clubQuery = cm.listCommunities({ query: term, sort: 'relevant', limit: 6 })
        .catch(() => null)

      void Promise.all([people, posts, collegeQuery, clubQuery])
        .then(([memberHits, postHits, collegeHits, clubHits]) => {
          if (cancelled) return
          const visiblePeople = memberHits.filter(person => {
            const handle = person.username ? `@${person.username}` : ''
            return !blockedHandles.includes(handle) && !mutedHandles.includes(handle)
          })
          const rpcColleges = collegeHits ?? []
          const rpcClubs = clubHits ?? []
          setState({
            people: visiblePeople,
            posts: postHits,
            collegeHits: rpcColleges.length > 0 ? rpcColleges : localColleges(colleges, term),
            collegesFromRpc: rpcColleges.length > 0,
            clubs: rpcClubs.length > 0 ? rpcClubs : localClubs(clubs, term),
            clubsFromRpc: rpcClubs.length > 0,
            loading: false,
            error: null,
            searched: true,
          })
        })
        .catch(error => {
          if (cancelled) return
          setState({ ...IDLE, loading: false, searched: true, error: describeError(error) })
        })
    }, 280)

    return () => { cancelled = true; window.clearTimeout(timer) }
    // blocked/muted handles and the fallback directory rows are read at response
    // time on purpose: they are shell-owned arrays whose identity is stable, and
    // keeping them out of the deps means a background refresh can never restart
    // an in-flight search. eslint-disable covers exactly that decision.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [term, caps.institutionSearch, limit])

  return state
}