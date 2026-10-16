export type PostKind = 'post' | 'confession' | 'poll' | 'reel'
export type CampusPost = {
  id: string
  author: string
  handle: string
  initials: string
  college: string
  time: string
  body: string
  likes: number
  comments: number
  reposts: number
  kind: PostKind
  media?: string[]
  authorId?: string | null
  editedAt?: string | null
  trending?: boolean
  anonymous?: boolean
  liked?: boolean
  saved?: boolean
  reposted?: boolean
  tag?: string
}
