import React from 'react'
import ReactDOM from 'react-dom/client'
import App from './App'
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

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode><App /></React.StrictMode>,
)