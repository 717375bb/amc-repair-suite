import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/**
 * Finds the synced BackShopListing.xlsm on this machine.
 *
 * The library is synced from SharePoint rather than reached through the
 * Graph API, per explicit user choice — that means no Azure app
 * registration, no IT admin consent and no stored mail/site credentials,
 * the same reasoning that put this project on Outlook COM instead of Graph.
 * Once synced it is an ordinary local file.
 *
 * CONFIRMED PATH (2026-08-27), after the user clicked Sync:
 *   C:\Users\<user>\American Airlines, Inc\CRA - CRA Team\BackShopListing.xlsm
 *
 * Note the sync root is `American Airlines, Inc`, NOT the pre-existing
 * `OneDrive - American Airlines, Inc` — that one holds only Favorites and
 * is a different thing. Both are searched anyway rather than hard-coding
 * the one observed today, since a different user or a re-sync can land it
 * under either.
 */

export const BACK_SHOP_FILE_NAME = 'BackShopListing.xlsm';

/** Overrides discovery entirely — for a machine that syncs somewhere unusual. */
const ENV_OVERRIDE = 'BACK_SHOP_LISTING_PATH';

/** Sync roots to search, in preference order. */
function candidateRoots(): string[] {
  const home = os.homedir();
  return [
    path.join(home, 'American Airlines, Inc'),
    path.join(home, 'OneDrive - American Airlines, Inc'),
    path.join(home, 'OneDrive'),
  ];
}

export interface BackShopFileLocation {
  filePath: string;
  /** Where it came from, so the UI can say whether it is the live synced copy. */
  source: 'env' | 'synced';
}

/**
 * Walks a sync root looking for the workbook.
 *
 * Bounded depth: a synced library nests a couple of folders deep at most,
 * and an unbounded walk of a OneDrive root can be enormous. Returns the
 * first match rather than trying to disambiguate — a second copy in a
 * different library would be a real ambiguity worth a human, but has not
 * been observed, and guessing between them silently would be worse than
 * taking the shallowest.
 */
function findUnder(root: string, maxDepth = 3): string | null {
  if (!fs.existsSync(root)) return null;
  let frontier: Array<{ dir: string; depth: number }> = [{ dir: root, depth: 0 }];

  while (frontier.length > 0) {
    const next: Array<{ dir: string; depth: number }> = [];
    for (const { dir, depth } of frontier) {
      let names: string[];
      try {
        names = fs.readdirSync(dir);
      } catch {
        continue; // unreadable folder (permissions, an offline placeholder)
      }

      for (const name of names) {
        const full = path.join(dir, name);
        // REAL BUG FOUND AND FIXED (2026-08-27): this used readdirSync's
        // Dirent flags, and a OneDrive-synced library folder is a REPARSE
        // POINT — `isDirectory()` reports FALSE for it (it is a link), so
        // the walk skipped straight past "CRA - CRA Team" and reported the
        // workbook missing while it was plainly sitting there.
        //
        // statSync FOLLOWS the reparse point, so it answers the question
        // actually being asked: "is there a directory/file at the other end
        // of this?" Same reason files are checked this way — a cloud-only
        // placeholder is not a plain file either.
        let stat: fs.Stats;
        try {
          stat = fs.statSync(full);
        } catch {
          continue; // a link to something not currently available locally
        }

        if (stat.isFile() && name.toLowerCase() === BACK_SHOP_FILE_NAME.toLowerCase()) return full;
        if (stat.isDirectory() && depth < maxDepth) next.push({ dir: full, depth: depth + 1 });
      }
    }
    frontier = next;
  }
  return null;
}

/**
 * The synced workbook, or null if it isn't on this machine.
 *
 * Null is a normal answer, not a failure: the UI falls back to letting the
 * analyst drop the file in, which is the other half of the "both" choice.
 */
export function findSyncedBackShopListing(): BackShopFileLocation | null {
  const override = process.env[ENV_OVERRIDE]?.trim();
  if (override) {
    return fs.existsSync(override) ? { filePath: override, source: 'env' } : null;
  }
  for (const root of candidateRoots()) {
    const hit = findUnder(root);
    if (hit) return { filePath: hit, source: 'synced' };
  }
  return null;
}

/** How old the synced copy is, so a stale sync is visible alongside the sheet's own date. */
export function fileModifiedAt(filePath: string): Date | null {
  try {
    return fs.statSync(filePath).mtime;
  } catch {
    return null;
  }
}
