# Remote Access to the Local Desktop — Feasibility Review

Status: REVIEW (decision input; 3-agent deep review, code-verified 2026-07-17)
Question: can a user set up once and then access their **entire local desktop
app** remotely from a phone over the relay — vs today's design where only
workspaces are shareable?

## Verdict

**Do not expose the entire local app. Do build "set up once, reach your
machine from your phone" on the two-plane model that already exists** —
phone → hosted control plane (Clerk auth) → relay → your machine as a
user-hosted *workspace backing*. The machinery for this is real and wired
today (not stubbed); it is blocked by two known external items (device-login
Phase A, no staging deploy) plus two missing pieces (daemonization, a
machine-management UI). Full-app exposure, by contrast, is a from-scratch
auth-hardening project with showstopper-grade findings.

## Why full-app exposure is a showstopper today (code-verified)

The local trust model is one fact: **loopback peer = full owner, no
identity, no per-action authorization** (`unsignedLocalRequestGuard`,
`control-plane/deployment-mode.ts`; only 7 machine routes are allowed
non-loopback).

1. **A large fraction of the local surface has NO per-route auth at all** —
   protected only by the loopback gate: the entire OpenCode engine surface
   (`routes/opencode-compat.ts` — bare Hono, mounted without auth; includes
   session tool execution and `PUT /auth/:providerID` provider-key writes),
   the filesystem browser (arbitrary `readdir`/`readFile`), the PTY
   WebSocket, the local relay proxy, and the connections host (loopback
   caller gets the trusted-owner partition → can mint OAuth tokens).
2. **Enabling embedded auth makes it WORSE, not better**: signed mode makes
   the loopback guard pass through (`deployment-mode.ts:226`) without adding
   bearer checks to any of the routes above — they'd become reachable by
   non-loopback callers *unauthenticated*.
3. **Loopback short-circuits are used as trust primitives** throughout:
   `central-runtime.ts:85` skips session-ownership entirely on loopback;
   the "bare session ids are banned as bearer" rule holds only on the signed
   path and evaporates locally.
4. **Credentials**: `CLAXEDO_CREDENTIALS_TOKEN` is unset on desktops ⇒
   anonymous secret write/delete/sync on `/api/claxedo/credentials`.
5. **Blast radius** if exposed with weak auth: full RCE (PTY + agent tools),
   arbitrary FS read/write, provider/OAuth secret exfiltration.
6. **The relay can't carry it anyway** without redesign: tokens are
   per-`(workspaceId, hostId)` pair (no "whole machine" claim shape), the
   only route scheme is `/workspaces/:id/*` (no vhost/path routing for a web
   UI), cookies are deliberately stripped on the user-hosted path, there's
   no HTML/asset rewriting, and per-tunnel caps (32 in-flight HTTP / 16 WS
   channels / 16 MiB) are tuned for API traffic, not serving an app.

If full-app exposure is ever wanted, the mandatory floor is: per-user issuer
+ login UI; bearer verification added to **every** currently auth-less
route; an explicit per-route remote-exposable classification; truthful
relayed-traffic demotion (relay must stamp `x-forwarded-for`, box must treat
relayed as non-loopback); bearer-only (no cookies) through the relay;
per-device tokens with revocation UI. Park it.

## What already works (surprisingly much)

- **`claxedo up` is functional end-to-end, not a stub**: challenge→sign→
  register with a CLI-owned P-256 key (control plane never holds the
  private key), boots a real loopback workspace-runtime for one directory,
  opens a real multiplexed outbound WebSocket tunnel (HTTP+WS+SSE, ping/
  watchdog, auto-reconnect with backoff), heartbeats every 25s.
- **The phone path already exists**: the printed `/w/:workspaceId` URL
  resolves in the hosted app; a phone drives a user-hosted workspace over
  the same relay path as any client — sessions, files, PTY — gated by
  hosted auth + revocable runtime access tokens. Nothing phone-specific is
  missing in the transport.
- **`claxedo-server` itself can dial the tunnel** — `user-hosted-tunnel.ts`
  (`startUserHostedWorkspaceTunnel`) already lets the embedded server
  register a local-worktree workspace over the relay. This is the seed of
  the one-time-setup UX below.

## The gap list for "set up once → phone reaches my machine"

| Gap | State | Owner |
| --- | --- | --- |
| Device-login issuer (Phase A) | fails closed 501 by design until `CLAXEDO_DEVICE_LOGIN_ISSUER` configured | self-host/identity track — the same blocker as `claxedo connect`; building it pays three times |
| Hosted control plane + relay staging deploy | code complete, never deployed | ops |
| Reboot survival / daemonization | NOT BUILT — `--detach` is a detached process, dies on reboot | see recommendation: make the desktop app the daemon |
| Machine management UI | NOT BUILT — no "your devices/machines" surface; revoke is CLI-only on the machine | new, small |
| Session visibility | desktop-local sessions (`host: "local"`) live only in local SQLite — **invisible from the phone**; only user-hosted/central-placed sessions show | product decision Q10 |
| Relay HA | single Fly instance owns all tunnels; restart drops them until auto-reconnect | documented v1 limit, acceptable at launch |

## Recommendation: desktop-native "Enable remote access"

Instead of asking users to daemonize a CLI, make the **desktop app the
daemon** — it's already a long-lived signed-in process:

1. A one-time toggle in the desktop app (and onboarding step 4): **"Enable
   remote access"** → hosted sign-in (if not yet) → the embedded
   claxedo-server enrolls this machine (app-owned host key, same
   challenge/sign/register protocol) and starts
   `startUserHostedWorkspaceTunnel` for the user's local projects,
   registering them as user-hosted workspaces.
   **One tunnel per machine, not per workspace:** the CLI today creates a
   hostId + process + tunnel per directory, but the relay protocol already
   supports one hostId registering a *list* of workspaceIds over a single
   multiplexed WebSocket (`registerHostTunnel({ hostId, workspaceIds })`,
   relay routes by hostId then checks workspace membership). The desktop
   design uses ONE app-owned hostId and ONE tunnel serving every local
   workspace — no extra processes (the embedded server already serves them
   all), workspace additions are registration updates, and browser-side
   RATs stay per-workspace so the security scope is unchanged. Caveat:
   per-tunnel caps (32 in-flight HTTP / 16 WS channels) become machine-wide
   — fine for personal phone use, and relay-config-tunable if ever needed.
2. The desktop app keeps tunnels alive while running; "start at login"
   (standard Electron autostart) is the reboot story — no launchd/systemd
   work, no orphan CLI process.
3. Step 4's QR then points at `app.claxedo.com/w/<workspaceId>` — the phone
   sees and drives the same workspaces the desktop has, through hosted auth.
4. A small **Devices** section (Settings) lists enrolled machines with
   last-seen and revoke — revocation rides the existing runtime-access-token
   revocation.

What this deliberately does NOT give: the phone does not see desktop-local
session history (local-only SQLite), and does not touch the local control
plane's own surface — that's the security boundary working as designed.
**Q10 (product):** for remote-enabled projects, place new sessions so
they're visible from both surfaces (user-hosted placement), or accept
"phone sees workspaces + sessions started while remote-enabled" in v1.

## How one tunnel serves every workspace (mechanism)

The WebSocket is a pipe, not a call — the tunnel protocol multiplexes many
labeled conversations over one socket (same idea as HTTP/2 streams):

1. **Registration**: the desktop registers
   `{ hostId: <machine>, workspaceIds: [ws_a, ws_b, ws_c] }`. The relay
   directory stores one entry: this socket serves these workspaces. Opening
   another project later = a registration update, not a new connection.
2. **Routing**: an inbound `GET /workspaces/ws_b/...` is authorized by a
   per-workspace RAT, resolved to the machine by `hostId`, with
   `workspaceId` as a membership check against the registered list.
3. **Multiplexing**: each request travels as envelopes tagged `request_id`
   (HTTP) or `channel_id` (WS/SSE streams) plus the workspace id; both ends
   reassemble by id (`pending`/`channels` maps in the tunnel code), so
   concurrent traffic for different workspaces interleaves safely on one
   socket.
4. **Dispatch on the desktop**: the embedded claxedo-server already hosts
   all local workspaces in one process behind
   `/workspaces/:workspaceId/*` — the tunnel hands each envelope to the
   right one; no per-workspace runtime processes.
5. **Security unchanged**: browser tokens are minted per workspace and
   checked at both ends (relay before entering the pipe; host verifies the
   per-request RHT + workspace match). The machine-wide thing is only the
   transport pipe.

Only the CLI's per-directory habit (hostId + process + tunnel per folder)
made this look like N connections; the protocol, directory, and auth were
already pair-shaped for one-host-many-workspaces.

## Impact on onboarding

Step 4 ("Access remotely") on desktop no longer requires cloud compute as
its only unlock: **either** a cloud workspace **or** "Enable remote access"
(this review's toggle) lights it up. The step's copy becomes: "Turn on
remote access → scan → your machine, from your phone." Gated on Phase A +
relay deploy shipping; until then the desktop step stays locked with honest
copy.
