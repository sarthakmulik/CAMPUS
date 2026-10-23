import { useEffect, useMemo, useRef, useState } from 'react'
import type { SponsoredAd } from '../lib/ads'
import { CTA_LABELS, recordAdClick, recordAdImpression } from '../lib/ads'

/**
 * Sponsored feed card. Rendered as part of the home feed, styled like a
 * native CAMPUS post card but ALWAYS carrying a permanent "Sponsored" label
 * (preview and delivery alike — paid content is never disguised as organic).
 *
 * Impression = the card was ≥50% visible for ≥1 continuous second, recorded
 * once per display instance (a fresh display id is minted per mount and the
 * server dedupes on it — re-renders and re-entry in the same session cannot
 * double-count a single exposure).
 */
export function SponsoredCard({
  ad,
  onHide,
  flash,
}: {
  ad: SponsoredAd
  onHide?: () => void
  flash?: (message: string) => void
}) {
  const [hidden, setHidden] = useState(false)
  const cardRef = useRef<HTMLElement | null>(null)
  // One display instance per mount; the unique(display_id) index on the server
  // makes tracking idempotent even across retries.
  const displayId = useMemo(
    () => (globalThis.crypto?.randomUUID ? globalThis.crypto.randomUUID() : `${Date.now()}-${Math.random()}`),
    [],
  )
  const impressionRef = useRef(false)
  const visibilityRef = useRef(false)
  const dwellTimerRef = useRef<number | null>(null)

  const tryRecordImpression = () => {
    if (impressionRef.current || !visibilityRef.current) return
    impressionRef.current = true
    void recordAdImpression(ad.id, displayId)
  }

  useEffect(() => {
    const node = cardRef.current
    if (!node || typeof IntersectionObserver === 'undefined') {
      // failsafe: no observer support → don't fabricate an impression
      return
    }
    const observer = new IntersectionObserver(entries => {
      const visible = entries.some(entry => entry.isIntersecting && entry.intersectionRatio >= 0.5)
      visibilityRef.current = visible
      if (visible) {
        if (dwellTimerRef.current === null) {
          dwellTimerRef.current = window.setTimeout(() => {
            dwellTimerRef.current = null
            tryRecordImpression()
          }, 1000)
        }
      } else if (dwellTimerRef.current !== null) {
        window.clearTimeout(dwellTimerRef.current)
        dwellTimerRef.current = null
      }
    }, { threshold: [0, 0.5, 1] })
    observer.observe(node)
    return () => {
      observer.disconnect()
      if (dwellTimerRef.current !== null) window.clearTimeout(dwellTimerRef.current)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  if (hidden) return null

  const initials = ad.advertiser_name.trim().split(/\s+/).filter(Boolean).map(part => part[0]).slice(0, 2).join('').toUpperCase() || 'SP'

  const onCta = () => {
    // fire-and-forget; the anchor opens the destination in a new tab regardless
    void recordAdClick(ad.id, displayId)
  }

  return (
    <article className="post-card ad-card" ref={cardRef} data-ad-id={ad.id}>
      <div className="post-head">
        <span className="post-author-link static">
          <span className="avatar post-avatar">
            {ad.advertiser_logo_url
              ? <img src={ad.advertiser_logo_url} alt="" loading="lazy"/>
              : <span className="ad-initials">{initials}</span>}
          </span>
          <span className="post-id">
            <span className="post-namerow"><b>{ad.advertiser_name}</b></span>
            <span className="post-idline ad-sponsored-line">
              <span className="badge ad-sponsored-badge">Sponsored</span>
            </span>
          </span>
        </span>
        <button
          className="icon-button more-button"
          aria-label="Hide this sponsored post"
          onClick={() => {
            setHidden(true)
            onHide?.()
            flash?.('We will show fewer sponsored posts like this for a while.')
          }}
        >
          ✕
        </button>
      </div>
      <div className="post-content">
        <p className="post-body">{ad.headline}</p>
        {ad.creative_kind === 'image' && ad.creative_url
          ? <img className="post-media ad-media" src={ad.creative_url} alt={`${ad.advertiser_name} — ${ad.headline}`} loading="lazy"/>
          : ad.creative_kind === 'video' && ad.creative_url
            ? (
              <video
                className="post-media ad-media"
                src={ad.creative_url}
                poster={ad.creative_thumb_url ?? undefined}
                controls
                muted
                playsInline
                preload="metadata"
              />
            )
            : null}
        <p className="post-body ad-desc">{ad.description}</p>
        <a
          className="ad-cta"
          href={ad.destination_url}
          target="_blank"
          rel="noopener noreferrer sponsored"
          onClick={onCta}
        >
          {CTA_LABELS[ad.cta] ?? 'Learn more'}
        </a>
        <p className="ad-fineprint">Sponsored by {ad.advertiser_name} · Paid placement chosen by your college targeting</p>
      </div>
    </article>
  )
}

export default SponsoredCard
