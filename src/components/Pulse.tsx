import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties, type PointerEvent as ReactPointerEvent } from 'react'
import {
  BarChart3, Check, Clock, Copy, Flag, HeartHandshake, Settings, Sparkles, Trophy, X,
} from 'lucide-react'
import * as db from '../lib/db'
import type {
  PulseDailyView, PulseStatementCard, PulseQuizSummary, PulseInsight,
  PulseMilestoneRow, PulseAttemptRow,
} from '../lib/db'
import {
  PULSE_REACTIONS, MILESTONES, MILESTONE_KEYS, TOPICS, TOPIC_KEYS, TOPIC_THEMES,
  type MilestoneKey, type TopicKey,
} from '../lib/pulse/config'
import {
  formatInsight, rankQuizzes, quizDurationLabel, nextInterestScore,
  NEUTRAL_PROFILE, type InterestProfile,
} from '../lib/pulse/engine'
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

/* ------------------------------------------------------------------ */
/* Small visual helpers                                                */
/* ------------------------------------------------------------------ */

const DEFAULT_THEME = { grad: 'linear-gradient(120deg,#6654f5,#9b7bff)', ring: '#6654f5' }
/** Visual identity for a category — deterministic, never user-specific. */
function topicTheme(category: string): { grad: string; ring: string } {
  return (TOPIC_THEMES as Record<string, { grad: string; ring: string }>)[category] ?? DEFAULT_THEME
}
function topicMeta(category: string): { label: string; emoji: string } {
  return (TOPICS as Record<string, { label: string; emoji: string }>)[category]
    ?? { label: category, emoji: '🧩' }
}

const prefersReducedMotion = (): boolean =>
  window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false

/** Animated number count-up (skipped entirely under reduced motion). */
function useCountUp(target: number, ms = 650): number {
  const [value, setValue] = useState(prefersReducedMotion() ? target : 0)
  useEffect(() => {
    if (prefersReducedMotion()) { setValue(target); return }
    if (!Number.isFinite(target)) { setValue(0); return }
    let raf = 0
    const t0 = performance.now()
    const from = 0
    const tick = (t: number) => {
      const p = Math.min(1, (t - t0) / ms)
      const eased = 1 - (1 - p) * (1 - p)   // ease-out
      setValue(Math.round(from + (target - from) * eased))
      if (p < 1) raf = requestAnimationFrame(tick)
    }
    raf = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(raf)
  }, [target, ms])
  return value
}

/** SVG progress ring — the privacy-threshold indicator for the daily card. */
function ThresholdRing({ progress, size = 34 }: { progress: number; size?: number }) {
  const stroke = 3.5
  const r = (size - stroke) / 2
  const c = 2 * Math.PI * r
  const p = Math.max(0, Math.min(1, progress))
  return (
    <svg className="pulse-ring" width={size} height={size} viewBox={`0 0 ${size} ${size}`} role="img" aria-label={`Privacy threshold ${Math.round(p * 100)}% reached`}>
      <circle cx={size / 2} cy={size / 2} r={r} fill="none" stroke="var(--line, #e6e4f7)" strokeWidth={stroke} />
      <circle
        cx={size / 2} cy={size / 2} r={r} fill="none" stroke="var(--brand, #6654f5)" strokeWidth={stroke}
        strokeLinecap="round" strokeDasharray={c} strokeDashoffset={c * (1 - p)}
        transform={`rotate(-90 ${size / 2} ${size / 2})`} className="pulse-ring-fill"
      />
    </svg>
  )
}

/* ------------------------------------------------------------------ */
/* Results — only once the server has unlocked them (threshold pass)   */
/* ------------------------------------------------------------------ */

function PulseResultRow({ index, label, emoji, n, max, total, mine }: {
  index: number; label: string; emoji: string; n: number; max: number; total: number; mine: boolean
}) {
  const shown = useCountUp(n)
  return (
    <div role="listitem" className={`pulse-result-row ${mine ? 'mine' : ''}`} style={{ '--i': index } as CSSProperties}>
      <span className="pulse-result-who">{emoji} {label}{mine && <span className="sr-only"> — your choice</span>}</span>
      <span className="pulse-result-bar-track" aria-hidden="true">
        <span className="pulse-result-bar" style={{ width: `${(shown / max) * 100}%` }} />
      </span>
      <span className="pulse-result-n">{shown} ({total > 0 ? Math.round((shown * 100) / total) : 0}%)</span>
    </div>
  )
}

function PulseResults({ daily }: { daily: PulseDailyView }) {
  const counts = daily.results
  const totalRaw = Object.values(counts ?? {}).reduce((a, b) => a + Number(b), 0)
  const total = useCountUp(totalRaw)
  const thresholdP = Math.max(0, Math.min(1, daily.responsesTotal / Math.max(1, daily.minSample)))

  if (daily.myVote === null) return null   // option index 0 is valid — must not be treated as "no vote"

  if (!counts) {
    const mine = daily.options[daily.myVote]
    return (
      <div className="pulse-results locked" role="status">
        <div className="pulse-voted-chip">
          <ThresholdRing progress={thresholdP} />
          <span className="pulse-voted-choice">
            <span className="pulse-voted-emoji" aria-hidden="true">{mine?.emoji}</span>
            <span>You answered: <b>{mine?.label}</b></span>
          </span>
        </div>
        <div className="pulse-threshold-note">
          <HeartHandshake size={15} />
          <span>
            {daily.responsesTotal < daily.minSample
              ? `Results unlock when ${daily.minSample} of your campus have answered — no one sees them before that. Yours is in.`
              : 'Yours is in. More responses are needed before we can show the results.'}
          </span>
        </div>
        <div className="pulse-threshold-track" aria-hidden="true">
          <span style={{ width: `${thresholdP * 100}%` }} />
        </div>
        <p className="pulse-quiet pulse-threshold-meta">{daily.responsesTotal} of {daily.minSample} responses</p>
      </div>
    )
  }

  const max = Math.max(1, ...Object.values(counts).map(Number))
  return (
    <div className="pulse-results" role="list" aria-label="Results so far">
      <div className="pulse-results-meta">
        <span>{total} response{total === 1 ? '' : 's'}</span>
        {totalRaw >= daily.minSample && <span className="pulse-results-ok"><Check size={13}/> results unlocked</span>}
      </div>
      {daily.options.map((opt, i) => {
        const n = Number(counts[String(i)] ?? 0)
        return (
          <PulseResultRow key={i} index={i} label={opt.label} emoji={opt.emoji} n={n} max={max} total={totalRaw} mine={daily.myVote === i} />
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

/* ------------------------------------------------------------------ */
/* Personalization settings sheet                                      */
/* ------------------------------------------------------------------ */

type ChipState = 'select' | 'avoid' | 'neutral'

function SettingsSheet({ profile, busy, onClose, onCycleTopic, onTogglePersonalization, onReset }: {
  profile: InterestProfile | null
  busy: boolean
  onClose: () => void
  onCycleTopic: (topic: TopicKey) => void
  onTogglePersonalization: (on: boolean) => void
  onReset: () => void
}) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose() }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])
  const chipState = (topic: TopicKey): ChipState => {
    if (!profile?.personalization || !profile.explicit[topic]) return 'neutral'
    return (profile.interests[topic] ?? 0.5) >= 0.5 ? 'select' : 'avoid'
  }
  return (
    <div className="pulse-sheet-backdrop" onClick={onClose}>
      <div className="pulse-sheet" role="dialog" aria-modal="true" aria-label="Your Pulse interests" onClick={e => e.stopPropagation()}>
        <div className="pulse-sheet-head">
          <h2><Sparkles size={16} /> Your interests</h2>
          <button className="pulse-sheet-close" onClick={onClose} aria-label="Close settings"><X size={18} /></button>
        </div>
        <p className="pulse-sheet-lede">
          Tap a topic to tell Pulse what you enjoy. This only shapes the order quizzes appear in —
          every feature stays available either way. Your interests are private: only you can see them.
        </p>
        <label className="pulse-sheet-toggle">
          <span>
            <b>Personalized recommendations</b>
            <small>Ranks quizzes by your interests. Turn off to keep everything in neutral order.</small>
          </span>
          <input
            type="checkbox"
            role="switch"
            checked={profile?.personalization ?? true}
            disabled={busy}
            onChange={e => onTogglePersonalization(e.target.checked)}
          />
        </label>
        <div className="pulse-topic-grid" role="group" aria-label="Topics">
          {TOPIC_KEYS.map(t => {
            const state = chipState(t)
            const meta = TOPICS[t]
            return (
              <button
                key={t}
                className={`pulse-topic-chip ${state}`}
                disabled={busy || profile?.personalization === false}
                aria-pressed={state !== 'neutral'}
                title={state === 'select' ? 'Enjoying — tap for “not for me”, again to clear'
                  : state === 'avoid' ? 'Not for me — tap to clear' : 'Tap if you enjoy this topic'}
                onClick={() => onCycleTopic(t)}
              >
                <span aria-hidden="true">{meta.emoji}</span> {meta.label}
                {state === 'select' && <span className="pulse-topic-state" aria-hidden="true">✓</span>}
                {state === 'avoid' && <span className="pulse-topic-state" aria-hidden="true">✕</span>}
              </button>
            )
          })}
        </div>
        {profile?.personalization === false && (
          <p className="pulse-quiet">Personalization is off — your topic choices are paused and nothing new is learned.</p>
        )}
        <div className="pulse-sheet-foot">
          <button className="pulse-danger-link" disabled={busy} onClick={onReset}>
            Reset my interest profile
          </button>
          <p className="pulse-quiet">Resetting clears what Pulse has learned. Your votes, quiz results and milestones stay.</p>
        </div>
      </div>
    </div>
  )
}

/**
 * Campus Pulse (nav label "Campus Pulse"): the daily check-in, the finite
 * "Am I the Only One?" deck, deterministic personality quizzes, threshold-
 * guarded insights and server-verified milestones. The server RPCs own every
 * number this page shows; the client never aggregates itself, and visitors
 * get the join state instead of partial features.
 *
 * 2.0 additions ride ON TOP of that model: presentation-order ranking only
 * (rankQuizzes), a private interest profile touched through server RPCs, and
 * fire-and-forget whitelisted analytics. No authoritative number ever moved
 * to the client.
 */
export default function Pulse({ identity, configured, isMember, requireAuth, notify, onSharePost }: Props) {
  const [daily, setDaily] = useState<PulseDailyView | null>(null)
  const [dailyEmpty, setDailyEmpty] = useState(false)
  const [statements, setStatements] = useState<PulseStatementCard[]>([])
  const [sectionErrors, setSectionErrors] = useState<{ deck?: string; quizzes?: string; insights?: string }>({})
  const [quizzes, setQuizzes] = useState<PulseQuizSummary[]>([])
  const [attempts, setAttempts] = useState<PulseAttemptRow[]>([])
  const [insights, setInsights] = useState<PulseInsight[]>([])
  const [milestones, setMilestones] = useState<PulseMilestoneRow[]>([])
  const [profile, setProfile] = useState<InterestProfile | null>(null)
  const [activeQuiz, setActiveQuiz] = useState<{ quiz: PulseQuizSummary; answers: (number | null)[]; step: number } | null>(null)
  const [outcome, setOutcome] = useState<{ quiz: PulseQuizSummary; resultKey: number; label: string; emoji: string; blurb: string } | null>(null)
  const [busy, setBusy] = useState(false)
  const [pending, setPending] = useState(false)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [reportTarget, setReportTarget] = useState<{ statementId: string; text: string } | null>(null)
  const [copied, setCopied] = useState(false)
  const [justVoted, setJustVoted] = useState(false)
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [feedbackGiven, setFeedbackGiven] = useState<string | null>(null)
  /* deck state */
  const [deckPos, setDeckPos] = useState<number | null>(null)
  const [flying, setFlying] = useState<{ id: string; dir: 'left' | 'right' | 'tap' } | null>(null)
  const [drag, setDrag] = useState<{ id: string; dx: number } | null>(null)
  const flight = useRef(0)
  const dragStart = useRef<{ id: string; x: number } | null>(null)
  const viewed = useRef<Set<string>>(new Set())

  // opening a quiz or landing on its result must bring that card into view —
  // the Personality section sits below the statement deck (≈1.3k px of scroll
  // on a 390×780 phone frame), so a tile tap otherwise has no visible effect.
  const quizCardRef = useRef<HTMLDivElement | null>(null)
  const resultCardRef = useRef<HTMLDivElement | null>(null)
  const activeQuizId = activeQuiz?.quiz.id ?? null
  useEffect(() => {
    const el = outcome ? resultCardRef.current : quizCardRef.current
    if ((activeQuizId || outcome) && el) {
      el.scrollIntoView({ behavior: prefersReducedMotion() ? 'auto' : 'smooth', block: 'start' })
    }
  }, [activeQuizId, outcome])

  /* ---------------------------------------------------------------- */
  /* Loading — the interest profile rides the same allSettled flight   */
  /* ---------------------------------------------------------------- */
  const load = useCallback(async () => {
    if (!configured || !isMember || !identity) { setLoading(false); return }
    const ticket = ++flight.current
    setLoading(true)
    setError(null)
    const [dailyRes, deckRes, quizRes, insightRes, milestoneRes, attemptRes, profileRes] = await Promise.allSettled([
      db.pulseEnsureDaily(),
      db.pulseStatements(),
      db.pulseQuizList(),
      db.pulseInsights(),
      db.pulseMilestonesMine(),
      db.pulseMyAttempts(),
      db.pulseProfileGet(),
    ])
    if (ticket !== flight.current) return   // a reload raced this response — discard
    const reasonOf = (r: PromiseSettledResult<unknown>): string =>
      r.status === 'rejected' ? (
        r.reason instanceof Error ? r.reason.message : String(r.reason)
      ) : ''
    const fail = dailyRes.status === 'rejected' ? reasonOf(dailyRes) : null
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
    if (profileRes.status === 'fulfilled') {
      const p = profileRes.value
      const interests: Record<string, number> = {}
      const explicit: Record<string, boolean> = {}
      for (const row of p.interests) { interests[row.topic] = Number(row.score); explicit[row.topic] = row.explicit }
      setProfile({ personalization: p.personalization, interests, explicit })
    }
    setSectionErrors({
      deck: deckRes.status === 'rejected' ? reasonOf(deckRes) : undefined,
      quizzes: quizRes.status === 'rejected' ? reasonOf(quizRes) : undefined,
      insights: insightRes.status === 'rejected' ? reasonOf(insightRes) : undefined,
    })
    setLoading(false)
  }, [configured, isMember, identity])

  useEffect(() => { void load() }, [load])

  /* one honest 'pulse_question_viewed' per instance per visit */
  useEffect(() => {
    if (daily && !viewed.current.has(daily.instanceId)) {
      viewed.current.add(daily.instanceId)
      db.pulseEventLog('pulse_question_viewed', 'pulse_question', daily.instanceId, { category: daily.category })
    }
  }, [daily])

  const awarded = useMemo(() => new Set(milestones.map(m => m.key)), [milestones])
  const myAttemptsByQuiz = useMemo(() => {
    const map = new Map<string, PulseAttemptRow>()
    for (const a of attempts) map.set(`${a.quizId}:${a.version}`, a)
    return map
  }, [attempts])

  /* ---------------------------------------------------------------- */
  /* 2.0 ranking — presentation order ONLY (never authoritative)       */
  /* ---------------------------------------------------------------- */
  const ranked = useMemo(() => {
    if (quizzes.length === 0) return []
    const lastAttempt = [...attempts].sort((a, b) => (a.at < b.at ? 1 : -1))[0] ?? null
    const lastCategory = lastAttempt ? quizzes.find(q => q.id === lastAttempt.quizId)?.category ?? null : null
    return rankQuizzes({
      scopeKey: identity?.id ?? 'platform',
      date: new Date().toISOString().slice(0, 10),
      quizzes: quizzes.map(q => ({
        id: q.id,
        title: q.title,
        category: q.category,
        questionCount: q.questions.length,
        attemptCount: attempts.filter(a => a.quizId === q.id).length,
        lastAttemptDate: attempts.filter(a => a.quizId === q.id).sort((a, b) => (a.at < b.at ? 1 : -1))[0]?.at.slice(0, 10) ?? null,
      })),
      profile: profile ?? NEUTRAL_PROFILE,
      lastCompletedCategory: lastCategory,
    })
  }, [quizzes, attempts, profile, identity])
  const quizById = useMemo(() => new Map(quizzes.map(q => [q.id, q])), [quizzes])

  /* ---- vote / skip (double-tap safe: server keeps the FIRST vote) ---- */
  const vote = async (optionIndex: number) => {
    if (!daily || pending || daily.myVote !== null) return
    setPending(true)
    setDaily({ ...daily, myVote: optionIndex })   // instant feedback, server corrects below
    setJustVoted(true)
    setTimeout(() => setJustVoted(false), 1600)
    try {
      navigator.vibrate?.(8)
    } catch { /* haptics are best-effort only */ }
    try {
      const res = await db.pulseVote(daily.instanceId, optionIndex)
      if (res.error) throw new Error(res.error)
      if (res.daily) setDaily(res.daily)
      db.pulseEventLog('pulse_question_answered', 'pulse_question', daily.instanceId, { category: daily.category })
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
      db.pulseEventLog('pulse_question_skipped', 'pulse_question', daily.instanceId, { category: daily.category })
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

  /* ---- swipe deck helpers ------------------------------------------ */
  /* After a reaction the card flies out and the deck advances. A card the
   * user later un-reacts from the recap list is already behind deckPos, so
   * it lives on in the recap (where it can be re-reacted) rather than
   * re-entering the deck — the deck stays a forward-only daily ritual. */
  const advanceDeck = (cardId: string, dir: 'left' | 'right' | 'tap') => {
    if (prefersReducedMotion()) { setDeckPos(p => (p ?? 0) + 1); return }
    setFlying({ id: cardId, dir })
    setTimeout(() => {
      setDeckPos(p => (p ?? 0) + 1)
      setFlying(null)
      setDrag(null)
    }, 240)
  }
  const deckReact = (card: PulseStatementCard, idx: number, dir: 'left' | 'right' | 'tap') => {
    void react(card, idx)
    advanceDeck(card.id, dir)
  }
  const onCardPointerDown = (e: ReactPointerEvent<HTMLElement>, card: PulseStatementCard) => {
    if (flying || card.my !== null) return
    dragStart.current = { id: card.id, x: e.clientX }
    ;(e.currentTarget as HTMLElement).setPointerCapture?.(e.pointerId)
  }
  const onCardPointerMove = (e: ReactPointerEvent<HTMLElement>, card: PulseStatementCard) => {
    const d = dragStart.current
    if (!d || d.id !== card.id || flying) return
    setDrag({ id: card.id, dx: e.clientX - d.x })
  }
  const onCardPointerUp = (e: ReactPointerEvent<HTMLElement>, card: PulseStatementCard) => {
    const d = dragStart.current
    dragStart.current = null
    if (!d || d.id !== card.id || flying) return
    const dx = drag?.id === card.id ? drag.dx : 0
    setDrag(null)
    if (dx > 72) deckReact(card, 0, 'right')        // Same
    else if (dx < -72) deckReact(card, 2, 'left')   // Not me
    // small drags just spring back
  }

  // start the deck at the first not-yet-reacted statement (returns resume
  // cleanly across reloads without ever rewinding past taken cards)
  useEffect(() => {
    if (deckPos === null && statements.length > 0) {
      const first = statements.findIndex(s => s.my === null)
      setDeckPos(first === -1 ? statements.length : first)
    }
  }, [statements, deckPos])

  /* ---- quiz flow (server re-scores everything) ---- */
  const startQuiz = (quiz: PulseQuizSummary) => {
    if (!requireAuth('complete a Campus Personality quiz')) return
    db.pulseEventLog('quiz_opened', 'quiz', quiz.id, { category: quiz.category })
    setOutcome(null)
    setActiveQuiz({ quiz, answers: quiz.questions.map(() => null), step: 0 })
  }

  const answerQuestion = (optionIndex: number) => {
    if (!activeQuiz) return
    try { navigator.vibrate?.(6) } catch { /* best effort */ }
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
      setFeedbackGiven(null)
      setActiveQuiz(null)
      db.pulseEventLog('quiz_completed', 'quiz', quiz.id, { resultKey: res.resultKey ?? 0, category: quiz.category })
      void load()
    } catch (quizError) {
      notify(db.friendlyMessage(quizError))
      setActiveQuiz(null)
    } finally {
      setBusy(false)
    }
  }

  const shareResult = (text: string) => {
    db.pulseEventLog('quiz_shared', 'quiz', outcome?.quiz.id ?? null, { category: outcome?.quiz.category })
    if (onSharePost && onSharePost(text)) { notify('Take it into the composer to post.'); return }
    void navigator.clipboard?.writeText(text).then(() => {
      setCopied(true)
      setTimeout(() => setCopied(false), 1800)
      notify('Result copied — paste it anywhere on CAMPUS.')
    }, () => notify('Could not copy the result.'))
  }

  /* result-screen feedback — gentle implicit signals (like/dislike), never
   * an explicit interest claim; the server rate-limits and stays bounded */
  const sendResultFeedback = async (value: 'like' | 'dislike') => {
    if (!outcome || feedbackGiven) return
    setFeedbackGiven(outcome.quiz.id)
    try {
      const res = await db.pulseInterestSignal(outcome.quiz.category, value)
      if (res.error) throw new Error(res.error)
      db.pulseEventLog('quiz_feedback_submitted', 'quiz', outcome.quiz.id, { topic: outcome.quiz.category, value })
      notify('Noted — more quizzes like this one are coming your way.')
    } catch (feedbackError) {
      setFeedbackGiven(null)
      notify(db.friendlyMessage(feedbackError))
    }
  }

  /* ---- settings sheet actions (server-authoritative, optimistic UI) ---- */
  const refreshProfile = useCallback(async () => {
    try {
      const p = await db.pulseProfileGet()
      const interests: Record<string, number> = {}
      const explicit: Record<string, boolean> = {}
      for (const row of p.interests) { interests[row.topic] = Number(row.score); explicit[row.topic] = row.explicit }
      setProfile({ personalization: p.personalization, interests, explicit })
    } catch { /* the sheet still shows the last known state */ }
  }, [])

  const cycleTopic = async (topic: TopicKey) => {
    const current: ChipState = profile?.explicit[topic]
      ? ((profile.interests[topic] ?? 0.5) >= 0.5 ? 'select' : 'avoid')
      : 'neutral'
    const next: ChipState = current === 'select' ? 'avoid' : current === 'avoid' ? 'neutral' : 'select'
    // optimistic mirror (bounded, same rules the server applies)
    setProfile(p => {
      if (!p) return p
      const interests = { ...p.interests }
      const explicit = { ...p.explicit }
      if (next === 'neutral') { delete interests[topic]; explicit[topic] = false }
      else { interests[topic] = nextInterestScore(interests[topic] ?? null, next); explicit[topic] = true }
      return { ...p, interests, explicit }
    })
    try {
      const res = await db.pulseInterestSignal(topic, next)
      if (res.error) throw new Error(res.error)
      db.pulseEventLog('topic_interest_updated', 'topic', null, { topic, signal: next })
      if (!res.ignored) notify(next === 'select' ? `${TOPICS[topic].label}: you'll see more of this`
        : next === 'avoid' ? `${TOPICS[topic].label}: we'll ease off this`
        : `${TOPICS[topic].label}: back to neutral`)
    } catch (topicError) {
      notify(db.friendlyMessage(topicError))
      void refreshProfile()
    }
  }

  const togglePersonalization = async (on: boolean) => {
    setProfile(p => (p ? { ...p, personalization: on } : p))
    try {
      await db.pulsePrefsSet(on)
      db.pulseEventLog('topic_interest_updated', 'pref', null, { personalization: on })
      notify(on ? 'Personalization is on.' : 'Personalization is off — every feature stays, the order is just neutral.')
    } catch (prefError) {
      notify(db.friendlyMessage(prefError))
      void refreshProfile()
    }
  }

  const resetProfile = async () => {
    try {
      await db.pulseProfileReset()
      setProfile(p => (p ? { ...p, interests: {}, explicit: {} } : p))
      db.pulseEventLog('topic_interest_updated', 'reset', null)
      notify('Your interest profile was cleared.')
    } catch (resetError) {
      notify(db.friendlyMessage(resetError))
    }
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

  /* deck rendering pieces */
  const deckRemaining = deckPos === null ? statements.length : Math.max(0, statements.length - deckPos)
  const topCard = deckPos !== null ? statements[deckPos] : undefined
  const nextCard = deckPos !== null ? statements[deckPos + 1] : undefined
  const reactedCards = statements.filter(s => s.my !== null)
  const topTransform: CSSProperties | undefined = (() => {
    if (flying && topCard && flying.id === topCard.id) return undefined   // CSS animation class drives it
    if (drag && topCard && drag.id === topCard.id) {
      return { transform: `translateX(${drag.dx}px) rotate(${drag.dx * 0.02}deg)`, transition: 'none' }
    }
    return undefined
  })()

  return (
    <div className="pulse-page">
      <div className="pulse-head">
        <h1 className="pulse-page-title">Campus Pulse</h1>
        <button
          className="pulse-gear"
          onClick={() => setSettingsOpen(true)}
          aria-label="Your interests and personalization settings"
          title="Your interests"
        >
          <Settings size={18} />
        </button>
      </div>
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
          <div className={`pulse-card pulse-daily ${daily.status === 'closed' ? 'closed' : ''} ${justVoted ? 'confirmed' : ''}`}>
            <span className="pulse-tag">{endsLabel(daily.endsAt)}</span>
            <h3 className="pulse-question">{daily.question}</h3>
            {daily.myVote === null && daily.status !== 'closed' ? (
              <>
                <div className="pulse-options">
                  {daily.options.map((opt, i) => (
                    <button
                      key={i}
                      className="pulse-option"
                      style={{ '--i': i } as CSSProperties}
                      disabled={pending || busy}
                      onClick={() => void vote(i)}
                    >
                      <span className="pulse-option-emoji" aria-hidden="true">{opt.emoji}</span>
                      <span>{opt.label}</span>
                    </button>
                  ))}
                </div>
                <p className="pulse-quiet pulse-daily-meta">
                  {daily.responsesTotal} response{daily.responsesTotal === 1 ? '' : 's'} so far
                  {daily.responsesTotal < daily.minSample && ` · results unlock at ${daily.minSample}`}
                </p>
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
          : sectionErrors.deck ? (
            <div className="pulse-card pulse-empty-card small">
              <p>The statement deck could not load right now.</p>
              <p className="pulse-quiet">{sectionErrors.deck}</p>
            </div>
          ) : statements.length === 0
            ? <div className="pulse-card pulse-empty-card small"><p>The statement deck is growing — come back tomorrow for a fresh set.</p></div>
            : (
              <>
                {deckRemaining > 0 && topCard ? (
                  <div className="pulse-deck2" aria-label={`Statement deck — ${deckRemaining} of ${statements.length} left today`}>
                    {nextCard && (
                      <article key={nextCard.id} className="pulse-card pulse-statement pulse-deck-under" aria-hidden="true">
                        <p className="pulse-statement-text">“{nextCard.text}”</p>
                      </article>
                    )}
                    <article
                      key={topCard.id}
                      className={[
                        'pulse-card', 'pulse-statement', 'pulse-deck-top',
                        flying?.id === topCard.id ? `fly-${flying.dir}` : '',
                        drag?.id === topCard.id ? 'dragging' : '',
                      ].filter(Boolean).join(' ')}
                      style={topTransform}
                      onPointerDown={e => onCardPointerDown(e, topCard)}
                      onPointerMove={e => onCardPointerMove(e, topCard)}
                      onPointerUp={e => onCardPointerUp(e, topCard)}
                      onPointerCancel={e => onCardPointerUp(e, topCard)}
                    >
                      <span className="pulse-deck-count">{deckRemaining} of {statements.length}</span>
                      <p className="pulse-statement-text">“{topCard.text}”</p>
                      <p className="pulse-statement-hint" aria-hidden="true">swipe → same · ← not me</p>
                      <div className="pulse-reactions">
                        {PULSE_REACTIONS.map((r, i) => (
                          <button
                            key={i}
                            className={`pulse-reaction big ${topCard.my === i ? 'mine' : ''}`}
                            onClick={() => deckReact(topCard, i, i === 0 ? 'right' : i === 2 ? 'left' : 'tap')}
                            aria-pressed={topCard.my === i}
                          >
                            <span aria-hidden="true">{r.emoji}</span>
                            <span className="pulse-reaction-count">{topCard.counts[i] ?? 0}</span>
                            <span className="sr-only">{r.label}</span>
                          </button>
                        ))}
                        <button
                          className="pulse-report"
                          onClick={() => setReportTarget({ statementId: topCard.id, text: topCard.text })}
                          aria-label="Report this statement"
                        >
                          <Flag size={15} />
                        </button>
                      </div>
                    </article>
                  </div>
                ) : (
                  <div className="pulse-card pulse-empty-card small pulse-deck-done">
                    <p><b>That's today's deck.</b></p>
                    <p className="pulse-quiet">A fresh set arrives tomorrow — same energy, new statements.</p>
                  </div>
                )}
                {reactedCards.length > 0 && (
                  <div className="pulse-recap">
                    <p className="pulse-recap-title">Your takes today</p>
                    {reactedCards.map(card => (
                      <article key={card.id} className="pulse-card pulse-statement compact">
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
                  </div>
                )}
                <p className="pulse-deck-note">A fresh deck every day — said by no one, felt by everyone. Reaction counts are anonymous.</p>
              </>
            )}
      </section>

      {/* ---------------- Campus Personality ---------------- */}
      <section className="pulse-section" aria-label="Campus Personality">
        <h2 className="pulse-kicker"><Trophy size={15}/> Campus Personality</h2>
        {activeQuiz ? (
          <div className="pulse-card pulse-quiz" ref={quizCardRef}>
            <div className="pulse-quiz-progress" role="progressbar" aria-valuemin={1} aria-valuemax={activeQuiz.quiz.questions.length} aria-valuenow={activeQuiz.step + 1}>
              <span style={{ width: `${((activeQuiz.step + 1) / activeQuiz.quiz.questions.length) * 100}%` }} />
            </div>
            <p className="pulse-quiz-step">{activeQuiz.step + 1} / {activeQuiz.quiz.questions.length}</p>
            <div className="pulse-quiz-stepwrap" key={activeQuiz.step}>
              <h3 className="pulse-question">{activeQuiz.quiz.questions[activeQuiz.step].prompt}</h3>
              <div className="pulse-options">
                {activeQuiz.quiz.questions[activeQuiz.step].options.map((opt, i) => (
                  <button key={i} className="pulse-option" style={{ '--i': i } as CSSProperties} disabled={busy} onClick={() => answerQuestion(i)}>
                    <span>{opt.text}</span>
                  </button>
                ))}
              </div>
            </div>
            <button className="pulse-skip" onClick={() => setActiveQuiz(null)}>Quit for now — no result is saved midway</button>
          </div>
        ) : outcome ? (
          (() => {
            const theme = topicTheme(outcome.quiz.category)
            return (
              <div className="pulse-card pulse-quiz-result" ref={resultCardRef} style={{ '--pt-ring': theme.ring } as CSSProperties}>
                <div className="pulse-result-hero" style={{ background: theme.grad }}>
                  <span className="pulse-result-emoji" aria-hidden="true">{outcome.emoji}</span>
                  <p className="pulse-result-label">{outcome.label}</p>
                </div>
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
                {feedbackGiven !== outcome.quiz.id ? (
                  <div className="pulse-feedback" role="group" aria-label="Was this quiz interesting?">
                    <span className="pulse-quiet">More like this?</span>
                    <button className="pulse-feedback-btn" onClick={() => void sendResultFeedback('like')} aria-label="More like this">👍</button>
                    <button className="pulse-feedback-btn" onClick={() => void sendResultFeedback('dislike')} aria-label="Less like this">👎</button>
                  </div>
                ) : (
                  <p className="pulse-quiet pulse-feedback-noted">Noted — thanks for steering your recommendations.</p>
                )}
                <p className="pulse-quiz-fineprint">Entertainment only, ever — results are deterministic, never a psychology read.</p>
              </div>
            )
          })()
        ) : loading ? (
          <div className="pulse-deck">{[0, 1].map(i => <span key={i} className="pulse-skel" style={{ width: '100%', height: 84 }} />)}</div>
        ) : sectionErrors.quizzes ? (
          <div className="pulse-card pulse-empty-card small">
            <p>Quizzes could not load right now.</p>
            <p className="pulse-quiet">{sectionErrors.quizzes}</p>
          </div>
        ) : quizzes.length === 0 ? (
          <div className="pulse-card pulse-empty-card small"><p>No quizzes yet — the first one is being authored.</p></div>
        ) : (
          <div className="pulse-quiz-grid">
            {ranked.map(rq => {
              const quiz = quizById.get(rq.id)
              if (!quiz) return null
              const attempt = myAttemptsByQuiz.get(`${quiz.id}:${quiz.version}`)
              const earnedLabel = attempt ? (quiz.results.find(r => r.resultKey === attempt.resultKey)?.label ?? null) : null
              const theme = topicTheme(quiz.category)
              const meta = topicMeta(quiz.category)
              return (
                <button
                  key={quiz.id}
                  className="pulse-quiz-tile2"
                  style={{ '--pt-ring': theme.ring } as CSSProperties}
                  onClick={() => startQuiz(quiz)}
                >
                  <span className="pulse-quiz-cover" style={{ background: theme.grad }}>
                    <span className="pulse-quiz-cover-emoji" aria-hidden="true">{meta.emoji}</span>
                    {rq.pickedForYou && <span className="pulse-quiz-picked">✦ Picked for you</span>}
                  </span>
                  <span className="pulse-quiz-title">{quiz.title}</span>
                  <span className="pulse-quiz-meta">
                    {meta.label} · {quiz.questions.length} questions · {quizDurationLabel(quiz.questions.length)}
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
          : sectionErrors.insights ? (
            <div className="pulse-card pulse-empty-card small">
              <p>Insights could not load right now.</p>
              <p className="pulse-quiet">{sectionErrors.insights}</p>
            </div>
          ) : insights.length === 0 ? (
            <div className="pulse-card pulse-empty-card small">
              <p>No insights yet this week.</p>
              <p className="pulse-quiet">Insights appear once enough of your campus takes part — nothing is estimated or invented.</p>
            </div>
          ) : (
            <div className="pulse-insights">
              {insights.map((ins, i) => {
                const view = formatInsight(ins as unknown as Record<string, unknown>)
                if (!view) return null   // non-whitelisted server keys render nothing — never invented copy
                const sampleP = view.min > 0 ? Math.max(0, Math.min(1, view.sample / view.min)) : 1
                return (
                  <article key={`${ins.key}:${i}`} className="pulse-card pulse-insight" style={{ '--i': i } as CSSProperties}>
                    <span className="pulse-insight-icon" aria-hidden="true">{view.icon}</span>
                    <div className="pulse-insight-main">
                      <p className="pulse-insight-title">{view.title}</p>
                      <p className="pulse-insight-body">{view.body}</p>
                      <div className="pulse-insight-sample" aria-hidden="true">
                        <span style={{ width: `${sampleP * 100}%` }} />
                      </div>
                      <p className="pulse-quiet pulse-insight-samplenote">
                        based on {view.sample} students{view.sample >= view.min ? '' : ` · ${view.min} needed`}
                      </p>
                      {view.explain && (
                        <details
                          className="pulse-insight-explain"
                          onToggle={e => { if ((e.target as HTMLDetailsElement).open) db.pulseEventLog('insight_opened', 'insight', null, { key: ins.key }) }}
                        >
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

      {settingsOpen && (
        <SettingsSheet
          profile={profile}
          busy={pending || busy}
          onClose={() => setSettingsOpen(false)}
          onCycleTopic={t => void cycleTopic(t)}
          onTogglePersonalization={on => void togglePersonalization(on)}
          onReset={() => void resetProfile()}
        />
      )}

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
