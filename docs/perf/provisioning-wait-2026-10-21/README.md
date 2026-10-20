# How soon a start notices its sandbox is up, 21 October 2026

A cloud workspace's start (onboarding's Create workspace, a new workspace, a wake) ends when the provisioner's run settles: `sandboxProvisionerClass` (`packages/claxedo-server/src/sandbox/provisioner.cf.ts`) takes the lease, and its alarm calls the organization's sandbox driver step by step, waiting each step's `retryAfterMs` before the next, until the driver hands back a serving target. The tab learns of the settle from the `cp/events` notice. This note measures how long after the provider's host is up each driver noticed it, before and after this lane.

The lane's brief assumed every driver answered `provisioning` with a fixed 2 s retry until its host was up. The code did not: the Cloudflare, Modal and Vercel drivers already block inside one step until the host answers, and the 2 s only followed a step that had already waited 30 s or more. Boat was the one driver whose readiness was a timer, inside its step: it read the sandbox every 2 s and probed the runtime's health every 1 s.

## Each driver, before and after

| driver | how it learns the host is up, before | after |
|---|---|---|
| Boat, machine | `GET /sandboxes/{id}` every 2 s inside the step for up to 120 s, then `provisioning` with a 2 s retry | the first command after the create or resume; Boat holds a command sent while a sandbox starts and runs it once the sandbox is ready, for up to 60 s, then refuses it as still starting ([readiness](https://docs.boat.dev/readiness), [execute command](https://docs.boat.dev/api/reference/agent/execute-sandbox-command)). A refusal is sent again at once; after the 120 s provisioning window the step answers `provisioning` with `retryAfterMs: 0`, since it was itself the wait |
| Boat, runtime | one `POST /commands` health probe per second (curl inside the VM, one Boat request each) | one command per 50 s window that probes inside the VM every 100 ms and answers at the first 200, or when the container leaves `running`/`paused` |
| Boat, a sandbox still archiving from a stop | `provisioning` with a 2 s retry, one provisioner step per read | read again inside the step after 250 ms, doubling to 2 s; Boat's stop has no blocking form ([stop](https://docs.boat.dev/snapshots/stop)) |
| Cloudflare | `ensure-runtime` blocks until the runtime is healthy: the sandbox Worker polls the container every 250 ms and the runtime's `/global/health` every 500 ms, and answers 503 after a 30 s health window (the caller's deadline is 300 s); after a 503 or a timeout, a 2 s retry | the same blocking call; after a 503 or a timeout the next step runs at once |
| Modal | `sandboxes.create` then `tunnels(30 s)`, both blocking; a 2 s retry after a tunnel timeout | the next step at once after a tunnel timeout |
| Vercel | `Sandbox.create` blocks until the sandbox runs; the driver starts the runtime detached and returns its URL, with no readiness wait of its own | unchanged |
| Docker | local; health polled every 250 ms | unchanged |

A transient provider error (a 5xx, a lost create acknowledgement) is not a readiness wait: every driver still waits 2 s before asking again, now one named constant, `TRANSIENT_DRIVER_RETRY_MS` (`drivers/transient-error.ts`).

What "ready" means is unchanged for every driver, and so are the provisioning deadline (the driver's own window per step, the provisioner's 15-minute wall), the lease epochs and the retry backoff of failed steps.

### What the 2 s was protecting

No provider's documentation names a status-read rate the 2 s kept under. Boat's one API-wide limit is 1,000 requests a minute from one IP address ([limits](https://docs.boat.dev/limits)), and every organization's Boat sandboxes are driven from the control plane's addresses, so the number of requests per start is what matters there. A Boat boot of 0.3–20 s with a runtime healthy 0–8 s later sent 18–19 requests before and 9 after (below): the held command and the in-VM probe replace the reads and probes, and the archive wait's longest gap stays 2 s, 30 reads a minute. Cloudflare's `ensure-runtime` goes to the organization's own sandbox Worker and is asked again only after it waited 30 s or more; Modal's `tunnels` after 30 s.

### The pollers' wait

The provisioner told a poller that joins a run to come back after the run's last step delay. With a driver answering `0`, a client without the `cp/events` notice (the desktop's connection read, the MCP relay, the session host) would have come back at its own floor (0.5–1 s) instead of 2 s, for a start that can take a minute. A run now keeps the wait it began with (the manager's `retryAfterMs`, 2 s in production) for its pollers, and only the alarm follows the driver's step delay (`Run.retryAfterMs`, `provisioner.cf.ts`). A failed step's retry is still reported as the time left until it.

## Measured settle times

`bunx vitest` over the real drivers with fake timers and fake providers whose host comes up at a chosen time, the base drivers (`origin/dev` 138854b173) against this branch's. A Boat request's round trip is 0 or 150 ms (the Worker in IAD to Boat; not measured, chosen to show its share). "Lag" is from the moment the provider's host is up to the moment the driver knows it.

Boat, one boot per host-up time from 0.3 to 20 s in 137 ms steps (146 boots), runtime healthy 0–7.9 s after its container starts:

| round trip | | machine lag | runtime health lag | Boat requests per boot |
|---|---|---|---|---|
| 0 ms | before | mean 988 ms, max 1988 | mean 501 ms, max 994 | 19 (max 25) |
| 0 ms | after | 1 ms | mean 51 ms, max 101 | 9 |
| 150 ms | before | mean 1164 ms, max 2214 | mean 736 ms, max 1299 | 18 (max 24) |
| 150 ms | after | 75 ms | mean 199 ms, max 249 | 9 |

At the brief's host-up times, 150 ms round trip, machine lag before → after: 0.3 s 2150 → 75 ms, 1.1 s 1350 → 75, 4.5 s 100 → 75, 12 s 1200 → 75; the before values depend on where the host-up falls in the 2 s read cycle. A Boat start therefore settles 1.4 s (0 ms round trip) to 1.6 s (150 ms) sooner on average, machine and runtime together, and up to about 3.2 s sooner.

Cloudflare, through a step loop that waits each answer's `retryAfterMs`, with the sandbox Worker modelled as above (one start per host-up time in 211 ms steps):

| host up after | round trip | before | after |
|---|---|---|---|
| 0.3–29 s | 0 ms | mean 251 ms, max 500 | mean 251 ms, max 500 |
| 0.3–29 s | 150 ms | mean 320 ms, max 571 | mean 320 ms, max 571 |
| 30.5–90 s | 0 ms | mean 291 ms, max 1856 | mean 252 ms, max 500 |
| 30.5–90 s | 150 ms | mean 373 ms, max 2090 | mean 323 ms, max 573 |

Inside the Worker's 30 s window nothing changed; the lag left is the sandbox Worker's own 500 ms health poll. A runtime that prepares for longer (a large repository's checkout) loses the 2 s gap between windows.

The schedule is asserted in `packages/sandbox-manager/src/drivers/boat-waits.test.ts`: a sandbox ready 0.3, 1.1, 4.5 or 12 s after its create is booted at that instant with no read; a start that outlasts Boat's 60 s hold is asked again at 60 s, and one that outlasts the 120 s window answers `retryAfterMs: 0`; an archive is read at 0, 250, 750, 1750, 3750, 5750 and 7750 ms; the health probe is one command of 50 s at 0.1 s intervals. The provisioner's half is `provisioner.workerd.test.ts` ("a driver whose step is a wait…"), which fails on the old provisioner with the poller told `0`.

## The onboarding rig

`bun run --cwd packages/claxedo-app e2e:perf-web --reps=3 --profile=india-staging --onboarding-only`, before on `origin/dev` 138854b173 and after on this branch, same session, a host shared with other lanes (load 16–40 on 12 cores, 0.1–3 GiB free):

| step | before p50 (reps) | after p50 (reps) |
|---|---|---|
| boot → Where it runs | 1095 ms | 1125 ms |
| Next → Project | 45 ms | 47 ms |
| Continue → AI | 15 ms | 19 ms |
| Create workspace → draft composer | 9721 ms (9721, 10930, 6724) | 7469 ms (7273, 7469, 8825) |

The rig cannot show this change: its driver is `cloudflare` pointed at the local sandbox emulator (`packages/harness/e2e/harness/hosted-sandbox-worker.ts`), whose `ensure-runtime` blocks while the local brokering driver spawns the runtime and polls its health every 100 ms, and never answers 503, so every start is one driver step before and after. The create-to-draft spread (6.7–10.9 s, against 3.9 s on a quiet host in [onboarding-steps-2026-10-20](../onboarding-steps-2026-10-20/README.md)) is that runtime's node start under the host's load; the difference between the arms is inside it.

## Not verified, and what is left

- Boat's held command was not exercised against Boat itself: this lane spent no Boat starts. Two documentation pages name the still-starting refusal differently (`sandbox_starting` on the readiness page, `boat_starting` in the command reference); the client accepts both. A staging start on a Boat key, with the start phases' `machine_ready` compared against the run before this branch, confirms it.
- The Cloudflare sandbox Worker's 500 ms runtime health poll and 250 ms container poll are now the largest lag left on that path (mean about 250 ms). The Worker is deployed by each organization (`packages/claxedo-server/scripts/sandbox/cloudflare-worker`), so a shorter poll reaches a person only after their Worker is redeployed; each poll there is an exec in the container, whose cost was not measured.
- Boat documents that a resume sent while a stop is still archiving takes the same machine back without a restore ([stop](https://docs.boat.dev/snapshots/stop)); the driver waits for the archive to end instead, since the resume API's answer in that state is not documented. Resuming at once would remove the 13–27 s archive from a wake right after a stop.
- Modal's TCP readiness probe is configured at 1 s, but the driver never waits on it (`tunnels` returns before the runtime listens), so the interval decides nothing today.
