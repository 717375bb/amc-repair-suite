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
