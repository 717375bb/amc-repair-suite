import type { Page } from 'playwright';
import type { MxiClient } from '../../mxiWriter/mxiClient.js';
import { waitBeforeRetry } from '../aeroRepair/retryBackoff.js';
import { resolveAuthFlowPolicy, type ResolvedAuthFlowPolicy, type VendorConfig } from './vendorConfig.js';
import { buildChargeToAccountWithSuffix } from './chargeToAccount.js';
import { classifyUsageTable } from './usageTable.js';
import {
  readAssignedTasksAreaText,
  readUnassignedTasksAreaText,
  waitForWorkPackageDetailsResolved,
} from './taskRecovery.js';
import {
  clickScheduleWorkPackage,
  confirmScheduleWorkPackage,
  fillChargeToAccount,
  fillNotesToVendor,
  fillPurchasingContact,
  fillReturnToLocation,
  findGeneratedOrderNumber,
  openGeneratedOrder,
  readChargeToAccount,
  readCurrentLocationCode,
  selectConditions,
  selectTransportation,
  transformReturnToLocation,
} from './scheduleWorkPackageForm.js';
import { clickRequestAuthorization, confirmAuthorizationRequest, selectAuthFlow } from './authFlow.js';
import { issueGeneratedOrder, moveOutboundShipmentToDock, readOrderRealState } from './issueAndDock.js';
import { isUnassignedTaskPresent, navigateToUnassignedTasksView, closeUnassignedTasksView, waitForUnassignedTasksSectionResolved } from './unassignedTasks.js';
import { isNoTasksAssignedException } from '../aeroRepair/noTaskException.js';
import { closePartOwnDetails, openPartOwnDetails, readPartOwnDetails, type PartOwnDetails } from './partOwnDetails.js';

const CLICK_DELAY_MS = 750;
const GRID_WAIT_TIMEOUT_MS = 30_000;
const GRID_WAIT_POLL_MS = 250;
const BN_OVERRIDE_ID = 'BN_SERIAL_REPAIR_FLOW';

async function pace(page: Page): Promise<void> {
  await page.waitForTimeout(CLICK_DELAY_MS);
}

/**
 * Generalized from 0T1Y4's own module, per explicit user direction: the
 * process is genuinely identical for every vendor using this same real
 * mechanism (vendor-code search + BN-prefix override + warranty terminal
 * state) — the ONLY thing that varies is which VendorConfig is passed in.
 * 0T1Y4 was the first (and, at the time of this generalization, only)
 * real, live-proven consumer; see shared/vendorRegistry.ts for how new
 * vendors are added (a config entry, not new code).
 */

// ---- Search (moved from 0t1y4/search.ts, unchanged — already generic) ----

/**
 * Real, from discovery-0t1y4-warranty-recording.ts: Options... -> Reset
 * Filters -> the "When selected, items at USSTG" cell (confirmed REQUIRED
 * for every vendor-code search, not vendor-optional) -> #idVendorShop fill
 * -> OK. Deliberately NOT reusing aeroRepair/partDetails.ts's
 * resetOptionsFilters() — that function checks/unchecks two DIFFERENT,
 * ID-based checkboxes than this recording's own cell-based click, and
 * nothing confirms the two are the same underlying control.
 */
async function navigateToVendorCodeGrid(page: Page, todoListUrl: string, vendorCode: string): Promise<void> {
  await page.goto(todoListUrl);
  await page.getByRole('link', { name: 'Options...' }).click();
  await pace(page);
  await page.getByRole('link', { name: 'Reset Filters' }).click();
  await pace(page);
  await page.getByRole('cell', { name: 'When selected, items at USSTG' }).nth(1).click();
  await pace(page);
  await page.locator('#idVendorShop').click();
  await pace(page);
  await page.locator('#idVendorShop').fill(vendorCode);
  await pace(page);
  // REAL BUG FOUND AND FIXED, caught live in production by a read-only
  // listing diagnostic before this ever reached a write call: the raw
  // recorded getByRole('link', { name: 'OK' }) is a substring match, and
  // this same Options dialog's real page also has unrelated task links
  // whose text contains "ok" (e.g. "...broken" — br-OK-en), causing a
  // strict-mode violation. Same known issue already fixed in
  // aeroRepair/partDetails.ts's navigateToPartGridAndGetCandidates — the
  // error output confirmed the real element id is identical:
  // #idButtonOptionsOK, the same Options dialog shared by every vendor's
  // search flow.
  await page.locator('#idButtonOptionsOK').click();
  await waitForVendorCodeGridResolved(page);
}

/**
 * Content-aware wait: either a real repair-line link ("Repair ... (PN: X,
 * SN: Y)" or the BN-line variant "(PN: X, BN: Y)") or the page's own "no
 * inventory" empty-state text. Not scoped to one known part number — a
 * vendor-code search can return lines for ANY part number.
 */
export async function waitForVendorCodeGridResolved(page: Page): Promise<void> {
  const start = Date.now();
  try {
    await page.waitForFunction(
      () => {
        const hasRealRow = Array.from(document.querySelectorAll('a')).some((a) =>
          /^Repair .*\(PN: [^,]+, (?:SN|BN): [^)]+\)$/.test((a.textContent ?? '').trim()),
        );
        const bodyText = document.body?.innerText ?? '';
        return hasRealRow || bodyText.includes('no inventory');
      },
      undefined,
      { timeout: GRID_WAIT_TIMEOUT_MS, polling: GRID_WAIT_POLL_MS },
    );
  } catch (err) {
    throw new Error(
      `Vendor-code grid did not resolve to a definitive state (no real "Repair ..." line AND no "no inventory" ` +
        `empty-state text) within ${GRID_WAIT_TIMEOUT_MS}ms — refusing to treat this as a genuine empty result. ` +
        `Underlying error: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  console.log(`[grid-wait] vendor-code grid resolved in ${Date.now() - start}ms`);
}

export interface VendorCodeCandidateLine {
  partNumber: string;
  /** The real serial number, OR for a BN-prefix line, the full "BN NNNNNN" value. */
  serialNumber: string;
  linkText: string;
  /** True if this line's link text used the "BN:" label instead of "SN:". */
  isBnLine: boolean;
}

const REPAIR_LINK_PATTERN = /^Repair .*\(PN: ([^,]+), (SN|BN): ([^)]+)\)$/;

async function findCandidateLinesForVendorCodeOnce(
  page: Page,
  todoListUrl: string,
  vendorCode: string,
): Promise<VendorCodeCandidateLine[]> {
  await navigateToVendorCodeGrid(page, todoListUrl, vendorCode);

  const bodyText = await page.locator('body').innerText();
  if (bodyText.includes('no inventory')) return [];

  const repairLinks = page.getByRole('link', { name: REPAIR_LINK_PATTERN });
  const count = await repairLinks.count();

  const candidates: VendorCodeCandidateLine[] = [];
  for (let i = 0; i < count; i++) {
    const linkText = (await repairLinks.nth(i).innerText()).trim();
    const match = linkText.match(REPAIR_LINK_PATTERN);
    if (!match) continue;
    candidates.push({
      partNumber: match[1],
      serialNumber: match[3],
      linkText,
      isBnLine: match[2] === 'BN',
    });
  }
  return candidates;
}

/**
 * REAL BUG FOUND AND FIXED, discovered live in production during 0T1Y4's
 * first-ever watched run: this search had zero retry protection, unlike
 * every one of aeroRepair/batchDiscovery.ts's equivalent candidate
 * searches — the same "consistent empty read" failure class already
 * root-caused for Aero Repair (MXI server latency under real concurrent
 * load, scaled by result-set size). Fixed the same proven way: only
 * trusts an empty result once 3 consecutive attempts, with a real pause
 * between them, all agree.
 */
export async function findCandidateLinesForVendorCode(
  page: Page,
  todoListUrl: string,
  vendorCode: string,
): Promise<VendorCodeCandidateLine[]> {
  const MAX_ATTEMPTS = 3;
  let lastResult: VendorCodeCandidateLine[] = [];
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    lastResult = await findCandidateLinesForVendorCodeOnce(page, todoListUrl, vendorCode);
    if (lastResult.length > 0) return lastResult;
    if (attempt < MAX_ATTEMPTS) await waitBeforeRetry(page, attempt);
  }
  return lastResult;
}

export async function openVendorCodeCandidate(page: Page, candidate: VendorCodeCandidateLine): Promise<void> {
  await page.getByRole('link', { name: candidate.linkText, exact: true }).click();
  await pace(page);
}

/**
 * Re-checks the target candidate's own row checkbox + radio right before
 * Schedule Work Package — mirrors the real recording's post-details-close
 * re-selection. NOT reusing Aero Repair's recheckRepairLineForSchedule():
 * that function also performs routing-based vendor-BID matching, a concept
 * that doesn't exist for a vendor-code search — its candidates are already
 * uniquely identified, confirmed via both real recordings to have exactly
 * one radio per row.
 */
async function recheckCandidateForSchedule(page: Page, candidate: VendorCodeCandidateLine): Promise<void> {
  const repairLink = page.getByRole('link', { name: candidate.linkText, exact: true });
  const targetTr = repairLink.locator('xpath=ancestor::tr[1]');
  await targetTr.locator('input[name="aInventory"]').check();
  await pace(page);
  const radios = targetTr.getByRole('radio');
  if ((await radios.count()) > 0) {
    await radios.first().check();
    await pace(page);
  }
}

// ---- Notes composition (moved from 0t1y4/notes.ts, parameterized) ----

/** Confirmed correct: header line + blank line + part description + Usage Parm table. */
export function composeNotesForNormalLine(details: PartOwnDetails, notesHeader: string): string {
  const partLine = `${details.partDescription} (PN: ${details.partNumber}, SN: ${details.serialNumber})`;
  const tableHeader = 'Usage Parm\tTSN\tTSO\tTSI';
  const tableRows = details.usageRows.map((row) => `${row.label}\t${row.tsn}\t${row.tso}\t${row.tsi}`);
  return [notesHeader, '', partLine, tableHeader, ...tableRows].join('\n') + '\n';
}

/** Confirmed correct as recorded: header-only, no description line even though PN/SN are available. */
export function composeNotesForBnLine(notesHeader: string): string {
  return `${notesHeader}\n`;
}

// ---- Orchestrator (moved from 0t1y4/writeUp.ts, parameterized by config) ----

export interface VendorCodeWriteUpFields {
  partNumber: string;
  serialNumber: string;
  isBnLine: boolean;
  purchasingContact: string;
  returnToLocation: string;
  conditions: string;
  transportation: string;
  chargeToAccountBefore: string;
  chargeToAccountAfter: string;
  notesText: string;
  generatedOrderNumber: string;
  authFlow: string;
}

export type VendorCodeWriteUpOutcome =
  | { status: 'authorized_only'; fields: VendorCodeWriteUpFields }
  | { status: 'issued_and_docked'; fields: VendorCodeWriteUpFields; shipmentId: string | null }
  | { status: 'no_candidate_lines'; vendorCode: string }
  | { status: 'unassigned_task_present'; partNumber: string; serialNumber: string; taskDetail: string }
  | { status: 'no_task_found_for_bn_line'; partNumber: string; serialNumber: string }
  | { status: 'zero_usage'; partNumber: string; serialNumber: string }
  | { status: 'usage_table_absent_unexpected'; partNumber: string; serialNumber: string }
  | {
      status: 'authorization_not_confirmed';
      partNumber: string;
      serialNumber: string;
      orderNumber: string;
      realAuthorizationStatus: string | null;
    }
  | { status: 'error'; partNumber: string | null; serialNumber: string | null; errorMessage: string };

/**
 * Generic vendor-code-search write-up flow. `preferredSerialNumber` selects
 * a specific candidate (refuses to silently substitute a different line,
 * same discipline as Aero Repair's findFirstRepairLineForPart); omitted
 * picks the first candidate found for this vendor's code.
 *
 * BN-prefix lines (per resolveAuthFlowPolicy's matched override) replay
 * the BN recording's own real sequence: Create New Task -> Ad-Hoc Task
 * creation UNCONDITIONALLY right after opening the line. Normal lines
 * replay the warranty recording's own sequence: the Unassigned Tasks
 * detour, actually checked (not just clicked through) via
 * isUnassignedTaskPresent.
 *
 * Authorization-status expectations differ deliberately by flow, per
 * explicit user correction after 0T1Y4's first live runs: the BN/REPAIR
 * flow mirrors Aero Repair's own REPAIR authorization (retries seeking a
 * real, synchronous APPROVED within the session); the WARRANTY flow
 * accepts REQUESTED as its correct terminal state — the external
 * vendor/manufacturer approval that would move it to APPROVED happens
 * outside this session, on its own timeline, and retrying past REQUESTED
 * is actively wrong (the "Request Authorization" link genuinely
 * disappears once a request is already in flight).
 */
export async function runVendorCodeWriteUp(
  client: MxiClient,
  config: VendorConfig,
  preferredSerialNumber?: string,
): Promise<VendorCodeWriteUpOutcome> {
  let knownPartNumber: string | null = null;
  let knownSerialNumber: string | null = preferredSerialNumber ?? null;

  try {
    const page: Page = await client.getAuthenticatedPage();
    const vendorCode = config.search.kind === 'vendorCode' ? config.search.vendorCode : '';

    const candidates = await findCandidateLinesForVendorCode(page, client.todoListUrl, vendorCode);
    if (candidates.length === 0) {
      return { status: 'no_candidate_lines', vendorCode };
    }

    let candidate: VendorCodeCandidateLine | undefined;
    if (preferredSerialNumber) {
      candidate = candidates.find((c) => c.serialNumber === preferredSerialNumber);
      if (!candidate) {
        throw new Error(
          `Preferred serial number "${preferredSerialNumber}" was not found among ${candidates.length} candidate ` +
            `line(s) for vendor ${vendorCode} — refusing to silently process a different line instead.`,
        );
      }
    } else {
      candidate = candidates[0];
    }
    knownPartNumber = candidate.partNumber;
    knownSerialNumber = candidate.serialNumber;

    const resolved: ResolvedAuthFlowPolicy = resolveAuthFlowPolicy(candidate.serialNumber, config);
    const isBnFlow = resolved.matchedOverrideId === BN_OVERRIDE_ID;

    await openVendorCodeCandidate(page, candidate);
    await waitForWorkPackageDetailsResolved(page);

    if (isBnFlow) {
      // REAL BUG FOUND AND FIXED, discovered live via direct DOM inspection
      // after a completed BN run: this code previously assumed BN lines
      // ALWAYS have no task assigned (true for the one recorded example,
      // discovery-0t1y4-bn-recording.ts's BN 394368 line) and created an
      // Ad-Hoc task UNCONDITIONALLY, with no check. Real evidence proved
      // this wrong — BN 394600 already had a genuine, real, pre-existing
      // task ("Slats Halfspeed during T/O roll at 90 kts. B1-007813
      // TRFKE00GYRE8", ID TRFKE00GZBS4) that existed before this automation
      // ever touched the line. The unconditional Ad-Hoc creation blindly
      // added a second, wrongly-named, redundant task alongside it instead
      // of recognizing and using the real one — confirmed via
      // discovery-inspectTaskDescriptionSource.ts's direct read of the
      // Assigned Tasks tab, not assumed. Fixed by adding the exact same
      // no-tasks-assigned check every other flow in this project already
      // has (isNoTasksAssignedException) — Ad-Hoc creation only fires when
      // a task is genuinely, confirmably absent, matching the recorded
      // example's own real state; when a real task already exists, this
      // now does nothing and proceeds with the rest of the flow using it.
      // REVISED per explicit user instruction: a BN line with genuinely no
      // findable task is NOT a case to paper over with a fabricated
      // Ad-Hoc task name. The task's real name/description IS the
      // real-world removal reason — losing it isn't a formality, it's
      // losing the actual information a human needs recorded. Flag it as
      // an exception instead, same "refuse to guess" discipline used
      // everywhere else in this project (never substitute fabricated data
      // for a real value the automation couldn't confirm).
      const assignedTasksText = await readAssignedTasksAreaText(page);
      if (isNoTasksAssignedException(assignedTasksText)) {
        return {
          status: 'no_task_found_for_bn_line',
          partNumber: candidate.partNumber,
          serialNumber: candidate.serialNumber,
        };
      }
      // else: a real task already exists — do nothing, proceed with the
      // rest of the flow (still on Work Package Details from the initial
      // openVendorCodeCandidate click, same as the no-detour case below).
    } else {
      await navigateToUnassignedTasksView(page);
      await waitForUnassignedTasksSectionResolved(page);
      const unassignedTasksText = await readUnassignedTasksAreaText(page);
      if (isUnassignedTaskPresent(unassignedTasksText)) {
        await closeUnassignedTasksView(page);
        return {
          status: 'unassigned_task_present',
          partNumber: candidate.partNumber,
          serialNumber: candidate.serialNumber,
          taskDetail: unassignedTasksText,
        };
      }
      await closeUnassignedTasksView(page);
    }

    const currentLocation = await readCurrentLocationCode(page, candidate.linkText);
    const returnToLocation = transformReturnToLocation(currentLocation);

    await openPartOwnDetails(page, candidate.linkText, candidate.serialNumber);
    const partOwnDetails = await readPartOwnDetails(page, candidate.partNumber, candidate.serialNumber);
    const usageClassification = classifyUsageTable(partOwnDetails.usageRows);

    if (usageClassification === 'present_all_zero') {
      await closePartOwnDetails(page);
      return { status: 'zero_usage', partNumber: candidate.partNumber, serialNumber: candidate.serialNumber };
    }
    if (usageClassification === 'absent' && resolved.usageTableExpectation !== 'expectedAbsent') {
      await closePartOwnDetails(page);
      return {
        status: 'usage_table_absent_unexpected',
        partNumber: candidate.partNumber,
        serialNumber: candidate.serialNumber,
      };
    }

    const notesText = isBnFlow
      ? composeNotesForBnLine(config.form.notesHeader)
      : composeNotesForNormalLine(partOwnDetails, config.form.notesHeader);
    await closePartOwnDetails(page);

    await recheckCandidateForSchedule(page, candidate);
    await clickScheduleWorkPackage(page);

    const chargeToAccountBefore = await readChargeToAccount(page);
    const chargeToAccountAfter = buildChargeToAccountWithSuffix(chargeToAccountBefore, config.form.chargeToAccountSuffix);
    await fillChargeToAccount(page, chargeToAccountAfter);
    await fillPurchasingContact(page, config.form.purchasingContact);
    await selectConditions(page, config.form.conditions);
    await fillReturnToLocation(page, returnToLocation);
    await selectTransportation(page, config.form.transportation);
    await fillNotesToVendor(page, notesText);
    await confirmScheduleWorkPackage(page);

    const generatedOrderNumber = await findGeneratedOrderNumber(page, candidate.linkText);
    if (!generatedOrderNumber) {
      throw new Error(
        `No order number was found after confirming Schedule Work Package for ${candidate.partNumber}/${candidate.serialNumber}.`,
      );
    }

    await openGeneratedOrder(page, generatedOrderNumber);

    let realAuthStatus: string | null;
    if (isBnFlow) {
      const MAX_AUTH_ATTEMPTS = 2;
      let approved = false;
      realAuthStatus = null;
      for (let attempt = 1; attempt <= MAX_AUTH_ATTEMPTS; attempt++) {
        await clickRequestAuthorization(page);
        await selectAuthFlow(page, resolved.authFlow);
        await confirmAuthorizationRequest(page);

        const attemptState = await readOrderRealState(page, generatedOrderNumber, client.todoListUrl);
        realAuthStatus = attemptState.authorizationStatus;
        if (attemptState.authorizationStatus === 'APPROVED') {
          approved = true;
          break;
        }
      }
      if (!approved) {
        return {
          status: 'authorization_not_confirmed',
          partNumber: candidate.partNumber,
          serialNumber: candidate.serialNumber,
          orderNumber: generatedOrderNumber,
          realAuthorizationStatus: realAuthStatus,
        };
      }
    } else {
      await clickRequestAuthorization(page);
      await confirmAuthorizationRequest(page);

      const state = await readOrderRealState(page, generatedOrderNumber, client.todoListUrl);
      realAuthStatus = state.authorizationStatus;
      if (realAuthStatus !== 'REQUESTED' && realAuthStatus !== 'APPROVED') {
        return {
          status: 'authorization_not_confirmed',
          partNumber: candidate.partNumber,
          serialNumber: candidate.serialNumber,
          orderNumber: generatedOrderNumber,
          realAuthorizationStatus: realAuthStatus,
        };
      }
    }

    const fields: VendorCodeWriteUpFields = {
      partNumber: candidate.partNumber,
      serialNumber: candidate.serialNumber,
      isBnLine: isBnFlow,
      purchasingContact: config.form.purchasingContact,
      returnToLocation,
      conditions: config.form.conditions,
      transportation: config.form.transportation,
      chargeToAccountBefore,
      chargeToAccountAfter,
      notesText,
      generatedOrderNumber,
      authFlow: resolved.authFlow,
    };

    // Structural dispatch per VENDOR_MODULE_REFACTOR_SPEC.md section 3.2 —
    // no code path from the AUTHORIZATION_ONLY branch can reach
    // issueGeneratedOrder/moveOutboundShipmentToDock; it simply never calls
    // them, not via an early return that a future edit could bypass.
    switch (resolved.terminalState) {
      case 'ISSUE_AND_DOCK': {
        const issueResult = await issueGeneratedOrder(client, generatedOrderNumber);
        const postIssueState = await readOrderRealState(page, generatedOrderNumber, client.todoListUrl);
        if (postIssueState.orderStatus !== 'ISSUED') {
          throw new Error(
            `Order ${generatedOrderNumber} not confirmed ISSUED (real status: ${postIssueState.orderStatus ?? '(not found)'}; ` +
              `issueGeneratedOrder reported: ${issueResult.status}${issueResult.errorMessage ? ' — ' + issueResult.errorMessage : ''}).`,
          );
        }
        const dockResult = await moveOutboundShipmentToDock(client, generatedOrderNumber);
        if (dockResult.status === 'failed' || dockResult.status === 'no_outbound_shipment_found') {
          throw new Error(`Move to Dock failed for order ${generatedOrderNumber}: ${dockResult.errorMessage ?? dockResult.status}`);
        }
        return { status: 'issued_and_docked', fields, shipmentId: dockResult.shipmentId };
      }
      case 'AUTHORIZATION_ONLY': {
        return { status: 'authorized_only', fields };
      }
    }
  } catch (err) {
    return {
      status: 'error',
      partNumber: knownPartNumber,
      serialNumber: knownSerialNumber,
      errorMessage: err instanceof Error ? err.message : String(err),
    };
  }
}
