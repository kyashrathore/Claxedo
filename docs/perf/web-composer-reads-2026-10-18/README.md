# The composer's reads after the rail, 2026-10-18

After the rail's first fill, a signed web boot made four more control-plane reads for the composer and the rail: `agent-config/connections`, `remote-access/devices`, and on a machine workspace's draft `agent-config/harness` and then `agent-config/providers?nativeHarness=pi&view=summary` (45,070 bytes, 6.8 KB on the wire), beside the runtime's `harness-config-options` over the relay. On the hosted e2e stack with 600 ms added per request, a warm reload of a Pi draft on a machine workspace made 15 requests (10.9 KB on the wire, 57 KB decoded) in three dependent waves.

## The flow

1. **Wave 1, the boot.** `createServer` (`packages/claxedo-app/src/server/server.ts`) starts the account catalog and the rail's grouped first pages. The shell, the rail rows and the composer mount only once the catalog answers.
2. **Wave 2, what mounts after the catalog.**
   - The rail's `createRowNavigation` (`src/rail/view/row-navigation.ts:16`) and the draft's Where chip (`src/projects/draft-context.ts:15`) read `queries.machines.list()`, which is the account's `machines.list`, `GET /api/claxedo/remote-access/devices` (`packages/claxedo-server/src/routes/remote-access.ts:82`).
   - `AgentHarnessSelector` (`src/composer/view/agent-harness-selector.tsx:43`) mounts `createHarnessOptionList`, which reads `queries.agentConnections.list()` (`src/composer/harness/harness-option-list.ts:14`), `GET /api/claxedo/agent-config/connections` (`packages/claxedo-server/src/agent-config/hosted-routes.ts:54`).
   - A draft with no saved choice for its placement hydrates from the folder's harness when the placement is not a cloud workspace (`src/composer/harness/harness-hydrator.ts:110`): `harnessConfig.folderHarness` (`src/server/harness-config.ts:29`), `GET /api/claxedo/agent-config/harness?workspaceId=` (`packages/claxedo-server/src/routes/hosted/shell.ts:448`). The Worker opens the workspace, then reads the runtime's identity and `/api/wr/health` over the relay (`hostedHarnessRuntimeStatus`, now `src/routes/hosted/harness-runtime.ts:140`). Its answer names the harness and the model, which the chip shows; Send is enabled here.
3. **Wave 3, what the harness's answer unlocks.**
   - `fetchConfigOptions` reads the harness's options; a machine placement asks its runtime through the relay (`readOptions`, `src/server/harness-options.ts:59`) for the model list and effort levels.
   - `createHarnessAccountState` (`src/composer/view/harness-account-state.ts`) read Pi's provider catalog as soon as the harness was Pi. That is why providers waited for the harness: the read was enabled by `harness() === pi`. Its only readers are the setup notices ("Pi is not set up", "account refused") and the picker's empty model section, and both speak only when the harness's models answered none. The Worker answered Pi's catalog whole whatever view was asked (`piProviderCatalog`, `src/credentials/worker/pi.ts:30`, `projectPiProviderCatalog` in `claxedo-server-core/src/credentials/pi-provider-projection.ts:64`): every launch provider's models, connected or not. The first screen used only `connected.length` and the `refused` flags.

A cloud workspace's Pi draft opens on its saved choice and is ready to send before any request answers; its only composer read is the control plane's `agentConfig.harness.options` in wave 2. It also read the Pi catalog in wave 2.

## What changed

- **The account state is read only once the harness answered no model** (`answeredNoModel`, `src/composer/view/harness-model-availability.ts:55`, passed to `createHarnessAccountState` at `agent-harness-selector.tsx:94`). A draft whose options name a model never reads Pi's catalog or the effective accounts. Flow 51 asserts that a Pi draft listing models reads no provider catalog, and that a Pi draft without an account still says "Pi is not set up" (both red with the gate switched).
- **The Worker answers Pi's catalog in the view asked for** (`shell.ts:402`), as it already did OpenCode's and as the daemon does Pi's: `view=summary` keeps connected providers whole and names the rest with no models. A Pi summary is 487 bytes with no account and 2,964–4,174 bytes with OpenAI or Anthropic connected, against 45,070 (38 KB if OpenRouter is the connected one). Settings → Models and onboarding read the same summary.
- **The harness status resolves once and reads together** (`src/routes/hosted/harness-runtime.ts`, split from `shell.ts`). The host (or cloud target) and the caller's actor resolve in one round, one runtime token is minted through the relay client's `connect` (`src/workspace/relay-runtime-client.ts:21`), and the identity and health reads go out together. The health is used only once the identity matches. Measured against the D1 control plane with the real relay provider (`harness-runtime.d1.test.ts`): **8 serial D1 rounds and 2 relay round trips before, 5 and 1 after.** At staging's ~80 ms Worker-to-D1 hop that is about 240 ms plus one Worker→relay→machine round trip off the composer's critical read. The OpenCode runtime catalog reads its identity and catalog the same way.
- **A signed server starts the machine list and the agent connections at creation** (`createServerQueries`, `src/server/server.ts:116`), beside the catalog, so both move from wave 2 to wave 1. The rail's row markers and the Where chip's machine names arrive with the rows.

## Measured on the hosted e2e stack

`98-composer-reads-probe.spec.ts` runs against the signed e2e stack (Miniflare Worker and D1, the hosted machine, the real app build) with 600 ms added to every API and relay request. It times a warm `page.reload()` until the composer's chip is ready (`data-readiness="ready"` and `data-ready-for-submit="true"`, or ready on a managed model). Requests are recorded on every origin, so the relay's reads count. "Before" is dev `79cf281121`; "after" is this branch.

| scenario | requests | dependent waves (all) | on the wire | decoded | chip ready | devices / connections wave |
| --- | --- | --- | --- | --- | --- | --- |
| machine workspace, Pi draft: before | 15 | 3 | 10,911 B | 57,274 B | 1970 ms (wave 2) | 2 |
| machine workspace, Pi draft: after | 14 | 3 | 4,102 B | 12,204 B | 1958 ms (wave 2) | 1 |
| cloud workspace, Pi draft: before | 10 | 2 | 9,500 B | 51,783 B | 713 ms (no request) | 2 |
| cloud workspace, Pi draft: after | 9 | 2 | 2,685 B | 6,708 B | 714 ms (no request) | 1 |
| session on a connection harness: before | 17 | 3 | 5,142 B | 12,399 B | 1404 ms (wave 1) | 2 |
| session on a connection harness: after | 17 | 3 | 5,140 B | 12,399 B | 1379 ms (wave 1) | 1 |

The chip's ready time does not move locally. The draft's chip waits on the harness status, which still needs the catalog to tell a machine placement from a cloud one. The local relay and D1 answer in microseconds, so the three serial rounds and one relay trip saved on that status read show only in the D1 rounds test, not here. Wave 3 is the harness's options (effort and model list), which the chip does not wait on.

```
python3 -I waves.py machine-before-600.json machine-after-600.json
```

## Experiments not taken

- **Reading the folder's harness at boot, before the catalog.** This would put a machine draft's ready chip in wave 1. The read must know the placement is not a cloud workspace, and a reload's URL does not say. Consuming an early answer would also need the hydrator to read status through the query cache: a second home for a server-owned lifecycle the harness store already holds. Not done.
- **Letting the harness answer carry the options.** The options for a machine placement come from the machine's runtime over the relay, not from a cheap indexed read. The Worker would add a relay call to the status route rather than save a client wave. Not done.
- **Deferring the connections read until the picker opens.** Every composer lists harness options from it, a connection harness's options wait on it, and it is 383 bytes. It moved earlier instead.
- **Starting the caller's actor beside the workspace open.** This saves a D1 round only for a cloud workspace, whose drafts never read the status. On a machine workspace the host lookup needs the opened workspace either way.

## Files

- `98-composer-reads-probe.spec.ts`: the probe. Copy it into `packages/claxedo-app/e2e/flows/`, then run `CLAXEDO_E2E_PORT_RANGE=48700-48779 PROBE_OUT=/tmp/machine.json PROBE_CLOUD_OUT=/tmp/cloud.json PROBE_SESSION_OUT=/tmp/session.json bun run e2e -- e2e/flows/98-composer-reads-probe.spec.ts --project=web --reporter=list`. It waits on a timer for trailing requests, which flows never do, so it is not a flow of the suite.
- `waves.py`: the wave computation over a run's JSON, marking the requests that ended before the chip was ready.
- `*-before-600.json`, `*-after-600.json`: the runs above.
