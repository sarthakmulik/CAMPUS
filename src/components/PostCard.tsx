import { useRef, useState } from 'react'
import {
  BadgeCheck, BookOpen, Bookmark, EyeOff, Flag, Heart,
  MessageCircle, MoreHorizontal, Pencil, Pin, Repeat2, Share2, Sparkles, Trash2, VolumeX,
} from 'lucide-react'
import { relativeTime } from '../lib/db'
import type { CampusPost } from '../types'
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
}

export function PostCard({
  post, isOwn, onLike, onSave, onComment, onShare, onReport, onRepost,
  onBlock, onMute, onEdit, onDelete, onMessage, onPin, onOpenMention, onOpenTag,
}: PostCardProps) {
  const [menuOpen, setMenuOpen] = useState(false)
  const [slide, setSlide] = useState(0)
  const slides = post.media ?? []
  const canActOnAuthor = Boolean(post.handle) && !post.anonymous
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
      {slides.length === 0 && <p className="post-body"><RichText text={post.body} onMention={onOpenMention} onHashtag={onOpenTag}/></p>}
      {mediaBlock}
      <div className="post-actions"><button className={post.liked?'liked':''} onClick={onLike} aria-label={`Like post (${post.likes})`}><Heart size={19} fill={post.liked?'currentColor':'none'}/><span>{post.likes}</span></button><button onClick={onComment} aria-label={`Comment (${post.comments})`}><MessageCircle size={19}/><span>{post.comments}</span></button><button className={post.reposted?'reposted':''} onClick={onRepost} aria-label={`Repost (${post.reposts})`}><Repeat2 size={19}/><span>{post.reposts}</span></button><button onClick={onShare} aria-label="Share"><Share2 size={18}/></button><span className="action-spacer"/><button className={post.saved?'saved':''} onClick={onSave} aria-label="Bookmark"><Bookmark size={19} fill={post.saved?'currentColor':'none'}/></button><button onClick={onReport} aria-label="Report"><Flag size={18}/></button></div>
      {slides.length > 0 && <p className="post-body post-caption"><RichText text={post.body} onMention={onOpenMention} onHashtag={onOpenTag}/></p>}
    </div>
  </article>
}

export default PostCard
