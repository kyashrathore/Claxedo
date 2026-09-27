# `@claxedo/agent-runtime-contract`

Dependency-free canonical contracts for Claxedo agent sessions: execution
bindings, content and message shapes, capabilities, connection descriptors,
errors, file references, and the runtime event model. Every Claxedo runtime
package (`@claxedo/agent-event-runtime`, `@claxedo/agent-sdk-runtime`,
`@claxedo/workspace-runtime`) and every client that speaks to them imports
these types from here, so the wire contract has exactly one owner.

## Install

```sh
npm install @claxedo/agent-runtime-contract
```

## Usage

```ts
import { requireAgentExecutionBinding, AGENT_RUNTIME_CONTRACT_VERSION } from "@claxedo/agent-runtime-contract"

const binding = requireAgentExecutionBinding({
  sessionId: "session-1",
  workspaceId: "workspace-1",
  directory: "/work/one",
  connectionId: "native:pi",
  upstreamSessionId: "pi-1",
})
```

The package ships plain ESM plus type declarations and has no runtime
dependencies, so it loads under Node without a TypeScript loader.

## The turn fold (`@claxedo/agent-runtime-contract/turn-fold`)

How a turn's parts group, and which groups a finished turn folds behind its
"Worked for" row. It lives here so every reader of a turn's parts groups and
folds them the same way.

- Group identity uses canonical tool spellings; harness variants (`command`, `read_file`, `ls`) fold in through the contract's `canonicalToolName`, so a new spelling is added once.
- Consecutive context tools (read, list, glob, grep) fold into an "Explored" group at any length, consecutive subagent spawns into an agents group at any length (a lone spawn too: the chip row is the only shape that draws one), and a run of work tools only at two or more members. Any other part flushes all three runs. Work is named by exclusion (not context, subagent, hidden or addressed to the reader), because a list names only the tools it knows, and a missing tool breaks a run into its own row.
- A read that returned an image stays its own row: a group summarizes reads as a count, and a count cannot stand in for a thumbnail.
- A failed spawn stays renderable so it can show the tool error when no child was admitted; its outcome does not say whether a child exists. A subagent spawn is recognized by name (the contract owns the spellings), or by an MCP tool declaring task work on its input.
- A single tool is not folded: it is already one compact row, and folding hides the only actionable content behind a click. A grouped run counts as one row because it has its own disclosure.
- The turn's answer is its last text group: no harness marks which text part answers (`finish` is never set natively, `AgentStepFinishPart` never emitted), so position stands in for it; narration before the last tool call folds with the work.
- A finished turn folds its machinery (tool runs, answered questions, spawns, reasoning, narration between tools) behind "Worked for Xs", leaving the answer; an explicit toggle beats the auto-fold. A working turn gets no fold and no control: settled alone cannot tell a finished turn from one between steps. Settled is per message, so a multi-step turn reads settled from its first step. A settled turn whose parts are still pending folds on the count it will have. An interrupted or failed turn keeps the control but does not fold on its own: its rows explain what happened, and a turn opened by hand and then interrupted must still be collapsible.
- A reader's own fold hides all of the turn, open rows included; an automatic fold never takes a row the reader opened.

## Versioning

`agent-runtime-contract` rides the runtime version track with the other
runtime packages (see `script/PUBLISH-ORDER.md` in the repository). A contract
change that consumers must react to bumps `AGENT_RUNTIME_CONTRACT_VERSION`.
