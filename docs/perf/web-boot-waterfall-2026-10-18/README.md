# The signed web boot's API waterfall, 2026-10-18

The rail of a signed browser boot was filled only after two dependent waves of control-plane requests: the catalog (`/api/claxedo/bootstrap`, `/api/workspace?host=provisioner`, `/api/workspace?host=machine`, `/api/workspace/shared-sessions`, `/api/claxedo/auth/descriptor`, `/api/auth/get-session`), then one `/api/control/session-list?scope=project` read per project, because the rail's first fill took the project ids from the catalog. Staging from India, warm asset cache, five projects: the HTML at 0.9 s, the JS running at 1.2 s, wave 1 answered at 3.4 s, the five session-list reads at 3.4–5.2 s, so the rail was complete at about 5.2 s after 15 API requests.

## What changed

- `GET /api/control/session-list?scope=projects` (the account operation `session.pages`) answers the first page of every project the reader may open a workspace in. The Worker reads the reader's project ids from the workspaces the reader may open (one indexed query) and runs the exact `scope=project` statement for each in one D1 `batch`, so the answer is one round trip from the same read each project page uses. `listFirstPages` in the app starts that read as soon as the rail's fill begins on a non-loopback server, before the catalog has named a project, and each project's page is cut from the answer; a project's later pages stay its own `scope=project` read with `after`.
- The account catalog reads `workspace.list.provisioner` alone: the Worker's `host=machine` answer is that list's `local-worktree` subset of the same `listWorkspaces` rows, so the second request carried nothing new. The operation `workspace.list.machine` is gone from the account contract.
- The cloud workspace list (`queries.cloud.list`, the composer's Where chip and Settings → Projects) is a projection of the account catalog's rows, not a second `GET /api/workspace?host=provisioner` after the catalog arrived.

## Measured on the hosted e2e stack

`98-boot-waterfall-probe.spec.ts` runs against the signed e2e stack (Miniflare Worker and D1, the hosted machine, the real app build): five projects with one prompted session each, 600 ms added to every API request through `page.route`, the account signed in, then a warm `page.reload()` timed until the rail shows five rows. `waves.py` recomputes the dependent waves from a run's JSON (a request's wave is one more than the deepest request that ended before it started; the previous page's aborted requests are dropped).

```
python3 -I waves.py before-600.json after-600.json
```

| build | API requests until the rail is filled | dependent waves | rail rows visible after reload | all boot API requests |
| --- | --- | --- | --- | --- |
| dev 8b2d1e949b (`before-600.json`) | 11 (6 catalog + 5 session-list) | 2 | 3847 ms | 19 |
| this branch (`after-600.json`) | 6 (5 catalog + 1 session-list) | 1 | 1206 ms | 15 |

The five parallel `scope=project` reads took 728–2484 ms each on the local D1 (600 ms of it injected): D1 answers them one after another. The one `scope=projects` batch took 671 ms.

The requests after the rail is filled are the same in both builds and are not this change's: one `/api/workspace/:id/connection` read per machine-placed workspace (the placement streams' relay links), `remote-access/devices` and `agent-config/connections` at shell mount, and the composer's `agent-config/harness` then `agent-config/providers` chain.

## Model of staging

Every staging request cost 1.2–2.3 s from India in the 2026-10-18 capture. The rail's fill goes from wave 1 (1.2 s → 3.4 s) plus wave 2 (3.4 s → 5.2 s) to wave 1 alone, with the grouped read in it: about 3.3–3.5 s instead of 5.2 s, and 6 requests before the rail instead of 11. The one request the rail now waits on is a single D1 batch rather than five reads D1 serves in turn, which is why the measured second wave spread from 560 to 1868 ms per request.

## Files

- `98-boot-waterfall-probe.spec.ts`: the probe. Copy it into `packages/claxedo-app/e2e/flows/` and run `CLAXEDO_E2E_PORT_RANGE=48500-48579 BOOT_PROBE_OUT=/tmp/run.json bun run e2e -- e2e/flows/98-boot-waterfall-probe.spec.ts --project=web --reporter=list`. It is not a flow of the suite: it waits on a timer to collect the requests after the rail, which flows never do.
- `waves.py`: the wave computation over a run's JSON.
- `before-600.json`, `after-600.json`: the two runs above.
