export type PostKind = 'post' | 'confession' | 'poll' | 'reel'
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
  anonymous?: boolean
  liked?: boolean
  saved?: boolean
  reposted?: boolean
  tag?: string
}
