/**
 * CLAUDE_CODE_PROMPT (ESD Finder — "if status is received, ignore",
 * 2026-09-09) — per explicit user direction, styled the same way
 * classifyRowAction.ts expresses its own business rules: a small, named,
 * pure classifier rather than an inline condition buried in
 * applyInferenceRules.ts.
 *
 * "Status" here is the CRA OOR's own `Order Status` column (`orderStatus`
 * on InferenceRecord/BaseFields) — PSA's own record of where the order
 * stands — not the vendor's free-text `Current Status`. Order Status
 * saying "Received" means PSA has already received the part back; tracking
 * an estimated ship date for a part that's already shipped is moot. This
 * rule can only ever fire when a CRA OOR file was supplied (orderStatus is
 * null otherwise), which matches the user's own framing: CRA upload is
 * optional, and this rule is part of what makes it worth uploading.
 *
 * Deliberately word-boundary matched and case-insensitive, not an exact
 * string match — real Order Status values have been seen with surrounding
 * words/punctuation elsewhere in this codebase (see CLAUDE.md's Back Shop
 * section on why a loose substring match on "scrap" was actively
 * dangerous) — but a literal substring match on "received" carries no such
 * false-positive risk here (no known Order Status value contains
 * "received" as a sub-word of something else), so a plain case-insensitive
 * word-boundary regex is enough without needing an explicit-list approach.
 */
export function isOrderStatusReceived(orderStatus: string | null): boolean {
  if (!orderStatus) return false;
  return /\breceived\b/i.test(orderStatus);
}
