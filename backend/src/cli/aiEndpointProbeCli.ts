import 'dotenv/config';
import { checkCorporateCaCert, looksLikeTlsInterception } from '../security/corporateCaCert.js';

/**
 * `npm run diag:ai-endpoint -- [url ...]`
 *
 * Answers one question: can THIS backend, on THIS network, reach a candidate
 * AI endpoint — and if not, why not?
 *
 * Built because "the AI doesn't work" has meant four different things in
 * this project's history, each needing a different fix, and the audit trail
 * could not tell them apart until now:
 *   - the host is unreachable (network/proxy block)
 *   - TLS fails because corporate inspection re-signs with an untrusted root
 *   - the credential is rejected (401/403)
 *   - the endpoint is fine and something else is wrong
 *
 * SENDS NOTHING. No API key, no vendor notes, no request body — it opens a
 * connection, reads the status line, and hangs up. Safe to run against any
 * candidate endpoint before approval, and safe to paste the output into a
 * ticket: it contains no secrets.
 */

interface ProbeResult {
  url: string;
  dnsOk: boolean;
  tlsOk: boolean;
  httpStatus: number | null;
  /** What this outcome means, in a sentence an IT ticket can use. */
  verdict: string;
}

const DEFAULT_CANDIDATES = [
  // Azure OpenAI in a company tenant — the usual answer for on-network
  // inference. The real host is <resource>.openai.azure.com; this generic
  // one only proves whether the domain family resolves at all.
  'https://management.azure.com',
  // GitHub Copilot / GitHub Models.
  'https://api.githubcopilot.com',
  'https://models.inference.ai.azure.com',
  // The current provider, for comparison — this is the one that failed with
  // a certificate error on 2026-08-25.
  'https://api.anthropic.com',
];

async function probe(url: string): Promise<ProbeResult> {
  const result: ProbeResult = { url, dnsOk: false, tlsOk: false, httpStatus: null, verdict: '' };

  try {
    // GET with no auth and no body. A 401/403 is a SUCCESS for our purposes:
    // it proves the network path and TLS both work and the service answered.
    const response = await fetch(url, {
      method: 'GET',
      signal: AbortSignal.timeout(15_000),
    });
    result.dnsOk = true;
    result.tlsOk = true;
    result.httpStatus = response.status;
    result.verdict =
      response.status === 401 || response.status === 403
        ? `REACHABLE. Answered ${response.status} (no credential was sent, so this is the expected reply) — network and TLS are fine.`
        : `REACHABLE. Answered ${response.status} — network and TLS are fine.`;
    return result;
  } catch (err) {
    const message = err instanceof Error ? (err.cause instanceof Error ? `${err.message} <- ${err.cause.message}` : err.message) : String(err);

    if (looksLikeTlsInterception(message)) {
      result.dnsOk = true;
      result.verdict =
        `TLS REJECTED — corporate inspection is re-signing this connection with a root Node does not trust. ` +
        `The host itself is reachable. Fix: set NODE_EXTRA_CA_CERTS to the corporate root CA in PEM form. (${message})`;
      return result;
    }
    if (/ENOTFOUND|EAI_AGAIN|getaddrinfo/i.test(message)) {
      result.verdict = `DNS FAILED — this hostname does not resolve from here. Either the name is wrong or DNS is restricted. (${message})`;
      return result;
    }
    if (/ECONNREFUSED|ECONNRESET|ETIMEDOUT|timed out|aborted/i.test(message)) {
      result.dnsOk = true;
      result.verdict = `BLOCKED — the name resolves but the connection does not complete. This is what a firewall or proxy block looks like. (${message})`;
      return result;
    }
    result.verdict = `FAILED — ${message}`;
    return result;
  }
}

async function main(): Promise<void> {
  const urls = process.argv.slice(2).filter((a) => a.startsWith('http'));
  const targets = urls.length > 0 ? urls : DEFAULT_CANDIDATES;

  const cert = checkCorporateCaCert();
  console.log('=== TLS trust ===');
  if (!cert.configured) {
    console.log('NODE_EXTRA_CA_CERTS is not set. Node is using its own built-in CA list, NOT the Windows');
    console.log('certificate store — which is why a browser can reach a site this process cannot.');
  } else if (cert.usable) {
    console.log(`NODE_EXTRA_CA_CERTS loaded from ${cert.path}`);
  } else {
    console.log(`PROBLEM: ${cert.problem}`);
  }

  console.log('\n=== Endpoint reachability (no credentials, no data sent) ===');
  for (const url of targets) {
    const r = await probe(url);
    console.log(`\n${url}`);
    console.log(`  ${r.verdict}`);
  }

  console.log('\nA 401 or 403 above is a GOOD result — it means the service answered.');
  console.log('Paste this output into an IT ticket as-is; it contains no secrets.');
}

main().catch((err) => {
  console.error(err instanceof Error ? (err.stack ?? err.message) : String(err));
  process.exit(1);
});
