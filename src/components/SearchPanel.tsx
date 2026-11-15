import { useEffect, useMemo, useRef, useState } from 'react'
import {
  ArrowRight, BadgeCheck, Building2, BookOpen, FileText, Hash, Loader2, Search,
  TrendingUp, UserRound, X,
} from 'lucide-react'
import * as db from '../lib/db'
import type { College, Club } from '../lib/db'
import { useSignedMediaUrl } from '../lib/signedMedia'
import { MIN_QUERY, useCampusSearch } from '../lib/useCampusSearch'
import type { CampusPost } from '../types'

import { initialsFor } from '../lib/db'

/**
 * A member's own photo when they uploaded one, initials otherwise. The avatars
 * bucket is public, so this is a plain read; going through `useSignedMediaUrl`
 * keeps the row correct if a project ever moves avatars behind signing, and the
 * initials fallback means a missing file is never a broken image.
 */
function PersonAvatar({ source, name, username }: {
  source: string | null | undefined
  name: string
  username: string | null | undefined
}) {
  const media = useSignedMediaUrl(source)
  if (!media.ready || !media.url) return <span className="avatar small">{initialsFor(name, username ?? '')}</span>
  return <span className="avatar small"><img src={media.url} alt=""/></span>
}

type Props = {
  /** Loaded directory rows: the offline fallback when 0057 search is absent. */
  colleges: College[]
  clubs: Club[]
  /** 0057 capability probe — enables the ranked directory search below. */
  caps: db.Caps
  blockedHandles: string[]
  mutedHandles: string[]
  /** Pre-filled query (e.g. a hashtag clicked in the right panel); empty = fresh start. */
  initialQuery?: string
  onClose: () => void
  /** Enter / "see all results": hands the query to the Search page. */
  onSubmit: (query: string) => void
  /** Starts (or reuses) a 1:1 chat with the person, then navigates to Chats. */
  onMessagePerson: (profileId: string) => void
  /** Opens the person's profile page (Instagram-style: follow/message live there). */
  onOpenProfile: (profileId: string) => void
  /** Opens a community detail (same destination the Communities page uses). */
  onOpenCommunity: (clubId: string) => void
  /** Opens the post's existing detail surface (canonical card + thread). */
  onOpenPost: (post: CampusPost) => void
  /** Opens an institution's discovery detail (departments, campuses, students). */
  onExploreCollege: (hit: db.InstitutionHit) => void
  onNavigate: (label: string) => void
  /**
   * Desktop presentation: the panel is rendered inside the global header's
   * search slot instead of in the page flow, so the input becomes the header
   * field and the results float underneath it. Everything else — the query
   * state, the debounce, the RPCs, the sections — is unchanged, and a phone
   * still gets the original in-flow panel.
   */
  anchored?: boolean
  /**
   * Hashtags already computed for the right rail ("Trending on Campus"). Used
   * only as the dropdown's starting point while the field is empty, so the
   * desktop search opens on real data instead of a blank card. Desktop only.
   */
  suggested?: [string, number][]
}

const KIND_LABEL: Record<string, string> = {
  post: 'Post',
  confession: 'Confession',
  poll: 'Poll',
  reel: 'Reel',
}

export default function SearchPanel({
  colleges, clubs, caps, blockedHandles, mutedHandles, initialQuery, onClose, onSubmit,
  onOpenProfile, onOpenCommunity, onOpenPost, onExploreCollege, onNavigate, anchored = false, suggested,
}: Props) {
  const [query, setQuery] = useState(initialQuery ?? '')
  const [active, setActive] = useState(-1)
  const rootRef = useRef<HTMLDivElement>(null)
  const inputRef = useRef<HTMLInputElement>(null)

  // The one search engine, shared with the Search & Discovery page: same
  // debounce, same RPCs, same blocked/muted filtering, same degradation copy.
  const search = useCampusSearch({ query, caps, colleges, clubs, blockedHandles, mutedHandles, limit: 10 })
  const { people, posts, collegeHits, collegesFromRpc, clubs: clubHits, clubsFromRpc, loading, error, searched } = search

  const trimmed = query.trim()
  const canSubmit = trimmed.length >= MIN_QUERY

  /* Anchored mode lives in the header, so it needs the two dismissals the
     in-flow panel gets from its own context: Escape and an outside click. */
  useEffect(() => {
    if (!anchored) return
    const onPointerDown = (event: MouseEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) onClose()
    }
    document.addEventListener('mousedown', onPointerDown)
    return () => document.removeEventListener('mousedown', onPointerDown)
  }, [anchored, onClose])

  /* a seed injected later (hashtag click) re-runs the search */
  useEffect(() => {
    if (initialQuery) setQuery(initialQuery)
  }, [initialQuery])

  /* ---- keyboard model (combobox + listbox) ------------------------------ */
  const rowCount = useMemo(() => {
    let total = 0
    if (anchored && !trimmed) total += Math.min(suggested?.length ?? 0, 5)
    total += people.length + clubHits.length + collegeHits.length + posts.length
    return total
  }, [anchored, trimmed, suggested, people, clubHits, collegeHits, posts])

  const rowsRef = useRef<HTMLElement[]>([])
  rowsRef.current = []
  let rowSeq = -1
  /* every option registers itself in render order, so Arrow keys and the
     active-descendant always agree with what is on screen */
  const option = () => {
    const index = ++rowSeq
    const ref = (node: HTMLElement | null) => { if (node) rowsRef.current[index] = node }
    return {
      ref,
      id: `campus-search-opt-${index}`,
      role: 'option' as const,
      'aria-selected': active === index,
      'data-active': active === index ? 'true' : undefined,
      className: `search-row${active === index ? ' is-active' : ''}`,
      onMouseEnter: () => setActive(index),
    }
  }

  const move = (delta: number) => {
    if (rowCount === 0) return
    setActive(current => {
      const next = current + delta
      if (next < 0) return rowCount - 1
      if (next >= rowCount) return 0
      return next
    })
  }

  const activate = (index: number) => {
    const node = rowsRef.current[index]
    if (node instanceof HTMLElement) node.click()
  }

  const submit = () => {
    if (!canSubmit) return
    onSubmit(trimmed)
  }

  const onKeyDown = (event: React.KeyboardEvent<HTMLInputElement>) => {
    if (event.key === 'Escape') { event.stopPropagation(); onClose(); return }
    if (event.key === 'ArrowDown') { event.preventDefault(); move(1); return }
    if (event.key === 'ArrowUp') { event.preventDefault(); move(-1); return }
    if (event.key === 'Home' && rowCount > 0) { event.preventDefault(); setActive(0); return }
    if (event.key === 'End' && rowCount > 0) { event.preventDefault(); setActive(rowCount - 1); return }
    if (event.key === 'Enter') {
      event.preventDefault()
      if (active >= 0 && active < rowCount) activate(active)
      else submit()
    }
  }

  const empty =
    searched && !loading && !error &&
    people.length === 0 && posts.length === 0 && collegeHits.length === 0 && clubHits.length === 0

  const activeId = active >= 0 && active < rowCount ? `campus-search-opt-${active}` : undefined

  return (
    <div className={`search-panel${anchored ? ' is-anchored' : ''}`} ref={rootRef}>
      <div className="search-bar">
        <Search size={18}/>
        <input
          ref={inputRef}
          value={query}
          onChange={event => { setQuery(event.target.value); setActive(-1) }}
          onKeyDown={onKeyDown}
          placeholder="Search people, posts, colleges, clubs…"
          autoFocus
          role="combobox"
          aria-label="Search CAMPUS"
          aria-expanded={true}
          aria-controls="campus-search-results"
          aria-autocomplete="list"
          aria-activedescendant={activeId}
        />
        {canSubmit && (
          <button className="search-submit" onClick={submit} aria-label="See all results">
            <ArrowRight size={17}/>
          </button>
        )}
        <button onClick={onClose} aria-label="Close search"><X size={18}/></button>
      </div>

      {error && <div className="search-error">{error}</div>}
      {loading && <div className="search-hint"><Loader2 size={15} className="search-spin"/>Searching CAMPUS…</div>}

      <div id="campus-search-results" role="listbox" aria-label="Search results">
        {/* Desktop-only starting point: the rail's own trending hashtags, so the
            dropdown is useful before anything is typed. Mobile keeps the panel
            exactly as it was. */}
        {anchored && !trimmed && (suggested?.length ?? 0) > 0 && (
          <section className="search-section">
            <h3>Trending searches</h3>
            {suggested!.slice(0, 5).map(([tag, count]) => (
              <button key={tag} {...option()} onClick={() => setQuery(tag)}>
                <span className="avatar small"><TrendingUp size={14}/></span>
                <span className="search-row-copy">
                  <b>#{tag}</b>
                  <small>{count === 1 ? '1 post' : `${count} posts`} on CAMPUS</small>
                </span>
              </button>
            ))}
          </section>
        )}

        {anchored && !trimmed && (suggested?.length ?? 0) === 0 && (
          <div className="search-hint">Search people, posts, colleges and clubs — results appear as you type.</div>
        )}

        {trimmed.length === 1 && (
          <div className="search-hint">Keep typing — {MIN_QUERY}+ characters runs the search.</div>
        )}

        {empty && (
          <div className="search-hint">
            No matches for “{trimmed}”. Try another spelling — the search covers member names, @usernames, post text, colleges and clubs.
          </div>
        )}

        {people.length > 0 && (
          <section className="search-section">
            <h3>People</h3>
            {people.map(person => (
              <button key={person.id} {...option()} onClick={() => onOpenProfile(person.id)}>
                <PersonAvatar
                  source={person.avatarUrl}
                  name={person.displayName}
                  username={person.username}
                />
                <span className="search-row-copy">
                  <b>{person.displayName}{person.isVerified && <BadgeCheck size={13} className="verified-tick"/>}</b>
                  <small>{person.username ? `@${person.username}` : 'no username yet'}{person.collegeShort ? ` · ${person.collegeShort}` : ''}{person.isPrivate ? ' · private' : ''}</small>
                </span>
              </button>
            ))}
          </section>
        )}

        {clubHits.length > 0 && (
          <section className="search-section">
            <h3>Communities</h3>
            {clubHits.map(club => (
              <button
                key={club.id}
                {...option()}
                onClick={() => {
                  if (club.my_status === 'active' || club.privacy !== 'hidden') onOpenCommunity(club.id)
                  else onNavigate('Communities')
                }}
              >
                <span className="avatar small"><BookOpen size={14}/></span>
                <span className="search-row-copy">
                  <b>{club.name}</b>
                  <small>
                    {club.description || 'Community on CAMPUS'}
                    {clubsFromRpc ? ` · ${club.member_count} member${club.member_count === 1 ? '' : 's'}` : ''}
                  </small>
                </span>
              </button>
            ))}
          </section>
        )}

        {collegeHits.length > 0 && (
          <section className="search-section">
            <h3>Colleges</h3>
            {collegeHits.map(college => (
              <button key={college.id} {...option()} onClick={() => onExploreCollege(college)}>
                <span className="avatar small"><Building2 size={14}/></span>
                <span className="search-row-copy">
                  <b>{college.name}</b>
                  <small>{[college.short_name, college.campus_locality ?? college.locality ?? ''].filter(Boolean).join(' · ')}</small>
                </span>
              </button>
            ))}
          </section>
        )}

        {posts.length > 0 && (
          <section className="search-section">
            <h3>Posts</h3>
            {posts.map((post: CampusPost) => (
              <button key={post.id} {...option()} onClick={() => onOpenPost(post)}>
                <span className="avatar small">{post.anonymous ? <FileText size={13}/> : post.initials || <UserRound size={13}/>}</span>
                <span className="search-row-copy">
                  <b>{post.anonymous ? 'Anonymous confession' : `${post.author}${post.college ? ` · ${post.college}` : ''}`}</b>
                  <small className="search-post-excerpt">{post.body.length > 120 ? `${post.body.slice(0, 120)}…` : post.body}</small>
                  <em>{KIND_LABEL[post.kind] ?? 'Post'} · {post.time}{post.comments > 0 ? ` · ${post.comments} repl${post.comments === 1 ? 'y' : 'ies'}` : ''}</em>
                </span>
              </button>
            ))}
          </section>
        )}
      </div>

      {canSubmit && (
        <button className="search-all" onClick={submit}>
          <span>See all results for “{trimmed}”</span>
          <ArrowRight size={15}/>
        </button>
      )}

      {!anchored && !trimmed && !loading && (
        <p className="search-footnote">
          <Hash size={12}/> Tip: press Enter to open the full results page.
        </p>
      )}
    </div>
  )
}