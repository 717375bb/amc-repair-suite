import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

// https://vite.dev/config/
export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: {
    // Binding only to localhost (Vite's default) isn't reachable through
    // GitHub Codespaces' port-forwarding path. Harmless for local dev too.
    host: true,
    proxy: {
      // CLAUDE_CODE_PROMPT (#6 fix, real bug) — the browser was calling the
      // backend directly cross-origin (this dev server on :5173, the API on
      // 127.0.0.1:3001), and the session cookie's SameSite=Lax silently
      // drops on cross-SITE fetch/XHR calls whenever the page is opened via
      // "localhost:5173" while the API is addressed as "127.0.0.1:3001" —
      // different hostnames are a different "site" for cookie purposes even
      // though both are loopback, even though CORS itself was configured
      // correctly. Confirmed live: login/register succeeded (that response
      // is what SETS the cookie), but every subsequent call (vendor list,
      // ESD file upload, etc.) silently sent no cookie at all and got a real
      // 401 "Not logged in". Proxying /api same-origin through this dev
      // server removes the cross-site relationship entirely — the browser
      // never talks to 127.0.0.1:3001 directly, so SameSite=Lax has nothing
      // to block, regardless of which loopback hostname the app is opened at.
      '/api': {
        target: 'http://127.0.0.1:3001',
        changeOrigin: true,
      },
    },
  },
})
