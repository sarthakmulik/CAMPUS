import type { ReactNode } from 'react'
import type { LucideIcon } from 'lucide-react'
import {
  Bell, Bookmark, BookOpen, BriefcaseBusiness, Building2, CalendarDays, ChevronDown,
  CircleDollarSign, Compass, Home, MessageCircle, Plus, Search, Shield, Sparkles,
  Trophy, UserRound, Users,
} from 'lucide-react'

/* ============================================================================
   DesktopChrome — the desktop-only presentation layer for the app shell.

   Two pieces, both `display: none` below 651px (see styles.desktop.css), so the
   mobile header, the mobile drawer and its 15 flat nav rows are untouched:
   they keep rendering from App.tsx's own .mobile-header / .primary-nav markup.

   Nothing here owns state, fetches data or changes a route: every control calls
   the same handlers the mobile chrome already uses (navigate, setSearchOpen,
   setSearchSeed, setAuthMode), so behaviour is shared, not duplicated.
   ========================================================================= */

type NavIcon = LucideIcon

export const DESK_NAV_GROUPS: { title: string; items: string[] }[] = [
  { title: 'Main', items: ['Home', 'Discover', 'Search'] },
  { title: 'Campus', items: ['Campus Pulse', 'Communities', 'Events', 'Clubs', 'Leaderboard'] },
  { title: 'Explore', items: ['Opportunities', 'Marketplace'] },
  { title: 'Personal', items: ['Chats', 'Notifications', 'Bookmarks'] },
  { title: 'Other', items: ['My College', 'Safety Centre'] },
]

const DESK_NAV_ICONS: Record<string, NavIcon> = {
  Home,
  Discover: Compass,
  Search,
  'Campus Pulse': Sparkles,
  Communities: Users,
  Events: CalendarDays,
  Clubs: BookOpen,
  Leaderboard: Trophy,
  Opportunities: BriefcaseBusiness,
  Marketplace: CircleDollarSign,
  Chats: MessageCircle,
  Notifications: Bell,
  Bookmarks: Bookmark,
  'My College': Building2,
  'Safety Centre': Shield,
}

export function DesktopNav({ activeNav, onNavigate, isStaff, onCreatePost, unread }: {
  activeNav: string
  onNavigate: (label: string) => void
  isStaff: boolean
  onCreatePost: () => void
  unread: number
}) {
  return (
    <div className="desk-nav">
      <button className="desk-compose" onClick={onCreatePost}>
        <Plus size={16} strokeWidth={2.6}/>
        <span>Create post</span>
      </button>

      <nav className="desk-nav-groups" aria-label="Desktop navigation">
        {DESK_NAV_GROUPS.map(group => (
          <div className="desk-nav-group" key={group.title}>
            <span className="desk-nav-label">{group.title}</span>
            {group.items.map(label => {
              const Icon = DESK_NAV_ICONS[label] ?? Compass
              const active = activeNav === label
              const badge = label === 'Notifications' && unread > 0 ? unread : 0
              return (
                <button
                  key={label}
                  className={`desk-nav-item${active ? ' active' : ''}`}
                  onClick={() => onNavigate(label)}
                  aria-current={active ? 'page' : undefined}
                  title={label}
                >
                  <Icon size={18} strokeWidth={active ? 2.4 : 2}/>
                  <span>{label}</span>
                  {badge > 0 && <i className="desk-nav-badge">{badge > 99 ? '99+' : badge}</i>}
                </button>
              )
            })}
          </div>
        ))}

        {isStaff && (
          <div className="desk-nav-group">
            <span className="desk-nav-label">Staff</span>
            <button
              className={`desk-nav-item${activeNav === 'Staff Console' ? ' active' : ''}`}
              onClick={() => onNavigate('Staff Console')}
              title="Staff Console"
            >
              <Shield size={18}/>
              <span>Staff Console</span>
            </button>
            <button
              className={`desk-nav-item${activeNav === 'Advertising' ? ' active' : ''}`}
              onClick={() => onNavigate('Advertising')}
              title="Advertising"
            >
              <Sparkles size={18}/>
              <span>Advertising</span>
            </button>
          </div>
        )}
      </nav>
    </div>
  )
}

export function DesktopHeader({ campusName, campusShort, initials, avatarUrl, onOpenSearch, onOpenNotifications, onOpenChats, onOpenProfile, onChangeCollege, unread, signedIn, searchOpen, searchSlot }: {
  campusName: string
  campusShort: string
  initials: string | null
  /** the member's profile photo; initials are the fallback, never both */
  avatarUrl?: string | null
  onOpenSearch: () => void
  onOpenNotifications: () => void
  onOpenChats: () => void
  onOpenProfile: () => void
  onChangeCollege: () => void
  unread: number
  signedIn: boolean
  /** True while the search surface is open: the trigger is replaced by it. */
  searchOpen: boolean
  /** The real search input + results, rendered into the centre column. */
  searchSlot?: ReactNode
}) {
  return (
    <header className="desk-header">
      {/* The header re-uses the shell's own column template (sidebar / feed /
          rail) so the search field starts exactly where the feed does, instead
          of floating at the viewport edge above the logo. The left cell is
          deliberately empty: the CAMPUS wordmark belongs to the sidebar only. */}
      <div className="desk-header-lead" aria-hidden="true"/>

      <div className="desk-header-centre">
        <div className="desk-search-anchor">
          {!searchOpen && (
            <button className="desk-search" onClick={onOpenSearch} aria-label="Search CAMPUS">
              <Search size={16}/>
              <span>Search people, posts, colleges…</span>
            </button>
          )}
          {searchSlot}
        </div>
      </div>

      <div className="desk-header-actions">
        <button className="desk-campus-switch" onClick={onChangeCollege} title={campusName || 'Pick your college'}>
          <span className="desk-campus-mark">{campusShort ? campusShort.slice(0, 2).toUpperCase() : <Building2 size={14}/>}</span>
          <span className="desk-campus-copy">
            <small>Campus</small>
            <b>{campusShort || (signedIn ? 'Not set' : 'Choose')}</b>
          </span>
          <ChevronDown size={14}/>
        </button>

        <button className="desk-icon-btn" onClick={onOpenChats} aria-label="Messages" title="Messages">
          <MessageCircle size={18}/>
        </button>

        <button className="desk-icon-btn" onClick={onOpenNotifications} aria-label="Notifications" title="Notifications">
          <Bell size={18}/>
          {unread > 0 && <i className="desk-dot">{unread > 9 ? '9+' : unread}</i>}
        </button>

        <button className="desk-avatar-btn" onClick={onOpenProfile} aria-label="Your profile" title="Your profile">
          <span className="avatar small">
            {avatarUrl ? <img src={avatarUrl} alt=""/> : initials ?? <UserRound size={15}/>}
          </span>
        </button>
      </div>
    </header>
  )
}