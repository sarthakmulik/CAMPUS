import { useEffect, useState } from 'react'
import { useBodyScrollLock } from '../lib/scrollLock'
import { ArrowLeft, Check, Eye, EyeOff, MailCheck, X } from 'lucide-react'
import { useAuth } from '../lib/auth'

export type AuthMode = 'signin' | 'signup' | 'reset'

type Props = {
  mode: AuthMode
  onModeChange: (mode: AuthMode) => void
  onClose: () => void
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/

/** Email + password authentication, backed by Supabase Auth. */
export default function AuthModal({ mode, onModeChange, onClose }: Props) {
  useBodyScrollLock()
  const { signIn, signUp, resetPassword, status, configured } = useAuth()
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [showPassword, setShowPassword] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [confirmationSent, setConfirmationSent] = useState(false)

  // Once the provider reports an account state, the wizard or the feed takes
  // over — close this modal.
  useEffect(() => {
    if (status === 'onboarding' || status === 'member') onClose()
  }, [status, onClose])

  const submit = async () => {
    setError(null)
    if (!EMAIL_RE.test(email.trim())) {
      setError('Enter a valid email address, for example you@college.edu.')
      return
    }
    if (mode === 'signup' && password.length < 8) {
      setError('Use a password with at least 8 characters.')
      return
    }
    if (mode !== 'reset' && !password) {
      setError('Enter your password.')
      return
    }

    setBusy(true)
    try {
      if (mode === 'signin') {
        const message = await signIn(email, password)
        if (message) setError(message)
      } else if (mode === 'signup') {
        const result = await signUp(email, password)
        if (result.error) setError(result.error)
        else if (result.needsConfirmation) setConfirmationSent(true)
      } else {
        const message = await resetPassword(email)
        if (message) setError(message)
        else setConfirmationSent(true)
      }
    } finally {
      setBusy(false)
    }
  }

  const heading =
    mode === 'signin' ? 'Welcome back.' : mode === 'signup' ? 'Create your account.' : 'Reset your password.'

  return (
    <div className="overlay" onMouseDown={event => { if (event.target === event.currentTarget) onClose() }}>
      <section className="auth-modal" role="dialog" aria-modal="true" aria-label={heading}>
        <button className="modal-close icon-button" onClick={onClose} aria-label="Close"><X size={20} /></button>
        <span className="brand-mark large">C</span>

        {confirmationSent ? (
          <>
            <div className="auth-success-icon"><MailCheck size={26} /></div>
            <h2>Check your inbox.</h2>
            <p>
              {mode === 'reset'
                ? 'We sent a password reset link to your email address.'
                : 'We sent a confirmation link to your email address. Confirm it, then sign in to finish setting up your CAMPUS profile.'}
            </p>
            <button className="secondary-button full" onClick={() => { setConfirmationSent(false); onModeChange('signin') }}>
              <ArrowLeft size={16} /> Back to sign in
            </button>
          </>
        ) : (
          <>
            <h2>{heading}</h2>
            <p>
              {mode === 'signup'
                ? 'Email and a password are all we need. College, course and interests come next — no student ID required.'
                : mode === 'reset'
                  ? 'Enter the email you signed up with and we will send a reset link.'
                  : 'Sign in to post, react, join clubs and chat with your campus.'}
            </p>

            <label className="field-label">
              Email address
              <input
                type="email"
                value={email}
                autoComplete="email"
                onChange={event => setEmail(event.target.value)}
                placeholder="you@college.edu"
              />
            </label>

            {mode !== 'reset' && (
              <label className="field-label">
                Password
                <span className="input-with-action">
                  <input
                    type={showPassword ? 'text' : 'password'}
                    value={password}
                    autoComplete={mode === 'signup' ? 'new-password' : 'current-password'}
                    onChange={event => setPassword(event.target.value)}
                    placeholder={mode === 'signup' ? 'At least 8 characters' : 'Your password'}
                  />
                  <button
                    type="button"
                    className="icon-button input-action"
                    onClick={() => setShowPassword(value => !value)}
                    aria-label={showPassword ? 'Hide password' : 'Show password'}
                  >
                    {showPassword ? <EyeOff size={17} /> : <Eye size={17} />}
                  </button>
                </span>
              </label>
            )}

            {error && <p className="form-error" role="alert">{error}</p>}

            <button className="primary-button full" disabled={busy} onClick={submit}>
              {busy ? 'Please wait…' : mode === 'signin' ? 'Sign in' : mode === 'signup' ? 'Create account' : 'Send reset link'}
            </button>

            {mode !== 'reset' && (
              <button className="text-button" disabled={busy} onClick={() => { setError(null); onModeChange('reset') }}>
                Forgot your password?
              </button>
            )}

            <div className="auth-switch">
              {mode === 'signin' ? (
                <span>New to CAMPUS? <button className="text-button" disabled={busy} onClick={() => { setError(null); onModeChange('signup') }}>Create an account</button></span>
              ) : (
                <span>Already have an account? <button className="text-button" disabled={busy} onClick={() => { setError(null); onModeChange('signin') }}>Sign in</button></span>
              )}
            </div>

            {mode === 'signup' && (
              <p className="auth-legal">
                <Check size={13} /> Your college choice is a self-declared affiliation. CAMPUS does not verify enrolment
                and never asks for student IDs or identity documents.
              </p>
            )}
            {!configured && <p className="setup-note">Preview mode: connect Supabase in .env to enable real accounts.</p>}
          </>
        )}
      </section>
    </div>
  )
}
