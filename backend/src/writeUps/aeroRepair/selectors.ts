import type { Page } from 'playwright';
import { waitForBodyTextIncludes, waitForGeneratedOrderNumberSettled, waitForTaskDefinitionCandidatesResolved } from './gridWait.js';

const CLICK_DELAY_MS = 750;

async function pace(page: Page): Promise<void> {
  await page.waitForTimeout(CLICK_DELAY_MS);
}

/**
 * Reads the DEFAULT "Assigned Tasks" tab of the Work Package Details page
 * — landed on immediately after clicking a part's repair link, before any
 * further navigation. Confirmed live, both directions: PN 14700AA / BN
 * 389428 (genuinely empty) shows exactly NO_TASKS_ASSIGNED_TEXT here;
 * 90001200-1 / SN JUN14-2448 (genuinely has assigned work) shows a real
 * task row instead, no such message. Call this BEFORE
 * navigateToUnassignedTasksView — that view's own "no open tasks" message
 * is a different, unrelated, normal/expected state and must not be
 * confused with this one (see constants.ts's NO_TASKS_ASSIGNED_TEXT).
 */
export async function readAssignedTasksAreaText(page: Page): Promise<string> {
  return page.locator('body').innerText();
}

/**
 * Reads the Unassigned Tasks sub-tab's body text — call this AFTER
 * navigateToUnassignedTasksView, BEFORE closeUnassignedTasksView (once
 * Close is clicked, this content is gone). Distinct from
 * readAssignedTasksAreaText above: this sub-tab's own confirmed-real
 * empty-state text (constants.ts's NO_UNASSIGNED_TASKS_TEXT) is unrelated
 * to the default Assigned Tasks tab's no-tasks message and was previously
 * never read at all — this view was a pure navigational pass-through.
 */
export async function readUnassignedTasksAreaText(page: Page): Promise<string> {
  return page.locator('body').innerText();
}

/**
 * Reads the "<STATION>/<CODE>" location token (e.g. "DCA/USSTG") from the
 * row matching the TARGET line's own known-unique repair-link text — the
 * source value routing and return-to-location are both derived from.
 *
 * REAL BUG FOUND AND FIXED via live testing: this originally used
 * `.first()` on `input[name="aInventory"]` with no scoping to the target
 * line at all. When a part number has multiple open repair lines (5013640
 * genuinely does — confirmed live: DEC16-3759 at CAK/USSTG, JUL14-3229 at
 * CLT/USSTG, and others), `.first()` silently grabbed row 1's location
 * regardless of which line findFirstRepairLineForPart had actually
 * selected — producing a return-to-location value for the WRONG station.
 * Caught because the resulting autocomplete suggestion didn't exist for
 * the actually-open work package (a live `fillReturnToLocation` timeout),
 * not because this looked wrong on inspection. Now scoped via the same
 * ancestor-of-known-unique-link technique used elsewhere in this module.
 */
export async function readCurrentLocationCode(page: Page, linkText: string): Promise<string> {
  const repairLink = page.getByRole('link', { name: linkText, exact: true });
  const row = repairLink.locator('xpath=ancestor::tr[1]');
  const rowText = await row.innerText();
  const match = rowText.match(/\b([A-Z]{3})\/([A-Z0-9]+)\b/);
  if (!match) {
    throw new Error(
      `Could not find a "<STATION>/<CODE>" location token in the target line's row text: "${rowText}"`,
    );
  }
  return `${match[1]}/${match[2]}`;
}

export interface TaskDefinitionCandidate {
  /** Visible text of the row's own `<a class="navigable">` link in the "Block / Requirement" column, e.g. "32-41-01-01-010-REPL (MAIN WHEEL ASSY 900-REPLACEMENT)". */
  name: string;
  /** Real value of the row's "Class" column, e.g. "REPL", "MOD", "PC" — see readTaskDefinitionCandidates' docstring for why this matters. */
  taskClass: string;
}

/**
 * Clicks "Create New Task" — a link present on the SAME default "Assigned
 * Tasks" tab landed on immediately after a part's repair link is clicked
 * (the same page readAssignedTasksAreaText/isNoTasksAssignedException
 * already check), reached regardless of whether the line currently shows
 * an assigned task or not. Opens the real "Task Selection" panel that
 * readTaskDefinitionCandidates reads from.
 */
export async function openCreateNewTask(page: Page): Promise<void> {
  await page.getByRole('link', { name: 'Create New Task' }).click();
  await pace(page);
}

/**
 * Reads the real candidate task definitions from the "Task Selection"
 * panel's "Blocks and Requirements" table (confirmed live via direct DOM
 * inspection against a real order, 90001200-1/AUG14-2477, and cross-checked
 * against 3 further real no-task lines — every real candidate row has its
 * own `input[name="aTaskDefinition"]` radio). The SAME radio's underlying
 * `value` can appear duplicated multiple times in the DOM per row (a real,
 * confirmed rendering quirk of this page — not a scoping bug), so dedupes
 * by that value. Each candidate's real "Name" is the visible text of the
 * row's own `<a class="navigable">` link in the "Block / Requirement"
 * column; `taskClass` is the row's plain-text "Class" cell (the first
 * `td.shortString` WITHOUT a nested link — the Config Slot cell is also
 * `shortString` but always contains one, confirmed via direct HTML
 * inspection).
 *
 * IMPORTANT, found via real investigation (not assumed from a screenshot):
 * this table is NOT scoped to the specific serial number in front of it —
 * it's a fixed catalog of task-definition TEMPLATES for the work package's
 * general assembly/config area, offered identically regardless of which
 * serial you arrived from (confirmed: 4 different real serials across 3
 * different part numbers all showed the exact same 2-template shape). It
 * is also NOT pooling in a sibling serial's real task, the originally
 * suspected mechanism — a genuinely correctly-scoped source for "does THIS
 * serial already have a real task" exists and was already being read all
 * along: the default Assigned Tasks tab this function's caller lands on
 * (readAssignedTasksAreaText), whose "Inventory" column is confirmed to
 * always match the exact target PN+SN, never a sibling's. This table is
 * about which TEMPLATE to build a brand-new task from, given that the
 * correctly-scoped check already found zero real tasks — a different
 * question entirely from "which existing task belongs to me."
 *
 * One of the two templates offered is consistently `taskClass: 'PC'`
 * (Parts Card — administrative documentation, never itself the repair
 * task) — see writeUp.ts for why that real, always-present, always-
 * irrelevant entry is what actually caused the previous false "multiple
 * candidates" reads, not real per-serial ambiguity.
 *
 * Deliberately does NOT read `#idInput12` (`aTaskName`) here — that field
 * belongs to a completely different "Create Ad-Hoc Task" mode
 * (`#idRadioAdHoc`), confirmed via DOM to be `display:none` unless that
 * mode is explicitly selected. The recording's own "test" text went into
 * that field specifically because the recorded order showed 2 raw
 * templates (before the PC-exclusion fix) — not because free-text entry is
 * part of the real recovery mechanism.
 */
export async function readTaskDefinitionCandidates(page: Page): Promise<TaskDefinitionCandidate[]> {
  // SYSTEMATIC AUDIT FIX: this used to call page.evaluate() immediately
  // after openCreateNewTask's click+750ms pace, with no wait of its own —
  // the exact same immediate-page.evaluate() vulnerability class as the
  // vendor-bid read (Part B). An incomplete read here would corrupt the
  // whole 0/1/2+ Ad-Hoc-recovery classification, not just miss one value.
  await waitForTaskDefinitionCandidatesResolved(page);
  return page.evaluate(() => {
    const radios = Array.from(document.querySelectorAll('input[name="aTaskDefinition"]')) as HTMLInputElement[];
    const seen = new Map<string, { name: string; taskClass: string }>();
    for (const radio of radios) {
      if (seen.has(radio.value)) continue;
      const tr = radio.closest('tr');
      const nameLink = tr?.querySelector('a.navigable');
      const name = (nameLink?.textContent ?? tr?.textContent ?? '').replace(/\s+/g, ' ').trim();
      const shortStringCells = tr ? Array.from(tr.querySelectorAll('td.shortString')) : [];
      const classCell = shortStringCells.find((td) => !td.querySelector('a'));
      const taskClass = (classCell?.textContent ?? '').trim();
      seen.set(radio.value, { name, taskClass });
    }
    return Array.from(seen.values());
  });
}

/**
 * Cancels out of the "Task Selection" panel without creating anything —
 * used both for the genuine 0-candidate case (falls through to the
 * original no-tasks-assigned exception) and the 2+ (ambiguous) case,
 * neither of which should ever submit a real task.
 */
export async function cancelCreateNewTask(page: Page): Promise<void> {
  await page.getByRole('link', { name: 'Cancel' }).click();
  await pace(page);
}

/**
 * Extracts the real Work Package/Check ID from the default Assigned Tasks
 * tab's own title line, e.g. `"Work Package Details  Repair MAIN WHEEL
 * ASSY 700 (PN: 5013641, SN: JUN10-2295/JAN10-0014) [TRFKE00GXV7S]"` ->
 * `"TRFKE00GXV7S"`. Confirmed live: this exact ID format (`TRFKE00GX...`)
 * is the same one that later appears as a real task's own "ID" column
 * value once a task exists (e.g. the ad-hoc task created for
 * JUN10-2295/JAN10-0014 got its own distinct new ID, `TRFKE00GXZNE`,
 * separate from this pre-existing check ID, `TRFKE00GXV7S`) — this
 * function reads the PRE-EXISTING check-level ID, the only one available
 * before a new task is actually created. Only scans the first line (the
 * page title) to avoid matching an unrelated bracketed token elsewhere on
 * the page. Returns null if the expected trailing `[...]` isn't found,
 * rather than guessing.
 */
export function extractWorkPackageCheckId(assignedTasksPageText: string): string | null {
  const titleLine = assignedTasksPageText.split('\n')[0] ?? '';
  const match = titleLine.match(/\[([A-Z0-9]+)\]\s*$/);
  return match ? match[1] : null;
}

/**
 * Creates a real Ad-Hoc task named after the one genuine candidate's own
 * real `name` text, with the real Work Package/Check ID appended directly
 * after it (per explicit user instruction) — the DESIGN-PIVOTED
 * replacement for the retired `selectSingleTaskDefinitionCandidate`
 * (Task-Definition-based creation).
 *
 * Why this exists: the Task-Definition path
 * (`#idRadioTaskDefn` -> select a `aTaskDefinition` radio -> OK -> a
 * second real confirmation page, `CreateTaskFromDefinition.jsp`) was
 * confirmed live to trigger a genuine, deliberate MXI step-up
 * re-authentication dialog (a real in-page jQuery UI modal demanding the
 * current user's password again) specifically at that second page's
 * commit step — confirmed via a timed, controlled test to be tied to the
 * action itself, not session staleness (appeared 13s after a brand-new
 * login). No automated, credential-free way through that exists. Per
 * explicit user decision, made with full awareness of this tradeoff: use
 * Ad-Hoc task creation instead — the same real, already-proven mechanism
 * the original recording used (`discovery-notaskwriteup-recording.ts`),
 * which does not touch `CreateTaskFromDefinition.jsp` at all and was
 * confirmed live (this same investigation) not to trigger the prompt.
 *
 * Sequence replays the original recording's proven real commit path
 * exactly — `#idRadioAdHoc` -> fill `#idInput12` (`aTaskName`) with the
 * real candidate name + a space + the check ID (not the recording's
 * literal "test" placeholder, which only existed because live copy-paste
 * wasn't reliable during that recording session) -> OK -> "Close" cell ->
 * "Close" link. This is DIFFERENT from the retired function's sequence —
 * no second confirmation page exists on this path.
 *
 * `checkId` must be read from the Assigned Tasks tab (extractWorkPackageCheckId)
 * BEFORE calling openCreateNewTask — the Task Selection panel this
 * function operates on does not itself display that ID anywhere. Required,
 * non-null — the caller must extract it and fail loudly if it's missing
 * rather than silently create a task without the ID the user explicitly
 * asked to always include.
 */
export async function createAdHocTaskForCandidate(
  page: Page,
  candidate: TaskDefinitionCandidate,
  checkId: string,
): Promise<void> {
  const taskName = `${candidate.name} ${checkId}`;
  await page.locator('#idRadioAdHoc').check();
  await pace(page);
  await page.locator('#idInput12').click();
  await page.locator('#idInput12').fill(taskName);
  await pace(page);
  await page.getByRole('link', { name: 'OK' }).click();
  await pace(page);
  await page.getByRole('cell', { name: 'Close' }).click();
  await pace(page);
  await page.getByRole('link', { name: 'Close' }).click();
  await pace(page);
}

/**
 * REAL GAP FOUND AND FIXED via a live end-to-end test failure: after
 * createAdHocTaskForCandidate's final "Close" click, the page lands back
 * on the filtered To Do List grid (`ToDoList.jsp`) — NOT the Work Package
 * Details page the rest of `runAeroRepairWriteUp` expects (the very next
 * call, `navigateToUnassignedTasksView`, needs an "Unassigned" link that
 * only exists there). This never mattered for the ORIGINAL flow, which
 * only ever reached Work Package Details once, straight from the repair
 * link click, with no Create-New-Task detour. Confirmed live: the same
 * part-number-filtered grid this whole flow already navigated through
 * (findFirstRepairLineForPart) is still active on this page — the exact
 * same `linkText` used to select the line originally is still present and
 * clickable, re-entering Work Package Details for the same line.
 */
export async function reopenRepairLineAfterTaskCreation(page: Page, linkText: string): Promise<void> {
  await page.getByRole('link', { name: linkText, exact: true }).click();
  await pace(page);
}

/** Real: `Schedule Work Package` link on the To Do List / order-line view. */
export async function clickScheduleWorkPackage(page: Page): Promise<void> {
  await page.getByRole('link', { name: 'Schedule Work Package' }).click();
  await pace(page);
}

/**
 * `Schedule Work Package` lands on `ScheduleCheck.jsp`, a generic
 * internal/external-vendor toggle defaulted to "Work done internally" —
 * NOT captured in the original recording (verified via grep: zero
 * occurrences of "ScheduleCheck", "external vendor", or "Work done"
 * anywhere in discovery-writeOrder-recording.ts). The recording's specific
 * order had exactly one eligible vendor bid; live testing confirmed
 * selecting a vendor radio in the Vendors/Shops sub-rows does NOT bypass
 * this toggle when a line has multiple bids (ours does) — so this really
 * is a separate, necessary step this project's write-up flow always needs,
 * just one the original recording never exercised because its test order
 * happened not to need it.
 *
 * Selecting this radio (the second of the two `input[type="radio"]`
 * elements on this page) is what reveals the vendor-specific fields
 * (Charge To Account, Purchasing Contact, Terms & Conditions, etc.) —
 * confirmed live: those fields don't exist in the DOM until this is
 * selected.
 */
export async function selectExternalVendorWorkPackage(page: Page): Promise<void> {
  await page.locator('input[type="radio"]').nth(1).check();
  await pace(page);
}

/**
 * Reads the field's current value via `.inputValue()` — a standard
 * Playwright read on a text input, same category of API as
 * mxiWriter/selectors.ts's readEsdField. The recording itself only showed
 * the field being populated via a lookup-dialog double-click then
 * immediately overwritten by `.fill()`; reading the value directly via
 * `.inputValue()` instead of replaying that dialog interaction is a
 * reasonable adaptation (standard API on the same real element ID), but
 * unconfirmed live that this control supports `.inputValue()` cleanly.
 */
export async function readChargeToAccount(page: Page): Promise<string> {
  return page.locator('#idEditFieldChargeToAccount').inputValue();
}

export async function fillChargeToAccount(page: Page, value: string): Promise<void> {
  await page.locator('#idEditFieldChargeToAccount').click();
  await pace(page);
  await page.locator('#idEditFieldChargeToAccount').fill(value);
  await pace(page);
}

/** Real: `#idEditFieldPurchasingContact`, click then fill. */
export async function fillPurchasingContact(page: Page, value: string): Promise<void> {
  await page.locator('#idEditFieldPurchasingContact').click();
  await pace(page);
  await page.locator('#idEditFieldPurchasingContact').fill(value);
  await pace(page);
}

/**
 * Selected by visible label (`selectOption({ label })`), per explicit user
 * decision — the recording only captured an opaque `{AES}...` encoded
 * value, not confirmed stable across orders. The label text itself is
 * unverified against live stage MXI.
 */
export async function selectConditions(page: Page, label: string): Promise<void> {
  await page.locator('#idDropdownTermsConditions').selectOption({ label });
  await pace(page);
}

/**
 * The recording did fill then click an autocomplete suggestion
 * (`page.getByText('DCA/DOCK').click()`) — but that only exists because a
 * REAL human typing real keystrokes triggered a live AJAX suggestion
 * popup. Confirmed via screenshot: `.fill()` sets the field's value
 * directly (correctly — "CLT/DOCK" appeared exactly right in the field)
 * without firing the keyup/input events such a widget listens for, so no
 * suggestion popup ever appears — there's nothing for getByText to find,
 * and the fill alone is already correct and complete. Removed the click
 * rather than chase a popup that programmatic fill will never trigger.
 */
export async function fillReturnToLocation(page: Page, value: string): Promise<void> {
  await page.locator('#idEditFieldReturnToLocation').click();
  await pace(page);
  await page.locator('#idEditFieldReturnToLocation').fill(value);
  await pace(page);
}

/** Same label-based caveat as selectConditions. */
export async function selectTransportation(page: Page, label: string): Promise<void> {
  await page.locator('#idDropdownTransportType').selectOption({ label });
  await pace(page);
}

/**
 * Real: `#idTextAreaNoteToVendor`, filled directly. The recording's
 * CapsLock press and clipboard-paste attempt were real user-workflow
 * artifacts superseded by the final `.fill()` call in the same recording —
 * replaying the final effective action (a direct fill of the complete
 * text), not every intermediate keystroke/paste attempt.
 */
export async function fillNotesToVendor(page: Page, value: string): Promise<void> {
  await page.locator('#idTextAreaNoteToVendor').click();
  await pace(page);
  await page.locator('#idTextAreaNoteToVendor').fill(value);
  await pace(page);
}

/** Real: exact-match "OK" link that confirms/saves the Schedule Work Package form. */
export async function confirmScheduleWorkPackage(page: Page): Promise<void> {
  await page.getByRole('link', { name: 'OK', exact: true }).click();
  await pace(page);
}

/** Real: click the newly-generated order number link to navigate into it (recording line 42). */
export async function openGeneratedOrder(page: Page, orderNumber: string): Promise<void> {
  await page.getByRole('link', { name: orderNumber, exact: true }).click();
  await pace(page);
}

/** Real: `Request Authorization` link on the newly-created RO's page (recording line 43). */
export async function clickRequestAuthorization(page: Page): Promise<void> {
  await page.getByRole('link', { name: 'Request Authorization' }).click();
  await pace(page);
}

/**
 * Selected by visible label, same mechanism as selectConditions/
 * selectTransportation. AUTH_FLOW = "Repair" (constants.ts) is now a
 * confirmed value — the recording (line 44) only captured an opaque
 * {AES}-encoded option here.
 */
export async function selectAuthFlow(page: Page, label: string): Promise<void> {
  await page.locator('#idDropdownAuthFlows').selectOption({ label });
  await pace(page);
}

/**
 * Real: the "OK" that submits the authorization request itself (recording
 * line 46) — deliberately NOT the "Issue Order" step that follows it
 * (line 47) or that button's own confirmation OK (line 48). This function
 * stops here; nothing calls Issue Order.
 */
export async function confirmAuthorizationRequest(page: Page): Promise<void> {
  await page.getByRole('link', { name: 'OK' }).click();
  await pace(page);
}

const ORDER_NUMBER_PATTERN = /^P\d{3}[A-Z0-9]{4}$/;

/**
 * REAL BUG FOUND AND FIXED via live testing, with real (if contained)
 * consequences: this originally used `.first()` on every order-number-
 * shaped link on the whole page after confirmScheduleWorkPackage() — but
 * that page is the SAME part-number-filtered grid used throughout this
 * module, which can show OTHER pre-existing orders for OTHER lines of the
 * same part number. A live test scheduling a NEW order for `MAY03-0588`
 * (which genuinely got its own new order, `P000B5NP`, confirmed via direct
 * inspection — left untouched, `OPEN`/`PENDING`) instead grabbed
 * `P000B5NM`, an unrelated PRE-EXISTING order for a different line
 * (`JUL14-3229`) that also appeared on the same page. The write-up then
 * requested authorization and confirmed the Auth Flow against THAT WRONG
 * ORDER, genuinely changing its status to `AUTH`/`APPROVED` on stage —
 * confirmed via direct inspection of the order afterward. (Contained by
 * the Issue Order boundary — that order was never issued — but a real,
 * unintended side effect on stage, not a hypothetical.)
 *
 * Fixed by scoping to the SAME row as the specific repair line just
 * scheduled (via its known-unique linkText), same ancestor-of-known-
 * unique-link technique used elsewhere in this module, instead of
 * grabbing the first order-number-shaped link anywhere on the page.
 */
export async function findGeneratedOrderNumber(page: Page, linkText: string): Promise<string | null> {
  // SYSTEMATIC AUDIT FIX: this used to call .count() immediately after
  // confirmScheduleWorkPackage's click+750ms pace — .count() never waits
  // for content, it just reports whatever currently matches. Most likely
  // real cause of a recurring production pattern (4 real 'filled'-with-
  // no-order-number rows on 2026-07-29 alone): the order-number link
  // genuinely hadn't rendered yet. See gridWait.ts's
  // waitForGeneratedOrderNumberSettled for why this deliberately does NOT
  // throw on timeout — a genuine, still-absent order number after 30s is
  // already a real, correctly-handled outcome downstream.
  await waitForGeneratedOrderNumberSettled(page, linkText, ORDER_NUMBER_PATTERN.source);

  const repairLink = page.getByRole('link', { name: linkText, exact: true });
  const targetTr = repairLink.locator('xpath=ancestor::tr[1]');
  const orderLinks = targetTr.getByRole('link', { name: ORDER_NUMBER_PATTERN });
  const count = await orderLinks.count();
  if (count === 0) return null;
  return (await orderLinks.first().innerText()).trim();
}
