import { useEffect, useMemo, useState } from 'react'
import {
  AlertCircle, Bell, BellOff, CheckCircle2, Clock, Loader2, Mail, MessageSquare,
  Settings2, Smartphone, Users, X,
} from 'lucide-react'
import * as db from '../lib/db'
import type { NotificationPrefs } from '../lib/db'
import {
  currentPermission, disablePush, enablePush, pushConfigured, pushSupported,
} from '../lib/webPush'

type Props = {
  open: boolean
  onClose: () => void
  notify: (message: string) => void
  userId: string
}

type PushStatus = 'idle' | 'busy' | 'granted' | 'denied' | 'unsupported' | 'no-key' | 'error'

/** The categories the sheet exposes, in a stable order. */
const CATEGORY_KEYS = [
  'like', 'comment', 'follow', 'mention', 'message',
  'community', 'event', 'marketplace',
] as const

const CATEGORY_LABEL: Record<(typeof CATEGORY_KEYS)[number], string> = {
  like: 'Likes & reposts',
  comment: 'Comments & replies',
  follow: 'New followers',
  mention: 'Mentions',
  message: 'Direct messages',
  community: 'Community activity',
  event: 'Events',
  marketplace: 'Marketplace',
}

/**
 * Notification settings: per-category in-app + browser-push controls,
 * message previews, timezone-aware quiet hours and the push device list.
 * Every toggle persists immediately so the NEXT event is already routed
 * by the new preference (the SQL trigger reads this table, not the UI).
 */
export default function NotificationSettings({ open, onClose, notify, userId }: Props) {
  const [prefs, setPrefs] = useState<NotificationPrefs | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [savingKey, setSavingKey] = useState<string | null>(null)
  const [pushStatus, setPushStatus] = useState<PushStatus>('idle')
  const [devices, setDevices] = useState<db.PushSubscriptionRecord[]>([])
  const [devicesLoading, setDevicesLoading] = useState(false)

  useEffect(() => {
    if (!open) return
    setLoading(true)
    setError(null)
    db.fetchNotificationPrefs()
      .then(setPrefs)
      .catch(err => setError(err instanceof Error ? err.message : 'Could not load your settings.'))
      .finally(() => setLoading(false))
    setPushStatus(
      !pushSupported()
        ? 'unsupported'
        : !pushConfigured()
          ? 'no-key'
          : currentPermission() === 'granted' ? 'idle' : 'idle',
    )
  }, [open])

  const refreshDevices = useMemo(() => () => {
    setDevicesLoading(true)
    db.fetchPushSubscriptions()
      .then(rows => setDevices(rows))
      .catch(() => setDevices([]))
      .finally(() => setDevicesLoading(false))
  }, [])

  /** device timezone hint for the quiet-hours input — has to sit BEFORE the
      early return below, or opening the sheet changes the hook order */
  const localTime = useMemo(() => {
    try {
      return Intl.DateTimeFormat().resolvedOptions().timeZone ?? ''
    } catch {
      return ''
    }
  }, [])

  useEffect(() => {
    if (open && currentPermission() === 'granted') refreshDevices()
  }, [open, refreshDevices])

  if (!open) return null

  /** optimistic toggle, persisted by the validated RPC, rolled back on failure.
      stateKey updates the camelCase state the UI reads; serverKey drives the RPC. */
  const save = async (stateKey: keyof NotificationPrefs, serverKey: string, value: boolean | string | null) => {
    const before = prefs
    if (!prefs || !serverKey) return
    setSavingKey(serverKey)
    setPrefs({ ...prefs, [stateKey]: value } as NotificationPrefs)
    try {
      await db.saveNotificationPrefs({ [serverKey]: value })
    } catch (err) {
      if (before) setPrefs(before)
      notify(err instanceof Error ? err.message : 'Could not save that setting. Try again.')
    } finally {
      setSavingKey(null)
    }
  }

  const update = (key: keyof NotificationPrefs, value: boolean | string | null) => {
    const map: Record<string, string> = {
      likeInapp: 'like_inapp', likePush: 'like_push',
      commentInapp: 'comment_inapp', commentPush: 'comment_push',
      followInapp: 'follow_inapp', followPush: 'follow_push',
      mentionInapp: 'mention_inapp', mentionPush: 'mention_push',
      messageInapp: 'message_inapp', messagePush: 'message_push',
      communityInapp: 'community_inapp', communityPush: 'community_push',
      eventInapp: 'event_inapp', eventPush: 'event_push',
      marketplaceInapp: 'marketplace_inapp', marketplacePush: 'marketplace_push',
      messagePreview: 'message_preview', quietEnabled: 'quiet_enabled',
      quietStart: 'quiet_start', quietEnd: 'quiet_end', timezone: 'timezone',
    }
    if (map[key] === undefined) return
    void save(key, map[key]!, value)
  }

  const togglePref = (stateKey: keyof NotificationPrefs, serverKey: string) => {
    if (!prefs) return
    const value = !prefs[stateKey]
    void save(stateKey, serverKey, value)
  }

  const enableBrowserPush = async () => {
    setPushStatus('busy')
    const result = await enablePush(userId)
    if (result === 'granted') {
      setPushStatus('granted')
      refreshDevices()
      notify('Browser notifications are on for your enabled categories.')
    } else {
      setPushStatus(result)
      if (result === 'denied') {
        notify('Your browser blocked notifications — you can change that in browser settings anytime.')
      } else if (result === 'error') {
        notify('Could not finish setting up browser notifications. Try again in a moment.')
      }
    }
  }

  const turnOffBrowserPush = async () => {
    setPushStatus('busy')
    await disablePush()
    setPushStatus('idle')
    setDevices([])
    notify('Browser notifications are off on this device.')
  }

  const pushEnabledLabel =
    !pushConfigured()
      ? 'Push is not configured on this deployment yet'
      : currentPermission() === 'denied'
        ? 'Blocked in browser settings'
        : currentPermission() === 'granted'
          ? 'Enabled on this device'
          : 'Off on this device'

  return (
    <div className="overlay" onMouseDown={event => { if (event.target === event.currentTarget) onClose() }}>
      <section className="bottom-sheet nc-settings" role="dialog" aria-label="Notification settings">
        <div className="sheet-handle"/>
        <div className="sheet-heading">
          <div>
            <span className="eyebrow">DELIVERY CONTROLS</span>
            <h2>Notification settings</h2>
          </div>
          <button className="icon-button" onClick={onClose} aria-label="Close settings"><X size={20}/></button>
        </div>

        <div className="nc-settings-scroll">
          {loading && <p className="empty-state"><Loader2 size={16} className="spin"/> Loading your preferences…</p>}
          {error && (
            <p className="form-error" role="alert">
              <AlertCircle size={15}/> {error}
              <button className="linklike" onClick={() => { setError(null); setLoading(true); db.fetchNotificationPrefs().then(setPrefs).catch(e2 => setError(e2.message)).finally(() => setLoading(false)) }}>Retry</button>
            </p>
          )}

          {/* browser push */}
          <section className="settings-card">
            <h2><Bell size={17}/> Browser push</h2>
            <div className="settings-row">
              <div>
                <b>{pushEnabledLabel}</b>
                <small>
                  {pushConfigured()
                    ? 'Get notified even when CAMPUS is in the background. Only your enabled categories are delivered.'
                    : 'Push delivery is not configured on this deployment (missing VAPID key). In-app notification still works fully.'}
                </small>
              </div>
              {pushConfigured() && currentPermission() !== 'denied' && (
                currentPermission() === 'granted'
                  ? (
                    <button className="secondary-button" disabled={pushStatus === 'busy'} onClick={() => void turnOffBrowserPush()}>
                      <BellOff size={15}/> Turn off
                    </button>
                  )
                  : (
                    <button className="primary-button" disabled={pushStatus === 'busy'} onClick={() => void enableBrowserPush()}>
                      {pushStatus === 'busy' ? <Loader2 size={15} className="spin"/> : <Bell size={15}/>} Enable
                    </button>
                  )
              )}
            </div>
            {currentPermission() === 'denied' && (
              <p className="settings-hint">
                {'Your browser has blocked notifications for this site. Allow them in the browser settings (lock icon in the address bar) — CAMPUS never re-prompts on its own.'}
              </p>
            )}
            {currentPermission() === 'granted' && (
              <div className="nc-devices">
                <b className="nc-devices-title"><Smartphone size={14}/> Devices on your account</b>
                {devicesLoading && <p className="settings-hint">Loading devices…</p>}
                {!devicesLoading && devices.length === 0 && <p className="settings-hint">This device is being registered…</p>}
                {devices.map((device, index) => (
                  <div className="nc-device-row" key={device.id}>
                    <span className="nc-device-name">{devices.length > 1 ? `Device ${index + 1}` : 'This device'}</span>
                    <button
                      className="linklike"
                      onClick={() => {
                        void db.removePushSubscription(device.endpoint).then(() => {
                          if (devices.length === 1) void disablePush()
                          refreshDevices()
                          notify('This device will no longer receive browser notifications.')
                        }).catch(err => notify(err instanceof Error ? err.message : 'Could not remove the device.'))
                      }}
                    >
                      Remove
                    </button>
                  </div>
                ))}
              </div>
            )}
          </section>

          {/* per-category matrix */}
          <section className="settings-card">
            <h2><Settings2 size={17}/> What you receive</h2>
            <p className="settings-hint">In-app = the bell list. Push = browser notifications. Important account notices are always delivered.</p>
            <div className="nc-cat-head" aria-hidden="true">
              <span>Category</span><span>In-app</span><span>Push</span>
            </div>
            {(prefs ? CATEGORY_KEYS : []).map(cat => {
              const serverInapp = `${cat}_inapp`
              const serverPush = `${cat}_push`
              const stateInapp = `${cat}Inapp` as keyof NotificationPrefs
              const statePush = `${cat}Push` as keyof NotificationPrefs
              return (
                <div className="settings-row nc-cat-row" key={cat}>
                  <div><b>{CATEGORY_LABEL[cat]}</b></div>
                  <button
                    className={`toggle ${prefs?.[stateInapp] ? 'on' : ''}`}
                    role="switch"
                    aria-checked={Boolean(prefs?.[stateInapp])}
                    aria-label={`${CATEGORY_LABEL[cat]} in-app`}
                    disabled={!prefs}
                    onClick={() => togglePref(stateInapp, serverInapp)}
                  ><span/></button>
                  <button
                    className={`toggle ${prefs?.[statePush] ? 'on' : ''}`}
                    role="switch"
                    aria-checked={Boolean(prefs?.[statePush])}
                    aria-label={`${CATEGORY_LABEL[cat]} push`}
                    disabled={!prefs}
                    onClick={() => togglePref(statePush, serverPush)}
                  ><span/></button>
                </div>
              )
            })}
            {!prefs && !loading && <p className="settings-hint">Preferences unavailable — try again.</p>}
          </section>

          {/* message preview + quiet hours */}
          <section className="settings-card">
            <h2><MessageSquare size={17}/> Messages</h2>
            <div className="settings-row">
              <div>
                <b>Show message previews</b>
                <small>Show the latest message text in notifications. Off keeps conversations private.</small>
              </div>
              <button
                className={`toggle ${prefs?.messagePreview ? 'on' : ''}`}
                role="switch"
                aria-checked={Boolean(prefs?.messagePreview)}
                aria-label="Message previews"
                disabled={!prefs}
                onClick={() => update('messagePreview', !prefs?.messagePreview)}
              ><span/></button>
            </div>
          </section>

          <section className="settings-card">
            <h2><Clock size={17}/> Quiet hours</h2>
            <div className="settings-row">
              <div>
                <b>Pause pushes overnight</b>
                <small>Applied on the server in your timezone — in-app notifications always keep flowing.</small>
              </div>
              <button
                className={`toggle ${prefs?.quietEnabled ? 'on' : ''}`}
                role="switch"
                aria-checked={Boolean(prefs?.quietEnabled)}
                aria-label="Quiet hours"
                disabled={!prefs}
                onClick={() => {
                  const next = !prefs?.quietEnabled
                  update('quietEnabled', next)
                  if (next && localTime && prefs?.timezone == null) update('timezone', localTime)
                }}
              ><span/></button>
            </div>
            {prefs?.quietEnabled && (
              <>
                <div className="nc-quiet-times">
                  <label>
                    <span>From</span>
                    <input
                      type="time"
                      value={prefs.quietStart}
                      onChange={event => { if (/^\d{2}:\d{2}$/.test(event.target.value)) update('quietStart', event.target.value) }}
                    />
                  </label>
                  <label>
                    <span>Until</span>
                    <input
                      type="time"
                      value={prefs.quietEnd}
                      onChange={event => { if (/^\d{2}:\d{2}$/.test(event.target.value)) update('quietEnd', event.target.value) }}
                    />
                  </label>
                </div>
                <label className="nc-tz-row">
                  <span>Timezone</span>
                  <input
                    type="text"
                    value={prefs.timezone ?? ''}
                    placeholder={localTime || 'e.g. Asia/Kolkata'}
                    onChange={event => {
                      const next = event.target.value
                      setPrefs({ ...prefs, timezone: next === '' ? null : next })
                    }}
                    onBlur={event => {
                      const next = event.target.value.trim()
                      update('timezone', next === '' ? null : next)
                    }}
                  />
                </label>
                <p className="settings-hint">Your device suggests <b>{localTime || 'no timezone'}</b>. Enter any valid IANA name (e.g. Asia/Kolkata). Quiet start can cross midnight.</p>
              </>
            )}
          </section>

          <section className="settings-card">
            <h2><Users size={17}/> Always-on notices</h2>
            <p className="settings-hint">Account security and important moderation notices are always delivered — they cannot be switched off because they protect the account itself.</p>
            <p className="settings-hint nc-dead-zone"><CheckCircle2 size={14} className="nc-dead-zone-icon"/> This app has no email delivery infrastructure, so no email notifications exist yet.</p>
            <p className="settings-hint nc-dead-zone"><Mail size={14}/> Muting someone (profile menu) silences their in-app activity immediately, and every conversation has its own mute switch in Chats.</p>
          </section>
        </div>
      </section>
    </div>
  )
}
