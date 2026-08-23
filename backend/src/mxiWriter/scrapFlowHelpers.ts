import type { Page } from 'playwright';

const CLICK_DELAY_MS = 750;

export async function pace(page: Page): Promise<void> {
  await page.waitForTimeout(CLICK_DELAY_MS);
}

/**
 * Clicks a control only if it's actually there, within a short bounded
 * wait.
 *
 * The scrap recordings are full of steps the user explicitly flagged as
 * intermittent ("lines 32, 38 and 54 will not ALWAYS appear. If they do,
 * click through as I did, if they don't, move on"). Waiting the Playwright
 * default 30s for an absent dialog and then throwing is precisely the bug
 * that produced the YES-timeout failures in the ESD/price writers, so
 * every optional step in these flows goes through here.
 *
 * Returns whether it actually clicked, so callers can record which
 * branches fired rather than guessing after the fact.
 */
export async function clickIfPresent(
  page: Page,
  locator: ReturnType<Page['getByRole']>,
  timeoutMs = 6000,
): Promise<boolean> {
  try {
    await locator.first().waitFor({ state: 'visible', timeout: timeoutMs });
  } catch {
    return false;
  }
  await locator.first().click();
  await pace(page);
  return true;
}

/**
 * Answers MXI's password challenge if it appears.
 *
 * These flows prompt for it repeatedly and NOT always at the same points,
 * so it is handled as an optional step everywhere rather than assumed.
 * Both submit styles the recordings show are supported: pressing Enter in
 * the field, and clicking a separate OK button.
 */
export async function enterPasswordIfPrompted(page: Page, password: string, timeoutMs = 8000): Promise<boolean> {
  const box = page.getByRole('textbox', { name: 'Password:' });
  try {
    await box.first().waitFor({ state: 'visible', timeout: timeoutMs });
  } catch {
    return false;
  }
  await box.first().fill(password);
  await pace(page);

  // Prefer an explicit OK button when one is offered; fall back to Enter,
  // which is what several of the recorded steps used.
  const okButton = page.getByRole('button', { name: 'OK' });
  if ((await okButton.count()) > 0) {
    await okButton.first().click();
  } else {
    await box.first().press('Enter');
  }
  await pace(page);
  return true;
}

/**
 * Attaches a file to the currently-open MXI attachment form.
 *
 * Handles BOTH mechanisms rather than assuming one: a real
 * `input[type=file]` in the DOM (set directly, which works even when it's
 * hidden behind styled markup), and a click that opens the browser's file
 * chooser (intercepted via Playwright's filechooser event). The recording
 * couldn't show which applies because the file was dragged in, and drag
 * -and-drop isn't captured by codegen.
 */
export async function attachFile(page: Page, filePath: string, timeoutMs = 10_000): Promise<boolean> {
  // 1. A real file input, hidden or not.
  const fileInput = page.locator('input[type="file"]');
  if ((await fileInput.count()) > 0) {
    await fileInput.first().setInputFiles(filePath);
    await pace(page);
    return true;
  }

  // 2. A control that opens the OS file chooser when clicked.
  const trigger = page
    .getByRole('link', { name: /browse|choose|select file|attach/i })
    .or(page.getByRole('button', { name: /browse|choose|select file|attach/i }));
  if ((await trigger.count()) === 0) return false;

  try {
    const [chooser] = await Promise.all([
      page.waitForEvent('filechooser', { timeout: timeoutMs }),
      trigger.first().click(),
    ]);
    await chooser.setFiles(filePath);
    await pace(page);
    return true;
  } catch {
    return false;
  }
}

/**
 * Derives the repair/shop location a scrapped item is staged and
 * transferred to, from the inventory's current location.
 *
 * Per explicit user direction (2026-08-23): an item sitting at
 * `<BASE>/USSTG` goes to `<BASE>/REPAIR1/SHOP1`; sometimes the site only
 * has a plain `<BASE>/REPAIR`; and DAY is a known exception that goes to
 * `DAY/REPAIR2/SHOP2`.
 *
 * Returns CANDIDATES in preference order rather than one guessed string —
 * the caller picks whichever actually exists in the real location picker,
 * so a site that doesn't match the common shape fails visibly instead of
 * silently transferring to a location that isn't there.
 */
export function repairLocationCandidates(currentLocation: string): string[] {
  const base = (currentLocation.split('/')[0] ?? '').trim().toUpperCase();
  if (!base) return [];
  if (base === 'DAY') return [`DAY/REPAIR2/SHOP2`, `DAY/REPAIR1/SHOP1`, `DAY/REPAIR`];
  return [`${base}/REPAIR1/SHOP1`, `${base}/REPAIR`, `${base}/REPAIR1`];
}
