import 'dotenv/config';
import { createReadyMxiClient } from './mxiWriter/cliMxiClient.js';
import type { MxiClient } from './mxiWriter/mxiClient.js';
import { parseEnvFlag } from './mxiWriter/parseEnvFlag.js';
import { findOrderByNumber, navigateToOrder, readEsdField, readNoteToReceiver } from './mxiWriter/selectors.js';
import { writeEsdAndNotes } from './mxiWriter/writeEsdAndNotes.js';

/**
 * Read-write smoke test: logs in, reads the current RO ESD (and, if a note
 * argument is given, the current Notes to Receiver) for one order, writes
 * the new value(s) via the combined writeEsdAndNotes(), and prints the
 * original ESD clearly so THAT field can be manually reverted afterward.
 * writeEsdAndNotes() re-reads and confirms internally; running
 * `npm run mxi:read-esd -- <orderNumber>` afterward gives a fully
 * independent second check (no shared code path).
 *
 * Notes to Receiver is NOT revertible the same way: it's a real
 * accumulating log on stage orders (confirmed via Part B research), and
 * `noteText` here is the ONE NEW entry to append, not the full field value —
 * writeEsdAndNotes()/updateNoteToReceiver() append it to whatever's already
 * there rather than overwriting. There is no "put it back" for an appended
 * log entry the way there is for a single-value field like ESD, so this
 * script only prints the original note for reference, not a revert command.
 *
 * Direct, one-order-at-a-time CLI invocation — NOT wired into the
 * /approve endpoint's automatic path (that's server.ts, a separate call
 * site). Defaults to stage; pass `--env production` to write to real live
 * Maintenix instead — an explicit, per-invocation opt-in, never an ambient
 * default, since this tool writes for real.
 *
 * Usage: npm run mxi:write-esd -- <orderNumber> <newDate> [noteText] [--env production]
 *   newDate format: DD-MMM-YYYY (e.g. 08-JUL-2026)
 *   noteText is optional — omit it to exercise the ESD-only path (still
 *   through the same combined writeEsdAndNotes(), just with noteText unset,
 *   per the "one function, not two branches" design). When given, it's
 *   appended as a new entry — pass it already formatted (e.g.
 *   "7.9.26 - some note"), matching assembleNoteText()'s real convention.
 */
async function main(): Promise<void> {
  const { env, rest } = parseEnvFlag(process.argv.slice(2));
  const orderNumber = rest[0];
  const newDate = rest[1];
  const noteText = rest[2];

  if (!orderNumber || !newDate) {
    console.error('Usage: npm run mxi:write-esd -- <orderNumber> <newDate> [noteText] [--env production]');
    console.error('  newDate format: DD-MMM-YYYY (e.g. 08-JUL-2026)');
    console.error('  noteText is optional — omit to exercise the ESD-only path');
    process.exitCode = 1;
    return;
  }

  console.log(`Target MXI environment: ${env.toUpperCase()}`);

  let client: MxiClient | undefined;
  try {
    client = await createReadyMxiClient(env);

    const page = await client.getAuthenticatedPage();
    await findOrderByNumber(page, orderNumber, client.todoListUrl);
    const originalEsd = await readEsdField(page);
    console.log(`Order ${orderNumber}: current RO ESD = ${originalEsd ?? '(blank)'}`);
    console.log(`>>> ORIGINAL ESD — save this to revert: ${originalEsd ?? '(blank)'} <<<`);

    let originalNote: string | null = null;
    if (noteText) {
      await navigateToOrder(page, orderNumber, client.todoListUrl);
      originalNote = await readNoteToReceiver(page);
      console.log(`Order ${orderNumber}: current Notes to Receiver = ${originalNote ?? '(blank)'}`);
      console.log(`>>> ORIGINAL NOTE — save this to revert: ${originalNote ?? '(blank)'} <<<`);
    }

    console.log(`Writing new RO ESD: ${newDate}${noteText ? ' and new Notes to Receiver' : ''}...`);

    const result = await writeEsdAndNotes(client, orderNumber, {
      esd: newDate,
      noteText: noteText || undefined,
    });

    if (result.status === 'success') {
      console.log(`Write succeeded and was confirmed by re-reading: RO ESD is now ${newDate}.`);
      if (noteText) {
        console.log('Notes to Receiver confirmed appended — prior history verified intact.');
      }
      const envFlagSuffix = env === 'production' ? ' --env production' : '';
      console.log(`To revert the ESD: npm run mxi:write-esd -- ${orderNumber} "${originalEsd}"${envFlagSuffix}`);
      if (noteText) {
        console.log(
          `Notes to Receiver is an accumulating log — there is no revert command for the appended entry. ` +
            `Original note (for reference only, not a revert value): ${originalNote ?? '(blank)'}`,
        );
      }
    } else {
      console.error(`Write FAILED: ${result.errorMessage}`);
      console.error(`Order ${orderNumber}'s original ESD was: ${originalEsd ?? '(blank)'}`);
      if (noteText) {
        console.error(`Order ${orderNumber}'s original Note was: ${originalNote ?? '(blank)'}`);
      }
      process.exitCode = 1;
    }
  } catch (err) {
    console.error('Smoke test failed:', err instanceof Error ? err.message : String(err));
    process.exitCode = 1;
  } finally {
    await client?.shutdown();
  }
}

main();
