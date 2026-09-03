import type { Page } from 'playwright';
import { createLogger } from '../../logging/logger.js';

const log = createLogger('writeup');

const DEFAULT_WAIT_MS = 20_000;
const POLL_MS = 250;

/**
 * Clicking an MXI action link without the three failure modes that have cost
 * this project the most write-up lines.
 *
 * Measured on 2026-08-28 across the real write_up_actions error history, the
 * top locator failures were all the same shape — a bare
 * `page.getByRole('link', { name: X }).click()`:
 *
 *   7x  Timeout 30000ms waiting for getByRole('link', { name: 'Unassigned' })
 *   6x  strict mode violation: 'L00158' resolved to 2 elements
 *   5x  Timeout 30000ms waiting for getByRole('link', { name: 'SE75558' })
 *   4x  Timeout 30000ms waiting for getByRole('link', { name: 'Request Authorization' })
 *
 * What this fixes:
 *
 *  1. AMBIGUITY. Playwright's strict mode throws when a name matches more
 *     than one element. MXI routinely shows the same order number twice on
 *     one page (grid cell and header), so a perfectly correct link name
 *     fails outright. Resolved to the first match, with a warning — every
 *     observed duplicate pointed at the same target.
 *
 *  2. OPAQUE FAILURE. A 30s timeout said only "I was waiting for X" — which
 *     is why this reads to an analyst as "the button is right there and it
 *     can't see it". The failure now names every link actually on the page,
 *     so the next occurrence is diagnosable instead of anecdotal.
 *
 *  3. WASTED TIME. The default 30s applied to every miss. A genuine absence
 *     now fails in 20s, and — more importantly — callers that treat absence
 *     as a real state (see clickActionLinkIfPresent) fail in about a second.
 *
 * What this deliberately does NOT do: reload, re-navigate, or retry the
 * surrounding step. These links sit on pages reached by real, sometimes
 * order-creating actions; silently repeating navigation to "help" could
 * re-submit one.
 */

export interface ClickActionLinkOptions {
  exact?: boolean;
  timeoutMs?: number;
  /** Names the step in errors and logs, e.g. "Request Authorization". */
  label?: string;
}

/** Every link name currently on the page, for a failure that can be acted on. */
async function visibleLinkNames(page: Page): Promise<string[]> {
  try {
    return await page.evaluate(() =>
      Array.from(document.querySelectorAll('a'))
        .map((a) => (a as HTMLElement).innerText.replace(/\s+/g, ' ').trim())
        .filter((t) => t.length > 0 && t.length < 60),
    );
  } catch {
    return [];
  }
}

/**
 * Builds the failure message. Pure and exported so the wording — the thing
 * an analyst actually reads at 6am — is unit-tested.
 */
export function describeMissingLink(wanted: string, available: readonly string[]): string {
  if (available.length === 0) {
    return (
      `Could not find the "${wanted}" action, and no links could be read from the page at all — ` +
      `the page was probably still loading or had navigated elsewhere.`
    );
  }
  const unique = [...new Set(available)];
  const near = unique.filter((n) => {
    const a = n.toLowerCase();
    const b = wanted.toLowerCase();
    return a.includes(b) || b.includes(a);
  });
  const shown = unique.slice(0, 25);
  return (
    `Could not find the "${wanted}" action on this page. ` +
    (near.length > 0 ? `Closest matches present: ${near.map((n) => JSON.stringify(n)).join(', ')}. ` : '') +
    `Links actually on the page: ${shown.map((n) => JSON.stringify(n)).join(', ')}` +
    (unique.length > shown.length ? ` (+${unique.length - shown.length} more)` : '')
  );
}

/**
 * Clicks the link, or throws an error that says what was on the page instead.
 */
export async function clickActionLink(
  page: Page,
  name: string,
  options: ClickActionLinkOptions = {},
): Promise<void> {
  const { exact = false, timeoutMs = DEFAULT_WAIT_MS, label = name } = options;
  const locator = page.getByRole('link', { name, exact });

  try {
    await locator.first().waitFor({ state: 'visible', timeout: timeoutMs, });
  } catch {
    throw new Error(describeMissingLink(label, await visibleLinkNames(page)));
  }

  const count = await locator.count();
  if (count > 1) {
    // Prefer an EXACT text match over DOM order when the name is ambiguous.
    //
    // This matters concretely: Playwright's default name matching is a
    // substring, so "Unassigned" also matches the "Unassigned Tasks" tab
    // sitting next to it. Taking `.first()` there would click whichever the
    // DOM happened to list first — a silently wrong tab, which is worse
    // than the strict-mode error it replaced. An exact match is
    // unambiguously the thing the caller named.
    if (!exact) {
      const exactLocator = page.getByRole('link', { name, exact: true });
      if ((await exactLocator.count()) === 1) {
        log.info({ label, count }, '[click] ambiguous link name resolved by exact text match');
        await exactLocator.click({ timeout: timeoutMs });
        return;
      }
    }
    log.warn(
      { label, count },
      '[click] link name matched more than one element and no single exact match exists — using the first. ' +
        'Strict mode would have failed here.',
    );
  }

  await locator.first().click({ timeout: timeoutMs });
}

/**
 * Clicks the link only if it is there, and says which happened.
 *
 * For actions whose ABSENCE is a real, meaningful state rather than a fault
 * — "Request Authorization" is missing on an order that is already
 * authorized, and that is a success, not a failure (documented from real
 * behaviour in mxiWriter/priceLineSelectors.ts). Blindly clicking those
 * burns the full timeout and then reports a failure for an order that was
 * fine.
 *
 * The short default wait is deliberate: this is asking a question, not
 * insisting on an outcome.
 */
export async function clickActionLinkIfPresent(
  page: Page,
  name: string,
  options: ClickActionLinkOptions = {},
): Promise<boolean> {
  const { exact = false, timeoutMs = 5_000 } = options;
  const locator = page.getByRole('link', { name, exact });
  try {
    await locator.first().waitFor({ state: 'visible', timeout: timeoutMs });
  } catch {
    return false;
  }
  await locator.first().click({ timeout: timeoutMs });
  return true;
}
