import { useEffect, useState } from 'react'
import { X } from 'lucide-react'
import { isNativeApp } from '../platform/platform'
import {
  appDownloadUrl, appPromptDismissed, detectMobilePlatform, dismissAppPrompt,
  type MobilePlatform,
} from '../lib/appDownload'

/**
 * A quiet, dismissible card inviting mobile-browser visitors to install the
 * native app. Renders nothing on desktop, inside the native app, when no
 * download URL is configured for the platform, or after a recent dismiss.
 * Non-modal: it never blocks the page or touches the history stack.
 */
export default function AppDownloadBanner() {
  const [target] = useState<{ platform: MobilePlatform; url: string } | null>(() => {
    if (isNativeApp) return null
    const platform = detectMobilePlatform()
    if (!platform) return null
    const url = appDownloadUrl(platform)
    if (!url || appPromptDismissed()) return null
    return { platform, url }
  })
  const [visible, setVisible] = useState(false)

  const dismiss = () => { dismissAppPrompt(); setVisible(false) }

  // let the page settle before offering — never interrupt the first paint
  useEffect(() => {
    if (!target) return
    const timer = window.setTimeout(() => setVisible(true), 2500)
    return () => window.clearTimeout(timer)
  }, [target])

  useEffect(() => {
    if (!visible) return
    const onKey = (event: KeyboardEvent) => { if (event.key === 'Escape') dismiss() }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [visible])

  if (!target || !visible) return null

  const ios = target.platform === 'ios'
  return (
    <div className="app-dl-banner" role="region" aria-label="Download the CAMPUS app">
      <img className="app-dl-icon" src="/campus-icon.png" alt="" width={44} height={44}/>
      <div className="app-dl-copy">
        <b>Get the CAMPUS app</b>
        <span>The full campus experience — faster, with push notifications.</span>
        <a
          className="primary-button app-dl-cta"
          href={target.url}
          target="_blank"
          rel="noopener noreferrer"
          onClick={dismiss}
        >
          {ios ? 'Download on the App Store' : 'Get the Android app'}
        </a>
      </div>
      <button className="icon-button app-dl-close" aria-label="Dismiss app download prompt" onClick={dismiss}>
        <X size={16}/>
      </button>
    </div>
  )
}