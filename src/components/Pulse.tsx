import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  BarChart3, Check, Clock, Copy, Flag, HeartHandshake, Sparkles, Trophy,
} from 'lucide-react'
import * as db from '../lib/db'
import type {
  PulseDailyView, PulseStatementCard, PulseQuizSummary, PulseInsight,
  PulseMilestoneRow, PulseAttemptRow,
} from '../lib/db'
import { PULSE_REACTIONS, MILESTONES, MILESTONE_KEYS, type MilestoneKey } from '../lib/pulse/config'
import { formatInsight } from '../lib/pulse/engine'
import ReportDialog from './ReportDialog'

type Identity = { id: string; name: string; username: string; initials: string }

type Props = {
  identity: Identity | null
  configured: boolean
  isMember: boolean
  requireAuth: (reason: string, returnTo?: string) => boolean
  notify: (message: string) => void
  /** Opens the existing composer with pre-filled share text (voluntary). */
  onSharePost?: (body: string) => boolean
}

/** Results bars only render once the privacy threshold is met — the server
 *  sends `results: null` before that, and this sub-component reinforces it. */
function PulseResults({ daily }: { daily: PulseDailyView }) {
  const counts = daily.results
  const total = Object.values(counts ?? {}).reduce((a, b) => a + Number(b), 0)
  if (!daily.myVote) return null
  if (!counts) {
    return (
      <div className="pulse-threshold-note" role="status">
        <HeartHandshake size={15} />
        <span>
          {daily.responsesTotal < daily.minSample
            ? `Your campus is just getting started — ${daily.responsesTotal} of ${daily.minSample} responses needed before results can be shown. Yours is in.`
            : `Yours is in. More responses are needed before we can show the results.`}
        </span>
      </div>
    )
  }
  const max = Math.max(1, ...Object.values(counts).map(Number))
  return (
    <div className="pulse-results" role="list" aria-label="Results so far">
      <div className="pulse-results-meta">
        <span>{total} response{total === 1 ? '' : 's'}</span>
        {total >= daily.minSample && <span className="pulse-results-ok"><Check size={13}/> results unlocked</span>}
      </div>
      {daily.options.map((opt, i) => {
        const n = Number(counts[String(i)] ?? 0)
        const mine = daily.myVote === i
        return (
          <div key={i} role="listitem" className={`pulse-result-row ${mine ? 'mine' : ''}`}>
            <span className="pulse-result-who">{opt.emoji} {opt.label}{mine && <span className="sr-only"> — your choice</span>}</span>
            <span className="pulse-result-bar-track" aria-hidden="true">
              <span className="pulse-result-bar" style={{ width: `${(n / max) * 100}%` }} />
            </span>
            <span className="pulse-result-n">{n} ({total > 0 ? Math.round((n * 100) / total) : 0}%)</span>
          </div>
        )
      })}
    </div>
  )
}

function endsLabel(iso: string): string {
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return ''
  return `ends ${d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}`
}

/**
 * Campus Pulse (nav label "Campus Pulse"): the daily check-in, the finite
 * "Am I the Only One?" deck, deterministic personality quizzes, threshold-
 * guarded insights and server-verified milestones. The server RPCs own every
 * number this page shows; the client never aggregates itself, and visitors
 * get the join state instead of partial features.
 */
export default function Pulse({ identity, configured, isMember, requireAuth, notify, onSharePost }: Props) {
  const [daily, setDaily] = useState<PulseDailyView | null>(null)
  const [dailyEmpty, setDailyEmpty] = useState(false)
  const [statements, setStatements] = useState<PulseStatementCard[]>([])
  const [quizzes, setQuizzes] = useState<PulseQuizSummary[]>([])
  const [attempts, setAttempts] = useState<PulseAttemptRow[]>([])
  const [insights, setInsights] = useState<PulseInsight[]>([])
  const [milestones, setMilestones] = useState<PulseMilestoneRow[]>([])
  const [activeQuiz, setActiveQuiz] = useState<{ quiz: PulseQuizSummary; answers: (number | null)[]; step: number } | null>(null)
  const [outcome, setOutcome] = useState<{ quiz: PulseQuizSummary; resultKey: number; label: string; emoji: string; blurb: string } | null>(null)
  const [busy, setBusy] = useState(false)
  const [pending, setPending] = useState(false)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [reportTarget, setReportTarget] = useState<{ statementId: string; text: string } | null>(null)
  const [copied, setCopied] = useState(false)
  const flight = useRef(0)

  const load = useCallback(async () => {
    if (!configured || !isMember || !identity) { setLoading(false); return }
    const ticket = ++flight.current
    setLoading(true)
    setError(null)
    const [dailyRes, deckRes, quizRes, insightRes, milestoneRes, attemptRes] = await Promise.allSettled([
      db.pulseEnsureDaily(),
      db.pulseStatements(),
      db.pulseQuizList(),
      db.pulseInsights(),
      db.pulseMilestonesMine(),
      db.pulseMyAttempts(),
    ])
    if (ticket !== flight.current) return   // a reload raced this response — discard
    const fail = dailyRes.status === 'rejected'
      ? dailyRes.reason instanceof Error ? dailyRes.reason.message : String(dailyRes.reason)
      : null
    if (fail) setError(fail)
    if (dailyRes.status === 'fulfilled') {
      setDaily(dailyRes.value.daily ?? null)
      setDailyEmpty(dailyRes.value.state === 'empty')
    }
    setStatements(deckRes.status === 'fulfilled' ? (deckRes.value.statements ?? []) : [])
    setQuizzes(quizRes.status === 'fulfilled' ? (quizRes.value.quizzes ?? []) : [])
    setInsights(insightRes.status === 'fulfilled' ? (insightRes.value.insights ?? []) : [])
    setMilestones(milestoneRes.status === 'fulfilled' ? milestoneRes.value : [])
    setAttempts(attemptRes.status === 'fulfilled' ? attemptRes.value : [])
    setLoading(false)
  }, [configured, isMember, identity])

  useEffect(() => { void load() }, [load])

  const awarded = useMemo(() => new Set(milestones.map(m => m.key)), [milestones])
  const myAttemptsByQuiz = useMemo(() => {
    const map = new Map<string, PulseAttemptRow>()
    for (const a of attempts) map.set(`${a.quizId}:${a.version}`, a)
    return map
  }, [attempts])

  /* ---- vote / skip (double-tap safe: server keeps the FIRST vote) ---- */
  const vote = async (optionIndex: number) => {
    if (!daily || pending || daily.myVote !== null) return
    setPending(true)
    setDaily({ ...daily, myVote: optionIndex })   // instant feedback, server corrects below
    try {
      const res = await db.pulseVote(daily.instanceId, optionIndex)
      if (res.error) throw new Error(res.error)
      if (res.daily) setDaily(res.daily)
      void load()   // milestones may have newly landed
    } catch (voteError) {
      setDaily(v => (v && v.instanceId === daily.instanceId ? { ...v, myVote: null } : v))   // roll back
      notify(db.friendlyMessage(voteError))
    } finally {
      setPending(false)
    }
  }

  const skipDaily = async () => {
    if (!daily || pending) return
    setPending(true)
    try {
      await db.pulseSkip(daily.instanceId)
      notify('Skipped for today — no streak lost.')
    } catch (skipError) {
      notify(db.friendlyMessage(skipError))
    } finally {
      setPending(false)
    }
  }

  /* ---- statement reactions (changeable, one per user per statement) ---- */
  const react = async (card: PulseStatementCard, idx: number) => {
    const next = card.my === idx ? null : idx   // tap own reaction again to clear
    setStatements(list => list.map(c => c.id === card.id ? {
      ...c, my: next, counts: next === null ? c.counts.map((n, i) => (i === card.my ? Math.max(0, n - 1) : n)) : c.counts.map((n, i) => (i === card.my ? Math.max(0, n - 1) : i === idx ? n + 1 : n)),
    } : c))
    try {
      const res = await db.pulseReact(card.id, next)
      if (res.error) throw new Error(res.error)
      setStatements(list => list.map(c => c.id === card.id
        ? { ...c, my: res.my ?? null, counts: (res.counts ?? c.counts).map(Number) }
        : c))
      if (next !== null) void load()   // Campus Voice milestone may have landed
    } catch (reactError) {
      setStatements(list => list.map(c => c.id === card.id ? { ...c, my: card.my, counts: card.counts } : c))
      notify(db.friendlyMessage(reactError))
    }
  }

  /* ---- quiz flow (server re-scores everything) ---- */
  const startQuiz = (quiz: PulseQuizSummary) => {
    if (!requireAuth('complete a Campus Personality quiz')) return
    setOutcome(null)
    setActiveQuiz({ quiz, answers: quiz.questions.map(() => null), step: 0 })
  }

  const answerQuestion = (optionIndex: number) => {
    if (!activeQuiz) return
    const answers = activeQuiz.answers.slice()
    answers[activeQuiz.step] = optionIndex
    if (activeQuiz.step < activeQuiz.quiz.questions.length - 1) {
      setActiveQuiz({ ...activeQuiz, answers, step: activeQuiz.step + 1 })
      return
    }
    void finishQuiz(activeQuiz.quiz, answers)
  }

  const finishQuiz = async (quiz: PulseQuizSummary, answers: (number | null)[]) => {
    if (answers.some(a => a === null) || !identity) return
    setBusy(true)
    try {
      const res = await db.pulseQuizSubmit(quiz.id, quiz.version, answers as number[])
      if (res.error || res.label === undefined) throw new Error(res.error ?? 'The quiz could not be scored.')
      setOutcome({ quiz, resultKey: res.resultKey ?? 0, label: res.label, emoji: res.emoji ?? '🙂', blurb: res.blurb ?? '' })
      setActiveQuiz(null)
      void load()
    } catch (quizError) {
      notify(db.friendlyMessage(quizError))
      setActiveQuiz(null)
    } finally {
      setBusy(false)
    }
  }

  const shareResult = (text: string) => {
    if (onSharePost && onSharePost(text)) { notify('Take it into the composer to post.'); return }
    void navigator.clipboard?.writeText(text).then(() => {
      setCopied(true)
      setTimeout(() => setCopied(false), 1800)
      notify('Result copied — paste it anywhere on CAMPUS.')
    }, () => notify('Could not copy the result.'))
  }

  /* ---- gate: not connected / signed out ---- */
  if (!configured) {
    return (
      <div className="pulse-page">
        <div className="pulse-empty-card">
          <Sparkles size={22} />
          <h2>Campus Pulse</h2>
          <p>CAMPUS is not connected right now, so today's Pulse can't load. Try again once you're back online.</p>
        </div>
      </div>
    )
  }
  if (!isMember) {
    return (
      <div className="pulse-page">
        <div className="pulse-empty-card">
          <Sparkles size={22} />
          <h2>Campus Pulse</h2>
          <p>One question a day, relatable statements, personality quizzes and real campus insights. Join CAMPUS to take part.</p>
          <button className="primary-button" onClick={() => requireAuth('answer today\'s Pulse', 'Campus Pulse')}>Join CAMPUS</button>
        </div>
      </div>
    )
  }

  const hero = (
    <div className="pulse-hero">
      <div className="pulse-hero-badges" aria-label="Your milestones">
        {loading
          ? <span className="pulse-skel" style={{ width: 120, height: 20 }} />
          : MILESTONE_KEYS.map(key => {
              const earned = awarded.has(key)
              const meta = MILESTONES[key]
              return (
                <span key={key} className={`pulse-chip ${earned ? 'earned' : ''}`} title={meta.hint}>
                  <span aria-hidden="true">{meta.emoji}</span> {meta.label}
                </span>
              )
            })}
      </div>
      <p className="pulse-hero-note">Milestones are optional keepsakes — skipping a day never costs you anything.</p>
    </div>
  )

  return (
    <div className="pulse-page">
      {hero}

      {/* ---------------- Today's Pulse ---------------- */}
      <section className="pulse-section" aria-label="Today's Pulse">
        <h2 className="pulse-kicker"><Clock size={15}/> Today's Pulse</h2>
        {loading ? (
          <div className="pulse-card pulse-skel-card" aria-hidden="true">
            <span className="pulse-skel" style={{ width: '70%', height: 22 }} />
            <span className="pulse-skel" style={{ width: '100%', height: 48 }} />
            <span className="pulse-skel" style={{ width: '100%', height: 48 }} />
            <span className="pulse-skel" style={{ width: '100%', height: 48 }} />
          </div>
        ) : error && !daily ? (
          <div className="pulse-card pulse-empty-card small">
            <p>Campus Pulse could not load today's question.</p>
            <p className="pulse-err">{error}</p>
            <button className="secondary-button" onClick={() => void load()}>Try again</button>
          </div>
        ) : dailyEmpty && !daily ? (
          <div className="pulse-card pulse-empty-card small">
            <p>No question is scheduled right now — new pulses are added as the approved library grows. Check back tomorrow.</p>
          </div>
        ) : daily ? (
          <div className={`pulse-card pulse-daily ${daily.status === 'closed' ? 'closed' : ''}`}>
            <span className="pulse-tag">{endsLabel(daily.endsAt)}</span>
            <h3 className="pulse-question">{daily.question}</h3>
            {daily.myVote === null && daily.status !== 'closed' ? (
              <>
                <div className="pulse-options">
                  {daily.options.map((opt, i) => (
                    <button
                      key={i}
                      className="pulse-option"
                      disabled={pending || busy}
                      onClick={() => void vote(i)}
                    >
                      <span className="pulse-option-emoji" aria-hidden="true">{opt.emoji}</span>
                      <span>{opt.label}</span>
                    </button>
                  ))}
                </div>
                <button className="pulse-skip" disabled={pending} onClick={() => void skipDaily()}>
                  Skip today
                </button>
              </>
            ) : (
              <>
                <PulseResults daily={daily} />
                {daily.status === 'closed' && daily.myVote === null && (
                  <p className="pulse-closed-note">Today's question has ended — a new one starts tomorrow.</p>
                )}
              </>
            )}
          </div>
        ) : null}
      </section>

      {/* ---------------- Am I the Only One? ---------------- */}
      <section className="pulse-section" aria-label="Am I the Only One?">
        <h2 className="pulse-kicker">Am I the Only One…?</h2>
        {loading
          ? <div className="pulse-deck">{[0, 1, 2].map(i => <span key={i} className="pulse-skel" style={{ width: '100%', height: 96 }} />)}</div>
          : statements.length === 0
            ? <div className="pulse-card pulse-empty-card small"><p>The statement deck is growing — come back tomorrow for a fresh set.</p></div>
            : (
              <div className="pulse-deck">
                {statements.map(card => (
                  <article key={card.id} className="pulse-card pulse-statement">
                    <p className="pulse-statement-text">“{card.text}”</p>
                    <div className="pulse-reactions">
                      {PULSE_REACTIONS.map((r, i) => (
                        <button
                          key={i}
                          className={`pulse-reaction ${card.my === i ? 'mine' : ''}`}
                          onClick={() => void react(card, i)}
                          aria-pressed={card.my === i}
                          title={r.label}
                        >
                          <span aria-hidden="true">{r.emoji}</span>
                          <span className="pulse-reaction-count">{card.counts[i] ?? 0}</span>
                          <span className="sr-only">{r.label}</span>
                        </button>
                      ))}
                      <button
                        className="pulse-report"
                        onClick={() => setReportTarget({ statementId: card.id, text: card.text })}
                        aria-label="Report this statement"
                      >
                        <Flag size={15} />
                      </button>
                    </div>
                  </article>
                ))}
                <p className="pulse-deck-note">A fresh deck every day — said by no one, felt by everyone. Reaction counts are anonymous.</p>
              </div>
            )}
      </section>

      {/* ---------------- Campus Personality ---------------- */}
      <section className="pulse-section" aria-label="Campus Personality">
        <h2 className="pulse-kicker"><Trophy size={15}/> Campus Personality</h2>
        {activeQuiz ? (
          <div className="pulse-card pulse-quiz">
            <div className="pulse-quiz-progress" role="progressbar" aria-valuemin={1} aria-valuemax={activeQuiz.quiz.questions.length} aria-valuenow={activeQuiz.step + 1}>
              <span style={{ width: `${((activeQuiz.step + 1) / activeQuiz.quiz.questions.length) * 100}%` }} />
            </div>
            <p className="pulse-quiz-step">{activeQuiz.step + 1} / {activeQuiz.quiz.questions.length}</p>
            <h3 className="pulse-question">{activeQuiz.quiz.questions[activeQuiz.step].prompt}</h3>
            <div className="pulse-options">
              {activeQuiz.quiz.questions[activeQuiz.step].options.map((opt, i) => (
                <button key={i} className="pulse-option" disabled={busy} onClick={() => answerQuestion(i)}>
                  <span>{opt.text}</span>
                </button>
              ))}
            </div>
            <button className="pulse-skip" onClick={() => setActiveQuiz(null)}>Quit for now — no result is saved midway</button>
          </div>
        ) : outcome ? (
          <div className="pulse-card pulse-quiz-result">
            <span className="pulse-result-emoji" aria-hidden="true">{outcome.emoji}</span>
            <p className="pulse-result-label">{outcome.label}</p>
            <p className="pulse-result-blurb">{outcome.blurb}</p>
            <p className="pulse-result-owner">
              {identity ? `${identity.name} · ` : ''}{outcome.quiz.title} · CAMPUS Campus Pulse
            </p>
            <div className="pulse-actions">
              <button className="secondary-button" onClick={() => shareResult(`${outcome.emoji} ${outcome.label} — ${outcome.quiz.title}. Find your campus legend in CAMPUS Pulse.`)}>
                {onSharePost ? 'Share' : <><Copy size={14}/> {copied ? 'Copied' : 'Copy result'}</>}
              </button>
              <button className="pulse-skip" onClick={() => startQuiz(outcome.quiz)}>Retake</button>
            </div>
            <p className="pulse-quiz-fineprint">Entertainment only, ever — results are deterministic, never a psychology read.</p>
          </div>
        ) : loading ? (
          <div className="pulse-deck">{[0, 1].map(i => <span key={i} className="pulse-skel" style={{ width: '100%', height: 84 }} />)}</div>
        ) : quizzes.length === 0 ? (
          <div className="pulse-card pulse-empty-card small"><p>No quizzes yet — the first one is being authored.</p></div>
        ) : (
          <div className="pulse-deck">
            {quizzes.map(quiz => {
              const attempt = myAttemptsByQuiz.get(`${quiz.id}:${quiz.version}`)
              const earnedLabel = attempt ? (quiz.results.find(r => r.resultKey === attempt.resultKey)?.label ?? null) : null
              return (
                <button key={quiz.id} className="pulse-card pulse-quiz-tile" onClick={() => startQuiz(quiz)}>
                  <span className="pulse-quiz-title">{quiz.title}</span>
                  <span className="pulse-quiz-meta">
                    {quiz.questions.length} questions
                    {earnedLabel && <span className="pulse-quiz-earned"> · last time: {earnedLabel}</span>}
                  </span>
                </button>
              )
            })}
          </div>
        )}
      </section>

      {/* ---------------- Campus Insights ---------------- */}
      <section className="pulse-section" aria-label="Campus Insights">
        <h2 className="pulse-kicker"><BarChart3 size={15}/> Campus Insights</h2>
        {loading
          ? <span className="pulse-skel" style={{ width: '100%', height: 88 }} />
          : insights.length === 0 ? (
            <div className="pulse-card pulse-empty-card small">
              <p>No insights yet this week.</p>
              <p className="pulse-quiet">Insights appear once enough of your campus takes part — nothing is estimated or invented.</p>
            </div>
          ) : (
            <div className="pulse-insights">
              {insights.map((ins, i) => {
                const view = formatInsight(ins as unknown as Record<string, unknown>)
                if (!view) return null   // non-whitelisted server keys render nothing — never invented copy
                return (
                  <article key={`${ins.key}:${i}`} className="pulse-card pulse-insight">
                    <span className="pulse-insight-icon" aria-hidden="true">{view.icon}</span>
                    <div>
                      <p className="pulse-insight-title">{view.title}</p>
                      <p className="pulse-insight-body">{view.body}</p>
                      {view.explain && (
                        <details className="pulse-insight-explain">
                          <summary>How this was calculated</summary>
                          <p>{view.explain}</p>
                          <p className="pulse-quiet">{view.sample} students took part{view.sample >= view.min ? ' — above the minimum sample of ' + view.min : '.'}</p>
                        </details>
                      )}
                    </div>
                  </article>
                )
              })}
            </div>
          )}
      </section>

      {reportTarget && (
        <ReportDialog
          target={{ label: 'this statement', statementId: reportTarget.statementId, excerpt: reportTarget.text }}
          onClose={() => setReportTarget(null)}
          onSubmitted={message => { setReportTarget(null); notify(message) }}
        />
      )}
    </div>
  )
}
