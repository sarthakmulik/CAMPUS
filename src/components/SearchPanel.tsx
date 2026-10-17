import { useEffect, useState } from 'react'
import { Building2, BadgeCheck, BookOpen, FileText, Loader2, Search, UserRound, X } from 'lucide-react'
import * as db from '../lib/db'
import type { College, Club, PersonResult } from '../lib/db'
import type { CampusPost } from '../types'

import { initialsFor } from '../lib/db'

type Props = {
  /** All loaded colleges/clubs are filtered locally — no extra RPC needed. */
  colleges: College[]
  clubs: Club[]
  blockedHandles: string[]
  mutedHandles: string[]
  /** Pre-filled query (e.g. a hashtag clicked in the right panel); empty = fresh start. */
  initialQuery?: string
  onClose: () => void
  /** Starts (or reuses) a 1:1 chat with the person, then navigates to Chats. */
  onMessagePerson: (profileId: string) => void
  /** Opens the person's profile page (Instagram-style: follow/message live there). */
  onOpenProfile: (profileId: string) => void
  onNavigate: (label: string) => void
}

const KIND_LABEL: Record<string, string> = {
  post: 'Post',
  confession: 'Confession',
  poll: 'Poll',
  reel: 'Reel',
}

export default function SearchPanel({ colleges, clubs, blockedHandles, mutedHandles, initialQuery, onClose, onOpenProfile, onMessagePerson, onNavigate }: Props) {
  const [query, setQuery] = useState(initialQuery ?? '')
  const [people, setPeople] = useState<PersonResult[]>([])
  const [posts, setPosts] = useState<CampusPost[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [searched, setSearched] = useState(false)

  const filteredColleges = colleges.filter(college =>
    query.trim().length >= 2 &&
    (college.name.toLowerCase().includes(query.trim().toLowerCase()) ||
     college.short_name.toLowerCase().includes(query.trim().toLowerCase())),
  ).slice(0, 5)

  const filteredClubs = clubs.filter(club =>
    query.trim().length >= 2 &&
    (club.name.toLowerCase().includes(query.trim().toLowerCase()) ||
     club.description.toLowerCase().includes(query.trim().toLowerCase())),
  ).slice(0, 5)

  useEffect(() => {
    const trimmed = query.trim()
    if (trimmed.length < 2) { setPeople([]); setPosts([]); setSearched(false); setError(null); return }
    let cancelled = false
    const token = setTimeout(() => {
      setLoading(true)
      setError(null)
      void Promise.all([
      db.searchMembers(trimmed, 10),
      db.searchPosts(trimmed, 10),
    ]).then(([memberHits, postHits]) => {
        if (cancelled) return
        setPeople(memberHits.filter(p => {
          const handle = p.username ? `@${p.username}` : ''
          return !blockedHandles.includes(handle) && !mutedHandles.includes(handle)
        }))
        setPosts(postHits)
        setSearched(true)
      }).catch(fetchError => {
        if (cancelled) return
        const raw = String((fetchError as { message?: string } | null)?.message ?? '')
        if (/search_members|search_posts|PGRST202|Could not find the function/i.test(raw)) {
          setError('Search is not connected to the database yet — apply supabase/migrations/0007_search.sql (and 0006_chats.sql for chats) in the Supabase SQL editor.')
        } else {
          setError(db.friendlyMessage(fetchError))
        }
      }).finally(() => {
        if (!cancelled) setLoading(false)
      })
    }, 280)
    return () => { cancelled = true; clearTimeout(token) }
  }, [query])

  /* a seed injected later (hashtag click) re-runs the search */
  useEffect(() => {
    if (initialQuery) setQuery(initialQuery)
  }, [initialQuery])

  const empty =
    searched && !loading && !error &&
    people.length === 0 && posts.length === 0 && filteredColleges.length === 0 && filteredClubs.length === 0

  return (
    <div className="search-panel">
      <div className="search-bar">
        <Search size={18}/>
        <input
          value={query}
          onChange={event => setQuery(event.target.value)}
          placeholder="Search people, posts, colleges, clubs…"
          autoFocus
        />
        <button onClick={onClose} aria-label="Close search"><X size={18}/></button>
      </div>

      {error && <div className="search-error">{error}</div>}
      {loading && <div className="search-hint"><Loader2 size={15} className="search-spin"/>Searching CAMPUS…</div>}
      {empty && (
        <div className="search-hint">
          No matches for “{query.trim()}”. Try another spelling — the search covers member names, @usernames, post text, colleges and clubs.
        </div>
      )}

      {people.length > 0 && (
        <section className="search-section">
          <h3>People</h3>
          {people.map(person => (
            <button key={person.id} className="search-row" onClick={() => onOpenProfile(person.id)}>
              <span className="avatar small">{initialsFor(person.displayName, person.username ?? '')}</span>
              <span className="search-row-copy">
                <b>{person.displayName}{person.isVerified && <BadgeCheck size={13} className="verified-tick"/>}</b>
                <small>{person.username ? `@${person.username}` : 'no username yet'}{person.collegeShort ? ` · ${person.collegeShort}` : ''}{person.isPrivate ? ' · private' : ''}</small>
              </span>
            </button>
          ))}
        </section>
      )}

      {filteredClubs.length > 0 && (
        <section className="search-section">
          <h3>Clubs</h3>
          {filteredClubs.map(club => (
            <button key={club.id} className="search-row" onClick={() => onNavigate('Clubs')}>
              <span className="avatar small"><BookOpen size={14}/></span>
              <span className="search-row-copy"><b>{club.name}</b><small>{club.description || 'Club on CAMPUS'}</small></span>
            </button>
          ))}
        </section>
      )}

      {filteredColleges.length > 0 && (
        <section className="search-section">
          <h3>Colleges</h3>
          {filteredColleges.map(college => (
            <button key={college.id} className="search-row" onClick={() => onNavigate('My College')}>
              <span className="avatar small"><Building2 size={14}/></span>
              <span className="search-row-copy"><b>{college.name}</b><small>{college.short_name}{college.city ? ` · ${college.city}` : ''}</small></span>
            </button>
          ))}
        </section>
      )}

      {posts.length > 0 && (
        <section className="search-section">
          <h3>Posts</h3>
          {posts.map(post => (
            <button key={post.id} className="search-row" onClick={() => onNavigate('Home')}>
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
  )
}

