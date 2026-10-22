## Engineering quality

Before changing code, inspect the implementation, callers, contracts, tests, and runtime flow. Find the canonical owner, then extend, simplify, move, or fix it so the repository keeps one clear path. Reuse shared mechanisms while keeping caller-specific policy separate. Extract abstractions when they reduce future change locations or name a real concept. Give every function, file, directory, and package one clear responsibility, an accurate name, a narrow API, and the correct dependency direction. Keep related code and tests together. Preserve persisted and external contracts when required. Work in complete, reviewable slices; remove replaced paths; and verify behavior through focused tests, typechecks, builds, repository searches, and real public entrypoints.

Learn the patterns in nearby code before adding a new implementation, including why those patterns exist. Look for existing code to extend or improve, and extract an abstraction when it gives repeated behavior one clear owner. Remove duplication, obsolete branches, and superseded code as part of the change. Aim for fewer concepts and fewer places to change; reduce lines by simplifying the design, never by compressing readable code or dropping necessary behavior. Keep these improvements tied to the requested work.

## Honest completion

Treat work as complete when the implemented behavior satisfies the goal through real entrypoints and acceptance checks. Keep tests meaningful: exercise the actual implementation, preserve useful coverage, and investigate failures rather than shaping the test around the result. Use canonical data and events from their authoritative producer. Keep one implementation per responsibility and finish migrations by removing obsolete routes, flags, helpers, and temporary paths. Fallback and backward compatibility require an explicit user request. Verify the positive flow and relevant negative flows, including failure, recovery, persistence, security, and isolation. Report the exact commands run and their outcomes. When an environment or dependency is unavailable, identify the unverified acceptance criterion directly. Keep plans and documentation aligned with live code. Finish every requirement that can be completed; for anything blocked, state the unmet requirement, evidence, blocker, owner, and concrete follow-up.

## Person-facing messages

A message a person reads (an error, refusal, notice, status line or toast) is one short line: what happened and, when there is one, the one thing they can do. No second sentence restating it, no internal ids, codes, HTTP verbs or provider text, and never a second failure appended to the first: a cleanup or follow-up failure goes to logs and telemetry, not into the reason. Detail a person may need sits behind an expandable view, not in the line.

## Validation cadence

During implementation, run only targeted tests and checks for the behavior being changed. Once all requested implementation work is finished and ready for final verification, run the applicable broader suites, corpus, typechecks, and architecture checks once. Do not run broad validation after each edit or run fixed repetition loops. If final validation fails, investigate and rerun only the affected tests or checks after fixing the cause; repeat a broader suite only when evidence shows the fix affects it. This cadence applies to package-level validation requirements too.

Benchmarks and performance measurement are not routine completion requirements, including during final verification. Run them only when the user requests benchmarking or performance measurement. Benchmark documentation and driver instructions are reference material for that work, not a requirement to run benchmarks for other changes.

## Architecture ratchets

Know these limits before writing code, not from a failing check:

- **File size.** A maintained source file stays at or under 800 lines. Tests, e2e, fixtures, `test-support`, locales, `.d.ts` and `packages/ui` are not counted. Files already over it have an exact ceiling in `script/file-size/ceilings.json` that may only fall. Before adding to a file near the limit, plan the split.
- **App line budgets.** `packages/claxedo-app` has a per-area budget and a total in `packages/claxedo-app/scripts/checks/budget.ts`, plus its own file (300), function (40) and component (120) limits and a no-comments rule in `packages/claxedo-app/AGENTS.md`.
- **Product closures.** Each shipped product has a module and package ceiling in `script/product-boundary/policies/*.ts` (`ceilings: { modules, packages }`), and the server's Worker entries are also pinned in `packages/claxedo-server/src/deployments/deployment-closures.test.ts`. A new file imported by Worker, desktop, connector or local-server code raises that product's module count by one; a new npm import raises its package count. Prefer extending an existing module in the product's closure over adding one, and check the policy's `forbiddenModules` and `forbiddenPackages` before importing across packages.
- **Helpers.** `script/helpers/verify.ts` refuses redefining a name a canonical module owns (`script/helpers/canonical.json`), a new divergent copy of an already-duplicated helper name, and drift between declared twins. Search for the existing helper before writing a guard, parser or retry helper.
- **Others in the same command:** every package whose bun tests call `mock.module` runs them with `--isolate`; `@claxedo/cli`'s npm install closure may not gain a native compile step (`script/install-steps`); deadlines use the referenced-timer helper; session-core stays free of Node imports.

Run `bun run test:architecture-ratchets` before completing any change that adds, removes, or redirects a production import. The pre-push hook runs this command after typecheck so deterministic closure drift fails locally instead of in CI.

When a ratchet fails, do not blindly raise a ceiling or baseline. First identify the newly reachable module and its dependency chain, then remove an accidental edge or reuse the canonical owner. If the dependency is intentional, run the affected product's full `verify:closure`, raise only the exact measured ceiling with no headroom, and update the adjacent comment to name the reviewed owner and why it belongs in that product. Never hide a dependency from the scanner with an opaque dynamic import.

When a file-size ratchet fails (the 800-line production budget or a reviewed per-file ceiling), treat it as a design signal, not a line-count problem. Ask how the file can become modular: name the responsibilities it holds, find the ones that are separate concepts or already have an owner, and split the file along them into several files with narrow APIs. Never shrink a working system to fit the number by joining lines, deleting comments or blank lines, inlining helpers, or shortening names, and never raise the ceiling instead of splitting.

## Explanations and summaries

Start with the direct answer, then build the mental model from the real code flow.
Begin with the user action or system event that starts the behavior.
Trace execution in order using exact repository names for components, functions, services, events, and files.
Use nested labels when they make ownership and calls easier to follow.
For example: `A. WorkspaceSidebar → A.1 WorkspaceList → A.1.1 useWorkspaces()`.
Continue through the real boundary: `useWorkspaces()` calls `workspace.list`, which reads `WorkspaceStore`.
For each step, explain what it receives, what it does, what it returns, and what runs next.
Include meaningful branches in place: “If cached, return it; otherwise fetch it.”
Identify where state lives and which component is authoritative for it.
Trace the result back to the UI, client, or original caller.
Explain relevant failure, disconnection, retry, and recovery behavior in the same flow.
Clearly distinguish observed code, evidence-based inference, and proposed behavior.
Explain the current flow completely before explaining a change.
Then name the precise change point: “A.1.1 changes from X to Y because Z.”
State which surrounding steps and contracts remain unchanged.
Separate distinct user flows instead of merging them into one abstraction.
Introduce a new term only when it names a necessary concept, and label proposed terms explicitly.
Use diagrams as optional summaries after the plain-English flow is understandable.
Keep the first explanation concise, then add depth through concrete causality and code references.
End with the user-visible result, why the change helps, and any meaningful downside.
