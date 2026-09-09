/**
 * Generic version of aeroRepair/chargeToAccount.ts's
 * buildWheelsBrakesChargeToAccount(), parameterized by suffix so 0T1Y4 (and
 * any future vendor needing the same "<CR-prefix> + suffix" shape) doesn't
 * duplicate the regex. Aero Repair's own function is left completely
 * untouched (not rewired to call this) — its call site, behavior, and
 * verification all stay exactly as already proven, per this whole
 * refactor's "no Aero Repair behavior change as a side effect" rule.
 */
const CHARGE_TO_ACCOUNT_PATTERN = /^(CR\d+)ROUTINE\+NONROUTINE$/;

/**
 * Replaces only the "ROUTINE+NONROUTINE" portion of the current
 * charge-to-account value with the given suffix, leaving the CR-prefix
 * untouched — e.g. suffix "REPAIR": "CR9ROUTINE+NONROUTINE" ->
 * "CR9REPAIR". Throws rather than guessing if the current value doesn't
 * match the expected shape (e.g. it's already been transformed by a prior
 * real write — a genuinely different, unrecognized starting state that
 * should never be blindly mangled).
 */
export function buildChargeToAccountWithSuffix(currentValue: string, suffix: string): string {
  const match = currentValue.trim().match(CHARGE_TO_ACCOUNT_PATTERN);
  if (!match) {
    throw new Error(
      `Charge-to-account value "${currentValue}" did not match the expected "<CR-prefix>ROUTINE+NONROUTINE" shape — ` +
        `refusing to guess a replacement.`,
    );
  }
  return `${match[1]}${suffix}`;
}

/** Just the leading "CR" + digits, regardless of what (if anything) follows. */
const CR_PREFIX_PATTERN = /^(CR\d+)/;

/** Per explicit user instruction (2026-08-14): the CR-prefix to assume when the autofilled value has no recognizable CR-prefix at all. */
const DEFAULT_CR_PREFIX = 'CR7';

/**
 * CLAUDE_CODE_PROMPT (charge-to-account default rule, 2026-08-14) — per
 * explicit user instruction: "the removal site" can leave a genuinely
 * different charge-to-account value autofilled depending on where the part
 * was removed, not just the "<CR-prefix>ROUTINE+NONROUTINE" shape
 * buildChargeToAccountWithSuffix above requires exactly (real example hit
 * live on stage: "CR7HMV"). Unless a vendor is explicitly stated
 * otherwise, this suite should always land on "<CR-prefix>REPAIR" — the
 * ONLY two exceptions are Aero Repair's WHEELSBRAKES flow (a wholly
 * separate module, aeroRepair/chargeToAccount.ts, untouched by this) and
 * the Collins vendor (76863's own fixed COLLINSDISPATCH100 suffix, still
 * routed through the strict buildChargeToAccountWithSuffix above — see
 * vendorCodeWriteUp.ts's dispatch on config.form.chargeToAccountSuffix).
 * Every other vendor in this shared engine uses this function instead:
 * extracts just the leading CR-prefix if one is present (no longer
 * requires the exact "ROUTINE+NONROUTINE" tail), and defaults to "CR7" —
 * never throws — if the autofilled value has no recognizable CR-prefix at
 * all (blank, or some other unrecognized shape).
 */
export function buildDefaultRepairChargeToAccount(currentValue: string): string {
  const match = currentValue.trim().match(CR_PREFIX_PATTERN);
  const prefix = match ? match[1] : DEFAULT_CR_PREFIX;
  return `${prefix}REPAIR`;
}

/**
 * CLAUDE_CODE_PROMPT (HMV base account codes, 2026-09-10) — per explicit
 * user direction: a part coming OUT OF one of these bases bills to an HMV
 * account rather than the ordinary `<CR-prefix>REPAIR`.
 *
 * The value is the segment appended after "HMV". NQA and QRO carry their
 * own station name (CR7HMVNQA, CR7HMVQRO); CKB and TUS deliberately do
 * NOT — "CKB doesn't use its name in its account code", and TUS was
 * confirmed the same way. That asymmetry is real, not an oversight, which
 * is exactly why it's spelled out per-base here rather than derived by a
 * rule that would silently invent "CR7HMVCKB".
 *
 * These are the same four bases `approvedLocations.ts` calls
 * CLT_ROUTED_BASES (they're handled out of CLT). Kept as its own table
 * rather than imported from there because the two facts are independent:
 * where a base's orders are CREATED is a routing decision, what account
 * they BILL to is a finance decision, and a future change to one must not
 * silently move the other.
 */
const HMV_ACCOUNT_BASES = new Map<string, string>([
  ['NQA', 'NQA'],
  ['QRO', 'QRO'],
  ['CKB', ''],
  ['TUS', ''],
]);

/** True if this base station bills to an HMV account instead of the default REPAIR one. */
export function isHmvAccountBase(baseStation: string | null | undefined): boolean {
  if (!baseStation) return false;
  return HMV_ACCOUNT_BASES.has(baseStation.trim().toUpperCase());
}

/**
 * Builds the HMV charge-to-account for a base station in HMV_ACCOUNT_BASES,
 * preserving whatever CR-prefix MXI autofilled (CR7/CR9/...) exactly as
 * buildDefaultRepairChargeToAccount does — same lenient extraction, same
 * CR7 fallback, and the same never-throws-on-an-odd-autofill behavior,
 * since a real "CR7HMV" has already been seen live in that field.
 *
 * Throws only if called with a base that isn't an HMV base at all — that's
 * a caller bug, not a data condition, and guessing an account code for an
 * arbitrary station is precisely what must never happen.
 */
export function buildHmvChargeToAccount(currentValue: string, baseStation: string): string {
  const normalized = baseStation.trim().toUpperCase();
  const baseSuffix = HMV_ACCOUNT_BASES.get(normalized);
  if (baseSuffix === undefined) {
    throw new Error(
      `buildHmvChargeToAccount called with base station "${baseStation}", which is not an HMV-account base ` +
        `(${[...HMV_ACCOUNT_BASES.keys()].join(', ')}) — refusing to invent an account code.`,
    );
  }
  const match = currentValue.trim().match(CR_PREFIX_PATTERN);
  const prefix = match ? match[1] : DEFAULT_CR_PREFIX;
  return `${prefix}HMV${baseSuffix}`;
}
