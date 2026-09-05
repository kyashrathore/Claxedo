# OpenCode v2 workerd profile as the worker runtime: evaluation

Date: 2026-09-05. Compared against the Pi-based worker in [the worker runtime plan](../plans/2026-09-05-002-pi-worker-runtime-and-gateway-plan.md). Evidence is the `anomalyco/opencode` `v2` branch source, the published `@opencode-ai/sdk@dev` packages (build `0.0.0-dev-19120`, installed for this evaluation), the v2 docs at `opencode.ai/v2/docs`, and a bundle spike. Nothing here was executed under workerd; that is the first gap named below.

## 1. What upstream shipped

`@opencode-ai/sdk/workerd` exports `OpenCodeWorkerd.create({ storage, config, plugins, instances })`. It boots the full v2 application graph inside a Cloudflare Durable Object and returns the same interface as the Node SDK: typed session operations plus a live event stream, served over an in-process fetch transport. The docs mark the v2 SDK as beta and say the API may change.

The profile is defined in `packages/server/src/workerd.ts` as a replacement graph applied on top of the standard server:

| Service | Workerd profile |
|---|---|
| Database | Drizzle over the Durable Object's SQLite (`sqlite.workerd`) |
| Events | `persist: true`, not optional, because eviction recovery replays durable history |
| Process spawner | `EnvironmentUnavailable`: a typed no-execution-plane spawner |
| FileSystem, FileSystemSearch, Pty | Fail with a clear defect "until a remote sandbox backs them" |
| Snapshot, Vcs | No-op layers |
| Plugin source | Precompiled plugins only; no directory scan, npm install, or import from disk |
| Native modules (pty, fff, shell parser, photon, process lock) | Inert stubs under the `workerd` bundle condition |

Eviction recovery is real and not workerd-specific: `SessionExecution` writes an execution claim at turn start, and `SessionRestart.resumeSuspendedSessions` runs at boot, replays the drain from durable history, and terminalizes a turn after ten resume attempts. Recovery is at-least-once by design.

The v2 core carries the whole third layer the Pi plan would have built: session persistence with an event projector, compaction (`session/compaction.ts`), fork (`Session.fork`), export and import (`SessionTransfer`), a subagent job runner with completion delivery to the parent, revert, an inbox for queued input, skills, remote MCP, and the tools `read`, `edit`, `write`, `grep`, `glob`, `shell`, `patch`, `webfetch`, `websearch`, `question`, `skill`, `subagent`. Model I/O is the Vercel AI SDK provider set, which is fetch-based.

The seam that matters most: `EmbeddedHost.CreateOptions.workspaceProviders`, a record of `WorkspaceDriver.Interface` implementations. A driver is four operations, `create`, `connect`, `suspendForIdle`, `destroy`, keyed by an idempotent `workspaceID` and an opaque JSON `binding`. `connect` returns an `EnvironmentDriver`, which is a `ChildProcessSpawner` plus optional file operation overrides. The `Environment` service picks that driver whenever a location has a `workspaceID`, and a local driver otherwise. Core also ships `makeMemoryDriver`, an in-memory filesystem driver. This is the same shape as the sandbox manager's lease, and it is how upstream intends a remote sandbox to back a workerd host.

## 2. Bundle spike

`bun build --target=node --conditions=workerd` on the published dev SDK, the way upstream's own `packages/server/script/workerd-probe.ts` does it:

| Measure | Result |
|---|---|
| Modules | 2,752 |
| Output, unminified | 20.1 MB |
| Output, minified | 12.2 MB |
| Output, minified and gzipped | 2.8 MB |
| Node builtins referenced | path, os, fs, url, util, crypto, stream, buffer, net, http, https, zlib, module, child_process, async_hooks |
| Static imports of stubbed builtins | `node:child_process` in two places, `node:net` in two |

Under `nodejs_compat`, net, http, https, fs, path, crypto, stream and zlib are supported, os, dns, tls and module are partial, and child_process is a stub that imports but throws when called. The static `child_process` imports therefore load; they must never be reached on the workerd path, which is what the `EnvironmentUnavailable` spawner is for. Upstream's probe accepts every `node:` external and fails only on `bun:` builtins, so this bundle is what upstream considers acceptable. A 2.8 MB compressed script is inside the paid Worker limit and well above the Pi loop's 0.4 MB, so cold isolate starts will be slower.

I found no Miniflare or workerd execution test in the upstream repository by code search. The server comment references an "A4 boot spike." Upstream's published evidence is the bundle probe.

## 3. Side by side against the Pi worker

| Concern | Pi worker (current plan) | OpenCode v2 workerd |
|---|---|---|
| Loop | `pi-agent-core`, dependency | v2 core, dependency |
| Persistence, compaction, fork, export | Claxedo-owned, in Pi's entry format, about 5,000 lines plus 1,500 copied | Upstream, in DO SQLite, with restart recovery |
| Eviction recovery | Claxedo-owned lease and resume | Upstream execution claim and boot sweep |
| Tools without a machine | Pi schemas over the virtual `SessionEnv` | Upstream tools over `makeMemoryDriver` |
| Machine work | Forked child session in a sandbox, Claxedo-owned spawn and report | Upstream subagent jobs with completion delivery, or a `WorkspaceDriver` that attaches a sandbox to the same session |
| Extensibility inside the worker | Data only; no extension host | Precompiled in-process plugins, first-party only for the same trust reason; skills; remote MCP |
| Harness in the sandbox | `pi-coding-agent` | Whatever the sandbox runs today, OpenCode included |
| Message and event format | Pi's; a second format beside the product's OpenCode events | The product's own; the existing native event path applies |
| Maintenance owned by Claxedo | Supervisor, persistence, tools, gateway, prompt assembly | DO class composition, one `WorkspaceDriver`, gateway wiring |
| Upstream stability | 0.73.1 tagged; patch releases every few days | Beta, `dev` dist-tag, Effect 4 release candidate, API may change |
| Bundle, gzipped | 0.4 MB | 2.8 MB |
| Execution proof under workerd | None yet, spike planned | None yet, spike planned |

## 4. What changes if the worker is OpenCode v2

- **The Claxedo-owned third layer disappears.** No entry tables, no compaction port, no tool reimplementation, no prompt assembly. What remains is a Durable Object class that creates the host on `state.storage`, a `WorkspaceDriver` over the sandbox manager, the gateway, and the composer work. That is the largest maintenance line in the Pi plan, removed.
- **One harness across placements.** The base tier and the sandbox tier speak the same protocol and produce the same events. The Pi plan introduced a second harness for the base tier and a promotion path between formats. Here promotion is `SessionTransfer.export` and `import`, both upstream.
- **The tool bridge comes back, but upstream owns it.** The user rejected a Claxedo-owned remote `SessionEnv`. `WorkspaceDriver` is that bridge as an upstream contract with idle suspension built in. Whether to use it, or to keep machine work strictly as child sessions through the subagent runner, becomes a product choice rather than an architecture one. Both are supported by the same core.
- **The gateway is unchanged.** Provider `baseURL` and key options in OpenCode config point the host at the gateway; the session grant token is the key. Credentials otherwise live in the DO's SQLite, which is why they must not.
- **Pi becomes one sandbox harness among peers.** Pi extension packages still require Sandbox placement, and nothing about that changes.

## 5. Risks specific to OpenCode v2

1. **Beta on a dev dist-tag.** Builds publish continuously. Pin an exact build, vendor the lockfile, and treat every bump as a release with the Miniflare suite as the gate.
2. **Effect 4 release candidate.** The dev packages depend on `effect@4.0.0-rc.112`; the vendored 1.17.13 tree uses a beta. Two Effect versions in one graph is a real hazard if both are bundled into one Worker. The hosted Worker must depend on one.
3. **The vendored tree is behind.** `packages/core` and `packages/server` here are 1.17.13 and have no workerd profile. Either consume the published dev packages or re-vendor from the `v2` branch. The memory notes record the fork-drift cost of re-vendoring.
4. **No execution proof.** The same gap as Pi. The spike is the gate.
5. **Cold start weight.** 12 MB of script per fresh isolate. Measure time to first token on a cold DO before committing to per-session objects; a per-tenant host with many sessions amortizes it and is upstream's documented shape.
6. **In-process plugins in the trusted object.** Any plugin passed to `create` runs beside the database. Only Claxedo-authored plugins go there, same rule as the Pi plan's first-party extension.
7. **Strategic tension.** The "OpenCode is just another harness" workstream demotes the vendored engine from privileged default. Using v2 core as the worker runtime makes OpenCode the base tier's runtime. That is compatible if the worker is treated as an implementation of the harness contract, and incompatible if the goal was to remove OpenCode from the control plane entirely.

## 6. Verdict

OpenCode v2 workerd is the stronger base for the worker, provided the execution spike passes. It supplies exactly the layer the Pi plan would have written and maintained, it unifies the harness and event format across placements, and its `WorkspaceDriver` and subagent runner already express both machine-work models. The costs are a beta dependency with continuous builds, a heavier bundle, and a decision about the vendored tree.

Recommended gate, in order:

1. Spike: create `OpenCodeWorkerd` on Durable Object storage under Miniflare, run one prompt through the gateway with a workerd-only assertion, run one `read` over `makeMemoryDriver`, evict, prompt again and confirm continuation. Two days of work.
2. If green, rewrite the worker plan on OpenCode v2: Unit 2 becomes the DO class and a `WorkspaceDriver` over the sandbox manager; Unit 4 keeps only the GitHub tools as a first-party plugin; Unit 6 keeps promotion as `SessionTransfer`.
3. If red, or if the dev tag churns in ways the spike cannot absorb within two weeks, keep the Pi plan as written. It remains correct and self-contained.
