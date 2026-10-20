import { Play } from 'lucide-react'
import type { ChatMessage } from '../../lib/db'

/**
 * A shared-content message: renders a REFERENCE to existing CAMPUS content
 * (reel / post / profile / listing / event) that the message row carries
 * as {kind, id}. Nothing is duplicated — the card shows the live, server-
 * resolved preview and hands navigation back to the caller. Styled like a
 * normal message bubble, not a product tile: thumbnail + one caption line +
 * attribution, no interface chrome.
 */
const KIND_WORD: Record<string, string> = {
  reel: 'reel', post: 'post', profile: 'profile', listing: 'listing', event: 'event',
}

export default function ChatSharedCard({
  message,
  onOpen,
}: {
  message: ChatMessage
  onOpen?: (message: ChatMessage) => void
}) {
  const kind = message.sharedKind
  if (!kind) return null

  if (!message.sharedAvailable) {
    return (
      <div className="dm-share-card unavailable" role="note">
        <b>This {KIND_WORD[kind]} is no longer available</b>
        <small>It may have been deleted, unpublished or is restricted.</small>
      </div>
    )
  }

  const isVideoCard = kind === 'reel'
  return (
    <button
      type="button"
      className={`dm-share-card ${kind}`}
      onClick={() => onOpen?.(message)}
      aria-label={`Open the shared ${KIND_WORD[kind]}${message.sharedTitle ? `: ${message.sharedTitle}` : ''}`}
    >
      {message.sharedImage ? (
        <span className="dm-share-media">
          {isVideoCard ? (
            <>
              <video src={message.sharedImage} muted playsInline preload="metadata" tabIndex={-1} />
              <i className="dm-share-play" aria-hidden="true"><Play size={14}/></i>
            </>
          ) : (
            <img src={message.sharedImage} alt="" loading="lazy" />
          )}
        </span>
      ) : kind === 'profile' ? (
        <span className="dm-share-avatar">{(message.sharedTitle ?? 'S').slice(0, 2)}</span>
      ) : (
        <span className="dm-share-media dm-share-fallback" aria-hidden="true">{KIND_WORD[kind][0].toUpperCase()}</span>
      )}
      <span className="dm-share-copy">
        <b>{message.sharedTitle ?? `Shared ${KIND_WORD[kind]}`}</b>
        <small className="dm-share-sub">
          {(kind === 'reel' || kind === 'post')
            ? (message.sharedAuthor ? `by ${message.sharedAuthor}` : message.sharedSubtitle ?? KIND_WORD[kind])
            : (message.sharedSubtitle ?? KIND_WORD[kind])}
        </small>
      </span>
    </button>
  )
}
