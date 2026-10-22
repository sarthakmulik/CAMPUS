import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  ArrowDown, ArrowUp, CalendarDays, ChevronDown, ChevronRight, Medal, Sparkles, Trophy, Users,
} from 'lucide-react'
import * as db from '../lib/db'
import type {
  LeaderboardAchievement, LeaderboardCategory, LeaderboardEntry, LeaderboardPeriod,
  LeaderboardRule, MyLeaderboardStanding,
} from '../lib/db'
import { initialsFor, relativeTime } from '../lib/db'

type Identity = { id: string; name: string; username: string; initials: string }

type Props = {
  identity: Identity | null
  configured: boolean
  requireAuth: (reason: string, returnTo?: string) => boolean
  notify: (message: string) => void
  onOpenProfile: (profileId: string) => void
}

const CATEGORIES: { key: LeaderboardCategory; label: string; hint: string }[] = [
  { key: 'overall', label: 'Overall', hint: 'Every scored contribution across CAMPUS.' },
  { key: 'college', label: 'My College', hint: 'Rankings for students of your college.' },
  { key: 'community', label: 'Communities', hint: 'Students shaping community discussions and resources.' },
  { key: 'creators', label: 'Creators', hint: 'Posts and reels that genuinely engage classmates.' },
  { key: 'events', label: 'Events', hint: 'Event organizers and verified attendees.' },
]

const PERIODS: { key: LeaderboardPeriod; label: string }[] = [
  { key: 'week', label: 'This week' },
  { key: 'month', label: 'This month' },
  { key: 'all', label: 'All time' },
]

const PAGE_SIZE = 50

const EMPTY_STANDING: MyLeaderboardStanding = {
  status: 'signed_out', points: 0, competitionRank: null, position: null, totalRanked: 0,
}

function pointsLabel(points: number): string {
  return points === 1 ? '1 pt' : `${points} pts`
}

function movementBadge(entry: LeaderboardEntry, period: LeaderboardPeriod) {
  if (period === 'all') return null
  if (entry.movement === null) {
    return <span className="lb-move new">New</span>
  }
  if (entry.movement < 0) {
    return <span className="lb-move up" title={`Moved up ${-entry.movement} place${-entry.movement === 1 ? '' : 's'}`}><ArrowUp size={12}/> Up</span>
  }
  if (entry.movement > 0) {
    return <span className="lb-move down" title={`Moved down ${entry.movement} place${entry.movement === 1 ? '' : 's'}`}><ArrowDown size={12}/> Down</span>
  }
  return <span className="lb-move same">–</span>
}

/**
 * The Leaderboard (nav label "Leaderboard"): real rankings derived from the
 * trusted points ledger built by migration 0027 —- triggers award points for
 * genuine, visible, non-self activity, and the ranking lives in the database.
 * The browser only renders what the server computed: category tabs, period
 * switches, the top three, the full ranked list, the viewer's own standing,
 * and server-validated milestones.
 */
export default function Leaderboard({ identity, configured, requireAuth, notify, onOpenProfile }: Props) {
  const [category, setCategory] = useState<LeaderboardCategory>('overall')
  const [period, setPeriod] = useState<LeaderboardPeriod>('week')
  const [entries, setEntries] = useState<LeaderboardEntry[]>([])
  const [standing, setStanding] = useState<MyLeaderboardStanding>(EMPTY_STANDING)
  const [achievements, setAchievements] = useState<LeaderboardAchievement[] | null>(null)
  const [rules, setRules] = useState<LeaderboardRule[] | null>(null)
  const [rulesOpen, setRulesOpen] = useState(false)
  const [loading, setLoading] = useState(true)
  const [loadingMore, setLoadingMore] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const requestId = useRef(0)
  const hasMore = useRef(false)

  const load = useCallback(async (replace: boolean, offset: number) => {
    const id = ++requestId.current
    if (replace) setLoading(true)
    else setLoadingMore(true)
    setError(null)
    try {
      const [page, my] = await Promise.allSettled([
        db.fetchLeaderboard(category, period, offset, PAGE_SIZE),
        identity ? db.fetchMyStanding(category, period) : Promise.resolve(EMPTY_STANDING),
      ])
      if (requestId.current !== id) return
      const rows = page.status === 'fulfilled' ? page.value : null
      if (!rows) throw page.status === 'rejected' ? page.reason : new Error('Could not load the leaderboard.')
      setEntries(current => {
        if (replace) return rows
        const seen = new Set(current.map(row => row.userId))
        return [...current, ...rows.filter(row => !seen.has(row.userId))]
      })
      hasMore.current = rows.length >= PAGE_SIZE
      setStanding(my.status === 'fulfilled' ? my.value : EMPTY_STANDING)
    } catch (err) {
      if (requestId.current !== id) return
      if (replace) setEntries([])
      setError(err instanceof Error ? err.message : 'Could not load the leaderboard.')
    } finally {
      if (requestId.current === id) {
        setLoading(false)
        setLoadingMore(false)
      }
    }
  }, [category, period, identity])

  /** initial load + every category / period change */
  useEffect(() => {
    void load(true, 0)
  }, [load])

  /** signed-in extras: milestones + the live scoring rules */
  useEffect(() => {
    if (!configured || !identity) {
      setAchievements(null)
      return
    }
    let cancelled = false
    void db.fetchMyAchievements().then(list => {
      if (!cancelled) setAchievements(list)
    }).catch(() => {
      if (!cancelled) setAchievements(null)
    })
    if (!rules) {
      void db.fetchLeaderboardRules().then(list => {
        if (!cancelled) setRules(list)
      }).catch(() => {
        /* the rules sheet falls back to omitting the weights, never to fake ones */
        if (!cancelled) setRules([])
      })
    }
    return () => { cancelled = true }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [configured, identity?.id])

  const topThree = useMemo(() => entries.slice(0, 3), [entries])
  const rest = useMemo(() => entries.slice(topThree.length), [entries, topThree])
  const nextAchievement = useMemo(
    () => achievements?.find(item => !item.earned) ?? null,
    [achievements],
  )
  const myEntryOnPage = useMemo(
    () => (identity ? entries.find(row => row.userId === identity.id) ?? null : null),
    [entries, identity],
  )

  const openProfile = (userId: string) => {
    if (!identity) { requireAuth('see who is on the board', 'Leaderboard'); return }
    onOpenProfile(userId)
  }

  if (!configured) {
    return (
      <div className="lb-page">
        <header className="lb-head"><h1 className="page-title">Leaderboard</h1></header>
        <div className="lb-state"><Trophy size={30} /><b>CAMPUS is not connected</b><span>The leaderboard is offline right now.</span></div>
      </div>
    )
  }

  const categoryMeta = CATEGORIES.find(item => item.key === category) ?? CATEGORIES[0]
  const collegeSelected = standing.status !== 'no_college'

  return (
    <div className="lb-page">
      <header className="lb-head">
        <h1 className="page-title">Leaderboard</h1>
        <p className="lb-sub">Students who bring campus to life. Scores come from real contribution — posting, helping, organizing and showing up.</p>
      </header>

      {/* category + period controls: one row, horizontally scrollable */}
      <div className="lb-controls">
        <nav className="community-tabs lb-tabs" data-no-page-swipe="true" aria-label="Leaderboard categories">
          {CATEGORIES.map(item => (
            <button
              key={item.key}
              className={`community-tab ${category === item.key ? 'on' : ''}`}
              onClick={() => setCategory(item.key)}
            >
              {item.key === 'events' ? <CalendarDays size={14}/> : item.key === 'community' ? <Users size={14}/> : item.key === 'creators' ? <Sparkles size={14}/> : <Trophy size={14}/>}
              {item.label}
            </button>
          ))}
        </nav>
        <div className="lb-periods" role="group" aria-label="Time period">
          {PERIODS.map(item => (
            <button
              key={item.key}
              className={period === item.key ? 'active' : ''}
              onClick={() => setPeriod(item.key)}
            >
              {item.label}
            </button>
          ))}
        </div>
      </div>

      {/* the viewer's own standing — always retrievable, even outside the
          loaded page: leaderboard_me ranks them against the same server
          aggregate instead of trusting an on-screen position */}
      <section className="lb-mine" aria-label="Your standing">
        {identity ? (
          standing.status === 'no_college' ? (
            <div className="lb-mine-card">
              <div className="lb-mine-avatar">{identity.initials}</div>
              <div className="lb-mine-body">
                <b>Your college rank is unavailable</b>
                <span>Pick your college in your profile to appear on the “My College” board.</span>
              </div>
              <button className="lb-mine-side" onClick={() => onOpenProfile(identity.id)}>Set it up<ChevronRight size={14}/></button>
            </div>
          ) : standing.status === 'signed_out' ? (
            <div className="lb-mine-card">
              <div className="lb-mine-avatar">{identity.initials}</div>
              <div className="lb-mine-body">
                <b>Your standing is not loaded</b>
                <span>Sign out and back in to refresh your session.</span>
              </div>
            </div>
          ) : standing.position === null ? (
            <div className="lb-mine-card unranked">
              <div className="lb-mine-avatar">{identity.initials}</div>
              <div className="lb-mine-body">
                <b>Not on this board yet — 0 pts</b>
                <span>{categoryMeta.hint} Contribute this {period === 'week' ? 'week' : period === 'month' ? 'month' : ''} to appear here.</span>
              </div>
              {nextAchievement ? (
                <div className="lb-mine-progress" title={nextAchievement.description}>
                  <span>{nextAchievement.label} · {nextAchievement.progress}/{nextAchievement.target}</span>
                  <progress max={nextAchievement.target} value={nextAchievement.progress} />
                </div>
              ) : null}
            </div>
          ) : (
            <div className="lb-mine-card">
              <div className="lb-mine-avatar">{identity.initials}</div>
              <div className="lb-mine-body">
                <b>Your rank · #{standing.competitionRank === standing.position ? standing.position : `${standing.position}`} <span>of {standing.totalRanked}</span></b>
                <span>{identity.name} · {pointsLabel(standing.points)} in {PERIODS.find(p => p.key === period)?.label.toLowerCase()}</span>
              </div>
              {nextAchievement ? (
                <div className="lb-mine-progress" title={nextAchievement.description}>
                  <span>{nextAchievement.label} · {nextAchievement.progress}/{nextAchievement.target}</span>
                  <progress max={nextAchievement.target} value={nextAchievement.progress} />
                </div>
              ) : null}
            </div>
          )
        ) : (
          <div className="lb-mine-card unranked">
            <div className="lb-mine-body">
              <b>Track your own rank</b>
              <span>Sign in to see where you stand and earn your place here.</span>
            </div>
            <button className="lb-mine-side" onClick={() => { requireAuth('see your rank', 'Leaderboard'); notify('Sign in to join the leaderboard.') }}>Sign in<ChevronRight size={14}/></button>
          </div>
        )}
      </section>

      {loading ? (
        <div className="lb-list" aria-busy="true">
          {[0, 1, 2, 3].map(index => (
            <div className="lb-row skeleton-row" key={index}>
              <span className="lb-rank-skel skeleton-block" />
              <span className="lb-avatar-skel skeleton-block" />
              <span className="lb-line-skel skeleton-block" />
              <span className="lb-pts-skel skeleton-block" />
            </div>
          ))}
        </div>
      ) : error ? (
        <div className="lb-state" role="alert">
          <Trophy size={30}/><b>Could not load the leaderboard</b><span>{error}</span>
          <button className="lb-retry" onClick={() => void load(true, 0)}>Try again</button>
        </div>
      ) : entries.length === 0 ? (
        <div className="lb-state">
          <Trophy size={30}/>
          <b>{category === 'college' && !collegeSelected ? 'No college board yet' : 'No ranked students yet'}</b>
          <span>
            {category === 'college' && !collegeSelected
              ? 'Pick your college in your profile to see who leads there.'
              : `${categoryMeta.hint} ${period === 'week' ? 'Nobody has earned points this week yet.' : period === 'month' ? 'Nobody has earned points this month yet.' : 'Nobody has earned points yet.'}`}
          </span>
        </div>
      ) : (
        <>
          {/* compact top three — no giant podium, the list stays near */}
          {topThree.length > 0 && (
            <section className="lb-podium" aria-label="Top three">
              {topThree.map(entry => {
                const place = topThree.indexOf(entry) + 1
                return (
                  <button
                    key={entry.userId}
                    className={`lb-pod place-${place}`}
                    onClick={() => openProfile(entry.userId)}
                    aria-label={`Rank ${entry.competitionRank} · ${entry.displayName} · ${pointsLabel(entry.points)}`}
                  >
                    <span className="lb-pod-rank">#{entry.competitionRank}</span>
                    <span className="lb-pod-avatar">
                      {entry.avatarUrl
                        ? <img src={entry.avatarUrl} alt="" />
                        : <span>{initialsFor(entry.displayName, entry.username ?? undefined)}</span>}
                      {place === 1 && <i className="lb-pod-mark"><Medal size={11}/></i>}
                    </span>
                    <b className="lb-pod-name">{entry.displayName}</b>
                    <span className="lb-pod-pts">{pointsLabel(entry.points)}</span>
                  </button>
                )
              })}
            </section>
          )}

          <ol className="lb-list" start={topThree.length + 1}>
            {rest.map(entry => (
              <li key={entry.userId}>
                <button className="lb-row" onClick={() => openProfile(entry.userId)}>
                  <span className="lb-rank">{entry.position}</span>
                  <span className="lb-avatar">
                    {entry.avatarUrl
                      ? <img src={entry.avatarUrl} alt="" />
                      : <span>{initialsFor(entry.displayName, entry.username ?? undefined)}</span>}
                  </span>
                  <span className="lb-who">
                    <b>{entry.displayName}{entry.isVerified ? <i className="lb-verified" title="Verified student">✓</i> : null}</b>
                    <small>
                      {entry.username ? `@${entry.username}` : 'campus student'}
                      {entry.collegeShortName ? ` · ${entry.collegeShortName}` : ''}
                      {category === 'events' && entry.lastEarnedAt ? ` · last earned ${relativeTime(entry.lastEarnedAt)}` : ''}
                    </small>
                  </span>
                  <span className="lb-side">
                    {movementBadge(entry, period)}
                    <b className="lb-pts">{pointsLabel(entry.points)}</b>
                  </span>
                </button>
              </li>
            ))}
          </ol>

          {hasMore.current ? (
            <button className="lb-more" disabled={loadingMore} onClick={() => void load(false, entries.length)}>
              {loadingMore ? 'Loading…' : 'Show more of the board'}
            </button>
          ) : entries.length > 6 ? (
            <p className="lb-end">That's the whole board {period === 'week' ? 'this week' : period === 'month' ? 'this month' : '— for now'}.</p>
          ) : null}
        </>
      )}

      {/* milestones + the auditable scoring model */}
      <section className="lb-milestones" aria-label="Your milestones">
        <h2><Sparkles size={15}/> Your milestones</h2>
        {identity ? (
          achievements ? (
            achievements.length === 0 ? (
              <p className="lb-milestones-empty">No milestones yet — your first contribution earns “First Contribution”.</p>
            ) : (
              <div className="lb-achieve-row" data-no-page-swipe="true">
                {achievements.map(item => (
                  <div key={item.key} className={`lb-achieve ${item.earned ? 'earned' : ''}`} title={item.description}>
                    <b><Medal size={12}/>{item.label}</b>
                    <span>{item.earned ? 'Earned' : `${item.progress}/${item.target}`}</span>
                    {!item.earned && <progress max={item.target} value={item.progress} />}
                  </div>
                ))}
              </div>
            )
          ) : (
            <p className="lb-milestones-empty">Checking your milestones…</p>
          )
        ) : (
          <p className="lb-milestones-empty">Sign in to earn milestones — everything is awarded from real activity.</p>
        )}

        <button className="lb-rules-toggle" onClick={() => setRulesOpen(value => !value)} aria-expanded={rulesOpen}>
          How points work<ChevronDown size={14} className={rulesOpen ? 'open' : ''}/>
        </button>
        {rulesOpen ? (
          <div className="lb-rules">
            {rules === null ? (
              <p>Loading the current rules…</p>
            ) : rules.filter(rule => rule.enabled && rule.points > 0).length ? (
              <>
                {rules.filter(rule => rule.enabled && rule.points > 0).map(rule => (
                  <div className="lb-rule" key={rule.activityType}>
                    <span>{rule.label}</span>
                    <b>+{rule.points} pt{rule.points === 1 ? '' : 's'}{rule.dailyCap ? ` · up to ${rule.dailyCap}/day` : ''}</b>
                  </div>
                ))}
                <p className="lb-rules-note">
                  Scores come from a server-side ledger of real activity: self-reactions never count,
                  anonymous confessions earn nothing, private community content stays off the board,
                  and deleting an activity returns its points. Daily caps keep volume farming out.
                </p>
              </>
            ) : (
              <p className="lb-rules-note">The scoring rules could not be loaded right now — scores still run server-side.</p>
            )}
          </div>
        ) : null}
      </section>
    </div>
  )
}
