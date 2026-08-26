/**
 * Parker Hannifin contract-code handling.
 *
 * Per explicit user direction (2026-08-26): a few Parker lines carry a
 * contract code in their part-details notes. Those lines are NOT warranty
 * work — they are billed against the contract — so they must
 *   1. use that contract code as the Charge To Account,
 *   2. bypass the warranty flow and go through REPAIR authorization,
 *   3. be issued and moved to dock, rather than stopping at
 *      authorization-only like the rest of this vendor family.
 *
 * Pure and separately tested: this decides a real financial account code
 * and whether a real order gets issued, so it is verified in `npm test`
 * rather than only ever observed in a live run.
 */

/**
 * The real MXI vendor codes this rule applies to, per explicit user
 * direction ("for Parker Hannifin specifically"). Scoped deliberately: the
 * first implementation applied to EVERY vendor in the shared engine, so
 * any unrelated vendor whose notes happened to contain one of these
 * strings would have silently changed account code AND started issuing
 * orders that should have stopped at authorization.
 */
export const PARKER_VENDOR_CODES: readonly string[] = ['3H889', '26433', '99321', '93835', '86329'];

/**
 * The contract codes themselves. These ARE the Charge To Account value —
 * used verbatim, with no CR-prefix, per explicit user direction.
 */
export const PARKER_CONTRACT_CODES = ['PARKERCPH', 'FOKKERPBH'] as const;
export type ParkerContractCode = (typeof PARKER_CONTRACT_CODES)[number];

/** Case-insensitive vendor-code membership — registry ids are lowercased. */
export function isParkerVendor(vendorCodeOrConfigId: string): boolean {
  const normalized = vendorCodeOrConfigId.trim().toUpperCase();
  return PARKER_VENDOR_CODES.some((code) => code.toUpperCase() === normalized);
}

/**
 * Finds a contract code in a part's receiving notes, or null.
 *
 * Whole-word matched so a longer string that merely CONTAINS the code
 * cannot trigger it. Case-insensitive because these are hand-typed notes.
 *
 * If BOTH codes somehow appear, the FIRST one in the notes wins rather
 * than the first in this list — a note that mentions one code and then
 * corrects it to another reads in document order, and picking by list
 * order would silently ignore that.
 */
export function detectParkerContractCode(receivingNotes: string | null | undefined): ParkerContractCode | null {
  if (!receivingNotes) return null;

  let best: { code: ParkerContractCode; index: number } | null = null;
  for (const code of PARKER_CONTRACT_CODES) {
    const match = new RegExp(`\\b${code}\\b`, 'i').exec(receivingNotes);
    if (match && (best === null || match.index < best.index)) {
      best = { code, index: match.index };
    }
  }
  return best?.code ?? null;
}

export interface ParkerContractOutcome {
  /** Null when this line is an ordinary warranty line and nothing changes. */
  contractCode: ParkerContractCode | null;
  /** The literal Charge To Account to write, or null to leave the normal rule alone. */
  chargeToAccount: string | null;
}

/**
 * The whole decision, in one place: does this line get contract handling?
 *
 * Returns nothing-to-do unless the vendor is Parker AND a code is present.
 * Both conditions matter — see PARKER_VENDOR_CODES for why the vendor
 * check is not optional.
 */
export function resolveParkerContract(
  vendorCodeOrConfigId: string,
  receivingNotes: string | null | undefined,
): ParkerContractOutcome {
  if (!isParkerVendor(vendorCodeOrConfigId)) return { contractCode: null, chargeToAccount: null };
  const contractCode = detectParkerContractCode(receivingNotes);
  if (!contractCode) return { contractCode: null, chargeToAccount: null };
  // Used verbatim — no CR-prefix, per explicit user direction.
  return { contractCode, chargeToAccount: contractCode };
}
