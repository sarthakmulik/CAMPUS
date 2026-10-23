/* CAMPUS service worker — web-push delivery + click-through routing.
 *
 * Scope: '/' so it can show notifications for the whole app.
 * The in-app notification bell is a completely separate system; this file
 * only turns server-enqueued web pushes (push_queue → edge function) into
 * browser notifications and routes their clicks. If the SW fails, the
 * in-app record of every push already exists — nothing is lost.
 */

self.addEventListener('install', (event) => {
  self.skipWaiting()
  if (event && event.waitUntil) {
    event.waitUntil(Promise.resolve())
  }
})

self.addEventListener('activate', (event) => {
  event.waitUntil(self.clients.claim())
})

/* Allow the app (webPush.ts) to tell the SW a new version is ready. */
self.addEventListener('message', (event) => {
  if (event.data === 'CAMPUS_SKIP_WAITING') self.skipWaiting()
})

/* The browser may rotate a push subscription while no CAMPUS tab is open
 * (endpoint/key regeneration). The old registration then goes dead
 * server-side. Ask any open CAMPUS tab to re-sync; if none is open the
 * app reconciles itself the next time it starts (webPush.reconcilePush).
 */
self.addEventListener('pushsubscriptionchange', () => {
  self.clients
    .matchAll({ type: 'window', includeUncontrolled: true })
    .then((clientList) => {
      for (const client of clientList) {
        client.postMessage({ type: 'CAMPUS_RESUBSCRIBE' })
      }
    })
})

/**
 * Push payloads come from the push-deliver edge function:
 * { title, body, url, tag }
 * The title/body are built server-side in SQL for the recipient only —
 * never raw message content for private conversations the user disabled
 * previews for, never any other user's private data.
 */
self.addEventListener('push', (event) => {
  let data = {}
  try {
    data = event.data ? event.data.json() : {}
  } catch {
    data = { title: 'CAMPUS', body: event.data ? event.data.text() : 'New activity' }
  }
  // No title → malformed/empty payload: show nothing rather than junk.
  if (!data.title) return
  // timestamp = when the EVENT happened (server insert time), not when the
  // device woke up — the OS then renders the real relative age ("2 min ago").
  let ts = Date.now()
  if (data.created_at) ts = Date.parse(data.created_at)
  if (!Number.isFinite(ts)) ts = Date.now()
  const options = {
    body: data.body || '',
    icon: '/campus-icon.png',
    badge: '/campus-badge.png',
    tag: data.tag || 'campus',
    renotify: Boolean(data.tag),
    lang: 'en',
    dir: 'ltr',
    timestamp: ts,
    data: {
      url: data.url || '/#home',
      nid: data.nid || null,
      category: data.category || null,
    },
    // Android heads-up behaviour; seconds, minimum 5
    vibrate: [40, 30, 40],
  }
  event.waitUntil(
    self.registration.showNotification(String(data.title), options),
  )
})

/**
 * Click behaviour: focus an existing CAMPUS tab (if it can see the hash
 * change) or open a fresh one on the deep link. Hash routing (#p/<id>,
 * #chat/<id>, #u/<user>, #c/, #e/, #m/) keeps zero private content in
 * the URL — only opaque ids and slugs.
 */
self.addEventListener('notificationclick', (event) => {
  event.notification.close()
  const target = (event.notification.data && event.notification.data.url) || '/#home'
  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((clientList) => {
      // 1. If a CAMPUS window is already open, focus it and navigate it.
      for (const client of clientList) {
        const clientPath = new URL(client.url).pathname
        const origin = self.location.origin
        if (clientPath === '/' || clientPath === '/index.html') {
          // postMessage first: the app navigates without a reload if it can.
          client.postMessage({ type: 'CAMPUS_NAVIGATE', url: target })
          return client.focus()
        }
      }
      // 2. No window (or none usable): open a new one on the deep link.
      return self.clients.openWindow(new URL(target, self.location.origin).href)
    }),
  )
})
