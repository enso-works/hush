import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'

import './index.css'
import { App } from './App'
import { detectAccess } from './lib/api'
import { PrefsProvider, SessionProvider } from './lib/session'
import { ThemeProvider } from './lib/theme'

// Demo, proxy or token? Asked once, before the first render, so neither a
// demo nor a dashboard its proxy signs in ever flashes the sign-in page.
detectAccess().then((access) => {
  createRoot(document.getElementById('root')!).render(
    <StrictMode>
      <ThemeProvider>
        <SessionProvider access={access}>
          <PrefsProvider>
            <App />
          </PrefsProvider>
        </SessionProvider>
      </ThemeProvider>
    </StrictMode>,
  )
})
