# Pi native harness cutover

Plan 004's implementation makes Pi a native machine harness and removes split
execution. Local browser and native runtime checks pass. **This is not release
acceptance:** packaged desktop, live provider refresh and staging Cloud checks
remain open. Plan 005 remains blocked.

- Branch: `codex/pi-native-no-split`
- Worktree: `/Users/yashvardhansingh/test/opencode/.worktrees/codex/pi-native-no-split`
- Baseline: `ca3e488f7a`
- Protocol and sandbox image pin: `@earendil-works/pi-coding-agent@0.85.1`
- Scope: [plan 004](../plans/2026-09-05-004-pi-native-harness-remove-central-plan.md)
- User documentation: [Using Pi in Claxedo](../pi-native-user-guide.md)

## Current execution flow

1. The user selects **Local** or **Cloud**, a workspace directory and **Pi** in
   the composer. `agent-harness-selector.tsx` uses the shared harness selection
   controller and `harness-config-runtime.ts`. Model and thinking options come
   from the selected machine's native configuration endpoint. Pi has no
   connected-provider catalog branch or execution-placement toggle.
2. The normal workspace session route admits the request. On Cloud, the control
   plane authorizes the workspace and routes through its relay to the sandbox.
   It does not run an agent loop. `NATIVE_HARNESS_ADAPTERS` in
   `packages/workspace-runtime/src/workspace/runtime.ts` selects Pi's factory.
3. `PiHarnessAdapter` extends `SdkRuntimeAdapter`. Its driver in
   `packages/agent-sdk-runtime/src/harnesses/pi/driver.ts` starts one
   `pi --mode rpc` process per session, with the selected directory and managed
   profile. The shared adapter records the product session ID separately from
   Pi's native session ID and native session-file path.
4. The process supplies models, thinking levels and its current selected model.
   The shared session-creation contract preserves that native selection when
   the caller did not choose a model. Pi model option IDs carry the native
   provider/model under the shared `pi` harness namespace. Usage retains the
   upstream provider/model. A missing executable or unavailable machine reports
   its actual error; no catalog or virtual runtime is substituted.
5. A product turn invokes native `prompt`. The driver applies the selected model
   and thinking level using native commands. Pi executes its own tools and
   loads its approved native resources. `rpc-process.ts` correlates request IDs,
   parses bounded JSONL frames, drains stderr and observes process exit.
6. `packages/agent-event-runtime/src/harnesses/pi/adapter.ts` normalizes native
   text, reasoning, tools and usage into the shared event contract. Final
   messages reconcile streamed deltas; `agent_settled` is the terminal
   observation. The shared runtime store owns the product transcript and turn
   lifecycle. Events return over the existing workspace stream to the UI.
7. Stop clears Pi's queue and aborts the turn before another turn can start.
   Extension questions use shared question ownership and cancellation. Process
   loss after admission reports failure; the driver does not replay the prompt.
   Idle processes can be reaped once Pi has persisted their native file. Resume
   opens that same file; a missing file is an error, not a new conversation.

Pi owns context selection, automatic compaction and native session persistence.
The product store owns visible transcript projections and product identity.
Compaction is exercised through the real native protocol and survives restart.
This refactor introduces no second memory engine. Repository memory remains
ordinary files on the selected machine.

Goals use `harnesses/shared/evaluated-goal-resource.ts` and the shared turn
lifecycle. Work runs in the session's Pi process. An independent Pi print-mode
process evaluates the result with tools, extensions, skills and prompt templates
disabled. Work and evaluator usage are recorded before the single product
terminal event; private evaluator text is not a second transcript response.
Interrupted goals require explicit resume. Native subagents remain unsupported.

## Credentials and extensions

The credential registry remains authoritative. Existing runtime configuration
sync supplies the auth map. `harnesses/pi/auth.ts` atomically writes the managed
Pi `auth.json` with mode 0600; a newly created profile uses mode 0700. API keys
and the current Codex OAuth access token are projected. Refresh tokens remain
with the registry, so Pi does not become a competing refresh owner. Empty
configuration clears credentials, including the first configuration applied to
a lazily selected harness after a crash. Rotation closes idle processes and rejects
changes during active work or evaluation.

Profile selection is explicit `agentDir`, then `PI_CODING_AGENT_DIR`, then the
runtime store's `pi/agent` directory (or the driver's managed home default when
there is no store root). A host-wide profile override is shared intentionally;
separate identities must have separate profiles. Adapters in one host process
retain shared profile ownership. Disposing an adapter clears credentials only
after the final owner releases the profile. Writes and cleanup are serialized,
including when a new adapter acquires the profile during cleanup. This is
in-process ownership; independent host processes must use separate profiles.
Regression tests cover override precedence, repeated disposal, surviving owners
and reacquisition during cleanup.

The checkpoint scrub boundary removes managed auth material while retaining
native session files. The real HTTP checkpoint test proves this locally.
Provider refresh against a live OAuth account has not been qualified here.

Pi loads native extensions from the managed profile and trusted project
configuration. Claxedo does not auto-trust a project or emulate an extension
host. Extensions have Pi's machine permissions; Cloud sandbox isolation is the
boundary for code that should not execute on the user's computer. A trusted Pi
MCP extension is required to consume MCP servers: configuring Claxedo MCP alone
does not add MCP support to upstream Pi.

## Channels, wakes and MCP

These entrypoints dispatch into the same machine session path:

- `packages/claxedo-server/src/session/machine-dispatch.ts` authorizes the
  canonical workspace, actor and private-session access on each operation.
  Session creation returns the admitted session ID. Channel reply collection
  subscribes before posting, filters by session and parent message, and waits
  for the corresponding terminal observation. Old idle events do not settle a
  new message. A disconnected stream fails without replaying uncertain work.
- Channel ingress supplies its authorized channel identity. Missing machine
  bindings fail with a workspace-required outcome. Revoked channel grants do
  not retain execution authority.
- `session/machine-wakes.ts` exposes authenticated wake operations and dispatches
  existing sessions through `prompt_async` with a stable wake message ID. The
  self-hosted composition enables its persistent scheduler with
  `CLAXEDO_WAKES=1`. It drains active requests and scheduler work on shutdown.
  This does not implement a new hosted workerd scheduler.
- `packages/claxedo-mcp/src/server.ts` uses normal workspace admission for
  `spawn_session` with an explicit workspace and harness. It waits for prompt
  admission. `schedule_followup` and `cancel_wake` call the authenticated wake
  route. These are shared MCP capabilities; the deleted central Pi tool
  injection is not retained.

The removed owners are the central session runtime, embedded Pi model backend,
SessionEnv tools-only bridge, virtual filesystem runtime, hybrid creation route,
split placement contracts and related public SDK exports. CLI deploy no longer
offers the unused harness choice or Pi-only `--tools` option. Existing
control-plane transport names are unrelated to execution placement and remain.

## Verification

Commands below run from the named package unless marked repository root.
Results are from this implementation task. Final checks retain logs under the
worktree's ignored `.artifacts/pi-native/`; earlier full-suite results were
observed in task output. The root intentionally has no general `bun test` suite.

`PI_EXECUTABLE` in native commands points to the isolated pinned binary:

```sh
export PI_EXECUTABLE=/Users/yashvardhansingh/test/opencode/.worktrees/codex/pi-native-no-split/.artifacts/pi-native/binary/node_modules/.bin/pi
```

| Owner / command | Observed result |
| --- | --- |
| Root: `bun install --frozen-lockfile` | Pass; 2,328 installs checked, no lockfile changes from install |
| Root: `bunx turbo run build --filter=@claxedo/workspace-runtime` | 8 build tasks pass |
| SDK final: `PI_EXECUTABLE=… bun run test` | 579 tests pass, zero failures/skips |
| SDK final: `PI_EXECUTABLE=… bun test src/harnesses/pi` | 23 pass, including real Pi, zero failures/skips |
| Workspace final: `PI_EXECUTABLE=… node --import ./src/text-imports.mjs --import tsx --test src/pi-native.node-test.ts` | 2 real HTTP tests pass: cold empty auth and checkpoint/restart; zero skips |
| Workspace: `PI_EXECUTABLE=… bun run test` | 925 Bun unit, 37 relay and 58 Node tests pass |
| Agent event runtime: `bun test src` | 154 pass |
| Agent runtime contract: `bun test src` | 20 pass |
| Local server: `bun test src` | 375 pass |
| MCP: `bun test src` | 90 pass |
| Wakes: `bun test` | 42 pass |
| CLI: `bun test src/commands/deploy.test.ts` | 1 pass; removed flags rejected before deployment |
| App: `bun test --conditions=browser --preload ./happydom.ts ./src` | 5,967 pass |
| App: `bunx vitest run --config vitest.config.ts` | 1,047 pass |
| App final: `bun test --conditions=browser --preload ./happydom.ts src/features/session/permission` | 34 pass; native Pi permission copy makes its real machine access explicit |
| App final: `bun test --conditions=browser --preload ./happydom.ts src/platform/runtime/session-url.test.ts` | 3 pass after deleting unused split-host parsing |
| App: `bun run typecheck` | Pass, including architecture, E2E types and performance checks |
| App: `bun run build` | Pass; 4,780 modules |
| SDK: `bun scripts/verify-publish.ts` and `npm pack --dry-run --ignore-scripts` | Pass; no package published |
| Workspace: `bun scripts/verify-publish.ts` | Pass |
| Root: `bun run test:architecture-ratchets` | Pass; 8 policies across 5 products |

Final affected runtime typechecks pass:

```sh
bunx turbo run typecheck --filter=@claxedo/agent-sdk-runtime --filter=@claxedo/workspace-runtime --filter=@claxedo/local-server --filter=@claxedo/agent-runtime-contract --filter=@claxedo/server-core
```

Event runtime, MCP and CLI package typechecks also passed during implementation.
The review follow-up reran both changed packages with
`bunx turbo run typecheck --filter=@claxedo/agent-sdk-runtime --filter=@claxedo/workspace-runtime`;
both pass. It also reran the build, both complete package suites with real Pi,
the focused Pi suite and root architecture ratchets listed above. Logs are
`review-{build,full-sdk,full-workspace,pi-sdk,types,ratchets}.log` under
`.artifacts/pi-native/`.

The four review findings are fixed:

- `workspace/runtime.ts` applies the first empty configuration before lazy
  admission; subsequent identical configurations remain deduplicated. The
  real HTTP test starts with crash-left auth, creates a session without a
  default harness and verifies the first prompt fails for missing credentials
  without contacting the provider.
- `harnesses/pi/executable.ts` resolves npm shims through the installed
  package's declared `bin.pi`, which is `dist/bundle/cli.js` in Pi 0.85.1.
  It no longer launches the unbundled `dist/cli.js`. The shim regression checks
  resolution, version execution and a missing declared binary. This ran on
  macOS; an installed Windows desktop run remains unverified.
- `harnesses/pi/driver.ts` invalidates pending idle checks when a turn starts.
  Both a stale RPC response and a stale RPC failure are covered; neither can
  dispose the newly admitted turn.
- `harnesses/pi/auth.ts` owns shared profile retention and serialized cleanup.
  Closing one adapter cannot clear a surviving adapter's credentials; repeated
  disposal and a new owner arriving during removal are covered.

This is affected-package verification, not a claim that repository-wide release
CI or deployed acceptance ran. SDK declaration hashes were regenerated from the
reviewed built API after removing split exports and returning native model
identity in the driver creation contract.

Server focused verification: **86 tests pass in seven files**:

```sh
CLAXEDO_DATA_DIR=/tmp/pi-normalize-server-tests bunx vitest run src/session/machine-dispatch.test.ts src/session/machine-wakes.test.ts src/channels/ingress.test.ts src/authority/relay-token-record.test.ts src/authority/adapters/d1/core-authority.test.ts src/session/routes/control-plane-session.test.ts src/tests/integration/native-session-cutover.integration.test.ts
```

Local browser verification: **1 passes**, exercising machine config options,
native Pi model prompt payload and session navigation:

```sh
PLAYWRIGHT_PORT=4468 PLAYWRIGHT_VIDEO=0 bunx playwright test e2e/playwright/core-harness-ownership-local.spec.ts --grep 'Pi loads' --workers=1
```

The browser uses the repository's mock machine service. Separately, real Pi
tests use the actual pinned executable and native file tools with a deterministic
HTTP model provider. They prove native identity, tool execution, image input,
extension question/answer, abort, compaction, usage, goals and restart. The Node
test crosses the real workspace HTTP route and checkpoint boundary. Neither
fixture is evidence of a live paid provider or deployed sandbox.

The signed-browser fixture no longer imports or injects an embedded Pi backend.
`startScriptedModelServer()` now owns a native Pi profile pointing to its HTTP
provider, passes that profile to local/desktop/relay fixture processes and
removes it on teardown. A real Pi smoke through that helper passed: the native
default selected `openai/gpt-4.1`, one request reached the scripted chat endpoint
and the product turn settled. Reproduction in this worktree:
`PI_EXECUTABLE=… bun .artifacts/pi-native/scripted-provider-proof.ts`. This
qualifies the fixture migration; it does not turn the blocked Cloud browser
journey into a passing acceptance run.

## Measured maintenance change

Measured at cutover commit `0c81512804` against `ca3e488f7a`, including
new additions exactly once. Subsequent dev integration is not included:

| Category | Added lines | Removed lines | Net |
| --- | ---: | ---: | ---: |
| Production source | 2,323 | 6,424 | **−4,101** |
| Tests and fixtures | 2,279 | 6,561 | −4,282 |

Method: tracked `git diff --numstat ca3e488f7a` plus line counts of
`git ls-files --others --exclude-standard`. Count TS/TSX/JS/MJS/MTS files;
paths containing `test`, `spec`, `fixture`, `mock` or `e2e` (case-insensitive)
are classified as tests/fixtures, and the rest as production. Docs, metadata, lockfiles
and ignored build output are excluded. Deleted obsolete tests are reported
separately; a lower test count is not itself a quality claim.

Final source closures: app local 958 modules/37 packages; local server 53/21;
self-hosted server 125/36; unsigned desktop renderer 1,008/56. No closure ceiling
was increased. The app effect-state-write allowance decreased from dev's 92 to the
measured 91 after removing Pi catalog effects while retaining the OpenCode
catalog admission owner introduced on dev.

The architectural reduction is one execution path: workspace admission → native
adapter → Pi process → shared events. The cost is that every current harness
session requires a machine. Pi also becomes an explicitly versioned executable
dependency. Bootless chat and a machine-as-tool UX belong to plan 005.

## Outstanding acceptance and deployment boundary

| Unmet requirement | Evidence / blocker | Owner and concrete follow-up |
| --- | --- | --- |
| Browser Cloud composer | `core-harness-ownership-cloud.spec.ts` fails before composer: `hosted operation "workspace.connection.mint" has no transport bound in this build`. `src/app/entry/app.tsx` binds browser accounts to `unboundHostedOperation`; this exists at baseline `ca3e488f7a`. | Browser account transport owner: bind the real hosted operation transport, then rerun the Pi Cloud spec. No fallback or synthetic production transport was added. |
| Packaged desktop Local Pi | Package/unit tests are not an installed desktop acceptance run. | Desktop runtime owner: package this branch and exercise create, edit, model change, stop, app restart and native resume. |
| Live OAuth refresh | Deterministic projection, expiry/revocation and isolation tests pass; live provider refresh was not exercised. | Credential owner: connect a staging account, refresh via the registry, sync/restart Pi, revoke and verify access loss. |
| Live Cloud sandbox and staging PR task | No staging sandbox deployment or real repository PR task ran in this task. | Sandbox/release owner: build the pinned image, provision through public Cloud routes, exercise tools and interruption, checkpoint/restore with separate credential rehydration, then run the staging repository acceptance task. |

Deploy this as a coordinated breaking client/server/runtime cutover. Stop old
central dispatch and its scheduler before switching binaries; use the native
machine composition and fresh bindings afterwards. Old central sessions,
pending actions, approvals and split SDK payloads have no supported read/resume
contract. They are not converted into native Pi sessions. No bulk data deletion,
historical reader, dual-write path or legacy compatibility adapter is included.
No deployment, push or package publication was performed by this task.

## Dev integration verification

The merge with `ffdd2577f5` retains OpenCode provider-catalog selection and
keeps native Pi on runtime config options. Registry credential management is a
separate capability, so Pi Settings still connects and disconnects credentials.
The merge passes 5,967 app Bun tests, 1,051 app Vitest tests, the complete app
`bun run typecheck`, the client-presentation projection tests, app
`bun run verify:closure`, and root `bun run test:architecture-ratchets`.
These logs use the `merge-` prefix in `.artifacts/pi-native/`.
