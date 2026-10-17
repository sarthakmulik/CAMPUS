import { useCallback, useEffect, useState } from 'react'
import { Bookmark, BadgeCheck, Camera, EllipsisVertical, Grid3X3, Loader2, MessageCircle, UserRound, UserPlus } from 'lucide-react'
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
  onToggleFollow: (id: string, current: boolean) => Promise<void>
  onOpenMention: (profileId: string) => void
  onOpenHashtag: (query: string) => void
  onSignOut: () => void
}

export default function Profile({ profileId, myUserId, colleges, isMember, caps, patchProfile, reloadProfile, ownProfile, onMessagePerson, onToggleFollow, onOpenMention, onOpenHashtag, onSignOut }: Props) {
  const [profile, setProfile] = useState<DbProfile | null>(null)
  const [stats, setStats] = useState<ProfileStats | null>(null)
  const [followTab, setFollowTab] = useState<'post' | 'reel'>('post')
  const [posts, setPosts] = useState<CampusPost[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [following, setFollowing] = useState(false)
  const [followBusy, setFollowBusy] = useState(false)
  const [memberList, setMemberList] = useState<{ mode: 'followers' | 'following' | null; rows: PersonResult[] }>({ mode: null, rows: [] })
  const [listLoading, setListLoading] = useState(false)
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [verifyNote, setVerifyNote] = useState<string | null>(null)

  const isSelf = !profileId || profileId === myUserId

  // signed-out visitors get an honest gate instead of uuid errors from
  // queries that would run with an empty user id
  const viewingId = profileId ?? myUserId
  const canQuery = Boolean(viewingId)

  const load = useCallback(async () => {
    if (!canQuery) return
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
  }, [profileId, myUserId])

  useEffect(() => { void load() }, [load])

  // the viewer follows this member?
  useEffect(() => {
    setFollowing(false)
    if (isSelf || !isMember) return
    void db.isFollowing(profileId!).then(setFollowing).catch(() => {})
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [profileId, isMember, isSelf])

  // uploads for the active tab (self always sees their own)
  useEffect(() => {
    if (!profile) return
    const locked = !isSelf && Boolean(profile.is_private) && !following
    if (locked) { setPosts([]); return }
    setPosts([])
    void db.fetchMemberPosts(profile.id, followTab, 24)
      .then(rows => setPosts(rows))
      .catch(e => setError(friendlyMessage(e)))
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
    if (!profile) return
    if (!isMember) return
    setFollowBusy(true)
    try {
      await onToggleFollow(profile.id, following)
      setFollowing(value => !value)
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

  if (!canQuery) {
    return <section className="profile-page"><div className="section-hero-icon"><UserRound size={27}/></div><span className="eyebrow">CAMPUS / PROFILE</span><h2>Profiles</h2><p>Your profile appears once your member profile is loaded — join CAMPUS to post, follow and chat.</p></section>
  }
  if (loading) {
    return <section className="profile-page"><div className="search-hint"><Loader2 size={15} className="search-spin"/>Loading profile…</div></section>
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
        onClose={() => setSettingsOpen(false)}
      />
    )
  }

  const locked = !isSelf && Boolean(profile.is_private) && !following
  const college = colleges.find(c => c.id === profile.college_id)?.short_name

  const display = profile.display_name?.trim() || (profile.username ? `@${profile.username}` : 'CAMPUS member')

  return (
    <section className="profile-page">
      <div className="profile-head">
        <div className="profile-head-top">
          <span className="avatar profile-avatar">
            {profile.avatar_url ? <img src={profile.avatar_url} alt=""/> : initialsFor(display, profile.username ?? '')}
          </span>
          {isSelf && <button className="icon-button profile-settings-trigger" aria-label="Settings" onClick={() => setSettingsOpen(true)}><EllipsisVertical size={22}/></button>}
        </div>
        <div className="profile-head-copy">
          <h1>{display}{profile.is_verified && <BadgeCheck size={18} className="verified-tick" aria-label="Verified"/>}</h1>
          <small>{profile.username ? `@${profile.username}` : 'no username yet'}{college ? ` · ${college}` : ''}{profile.is_private ? ' · private account' : ''}</small>
          {profile.bio && <p className="profile-bio"><RichText text={profile.bio} onMention={onOpenMention} onHashtag={onOpenHashtag}/></p>}
        </div>

        <div className="profile-actions">
          {isSelf ? (
            <button className="profile-message" onClick={() => setSettingsOpen(true)}>
              <UserRound size={14}/> Edit profile
            </button>
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

        {stats && (
          <div className="profile-stats">
            <button className={followTab === 'post' ? 'on' : ''} onClick={() => setFollowTab('post')}>
              <b>{stats.postCount}</b><span>{stats.postCount === 1 ? 'post' : 'posts'}</span>
            </button>
            <button className={followTab === 'reel' ? 'on' : ''} onClick={() => setFollowTab('reel')}>
              <b>{stats.reelCount}</b><span>{stats.reelCount === 1 ? 'reel' : 'reels'}</span>
            </button>
            <button onClick={() => void openMemberList('followers')}>
              <b>{stats.followerCount}</b><span>{stats.followerCount === 1 ? 'follower' : 'followers'}</span>
            </button>
            <button onClick={() => void openMemberList('following')}>
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
              <span className="avatar small">{initialsFor(person.displayName, person.username ?? '')}</span>
              <span className="search-row-copy">
                <b>{person.displayName}</b>
                <small>{person.username ? `@${person.username}` : ''}{person.isPrivate ? ' · private' : ''}</small>
              </span>
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
          <div className="profile-tabs">
            <button className={followTab === 'post' ? 'on' : ''} onClick={() => setFollowTab('post')}><Grid3X3 size={14}/> Posts</button>
            <button className={followTab === 'reel' ? 'on' : ''} onClick={() => setFollowTab('reel')}><Bookmark size={14}/> Reels</button>
          </div>

          {posts.length === 0 ? (
            <div className="profile-locked empty">
              <Grid3X3 size={26}/>
              <b>{isSelf ? `No ${followTab === 'reel' ? 'reels' : 'posts'} yet` : `No ${followTab === 'reel' ? 'reels' : 'posts'} from this member yet`}</b>
              <p>{isSelf ? `Post ${followTab === 'reel' ? 'a reel' : 'the first thing'} from the composer on Home.` : 'When they post, it appears here.'}</p>
            </div>
          ) : (
            <div className="profile-grid">
              {posts.map(post => {
                const media = post.media?.[0] ?? null
                const isVideo = media ? /\.(mp4|webm|mov)(\?|$)/i.test(media) : false
                return (
                  <article key={post.id} className="profile-grid-item">
                    {media
                      ? isVideo
                        ? <video src={media} muted playsInline/>
                        : <img src={media} alt="" loading="lazy"/>
                      : <div className="grid-text">{post.body.length > 150 ? `${post.body.slice(0, 150)}…` : post.body}</div>}
                    <footer>
                      <span>{post.time} · {post.likes} likes · {post.comments} replies</span>
                    </footer>
                  </article>
                )
              })}
            </div>
          )}
        </>
      )}
    </section>
  )
}
