import { useCallback, useEffect, useRef, useState } from 'react'
import {
  BadgeCheck, Camera, Clapperboard, EllipsisVertical, Grid3X3, Loader2, Link2,
  MessageCircle, Play, UserRound, UserPlus,
} from 'lucide-react'
import * as db from '../lib/db'
import type { CampusPost, Caps, College, PersonResult, Profile as DbProfile, ProfileStats } from '../lib/db'
import { friendlyMessage, initialsFor } from '../lib/db'
import ProfileSettings from './ProfileSettings'
import RichText from './RichText'

type Props = {
  /** null → the signed-in member's own profile */
  profileId: string | null
  myUserId: string
  colleges: College[]
  isMember: boolean
  caps: Caps
  patchProfile: (patch: db.ProfilePatch) => Promise<string | null>
  reloadProfile: () => void
  ownProfile: DbProfile | null
  onMessagePerson: (id: string) => void
  onToggleFollow: (id: string, current: boolean) => Promise<boolean>
  onOpenMention: (profileId: string) => void
  onOpenHashtag: (query: string) => void
  onSignOut: () => void
  /** tap a grid tile → App's existing comments/detail sheet for that post */
  onOpenPost?: (post: CampusPost) => void
  /** empty-state CTA → App's existing global composer ('post' | 'reel') */
  onCreatePost?: (kind: 'post' | 'reel') => void
}

export default function Profile({ profileId, myUserId, colleges, isMember, caps, patchProfile, reloadProfile, ownProfile, onMessagePerson, onToggleFollow, onOpenMention, onOpenHashtag, onSignOut, onOpenPost, onCreatePost }: Props) {
  const [profile, setProfile] = useState<DbProfile | null>(null)
  const [stats, setStats] = useState<ProfileStats | null>(null)
  const [followTab, setFollowTab] = useState<'post' | 'reel'>('post')
  const [posts, setPosts] = useState<CampusPost[]>([])
  const [postsLoading, setPostsLoading] = useState(true)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [following, setFollowing] = useState(false)
  const [followBusy, setFollowBusy] = useState(false)
  const [memberList, setMemberList] = useState<{ mode: 'followers' | 'following' | null; rows: PersonResult[] }>({ mode: null, rows: [] })
  const [listLoading, setListLoading] = useState(false)
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [verifyNote, setVerifyNote] = useState<string | null>(null)
  const [note, setNote] = useState<string | null>(null)
  const noteTimer = useRef<number | undefined>(undefined)
  useEffect(() => () => { if (noteTimer.current) window.clearTimeout(noteTimer.current) }, [])

  const isSelf = !profileId || profileId === myUserId

  // signed-out visitors get an honest gate instead of uuid errors from
  // queries that would run with an empty user id
  const viewingId = profileId ?? myUserId
  const canQuery = Boolean(viewingId)

  const load = useCallback(async () => {
    if (!canQuery) return
    // member profiles are hidden from signed-out visitors by RLS — invite them
    // in instead of pretending the member does not exist
    if (!isMember && profileId) {
      setError('Sign in to view member profiles — CAMPUS hides profiles from visitors.')
      setLoading(false)
      return
    }
    setLoading(true)
    setError(null)
    try {
      const id = viewingId
      const [p, s] = await Promise.all([
        db.fetchProfile(id),
        db.fetchProfileStats(id),
      ])
      if (!p) throw new Error('That member could not be found.')
      setProfile(p)
      setStats(s)
    } catch (e) {
      setError(friendlyMessage(e))
    } finally {
      setLoading(false)
    }
  }, [profileId, myUserId, isMember])

  useEffect(() => { void load() }, [load])

  // the viewer follows this member?
  useEffect(() => {
    setFollowing(false)
    if (isSelf || !isMember || !myUserId) return
    void db.isFollowing(myUserId, profileId!).then(setFollowing).catch(() => {})
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [profileId, myUserId, isMember, isSelf])

  // uploads for the active tab (self always sees their own)
  useEffect(() => {
    if (!profile) return
    const locked = !isSelf && Boolean(profile.is_private) && !following
    setPostsLoading(true)
    setPosts([])
    if (locked) { setPostsLoading(false); return }
    void db.fetchMemberPosts(profile.id, followTab, 24)
      .then(rows => setPosts(rows))
      .catch(e => setError(friendlyMessage(e)))
      .finally(() => setPostsLoading(false))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [profile?.id, followTab, following])

  async function openMemberList(mode: 'followers' | 'following') {
    if (!stats || !profile) return
    setMemberList({ mode, rows: [] })
    if (mode === 'followers' && stats.followerCount === 0) return
    if (mode === 'following' && stats.followingCount === 0) return
    setListLoading(true)
    try {
      const rows = await db.fetchFollowersList(profile.id, mode === 'followers', 50)
      setMemberList({ mode, rows })
    } catch (e) {
      setError(friendlyMessage(e))
      setMemberList({ mode: null, rows: [] })
    } finally {
      setListLoading(false)
    }
  }

  async function toggleFollow() {
    if (!profile || !isMember || followBusy) return
    setFollowBusy(true)
    try {
      const ok = await onToggleFollow(profile.id, following)
      if (ok) {
        setFollowing(value => !value)
        // keep the session-visible follower count honest without a refetch:
        // the mirror the row holds is updated inside the same toggle
        setStats(s => s ? { ...s, followerCount: s.followerCount + (following ? -1 : 1) } : s)
      }
    } finally {
      setFollowBusy(false)
    }
  }

  // admins hand out the verified tick; the server re-checks the role
  const isAdminViewer = ownProfile?.role === 'admin'
  const [verifyBusy, setVerifyBusy] = useState(false)

  async function toggleVerified() {
    if (!profile || !isAdminViewer) return
    setVerifyBusy(true)
    setVerifyNote(null)
    try {
      await db.setProfileVerified(profile.id, !profile.is_verified)
      await load()
    } catch (error) {
      setVerifyNote(friendlyMessage(error))
    } finally {
      setVerifyBusy(false)
    }
  }

  /** copy the #u/<username> deep link this app resolves in App.tsx:940 */
  async function copyProfileLink() {
    if (!profile) return
    const base = `${window.location.origin}${window.location.pathname}`
    const link = profile.username ? `${base}#u/${profile.username}` : base
    try {
      await navigator.clipboard.writeText(link)
      showNote(profile.username ? 'Profile link copied.' : 'The home link was copied — this member has no username yet.')
    } catch {
      showNote(profile.username ? `Could not copy — the link is ${link}` : 'Could not copy a profile link.')
    }
  }

  function showNote(message: string) {
    setNote(message)
    if (noteTimer.current) window.clearTimeout(noteTimer.current)
    noteTimer.current = window.setTimeout(() => setNote(null), 2700)
  }

  if (!canQuery) {
    return <section className="profile-page"><div className="section-hero-icon"><UserRound size={27}/></div><span className="eyebrow">CAMPUS / PROFILE</span><h2>Profiles</h2><p>Your profile appears once your member profile is loaded — join CAMPUS to post, follow and chat.</p></section>
  }
  if (loading) {
    return <section className="profile-page" aria-busy="true"><ProfileSkeleton/></section>
  }
  if (error || !profile) {
    return <section className="profile-page"><div className="search-error">{error || 'Profile not available.'}</div></section>
  }

  if (settingsOpen && isSelf) {
    return (
      <ProfileSettings
        profile={profile}
        userId={myUserId}
        caps={caps}
        patchProfile={patchProfile}
        reloadProfile={reloadProfile}
        onSignOut={onSignOut}
        onClose={() => { setSettingsOpen(false); void load() }}
      />
    )
  }

  const locked = !isSelf && Boolean(profile.is_private) && !following
  const college = colleges.find(c => c.id === profile.college_id)?.short_name

  const display = profile.display_name?.trim() || (profile.username ? `@${profile.username}` : 'CAMPUS member')

  // academic line only from real fields, only when present
  const academic = [profile.course ?? profile.department ?? null,
    profile.year_of_study ? `Year ${profile.year_of_study}` : null]
    .filter(Boolean).join(' · ') as string
  const hasUsername = Boolean(profile.username)

  const kindLabel = (post: CampusPost) => post.kind === 'confession' ? 'Confession'
    : post.kind === 'poll' ? 'Poll'
    : post.kind === 'reel' ? 'Reel' : 'Post'

  return (
    <section className="profile-page">
      <div className="profile-head">
        <div className="profile-hero">
          <span className="avatar profile-avatar">
            {profile.avatar_url
              ? <img src={profile.avatar_url} alt={`${display}'s profile photo`}/>
              : initialsFor(display, profile.username ?? '')}
          </span>
          <div className="profile-identity">
            <h1>
              {display}
              {profile.is_verified && <BadgeCheck size={17} className="verified-tick" aria-label="Verified"/>}
              {profile.is_private && <span className="profile-private-chip">private</span>}
            </h1>
            <small className={hasUsername ? undefined : 'profile-username-empty'}>
              {hasUsername ? `@${profile.username}` : 'no username yet'}
            </small>
            {(college || academic) && (
              <span className="profile-meta-chip">
                {college ?? 'No college set'}{academic ? ` · ${academic}` : ''}
              </span>
            )}
          </div>
          <div className="profile-head-tools">
            <button className="icon-button" aria-label="Copy profile link" onClick={() => void copyProfileLink()}>
              <Link2 size={19}/>
            </button>
            {isSelf && (
              <button className="icon-button profile-settings-trigger" aria-label="Edit profile and settings" onClick={() => setSettingsOpen(true)}>
                <EllipsisVertical size={21}/>
              </button>
            )}
          </div>
        </div>

        {profile.bio && (
          <p className="profile-bio"><RichText text={profile.bio} onMention={onOpenMention} onHashtag={onOpenHashtag}/></p>
        )}

        <div className="profile-actions">
          {isSelf ? (
            <>
              <button className="profile-edit" onClick={() => setSettingsOpen(true)}>
                <UserRound size={14}/> Edit profile
              </button>
            </>
          ) : (
            <>
              {isAdminViewer && (
                <button className="profile-follow is-following" disabled={verifyBusy} onClick={() => void toggleVerified()}>
                  {verifyBusy ? <Loader2 size={14} className="search-spin"/> : <BadgeCheck size={14}/>} {profile.is_verified ? 'Unverify' : 'Verify'}
                </button>
              )}
              <button className={`profile-follow ${following ? 'is-following' : ''}`} disabled={followBusy} onClick={() => void toggleFollow()}>
                {followBusy ? <Loader2 size={14} className="search-spin"/> : following ? <><UserRound size={14}/> Following</> : <><UserPlus size={14}/> Follow</>}
              </button>
              <button className="profile-message" onClick={() => onMessagePerson(profile.id)}>
                <MessageCircle size={14}/> {following ? 'Message' : 'Chat request'}
              </button>
            </>
          )}
        </div>
        {verifyNote && <div className="settings-note">{verifyNote}</div>}
        {note && <div className="settings-note" role="status">{note}</div>}

        {stats && (
          <div className="profile-stats">
            <button className={followTab === 'post' ? 'on' : ''} onClick={() => setFollowTab('post')} aria-label={`Posts: ${stats.postCount}. Switch to posts`}>
              <b>{stats.postCount}</b><span>{stats.postCount === 1 ? 'post' : 'posts'}</span>
            </button>
            <button className={followTab === 'reel' ? 'on' : ''} onClick={() => setFollowTab('reel')} aria-label={`Reels: ${stats.reelCount}. Switch to reels`}>
              <b>{stats.reelCount}</b><span>{stats.reelCount === 1 ? 'reel' : 'reels'}</span>
            </button>
            <button onClick={() => void openMemberList('followers')} aria-label={`Followers: ${stats.followerCount}. Open list`}>
              <b>{stats.followerCount}</b><span>{stats.followerCount === 1 ? 'follower' : 'followers'}</span>
            </button>
            <button onClick={() => void openMemberList('following')} aria-label={`Following: ${stats.followingCount}. Open list`}>
              <b>{stats.followingCount}</b><span>following</span>
            </button>
          </div>
        )}
      </div>

      {memberList.mode && (
        <div className="profile-list-panel">
          <h3>{memberList.mode === 'followers' ? 'Followers' : 'Following'}</h3>
          {listLoading && <div className="search-hint"><Loader2 size={15} className="search-spin"/>Loading…</div>}
          {!listLoading && memberList.rows.length === 0 && (
            <div className="search-hint">Nobody here yet — follows appear as members follow each other.</div>
          )}
          {memberList.rows.map(person => (
            <div key={person.id} className="search-row">
              <button className="search-row-link" onClick={() => onOpenMention(person.id)} aria-label={`Open ${person.displayName}'s profile`}>
                <span className="avatar small">{initialsFor(person.displayName, person.username ?? '')}</span>
                <span className="search-row-copy">
                  <b>{person.displayName}</b>
                  <small>{person.username ? `@${person.username}` : ''}{person.isPrivate ? ' · private' : ''}</small>
                </span>
              </button>
              {!isSelf && person.id !== myUserId && (
                <button className="search-message" onClick={() => onMessagePerson(person.id)}><MessageCircle size={13}/> Message</button>
              )}
            </div>
          ))}
          <button className="text-button profile-list-close" onClick={() => setMemberList({ mode: null, rows: [] })}>Close</button>
        </div>
      )}

      {locked ? (
        <div className="profile-locked">
          <Camera size={26}/>
          <b>This account is private</b>
          <p>Follow to see this member's posts and reels.</p>
        </div>
      ) : (
        <>
          <div className="profile-segment" role="tablist" aria-label={`${display}'s uploads`}>
            <button role="tab" aria-selected={followTab === 'post'} className={followTab === 'post' ? 'on' : ''} onClick={() => setFollowTab('post')}>
              <Grid3X3 size={14}/> Posts
            </button>
            <button role="tab" aria-selected={followTab === 'reel'} className={followTab === 'reel' ? 'on' : ''} onClick={() => setFollowTab('reel')}>
              <Clapperboard size={14}/> Reels
            </button>
          </div>

          {postsLoading ? (
            <div className="profile-grid" aria-hidden="true">
              {Array.from({ length: 6 }, (_, i) => <div key={i} className="profile-grid-item skeleton-tile"><span className="skeleton-fill"/></div>)}
            </div>
          ) : posts.length === 0 ? (
            <div className="profile-empty">
              <span className="profile-empty-icon">{followTab === 'reel' ? <Clapperboard size={24}/> : <Grid3X3 size={24}/>}</span>
              <b>{isSelf ? `No ${followTab === 'reel' ? 'reels' : 'posts'} yet` : `No ${followTab === 'reel' ? 'reels' : 'posts'} from this member yet`}</b>
              <p>{isSelf
                ? `Share your first ${followTab === 'reel' ? 'reel' : 'post'} with your campus.`
                : 'When they post, it appears here.'}</p>
              {isSelf && onCreatePost && (
                <button className="profile-empty-cta" onClick={() => onCreatePost(followTab === 'reel' ? 'reel' : 'post')}>
                  {followTab === 'reel' ? 'Create your first reel' : 'Create your first post'}
                </button>
              )}
            </div>
          ) : (
            <div className="profile-grid">
              {posts.map(post => {
                const media = post.media?.[0] ?? null
                const isVideo = media ? /\.(mp4|webm|mov)(\?|$)/i.test(media) : false
                const excerpt = (post.body ?? '').trim()
                return (
                  <button
                    key={post.id}
                    className={`profile-grid-item${media ? '' : ' is-text'}`}
                    onClick={() => onOpenPost?.(post)}
                    aria-label={`${kindLabel(post)}: ${excerpt ? excerpt.slice(0, 70) : 'open'}`}
                  >
                    {media
                      ? <>
                          {isVideo
                            ? <video src={media} preload="metadata" muted playsInline/>
                            : <img src={media} alt="" loading="lazy" decoding="async" onError={e => { e.currentTarget.style.display = 'none' }}/>}
                          {isVideo && <span className="grid-play" aria-hidden="true"><Play size={15} fill="currentColor"/></span>}
                          <span className="tile-foot">
                            <span>{post.time}</span>
                            {(post.likes > 0 || post.comments > 0) && (
                              <span className="grid-meta">{post.likes > 0 && `♥ ${post.likes}`}{post.likes > 0 && post.comments > 0 ? ' · ' : ''}{post.comments > 0 && `${post.comments} 💬`}</span>
                            )}
                          </span>
                        </>
                      : <>
                          <span className="grid-kind">{kindLabel(post)}</span>
                          <span className="grid-text">{excerpt || 'Open this post'}</span>
                          <span className="tile-foot">
                            <span>{post.time}</span>
                            {(post.likes > 0 || post.comments > 0) && (
                              <span className="grid-meta">{post.likes > 0 && `♥ ${post.likes}`}{post.likes > 0 && post.comments > 0 ? ' · ' : ''}{post.comments > 0 && `${post.comments} 💬`}</span>
                            )}
                          </span>
                        </>}
                  </button>
                )
              })}
            </div>
          )}
        </>
      )}
    </section>
  )
}

/** Layout-matched skeleton (same tile shape as .profile-grid-item). */
function ProfileSkeleton() {
  return (
    <>
      <div className="profile-skeleton-head">
        <span className="skeleton-fill skeleton-avatar"/>
        <span className="skeleton-fill skeleton-name"/>
      </div>
      <div className="profile-grid">
        {Array.from({ length: 6 }, (_, i) => <div key={i} className="profile-grid-item skeleton-tile"><span className="skeleton-fill"/></div>)}
      </div>
    </>
  )
}
