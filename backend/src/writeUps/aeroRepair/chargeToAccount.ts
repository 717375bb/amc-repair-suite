import { CHARGE_TO_ACCOUNT_REPLACEMENT } from './constants.js';

/**
 * Matches the exact shape confirmed in the recording: a "CR"-plus-digits
 * prefix (CR9 in the recorded example; the task also names CR7 as a
 * possible variant) directly followed by "ROUTINE+NONROUTINE" — no spaces,
 * no hyphen, confirmed from the recording's own captured lookup-row text
 * ("CR9ROUTINE+NONROUTINE   Select Account", where "Select Account" is a
 * separate action label in that row, not part of the field value).
 */
const CHARGE_TO_ACCOUNT_PATTERN = /^(CR\d+)ROUTINE\+NONROUTINE$/;

/**
 * Replaces only the "ROUTINE+NONROUTINE" portion of the current
 * charge-to-account value with WHEELSBRAKES, leaving the CR-prefix
 * untouched — e.g. "CR9ROUTINE+NONROUTINE" -> "CR9WHEELSBRAKES".
 *
 * Throws rather than guessing if the current value doesn't match the
 * recorded shape exactly — a different/unexpected prefix format on some
 * order shouldn't be blindly mangled.
 */
export function buildWheelsBrakesChargeToAccount(currentValue: string): string {
  const match = currentValue.trim().match(CHARGE_TO_ACCOUNT_PATTERN);
  if (!match) {
    throw new Error(
      `Charge-to-account value "${currentValue}" did not match the expected "<CR-prefix>ROUTINE+NONROUTINE" shape confirmed from the real recording — refusing to guess a replacement.`,
    );
  }
  return `${match[1]}${CHARGE_TO_ACCOUNT_REPLACEMENT}`;
}
