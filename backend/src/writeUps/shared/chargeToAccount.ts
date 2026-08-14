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
