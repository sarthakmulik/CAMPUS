import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  ArrowLeft, BadgeCheck, Bookmark, BookmarkCheck, Building2, CalendarDays, Check, Clock,
  Copy, Download, EyeOff, FileText, Flag, Globe2, Link as LinkIcon, Loader2,
  Lock, MessageCircle, MoreHorizontal, Pencil, Pin, Plus, Search,
  Send, Settings, Share2, Trash2, UserPlus, Users, X,
} from 'lucide-react'
import * as db from '../lib/db'
import * as cm from '../lib/communities'
import { friendlyMessage, initialsFor, relativeTime } from '../lib/db'
import { mapFeedRow } from '../lib/db'
import type { CampusPost } from '../types'
import * as bk from '../lib/bookmarks'
import PostCard from './PostCard'
import CommentsSheet from './CommentsSheet'
import CommunityChat from './CommunityChat'
import ReportDialog, { type ReportTarget } from './ReportDialog'
import ShareContentSheet, { type ShareTarget } from './chat/ShareContentSheet'
import RichText from './RichText'

type Identity = { id: string; name: string; username: string; initials: string }

type Props = {
  communityId: string
  identity: Identity | null
  configured: boolean
  requireAuth: (reason: string, returnTo?: string) => boolean
  notify: (message: string) => void
  onOpenMention: (profileId: string) => void
  onBack: () => void
  /** report the current tab to the shell (device Back walks tab history) */
  onTabChange?: (tab: string) => void
  /** a popped history entry restored a specific tab */
  restoreTab?: string | null
}

const FEED_TABS = ['Feed', 'Chat', 'Resources', 'Events', 'Members', 'About'] as const
type DetailTab = typeof FEED_TABS[number]

const PINNED_NOTE = 'Pinned to the top of the community feed.'

export default function CommunityDetail({
  communityId, identity, requireAuth, notify, onOpenMention, onBack, onTabChange, restoreTab,
}: Props) {
  const [detail, setDetail] = useState<cm.CommunityDetail | null>(null)
  const membershipRef = useRef<string | null>(null)
  const [loadState, setLoadState] = useState<'loading' | 'ready' | 'missing' | 'error'>('loading')
  const [loadError, setLoadError] = useState<string | null>(null)
  const [tab, setTab] = useState<DetailTab>('Feed')
  // once the Chat tab has been opened, the panel stays mounted but hidden
  // while other tabs are up — drafts, scroll position and realtime history
  // survive tab switches without refetching
  const [visitedChat, setVisitedChat] = useState(false)

  /* ---- membership-aware navigation --------------------------------------- */
  /** history keeps the tab so device Back walks it; parent reports/restores */
  const onTabChangeRef = useRef(onTabChange)
  onTabChangeRef.current = onTabChange
  const reportedTabRef = useRef<DetailTab | null>(null)

  const isModerator = useMemo(
    () => detail?.my_role !== null && detail?.my_role !== undefined &&
      ['owner', 'admin', 'moderator'].includes(detail.my_role),
    [detail],
  )
  const isOwner = useMemo(
    () => detail?.my_role !== null && detail?.my_role !== undefined &&
      ['owner', 'admin'].includes(detail.my_role),
    [detail],
  )
  const isMember = detail?.my_status === 'active'
  /** non-members see only the About tab — no restricted content pretends */
  const visibleTabs: readonly DetailTab[] = isMember ? FEED_TABS : ['About']

  useEffect(() => {
    if (detail && !isMember && tab !== 'About') setTab('About')
  }, [detail, isMember, tab])

  /** restore a tab dropped here from a popped history entry */
  useEffect(() => {
    if (restoreTab && isMember && visibleTabs.includes(restoreTab as DetailTab)) {
      setTab(restoreTab as DetailTab)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [restoreTab, isMember])

  /** report tab to the shell after each change (drives history) */
  useEffect(() => {
    if (tab !== reportedTabRef.current) {
      reportedTabRef.current = tab
      onTabChangeRef.current?.(tab)
    }
  }, [tab])

  const loadDetail = useCallback(async () => {
    setLoadState('loading')
    setLoadError(null)
    try {
      const data = await cm.communityDetail(communityId)
      if (!data) {
        setDetail(null)
        setLoadState('missing')
      } else {
        const prevStatus = membershipRef.current
        membershipRef.current = data.my_status
        setDetail(data)
        setLoadState('ready')
        // transitions from member actions land on the membership home tab:
        // join/request approval → Feed once access is confirmed; leave → About
        if (prevStatus !== null && prevStatus !== data.my_status) {
          if (prevStatus !== 'active' && data.my_status === 'active') setTab('Feed')
          if (prevStatus === 'active' && data.my_status !== 'active') setTab('About')
        }
      }
    } catch (err) {
      setLoadError(friendlyMessage(err))
      setLoadState('error')
    }
  }, [communityId])

  useEffect(() => {
    const allowed = requireAuth('Sign in to view community pages.', 'Communities')
    if (!allowed) return
    void loadDetail()
  }, [loadDetail, requireAuth])

  if (loadState === 'loading') {
    return (
      <div className="community-detail">
        <div className="detail-loading-panel"><Loader2 size={22} className="spin"/> Opening community…</div>
      </div>
    )
  }
  if (loadState === 'missing' || (detail && detail.privacy === 'hidden' && !detail.my_status)) {
    return (
      <div className="community-detail">
        <DetailTopBar onBack={onBack} title={detail?.name ?? 'Community'} privacy={detail?.privacy} />
        <div className="empty-state">
          <EyeOff size={30}/>
          <b>You don't have access</b>
          <span>This community is hidden. Only its members can see it — you need an invitation.</span>
        </div>
      </div>
    )
  }
  if (loadState === 'error') {
    return (
      <div className="community-detail">
        <DetailTopBar onBack={onBack} title="Community" />
        <div className="community-error" role="alert">
          <p>{loadError}</p>
          <button onClick={() => void loadDetail()}>Try again</button>
        </div>
      </div>
    )
  }
  if (!detail) return null

  return (
    <div className={`community-detail${tab === 'Chat' ? ' chat-open' : ''}`}>
      <DetailTopBar onBack={onBack} title={detail.name} privacy={detail.privacy} />

      {/* Layout A — the full overview exists ONLY on the About tab. Content
          tabs start straight at the tab bar so the timeline/list owns the
          whole viewport (component level, not CSS hiding). */}
      {tab === 'About' && (
        <header className="community-hero about-hero">
          <div className="community-hero-cover">
            {detail.cover_image_url
              ? <img src={detail.cover_image_url} alt="" />
              : <span className="community-hero-cover-fallback"/>}
          </div>
          <div className="community-hero-bar">
            <span className="avatar community-hero-avatar">
              {detail.logo_url ? <img src={detail.logo_url} alt=""/> : initialsFor(detail.name, detail.slug)}
            </span>
            <div className="community-hero-id">
              <h1>
                {detail.name}
                {detail.archived && <span className="community-archived-chip">Archived</span>}
              </h1>
              <p className="community-hero-sub">
                {detail.scope === 'college'
                  ? <><Building2 size={13}/>{detail.college_name ?? 'College community'}</>
                  : <><Globe2 size={13}/>Global community</>}
                <i>·</i>{detail.category}
                <i>·</i>{detail.privacy === 'public' ? 'Public' : detail.privacy === 'private' ? 'Private' : 'Hidden'}
              </p>
            </div>
            <span className="community-hero-count"><Users size={14}/>{detail.member_count}</span>
          </div>
          <CommunityActions
            detail={detail}
            identity={identity}
            isOwner={isOwner}
            requireAuth={requireAuth}
            notify={notify}
            onChanged={() => void loadDetail()}
          />
        </header>
      )}

      <nav className="community-tabs detail-tabs" data-no-page-swipe="true" aria-label="Community sections">
        {visibleTabs.map(item => (
          <button key={item} className={item === tab ? 'on' : ''} onClick={() => { setTab(item); if (item === 'Chat') setVisitedChat(true) }}>{item}</button>
        ))}
      </nav>

      {detail.archived && (
        <div className="community-archived-banner">
          This community was archived by its owner. It stays read-only: nothing new can be posted, and joining is closed.
        </div>
      )}

      {tab === 'Feed' && (
        <CommunityFeedPanel
          detail={detail}
          identity={identity}
          isModerator={isModerator}
          notify={notify}
          requireAuth={requireAuth}
          onOpenMention={onOpenMention}
        />
      )}
      {(tab === 'Chat' || visitedChat) && (
        <div className={`cc-holder ${tab === 'Chat' ? '' : 'hidden'}`}>
          {detail.archived ? (
            <div className="empty-state"><MessageCircle size={28}/><b>Chat is closed</b><span>This community is archived. History stays but nothing new can be sent.</span></div>
          ) : (
            <CommunityChat
              communityId={detail.id}
              identity={identity}
              isModerator={isModerator}
              notify={notify}
              onOpenMention={onOpenMention}
            />
          )}
        </div>
      )}
      {tab === 'Resources' && (
        <ResourcesPanel
          communityId={detail.id}
          identity={identity}
          isMember={isMember}
          isModerator={isModerator}
          requireAuth={requireAuth}
          notify={notify}
        />
      )}
      {tab === 'Events' && (
        <EventsPanel
          communityId={detail.id}
          identity={identity}
          isMember={isMember}
          isModerator={isModerator}
          requireAuth={requireAuth}
          notify={notify}
        />
      )}
      {tab === 'Members' && (
        <MembersPanel
          detail={detail}
          identity={identity}
          isModerator={isModerator}
          isOwner={isOwner}
          notify={notify}
          onOpenMention={onOpenMention}
        />
      )}
      {tab === 'About' && (
        <AboutPanel
          detail={detail}
          identity={identity}
          isModerator={isModerator}
          isOwner={isOwner}
          notify={notify}
          onChanged={() => void loadDetail()}
        />
      )}
    </div>
  )
}

/* -------------------------------------------------------------------------- */
/* Header pieces                                                               */
/* -------------------------------------------------------------------------- */

function DetailTopBar({ onBack, title, privacy }: { onBack: () => void; title: string; privacy?: string }) {
  return (
    <div className="detail-topbar">
      <button className="icon-button" onClick={onBack} aria-label="Back to communities"><ArrowLeft size={20}/></button>
      <div className="detail-topbar-title">
        <b>{title}</b>
        {privacy && privacy !== 'public' && <span>{privacy === 'private' ? <><Lock size={11}/> private</> : <><EyeOff size={11}/> hidden</>}</span>}
      </div>
    </div>
  )
}

function CommunityActions({ detail, identity, isOwner, notify, requireAuth, onChanged }: {
  detail: cm.CommunityDetail
  identity: Identity | null
  isOwner: boolean
  notify: (message: string) => void
  requireAuth: (reason: string, returnTo?: string) => boolean
  onChanged: () => void
}) {
  const [busy, setBusy] = useState(false)
  const [confirming, setConfirming] = useState<'leave' | 'archive' | null>(null)
  const [shareOpen, setShareOpen] = useState(false)
  const [reportOpen, setReportOpen] = useState(false)
  const [copyClicked, setCopyClicked] = useState(false)

  const act = async (fn: () => Promise<unknown>, success = '') => {
    setBusy(true)
    try {
      await fn()
      if (success) notify(success)
      onChanged()
    } catch (err) {
      notify(friendlyMessage(err))
    } finally {
      setBusy(false)
      setConfirming(null)
    }
  }

  const communitySlugUrl = `${window.location.origin}${window.location.pathname}#/communities/${detail.slug}`

  const copyLink = async () => {
    const failure = await db.copyToClipboard(communitySlugUrl)
    if (failure) notify(failure)
    else { notify('Community link copied.'); setCopyClicked(true); window.setTimeout(() => setCopyClicked(false), 1600) }
  }

  const member = detail.my_status === 'active'
  const pending = detail.my_status === 'pending'

  return (
    <div className="community-actions">
      {member && (
        <>
          <span className="community-joined-chip"><Check size={12}/> Member{['owner', 'admin'].includes(detail.my_role ?? '') ? ' · Owner' : detail.my_role === 'moderator' ? ' · Moderator' : ''}</span>
          {!['owner', 'admin'].includes(detail.my_role ?? '') && (
            confirming === 'leave'
              ? <span className="confirm-strip">
                  <span>Leave this community?</span>
                  <button className="danger-mini" disabled={busy} onClick={() => void act(() => cm.leaveCommunity(detail.id), 'You left the community.')}>Yes, leave</button>
                  <button className="ghost-mini" onClick={() => setConfirming(null)}>No</button>
                </span>
              : <button className="ghost-action" onClick={() => setConfirming('leave')}>Leave</button>
          )}
        </>
      )}
      {!member && pending && (
        confirming === 'leave'
          ? <span className="confirm-strip">
              <span>Take back your request?</span>
              <button className="danger-mini" disabled={busy} onClick={() => void act(() => cm.cancelJoinRequest(detail.id), 'Request cancelled.')}>Yes, cancel</button>
              <button className="ghost-mini" onClick={() => setConfirming(null)}>No</button>
            </span>
          : <button className="ghost-action" onClick={() => setConfirming('leave')}><Clock size={15}/> Request sent — cancel</button>
      )}
      {!member && !pending && detail.my_status !== 'banned' && !detail.archived && (
        <button
          className="primary-button"
          disabled={busy}
          onClick={async () => {
            if (!identity) {
              requireAuth('Sign in to join communities.', 'Communities')
              return
            }
            await act(async () => {
              const result = await cm.joinCommunity(detail.id)
              return result === 'requested' ? notify('Request sent — a moderator will review it.') : null
            })
          }}
        >
          {detail.privacy === 'private' ? 'Request to join' : 'Join'}
        </button>
      )}
      {detail.my_status === 'banned' && (
        <span className="community-invite-note">Moderators removed you — you cannot rejoin.</span>
      )}

      {(member || detail.privacy !== 'hidden') && (
        <button className="ghost-action" onClick={() => setShareOpen(v => !v)}>
          <Share2 size={15}/> Share
        </button>
      )}
      {shareOpen && (
        <div className="share-strip">
          <button onClick={() => void copyLink()}>{copyClicked ? <Check size={14}/> : <Copy size={14}/>} Copy link</button>
          <button onClick={() => { setShareOpen(false); setReportOpen(true) }}><Flag size={14}/> Report community</button>
        </div>
      )}

      {isOwner && !detail.archived && (
        confirming === 'archive'
          ? <span className="confirm-strip">
              <span>Archive {detail.name}? Members lose posting and it leaves discovery.</span>
              <button className="danger-mini" disabled={busy} onClick={() => void act(() => cm.archiveCommunity(detail.id, true), 'Community archived.')}>Archive</button>
              <button className="ghost-mini" onClick={() => setConfirming(null)}>No</button>
            </span>
          : <button className="ghost-action danger" onClick={() => setConfirming('archive')}><Settings size={15}/> Archive</button>
      )}
      {isOwner && detail.archived && (
        <button className="ghost-action" disabled={busy} onClick={() => void act(() => cm.archiveCommunity(detail.id, false), 'Community restored.')}>Restore community</button>
      )}

      {reportOpen && (
        <CommunityReportDialog
          communityId={detail.id}
          communityName={detail.name}
          onClose={() => setReportOpen(false)}
          onDone={message => { setReportOpen(false); notify(message) }}
        />
      )}
    </div>
  )
}

function CommunityReportDialog({ communityId, communityName, onClose, onDone }: {
  communityId: string
  communityName: string
  onClose: () => void
  onDone: (message: string) => void
}) {
  const reasons = ['Spam or scam', 'Harassment or threats', 'Inappropriate content', 'Impersonating a college', 'Other']
  const [reason, setReason] = useState(reasons[0])
  const [details, setDetails] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  return (
    <div className="overlay" onMouseDown={event => { if (event.target === event.currentTarget) onClose() }}>
      <section className="report-dialog" role="dialog" aria-modal="true" aria-label={`Report ${communityName}`}>
        <button className="modal-close icon-button" onClick={onClose} aria-label="Close"><X size={18}/></button>
        <span className="prompt-icon"><Flag size={20}/></span>
        <h3 className="report-heading">Report {communityName}</h3>
        {error && <p className="form-error" role="alert">{error}</p>}
        <fieldset className="reason-list">
          {reasons.map(item => (
            <label key={item} className={`reason-option ${item === reason ? 'selected' : ''}`}>
              <input type="radio" name="community-report-reason" checked={item === reason} onChange={() => setReason(item)}/>
              <span>{item}</span>
            </label>
          ))}
        </fieldset>
        <label className="field-label">
          Anything the moderators should know? <span className="optional">optional</span>
          <textarea
            value={details}
            onChange={event => setDetails(event.target.value)}
            rows={3}
            maxLength={800}
          />
        </label>
        <div className="wizard-actions inline">
          <button className="secondary-button" onClick={onClose} disabled={busy}>Cancel</button>
          <button
            className="primary-button"
            disabled={busy}
            onClick={async () => {
              setBusy(true)
              setError(null)
              try {
                await cm.reportCommunity(communityId, reason, details)
                onDone('Report filed — moderators will review it.')
              } catch (err) {
                setError(friendlyMessage(err))
              } finally {
                setBusy(false)
              }
            }}
          >
            {busy ? <Loader2 size={15} className="spin"/> : <Flag size={15}/>} File report
          </button>
        </div>
      </section>
    </div>
  )
}

/* -------------------------------------------------------------------------- */
/* Feed panel — community posts on the shared posts infrastructure             */
/* -------------------------------------------------------------------------- */

function CommunityFeedPanel({ detail, identity, isModerator, notify, requireAuth, onOpenMention }: {
  detail: cm.CommunityDetail
  identity: Identity | null
  isModerator: boolean
  notify: (message: string) => void
  requireAuth: (reason: string, returnTo?: string) => boolean
  onOpenMention: (profileId: string) => void
}) {
  const [posts, setPosts] = useState<CampusPost[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [composerBody, setComposerBody] = useState('')
  const [editingPostId, setEditingPostId] = useState<string | null>(null)
  const [image, setImage] = useState<File | null>(null)
  const [imagePreview, setImagePreview] = useState<string | null>(null)
  const [publishing, setPublishing] = useState(false)
  const [commentTarget, setCommentTarget] = useState<CampusPost | null>(null)
  const [reportTarget, setReportTarget] = useState<ReportTarget | null>(null)
  const inputRef = useRef<HTMLInputElement>(null)
  const allowPost = detail.my_status === 'active' && !detail.archived
  const load = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const rows = await cm.fetchCommunityFeed({ clubId: detail.id })
      const mapped = rows.map(row => ({ ...mapFeedRow(row), isPinned: Boolean(row.is_pinned) }))
      setPosts(mapped)
      // hydrate which of these community posts the member bookmarked
      void bk.syncPostSaves(mapped).catch(() => undefined)
    } catch (err) {
      setError(friendlyMessage(err))
    } finally {
      setLoading(false)
    }
  }, [detail.id])

  useEffect(() => {
    void load()
  }, [load])

  // newer posts/pins/edits arrive without navigation; throttled refresh
  useEffect(() => {
    let pending = false
    let timer: number | null = null
    const schedule = () => {
      if (pending || timer !== null) return
      pending = true
      timer = window.setTimeout(() => {
        pending = false
        timer = null
        void load()
      }, 900)
    }
    const unsubscribe = cm.subscribeCommunityPosts(detail.id, schedule)
    return () => { if (timer !== null) window.clearTimeout(timer); unsubscribe() }
  }, [detail.id, load])

  const patchPost = (postId: string, patch: Partial<CampusPost>) => {
    setPosts(current => current.map(p => p.id === postId ? { ...p, ...patch } : p))
  }

  const like = async (post: CampusPost) => {
    if (!identity) {
      requireAuth('like posts', 'Communities')
      return
    }
    const nextLiked = !post.liked
    patchPost(post.id, { liked: nextLiked, likes: post.likes + (nextLiked ? 1 : -1) })
    try {
      await db.toggleLike(post.id, identity.id, nextLiked)
    } catch (err) {
      patchPost(post.id, { liked: post.liked, likes: post.likes })
      notify(friendlyMessage(err))
    }
  }

  const publish = async () => {
    if (!identity) {
      requireAuth('post in communities', 'Communities')
      return
    }
    const body = composerBody.trim()
    if (!editingPostId && !body && !image) { notify('Write something or add an image first.'); return }
    setPublishing(true)
    try {
      if (editingPostId) {
        if (!body) throw new Error('The post body cannot be empty.')
        await db.updatePost(editingPostId, body)
        setEditingPostId(null)
        setComposerBody('')
        notify('Post updated.')
        void load()
        return
      }
      let mediaUrls: string[] = []
      if (image) {
        const url = await db.uploadMedia(identity.id, image)
        mediaUrls = [url]
      }
      await db.createPost({
        userId: identity.id,
        body,
        kind: 'post',
        isAnonymous: false,
        collegeId: null,
        collegeShort: detail.college_short_name ?? '',
        authorName: identity.name,
        authorUsername: identity.username,
        mediaUrls,
        communityId: detail.id,
      })
      setComposerBody('')
      setImage(null)
      setImagePreview(null)
      notify('Posted to the community.')
      void load()
    } catch (err) {
      setError(friendlyMessage(err))
    } finally {
      setPublishing(false)
    }
  }

  const pickImage = (file: File | undefined) => {
    if (!file) return
    const problem = file.type.startsWith('image/') ? null : 'Pick an image file (JPG, PNG or WebP).'
    if (problem) { notify(problem); return }
    if (file.size > db.MAX_MEDIA_BYTES) { notify('That image is over 25 MB.'); return }
    setImage(file)
    setImagePreview(URL.createObjectURL(file))
  }

  const deletePost = async (post: CampusPost) => {
    if (!window.confirm('Delete this post from the community? This cannot be undone.')) return
    try {
      await db.deletePost(post.id)
      setPosts(current => current.filter(p => p.id !== post.id))
      notify('Post deleted.')
    } catch (err) {
      notify(friendlyMessage(err))
    }
  }

  const togglePin = async (post: CampusPost) => {
    try {
      await cm.setPostPin(detail.id, post.id, !post.isPinned)
      patchPost(post.id, { isPinned: !post.isPinned })
      notify(!post.isPinned ? PINNED_NOTE : 'Post unpinned — it flows in normal order again.')
      void load()
    } catch (err) {
      notify(friendlyMessage(err))
    }
  }

  const [postShareTarget, setPostShareTarget] = useState<ShareTarget | null>(null)
  const sharePost = (post: CampusPost) => {
    setPostShareTarget({
      kind: 'post',
      id: post.id,
      title: post.body.trim().slice(0, 110) || 'Post',
      subtitle: post.anonymous ? 'Anonymous post' : `by ${post.author}`,
      image: post.media?.[0] ?? null,
    })
  }

  const savePost = (post: CampusPost) => {
    if (!identity) { requireAuth('bookmark posts'); return }
    bk.toggleSaved(post.kind === 'reel' ? 'reel' : 'post', post.id)
      .catch(error => notify(friendlyMessage(error)))
  }

  return (
    <section className="community-feed">
      {allowPost && (
        <div className={`community-composer${editingPostId ? ' editing' : ''}`}>
          {editingPostId && (
            <div className="chat-editing-hint">
              Editing a post — only its text can change.
              <button onClick={() => { setEditingPostId(null); setComposerBody('') }}>Cancel</button>
            </div>
          )}
          <textarea
            value={composerBody}
            onChange={event => setComposerBody(event.target.value)}
            rows={2}
            maxLength={5000}
            placeholder={`Share something with ${detail.name}…`}
          />
          {imagePreview && (
            <div className="composer-preview">
              <img src={imagePreview} alt=""/>
              <button onClick={() => { setImage(null); setImagePreview(null) }} aria-label="Remove image"><X size={14}/></button>
            </div>
          )}
          <div className="composer-row">
            <button className="icon-button" onClick={() => inputRef.current?.click()} aria-label="Add image" disabled={publishing || Boolean(editingPostId)}><Plus size={18}/></button>
            <input ref={inputRef} type="file" accept="image/*" hidden onChange={event => pickImage(event.target.files?.[0])}/>
            <span/>
            <button className="primary-button" onClick={() => void publish()} disabled={publishing}>
              {publishing ? <Loader2 size={15} className="spin"/> : <Send size={15}/>}
              {editingPostId ? 'Save' : 'Post'}
            </button>
          </div>
        </div>
      )}
      {!allowPost && (
        <div className="empty-state small">
          {detail.my_status === 'active'
            ? 'This archived community is read-only.'
            : detail.my_status === 'banned'
              ? 'Moderators removed you from this community.'
              : 'Join the community to post here.'}
        </div>
      )}

      {error && (
        <div className="community-error" role="alert"><p>{error}</p><button onClick={() => void load()}>Try again</button></div>
      )}
      {loading && (
        <div className="community-feed-skeleton">
          {[0, 1, 2].map(index => <div key={index} className="post-card skeleton-card"><div className="skeleton-block w60"/><div className="skeleton-block w90"/><div className="skeleton-block w40"/></div>)}
        </div>
      )}
      {!loading && !error && posts.length === 0 && (
        <div className="empty-state"><MessageCircle size={28}/><b>No posts yet</b><span>{allowPost ? 'Start the conversation.' : 'Posts by members appear here.'}</span></div>
      )}

      <div className="community-feed-list">
        {posts.map(post => (
          <div key={post.id} className="community-feed-item">
            {post.isPinned && <span className="pin-flag"><Pin size={12}/> Pinned by moderators</span>}
            <PostCard
              post={post}
              isOwn={Boolean(identity && post.authorId === identity.id)}
              onLike={() => void like(post)}
              onSave={() => savePost(post)}
              onComment={() => { if (requireAuth('join the conversation', 'Communities')) setCommentTarget(post) }}
              onShare={() => sharePost(post)}
              onReport={() => setReportTarget({ label: 'this post', postId: post.id, excerpt: post.body.slice(0, 200) })}
              onRepost={() => notify('Reposts do not work inside communities yet — share the post instead.')}
              onBlock={() => notify('Use the Members tab to manage community moderators.')}
              onMute={() => notify('Mutes work on the main feed; community moderation lives in the Members tab.')}
              onEdit={() => { setEditingPostId(post.id); setComposerBody(post.body) }}
              onDelete={() => void deletePost(post)}
              onMessage={() => notify('Message them from their profile — community chat covers the whole group.')}
              onPin={isModerator ? () => void togglePin(post) : undefined}
              onOpenMention={onOpenMention}
              onOpenTag={() => notify('Hashtags work on the main feed.')}
            />
          </div>
        ))}
      </div>

      {commentTarget && (
        <CommentsSheet
          theme="light"
          post={commentTarget}
          userId={identity?.id ?? null}
          identity={identity ?? { name: 'You', username: '', initials: 'Y' }}
          requireAuth={requireAuth}
          onClose={() => setCommentTarget(null)}
          onCountChange={count => patchPost(commentTarget.id, { comments: count })}
        />
      )}
      {reportTarget && (
        <ReportDialog
          target={reportTarget}
          onClose={() => setReportTarget(null)}
          onSubmitted={message => { setReportTarget(null); notify(message) }}
        />
      )}
      {postShareTarget && (
        <ShareContentSheet
          target={postShareTarget}
          onClose={() => setPostShareTarget(null)}
          onFlash={notify}
          onSent={count => notify(count === 1 ? 'Sent to 1 chat.' : `Sent to ${count} chats.`)}
        />
      )}
    </section>
  )
}

/* -------------------------------------------------------------------------- */
/* Chat panel                                                                  */
/* -------------------------------------------------------------------------- */


/* -------------------------------------------------------------------------- */
/* Resources panel                                                             */
/* -------------------------------------------------------------------------- */

function ResourcesPanel({ communityId, identity, isMember, isModerator, requireAuth, notify }: {
  communityId: string
  identity: Identity | null
  isMember: boolean
  isModerator: boolean
  requireAuth: (reason: string, returnTo?: string) => boolean
  notify: (message: string) => void
}) {
  const [rows, setRows] = useState<cm.ResourceRow[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [title, setTitle] = useState('')
  const [description, setDescription] = useState('')
  const [linkUrl, setLinkUrl] = useState('')
  const [file, setFile] = useState<File | null>(null)
  const [busy, setBusy] = useState(false)
  const [addOpen, setAddOpen] = useState(false)
  const fileInputRef = useRef<HTMLInputElement>(null)
  const [savedIds, setSavedIds] = useState<Set<string>>(new Set())
  const [saveBusyId, setSaveBusyId] = useState<string | null>(null)

  const load = useCallback(async () => {
    if (!isMember) { setLoading(false); return }
    setLoading(true)
    setError(null)
    try {
      const fresh = await cm.fetchCommunityResources(communityId)
      setRows(fresh)
      // hydrate which of these the member saved (0026; no-op before migration)
      void bk.hydrateResourceSaves(fresh.map(r => r.id)).catch(() => undefined)
    } catch (err) {
      setError(friendlyMessage(err))
    } finally {
      setLoading(false)
    }
  }, [communityId, isMember])

  useEffect(() => {
    void load()
  }, [load])

  // keep the per-row saved state in step with the shared saved store —
  // saves can land from anywhere in the app while this panel is open
  useEffect(() => {
    const sync = () => setSavedIds(new Set(rows.filter(r => bk.isSaved('resource', r.id)).map(r => r.id)))
    sync()
    return bk.subscribeToStore(sync)
  }, [rows])

  const toggleSaveResource = async (row: cm.ResourceRow) => {
    if (!identity) { requireAuth('save resources', 'Resources'); return }
    setSaveBusyId(row.id)
    try {
      const saved = await bk.toggleSaved('resource', row.id)
      notify(saved ? 'Resource saved — find it under Saved.' : 'Removed from your saved resources.')
    } catch (err) {
      notify(friendlyMessage(err))
    } finally {
      setSaveBusyId(null)
    }
  }

  if (!isMember) {
    return <div className="empty-state"><FileText size={28}/><b>Members-only resources</b><span>Join this community to share and download notes, papers and links.</span></div>
  }

  const add = async () => {
    if (!identity) { requireAuth('share resources', 'Communities'); return }
    const trimmedTitle = title.trim()
    if (!trimmedTitle) { notify('Give the resource a title.'); return }
    if (!file && !linkUrl.trim()) { notify('Attach a file or paste a link.'); return }
    if (file) {
      const problem = cm.resourceUploadProblem(file)
      if (problem) { notify(problem); return }
    }
    setBusy(true)
    setError(null)
    try {
      let upload: { path: string; name: string; size: number; mime: string } | null = null
      if (file) upload = await cm.uploadResourceFile(communityId, identity.id, file)
      await cm.addCommunityResource({
        clubId: communityId,
        title: trimmedTitle,
        description: description.trim(),
        linkUrl: upload ? '' : linkUrl.trim(),
        upload,
      })
      setTitle(''); setDescription(''); setLinkUrl(''); setFile(null); setAddOpen(false)
      notify('Resource shared with the community.')
      void load()
    } catch (err) {
      setError(friendlyMessage(err))
    } finally {
      setBusy(false)
    }
  }

  const openResource = async (row: cm.ResourceRow) => {
    if (row.link_url) {
      window.open(row.link_url, '_blank', 'noopener')
      return
    }
    if (!row.storage_path) return
    try {
      const url = await cm.resourceDownloadUrl(row.storage_path)
      window.open(url, '_blank', 'noopener')
    } catch (err) {
      notify(friendlyMessage(err))
    }
  }

  const remove = async (row: cm.ResourceRow) => {
    if (!window.confirm(`Remove "${row.title}"? ${row.file_name ? 'The uploaded file is deleted too.' : ''}`)) return
    try {
      await cm.deleteCommunityResource(row)
      setRows(current => current.filter(r => r.id !== row.id))
      notify('Resource removed.')
    } catch (err) {
      notify(friendlyMessage(err))
    }
  }

  const canManageRow = (row: cm.ResourceRow) => row.mine || isModerator

  return (
    <section className="community-resources">
      <div className="panel-head">
        <p><FileText size={16}/> Notes, papers, decks and links members find useful.</p>
        <button className="primary-button" onClick={() => setAddOpen(v => !v)}><Plus size={15}/> Add resource</button>
      </div>

      {addOpen && (
        <div className="resource-form">
          <label>Title<input value={title} onChange={event => setTitle(event.target.value)} maxLength={120} placeholder="e.g. DBMS unit-3 notes"/></label>
          <label>Description<textarea value={description} onChange={event => setDescription(event.target.value)} rows={2} maxLength={500} placeholder="What does it help with? (optional)"/></label>
          <div className="resource-inputs">
            <button className="ghost-action" onClick={() => fileInputRef.current?.click()}>
              {file ? <Check size={14}/> : <Plus size={14}/>} {file ? file.name : 'Attach file (≤ 25 MB)'}
            </button>
            <input ref={fileInputRef} type="file" hidden onChange={event => { setFile(event.target.files?.[0] ?? null); setLinkUrl('') }}/>
            <label className="link-field">
              <LinkIcon size={15}/>
              <input value={linkUrl} onChange={event => { setLinkUrl(event.target.value); setFile(null) }} placeholder="…or paste a link" disabled={Boolean(file)}/>
            </label>
          </div>
          {error && <div className="form-error" role="alert">{error}</div>}
          <div className="resource-form-foot">
            <span className="wizard-flex"/>
            <button className="primary-button" disabled={busy} onClick={() => void add()}>
              {busy ? <Loader2 size={14} className="spin"/> : <Check size={14}/>} Share
            </button>
          </div>
        </div>
      )}

      {loading && <div className="detail-loading-panel small"><Loader2 size={16} className="spin"/> Loading resources…</div>}
      {!loading && error && (
        <div className="community-error" role="alert"><p>{error}</p><button onClick={() => void load()}>Try again</button></div>
      )}
      {!loading && !error && rows.length === 0 && (
        <div className="empty-state small"><FileText size={24}/><b>Nothing shared yet</b><span>Notes, past papers, decks or useful links fit here.</span></div>
      )}
      <ul className="resource-list">
        {rows.map(row => (
          <li key={row.id} className="resource-row">
            <span className="resource-icon">{row.link_url ? <LinkIcon size={16}/> : <FileText size={16}/>}</span>
            <div className="resource-data">
              <b>{row.title}</b>
              {row.description && <p>{row.description}</p>}
              <span className="resource-meta">
                {row.file_name ?? 'Link'}{row.file_size != null ? ` · ${(row.file_size / 1024).toFixed(0)} KB` : ''} · {row.uploader_name ?? 'Member'} · {relativeTime(row.created_at)}
              </span>
            </div>
            <button className={`icon-button${savedIds.has(row.id) ? ' saved' : ''}`} onClick={() => void toggleSaveResource(row)} aria-label={savedIds.has(row.id) ? 'Remove saved resource' : 'Save resource'} disabled={saveBusyId === row.id}>
              {saveBusyId === row.id ? <Loader2 size={15} className="spin"/> : savedIds.has(row.id) ? <BookmarkCheck size={16}/> : <Bookmark size={16}/>}
            </button>
            <button className="icon-button" onClick={() => void openResource(row)} aria-label={row.link_url ? 'Open link' : 'Download'}>{row.link_url ? <LinkIcon size={16}/> : <Download size={16}/>}</button>
            {canManageRow(row) && (
              <button className="icon-button" onClick={() => void remove(row)} aria-label="Remove resource"><Trash2 size={15}/></button>
            )}
          </li>
        ))}
      </ul>
    </section>
  )
}

/* -------------------------------------------------------------------------- */
/* Events panel                                                                */
/* -------------------------------------------------------------------------- */

function EventsPanel({ communityId, identity, isMember, isModerator, requireAuth, notify }: {
  communityId: string
  identity: Identity | null
  isMember: boolean
  isModerator: boolean
  requireAuth: (reason: string, returnTo?: string) => boolean
  notify: (message: string) => void
}) {
  const [events, setEvents] = useState<cm.CommunityEventRow[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [formOpen, setFormOpen] = useState(false)
  const [editEvent, setEditEvent] = useState<cm.CommunityEventRow | null>(null)
  const [title, setTitle] = useState('')
  const [description, setDescription] = useState('')
  const [venue, setVenue] = useState('')
  const [startLocal, setStartLocal] = useState('')
  const [endLocal, setEndLocal] = useState('')
  const [capacity, setCapacity] = useState('')
  const [registrationUrl, setRegistrationUrl] = useState('')
  const [busy, setBusy] = useState(false)
  const [rsvpBusyId, setRsvpBusyId] = useState<string | null>(null)

  const load = useCallback(async () => {
    if (!isMember) { setLoading(false); return }
    setLoading(true)
    setError(null)
    try {
      setEvents(await cm.fetchCommunityEvents(communityId))
    } catch (err) {
      setError(friendlyMessage(err))
    } finally {
      setLoading(false)
    }
  }, [communityId, isMember])

  useEffect(() => {
    void load()
  }, [load])

  const resetForm = () => {
    setTitle(''); setDescription(''); setVenue(''); setStartLocal(''); setEndLocal(''); setCapacity(''); setRegistrationUrl('')
    setEditEvent(null)
  }

  const openForm = (event: cm.CommunityEventRow | null) => {
    setFormOpen(true)
    if (event) {
      setEditEvent(event)
      setTitle(event.title)
      setDescription(event.description)
      setVenue(event.venue ?? '')
      setStartLocal(toLocalInput(event.starts_at))
      setEndLocal(event.ends_at ? toLocalInput(event.ends_at) : '')
      setCapacity(event.capacity != null ? String(event.capacity) : '')
      setRegistrationUrl(event.registration_url ?? '')
    } else {
      resetForm()
    }
  }

  const save = async () => {
    if (!identity) { requireAuth('manage events', 'Communities'); return }
    if (title.trim().length < 3) { notify('Give the event a title.'); return }
    if (!startLocal) { notify('Pick a start time.'); return }
    setBusy(true)
    setError(null)
    try {
      await cm.saveCommunityEvent({
        clubId: communityId,
        eventId: editEvent?.id ?? null,
        title: title.trim(),
        description: description.trim(),
        venue: venue.trim(),
        startAt: new Date(startLocal).toISOString(),
        endAt: endLocal ? new Date(endLocal).toISOString() : null,
        registrationUrl: registrationUrl.trim(),
        capacity: capacity.trim() ? Number(capacity) : null,
      })
      resetForm()
      setFormOpen(false)
      notify(editEvent ? 'Event updated.' : 'Event scheduled.')
      void load()
    } catch (err) {
      setError(friendlyMessage(err))
    } finally {
      setBusy(false)
    }
  }

  const removeEvent = async (event: cm.CommunityEventRow) => {
    if (!window.confirm(`Delete "${event.title}"? Registrations for it are removed too.`)) return
    try {
      await cm.deleteCommunityEvent(event.id)
      setEvents(current => current.filter(e => e.id !== event.id))
      notify('Event deleted.')
    } catch (err) {
      notify(friendlyMessage(err))
    }
  }

  const rsvp = async (event: cm.CommunityEventRow, status: 'going' | 'interested' | 'not_going') => {
    if (!identity) { requireAuth('RSVP to events', 'Communities'); return }
    if (!isMember) { notify('Join the community to RSVP.'); return }
    setRsvpBusyId(event.id)
    try {
      const stored = await cm.rsvpEvent(event.id, status)
      const label = stored === 'going' ? 'going' : stored === 'interested' ? 'interested' : 'removed'
      notify(stored === 'removed' ? 'You are off the guest list.' : `Marked ${label}.`)
      void load()
    } catch (err) {
      notify(friendlyMessage(err))
    } finally {
      setRsvpBusyId(null)
    }
  }

  if (!isMember && !formOpen) {
    // public communities still show events read-only
  }

  const upcoming = events.filter(event => !event.past)
  const past = events.filter(event => event.past)

  return (
    <section className="community-events">
      <div className="panel-head">
        <p><CalendarDays size={16}/> Meetups, sessions and fests organized inside the community.</p>
        {isModerator && !formOpen && <button className="primary-button" onClick={() => { setEditEvent(null); openForm(null) }}><Plus size={15}/> New event</button>}
      </div>

      {formOpen && (
        <div className="event-form">
          <label>Title<input value={title} onChange={event => setTitle(event.target.value)} maxLength={120} placeholder="e.g. Placement prep session"/></label>
          <label>Details<textarea value={description} onChange={event => setDescription(event.target.value)} rows={2} maxLength={1000} placeholder="What happens, who it is for… (optional)"/></label>
          <div className="event-grid">
            <label>Venue or online link<input value={venue} onChange={event => setVenue(event.target.value)} maxLength={200} placeholder="Room 204 / meet link"/></label>
            <label>Registration URL<input value={registrationUrl} onChange={event => setRegistrationUrl(event.target.value)} placeholder="optional external form"/></label>
            <label>Starts<input type="datetime-local" value={startLocal} onChange={event => setStartLocal(event.target.value)}/></label>
            <label>Ends<input type="datetime-local" value={endLocal} onChange={event => setEndLocal(event.target.value)}/></label>
            <label>Capacity<input type="number" min={1} value={capacity} onChange={event => setCapacity(event.target.value)} placeholder="no limit"/></label>
          </div>
          {error && <div className="form-error" role="alert">{error}</div>}
          <div className="resource-form-foot">
            {editEvent && <button className="ghost-action" onClick={() => { resetForm(); setFormOpen(false) }}>Cancel</button>}
            <span className="wizard-flex"/>
            <button className="primary-button" disabled={busy} onClick={() => void save()}>
              {busy ? <Loader2 size={14} className="spin"/> : <Check size={14}/>} {editEvent ? 'Save changes' : 'Schedule event'}
            </button>
          </div>
        </div>
      )}

      {loading && <div className="detail-loading-panel small"><Loader2 size={16} className="spin"/> Loading events…</div>}
      {!loading && error && (
        <div className="community-error" role="alert"><p>{error}</p><button onClick={() => void load()}>Try again</button></div>
      )}
      {!loading && events.length === 0 && !formOpen && (
        <div className="empty-state"><CalendarDays size={28}/><b>No events yet</b><span>{isModerator ? 'Schedule the first meetup.' : 'Organizers will post meetups here.'}</span></div>
      )}

      {upcoming.length > 0 && <h4 className="event-group-title">Upcoming</h4>}
      <ul className="event-list">
        {upcoming.map(event => <EventRow key={event.id} event={event} identity={identity} isMember={isMember} isModerator={isModerator} rsvpBusy={rsvpBusyId === event.id} onRsvp={status => void rsvp(event, status)} onEdit={() => openForm(event)} onDelete={() => void removeEvent(event)}/>)}
      </ul>
      {past.length > 0 && <h4 className="event-group-title">Past</h4>}
      <ul className="event-list past">
        {past.map(event => <EventRow key={event.id} event={event} identity={identity} isMember={isMember} isModerator={isModerator} rsvpBusy={rsvpBusyId === event.id} onRsvp={status => void rsvp(event, status)} onEdit={() => openForm(event)} onDelete={() => void removeEvent(event)}/>)}
      </ul>
    </section>
  )
}

function toLocalInput(iso: string): string {
  const date = new Date(iso)
  const pad = (value: number) => String(value).padStart(2, '0')
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`
}

function EventRow({ event, identity, isMember, isModerator, rsvpBusy, onRsvp, onEdit, onDelete }: {
  event: cm.CommunityEventRow
  identity: Identity | null
  isMember: boolean
  isModerator: boolean
  rsvpBusy: boolean
  onRsvp: (status: 'going' | 'interested' | 'not_going') => void
  onEdit: () => void
  onDelete: () => void
}) {
  const full = event.capacity != null && event.going_count >= event.capacity
  return (
    <li className={`event-row${event.past ? ' past' : ''}${event.cancelled ? ' cancelled' : ''}`}>
      <div className="event-when">
        <b>{new Date(event.starts_at).toLocaleString([], { month: 'short', day: 'numeric' })}</b>
        <span>{new Date(event.starts_at).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}</span>
      </div>
      <div className="event-data">
        <b>{event.title}{event.cancelled && <span className="event-cancel-chip">cancelled</span>}{event.past && !event.cancelled && <span className="event-past-chip">past</span>}</b>
        {event.description && <p>{event.description}</p>}
        <span className="event-meta">
          <Users size={12}/> {event.going_count} going · {event.interested_count} interested
          {event.capacity != null ? ` · cap ${event.capacity}` : ''}
          {event.venue ? <> · {event.venue.startsWith('http') ? 'online' : event.venue}</> : null}
        </span>
        {!event.past && (
          <div className="event-rsvp">
            <button
              className={`rsvp-btn${event.my_status === 'going' ? ' on' : ''}`}
              disabled={rsvpBusy || (!isMember && !identity)}
              onClick={() => onRsvp(event.my_status === 'going' ? 'not_going' : 'going')}
              title={full && event.my_status !== 'going' ? 'This event is full' : undefined}
            >
              {full && event.my_status !== 'going' ? 'Full' : event.my_status === 'going' ? 'Going — tap to withdraw' : 'Going'}
            </button>
            <button
              className={`rsvp-btn${event.my_status === 'interested' ? ' on' : ''}`}
              disabled={rsvpBusy || (!isMember && !identity)}
              onClick={() => onRsvp(event.my_status === 'interested' ? 'not_going' : 'interested')}
            >
              Interested
            </button>
          </div>
        )}
      </div>
      {isModerator && (
        <div className="event-org-tools">
          <button className="icon-button" onClick={onEdit} aria-label="Edit event"><Pencil size={15}/></button>
          <button className="icon-button" onClick={onDelete} aria-label="Delete event"><Trash2 size={15}/></button>
        </div>
      )}
    </li>
  )
}

/* -------------------------------------------------------------------------- */
/* Members panel + moderation                                                  */
/* -------------------------------------------------------------------------- */

function MembersPanel({ detail, identity, isModerator, isOwner, notify, onOpenMention }: {
  detail: cm.CommunityDetail
  identity: Identity | null
  isModerator: boolean
  isOwner: boolean
  notify: (message: string) => void
  onOpenMention: (profileId: string) => void
}) {
  const [rows, setRows] = useState<cm.CommunityMemberRow[]>([])
  const [requests, setRequests] = useState<cm.JoinRequestRow[]>([])
  const [query, setQuery] = useState('')
  const [debounced, setDebounced] = useState('')
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [inviteHandle, setInviteHandle] = useState('')
  const [busyUser, setBusyUser] = useState<string | null>(null)
  const [rowMenu, setRowMenu] = useState<string | null>(null)
  const [transferTarget, setTransferTarget] = useState<cm.CommunityMemberRow | null>(null)
  const [requestsOpen, setRequestsOpen] = useState(false)
  const canInvite = detail.privacy !== 'public' && detail.my_status === 'active' && !detail.archived

  useEffect(() => {
    const timer = window.setTimeout(() => setDebounced(query), 300)
    return () => window.clearTimeout(timer)
  }, [query])

  const load = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const [members, pending] = await Promise.all([
        cm.fetchCommunityMembers(detail.id, debounced),
        isModerator ? cm.fetchJoinRequests(detail.id) : Promise.resolve([]),
      ])
      setRows(members)
      setRequests(pending)
    } catch (err) {
      setError(friendlyMessage(err))
    } finally {
      setLoading(false)
    }
  }, [detail.id, debounced, isModerator])

  useEffect(() => {
    void load()
  }, [load])

  const runOnUser = async (userId: string, fn: () => Promise<unknown>, success: string) => {
    setBusyUser(userId)
    try {
      await fn()
      notify(success)
      await load()
    } catch (err) {
      notify(friendlyMessage(err))
      throw err
    } finally {
      setBusyUser(null)
    }
  }

  const invite = async () => {
    const handle = inviteHandle.trim().replace(/^@/, '')
    if (!handle) return
    try {
      const resolved = await db.findProfileIdByUsername(handle)
      if (!resolved) { notify(`No member found as @${handle}.`); return }
      await cm.inviteToCommunity(detail.id, resolved)
      notify(`Invitation sent to @${handle}.`)
      setInviteHandle('')
    } catch (err) {
      notify(friendlyMessage(err))
    }
  }

  return (
    <section className="community-members">
      <div className="member-toolbar">
        <div className="community-searchbar small">
          <Search size={16}/>
          <input value={query} onChange={event => setQuery(event.target.value)} placeholder="Search members" aria-label="Search members"/>
        </div>
        {isModerator && requests.length > 0 && (
          <button className="ghost-action" onClick={() => setRequestsOpen(v => !v)}>
            <UserPlus size={15}/> Join requests ({requests.length})
          </button>
        )}
        {canInvite && (
          <div className="invite-field">
            <input
              value={inviteHandle}
              onChange={event => setInviteHandle(event.target.value)}
              onKeyDown={event => { if (event.key === 'Enter') void invite() }}
              placeholder="@username to invite"
            />
            <button className="primary-button" onClick={() => void invite()}><Plus size={14}/> Invite</button>
          </div>
        )}
      </div>

      {requestsOpen && isModerator && (
        <div className="join-request-board">
          <header><h4>Join requests</h4><button className="icon-button" onClick={() => setRequestsOpen(false)} aria-label="Close"><X size={15}/></button></header>
          {requests.length === 0 && <p className="empty-inline">No pending requests right now.</p>}
          {requests.map(request => (
            <div key={request.user_id} className="member-row pending">
              <button className="search-row-link" onClick={() => onOpenMention(request.user_id)}>
                <span className="avatar">{request.avatar_url ? <img src={request.avatar_url} alt=""/> : initialsFor(request.display_name ?? '?', request.username ?? '')}</span>
                <span className="row-id"><b>{request.display_name ?? 'Student'}</b>{request.username && <span>@{request.username}</span>}</span>
              </button>
              <div className="row-tools">
                <button className="mini-approve" disabled={busyUser === request.user_id} onClick={() => void runOnUser(request.user_id, () => cm.respondJoinRequest(detail.id, request.user_id, true), `${request.display_name ?? 'They'} joined.`)}>Accept</button>
                <button className="mini-deny" disabled={busyUser === request.user_id} onClick={() => void runOnUser(request.user_id, () => cm.respondJoinRequest(detail.id, request.user_id, false), 'Request declined.')}>Decline</button>
              </div>
            </div>
          ))}
        </div>
      )}

      {error && (
        <div className="community-error" role="alert"><p>{error}</p><button onClick={() => void load()}>Try again</button></div>
      )}
      {loading && <div className="detail-loading-panel small"><Loader2 size={16} className="spin"/> Loading members…</div>}
      {!loading && rows.length === 0 && !error && (
        <div className="empty-state small"><Users size={24}/><b>No members found</b><span>{debounced ? 'Try another name.' : 'Nobody has joined yet.'}</span></div>
      )}

      <ul className="member-list">
        {rows.map(row => {
          const roleLabel = row.role === 'owner' || row.role === 'admin' ? 'Owner' : row.role === 'moderator' ? 'Moderator' : ''
          const isTargetOwner = row.role === 'owner' || row.role === 'admin'
          return (
            <li key={row.user_id} className="member-row">
              <button className="search-row-link" onClick={() => onOpenMention(row.user_id)}>
                <span className="avatar">{row.avatar_url ? <img src={row.avatar_url} alt=""/> : initialsFor(row.display_name ?? '?', row.username ?? '')}</span>
                <span className="row-id">
                  <b>{row.display_name ?? 'Student'}</b>
                  {row.is_verified && <BadgeCheck size={14} className="verified-tick"/>}
                  {row.username && <span>@{row.username}</span>}
                </span>
              </button>
              {roleLabel && <span className="member-role-chip">{roleLabel}</span>}
              <span className="member-since">joined {relativeTime(row.joined_at)}</span>

              {identity && row.user_id !== identity.id && (isOwner || isModerator) && (
                <div className="row-tools">
                  <button className="icon-button" onClick={() => setRowMenu(rowMenu === row.user_id ? null : row.user_id)} aria-label={`Manage ${row.display_name ?? 'member'}`} disabled={busyUser === row.user_id}>
                    {busyUser === row.user_id ? <Loader2 size={15} className="spin"/> : <MoreHorizontal size={16}/>}
                  </button>
                  {rowMenu === row.user_id && (
                    <div className="member-menu">
                      {isOwner && !isTargetOwner && (row.role === 'moderator'
                        ? <button onClick={() => void runOnUser(row.user_id, () => cm.setMemberRole(detail.id, row.user_id, 'member'), 'Demoted to member.').catch(() => {})}><Users size={14}/> Make member</button>
                        : <button onClick={() => void runOnUser(row.user_id, () => cm.setMemberRole(detail.id, row.user_id, 'moderator'), 'Promoted to moderator.').catch(() => {})}><Settings size={14}/> Make moderator</button>)}
                      {isOwner && !isTargetOwner && (
                        <button onClick={() => { setRowMenu(null); setTransferTarget(row) }}><BadgeCheck size={14}/> Transfer ownership</button>
                      )}
                      <button className="danger" onClick={() => void runOnUser(row.user_id, () => cm.removeMember(detail.id, row.user_id, true), 'Removed and banned from rejoining.' ).catch(() => {})}><Trash2 size={14}/> Ban from community</button>
                      <button onClick={() => void runOnUser(row.user_id, () => cm.removeMember(detail.id, row.user_id, false), 'Removed from the community.').catch(() => {})}><X size={14}/> Remove (can re-request)</button>
                    </div>
                  )}
                </div>
              )}
            </li>
          )
        })}
      </ul>

      {transferTarget && (
        <div className="overlay" onMouseDown={event => { if (event.target === event.currentTarget) setTransferTarget(null) }}>
          <section className="report-dialog" role="dialog" aria-modal="true">
            <button className="modal-close icon-button" onClick={() => setTransferTarget(null)} aria-label="Close"><X size={18}/></button>
            <span className="prompt-icon"><Settings size={20}/></span>
            <h3 className="report-heading">Transfer ownership to {transferTarget.display_name ?? 'this member'}?</h3>
            <p className="confirm-body">You become a moderator; they become the owner and can archive, restyle the leadership and transfer again.</p>
            <div className="wizard-actions inline">
              <button className="secondary-button" onClick={() => setTransferTarget(null)}>Keep ownership</button>
              <button
                className="primary-button"
                onClick={async () => {
                  try {
                    await cm.transferOwnership(detail.id, transferTarget.user_id)
                    notify('Ownership transferred.')
                    setTransferTarget(null)
                    await load()
                  } catch (err) {
                    notify(friendlyMessage(err))
                  }
                }}
              >
                Transfer
              </button>
            </div>
          </section>
        </div>
      )}
    </section>
  )
}

/* -------------------------------------------------------------------------- */
/* About panel                                                                 */
/* -------------------------------------------------------------------------- */

function AboutPanel({ detail, identity, isModerator, isOwner, notify, onChanged }: {
  detail: cm.CommunityDetail
  identity: Identity | null
  isModerator: boolean
  isOwner: boolean
  notify: (message: string) => void
  onChanged: () => void
}) {
  const [reports, setReports] = useState<cm.CommunityReportRow[] | null>(null)
  const [reportsOpen, setReportsOpen] = useState(false)

  const loadReports = useCallback(async () => {
    if (!isModerator) return
    try {
      setReports(await cm.fetchCommunityReports(detail.id))
    } catch (err) {
      notify(friendlyMessage(err))
      setReports([])
    }
  }, [detail.id, isModerator, notify])

  useEffect(() => {
    if (reportsOpen && reports === null) void loadReports()
  }, [reportsOpen, reports, loadReports])

  const isModeratorGuard = isModerator

  return (
    <section className="community-about">
      <div className="about-block">
        <h4>About</h4>
        <p>{detail.description || 'This community has no description yet.'}</p>
        <dl className="about-facts">
          <div><dt>Created</dt><dd>{new Date(detail.created_at).toLocaleDateString()} by <b>{detail.creator_name ?? 'a member'}</b></dd></div>
          <div><dt>Scope</dt><dd>{detail.scope === 'college' ? `College — ${detail.college_name ?? 'a specific college'}` : 'Global — open across colleges'}</dd></div>
          <div><dt>Privacy</dt><dd>{detail.privacy === 'public' ? 'Public — anyone can read the feed' : detail.privacy === 'private' ? 'Private — joining needs approval' : 'Hidden — members only, invitation-only joins'}</dd></div>
          <div><dt>Members</dt><dd>{detail.member_count}</dd></div>
          <div><dt>Posts</dt><dd>{detail.post_count}</dd></div>
          <div><dt>Upcoming events</dt><dd>{detail.event_count}</dd></div>
        </dl>
      </div>

      <div className="about-block">
        <h4>Community rules</h4>
        {detail.rules.trim()
          ? <ul className="rules-list">{detail.rules.split('\n').filter(Boolean).map((line, index) => <li key={index}>{line.trim()}</li>)}</ul>
          : 'No rules yet — the community-wide CAMPUS guidelines still apply, and platform safety always outranks community preferences.'}
      </div>

      {isModeratorGuard && (
        <div className="about-block">
          <h4>Moderation</h4>
          <p>Reports filed against this community — never visible to the reporter's community, only to the moderation team.</p>
          <button className="ghost-action" onClick={() => setReportsOpen(v => !v)}><Flag size={14}/> {reportsOpen ? 'Hide reports' : `Review reports${reports && reports.length ? ` (${reports.length})` : ''}`}</button>
          {reportsOpen && reports && (
            <ul className="report-list">
              {reports.length === 0 && <p className="empty-inline">No reports filed for this community yet.</p>}
              {reports.map(report => (
                <li key={report.id}>
                  <b>{report.reason}</b>
                  {report.details && <p>{report.details}</p>}
                  <span>by {report.reporter_name ?? 'a member'} · <span className="capitalize">{report.status}</span> · {relativeTime(report.created_at)}</span>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}

      <p className="about-footnote">
        One honest limitation: threaded "Discussion" posts are served by the community feed for now — this page's feed covers text, images, comments, reactions and pinned announcements.
      </p>
    </section>
  )
}
