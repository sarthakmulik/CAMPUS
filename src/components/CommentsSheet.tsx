import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { useBodyScrollLock } from '../lib/scrollLock'
import { createPortal } from 'react-dom'
import { BadgeCheck, Check, Heart, MessageCircle, Pencil, Pin, Send, Trash2, X } from 'lucide-react'
import {
  addComment, deleteComment, fetchComments, friendlyMessage, relativeTime,
  setCommentPinned, toggleCommentLike, updateComment, type CampusComment,
} from '../lib/db'
import type { CampusPost } from '../types'
import { attachSheetDismiss } from '../lib/sheetDismiss'

type CommentsSheetProps = {
  post: CampusPost
  userId: string | null
  identity: { name: string; username: string; initials: string }
  requireAuth: (reason: string) => boolean
  /** 'light' = feed sheets, 'dark' = Discover reels theme. */
  theme?: 'light' | 'dark'
  /** post-detail variant: the sheet shows the full post above its thread —
   *  the canonical destination for tapping a post card (profile grid). The
   *  post node is rendered by App so it can reuse the ONE PostCard with all
   *  of its existing action handlers; this component stays comments-logic-only. */
  detail?: boolean
  detailNode?: ReactNode
  onClose: () => void
  /** Syncs the live comment count back to the feed/reel that opened the sheet. */
  onCountChange: (count: number) => void
}

type ThreadRow = { parent: CampusComment; replies: CampusComment[] }

/**
 * Instagram-style comment thread for any post kind (text / image / reel):
 * replies to comments (one level), comment likes, and pinning by the post
 * author. One component for both themes: the feed uses the light bottom
 * sheet, Discover opens it in the dark reels theme.
 */
export default function CommentsSheet({
  post, userId, identity, requireAuth, theme = 'light', detail = false, detailNode = null, onClose, onCountChange,
}: CommentsSheetProps) {
  // bottom sheet over a dimmed overlay — keep the feed from scrolling behind it
  useBodyScrollLock()
  // Escape closes, matching the drawer's dismissal contract (keyboard a11y)
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose() }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [onClose])
  // swipe-to-dismiss attaches through a ref callback; holder keeps the teardown
  const dismissRef = useRef<(() => void) | null>(null)
  const [comments, setComments] = useState<CampusComment[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [draft, setDraft] = useState('')
  const [busy, setBusy] = useState(false)
  const [editingId, setEditingId] = useState<string | null>(null)
  const [editDraft, setEditDraft] = useState('')
  const [editBusy, setEditBusy] = useState(false)
  const [armedDelete, setArmedDelete] = useState<string | null>(null)
  const [replyTo, setReplyTo] = useState<CampusComment | null>(null)
  const [pinBusy, setPinBusy] = useState<string | null>(null)
  /** parent comment ids whose replies are slid open (Instagram: closed by default) */
  const [openReplies, setOpenReplies] = useState<Set<string>>(new Set())
  const listRef = useRef<HTMLDivElement | null>(null)

  const isPostAuthor = Boolean(userId && !post.anonymous && post.authorId && post.authorId === userId)

  const load = async () => {
    setLoading(true)
    setError(null)
    try {
      const rows = await fetchComments(post.id)
      setComments(rows)
      onCountChange(rows.length)
    } catch (err) {
      setError(friendlyMessage(err))
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => { void load() /* eslint-disable-line react-hooks/exhaustive-deps */ }, [post.id])

  // threads render top but a new comment/reply lands at the bottom — keep seen
  const grouped = useMemo<ThreadRow[]>(() => {
    const parents = comments.filter(c => !c.parentId)
    const byParent = new Map<string, CampusComment[]>()
    for (const c of comments) {
      if (!c.parentId) continue
      const list = byParent.get(c.parentId) ?? []
      list.push(c)
      byParent.set(c.parentId, list)
    }
    return parents.map(parent => ({ parent, replies: byParent.get(parent.id) ?? [] }))
      .sort((a, b) => Number(Boolean(b.parent.pinnedAt)) - Number(Boolean(a.parent.pinnedAt)))
  }, [comments])

  useEffect(() => {
    const list = listRef.current
    if (list) list.scrollTop = list.scrollHeight
  }, [comments.length, loading])

  const toggleReplies = (parentId: string) => {
    setOpenReplies(current => {
      const next = new Set(current)
      if (next.has(parentId)) next.delete(parentId)
      else next.add(parentId)
      return next
    })
  }

  /** Replying always targets a parent (one level deep, server-enforced) —
   *  a reply button on a reply answers that thread's parent. */
  const startReply = (comment: CampusComment) => {
    const target = comment.parentId
      ? comments.find(c => c.id === comment.parentId) ?? comment
      : comment
    setReplyTo(target)
    setOpenReplies(current => new Set(current).add(target.id))
  }

  const armDelete = (id: string) => {
    setArmedDelete(id)
    window.setTimeout(() => setArmedDelete(current => current === id ? null : current), 3000)
  }

  const submit = async () => {
    const body = draft.trim()
    if (!body) return
    if (!userId) { requireAuth('join the conversation'); return }
    setBusy(true)
    try {
      const created = await addComment(
        post.id, userId, body,
        identity.name, identity.username,
        replyTo?.id ?? null,
      )
      setComments(current => [...current, created])
      onCountChange(comments.length + 1)
      setDraft('')
      if (replyTo) {
        // slide the thread open so the new reply is visible where it lands
        setOpenReplies(current => new Set(current).add(replyTo.id))
        setReplyTo(null)
      }
    } catch (err) {
      setError(friendlyMessage(err))
    } finally {
      setBusy(false)
    }
  }

  const startEdit = (comment: CampusComment) => {
    setEditingId(comment.id)
    setEditDraft(comment.body)
  }

  const saveEdit = async (comment: CampusComment) => {
    const body = editDraft.trim()
    if (!body) return
    setEditBusy(true)
    try {
      const editedAt = await updateComment(comment.id, body)
      setComments(current => current.map(c => c.id === comment.id
        ? { ...c, body, editedAt: editedAt ?? new Date().toISOString(), time: relativeTime(new Date().toISOString()) }
        : c))
      setEditingId(null)
      setEditDraft('')
    } catch (err) {
      setError(friendlyMessage(err))
    } finally {
      setEditBusy(false)
    }
  }

  const remove = async (comment: CampusComment) => {
    // deleting a parent takes its replies with it (server cascade)
    if (armedDelete !== comment.id) { armDelete(comment.id); return }
    try {
      await deleteComment(comment.id)
      const removedCount = comment.parentId
        ? 1
        : 1 + (grouped.find(row => row.parent.id === comment.id)?.replies.length ?? 0)
      setComments(current => current.filter(c => c.id !== comment.id && c.parentId !== comment.id))
      onCountChange(Math.max(0, comments.length - removedCount))
    } catch (err) {
      setError(friendlyMessage(err))
    } finally {
      setArmedDelete(null)
    }
  }

  const like = async (comment: CampusComment) => {
    if (!userId) { requireAuth('like comments'); return }
    const target = !comment.likedByMe
    setComments(current => current.map(c => c.id === comment.id
      ? { ...c, likedByMe: target, likes: c.likes + (target ? 1 : -1) }
      : c))
    try {
      await toggleCommentLike(comment.id, userId, target)
    } catch (err) {
      setError(friendlyMessage(err))
      setComments(current => current.map(c => c.id === comment.id
        ? { ...c, likedByMe: comment.likedByMe, likes: comment.likes }
        : c))
    }
  }

  const pin = async (comment: CampusComment) => {
    if (!isPostAuthor) return
    setPinBusy(comment.id)
    try {
      await setCommentPinned(comment.id, !comment.pinnedAt)
      // refetch so the pinned comment moves with real server state
      await load()
    } catch (err) {
      setError(friendlyMessage(err))
    } finally {
      setPinBusy(null)
    }
  }

  const onKeyDown = (event: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault()
      void submit()
    }
  }

  const renderBody = (comment: CampusComment, isReply: boolean) => {
    const isOwn = Boolean(userId && comment.authorId === userId)
    const editing = editingId === comment.id
    return (
      <div className={`comment-row ${isReply ? 'reply' : ''}`} key={comment.id}>
        <span className="comment-avatar">{comment.initials}</span>
        <div className="comment-main">
          {comment.pinnedAt && <span className="comment-pinned"><Pin size={11}/> Pinned</span>}
          {editing ? (
            <div className="comment-edit">
              <textarea value={editDraft} onChange={e => setEditDraft(e.target.value)} rows={2} maxLength={500} autoFocus/>
              <div className="comment-edit-actions">
                <button className="comment-mini" onClick={() => { setEditingId(null); setEditDraft('') }}>Cancel</button>
                <button className="comment-mini primary" disabled={editBusy} onClick={() => void saveEdit(comment)}>
                  {editBusy ? 'Saving…' : 'Save'}
                </button>
              </div>
            </div>
          ) : (
            <>
              <div className="comment-head">
                <b>{comment.author}</b>
                {comment.authorVerified && <BadgeCheck size={13} className="verified-tick"/>}
                {comment.handle && <span>{comment.handle}</span>}
                <span className="comment-time">· {comment.time}</span>
                {comment.editedAt && <span className="comment-time">· edited {relativeTime(comment.editedAt)}</span>}
              </div>
              <p className="comment-body">{comment.body}</p>
              <div className="comment-tools">
                <button onClick={() => startReply(comment)}>Reply</button>
                {isPostAuthor && (
                  <button disabled={pinBusy !== null} onClick={() => void pin(comment)}>
                    <Pin size={12}/> {comment.pinnedAt ? 'Unpin' : 'Pin'}
                  </button>
                )}
                {isOwn && (
                  <>
                    <button onClick={() => startEdit(comment)}><Pencil size={13}/> Edit</button>
                    <button className={armedDelete === comment.id ? 'armed' : ''} onClick={() => void remove(comment)}>
                      {armedDelete === comment.id ? <><Check size={13}/> Tap again</> : <><Trash2 size={13}/> Delete</>}
                    </button>
                  </>
                )}
              </div>
            </>
          )}
        </div>
        <button
          className={`comment-like ${comment.likedByMe ? 'on' : ''}`}
          onClick={() => void like(comment)}
          aria-label={comment.likedByMe ? 'Unlike comment' : 'Like comment'}
        >
          <Heart size={13} fill={comment.likedByMe ? 'currentColor' : 'none'}/>
          {comment.likes > 0 && <span>{comment.likes}</span>}
        </button>
      </div>
    )
  }

  return createPortal(
    <div className="overlay comments-overlay" onMouseDown={e => { if (e.target === e.currentTarget) onClose() }}>
      <section className={`bottom-sheet comments-sheet ${theme === 'dark' ? 'dark' : ''}${detail ? ' detail' : ''}`} role="dialog" aria-label={detail ? 'Post detail' : `Comments on ${post.anonymous ? 'this post' : 'this post'}`} ref={el => { dismissRef.current?.(); dismissRef.current = el ? attachSheetDismiss(el, onClose) : null }}>
        <div className="sheet-handle"/>
        <div className="sheet-heading">
          <div>
            <span className="eyebrow">{detail ? 'POST' : post.anonymous ? 'CONFESS THREAD' : 'CAMPUS THREAD'}</span>
            <h2>{`Comments${comments.length > 0 ? ` · ${comments.length}` : ''}`}</h2>
          </div>
          <button className="icon-button" onClick={onClose} aria-label="Close comments"><X size={20}/></button>
        </div>
        {detail && detailNode && <div className="comments-detail-post">{detailNode}</div>}

        <div id={detail ? 'detail-comments' : undefined} className="comments-list" ref={listRef}>
          {loading && <p className="comments-status">Loading comments…</p>}
          {error && (
            <div className="comments-error">
              <p>{error}</p>
              <button className="comments-retry" onClick={() => void load()}>Try again</button>
            </div>
          )}
          {!loading && !error && comments.length === 0 && (
            <p className="comments-empty"><MessageCircle size={26}/><b>No comments yet</b><span>Be the first to reply — keep it kind.</span></p>
          )}
          {!loading && !error && grouped.map(row => {
            const open = openReplies.has(row.parent.id)
            const count = row.replies.length
            return (
              <div className="comment-thread" key={row.parent.id}>
                {renderBody(row.parent, false)}
                {count > 0 && (
                  <button className="comment-view-replies" onClick={() => toggleReplies(row.parent.id)}>
                    <i className={open ? 'up' : ''}/>
                    {open ? 'Hide replies' : `View ${count} ${count === 1 ? 'reply' : 'replies'}`}
                  </button>
                )}
                {count > 0 && (
                  <div className={`comment-replies ${open ? 'open' : ''}`}>
                    <div className="comment-replies-inner">
                      {row.replies.map(reply => renderBody(reply, true))}
                    </div>
                  </div>
                )}
              </div>
            )
          })}
        </div>

        {replyTo && (
          <div className="replying-banner">
            <span>Replying to <b>{replyTo.author}</b></span>
            <button onClick={() => setReplyTo(null)}>Cancel</button>
          </div>
        )}

        <div className="comment-composer">
          <span className="comment-avatar you">{identity.initials}</span>
          <textarea
            className="comment-input"
            value={draft}
            onChange={e => setDraft(e.target.value)}
            onKeyDown={onKeyDown}
            placeholder={replyTo
              ? `Reply to ${replyTo.author}…`
              : post.anonymous ? 'Reply to this confession…' : 'Add a comment…'}
            maxLength={500}
            rows={1}
          />
          <button
            className="comment-send"
            disabled={busy || !draft.trim()}
            onClick={() => void submit()}
            aria-label={replyTo ? 'Post reply' : 'Post comment'}
          >
            <Send size={16}/>
          </button>
        </div>
        <div className="comment-counter">{draft.length}/500</div>
      </section>
    </div>,
    document.body,
  )
}
