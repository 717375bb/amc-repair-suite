# Vendor Quote Writer — Spec

Written **before** implementation, per this project's standing convention
(same as `PHASE2_MXI_WRITER_SPEC.md` and `VENDOR_MODULE_REFACTOR_SPEC.md`).
Every design decision below traces to either an explicit user answer
(2026-08-21, recorded verbatim in §2) or a real, executed feasibility probe
(§3) — nothing here is assumed where it could be checked.

## 1. What this is

A fourth workstream alongside Order Write-Ups, Open Order ESD Finder, and
Invoice Price Writer: read vendor **quote PDFs** out of a dedicated Outlook
folder, extract their real contents, show them for review, and write the
result into MXI (Unit Price **and** ESD).

Today this is fully manual — the analyst opens each quote email, reads the
PDF, and retypes the price and lead time into MXI per order.

## 2. Confirmed decisions (explicit user answers, 2026-08-21)

| Question | Answer | Consequence |
|---|---|---|
| Mail access | **Local Outlook COM** | No Azure AD app registration, no IT admin consent, no stored mail credentials. Windows + desktop Outlook required. Mirrors the already-proven Excel COM pattern. |
| MXI write target | **Price *and* ESD** | Reuses `writePriceLineUpdate.ts` for price, but pushes a **real ESD** derived from the quote's lead time — not the Invoice Price Writer's "tomorrow" placeholder. |
| Mail scope | **One dedicated folder** | User is creating a new Quotes folder. Path configurable via `.env`; tool never reads outside it. |
| PDF type | **Mixed / unknown** | PDFs go to Claude directly (handles real-text and scanned alike) rather than a local text-only extractor that breaks on the first scan. |
| Order matching | **PSA order number is on the quote** | Direct `P000XXXX` lookup — no fuzzy PN+SN matching needed for v1. See §7 for the fallback question this leaves open. |
| Mailbox writes | **Mark processed mail as read** | The tool *does* modify the mailbox, but minimally: read-flag only, only after a genuinely successful MXI write, never move/delete. |

## 3. Feasibility: proven, not assumed

Outlook COM was probed for real on this machine before any of this was
designed (read-only — folder names and item counts only, no message
content read, nothing modified):

- `HKLM:\SOFTWARE\Classes\Outlook.Application\CurVer` → `Outlook.Application.16`
- `New-Object -ComObject Outlook.Application` → **succeeded**, version `16.0.0.20228`
- `GetNamespace("MAPI")` → **OK**; full folder tree enumerated successfully,
  including item counts (`Inbox` 2824, `psa_CRA` 9293, `OOR` 496).

**This is the single biggest risk in the whole project and it is now
retired.** If COM had been blocked by policy, the entire approach would
have had to change to Microsoft Graph (weeks of IT approval) or a manual
watched folder.

**Confirmed at the same time**: no folder in the mailbox is quote-specific
today. The user is creating one — so the folder path must be configuration,
not a hardcoded constant, and a missing/misnamed folder must fail with a
clear, actionable error (listing what folders *do* exist), never silently
return zero messages. Silent-zero is exactly the failure mode
`api/esdFinder/ingestion.ts` already exists to prevent for spreadsheets.

## 4. Architecture

Deliberately mirrors the ESD Finder's proven shape (two-phase: a read/extract
job, then a separate human-approved write job), because that structure has
already survived real production use in this repo.

```
backend/
  scripts/
    read-outlook-quotes.ps1        Outlook COM: resolve folder, save PDF attachments, emit JSON. READ-ONLY.
    mark-outlook-mail-read.ps1     Outlook COM: mark ONE message read by EntryID. The only mailbox mutation.
  src/
    quoteWriter/
      types.ts                     OutlookMessage, QuoteAttachment, QuoteExtraction
      outlookReader.ts             execFile wrapper (child_process) around read-outlook-quotes.ps1
      outlookMarkRead.ts           execFile wrapper around mark-outlook-mail-read.ps1
      extractionTypes.ts           QuoteExtractionProvider interface — the swappable seam
      anthropicQuoteProvider.ts    real Claude PDF extraction, forced tool-calling
      dryRunQuoteProvider.ts       no-op provider, zero API calls (mirrors dryRunProvider.ts)
      matchQuoteToOrder.ts         order-number-first matching + validation
    api/quoteWriter/
      quoteJobManager.ts           own activeRunId slot — independent of the other three tabs
    api/jobRunners/
      quoteIngestRunner.ts         spawned: Outlook read -> Claude extract -> emit
      quoteWriteRunner.ts          spawned: MXI write (price + ESD) -> mark read
  data/
    quote-attachments/             gitignored staging for real PDFs (CONFIDENTIAL vendor pricing)
```

Frontend: `src/pages/VendorQuotes.tsx` + `src/lib/quoteApi.ts` + nav entry,
following `EsdFinder.tsx`'s State A/B/C shape.

### 4.1 Why PowerShell + `execFile`, not a Node COM library

Exactly the reasoning already validated by `write-tool-output-flags.ps1`:
Office COM is most reliably driven by the OS's own scripting host, and
`child_process.execFile` (argument array, **no shell**) avoids the Windows
shell-quoting hazards this repo has already been bitten by. Node COM
bindings would add a native dependency for no real gain.

## 5. Data model

Three new tables, same append-only two-table-plus-writes pattern as
`runs`/`esd_inferences`/`mxi_writes`:

- `quote_runs` — one row per ingest run (folder, message count, started/completed).
- `quote_extractions` — one row per PDF: source message EntryID, sender,
  subject, received time, attachment filename, plus every extracted field
  (order number, vendor, PN, SN, unit price, currency, quote number, quote
  date, lead-time days, computed ESD), the AI's confidence, and the raw
  model response for audit.
- `quote_writes` — one row per real MXI write attempt, mirroring
  `mxi_writes`/`invoice_price_writes` (target env, status, error, approved_by).

`quote_extractions.source_entry_id` is what `mark-outlook-mail-read.ps1`
later targets — EntryID is Outlook's own stable per-message identifier.

## 6. Safety rules (non-negotiable, enforced structurally)

1. **The mailbox is read-only except for the read-flag.** The reader script
   contains no `Move`, `Delete`, or `Save` call at all — not a flag that
   could be toggled. Marking read lives in a *separate* script that takes
   exactly one EntryID.
2. **Mail is only ever marked read after a verified-successful MXI write.**
   A failed or skipped write leaves the message untouched, so the queue
   never silently loses work.
3. **Quote PDFs are confidential vendor pricing.** `data/` already covers
   the staging directory, but explicit entries are added and
   `verify-gitignore.ps1`'s checked-path list is extended — a `.gitignore`
   entry that *looks* right has silently failed twice in this project, so
   the authoritative `git check-ignore` test is the only acceptable proof.
4. **Never write to MXI off an unreviewed extraction.** AI-extracted prices
   are money. Every row is human-reviewed in the UI before any write, same
   as every other writer in this repo.
5. **Extraction confidence is surfaced, never hidden.** A low-confidence or
   partially-extracted quote renders as needs-attention, not as a normal row.

## 7. Open questions — deliberately NOT guessed

- **What a real quote PDF actually looks like.** No real example has been
  inspected yet. The extraction schema in §5 is a considered starting point,
  not a confirmed one — it gets validated against real PDFs in Stage 2 and
  revised if wrong.
- **Lead time → ESD.** The user confirmed "price and ESD both," but *how*
  the quote states its date (an explicit ship date? "10-14 days ARO"?) is
  unknown until real PDFs are seen. Whether the existing
  `SHIPPING_BUFFER_DAYS`/`QUOTE_BUFFER_DAYS` should apply on top is an open
  question for the user once we know.
- **Fallback when the order number is missing/unreadable.** The user says
  it's always on the quote; real PDFs will confirm or refute that. Until
  then, a quote with no extractable order number is an explicit
  needs-review row — never a guess.
- **Multi-quote and multi-line PDFs.** A single PDF covering several orders
  hasn't been confirmed to exist or ruled out.

## 8. Build order (one stage, proven with real data, before the next)

1. ~~**Outlook reader**~~ — DONE. Real folder, real attachments saved, JSON emitted, read-only proven (every touched message still unread).
2. ~~**Claude extraction**~~ — DONE. Validated against real quote PDFs; schema revised from real evidence (email body added as input, NREP detection added).
3. ~~**Match + persist**~~ — DONE. Order-number lookup, DB tables, ingest job/endpoint/CLI.
4. ~~**Review UI**~~ — DONE at `/email-quotes`, replacing the old mock scaffold. Dispositions (NREP/BER/exclude) included.
5. **MXI write** — BUILT, guards verified, **but no real write performed yet**. Price + ESD, stage first, one order, watched.

### Remaining open items

- **The first real MXI write has not happened.** Everything around it is
  tested — disposition guards, already-written guard, missing-field guard,
  mark-as-read round-trip — but no price or ESD has actually been pushed by
  this path. Do the first one as a single order against stage, watched, per
  this project's standing discipline for any new kind of production action.
- **The scrap process itself is still out of scope.** NREP and BER rows are
  recorded and excluded from the write, waiting for that workflow to be
  built.
- **Extraction is not perfectly deterministic.** Prices were stable across
  five real runs, but one document's completion date came back on three
  runs and null on a fourth, shifting its derived ESD by five days. Human
  review before writing is load-bearing, not ceremonial.
- **Multi-line orders are skipped**, inherited from `writePriceLineUpdate()`'s
  existing single-line limitation.
