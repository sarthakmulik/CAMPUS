import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { Check, MessageCircle, Pencil, Send, Trash2, X } from 'lucide-react'
import {
  addComment, deleteComment, fetchComments, friendlyMessage, relativeTime,
  updateComment, type CampusComment,
} from '../lib/db'
import type { CampusPost } from '../types'

type CommentsSheetProps = {
  post: CampusPost
  userId: string | null
  identity: { name: string; username: string; initials: string }
  requireAuth: (reason: string) => boolean
  /** 'light' = feed sheets, 'dark' = Discover reels theme. */
  theme?: 'light' | 'dark'
  onClose: () => void
  /** Syncs the live comment count back to the feed/reel that opened the sheet. */
  onCountChange: (count: number) => void
}

/**
 * Comment thread for any post kind (text / image / reel). One component for
 * both themes: the feed uses the standard light bottom sheet, Discover opens
 * it in the dark reels theme. Edit + delete are only offered on your own
 * comments, with the same "edited · time" marker used by posts.
 */
export default function CommentsSheet({
  post, userId, identity, requireAuth, theme = 'light', onClose, onCountChange,
}: CommentsSheetProps) {
  const [comments, setComments] = useState<CampusComment[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [draft, setDraft] = useState('')
  const [busy, setBusy] = useState(false)
  const [editingId, setEditingId] = useState<string | null>(null)
  const [editDraft, setEditDraft] = useState('')
  const [editBusy, setEditBusy] = useState(false)
  const [armedDelete, setArmedDelete] = useState<string | null>(null)
  const listRef = useRef<HTMLDivElement | null>(null)

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

  // Newest comment is at the bottom — keep the thread scrolled to it.
  useEffect(() => {
    const list = listRef.current
    if (list) list.scrollTop = list.scrollHeight
  }, [comments.length, loading])

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
      )
      setComments(current => [...current, created])
      onCountChange(comments.length + 1)
      setDraft('')
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
    if (armedDelete !== comment.id) { armDelete(comment.id); return }
    try {
      await deleteComment(comment.id)
      setComments(current => current.filter(c => c.id !== comment.id))
      onCountChange(Math.max(0, comments.length - 1))
    } catch (err) {
      setError(friendlyMessage(err))
    } finally {
      setArmedDelete(null)
    }
  }

  const onKeyDown = (event: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault()
      void submit()
    }
  }

  return createPortal(
    <div className="overlay comments-overlay" onMouseDown={e => { if (e.target === e.currentTarget) onClose() }}>
      <section className={`bottom-sheet comments-sheet ${theme === 'dark' ? 'dark' : ''}`} role="dialog" aria-label={`Comments on ${post.anonymous ? 'this post' : 'this post'}`}>
        <div className="sheet-handle"/>
        <div className="sheet-heading">
          <div>
            <span className="eyebrow">{post.anonymous ? 'CONFESS THREAD' : 'CAMPUS THREAD'}</span>
            <h2>Comments{comments.length > 0 ? ` · ${comments.length}` : ''}</h2>
          </div>
          <button className="icon-button" onClick={onClose} aria-label="Close comments"><X size={20}/></button>
        </div>

        <div className="comments-list" ref={listRef}>
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
          {comments.map(comment => {
            const isOwn = Boolean(userId && comment.authorId === userId)
            const editing = editingId === comment.id
            return (
              <div className="comment-row" key={comment.id}>
                <span className="comment-avatar">{comment.initials}</span>
                <div className="comment-main">
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
                        {comment.handle && <span>{comment.handle}</span>}
                        <span className="comment-time">· {comment.time}</span>
                        {comment.editedAt && <span className="comment-time">· edited {relativeTime(comment.editedAt)}</span>}
                      </div>
                      <p className="comment-body">{comment.body}</p>
                      {isOwn && (
                        <div className="comment-own-actions">
                          <button onClick={() => startEdit(comment)}><Pencil size={13}/> Edit</button>
                          <button className={armedDelete === comment.id ? 'armed' : ''} onClick={() => void remove(comment)}>
                            {armedDelete === comment.id ? <><Check size={13}/> Tap again</> : <><Trash2 size={13}/> Delete</>}
                          </button>
                        </div>
                      )}
                    </>
                  )}
                </div>
              </div>
            )
          })}
        </div>

        <div className="comment-composer">
          <span className="comment-avatar you">{identity.initials}</span>
          <textarea
            className="comment-input"
            value={draft}
            onChange={e => setDraft(e.target.value)}
            onKeyDown={onKeyDown}
            placeholder={post.anonymous ? 'Reply to this confession…' : 'Add a comment…'}
            maxLength={500}
            rows={1}
          />
          <button
            className="comment-send"
            disabled={busy || !draft.trim()}
            onClick={() => void submit()}
            aria-label="Post comment"
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
