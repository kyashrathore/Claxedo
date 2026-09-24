# Harness checks

Run `bun run check` from this package, or `bun run --cwd packages/harness check` from the repository root. `bun run test` runs the checks before the package tests. Run the fixture suite from this package with `bun test scripts`.

`scripts/check.ts` scans TypeScript and JavaScript files under `src/`, reports `path:line rule: fix`, and exits non-zero on violations. It parses with the TypeScript 5 compiler API from the `typescript-5` dev dependency, because TypeScript 7 ships no JavaScript API. Generated Codex protocol files under `src/transports/codex-app-server/{generated,generated-protocol,protocol}/` are excluded.

Every file is held to no comments, both import boundaries, no swallowed errors and the one harness table. Test code (`*.test.ts`, `test-support/`, `test-utils/`) may also import `bun:test` and `src/test-support/`. Production code alone is held to size, budget, no policy in transports, process-wide state and no polling, and only production lines count toward a budget.

Budgets live in `budget.json`. Add a transport's reviewed line budget there when adding its folder; a missing budget fails the check. Process-wide state owners are the exact backticked `src/…` paths in the `Process-wide state` section of `AGENTS.md`. Timer-loop owners are an explicit list in `scripts/check.ts` and need a reason when added.

The transport policy check treats decision strings in type nodes, and values in a variable or property named `protocol…Map` or `protocol…Mapping`, as protocol declarations. Elsewhere those literals are request decisions. Calls named like a goal loop, and title conditionals or `shouldTitle`/`decideTitle`/`generateTitle` calls outside a `naming` operation, fail. Change offending transport code instead of weakening the check.

For each new check, add a passing and a violating fixture to `scripts/check.test.ts`. The violating fixture must assert that check's rule and expected fix text.
