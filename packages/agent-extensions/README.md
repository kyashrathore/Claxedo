# `@claxedo/agent-extensions`

Reusable agent capabilities for Codex, Claude, OpenCode, and Cursor.

Agent Extensions let a host install one package and materialize the supported
components into runner-native locations: skills, MCP server configs, and local
runner plugins where the install path is verified.

## Install

```sh
npm install @claxedo/agent-extensions
```

## Quickstart

```ts
import { createAgentExtensions } from "@claxedo/agent-extensions"

const extensions = createAgentExtensions({
  projectDir: process.cwd(),
})

await extensions.install({
  source: "acme/review-tools",
  targets: ["codex", "claude", "opencode"],
})

console.log(await extensions.list())
```

For local project packages:

```ts
await extensions.installCached({
  packagePath: "agent-extensions/review-tools",
  id: "review-tools",
  targets: ["cursor"],
})
```

## CLI

```sh
agent-extensions install acme/review-tools --targets codex,claude
agent-extensions install --path agent-extensions/review-tools --id review-tools
agent-extensions list --json
agent-extensions disable review-tools
agent-extensions enable review-tools
agent-extensions update review-tools
agent-extensions uninstall review-tools
agent-extensions doctor
```

`--cache-dir` controls durable package data: fetched package cache, machine
installs, and mirrored workspace state. `--runtime-dir` controls generated runtime
state for `materialize` and `list` output, defaulting to
`<project>/.agent-extensions`.

`materialize` remains available for first-party project extensions stored under
`agent-extensions/`:

```sh
agent-extensions materialize --targets codex,claude,opencode,cursor
```

## Package Shape

An extension package can include one or more supported components:

```text
review-tools/
  SKILL.md
  mcp.json
  .cursor-plugin/plugin.json
```

Conventional component directories are also supported by runtime replay and the
first-party `materialize` command:

```text
agent-extensions/
  skills/review/SKILL.md
  mcp/docs.json
  plugins/cursor/notes/plugin.json
```

Supported targets are:

```ts
["opencode", "claude", "codex", "cursor"]
```

## Host Integration

The package owns deterministic extension mechanics:

- source parsing and GitHub fetch/cache
- desired install state and lock files
- install/update/enable/disable/uninstall lifecycle
- policy overlay resolution
- runtime snapshot creation
- materialization and replay
- owned-artifact cleanup and conflict detection

Product hosts own authorization and orchestration:

- user and organization identity
- workspace admin checks
- catalog allowlists
- hosted persistence
- telemetry and audit
- fanout to connected workspace runtimes

Use pure policy overrides when a host has already made authorization decisions:

```ts
const snapshot = await extensions.snapshot({
  policyOverrides: [
    { id: "review-tools", scope: "workspace", enabled: false },
  ],
})
```

Then apply the snapshot in a runtime host:

```ts
import { applyRuntimeAgentExtensions } from "@claxedo/agent-extensions/replay"

await applyRuntimeAgentExtensions(snapshot, process.cwd())
```

## Safety Model

Agent Extensions keep ownership records in `.agent-extensions/materialized.json`
and refuse to overwrite unmanaged target paths. Uninstall and disable remove
only owned artifacts. GitHub packages are locked by resolved SHA and verified
against recorded package digests before replay.

Run `agent-extensions doctor` to inspect desired state, locks, cache roots, and
materialized paths.
