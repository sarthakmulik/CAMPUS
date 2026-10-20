import type { ReactNode } from 'react'

/**
 * CAMPUS boot experience — shown only while the app is genuinely restoring
 * its session and profile (auth.booting), plus the profile-failure surface.
 *
 * Everything animated is CSS-driven (opacity/transform only): an ambient
 * ivory + lavender atmosphere, the brand mark entering with a soft spring and
 * an occasional gradient highlight sweep, a breathing halo, a tiny node
 * network suggesting students connecting, and an honest *indeterminate*
 * progress hairline (the boot sequence has no measurable steps — no fake
 * percentages). `slow` adds a "still connecting" hint after 14s; `error`
 * hands the user the existing sign-out / retry actions instead of hiding
 * behind the animation.
 */

type Props = {
  /** Render with all motion frozen — used by the fade-out veil. */
  quiescent?: boolean
  /** Set by a boot watchdog — initialization is taking unusually long. */
  slow?: boolean
  /** Profile load failure — reuses CAMPUS' existing retry / sign-out flow. */
  error?: string | null
  onRetry?: () => void
  onSignOut?: () => void
  notice?: ReactNode
}

export default function BootScreen({ quiescent, slow, error, onRetry, onSignOut, notice }: Props) {
  return (
    <main
      className={`boot-screen${quiescent ? ' boot-static' : ''}`}
      role="status"
      aria-live="polite"
      aria-label={error ? 'CAMPUS could not finish loading your profile' : 'Loading CAMPUS'}
    >
      <div className="boot-atmos" aria-hidden="true">
        <span className="boot-blob boot-blob-a" />
        <span className="boot-blob boot-blob-b" />
      </div>

      <div className="boot-mark" aria-hidden="true">
        <span className="boot-halo" />
        <span className="boot-logo">
          <svg viewBox="0 0 24 24" className="boot-logo-shine" preserveAspectRatio="none">
            <polygon points="0,0 10,0 2,24 -2,24" fill="#ffffff" />
          </svg>
          <span className="boot-logo-lockup"><b>C</b></span>
        </span>
        <svg className="boot-net" viewBox="0 0 232 64" fill="none" aria-hidden="true">
          <line x1="26" y1="44" x2="82" y2="20" />
          <line x1="82" y1="20" x2="138" y2="42" />
          <line x1="138" y1="42" x2="192" y2="16" />
          <line x1="192" y1="16" x2="218" y2="38" />
          <line x1="82" y1="20" x2="58" y2="8" />
          <circle className="boot-node" cx="58" cy="8" r="2" />
          <circle className="boot-node" cx="26" cy="44" r="2.4" />
          <circle className="boot-node" cx="82" cy="20" r="2.6" />
          <circle className="boot-node" cx="138" cy="42" r="2.4" />
          <circle className="boot-node" cx="192" cy="16" r="2.2" />
          <circle className="boot-node" cx="218" cy="38" r="2" />
        </svg>
      </div>

      <div className="boot-copy">
        <b className="boot-wordmark">CAMPUS</b>
        <p className="boot-tag">Bringing your campus together.</p>
        {slow && <p className="boot-slow">Still connecting — this is taking longer than usual.</p>}
        <span className="boot-bar" aria-hidden="true"><i /></span>
      </div>

      {error && (
        <div className="boot-error">
          <h2>We could not load your profile.</h2>
          <p className="form-error" role="alert">{error}</p>
          <div className="wizard-actions inline">
            <button className="secondary-button" onClick={onSignOut}>Sign out</button>
            <button className="primary-button" onClick={onRetry}>Try again</button>
          </div>
        </div>
      )}
      {notice}
    </main>
  )
}
