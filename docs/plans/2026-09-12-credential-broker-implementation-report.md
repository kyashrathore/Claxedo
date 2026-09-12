# Credential broker implementation report

Date: 2026-09-12. Status: incomplete; paused at the explicit accounts-lane boundary.
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

- GitHub clone placeholder consumer, supervisor secret delivery, wake network policy, Daytona resume secret reconciliation, Cloudflare token renewal, and workspace-scoped credential network policy. Each needs its failing test before the fix.
- All Appendix E feasibility experiments and their results in the design.
- The `@claxedo/egress-broker` package, revisioned Binding contract, authenticated binding-id request path, injection/request policy/redirect/failure reporting, generic delivery adapter, Node control-plane hosting, and loopback hosting.
- Live Cloudflare image/runtime verification and any required SDK behavior fixes discovered there.

The hosted store and lease-key changes remain explicitly outside this round. The broker round is not complete.
