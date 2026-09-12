# Credential broker implementation report

Date: 2026-09-12. Status: incomplete; independent work resumed on user instruction. The registry edit remains deferred to the accounts lane.
Worktree: `/Users/yashvardhansingh/test/opencode-broker`.
Branch: `feat/credential-broker`, created from `dev` at `67e155dd35` with user authorization.
No push or PR. No accounts-lane files changed.

## Commits

- `d0c66f90bf` — chore(sandbox): upgrade provider SDKs and Cloudflare image
- `f46785e0fc` — docs(sandbox): declare implemented broker and egress capabilities
- `c92fbf01a6` — fix(mcp): preserve complete brokered authorization headers

The SDK pins are Daytona 0.211.2, Vercel 3.3.0, Modal 0.10.1, and Cloudflare 0.12.9. Each was checked against the npm registry's `latest` metadata. Cloudflare's Docker base matches its SDK. The compatibility date is unchanged; changing its container semantics requires live verification.

The catalog retains native brokering for Daytona/Vercel, proxy brokering for Cloudflare, and none for the other drivers. Egress remains hosts-and-cidrs for Daytona, hosts for Vercel, and none elsewhere. These describe the implemented drivers: provider features listed in Appendix A are not automatically implemented by installing newer SDKs. Documentation now states the unwired capabilities and checks the brokering matrix as well as egress.

MCP's authoritative producer already emits a complete Authorization value, required by the header-transform drivers. The runtime now uses its placeholder as the entire header. Daytona's literal substitution therefore inserts exactly one Bearer scheme. The signed desktop passes the same complete value through without stripping and re-adding its scheme.

## Accounts-lane boundary requiring coordination

`packages/claxedo-server-core/src/credentials/registry.ts:190` calls `ensurePresetForProvider(input.provider_id)` when saving a credential. The call carries no workspace identity. `packages/claxedo-server-core/src/sandbox/network/policy.ts:307` maps the provider to a group, and `upsertAutoPolicy` inserts a row with `workspace_id: null`.

Saving an account is not workspace authorization. Fixing this at its authoritative source requires removing the save-time grant in `registry.ts`, then removing its obsolete policy helper and handling the existing credential-generated policy rows. If automatic workspace grants are retained, they instead need an actual workspace-scoped attachment caller; fabricating a workspace or leaving a no-op compatibility helper would violate the objective.

Owner: the accounts lane owns `credentials/registry.ts`. Required follow-up: have that lane remove the automatic grant, or explicitly authorize this lane to make that narrow registry edit with coordination. The objective says to stop and report if an off-limits edit is necessary; this report records that stop. The registry was only read.

## Verification commands and outcomes

Commands run from the named package directory unless stated otherwise. Logs are under `/tmp/broker-*.log` on this machine; they are not committed artifacts.

| Directory | Command | Outcome |
| --- | --- | --- |
| root | `curl -fsSL https://registry.npmjs.org/@daytona%2fsdk/latest` (also `@vercel%2fsandbox`, `modal`, `@cloudflare%2fsandbox`) | All four registry requests passed; versions above |
| root | `bun install --minimum-release-age=0` | Passed; 4354 packages installed; lock updated |
| Cloudflare Worker | `npm install --ignore-scripts` | Passed; lock updated; npm reported 3 high vulnerabilities, no unrelated audit fix applied |
| sandbox-manager | `bun run typecheck` | Passed, zero errors |
| sandbox-manager | `bun run test` | SDK slice: 212 pass, 0 fail; catalog slice: 213 pass, 0 fail |
| claxedo-server | `bunx vitest run scripts/sandbox/cloudflare-worker/src/registry.test.ts` | 10 pass, 0 fail |
| claxedo-server | `bun run typecheck` | Initially one unresolved generated Pi package export; passed with zero errors after building dependencies |
| sandbox-manager | `bun run build` | Initially failed on missing generated helpers/sandbox-contract; passed after dependency builds |
| agent-event-runtime | `bun run build` | Initially failed on missing generated helpers/agent-runtime-contract; passed after dependency builds |
| claxedo-helpers, sandbox-contract, agent-runtime-contract | `bun run build` in each | All three passed |
| Cloudflare Worker | `./node_modules/.bin/wrangler deploy --dry-run --outdir .artifacts/broker-dry-run` | Failed: Docker CLI could not be launched; container build unverified |
| Cloudflare Worker | `./node_modules/.bin/wrangler deploy --dry-run --containers-rollout=none --outdir .artifacts/broker-dry-run` | Passed: Worker code bundle only, no deployment or container validation |
| claxedo-local-server | `bunx vitest run src/agent-plugins/runtime/runtime-contribution.test.ts src/agent-plugins/local-composition.test.ts` | Red before fix: 1 failed assertion, 4 passed; separate local-composition suite could not load better-sqlite3 |
| claxedo-local-server | `bunx vitest run src/agent-plugins/runtime/runtime-contribution.test.ts` | Green after fix: 5 pass, 0 fail |
| claxedo-local-server | `bun test src/agent-plugins/local-composition.test.ts` | Initially 0 pass, 1 fail/1 import error; after reinstall: 2 pass, 0 fail |
| root | `bun install --frozen-lockfile --minimum-release-age=0` | Passed; repaired missing installed dependencies, 22 packages installed |
| claxedo-server | `bun test src/agent-plugins/mcp/runtime-preparation.test.ts` | 6 pass, 0 fail |
| claxedo-local-server | `bun run typecheck` | Passed, zero errors |
| root | `bun run test:architecture-ratchets` | Passed twice: 13 tests, 0 fail; 5 products/8 source policies pass; helpers ratchet pass; no baseline changes |
| root | `git diff --check` | Passed before each completed slice |

The failing MCP assertion exercised the real apply route and generated `.mcp.json`. Its replacement check demonstrates literal substitution; it is not a live Daytona request. The desktop tests exercise the signed loopback push, rotation, launch, and withdrawal.

## Changed files

- `bun.lock`
- `packages/sandbox-manager/package.json`
- `packages/claxedo-server/scripts/sandbox/cloudflare-worker/package.json`
- `packages/claxedo-server/scripts/sandbox/cloudflare-worker/package-lock.json`
- `packages/claxedo-server/scripts/sandbox/cloudflare-worker/Dockerfile`
- `packages/claxedo-server/scripts/sandbox/cloudflare-worker/wrangler.toml`
- `packages/sandbox-manager/src/driver-catalog.ts`
- `packages/sandbox-manager/src/index.ts`
- `packages/sandbox-manager/src/egress-policy.test.ts`
- `public-docs/sandbox-egress.md`
- `packages/claxedo-local-server/src/agent-plugins/runtime/runtime-contribution.ts`
- `packages/claxedo-local-server/src/agent-plugins/runtime/runtime-contribution.test.ts`
- `packages/claxedo-local-server/src/agent-plugins/local-composition.ts`
- `docs/plans/2026-09-12-credential-broker-implementation-report.md`

## Appendix E status

No Appendix E experiment has run. Provider credentials and live environments have not been assessed. The following are unexecuted, not negative feasibility results. Date for all entries: 2026-09-12. Command for all entries: none; implementation stopped at the accounts-lane boundary before experiment preparation.

| Item | Provider | Result |
| --- | --- | --- |
| 1: x-api-key substitution | Daytona | not run: paused at the explicit accounts-lane boundary |
| 2: transform overwrites client header | Vercel | not run: paused at the explicit accounts-lane boundary |
| 3: HTTPS interception and live handler update | Cloudflare | not run: paused at the boundary; Docker CLI also unavailable for local image validation |
| 4: ChatGPT subscription through proxy | Codex | not run: paused at the explicit accounts-lane boundary |
| 5: SDK endpoint override | Cursor | not run: paused at the explicit accounts-lane boundary |
| 6: per-provider base URL | Pi/OpenCode | not run: paused at the explicit accounts-lane boundary |
| 7: integration ownership and live edit | exe.dev | not run: paused at the explicit accounts-lane boundary |
| 8: sidecar allowlisting | Modal | not run: paused at the explicit accounts-lane boundary |
| 9: signed subject at provisioning in every deployment mode | Claxedo | not run: paused at the explicit accounts-lane boundary |

The authoritative design's Appendix E has not been filled with acceptance claims. Resume by running each available experiment and recording its actual command and result there.

## Remaining implementation

- Supervisor secret delivery, wake network policy, Daytona resume secret reconciliation, Cloudflare token renewal, and workspace-scoped credential network policy. Each needs its failing test before the fix.
- All Appendix E feasibility experiments and their results in the design.
- The `@claxedo/egress-broker` package, revisioned Binding contract, authenticated binding-id request path, injection/request policy/redirect/failure reporting, generic delivery adapter, Node control-plane hosting, and loopback hosting.
- Live Cloudflare image/runtime verification and any required SDK behavior fixes discovered there.

The hosted store and lease-key changes remain explicitly outside this round. The broker round is not complete.

## GitHub clone placeholder consumer

Completed after the user directed continuation on independent work. Both Claxedo host entrypoints call `claxedoWorkspaceRuntimeBootFromEnv`, which now configures `http.https://github.com/.extraheader` before returning server options. Git receives `Authorization: <placeholder>`; Daytona substitutes the complete Basic auth value supplied by `authenticatedGitHubCloneSource`. The global Git configuration lives in the runtime's home and replaces the previous header on subsequent boot. Configuration failure stops boot. No actual GitHub token is introduced into this path.

Additional changed files:

- `packages/claxedo-server/src/hosts/workspace-runtime/git-auth.ts`
- `packages/claxedo-server/src/hosts/workspace-runtime/runtime-boot.ts`
- `packages/claxedo-server/src/hosts/workspace-runtime/runtime-boot.test.ts`

Validation:

- In claxedo-server, `bun test src/hosts/workspace-runtime/runtime-boot.test.ts` failed before the implementation because the real Git URL-matched header was absent; passed after the fix.
- `bun test src/hosts/workspace-runtime/runtime-boot.test.ts src/workspace/repository-clone.test.ts`: 26 pass, 0 fail. Real Git runs with an isolated home inside this worktree. Assertions cover GitHub HTTPS matching, rejection of HTTP and a lookalike hostname, replacement on repeat boot, malformed header rejection, and config-write failure blocking boot.
- In claxedo-server, `bun run typecheck`: passed, zero errors.
- At root, `bun run test:architecture-ratchets`: 13 pass, 0 fail; all 8 source policies and helpers pass; no baseline changes.
- `git diff --check`: passed.

This proves runtime header configuration. A private GitHub clone through a live Daytona edge remains unverified.

Next: test and repair self-hosted supervisor secret delivery. Trace the existing runtime preparation and GitHub clone secret producers into the supervisor's `manager.ensure` call, then assert that the same secrets reach the driver without entering ordinary runtime env. This is needed so the clone and MCP consumers receive authority on self-hosted provisioning as well as hosted provisioning.

## Supervisor secret delivery (2026-09-13)

The self-hosted manager discarded `SandboxEnsureInput.secrets` before entering the supervisor. Both its direct and relay-host paths now carry that explicit channel through `startRuntime` and `startSandbox` to the real sandbox manager. Recursive provisioning retries retain the same request's secrets. Values are not stored on runtime state, persisted in lease rows, or placed in the ordinary boot environment. Selection and renewal on later independent wakes remain separate unfinished work.

Changed files: `packages/claxedo-server/src/workspace/supervisor/index.ts`, `sandbox.ts`, and `cloud.test.ts` in that same directory.

Commands from claxedo-server:

- `bun test src/workspace/supervisor/cloud.test.ts`: before fix, the two new direct/relay tests failed because the driver received no secrets. After fix and negative-flow coverage: 61 pass, 0 fail.
- The added unsupported-driver test initially exposed missing capability fields in the Modal test double. Its metadata now matches production (`secretBrokering: none`, `egressControl: none`), and the real manager's refusal is exercised. No production behavior was weakened to satisfy the test.
- `bun run typecheck`: passed, zero errors.

At root, `bun run test:architecture-ratchets`: 13 pass, 0 fail; all 8 source policies and helpers pass. No baselines changed. `git diff --check` passed.

The tests execute the supervisor and manager through the public manager entrypoint with mocked provider transport. They do not prove provider-side injection. Self-hosted MCP preparation composition and fresh authority resolution on independent wake remain to be verified.

Next: inspect every wake caller of `ensure`, add failing tests where network policy is omitted, and route each caller through its deployment's existing policy producer. Creation-time restrictions must survive waking or replacing the sandbox; secret delivery alone does not enforce that boundary.

## Wake reconciliation and generic broker skeleton (2026-09-13)

Commits preceding the package:

- `f074ca4a2f fix(sandbox): enforce hosted network policy on wake`: hosted connection resolution now supplies the canonical policy built from control-plane origin, relay, repository, and configured extra hosts. Hosted connection, route, billing wake, and signed integration fixtures were updated. Focused tests: 46 pass, 0 fail; server typecheck and architecture ratchets pass.
- `7b9ad8defa fix(daytona): reconcile brokered references on reuse and resume`: existing/resumed Daytona sandboxes receive explicitly supplied references before runtime start. Empty references detach; omitted references preserve the current configuration. Manager tests: 214 pass, 0 fail; manager/server typechecks pass. New environment variables becoming visible to an already running process still require live provider verification.

The new `@claxedo/egress-broker` package implements binding-scoped signed placeholders, immutable revision snapshots, destination/method/path policy, credential injection, streaming forwarding, redirect refusal, and revision-specific failure reports. Its process-owned adapter supports projection, rotation, binding withdrawal, and runtime generation withdrawal. Its standalone Node listener binds only to loopback. Local and self-host control-plane compositions accept its request handler through explicit hosting options. Local hosting requires loopback and withholds CORS access.

Validation commands:

- In `packages/egress-broker`, `bun run test`: 22 pass, 0 fail under Node Vitest, including an actual loopback listener with rotation and withdrawal. `bun run build` and `bun run typecheck`: pass.
- In `packages/claxedo-local-server`, `bun run test -- src/app/local-app.behaviour.test.ts`: 25 pass, 0 fail. These hosting checks exercise the app with an injected handler; broker semantics are exercised separately by the package's real HTTP test. `bun run typecheck`: pass.
- In `packages/claxedo-server`, `bun run test -- src/deployments/self-hosted-node/app.security-headers.test.ts`: 17 pass, 0 fail. `bun run typecheck`: pass.
- At root, `bun run test:architecture-ratchets`: 13 pass, 0 fail; 5 products / 8 source policies and helpers pass. No baselines changed.
- Initial direct factory imports in both server compositions exceeded package ceilings by one. The final hosting contract accepts a Request-to-Response handler, preserving composition independence; it does not hide or dynamically load a dependency.
- An initial Bun-run Node-listener test completed request assertions but hung during listener shutdown. The target Node runtime completed the lifecycle smoke and all package tests; package tests now explicitly use Node Vitest.

Changed files for the skeleton: `bun.lock`; `packages/egress-broker/package.json`, `tsconfig.json`, `README.md`, `src/binding.ts`, `src/token.ts`, `src/broker.ts`, `src/delivery.ts`, `src/node.ts`, `src/index.ts`, `src/broker.test.ts`, `src/delivery.test.ts`; `packages/claxedo-local-server/src/app/local-app.ts` and `local-app.behaviour.test.ts`; `packages/claxedo-server/src/deployments/self-hosted-node/app.ts` and `app.security-headers.test.ts`; this report.

The broker is opt-in infrastructure, not an enabled end-to-end model-provider flow. Provisioning selection, harness configuration, renewal, and persistent hosted storage are not connected by this slice. No Appendix E live provider experiment is claimed. The accounts-lane boundary recorded earlier still applies.

Next concrete task: reproduce Cloudflare's expired egress-token failure, trace token production through container configuration and outbound interception, and implement renewal at the authoritative lifecycle owner. Test an active runtime past expiry, renewal failure, and restart so protected egress does not silently stop after the current 15-minute token lifetime. This is required for long-running brokered sessions; successful initial injection alone is insufficient.

## Cloudflare feasibility preparation and image manifest repair (2026-09-13)

The old Worker mints a JWT once during ensure-runtime; `runtimeMcpServers` copies that value into harness configuration. Updating only the Worker environment cannot renew already materialized client authentication. Appendix C instead calls for native outbound interception and removal of `/egress`; no parallel renewal mechanism was added to preserve the obsolete end state.

Preparing the real image exposed an independent packaging defect: `first-party-mcp.ts` imports `@claxedo/mcp`, but `hostBundlePackageRoots` omitted that host-owned package. The host metadata gate rejected its three external MCP SDK imports. Added the canonical package root so both builds and generated external dependency pins follow its declared graph. Updated the real graph assertion: the MCP package depends on workspace-runtime and therefore comes after it in topological order.

Commands and outcomes:

- `bun test scripts/sandbox/tests/build-sandbox-image.test.ts` from claxedo-server: failing regression before fix; 23 pass, 0 fail after fix.
- `bun build-sandbox-image.ts --bundle-only --out=cloudflare-worker/.build` from scripts/sandbox: failed before fix on undeclared MCP SDK imports; passed after fix, build ID `30f6471c69`.
- `bun run test:architecture-ratchets` from root: 13 pass, 0 fail; all source and helper policies pass without baseline changes.
- `node --check feasibility/check.mjs`: pass.
- Probe Worker dry-run bundle: pass. Local container build: failed on Docker Hub base-image metadata timeout. Exact commands and unmet acceptance criterion are recorded in design Appendix E.

Changed files: `scripts/sandbox/build-sandbox-image.ts`, `scripts/sandbox/tests/build-sandbox-image.test.ts`, and `scripts/sandbox/cloudflare-worker/feasibility/{outbound.ts,wrangler.toml,check.mjs,README.md}` under claxedo-server; design 002 Appendix E; this report. The probe uses synthetic data and is local-only; it was not deployed.

Next: recover the base-image fetch, run the four-request local probe and cleanup, then test the same behavior in an isolated deployed sandbox. Only verified native interception supports replacing the expiring `/egress` route. The long-running credential flow is not complete.

Packaging fix commit: `0a526f2492 fix(sandbox): include first-party MCP in image dependency roots`. Server `bun run typecheck` passes after the probe uses the SDK's namespace parameter type. The first typecheck rejected a global Workers type unavailable to the server compilation and a `keepAlive` option absent from its ambient SDK declaration; the probe no longer supplies that unnecessary option.

## Pi base-URL feasibility and Cloudflare build recovery (2026-09-13)

The real Pi 0.85.0 public-runtime integration passed, including two new assertions of the actual provider request path and bearer placeholder. Exact command: from `packages/agent-sdk-runtime`, `PI_EXECUTABLE=/Users/yashvardhansingh/test/opencode-broker/.artifacts/broker-pi/node_modules/.bin/pi bun test src/harnesses/pi/native.integration.test.ts`: 2 pass, 0 fail, 27 assertions. An isolated npm install supplies the exact version; the globally installed 0.85.1 failed the existing version gate. Appendix E item 6 now records the verified Pi portion and explicitly leaves OpenCode and real-vendor/broker integration unverified.

Changed files: `packages/agent-sdk-runtime/src/harnesses/pi/native.integration.test.ts`, design 002, and this report.

Cloudflare follow-up: the stuck public-image pull was waiting in `docker-credential-desktop get`. A direct HTTPS request to Docker Hub returned the expected unauthenticated 401. After terminating only this task's stuck pull/helper, an empty task-local Docker client config allowed the public pull to finish: image digest `sha256:4a56a37a3cfd9b38d65bb4b5d0b341e6490a3a4c0226274ae4c1cca4948e85fe`. The isolated config also needs Docker Desktop's `cliPluginsExtraDirs` so Wrangler can use Buildx. A new local probe image build progressed into its Dockerfile dependency installation; no interception result is claimed yet.

## OpenCode provider endpoint feasibility (2026-09-13)

Added `packages/workspace-runtime/scripts/node-provider-feasibility.mjs`, an actual Node/embedded-SDK/workspace-HTTP smoke. It configures an OpenAI-compatible provider endpoint and dummy key, creates a workspace session, submits a turn, asserts the real outbound path, bearer header, and model, and waits for the provider's streamed text in the workspace message snapshot. It uses an isolated workspace/database/test home and cleans up the host and local HTTP server.

Command from workspace-runtime: `node scripts/node-provider-feasibility.mjs`: pass; one actual provider HTTP request, Node 26.8.1, no provider mocks inside the SDK. The provider response itself is deterministic test data. Appendix E item 6 now records the verified OpenCode keys and explicit limits. No live model-vendor request or production binding configuration is claimed.

Changed files: that new smoke script, design 002, and this report. `git diff --check`: pass. No production imports or dependency declarations changed.

## Repair native runtime image smoke (2026-09-13)

The first full Cloudflare image build installed its dependencies and booted the runtime, then failed the image smoke after 20 seconds. The smoke sent the former fake-harness `exec: printf ...` prompt to real Pi with no provider configuration. The production gate was not disabled or given a larger timeout.

Updated `packages/claxedo-server/scripts/sandbox/workspace-runtime-image-smoke.mjs` to start a deterministic local provider, configure the real Pi process with its own isolated models file, request a native file write, and verify the file contents, returned tool message, streamed completion, and persisted history. Existing session create/update/list/delete assertions remain. The test owns and closes its local endpoint and runtime.

Validation:

- `bun test scripts/sandbox/tests/build-sandbox-image.test.ts` from claxedo-server: 23 pass, 0 fail.
- `bun build-sandbox-image.ts --bundle-only --out=cloudflare-worker/.build` from scripts/sandbox: pass; new build ID `195438cb63`.
- Root `bun run test:architecture-ratchets`: 13 pass, 0 fail; all source and helper policies pass unchanged.
- A direct host-machine invocation of the standalone bundle failed before readiness because that image context's npm dependencies were not installed on the host (`jsonc-parser` missing). It is not counted as an acceptance pass.
- Rebuilding through `wrangler dev --config feasibility/wrangler.toml --port 8793` with the task-local Docker client configuration: the actual Dockerfile's native runtime smoke passed under Node 24.18.0 (`[7/7] ... workspace-runtime-image-smoke.mjs`, done in 7.8 seconds). Image export was still running at this report entry; interception checks remain separate.

Changed files: the image smoke, design 002's Daytona/Vercel access results, and this report. Daytona authentication needs renewal; the intended Vercel project/team is awaiting user input. Neither live substitution experiment is claimed.

## Cloudflare local interception result (2026-09-13)

`node feasibility/check.mjs` passed all four real container HTTPS calls and cleanup. Node and Bun reached the synthetic outbound handler at revision 1 and, without restarting the sandbox, revision 2. Worker logs confirm successful sandbox destruction. Server `bun run typecheck` passes. This is local workerd/Docker evidence using the production image, not a deployed provider claim.

Two initial probe failures changed the implementation requirements: a class field shadows the SDK's handler-registration setter; and `ctx.exports` is disabled at compatibility date `2025-04-01`. The probe now invokes the setter and explicitly enables the documented `enable_ctx_exports` flag. A check run during hot reload repeated the earlier registration error; it was rerun only after the local server reported ready. The production Worker has not yet adopted these changes.

Changed files: `feasibility/outbound.ts`, `feasibility/check.mjs`, `feasibility/wrangler.toml`, `feasibility/README.md` under the Cloudflare Worker; design 002; this report. `git diff --check` passes.

Next: secure and deploy an isolated probe, verify native interception on Cloudflare itself, then replace the old expiring-token proxy with the native handler at its authoritative registration owner. Test secret rotation and withdrawal through actual requests before declaring the adapter's capabilities.
