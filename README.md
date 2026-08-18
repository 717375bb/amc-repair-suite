# AMC Repair Suite

Automation tooling for PSA Airlines' component repair team — infers estimated
ship dates from vendor reports, and drives real order write-ups/writes into
Maintenix (MXI) via a login-gated web app. See `CLAUDE.md` for the full,
living project reference; `security.md`/`privacy.md` for the security and
data-handling model.

## Run it with one click (GitHub Codespaces)

[![Open in GitHub Codespaces](https://github.com/codespaces/badge.svg)](https://codespaces.new/717375bb/amc-repair-suite?quickstart=1)

1. **Before clicking**, optionally set `ANTHROPIC_API_KEY` as a Codespaces
   secret (repo Settings → Secrets and variables → Codespaces) — required
   for ESD Finder's AI classification step. Everything else works without
   any secret configured. See `docs/CODESPACES.md` for the full list of
   optional secrets and what each one affects.
2. Click the badge above and wait for the container to build (installs
   dependencies + Playwright's Chromium, a few minutes the first time).
3. Both servers start automatically and the app opens in a browser tab.
4. Create an account using your real MXI username/password — same login
   model as running this locally (see `security.md` §1.1).

Full details, secret list, and known-untested items: `docs/CODESPACES.md`.

## Running it locally instead

See the root `CLAUDE.md` ("How to run this for a normal week") and
`backend/README.md` for the local, terminal-based setup this project has
always used.

---

## Frontend scaffold (React + TypeScript + Vite)

This template provides a minimal setup to get React working in Vite with HMR and some ESLint rules.

Currently, two official plugins are available:

- [@vitejs/plugin-react](https://github.com/vitejs/vite-plugin-react/blob/main/packages/plugin-react) uses [Oxc](https://oxc.rs)
- [@vitejs/plugin-react-swc](https://github.com/vitejs/vite-plugin-react/blob/main/packages/plugin-react-swc) uses [SWC](https://swc.rs/)

## React Compiler

The React Compiler is not enabled on this template because of its impact on dev & build performances. To add it, see [this documentation](https://react.dev/learn/react-compiler/installation).

## Expanding the ESLint configuration

If you are developing a production application, we recommend updating the configuration to enable type-aware lint rules:

```js
export default defineConfig([
  globalIgnores(['dist']),
  {
    files: ['**/*.{ts,tsx}'],
    extends: [
      // Other configs...

      // Remove tseslint.configs.recommended and replace with this
      tseslint.configs.recommendedTypeChecked,
      // Alternatively, use this for stricter rules
      tseslint.configs.strictTypeChecked,
      // Optionally, add this for stylistic rules
      tseslint.configs.stylisticTypeChecked,

      // Other configs...
    ],
    languageOptions: {
      parserOptions: {
        project: ['./tsconfig.node.json', './tsconfig.app.json'],
        tsconfigRootDir: import.meta.dirname,
      },
      // other options...
    },
  },
])
```

You can also install [eslint-plugin-react-x](https://github.com/Rel1cx/eslint-react/tree/main/packages/plugins/eslint-plugin-react-x) and [eslint-plugin-react-dom](https://github.com/Rel1cx/eslint-react/tree/main/packages/plugins/eslint-plugin-react-dom) for React-specific lint rules:

```js
// eslint.config.js
import reactX from 'eslint-plugin-react-x'
import reactDom from 'eslint-plugin-react-dom'

export default defineConfig([
  globalIgnores(['dist']),
  {
    files: ['**/*.{ts,tsx}'],
    extends: [
      // Other configs...
      // Enable lint rules for React
      reactX.configs['recommended-typescript'],
      // Enable lint rules for React DOM
      reactDom.configs.recommended,
    ],
    languageOptions: {
      parserOptions: {
        project: ['./tsconfig.node.json', './tsconfig.app.json'],
        tsconfigRootDir: import.meta.dirname,
      },
      // other options...
    },
  },
])
```
