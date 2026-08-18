import type { Locator } from 'playwright';

export interface RemovalTaskInfo {
  /** The row's real "Removal Information > Task > Name" — see extractRemovalTaskInfo's docstring. */
  name: string | null;
  /** The row's real "Removal Information > Task > ID" — see extractRemovalTaskInfo's docstring. */
  id: string | null;
}

/**
 * Real, confirmed DOM structure (discovery-inspectRemovalInfoAndNoTask.ts,
 * direct inspection against real production line 861CA01/957, and a real
 * user-provided screenshot): a real grid row's "Removal Information >
 * Task" column is a `td.longString` cell containing
 * `<a href=".../TaskDetails.jsp?aTask=<token>">Name text</a>`, immediately
 * followed by a `td.shortString` sibling cell whose own `<a>` (same
 * `aTask=<token>`) text is the real Task ID — e.g. Name="AC service bus
 * caution message on #2 eng with apu batt charger msg", ID="TRFKE00GY46E".
 *
 * This is a DIFFERENT real field from the Work Package/Check ID (read
 * elsewhere from the Assigned Tasks tab's own title line via
 * extractWorkPackageCheckId) — confirmed distinct on the same real line
 * (Task ID "TRFKE00GY46E" vs. Check ID "TRFKE00GY4KC"). Used, per explicit
 * user instruction, as the real Ad-Hoc task name (`${name} ${id}`) when a
 * line has no task currently assigned — this data is the actual real-world
 * removal reason, not a template/administrative label.
 *
 * Best-effort: returns nulls rather than throwing if the row's shape
 * doesn't match, so a genuinely missing Removal Information task is a
 * real, later "flag as error" case, not a crash here. Confirmed present on
 * almost every real line per explicit user statement, but never assumed
 * universal.
 */
export async function extractRemovalTaskInfo(repairLinkLocator: Locator): Promise<RemovalTaskInfo> {
  return repairLinkLocator.evaluate((linkEl) => {
    const tr = linkEl.closest('tr');
    if (!tr) return { name: null, id: null };
    const nameCell = tr.querySelector('td.longString a[href*="TaskDetails.jsp"]');
    if (!nameCell) return { name: null, id: null };
    const idCell = nameCell.closest('td')?.nextElementSibling;
    const idLink = idCell?.querySelector('a[href*="TaskDetails.jsp"]');
    const name = (nameCell.textContent ?? '').trim();
    const id = (idLink?.textContent ?? '').trim();
    return { name: name || null, id: id || null };
  });
}

export type PreferredVendorIndicatorState = 'preferred' | 'not_preferred' | 'not_found';

/**
 * Preferred-vendor check (all vendors except Aero Repair) — real, confirmed
 * HTML: `<td class="checkbox"><input disabled checked type="CHECKBOX"
 * name=""></td>`. The per-line hashed `td` id is NOT stable and must not be
 * used; the stable anchor is the parent cell's own `class="checkbox"`.
 * Read-only: the input is `disabled`, this never clicks it. Scoped to the
 * SAME row as the given repair-link locator, mirroring
 * extractRemovalTaskInfo's own row-scoping technique — the checkbox exists
 * exactly once per line, so this row scope already isolates it with no
 * disambiguation needed.
 *
 * Tri-state, never a boolean default: 'preferred' (checked attribute
 * present), 'not_preferred' (checkbox found but unchecked — another vendor
 * is preferred for this part, a legitimate business outcome), or
 * 'not_found' (the row has no such cell at all — a genuinely
 * indeterminate read that callers must raise as an explicit exception
 * rather than silently treating as "not preferred"). Never inferred from
 * absence/timeout — this is a single definitive DOM read.
 */
export async function readPreferredVendorIndicator(repairLinkLocator: Locator): Promise<PreferredVendorIndicatorState> {
  return repairLinkLocator.evaluate((linkEl) => {
    const tr = linkEl.closest('tr');
    if (!tr) return 'not_found';
    const checkbox = tr.querySelector('td.checkbox > input[type="CHECKBOX"]') as HTMLInputElement | null;
    if (!checkbox) return 'not_found';
    return checkbox.checked ? 'preferred' : 'not_preferred';
  });
}
