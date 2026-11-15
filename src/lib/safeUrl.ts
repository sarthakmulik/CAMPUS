/** Only http(s) URLs may ever become navigable links.
 *
 *  The app renders member/host-entered URLs from the database (event
 *  registration / map / online links, community resource links). A
 *  `javascript:`, `data:` or `vbscript:` value that reached an href — or
 *  window.open — would execute script inside the app origin, where the
 *  Supabase session (and its tokens) live. This returns the URL only when
 *  it parses with an http/https scheme; anything else returns null and the
 *  caller simply doesn't render the link.
 *
 *  The database enforces the same rule for new writes (migration 0069
 *  check constraints); this guard covers rows written before that and is
 *  the only line of defense at render time. */
export function safeHttpUrl(raw: string | null | undefined): string | null {
  if (!raw) return null
  try {
    const url = new URL(raw.trim())
    return url.protocol === 'http:' || url.protocol === 'https:' ? url.toString() : null
  } catch {
    return null
  }
}
