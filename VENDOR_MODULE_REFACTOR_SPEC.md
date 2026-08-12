# Vendor Module Refactor Spec

Written before implementation, per the 0T1Y4 prompt's own fallback instruction
("if that refactor hasn't landed yet, do it first and verify zero behavior
change against a prior known Aero Repair run before touching 0T1Y4"). This
spec did not exist anywhere in the repo, the user's home directory, or
Downloads before this document — confirmed via direct search, not assumed
missing. Drafted fresh, then implemented against this exact shape.

## 1. Why this exists

Aero Repair's write-up flow (`backend/src/writeUps/aeroRepair/`) was built as
a single, entirely self-contained module — no vendor abstraction, hardcoded
constants, hardcoded outcome types. That was correct for one vendor. Adding a
second (`0T1Y4`, warranty terminal state) with a materially different flow
(vendor-code search instead of station-routing, an authorization-only terminal
state, an auth-flow policy keyed on serial-number prefix, a usage table that
can legitimately be absent) surfaced real, reusable mechanics that shouldn't
be copy-pasted a second time, and real per-vendor differences that shouldn't
be forced into Aero Repair's existing hardcoded shape.

**Scope discipline**: this is a 2-vendor refactor, not a speculative
N-vendor framework. Only mechanics **confirmed identical** across both
vendors' real recordings move into the shared engine. Anything genuinely
vendor-specific (station routing, vendor-bid-radio selection, the
routine/non-routine charge-to-account replacement) stays put. Aero Repair's
own runtime behavior must not change as a side effect of this work — verified
below, not assumed.

## 2. What actually generalizes (confirmed against both real recordings)

Cross-checked line-by-line, `discovery-writeOrder-recording.ts` (Aero Repair,
the recording `aeroRepair`'s own module was originally built from) against
`discovery-0t1y4-bn-recording.ts` / `discovery-0t1y4-warranty-recording.ts`:

| Mechanic | Aero Repair | 0T1Y4 BN | 0T1Y4 Warranty | Shared? |
|---|---|---|---|---|
| Create New Task -> Ad-Hoc (`#idRadioAdHoc`, `#idInput12`, OK, Close, Close) | Yes (no-task recovery path) | Yes, identical sequence | N/A (task already assigned) | **Yes** |
| Schedule Work Package form (charge-to-account, purchasing contact, conditions/transportation dropdowns by label, notes, OK) | Yes | Yes | Yes | **Yes** (label-based dropdown selects, field IDs identical) |
| Request Authorization -> select Auth Flow by label -> OK | Yes (always "REPAIR") | Yes (explicit override to "REPAIR") | Yes (leaves default "WARRANTY", no dropdown touch) | **Yes**, mechanic shared; label/override policy is config |
| Issue Order -> OK -> Receipt & Returns -> shipment -> Move to Dock -> Close -> Close | Yes | Yes | **Never reached** (terminates after auth) | **Yes**, mechanic shared; whether it runs at all is config (`terminalState`) |
| Station routing + vendor-bid-radio selection | Yes (12-station table) | **No** — vendor is already fixed by the `0T1Y4` vendor-code search | No | **No** — stays in Aero Repair only |
| Line search / candidate discovery | OEM Part Number filter across 6 known part numbers | Vendor/Shop code filter (`#idVendorShop`) | Vendor/Shop code filter | **No** — genuinely different UI flows, each vendor keeps its own search |
| Charge-to-account value construction | Regex replace "ROUTINE+NONROUTINE" -> "WHEELSBRAKES" on the CR-prefix read from the field | Arrow-key-clear + fixed literal `CR9REPAIR` | Fixed literal `CR9REPAIR` | **No** — different construction logic per vendor, `chargeToAccountSuffix` config value covers the common "REPAIR"-suffix shape only |
| Usage table read + classification | Binary: present+all-zero -> `Zero Usage - Records Error`, anything else -> proceed | Three-way: absent is *expected* for BN lines | Three-way: present+non-zero is the normal case | **New 3-way classifier added to shared engine; Aero Repair's own binary check is left untouched** (see §3.3) |

## 3. Shared engine (`backend/src/writeUps/shared/`)

### 3.1 `vendorConfig.ts` — types only, no behavior

```ts
export type TerminalState = 'ISSUE_AND_DOCK' | 'AUTHORIZATION_ONLY';
export type UsageTableExpectation = 'expectedPresent' | 'expectedAbsent';

export interface AuthFlowOverride {
  id: string;
  when: { serialNumberPrefix: string };
  authFlow: string;
  terminalState: TerminalState;
  usageTable: UsageTableExpectation;
}

export interface AuthFlowPolicy {
  default: string;
  overrides: AuthFlowOverride[];
}

export interface VendorFormConfig {
  purchasingContact: string;
  conditions: string;
  transportation: string;
  chargeToAccountSuffix: string;
  notesHeader: string;
}

export interface VendorConfig {
  id: string;
  displayName: string;
  form: VendorFormConfig;
  authFlowPolicy: AuthFlowPolicy;
  defaultTerminalState: TerminalState;
  warrantyEligible: boolean;
}

export interface ResolvedAuthFlowPolicy {
  authFlow: string;
  terminalState: TerminalState;
  usageTableExpectation: UsageTableExpectation;
  matchedOverrideId: string | null;
}
```

`resolveAuthFlowPolicy(serialNumber, config)`: normalizes the serial (trim +
uppercase), checks each override's `serialNumberPrefix` in order, returns the
first match; falls back to `{ authFlow: config.authFlowPolicy.default,
terminalState: config.defaultTerminalState, usageTableExpectation:
'expectedPresent' }` if nothing matches. Logs which branch fired — this
function makes a real dispatch decision for a real production write, so it
does not fail silently.

**Applied to Aero Repair** (documents current behavior as config, changes
nothing): `authFlowPolicy = { default: 'REPAIR (Repair Authorization)',
overrides: [] }`, `defaultTerminalState = 'ISSUE_AND_DOCK'`. Every real order
today gets `authFlow = 'REPAIR (Repair Authorization)'` and
`terminalState = 'ISSUE_AND_DOCK'` unconditionally — `resolveAuthFlowPolicy`
returns exactly that with zero overrides ever matching, so this is a
restatement, not a change.

### 3.2 Terminal-state dispatch (structural, per the prompt's own requirement)

Lives at the call site that currently hardcodes "always issue + dock"
(0T1Y4's own process-line equivalent — see §4). Aero Repair's existing
`processLine.ts` is **not** rewired through this dispatch — it already always
does `ISSUE_AND_DOCK` unconditionally with no config anywhere in the call
path, and rewiring it through a switch that always takes the same branch is
a no-op that only adds risk. The dispatch itself:

```ts
switch (resolved.terminalState) {
  case 'ISSUE_AND_DOCK':
    // issueGeneratedOrder + moveOutboundShipmentToDock, independently
    // re-verified — identical to Aero Repair's existing processLine.ts logic,
    // reused via shared/issueAndDock.ts (see §3.4).
    break;
  case 'AUTHORIZATION_ONLY':
    // record a positive, explicit outcome; never call issueOrder/moveToDock.
    break;
}
```

No code path may reach `issueGeneratedOrder`/`moveOutboundShipmentToDock` from
the `AUTHORIZATION_ONLY` branch — enforced by the branch simply not calling
them, not by an early return that could be bypassed by a future edit.

### 3.3 Usage table — new 3-way classifier, additive only

`shared/usageTable.ts` exports `classifyUsageTable(usageRows):
'present_nonzero' | 'present_all_zero' | 'absent'`. This is **new**, used
only by 0T1Y4. Aero Repair's existing `partDetails.ts#isZeroUsage` (binary,
used for its one real check — `Zero Usage - Records Error`) is left
byte-for-byte unchanged. The two are independent functions; Aero Repair does
not call the new classifier and the new classifier does not replace
`isZeroUsage`. Reconciling their edge-case semantics (e.g. one usage row
present, the other missing) is deliberately out of scope — forcing them into
one shared implementation for a case that has never been observed in
practice is exactly the kind of premature abstraction this refactor is
supposed to avoid, and doing so would risk changing Aero Repair's real
behavior for no real benefit.

### 3.4 What actually moves into `shared/`

Moved (cut, not duplicated) from `aeroRepair/selectors.ts` and
`aeroRepair/issueOrder.ts`, confirmed vendor-agnostic per §2's table:

- `shared/taskRecovery.ts` — `openCreateNewTask`, `readTaskDefinitionCandidates`,
  `cancelCreateNewTask`, `createAdHocTaskForCandidate`,
  `extractWorkPackageCheckId`, `reopenRepairLineAfterTaskCreation`,
  `readAssignedTasksAreaText`, `readUnassignedTasksAreaText`,
  `TaskDefinitionCandidate` (+ their `gridWait.ts` waits:
  `waitForTaskDefinitionCandidatesResolved`, `waitForWorkPackageDetailsResolved`,
  `waitForBodyTextIncludes`).
- `shared/scheduleWorkPackageForm.ts` — `clickScheduleWorkPackage`,
  `selectExternalVendorWorkPackage`, `readChargeToAccount`,
  `fillChargeToAccount`, `fillPurchasingContact`, `selectConditions`,
  `fillReturnToLocation`, `selectTransportation`, `fillNotesToVendor`,
  `confirmScheduleWorkPackage`, `openGeneratedOrder`, `findGeneratedOrderNumber`
  (+ `waitForGeneratedOrderNumberSettled`).
- `shared/authFlow.ts` — `clickRequestAuthorization`, `selectAuthFlow`,
  `confirmAuthorizationRequest`, plus `resolveAuthFlowPolicy` (new).
- `shared/issueAndDock.ts` — the entire contents of `aeroRepair/issueOrder.ts`
  (`clickIssueOrder`, `confirmIssueOrder`, `navigateToOrderByNumber`,
  `readOrderRealState`, `issueGeneratedOrder`, `readOutboundShipmentDockState`,
  `moveOutboundShipmentToDock`). This supersedes the module's original
  "vendor-module-isolation" duplication design (which deliberately
  reimplemented the ESD writer's `reissueOrder()` locally rather than share
  cross-module) — 0T1Y4's own recording confirms byte-for-byte identical
  Issue Order / Move to Dock sequencing, so the isolation rationale no longer
  holds once a second vendor genuinely needs the same mechanism.

Aero Repair's own files (`selectors.ts`, `issueOrder.ts`) re-export these
names from `shared/` so every existing call site
(`writeUp.ts`, `batchDiscovery.ts`, `partDetails.ts`, `processLine.ts`)
continues to compile and run unchanged — only the function bodies' *location*
moves, not their behavior or call signature.

**Stays in `aeroRepair/`** (genuinely vendor-specific, per §2's table):
`routing.ts`, `chargeToAccount.ts` (the routine/non-routine replacement),
`returnToLocation.ts`, `noTaskException.ts`'s text constants,
`partDetails.ts`'s station-based search + vendor-bid-radio selection +
`isZeroUsage`, the 12-station `AERO_REPAIR_ROUTING` table, and
`writeUp.ts`/`processLine.ts` themselves (Aero Repair keeps its own
orchestrator — it is not rewritten to consume a generic
config-driven-orchestrator, since doing so would touch its live behavior for
no functional gain; only its *constant values* are additionally expressed as
an `AeroRepairVendorConfig` object per §3.5, for consistency and so the
`resolveAuthFlowPolicy`/`VendorConfig` types have a second real consumer to
validate their shape against).

### 3.5 `AeroRepairVendorConfig` (documentation + shape validation, not a rewire)

**Revised per explicit user instruction, after the live label-confirmation
pass below**: Purchasing Contact, Terms & Conditions, and Transport Type are
confirmed **global MXI defaults**, not vendor-scoped — confirmed via a single
live read-only query of the real `<option>` elements on an *existing* Aero
Repair production form (`discovery-confirmGlobalDropdownLabels.ts`), not by
touching 0T1Y4. `shared/vendorConfig.ts` now exports
`DEFAULT_VENDOR_FORM_DEFAULTS` (`purchasingContact: '717375'`,
`conditions: 'NET30'`, `transportation: 'FEDEX-2'`) and a
`buildVendorFormConfig()` helper that merges a vendor's own required fields
(`chargeToAccountSuffix`, `notesHeader` — genuinely vendor-specific) with
those defaults. **Aero Repair is the sole current exception**, overriding
only `transportation` to `'PICKUP'`. Every future vendor (0T1Y4 onward)
inherits the default rather than restating these three values:

```ts
export const AERO_REPAIR_VENDOR_CONFIG: VendorConfig = {
  id: 'aeroRepair',
  displayName: 'Aero Repair',
  form: buildVendorFormConfig({
    transportation: TRANSPORTATION_LABEL,                 // 'PICKUP' — the sole override
    chargeToAccountSuffix: CHARGE_TO_ACCOUNT_REPLACEMENT, // 'WHEELSBRAKES'
    notesHeader: NOTES_HEADER_TEXT,                       // 'INSPECT AND SERVICE AS REQUIRED'
  }),
  authFlowPolicy: { default: AUTH_FLOW, overrides: [] }, // 'REPAIR (Repair Authorization)'
  defaultTerminalState: 'ISSUE_AND_DOCK',
  warrantyEligible: false,
};
```

Not currently read by `writeUp.ts`/`processLine.ts` (which still use the raw
constants directly, unchanged) — this object exists so the `VendorConfig`
shape is proven against a second real, already-verified-in-production vendor
before 0T1Y4 (a brand-new, never-run vendor) becomes the shape's only real
user. If a future third vendor needs Aero Repair to actually consume its own
config object end-to-end, that's a separate, later change with its own
verification pass — not bundled into this one.

## 4. 0T1Y4's own module (`backend/src/writeUps/0t1y4/`)

Built on top of the shared engine, not the generic orchestrator — its search
strategy, notes composition (two branches, keyed on usage-table
classification per the prompt's item 3, not a vendor-config flag), and
terminal-state dispatch are enough of a distinct shape that a bespoke
`runVendor0T1Y4WriteUp()` (same pattern as Aero Repair's own
`runAeroRepairWriteUp()`) calling into `shared/` is clearer than forcing a
one-size-fits-all generic runner for exactly two, meaningfully different
vendors. New exceptions (`Usage Table Absent (Unexpected)`,
`Authorization Not Confirmed`) are appended to `write_up_actions` the same
append-only way every other exception in this project already is —
`outcome` is a free-text `TEXT` column with no enum constraint (confirmed via
`db.ts`'s schema), so no migration is required.

## 5. Verification: zero behavior change against a prior known Aero Repair run

Before any 0T1Y4-specific code is written:

1. `tsc --noEmit` clean across the whole backend, both before and after the
   move.
2. Grep-confirm every moved function has exactly the call sites it had
   before (same names, same signatures), now resolving through a re-export
   rather than a local definition.
3. Live, read-only comparison: run `npm run aero-repair:batch-discovery`
   against the same environment as a known prior run and confirm identical
   classification counts/shape for at least one part number with existing
   history — discovery never mutates anything, so this is safe to run
   freely, same as every prior discovery proof in this project.
4. If a live write-path smoke test is warranted, use the existing
   `aero-repair:write-up` CLI (stops before Issue Order, a pre-existing safe
   checkpoint) against a real line and confirm the filled-fields output
   matches the same shape/values a pre-refactor run would have produced.

Only after all four are genuinely confirmed does 0T1Y4 implementation begin.

## 5.1 Generalization to a true multi-vendor engine (post-0T1Y4)

Per explicit user direction, after 0T1Y4's first live production runs
proved the mechanism end-to-end: the "vendor-code search + BN-prefix
override + warranty terminal state" process is identical for every vendor
using it, save for the vendor code itself. `0t1y4/writeUp.ts`,
`0t1y4/search.ts`, and `0t1y4/notes.ts` were generalized into
`shared/vendorCodeWriteUp.ts` (parameterized by `VendorConfig` instead of
importing one hardcoded config), and the 0T1Y4-only `constants.ts`/
`vendorConfig.ts` were replaced by `shared/vendorConfig.ts`'s
`buildWarrantyTerminalStateVendorConfig(vendorCode, displayName, overrides?)`
plus `shared/vendorRegistry.ts`'s `VENDOR_REGISTRY` map. Two more real
mechanics (`openPartOwnDetails`/`readPartOwnDetails`/`closePartOwnDetails`
and the Unassigned Tasks detour + `isUnassignedTaskPresent`) were promoted
from `aeroRepair/` to `shared/` in the same pass, having now been proven by
a second real vendor.

**Adding a new vendor to this family is a one-line registry entry** —
`'XXXXX': buildWarrantyTerminalStateVendorConfig('XXXXX', 'Vendor XXXXX')`
— no new orchestrator, search, or notes code. `vendorCodeWriteUpCli.ts`
(`npm run vendor:write-up -- <vendorCode> [serialNumber] [--env
production]`) supersedes the old single-vendor CLI.

**This does not remove the need for a first watched run per vendor.** The
code path is proven; a given vendor's own real data is not, until it's
actually been exercised — 0T1Y4's own first runs surfaced three real bugs
(an ambiguous "OK" selector, missing retry protection, and a wrong
Authorization Status expectation) that no amount of code review would have
caught. `buildWarrantyTerminalStateVendorConfig`'s optional `overrides`
parameter exists specifically so a future vendor that turns out to
genuinely differ from the template doesn't require another refactor — it
requires noticing the difference during that first watched run and passing
an explicit override, not silently assuming identical.

## 6. Open items the 0T1Y4 prompt itself already flags (not resolved by this
refactor, still require human confirmation before a real production run)

- Exact `page.goto(...)` URLs (truncated in both pasted recordings).
- Real visible `<option>` labels for Terms/Conditions, Transport Type, and
  Auth Flow dropdowns (replacing the recordings' opaque `{AES}...` tokens).
- Whether the Transport Type token discrepancy between the two recordings
  reflects a real behavioral difference (possibly moving `transportation`
  from top-level `form` into a serial-prefix-keyed override, same shape as
  `authFlowPolicy`).
- Whether BN-line notes should include the PN/SN description line despite
  the recording omitting it.
- Whether the "items at USSTG" filter checkbox belongs in 0T1Y4's own
  vendor-code search routine or is session-specific.

These are explicitly **not** guessed at anywhere in this spec or its
implementation — each is a real open question the 0T1Y4 prompt itself lists
under "before running against production," and stays open until answered.
