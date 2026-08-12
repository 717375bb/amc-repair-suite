# Architecture Findings — amc-repair-suite
_Generated 2026-07-08 via graphify graph traversal. Update this file as findings are resolved or new ones emerge._

---

## Finding 1: `.isSessionAlive()` is a TODO placeholder — session expiry is undetected

**File:** `backend/src/mxiWriter/mxiClient.ts:L118–L119`
**Severity:** Medium-High
**Status:** Resolved 2026-07-08

The graph exposed a node at L119 with the text:
> `TODO: fill in once we know what a logged-out/session-expired MXI page looks like`

`.isSessionAlive()` currently just trusts the last successful login. It has no real signal for "this page looks logged out."

**Why it matters:**
The CLAUDE.md safety guarantee is "re-auth once then halt." But that retry path only triggers when a *downstream* operation fails (e.g., `findOrderByNumber()` can't find the input field because the login page has replaced it). It does not proactively check session state before attempting a write. A timed-out session will produce a Playwright selector-not-found timeout or a cryptic wrong-page error rather than a clean "session expired, retrying" message.

**Blast radius:**
All four MXI consumers share this gap through `createReadyStageMxiClient()` in `stageClient.ts`:
- `mxiReadEsd.ts` (read-only smoke test)
- `mxiWriteEsd.ts` (CLI write tool)
- `saveStorageState.ts` (auth-state saver)
- `server.ts` `/approve` handler (via `writeEsd()`)

**Fix applied 2026-07-08:**
Exported `TODO_LIST_URL` from `selectors.ts`. `isSessionAlive()` now navigates there (10s timeout) and checks whether MXI bounced the response to `login.jsp`. Also adds a cheap URL pre-check before the navigation so an already-redirected idle page doesn't pay the round-trip cost. Verified via `npm run mxi:read-esd -- P000AG1D`: login succeeded, ESD returned correctly, session-probe navigation did not interfere.

---

## Finding 2: `MxiClient` is the session bottleneck for ALL MXI interactions

**File:** `backend/src/mxiWriter/mxiClient.ts`
**Severity:** Info / Design note
**Status:** Expected — document for future changes

`MxiClient` has the most edges in the graph (15), more than even `writeEsd()` (11). This is because it is the shared browser context for every tool that touches MXI:

```
MxiClient
  ← imports  writeEsd.ts         (write path)
  ← imports  mxiReadEsd.ts       (read smoke test)
  ← imports  mxiWriteEsd.ts      (CLI write tool)
  ← imports  saveStorageState.ts (auth saver)
  ← imports  stageClient.ts      (shared bootstrap wrapper)
  + internal methods: .initialize(), .getAuthenticatedPage(), .shutdown(),
                      .getState(), .constructor(), .isSessionAlive()
```

**Why this matters for future changes:**
Any change to auth logic (session handling, retry behavior, credential rotation) has to go through `MxiClient` / `stageClient.ts`. That's correct — one place. But it also means a bug in `MxiClient` affects all four consumers simultaneously, including the read-only path (`mxiReadEsd.ts`) which has never been accused of being risky.

**Recommendation:**
When `.isSessionAlive()` is implemented (Finding 1), test it via `mxiReadEsd.ts` first (read-only, no write risk), then verify the same behavior holds in the write path.

---

## Finding 3: `openDb()` bridges CLI pipeline and HTTP server — single shared DB handle

**File:** `backend/src/db/db.ts:L53`
**Severity:** Info / Watch for concurrency
**Status:** Open — not a current bug, but a future risk

`openDb()` has the highest betweenness centrality in the graph. It's called by both:
- The Phase 1 CLI pipeline (parsers → inference → audit write)
- The Phase 2 HTTP server (`/approve`, `/reject`, `/pending-esd-updates`)

Both paths share one SQLite file (`data/audit.db`). SQLite handles concurrent reads fine but serializes writes. If the Phase 1 CLI pipeline is mid-run (writing inference records) while the server handles an `/approve`, they will contend on the write lock.

**Current risk:** Low — the CLI is typically a one-shot run, not a daemon. But if Phase 1 is ever scheduled or long-running alongside the server, write contention will produce "database is locked" errors from `better-sqlite3`.

**Fix path if needed:** `better-sqlite3`'s synchronous API in WAL mode (`PRAGMA journal_mode=WAL`) allows concurrent reads and only serializes writers, reducing contention to near-zero for this workload.

---

## Finding 4: `writeEsd()` has exactly two callers — both require human intent

**File:** `backend/src/mxiWriter/writeEsd.ts:L24`
**Severity:** Info / Confirms safety design
**Status:** Confirmed correct

Graph traversal confirmed `writeEsd()` is imported by only two files:
1. `server.ts` — triggered by explicit `POST /esd-updates/:orderNumber/approve` with `approvedBy` field
2. `mxiWriteEsd.ts` — manual CLI invocation with order number as argument

No scheduler, loop, or automatic path reaches `writeEsd()`. The `MXI Write Safety - Human Approval Only` design principle is encoded as a rationale node with edges into both `MxiClient` and `writeEsd.ts`.

The read-back check inside `writeEsd()` catches write failures but does NOT prevent a wrong value from being committed to the live record (confirmed by the Phase 2c incident). The audit trail (`insertMxiWrite()`) records the outcome either way.

---

## Finding 5: `EsdInferenceProvider` interface — Azure stub is a live import path

**File:** `backend/src/inference/azureOpenAiProvider.ts`
**Severity:** Low
**Status:** Open — known stub, worth a runtime guard

The graph shows `AzureOpenAiEsdProvider` is wired into the provider interface (`EsdInferenceProvider` hyperedge: all three providers implement it). The stub throws `new Error('Not implemented')`.

If anything ever accidentally selects it (e.g., a future config value that maps a string to a provider), it will throw at runtime rather than at startup. A guard that validates the selected provider at `cli.ts` startup (before any file parsing begins) would surface this immediately rather than mid-run.

---

## Hyperedges (structural groupings confirmed by graph)

- **All ESD Provider Implementations** — `types.ts`, `anthropicProvider.ts`, `azureOpenAiProvider.ts`, `dryRunProvider.ts` — all implement `EsdInferenceProvider` [EXTRACTED]
- **MXI Stage Bootstrap consumers** — `stageClient.ts`, `mxiReadEsd.ts`, `mxiWriteEsd.ts`, `saveStorageState.ts` [EXTRACTED]
- **Phase 1 Pipeline Data Flow** — parsers → `matchOrders.ts` → `applyInferenceRules.ts` → `db.ts` → `exportExcel.ts` [INFERRED 0.95]

---

## How to re-run this analysis

```bash
cd C:\Users\717375\amc-repair-suite
# Query the existing graph (no rebuild needed):
graphify query "MxiClient session expiry isSessionAlive"
graphify query "writeEsd callers approval constraints"
graphify path "openDb()" "server.ts"

# Rebuild from scratch after significant code changes:
# /graphify --update
```
