import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import {
  ArrowDown, ArrowLeft, CornerUpLeft, FileText, Image as ImageIcon, MessageSquare, Pencil,
  Plus, Reply, Search, Send, SmilePlus, Trash2, X,
} from 'lucide-react'
import * as db from '../lib/db'
import * as cm from '../lib/communities'
import { friendlyMessage, initialsFor, relativeTime } from '../lib/db'
import type { ChatAttachment, ChatMessage } from '../lib/db'
import RichText from './RichText'
import ReportDialog, { type ReportTarget } from './ReportDialog'
import ChatSharedCard from './chat/ChatSharedCard'
import { useMenuDismiss } from '../lib/menuDismiss'

type Identity = { id: string; name: string; username: string; initials: string }

type Props = {
  communityId: string
  identity: Identity | null
  isModerator: boolean
  notify: (message: string) => void
  onOpenMention: (profileId: string) => void
}

const REACTIONS = ['👍', '❤️', '😂', '🎉', '🙏', '🔥', '👀', '💯']
const PAGE_SIZE = 40
const EDIT_WINDOW_MS = 24 * 60 * 60 * 1000
// same family as the server rule: mentions start at @ after a break, not
// inside an email address like a@campus. Group 1 keeps the break character
// so insertion can restore it; group 2 is the handle being typed.
const MENTION_CARET_RE = /(^|[^a-zA-Z0-9_.@-])@([a-zA-Z0-9_]*)$/
const MENTION_CHAR_RE = /(?:^|[^a-zA-Z0-9_.@-])@([a-zA-Z0-9_]{3,20})(?![a-zA-Z0-9_])/gu

function sameDay(a: string, b: string): boolean {
  return new Date(a).toDateString() === new Date(b).toDateString()
}

function dayLabel(iso: string): string {
  const d = new Date(iso)
  const now = new Date()
  if (d.toDateString() === now.toDateString()) return 'Today'
  if (d.toDateString() === new Date(now.getTime() - 86_400_000).toDateString()) return 'Yesterday'
  return d.toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' })
}

function formatBytes(bytes: number): string {
  if (bytes >= 1_048_576) return `${(bytes / 1_048_576).toFixed(1)} MB`
  if (bytes >= 1024) return `${Math.round(bytes / 1024)} KB`
  return `${bytes} B`
}

function tombstonePatch(message: ChatMessage, at: string, removerId: string | null) {
  const entity = (m: ChatMessage) => m.id === message.id ? {
    ...m, body: '', deletedAt: at, deletedBy: removerId ?? m.deletedBy,
    attachments: [] as ChatAttachment[], reactions: {}, pinnedAt: null,
  } : m
  return entity
}

export default function CommunityChat({ communityId, identity, isModerator, notify, onOpenMention }: Props) {
  const [conversationId, setConversationId] = useState<string | null>(null)
  const [openStatus, setOpenStatus] = useState<'loading' | 'open' | 'blocked' | 'error'>('loading')
  const [openError, setOpenError] = useState<string | null>(null)

  const [messages, setMessages] = useState<ChatMessage[]>([])
  const [loadingThread, setLoadingThread] = useState(false)
  const [loadingOlder, setLoadingOlder] = useState(false)
  const [olderAvailable, setOlderAvailable] = useState(false)
  const [threadError, setThreadError] = useState<string | null>(null)

  const [draft, setDraft] = useState('')
  const [sending, setSending] = useState(false)
  const [pendingFiles, setPendingFiles] = useState<File[]>([])
  const [uploading, setUploading] = useState<string | null>(null)

  const [replyTo, setReplyTo] = useState<ChatMessage | null>(null)
  const [editing, setEditing] = useState<ChatMessage | null>(null)

  const [menuFor, setMenuFor] = useState<string | null>(null)
  const [pickerFor, setPickerFor] = useState<string | null>(null)

  const [mentionQuery, setMentionQuery] = useState<string | null>(null)
  const [mentionTargets, setMentionTargets] = useState<db.MentionTarget[]>([])
  const [mentionIndex, setMentionIndex] = useState(0)

  const [threadRoot, setThreadRoot] = useState<ChatMessage | null>(null)
  const [threadMsgs, setThreadMsgs] = useState<ChatMessage[]>([])
  const [threadLoading, setThreadLoading] = useState(false)

  const [searchOpen, setSearchOpen] = useState(false)
  const [searchInput, setSearchInput] = useState('')
  const [searchTag, setSearchTag] = useState('')
  const [searchResults, setSearchResults] = useState<ChatMessage[]>([])
  const [searching, setSearching] = useState(false)
  const [searchError, setSearchError] = useState<string | null>(null)

  const [pins, setPins] = useState<ChatMessage[]>([])
  const [highlightId, setHighlightId] = useState<string | null>(null)
  const [atBottom, setAtBottom] = useState(true)
  const [newBelow, setNewBelow] = useState(0)

  const [reportTarget, setReportTarget] = useState<ReportTarget | null>(null)
  const [imageOverlay, setImageOverlay] = useState<{ url: string; name: string } | null>(null)
  const [attachmentUrls, setAttachmentUrls] = useState<Record<string, string>>({})

  const scrollRef = useRef<HTMLDivElement | null>(null)
  const inputRef = useRef<HTMLTextAreaElement | null>(null)
  const fileInputRef = useRef<HTMLInputElement | null>(null)

  // refs mirror live values so the realtime subscription is created once per
  // conversation and never churns (state closures would resubscribe forever)
  const atBottomRef = useRef(true)
  const threadRootRef = useRef<string | null>(null)
  const myId = identity?.id ?? null

  const coarsePointer = useRef(
    typeof window !== 'undefined' && typeof window.matchMedia === 'function'
      ? window.matchMedia('(pointer: coarse)').matches
      : false,
  )

  useEffect(() => { atBottomRef.current = atBottom }, [atBottom])
  useEffect(() => { threadRootRef.current = threadRoot?.id ?? null }, [threadRoot])

  /* ---------------------------------------------------------------- */
  /* opening the channel + loading history + pins                     */
  /* ---------------------------------------------------------------- */

  const openChat = useCallback(async () => {
    if (!identity) { setOpenStatus('blocked'); return }
    setOpenStatus('loading')
    try {
      const id = await cm.openCommunityChat(communityId)
      setConversationId(id)
      setOpenStatus('open')
    } catch (err) {
      setOpenError(friendlyMessage(err))
      setOpenStatus('error')
    }
  }, [communityId, identity])

  useEffect(() => {
    if (openStatus === 'blocked' || openStatus === 'open') return
    void openChat()
  }, [openStatus, openChat])

  const refreshPins = useCallback(async (conversation: string) => {
    try {
      setPins(await db.fetchChatPins(conversation))
    } catch {
      setPins([]) // the banner hides instead of failing loudly; chat still works
    }
  }, [])

  useEffect(() => {
    if (!conversationId) return
    let cancelled = false
    setLoadingThread(true)
    setLoadingOlder(false)
    setThreadError(null)
    db.fetchChatMessages(conversationId, null, PAGE_SIZE)
      .then(rows => {
        if (cancelled) return
        setMessages(rows)
        setOlderAvailable(rows.length >= PAGE_SIZE)
        void db.markConversationRead(conversationId).catch(() => {})
      })
      .catch(err => { if (!cancelled) setThreadError(friendlyMessage(err)) })
      .finally(() => { if (!cancelled) setLoadingThread(false) })
    void refreshPins(conversationId)
    return () => { cancelled = true }
  }, [conversationId, refreshPins])

  const loadOlder = useCallback(async () => {
    if (!conversationId || loadingOlder || messages.length === 0) return
    setLoadingOlder(true)
    const cursor = messages[0].createdAt
    const box = scrollRef.current
    const previousHeight = box?.scrollHeight ?? 0
    try {
      const rows = await db.fetchChatMessages(conversationId, cursor, PAGE_SIZE)
      if (rows.length) {
        setMessages(current => {
          const known = new Set(current.map(m => m.id))
          return [...rows.filter(r => !known.has(r.id)), ...current]
        })
        setOlderAvailable(rows.length >= PAGE_SIZE)
        requestAnimationFrame(() => {
          const after = scrollRef.current
          if (after) after.scrollTop += after.scrollHeight - previousHeight
        })
      } else {
        setOlderAvailable(false)
      }
    } catch (err) {
      notify(friendlyMessage(err))
    } finally {
      setLoadingOlder(false)
    }
  }, [conversationId, loadingOlder, messages, notify])

  /* ---------------------------------------------------------------- */
  /* realtime: inserts + updates (edits, unsends, reactions, pins)     */
  /* ---------------------------------------------------------------- */

  const markReadIfWatched = useCallback(() => {
    if (!conversationId) return
    const box = scrollRef.current
    const nearBottom = !box || box.scrollHeight - box.scrollTop - box.clientHeight < 140
    if (nearBottom && document.visibilityState === 'visible') {
      void db.markConversationRead(conversationId).catch(() => {})
    }
  }, [conversationId])

  /* Realtime chat_messages payloads carry ONLY table columns — the persona
     fields (sender name/username/avatar) and the derived reply fields
     (parent author + excerpt, reply count) never travel on the wire and
     must be preserved from the row we already hold. State fields (body,
     attachments, reactions, deleted, pinned, edited) are authoritative. */
  const mergeIncoming = (existing: db.ChatMessage, incoming: db.ChatMessage): db.ChatMessage => ({
    ...existing,
    body: incoming.body,
    createdAt: incoming.createdAt,
    editedAt: incoming.editedAt,
    deletedAt: incoming.deletedAt,
    deletedBy: incoming.deletedBy,
    parentMessageId: incoming.parentMessageId ?? existing.parentMessageId,
    parentAuthorName: incoming.parentAuthorName ?? existing.parentAuthorName,
    parentExcerpt: incoming.parentExcerpt ?? existing.parentExcerpt,
    attachments: incoming.attachments,
    reactions: incoming.reactions,
    pinnedAt: incoming.pinnedAt,
    replyCount: incoming.replyCount || existing.replyCount,
    senderUsername: incoming.senderUsername ?? existing.senderUsername,
    senderName: incoming.senderName && incoming.senderName !== 'Student' ? incoming.senderName : existing.senderName,
    senderAvatarUrl: incoming.senderAvatarUrl ?? existing.senderAvatarUrl,
  })

  const applyMessage = useCallback((incoming: db.ChatMessage, type: 'insert' | 'update') => {
    setMessages(current => {
      // A brand-new reply arriving on the realtime wire has no derived
      // parent fields (they never travel on chat_messages payloads). If we
      // already hold the parent row, quote it honestly; jumpToMessage will
      // repaint from the server for anything deeper.
      if (incoming.parentMessageId && !incoming.parentAuthorName) {
        const parent = current.find(m => m.id === incoming.parentMessageId)
        if (parent) {
          incoming = {
            ...incoming,
            parentAuthorName: parent.senderName,
            parentExcerpt: parent.deletedAt ? 'Message unsent' : (parent.body ? parent.body.slice(0, 96) : '(attachment)'),
          }
        }
      }
      const index = current.findIndex(m => m.id === incoming.id)
      if (index === -1) {
        const next = [...current, incoming]
        next.sort((a, b) => a.createdAt === b.createdAt
          ? (a.id < b.id ? -1 : 1)
          : a.createdAt.localeCompare(b.createdAt))
        return next
      }
      const next = [...current]
      next[index] = mergeIncoming(next[index], incoming)
      return next
    })

    if (type === 'insert') {
      if (incoming.senderId !== myId) {
        if (!atBottomRef.current) setNewBelow(count => count + 1)
      }
      markReadIfWatched()
    }

    // live thread patching: this row belongs to the open thread?
    const rootId = threadRootRef.current
    if (rootId) {
      if (incoming.id === rootId) {
        setThreadRoot(root => root ? mergeIncoming(root, incoming) : root)
      }
      if (incoming.parentMessageId === rootId) {
        setThreadMsgs(list => {
          const i = list.findIndex(m => m.id === incoming.id)
          if (i === -1) return type === 'insert' ? [...list, incoming] : list
          const copy = [...list]
          copy[i] = mergeIncoming(copy[i], incoming)
          return copy
        })
      }
    }

    // pin changes move the banner
    if (type === 'update' && conversationId && incoming.pinnedAt) {
      void refreshPins(conversationId)
    }
  }, [conversationId, markReadIfWatched, myId, refreshPins])

  useEffect(() => {
    if (!conversationId) return
    const unsubscribe = db.subscribeChatMessages(conversationId, applyMessage)
    return () => { unsubscribe() }
  }, [conversationId, applyMessage])

  /* ---------------------------------------------------------------- */
  /* scrolling discipline                                             */
  /* ---------------------------------------------------------------- */

  useLayoutEffect(() => {
    const box = scrollRef.current
    if (box && atBottom) box.scrollTop = box.scrollHeight
  }, [messages.length, loadingThread, atBottom])

  const onScroll = useCallback(() => {
    const box = scrollRef.current
    if (!box) return
    const bottom = box.scrollHeight - box.scrollTop - box.clientHeight
    const now = bottom < 80
    setAtBottom(now)
    if (now && newBelow > 0) setNewBelow(0)
  }, [newBelow])

  const jumpToLatest = () => {
    const box = scrollRef.current
    if (box) {
      box.scrollTo({ top: box.scrollHeight, behavior: 'smooth' })
      setNewBelow(0)
    }
  }

  const flash = (id: string) => {
    setHighlightId(id)
    window.setTimeout(() => setHighlightId(current => (current === id ? null : current)), 1600)
  }

  /** shared cards navigate through the app's existing hash deep links */
  const openSharedCard = useCallback((message: ChatMessage) => {
    if (!message.sharedKind || !message.sharedId) return
    if (message.sharedKind === 'profile') {
      onOpenMention(message.sharedId)
      return
    }
    const hash = message.sharedKind === 'listing' && message.sharedSlug ? `#m/${message.sharedSlug}`
      : message.sharedKind === 'event' && message.sharedSlug ? `#e/${message.sharedSlug}`
      : message.sharedKind === 'reel' || message.sharedKind === 'post' ? `#p/${message.sharedId}`
      : null
    if (hash && window.location.hash !== hash) {
      window.history.replaceState(null, '', window.location.pathname + window.location.search)
      window.location.hash = hash
    }
  }, [onOpenMention])

  const jumpToMessage = useCallback(async (id: string) => {
    const box = scrollRef.current
    const find = () => box?.querySelector<HTMLElement>(`[data-mid="${id}"]`)
    if (find()) {
      find()!.scrollIntoView({ block: 'center', behavior: 'smooth' })
      flash(id)
      return
    }
    if (!conversationId || !messages.length) return
    let current = messages
    for (let guard = 0; guard < 10; guard += 1) {
      const cursor = current[0].createdAt
      let rows: db.ChatMessage[] = []
      try {
        rows = await db.fetchChatMessages(conversationId, cursor, PAGE_SIZE)
      } catch {
        break
      }
      if (!rows.length) break
      const known = new Set(current.map(m => m.id))
      current = [...rows.filter(r => !known.has(r.id)), ...current]
      if (rows.some(r => r.id === id)) {
        setMessages(current)
        setOlderAvailable(current.length >= PAGE_SIZE)
        requestAnimationFrame(() => {
          find()?.scrollIntoView({ block: 'center', behavior: 'smooth' })
          flash(id)
        })
        return
      }
    }
    notify('That message is outside the loaded history — try Search.')
  }, [conversationId, messages, notify])

  /* ---------------------------------------------------------------- */
  /* mention autocomplete                                             */
  /* ---------------------------------------------------------------- */

  useEffect(() => {
    if (mentionQuery === null || !conversationId) return
    const id = window.setTimeout(() => {
      db.fetchMentionTargets(conversationId, mentionQuery)
        .then(setMentionTargets)
        .catch(() => setMentionTargets([]))
    }, 180)
    return () => window.clearTimeout(id)
  }, [mentionQuery, conversationId])

  useEffect(() => { setMentionIndex(0) }, [mentionTargets.length])

  const applyMention = (target: db.MentionTarget) => {
    const input = inputRef.current
    if (!input || mentionQuery === null) return
    const caret = input.selectionStart ?? draft.length
    const before = draft.slice(0, caret)
    const match = MENTION_CARET_RE.exec(before)
    if (!match) return
    const start = caret - match[0].length
    const prefix = match[1]
    const next = draft.slice(0, start) + prefix + `@${target.username} ` + draft.slice(caret)
    setDraft(next)
    setMentionQuery(null)
    setMentionTargets([])
    requestAnimationFrame(() => {
      const position = start + prefix.length + target.username.length + 2
      input.setSelectionRange(position, position)
      input.focus()
    })
  }

  const onComposerChange = (value: string, caret: number | null) => {
    setDraft(value)
    const before = value.slice(0, caret ?? value.length)
    const match = MENTION_CARET_RE.exec(before)
    if (match) {
      setMentionQuery(match[2])
      setMentionIndex(0)
    } else if (mentionQuery !== null) {
      setMentionQuery(null)
      setMentionTargets([])
    }
  }

  /* ---------------------------------------------------------------- */
  /* attachments                                                      */
  /* ---------------------------------------------------------------- */

  const onPickFiles = (files: FileList | null) => {
    if (!files) return
    const next: File[] = []
    for (const file of Array.from(files)) {
      if (pendingFiles.length + next.length >= 4) { notify('A message can carry at most 4 attachments.'); break }
      if (file.size <= 0) { notify('That file is empty.'); continue }
      if (file.size > 25 * 1024 * 1024) { notify('Attachments can be at most 25 MB.'); continue }
      next.push(file)
    }
    if (next.length) setPendingFiles(current => [...current, ...next])
    if (fileInputRef.current) fileInputRef.current.value = ''
  }

  /* ---------------------------------------------------------------- */
  /* sending / editing / moderation                                   */
  /* ---------------------------------------------------------------- */

  const send = async () => {
    if (!identity || !conversationId || sending) return
    if (editing) {
      const body = draft.trim()
      if (!body) { notify('Write something first.'); return }
      setSending(true)
      setThreadError(null)
      try {
        await db.editChatMessage(editing.id, body)
        const at = new Date().toISOString()
        const patch = (m: ChatMessage) => m.id === editing.id ? { ...m, body, editedAt: at } : m
        setMessages(list => list.map(patch))
        setThreadMsgs(list => list.map(patch))
        setEditing(null)
        setDraft('')
      } catch (err) {
        setThreadError(friendlyMessage(err))
      } finally {
        setSending(false)
      }
      return
    }

    const body = draft.trim()
    if (!body && pendingFiles.length === 0) return
    setSending(true)
    setThreadError(null)
    try {
      let attachments: db.ChatAttachment[] = []
      if (pendingFiles.length) {
        setUploading('Uploading ' + pendingFiles.map(f => f.name).join(', '))
        try {
          attachments = []
          for (const file of pendingFiles) {
            attachments.push(await db.uploadChatAttachment(conversationId, file))
          }
        } finally {
          setUploading(null)
        }
      }
      const parentId = threadRoot ? threadRoot.id : (replyTo ? (replyTo.parentMessageId ?? replyTo.id) : null)
      const saved = await db.sendChatMessage(conversationId, body, identity.id, { parentId, attachments })
      setDraft('')
      setReplyTo(null)
      setPendingFiles([])
      applyMessage(saved, 'insert')
      if (threadRoot && saved.parentMessageId === threadRoot.id) {
        setThreadMsgs(list => list.some(m => m.id === saved.id) ? list : [...list, saved])
      }
    } catch (err) {
      // draft + pending files stay so a retry resends them — no silent loss
      setThreadError(friendlyMessage(err))
    } finally {
      setSending(false)
    }
  }

  const unsend = async (message: ChatMessage) => {
    try {
      await db.unsendChatMessage(message.id)
      const at = new Date().toISOString()
      // the server records deleted_by = the remover (the sender, here)
      const patch = tombstonePatch(message, at, myId)
      setMessages(list => list.map(patch))
      setThreadMsgs(list => list.map(patch))
    } catch (err) {
      notify(friendlyMessage(err))
    }
  }

  const moderatorRemove = async (message: ChatMessage) => {
    try {
      await db.removeChatMessage(message.id)
      const at = new Date().toISOString()
      // the server records deleted_by = the remover (moderator, or self)
      const patch = tombstonePatch(message, at, myId)
      setMessages(list => list.map(patch))
      setThreadMsgs(list => list.map(patch))
      notify(message.senderId === myId ? 'Message removed.' : 'Message removed from the community chat.')
    } catch (err) {
      notify(friendlyMessage(err))
    }
  }

  const togglePin = async (message: ChatMessage) => {
    const wantPinned = !message.pinnedAt
    try {
      await db.setChatMessagePin(message.id, wantPinned)
      const patch = (m: ChatMessage) => m.id === message.id
        ? { ...m, pinnedAt: wantPinned ? new Date().toISOString() : null } : m
      setMessages(list => list.map(patch))
      setThreadMsgs(list => list.map(patch))
      if (conversationId) void refreshPins(conversationId)
      notify(wantPinned ? 'Pinned to the top of this community chat.' : 'Unpinned.')
    } catch (err) {
      notify(friendlyMessage(err))
    }
  }

  const react = async (message: ChatMessage, emoji: string) => {
    if (!identity) return
    try {
      const nextReactions = await db.toggleChatReaction(message.id, emoji)
      const patch = (m: ChatMessage) => m.id === message.id ? { ...m, reactions: nextReactions } : m
      setMessages(list => list.map(patch))
      setThreadMsgs(list => list.map(patch))
    } catch (err) {
      notify(friendlyMessage(err))
    }
  }

  /* ---------------------------------------------------------------- */
  /* thread + search                                                  */
  /* ---------------------------------------------------------------- */

  const closeThread = () => { setThreadRoot(null); setThreadMsgs([]) }

  const openThread = useCallback(async (message: ChatMessage) => {
    setMenuFor(null)
    setThreadRoot(message)
    setThreadLoading(true)
    setThreadMsgs([])
    try {
      const rows = await db.fetchChatThread(message.id)
      const root = rows[0] ?? message
      setThreadRoot(root)
      setThreadMsgs(rows.slice(1))
    } catch (err) {
      notify(friendlyMessage(err))
      closeThread()
    } finally {
      setThreadLoading(false)
    }
  }, [notify])

  useEffect(() => {
    if (!searchOpen || !conversationId) return
    const term = searchInput.trim()
    const tag = searchTag.trim()
    if (!term && !tag) {
      setSearchResults([])
      setSearchError(null)
      return
    }
    const id = window.setTimeout(() => {
      setSearching(true)
      setSearchError(null)
      db.searchChatMessages(conversationId, term, tag)
        .then(setSearchResults)
        .catch(err => setSearchError(friendlyMessage(err)))
        .finally(() => setSearching(false))
    }, 320)
    return () => window.clearTimeout(id)
  }, [searchOpen, searchInput, searchTag, conversationId])

  const startTagSearch = (raw: string) => {
    setSearchOpen(true)
    setSearchTag((raw.startsWith('#') ? raw.slice(1) : raw).replace(/[^\w-]/g, '').slice(0, 30))
    setSearchInput('')
  }

  /* ---------------------------------------------------------------- */
  /* one click-away rule for the message menus and pickers            */
  /* ---------------------------------------------------------------- */

  useMenuDismiss(
    Boolean(menuFor || pickerFor || mentionQuery),
    () => { setMenuFor(null); setPickerFor(null) },
    () => [],
    {
      inside: target => Boolean(target.closest('.chat-msg-menu, .cc-reaction-picker, .cc-mentions, .chat-input-row, .cc-actions')),
      onDismissed: target => {
        // clicking elsewhere in the thread list also clears the pending mention
        if (mentionQuery && target.closest('.chat-bubble-row')) setMentionQuery(null)
      },
    },
  )

  /* ---------------------------------------------------------------- */
  /* signed URLs for private attachments (1 hour, cached per session)  */
  /* ---------------------------------------------------------------- */

  const attachmentPaths = useMemo(
    () => [...new Set([
      ...messages.flatMap(m => m.attachments.map(a => a.path)),
      ...threadMsgs.flatMap(m => m.attachments.map(a => a.path)),
    ].filter(path => !attachmentUrls[path]))],
    [messages, threadMsgs, attachmentUrls],
  )
  useEffect(() => {
    if (!attachmentPaths.length) return
    let cancelled = false
    db.chatAttachmentUrls(attachmentPaths).then(urls => {
      if (!cancelled && Object.keys(urls).length) {
        setAttachmentUrls(current => ({ ...current, ...urls }))
      }
    }).catch(() => {})
    return () => { cancelled = true }
  }, [attachmentPaths])

  /* ---------------------------------------------------------------- */

  if (openStatus === 'blocked') {
    return <div className="empty-state"><MessageSquare size={28}/><b>Members' chat</b><span>Join this community to read and send messages here.</span></div>
  }
  if (openStatus === 'error') {
    return <div className="community-error" role="alert"><p>{openError}</p><button onClick={() => void openChat()}>Try again</button></div>
  }
  if (openStatus !== 'open' || !conversationId) {
    return <div className="empty-state"><MessageSquare size={28}/><b>Opening the community chat…</b><span><span className="mini-spinner"/> Securing your seat.</span></div>
  }

  const mentionMode = mentionQuery !== null && mentionTargets.length > 0
  const canSend = Boolean(identity) && !sending && (draft.trim().length > 0 || pendingFiles.length > 0)

  const groupedBefore = (message: ChatMessage, rows: ChatMessage[]): boolean => {
    const index = rows.findIndex(m => m.id === message.id)
    if (index <= 0) return false
    const previous = rows[index - 1]
    return (
      previous.senderId === message.senderId &&
      !previous.deletedAt && !message.deletedAt &&
      !message.parentMessageId &&
      sameDay(previous.createdAt, message.createdAt) &&
      new Date(message.createdAt).getTime() - new Date(previous.createdAt).getTime() < 5 * 60 * 1000
    )
  }

  const renderBubble = (message: ChatMessage, rows: ChatMessage[] = messages) => {
    const mine = message.senderId === myId
    const deleted = Boolean(message.deletedAt)
    const modRemoved = deleted && message.deletedBy !== null
      && message.deletedBy !== message.senderId
    const attachments = message.attachments ?? []
    const images = attachments.filter(a => a.mime.startsWith('image/'))
    const files = attachments.filter(a => !a.mime.startsWith('image/'))
    const reactionRows = Object.entries(message.reactions ?? {}).filter(([, ids]) => ids.length > 0)
    const canEdit = mine && !deleted && Boolean(message.body)
      && Date.now() - new Date(message.createdAt).getTime() < EDIT_WINDOW_MS
    const menuOpen = menuFor === message.id
    const grouped = groupedBefore(message, rows)

    const resolveUrl = (att: ChatAttachment): string | null => attachmentUrls[att.path] ?? null

    return (
      <div
        key={message.id}
        data-mid={message.id}
        className={[
          'chat-bubble-row',
          mine ? 'mine' : 'theirs',
          grouped ? 'grouped' : '',
          highlightId === message.id ? 'flash' : '',
        ].filter(Boolean).join(' ')}
      >
        {!mine && (
          <span className="avatar small" title={message.senderName}>
            {message.senderAvatarUrl
              ? <img src={message.senderAvatarUrl} alt="" loading="lazy"/>
              : initialsFor(message.senderName, '')}
          </span>
        )}
        <div className="chat-msg-stack">
          {!mine && !grouped && (
            <small className="chat-sender">
              {message.senderName}{message.senderUsername && ` · @${message.senderUsername}`}
            </small>
          )}

          {deleted ? (
            <div className={`chat-bubble unsent ${mine ? 'mine' : 'theirs'}`}>
              <p>
                {mine ? 'You unsent a message'
                  : modRemoved ? 'A moderator removed this message'
                  : `${message.senderName} unsent a message`}
              </p>
            </div>
          ) : (
            <div className={`chat-bubble ${mine ? 'mine' : 'theirs'}`}>
              {message.sharedKind ? (
                <ChatSharedCard message={message} onOpen={openSharedCard} />
              ) : null}
              {message.parentMessageId && (
                <button
                  type="button"
                  className="chat-reply-chip"
                  onClick={() => void jumpToMessage(message.parentMessageId!)}
                  aria-label="Jump to the message this replies to"
                >
                  <CornerUpLeft size={12}/>
                  <span className="chat-reply-text">
                    <b>{message.parentAuthorName ?? 'Message'}</b>
                    {message.parentExcerpt ? <i>{message.parentExcerpt}</i> : null}
                  </span>
                </button>
              )}

              {message.body ? (
                <p className="chat-body cc-body">
                  <RichText text={message.body} onMention={onOpenMention} onHashtag={startTagSearch}/>
                </p>
              ) : null}

              {images.length > 0 && (
                <div className={`chat-attachments ${images.length > 1 ? 'grid' : ''}`}>
                  {images.map(att => {
                    const url = resolveUrl(att)
                    return (
                      <button key={att.path} type="button" className="chat-attachment-image"
                        onClick={() => { if (url) setImageOverlay({ url, name: att.name }) }}
                        aria-label={`Open image ${att.name}`}
                      >
                        {url ? <img src={url} alt={att.name}/>
                          : <span className="mini-spinner" role="status" aria-label="Loading image"/>}
                      </button>
                    )
                  })}
                </div>
              )}
              {files.map(att => {
                const url = resolveUrl(att)
                return (
                  <a key={att.path} className="chat-attachment-file" href={url ?? undefined}
                    target="_blank" rel="noopener noreferrer" download={att.name}
                    onClick={event => {
                      if (!url) { event.preventDefault(); notify('The secure link is loading — try again in a second.') }
                    }}>
                    <FileText size={15}/>
                    <span><b>{att.name}</b><i>{formatBytes(att.size)} · download</i></span>
                  </a>
                )
              })}

              <div className="chat-meta-row">
                <small title={new Date(message.createdAt).toLocaleString()}>
                  {relativeTime(message.createdAt)}{message.editedAt ? ' · edited' : ''}{message.pinnedAt ? ' · pinned' : ''}
                </small>
              </div>

              {reactionRows.length > 0 && (
                <div className="chat-reactions">
                  {reactionRows.map(([emoji, ids]) => (
                    <button key={emoji} type="button"
                      className={`chat-reaction ${ids.includes(myId ?? '') ? 'mine' : ''}`}
                      onClick={() => void react(message, emoji)}
                      aria-label={`${emoji} from ${ids.length} ${ids.includes(myId ?? '') ? '— remove your reaction' : '— react too'}`}
                      title={ids.length === 1 ? '1 reaction' : `${ids.length} reactions`}
                    >
                      <span>{emoji}</span><i>{ids.length}</i>
                    </button>
                  ))}
                </div>
              )}

              {menuOpen && (
                <div className="chat-msg-menu" role="menu">
                  {canEdit && (
                    <button type="button" role="menuitem" onClick={() => {
                      setEditing(message); setDraft(message.body); setReplyTo(null)
                      setMenuFor(null); requestAnimationFrame(() => inputRef.current?.focus())
                    }}><Pencil size={13}/> Edit</button>
                  )}
                  {mine && (
                    <button type="button" role="menuitem" onClick={() => { setMenuFor(null); void unsend(message) }}>
                      <Trash2 size={13}/> Unsend
                    </button>
                  )}
                  {isModerator && !message.deletedAt && (
                    <button type="button" role="menuitem" onClick={() => { setMenuFor(null); void togglePin(message) }}>
                      {message.pinnedAt ? 'Unpin message' : 'Pin message'}
                    </button>
                  )}
                  {isModerator && !mine && (
                    <button type="button" role="menuitem" onClick={() => { setMenuFor(null); void moderatorRemove(message) }}>
                      <Trash2 size={13}/> Remove from chat
                    </button>
                  )}
                  {(message.replyCount > 0 || message.parentMessageId) && (
                    <button type="button" role="menuitem" onClick={() => void openThread(message)}>
                      <MessageSquare size={13}/> View thread
                    </button>
                  )}
                  {!mine && (
                    <button type="button" role="menuitem" onClick={() => {
                      setMenuFor(null)
                      setReportTarget({
                        label: 'this message',
                        reportedUserId: message.senderId,
                        excerpt: message.body || `[attachment] ${attachments.map(a => a.name).join(', ')}`,
                      })
                    }}>
                      Report message
                    </button>
                  )}
                </div>
              )}

              {pickerFor === message.id && (
                <div className="cc-reaction-picker" role="menu" aria-label="Pick a reaction">
                  {REACTIONS.map(emoji => (
                    <button key={emoji} type="button" role="menuitem"
                      onClick={() => { setPickerFor(null); void react(message, emoji) }}>{emoji}</button>
                  ))}
                </div>
              )}
            </div>
          )}

          {!deleted && (
            <div className="cc-actions">
              <button type="button" className="cc-chip" aria-label="Add a reaction"
                onClick={() => { setPickerFor(pickerFor === message.id ? null : message.id); setMenuFor(null) }}>
                <SmilePlus size={14}/>
              </button>
              <button type="button" className="cc-chip" aria-label="Reply"
                onClick={() => { setReplyTo(message); setEditing(null); setMenuFor(null); inputRef.current?.focus() }}>
                <Reply size={14}/>
              </button>
              {(message.replyCount > 0 || message.parentMessageId) && (
                <button type="button" className="cc-chip" aria-label="View thread"
                  onClick={() => void openThread(message)}>
                  <MessageSquare size={13}/>
                  {message.replyCount > 0 ? <i>{message.replyCount}</i> : null}
                </button>
              )}
              {message.body && (
                <button type="button" className="cc-chip" aria-label="Copy message text"
                  onClick={() => {
                    void navigator.clipboard.writeText(message.body)
                      .then(() => notify('Message text copied.'))
                      .catch(() => notify('Your browser blocked copying — select the text instead.'))
                  }}>
                  Copy
                </button>
              )}
              <button type="button" className="cc-chip" aria-label="More actions"
                onClick={() => { setMenuFor(menuOpen ? null : message.id); setPickerFor(null) }}>
                <Plus size={14}/>
              </button>
            </div>
          )}
        </div>
      </div>
    )
  }

  return (
    <section className="community-chat cc-root" aria-label="Community chat">
      <header className="cc-head">
        <button className="cc-head-btn" aria-expanded={searchOpen}
          onClick={() => { setSearchOpen(v => !v); setMenuFor(null); setPickerFor(null) }}>
          <Search size={15}/> <span>Search</span>
        </button>
        {threadRoot && (
          <button className="cc-head-btn" onClick={closeThread}>
            <MessageSquare size={15}/> <span>In thread</span>
          </button>
        )}
      </header>

      {pins.length > 0 && !threadRoot && (
        <div className="cc-pins">
          <MessageSquare size={13}/>
          <button className="cc-pin" onClick={() => void jumpToMessage(pins[0].id)}>
            <b>{pins[0].senderName}</b>
            <i>{pins[0].body ? pins[0].body.slice(0, 90) : '(attachment)'}</i>
          </button>
          {pins.length > 1 && <span className="cc-pin-count">{pins.length} pinned</span>}
        </div>
      )}

      {searchOpen && !threadRoot && (
        <div className="cc-search" role="search">
          <div className="cc-search-inputs">
            <input value={searchTag} onChange={event => setSearchTag(event.target.value.replace(/[^\w#-]/g, '').slice(0, 31))}
              placeholder="#tag" aria-label="Filter by hashtag"/>
            <input value={searchInput} onChange={event => setSearchInput(event.target.value.slice(0, 60))}
              placeholder="Words or a person's name" aria-label="Search this chat"/>
            <button className="cc-head-btn" aria-label="Close search"
              onClick={() => { setSearchOpen(false); setSearchInput(''); setSearchTag(''); setSearchResults([]) }}>
              <X size={15}/>
            </button>
          </div>
          <div className="cc-search-results">
            {searching && <div className="chats-hint"><span className="mini-spinner"/>Searching this community's chat…</div>}
            {searchError && <div className="chats-hint error">{searchError}</div>}
            {!searching && !searchError && !searchResults.length && (searchInput.trim() || searchTag) && (
              <div className="chats-hint">Nothing in this community's chat matches. Search stays inside this chat.</div>
            )}
            {searchResults.map(hit => (
              <button key={hit.id} type="button" className="cc-search-hit"
                onClick={() => { setSearchOpen(false); setSearchInput(''); setSearchTag(''); void jumpToMessage(hit.id) }}>
                {hit.senderAvatarUrl
                  ? <img className="avatar small" src={hit.senderAvatarUrl} alt=""/>
                  : <span className="avatar small">{initialsFor(hit.senderName, '')}</span>}
                <span className="cc-hit-main">
                  <b>{hit.senderName} <i>{relativeTime(hit.createdAt)}</i></b>
                  <em>{hit.body || (hit.attachments.length ? '(attachment)' : '')}</em>
                </span>
              </button>
            ))}
          </div>
        </div>
      )}

      {/* the stage: main timeline beneath, the thread slides over it while
          the composer stays shared below — replying from a thread works */}
      <div className="cc-stage">
        <div className="chat-scroll" ref={scrollRef} onScroll={onScroll}>
          {loadingThread && <div className="chats-hint"><span className="mini-spinner"/>Loading messages…</div>}
          {loadingOlder && <div className="chats-hint"><span className="mini-spinner"/>Loading earlier messages…</div>}
          {olderAvailable && !loadingOlder && !loadingThread && (
            <button className="link-like cc-load-older" onClick={() => void loadOlder()}>Load earlier messages</button>
          )}

          {!loadingThread && !threadError && messages.length === 0 && (
            <div className="chat-day-start">
              <span>This community shares one room — keep it kind and useful.
                Try @mentions, #hashtags, reactions, replies and attachments.</span>
            </div>
          )}

          {messages.map((message, index) => {
            const previous = messages[index - 1]
            const newDay = !previous || !sameDay(previous.createdAt, message.createdAt)
            return (
              <div key={message.id}>
                {newDay && <div className="cc-day"><span>{dayLabel(message.createdAt)}</span></div>}
                {renderBubble(message)}
              </div>
            )
          })}
        </div>

        {threadRoot && (
          <div className="cc-thread" role="dialog" aria-label="Message thread">
            <header className="cc-thread-head">
              <button aria-label="Back to the main chat" onClick={closeThread}>
                <ArrowLeft size={16}/>
              </button>
              <b>Thread</b>
              <i>{threadMsgs.length} {threadMsgs.length === 1 ? 'reply' : 'replies'}</i>
            </header>
            <div className="chat-scroll cc-thread-scroll">
              {threadLoading && <div className="chats-hint"><span className="mini-spinner"/>Loading thread…</div>}
              {threadRoot && renderBubble(threadRoot, [threadRoot, ...threadMsgs])}
              {!threadLoading && threadMsgs.length === 0 && (
                <div className="chats-hint">No replies yet — use the reply chip below the message.</div>
              )}
              {threadMsgs.map(message => renderBubble(message, [threadRoot!, ...threadMsgs]))}
            </div>
          </div>
        )}

        {!atBottom && (
          <button className="cc-jump" onClick={jumpToLatest} aria-label="Jump to the newest messages">
            <ArrowDown size={15}/>{newBelow > 0 ? <i>{newBelow}</i> : null}
          </button>
        )}
      </div>

      <div className="chat-input-wrap">
        {replyTo && !editing && (
          <div className="cc-context-banner">
            <Reply size={13}/>
            <div><b>Replying to {replyTo.senderName}</b><i>{replyTo.body || '(attachment)'}</i></div>
            <button aria-label="Cancel reply" onClick={() => setReplyTo(null)}><X size={14}/></button>
          </div>
        )}
        {editing && (
          <div className="cc-context-banner">
            <Pencil size={13}/>
            <div><b>Editing your message</b><i>The text updates for everyone.</i></div>
            <button aria-label="Cancel edit" onClick={() => { setEditing(null); setDraft('') }}><X size={14}/></button>
          </div>
        )}
        {pendingFiles.length > 0 && (
          <div className="cc-pending">
            {pendingFiles.map((file, index) => (
              <span key={`${file.name}-${index}`} className="cc-pending-chip">
                {file.type.startsWith('image/') ? <ImageIcon size={12}/> : <FileText size={12}/>}
                <i>{file.name.length > 26 ? `${file.name.slice(0, 24)}…` : file.name}</i>
                <button aria-label={`Remove ${file.name}`}
                  onClick={() => setPendingFiles(list => list.filter((_, i) => i !== index))}>
                  <X size={11}/>
                </button>
              </span>
            ))}
          </div>
        )}
        {uploading && <div className="chats-hint"><span className="mini-spinner"/>{uploading}…</div>}
        {threadError && <div className="chats-hint error">{threadError}</div>}

        {mentionMode && (
          <div className="cc-mentions" role="listbox" aria-label="Community members">
            {mentionTargets.map((target, index) => (
              <button key={target.id} type="button" role="option" aria-selected={index === mentionIndex}
                className={`cc-mention-row ${index === mentionIndex ? 'on' : ''}`}
                onMouseEnter={() => setMentionIndex(index)}
                onClick={() => applyMention(target)}>
                {target.avatarUrl
                  ? <img className="avatar small" src={target.avatarUrl} alt=""/>
                  : <span className="avatar small">{initialsFor(target.displayName, '')}</span>}
                <span className="cc-mention-name"><b>{target.displayName}</b><i>@{target.username}</i></span>
              </button>
            ))}
          </div>
        )}

        <div className="chat-input-row cc-composer">
          <input ref={fileInputRef} type="file" hidden multiple
            accept="image/jpeg,image/png,image/webp,image/gif,application/pdf,text/plain,.doc,.docx,.xls,.xlsx,.ppt,.pptx"
            onChange={event => onPickFiles(event.target.files)}/>
          <button className="chat-attach" aria-label="Attach a file or image"
            disabled={!identity || sending || editing !== null}
            onClick={() => fileInputRef.current?.click()}>
            <Plus size={16}/>
          </button>
          <textarea
            ref={inputRef}
            className="chat-textarea"
            value={draft}
            onChange={event => onComposerChange(event.target.value, event.target.selectionStart)}
            onInput={event => {
              const el = event.currentTarget
              el.style.height = 'auto'
              el.style.height = `${Math.min(el.scrollHeight, 120)}px`
            }}
            onKeyDown={event => {
              if (editing && event.key === 'Escape') { setEditing(null); setDraft(''); return }
              if (mentionMode) {
                if (event.key === 'ArrowDown') { event.preventDefault(); setMentionIndex(i => Math.min(i + 1, mentionTargets.length - 1)); return }
                if (event.key === 'ArrowUp') { event.preventDefault(); setMentionIndex(i => Math.max(i - 1, 0)); return }
                if (event.key === 'Enter' || event.key === 'Tab') {
                  event.preventDefault()
                  applyMention(mentionTargets[mentionIndex] ?? mentionTargets[0])
                  return
                }
                if (event.key === 'Escape') { setMentionQuery(null); setMentionTargets([]); return }
              }
              if (event.key === 'Enter' && !event.shiftKey && !coarsePointer.current) {
                event.preventDefault()
                void send()
              }
            }}
            maxLength={2000}
            rows={1}
            placeholder={identity ? 'Write to the community… @mention · #tag' : 'Sign in to chat'}
            disabled={!identity}
            aria-label={editing ? 'Edit your message' : 'Message the community'}
          />
          <button className="chat-send" aria-label={editing ? 'Save edit' : 'Send message'}
            disabled={!canSend && !editing}
            onClick={() => void send()}>
            {sending ? <span className="mini-spinner"/> : <Send size={17}/>}
          </button>
        </div>
        {draft.length > 1800 && <div className="cc-limit">{draft.length}/2000</div>}
      </div>

      {imageOverlay && (
        <div className="cc-image-overlay"
          onMouseDown={event => { if (event.target === event.currentTarget) setImageOverlay(null) }}>
          <img src={imageOverlay.url} alt={imageOverlay.name}/>
          <div className="cc-image-caption">
            <span>{imageOverlay.name}</span>
            <a href={imageOverlay.url} target="_blank" rel="noopener noreferrer">Open full size</a>
            <button aria-label="Close image" onClick={() => setImageOverlay(null)}><X size={18}/></button>
          </div>
        </div>
      )}

      {reportTarget && (
        <ReportDialog
          target={reportTarget}
          onClose={() => setReportTarget(null)}
          onSubmitted={message => { setReportTarget(null); notify(message) }}
        />
      )}
    </section>
  )
}
