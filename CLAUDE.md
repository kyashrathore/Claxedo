## Engineering quality

Before changing code, inspect the implementation, callers, contracts, tests, and runtime flow. Find the canonical owner, then extend, simplify, move, or fix it so the repository keeps one clear path. Reuse shared mechanisms while keeping caller-specific policy separate. Extract abstractions when they reduce future change locations or name a real concept. Give every function, file, directory, and package one clear responsibility, an accurate name, a narrow API, and the correct dependency direction. Keep related code and tests together. Preserve persisted and external contracts when required. Work in complete, reviewable slices; remove replaced paths; and verify behavior through focused tests, typechecks, builds, repository searches, and real public entrypoints.

## Honest completion

Treat work as complete when the implemented behavior satisfies the goal through real entrypoints and acceptance checks. Keep tests meaningful: exercise the actual implementation, preserve useful coverage, and investigate failures rather than shaping the test around the result. Use canonical data and events from their authoritative producer. Keep one implementation per responsibility and finish migrations by removing obsolete routes, flags, helpers, and temporary paths. Fallback and backward compatibility require an explicit user request. Verify the positive flow and relevant negative flows, including failure, recovery, persistence, security, and isolation. Report the exact commands run and their outcomes. When an environment or dependency is unavailable, identify the unverified acceptance criterion directly. Keep plans and documentation aligned with live code. Finish every requirement that can be completed; for anything blocked, state the unmet requirement, evidence, blocker, owner, and concrete follow-up.

## Comments

A comment may only say something the code cannot say: a constraint, a failure mode, a platform or library behavior invisible at the call site, an ordering invariant, a measured number, or why the obvious simpler approach fails. Before writing one, delete it and ask whether reading the code loses anything. If not, leave it deleted.

Do not write a restatement of the identifier or the next statement, a section banner or group label, a narration of the test step below it, the history of what the code used to do, a plan or ticket or rubric number, a `file.ts:123` citation, or a defence addressed to a reviewer. A file header that documents the system rather than the file is the same defect at scale. Tool directives a script actually reads are not comments in this sense and stay.

When changing code that carries a comment, rewrite the comment from the new code rather than editing the old sentence; editing preserves the old shape and is how history narration accumulates. Never explain what changed. Write the number, not the fact that you measured. A comment that contradicts the code is a defect to fix on sight, ahead of any cleanup, because it is the only kind that costs a debugging session.

## Architecture ratchets

Run `bun run test:architecture-ratchets` before completing any change that adds, removes, or redirects a production import. The pre-push hook runs this command after typecheck so deterministic closure drift fails locally instead of in CI.

When a ratchet fails, do not blindly raise a ceiling or baseline. First identify the newly reachable module and its dependency chain, then remove an accidental edge or reuse the canonical owner. If the dependency is intentional, run the affected product's full `verify:closure`, raise only the exact measured ceiling with no headroom, and update the adjacent comment to name the reviewed owner and why it belongs in that product. Never hide a dependency from the scanner with an opaque dynamic import.

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
