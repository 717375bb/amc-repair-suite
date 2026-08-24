/**
 * Unwraps the real cause out of an Anthropic SDK failure.
 *
 * WHY THIS EXISTS: a network-level failure from the SDK always arrives as
 * an `APIConnectionError` whose `message` is the literal, information-free
 * string "Connection error." Every one of the 10 real failures recorded in
 * `quote_extractions` on 2026-08-24 says exactly that and nothing more, so
 * the audit trail could not distinguish a DNS failure from a TCP reset
 * from a TLS/certificate rejection — the three cases that point at
 * completely different causes (and, on a corporate network, at completely
 * different fixes).
 *
 * Node puts the real failure in `err.cause`, often nested more than one
 * level deep (undici wraps its own socket errors), with the useful part in
 * `code` (`ENOTFOUND`, `ECONNRESET`, `ECONNREFUSED`,
 * `UND_ERR_CONNECT_TIMEOUT`, `SELF_SIGNED_CERT_IN_CHAIN`, ...). This walks
 * that chain and appends whatever it finds, so the recorded note names the
 * actual mechanism instead of restating that something went wrong.
 *
 * Deliberately additive: the original message is always kept first, so
 * nothing that already reads these strings loses information.
 */
export function describeError(err: unknown): string {
  if (!(err instanceof Error)) return String(err);

  const parts: string[] = [err.message];
  const seen = new Set<unknown>([err]);

  let current: unknown = (err as { cause?: unknown }).cause;
  // Bounded — a malformed cause chain must never spin here.
  for (let depth = 0; depth < 5 && current && !seen.has(current); depth++) {
    seen.add(current);

    if (current instanceof Error) {
      const code = (current as NodeJS.ErrnoException).code;
      const errno = (current as NodeJS.ErrnoException).errno;
      const syscall = (current as NodeJS.ErrnoException).syscall;
      const host = (current as { hostname?: string }).hostname;

      const detail = [
        code ? `code=${code}` : null,
        errno !== undefined && code === undefined ? `errno=${errno}` : null,
        syscall ? `syscall=${syscall}` : null,
        host ? `host=${host}` : null,
      ]
        .filter(Boolean)
        .join(' ');

      parts.push(detail ? `${current.message} (${detail})` : current.message);
      current = (current as { cause?: unknown }).cause;
      continue;
    }

    parts.push(String(current));
    break;
  }

  // Dedupe consecutive identical links — undici sometimes repeats a message
  // verbatim one level down, and repeating it adds nothing.
  const deduped = parts.filter((p, i) => i === 0 || p !== parts[i - 1]);
  return deduped.join(' <- ');
}
