# Writing business rules in this codebase

Per explicit user direction (2026-09-10): adopt a Gherkin-style
Given/When/Then shape for business-rule code going forward, for
readability and standardization — **without** adding Cucumber or any new
test-runner dependency. This repo's tests already run well on Node's
built-in `node:test` + `tsx` (`npm test`, 248 passing as of this doc);
`@cucumber/cucumber` needs its own separate runner, `.feature` files, and
step-definition wiring that don't plug into that setup, so adopting it for
real would mean maintaining two parallel toolchains for one project. The
lightweight version below gets the actual benefit (rules read like
specifications, one rule = one pure function, easy to extend) with zero new
tooling risk.

This formalizes a convention the codebase was already drifting toward —
`backend/src/inference/classifyRowAction.ts` is the clearest prior example.
Everything below just names the pattern and makes it explicit so new code
follows it on purpose rather than by accident.

## The shape

A business rule is:

1. **One pure function** — no Playwright `Page`, no DB handle, no I/O.
   Takes plain data in, returns a plain, named decision out. This is what
   makes it unit-testable in milliseconds and safe to reuse at both
   discovery-time (for a preview) and execute-time (for the real write) —
   see `returnToLocationRotation.ts`'s `nextRotationLocation` for an
   example that's genuinely called from both.
2. **A docblock written as Given/When/Then**, in that order, directly above
   the function. Not a comment restating the code — the actual business
   justification, in business language a non-engineer could follow.
3. **A named return type for the outcome**, when the rule has more than one
   possible answer (a union of string literals, not a bare `boolean`) — so
   a caller's `switch`/comparison reads as business language too.

```ts
/**
 * GIVEN a [real-world condition the rule cares about]
 * WHEN [the point in the flow this rule is evaluated]
 * THEN [the decision this rule produces, and why]
 *
 * Real example / source: [the discovery recording, user instruction, or
 * incident this rule traces back to — every rule in this codebase already
 * has to cite one; this is that citation restated as the "why"].
 */
export function ruleName(input: RelevantInput): NamedOutcome {
  ...
}
```

## Worked example (already in the codebase)

`backend/src/inference/statusRules.ts`:

```ts
/**
 * GIVEN the CRA OOR's own Order Status column
 * WHEN deciding whether to run ESD inference on a row at all
 * THEN treat "Received" as meaning the part is already back — PSA has it,
 *      so tracking an estimated ship date for it is moot. Only ever
 *      fires when a CRA OOR file was actually uploaded (this column is
 *      null otherwise).
 */
export function isOrderStatusReceived(orderStatus: string | null): boolean {
  ...
}
```

## Where this applies

New business-rule modules going forward — the kind of file that decides
*what MXI should show*, not the kind that drives Playwright to make it show
that. Concretely: `shared/chargeToAccount.ts`, `shared/shipmentMethod.ts`,
`shared/returnToLocationRotation.ts`, `inference/statusRules.ts`,
`inference/classifyRowAction.ts`, `shared/partName.ts` are all this shape
already or have been retrofitted to it. Selector/DOM-interaction files
(`selectors.ts`, `scheduleWorkPackageForm.ts`, etc.) are a different kind of
thing and don't need this — they're the *mechanism*, not the *rule*.

## Not required retroactively

Existing rule-shaped code that predates this convention doesn't need a
mass rewrite just to add Given/When/Then headers — update a file's
docblock to this shape when you're already touching it for a real reason,
not as a separate pass.
