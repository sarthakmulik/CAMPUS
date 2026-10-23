import { useCallback, useEffect, useRef, useState } from 'react'
import {
  AtSign, Bell, CalendarDays, Check, Heart, Loader2, MessageCircle, MessageSquareText,
  Repeat2, Settings2, ShieldCheck, Store, Tag, UserPlus, Users, X,
} from 'lucide-react'
import * as db from '../lib/db'
import type { NotificationFilter, NotificationItem } from '../lib/db'
import { initialsFor, relativeTime } from '../lib/db'
import NotificationSettings from './NotificationSettings'
import {
  currentPermission, dismissPushPrompt, pushConfigured, pushPromptDismissed,
} from '../lib/webPush'

type Identity = { id: string; name: string; username: string; initials: string }

type Props = {
  identity: Identity
  configured: boolean
  notify: (message: string) => void
  collegeId?: string | null
  /** bumps when the shell's realtime bell sees activity — the center re-reads */
  liveTick: number
  /** after mark-read actions the shell re-reads its own unread badge count */
  onCountsChanged: () => void
  onOpenChat: (conversationId: string) => void
  onOpenProfile: (profileId: string) => void
}

const FILTERS: { key: NotificationFilter; label: string }[] = [
  { key: 'all', label: 'All' },
  { key: 'unread', label: 'Unread' },
  { key: 'follow', label: 'Following' },
  { key: 'mention', label: 'Mentions' },
  { key: 'message', label: 'Messages' },
  { key: 'community', label: 'Communities' },
  { key: 'event', label: 'Events' },
]

const PAGE_SIZE = 30

type DisplayRow = {
  key: string
  /** ids of every collapsed notification row (group members) */
  ids: string[]
  /** newest source item drives destination + text */
  head: NotificationItem
  unread: boolean
  createdAt: string
  actors: db.NotificationActor[]
  extraCount: number
  title: string
  detail: string | null
  thumb: string | null
}

type Destination = {
  action: 'post' | 'chat' | 'community' | 'event' | 'listing' | 'profile' | 'none'
  param: string | null
  flow: boolean
}

/** Where a notification navigates — same deep links the share system uses. */
function destination(item: NotificationItem): Destination {
  const postId = (item.metadata.post_id as string) ?? item.entityId
  switch (item.type) {
    case 'post_like': case 'post_repost': case 'post_comment':
    case 'post_reply': case 'post_mention': case 'comment_like':
      return { action: 'post', param: postId ?? null, flow: false }
    case 'follow': {
      const profileId = item.actor?.id
      return { action: 'profile', param: profileId ?? null, flow: false }
    }
    case 'chat_message': case 'chat_mention': case 'chat_reply':
      return { action: 'chat', param: item.entityId ?? null, flow: false }
    case 'club_join_accepted': case 'club_join_rejected': case 'club_invitation':
    case 'club_role_changed': case 'club_banned': case 'club_removed': case 'club_ownership':
      return { action: 'community', param: item.slug ?? null, flow: false }
    case 'event_updated': case 'event_cancelled': case 'event_registered': case 'event_promoted':
      return { action: 'event', param: item.slug ?? null, flow: false }
    case 'listing_removed': case 'listing_restored':
      return { action: 'listing', param: item.slug ?? null, flow: false }
    default:
      return { action: 'none', param: null, flow: false }
  }
}

/** Copy per type — real actors + real entity names, never raw ids. */
function rowText(
  item: NotificationItem,
  actors: db.NotificationActor[],
  count: number,
  entityTitle: string | null,
): { title: string; detail: string | null } {
  const lead = actors[0]?.name || actors[0]?.username || 'Someone'
  const grouped = count > 1
  const kind = item.metadata.kind === 'reel' ? 'reel' : 'post'
  const who = grouped && count > actors.length ? `${lead} and others` : lead
  switch (item.type) {
    case 'follow':
      return { title: `${lead} started following you`, detail: null }
    case 'post_like':
      return { title: `${who} liked your ${kind}`, detail: null }
    case 'comment_like':
      return { title: `${who} liked your comment`, detail: null }
    case 'post_repost':
      return { title: `${who} reposted your ${kind}`, detail: null }
    case 'post_comment':
      return { title: `${who} commented on your ${kind}`, detail: null }
    case 'post_reply':
      return { title: `${lead} replied to your comment`, detail: null }
    case 'post_mention':
      return { title: `${lead} mentioned you in a ${kind}`, detail: null }
    case 'chat_mention':
      return { title: `${lead} mentioned you in a community chat`, detail: null }
    case 'chat_reply':
      return { title: `${lead} replied to your message in a community chat`, detail: null }
    case 'chat_message':
      return {
        title: count > 1 ? `${count} messages from ${lead === 'Someone' ? actors[0]?.username ?? 'a friend' : lead}` : `New message from ${lead}`,
        detail: null,
      }
    case 'club_join_accepted':
      return { title: 'Join request accepted', detail: entityTitle ? `You're now part of ${entityTitle}` : null }
    case 'club_join_rejected':
      return { title: 'Join request declined', detail: entityTitle ? `${entityTitle} couldn't seat you this time` : null }
    case 'club_invitation':
      return { title: `${lead} invited you to join`, detail: entityTitle ?? null }
    case 'club_role_changed':
      return { title: `Your role changed in ${entityTitle ?? 'a community'}`, detail: null }
    case 'club_banned':
    case 'club_removed':
      return { title: `Removed from ${entityTitle ?? 'a community'}`, detail: 'You no longer have access there.' }
    case 'club_ownership':
      return { title: `${entityTitle ?? 'A community'} changed ownership`, detail: null }
    case 'event_registered':
      return { title: 'RSVP confirmed', detail: entityTitle ? `Your spot for ${entityTitle} is set` : null }
    case 'event_updated':
      return { title: `${lead} updated an event you joined`, detail: entityTitle ?? null }
    case 'event_cancelled':
      return { title: `${entityTitle ?? 'An event you joined'} was cancelled`, detail: null }
    case 'event_promoted':
      return { title: 'You now host an event', detail: entityTitle ?? null }
    case 'listing_removed':
      return { title: 'Your listing was removed', detail: entityTitle ?? null }
    case 'listing_restored':
      return { title: 'Your listing is live again', detail: entityTitle ?? null }
    default:
      return { title: 'Important update about your account', detail: entityTitle ?? null }
  }
}

/** Engagement collapses per post; chat messages collapse per conversation. */
function groupKey(item: NotificationItem): string | null {
  if (item.type === 'chat_message') return `chat:${item.entityId ?? ''}`
  if (['post_like', 'post_repost', 'comment_like', 'post_comment'].includes(item.type)) {
    return `${item.type}:${item.metadata.post_id ?? item.entityId ?? ''}`
  }
  return null
}

function typeIcon(type: string) {
  switch (type) {
    case 'follow': return <UserPlus size={18}/>
    case 'chat_message': case 'chat_reply': return <MessageCircle size={18}/>
    case 'chat_mention': case 'post_mention': return <AtSign size={18}/>
    case 'post_like': case 'comment_like': return <Heart size={18}/>
    case 'post_repost': return <Repeat2 size={18}/>
    case 'post_comment': case 'post_reply': return <MessageSquareText size={18}/>
    case 'club_invitation': case 'club_role_changed': case 'club_ownership': return <Users size={18}/>
    case 'club_banned': case 'club_removed': case 'listing_removed': return <ShieldCheck size={18}/>
    case 'club_join_accepted': case 'event_registered': case 'event_updated':
    case 'event_cancelled': case 'event_promoted': return <CalendarDays size={18}/>
    case 'listing_restored': return <Store size={18}/>
    default: return <Tag size={18}/>
  }
}

type Suggestion = {
  id: string
  username: string | null
  name: string | null
  reason: string
  isFollowing: boolean
  busy: boolean
}

/**
 * The notification center (the bell's destination). One server-paged,
 * RLS-safe read; filter tabs re-query; engagement rows collapse per post
 * and chat rows per conversation; a tap marks its group read and navigates.
 * "Suggested for you" below is a RECOMMENDATION block — plain profile data,
 * never notification records.
 */
export default function NotificationCenter({
  identity, configured, notify, collegeId, liveTick, onCountsChanged, onOpenChat, onOpenProfile,
}: Props) {
  const [filter, setFilter] = useState<NotificationFilter>('all')
  const [rows, setRows] = useState<DisplayRow[]>([])
  const [loading, setLoading] = useState(true)
  const [loadingMore, setLoadingMore] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [everLoaded, setEverLoaded] = useState(false)
  const [more, setMore] = useState(false)
  const [sheetOpen, setSheetOpen] = useState(false)
  const [busyAll, setBusyAll] = useState(false)
  const [promptOpen, setPromptOpen] = useState(false)
  const [suggestions, setSuggestions] = useState<Suggestion[]>([])
  const [suggLoading, setSuggLoading] = useState(false)

  /** cumulative raw items for the CURRENT query — grouping stays honest
      across pages, and mark-read flips stay locked in during appends */
  const itemsRef = useRef<NotificationItem[]>([])
  const requestId = useRef(0)

  const decorate = useCallback((items: NotificationItem[]): DisplayRow[] => {
    const out: DisplayRow[] = []
    const index = new Map<string, DisplayRow>()
    for (const item of items) {
      const key = groupKey(item)
      if (key && index.has(key)) {
        const row = index.get(key)!
        if (!row.ids.includes(item.id)) {
          row.ids.push(item.id)
          row.unread = row.unread || item.readAt == null
          if (item.createdAt > row.createdAt) { row.createdAt = item.createdAt; row.head = item }
        }
        continue
      }
      const row: DisplayRow = {
        key: item.id,
        ids: [item.id],
        head: item,
        unread: item.readAt == null,
        createdAt: item.createdAt,
        actors: item.actor ? [item.actor] : [],
        extraCount: 0,
        title: '',
        detail: null,
        thumb: null,
      }
      out.push(row)
      if (key) index.set(key, row)
    }
    return out.map(row => {
      const text = rowText(row.head, row.actors, row.ids.length, row.head.title ?? null)
      const extraCount = Math.max(0, row.ids.length - Math.max(row.actors.length, 1))
      const thumb = (row.head.metadata.thumb as string | null) ?? null
      return { ...row, extraCount, title: text.title, detail: text.detail, thumb }
    })
  }, [])

  const fetchPage = useCallback((replace: boolean, offset: number) => {
    if (!configured) { setLoading(false); return }
    const id = ++requestId.current
    if (replace) { setLoading(true); itemsRef.current = [] } else setLoadingMore(true)
    setError(null)
    db.fetchNotifications(filter, PAGE_SIZE, offset)
      .then(fetched => {
        if (requestId.current !== id) return
        const seen = new Set(itemsRef.current.map(item => item.id))
        const keep = replace ? [] : [...itemsRef.current]
        for (const item of fetched) {
          if (!seen.has(item.id)) { seen.add(item.id); keep.push(item) }
        }
        itemsRef.current = keep
        setRows(decorate(keep))
        setEverLoaded(true)
        setMore(fetched.length === PAGE_SIZE)
      })
      .catch(err => {
        if (requestId.current !== id) return
        setError(err instanceof Error ? err.message : 'Could not load notifications.')
        if (replace) { setRows([]); itemsRef.current = [] }
      })
      .finally(() => {
        if (requestId.current === id) { setLoading(false); setLoadingMore(false) }
      })
  }, [filter, configured, decorate])

  useEffect(() => {
    setRows([]); setEverLoaded(false); setMore(false); itemsRef.current = []
    fetchPage(true, 0)
  }, [filter, configured, identity.id, fetchPage])

  /** live activity while the center is open: silent re-read of page one */
  const lastTick = useRef(liveTick)
  useEffect(() => {
    if (liveTick !== lastTick.current) {
      lastTick.current = liveTick
      fetchPage(true, 0)
    }
  }, [liveTick, fetchPage])

  /** one-time push prompt decision (never on load, only on first center visit) */
  useEffect(() => {
    if (!configured) return
    const dismissed = pushPromptDismissed()
    setPromptOpen(!dismissed && pushConfigured() && currentPermission() === 'default')
  }, [configured, identity.id])

  const applyRead = (ids: string[]) => {
    setRows(current => current.map(row => (
      ids.some(id => row.ids.includes(id)) ? { ...row, unread: false } : row
    )))
    void db.markNotificationsRead(ids).then(() => onCountsChanged())
      .catch(err => notify(err instanceof Error ? err.message : 'Could not sync read state.'))
  }

  const runAction = (destination: Destination) => {
    if (!destination.param) {
      if (destination.action === 'none') notify('This notification no longer points anywhere.')
      return
    }
    switch (destination.action) {
      case 'post': window.location.hash = `#p/${destination.param}`; break
      case 'chat': onOpenChat(destination.param); break
      case 'community': window.location.hash = `#c/${destination.param}`; break
      case 'event': window.location.hash = `#e/${destination.param}`; break
      case 'listing': window.location.hash = `#m/${destination.param}`; break
      case 'profile': onOpenProfile(destination.param); break
      default: notify('This notification no longer points anywhere.')
    }
  }

  const openRow = (row: DisplayRow) => {
    if (row.unread) applyRead(row.ids)
    runAction(destination(row.head))
  }

  const markAll = async () => {
    setBusyAll(true)
    try {
      await db.markAllNotificationsRead(filter)
      setRows(current => current.map(row => ({ ...row, unread: false })))
      onCountsChanged()
    } catch (err) {
      notify(err instanceof Error ? err.message : 'Could not mark everything read.')
    } finally {
      setBusyAll(false)
    }
  }

  /** follow suggestions: real profiles, real reasons, nothing persisted */
  const loadSuggestions = useCallback(() => {
    if (!configured || !identity.id) return
    setSuggLoading(true)
    db.fetchFollowSuggestions(identity.id, collegeId ?? null, 5)
      .then(async base => {
        if (base.length === 0) { setSuggestions([]); return
        }
        const ids = base.map(person => person.id)
        const client = db.getSupabaseClient()
        if (!client) { setSuggestions([]); return
        }
        const [following, memberships, candidateFollowers] = await Promise.all([
          client.from('follows').select('followed_id').eq('follower_id', identity.id).in('followed_id', ids),
          client.from('club_members').select('user_id, club_id').in('user_id', [identity.id, ...ids]),
          client.from('follows').select('follower_id, followed_id').in('followed_id', ids),
        ])
        if (following.error || memberships.error || candidateFollowers.error) throw following.error ?? memberships.error ?? candidateFollowers.error
        const followingIds = new Set((following.data ?? []).map(row => String(row.followed_id)))
        const clubsOf = new Map<string, Set<string>>()
        for (const row of (memberships.data ?? []) as { user_id: string; club_id: string }[]) {
          const set = clubsOf.get(String(row.user_id)) ?? new Set<string>()
          set.add(String(row.club_id))
          clubsOf.set(String(row.user_id), set)
        }
        const myClubs = clubsOf.get(identity.id) ?? new Set<string>()
        const followerCount = new Map<string, number>()
        for (const row of (candidateFollowers.data ?? []) as { follower_id: string; followed_id: string }[]) {
          followerCount.set(String(row.followed_id), (followerCount.get(String(row.followed_id)) ?? 0) + 1)
        }
        setSuggestions(base.map(person => {
          const shared = [...myClubs].filter(club => (clubsOf.get(person.id) ?? new Set()).has(club)).length
          const followers = followerCount.get(person.id) ?? 0
          return {
            id: person.id,
            username: person.username,
            name: person.name,
            reason: shared > 0
              ? `${shared} shared ${shared === 1 ? 'community' : 'communities'}`
              : followers >= 10
                ? 'Active on campus'
                : 'From your college',
            isFollowing: followingIds.has(person.id),
            busy: false,
          }
        }))
      })
      .catch(() => setSuggestions([]))
      .finally(() => setSuggLoading(false))
  }, [configured, identity])

  useEffect(() => { loadSuggestions() }, [loadSuggestions])

  const followSuggestion = (person: Suggestion) => {
    const target = !person.isFollowing
    setSuggestions(current => current.map(s => s.id === person.id ? { ...s, isFollowing: target, busy: true } : s))
    const run = target
      ? db.followUser(identity.id, person.id)
      : db.unfollowUser(person.id)
    void run
      .catch(err => {
        setSuggestions(current => current.map(s => s.id === person.id ? { ...s, isFollowing: person.isFollowing, busy: false } : s))
        notify(err instanceof Error ? err.message : 'Could not update that follow.')
      })
      .finally(() => setSuggestions(current => current.map(s => s.id === person.id ? { ...s, busy: false } : s)))
  }

  if (!configured) {
    return (
      <div className="nc-page">
        <header className="nc-head"><h1 className="page-title">Notifications</h1></header>
        <div className="nc-state"><Bell size={30}/><b>Notifications are offline</b><span>CAMPUS is not connected to the server right now.</span></div>
      </div>
    )
  }

  const unreadShown = rows.filter(row => row.unread).length
  const nothingMatched = !loading && !error && rows.length === 0

  return (
    <div className="nc-page">
      <header className="nc-head" data-no-page-swipe="true">
        <div className="nc-head-title">
          <h1 className="page-title">Notifications</h1>
          <span className="nc-unread-chip" data-on={rows.some(row => row.unread)}>
            {unreadShown > 0 ? `${unreadShown} new` : 'All caught up'}
          </span>
        </div>
        <div className="nc-head-actions">
          <button className="secondary-button nc-mark-all" disabled={busyAll} onClick={() => void markAll()}>
            <Check size={15}/> {busyAll ? 'Marking…' : 'Mark all read'}
          </button>
          <button className="icon-button" onClick={() => setSheetOpen(true)} aria-label="Notification settings">
            <Settings2 size={19}/>
          </button>
        </div>
      </header>

      {promptOpen && (
        <div className="nc-push-prompt" role="status">
          <div className="nc-push-prompt-copy">
            <b>Get push notifications?</b>
            <span>Messages, mentions and event reminders even with CAMPUS closed — you pick the categories.</span>
          </div>
          <div className="nc-push-prompt-actions">
            <button className="linklike" onClick={() => { dismissPushPrompt(); setPromptOpen(false) }}>Not now</button>
            <button className="primary-button" onClick={() => { dismissPushPrompt(); setPromptOpen(false); setSheetOpen(true) }}>Enable</button>
          </div>
          <button className="icon-button nc-prompt-close" aria-label="Dismiss push prompt" onClick={() => { dismissPushPrompt(); setPromptOpen(false) }}><X size={15}/></button>
        </div>
      )}

      <nav className="community-tabs nc-tabs" data-no-page-swipe="true" aria-label="Notification filters">
        {FILTERS.map(tab => (
          <button
            key={tab.key}
            className={filter === tab.key ? 'on' : ''}
            onClick={() => setFilter(tab.key)}
            aria-current={filter === tab.key ? 'true' : undefined}
          >
            {tab.label}
          </button>
        ))}
      </nav>

      {loading && (
        <div className="nc-list" aria-hidden="true">
          {Array.from({ length: 6 }).map((_, index) => (
            <div className="nc-row skeleton-card" key={index}>
              <div className="skeleton-block nc-skel-avatar"/>
              <div className="skeleton-lines nc-skel-lines">
                <div className="skeleton-block w70"/>
                <div className="skeleton-block w40"/>
              </div>
            </div>
          ))}
        </div>
      )}

      {error && (
        <div className="nc-state" role="alert">
          <Bell size={28}/>
          <b>Could not load notifications</b>
          <span>{error}</span>
          <button className="secondary-button" onClick={() => fetchPage(true, 0)}>Try again</button>
        </div>
      )}

      {nothingMatched && everLoaded && (
        <div className="nc-state">
          <Bell size={34}/>
          <b>{filter === 'unread' ? 'No unread notifications' : 'Quiet so far'}</b>
          <span>Likes, comments, mentions, messages and events will land here as they happen.</span>
        </div>
      )}

      {!loading && !error && rows.length > 0 && (
        <div className="nc-list">
          <ul>
            {rows.map(row => (
              <li key={row.key}>
                <button className={`nc-row ${row.unread ? 'unread' : ''}`} onClick={() => openRow(row)}>
                  <span className="nc-avatar">
                    {row.actors[0]?.avatar
                      ? <img src={row.actors[0].avatar} alt="" loading="lazy"/>
                      : row.actors.length > 0
                        ? <span className="avatar">{initialsFor(row.actors[0]!.name, row.actors[0]!.username)}</span>
                        : <span className="avatar sys">{typeIcon(row.head.type)}</span>}
                  </span>
                  <span className="nc-row-copy">
                    <span className="nc-row-title">
                      {row.title}
                      {row.extraCount > 0 && <em className="nc-extra">+{row.extraCount}</em>}
                    </span>
                    {row.detail && <span className="nc-row-detail">{row.detail}</span>}
                    <span className="nc-row-meta">{relativeTime(row.createdAt)}</span>
                  </span>
                  {row.thumb && <img className="nc-row-thumb" src={row.thumb} alt="" loading="lazy"/>}
                  <span className={`nc-dot ${row.unread ? 'on' : ''}`}/>
                </button>
              </li>
            ))}
          </ul>
          {more && (
            <button className="secondary-button nc-more" disabled={loadingMore} onClick={() => fetchPage(false, itemsRef.current.length)}>
              {loadingMore ? <><Loader2 size={15} className="spin"/> Loading…</> : 'Load more'}
            </button>
          )}
        </div>
      )}

      {/* suggestions: visually separated recommendations, never activity */}
      <section className="nc-suggestions" aria-label="Suggested people">
        <h2><Users size={16}/> Suggested for you</h2>
        {suggLoading && <p className="nc-sugg-status"><Loader2 size={14} className="spin"/> Finding people from your campus…</p>}
        {!suggLoading && suggestions.length === 0 && (
          <p className="nc-sugg-status">No suggestions right now — as communities and classes fill up, new classmates appear here.</p>
        )}
        {suggestions.map(person => (
          <div className="nc-sugg-row" key={person.id}>
            <button
              className="nc-sugg-person"
              onClick={() => { if (person.id) onOpenProfile(person.id) }}
            >
              <span className="avatar">{initialsFor(person.name, person.username)}</span>
              <span className="nc-sugg-copy">
                <b>{person.name ?? person.username ?? 'Campus student'}</b>
                <small>{person.reason}</small>
              </span>
            </button>
            <button
              className={`secondary-button nc-follow ${person.isFollowing ? 'on' : ''}`}
              disabled={person.busy}
              onClick={() => followSuggestion(person)}
            >
              {person.isFollowing ? 'Following' : 'Follow'}
            </button>
          </div>
        ))}
      </section>

      <NotificationSettings
        open={sheetOpen}
        onClose={() => setSheetOpen(false)}
        notify={notify}
        userId={identity.id}
      />
    </div>
  )
}
