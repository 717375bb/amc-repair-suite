import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { BrowserRouter } from 'react-router-dom'
import './index.css'
import App from './App.tsx'
import { ThemeProvider } from './lib/theme.tsx'
import { SidebarProvider } from './lib/sidebar.tsx'
import { AuthProvider } from './lib/authContext.tsx'

// CLAUDE_CODE_PROMPT (#6, login/account system) — ExecuteRunProvider moved
// out of here and into App.tsx's authenticated route group. It used to
// live at the app root, wrapping every route including /login — its
// one-shot, ref-guarded "re-attach to an already-running job" effect only
// ever fires on its OWN first mount, never retries, and with login now
// always gating the very first page load, that first mount was always
// anonymous (401, silently swallowed) — permanently losing the reconnect
// feature for the rest of the session. Mounting it fresh only once
// authenticated fixes that: its first real mount now happens exactly when
// login succeeds.
createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <ThemeProvider>
      <BrowserRouter>
        <AuthProvider>
          <SidebarProvider>
            <App />
          </SidebarProvider>
        </AuthProvider>
      </BrowserRouter>
    </ThemeProvider>
  </StrictMode>,
)
