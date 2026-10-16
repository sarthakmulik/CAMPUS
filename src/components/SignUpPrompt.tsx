import { Check, UserPlus, X } from 'lucide-react'

type Props = {
  reason: string
  onClose: () => void
  onJoin: () => void
  onSignIn: () => void
}

/**
 * Shown when a visitor tries a restricted action. Explains what an account is
 * for, keeps the browsing session intact, and offers both new and returning
 * paths. Nothing is blocked permanently — "Keep exploring" returns to the
 * read-only feed.
 */
export default function SignUpPrompt({ reason, onClose, onJoin, onSignIn }: Props) {
  return (
    <div className="overlay" onMouseDown={event => { if (event.target === event.currentTarget) onClose() }}>
      <section className="signup-prompt" role="dialog" aria-modal="true" aria-label={`Join CAMPUS to ${reason}`}>
        <button className="modal-close icon-button" onClick={onClose} aria-label="Close"><X size={20} /></button>
        <span className="prompt-icon"><UserPlus size={22} /></span>
        <h2>Join CAMPUS to {reason}</h2>
        <p>
          You are browsing CAMPUS as a visitor, which is read-only. Creating an account takes a minute and unlocks
          everything on campus.
        </p>
        <ul className="prompt-benefits">
          <li><Check size={15} /> Post, react, comment, repost and bookmark</li>
          <li><Check size={15} /> Anonymous confessions, polls and reels</li>
          <li><Check size={15} /> Chats, clubs, events and placement alerts</li>
          <li><Check size={15} /> Pick your college — self-declared, no student ID needed</li>
        </ul>
        <div className="prompt-actions">
          <button className="primary-button full" onClick={onJoin}>Create free account</button>
          <button className="secondary-button full" onClick={onSignIn}>I already have an account</button>
          <button className="text-button" onClick={onClose}>Keep exploring</button>
        </div>
      </section>
    </div>
  )
}
