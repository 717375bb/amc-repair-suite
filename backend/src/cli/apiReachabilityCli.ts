import 'dotenv/config';
import dns from 'node:dns/promises';
import tls from 'node:tls';
import fs from 'node:fs/promises';
import path from 'node:path';
import Anthropic from '@anthropic-ai/sdk';
import { describeError } from '../quoteWriter/connectionErrorDetail.js';

/**
 * `npm run diag:api-reachability`
 *
 * Answers one question: when calls to the Anthropic API fail from this
 * machine, WHICH layer is failing, and does it treat a small text request
 * differently from a PDF upload?
 *
 * Built because the same five quote PDFs failed twice on the corporate
 * network (2026-08-24 14:33 and 15:04) and then succeeded on a phone
 * hotspot ten minutes later. That is a real difference between networks,
 * but the recorded evidence — the SDK's information-free "Connection
 * error." — could not say whether the cause was DNS, TCP, TLS
 * interception, or a policy rejection. It also could not say whether the
 * ESD path would have failed too, because ESD inference had not run since
 * 2026-08-19 and so was never exercised on the same network at the same
 * time.
 *
 * The two API probes are deliberately shaped like the two real callers:
 *   - TEXT  mirrors inference/anthropicProvider.ts — Haiku, a few hundred
 *     bytes, no attachment.
 *   - PDF   mirrors quoteWriter/anthropicQuoteProvider.ts — Sonnet, a real
 *     base64 quote PDF inline (tens to hundreds of KB).
 * If both fail, the block is at the host/domain level and the ESD path is
 * equally affected. If only the PDF probe fails, it is size- or
 * content-sensitive — which is the only shape that would genuinely explain
 * "quotes are blocked but ESD is not."
 *
 * Read-only and cheap: max_tokens is tiny, nothing is written to the DB,
 * no mailbox or MXI access. Safe to run on any network, any number of
 * times.
 */

const HOST = 'api.anthropic.com';

function ok(label: string, detail = ''): void {
  console.log(`  [ OK ] ${label}${detail ? ' — ' + detail : ''}`);
}
function fail(label: string, err: unknown): void {
  console.log(`  [FAIL] ${label}`);
  console.log(`         ${describeError(err)}`);
}

async function checkDns(): Promise<void> {
  console.log(`\n1. DNS — can ${HOST} be resolved at all?`);
  try {
    const addresses = await dns.lookup(HOST, { all: true });
    ok('resolved', addresses.map((a) => a.address).join(', '));
    console.log(`         servers: ${dns.getServers().join(', ')}`);
  } catch (err) {
    fail('could not resolve', err);
    console.log('         ENOTFOUND here means DNS itself is refusing the name —');
    console.log('         a domain-level block or sinkhole, not a size or content rule.');
  }
}

async function checkTls(): Promise<void> {
  console.log(`\n2. TLS — does a direct handshake to ${HOST}:443 complete, and who signed it?`);
  await new Promise<void>((resolve) => {
    const socket = tls.connect({ host: HOST, port: 443, servername: HOST, timeout: 10_000 }, () => {
      const cert = socket.getPeerCertificate();
      ok('handshake completed', `authorized=${socket.authorized}`);
      console.log(`         issuer: ${cert?.issuer?.O ?? '(unknown)'} / CN=${cert?.issuer?.CN ?? '(unknown)'}`);
      // A corporate TLS-inspecting proxy substitutes its own CA here. That
      // is the single most useful line in this whole report: if the issuer
      // is not a public CA, every request is being decrypted in transit and
      // a policy engine is deciding what passes.
      if (!socket.authorized) {
        console.log(`         NOT AUTHORIZED: ${socket.authorizationError}`);
      }
      socket.end();
      resolve();
    });
    socket.on('timeout', () => {
      console.log('  [FAIL] handshake timed out after 10s (silent drop — typical of a firewall DROP rule)');
      socket.destroy();
      resolve();
    });
    socket.on('error', (err) => {
      fail('handshake failed', err);
      console.log('         ECONNRESET/ECONNREFUSED = actively rejected (a proxy or firewall saying no).');
      socket.destroy();
      resolve();
    });
  });
}

async function checkTextCall(client: Anthropic): Promise<boolean> {
  console.log('\n3. TEXT probe — the shape the ESD inference path sends (Haiku, no attachment).');
  try {
    const started = Date.now();
    await client.messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 16,
      messages: [{ role: 'user', content: 'Reply with the single word: ok' }],
    });
    ok('call succeeded', `${Date.now() - started}ms`);
    return true;
  } catch (err) {
    fail('call failed', err);
    return false;
  }
}

async function checkPdfCall(client: Anthropic): Promise<boolean> {
  console.log('\n4. PDF probe — the shape the quote reader sends (Sonnet, real PDF inline).');
  const dir = path.join('data', 'quote-attachments');
  let pdfPath: string;
  try {
    const files = (await fs.readdir(dir)).filter((f) => f.toLowerCase().endsWith('.pdf'));
    if (files.length === 0) {
      console.log(`  [SKIP] no PDFs in ${dir} to probe with.`);
      return true;
    }
    // Largest available — the worst case for any size-based rule.
    const sized = await Promise.all(
      files.map(async (f) => ({ f, size: (await fs.stat(path.join(dir, f))).size })),
    );
    sized.sort((a, b) => b.size - a.size);
    pdfPath = path.join(dir, sized[0].f);
    console.log(`         using ${sized[0].f} (${sized[0].size} B raw, ~${Math.round((sized[0].size * 4) / 3 / 1024)} KB base64)`);
  } catch (err) {
    console.log(`  [SKIP] could not read ${dir}: ${describeError(err)}`);
    return true;
  }

  try {
    const data = (await fs.readFile(pdfPath)).toString('base64');
    const started = Date.now();
    await client.messages.create({
      model: 'claude-sonnet-5',
      max_tokens: 16,
      messages: [
        {
          role: 'user',
          content: [
            { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data } },
            { type: 'text', text: 'Reply with the single word: ok' },
          ],
        },
      ],
    });
    ok('call succeeded', `${Date.now() - started}ms`);
    return true;
  } catch (err) {
    fail('call failed', err);
    return false;
  }
}

async function main(): Promise<void> {
  console.log('Anthropic API reachability check');
  console.log('Run this on the network that is failing, then again on one that works.');
  console.log(`node ${process.version} | ${new Date().toISOString()}`);

  const proxyVars = ['HTTP_PROXY', 'HTTPS_PROXY', 'http_proxy', 'https_proxy', 'NO_PROXY', 'no_proxy']
    .map((k) => (process.env[k] ? `${k}=${process.env[k]}` : null))
    .filter(Boolean);
  // Node's built-in fetch (which the SDK uses) does NOT honour these on its
  // own. If they are set, the corporate network expects a proxy that this
  // process is not actually going through — a cause in its own right.
  console.log(
    `\n0. Proxy environment: ${proxyVars.length ? proxyVars.join(', ') + '  <-- set, but Node fetch ignores these by default' : 'none set'}`,
  );

  await checkDns();
  await checkTls();

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    console.log('\n[SKIP] ANTHROPIC_API_KEY not set — skipping the two API probes.');
    return;
  }
  // maxRetries 0: we want the FIRST real failure, not a retried summary.
  const client = new Anthropic({ apiKey, maxRetries: 0 });

  const textOk = await checkTextCall(client);
  const pdfOk = await checkPdfCall(client);

  console.log('\n--- what this means ---');
  if (textOk && pdfOk) {
    console.log('  Both shapes work from this network. Nothing is being blocked here.');
  } else if (!textOk && !pdfOk) {
    console.log('  BOTH shapes fail. The block is at the host/domain level, not about');
    console.log('  PDFs or payload size — so the ESD inference path is affected exactly');
    console.log('  the same way, and would fail here too.');
  } else if (textOk && !pdfOk) {
    console.log('  Text works, PDF does not. THIS is the only result that genuinely means');
    console.log('  "quotes are blocked but ESD is not" — something is inspecting size or');
    console.log('  document content. Check the TLS issuer above: a non-public CA means');
    console.log('  requests are being decrypted and policy-checked in transit.');
  } else {
    console.log('  PDF works but text does not — unexpected. Re-run; if it persists this');
    console.log('  is more likely transient than a policy rule.');
  }
}

main().catch((err) => {
  console.error(describeError(err));
  process.exit(1);
});
