import { Building2, CalendarDays, MessageCircle, Shield, Sparkles, ArrowRight } from 'lucide-react'

type Props = {
  onExplore: () => void
  onJoin: () => void
  configured: boolean
}

const highlights = [
  { icon: Sparkles, title: 'Confessions & takes', copy: 'Anonymous campus confessions, polls and reels.' },
  { icon: CalendarDays, title: 'Clubs & events', copy: 'Fests, meetups, workshops and societies.' },
  { icon: MessageCircle, title: 'Your people', copy: 'Class groups, chats and course communities.' },
  { icon: Shield, title: 'Safety first', copy: 'Report, block and privacy controls built in.' },
]

/**
 * First-time visitor experience. No account is required to read permitted
 * public content — "Explore CAMPUS" drops the visitor straight into the
 * read-only shell, "Join CAMPUS" starts account creation + onboarding.
 */
export default function WelcomeScreen({ onExplore, onJoin, configured }: Props) {
  return (
    <div className="welcome-screen">
      <header className="welcome-topbar">
        <span className="brand"><span className="brand-mark">C</span><span>CAMPUS</span></span>
        <div className="welcome-topbar-actions">
          <button className="text-button" onClick={onExplore}>Explore</button>
          <button className="primary-button" onClick={onJoin}>Join CAMPUS</button>
        </div>
      </header>

      <main className="welcome-grid">
        <section className="welcome-copy">
          <span className="eyebrow">YOUR PEOPLE. YOUR PLACE.</span>
          <h1>Same Campus,<br /><em>Bigger Dreams.</em></h1>
          <p className="welcome-lead">
            Posts, confessions, clubs, events and placement alerts from students at your college.
            Look around first — CAMPUS never forces you to register before you can read.
          </p>

          <div className="welcome-actions">
            <button className="primary-button large" onClick={onExplore}>
              Explore CAMPUS <ArrowRight size={17} />
            </button>
            <button className="secondary-button large" onClick={onJoin}>Join CAMPUS</button>
          </div>

          <ul className="welcome-reassurance">
            <li><Shield size={15} /> Exploring is free and read-only. You choose when to join.</li>
            <li><Building2 size={15} /> Your college is a self-declared affiliation — no student ID, no admin approval.</li>
          </ul>

          {!configured && (
            <p className="welcome-setup-note">
              Preview mode: add your Supabase URL and anon key to <code>.env</code> to enable accounts.
            </p>
          )}
        </section>

        <section className="welcome-art" aria-hidden="true">
          <div className="welcome-art-scene">
            <div className="art-sun" />
            <div className="art-building"><span /><span /><span /><span /><b /></div>
            <div className="art-hill" />
          </div>
          <div className="welcome-float-card card-a">
            <span className="avatar">CB</span>
            <div><b>Campus Bot</b><small>#FestSeason is trending</small></div>
          </div>
          <div className="welcome-float-card card-b">
            <span className="kind-icon pink"><Sparkles size={16} /></span>
            <div><b>1,240 posts today</b><small>from SPPU students</small></div>
          </div>
        </section>
      </main>

      <section className="welcome-highlights">
        {highlights.map(({ icon: Icon, title, copy }) => (
          <article className="welcome-highlight" key={title}>
            <span className="welcome-highlight-icon"><Icon size={18} /></span>
            <b>{title}</b>
            <small>{copy}</small>
          </article>
        ))}
      </section>

      <footer className="welcome-footer">
        Built for students, by students. Community guidelines apply everywhere — be kind, no threats, no doxxing.
      </footer>
    </div>
  )
}
