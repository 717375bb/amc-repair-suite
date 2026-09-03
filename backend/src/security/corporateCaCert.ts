import fs from 'node:fs';
import { createLogger } from '../logging/logger.js';

const log = createLogger('api');

/**
 * Reporting whether Node trusts the corporate TLS root.
 *
 * REAL BUG THIS EXISTS FOR (2026-08-28): run 31 had 241 of 2002 orders come
 * back from the Anthropic API with
 *
 *   unable to verify the first certificate (UNABLE_TO_VERIFY_LEAF_SIGNATURE)
 *
 * That is corporate SSL inspection: the proxy re-signs HTTPS traffic with an
 * internal root that Node does not ship with, so every outbound API call
 * fails even though the network itself is fine and a browser on the same
 * machine works (browsers use the Windows certificate store; Node does not).
 *
 * The fix is environmental, not code: point NODE_EXTRA_CA_CERTS at the
 * corporate root CA in PEM form. Node reads that variable ONCE at process
 * start, before any of this code runs — it cannot be set from inside the
 * program, which is exactly why this module only inspects and reports.
 *
 * Getting the PEM: ask IT for the root CA, or export it from the Windows
 * store —
 *   certutil -store root  (find the corporate root's thumbprint)
 *   certutil -store root <thumbprint> C:\path\corp-root.cer
 *   certutil -encode C:\path\corp-root.cer C:\path\corp-root.pem
 * then set NODE_EXTRA_CA_CERTS=C:\path\corp-root.pem in backend/.env and
 * restart the server.
 */

export interface CaCertStatus {
  configured: boolean;
  path: string | null;
  /** True when the path is set AND the file is readable and looks like a PEM. */
  usable: boolean;
  problem: string | null;
}

const PEM_MARKER = '-----BEGIN CERTIFICATE-----';

export function checkCorporateCaCert(): CaCertStatus {
  const path = process.env.NODE_EXTRA_CA_CERTS?.trim() || null;
  if (!path) {
    return {
      configured: false,
      path: null,
      usable: false,
      problem: null, // Not a problem in itself — only matters off-network.
    };
  }

  try {
    const contents = fs.readFileSync(path, 'utf-8');
    if (!contents.includes(PEM_MARKER)) {
      return {
        configured: true,
        path,
        usable: false,
        problem:
          `NODE_EXTRA_CA_CERTS points at "${path}", but that file contains no ${PEM_MARKER} block. ` +
          `A DER/.cer file must be converted to PEM first (certutil -encode).`,
      };
    }
    return { configured: true, path, usable: true, problem: null };
  } catch (err) {
    return {
      configured: true,
      path,
      usable: false,
      problem:
        `NODE_EXTRA_CA_CERTS points at "${path}", which could not be read: ` +
        `${err instanceof Error ? err.message : String(err)}`,
    };
  }
}

/**
 * Logs the state at startup.
 *
 * Says something in every case, including the ordinary one. A silent
 * "everything is fine" is what let 241 failed orders look like a finding
 * about vendor notes for a whole run.
 */
export function reportCorporateCaCert(): CaCertStatus {
  const status = checkCorporateCaCert();

  if (status.problem) {
    log.warn({ path: status.path }, `[tls] ${status.problem}`);
  } else if (status.usable) {
    log.info({ path: status.path }, '[tls] corporate CA bundle loaded from NODE_EXTRA_CA_CERTS');
  } else {
    log.info(
      {},
      '[tls] NODE_EXTRA_CA_CERTS is not set. If AI inference fails with ' +
        '"unable to verify the first certificate", this is what to set — see security/corporateCaCert.ts.',
    );
  }

  return status;
}

/** True when an error looks like the corporate-inspection TLS failure. */
export function looksLikeTlsInterception(message: string): boolean {
  return (
    /unable to verify the first certificate/i.test(message) ||
    /UNABLE_TO_VERIFY_LEAF_SIGNATURE/i.test(message) ||
    /self[- ]signed certificate in certificate chain/i.test(message)
  );
}
