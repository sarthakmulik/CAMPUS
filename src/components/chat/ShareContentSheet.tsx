import { useEffect, useMemo, useRef, useState } from 'react'
import { Check, Link2, Loader2, Search, X } from 'lucide-react'
import type { ChatSummary } from '../../lib/db'
import * as db from '../../lib/db'
import { useBodyScrollLock } from '../../lib/scrollLock'
import { useEscapeKey } from '../../lib/menuDismiss'

export type ShareTarget = {
  kind: db.ChatSharedKind
  id: string
  title: string
  subtitle?: string | null
  image?: string | null
  slug?: string | null
}

type Recipient = {
  key: string
  conversationId: string | null // null → open a fresh DM with this member
  userId: string
  name: string
  username: string
  avatar: string | null
  preview: string
}

const isVideoUrl = (url: string) => /\.(webm|mp4|mov|m4v)(\?|$)/i.test(url)

/**
 * The share sheet — Instagram-style: the content is already KNOWN (the user
 * tapped Share on it), so this sheet only picks recipients. Recent chats
 * first, searchable people below, multi-select, a prominent Send, and an
 * optional personal note. One chat message per recipient — a REFERENCE to
 * the original content ({kind, id}), never a re-upload. Failures stay
 * visible per recipient and can be retried without re-sending successes.
 */
export default function ShareContentSheet({
  target,
  presetConversationId,
  onClose,
  onFlash,
  onSent,
}: {
  target: ShareTarget
  /** destination already decided (e.g. shared from inside an open chat) → one-tap send */
  presetConversationId?: string | null
  onClose: () => void
  onFlash?: (message: string) => void
  /** after a successful send (used to close with feedback) */
  onSent?: (conversations: number) => void
}) {
  useBodyScrollLock()
  useEscapeKey(true, onClose)
  const [conversations, setConversations] = useState<ChatSummary[]>([])
  const [loading, setLoading] = useState(true)
  const [listError, setListError] = useState<string | null>(null)
  const [peopleQuery, setPeopleQuery] = useState('')
  const [people, setPeople] = useState<Recipient[]>([])
  const [peopleBusy, setPeopleBusy] = useState(false)
  const [selected, setSelected] = useState<Set<string>>(new Set(presetConversationId ? [presetConversationId] : []))
  const [note, setNote] = useState('')
  const [sending, setSending] = useState(false)
  const sendingRef = useRef(false)
  const [sentKeys, setSentKeys] = useState<Set<string>>(new Set())
  const [failed, setFailed] = useState<Record<string, string>>({})

  useEffect(() => {
    setLoading(true)
    db.fetchConversations()
      .then(rows => setConversations(rows.filter(c => c.status === 'accepted' && !c.archived)))
      .catch(error => setListError(db.friendlyMessage(error)))
      .finally(() => setLoading(false))
  }, [])

  useEffect(() => {
    const raw = peopleQuery.trim()
    if (raw.length < 2) { setPeople([]); setPeopleBusy(false); return }
    setPeopleBusy(true)
    const timer = window.setTimeout(() => {
      db.searchMembers(raw, 8)
        .then(rows => setPeople(rows.map(row => ({
          key: `user:${row.id}`,
          conversationId: null,
          userId: row.id,
          name: row.displayName,
          username: row.username ?? '',
          avatar: row.avatarUrl,
          preview: 'New message',
        }))))
        .catch(() => setPeople([]))
        .finally(() => setPeopleBusy(false))
    }, 320)
    return () => window.clearTimeout(timer)
  }, [peopleQuery])

  /** recent conversations first, newest first */
  const chatRecipients = useMemo<Recipient[]>(
    () => conversations.map(c => ({
      key: c.id,
      conversationId: c.id,
      userId: c.peerId ?? '',
      name: c.peerName,
      username: c.peerUsername,
      avatar: c.peerAvatar,
      preview: c.kind === 'group' ? `${c.memberCount} members` : (c.peerUsername ? `@${c.peerUsername}` : 'Direct message'),
    })),
    [conversations],
  )

  /** searched members who don't already have a chat in the list */
  const searchedRecipients = useMemo<Recipient[]>(() => {
    const known = new Set(chatRecipients.map(r => r.userId))
    return people.filter(p => !known.has(p.userId) && p.key && p.userId)
  }, [people, chatRecipients])

  const recipients = useMemo(() => [...chatRecipients, ...searchedRecipients], [chatRecipients, searchedRecipients])

  const toggle = (key: string) => {
    setFailed(current => {
      const next = { ...current }
      delete next[key]
      return next
    })
    setSelected(current => {
      const next = new Set(current)
      if (next.has(key)) next.delete(key)
      else next.add(key)
      return next
    })
  }

  const copyLink = async () => {
    const base = window.location.origin + window.location.pathname
    const url = target.kind === 'listing' && target.slug ? `${base}/#m/${target.slug}`
      : target.kind === 'event' && target.slug ? `${base}/#e/${target.slug}`
      : `${base}/#p/${target.id}`
    const failure = await db.copyToClipboard(url)
    onFlash?.(failure ?? 'Link copied — paste it anywhere to share.')
  }

  /**
   * Sends only the recipients that have not been delivered yet — a retry
   * never re-sends to chats that already show "Sent". Rapid double taps
   * cannot duplicate a message: sendingRef is a synchronous guard that is
   * set BEFORE the first await, so a second click in the same tick bails.
   * The backend send is awaited per recipient: nothing is reported before
   * it exists.
   */
  const send = async () => {
    const pending = recipients
      .map(r => r.key)
      .filter(key => selected.has(key) && !sentKeys.has(key))
    if (sendingRef.current || pending.length === 0) return
    sendingRef.current = true
    setSending(true)
    setFailed({})
    for (const key of pending) {
      const recipient = recipients.find(r => r.key === key)
      if (!recipient) continue
      try {
        const conversationId = recipient.conversationId ?? await db.openDm(recipient.userId)
        await db.shareContentToChat(conversationId, { kind: target.kind, id: target.id }, note)
        setSentKeys(current => new Set(current).add(key))
      } catch (error) {
        setFailed(current => ({ ...current, [key]: db.friendlyMessage(error) }))
        // a blocked/dead chat aborts the batch — the rest stays retryable
        break
      }
    }
    sendingRef.current = false
    setSending(false)
  }

  const failures = Object.keys(failed).length
  const delivered = sentKeys.size
  const remaining = selected.size - sentKeys.size - failures
  const allDone = !sending && selected.size > 0 && remaining === 0 && delivered > 0

  useEffect(() => {
    if (allDone) {
      onSent?.(delivered)
      const timer = window.setTimeout(onClose, 900)
      return () => window.clearTimeout(timer)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [allDone])

  const sendable = selected.size - sentKeys.size > 0

  return (
    <div className="overlay" onMouseDown={event => { if (event.target === event.currentTarget) onClose() }}>
      <section className="share-modal" role="dialog" aria-modal="true" aria-label="Share">
        <button className="modal-close icon-button" onClick={onClose} aria-label="Close"><X size={20}/></button>
        <h2>Share</h2>

        <div className="share-target-row">
          {target.image
            ? isVideoUrl(target.image)
              ? <video src={target.image} muted playsInline preload="metadata" aria-hidden="true"/>
              : <img src={target.image} alt="" loading="lazy"/>
            : <span className="share-target-fallback" aria-hidden="true">{target.kind[0]?.toUpperCase()}</span>}
          <span className="share-target-copy">
            <b>{target.title}</b>
            {target.subtitle && <small>{target.subtitle}</small>}
          </span>
          <button className="link-button" onClick={() => void copyLink()}>
            <Link2 size={13}/> Copy link
          </button>
        </div>

        <div className="share-search">
          <Search size={15}/>
          <input
            placeholder="Search people or chats"
            value={peopleQuery}
            onChange={event => setPeopleQuery(event.target.value)}
            maxLength={40}
            aria-label="Search people or chats"
          />
          {peopleBusy ? <span className="mini-spinner"/> : null}
        </div>

        <div className="share-recipients">
          {loading && <div className="share-list-note"><span className="mini-spinner"/> Loading your chats…</div>}
          {listError && <div className="share-list-note error">{listError} <button className="link-button" onClick={() => window.location.reload()}>Retry</button></div>}
          {!loading && recipients.length === 0 && (
            <div className="share-list-note"><b>No chats or people match yet — try searching up top.</b></div>
          )}
          {recipients.map(recipient => (
            <button
              key={recipient.key}
              className={`share-recipient ${selected.has(recipient.key) ? 'checked' : ''} ${sentKeys.has(recipient.key) ? 'sent' : ''} ${failed[recipient.key] ? 'failed' : ''}`}
              onClick={() => { if (!sentKeys.has(recipient.key) && !sending) toggle(recipient.key) }}
              disabled={sentKeys.has(recipient.key) || sending}
              aria-pressed={selected.has(recipient.key) || sentKeys.has(recipient.key)}
            >
              {recipient.avatar
                ? <img className="avatar small" src={recipient.avatar} alt=""/>
                : <span className="avatar small">{db.initialsFor(recipient.name, recipient.username)}</span>}
              <span className="share-recipient-copy">
                <b>{recipient.name}</b>
                <small>{failed[recipient.key] ?? (sentKeys.has(recipient.key) ? 'Sent' : recipient.preview)}</small>
              </span>
              <span className="share-recipient-tick" aria-hidden="true">
                {sentKeys.has(recipient.key) || selected.has(recipient.key) ? <Check size={14}/> : null}
              </span>
            </button>
          ))}
        </div>

        <label className="share-note">
          <span className="note-label">Message</span>
          <input
            placeholder={`Optional — say something about this ${KIND_WORD[target.kind]}…`}
            value={note}
            maxLength={2000}
            onChange={event => setNote(event.target.value)}
          />
        </label>

        <div className="wizard-actions inline">
          <button className="secondary-button" onClick={onClose} disabled={sending}>Close</button>
          <button
            className="primary-button"
            disabled={sending || !sendable}
            onClick={() => void send()}
          >
            {sending
              ? <><Loader2 size={14} className="spin"/> Sending…</>
              : allDone ? 'Sent'
              : remaining > 0 ? `Send to ${remaining} ${remaining === 1 ? 'chat' : 'chats'}` : 'Send'}
          </button>
        </div>
        {allDone && sentKeys.size > 1 && <p className="visually-hidden" role="status">Sent to {sentKeys.size} chats.</p>}
      </section>
    </div>
  )
}

const KIND_WORD: Record<string, string> = {
  reel: 'reel', post: 'post', profile: 'profile', listing: 'listing', event: 'event',
}
