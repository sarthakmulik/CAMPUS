import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { ArrowLeft, MessageCircle, Pencil, Send, Trash2, X, Users } from 'lucide-react'
import * as db from '../lib/db'
import type { ChatMessage, ChatSummary } from '../lib/db'
import { initialsFor, relativeTime } from '../lib/db'

type Identity = { id: string; name: string; username: string; initials: string }

type Props = {
  identity: Identity | null
  configured: boolean
  /** When set, the page boots straight into that conversation (opened from a post's ⋯ menu). */
  autoOpen?: string | null
  onAutoOpened?: () => void
}

/**
 * Chats — 1:1 direct messages with classmates plus friend/class group chats
 * (Instagram's logic: one list, one composer). Club conversations are a
 * separate, later feature and are filtered out server-side (they never match
 * kind in ('dm','group') in the list RPC, so they never appear here).
 */
export default function Chats({ identity, configured, autoOpen, onAutoOpened }: Props) {
  const [conversations, setConversations] = useState<ChatSummary[]>([])
  const [loadingList, setLoadingList] = useState(true)
  const [listError, setListError] = useState<string | null>(null)
  const [openId, setOpenId] = useState<string | null>(null)
  const [messages, setMessages] = useState<ChatMessage[]>([])
  const [loadingThread, setLoadingThread] = useState(false)
  const [threadError, setThreadError] = useState<string | null>(null)
  const [draft, setDraft] = useState('')
  const [sending, setSending] = useState(false)
  const [peerName, setPeerName] = useState('')
  const [mobileThread, setMobileThread] = useState(false)
  const [peek, setPeek] = useState<ChatSummary | null>(null)
  /* group creation panel */
  const [groupPanel, setGroupPanel] = useState(false)
  const [groupTitle, setGroupTitle] = useState('')
  const [groupHandle, setGroupHandle] = useState('')
  const [groupMembers, setGroupMembers] = useState<{ id: string; name: string }[]>([])
  const [groupBusy, setGroupBusy] = useState(false)
  const [groupError, setGroupError] = useState<string | null>(null)
  /* message actions (Instagram): hover ⋯ on your own bubbles → Edit / Unsend */
  const [actionsFor, setActionsFor] = useState<string | null>(null)
  const [editing, setEditing] = useState<{ id: string; original: string } | null>(null)

  const seenIds = useRef<Set<string>>(new Set())
  const scrollRef = useRef<HTMLDivElement | null>(null)

  const loadConversations = useCallback(async () => {
    setLoadingList(true)
    setListError(null)
    try {
      const rows = await db.fetchConversations()
      setConversations(rows)
    } catch (error) {
      setListError(db.friendlyMessage(error))
    } finally {
      setLoadingList(false)
    }
  }, [])

  useEffect(() => {
    if (!configured || !identity) return
    void loadConversations()
  }, [configured, identity?.id, loadConversations])

  const openConversation = useCallback(async (conversationId: string) => {
    setOpenId(conversationId)
    setMobileThread(true)
    setThreadError(null)
    setLoadingThread(true)
    setMessages([])
    seenIds.current = new Set()
    if (scrollRef.current) scrollRef.current.scrollTop = 0
    setEditing(null)
    setActionsFor(null)
    try {
      const rows = await db.fetchChatMessages(conversationId)
      rows.forEach(row => seenIds.current.add(row.id))
      setMessages(rows)
      const summary = conversations.find(c => c.id === conversationId)
      if (summary) {
        setPeerName(summary.peerName)
        setPeek(summary)
      } else {
        // opened straight from a post menu before the list finished loading —
        // pull the list to resolve the peer's name
        void db.fetchConversations()
          .then(list => {
            setConversations(list)
            const found = list.find(c => c.id === conversationId)
            if (found) { setPeerName(found.peerName); setPeek(found) }
          })
          .catch(() => {})
      }
      void db.markConversationRead(conversationId)
      // clear the unread badge locally
      setConversations(list => list.map(c => c.id === conversationId ? { ...c, unread: 0 } : c))
    } catch (error) {
      setThreadError(db.friendlyMessage(error))
    } finally {
      setLoadingThread(false)
    }
  }, [conversations])

  // a chat opened from a post's ⋯ menu lands here with the conversation id
  useEffect(() => {
    if (!autoOpen) return
    void openConversation(autoOpen).then(() => onAutoOpened?.())
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [autoOpen])

  /* realtime: new messages in the open thread arrive live; edits and unsends
     replace the row in place — no refetch, no navigation */
  useEffect(() => {
    if (!openId) return
    const unsubscribe = db.subscribeChatMessages(openId, (message, type) => {
      if (type === 'update') {
        setMessages(list => list.map(item => item.id === message.id ? message : item))
        // the other side edited/unsent: refresh list previews + badges quietly
        void db.fetchConversations().then(rows => setConversations(rows)).catch(() => {})
        return
      }
      if (seenIds.current.has(message.id)) return
      seenIds.current.add(message.id)
      setMessages(list => [...list, message])
      if (message.senderId !== identity?.id) {
        void db.markConversationRead(openId)
        void db.fetchConversations().then(rows => setConversations(rows)).catch(() => {})
      }
    })
    return () => {
      unsubscribe()
      void db.fetchConversations().then(rows => setConversations(rows)).catch(() => {})
    }
  }, [openId, identity?.id])

  /* the chats list itself stays live: every new message, edit or unsend
     anywhere re-runs the list query, so previews, order and unread badges
     update without any navigation or polling */
  useEffect(() => {
    if (!identity) return
    let timer: number | null = null
    const throttled = () => {
      if (timer) return
      timer = window.setTimeout(() => {
        timer = null
        void db.fetchConversations().then(rows => setConversations(rows)).catch(() => {})
      }, 900)
    }
    const unsubscribe = db.subscribeChatActivity(throttled)
    return () => {
      if (timer) window.clearTimeout(timer)
      unsubscribe()
    }
  }, [identity?.id])

  /* keep the newest message in view */
  useLayoutEffect(() => {
    const box = scrollRef.current
    if (box) box.scrollTop = box.scrollHeight
  }, [messages.length, loadingThread, openId])

  /* Instagram flows: send completes your stream; Edit rewrites in place;
     Unsend tombstones it — the text leaves the database for everyone. */
  const saveEdit = useCallback(async () => {
    const body = draft.trim()
    if (!editing || !body || sending) return
    setSending(true)
    setThreadError(null)
    try {
      await db.editChatMessage(editing.id, body)
      const at = new Date().toISOString()
      setMessages(list => list.map(item => item.id === editing.id ? { ...item, body, editedAt: at } : item))
      setEditing(null)
      setDraft('')
      void db.fetchConversations().then(rows => setConversations(rows)).catch(() => {})
    } catch (error) {
      setThreadError(db.friendlyMessage(error))
    } finally {
      setSending(false)
    }
  }, [draft, editing, sending])

  const unsendMessage = useCallback(async (messageId: string) => {
    setThreadError(null)
    try {
      await db.unsendChatMessage(messageId)
      const at = new Date().toISOString()
      setMessages(list => list.map(item => item.id === messageId ? { ...item, body: '', deletedAt: at } : item))
      void db.fetchConversations().then(rows => setConversations(rows)).catch(() => {})
    } catch (error) {
      setThreadError(db.friendlyMessage(error))
    }
  }, [])

  /* incoming chat requests: the recipient accepts or declines once */
  const respondRequest = useCallback(async (action: 'accept' | 'decline') => {
    if (!openId) return
    setThreadError(null)
    try {
      await db.respondChatRequest(openId, action)
      const rows = await db.fetchConversations()
      setConversations(rows)
      setPeek(rows.find(c => c.id === openId) ?? null)
    } catch (error) {
      setThreadError(db.friendlyMessage(error))
    }
  }, [openId])

  // state of the open thread (request handling)
  const openSummary = openId ? conversations.find(c => c.id === openId) ?? peek : null
  const openStatus: 'pending' | 'accepted' | 'declined' | 'unknown' = openSummary?.status ?? 'unknown'
  const openMine = openSummary?.iRequested ?? false
  // the request creator may send exactly ONE opening note — once it exists,
  // the composer closes until they accept (mirrors the server rule honestly
  // instead of letting a second message die on the RLS policy)
  const myPendingUsed =
    openStatus === 'pending'
    && openMine
    && messages.some(message => message.senderId === identity?.id)
  const sendBlocked =
    openStatus === 'unknown'
    || openStatus === 'declined'
    || (openStatus === 'pending' && !openMine)
    || myPendingUsed

  const send = useCallback(async () => {
    const body = draft.trim()
    if (!body || !openId || sending || !identity) return
    if (editing) { void saveEdit(); return }
    // unknown/expired states resolve first; declined and pending recipients never send
    if (openStatus === 'unknown' || openStatus === 'declined' || (openStatus === 'pending' && !openMine) || myPendingUsed) return
    setSending(true)
    setThreadError(null)
    try {
      const sent = await db.sendChatMessage(openId, body, identity.id)
      if (!seenIds.current.has(sent.id)) {
        seenIds.current.add(sent.id)
        setMessages(list => [...list, { ...sent, senderName: identity?.name ?? 'You' }])
      }
      setDraft('')
      setConversations(list => list.map(c => c.id === openId
        ? { ...c, lastBody: sent.body, lastAt: sent.createdAt }
        : c))
    } catch (error) {
      setThreadError(db.friendlyMessage(error))
    } finally {
      setSending(false)
    }
  }, [draft, openId, sending, openStatus, openMine, myPendingUsed, editing, saveEdit, identity?.id, identity?.name])

  const addGroupMember = useCallback(async () => {
    if (!identity) return
    const raw = db.normalizeUsername(groupHandle)
    if (!raw) return
    setGroupError(null)
    try {
      const id = await db.findProfileIdByUsername(raw)
      if (!id) { setGroupError(`No member found as @${raw}.`); return }
      if (groupMembers.some(member => member.id === id)) { setGroupError(`@${raw} is already in the group.`); return }
      if (id === identity.id) { setGroupError('You are the group creator — you join automatically.'); return }
      const profile = await db.fetchProfile(id)
      setGroupMembers(list => [...list, {
        id,
        name: (profile?.display_name?.trim()) || (profile?.username ? `@${profile.username}` : `@${raw}`),
      }])
      setGroupHandle('')
    } catch (error) {
      setGroupError(db.friendlyMessage(error))
    }
  }, [groupHandle, groupMembers, identity])

  const createGroup = useCallback(async () => {
    const title = groupTitle.trim()
    if (!title) { setGroupError('Name your group first.'); return }
    setGroupBusy(true)
    setGroupError(null)
    try {
      const conversationId = await db.createGroup(title, groupMembers.map(member => member.id))
      setGroupPanel(false)
      setGroupTitle('')
      setGroupHandle('')
      setGroupMembers([])
      await loadConversations()
      void openConversation(conversationId)
    } catch (error) {
      setGroupError(db.friendlyMessage(error))
    } finally {
      setGroupBusy(false)
    }
  }, [groupTitle, groupMembers, loadConversations, openConversation])

  /* ---- empty / gated states ---------------------------------------------- */

  if (!configured) {
    return <section className="section-page"><div className="section-hero-icon"><MessageCircle size={27}/></div><span className="eyebrow">CAMPUS / CHATS</span><h2>Your conversations</h2><p>CAMPUS is not connected to its database yet, so chats are unavailable right now.</p></section>
  }

  if (!identity) {
    return <section className="section-page"><div className="section-hero-icon"><MessageCircle size={27}/></div><span className="eyebrow">CAMPUS / CHATS</span><h2>Your conversations</h2><p>Chats open once your member profile is loaded.</p></section>
  }

  const active = openId ? conversations.find(c => c.id === openId) ?? peek : null

  /* ---- render ------------------------------------------------------------- */

  return (
    <section className="chats-page">
      <div className={`chats-list-pane ${mobileThread ? 'thread-open' : ''}`}>
        <div className="chats-list-head">
          <h1>Chats</h1>
          <button className="new-group-button" onClick={() => { setGroupPanel(v => !v); setGroupError(null) }}>
            <Users size={15}/><span>New group</span>
          </button>
        </div>

        {groupPanel && (
          <div className="group-creator">
            <input
              className="group-name"
              placeholder="Group name (e.g. Section A study group)"
              value={groupTitle}
              maxLength={60}
              onChange={event => setGroupTitle(event.target.value)}
            />
            <div className="group-add-row">
              <input
                placeholder="Add classmates by @username"
                value={groupHandle}
                onKeyDown={event => { if (event.key === 'Enter') { event.preventDefault(); void addGroupMember() } }}
                onChange={event => setGroupHandle(event.target.value)}
              />
              <button className="text-button" onClick={() => void addGroupMember()}>Add</button>
            </div>
            {groupMembers.length > 0 && (
              <div className="group-chips">
                {groupMembers.map(member => (
                  <span key={member.id} className="group-chip">
                    {member.name}
                    <button aria-label={`Remove ${member.name}`} onClick={() => setGroupMembers(list => list.filter(m => m.id !== member.id))}><X size={12}/></button>
                  </span>
                ))}
              </div>
            )}
            {groupError && <div className="chats-hint error">{groupError}</div>}
            <div className="group-actions">
              <button className="text-button" onClick={() => { setGroupPanel(false); setGroupError(null); setGroupMembers([]) }}>Cancel</button>
              <button className="group-create-button" disabled={groupBusy || !groupTitle.trim()} onClick={() => void createGroup()}>
                {groupBusy ? <span className="mini-spinner"/> : 'Create group'}
              </button>
            </div>
          </div>
        )}

        {loadingList && <div className="chats-hint"><span className="mini-spinner"/>Loading conversations…</div>}
        {!loadingList && listError && (
          <div className="chats-hint error">{listError} <button className="link-button" onClick={() => void loadConversations()}>Retry</button></div>
        )}
        {!loadingList && !listError && conversations.length === 0 && !groupPanel && (
          <div className="chats-empty">
            <MessageCircle size={34}/>
            <b>No conversations yet</b>
            <p>Open the ⋯ menu on any post and choose “Message author” for a 1:1 chat, or tap New group up top to gather your friends.</p>
          </div>
        )}

        <div className="chats-list">
          {conversations.map(conversation => (
            <button key={conversation.id} className={`chat-row ${openId === conversation.id ? 'active' : ''}`} onClick={() => void openConversation(conversation.id)}>
              <span className={`avatar ${conversation.kind === 'group' ? 'group' : ''}`}>{db.initialsFor(conversation.peerName, conversation.peerUsername)}</span>
              <span className="chat-row-copy">
                <b>{conversation.peerName}</b>
                <small>{conversation.lastBody?.trim() ? conversation.lastBody : (conversation.kind === 'group' ? 'No messages yet — get the group going' : 'Say hi — no messages yet')}</small>
              </span>
              <span className="chat-row-meta">
                <small>{conversation.lastAt ? relativeTime(conversation.lastAt) : ''}</small>
                {conversation.status === 'pending' && <i className="request-tag">{conversation.iRequested ? 'Sent' : 'Request'}</i>}
                {conversation.status === 'declined' && <i className="request-tag declined-tag">Declined</i>}
                {conversation.unread > 0 && <i className="unread-pill">{conversation.unread}</i>}
              </span>
            </button>
          ))}
        </div>
      </div>

      <div className={`chat-thread-pane ${mobileThread ? 'open' : ''}`}>
        {!openId ? (
          <div className="chat-thread-empty">
            <MessageCircle size={34}/>
            <b>Pick a conversation</b>
            <p>Your 1:1 and group chats appear here.</p>
          </div>
        ) : (
          <>
            <div className="chat-thread-head">
              <button className="icon-button chat-back" aria-label="Back to chats" onClick={() => { setOpenId(null); setMobileThread(false) }}><ArrowLeft size={19}/></button>
              <span className="avatar small">{initialsFor(peerName, active?.peerUsername ?? '')}</span>
              <b>{peerName}</b>
              <span className="chat-sub">{active?.kind === 'group' ? `group${active.memberCount > 0 ? ` · ${active.memberCount}` : ''}` : 'direct message'}</span>
            </div>

            <div className="chat-scroll" ref={scrollRef}>
              {loadingThread && <div className="chats-hint"><span className="mini-spinner"/>Loading messages…</div>}
              {threadError && <div className="chats-hint error">{threadError}</div>}
              {!loadingThread && !threadError && messages.length === 0 && (
                <div className="chat-day-start">
                  <span>{active?.kind === 'group' ? `This is the start of ${peerName}. Keep it kind.` : `This is the beginning of your chat with ${peerName}. Keep it kind.`}</span>
                </div>
              )}
              {messages.map(message => {
                const mine = message.senderId === identity.id
                const isGroup = active?.kind === 'group'
                const unsent = Boolean(message.deletedAt)
                const editable = mine && !unsent
                return (
                  <div key={message.id} className={`chat-bubble-row ${mine ? 'mine' : 'theirs'}`}>
                    {!mine && <span className="avatar small">{initialsFor(message.senderName, active?.peerUsername ?? '')}</span>}
                    {mine && editable && (
                      <button
                        className="chat-msg-actions"
                        aria-label="Message options"
                        onClick={() => setActionsFor(current => current === message.id ? null : message.id)}
                      >
                        <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><circle cx="12" cy="5" r="1.8"/><circle cx="12" cy="12" r="1.8"/><circle cx="12" cy="19" r="1.8"/></svg>
                      </button>
                    )}
                    {mine && editable && actionsFor === message.id && (
                      <div className="chat-msg-menu">
                        <button
                          onClick={() => {
                            setEditing({ id: message.id, original: message.body })
                            setDraft(message.body)
                            setActionsFor(null)
                          }}
                        >
                          <Pencil size={13}/> Edit
                        </button>
                        <button className="danger" onClick={() => { setActionsFor(null); setEditing(null); setDraft(''); void unsendMessage(message.id) }}>
                          <Trash2 size={13}/> Unsend
                        </button>
                      </div>
                    )}
                    <div className="chat-msg-stack">
                      {isGroup && !mine && <small className="chat-sender">{message.senderName}</small>}
                      {unsent ? (
                        <div className={`chat-bubble unsent ${mine ? 'mine' : 'theirs'}`}>
                          <p>{mine ? 'You unsent a message' : `${isGroup ? message.senderName : peerName} unsent a message`}</p>
                        </div>
                      ) : (
                        <div className={`chat-bubble ${mine ? 'mine' : 'theirs'}`}>
                          <p>{message.body}</p>
                          <small>{relativeTime(message.createdAt)}{message.editedAt ? ' · edited' : ''}</small>
                        </div>
                      )}
                    </div>
                  </div>
                )
              })}
            </div>

            {(openStatus === 'pending' || openStatus === 'declined') && openSummary?.kind === 'dm' && (
              <div className={`chat-request-banner ${openStatus === 'declined' ? 'declined' : ''}`}>
                {openStatus === 'declined' ? (
                  <span>{openMine ? 'Your chat request was not accepted — sending is closed.' : 'You declined this chat request.'}</span>
                ) : openMine ? (
                  <span>Chat request sent — {peerName} needs to accept before the chat opens.</span>
                ) : (
                  <>
                    <span>{peerName} wants to chat with you.</span>
                    <button className="chat-request-accept" onClick={() => void respondRequest('accept')}>Accept</button>
                    <button className="chat-request-decline" onClick={() => void respondRequest('decline')}>Decline</button>
                  </>
                )}
              </div>
            )}

            <div className="chat-input-row">
              {editing && <div className="chat-editing-hint">Editing a message <button className="link-button" onClick={() => { setEditing(null); setDraft('') }}>Cancel</button></div>}
              <input
                value={draft}
                onChange={event => setDraft(event.target.value)}
                onKeyDown={event => {
                  if (event.key === 'Escape' && editing) { setEditing(null); setDraft(''); return }
                  if (event.key === 'Enter' && !event.shiftKey) { event.preventDefault(); void send() }
                }}
                placeholder={editing
                  ? 'Rewrite your message…'
                  : sendBlocked
                    ? (myPendingUsed
                      ? `Request sent — waiting for ${peerName} to accept`
                      : (openStatus === 'unknown' ? 'Loading conversation…' : 'Accept the chat request to reply'))
                    : `Message ${peerName}…`}
                maxLength={2000}
                disabled={sendBlocked && !editing}
              />
              <button
                className="chat-send"
                aria-label={editing ? 'Save edited message' : 'Send message'}
                disabled={(sending || !draft.trim() || sendBlocked) && !editing}
                onClick={() => void send()}
              >
                {sending ? <span className="mini-spinner"/> : editing ? <Pencil size={16}/> : <Send size={17}/>}
              </button>
            </div>
            {threadError && <button className="chat-clear-error" onClick={() => setThreadError(null)} aria-label="Dismiss error"><X size={14}/></button>}
          </>
        )}
      </div>
    </section>
  )
}
