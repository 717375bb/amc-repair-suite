#!/usr/bin/env bash
# Codespaces one-time container setup. See docs/CODESPACES.md for the full
# writeup of what this does and why. Idempotent: safe to re-run (e.g. a
# container rebuild) without clobbering anything the user already set.
set -euo pipefail

cd "$(dirname "$0")/.."
REPO_ROOT="$(pwd)"

echo "==> Installing frontend dependencies..."
npm install

echo "==> Installing backend dependencies..."
npm install --prefix backend

echo "==> Installing Playwright Chromium (+ system deps) for the MXI writer..."
npx --prefix backend playwright install --with-deps chromium

ENV_FILE="backend/.env"
ENV_EXAMPLE="backend/.env.example"

if [ ! -f "$ENV_FILE" ]; then
  echo "==> No backend/.env found — copying from .env.example..."
  cp "$ENV_EXAMPLE" "$ENV_FILE"
fi

# Fill in a var in backend/.env only if its current value is blank. Never
# overwrites a value the user (or a Codespaces secret reflected in here by
# hand) already set. Matches the generation method .env.example/security.md
# already document for these two vars.
fill_if_blank() {
  local key="$1"
  local current
  current="$(grep -E "^${key}=" "$ENV_FILE" | head -n1 | cut -d'=' -f2- || true)"
  if [ -z "$current" ]; then
    local value
    value="$(node -e "console.log(require('crypto').randomBytes(32).toString('hex'))")"
    if grep -qE "^${key}=" "$ENV_FILE"; then
      sed -i "s#^${key}=.*#${key}=${value}#" "$ENV_FILE"
    else
      echo "${key}=${value}" >> "$ENV_FILE"
    fi
    echo "    generated a fresh ${key} (blank before)"
  fi
}

echo "==> Filling CREDENTIAL_ENCRYPTION_KEY / AUTOMATION_API_KEY if blank..."
fill_if_blank "CREDENTIAL_ENCRYPTION_KEY"
fill_if_blank "AUTOMATION_API_KEY"

# Codespaces-only, unconditional (not fill-if-blank): MXI's Akamai edge has
# already been confirmed, via real testing in this project, to block
# headless Chromium traffic specifically (see backend/CHANGELOG.md's
# HEADLESS=false finding). backend/.env here only ever exists inside this
# container — never the user's local machine — so overriding it every
# setup run is safe and correct, unlike a local .env where a permanently
# headed run would pop an inconvenient visible browser window. Headed mode
# needs a real display, which this container doesn't have, so
# .vscode/tasks.json runs the backend under `xvfb-run` (a virtual display)
# to make headed rendering possible without one.
echo "==> Forcing HEADLESS=false for this Codespace (MXI blocks headless traffic; see docs/CODESPACES.md)..."
if grep -qE "^HEADLESS=" "$ENV_FILE"; then
  sed -i "s#^HEADLESS=.*#HEADLESS=false#" "$ENV_FILE"
else
  echo "HEADLESS=false" >> "$ENV_FILE"
fi

echo ""
echo "==> Secret status (Codespaces secrets, if configured, arrive as real"
echo "    env vars and take effect automatically — no .env edit needed):"
if [ -n "${ANTHROPIC_API_KEY:-}" ]; then
  echo "    [ok]      ANTHROPIC_API_KEY is set — ESD Finder AI classification will work."
else
  echo "    [missing] ANTHROPIC_API_KEY is NOT set — ESD Finder's AI classification step"
  echo "              will fail until you add it as a Codespaces secret and rebuild."
  echo "              Login, Order Write-Ups, and everything else still work."
fi
if [ -n "${MXI_USERNAME:-}${MXI_PASSWORD:-}" ]; then
  echo "    [ok]      MXI_USERNAME/MXI_PASSWORD set — the Power Automate shared client will log in at boot."
else
  echo "    [note]    MXI_USERNAME/MXI_PASSWORD not set — only affects the Power Automate"
  echo "              (/pending-esd-updates, /approve, /reject) endpoints, not the browser UI."
  echo "              Each analyst's own MXI login (used by Order Write-Ups / ESD Finder writes)"
  echo "              is entered through the app's own Create Account page, not this file."
fi
echo ""
echo "==> Setup complete. Both servers will start automatically."
