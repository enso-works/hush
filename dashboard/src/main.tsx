import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'

import './index.css'
import { App } from './App'
import { detectDemo } from './lib/api'
import { PrefsProvider, SessionProvider } from './lib/session'
import { ThemeProvider } from './lib/theme'

// Is this a demo? It answers /admin without a token. Asked once, before the
// first render, so a demo never flashes the sign-in page.
detectDemo().then((demo) => {
  createRoot(document.getElementById('root')!).render(
    <StrictMode>
      <ThemeProvider>
        <SessionProvider demo={demo}>
          <PrefsProvider>
            <App />
          </PrefsProvider>
        </SessionProvider>
      </ThemeProvider>
    </StrictMode>,
  )
})
