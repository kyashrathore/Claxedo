# OpenCode embedded SDK contract (Unit 1)

Status: UPSTREAM FIXED; NO CLAXEDO REPAIR. The original
`@opencode-ai/core@0.0.0-beta-18314` build captured an undefined filesystem
search dependency and returned an empty 500 from every location-resolving
request. Section 2.3 retains the root-cause record. Upstream removed the
reciprocal runtime import in
[PR #45684](https://github.com/anomalyco/opencode/pull/45684), and the published
`0.0.0-beta-18684` family contains that fix. Claxedo now consumes only the
public SDK dependency; the in-process graph mutation and direct core
dependency have been deleted.
Pinned baseline: `@opencode-ai/sdk@0.0.0-beta-18684`
Revalidated on: Node v26.8.1, Bun 1.3.14, darwin-arm64
Planning commit: `8be1be76ce`

This document is the parity and deletion contract that gates the cutover. Every
claim below is marked `VERIFIED` (observed by running the pinned release or
reading the published artifact), `READ` (read from published typings without
executing), or `OPEN` (still a gate).

Reproduce with `packages/opencode-runtime/contract/` (see "Running the probes").

## 1. Release identity

| Fact                   | Value                                                                         | Evidence                        |
| ---------------------- | ----------------------------------------------------------------------------- | ------------------------------- |
| Pinned SDK             | `@opencode-ai/sdk@0.0.0-beta-18684`                                           | VERIFIED — installs from npm    |
| `beta` dist-tag        | resolves to the same version                                                  | VERIFIED — `npm view dist-tags` |
| `latest` dist-tag      | `1.18.25` (legacy V1)                                                         | VERIFIED                        |
| Family pinned together | `client`, `core`, `plugin`, `schema`, `server`, `util` all `0.0.0-beta-18684` | VERIFIED — SDK `dependencies`   |

`beta` is a **moving** tag and `dev` was already ahead (`0.0.0-dev-18695`) at
revalidation time. The lockfile pin, not the tag, is the contract.

### 1.1 Installed production closure

A clean isolated install of the pinned SDK resolves these `@opencode-ai/*`
packages (VERIFIED):

```
ai, client, codemode, core, plugin, protocol, pty, pty-linux-x64-gnu,
schema, sdk, server, simulation, util
```

**This is wider than the plan's Unit 2 collision list.** Local workspace
packages that collide with the published closure:

| Local package       | Local name              | In pinned closure?       |
| ------------------- | ----------------------- | ------------------------ |
| `packages/sdk/js`   | `@opencode-ai/sdk`      | yes                      |
| `packages/core`     | `@opencode-ai/core`     | yes                      |
| `packages/server`   | `@opencode-ai/server`   | yes                      |
| `packages/plugin`   | `@opencode-ai/plugin`   | yes                      |
| `packages/schema`   | `@opencode-ai/schema`   | yes                      |
| `packages/codemode` | `@opencode-ai/codemode` | **yes — newly observed** |
| `packages/protocol` | `@opencode-ai/protocol` | **yes — newly observed** |

Seven collisions, not five. `@opencode-ai/util` has no local twin.
`@opencode-ai/ui`, `tui`, `cli`, `llm`, `script`, `storybook`, `session-ui`,
`http-recorder`, `effect-*` are published-or-local but absent from the pinned
production closure, so they do not collide (they remain subject to the
runtime-edge rule in Unit 2).

### 1.2 Native modules — and a missing Windows target

`@opencode-ai/pty@0.1.13` carries optional native binaries. The full published
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

### 1.3 Dependency-age adoption record

`bunfig.toml` keeps the repository's three-day adoption gate unchanged.
`beta-18684` was published on 2026-08-29 and was adopted through the reviewed
one-time `--minimum-release-age=0` path; the committed lockfile is the actual
adoption record. The SDK integrity is
`sha512-uABvL1V3fOqNsyV163xBMHlQMbFYXzlcR+YF5Ti0zrdALjoDem7tC109p8tpOIp7EGqd7rVGHa9/02z718vuzg==`.
Core remains only a transitive member of the SDK family. Claxedo no longer
declares it directly.

`npm audit --omit=dev` reports no high or critical findings. Its 14 moderate
dependency-path findings all roll up to the inherited OpenTelemetry baggage
allocation advisory in `@opentelemetry/core@2.6.1`; that same version was
already present in the `beta-18314` lock, so the SDK upgrade does not introduce
the advisory. It remains an upstream dependency risk rather than a reason to
restore a Claxedo-owned runtime path.

The historical `beta-18314` adoption established why the exception mechanism
exists: a newly published exact pin was blocked by the age gate until its
reviewed integrity-hashed graph entered `bun.lock`. Release builds continue to
use the frozen graph and do not make a new adoption decision.

## 2. Node loadability — RESOLVED via the existing bundle pipeline

**Status: resolved.** All 31 contract assertions pass through the supported
`Bun.build` Node bundle. Reproduce with
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
export * as OpenCode from "./opencode" // no file extension
export * as Tool from "./tool"
export { ClientError } from "@opencode-ai/client"
export * from "./contracts"
```

Extensionless relative specifiers are invalid in Node ESM. The same pattern
appears throughout the published `dist/` (`./promise`, `./internal/host`,
`./workerd`, `./contracts`, `./tool`).

Every shipped Claxedo deployment is Node:

| Deployment     | Runtime                                                | Evidence                        |
| -------------- | ------------------------------------------------------ | ------------------------------- |
| Hosted sandbox | `FROM node:22-bookworm-slim`                           | `scripts/sandbox/Dockerfile:1`  |
| Desktop        | esbuild/Bun bundle, `target: "node"`, `better-sqlite3` | `bundle-claxedo-server.ts:9,20` |
| Self-hosted    | `deployments/self-hosted-node`                         | package name                    |

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
pinned SDK and boot a host under Node _by this supported build path_. That is
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

## 2.2 Historical gate failure — location/project/config returned 500

**This affected `beta-18314`; it does not affect the current pin.** On a host built through the public
`OpenCode.create()`, every surface that resolves location, project or config
context fails with HTTP 500, while session storage works normally.

VERIFIED, reproducible, identical under **both** Bun (direct package import) and
Node (our bundle):

| Works                                 | Returns 500                                |
| ------------------------------------- | ------------------------------------------ |
| `health.get`                          | `location.get`                             |
| `server.get`                          | `project.list`, `project.current`          |
| `debug.location.list`                 | `agent.list`, `command.list`, `skill.list` |
| `sessions.*` (create/get/list/export) | `config.get`                               |
| `events.subscribe`                    | `model.list`, `provider.list`              |
|                                       | `integration.list`                         |

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

### Correction: the empty registry is NOT the cause

I earlier called `node = registryNode({})` the root cause. Reading the upstream
`beta` branch (`sst/opencode`, not the published dist) disproves that.

The public SDK has TWO entrypoints and they differ deliberately:

| Entrypoint                   | `workspaceProviders` | Source                                                                                           |
| ---------------------------- | -------------------- | ------------------------------------------------------------------------------------------------ |
| `@opencode-ai/sdk` (promise) | **omitted**          | `packages/sdk/src/promise.ts:8` — `Omit<EmbeddedHost.CreateOptions, "workspaceProviders">`       |
| `@opencode-ai/sdk/effect`    | **accepted**         | `packages/sdk/src/effect/opencode.ts` — `export type CreateOptions = EmbeddedHost.CreateOptions` |

`./effect` is a documented public export, so using it is not a Decision 15
violation. Through it, with a local driver built on the published
`EnvironmentLocal.makeLocalDriver`, VERIFIED working:

```
workspace.create      OK  wrk_04188900...
workspace.provision   OK  provider "local", binding attached
sessions.create       OK  with location { directory, workspaceID }
```

That is exactly the setup the SDK's own tests use
(`packages/sdk/test/embedded.test.ts:545`). So workspace provisioning is
available and works — the earlier `ProviderNotFound` was my failure to use the
entrypoint that exposes it, not an upstream defect.

**But the 500s persist anyway.** With a fully provisioned workspace, a real
git-backed project directory, and sessions carrying the `workspaceID`,
`config.get`, `agent.list`, `provider.list` and `sessions.prompt` still all
return 500. So provisioning is not the missing piece either.

### Source works, the installed package set does not — cause NOT isolated

This section has been rewritten twice because I twice stated a cause I had not
proven. What follows is only what tests show.

**Observed, upstream workspace** (`sst/opencode`, `beta` branch, all deps
resolving to workspace source, run under Bun):

- Their own 15 embedded SDK tests pass.
- `config.get`, `agent.list`, `provider.list`, `plugin.list` all succeed with a
  **bare temp directory** — no workspace provisioning, no overrides, no
  schema-constructed location.
- The same is true calling a locally built `packages/sdk/dist/effect/index.js`
  (its dependencies still resolve to source).

**Observed, isolated npm install of the published packages** (same runtime,
same `effect@4.0.0-rc.111`): the same four calls return **500 with an empty
body**, and `sessions.prompt` likewise.

**Eliminated by direct test:**

| Hypothesis                                          | Result                                                 |
| --------------------------------------------------- | ------------------------------------------------------ |
| Usage shape (plain object vs `Location.Ref.make`)   | identical failure, identical request URL               |
| Workspace provisioning                              | source works without it; install fails with it         |
| `effect` version skew                               | both `4.0.0-rc.111`                                    |
| Duplicate `effect` copies breaking Context identity | exactly one install                                    |
| Global `~/.config/opencode/opencode.jsonc`          | fails with it present                                  |
| Runtime                                             | both under Bun                                         |
| Our Node bundle                                     | fails importing the package directly                   |
| **Published `sdk` dist contents**                   | swapping in the locally built dist does **not** fix it |
| **Published `core` dist contents**                  | swapping in the locally built dist does **not** fix it |
| **Published `server` dist contents**                | swapping in the locally built dist does **not** fix it |

**Narrowed further: built output fails, source succeeds.** Swapping the
locally built dists of _every_ `@opencode-ai` package (`sdk`, `core`, `server`,
`util`, `client`, `schema`, `plugin`, `protocol`, `ai`, `codemode`,
`simulation`) into the published install — dists built from the exact source
that works — still fails identically. So this is not a bad publish of one
package: **anything produced by their build behaves differently from the source
it was built from.**

**And their pipeline cannot see it.** Two facts explain how this ships green:

1. No SDK test imports `dist`. `packages/sdk/test/*.ts` all import `../src/...`,
   so the entire suite — including the 15 embedded tests that pass — exercises
   TypeScript source, never build output.
2. The one script that does test real tarballs,
   `packages/sdk/script/verify-package.ts`, packs every package and builds a
   consumer whose only assertion is `opencode.health.get()`. That is precisely
   the call that still works in the published install, because it resolves no
   location.

So nothing in their pipeline calls a location-resolving endpoint against built
or packed output. `health.get` passes, everything behind it is untested there,
and the failure reaches consumers untouched.

**Splitting/identity hypothesis — tested and ELIMINATED.**
`packages/core/script/build.ts` is the only build in the family using
`Bun.build({ splitting: true })`, and splitting can duplicate a module across
chunks. Effect's `Context.Service` tags are identity-bearing, so duplication
would produce exactly this shape: service lookup fails, handler 500s, nothing
logged. It was the best remaining theory.

It is wrong. In the published `core` dist, `"@opencode/Location"` and
`"@opencode/Project"` each appear in exactly **one** JS chunk (the only other
hit is the `.d.ts`). The service tags are not duplicated, so identity is intact.

Two incidental findings from testing it, both worth passing upstream:

- Rebuilding `core` with `splitting: false` emits **397 files from 404 source
  entrypoints**. Seven are silently dropped — `bus`, `environment/index`,
  `filesystem`, `image`, `location`, `project`, `project/markers` — leaving a
  package that cannot load (`Cannot find module '@opencode-ai/core/bus'`). That
  the dropped set includes `location` and `project` is striking, though the
  split build does emit them.
- The build script's own "exactly one eager require helper" assertion assumes
  splitting and fires when it is off.

### ISOLATED: the defect is in `@opencode-ai/core`'s build output

A clean, repeatable A/B in one isolated npm install of the published packages.
Only one thing changes between runs — whether `@opencode-ai/core`'s
`package.json` exports point at `./dist/*.js` or `./src/*.ts`. Every other
package (`sdk`, `server`, `client`, `util`, `schema`, `plugin`, `protocol`,
`ai`, `codemode`, `simulation`) stays exactly as published, and the runtime is
the same Bun in both runs:

| `@opencode-ai/core` exports                 | `config.get` · `agent.list` · `provider.list` |
| ------------------------------------------- | --------------------------------------------- |
| `./dist/*.js` (published build)             | **4 errors** — 500, empty body                |
| `./src/*.ts` (the source it was built from) | **4 successes**                               |

So the divergence lives entirely in **core's build output**. Nothing else in
the family needs to change to make the failing calls work.

Per-file bisection inside core is not possible from outside: `splitting: true`
means the real modules live in shared chunks, so replacing `dist/location.js`
changes nothing — the other built modules import `location` from the chunk, not
from that shim. Narrowing further means instrumenting core's build.

The construct responsible is named in §2.3. An earlier note here said
per-file bisection was the only way forward and that the cause was upstream's
to find; instrumenting the failing request instead of the build turned out to
answer it in one step.

## 2.3 ROOT CAUSE AND UPSTREAM RESOLUTION — core filesystem module cycle

VERIFIED. Reproduced from a clean `bun run build` of `sst/opencode` at
`b731bc1`, not only from the published tarball, and fixed by a one-line change
to their source.

**A. The observable.** `config.get`, `agent.list`, `provider.list`,
`plugin.list` and `session.prompt` return HTTP 500 with an empty body.
`health.get()` and `session.list` succeed. The dividing line is whether the
request resolves a location.

**B. The defect.** `EmbeddedHost.create` builds the router through
`HttpEffect.toWebHandlerWith`, which converts an unhandled defect into a bare
500 and logs nothing. Piping the router effect through `Effect.onError` before
that conversion surfaces the cause:

```
TypeError: undefined is not an object (evaluating 'node.name')
  at resolve (@opencode-ai/util/dist/effect/layer-node.js:105)
  at recur   (@opencode-ai/util/dist/effect/layer-node.js:63)
  at hoist   (@opencode-ai/util/dist/effect/layer-node.js:89)
```

`LayerNode.walk` calls `options.resolve(node)`, which reads `node.name`. Making
`walk` report its stack instead of throwing names the owner exactly:

```
parent stack: [ "group", "@opencode/PluginSupervisor", "group", "@opencode/FileSystem" ]
parent deps : [ "@opencode/FSUtil", "@opencode/Location", "undefined" ]
```

`@opencode/FileSystem`'s third dependency is `undefined`.

**C. Why it is `undefined`.** `core/src/filesystem.ts` declares

```ts
export const node = makeLocationNode({
  service: Service,
  layer: baseLayer,
  deps: [FSUtil.node, Location.node, FileSystemSearch.node],
})
```

and imports `FileSystemSearch` from `./filesystem/search.js`, which in turn
imports `FileSystem` from `../filesystem.js` — a cycle. As ESM source the cycle
is harmless: `search.ts` only touches the `FileSystem` namespace lazily, inside
layer bodies, so by the time `filesystem.ts`'s top-level `node` is evaluated
the search module has finished. `core` is published through
`Bun.build({ splitting: true })`, which merges both modules into ONE chunk and
emits `filesystem.ts` first:

```
job-3675e63x.js:36   // src/filesystem.ts
job-3675e63x.js:144  deps: [FSUtil.node, exports_location.node, exports_search.node]
job-3675e63x.js:147  // src/filesystem/search.ts
job-3675e63x.js:298  var node2 = configured();          <- the search node, 154 lines late
```

A bundled namespace object yields `undefined` for a not-yet-initialised binding
rather than throwing a TDZ `ReferenceError`, so the hole is captured silently
and survives into every consumer of every published build.

**D. Why it ships green.** `packages/sdk/script/verify-package.ts` packs real
tarballs and installs them, but the consumer it builds asserts only
`opencode.health.get()` — the one call that resolves no location. None of
upstream's 15 embedded tests imports `dist`; they all run against `src`, where
the cycle is benign.

**E. The upstream fix (verified).** `search.ts` uses only
`FileSystem.FindInput` and `FileSystem.Entry`, both exported by
`@opencode-ai/schema/filesystem`. Importing them from there breaks the cycle,
and the bundler then emits the two modules in separate chunks with a real
import edge between them:

| `packages/core` at `b731bc1`       | `config.get` · `agent.list` · `provider.list` · `plugin.list` |
| ---------------------------------- | ------------------------------------------------------------- |
| built dist, unmodified             | 4 errors                                                      |
| built dist, one-line import change | **4 successes**                                               |

Upstream independently landed this exact change in
[PR #45684](https://github.com/anomalyco/opencode/pull/45684) on 2026-08-27.
`beta-18684` publishes it.

**F. What Claxedo does about it.** The temporary `beta-18314` graph mutation
served only until a fixed public package existed. Upgrading to `beta-18684`
triggered its deletion contract: Claxedo removed the mutation, its direct core
dependency, its public exports, and its upstream patch artifact. The permanent
contract now calls `config.get`, `agent.list`, and `provider.list` through the
public SDK under both Bun and bundled Node; any recurrence fails without
depending on core internals.

### The 500s carry an empty body (correcting a false finding)

I briefly recorded that every 500 returned
`{ _id: 'Effect', op: 'Suspend', args: [Function] }` as its body and called that
a broken server error path. **That was my own bug, not upstream's.**
`HttpClientResponse.text` is an Effect — a lazy accessor — so printing it
without running it yields exactly that object. Running it properly gives the
truth:

```
config.get      status=500  body: (empty)
agent.list      status=500  body: (empty)
provider.list   status=500  body: (empty)
sessions.prompt status=500  body: (empty)
```

So the accurate statement is narrower and more ordinary: **the embedded host
returns 500 with an empty body and emits nothing through `log.emit`.** That is
still the reason no black-box probing recovers the cause, but it is not the
dramatic defect I claimed. Do not report the Effect-object version; it is false.

### What the source does explain

`packages/core/src/location.ts:18` — `export const node =
LayerNode.unbound(Service, tags.values.location)`. The location service is
unbound by design and bound per request. `Config.layer`
(`packages/core/src/config.ts:101`) requires `Location.Service`, which is why
config, agents, providers and prompting share one failure: they all resolve a
location. `createEmbeddedRoutes` includes `LocationServiceMap.node` on the same
service set as `createRoutes` (`packages/server/src/routes.ts:89`), so the
binding machinery is present — it is the binding or its error surface that
misbehaves, not its absence.

### Superseded: what I originally believed

`@opencode-ai/core/dist/chunks/job-t14kykx1.js` defines the default workspace
driver as, literally:

```js
node = registryNode({})
```

**An empty provider registry.** That single line explains every symptom:

- `workspace.create` requires a `provider`, and resolving it fails with
  `ProviderNotFoundError: Workspace provider not found: <name>` (VERIFIED).
- Nothing can register a provider, because the public options type is
  `Omit<EmbeddedHost.CreateOptions, "workspaceProviders">` and
  `internal/host.js:16` only installs a populated registry when
  `workspaceProviders` is supplied.
- So no location ever provisions — `debug.location.list` stays `[]` even after
  a session exists (VERIFIED).
- Therefore every API that must resolve a location 500s, while `sessions.*`
  works because it persists directly and derives `projectID` by hashing.

### Public-API workarounds attempted, all negative

`create(options, embed)`'s second parameter IS public, `embed.overrides` is
`readonly [source, replacement][]`, and `@opencode-ai/core` exports `./*` as a
public wildcard — so a fix here would need no `dist/internal` import. Tried:

| Attempt                                                                                                         | Result                                                                        |
| --------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------- |
| `overrides: [WorkspaceDriver.node]`                                                                             | no change — and malformed: `Replacements` needs PAIRS, so this proved nothing |
| `overrides: [[WorkspaceDriver.node, registryNode({})]]`                                                         | no change — replaced empty with empty, a no-op                                |
| `overrides: [[WorkspaceDriver.node, registryNode({ local: <driver built on the published makeLocalDriver> })]]` | still `ProviderNotFound` — the replacement does not reach the compiled graph  |
| local models catalog via `models.file` (+`fetch:false`)                                                         | no change — not a catalog problem                                             |
| git-initialised project, explicit `config.directory`, warmed location, no-arg calls                             | no change                                                                     |
| `WorkspaceDriver.node` override + `workspace.create`                                                            | `ProviderNotFound`                                                            |

Egress was ruled out separately: Node `fetch` reaches `models.dev/api.json`
with status 200 from the same process. The bundle was ruled out: identical
failures under Bun importing the package directly. The client surfaces only
`{ status: 500 }` — no body — and the host's `log.emit` writer emits nothing
for the failing request, so there is no richer error to report upstream than
the reproduction itself.

### Historical impact on the plan

The plan already answers most of this itself. Decision 7 says keep Claxedo
stores authoritative "where the SDK has no public domain operation", Decision 9
keeps the credential registry and Agent Config authoritative, and Scope
Boundaries puts "replacing Claxedo's own ... credential, or Agent Config
authorities with OpenCode-owned versions" explicitly OUT of scope.

So `/global/config` and `/agent` did not need an alternate SDK path — Claxedo's
Agent Config was already their authority. The genuine `beta-18314` casualty
was **`provider.list` / `model.list`**, which Unit 5 derives from the public
typed APIs plus the Claxedo-owned plugin manifest. The later pin restores that
typed-API half; no Claxedo fallback is needed or permitted.

Session persistence, events, transfer/migration, permissions and forms were
unaffected. Turn execution was blocked because prompting also resolves an
agent and model, as the historical prompt result below records.

### RESOLVED: the upstream-fixed SDK executes a turn without a repair

VERIFIED (`gate-prompt-viability.mjs` against the bundled public SDK — §2.3):

| Call              | `beta-18314`   | `beta-18684`                                                                  |
| ----------------- | -------------- | ----------------------------------------------------------------------------- |
| `sessions.create` | OK             | OK                                                                            |
| `sessions.prompt` | **500**        | **OK** — returns a real `msg_...` user message, `delivery: "steer"`           |
| `agent.list`      | **500**        | OK                                                                            |
| `provider.list`   | **500**        | OK                                                                            |
| `message.list`    | `{ data: [] }` | `{ data: [] }` (nothing has run yet; no credentials in a bare temp workspace) |

This retires the blocking finding recorded here earlier ("session execution is
blocked; Unit 4 is unreachable; Unit 7 would ship a product that cannot run an
agent"). Every one of those symptoms was the single `undefined` dependency in
`@opencode/FileSystem`.

**API shape correction found while proving it.** V2's prompt input is FLAT:

```ts
oc.sessions.prompt({ sessionID, text, files?, agents?, skills?, metadata?, delivery?, resume? })
```

There is no `parts` array and no per-call `model`. The earlier probe passed
`{ parts: [{ type: "text", text }] , model: {...} }` and got
`InvalidRequestError: Missing key at ["text"]` — a typed schema rejection, not a
defect. The model is resolved from agent/config, i.e. through the surfaces the
upstream fix restores. Unit 4's prompt projector must map Claxedo's part list onto
this flat shape; `delivery: "steer" | "queue"` is how V2 expresses steer-vs-
queue admission.

### Current catalog decision — use the SDK producer

`beta-18684` restores `provider.list` and `model.list`, so Unit 5 has one path:
the typed runtime port consumes the public SDK catalog. The narrower offline
registry is not a recovery source and must not be substituted when the SDK
fails. Claxedo's model picker remains a separate, explicitly owned product
catalog; it is not synthesized into SDK runtime facts. This closes the former
Unit 5 blocker without dropping providers, lowering a contract threshold, or
creating another models.dev ingestion path.

### Superseded hypothesis (kept for the record)

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
  ? [...(embed.overrides ?? []), [WorkspaceDriver.node, WorkspaceDriver.registryNode(workspaceProviders)]]
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

### Confirmed end to end, through the route the product actually calls

Not a synthetic comparison — both runtimes were asked the same question with
the real app running (`gate-app-startup-path.mjs`):

```
A. vendored fork, via the running local server
   status 200  body {"$schema":"https://opencode.ai/config.json"}
B. pinned public SDK, via OpenCode.create()
   ERR config.get      (backs GET /global/config)      500
   ERR provider.list   (backs the provider catalog)    500
   ERR agent.list      (backs GET /agent)              500
   OK  sessions.create (backs session start)           ses_fbfc6d71bffe...
```

The Claxedo shell issues `GET /global/config` on first paint;
`claxedo-local-server/src/opencode/compat-routes/index.ts:271` serves it from
the engine, and the cutover would serve it from `client.config.get()`. So the
app's **first request** is on the broken surface.

Browser-verified both ways on a real Chromium against the running app: with the
engine reachable the shell renders cleanly; with it unreachable the same shell
renders plus a "Request failed — GET /global/config → 502" toast. Session
creation, by contrast, works on the public SDK today.

**Net: the cutover cannot be completed against this SDK release.** Session
execution and events are portable now; config, catalog, agents and integrations
are not.

### An unrelated runtime trap worth recording

Starting the local server under **Bun** fails every OpenCode route with
`No such built-in module: node:sqlite` — Bun 1.3.14 does not provide it, and
the vendored fork's engine imports it unconditionally. Node does provide it
(experimentally). The shipped desktop runs this server under Node, so Node is
the faithful baseline; `run-local-server-node.mjs` exists to make that explicit.

The public V2 SDK is actually better behaved here: its `#sqlite` imports map
carries a `bun` condition resolving to bun:sqlite, so it runs under both.

### Resolution in the later public beta

The affected build-numbered releases remain useful historical evidence:

| Version            | Imports?                                 | Catalog/location surface           |
| ------------------ | ---------------------------------------- | ---------------------------------- |
| `0.0.0-beta-18314` | yes                                      | **500s**                           |
| `0.0.0-beta-18230` | yes                                      | **500s**                           |
| `0.0.0-beta-18027` | **no** — `#transpile` resolution failure | n/a                                |
| `0.0.0-beta-18684` | yes                                      | **works without a Claxedo repair** |

The `beta` dist-tag now identifies the fixed build-numbered lineage. The
timestamp-numbered `0.0.0-beta-2026...` artifacts remain a different legacy
shape, so upgrades must still follow the dist-tag lineage and an exact pin
rather than raw semver ordering.

This closes the former R7/Unit 5 location-resolution blocker. Provider/model,
config, agent, integration, and prompt behavior remain governed by their own
domain contracts, but none is blocked by the filesystem layer graph.

## 3. Host lifecycle

All VERIFIED under Bun against the pinned release.

| Property                            | Observed                                                                                           |
| ----------------------------------- | -------------------------------------------------------------------------------------------------- |
| `OpenCode.create()` cold boot       | **216 ms** (empty DB, `events.persist: true`)                                                      |
| Explicit `database.path`            | honored; file created at the given path                                                            |
| Default `database.path`             | `:memory:` — `dist/internal/host.js:15` reads `database: { path: ":memory:", ...server.database }` |
| `close()`                           | present, resolves                                                                                  |
| `[Symbol.asyncDispose]`             | present                                                                                            |
| Raw `fetch` on the public interface | **`undefined`** — Decision 4 confirmed empirically                                                 |
| Persistence across host restart     | session created, host closed, fresh host on same path reads it back                                |
| Suspended-session recovery          | `runtime.runFork(SessionRestart.resumeSuspendedSessions)` at host create — background fiber, READ  |

`ServerOptions` exposes exactly what Unit 3 needs (READ, from
`@opencode-ai/server/dist/options.d.ts`): `database.path`, `events.persist`,
`config.{directory,project,file,content}`, `models.*`, `fs.filewatcher`,
`app.{name,version,channel}`. `hostname`, `port` and `password` are omitted by
`CreateOptions` — the embedded host has no listener.

## 4. Workspace isolation — Decision 3 survives, Decision 13 is load-bearing

VERIFIED with two sessions created at two directories against one shared host:

| Call                                                    | Result                                             |
| ------------------------------------------------------- | -------------------------------------------------- |
| `sessions.list({ directory: wsA })`                     | returns only the wsA session                       |
| `sessions.list({ directory: wsB })`                     | returns only the wsB session                       |
| `sessions.list({})`                                     | returns **both** — unscoped list is host-global    |
| `sessions.get({ sessionID: <wsB id> })` from any caller | **succeeds**, returning wsB's `location.directory` |

Two conclusions:

1. **Decision 3 (one shared host per OS process) is not falsified.**
   Directory-scoped listing is correctly isolated at the SDK level.
2. **`sessions.get` performs no location authorization.** Any session is
   readable by ID regardless of workspace. Decision 13's opaque workspace scope
   and per-operation session/location revalidation are therefore the _only_
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

| Event              | has `id` | has `durable` | has `location` |
| ------------------ | -------- | ------------- | -------------- |
| `server.connected` | yes      | **no**        | no             |
| `session.created`  | yes      | **yes**       | yes            |

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
function status() {
  return Effect.succeed({ status: "completed" })
}
function run() {
  return Effect.succeed({ status: "completed" })
}
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
- **`prompt`'s id IS the durable message id — it is just not visible yet.**
  VERIFIED (`gate-inbox-identity.mjs`). CORRECTS an earlier note here that read
  the id as "an inbox entry, not a message". `sessions.prompt` answers with
  `{ id: "msg_...", sessionID, timeCreated, payload: { text }, delivery }`, and
  that exact id later appears in `message.list` as the `user` message and as
  `session.inbox.delivered`'s `inboxID`. Immediately after prompting,
  `message.list` is EMPTY and staging a revert against the id fails
  (`MessageNotFoundError` when idle, `SessionBusyError` while the turn runs).
  So the rule for Unit 4b is a TIMING rule — hold the id from admission and
  wait for `session.inbox.delivered` — not "look the id up again in the page".
- **`revert.clear` on a session with nothing staged is a no-op**, not an
  error. VERIFIED. "Unrevert" therefore needs no prior-state bookkeeping in
  the adapter.
- **`session.fork` refuses an empty session**: `InvalidRequestError` with
  `kind: "empty_session"`. VERIFIED. Fork requires at least one durable
  message, so the adapter surfaces a typed failure rather than fabricating a
  fork id the UI would then navigate to.
- **Prompt input is FLAT** — `{ sessionID, text, files?, agents?, skills?,
metadata?, delivery?, resume? }`. No `parts`, no per-call `model`; see §2.3.
  `delivery: "steer" | "queue"` is how V2 expresses send-while-running.
- **`permission.reply` takes `"once" | "always" | "reject"`** with an optional
  message, and `form.reply` takes a STRUCTURED `answer` record
  (`string | number | boolean | string[]` per field). VERIFIED from the
  generated client; this is what lets harness-neutral question replies carry
  real form values instead of a stringified blob (R5).
- **Location-scoped lists all take the NESTED `{ location: { directory } }`**
  (`agent.list`, `command.list`, `model.list`, `permission.request.list`,
  `form.request.list`) while `session.list` alone takes a FLAT `directory`.
  Mixing the two is silent, not an error — the port makes each unrepresentable
  in the wrong place.

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
workspace so they characterize the _published_ package, not monorepo
resolution.

## 10. Open gates carried into later units

| Gate                                                                    | Unit  | Status                                                                     |
| ----------------------------------------------------------------------- | ----- | -------------------------------------------------------------------------- |
| **`sessions.prompt` executes a turn**                                   | 1     | **CLOSED — upstream-fixed beta answers through the public SDK (§2.3)**     |
| Location/project/config surfaces usable from the public entrypoint      | 1     | **CLOSED — `beta-18684`; permanent Bun/Node contract coverage (§2.3)**     |
| Route `/global/config` and `/agent` from Claxedo's Agent Config instead | 4     | OPEN — the plan's own ownership model already covers this                  |
| `provider.list` / `model.list` from the SDK                             | 5     | **CLOSED for location resolution** — domain projection remains Unit 5 work |
| One working **Node** build of the pinned SDK                            | 2a    | **CLOSED** — Bun.build + `jsonc-parser-esm` plugin; 31/31 on Node          |
| `integration.list/get` credential identity sufficiency                  | 1 → 5 | OPEN — no longer blocked by the layer graph                                |
| `node:sqlite` present and stable on packaged Electron per target        | 7     | OPEN — new, from §2.1                                                      |
| V1→V2 transfer schema transformer proven over the corpus                | 1 → 6 | OPEN                                                                       |
| Assistant message with no `tokens`: metering outcome                    | 3     | OPEN                                                                       |
| Plugin setup failure releases handles/DB locks                          | 1 → 3 | OPEN                                                                       |
| Remaining native modules (`@opencode-ai/pty-*`) per desktop target      | 7     | OPEN — narrowed by §2.1                                                    |
| Packaged idle RSS / startup thresholds                                  | 1 → 7 | OPEN                                                                       |
| Concurrent multi-location **turns** (needs provider creds)              | 1     | OPEN — only CRUD isolation probed so far                                   |

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
