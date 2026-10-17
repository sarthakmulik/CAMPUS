import { useEffect, useMemo, useState } from 'react'
import * as db from '../lib/db'

/** Splits text into links, #hashtags, @mentions and plain runs. */
const TOKEN_RE = /(https?:\/\/[^\s<>"']+|www\.[^\s<>"']+|#[\p{L}\p{N}_]{2,30}|@[a-zA-Z0-9_]{3,20})/gu

type Segment =
  | { kind: 'text'; value: string }
  | { kind: 'link'; value: string }
  | { kind: 'hashtag'; value: string }
  | { kind: 'mention'; value: string }

type Props = {
  text: string
  /** Opens a member's profile for an @mention. */
  onMention: (profileId: string) => void
  /** Opens search seeded with the hashtag. */
  onHashtag: (query: string) => void
}

/** Clickable links, #hashtags and @mentions inside feed bodies and bios.
 *  A mention with no match (yet, or ever) renders as plain text — no dead
 *  links, no fake success. */
export default function RichText({ text, onMention, onHashtag }: Props) {
  const segments = useMemo<Segment[]>(() => {
    const out: Segment[] = []
    let cursor = 0
    for (const match of text.matchAll(TOKEN_RE)) {
      const index = match.index ?? 0
      if (index > cursor) out.push({ kind: 'text', value: text.slice(cursor, index) })
      const value = match[0]
      if (value.startsWith('#')) out.push({ kind: 'hashtag', value })
      else if (value.startsWith('@')) out.push({ kind: 'mention', value })
      else out.push({ kind: 'link', value })
      cursor = index + value.length
    }
    if (cursor < text.length) out.push({ kind: 'text', value: text.slice(cursor) })
    return out
  }, [text])

  return (
    <span className="rich-text">
      {segments.map((segment, index) => {
        if (segment.kind === 'text') return <span key={index}>{segment.value}</span>
        if (segment.kind === 'link') {
          const href = segment.value.startsWith('www.') ? `https://${segment.value}` : segment.value
          return (
            <a key={index} className="rich-link" href={href} target="_blank" rel="noopener noreferrer nofollow">
              {segment.value}
            </a>
          )
        }
        if (segment.kind === 'hashtag') {
          return (
            <button key={index} type="button" className="rich-hashtag" onClick={() => onHashtag(segment.value)}>
              {segment.value}
            </button>
          )
        }
        return <Mention key={index} token={segment.value} onMention={onMention}/>
      })}
    </span>
  )
}

function Mention({ token, onMention }: { token: string; onMention: (id: string) => void }) {
  const username = token.slice(1).toLowerCase()
  const [profileId, setProfileId] = useState<string | null>(null) // null → unresolved (or resolving)

  // lookup is cached per username, so repeated mentions resolve instantly
  useEffect(() => {
    let cancelled = false
    db.fetchProfileIdByUsername(username).then(id => { if (!cancelled) setProfileId(id) })
    return () => { cancelled = true }
  }, [username])

  if (!profileId) return <>{token}</>
  return (
    <button type="button" className="rich-mention" onClick={() => onMention(profileId)}>
      {token}
    </button>
  )
}
