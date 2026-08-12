import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { BrowserRouter } from 'react-router-dom'
import './index.css'
import App from './App.tsx'
import { ThemeProvider } from './lib/theme.tsx'
import { SidebarProvider } from './lib/sidebar.tsx'
import { ExecuteRunProvider } from './lib/executeRun.tsx'

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <ThemeProvider>
      <SidebarProvider>
        <ExecuteRunProvider>
          <BrowserRouter>
            <App />
          </BrowserRouter>
        </ExecuteRunProvider>
      </SidebarProvider>
    </ThemeProvider>
  </StrictMode>,
)
