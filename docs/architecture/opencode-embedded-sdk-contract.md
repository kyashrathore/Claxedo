# OpenCode embedded SDK contract (Unit 1)

Status: Unit 1 — one required gate FAILED, see §2.2. Cutover cannot proceed as
planned without a decision.
Pinned baseline: `@opencode-ai/sdk@0.0.0-beta-18314`
Probed on: Node v22.22.2, Bun 1.3.11, linux-x64
Planning commit: `8be1be76ce`

This document is the parity and deletion contract that gates the cutover. Every
claim below is marked `VERIFIED` (observed by running the pinned release or
reading the published artifact), `READ` (read from published typings without
executing), or `OPEN` (still a gate).

Reproduce with `packages/opencode-runtime/contract/` (see "Running the probes").

## 1. Release identity

| Fact | Value | Evidence |
|---|---|---|
| Pinned SDK | `@opencode-ai/sdk@0.0.0-beta-18314` | VERIFIED — installs from npm |
| `beta` dist-tag | resolves to the same version | VERIFIED — `npm view dist-tags` |
| `latest` dist-tag | `1.18.23` (legacy V1) | VERIFIED |
| Family pinned together | `client`, `core`, `plugin`, `schema`, `server`, `util` all `0.0.0-beta-18314` | VERIFIED — SDK `dependencies` |

`beta` is a **moving** tag and `dev` was already ahead (`0.0.0-dev-18332`) at
planning time. The lockfile pin, not the tag, is the contract.

### 1.1 Installed production closure

A clean isolated install of the pinned SDK resolves these `@opencode-ai/*`
packages (VERIFIED):

```
ai, client, codemode, core, plugin, protocol, pty, pty-linux-x64-gnu,
schema, sdk, server, simulation, util
```

**This is wider than the plan's Unit 2 collision list.** Local workspace
packages that collide with the published closure:

| Local package | Local name | In pinned closure? |
|---|---|---|
| `packages/sdk/js` | `@opencode-ai/sdk` | yes |
| `packages/core` | `@opencode-ai/core` | yes |
| `packages/server` | `@opencode-ai/server` | yes |
| `packages/plugin` | `@opencode-ai/plugin` | yes |
| `packages/schema` | `@opencode-ai/schema` | yes |
| `packages/codemode` | `@opencode-ai/codemode` | **yes — newly observed** |
| `packages/protocol` | `@opencode-ai/protocol` | **yes — newly observed** |

Seven collisions, not five. `@opencode-ai/util` has no local twin.
`@opencode-ai/ui`, `tui`, `cli`, `llm`, `script`, `storybook`, `session-ui`,
`http-recorder`, `effect-*` are published-or-local but absent from the pinned
production closure, so they do not collide (they remain subject to the
runtime-edge rule in Unit 2).

### 1.2 Native modules — and a missing Windows target

`@opencode-ai/pty@0.1.9` carries optional native binaries. The full published
set, from the resolved lockfile (VERIFIED):

```
pty-darwin-arm64      pty-linux-arm64-gnu   pty-linux-x64-gnu
pty-darwin-x64        pty-linux-arm64-musl  pty-linux-x64-musl
```

**There is no `win32` native.** Claxedo ships a Windows desktop target, so Unit
7 must establish what happens there: whether the SDK degrades without PTY, or
whether the Windows build is blocked. This is a packaging gate, not a detail.

Note also (§2.1) that SQLite does **not** need a native module on Node — it
comes from `node:sqlite`. PTY is the real native packaging problem.

### 1.3 The dependency-age policy is real, and currently blocks this pin

`bunfig.toml` sets `minimumReleaseAge = 259200` (3 days) with an explicit
`minimumReleaseAgeExcludes` allowlist. The plan's Prerequisites reference to
"the repository's dependency-age policy" is therefore accurate and enforced by
`bun install`, which fails hard:

```
error: No version matching "@opencode-ai/sdk" found for specifier
"0.0.0-beta-18314" (blocked by minimum-release-age: 259200 seconds)
```

`0.0.0-beta-18314` was published **2026-08-26T17:35:47Z** — about 4.6 hours
before this probe, i.e. **0.19 days against a 3-day policy** (VERIFIED).

Adopting it requires one of:

1. **Wait** until roughly 2026-08-29, after which it installs normally.
2. **Record the one-time exception** the plan's Prerequisites already specify
   (registry source, integrity hashes, package-family diff, native/lifecycle
   audit, provenance, vulnerability results), and restore the policy after.

Development on the cutover branch currently proceeds with a local
`--minimum-release-age=0`, which does **not** change the committed policy.
Merging the lockfile entry is the actual adoption decision and must not happen
until (1) or (2) holds.

There is no age-eligible alternative worth taking: see §2.2 — the newest
age-eligible V2 beta (`0.0.0-beta-17963`) cannot even be imported.

## 2. Node loadability — RESOLVED via the existing bundle pipeline

**Status: resolved.** All 28 contract assertions pass on **Node v22.22.2**
through a `Bun.build` bundle. Cold boot on Node: **173 ms**. Reproduce with
`bun run build-node-bundle.ts && node probe-node.mjs`.

The rest of this section records the blocker and why the fix is the repo's
existing mechanism rather than a new one.

**The pinned SDK cannot be imported by plain Node ESM.** VERIFIED:

```
Error [ERR_MODULE_NOT_FOUND]: Cannot find module '.../dist/opencode'
  imported from .../@opencode-ai/sdk/dist/index.js
```

`dist/index.js` is published as:

```js
export * as OpenCode from "./opencode";   // no file extension
export * as Tool from "./tool";
export { ClientError } from "@opencode-ai/client";
export * from "./contracts";
```

Extensionless relative specifiers are invalid in Node ESM. The same pattern
appears throughout the published `dist/` (`./promise`, `./internal/host`,
`./workerd`, `./contracts`, `./tool`).

Every shipped Claxedo deployment is Node:

| Deployment | Runtime | Evidence |
|---|---|---|
| Hosted sandbox | `FROM node:22-bookworm-slim` | `scripts/sandbox/Dockerfile:1` |
| Desktop | esbuild/Bun bundle, `target: "node"`, `better-sqlite3` | `bundle-claxedo-server.ts:9,20` |
| Self-hosted | `deployments/self-hosted-node` | package name |

So R2 ("the public embedded SDK is the only OpenCode executor") cannot be met
by importing the package directly on Node. Resolution paths, in preference
order:

1. **Bundle it — this is the answer.** VERIFIED. Claxedo already bundles the
   server with `Bun.build` (`target: "node"`, `format: "esm"`), and bundlers
   resolve extensionless specifiers. The dynamic-require leak that broke the
   first attempt came from **`jsonc-parser`**, whose UMD default entry hides
   relative requires inside its factory closure — precisely the package the
   repo already fixes with the `jsonc-parser-esm` resolve plugin in
   `claxedo-desktop/scripts/bundle-claxedo-server.ts:37`. Reusing that one
   plugin, plus keeping native modules external, produces a Node-loadable
   28.7 MB bundle that passes the full probe.
2. Run the SDK under Bun in-process. Unnecessary now; would contradict the Node
   packaging story for desktop and sandbox.
3. A Node loader/resolver shim. Rejected: a private-resolution hack of exactly
   the kind Decision 15 forbids.

**Gate for Unit 2 checkpoint 2a:** the isolated runtime package must import the
pinned SDK and boot a host under Node *by this supported build path*. That is
now demonstrated, so 2a is unblocked.

Two build settings are load-bearing:

- **`jsonc-parser` must resolve to its ESM entry.** Without the plugin the
  bundle throws `Cannot find module './impl/format'` at import time.
- **Target Node explicitly.** The published code emits `await using` (explicit
  resource management), which Node 22.22 cannot parse. `Bun.build`'s
  `target: "node"` handles it; with esbuild, pass `--target=node22`. VERIFIED
  (esbuild without a target produced `SyntaxError: Unexpected identifier '_3'`).

### 2.1 SQLite comes from Node itself — no native module

On the `node` export condition the SDK's SQLite driver is
`@opencode-ai/core/dist/database/sqlite.node.js`, which imports
**`DatabaseSync` from `node:sqlite`** (VERIFIED — `better-sqlite3` is not even
installed in the probe closure; externalizing it was unnecessary).

Two consequences for Unit 7:

- **Good:** the embedded SDK needs no native SQLite module on Node. That
  removes a large slice of the deferred "which native modules per desktop
  target" question. `@opencode-ai/pty-linux-x64-gnu` remains the real native
  dependency to package per platform.
- **New constraint:** `node:sqlite` is **experimental** in Node 22 (the probe
  emits `ExperimentalWarning: SQLite is an experimental feature and might
  change at any time`). The runtime therefore depends on an unstable Node API,
  and **Electron's bundled Node version becomes load-bearing** — Unit 7 must
  verify `node:sqlite` exists and behaves on the packaged Electron for every
  desktop target, not merely on the CI Node. Claxedo's own `better-sqlite3`
  usage is unaffected; the two coexist.

## 2.2 GATE FAILURE — location/project/config surfaces return 500

**This is the blocking finding of Unit 1.** On a host built through the public
`OpenCode.create()`, every surface that resolves location, project or config
context fails with HTTP 500, while session storage works normally.

VERIFIED, reproducible, identical under **both** Bun (direct package import) and
Node (our bundle):

| Works | Returns 500 |
|---|---|
| `health.get` | `location.get` |
| `server.get` | `project.list`, `project.current` |
| `debug.location.list` | `agent.list`, `command.list`, `skill.list` |
| `sessions.*` (create/get/list/export) | `config.get` |
| `events.subscribe` | `model.list`, `provider.list` |
| | `integration.list` |

Ruled out, each by direct test:

- **Not our bundle** — identical failures under Bun importing the published
  package directly.
- **Not egress** — Node's `fetch` reaches `https://models.dev/api.json` with
  status 200 from this same process/environment.
- **Not a missing models catalog** — same result with `models.fetch=false`,
  `models.snapshot=true`, and defaults.
- **Not a missing git project** — same result in a git-initialized, committed
  workspace.
- **Not a missing config directory** — same with `config.directory` set.
- **Not a cold location** — same after `sessions.create` succeeded for that
  exact directory (and returned a resolved `projectID`).
- **Not argument shape** — same with and without a `location` argument.

### Probable cause (source-read, not execute-confirmed)

The public entrypoint cannot install a workspace driver. In
`@opencode-ai/sdk/dist/promise.d.ts` the public options are

```ts
export interface CreateOptions
  extends Omit<EmbeddedHost.CreateOptions, "workspaceProviders"> { ... }
```

and `dist/internal/host.js:16` installs the Node workspace driver **only** when
`workspaceProviders` is supplied:

```js
workspaceProviders
  ? [...embed.overrides ?? [], [WorkspaceDriver.node, WorkspaceDriver.registryNode(workspaceProviders)]]
  : embed.overrides
```

Since the public type deliberately omits that field, a host created via
`OpenCode.create()` gets no `WorkspaceDriver.node` — which matches the observed
split exactly: pure session persistence works, everything requiring a workspace
driver to resolve a directory does not.

This could not be execute-confirmed: `@opencode-ai/sdk/dist/internal/host.js` is
not reachable as a subpath (the `exports` map is enforced under Node ESM), and
reaching it in product code is precisely what Decision 15 bans. That the exports
map does hold is a mild positive for Decision 15's risk under Node — a bundler
inlining it remains the residual hazard.

### What this blocks

R7 in full, and with it Unit 5 end to end: provider/model catalog, MCP,
credentials via `integration.*`, and Agent Config. Unit 4's typed `/provider`
and `/mcp` handlers. Decision 8's "static config enters through explicit SDK
config content", since `config.get` itself fails.

Session parity (R5) and the event authority (R6) are **not** blocked — those
surfaces work.

### The gap is persistent across builds, not a single bad release

Swept across the V2 build-numbered line (VERIFIED):

| Version | Age | Imports? | Catalog/location surface |
|---|---|---|---|
| `0.0.0-beta-18314` | 0.19d | yes | **500s** |
| `0.0.0-beta-18230` | 1.02d | yes | **500s** |
| `0.0.0-beta-18027` | 2.89d | **no** — `Cannot find package '#transpile'` from `@opencode-ai/codemode` | n/a |
| `0.0.0-beta-17963` | 3.56d | **no** — same `#transpile` failure | n/a |

Two builds load and both fail identically, so this is a standing property of
the public V2 embedded SDK rather than one bad publish. (18314 did improve
project resolution: its sessions carry a real `projectID` hash where 18230
reported the literal `"global"`.)

The two older builds are the only age-eligible candidates and neither imports
at all, so there is no version that satisfies both §1.3's age policy and this
gate.

### No newer V2 beta exists to escape to

Decision 1 says to re-plan against a later exact beta on a failed gate. There
isn't one, and the version strings are a trap:

- The V2 embedded line is **build-numbered** (`0.0.0-beta-18314`) and is what
  the `beta` dist-tag points to. It is the newest in that lineage.
- There are ~3100 **timestamp-numbered** `0.0.0-beta-2026...` versions that sort
  *higher*. VERIFIED: `0.0.0-beta-202608110357` is a completely different
  artifact — the legacy fork-shaped SDK with `./client`, `./server`, `./v2`
  exports and none of the `@opencode-ai/core` family (7 packages installed
  versus 533). Pinning "the newest beta" silently installs the **old** product.

That trap belongs in the plan's documented upgrade procedure: follow the `beta`
dist-tag lineage and the build-numbered scheme, never `semver` ordering.

### Decision required

Per Decision 1 this is a stop-and-re-plan trigger, and the options are:

1. **Report upstream and wait** for a V2 beta that exposes `workspaceProviders`
   (or installs the Node driver by default) through the public entrypoint.
2. **Narrow the cutover** to the surfaces that work — session execution and
   events — and keep Claxedo's existing paths for provider/model catalog, MCP
   and credentials for now. This contradicts R2/R11's "one runtime" invariant
   and would leave the fork alive, so it is a real change of plan, not a tweak.
3. **Use the internal host** with `workspaceProviders`. Rejected: Decision 15
   forbids it, and it makes the public installation cosmetic — the exact
   outcome the Alternatives section already rejected.

## 3. Host lifecycle

All VERIFIED under Bun against the pinned release.

| Property | Observed |
|---|---|
| `OpenCode.create()` cold boot | **216 ms** (empty DB, `events.persist: true`) |
| Explicit `database.path` | honored; file created at the given path |
| Default `database.path` | `:memory:` — `dist/internal/host.js:15` reads `database: { path: ":memory:", ...server.database }` |
| `close()` | present, resolves |
| `[Symbol.asyncDispose]` | present |
| Raw `fetch` on the public interface | **`undefined`** — Decision 4 confirmed empirically |
| Persistence across host restart | session created, host closed, fresh host on same path reads it back |
| Suspended-session recovery | `runtime.runFork(SessionRestart.resumeSuspendedSessions)` at host create — background fiber, READ |

`ServerOptions` exposes exactly what Unit 3 needs (READ, from
`@opencode-ai/server/dist/options.d.ts`): `database.path`, `events.persist`,
`config.{directory,project,file,content}`, `models.*`, `fs.filewatcher`,
`app.{name,version,channel}`. `hostname`, `port` and `password` are omitted by
`CreateOptions` — the embedded host has no listener.

## 4. Workspace isolation — Decision 3 survives, Decision 13 is load-bearing

VERIFIED with two sessions created at two directories against one shared host:

| Call | Result |
|---|---|
| `sessions.list({ directory: wsA })` | returns only the wsA session |
| `sessions.list({ directory: wsB })` | returns only the wsB session |
| `sessions.list({})` | returns **both** — unscoped list is host-global |
| `sessions.get({ sessionID: <wsB id> })` from any caller | **succeeds**, returning wsB's `location.directory` |

Two conclusions:

1. **Decision 3 (one shared host per OS process) is not falsified.**
   Directory-scoped listing is correctly isolated at the SDK level.
2. **`sessions.get` performs no location authorization.** Any session is
   readable by ID regardless of workspace. Decision 13's opaque workspace scope
   and per-operation session/location revalidation are therefore the *only*
   barrier to cross-workspace session reads — a required control, not
   defence-in-depth. Unit 3's "Security edge" test must assert this directly.

Corollary for Unit 3: the typed port must never expose an unscoped
`sessions.list`, and must pass `directory` on every list.

**Note on input shape:** `SessionListInput` takes flat `directory` / `workspace`
/ `project` / `subpath` filters. It does **not** take a nested `location`
object (that is `SessionCreateInput`'s shape). Passing `{ location: {...} }` to
`list` silently returns the unfiltered host-global set. This is an easy and
dangerous mistake — it produced a false isolation failure during this probe.
The typed port must make the scoped form the only reachable one.

## 5. Events

VERIFIED by subscribing across two session creations:

| Event | has `id` | has `durable` | has `location` |
|---|---|---|---|
| `server.connected` | yes | **no** | no |
| `session.created` | yes | **yes** | yes |

Consistent with the published union (READ): every `V2Event` carries
`id: string`, but only some carry `durable: { aggregateID, seq, version }`.
`SessionCreated` and `SessionToolCalled` do; `SessionTextDelta`,
`SessionUsageUpdated` and `server.connected` do not.

**Consequence for R6.** `session.usage.updated` has no durable sequence, so it
cannot be checkpointed or replayed after a reconnect. Usage must be
snapshot-derived, per Decision 5:

- per-turn authority: assistant-message `tokens` from paged `message.list`
  (`SessionMessageAssistant.tokens?: TokenUsageInfo`, `cost?: MoneyUSD` — both
  READ, both **optional**);
- session-level reconciliation: `session.get` → `SessionInfo.tokens` / `cost`.
  VERIFIED present on a freshly created session
  (`{"input":0,"output":0,"reasoning":0,"cache":{"read":0,"write":0}}`, cost `0`);
- aggregate audit only: `session.stats` → `SessionStatsInfo`, which is a
  **time-ranged dashboard rollup** (`range`, `sessions`, `activeDays`,
  `streak`, per-model usage). It cannot repair a specific missing per-message
  fact.

**OPEN:** `tokens` and `cost` are optional on assistant messages. Unit 3 must
define the reconciliation outcome for a completed assistant message that
carries neither (e.g. `finish: "error"` / `"interrupted"`). Absence must not be
metered as zero.

## 6. Session transfer (the Node migration path)

VERIFIED: `sessions.export({ sessionID })` returns exactly

```
{ info, messages }
```

which matches `SessionTransferData = { info: SessionInfo; messages: SessionMessageInfo[] }`
(READ) and matches the legacy fork's CLI exporter envelope
(`packages/opencode/src/cli/cmd/export.ts` writes `{ info: sessionInfo, messages }`).
The transfer envelope is therefore structurally aligned across V1 and V2; only
the inner types differ.

`SessionImportInput.info` preserves `id`, `parentID`, `fork.boundary`,
`projectID`, `agent` and `model` (READ), so identity and lineage survive
import — most of Unit 6's semantic validation list.

**Note the parameter name:** `export`/`get` take `sessionID`, not `id`.
`create` takes `id`. VERIFIED (an `id` argument fails with
`InvalidRequestError: Expected a string starting with "ses" at ["sessionID"]`).

### 6.1 The legacy side has no bulk exporter

Confirmed by search: the fork has **no** session transfer surface. There is no
`transfer.ts` under `packages/core/src/session/`, no export/import in the
fork's own V2 gen client, no export route in `packages/server/src`, and no
`SessionTransfer` symbol anywhere in `packages/`.

The only exporter is `packages/opencode/src/cli/cmd/export.ts` — a **CLI
command**, **single-session**, **interactive when no ID is passed**, writing to
**stdout**. It composes `Session.Service.list/get/messages`, so the primitives
for a bulk exporter exist, but the bulk exporter itself is new code that
checkpoint 6a must add. Plan Decision 10 and Unit 6 already say so; this
section is the evidence.

### 6.2 `migration.v1.status` is not a readiness signal on Node

`@opencode-ai/core` maps the V1 migrator by runtime condition:

```json
"#v1-migration": {
  "bun":     "./dist/database/v1-migration.bun.js",
  "node":    "./dist/database/v1-migration.noop.js",
  "workerd": "./dist/database/v1-migration.noop.js",
  "default": "./dist/database/v1-migration.noop.js"
}
```

and the noop is (VERIFIED, published source):

```js
function status() { return Effect.succeed({ status: "completed" }) }
function run()    { return Effect.succeed({ status: "completed" }) }
```

On Node, in-place V1 migration does nothing and reports success. Probing a
fresh host returns `{"status":"completed"}` immediately. `migration.v1.status`
is diagnostic only; semantic validation is the readiness authority, exactly as
Unit 6 specifies.

## 7. API surface parity notes

READ from the pinned generated client.

- **No `credential.list`.** VERIFIED at runtime: the credential group exposes
  only `activate`, `remove`, `update`. The ownership ledger cannot be rebuilt by
  enumeration. OPEN: prove `integration.list`/`get` carries enough connection
  identity, else restrict deletion to ledger-recorded IDs (Decision 9).
- **No `session.archive`.** `SessionInfo.time.archived?: number` exists and is
  read-only from the client's perspective; `session.remove` is the only
  mutation. A freshly created session reports `time` keys `created,updated`
  only. Claxedo's projection stays the archive authority (R5, Decision 16).
- **MCP has no atomic `update` or `restart`.** Surface is `list`, `add`,
  `remove`, `connect`, `disconnect`, `resource.catalog`. Update is
  `remove → add` with compensation; restart is `disconnect → connect`
  (Decision 16).
- **PTY is supported**, contrary to any "unsupported" framing: `pty.{list,
  create,get,update,remove,connect.token}` plus `experimental.persistentPty.*`
  and a `Pty` schema contract. Claxedo retires the passthrough because its own
  terminal is authoritative, not because V2 lacks it (Decision 7).
- **No todo API.** Claxedo-owned store plus a registered plugin tool
  (Decision 7).
- **Forms exist**: `form.{request.list,list,create,get,state,reply,cancel}`,
  backing the structured-question decision.
- `sessions.list` returns `{ data, cursor }` — paged. VERIFIED.

## 8. The unexported raw-fetch host

`EmbeddedHost.create()` ships in the published tarball at
`dist/internal/host.js` and **does** return a raw `fetch` (READ). It is absent
from the package `exports` map, so it is not a supported subpath — but a deep
import or an `exports`-disrespecting bundler reaches it. This is the single
most likely way the migration silently regresses into what it exists to delete.

Decision 15's gates must name `dist/internal`, `/internal/host`,
`EmbeddedHost`, and `@opencode-ai/sdk/dist/**` explicitly.

## 9. Running the probes

```
packages/opencode-runtime/contract/
```

See that directory's README. The probes are deliberately runnable outside the
workspace so they characterize the *published* package, not monorepo
resolution.

## 10. Open gates carried into later units

| Gate | Unit | Status |
|---|---|---|
| Location/project/config surfaces usable from the public entrypoint | 1 | **FAILED — blocks R7 and Unit 5 (§2.2)** |
| One working **Node** build of the pinned SDK | 2a | **CLOSED** — Bun.build + `jsonc-parser-esm` plugin; 28/28 on Node |
| `integration.list/get` credential identity sufficiency | 1 → 5 | **BLOCKED by §2.2** — the surface 500s |
| `node:sqlite` present and stable on packaged Electron per target | 7 | OPEN — new, from §2.1 |
| V1→V2 transfer schema transformer proven over the corpus | 1 → 6 | OPEN |
| Assistant message with no `tokens`: metering outcome | 3 | OPEN |
| Plugin setup failure releases handles/DB locks | 1 → 3 | OPEN |
| Remaining native modules (`@opencode-ai/pty-*`) per desktop target | 7 | OPEN — narrowed by §2.1 |
| Packaged idle RSS / startup thresholds | 1 → 7 | OPEN |
| Concurrent multi-location **turns** (needs provider creds) | 1 | OPEN — only CRUD isolation probed so far |

### Plan amendments this unit produced

1. **Unit 2 collision list is seven, not five** — add `@opencode-ai/codemode`
   and `@opencode-ai/protocol` (§1.1).
2. **Unit 3's typed port must forbid unscoped listing** and must not accept a
   nested `location` filter shape (§4).
3. **Unit 3's "Security edge" test must assert cross-workspace `sessions.get`
   is blocked by Claxedo's scope**, since the SDK permits it (§4).
4. **Unit 7 must verify `node:sqlite` on packaged Electron**, and can drop
   native SQLite from the SDK's packaging requirements (§2.1).
5. **Unit 2a's definition of green** should name the bundle path explicitly:
   the `jsonc-parser` ESM resolve plugin plus a Node target (§2).
