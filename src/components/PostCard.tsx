import { useEffect, useRef, useState } from 'react'
import { useSavedFlag } from '../lib/bookmarks'
import {
  BadgeCheck, BookOpen, Bookmark, ChartNoAxesColumn, Check, EyeOff, Flag, Heart,
  MessageCircle, MoreHorizontal, Pencil, Pin, Repeat2, Share2, Sparkles, Trash2, VolumeX,
} from 'lucide-react'
import { relativeTime } from '../lib/db'
import type { CampusPost, PollState } from '../types'
import RichText from './RichText'
import ReelPlayer from './ReelPlayer'

export interface PostCardProps {
  post: CampusPost
  isOwn: boolean
  onLike: () => void
  onSave: () => void
  onComment: () => void
  onShare: () => void
  onReport: () => void
  onRepost: () => void
  onBlock: () => void
  onMute: () => void
  onEdit: () => void
  onDelete: () => void
  onMessage: () => void
  /** Moderators pin announcements inside community feeds; absent elsewhere. */
  onPin?: () => void
  onOpenMention: (profileId: string) => void
  onOpenTag: (query: string) => void
  /** hydrated poll state (batched with the feed page). `undefined` = still
   *  loading, `null` = unavailable; only polls carry these. */
  poll?: PollState | null
  /** submits the whole selection; resolves success so the UI can roll back */
  onVote?: (optionIds: string[]) => Promise<boolean>
}

/** "Ends in 2 days 5 hours" / "Ended 3 hours ago" — derived from the DB's
 *  closes_at (UTC storage, local display), never from a client timer. */
function closeLabel(state: PollState): string {
  if (!state.closesAt) return 'Open poll'
  const end = new Date(state.closesAt).getTime()
  const diff = end - Date.now()
  if (diff <= 0) return `Poll ended ${relativeTime(state.closesAt)}`
  const minutes = Math.floor(diff / 60000)
  const days = Math.floor(minutes / 1440)
  const hours = Math.floor((minutes % 1440) / 60)
  const mins = minutes % 60
  if (minutes < 60) return `Ends in ${mins} min`
  if (days >= 1) return hours >= 1 ? `Ends in ${days}d ${hours}h` : `Ends in ${days}d`
  return `Ends in ${hours}h`
}

/**
 * The poll voting block. Before voting, options are plain tappable choices
 * (single choice taps through at once; multiple choice toggles and submits
 * explicitly). After voting — or once the poll ends — they become result
 * bars driven by the server state: counts + rounded percentages, with the
 * reader's own selection highlighted. A real failure rolls everything back
 * and reports through `onVote`'s success=false + parent notify.
 */
function PollBlock({ poll, onVote }: { poll: PollState; onVote?: (optionIds: string[]) => Promise<boolean> }) {
  const hasVoted = poll.options.some(option => option.mine)
  const [picking, setPicking] = useState(false)
  const initialMineKey = poll.options.filter(option => option.mine).map(option => option.id).join(',')
  const [selection, setSelection] = useState<string[]>(() =>
    poll.options.filter(option => option.mine).map(option => option.id))
  const [busy, setBusy] = useState(false)
  const [selectionError, setSelectionError] = useState('')
  const lastMineKey = useRef(initialMineKey)

  // A new authoritative state (e.g. after voting elsewhere, or state refresh)
  // re-syncs the local picker; the ref avoids fighting the user's edits.
  useEffect(() => {
    const mineKey = poll.options.filter(option => option.mine).map(option => option.id).join(',')
    if (mineKey !== lastMineKey.current) {
      lastMineKey.current = mineKey
      setSelection(poll.options.filter(option => option.mine).map(option => option.id))
    }
  }, [initialMineKey, poll.options])

  const votingAllowed = Boolean(onVote) && poll.isOpen && !busy
  const showResults = !poll.isOpen || hasVoted
  const showPickers = votingAllowed && !showResults || (poll.isOpen && hasVoted && picking && votingAllowed)

  const toggle = (optionId: string) => {
    if (!votingAllowed) return
    setSelectionError('')
    if (poll.multipleChoice) {
      setSelection(current => current.includes(optionId)
        ? current.filter(id => id !== optionId)
        : [...current, optionId])
    } else {
      setPicking(false) // direct re-vote attempt; submit immediately below
      void submit([optionId])
    }
  }

  const submit = async (ids?: string[]) => {
    const finalIds = (ids ?? selection).filter(Boolean)
    if (!finalIds.length) { setSelectionError('Pick at least one option.'); return }
    if (!onVote) return
    setBusy(true)
    setSelectionError('')
    const ok = await onVote(finalIds)
    setBusy(false)
    if (ok) {
      lastMineKey.current = finalIds.join(',')
      setPicking(false)
    } else {
      // authoritative state arrives separately; restore picker if it changed
      setSelection(poll.options.filter(option => option.mine).map(option => option.id))
      if (!hasVoted) setPicking(true)
    }
  }

  const total = poll.totalVotes

  return (
    <div className="poll-block" role="group" aria-label="Campus poll">
      <div className="poll-status-row">
        {poll.multipleChoice && <span className="poll-chip multi">Multiple choices allowed</span>}
        {poll.isOpen
          ? <span className="poll-chip time">{closeLabel(poll)}</span>
          : <span className="poll-chip ended">Poll ended</span>}
        {showResults && poll.isOpen && <span className="poll-chip recorded"><Check size={12}/> Your vote is recorded</span>}
        {showResults && <span className="poll-chip results">Results <i>·</i> {total} {total === 1 ? 'vote' : 'votes'}</span>}
      </div>

      <div className="poll-options">
        {poll.options.map(option => {
          const pct = total > 0 ? Math.round((option.votes / total) * 100) : 0
          const barStyle = { width: `${Math.min(pct, 100)}%` }
          const pickedHere = poll.options.some(entry => entry.mine && entry.id === option.id)
          const selectedHere = selection.includes(option.id)
          const interactive = showPickers && votingAllowed
          return interactive ? (
            <button
              key={option.id}
              className={`poll-option pick ${selectedHere ? 'checked' : ''}${poll.multipleChoice ? ' multi' : ''}`}
              onClick={() => toggle(option.id)}
              aria-pressed={selectedHere ? 'true' : 'false'}
              disabled={busy}
            >
              {poll.multipleChoice && <span className={`poll-box ${selectedHere ? 'on' : ''}`}>{selectedHere && <Check size={13}/>}</span>}
              <span className="poll-option-label">{option.label}</span>
            </button>
          ) : (
            <button
              key={option.id}
              className={`poll-option result ${pickedHere ? 'mine' : ''}`}
              onClick={() => { if (poll.isOpen && pickedHere && onVote) setPicking(true) }}
              aria-label={pickedHere ? `${option.label}, your pick, ${pct}% of ${total} votes` : `${option.label}, ${pct}% of ${total} votes`}
            >
              {pickedHere && showResults && <Check size={14} className="poll-mine-tick" aria-hidden="true"/>}
              <span className="poll-bar" style={barStyle} aria-hidden="true"/>
              <span className="poll-option-line">
                <span className="poll-option-label">{option.label}</span>
                <span className="poll-figures">{pct}% <i>·</i> {option.votes} {option.votes === 1 ? 'vote' : 'votes'}</span>
              </span>
            </button>
          )
        })}
      </div>

      {total === 0 && showResults && <p className="poll-hint">No votes yet{showPickers ? ' — tap an option above to vote.' : ' — be the first to vote once it opens.'}</p>}
      {selectionError && <p className="poll-error" role="alert">{selectionError}</p>}

      {poll.multipleChoice && showPickers && votingAllowed && (
        <button className="poll-submit" disabled={busy || selection.length === 0} onClick={() => void submit()}>
          {busy ? 'Recording…' : `Submit vote${selection.length > 1 ? ` (${selection.length})` : ''}`}
        </button>
      )}
      {poll.isOpen && hasVoted && !picking && votingAllowed && (
        <button className="poll-change" onClick={() => {
          setSelection(poll.options.filter(option => option.mine).map(option => option.id))
          setPicking(true)
        }}>
          Change your vote
        </button>
      )}
      {!poll.isOpen && <p className="poll-hint">This poll is closed — results are final.</p>}
    </div>
  )
}

export function PostCard({
  post, isOwn, onLike, onSave, onComment, onShare, onReport, onRepost,
  onBlock, onMute, onEdit, onDelete, onMessage, onPin, onOpenMention, onOpenTag,
  poll, onVote,
}: PostCardProps) {
  const [menuOpen, setMenuOpen] = useState(false)
  const [slide, setSlide] = useState(0)
  const slides = post.media ?? []
  const canActOnAuthor = Boolean(post.handle) && !post.anonymous
  // the saved flag comes from the shared saved store (persisted through
  // post_bookmarks), so every feed that renders this card shows one truth
  const saved = useSavedFlag(post.kind === 'reel' ? 'reel' : 'post', post.id)
  const trackRef = useRef<HTMLDivElement | null>(null)
  const onTrackScroll = () => {
    const track = trackRef.current
    if (!track || slides.length < 2) return
    const index = Math.round(track.scrollLeft / track.clientWidth)
    setSlide(index > slides.length - 1 ? slides.length - 1 : index < 0 ? 0 : index)
  }
  const goSlide = (index: number) => {
    setSlide(index)
    const track = trackRef.current
    if (track) track.scrollTo({ left: index * track.clientWidth, behavior: 'smooth' })
  }
  const mediaBlock = slides.length === 1 ? (
    post.kind === 'reel'
      ? <ReelPlayer src={slides[0]} />
      : <img className="post-media" src={slides[0]} alt="" loading="lazy"/>
  ) : slides.length > 1 ? (
    <div className="carousel" role="group" aria-label="Image carousel">
      <div className="carousel-track" data-no-page-swipe="true" ref={trackRef} onScroll={onTrackScroll}>
        {slides.map(url => <img key={url} src={url} alt="" loading="lazy" draggable={false}/>)}
      </div>
      {slides.length > 1 && <div className="carousel-dots">{slides.map((url, index) => <button key={url} className={index === slide ? 'on' : ''} onClick={() => goSlide(index)} aria-label={`Image ${index + 1} of ${slides.length}`}/>)}</div>}
      {slides.length > 1 && <>
        <button className="carousel-arrow left" onClick={() => goSlide(Math.max(0, slide - 1))} aria-label="Previous image" disabled={slide === 0}>‹</button>
        <button className="carousel-arrow right" onClick={() => goSlide(Math.min(slides.length - 1, slide + 1))} aria-label="Next image" disabled={slide === slides.length - 1}>›</button>
      </>}
    </div>
  ) : null
  const pollBlock = post.kind === 'poll' ? (
    poll === undefined
      ? <p className="poll-loading" role="status"><ChartNoAxesColumn size={14}/> Loading poll results…</p>
      : poll === null
        ? <p className="poll-hint">Poll results are unavailable right now.</p>
        : <PollBlock poll={poll} onVote={onVote}/>
  ) : null
  return <article className="post-card">
    <div className="post-head">
      <button
        className={`post-author-link${post.anonymous || !post.authorId ? ' static' : ''}`}
        onClick={() => { if (!post.anonymous && post.authorId) onOpenMention(post.authorId) }}
        aria-label={post.anonymous ? 'Anonymous confession' : `Open ${post.author}'s profile`}
        tabIndex={post.anonymous || !post.authorId ? -1 : 0}
      >
        <span className={`avatar post-avatar ${post.anonymous?'anonymous-avatar':''}`}>{post.anonymous?<BookOpen size={21}/>:post.initials}</span>
        <span className="post-id">
          <span className="post-namerow"><b>{post.author}</b>{post.authorVerified&&<BadgeCheck size={15} className="verified-tick" aria-label="Verified"/>}</span>
          <span className="post-idline">{post.handle&&<span>{post.handle}</span>}<i>·</i><span>{post.time}</span>{post.editedAt&&<><i>·</i><span className="edited-marker">edited {relativeTime(post.editedAt)}</span></>}{post.college&&<><i>·</i><span>{post.college}</span></>}</span>
        </span>
      </button>
      <button className="icon-button more-button" onClick={() => setMenuOpen(v=>!v)} aria-label="More options"><MoreHorizontal size={20}/></button>{menuOpen&&<div className="post-menu">{isOwn&&<button onClick={()=>{onEdit();setMenuOpen(false)}}><Pencil size={15}/> Edit post</button>}{isOwn&&<button className="danger" onClick={()=>{onDelete();setMenuOpen(false)}}><Trash2 size={15}/> Delete post</button>}{onPin&&<button onClick={()=>{onPin();setMenuOpen(false)}}>{post.isPinned?<><Pin size={15}/> Unpin from top</>:<><Pin size={15}/> Pin to top</>}</button>}<button onClick={()=>{onReport();setMenuOpen(false)}}><Flag size={15}/> Report post</button><button onClick={()=>{onShare();setMenuOpen(false)}}><Share2 size={15}/> Copy post text</button>{canActOnAuthor&&<button onClick={()=>{onMute();setMenuOpen(false)}}><VolumeX size={15}/> Mute {post.handle}</button>}{canActOnAuthor&&<button onClick={()=>{onBlock();setMenuOpen(false)}}><EyeOff size={15}/> Block {post.handle}</button>}{canActOnAuthor&&!isOwn&&<button onClick={()=>{onMessage();setMenuOpen(false)}}><MessageCircle size={15}/> Message {post.handle}</button>}</div>}
    </div>
    <div className="post-content">
      {(post.trending || post.anonymous || post.tag) && <div className="post-badges">{post.trending&&<span className="badge trending-badge"><Sparkles size={12}/> Trending</span>}{post.anonymous&&<span className="badge confession-badge">😳 Confession</span>}{post.tag&&<span className="badge college-badge">{post.tag}</span>}</div>}
      {(slides.length === 0 && post.kind !== 'poll') && <p className="post-body"><RichText text={post.body} onMention={onOpenMention} onHashtag={onOpenTag}/></p>}
      {post.kind === 'poll' && <p className="post-body poll-question">{slides.length === 0 ? <RichText text={post.body} onMention={onOpenMention} onHashtag={onOpenTag}/> : post.body}</p>}
      {mediaBlock}
      {pollBlock}
      <div className="post-actions"><button className={post.liked?'liked':''} onClick={onLike} aria-label={`Like post (${post.likes})`}><Heart size={19} fill={post.liked?'currentColor':'none'}/><span>{post.likes}</span></button><button onClick={onComment} aria-label={`Comment (${post.comments})`}><MessageCircle size={19}/><span>{post.comments}</span></button><button className={post.reposted?'reposted':''} onClick={onRepost} aria-label={`Repost (${post.reposts})`}><Repeat2 size={19}/><span>{post.reposts}</span></button><button onClick={onShare} aria-label="Share"><Share2 size={18}/></button><span className="action-spacer"/><button className={saved?'saved':''} onClick={onSave} aria-label={saved ? 'Remove saved post' : 'Save post'}><Bookmark size={19} fill={saved?'currentColor':'none'}/></button><button onClick={onReport} aria-label="Report"><Flag size={18}/></button></div>
      {(slides.length > 0 && post.kind !== 'poll') && <p className="post-body post-caption"><RichText text={post.body} onMention={onOpenMention} onHashtag={onOpenTag}/></p>}
    </div>
  </article>
}

export default PostCard
