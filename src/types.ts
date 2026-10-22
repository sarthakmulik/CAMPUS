export type PostKind = 'post' | 'confession' | 'poll' | 'reel'

/** Authoritative per-option snapshot coming from poll_states()/cast_poll_vote()
 *  (migration 0028). Identities are never part of the payload. */
export type PollOption = {
  id: string
  label: string
  position: number
  votes: number
  /** did the current viewer pick this option */
  mine: boolean
}

export type PollState = {
  postId: string
  multipleChoice: boolean
  /** ISO timestamp or null = open-ended */
  closesAt: string | null
  /** recomputed server-side from closes_at */
  isOpen: boolean
  totalVotes: number
  options: PollOption[]
}

export type CampusPost = {
  id: string
  author: string
  handle: string
  initials: string
  college: string
  time: string
  /** raw created_at — used by the For You ranking (recency) */
  createdAt?: string
  body: string
  likes: number
  comments: number
  reposts: number
  kind: PostKind
  media?: string[]
  authorId?: string | null
  editedAt?: string | null
  authorVerified?: boolean
  trending?: boolean
  /** moderator pin inside a community feed — ordered first, flagged, not "trending" */
  isPinned?: boolean
  anonymous?: boolean
  liked?: boolean
  saved?: boolean
  reposted?: boolean
  tag?: string
  /** hydrated in batches from poll_states() after a feed page lands */
  poll?: PollState | null
}
