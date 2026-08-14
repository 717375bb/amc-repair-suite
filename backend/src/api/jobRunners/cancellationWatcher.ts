import readline from 'node:readline';

/**
 * CLAUDE_CODE_PROMPT (cancel button for ESD writer / Order Write-Ups) —
 * cooperative cancellation, not OS-level process signaling. Real constraint
 * this was built around: this project runs on Windows, where
 * `ChildProcess.kill()` always force-terminates immediately regardless of
 * the signal argument (Node's own documented behavior — Windows has no
 * POSIX signal delivery) — a runner that's mid-Playwright-session would
 * have zero chance to call `client.shutdown()` before dying, risking an
 * orphaned headless Chromium process still holding a real MXI login.
 *
 * Instead, the parent (jobManager.ts's `requestCancellation`) writes a
 * single `{"type":"cancel"}` JSON line to this child's stdin. Every runner
 * that touches a real MxiClient (discovery, execute, esdWrite — not
 * esdCompare, which never opens a browser at all) calls this once at the
 * top of main() and checks the returned AbortSignal at natural loop
 * boundaries (between vendors, between lines, between orders) — never
 * mid-Playwright-action, since there's no reliable way to abort a single
 * in-flight page interaction cleanly. On seeing cancel, the runner's own
 * existing `finally { await client.shutdown() }` still runs (this is a
 * normal early-return/break out of the loop, not a forced kill), so
 * cleanup is exactly as reliable as any other exit path already is.
 *
 * `spawnRunner` still keeps a grace-period hard-kill fallback for a runner
 * that's genuinely hung and never reaches its own next checkpoint (e.g.
 * a single Playwright action stuck well past its own internal timeout) —
 * that path accepts the Windows force-kill risk as a last resort, not the
 * common one.
 */
export function watchStdinForCancellation(): AbortSignal {
  const controller = new AbortController();
  const rl = readline.createInterface({ input: process.stdin });
  // REAL BUG FOUND AND FIXED, caught live: `spawnRunner`'s stdio changed
  // from `['ignore', 'pipe', 'pipe']` to `['pipe', 'pipe', 'pipe']` so this
  // function could receive a cancel message — but a `readline.Interface`
  // reading from a piped (not ignored) stdin puts that stream into flowing
  // mode, which counts as an active handle keeping the Node event loop
  // alive. The runner's own `main()` could finish completely — real MXI
  // work done, browser genuinely closed via `client.shutdown()`, a 'done'
  // envelope emitted — and the process would STILL never exit, because
  // this open stdin listener alone kept it alive waiting for input that
  // was never coming. From the parent's side (jobManager.ts's `close`
  // handler, which is what actually marks a job finished) this looked
  // exactly like a hang: the run had genuinely completed, but the UI
  // polled forever because the child process itself never reported back.
  // Reproduced directly (spawned discoveryRunner.ts exactly as
  // jobManager.ts does): stdout showed a clean 'done' envelope, but no
  // `close` event ever fired on the child.
  //
  // `.unref()` tells Node this handle should NOT be counted toward keeping
  // the process alive — the stream can still receive and act on a real
  // cancel message while OTHER work keeps the process running (the awaited
  // MXI operations), but once that other work finishes, an unref'd stdin
  // listener no longer blocks a normal exit.
  process.stdin.unref();
  rl.on('line', (line) => {
    const trimmed = line.trim();
    if (!trimmed) return;
    try {
      const message = JSON.parse(trimmed) as { type?: string };
      if (message?.type === 'cancel') {
        console.error('[cancellation] Cancel request received — will stop at the next safe checkpoint.');
        controller.abort();
      }
    } catch {
      // A non-JSON stdin line shouldn't happen (the parent only ever writes
      // this one message shape) — ignored rather than crashing the runner.
    }
  });
  return controller.signal;
}
