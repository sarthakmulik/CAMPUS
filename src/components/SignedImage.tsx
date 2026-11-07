import type { ReactNode } from 'react'
import { useSignedMediaUrl } from '../lib/signedMedia'

/**
 * An <img> whose source resolves through the 0051 signed layer before
 * mounting: the private `media` bucket never renders its raw (inert) URL.
 * Shows `fallback` (or nothing) until the mint settles; pass-through sources
 * (public buckets) resolve instantly.
 */
export default function SignedImage({ src, alt, className, fallback, eager }: {
  src: string | null | undefined
  alt?: string
  className?: string
  fallback?: ReactNode
  /** skip below-the-fold laziness for above-the-fold hero art */
  eager?: boolean
}) {
  const media = useSignedMediaUrl(src)
  if (!media.ready || !media.url) return <>{fallback ?? null}</>
  return <img src={media.url} alt={alt ?? ''} className={className} loading={eager ? 'eager' : 'lazy'} />
}
