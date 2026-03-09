# WorkGraph: Pending Work

Status snapshot as of 2026-03-10. 645 tests pass across 56 files.

---

## Completed Tasks

The following tasks from the original list have been completed:

- **TASK-01** — Fixed self-referencing import in workgraph-bridge.ts (uses relative imports now)
- **TASK-02** — Fixed tsconfig.json (removed stale references, fixed rootDir)
- **TASK-03** — Fixed all test imports to use new subdirectory paths
- **TASK-04** — Replaced all @opencode-ai/orchestrator-* imports with relative paths
- **TASK-05** — Fixed src/model/ imports (workgraph.ts, hooks.ts use relative paths)
- **TASK-06** — Deleted team/handoff reducers, tests, and schema tables
- **TASK-07** — Deleted decision/lead/message reducers, tests, and schema tables
- **TASK-08** — Deleted planning reducer and test
- **TASK-09** — Removed team_id, replaced DecomposedTask with TaskInfo, added role field
- **TASK-10** — Deleted capability packs (execution, research, ux) and tests
- **TASK-11** — Deleted renderers (html-brief, markdown) and tests
- **TASK-13** — Removed artifacts_current from schema
- **TASK-16** — Created .dev-docs/@tests.md

---

## Remaining Work

### TASK-12: Wire connectors into app or delete them

**Status:** Connectors exist with passing tests but are not wired into the app.
**Current state:** `src/connectors/github/`, `src/connectors/jira/`, `src/connectors/linear/` exist with working test suites. Hydration routes in `src/routes/hydration.ts` exist but don't instantiate connectors.

**Decision needed:**
- **(A) Keep and wire:** Register connectors in a service so hydration routes use them.
- **(B) Delete:** Remove connector directories + tests. Hydration routes become stubs.

---

### TASK-14: Implement upstream scratchpad injection in executor

**Status:** Not implemented.
**Spec reference:** SPEC.md Section 7.4 — `collectUpstreamScratchpads`
**What:** The executor's `spawnTaskAgent` function (in `src/orchestrator/executor.ts`) currently reads only the node's own scratchpad entry for its prompt. It should also gather scratchpad entries from completed upstream dependencies and include them in the task agent's prompt.

**Note:** The MCP `read_scratchpads` tool already does this when a task agent calls it explicitly — this task is about auto-injecting upstream context into the initial prompt so agents don't have to call `read_scratchpads` manually.

**Files:**
- `src/orchestrator/executor.ts` — in `spawnTaskAgent()`, after reading the node's own scratchpad, query upstream dependency scratchpads and append to the prompt.

**Test:** The e2e test suite (`test/integration/e2e-mcp-orchestration.test.ts`) already tests scratchpad communication via explicit tool calls. A new test should verify that the executor's spawned prompt includes upstream scratchpad content automatically.

---

### TASK-15: Wire skill file loading into agent prompts

**Status:** Partial — skill files exist, loading not wired.
**Current state:** `skills/` directory contains 6 files: `architect.md`, `developer.md`, `code_reviewer.md`, `qa.md`, `pm.md`, `designer.md`. These are not loaded or injected into agent prompts.

**What:** When the executor spawns a task agent, load `skills/{role}.md` and prepend it to the agent's system prompt.

**Files:**
- `src/orchestrator/executor.ts` — in `spawnTaskAgent()`, read the skill file for the node's role and prepend to `taskPrompt`.

**Test:** Unit test: loading a skill file returns its content. Integration test: spawned agent prompt contains skill file content.

---

### TASK-17: Fill remaining integration test gaps

**Status:** Partial — e2e suite covers most scenarios, some gaps remain.
**Already covered by `test/integration/e2e-mcp-orchestration.test.ts` (35 tests):**
- Full plan → execute → complete cycle
- Failure cascade (max retries → downstream nodes fail)
- Retry then success
- Scratchpad communication (via explicit MCP tool calls)
- Cancel mid-execution
- Concurrent runs
- Event audit trail

**Still missing:**
- Automatic upstream scratchpad injection in executor prompt (requires TASK-14)
- Skill file loading per role in executor prompt (requires TASK-15)
- Concurrency limit test: exceed `maxActivePerRun` → verify queuing

---

### TASK-18: Clean up stale collaboration tests

**Status:** Partial — deleted reducer tests cleaned, collaboration tests still reference team model.
**Files:**
- `test/integration/collaboration-flow.test.ts` — still references `teamId` in message payloads. Needs rewrite to use role-based scratchpad model, or delete if collaboration tests are no longer relevant.

---

## Task Dependency Graph

```
TASK-12 (connectors: wire or delete) — independent, decision needed

TASK-14 (auto scratchpad injection) ──→ TASK-17 (remaining integration tests)
TASK-15 (skill file loading)        ──→ TASK-17 (remaining integration tests)

TASK-18 (collaboration test cleanup) — independent
```
