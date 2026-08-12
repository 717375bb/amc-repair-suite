# Graph Report - .  (2026-07-08)

## Corpus Check
- Corpus is ~20,357 words - fits in a single context window. You may not need a graph.

## Summary
- 351 nodes · 605 edges · 21 communities (16 shown, 5 thin omitted)
- Extraction: 97% EXTRACTED · 3% INFERRED · 0% AMBIGUOUS · INFERRED: 21 edges (avg confidence: 0.84)
- Token cost: 0 input · 0 output

## Community Hubs (Navigation)
- DB Layer & Server API
- CLI Pipeline & Order Matching
- Frontend Dependencies
- ESD Inference Engine
- Backend Dependencies
- MXI Write Automation
- UI Components & Mock Data
- App Shell & Navigation
- Frontend TypeScript Config
- Node TypeScript Config
- Backend TypeScript Config
- Workflow Pages
- Project Docs & Spec
- TypeScript Project References
- API Test Scaffold
- Frontend Entry Point
- Domain Types
- Frontend Framework

## God Nodes (most connected - your core abstractions)
1. `compilerOptions` - 17 edges
2. `compilerOptions` - 16 edges
3. `MxiClient` - 15 edges
4. `compilerOptions` - 14 edges
5. `main()` - 13 edges
6. `writeEsd()` - 11 edges
7. `EsdInferenceProvider` - 10 edges
8. `createReadyStageMxiClient()` - 10 edges
9. `EsdInferenceResult` - 9 edges
10. `statusTone()` - 9 edges

## Surprising Connections (you probably didn't know these)
- `Frontend Entry Point HTML` --references--> `Favicon SVG (Claude-style lightning bolt icon)`  [EXTRACTED]
  index.html → public/favicon.svg
- `AMC Repair Suite CLAUDE.md - Project Overview` --references--> `Phase 2 MXI Writer Spec`  [EXTRACTED]
  CLAUDE.md → backend/PHASE2_MXI_WRITER_SPEC.md
- `MXI Session Management - Login-Once, Retry-Once-Then-Halt` --rationale_for--> `MXI Client (single persistent Playwright browser context)`  [EXTRACTED]
  backend/PHASE2_MXI_WRITER_SPEC.md → CLAUDE.md
- `Write Reporting Failure vs Record Being Wrong Are Different Facts` --rationale_for--> `Write ESD - Orchestrates Write + Read-Back Confirmation`  [EXTRACTED]
  backend/PHASE2_MXI_WRITER_SPEC.md → CLAUDE.md
- `AMC Repair Suite CLAUDE.md - Project Overview` --references--> `Backend Phase 1 README`  [EXTRACTED]
  CLAUDE.md → backend/README.md

## Import Cycles
- None detected.

## Hyperedges (group relationships)
- **All ESD Provider Implementations (swappable via EsdInferenceProvider interface)** — backend_src_inference_types_ts, backend_src_inference_anthropicprovider_ts, backend_src_inference_azureopenaiproviderts, backend_src_inference_dryrunprovider_ts [EXTRACTED 1.00]
- **MXI Stage Bootstrap - Shared createReadyStageMxiClient() Consumers** — backend_src_mxiwriter_stageclient_ts, backend_src_mxireadesd_ts, backend_src_mxiwriteesd_ts, backend_src_mxiwriter_savestoragestate_ts [EXTRACTED 1.00]
- **Phase 1 ESD Inference Pipeline Data Flow** — backend_src_parsers_vendoroorparser_ts, backend_src_parsers_craoorparser_ts, backend_src_matching_matchorders_ts, backend_src_inference_applyinferencerules_ts, backend_src_db_db_ts, backend_src_output_exportexcel_ts [INFERRED 0.95]

## Communities (21 total, 5 thin omitted)

### Community 0 - "DB Layer & Server API"
Cohesion: 0.11
Nodes (29): EsdInferenceDbRow, getActionableEsdInference(), getPendingEsdUpdates(), insertMxiWrite(), MxiWriteInsert, openDb(), RawEsdInferenceRow, rowToEsdInference() (+21 more)

### Community 1 - "CLI Pipeline & Order Matching"
Cohesion: 0.13
Nodes (27): main(), opts, printSummary(), program, insertInferenceRecords(), insertRun(), matchOrders(), normalizeOrderNumber() (+19 more)

### Community 2 - "Frontend Dependencies"
Cohesion: 0.06
Nodes (31): dependencies, lucide-react, react, react-dom, react-router-dom, devDependencies, autoprefixer, eslint (+23 more)

### Community 3 - "ESD Inference Engine"
Cohesion: 0.14
Nodes (17): AnthropicEsdProvider, inputSchema, applyInferenceRules(), BaseFields, ComputedFields, emptySummary(), finalizeRecord(), processOrder() (+9 more)

### Community 4 - "Backend Dependencies"
Cohesion: 0.07
Nodes (28): dependencies, @anthropic-ai/sdk, better-sqlite3, commander, date-fns, dotenv, exceljs, express (+20 more)

### Community 5 - "MXI Write Automation"
Cohesion: 0.10
Nodes (29): Phase 2 MXI Writer Spec, CLI Entry Point (commander), DB Module (schema inlined, getPendingEsdUpdates, getActionableEsdInference, insertMxiWrite), SQLite DB Schema (runs, esd_inferences, mxi_writes), Match Orders - Joins on Normalized Order Number, Orphan Diagnostics, MXI Read ESD CLI Tool (read-only smoke test), MXI Write ESD CLI Tool (read-write smoke test) (+21 more)

### Community 6 - "UI Components & Mock Data"
Cohesion: 0.16
Nodes (21): Badge(), BadgeTone, Card(), CardHeader(), PrimaryButton(), SecondaryButton(), toneClasses, discrepancies (+13 more)

### Community 7 - "App Shell & Navigation"
Cohesion: 0.13
Nodes (19): App(), Sidebar(), TopBar(), AppLayout(), NavGroup, navGroups, NavItem, navItems (+11 more)

### Community 8 - "Frontend TypeScript Config"
Cohesion: 0.11
Nodes (18): compilerOptions, allowImportingTsExtensions, erasableSyntaxOnly, jsx, lib, module, moduleDetection, moduleResolution (+10 more)

### Community 9 - "Node TypeScript Config"
Cohesion: 0.11
Nodes (17): compilerOptions, allowImportingTsExtensions, erasableSyntaxOnly, lib, module, moduleDetection, moduleResolution, noEmit (+9 more)

### Community 10 - "Backend TypeScript Config"
Cohesion: 0.12
Nodes (15): compilerOptions, declaration, esModuleInterop, forceConsistentCasingInFileNames, lib, module, moduleResolution, outDir (+7 more)

### Community 11 - "Workflow Pages"
Cohesion: 0.30
Nodes (7): WorkflowPlaceholder(), BackshopRepairs(), QuotesReports(), ScrappedParts(), StatisticalModels(), VendorKpiReports(), WarrantyAssessment()

### Community 12 - "Project Docs & Spec"
Cohesion: 0.24
Nodes (12): Backend Phase 1 README, Anthropic ESD Provider (claude-haiku-4-5-20251001), Apply Inference Rules - 5-Step Decision Engine, Azure OpenAI ESD Provider (stub - not implemented), Inference Constants (buffer-day constants), Date Utils - parseFlexibleDate, Dry Run ESD Provider (no-op for --dry-run), EsdInferenceProvider Interface (+4 more)

## Knowledge Gaps
- **137 isolated node(s):** `client`, `name`, `private`, `version`, `type` (+132 more)
  These have ≤1 connection - possible missing edges or undocumented components.
- **5 thin communities (<3 nodes) omitted from report** — run `graphify query` to explore isolated nodes.

## Suggested Questions
_Questions this graph is uniquely positioned to answer:_

- **Why does `openDb()` connect `DB Layer & Server API` to `CLI Pipeline & Order Matching`?**
  _High betweenness centrality (0.019) - this node is a cross-community bridge._
- **What connects `client`, `name`, `private` to the rest of the system?**
  _141 weakly-connected nodes found - possible documentation gaps or missing edges._
- **Should `DB Layer & Server API` be split into smaller, more focused modules?**
  _Cohesion score 0.11304347826086956 - nodes in this community are weakly interconnected._
- **Should `CLI Pipeline & Order Matching` be split into smaller, more focused modules?**
  _Cohesion score 0.12612612612612611 - nodes in this community are weakly interconnected._
- **Should `Frontend Dependencies` be split into smaller, more focused modules?**
  _Cohesion score 0.0625 - nodes in this community are weakly interconnected._
- **Should `ESD Inference Engine` be split into smaller, more focused modules?**
  _Cohesion score 0.13548387096774195 - nodes in this community are weakly interconnected._
- **Should `Backend Dependencies` be split into smaller, more focused modules?**
  _Cohesion score 0.06896551724137931 - nodes in this community are weakly interconnected._