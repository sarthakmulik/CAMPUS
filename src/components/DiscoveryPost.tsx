import { useRef, useState } from 'react'
import {
  BadgeCheck, Bookmark, BookOpen, Heart, ImageOff, Loader2, MessageCircle,
  Play, Repeat2, Share2,
} from 'lucide-react'
import { useSavedFlag } from '../lib/bookmarks'
import { useSignedMedia } from '../lib/signedMedia'
import type { CampusPost, PollState } from '../types'
import { PollBlock } from './PostCard'
import RichText from './RichText'

/* ============================================================================
   Discovery post card — the content presentation layer of Search & Discovery.

   One renderer, per-type layouts. The post's own data decides which layout it
   gets (never a manual flag), so a new post type only needs a branch here:

     image     → media-dominant card (Pinterest-style visual block on top)
     video     → real poster frame, play affordance, duration when the file
                 reports it; playback stays in the existing detail player
     text      → typography-first card, no media gutter, Read more when long
     poll      → the platform's own poll block (single voting implementation)
     confession→ anonymous identity, no avatar, campus-scope label
     mixed     → 1 / 2 / 3 / 4-up composition with a +N overflow badge

   Every interaction is passed in from the shell (App.tsx): there is no second
   like/save/vote implementation here. Opening a card uses the existing
   post-detail surface, so the media viewer, comments and the canonical
   PostCard stay the single source of truth.
   ========================================================================= */

export type PostFilter = 'all' | 'photo' | 'video' | 'text' | 'poll'

const VIDEO_EXT = /\.(mp4|webm|mov|m4v|ogv)(\?|$)/i

function isVideoUrl(url: string | undefined | null): boolean {
  return Boolean(url && VIDEO_EXT.test(url))
}

/** The filter a post belongs to, derived from its own data. */
export function postFilterOf(post: CampusPost): Exclude<PostFilter, 'all'> {
  if (post.kind === 'poll') return 'poll'
  const media = post.media ?? []
  if (post.kind === 'reel') return 'video'
  if (media.length > 0) return isVideoUrl(media[0]) ? 'video' : 'photo'
  return 'text'
}

const KIND_LABEL: Record<CampusPost['kind'], string> = {
  post: 'Post',
  confession: 'Confession',
  poll: 'Poll',
  reel: 'Video',
}

type CardProps = {
  post: CampusPost
  /** hydrated poll state: undefined = loading, null = unavailable */
  poll?: PollState | null
  onOpen: () => void
  onOpenProfile: (profileId: string) => void
  onOpenTag: (query: string) => void
  onLike: () => void
  onSave: () => void
  onComment: () => void
  onShare: () => void
  onRepost: () => void
  onVote?: (optionIds: string[]) => Promise<boolean>
  /** first paint: load this card's media without waiting for the observer */
  eager?: boolean
}

/* -------------------------------------------------------------------------- */
/* media                                                                      */
/* -------------------------------------------------------------------------- */

/**
 * One image, presentation-resolved (0051 signed URLs) with three honest states:
 * a quiet skeleton while the signature mints, the real file at its own aspect
 * ratio once it decodes, and a designed fallback when the object is missing or
 * corrupt — never the browser's broken-image glyph.
 */
function DiscoveryImage({ source, eager, alt, fill }: { source: string; eager?: boolean; alt: string; fill?: boolean }) {
  const [ratio, setRatio] = useState<number | null>(null)
  const [failed, setFailed] = useState(false)
  const media = useSignedMedia([source])
  const url = media.urls[0]

  if (failed || (media.ready && !url)) {
    return (
      <span className="dpost-media-fallback">
        <ImageOff size={20}/>
        <small>Media unavailable</small>
      </span>
    )
  }
  if (!media.ready || !url) {
    return <span className="dpost-media-skeleton" aria-hidden="true"><Loader2 size={18} className="disc-spin"/></span>
  }
  return (
    <img
      className="dpost-img"
      src={url}
      alt={alt}
      loading={eager ? 'eager' : 'lazy'}
      decoding="async"
      draggable={false}
      style={!fill && ratio ? { aspectRatio: String(ratio) } : undefined}
      onLoad={event => {
        if (fill) return
        const img = event.currentTarget
        if (img.naturalWidth > 0 && img.naturalHeight > 0) setRatio(img.naturalWidth / img.naturalHeight)
      }}
      onError={() => setFailed(true)}
    />
  )
}

/** Video preview: the file's own first frame, a play affordance and its real
 *  duration. Playback itself stays in the existing post-detail player. */
function DiscoveryVideo({ source, eager, label, onOpen }: {
  source: string
  eager?: boolean
  label: string
  onOpen: () => void
}) {
  const media = useSignedMedia([source])
  const url = media.urls[0]
  const [seconds, setSeconds] = useState<number | null>(null)
  const [failed, setFailed] = useState(false)
  const ref = useRef<HTMLVideoElement | null>(null)

  if (failed || (media.ready && !url)) {
    return (
      <span className="dpost-media-fallback">
        <Play size={20}/>
        <small>Video unavailable</small>
      </span>
    )
  }
  if (!media.ready || !url) {
    return <span className="dpost-media-skeleton" aria-hidden="true"><Loader2 size={18} className="disc-spin"/></span>
  }
  return (
    <span className="dpost-video">
      <video
        ref={ref}
        src={url}
        muted
        playsInline
        preload={eager ? 'metadata' : 'none'}
        aria-label={label}
        onLoadedMetadata={event => {
          const video = event.currentTarget
          if (Number.isFinite(video.duration)) setSeconds(video.duration)
        }}
        onError={() => setFailed(true)}
      />
      <button className="dpost-play" onClick={onOpen} aria-label={`Play ${label}`}>
        <Play size={20}/>
      </button>
      {seconds !== null && (
        <span className="dpost-video-length">
          {Math.floor(seconds / 60)}:{String(Math.floor(seconds % 60)).padStart(2, '0')}
        </span>
      )}
    </span>
  )
}

/**
 * Multi-attachment composition. Ratios stay square for the collage cells so a
 * mixed set never produces a ragged card; a single attachment keeps its own
 * ratio (handled by DiscoveryImage).
 */
function MediaCollage({ media, alt, onOpen }: { media: string[]; alt: string; onOpen: () => void }) {
  const shown = media.slice(0, 4)
  const extra = media.length - shown.length
  const count = shown.length
  return (
    <button className={`dpost-collage n${count}`} onClick={onOpen} aria-label={`Open post with ${media.length} attachments`}>
      {shown.map((source, index) => (
        <span className="dpost-collage-cell" key={`${source}-${index}`}>
          <DiscoveryImage source={source} alt={alt} fill/>
          {extra > 0 && index === count - 1 && <span className="dpost-more">+{extra}</span>}
        </span>
      ))}
    </button>
  )
}

/* -------------------------------------------------------------------------- */
/* card                                                                       */
/* -------------------------------------------------------------------------- */

export default function DiscoveryPostCard(props: CardProps) {
  const { post, poll, onOpen, onOpenProfile, onOpenTag, onLike, onSave, onComment, onShare, onRepost, onVote, eager } = props
  const [expanded, setExpanded] = useState(false)
  const saved = useSavedFlag('post', post.id)

  // the caption is the card's only text; a long one gets a real Read more
  const long = post.body.length > 240
  const caption = long && !expanded ? `${post.body.slice(0, 240).trimEnd()}…` : post.body

  const media = post.media ?? []
  const filter = postFilterOf(post)
  const isPoll = post.kind === 'poll'
  const anonymous = post.anonymous
  const canOpenAuthor = !anonymous && Boolean(post.authorId)

  const mediaBlock = !isPoll && media.length > 0 ? (
    media.length === 1 ? (
      isVideoUrl(media[0]) || post.kind === 'reel' ? (
        <DiscoveryVideo source={media[0]} eager={eager} label={`video post by ${post.author}`} onOpen={onOpen}/>
      ) : (
        <button className="dpost-media" onClick={onOpen} aria-label={`Open post by ${post.author}`}>
          <DiscoveryImage source={media[0]} eager={eager} alt={`Post by ${post.author}`}/>
        </button>
      )
    ) : (
      <MediaCollage media={media} alt={`Post by ${post.author}`} onOpen={onOpen}/>
    )
  ) : null

  return (
    <article className={`dpost kind-${filter}${isPoll ? ' is-poll' : ''}`} data-kind={post.kind}>
      <header className="dpost-head">
        <button
          className={`dpost-author${canOpenAuthor ? '' : ' static'}`}
          onClick={() => { if (canOpenAuthor && post.authorId) onOpenProfile(post.authorId) }}
          tabIndex={canOpenAuthor ? 0 : -1}
          aria-label={anonymous ? 'Anonymous confession' : `Open ${post.author}'s profile`}
        >
          <span className={`avatar dpost-avatar${anonymous ? ' anonymous' : ''}`}>
            {anonymous ? <BookOpen size={17}/> : post.initials || <BookOpen size={17}/>}
          </span>
          <span className="dpost-id">
            <span className="dpost-namerow">
              <b>{anonymous ? 'Anonymous' : post.author}</b>
              {post.authorVerified && <BadgeCheck size={13} className="verified-tick" aria-label="Verified"/>}
            </span>
            <span className="dpost-meta">
              {post.college && <span>{post.college}</span>}
              {post.college && <i>·</i>}
              <span>{post.time}</span>
            </span>
          </span>
        </button>
        <span className="dpost-kind">{KIND_LABEL[post.kind]}</span>
      </header>

      {(anonymous || post.audience === 'college' || post.trending) && (
        <div className="dpost-badges">
          {anonymous && <span className="dpost-badge confession">Confession</span>}
          {post.audience === 'college' && <span className="dpost-badge audience">My College only</span>}
          {post.trending && <span className="dpost-badge trending">Trending</span>}
        </div>
      )}

      {mediaBlock}

      {post.body.length > 0 && (
        <div className={`dpost-body${media.length > 0 && !isPoll ? ' has-media' : ''}`}>
          <p className={long && !expanded ? 'clamped' : undefined}>
            <RichText text={caption} onMention={onOpenProfile} onHashtag={onOpenTag}/>
          </p>
          {long && (
            <button className="dpost-read" onClick={() => setExpanded(value => !value)}>
              {expanded ? 'Show less' : 'Read more'}
            </button>
          )}
        </div>
      )}

      {isPoll && (
        poll === undefined
          ? <p className="dpost-poll-loading"><Loader2 size={13} className="disc-spin"/> Loading poll…</p>
          : poll === null
            ? <p className="dpost-poll-hint">Poll results are unavailable right now.</p>
            : <PollBlock poll={poll} onVote={onVote}/>
      )}

      <footer className="dpost-actions">
        <button className={post.liked ? 'liked' : ''} onClick={onLike} aria-pressed={Boolean(post.liked)} aria-label={`Like post (${post.likes})`}>
          <Heart size={17} fill={post.liked ? 'currentColor' : 'none'}/><span>{post.likes}</span>
        </button>
        <button onClick={onComment} aria-label={`Comment (${post.comments})`}>
          <MessageCircle size={17}/><span>{post.comments}</span>
        </button>
        <button className={post.reposted ? 'reposted' : ''} onClick={onRepost} aria-pressed={Boolean(post.reposted)} aria-label={`Repost (${post.reposts})`}>
          <Repeat2 size={17}/><span>{post.reposts}</span>
        </button>
        <button onClick={onShare} aria-label="Share"><Share2 size={16}/></button>
        <button className={`dpost-save${saved ? ' saved' : ''}`} onClick={onSave} aria-pressed={saved} aria-label={saved ? 'Remove saved post' : 'Save post'}>
          <Bookmark size={17} fill={saved ? 'currentColor' : 'none'}/>
        </button>
      </footer>
    </article>
  )
}

/* -------------------------------------------------------------------------- */
/* grid + skeletons                                                           */
/* -------------------------------------------------------------------------- */

export function DiscoveryPostGrid({ children, label }: { children: React.ReactNode; label: string }) {
  return <div className="disc-masonry" role="list" aria-label={label}>{children}</div>
}

/** Skeleton shapes mirror the real cards so nothing jumps when data lands. */
export function DiscoveryPostSkeleton({ shape }: { shape: 'media' | 'text' | 'poll' }) {
  if (shape === 'media') {
    return (
      <div className="dpost dpost-skeleton" aria-hidden="true">
        <span className="dpost-sk-head"/>
        <span className="dpost-sk-media tall"/>
        <span className="dpost-sk-lines"><i/><i className="short"/></span>
      </div>
    )
  }
  if (shape === 'poll') {
    return (
      <div className="dpost dpost-skeleton" aria-hidden="true">
        <span className="dpost-sk-head"/>
        <span className="dpost-sk-lines"><i/><i/></span>
        <span className="dpost-sk-poll"><i/><i/><i/></span>
      </div>
    )
  }
  return (
    <div className="dpost dpost-skeleton" aria-hidden="true">
      <span className="dpost-sk-head"/>
      <span className="dpost-sk-lines"><i/><i/><i className="short"/></span>
    </div>
  )
}

export function DiscoveryPostsSkeleton({ count = 4 }: { count?: number }) {
  const shapes: Array<'media' | 'text' | 'poll'> = ['media', 'text', 'poll', 'media', 'text']
  return <>{Array.from({ length: count }).map((_, index) => <DiscoveryPostSkeleton key={index} shape={shapes[index % shapes.length]}/>)}</>
}

/** Compact single line used by the "load more" affordance. */
export function DiscoveryLoadMore({ loading, done, onClick }: { loading: boolean; done: boolean; onClick: () => void }) {
  if (done) return <p className="disc-end">You are all caught up.</p>
  return (
    <button className="disc-load-more" onClick={onClick} disabled={loading}>
      {loading ? <><Loader2 size={15} className="disc-spin"/> Loading…</> : 'Load more posts'}
    </button>
  )
}