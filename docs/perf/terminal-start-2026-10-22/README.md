# Starting a terminal on a cloud workspace, 22 October 2026

The owner, on the web from India against staging: "starting a terminal takes up to 2 minutes when the machine boots in seconds." The workspace is `ws_mvfqicz4_68nx2wwd5a211tk4`, a Boat sandbox.

The up-to-2-minutes is a Boat resume onto a runtime image that changed since the workspace last ran. The machine is up in 3–7 s. Our Boat driver then pulls the whole image and copies its trees before the runtime starts, which takes 60–100 s. Staging publishes a new image on almost every deploy, so almost every first wake after a deploy pays it. A wake whose image did not change prepares it in 0.6–2.4 s.

That wait is not fixed here. Whether a resume should serve the previous image or fetch only the changed layers is the owner's decision (below). This branch fixes the terminal's own seconds on either side of the start, and makes the image build keep its unchanged layers, which a delta update would need.

## The flow and its waits

A person presses a tile in the terminal creator (`TerminalCreator`, `packages/claxedo-app/src/terminal/view/terminal-creator.tsx`).

1. **`terminals.create`** (`src/server/terminals.ts`) runs `wakeIfStopped`. If the catalog reads the placement as stopped, it runs `startWorkspace` (`src/server/workspace-start.ts`):
   - It sends `POST /api/workspace/<id>/connection` with `{ retry: true }`, then polls with each answer's `retryAfterMs`. That is 2 s on staging, clamped to 0.5–30 s.
   - A `cloudWorkspaceChanged` notice on `cp/events` cuts a wait short.
2. **The control plane** (`hostedConnectionInfo` → `SandboxProvisioner`, `packages/claxedo-server/src/sandbox/provisioner.cf.ts`) answers `provisioning` while its alarm drives the Boat driver step by step. `resumeHost` (`packages/sandbox-manager/src/drivers/boat.ts`) runs these phases in turn, each one a `sandbox.start_phase` in PostHog:
   - waits out an archive;
   - resumes the machine and holds a command until it is ready (`machine_ready`);
   - runs `prepare` and `start` (`image_ready`);
   - publishes the port and probes the runtime's health inside the VM (`runtime_ready`).

   After `runtime_ready` the provisioner pushes settings, plugins and lease env (`push`, `hosted-runtime-delivery.ts`) and settles. The next poll answers `ready` with a relay link.
3. **The tab** re-reads the catalog, and the start's link is adopted by the relay client (`src/server/relay.ts`).
4. **`POST /api/wr/pty`** goes through the relay:
   - the edge Worker;
   - the workspace's room Durable Object, which looks up the target and token revocation (cached 10 s);
   - the Boat ingress;
   - the runtime, which asks the control plane's session authority on every PTY request (`terminal-authority.ts`).
5. **The pane mounts** and `attachTerminal` opens `…/pty/<id>/connect`. The same chain admits the WebSocket upgrade, and the runtime answers with the cursor frame.

Closing the pane calls `DELETE /api/wr/pty/<id>`. The rail drops the row when that answers.

## Where the two minutes went

These are Boat resumes from PostHog `sandbox.start_phase`, by `workspace_id`, epoch and phase. "Image changed" means the staging deploy job's log names a different image tag than the workspace's previous boot.

| wake (UTC) | image changed | machine_ready | image_ready | runtime_ready |
|---|---|---|---|---|
| 10-15 12:16 | not checked | 5.1 s | 1.4 s | 2.3 s |
| 10-15 12:42 | not checked | 7.0 s | **59.6 s** | 2.5 s |
| 10-17 14:20 | yes (→ f6d2bb558d) | 3.6 s | **91.9 s** | 1.4 s |
| 10-17 15:10 | no (f6d2bb558d) | 3.3 s | 1.5 s | 13.4 s |
| 10-20 18:19 | yes (9f667af986 → d75fd57349) | 3.8 s | **95.1 s** | 1.3 s |
| 10-21 18:31 (owner's) | yes (d75fd57349 → c653c85c5e) | 3.2 s | **80.4 s** | 1.4 s |
| 10-22 04:21 (owner's) | no (c653c85c5e) | 5.2 s | 1.6 s | 13.4 s |

Over 30 days `image_ready` on a resume has two clusters: 0.6–2.4 s and 33–102 s. The owner's wake on 21 October spent about 89 s on the server before the first `ready`. After that came the tab's poll (≤ 2 s), the catalog re-read, the PTY create and the attach.

In `boat.ts` `containerScripts().prepare`, a resume whose image's trees are not seeded does the following:
1. `docker pull` of the image. The driver's own comment measures this at 47–67 s.
2. A copy of all seven trees through `docker cp | tar`.
3. Removal of the previous image's trees.

After the container starts, `removeImage` deletes the image and Boat's saved archive of it, so no layer survives to the next image.

The images themselves shared nothing they could have. The ghcr manifests of d75fd57349 and c653c85c5e are both 1,119.6 MB compressed in 14 layers. Every layer from the apt layer on carries a new digest at a byte-identical size:

| layers | size |
|---|---|
| apt | 152.3 MB |
| npm globals | 277.8 MB |
| agent CLIs | 347.9 MB |
| runtime | 258.2 MB |

CI built every step afresh.

Two wakes with an unchanged image spent 13.4 s in `runtime_ready`, against 1.3–2.5 s in the others. That is the runtime's own boot inside the container (its checkout check, the repository's `start.sh`, and the OpenCode engine's `prepare` when the workspace has one). It was not traced further here.

## The terminal's own seconds

Measured from India against staging with the dev CLI's bearer. The probe:
1. reads the connection;
2. lists and creates a PTY through the relay;
3. opens its WebSocket to the first frame;
4. deletes it.

`wrangler tail` ran on the control plane and the relay at the same time. The workspace was awake.

| step | wall from India | inside |
|---|---|---|
| `GET /api/workspace/<id>/connection` | 1.6–3.9 s, once 12.6 s | `total` 1.6–2.0 s: auth 0.42–0.58, d1 0.65–0.94, do 14–16 ms, and 0.6–0.85 s no entry named. The 12.6 s read had `do;dur=9760`. |
| relay `GET /api/wr/pty` | 1.2–2.9 s | `runtime-total` 0.18–1.14 s |
| relay `POST /api/wr/pty` | 0.67–7.2 s | `runtime-total` 0.19–1.11 s |
| WebSocket open to first frame | 1.0–2.6 s | |
| relay `DELETE /api/wr/pty/<id>` | 3.8–4.9 s | `runtime-total` 3.2–3.3 s, every time |

### What the relay hop is made of

The room's lookups on the control plane are mostly fast. Over 9 h of tail, `internal/relay/target` was p50 246 ms and p99 2.5 s, and `internal/relay/revocation` was p50 93 ms and p99 3.2 s. The runtime's per-request `session-authorize` was p50 144 ms and p99 491 ms across 14,842 calls.

The Boat ingress for this workspace (`*.on.ascii.dev`) resolves to OVH in Gravelines, France, while the workspace's home region and the relay room are us-east. Timed directly from India, its `/global/health` took:
- 0.2 s p50 and 0.6 s p90 on a warm connection, over 40 requests;
- 0.7–2.7 s per request on a new connection;
- once 9.1 s to first byte.

The 7.2 s `POST` and the multi-second relay tails match the Boat ingress's own tail, not ours. Placing the room by where the sandbox actually runs rather than by the workspace's home region would shorten every relay request for a Boat workspace. That is not done here; the lease does not record the provider's region.

### The 9.8 s Durable Object read

The 12.6 s connection read spent 9.76 s in `do`, the provisioner's `inFlight()` RPC. That read predates the tails, so it has no inside view. Later RPCs measured inside the object:
- `inFlight()` took 8–29 ms while no run was in flight.
- It took 0.45–2.0 s during the 22 October wake, with the alarm's step running beside it.

Every later read from the Worker measured `do` at 14–376 ms. It was not reproduced, and no fix is made for it.

## What changed on `perf/terminal-start`

| change | before | after | test (fails before, passes after) |
|---|---|---|---|
| Closing a terminal hangs it up right after its SIGTERM (`retire`, `packages/process-ownership/src/launch/retirement.ts`). Before: SIGTERM, then the full `termGraceMs`, then the hangup, then SIGKILL. A login shell ignores SIGTERM. The hangup stays after the signal: sent first, it leaves a zombie group that macOS refuses a signal to (EPERM), which left the terminal unresolved in 2 of 6 runs of the local daemon's idle-grace test. | removing a `/bin/bash -l` PTY: 3,982 ms, ending with SIGKILL; staging's runtime 3.2–3.3 s per `DELETE` | 45–48 ms, ended by the hangup, SIGTERM only | `real-spawn.test.ts` "removing an interactive login shell ends it at its hangup…"; `launch-gate.test.ts` "a shell that ignores SIGTERM ends at its hangup without waiting out the TERM grace" |
| A terminal created right after a wake uses the start's link (`relay.connection` prefers a usable held link over an in-flight read). Before, the event stream that opens on the catalog re-read minted its own link, and the terminal's `POST` waited on that read. | signed e2e stack: the PTY `POST` waited for the stream's `GET …/connection` | the `POST` leaves 2 ms after the start answers ready; on staging that read is 1.6–2.0 s at the Worker plus the round trip | `relay.test.ts` "a request made while a connection read is still in flight uses the link a start just adopted…" |
| A ready workspace's connection read passes the lease it already read to `runtimeProvisioned`, and the runtime call is charged as `upstream` with its host. Before, `supervisorClient` read the lease again and the call was untimed. | one more serial D1 round per read; the 0.6–0.85 s runtime call shown nowhere | one lease read; the call shows as `upstream` / `upstream-host` | `hosted-connection-status.test.ts` "asks the runtime the lease it already read names…"; `hosted-runtime-delivery-default.test.ts` "readiness asks the runtime the caller's ready lease names…" |
| The sandbox image build reads and writes a registry layer cache (`sandboxImageBuildArgs`, `<repository>:buildcache`, `mode=max`) on every pushed build. | each deploy's image had new digests for 1,042 MB of unchanged layers | runtime-only change: 860.5 MB keeps its digests, 259.1 MB is new | `build-sandbox-image.test.ts` "a pushed build reads and writes the layer cache…" |

The layer-cache proof uses the real build args against a local registry:
1. Image A built in a fresh `docker-container` builder (735 s, amd64 under emulation).
2. The runtime bundle changed.
3. Image B built in another fresh builder that imported A's cache (501 s).

B's first ten layers kept A's digests: base 82.4 MB, apt 152.3, npm globals 277.8, agent CLIs 347.9. The four runtime layers were new. The runtime's `npm install` layer is still rebuilt whenever the bundle changes, because `COPY .build/` precedes it.

The cached steps no longer pick up newer Debian packages until the Dockerfile's apt line or base image changes.

The cold path on the signed e2e stack (cloudflare driver emulator, a Shell tile on an asleep cloud workspace, after this branch):

| step | time |
|---|---|
| first start POST answers provisioning | 0.07 s |
| second poll after the 2 s wait answers provisioning | 2.08 s |
| settle notice; third poll answers ready | 2.15 s |
| PTY created | 2.19 s |
| WebSocket's first frame | 2.32 s |
| pane attached | 2.47 s |

On an awake workspace the pane attaches 0.16 s after the press. The emulator boots in about 2 s, so this shows the app's order of requests, not Boat's time.

## Not done, and why

- **The image wait (60–100 s) is the owner's decision.** There are two ways:
  - **(A) Serve now, update later.** A resume whose new image is not seeded starts the previous image's container (about 2 s) and reads as outdated. The app already offers Restart to update. Today the connection read refuses an outdated runtime with 409 `cloud_runtime_image_outdated` (0228cdd5d1), and that refusal would become a notice.
  - **(B) Delta update.** With this branch's layer cache in place, the driver fetches only the layers the trees lack (about 260 MB today, against 1.1 GB) and applies them, with OCI whiteouts, onto a copy of the old trees. What a person installed into the trees would then survive an update, which it does not today.
- **Unverified:**
  - The split of the 80–95 s between the pull and the tree copy on Boat. No Boat start was spent on a changed image; the two stopped workspaces in the owner's project refuse every start with 409 `runtime_prepare_failed` ("Plugin composio is not installed from claxedo for this project"), and the owner's live workspace was not stopped.
  - The relay ordering fix and the connection read change are not yet measured on staging.
  - The hangup order on Windows, where the pseudoconsole now closes right after the job's tree is ended, with no grace between.
- **Not traced:** the 13.4 s `runtime_ready` of some unchanged-image wakes, and the 9.8 s Durable Object read.

## Reproducing

The phase table comes from PostHog:

```sql
SELECT properties.workspace_id AS ws, properties.epoch AS epoch, min(timestamp) AS at,
  maxIf(toInt(properties.duration_ms), properties.phase = 'machine_ready') AS machine_ms,
  maxIf(toInt(properties.duration_ms), properties.phase = 'image_ready') AS image_ms,
  maxIf(toInt(properties.duration_ms), properties.phase = 'runtime_ready') AS runtime_ms
FROM events
WHERE event = 'sandbox.start_phase' AND properties.driver = 'boat' AND properties.boot_mode = 'resume'
GROUP BY ws, epoch ORDER BY at
```

To compare two images' layers, read their manifests from ghcr with an anonymous pull token (`https://ghcr.io/token?scope=repository:kyashrathore/claxedo-sandbox:pull`). The deploy job `boat sandbox image` logs the tag each staging deploy published.
