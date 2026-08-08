## Engineering quality

Before changing code, inspect the implementation, callers, contracts, tests, and runtime flow. Find the canonical owner, then extend, simplify, move, or fix it so the repository keeps one clear path. Reuse shared mechanisms while keeping caller-specific policy separate. Extract abstractions when they reduce future change locations or name a real concept. Give every function, file, directory, and package one clear responsibility, an accurate name, a narrow API, and the correct dependency direction. Keep related code and tests together. Preserve persisted and external contracts when required. Work in complete, reviewable slices; remove replaced paths; and verify behavior through focused tests, typechecks, builds, repository searches, and real public entrypoints.

## Honest completion

Treat work as complete when the implemented behavior satisfies the goal through real entrypoints and acceptance checks. Keep tests meaningful: exercise the actual implementation, preserve useful coverage, and investigate failures rather than shaping the test around the result. Use canonical data and events from their authoritative producer. Keep one implementation per responsibility and finish migrations by removing obsolete routes, flags, helpers, and temporary paths. Fallback and backward compatibility require an explicit user request. Verify the positive flow and relevant negative flows, including failure, recovery, persistence, security, and isolation. Report the exact commands run and their outcomes. When an environment or dependency is unavailable, identify the unverified acceptance criterion directly. Keep plans and documentation aligned with live code. Finish every requirement that can be completed; for anything blocked, state the unmet requirement, evidence, blocker, owner, and concrete follow-up.

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
