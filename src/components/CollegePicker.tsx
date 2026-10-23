import { useCallback, useEffect, useRef, useState } from 'react'
import { Search, X } from 'lucide-react'
import type { AdCollegeChip, AdCollegeHit } from '../lib/ads'
import { searchAdColleges } from '../lib/ads'

/**
 * Searchable, server-paginated college selector for campaign targeting.
 * Never loads the whole directory: typing queries `search_colleges_for_ads`
 * (name / short_name / city / state / domain) and pages through results.
 * The parent owns the selection array; an EMPTY selection is invalid and the
 * server-side targeting RPC refuses it — empty must never mean "everyone".
 */
export function CollegePicker({
  selected,
  onChange,
  flash,
}: {
  selected: AdCollegeChip[]
  onChange: (next: AdCollegeChip[]) => void
  flash?: (message: string) => void
}) {
  const [query, setQuery] = useState('')
  const [hits, setHits] = useState<AdCollegeHit[]>([])
  const [offset, setOffset] = useState(0)
  const [hasMore, setHasMore] = useState(false)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const PAGE = 24
  const debounceRef = useRef<number | null>(null)
  const runIdRef = useRef(0)

  const runSearch = useCallback(async (q: string, from: number, append: boolean) => {
    const runId = ++runIdRef.current
    setLoading(true)
    setError(null)
    try {
      const rows = await searchAdColleges(q, PAGE, from)
      if (runId !== runIdRef.current) return
      setHits(prev => (append ? [...prev.filter(prevRow => !rows.some(row => row.id === prevRow.id)), ...rows] : rows))
      setOffset(from + rows.length)
      setHasMore(rows.length === PAGE)
    } catch (err) {
      if (runId !== runIdRef.current) return
      setHits([])
      setHasMore(false)
      setError(err instanceof Error ? err.message : 'Could not search colleges.')
    } finally {
      if (runId === runIdRef.current) setLoading(false)
    }
  }, [])

  useEffect(() => {
    if (debounceRef.current) window.clearTimeout(debounceRef.current)
    debounceRef.current = window.setTimeout(() => void runSearch(query, 0, false), 320)
    return () => { if (debounceRef.current) window.clearTimeout(debounceRef.current) }
  }, [query, runSearch])

  const pick = (hit: AdCollegeHit) => {
    if (selected.some(row => row.id === hit.id)) return
    onChange([...selected, { id: hit.id, name: hit.name, short_name: hit.short_name, city: hit.city, state: hit.state }])
  }

  const remove = (id: string) => onChange(selected.filter(row => row.id !== id))

  const addAllVisible = () => {
    const additions = hits
      .filter(hit => !selected.some(row => row.id === hit.id))
      .map(hit => ({ id: hit.id, name: hit.name, short_name: hit.short_name, city: hit.city, state: hit.state }))
    if (additions.length === 0) return
    onChange([...selected, ...additions])
  }

  return (
    <div className="college-picker">
      {!!selected.length && (
        <div className="college-picker-selected" aria-label={`Selected colleges: ${selected.length}`}>
          <span className="college-picker-count">{selected.length} selected</span>
          <div className="college-chips">
            {selected.map(chip => (
              <button key={chip.id} className="college-chip" onClick={() => remove(chip.id)} aria-label={`Remove ${chip.name}`}>
                {chip.short_name || chip.name}
                <X size={13} aria-hidden="true"/>
              </button>
            ))}
          </div>
          <button className="college-picker-clear" onClick={() => onChange([])}>Clear all</button>
        </div>
      )}

      <label className="college-picker-search">
        <Search size={16} aria-hidden="true"/>
        <input
          type="search"
          value={query}
          onChange={event => setQuery(event.target.value)}
          placeholder="Search colleges by name, city, state or domain…"
          autoComplete="off"
        />
      </label>

      {error && <p className="college-picker-error" role="alert">{error}</p>}
      {loading && <p className="college-picker-status" role="status">Searching colleges…</p>}
      {!loading && !error && hits.length === 0 && (
        <p className="college-picker-status">No colleges match “{query.trim()}”. Try a shorter search.</p>
      )}

      {!loading && hits.length > 0 && (
        <>
          <div className="college-picker-toolbar">
            <button className="college-picker-select-all" onClick={addAllVisible}>
              Add all {hits.length} shown
            </button>
          </div>
          <ul className="college-picker-list">
            {hits.map(hit => {
              const picked = selected.some(row => row.id === hit.id)
              return (
                <li key={hit.id}>
                  <button
                    className={`college-row${picked ? ' picked' : ''}`}
                    onClick={() => (picked ? remove(hit.id) : pick(hit))}
                    aria-pressed={picked}
                  >
                    <span className="college-row-main">
                      <b>{hit.name}</b>
                      <span>{[hit.short_name, hit.city, hit.state].filter(Boolean).join(' · ')}</span>
                    </span>
                    <span className="college-row-meta">
                      {hit.verified && <i className="college-verified">✓</i>}
                      <i className="college-members">{hit.member_count} student{hit.member_count === 1 ? '' : 's'}</i>
                      {picked && <i className="college-picked-tick">✓</i>}
                    </span>
                  </button>
                </li>
              )
            })}
          </ul>
          {hasMore && (
            <button className="college-picker-more" disabled={loading} onClick={() => void runSearch(query, offset, true)}>
              {loading ? 'Loading…' : 'Load more colleges'}
            </button>
          )}
        </>
      )}
    </div>
  )
}

export default CollegePicker
