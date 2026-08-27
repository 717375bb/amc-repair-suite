/**
 * Contract-code handling for the shared vendor-code write-up engine.
 *
 * Some lines carry a contract code in their part-details notes. Those lines
 * are NOT warranty work — they are billed against the contract — so they
 *   1. use that contract code as the Charge To Account, with the line's own
 *      CR-prefix,
 *   2. bypass the warranty flow and take REPAIR authorization,
 *   3. get issued and moved to dock, rather than stopping at
 *      authorization-only like the rest of this vendor family.
 *
 * SCOPE WIDENED 2026-08-27, per explicit user direction: "I don't want this
 * to be done per vendor. I want for each line found within non-aero repair
 * vendors to read the part details notes, and ANY part that sees the whole
 * string FOKKERPBH or PARKERCPH to use that account code."
 *
 * This replaces parkerContractCodes.ts, which keyed on a fixed list of
 * Parker vendor codes. That scoping turned out to be wrong on the facts:
 * FOKKERPBH belongs to Aerotron (2N512), not Parker. The codes travel with
 * the CONTRACT, not the vendor, so the vendor is no longer consulted at all.
 *
 * "non-aero repair vendors" is satisfied structurally rather than by a
 * check: this module is only ever called from vendorCodeWriteUp.ts. Aero
 * Repair runs through its own separate engine (writeUps/aeroRepair/) which
 * never imports this.
 *
 * Pure and separately tested: this decides a real financial account code
 * and whether a real order gets issued, so it is verified in `npm test`
 * rather than only ever observed in a live run.
 */

/**
 * The contract codes. Matched as whole words, case-insensitively — these
 * are hand-typed notes.
 */
export const CONTRACT_CODES = ['PARKERCPH', 'FOKKERPBH'] as const;
export type ContractCode = (typeof CONTRACT_CODES)[number];

/** Just the leading "CR" + digits, regardless of what follows. */
const CR_PREFIX_PATTERN = /^(CR\d+)/;

/**
 * The CR-prefix to assume when the autofilled value has no recognisable one
 * at all — same value and same reasoning as
 * chargeToAccount.ts's buildDefaultRepairChargeToAccount.
 */
const DEFAULT_CR_PREFIX = 'CR7';

/**
 * Finds a contract code in a part's receiving notes, or null.
 *
 * Whole-word matched so a longer string that merely CONTAINS the code
 * cannot trigger it — the user's wording is "sees the whole string".
 *
 * If BOTH codes appear, the FIRST one in the notes wins rather than the
 * first in this list: a note that names one code and then corrects it to
 * another reads in document order, and picking by list order would
 * silently ignore that.
 */
export function detectContractCode(receivingNotes: string | null | undefined): ContractCode | null {
  if (!receivingNotes) return null;

  let best: { code: ContractCode; index: number } | null = null;
  for (const code of CONTRACT_CODES) {
    const match = new RegExp(`\\b${code}\\b`, 'i').exec(receivingNotes);
    if (match && (best === null || match.index < best.index)) {
      best = { code, index: match.index };
    }
  }
  return best?.code ?? null;
}

/**
 * Builds the Charge To Account for a contract line: the line's own
 * CR-prefix followed by the contract code.
 *
 * CORRECTED 2026-08-27, per explicit user direction: "a mistake I made
 * yesterday, these accounts DO need the CR7/9 prefix just like normal." The
 * first implementation used the bare code with no prefix.
 *
 * Deliberately uses the LENIENT prefix extraction rather than
 * buildChargeToAccountWithSuffix. That function requires the autofilled
 * value to be exactly "<CR-prefix>ROUTINE+NONROUTINE" and THROWS otherwise
 * — and the autofilled value is already known to vary in the wild (a real
 * "CR7HMV" was hit live). Throwing there would fail a contract line over
 * the shape of a value we are about to overwrite anyway.
 */
export function buildContractChargeToAccount(currentValue: string, code: ContractCode): string {
  const match = currentValue.trim().match(CR_PREFIX_PATTERN);
  const prefix = match ? match[1] : DEFAULT_CR_PREFIX;
  return `${prefix}${code}`;
}

export interface ContractOutcome {
  /** Null when this line is an ordinary line and nothing changes. */
  contractCode: ContractCode | null;
  /** The Charge To Account to write, or null to leave the normal rule alone. */
  chargeToAccount: string | null;
}

/**
 * The whole decision, in one place.
 *
 * `currentChargeToAccount` is what MXI autofilled, and is only used to
 * carry that line's CR-prefix through.
 */
export function resolveContract(
  receivingNotes: string | null | undefined,
  currentChargeToAccount: string,
): ContractOutcome {
  const contractCode = detectContractCode(receivingNotes);
  if (!contractCode) return { contractCode: null, chargeToAccount: null };
  return { contractCode, chargeToAccount: buildContractChargeToAccount(currentChargeToAccount, contractCode) };
}
