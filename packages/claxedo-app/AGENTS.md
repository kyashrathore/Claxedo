# Claxedo App Agent Instructions

These instructions apply to work inside `packages/claxedo-app`.

## Operating Principles

- Read current source before editing. Treat plans and goal files as intent, not
  proof.
- Keep work inside the Claxedo app unless the task clearly requires another
  package.
- Prefer improving existing modules over creating parallel systems.
- End with one canonical path per responsibility. Do not leave duplicate
  helpers, shadow routes, obsolete flags, compatibility shims, or almost-the-same
  abstractions behind.
- Keep migrations additive until consumers are moved. Delete the old path only
  after the new path owns the behavior.
- Prefer one clear function over early abstraction. Extract only when the helper
  names a real concept, hides a complex boundary, or is reused.
- Do not introduce a second source of truth for session state, commands, events,
  approvals, identity, or cached server data.
- Treat browser storage and desktop files as caches unless the server explicitly
  owns durable state.
- Do not let agents fake user input. UI, voice, remote-agent, and server-pushed
  actions should use the same typed command path.
- Record skipped verification with the reason.

## Working Loop

For each meaningful slice:

1. Inspect the real owner of the behavior.
2. Add or update focused tests for the intended behavior.
3. Implement the smallest complete change.
4. Run focused tests from `packages/claxedo-app`.
5. Run `bun run typecheck` from `packages/claxedo-app`.
6. Use browser or integration verification when routing, layout, chat, command
   dispatch, reload behavior, or visual behavior changes.
7. Look for dead, duplicate, shadow, or parallel implementations in the touched
   area and remove them when safe.
8. Record what passed and what remains risky.

## Designing `goal.md`

Keep `goal.md` thin, executable, and falsifiable.

- Start with the objective in behavior terms.
- Name the few invariants that must remain true.
- List the source paths and docs the agent should inspect first.
- Split scope into in-scope and out-of-scope work.
- Put execution steps in dependency order.
- Add only the operating rules that matter for this goal.
- Track progress with evidence: tests run, files changed, browser flows checked,
  or risks found.
- Avoid giant self-reported completion prose. If a checkbox is checked, it
  should be easy for another agent to falsify or verify.

## Parallel Agents And Workflows

Use subagents or parallel agents when work can proceed independently:

- separate implementation slices with disjoint file ownership,
- research questions that do not edit files,
- adversarial review of goal claims,
- test-quality or integration-gap review,
- browser verification while the main thread keeps coding.

Do not parallelize edits that touch the same files or depend on unresolved design
decisions. Give each agent a narrow charter, expected output, relevant paths,
forbidden areas, and a clear rule about whether it may edit files.

For Claude-style workflows, use a simple staged shape:

1. Investigate with parallel finders.
2. Verify material findings adversarially.
3. Synthesize confirmed findings into one action list.
4. Implement disjoint slices in parallel only when file ownership is clear.
5. Review the finished evidence before calling the goal done.

Use parallel tool calls for independent reads, searches, typechecks, and tests
when they cannot corrupt shared state. Do not parallelize file edits,
regeneration steps, shared-cache mutations, or commands that write the same
output.
