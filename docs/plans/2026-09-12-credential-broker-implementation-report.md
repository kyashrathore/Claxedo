# Credential broker implementation report

Status (2026-09-14): a dated log of the broker lane's slices on 2026-09-12 and 2026-09-13, kept as
the record of each run. Where the code has moved on since an entry, a "Superseded" line under it
says how; `docs/plans/2026-09-12-002-feat-credential-broker-design.md` describes the code as it is.

Date: 2026-09-12. Status at the time: incomplete; independent work resumed on user instruction. The registry edit remains deferred to the accounts lane.
Worktree: `/Users/yashvardhansingh/test/opencode-broker`.
Branch: `feat/credential-broker`, created from `dev` at `67e155dd35` with user authorization.
No push or PR. No accounts-lane files changed.

## Commits

- `d0c66f90bf` — chore(sandbox): upgrade provider SDKs and Cloudflare image
- `f46785e0fc` — docs(sandbox): declare implemented broker and egress capabilities
- `c92fbf01a6` — fix(mcp): preserve complete brokered authorization headers

The SDK pins are Daytona 0.211.2, Vercel 3.3.0, Modal 0.10.1, and Cloudflare 0.12.9. Each was checked against the npm registry's `latest` metadata. Cloudflare's Docker base matches its SDK. The compatibility date is unchanged; changing its container semantics requires live verification.

The catalog retains native brokering for Daytona/Vercel, proxy brokering for Cloudflare, and none for the other drivers. Egress remains hosts-and-cidrs for Daytona, hosts for Vercel, and none elsewhere. These describe the implemented drivers: provider features listed in Appendix A are not automatically implemented by installing newer SDKs. Documentation now states the unwired capabilities and checks the brokering matrix as well as egress.

Superseded: Cloudflare is `native` since the native credential delivery slice below; its egress control is `none`.

MCP's authoritative producer already emits a complete Authorization value, required by the header-transform drivers. The runtime now uses its placeholder as the entire header. Daytona's literal substitution therefore inserts exactly one Bearer scheme. The signed desktop passes the same complete value through without stripping and re-adding its scheme.

## Accounts-lane boundary requiring coordination

Superseded: the save-time grant is gone. `ensurePresetForProvider` and `upsertAutoPolicy` no longer exist, a migration deleted the rows they wrote, and a restricted sandbox derives its provider hosts at ensure time from the credentials it is sent (design 002, Appendix B, item 9).

`packages/claxedo-server-core/src/credentials/registry.ts` called `ensurePresetForProvider(input.provider_id)` when saving a credential. The call carried no workspace identity. `packages/claxedo-server-core/src/sandbox/network/policy.ts` mapped the provider to a group, and `upsertAutoPolicy` inserted a row with `workspace_id: null`.

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

Superseded: the experiments have since run where access allowed; design 002's Appendix E holds each command and result, and the sections below record the runs in order.

At the time of this entry no Appendix E experiment had run. Provider credentials and live environments had not been assessed. The following were unexecuted, not negative feasibility results. Date for all entries: 2026-09-12. Command for all entries: none; implementation stopped at the accounts-lane boundary before experiment preparation.

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

## Remaining implementation (updated 2026-09-13)

- The workspace-less credential network grant is blocked by the explicit accounts-lane ownership restriction documented above. (Superseded: the grant is gone; see that section.)
- Deployed Cloudflare Container acceptance is blocked by image upload. Native injection, rotation and withdrawal are now verified through local workerd/Docker against an isolated HTTPS upstream.
- Daytona needs working authentication; Vercel awaits the intended project/team; exe.dev integration behavior remains unverified after the host-trust gate; Modal lacks configured authentication/allowlisting. Appendix E records exact evidence, not inferred provider outcomes.
- Signed subject now reaches the three hosted lifecycle hooks. It does not yet reach per-user provider selection or per-user leases in every deployment mode.
- The generic broker and Node/loopback hosting exist and have focused tests plus live Codex subscription evidence. Production binding composition, storage, selection, renewal, and full harness projections are incomplete.
- Hosted store and lease-key changes remain explicitly excluded by the objective file pending accounts-lane coordination. The complete design is not implemented.

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

## Protected Cloudflare deployment attempt and Cursor routing (2026-09-13)

Secured the isolated Cloudflare probe: missing token disables it, unauthenticated calls receive 401, and sandbox operations require POST on its two known paths. The token file is ignored. Added explicit `standard-1` sizing and documented deployed checks/cleanup. Server `bun run typecheck` passes. The authenticated local `node feasibility/check.mjs` passes, including rejection before its four real container requests and sandbox cleanup.

Two `wrangler deploy --config feasibility/wrangler.toml` attempts failed during image upload with a closed network connection. Their processes exited; neither was treated as successful deployment. The temporary disabled Worker was deleted with `wrangler delete --config feasibility/wrangler.toml --force`; container listing showed no matching probe application. No production Worker was changed. Appendix E records this as not run on deployed Cloudflare.

Added `packages/agent-sdk-runtime/scripts/cursor-endpoint-feasibility.mjs`. `node scripts/cursor-endpoint-feasibility.mjs` passes with the real Cursor SDK: its auth-exchange and model-catalog calls reach `CURSOR_BACKEND_URL` with the configured placeholder bearer header. Authentication is deliberately rejected; successful inference is not claimed. The first invocation lacked the SDK-required explicit model and failed before networking; the final experiment sets `model: { id: "auto" }` and asserts actual received requests.

Changed files: the Cursor probe; Cloudflare `feasibility/outbound.ts`, `check.mjs`, `wrangler.toml`, `README.md`, `.gitignore`; design 002; this report. No real provider credential was used or exposed. The production native Cloudflare adapter remains gated on deployed acceptance; full provider-account integration remains dependent on the accounts lane.

## Live Codex subscription through the generic broker (2026-09-13)

Added `packages/egress-broker/scripts/codex-subscription-feasibility.ts` and usage instructions in the package README. The test uses the real repository app-server process wrapper, image-pinned Codex 0.133.0, actual broker/delivery adapter/Node listener, and a live ChatGPT subscription. The controller reads the saved access token; the child gets an isolated home and a signed binding placeholder through a custom Responses provider with `requires_openai_auth=false`.

The final live command (all three environment inputs and executable path are recorded in Appendix E item 4) passed: `gpt-5.5` returned HTTP 200 and the requested response. Binding withdrawal then rejected the same running app-server's next turn. The assertion observes an actual missing-binding lookup and no additional upstream call, so a client-side failure alone cannot satisfy the test. After process-group disposal, recursive inspection found no real credential in runtime files; the temporary home and listener were removed. No source auth file was changed.

Initial `gpt-5.3-codex` failed because that model was unavailable to the account. The live model catalog identified `gpt-5.5`; subsequent tests used it. Earlier successful runs emitted a client-disconnect warning on teardown; the final strengthened run exited 0 with its acceptance JSON. Root `bun run test:architecture-ratchets` passed (13 tests, all source/helper policies, no baseline changes). `git diff --check` passed.

This proves the custom-provider subscription proxy mechanism with a fixture binding authority. It does not implement production signed-user selection, binding storage, renewal, or model configuration. Appendix E also records the missing exe.dev host trust, absent Modal authentication, and the workspace-only preparation callback that still drops signed-user context.

Changed files: the Codex feasibility script, egress-broker README, design 002, and this report. Next implementation target: the Cloudflare expiring-token path, using the locally verified native outbound API while keeping deployed acceptance explicitly pending. The off-limits accounts contracts and hosted store remain untouched.

## Native Cloudflare credential delivery — 2026-09-13

Replaced the unrenewed 15-minute JWT with native HTTPS outbound injection.
The driver preserves each secret name and distinguishes omitted registrations
from explicit withdrawal. The Worker validates registrations, keeps values in
its existing KV authority, configures per-host handlers, and boots clients with
named placeholders. Forwarding checks host and placeholder, reads current KV
values per request, strips credential/cookie headers, and rejects redirects.
MCP materialization retains the original URL. Deleted the obsolete JWT helper,
vendor copy, package export/build entry, HTTP route and consumer rewrite.
Catalog and docs now declare native brokering with unrestricted unrelated egress.

Failing test first: root `node packages/claxedo-server/node_modules/vitest/vitest.mjs
run packages/claxedo-server/scripts/sandbox/cloudflare-worker/src/registry.test.ts`
initially produced 10 pass / 3 fail: absent native handler setup, empty input
retaining the old value, malformed input accepted. These were actual assertions.

Final gates:

- Root `node packages/claxedo-server/node_modules/vitest/vitest.mjs run packages/claxedo-server/scripts/sandbox/cloudflare-worker/src`: 21 pass / 0 fail.
- Sandbox-manager `bun test src/drivers/cloudflare.test.ts src/egress-policy.test.ts`: 58 pass / 0 fail. An intermediate run found the old nameless payload assertion; a later run found a documentation table replacement error and stale error-text assertion. All were corrected.
- Local-server `bun test src/agent-plugins/runtime/runtime-contribution.test.ts`: 4 pass / 0 fail. Removed the obsolete partial-JWT-config test with its production parser; strict registration and authority failure tests cover the new boundary.
- `bun run typecheck` in claxedo-server, claxedo-local-server and sandbox-manager: pass. The first server check caught test fetch doubles incorrectly cast to Bun's fetch type; the forwarding dependency now exposes only the Request-to-Response function it uses.
- Sandbox-manager `bun run build`: pass.
- Worker `npx wrangler deploy --dry-run --outdir /tmp/broker-native-cf-worker-dry-run`: pass, including the Docker image build. No deployment occurred.
- Root `bun run test:architecture-ratchets`: 13 pass / 0 fail, five product and eight source policies plus helper ratchet pass; no baseline changes.
- `git diff --check`: pass after removing one trailing blank line.

This completes the source replacement, not deployed acceptance or the full
credential broker. The new production handler still needs a real-container
injection/rotation/withdrawal experiment; the previous local probe proved SDK
interception and handler updates only. The prior remote image upload failure
still blocks deployed acceptance. Existing KV is eventually consistent and
sandbox-keyed: this slice does not implement account selection, revision-aware
hosted bindings, refresh coordination, immediate global revocation, or native
per-binding method/path policies. Accounts-lane files remain untouched. Deploy
matching driver and Worker together and destroy/recreate existing sandboxes;
there is no legacy registration migration.

Changed files:

- `packages/claxedo-server/scripts/sandbox/cloudflare-worker/src/index.ts`
- `packages/claxedo-server/scripts/sandbox/cloudflare-worker/src/registry.test.ts`
- `packages/claxedo-server/scripts/sandbox/cloudflare-worker/src/outbound-credentials.ts`
- `packages/claxedo-server/scripts/sandbox/cloudflare-worker/src/outbound-credentials.test.ts`
- `packages/claxedo-server/scripts/sandbox/cloudflare-worker/src/egress.ts` (deleted)
- `packages/claxedo-server/scripts/sandbox/cloudflare-worker/wrangler.toml`
- `packages/claxedo-server/scripts/sandbox/cloudflare-worker/README.md`
- `packages/claxedo-local-server/src/agent-plugins/runtime/runtime-contribution.ts`
- `packages/claxedo-local-server/src/agent-plugins/runtime/runtime-contribution.test.ts`
- `packages/sandbox-manager/src/drivers/cloudflare.ts`
- `packages/sandbox-manager/src/drivers/cloudflare.test.ts`
- `packages/sandbox-manager/src/drivers/cloudflare-egress.ts` (deleted)
- `packages/sandbox-manager/src/drivers/cloudflare-egress.test.ts` (deleted)
- `packages/sandbox-manager/src/driver-catalog.ts`
- `packages/sandbox-manager/src/egress-policy.test.ts`
- `packages/sandbox-manager/scripts/build.ts`
- `packages/sandbox-manager/package.json`
- `packages/sandbox-manager/README.md`
- `packages/sandbox-manager/docs/architecture.md`
- `public-docs/sandbox-egress.md`
- `docs/plans/2026-09-12-002-feat-credential-broker-design.md`
- This implementation report.

Next task: extend the isolated native probe to call this production handler
with fixture credentials, then verify real Node and Bun HTTPS requests select
the correct header, observe rotation without restarting the client, and lose
credential access after withdrawal. This closes the gap between unit-tested
forwarding and the platform's actual TLS interception boundary before another
isolated deployed attempt.

## Production Cloudflare handler live local acceptance — 2026-09-13

Commit `2b363c7d04` implemented native injection. The isolated feasibility probe
now imports that production Sandbox class, writes its actual KV authority, and
configures the production named handler. A temporary deployed HTTPS Worker
validates a controller-only fixture credential and returns a verdict/revision.
Two long-running client processes coordinate through files so rotation and
withdrawal cannot pass by silently restarting either client.

`node feasibility/check.mjs` passed six actual HTTPS requests: Node and Bun
both authenticated at revisions 1 and 2 with unchanged PIDs; after KV withdrawal
and native handler removal both returned 401. The controller rejected any
captured response containing the fixture token. This is not a whole-filesystem
secret scan, nor a real provider account test. The fixture credential never
appears in the client script or its input headers.

The upstream deploy and secret configuration succeeded. The checker destroyed
the sandbox and cleared its KV key. `npx wrangler delete --config
feasibility/upstream/wrangler.toml --force` succeeded. The verified local dev
process was then terminated (exit 143). Exact setup/check/cleanup commands are
recorded in Appendix E and the probe README. Server `bun run typecheck` passed.

This closes local production-handler acceptance left by the previous slice.
Deployed Cloudflare Container acceptance remains blocked by the earlier image
upload failure; local KV behavior does not prove global revocation latency.
Changed files: feasibility `outbound.ts`, `check.mjs`, `wrangler.toml`, `README.md`,
new `upstream/index.ts` and `upstream/wrangler.toml`, design 002 and this report.

Final acceptance-slice gates: root `bun run test:architecture-ratchets` passed
13 tests, all five product/eight source policies and helper ratchet unchanged;
`git diff --check` passed. Next: trace signed-user identity across runtime
preparation/provisioning and add route-level proof for Appendix E item 9,
without modifying accounts-owned contracts.

## Signed lifecycle context and authoritative withdrawal — 2026-09-13

The connection trace found two concrete gaps. Verified subject was available at
both connection handlers but dropped by the workspace-only preparation hook.
Separately, the MCP preparer omitted an empty secret set and cloud wake filtered
empty arrays, preventing withdrawal from reaching native drivers.

`WorkspaceRuntimeContext` now carries the verified subject and workspace id to
both preparation and provisioning. Initial cloud creation (including its
waitUntil chain), cloud connect/wake and user-hosted connect all pass it.
The Agent Plugins composition retains its existing snapshot selection; no
account selection or lease key is synthesized. The preparer emits its complete
secret list, including empty, and create/wake deliver that explicit empty list.

Failing tests first:

- Preparation/connection suite: 9 pass / 3 fail for omitted empty sets and missing withdrawal forwarding.
- Connection context suite: 4 pass / 2 fail for lost subject in cloud and user-hosted hooks.
- Hosted workspace route suite: 36 pass / 1 fail for lost subject in initial creation.

Final command from claxedo-server: `node node_modules/vitest/vitest.mjs run
src/routes/hosted/workspace.test.ts
src/connections/hosted-connection-info.agent-plugins.test.ts
src/agent-plugins/mcp/runtime-preparation.test.ts
src/agent-plugins/signed-composio.miniflare.test.ts`: 54 pass / 0 fail.
The Miniflare fixture was corrected to pass the complete produced Authorization
header; it previously stripped Bearer despite the consumer's whole-header
contract. An initial edit command used the wrong working-directory-relative
path, changed nothing, and was corrected before the failing-test run.

Changed files: `src/workspace/route-support.ts`,
`src/connections/hosted-connection-info.ts`,
`src/connections/user-hosted-connection.ts`,
`src/connections/hosted-connection-info.agent-plugins.test.ts`,
`src/routes/hosted/workspace.ts`, `src/routes/hosted/workspace.test.ts`,
`src/agent-plugins/hosted-composition.ts`,
`src/agent-plugins/mcp/runtime-preparation.ts`,
`src/agent-plugins/mcp/runtime-preparation.test.ts`, and
`src/agent-plugins/signed-composio.miniflare.test.ts` under claxedo-server;
design 002 and this report.

Remaining: Appendix E item 9 is partial, because the callback boundary is not
a per-user binding store or lease. No accounts-owned contract was edited.

Final gates: server `bun run typecheck` passed; root
`bun run test:architecture-ratchets` passed 13 tests and all five product/eight
source policies plus helper ratchet without baseline changes; `git diff --check`
passed. The first typecheck exposed the initial-create call sites, which were
then covered by a failing route test and updated.

## Scope coordination and exe.dev access — 2026-09-13

Commit `0fb565036d` contains the signed-context and withdrawal fixes. A scope
question is pending because full integration requires steps 3/4 and credential
contract edits explicitly reserved by the objective file. No dependent edit has
been made while awaiting that decision.

Independent exe.dev verification progressed beyond the earlier host-trust gate.
The scanned RSA key matched the provider's HTTPS-published fingerprint and was
supplied via a task-local known-hosts file. The authenticated read-only
`integrations list --json` command then failed with exit 255, Permission denied
(publickey,keyboard-interactive). Exact command and source are in Appendix E.
No user SSH configuration, provider integration, VM, or account was changed.
Live integration behavior remains not run until registered-key access exists.

## Generic broker stream ownership audit — 2026-09-13

The authorized skeleton audit found that `reportFailure` throwing after an
upstream 401/403 returned the authority-unavailable response without cancelling
the upstream body. Two failing tests reproduced this leak (21 pass / 2 fail).
The broker now cancels that body before propagating the failure to its existing
503 boundary. It does not retry the credential or change accounts.

A new actual Node loopback transport test also proves incremental delivery:
the client receives the first SSE chunk before the producer creates the second,
and client reader cancellation cancels the still-open upstream stream.
`node node_modules/vitest/vitest.mjs run src` from egress-broker passes 25 tests.
`bun run build` passes. Root `bun run test:architecture-ratchets` passes 13 tests
and all source/helper policies without baseline changes. `git diff --check`
passes. Changed files: egress-broker `src/broker.ts`, `src/broker.test.ts`,
`src/delivery.test.ts`, and this report.

The full-design scope question remains unanswered. Hosted binding storage,
account selection and per-user leases cannot be implemented within the original
explicit exclusions. External feasibility blockers remain as recorded: deployed
Cloudflare image upload, Daytona/ exe.dev/Modal account access, and the Vercel
project/team choice. No dependent store/lease edit or auth setup was performed.

## Resumed worktree validation and lockfile reconciliation — 2026-09-13

The resumed goal found new commits after `3e0b2992c7`:

- `65555767bc` — forward empty secret lists through the sandbox manager.
- `bb873fa3b6` — upsert Daytona secrets and remount without stale environment values.
- `3291c64ff5` — preserve ordinary traffic to Cloudflare credential hosts.
- `be4fca47cf` — reconcile supervisor bindings/policy before reporting ready.
- `a6e543005b` — pin the existing activation-owner credential subject limitation.
- `6839235ec7` — withdraw clone headers and report runtime boot failures.
- `ea2cedaa9c` — bound token mint lifetime, evict replaced generations and reject unusable destinations.

Current-state validation at `ea2cedaa9c`:

- Egress-broker `node node_modules/vitest/vitest.mjs run src`: 28 pass.
- Sandbox-manager `bun test src/drivers/daytona.test.ts src/manager.test.ts`: 77 pass.
- Claxedo-server `node node_modules/vitest/vitest.mjs run src/workspace/supervisor/cloud.test.ts src/hosts/workspace-runtime/host-run.test.ts src/hosts/workspace-runtime/runtime-boot.test.ts src/agent-plugins/mcp/runtime-preparation.test.ts scripts/sandbox/cloudflare-worker/src`: 127 pass across six files.
- `bun run typecheck` in those three packages: all pass.
- Root `bun run test:architecture-ratchets`: 13 pass; five product/eight source policies and helper ratchet pass without baseline changes.

The new manifest changes were absent from `bun.lock`: egress-broker's
`@tsconfig/node-lts` dev dependency and sandbox-manager's 0.9.0 workspace version.
The lockfile now includes exactly those two metadata changes. No resolved
package version or integrity hash changed.

The default install check hit the repository's three-day age gate for the
already-pinned Vercel/Modal SDKs. With the documented release-install setting,
`bun install --frozen-lockfile --lockfile-only --ignore-scripts
--minimum-release-age=0` wrote the corrected lockfile (Bun's lockfile-only mode
wrote it despite the frozen flag). The subsequent actual
`bun install --frozen-lockfile --ignore-scripts --minimum-release-age=0` passed:
2246 installs checked across 2659 packages, no changes. `git diff --check` passed.
Only `bun.lock` and this report changed in this validation slice.

The full-design authorization blocker is unchanged: the objective still excludes
hosted store and per-user lease changes and reserves credential contracts. At
this entry the registry still called `ensurePresetForProvider` without
workspace scope (superseded: removed, see the accounts-lane section). No renewed
live-provider or full-design completion claim follows from these focused
validation results. The scope decision remains pending.
