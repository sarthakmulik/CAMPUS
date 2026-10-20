import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import {
  ArrowLeft, Bell, BellOff, Check, ChevronsDown, Download, FileText,
  MessageCircle, Mic, MoreHorizontal, Paperclip, Pencil, Play, Plus, Search, Send,
  Square, Trash2, Users, X,
} from 'lucide-react'
import * as db from '../lib/db'
import type {
  AllChatsSearchHit, ChatAttachment, ChatMessage, ChatSummary,
  ConversationMember,
} from '../lib/db'
import { initialsFor, relativeTime } from '../lib/db'
import ReportDialog from './ReportDialog'
import ChatSharedCard from './chat/ChatSharedCard'

type Identity = { id: string; name: string; username: string; initials: string }

type Props = {
  identity: Identity | null
  configured: boolean
  /** When set, the page boots straight into that conversation (opened from a post's ⋯ menu). */
  autoOpen?: string | null
  onAutoOpened?: () => void
  /** A message prefill for the opened conversation (e.g. Contact Seller) —
   *  the buyer reviews it and hits send themselves; nothing is auto-sent. */
  initialDraft?: string | null
  onDraftConsumed?: () => void
  /** Shared-content cards navigate to profiles through the app shell. */
  onOpenProfile?: (profileId: string) => void
}

const REACTIONS = ['👍', '❤️', '😂', '🎉', '🙏', '🔥', '👀', '💯'] as const

type ListFilter = 'all' | 'unread' | 'groups' | 'archived'

/**
 * Chats — 1:1 direct messages and group chats (never club channels — they
 * live in Communities). Instagram-style: one list, one composer, replies,
 * reactions, media, shared CAMPUS content, read receipts, typing, search,
 * and per-user inbox preferences (0023).
 */
export default function Chats({
  identity, configured, autoOpen, onAutoOpened, initialDraft, onDraftConsumed, onOpenProfile,
}: Props) {
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

  /* inbox: filters + search + per-row menus */
  const [filter, setFilter] = useState<ListFilter>('all')
  const [listQuery, setListQuery] = useState('')
  const [listMenuId, setListMenuId] = useState<string | null>(null)
  const [globalHits, setGlobalHits] = useState<AllChatsSearchHit[] | null>(null)
  const [globalSearching, setGlobalSearching] = useState(false)
  const [globalError, setGlobalError] = useState<string | null>(null)
  const [globalQuery, setGlobalQuery] = useState('')

  /* group creation panel */
  const [groupPanel, setGroupPanel] = useState(false)
  const [groupTitle, setGroupTitle] = useState('')
  const [groupHandle, setGroupHandle] = useState('')
  const [groupMembers, setGroupMembers] = useState<{ id: string; name: string }[]>([])
  const [groupBusy, setGroupBusy] = useState(false)
  const [groupError, setGroupError] = useState<string | null>(null)

  /* message actions + v2 features */
  const [actionsFor, setActionsFor] = useState<string | null>(null)
  const [pickerFor, setPickerFor] = useState<string | null>(null)
  const [editing, setEditing] = useState<{ id: string; original: string } | null>(null)
  const [replyTo, setReplyTo] = useState<ChatMessage | null>(null)
  const [highlightId, setHighlightId] = useState<string | null>(null)

  /* attachments + voice */
  const [pendingAttachments, setPendingAttachments] = useState<ChatAttachment[]>([])
  const [uploadingName, setUploadingName] = useState<string | null>(null)
  const [recording, setRecording] = useState(false)
  const [voiceSeconds, setVoiceSeconds] = useState(0)
  const [voiceError, setVoiceError] = useState<string | null>(null)

  /* forward dialog */
  const [forwardFor, setForwardFor] = useState<ChatMessage | null>(null)
  const [forwardBusy, setForwardBusy] = useState(false)
  const [attachMenuOpen, setAttachMenuOpen] = useState(false)
  const [reportTarget, setReportTarget] = useState<{ label: string; reportedUserId: string; excerpt: string } | null>(null)
  const [listNotice, setListNotice] = useState<string | null>(null)

  /* in-conversation search */
  const [searchOpen, setSearchOpen] = useState(false)
  const [searchQuery, setSearchQuery] = useState('')
  const [searchResults, setSearchResults] = useState<ChatMessage[] | null>(null)
  const [searchBusy, setSearchBusy] = useState(false)
  const [searchError, setSearchError] = useState<string | null>(null)

  /* conversation details (groups + prefs) */
  const [detailsOpen, setDetailsOpen] = useState(false)
  const [members, setMembers] = useState<ConversationMember[]>([])
  const [membersLoading, setMembersLoading] = useState(false)
  const [detailsError, setDetailsError] = useState<string | null>(null)
  const [renaming, setRenaming] = useState(false)
  const [renameValue, setRenameValue] = useState('')
  const [addHandle, setAddHandle] = useState('')
  const [addBusy, setAddBusy] = useState(false)
  const [onlineIds, setOnlineIds] = useState<string[]>([])

  /* typing */
  const [typingPeer, setTypingPeer] = useState(false)

  /* pagination */
  const [hasOlder, setHasOlder] = useState(false)
  const [loadingOlder, setLoadingOlder] = useState(false)

  const seenIds = useRef<Set<string>>(new Set())
  const sendingRef = useRef(false)
  const scrollRef = useRef<HTMLDivElement | null>(null)
  const listBottomRef = useRef<HTMLDivElement | null>(null)
  const photoInputRef = useRef<HTMLInputElement | null>(null)
  const docInputRef = useRef<HTMLInputElement | null>(null)
  const recorderRef = useRef<MediaRecorder | null>(null)
  const voiceChunksRef = useRef<Blob[]>([])
  const voiceTimerRef = useRef<number | null>(null)
  const lastPingRef = useRef(0)
  const typingCtlRef = useRef<{ ping: () => Promise<void>; unsubscribe: () => void } | null>(null)

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

  /* presence: "Online now" — live only, nothing is stored */
  useEffect(() => {
    if (!configured || !identity) return
    const unsubscribe = db.subscribeOnlinePresence(identity.id, ids => setOnlineIds(ids))
    return () => unsubscribe()
  }, [configured, identity?.id])

  const openConversation = useCallback(async (conversationId: string) => {
    setOpenId(conversationId)
    setMobileThread(true)
    setThreadError(null)
    setLoadingThread(true)
    setMessages([])
    setSearchOpen(false)
    setSearchResults(null)
    setSearchQuery('')
    setGlobalHits(null)
    setPendingAttachments([])
    setReplyTo(null)
    setEditing(null)
    setActionsFor(null)
    setPickerFor(null)
    setDetailsOpen(false)
    setEditing(null)
    setReplyTo(null)
    setAttachMenuOpen(false)
    seenIds.current = new Set()
    if (scrollRef.current) scrollRef.current.scrollTop = 0
    try {
      const summary0 = conversations.find(c => c.id === conversationId) ?? null
      const cutoff = summary0?.clearedAt ?? null
      const rows = (await db.fetchChatMessages(conversationId)).filter(m => !cutoff || m.createdAt > cutoff)
      rows.forEach(row => seenIds.current.add(row.id))
      setMessages(rows)
      setHasOlder(rows.length >= 40 && (!cutoff || rows[0].createdAt > cutoff))
      const summary = summary0
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

  /* realtime: new messages in the open thread arrive live; edits/unsends/
     reactions/attachments replace the row in place. Bare payloads carry
     only table columns — persona and quote/previews stay from the held row. */
  useEffect(() => {
    if (!openId) return
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
      isSystem: incoming.isSystem || existing.isSystem,
      sharedKind: existing.sharedKind ?? incoming.sharedKind,
      sharedId: incoming.sharedId ?? existing.sharedId,
      sharedTitle: existing.sharedTitle ?? incoming.sharedTitle,
      sharedSubtitle: existing.sharedSubtitle ?? incoming.sharedSubtitle,
      sharedAuthor: existing.sharedAuthor ?? incoming.sharedAuthor,
      sharedImage: existing.sharedImage ?? incoming.sharedImage,
      sharedSlug: existing.sharedSlug ?? incoming.sharedSlug,
      sharedAvailable: existing.sharedAvailable,
      senderUsername: incoming.senderUsername ?? existing.senderUsername,
      senderName: incoming.senderName && incoming.senderName !== 'Student' ? incoming.senderName : existing.senderName,
      senderAvatarUrl: incoming.senderAvatarUrl ?? existing.senderAvatarUrl,
    })
    const unsubscribe = db.subscribeChatMessages(openId, (message, type) => {
      if (type === 'update') {
        setMessages(list => list.map(item => item.id === message.id ? mergeIncoming(item, message) : item))
        void db.fetchConversations().then(rows => setConversations(rows)).catch(() => {})
        return
      }
      if (seenIds.current.has(message.id)) return
      seenIds.current.add(message.id)
      setMessages(list => {
        const index = list.findIndex(item => item.id === message.id)
        if (index !== -1) {
          const copy = [...list]
          copy[index] = mergeIncoming(copy[index], message)
          return copy
        }
        return [...list, message]
      })
      setHasOlder(current => current || false)
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

  /* typing indicators: one broadcast channel while a thread is open */
  useEffect(() => {
    if (!openId || !identity) return
    const myId = identity.id
    const ctl = db.subscribeTyping(openId, myId, ids => setTypingPeer(ids.length > 0))
    typingCtlRef.current = ctl
    return () => {
      ctl.unsubscribe()
      typingCtlRef.current = null
      setTypingPeer(false)
    }
  }, [openId, identity?.id])

  const pingTyping = () => {
    const now = Date.now()
    if (now - lastPingRef.current < 2000) return
    lastPingRef.current = now
    void typingCtlRef.current?.ping()
  }

  /* the chats list stays live */
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
    if (box && !highlightId) box.scrollTop = box.scrollHeight
  }, [messages.length, loadingThread, openId, highlightId])

  /* jump + highlight (search hits, reply quotes, forward targets) */
  const pendingJumpRef = useRef<string | null>(null)

  const jumpToMessage = useCallback(async (messageId: string) => {
    setHighlightId(null)
    // ensure the message is actually loaded — page back until it is
    if (!messages.some(m => m.id === messageId)) {
      let oldest = messages[0]
      let attempts = 0
      while (oldest && attempts < 10) {
        attempts += 1
        const older = await db.fetchChatMessages(openId!, oldest.createdAt, 40).catch(() => [])
        if (!older.length) break
        oldest = older[0]
        setMessages(list => {
          const known = new Set(list.map(m => m.id))
          const fresh = older.filter(m => !known.has(m.id))
          fresh.forEach(m => seenIds.current.add(m.id))
          return [...fresh, ...list]
        })
        if (older.some(m => m.id === messageId)) break
      }
    }
    // the BubbleRow scrolls itself into view when it sees its id highlighted
    setHighlightId(messageId)
    window.setTimeout(() => setHighlightId(current => current === messageId ? null : current), 2600)
  }, [messages, openId])

  /* a search hit that opened a NEW conversation jumps once its messages land */
  useEffect(() => {
    const target = pendingJumpRef.current
    if (!target || loadingThread || messages.length === 0) return
    pendingJumpRef.current = null
    void jumpToMessage(target)
  }, [loadingThread, messages.length, jumpToMessage])

  /* global (across chats) message search */
  useEffect(() => {
    const raw = globalQuery.trim()
    if (raw.length < 2) { setGlobalHits(null); setGlobalSearching(false); setGlobalError(null); return }
    setGlobalSearching(true)
    const timer = window.setTimeout(() => {
      db.searchAllChats(raw, 30)
        .then(rows => setGlobalHits(rows))
        .catch(error => { setGlobalError(db.friendlyMessage(error)); setGlobalHits(null) })
        .finally(() => setGlobalSearching(false))
    }, 320)
    return () => window.clearTimeout(timer)
  }, [globalQuery])

  /* in-conversation search */
  const runThreadSearch = useCallback(async () => {
    if (!openId) return
    const q = searchQuery.trim()
    if (!q) { setSearchResults(null); setSearchError(null); return }
    setSearchBusy(true)
    setSearchError(null)
    try {
      const hashtag = q.startsWith('#') ? q : ''
      const text = hashtag ? '' : q
      const rows = await db.searchChatMessages(openId, text, hashtag, null)
      setSearchResults(rows)
    } catch (error) {
      setSearchError(db.friendlyMessage(error))
      setSearchResults(null)
    } finally {
      setSearchBusy(false)
    }
  }, [openId, searchQuery])

  const applyPrefs = useCallback(async (conversationId: string, action: db.ConversationPrefAction) => {
    setListError(null)
    try {
      await db.setConversationPrefs(conversationId, action)
      await loadConversations()
    } catch (error) {
      setListError(db.friendlyMessage(error))
    }
  }, [loadConversations])

  const loadOlder = useCallback(async () => {
    if (!openId || loadingOlder) return
    const oldest = messages[0]
    if (!oldest) return
    setLoadingOlder(true)
    try {
      const cutoff = conversations.find(c => c.id === openId)?.clearedAt ?? null
      let older = await db.fetchChatMessages(openId, oldest.createdAt, 40)
      if (cutoff) {
        // "clear chat" hides my history at/before the cutoff — never page past it
        older = older.filter(m => m.createdAt > cutoff)
      }
      if (older.length) {
        older.forEach(m => seenIds.current.add(m.id))
        setMessages(list => [...older.filter(m => !list.some(l => l.id === m.id)), ...list])
        setHasOlder(older.length >= 40 && (!cutoff || older[older.length - 1].createdAt > cutoff))
      } else {
        setHasOlder(false)
      }
    } catch (error) {
      setThreadError(db.friendlyMessage(error))
    } finally {
      setLoadingOlder(false)
    }
  }, [openId, messages, loadingOlder, conversations])

  /* Instagram flows: send / edit / unsend */
  const saveEdit = useCallback(async () => {
    const body = draft.trim()
    if (!editing || !body || sending) return
    setSending(true)
    setThreadError(null)
    try {
      await db.editChatMessage(editing.id, body)
      const at = new Date().toISOString()
      setMessages(list => list.map(item => item.id === editing.id
        ? { ...item, body, editedAt: at } : item))
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
      setMessages(list => list.map(item => item.id === messageId
        ? { ...item, body: '', deletedAt: at, attachments: [], reactions: {} } : item))
      void db.fetchConversations().then(rows => setConversations(rows)).catch(() => {})
    } catch (error) {
      setThreadError(db.friendlyMessage(error))
    }
  }, [])

  /* incoming chat requests */
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
  const active = openId ? conversations.find(c => c.id === openId) ?? peek : null
  const openSummary = active
  const openStatus: 'pending' | 'accepted' | 'declined' | 'unknown' = openSummary?.status ?? 'unknown'
  const openMine = openSummary?.iRequested ?? false
  const myPendingUsed =
    openStatus === 'pending'
    && openMine
    && messages.some(message => message.senderId === identity?.id)
  const sendBlocked =
    openStatus === 'unknown'
    || openStatus === 'declined'
    || (openStatus === 'pending' && !openMine)
    || myPendingUsed

  // Contact Seller prefills a contextual draft — never auto-sent
  useEffect(() => {
    if (initialDraft && !sendBlocked && !draft && pendingAttachments.length === 0) {
      setDraft(initialDraft)
      onDraftConsumed?.()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sendBlocked, initialDraft, draft])

  const uploadingRef = useRef<File | null>(null)

  const handleFiles = useCallback(async (files: FileList | File[], kind: 'media' | 'docs') => {
    if (!openId) return
    setThreadError(null)
    for (const file of Array.from(files)) {
      if (pendingAttachments.length >= 4) { setThreadError('A message can carry at most 4 attachments.'); break }
      uploadingRef.current = file
      setUploadingName(file.name)
      try {
        const attachment = await db.uploadChatAttachment(openId, file)
        setPendingAttachments(list => [...list, attachment])
      } catch (error) {
        setThreadError(db.friendlyMessage(error))
      } finally {
        setUploadingName(null)
        uploadingRef.current = null
      }
    }
    void kind
  }, [openId, pendingAttachments.length])

  /* voice recording: real MediaRecorder, honest support states */
  const startRecording = useCallback(async () => {
    setVoiceError(null)
    if (!(navigator.mediaDevices && window.MediaRecorder)) {
      setVoiceError('This browser cannot record audio — try Chrome, Edge or Firefox.')
      return
    }
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true })
      const mime = MediaRecorder.isTypeSupported('audio/webm;codecs=opus')
        ? 'audio/webm;codecs=opus'
        : MediaRecorder.isTypeSupported('audio/mp4') ? 'audio/mp4' : ''
      const recorder = mime ? new MediaRecorder(stream, { mimeType: mime }) : new MediaRecorder(stream)
      voiceChunksRef.current = []
      recorder.ondataavailable = event => {
        if (event.data && event.data.size > 0) voiceChunksRef.current.push(event.data)
      }
      recorder.onstop = () => {
        stream.getTracks().forEach(track => track.stop())
      }
      recorderRef.current = recorder
      recorder.start(250)
      setRecording(true)
      setVoiceSeconds(0)
      if (voiceTimerRef.current) window.clearInterval(voiceTimerRef.current!)
      voiceTimerRef.current = window.setInterval(() => setVoiceSeconds(s => s + 1), 1000)
    } catch {
      setVoiceError('Microphone permission is needed for voice messages.')
    }
  }, [])

  const cancelRecording = useCallback(() => {
    const recorder = recorderRef.current
    if (recorder && recorder.state !== 'inactive') { recorder.onstop = null; recorder.stop() }
    recorderRef.current = null
    voiceChunksRef.current = []
    setRecording(false)
    setVoiceSeconds(0)
    if (voiceTimerRef.current) { window.clearInterval(voiceTimerRef.current); voiceTimerRef.current = null }
  }, [])

  const sendRecording = useCallback(async () => {
    const recorder = recorderRef.current
    if (!recorder || !openId) { cancelRecording(); return }
    if (recorder.state !== 'inactive') recorder.stop()
    recorderRef.current = null
    const type = recorder.mimeType ?? 'audio/webm'
    const blob = new Blob(voiceChunksRef.current, { type })
    voiceChunksRef.current = []
    if (voiceTimerRef.current) { window.clearInterval(voiceTimerRef.current); voiceTimerRef.current = null }
    setRecording(false)
    setVoiceSeconds(0)
    if (blob.size < 64) { setVoiceError('The recording was empty — try again.'); return }
    if (voiceSeconds < 1) { setVoiceError('Hold the mic for at least a second.'); return }
    const ext = type.includes('mp4') ? '.m4a' : '.webm'
    const file = new File([blob], `voice-${Date.now()}${ext}`, { type: type.split(';')[0] })
    setUploadingName('voice note')
    try {
      const attachment = await db.uploadChatAttachment(openId, file)
      setPendingAttachments(list => [...list, attachment])
    } catch (error) {
      setThreadError(db.friendlyMessage(error))
    } finally {
      setUploadingName(null)
    }
  }, [cancelRecording, openId, voiceSeconds])

  /* content sharing happens FROM the content (Reels, feed, detail pages)
     through the app-level share sheet — the composer never browses content */
  const send = useCallback(async () => {
    if (!openId || sendingRef.current || !identity) return
    if (editing) { void saveEdit(); return }
    if (openStatus === 'unknown' || openStatus === 'declined' || (openStatus === 'pending' && !openMine) || myPendingUsed) return
    const note = draft.trim()
    if (!note && pendingAttachments.length === 0) return
    // synchronous guard: a rapid second tap in the same tick must not
    // queue a second identical message while the first one is in flight
    sendingRef.current = true
    setSending(true)
    setThreadError(null)
    try {
      const sent = await db.sendChatMessage(openId, note, identity.id, {
        parentId: replyTo?.id ?? null,
        attachments: pendingAttachments.length ? pendingAttachments : undefined,
      })
      if (!seenIds.current.has(sent.id)) {
        seenIds.current.add(sent.id)
        setMessages(list => [...list, { ...sent, senderName: identity?.name ?? 'You' }])
      }
      setDraft('')
      setPendingAttachments([])
      setReplyTo(null)
      setConversations(list => list.map(c => c.id === openId
        ? { ...c, lastPreview: lastPreviewFor(sent), lastSenderId: identity.id, lastAt: sent.createdAt, lastSeen: false }
        : c))
    } catch (error) {
      setThreadError(db.friendlyMessage(error))
    } finally {
      sendingRef.current = false
      setSending(false)
    }
  }, [draft, openId, openStatus, openMine, myPendingUsed, editing, saveEdit, identity, replyTo, pendingAttachments])

  const react = useCallback(async (message: ChatMessage, emoji: string) => {
    try {
      const nextReactions = await db.toggleChatReaction(message.id, emoji)
      setMessages(list => list.map(item => item.id === message.id ? { ...item, reactions: nextReactions } : item))
    } catch (error) {
      setThreadError(db.friendlyMessage(error))
    }
  }, [])

  const forwardTo = useCallback(async (message: ChatMessage, targets: string[]) => {
    if (!targets.length) return
    setForwardBusy(true)
    const names = new Map(targets.map(id => [id, conversations.find(c => c.id === id)?.peerName ?? 'a chat']))
    const errors: string[] = []
    for (const targetId of targets) {
      try {
        if (message.attachments.length > 0) {
          const copied = await db.copyChatAttachments(message.attachments, targetId)
          await db.forwardChatMessage(message.id, targetId, copied)
        } else {
          await db.forwardChatMessage(message.id, targetId)
        }
      } catch (error) {
        errors.push(`${names.get(targetId)}: ${db.friendlyMessage(error)}`)
      }
    }
    setForwardBusy(false)
    if (errors.length) {
      setThreadError(`Not forwarded — ${errors.join(' · ')}`)
    } else {
      setForwardFor(null)
      setListNotice(`Forwarded to ${targets.length} ${targets.length === 1 ? 'chat' : 'chats'}.`)
    }
  }, [conversations])

  /* group management */
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

  const loadMembers = useCallback(async (conversationId: string) => {
    setMembersLoading(true)
    setDetailsError(null)
    try {
      setMembers(await db.fetchConversationMembers(conversationId))
    } catch (error) {
      setDetailsError(db.friendlyMessage(error))
    } finally {
      setMembersLoading(false)
    }
  }, [])

  useEffect(() => {
    if (detailsOpen && openId) void loadMembers(openId)
  }, [detailsOpen, openId, loadMembers])

  const addMemberToOpenGroup = useCallback(async () => {
    if (!openId) return
    const raw = db.normalizeUsername(addHandle)
    if (!raw) return
    setAddBusy(true)
    setDetailsError(null)
    try {
      const id = await db.findProfileIdByUsername(raw)
      if (!id) { setDetailsError(`No member found as @${raw}.`); return }
      const added = await db.addGroupMembers(openId, [id])
      if (!added) { setDetailsError(`@${raw} is already in this group.`) }
      setAddHandle('')
      await loadMembers(openId)
      void loadConversations()
    } catch (error) {
      setDetailsError(db.friendlyMessage(error))
    } finally {
      setAddBusy(false)
    }
  }, [openId, addHandle, loadMembers, loadConversations])

  const removeMemberFromOpenGroup = useCallback(async (userId: string) => {
    if (!openId) return
    setDetailsError(null)
    try {
      await db.removeGroupMember(openId, userId)
      await loadMembers(openId)
    } catch (error) {
      setDetailsError(db.friendlyMessage(error))
    }
  }, [openId, loadMembers])

  const leaveOpenGroup = useCallback(async () => {
    if (!openId) return
    setDetailsError(null)
    try {
      await db.leaveGroup(openId)
      setDetailsOpen(false)
      setOpenId(null)
      setMobileThread(false)
      await loadConversations()
    } catch (error) {
      setDetailsError(db.friendlyMessage(error))
    }
  }, [openId, loadConversations])

  const renameOpenGroup = useCallback(async () => {
    if (!openId || !renameValue.trim()) return
    setDetailsError(null)
    try {
      const title = await db.renameGroup(openId, renameValue.trim())
      setRenaming(false)
      if (title) { setPeerName(title); void loadConversations() }
    } catch (error) {
      setDetailsError(db.friendlyMessage(error))
    }
  }, [openId, renameValue, loadConversations])

  /* shared-card navigation: real deep links already exist in the app shell */
  const openSharedCard = useCallback((message: ChatMessage) => {
    if (!message.sharedKind || !message.sharedId) return
    if (message.sharedKind === 'profile') {
      if (onOpenProfile) onOpenProfile(message.sharedId)
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
  }, [onOpenProfile])

  /* ---- inbox filters + search -------------------------------------------- */

  const visibleConversations = conversations.filter(c => {
    if (filter === 'archived') return c.archived
    if (c.archived) return false
    if (filter === 'unread') return c.unread > 0
    if (filter === 'groups') return c.kind === 'group'
    return true
  }).filter(c => {
    const q = listQuery.trim().toLowerCase()
    if (!q) return true
    return c.peerName.toLowerCase().includes(q) || (c.peerUsername ?? '').toLowerCase().includes(q)
  })

  const totalUnread = conversations.reduce((sum, c) => sum + (c.archived ? 0 : c.unread), 0)

  /* receipts on my own newest message */
  const lastMineMessage = [...messages].reverse().find(m => m.senderId === identity?.id && !m.deletedAt)

  const isGroup = active?.kind === 'group'
  const myMembershipRole = members.find(m => m.id === identity?.id)?.role ?? null
  const isGroupAdmin = Boolean(isGroup && (myMembershipRole === 'admin'))
  const peerOnline = Boolean(
    active?.kind === 'dm' && active.peerId && onlineIds.includes(active.peerId)
  )

  /* ---- empty / gated states ---------------------------------------------- */

  if (!configured) {
    return <section className="section-page"><div className="section-hero-icon"><MessageCircle size={27}/></div><span className="eyebrow">CAMPUS / CHATS</span><h2>Your conversations</h2><p>CAMPUS is not connected to its database yet, so chats are unavailable right now.</p></section>
  }

  if (!identity) {
    return <section className="section-page"><div className="section-hero-icon"><MessageCircle size={27}/></div><span className="eyebrow">CAMPUS / CHATS</span><h2>Your conversations</h2><p>Chats open once your member profile is loaded.</p></section>
  }

  const myId = identity.id

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

        <div className="chats-global-search">
          <Search size={15}/>
          <input
            placeholder="Search messages in all your chats…"
            value={globalQuery}
            maxLength={60}
            onChange={event => setGlobalQuery(event.target.value)}
          />
          {globalQuery && (
            <button className="icon-button" aria-label="Clear search" onClick={() => setGlobalQuery('')}><X size={13}/></button>
          )}
        </div>

        {globalHits !== null && (
          <div className="chats-global-results">
            {globalSearching && <div className="chats-hint"><span className="mini-spinner"/>Searching…</div>}
            {!globalSearching && globalError && <div className="chats-hint error">{globalError}</div>}
            {!globalSearching && !globalError && globalHits.length === 0 && (
              <div className="chats-hint">No messages match “{globalQuery}”.</div>
            )}
            {globalHits.map(hit => (
              <button
                key={hit.messageId}
                className="chats-global-hit"
                onClick={() => {
                  setGlobalHits(null)
                  setGlobalQuery('')
                  pendingJumpRef.current = hit.messageId
                  void openConversation(hit.conversationId)
                }}
              >
                <span className="avatar small">{initialsFor(hit.senderName, '')}</span>
                <span className="chats-global-hit-copy">
                  <b>{hit.conversationTitle}</b>
                  <small><b>{hit.senderName}</b> {hit.body.slice(0, 80)}</small>
                </span>
                <small>{relativeTime(hit.createdAt)}</small>
              </button>
            ))}
          </div>
        )}

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

        <div className="chats-filters" role="tablist" aria-label="Conversation filters">
          {([
            ['all', `All${totalUnread ? ` (${conversations.filter(c => !c.archived && c.unread > 0).length})` : ''}`],
            ['unread', 'Unread'],
            ['groups', 'Groups'],
            ['archived', 'Archived'],
          ] as [ListFilter, string][]).map(([key, label]) => (
            <button key={key} className={`chats-filter-chip ${filter === key ? 'active' : ''}`} onClick={() => setFilter(key)}>{label}</button>
          ))}
          <input
            className="chats-filter-input"
            placeholder="Find a chat…"
            value={listQuery}
            maxLength={40}
            onChange={event => setListQuery(event.target.value)}
          />
        </div>

        {listNotice && (
          <div className="chats-hint ok" role="status">
            {listNotice}
            <button className="link-button" onClick={() => setListNotice(null)}>OK</button>
          </div>
        )}

        {loadingList && <div className="chats-hint"><span className="mini-spinner"/>Loading conversations…</div>}
        {!loadingList && listError && (
          <div className="chats-hint error">{listError} <button className="link-button" onClick={() => void loadConversations()}>Retry</button></div>
        )}
        {!loadingList && !listError && visibleConversations.length === 0 && !groupPanel && globalHits === null && (
          <div className="chats-empty">
            <MessageCircle size={34}/>
            <b>{filter === 'archived' ? 'No archived chats' : filter === 'unread' ? 'Nothing unread' : filter === 'groups' ? 'No group chats yet' : 'No conversations yet'}</b>
            <p>Open the ⋯ menu on any post and choose “Message author”, send a reel from Discover, or tap New group up top.</p>
          </div>
        )}

        <div className="chats-list">
          {visibleConversations.map(conversation => (
            <div
              key={conversation.id}
              className={`chat-row-wrap ${openId === conversation.id ? 'active' : ''}`}
            >
              <button
                className={`chat-row ${openId === conversation.id ? 'active' : ''}`}
                onContextMenu={event => { event.preventDefault(); setListMenuId(conversation.id) }}
                onClick={() => void openConversation(conversation.id)}
                onAuxClick={event => { if (event.button === 1) { event.preventDefault(); setListMenuId(conversation.id) } }}
              >
                {conversation.peerAvatar
                  ? <img className={`avatar ${conversation.kind === 'group' ? 'group' : ''}`} src={conversation.peerAvatar} alt=""/>
                  : <span className={`avatar ${conversation.kind === 'group' ? 'group' : ''}`}>{initialsFor(conversation.peerName, conversation.peerUsername)}</span>}
                <span className="chat-row-copy">
                  <b>
                    {conversation.peerName}
                    {conversation.pinned && <i className="dm-row-flag" title="Pinned">⌐</i>}
                    {conversation.muted && <BellOff size={11} aria-label="Muted" className="dm-row-muted"/>}
                  </b>
                  <small>{previewFor(conversation, myId)}</small>
                </span>
                <span className="chat-row-meta">
                  {conversation.status === 'pending' && <i className="request-tag">{conversation.iRequested ? 'Sent' : 'Request'}</i>}
                  {conversation.status === 'declined' && <i className="request-tag declined-tag">Declined</i>}
                  <small>{conversation.lastAt ? relativeTime(conversation.lastAt) : ''}</small>
                  {conversation.unread > 0 && <i className="unread-pill">{conversation.unread}</i>}
                </span>
              </button>
              <button
                className="chat-row-menu"
                aria-label={`Options for ${conversation.peerName}`}
                onClick={() => setListMenuId(current => current === conversation.id ? null : conversation.id)}
              >
                <MoreHorizontal size={14}/>
              </button>
              {listMenuId === conversation.id && (
                <div className="chat-msg-menu dm-list-menu" onMouseLeave={() => setListMenuId(null)}>
                  <button onClick={() => { setListMenuId(null); void applyPrefs(conversation.id, conversation.pinned ? 'unpin' : 'pin') }}>
                    <ChevronsDown size={13}/> {conversation.pinned ? 'Unpin' : 'Pin to top'}
                  </button>
                  <button onClick={() => { setListMenuId(null); void applyPrefs(conversation.id, conversation.muted ? 'unmute' : 'mute') }}>
                    {conversation.muted ? <Bell size={13}/> : <BellOff size={13}/>} {conversation.muted ? 'Unmute' : 'Mute'}
                  </button>
                  <button onClick={() => { setListMenuId(null); void applyPrefs(conversation.id, conversation.archived ? 'unarchive' : 'archive') }}>
                    <Download size={13}/> {conversation.archived ? 'Unarchive' : 'Archive'}
                  </button>
                  <button onClick={() => { setListMenuId(null); void applyPrefs(conversation.id, 'mark_unread') }}>
                    <MessageCircle size={13}/> Mark as unread
                  </button>
                  <button className="danger" onClick={() => { setListMenuId(null); void applyPrefs(conversation.id, 'clear') }}>
                    <Trash2 size={13}/> Clear for me
                  </button>
                </div>
              )}
            </div>
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
              {openSummary?.peerAvatar
                ? <img className="avatar small" src={openSummary.peerAvatar} alt=""/>
                : <span className="avatar small">{initialsFor(peerName, active?.peerUsername ?? '')}</span>}
              <div className="chat-thread-head-copy">
                <b>{peerName}</b>
                <span className="chat-sub">
                  {peerOnline ? <><i className="dm-online-dot" aria-hidden="true"/>Online</>
                    : isGroup ? `group${active && active.memberCount > 0 ? ` · ${active.memberCount}` : ''}` + (typingPeer ? ' · typing…' : '')
                    : typingPeer ? 'typing…'
                    : 'direct message'}
                </span>
              </div>
              <button
                className="icon-button"
                aria-label={searchOpen ? 'Close search' : 'Search this chat'}
                onClick={() => { setSearchOpen(v => !v); setSearchResults(null); setSearchQuery(''); setSearchError(null) }}
              ><Search size={16}/></button>
              <button className="icon-button" aria-label="Conversation details" onClick={() => setDetailsOpen(true)}><MoreHorizontal size={16}/></button>
            </div>

            {searchOpen && (
              <div className="chat-search-bar">
                <input
                  placeholder="Search this chat — a word, a name or a #tag…"
                  value={searchQuery}
                  maxLength={60}
                  onChange={event => setSearchQuery(event.target.value)}
                  onKeyDown={event => { if (event.key === 'Enter') { event.preventDefault(); void runThreadSearch() } }}
                  autoFocus
                />
                <button className="text-button" onClick={() => void runThreadSearch()} disabled={searchBusy}>
                  {searchBusy ? <span className="mini-spinner"/> : 'Find'}
                </button>
                {searchResults && (
                  <button className="link-button" onClick={() => { setSearchResults(null); setSearchQuery('') }}>Clear</button>
                )}
              </div>
            )}

            {searchOpen && searchResults !== null && (
              <div className="chat-search-results">
                {searchResults.length === 0 && !searchBusy && <div className="chats-hint">No messages match in this chat.</div>}
                {searchResults.map(hit => (
                  <button key={hit.id} className="chat-search-hit" onClick={() => { void jumpToMessage(hit.id); setSearchResults(null) }}>
                    <span className="avatar small">{initialsFor(hit.senderName, '')}</span>
                    <span className="chat-search-hit-copy">
                      <b>{hit.senderName}</b>
                      <small>{hit.body || `Sent ${hit.sharedKind ?? 'an attachment'}`}</small>
                    </span>
                    <small>{relativeTime(hit.createdAt)}</small>
                  </button>
                ))}
              </div>
            )}

            <div className="chat-scroll" ref={scrollRef}>
              {hasOlder && !loadingThread && (
                <button className="chat-load-older" onClick={() => void loadOlder()} disabled={loadingOlder}>
                  {loadingOlder ? <span className="mini-spinner"/> : <ChevronsDown size={14}/>} Load earlier messages
                </button>
              )}
              {loadingThread && <div className="chats-hint"><span className="mini-spinner"/>Loading messages…</div>}
              {threadError && <div className="chats-hint error">{threadError}</div>}
              {!loadingThread && !threadError && messages.length === 0 && (
                <div className="chat-day-start">
                  <span>{isGroup ? `This is the start of ${peerName}. Keep it kind.` : `This is the beginning of your chat with ${peerName}. Keep it kind.`}</span>
                </div>
              )}
              {messages.map(message => {
                const mine = message.senderId === myId
                return (
                  <BubbleRow
                    key={message.id}
                    message={message}
                    mine={mine}
                    system={message.isSystem}
                    isGroup={Boolean(isGroup)}
                    highlightId={highlightId}
                    myId={myId}
                    peerName={peerName}
                    actionsFor={actionsFor}
                    pickerFor={pickerFor}
                    onOpenContextMenu={(id) => { setActionsFor(id); setPickerFor(null) }}
                    onTogglePicker={(id) => { setPickerFor(current => current === id ? null : id); setActionsFor(null) }}
                    onMenuClose={() => { setActionsFor(null); setPickerFor(null) }}
                    onReply={(m) => { setReplyTo(m); setActionsFor(null) }}
                    onReact={react}
                    onForward={m => setForwardFor(m)}
                    onEdit={(m) => { setEditing({ id: m.id, original: m.body }); setDraft(m.body); setActionsFor(null) }}
                    onUnsend={(id) => { setActionsFor(null); setEditing(null); setDraft(''); void unsendMessage(id) }}
                    onReport={(m) => {
                      setActionsFor(null)
                      setReportTarget({
                        label: m.senderId === myId ? 'this message' : `this message from ${m.senderName}`,
                        reportedUserId: m.senderId ?? '',
                        excerpt: m.body.slice(0, 200),
                      })
                    }}
                    onCopy={async (text) => {
                      const failure = await db.copyToClipboard(text)
                      if (failure) setThreadError(failure)
                      else setThreadError(null)
                    }}
                    onOpen={m => void jumpToMessage(m.id)}
                    onOpenShared={openSharedCard}
                  />
                )
              })}
              {messageReceiptSlot(lastMineMessage, identity)}
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

            <div className="chat-compose">
              {(editing || replyTo) && (
                <div className="chat-compose-context">
                  {editing ? (
                    <span>Editing a message</span>
                  ) : replyTo ? (
                    <button className="chat-reply-context" onClick={() => void jumpToMessage(replyTo.id)}>
                      <span className="chat-reply-line" aria-hidden="true"/>
                      <span>
                        <b>Replying to {replyTo.senderId === myId ? 'yourself' : replyTo.senderName}</b>
                        <small>{composeQuote(replyTo)}</small>
                      </span>
                    </button>
                  ) : null}
                  <button
                    aria-label="Cancel"
                    onClick={() => { if (editing) setEditing(null); else setReplyTo(null); setDraft('') }}
                  ><X size={14}/></button>
                </div>
              )}

              {pendingAttachments.length > 0 && (
                <div className="chat-attach-strip" aria-label="Attachments to send">
                  {pendingAttachments.map(att => (
                    <span key={att.path} className={`chat-attach-chip ${att.mime.startsWith('image/') ? 'image' : att.mime.startsWith('audio/') ? 'audio' : att.mime.startsWith('video/') ? 'video' : 'file'}`}>
                      {att.mime.startsWith('image/') ? <span className="ch-icon" aria-hidden="true">🖼️</span>
                        : att.mime.startsWith('video/') ? <Play size={12}/>
                        : att.mime.startsWith('audio/') ? <Mic size={12}/>
                        : <FileText size={12}/>}
                      <small>{att.name}</small>
                      <button onClick={() => setPendingAttachments(list => list.filter(a => a.path !== att.path))} aria-label={`Remove ${att.name}`}><X size={12}/></button>
                    </span>
                  ))}
                </div>
              )}

              <div className="chat-toolbar-row">
                <div className="chat-attach-menu-root">
                  <button
                    className="icon-button chat-tool"
                    aria-label="Attach"
                    onClick={() => setAttachMenuOpen(v => !v)}
                  ><Paperclip size={17}/></button>
                  {attachMenuOpen && (
                    <div className="chat-msg-menu dm-attach-menu" onMouseLeave={() => setAttachMenuOpen(false)}>
                      <button onClick={() => { setAttachMenuOpen(false); photoInputRef.current?.click() }}>
                        <Plus size={13}/> Photo / video
                      </button>
                      <button onClick={() => { setAttachMenuOpen(false); docInputRef.current?.click() }}>
                        <FileText size={13}/> Document
                      </button>
                      <button onClick={() => { setAttachMenuOpen(false); void startRecording(); }}>
                        <Mic size={13}/> Voice message
                      </button>
                    </div>
                  )}
                </div>

                {recording ? (
                  <>
                    <button className="chat-send voice" aria-label="Cancel recording" onClick={() => cancelRecording()}><Square size={14}/></button>
                    <input
                      value={`Recording voice note… ${voiceSeconds}s`}
                      readOnly
                      className="chat-voice-display"
                      aria-label="Recording"
                    />
                  </>
                ) : (
                  <input
                    value={draft}
                    onChange={event => { setDraft(event.target.value); pingTyping() }}
                    onKeyDown={event => {
                      if (event.key === 'Escape' && (editing || replyTo)) { setEditing(null); setReplyTo(null); setDraft(''); return }
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
                )}
                <button
                  className="chat-send"
                  aria-label={editing ? 'Save edited message' : sending ? 'Sending' : recording ? 'Send voice note' : 'Send message'}
                  disabled={
                    sending
                    || sendBlocked && !editing
                    || recording ? false : (!draft.trim() && pendingAttachments.length === 0)
                  }
                  onClick={() => { if (recording) void sendRecording(); else void send() }}
                >
                  {sending ? <span className="mini-spinner"/> : <Send size={17}/>}
                </button>
              </div>
              {(voiceError || uploadingName) && (
                <div className="chats-hint error" role="status">
                  {voiceError ?? `Uploading ${uploadingName}…`}
                  {voiceError && <button className="link-button" onClick={() => setVoiceError(null)}>Dismiss</button>}
                </div>
              )}
            </div>
            {threadError && <button className="chat-clear-error" onClick={() => setThreadError(null)} aria-label="Dismiss error"><X size={14}/></button>}

            <input
              ref={photoInputRef}
              type="file"
              accept="image/*,video/*"
              multiple
              hidden
              onChange={event => { void handleFiles(event.target.files ?? [], 'media'); event.target.value = '' }}
            />
            <input
              ref={docInputRef}
              type="file"
              accept=".pdf,.doc,.docx,.xls,.xlsx,.ppt,.pptx,.txt"
              multiple
              hidden
              onChange={event => { void handleFiles(event.target.files ?? [], 'docs'); event.target.value = '' }}
            />
          </>
        )}
      </div>

      {/* conversation details sheet (groups + per-user prefs) */}
      {detailsOpen && openId && openSummary && (
        <div className="overlay" onMouseDown={event => { if (event.target === event.currentTarget) setDetailsOpen(false) }}>
          <section className="dm-details-modal" role="dialog" aria-modal="true">
            <button className="modal-close icon-button" onClick={() => setDetailsOpen(false)} aria-label="Close"><X size={20}/></button>
            <h2>Chat details</h2>
            {isGroup ? (
              <>
                {renaming ? (
                  <div className="dm-rename-row">
                    <input
                      value={renameValue}
                      maxLength={60}
                      placeholder={peerName}
                      onChange={event => setRenameValue(event.target.value)}
                      onKeyDown={event => { if (event.key === 'Enter') { event.preventDefault(); void renameOpenGroup() } }}
                    />
                    <button className="primary-button" onClick={() => void renameOpenGroup()} disabled={!renameValue.trim()}>Save</button>
                    <button className="secondary-button" onClick={() => setRenaming(false)}>Cancel</button>
                  </div>
                ) : (
                  <div className="dm-details-head">
                    <span className="avatar group">{initialsFor(peerName, '')}</span>
                    <div>
                      <b>{peerName}</b><br/>
                      <button className="link-button" onClick={() => { if (isGroupAdmin) { setRenaming(true); setRenameValue(peerName) } else setDetailsError('Only the group admin can rename the group.') }}>
                        {isGroupAdmin ? 'Rename group' : 'Group (admin: rename)'}
                      </button>
                    </div>
                  </div>
                )}

                {isGroupAdmin && (
                  <div className="dm-add-row">
                    <input
                      placeholder="Add member by @username"
                      value={addHandle}
                      maxLength={40}
                      onChange={event => setAddHandle(event.target.value)}
                      onKeyDown={event => { if (event.key === 'Enter') { event.preventDefault(); void addMemberToOpenGroup() } }}
                    />
                    <button className="primary-button" onClick={() => void addMemberToOpenGroup()} disabled={addBusy || !addHandle.trim()}>
                      {addBusy ? <span className="mini-spinner"/> : 'Add'}
                    </button>
                  </div>
                )}

                {membersLoading && <div className="chats-hint"><span className="mini-spinner"/>Loading members…</div>}
                {detailsError && <div className="chats-hint error">{detailsError} <button className="link-button" onClick={() => void loadMembers(openId)}>Retry</button></div>}
                <div className="dm-member-list">
                  {members.map(member => (
                    <div key={member.id} className="dm-member-row">
                      {member.avatarUrl ? <img className="avatar small" src={member.avatarUrl} alt=""/> : <span className="avatar small">{initialsFor(member.displayName, member.username)}</span>}
                      <span className="dm-member-copy">
                        <b>{member.displayName}{member.id === myId ? ' (you)' : ''}</b>
                        <small>{member.username ? `@${member.username}` : 'Member'}{member.role === 'admin' ? ' · admin' : ''}</small>
                      </span>
                      {isGroupAdmin && member.id !== myId && (
                        <button className="link-button danger" onClick={() => void removeMemberFromOpenGroup(member.id)} aria-label={`Remove ${member.displayName}`}>
                          Remove
                        </button>
                      )}
                    </div>
                  ))}
                </div>
                <div className="wizard-actions inline">
                  <button className="secondary-button" onClick={() => void leaveOpenGroup()}>Leave group</button>
                </div>
              </>
            ) : (
              <div className="dm-details-col">
                <div className="dm-details-head">
                  {active?.peerId && active.peerAvatar
                    ? <img className="avatar group" src={active.peerAvatar} alt=""/>
                    : <span className="avatar group">{initialsFor(peerName, active?.peerUsername ?? '')}</span>}
                  <div>
                    <b>{peerName}</b><br/>
                    <small className="chat-sub">{active?.peerUsername ? `@${active.peerUsername}` : ''}{peerOnline ? ' · Online now' : ''}</small>
                  </div>
                </div>
                <div className="dm-pref-actions">
                  <button className="secondary-button" onClick={() => void applyPrefs(openId, active?.muted ? 'unmute' : 'mute')}>
                    {active?.muted ? <><Bell size={14}/> Unmute</> : <><BellOff size={14}/> Mute</>}
                  </button>
                  <button className="secondary-button" onClick={() => void applyPrefs(openId, active?.pinned ? 'unpin' : 'pin')}>
                    {active?.pinned ? 'Unpin from top' : 'Pin to top'}
                  </button>
                  <button className="secondary-button" onClick={() => void applyPrefs(openId, active?.archived ? 'unarchive' : 'archive')}>
                    {active?.archived ? 'Unarchive' : 'Archive'}
                  </button>
                  <button className="secondary-button" onClick={() => void applyPrefs(openId, 'mark_unread')}>Mark as unread</button>
                  <button className="secondary-button danger" onClick={() => void applyPrefs(openId, 'clear').then(() => { setDetailsOpen(false); setOpenId(null); setMobileThread(false) })}>
                    <Trash2 size={14}/> Clear chat for me
                  </button>
                </div>
              </div>
            )}
          </section>
        </div>
      )}

      {/* forward dialog */}
      {forwardFor && (
        <ForwardDialog
          message={forwardFor}
          conversations={conversations.filter(c => c.status === 'accepted' && c.id !== openId && !c.archived)}
          busy={forwardBusy}
          onClose={() => setForwardFor(null)}
          onSend={targets => void forwardTo(forwardFor, targets)}
        />
      )}

      {/* report a message (its author) through the platform report flow */}
      {reportTarget && (
        <ReportDialog
          target={{ label: reportTarget.label, reportedUserId: reportTarget.reportedUserId, excerpt: reportTarget.excerpt }}
          onClose={() => setReportTarget(null)}
          onSubmitted={message => { setReportTarget(null); setThreadError(null); setListNotice(message) }}
        />
      )}
    </section>
  )
}

/* small helpers at module scope ------------------------------------------------- */

/** message type → human labeler used by the list preview */
function lastPreviewFor(message: ChatMessage): string {
  if (message.deletedAt) return 'Message unsent'
  if (message.isSystem) return message.body
  if (message.sharedKind) return `Sent a ${message.sharedKind}`
  const mime = message.attachments[0]?.mime ?? ''
  if (message.attachments.length > 0 && !message.body) {
    if (mime.startsWith('image/')) return 'Sent a photo'
    if (mime.startsWith('video/')) return 'Sent a video'
    if (mime.startsWith('audio/')) return 'Sent a voice message'
    return 'Sent a file'
  }
  return message.body
}

function previewFor(conversation: ChatSummary, myId: string): string {
  const open = conversation.lastPreview?.trim()
  if (!open) return conversation.kind === 'group' ? 'No messages yet — get the group going' : 'Say hi — no messages yet'
  if (conversation.lastSenderId === myId) return `You: ${open}`
  return open
}

/** one bubble row with hover + long-press menus */
function BubbleRow({
  message,
  mine,
  system,
  isGroup,
  highlightId,
  myId,
  peerName,
  actionsFor,
  pickerFor,
  onOpenContextMenu,
  onTogglePicker,
  onMenuClose,
  onReply,
  onReact,
  onForward,
  onEdit,
  onUnsend,
  onReport,
  onCopy,
  onOpen,
  onOpenShared,
}: {
  message: ChatMessage
  mine: boolean
  system: boolean
  isGroup: boolean
  highlightId: string | null
  myId: string
  peerName: string
  actionsFor: string | null
  pickerFor: string | null
  onOpenContextMenu: (id: string) => void
  onTogglePicker: (id: string) => void
  onMenuClose: () => void
  onReply: (message: ChatMessage) => void
  onReact: (message: ChatMessage, emoji: string) => Promise<void>
  onForward: (message: ChatMessage) => void
  onEdit: (message: ChatMessage) => void
  onUnsend: (id: string) => void
  onReport: (message: ChatMessage) => void
  onCopy: (text: string) => Promise<void>
  onOpen: (message: ChatMessage) => void
  onOpenShared: (message: ChatMessage) => void
}) {
  const rowRef = useRef<HTMLDivElement | null>(null)
  const longPress = useRef<{ timer: number | null; moved: boolean; x: number; y: number }>({ timer: null, moved: false, x: 0, y: 0 })

  /* this row scrolls itself into view when a search hit / quote targets it */
  useEffect(() => {
    if (highlightId === message.id) {
      rowRef.current?.scrollIntoView({ block: 'center', behavior: 'smooth' })
    }
  }, [highlightId, message.id])

  const startLongPress = (event: React.TouchEvent) => {
    if (system) return
    longPress.current = { timer: null, moved: false, x: event.touches[0]?.clientX ?? 0, y: event.touches[0]?.clientY ?? 0 }
    longPress.current.timer = window.setTimeout(() => {
      if (!longPress.current.moved) onOpenContextMenu(message.id)
    }, 480)
  }
  const cancelLongPress = () => {
    if (longPress.current.timer) { window.clearTimeout(longPress.current.timer); longPress.current.timer = null }
  }
  const onTouchMove = (event: React.TouchEvent) => {
    const touch = event.touches[0]
    if (touch && Math.abs(touch.clientX - longPress.current.x) + Math.abs(touch.clientY - longPress.current.y) > 10) {
      cancelLongPress()
      longPress.current.moved = true
    }
  }

  if (system) {
    return (
      <div className="chat-system-row" ref={rowRef}>
        <span>{message.body}</span>
        <small>{relativeTime(message.createdAt)}</small>
      </div>
    )
  }

  const unsent = Boolean(message.deletedAt)
  const hasMenu = !unsent
  const hasText = Boolean(message.body?.trim())
  const canForward = !unsent && (hasText || message.attachments.length > 0 || Boolean(message.sharedKind))

  const quote = message.parentAuthorName ? { author: message.parentAuthorName, excerpt: message.parentExcerpt ?? '' } : null
  const reactionRows = Object.entries(message.reactions ?? {}).filter(([, ids]) => ids.length > 0)

  const receiveVoice = message.attachments.filter(a => a.mime.startsWith('audio/'))
  const images = message.attachments.filter(a => a.mime.startsWith('image/'))
  const videos = message.attachments.filter(a => a.mime.startsWith('video/'))
  const files = message.attachments.filter(a => !a.mime.startsWith('image/') && !a.mime.startsWith('video/') && !a.mime.startsWith('audio/'))

  return (
    <div
      ref={rowRef}
      className={`chat-bubble-row ${mine ? 'mine' : 'theirs'} ${highlightId === message.id ? 'highlighted' : ''}`}
      onTouchStart={startLongPress}
      onTouchMove={onTouchMove}
      onTouchEnd={cancelLongPress}
      onTouchCancel={cancelLongPress}
    >
      {!mine && <span className="avatar small">{initialsFor(message.senderName, '')}</span>}

      {mine && hasMenu && (
        <button
          className="chat-msg-actions"
          aria-label="Message options"
          onClick={() => onOpenContextMenu(message.id)}
        >
          <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><circle cx="12" cy="5" r="1.8"/><circle cx="12" cy="12" r="1.8"/><circle cx="12" cy="19" r="1.8"/></svg>
        </button>
      )}

      {hasMenu && actionsFor === message.id && (
        <div className={`chat-msg-menu ${mine ? '' : 'theirs'}`} onMouseLeave={onMenuClose}>
          <button onClick={() => { onMenuClose(); onReply(message) }}><MessageCircle size={13}/> Reply</button>
          <button onClick={() => { onMenuClose(); onTogglePicker(message.id) }}><span>🙂</span> React</button>
          {canForward && <button onClick={() => { onMenuClose(); onForward(message) }}><Send size={13}/> Forward</button>}
          {hasText && <button onClick={() => { onMenuClose(); void onCopy(message.body) }}><FileText size={13}/> Copy text</button>}
          {mine
            ? <button onClick={() => { onMenuClose(); onEdit(message) }}><Pencil size={13}/> Edit</button>
            : <button onClick={() => { onMenuClose(); onReport(message) }}><FlagGlyph/> Report</button>}
          {mine && <button className="danger" onClick={() => { onMenuClose(); onUnsend(message.id) }}><Trash2 size={13}/> Unsend</button>}
        </div>
      )}

      {hasMenu && pickerFor === message.id && (
        <div className={`chat-msg-menu dm-reaction-picker ${mine ? '' : 'theirs'}`} onMouseLeave={onMenuClose}>
          {REACTIONS.map(emoji => (
            <button key={emoji} type="button" role="menuitem" onClick={() => { onMenuClose(); void onReact(message, emoji) }}>{emoji}</button>
          ))}
        </div>
      )}

      <div className="chat-msg-stack">
        {isGroup && !mine && <small className="chat-sender">{message.senderName}</small>}

        {quote && (
          <button className="chat-quote" onClick={() => onOpen(message)}>
            <b>{quote.author === 'Message unsent' ? 'Unsent message' : quote.author}</b>
            <small>{quote.excerpt}</small>
          </button>
        )}

        {unsent ? (
          <div className={`chat-bubble unsent ${mine ? 'mine' : 'theirs'}`}>
            <p>{mine ? 'You unsent a message' : `${isGroup ? message.senderName : peerName} unsent a message`}</p>
          </div>
        ) : (
          <div className={`chat-bubble media-bubble ${mine ? 'mine' : 'theirs'}`}>
            {message.sharedKind ? (
              <ChatSharedCard
                message={message}
                onOpen={onOpenShared}
              />
            ) : null}

            {images.length > 0 && (
              <div className={`chat-att-grid count-${Math.min(images.length, 4)}`}>
                {images.map(att => <ChatImageCell key={att.path} attachment={att} />)}
              </div>
            )}

            {videos.map(att => <ChatVideoCell key={att.path} attachment={att} />)}

            {receiveVoice.map(att => <VoiceBubble key={att.path} attachment={att} />)}

            {files.map(att => <ChatFileRow key={att.path} attachment={att} />)}

            {message.body?.trim() && <p>{message.body}</p>}
            <small>{relativeTime(message.createdAt)}{message.editedAt ? ' · edited' : ''}</small>
          </div>
        )}

        {reactionRows.length > 0 && (
          <div className="chat-reaction-row">
            {reactionRows.map(([emoji, ids]) => (
              <button
                key={emoji}
                className={ids.includes(myId) ? 'mine' : ''}
                onClick={() => void onReact(message, emoji)}
                title={ids.includes(myId) ? 'Remove your reaction' : 'React too'}
              >
                <span>{emoji}</span><i>{ids.length}</i>
              </button>
            ))}
          </div>
        )}
      </div>
    </div>
  )
}

function FlagGlyph() {
  return <span aria-hidden="true">⚑</span>
}

/** images: signed URL once per row, click opens the full-size view */
function ChatImageCell({ attachment }: { attachment: ChatAttachment }) {
  const [src, setSrc] = useState<string | null>(null)
  const [failed, setFailed] = useState(false)

  useEffect(() => {
    let alive = true
    db.chatAttachmentUrls([attachment.path]).then(map => {
      if (!alive) return
      const url = map[attachment.path]
      if (url) setSrc(url)
      else setFailed(true)
    })
    return () => { alive = false }
  }, [attachment.path])

  if (failed) return <span className="chat-att-cell missing" aria-label="Image unavailable">No preview</span>
  if (!src) return <span className="chat-att-cell loading"><span className="mini-spinner"/></span>
  return (
    <a className="chat-att-cell image" href={src} target="_blank" rel="noreferrer">
      <img src={src} alt={attachment.name} />
    </a>
  )
}

/** a voice note bubble: real audio element, progress + duration, honest failures */
function VoiceBubble({ attachment }: { attachment: ChatAttachment }) {
  const audioRef = useRef<HTMLAudioElement | null>(null)
  const [src, setSrc] = useState<string | null>(null)
  const [failed, setFailed] = useState(false)
  const [playing, setPlaying] = useState(false)
  const [progress, setProgress] = useState(0)
  const [duration, setDuration] = useState<number | null>(null)

  useEffect(() => {
    let alive = true
    db.chatAttachmentUrls([attachment.path]).then(map => {
      if (!alive) return
      const url = map[attachment.path]
      if (url) setSrc(url)
      else setFailed(true)
    })
    return () => { alive = false }
  }, [attachment.path])

  if (failed) return <div className="chat-voice failed">Voice note unavailable.</div>
  if (!src) return <div className="chat-voice"><span className="mini-spinner"/></div>

  return (
    <div className="chat-voice">
      <button
        className="chat-voice-btn"
        aria-label={playing ? 'Pause voice message' : 'Play voice message'}
        onClick={() => {
          const audio = audioRef.current
          if (!audio) return
          if (playing) { audio.pause() } else { void audio.play() }
        }}
      >
        {playing ? <Square size={15}/> : <Play size={15}/>}
      </button>
      <div className="chat-voice-bar" aria-hidden="true"><i style={{ width: `${progress}%` }}/></div>
      <small>{duration != null ? (duration < 10 ? `${duration.toFixed(1)}s` : `${Math.round(duration)}s`) : ''}</small>
      <audio
        ref={audioRef}
        src={src}
        preload="metadata"
        onPlay={() => setPlaying(true)}
        onPause={() => setPlaying(false)}
        onEnded={() => { setPlaying(false); setProgress(0) }}
        onLoadedMetadata={event => {
          const value = (event.target as HTMLAudioElement).duration
          setDuration(Number.isFinite(value) ? value : null)
        }}
        onTimeUpdate={event => {
          const audio = event.target as HTMLAudioElement
          if (audio.duration && Number.isFinite(audio.duration)) {
            setProgress(Math.round((audio.currentTime / audio.duration) * 100))
          }
        }}
      />
    </div>
  )
}

/** files: name + size + open/download through a short-lived signed URL */
function ChatFileRow({ attachment }: { attachment: ChatAttachment }) {
  const [src, setSrc] = useState<string | null>(null)
  const [failed, setFailed] = useState(false)

  useEffect(() => {
    let alive = true
    db.chatAttachmentUrls([attachment.path]).then(map => {
      if (!alive) return
      const url = map[attachment.path]
      if (url) setSrc(url)
      else setFailed(true)
    })
    return () => { alive = false }
  }, [attachment.path])

  return (
    <span className="chat-att-file">
      <FileText size={15}/>
      <span className="chat-att-file-copy">
        <b>{attachment.name}</b>
        <small>{attachment.size > 1024 * 1024 ? `${(attachment.size / (1024 * 1024)).toFixed(1)} MB` : `${Math.round(attachment.size / 1024)} KB`}</small>
      </span>
      {src && <a href={src} target="_blank" rel="noreferrer" aria-label={`Open ${attachment.name}`}><Download size={15}/></a>}
      {failed && <small className="chat-voice failed">Unavailable</small>}
    </span>
  )
}

/** videos: signed URL per attachment, honest failure state */
function ChatVideoCell({ attachment }: { attachment: ChatAttachment }) {
  const [src, setSrc] = useState<string | null>(null)
  const [failed, setFailed] = useState(false)

  useEffect(() => {
    let alive = true
    db.chatAttachmentUrls([attachment.path]).then(map => {
      if (!alive) return
      const url = map[attachment.path]
      if (url) setSrc(url)
      else setFailed(true)
    })
    return () => { alive = false }
  }, [attachment.path])

  if (failed) return <span className="chat-att-video missing">Video unavailable</span>
  if (!src) return <span className="chat-att-video loading"><span className="mini-spinner"/></span>
  return <video src={src} controls preload="metadata" playsInline className="chat-att-video" />
}

function composeQuote(message: ChatMessage): string {
  if (message.deletedAt) return 'Unsent message'
  if (message.sharedKind) return message.sharedTitle ?? `Sent a ${message.sharedKind}`
  const attachment = message.attachments[0]
  if (attachment) {
    if (attachment.mime.startsWith('image/')) return '📷 Photo'
    if (attachment.mime.startsWith('video/')) return '🎬 Video'
    if (attachment.mime.startsWith('audio/')) return '🎙️ Voice message'
    return `📎 ${attachment.name}`
  }
  return message.body.slice(0, 90)
}

/** the receipt line: Sent / Seen on my own newest message */
function messageReceiptSlot(message: ChatMessage | undefined, identity: Identity) {
  if (!message || message.senderId !== identity.id || message.deletedAt) return null
  const dmSeen = message.seenCount > 0
  return (
    <div className="chat-receipt" role="status">
      <small>{dmSeen ? 'Seen' : 'Sent'}</small>
    </div>
  )
}

/** forwarding: pick chats, files are copied conversation-side by the data layer */
function ForwardDialog({
  message,
  conversations,
  busy,
  onClose,
  onSend,
}: {
  message: ChatMessage
  conversations: ChatSummary[]
  busy: boolean
  onClose: () => void
  onSend: (targetIds: string[]) => void
}) {
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [note, setNote] = useState('')

  return (
    <div className="overlay" onMouseDown={event => { if (event.target === event.currentTarget) onClose() }}>
      <section className="dm-details-modal" role="dialog" aria-modal="true" aria-label="Forward message">
        <button className="modal-close icon-button" onClick={onClose} aria-label="Close"><X size={20}/></button>
        <h2>Forward message</h2>
        <div className="dm-details-head">
          <span className="chat-bubble forwarded-preview">{message.body ? message.body.slice(0, 120) : message.sharedTitle ?? (message.attachments[0]?.name ?? 'An attachment')}</span>
        </div>

        <div className="dm-member-list">
          {conversations.length === 0 && (
            <div className="chats-hint">No other chats to forward to — accept a chat request or create a group first.</div>
          )}
          {conversations.map(conversation => (
            <button
              key={conversation.id}
              className={`dm-member-row clickable ${selected.has(conversation.id) ? 'checked' : ''}`}
              onClick={() => setSelected(current => {
                const next = new Set(current)
                if (next.has(conversation.id)) next.delete(conversation.id)
                else next.add(conversation.id)
                return next
              })}
            >
              <span className={`avatar ${conversation.kind === 'group' ? 'group' : ''}`}>{initialsFor(conversation.peerName, conversation.peerUsername)}</span>
              <span className="dm-member-copy">
                <b>{conversation.peerName}</b>
                <small>{conversation.lastPreview?.slice(0, 40) ?? (conversation.kind === 'group' ? 'Group' : 'Direct message')}</small>
              </span>
              <span className="share-recipient-tick" aria-hidden="true"><Check size={14}/></span>
            </button>
          ))}
        </div>

        {selected.size > 0 && (
          <label className="share-note">
            Optional note
            <input
              value={note}
              maxLength={2000}
              placeholder="Add your own words (optional)…"
              onChange={event => setNote(event.target.value)}
            />
          </label>
        )}

        <div className="wizard-actions inline">
          <button className="secondary-button" onClick={onClose} disabled={busy}>Cancel</button>
          <button className="primary-button" disabled={busy || selected.size === 0} onClick={() => onSend([...selected])}>
            {busy ? <span className="mini-spinner"/> : selected.size === 0 ? 'Choose chats' : `Forward to ${selected.size}`}
          </button>
        </div>
        {selected.size > 0 && message.attachments.length > 0 && (
          <small className="dm-forward-hint">Files are copied into each receiving chat’s own private folder — originals stay untouched.</small>
        )}
      </section>
    </div>
  )
}

