## Engineering quality

Before changing code, inspect the implementation, callers, contracts, tests, and runtime flow. Find the canonical owner, then extend, simplify, move, or fix it so the repository keeps one clear path. Reuse shared mechanisms while keeping caller-specific policy separate. Extract abstractions when they reduce future change locations or name a real concept. Give every function, file, directory, and package one clear responsibility, an accurate name, a narrow API, and the correct dependency direction. Keep related code and tests together. Preserve persisted and external contracts when required. Work in complete, reviewable slices; remove replaced paths; and verify behavior through focused tests, typechecks, builds, repository searches, and real public entrypoints.

## Honest completion

Treat work as complete when the implemented behavior satisfies the goal through real entrypoints and acceptance checks. Keep tests meaningful: exercise the actual implementation, preserve useful coverage, and investigate failures rather than shaping the test around the result. Use canonical data and events from their authoritative producer. Keep one implementation per responsibility and finish migrations by removing obsolete routes, flags, helpers, and temporary paths. Fallback and backward compatibility require an explicit user request. Verify the positive flow and relevant negative flows, including failure, recovery, persistence, security, and isolation. Report the exact commands run and their outcomes. When an environment or dependency is unavailable, identify the unverified acceptance criterion directly. Keep plans and documentation aligned with live code. Finish every requirement that can be completed; for anything blocked, state the unmet requirement, evidence, blocker, owner, and concrete follow-up.

## Long-running work

Never wait on a long-running command without a progress signal you are actually reading. Before starting anything that may run for minutes, decide what its progress looks like — a line per unit of work, a growing artifact, a per-attempt diagnostic file — and watch that. If a command offers a verbose or per-step reporting flag, pass it. If its output is piped through `tail`, `grep`, or a buffering filter, you have blinded yourself: write it to a file and follow the file instead.

Set a deadline before you start, proportional to the work: a test suite is minutes, a build is minutes, a benchmark's cost is knowable from what it measures. When the deadline passes with no new progress output, stop and diagnose rather than continuing to wait. "Still running" is not progress; CPU burn is not progress. A process can spin, retry, or loop forever while looking healthy. Prove forward motion by naming the unit of work that completed since the last check.

Look for the progress record the tool already keeps. Harnesses, drivers, and builds commonly leave per-attempt state, diagnostics, or logs on disk next to their output; find them before inventing your own instrumentation. A retry loop that rewrites the same attempt directory is the signature of a stuck run, not a slow one.

Report progress in the same terms: what completed, what is in flight, and what the next observable event will be. If you cannot say what the process has finished since you last looked, say that plainly and treat it as a fault to investigate.

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
