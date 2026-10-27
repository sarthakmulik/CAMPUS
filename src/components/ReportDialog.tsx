import { useState } from 'react'
import { useBodyScrollLock } from '../lib/scrollLock'
import { AlertCircle, Flag, X } from 'lucide-react'
import * as db from '../lib/db'

export type ReportTarget = {
  /** What is being reported, shown in the heading, e.g. 'this confession'. */
  label: string
  postId?: string | null
  reportedUserId?: string | null
  /** Text snapshot of reported content, sent as details for the moderation queue. */
  excerpt?: string
  /** Pulse statement target: routes the report through pulse_report_statement. */
  statementId?: string
}

type Props = {
  target: ReportTarget
  onClose: () => void
  onSubmitted: (message: string) => void
}

const REASONS = [
  'Harassment or bullying',
  'Threats or violence',
  'Doxxing or private information',
  'Spam or scam',
  'Hate speech',
  'Nudity or sexual content',
  'Something else',
]

/**
 * Real report submission: writes to the reports table through the
 * rate-limited submit_report() function. Failures are shown, never ignored.
 */
export default function ReportDialog({ target, onClose, onSubmitted }: Props) {
  // report dialog — lock the page behind the dimmed overlay
  useBodyScrollLock()
  const [reason, setReason] = useState(REASONS[0])
  const [details, setDetails] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const submit = async () => {
    setBusy(true)
    setError(null)
    try {
      if (target.statementId) {
        await db.pulseReportStatement({
          statementId: target.statementId,
          reason,
          details: details.trim() || (target.excerpt ? `Reported content: ${target.excerpt}` : ''),
        })
      } else {
        await db.submitReport({
          reason,
          postId: target.postId ?? null,
          reportedUserId: target.reportedUserId ?? null,
          details: details.trim() || (target.excerpt ? `Reported content: ${target.excerpt}` : ''),
        })
      }
      onSubmitted('Thanks — your report is in the CAMPUS moderation queue.')
    } catch (submitError) {
      setError(db.friendlyMessage(submitError))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="overlay" onMouseDown={event => { if (event.target === event.currentTarget) onClose() }}>
      <section className="report-dialog" role="dialog" aria-modal="true" aria-label={`Report ${target.label}`}>
        <button className="modal-close icon-button" onClick={onClose} aria-label="Close"><X size={20} /></button>
        <span className="prompt-icon"><Flag size={20} /></span>
        <h2>Report {target.label}</h2>
        <p>
          Reports go to CAMPUS platform moderators, not to your college. We never show the reporter's identity.
        </p>

        <fieldset className="reason-list">
          <legend>Why are you reporting this?</legend>
          {REASONS.map(item => (
            <label key={item} className={`reason-option ${reason === item ? 'selected' : ''}`}>
              <input
                type="radio"
                name="report-reason"
                value={item}
                checked={reason === item}
                onChange={() => setReason(item)}
              />
              <span>{item}</span>
            </label>
          ))}
        </fieldset>

        <label className="field-label">
          Anything else we should know? <span className="optional">optional</span>
          <textarea
            rows={3}
            maxLength={500}
            value={details}
            onChange={event => setDetails(event.target.value)}
            placeholder="Context helps moderators act faster."
          />
        </label>

        {error && <p className="form-error" role="alert"><AlertCircle size={15} /> {error}</p>}

        <div className="wizard-actions inline">
          <button className="secondary-button" onClick={onClose} disabled={busy}>Cancel</button>
          <button className="primary-button" onClick={() => void submit()} disabled={busy}>
            {busy ? 'Sending…' : 'Submit report'}
          </button>
        </div>
      </section>
    </div>
  )
}
