/**
 * New, per VENDOR_MODULE_REFACTOR_SPEC.md section 3.3 — a three-way
 * classification of a part's own Current Usage table, additive only.
 *
 * Deliberately NOT a replacement for aeroRepair/partDetails.ts's own
 * isZeroUsage(): that function is binary (present+all-zero vs. everything
 * else) and is left byte-for-byte unchanged. This classifier exists because
 * 0T1Y4 needs a genuine third state its own recordings prove is real —
 * "table absent entirely" (confirmed for BN-prefix lines, which have no
 * usage table at all) — a state Aero Repair's real parts have never shown
 * and isZeroUsage was never designed to distinguish. Reconciling the two
 * functions' edge-case semantics (e.g. one of two expected rows missing) is
 * out of scope — forcing a shared implementation for a case never observed
 * in practice would risk changing Aero Repair's real behavior for no
 * benefit, exactly the premature-abstraction trap this refactor is meant to
 * avoid.
 */

export interface UsageParmRowLike {
  label: string;
  tsn: string;
  tso: string;
  tsi: string;
}

export type UsageTableClassification = 'present_nonzero' | 'present_all_zero' | 'absent';

const USAGE_ROW_LABELS = ['CYCLES', 'HOURS'];

/**
 * 'absent' whenever the table has zero parsed rows at all (the BN-line
 * case — no Usage Parm table exists on the page for a part with no usage
 * data). 'present_all_zero' only when BOTH expected labels (CYCLES, HOURS)
 * are present and every one of their 6 values (TSN/TSO/TSI x2) is exactly
 * 0, compared numerically so "0", "0.0", "0.00" all count. Anything else
 * present is 'present_nonzero' — including a partial read (one label found,
 * the other missing), which is deliberately NOT folded into 'absent': a
 * partial read is a different, more suspicious shape than a genuinely empty
 * table and callers should not treat it the same as a confirmed-absent one.
 */
export function classifyUsageTable(usageRows: UsageParmRowLike[]): UsageTableClassification {
  if (usageRows.length === 0) return 'absent';

  const bothLabelsPresent = USAGE_ROW_LABELS.every((label) => usageRows.some((r) => r.label === label));
  if (!bothLabelsPresent) return 'present_nonzero';

  const allZero = USAGE_ROW_LABELS.every((label) => {
    const row = usageRows.find((r) => r.label === label)!;
    return Number(row.tsn) === 0 && Number(row.tso) === 0 && Number(row.tsi) === 0;
  });

  return allZero ? 'present_all_zero' : 'present_nonzero';
}
