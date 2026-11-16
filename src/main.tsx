import React from 'react'
import ReactDOM from 'react-dom/client'
import App from './App'
import { isNativeApp } from './platform/platform'
import './styles.tokens.css'
import './styles.css'
import './styles.onboarding.css'
import './styles.ads.css'
import './styles.staff.css'
import './styles.ui4.css'
// Desktop layout layer: every rule is inside @media (min-width: 651px), so it
// loads last (wins the cascade) and cannot reach the mobile breakpoint.
import './styles.desktop.css'
// Search & Discovery page + the dropdown affordances it needs. Last, so its
// new .disc-*/.search-* rules win; it declares no max-width queries, so the
// phone keeps exactly the layout it had.
import './styles.search.css'
// Native-inset bridge: --safe-inset-* = max(env(), native measurement) for
// every rule below that reads safe-area spacing (Android env() can lie).
import './styles.safe-insets.css'

// Native app feel: inside the Capacitor WebView, long-press must not start
// text selection or the copy callout — selecting paragraphs like a website
// reads as a web page, not an app. The html.native-app class scopes the
// user-select/callout kill (styles.css); inputs keep selection for typing.
// Copying a message stays available through the bubble's ⋮ Copy action.
if (isNativeApp) document.documentElement.classList.add('native-app')

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode><App /></React.StrictMode>,
)