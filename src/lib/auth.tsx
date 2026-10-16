import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from 'react'
import { supabase, isSupabaseConfigured } from './supabase'
import * as db from './db'

/**
 * CAMPUS account state.
 *
 * Three account states, matching the product model:
 *   visitor     — unauthenticated, read-only access to permitted public content
 *   onboarding  — signed in, profile not finished yet (multi-step wizard)
 *   member      — signed in, onboarding complete, full social features
 *
 * There is deliberately no "verified student" state: college affiliation on
 * CAMPUS is self-declared and never treated as proof of enrolment.
 */

export type AuthUser = { id: string; email?: string }
export type AccountStatus = 'loading' | 'visitor' | 'onboarding' | 'member'
export type GateInfo = { reason: string; returnTo?: string } | null

const EXPLORE_KEY = 'campus.explored'
const LOCAL_ONBOARDING_KEY = 'campus.onboarding'

type LocalOnboarding = { step: number; done: boolean }

function readLocalOnboarding(): LocalOnboarding {
  try {
    const raw = window.localStorage.getItem(LOCAL_ONBOARDING_KEY)
    if (raw) {
      const parsed = JSON.parse(raw) as Partial<LocalOnboarding>
      return { step: Number(parsed.step) || 0, done: Boolean(parsed.done) }
    }
  } catch {
    /* storage blocked: fall through */
  }
  return { step: 0, done: false }
}

function writeLocalOnboarding(next: LocalOnboarding): void {
  try {
    window.localStorage.setItem(LOCAL_ONBOARDING_KEY, JSON.stringify(next))
  } catch {
    /* storage blocked */
  }
}

export function hasSeenWelcome(): boolean {
  try {
    return window.localStorage.getItem(EXPLORE_KEY) === '1'
  } catch {
    return false
  }
}

export function markWelcomeSeen(): void {
  try {
    window.localStorage.setItem(EXPLORE_KEY, '1')
  } catch {
    /* storage blocked */
  }
}

type AuthValue = {
  configured: boolean
  booting: boolean
  user: AuthUser | null
  profile: db.Profile | null
  profileError: string | null
  status: AccountStatus
  step: number
  caps: db.Caps
  colleges: db.College[]
  topics: db.Topic[]
  clubs: db.Club[]
  notice: string
  notify: (message: string) => void
  gateInfo: GateInfo
  requireAuth: (reason: string, returnTo?: string) => boolean
  closeGate: () => void
  signIn: (email: string, password: string) => Promise<string | null>
  signUp: (email: string, password: string) => Promise<{ error: string | null; needsConfirmation: boolean }>
  signOut: () => Promise<void>
  resetPassword: (email: string) => Promise<string | null>
  patchProfile: (patch: db.ProfilePatch) => Promise<string | null>
  setStep: (step: number) => void
  reloadProfile: () => Promise<void>
  refreshDirectory: () => Promise<void>
}

const AuthContext = createContext<AuthValue | null>(null)

export function useAuth(): AuthValue {
  const value = useContext(AuthContext)
  if (!value) throw new Error('useAuth must be used inside <AuthProvider>.')
  return value
}

export function AuthProvider({ children }: { children: ReactNode }) {
  const [booting, setBooting] = useState(true)
  const [user, setUser] = useState<AuthUser | null>(null)
  const [profile, setProfile] = useState<db.Profile | null>(null)
  const [profileError, setProfileError] = useState<string | null>(null)
  const [status, setStatus] = useState<AccountStatus>('loading')
  const [step, setStepState] = useState(0)
  const [caps, setCaps] = useState<db.Caps>(db.EMPTY_CAPS)
  const [colleges, setColleges] = useState<db.College[]>([])
  const [topics, setTopics] = useState<db.Topic[]>([])
  const [clubs, setClubs] = useState<db.Club[]>([])
  const [notice, setNotice] = useState('')
  const [gateInfo, setGateInfo] = useState<GateInfo>(null)

  const notify = useCallback((message: string) => {
    setNotice(message)
    window.setTimeout(() => setNotice(current => (current === message ? '' : current)), 3600)
  }, [])

  const refreshDirectory = useCallback(async () => {
    if (!supabase) return
    const results = await Promise.allSettled([db.loadColleges(), db.loadTopics(), db.loadClubs()])
    if (results[0].status === 'fulfilled') setColleges(results[0].value)
    if (results[1].status === 'fulfilled') setTopics(results[1].value)
    if (results[2].status === 'fulfilled') setClubs(results[2].value)
  }, [])

  const computeStatus = useCallback((row: db.Profile | null, currentCaps: db.Caps): AccountStatus => {
    const local = readLocalOnboarding()
    // Without the migration columns the completion flag only lives on this
    // device, so a cleared/new device would replay the wizard. Fall back to
    // "this profile already declared its identity" (username + college).
    const identityReady = Boolean(row?.username && row?.college_id)
    const done = row?.onboarding_completed_at != null
      || (!currentCaps.profileExtras && (local.done || identityReady))
    const nextStep = currentCaps.profileExtras ? Number(row?.onboarding_step ?? 0) : local.step
    setStepState(nextStep)
    return done ? 'member' : 'onboarding'
  }, [])

  const loadMember = useCallback(
    async (nextUser: AuthUser) => {
      setProfileError(null)
      let nextCaps = db.EMPTY_CAPS
      try {
        nextCaps = await db.probeCaps()
        setCaps(nextCaps)
      } catch {
        setCaps(db.EMPTY_CAPS)
      }
      void refreshDirectory()
      try {
        const row = await db.ensureProfile(nextUser)
        setProfile(row)
        setStatus(computeStatus(row, nextCaps))
      } catch (error) {
        setProfile(null)
        setProfileError(db.friendlyMessage(error))
        setStatus('onboarding')
      }
    },
    [computeStatus, refreshDirectory],
  )

  useEffect(() => {
    let cancelled = false

    const boot = async () => {
      if (!supabase) {
        setStatus('visitor')
        setBooting(false)
        return
      }
      // Support the email confirmation redirect (?code=... PKCE flow).
      try {
        const params = new URLSearchParams(window.location.search)
        const code = params.get('code')
        if (code) {
          await supabase.auth.exchangeCodeForSession(code)
          window.history.replaceState({}, document.title, window.location.pathname)
        }
      } catch {
        /* link may already have been used */
      }

      const { data } = await supabase.auth.getSession()
      if (cancelled) return
      const sessionUser = data.session?.user
        ? { id: data.session.user.id, email: data.session.user.email }
        : null
      setUser(sessionUser)
      if (sessionUser) {
        await loadMember(sessionUser)
      } else {
        setStatus('visitor')
      }
      if (!cancelled) setBooting(false)
    }

    void boot()

    const listener = supabase?.auth.onAuthStateChange((_event, session) => {
      const nextUser = session?.user ? { id: session.user.id, email: session.user.email } : null
      setUser(nextUser)
      if (nextUser) {
        void loadMember(nextUser)
      } else {
        setProfile(null)
        setStatus('visitor')
      }
    })

    return () => {
      cancelled = true
      listener?.data.subscription.unsubscribe()
    }
  }, [loadMember])

  const signIn = useCallback(async (email: string, password: string): Promise<string | null> => {
    if (!supabase) return 'CAMPUS is not connected. Add your Supabase URL and anon key to .env first.'
    if (!email.trim() || !password) return 'Enter your email and password.'
    const { error } = await supabase.auth.signInWithPassword({ email: email.trim(), password })
    return error ? db.friendlyMessage(error) : null
  }, [])

  const signUp = useCallback(
    async (email: string, password: string): Promise<{ error: string | null; needsConfirmation: boolean }> => {
      if (!supabase) return { error: 'CAMPUS is not connected. Add your Supabase URL and anon key to .env first.', needsConfirmation: false }
      if (!email.trim()) return { error: 'Enter your college or personal email address.', needsConfirmation: false }
      if (password.length < 8) return { error: 'Use a password with at least 8 characters.', needsConfirmation: false }
      const { data, error } = await supabase.auth.signUp({ email: email.trim(), password })
      if (error) return { error: db.friendlyMessage(error), needsConfirmation: false }
      // No session means the project requires email confirmation.
      return { error: null, needsConfirmation: !data.session }
    },
    [],
  )

  const signOut = useCallback(async () => {
    if (supabase) await supabase.auth.signOut()
    setUser(null)
    setProfile(null)
    setCaps(db.EMPTY_CAPS)
    setGateInfo(null)
    setStatus('visitor')
  }, [])

  const resetPassword = useCallback(async (email: string): Promise<string | null> => {
    if (!supabase) return 'CAMPUS is not connected.'
    if (!email.trim()) return 'Enter your email address first.'
    const { error } = await supabase.auth.resetPasswordForEmail(email.trim(), {
      redirectTo: window.location.origin,
    })
    return error ? db.friendlyMessage(error) : null
  }, [])

  const patchProfile = useCallback(
    async (patch: db.ProfilePatch): Promise<string | null> => {
      if (!user) return 'Sign in to save changes.'
      try {
        await db.saveProfile(user.id, patch, caps)
        const merged = profile ? ({ ...profile, ...patch } as db.Profile) : null
        if (merged) setProfile(merged)
        // Profile changes can change the account state itself — finishing
        // onboarding must move the member from the wizard into the app.
        setStatus(computeStatus(merged, caps))
        if (patch.onboarding_step !== undefined) {
          const local = readLocalOnboarding()
          writeLocalOnboarding({ step: patch.onboarding_step, done: local.done })
          setStepState(patch.onboarding_step)
        }
        if (patch.onboarding_completed_at) writeLocalOnboarding({ step: 6, done: true })
        return null
      } catch (error) {
        return db.friendlyMessage(error)
      }
    },
    [user, caps, profile, computeStatus],
  )

  const setStep = useCallback(
    (next: number) => {
      setStepState(next)
      const local = readLocalOnboarding()
      writeLocalOnboarding({ step: next, done: local.done })
      if (user && caps.profileExtras) void db.saveProfile(user.id, { onboarding_step: next }, caps).catch(() => undefined)
    },
    [user, caps],
  )

  const reloadProfile = useCallback(async () => {
    if (!user) return
    try {
      const row = await db.fetchProfile(user.id)
      setProfile(row)
      setProfileError(null)
      setStatus(computeStatus(row, caps))
    } catch (error) {
      setProfileError(db.friendlyMessage(error))
    }
  }, [user, caps, computeStatus])

  const requireAuth = useCallback(
    (reason: string, returnTo?: string): boolean => {
      if (status === 'member') return true
      setGateInfo({ reason, returnTo })
      return false
    },
    [status],
  )

  const closeGate = useCallback(() => setGateInfo(null), [])

  const value = useMemo<AuthValue>(
    () => ({
      configured: isSupabaseConfigured,
      booting,
      user,
      profile,
      profileError,
      status,
      step,
      caps,
      colleges,
      topics,
      clubs,
      notice,
      notify,
      gateInfo,
      requireAuth,
      closeGate,
      signIn,
      signUp,
      signOut,
      resetPassword,
      patchProfile,
      setStep,
      reloadProfile,
      refreshDirectory,
    }),
    [
      booting, user, profile, profileError, status, step, caps, colleges, topics, clubs,
      notice, notify, gateInfo, requireAuth, closeGate, signIn, signUp, signOut,
      resetPassword, patchProfile, setStep, reloadProfile, refreshDirectory,
    ],
  )

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>
}
