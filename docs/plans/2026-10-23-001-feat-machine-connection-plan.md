# Machine connection: fast, reliable, safe and trustable

This plan makes a person's own machine (a laptop, a home or office desktop, an AWS or other cloud VM) feel local
when it is near and stay fast when it is far, without giving up live access control or putting keys where they do
not belong. It extends [Remote machine connection](./2026-09-14-003-feat-connect-implementation-plan.md), whose
P1–P3 shipped; that plan's P4–P6 stay where they are.

The bar is T3 Code's remote machines (direct LAN, Tailscale and SSH routes with nothing in the middle) and beyond
it: the same speed with nothing extra to install, sharing between people, live revocation, keys that never reach a
machine that does not need them, and traffic we cannot read.

## 0. Decisions

Decided by the owner on 2026-10-23:

- **W7 is parked.** Per-machine certificates, a domain of our own and DNS infrastructure cost more than a direct
  LAN route for the web returns now; the web keeps the relay. Connecting a machine is the focus instead
  ([Connecting a machine](./2026-10-23-002-feat-connect-a-machine-ux-plan.md)).

- **Model credentials by machine kind.** A cloud machine (AWS and the like) spends the owner's accounts through
  the hosted egress broker on the control plane, so the real key never reaches it. A machine on the owner's LAN
  spends them through the egress broker on the owner's main machine (the desktop app), so the key never leaves
  that machine. A broker inside the connected machine's own connector is not built.
- **The hosted broker serves plan accounts** (Claude Pro/Max, ChatGPT plans), not only API keys.

Decided by the owner on 2026-10-22, answering the open questions below:

- **Revocation on the machine (W3):** "revoked within about a second, a minute at worst" is accepted.
- **Which machines are LAN machines (W4):** none is marked. A machine the owner's desktop reaches directly on the
  network (W1) spends through the desktop's broker; any other spends through the hosted broker. This replaces the
  earlier default of pausing a LAN machine's model calls while its main machine is away: the owner asked for the
  hosted broker in that case.
- **W6** is closed (rooms already follow the machine). **W2** is reshaped as its Assessment says.

Open, for the owner (each blocks only its own workstream):

1. **W9, end-to-end encryption.** The relay could then not read traffic; shared sessions need keys handed to every
   viewer. Wanted, and when?
2. **W10, agents without admin.** A separate low-privilege OS user stops an agent reading the connector's memory
   or damaging the machine, but tasks such as installing a printer driver need admin. Default on or off per
   machine?

## 1. Where it stands (measured 2026-10-22, from India)

| Path | Today |
|---|---|
| Assign a folder → the machine serves it | 2.5–3.8 s (was 14.7–16.6 s before the host-changed ring) |
| Terminal on a connected machine, mint → first output | 5.0–5.3 s (was 7.7–12.6 s) |
| One request through the relay | ~0.4 s warm; 1.7–3.5 s on a fresh connection |
| Keystroke echo through the relay | ~0.2–0.4 s (estimated from the relay's 180–205 ms host leg plus the edge) |
| Same request over a LAN, for comparison | ~1–10 ms |
| Connector stop | 0.75–1.7 s, 2.9 s with a terminal open |
| CLI install from npm | 2–3 min on Linux and macOS; 29 min on Windows (cause not isolated) |

Every byte between the app and a connected machine goes through the relay (`@claxedo/workspace-relay`, one Durable
Object room per workspace). A room is placed once, when it is created, and for a machine that is the machine's own
tunnel dial: the room lands in the region of the machine's Cloudflare edge country, or `apac` for a country outside
the table (`relayLocationHint`). The machine checks the relay's 60 s Relay Host Token itself, then still asks the
control plane, uncached, on every session read or write, terminal create, attach and 10 s renewal, and every stream
lease. The connector only dials out; its runtime listens on loopback; the heartbeat reports that a machine is
online, not where it is.

What a connected machine can spend today: Pi gets the owner's accounts through push-config's direct rows, which put
the raw secrets on the machine (`ownerPiDirectRows`). Claude Code and Codex use the machine's own CLI login.
OpenCode gets nothing deliverable without a hand-authored key.

## 2. Target

```
          same network                       different networks / far away
app ─────────────────────────▶ machine      app ──▶ relay (fallback, or setup only) ──▶ machine
     direct route (W1, W7)                       peer-to-peer once set up (W8)
     access checked on the machine (W3)          one connection per workspace (W2)
     model calls → owner's main machine (W4)     model calls → hosted broker (W4)
```

A machine has several routes; the app uses the best one that answers and moves back to a better one when the
network changes. The relay stays the route that always works.

## 3. Workstreams

Each workstream proves its behaviour live before its broad suites run (AGENTS.md, "Validation cadence"): build,
run it through its real entrypoint against staging or a real machine with the logs tailed, cover every case it
claims, and only then run the affected replay and e2e flows at merge.

Assessed against the code on 2026-10-22; each workstream's **Assessment** says what it buys, what it costs and
why it was or was not built:

| | Verdict |
|---|---|
| W3 | Built; proven on staging (`ecaee99e66`) with a machine built from dev `e36efd45` |
| W1 | Built; proven against staging from one box, where the direct route answers in milliseconds; the desktop app end to end and a real two-machine LAN are not measured |
| W2 | Not built as written: most of it already holds, and what is left is small; reshaped below |
| W4 | Cloud path built for every `claxedo connect` machine; LAN path built: a machine its owner's desktop reaches spends through the desktop's broker. Both proven on the hosted stack run locally; plan refresh and a deploy remain |
| W5 | `claxedo doctor`, the service's PATH and Pi's Windows bash built; installers need a Windows box |
| W6 | Already met by how rooms are placed |

### W1 — Direct route on the same network (desktop app first)

The connector also listens on its private interfaces (LAN, tailnet) behind TLS, and reports those addresses in its
heartbeat. The desktop app connects to them directly, pinning the certificate fingerprint the control plane hands
out at enrollment, and falls back to the relay on any failure. It re-checks routes on network change and on focus.

Trade-offs: the machine opens a port on its private network (bound to private interfaces only, TLS plus a W3 grant
required, switchable off per machine). The web app is not covered until W7.

- [x] The connector serves its runtime routes on its private addresses, TLS 1.3 only. Progress: the listener
  (`claxedo-host-serving/src/direct-listener.ts`) binds only RFC 1918, CGNAT (tailnet) and unique-local addresses,
  behind a self-signed P-256 certificate of its own key. It admits only the owner's workspace-wide Runtime Access
  Token, verified against the control plane's key set, with the token's standing asked of the control plane and
  remembered 10 s as the relay remembers it (`direct-admission.ts`). It refuses session-scoped tokens, strips the
  relay-only headers, and answers 503 `machine_paused` and closes the terminals it carried while the owner has the
  machine paused.
- [x] Heartbeat carries the machine's private addresses and certificate fingerprint. Progress: the control plane
  keeps only the enrollment's current routes (`host_direct_routes`) and hands them only to the workspace owner's
  connection, and only while the machine serves.
- [x] The desktop's route. Progress: the daemon carries HTTP and WebSocket to the machine over TLS pinned to its key
  (`PUT /api/claxedo/direct-routes/:id`, `/direct/workspaces/:id/*`), so the renderer keeps talking to loopback; the
  app's route machine (`claxedo-app/src/server/direct-route.ts`) moves between relay, probing, direct and refused,
  falls back to the relay on any failure, and checks again on the online, focus and visibility signal.
- [ ] Live: desktop and machine on one LAN, terminal open ≤ 0.5 s, keystroke echo ≤ 20 ms; pull the LAN cable
  mid-session and the session continues over the relay. Progress: proven on one box over a private alias address:
  HTTP and terminal sockets went direct (established TCP connections to the alias rose while the direct terminal
  was open), a token refreshed away was refused on the direct route within 13 ms, a cut LAN port fell back to the
  relay in 22 ms and came back on a recheck, and a pause closed a direct terminal in 32 ms and refused reads until
  the resume, 116 ms later. On staging (2026-10-23, dev `e36efd45`, machine and client on one Linux box in IAD, the
  route on a private alias address, the client pinning the key the connection named): reads 2–4 ms, a terminal
  created in 11–20 ms after the first request (600 ms, the one authority check), its first frame 8 ms after the
  socket opened, keystroke echo 3–6 ms where the relay's was 81–159 ms (p50 83 ms); a wrong token was refused 401.
  Not measured: the desktop app using the route end to end, a real two-machine LAN or tailnet, macOS, Windows, IPv6
  and the signed Electron renderer.
- [x] A per-machine switch turns the private listener off. Progress: `claxedo connect --direct on|off`, saved, on by
  default; off, nothing listens and the connection names no routes (proven live).

Rollout order: run `create table host_direct_routes` on the deployed control-plane database, deploy the control
plane, then release the desktop, and the CLI last. The heartbeat schema is strict, so an older control plane
refuses a beat that reports routes, and the connector treats that 400 as a decision and stops.

**Assessment.** The dependency on W3 is harder than stated. The daemon's ingress (`localHostRelayActor`), the
runtime's `createRelayHostAuthMiddleware` and the control plane's session authority each admit only a
relay-minted RHT, and a direct caller must never come out as `loopback-direct`, which is the machine's owner.
Without W3 a LAN terminal still pays the machine's authority call to the control plane, so echo drops to about
10 ms but a terminal open keeps that call's 0.4–1.9 s from India (inferred from §1, not measured on a LAN). The renderer path is costly: `connect-src` lists exact origins
stamped at load, the runtime sends no CORS headers, Chromium's Local Network Access gating may apply, certificate
pinning is possible only in main (`setCertificateVerifyProc`), and the repository has no certificate library.
Built in that shape: the direct route lives in the daemon, which reaches the LAN address over Node TLS pinning the
listener's own key, so the renderer keeps talking to loopback; with W3 a terminal reuses the machine's authority
answer over the direct route as over the relay (six direct terminals cost one control-plane check where they cost
twelve), and the direct admission asks the control plane once per token per 10 s.

### W2 — One connection per workspace

All terminals and requests for a workspace ride one multiplexed connection instead of a new secure connection per
terminal.

Trade-offs: one large transfer can delay keystrokes on a shared connection, so streams need priorities; a transport
change across app, relay and runtime.

- [ ] One connection carries requests, terminal streams and events, with per-stream priority (input and terminal
  output above file transfers). Progress:
- [ ] Live over the relay from India: second and later terminals open ≤ 1 s; a 200 MB download does not raise
  keystroke echo by more than 50 ms. Progress:

**Assessment.** Most of this already holds. The browser's runtime requests share one HTTP/2 or HTTP/3 connection to
the edge (the relay is same-origin under `/relay`), and the machine already carries every stream of a workspace on
one tunnel (`setHostServing`). What is left is a terminal's WebSocket, which opens its own connection: 0.24–0.44 s
of TCP and TLS from India, out of 0.76–1.31 s for the whole open. The rest is the relay hop and, on the create, the
authority call that W3 removes. A multiplexed stream protocol through app, relay room and runtime would replace
fetch and WebSocket for every runtime call. It would also add head-of-line blocking on the client leg, which
separate connections do not have; the 200 MB criterion guards against a problem this design creates there.
Proposed instead: measure a second terminal's open after W3; if the handshake still dominates, keep a warm terminal
socket per workspace; give the host tunnel per-stream priority only if a measurement shows a transfer delaying
keystrokes on it.

### W3 — Access checked on the machine, revoked live

A connected machine reuses the control plane's allowed answers for up to a minute instead of asking on every
request, and forgets every one of them the moment the control plane rings that someone's access may have narrowed.
Decision 1 accepted the bound: revoked within about a second, a minute at worst.

- [x] Answers the machine may reuse. Progress: the oracle (`routes/runtime-session-authority.ts`) answers a host
  read, a host admin check and a plain session read or write with `grantTtlMs`, 60 s and never past the runtime
  access token's expiry. The machine holds an allowed answer that long (`session-core/src/authority-grants.ts`, 60 s
  at most whatever the answer says), keyed by the relay token's verified `parent_jti`, the actor, the workspace, the
  session, the action and the write class. Refusals, stream and turn leases, starts and registrations are asked
  every time. Only a host the control plane rings holds answers: the CLI's listener and the desktop's local server.
  A cloud runtime or a session host asks on every request as before. Signed grants verified with delivered keys
  were not built: reusing the plane's own answer needs no new audience, key or per-session share encoding.
- [x] Revoking a share, removing a member or pausing pushes to the machine. Progress: each rings `host.changed` to
  every machine serving an affected workspace (`workspace/host-changed-notice.ts`); the machine forgets every held
  answer, and each open terminal checks again at once. An answer to a question asked before the ring is dropped,
  so a ring that lands mid-question is not undone. The desktop's ring reaches its local server through
  `POST /api/claxedo/host-serving/access-changed`. Revoking the machine already stopped it.
- [x] With the push path cut, a revoked answer lapses within 60 s. Progress: unit-tested
  (`remote-session-authority.test.ts`, `authority-grants`).
- [x] Live: a terminal no longer pays the authority round trip each time, and a narrowing is refused within 2 s.
  Progress, on the hosted control plane and relay run locally under Miniflare, with the CLI built from this branch
  enrolled by invitation (driver: the scratch `local-w3.ts`, not a committed flow):
  - six terminals cost one authority call (the published CLI 0.2.1: 18), five reads of a shared session one (0.2.1:
    five);
  - after the owner revoked the share, the colleague's next read was refused 52–69 ms after the revoke; after the
    colleague was removed from the organization, 57–70 ms;
  - a pause was heard in 24–46 ms and a resume in 30–50 ms, with the process running throughout.
  On staging (`ecaee99e66`, 2026-10-23), a machine built from dev `e36efd45` checked once per connection token:
  six mints with two terminals each, opened and closed, cost six checks for 24 requests; over the direct route six
  terminals under one token cost one. First-terminal mint to prompt was 1.23 s p50 (0.86–2.35 s) and a second
  terminal 0.35 s, from IAD; the older control plane (`claxedo-64bf4618d99a`) gave no `grantTtlMs`, so the same
  machine asked on every request (30 calls for 10 terminals).

A pause no longer stops a `claxedo connect` machine: it withdraws serving, so its relay tunnels and its direct route
(W1) close at once, keeps beating, says so once, and serves again when a beat finds it resumed. One started while
paused waits instead of exiting with a decision its service manager would not restart. `claxedo status` and
`claxedo doctor` report the pause. The control plane admits a paused machine to its doorbell, which carries only
rings, so a resume reaches it at once: on the hosted stack run locally a running machine served again 34 ms after the
resume and one restarted while paused 130 ms after it, where staging, without this, took the next beat (22.3 s).
On staging (`ecaee99e66`, machine from dev `e36efd45`): the machine logged the pause 0.48 s after the owner's request
and its direct terminal closed then; direct reads answered 503 `machine_paused`, `POST /connection` 409 by 0.86 s,
and the relay refused the old token 403, with the process running. It logged the resume 0.63 s after the request,
served direct reads at 0.65 s, minted a connection at 1.0 s and opened a relay terminal at 1.8 s. Restarted while
paused, it retried acquire about every 20 s with its doorbell held, and served 2.3 s after the resume (a relay
terminal at 5.5 s).

### W4 — The owner's accounts on connected machines

Every `claxedo connect` machine spends through the hosted broker (`/bindings/*` on the control plane, the same one
Boat, Modal and Docker sandboxes use) with a stand-in bound to the machine's enrollment instead of a sandbox lease.
While the owner's desktop reaches the machine over W1's direct route, the machine spends through the desktop's
broker instead, call by call, and through the hosted broker again the moment the desktop is not there ("LAN path"
below). The hosted broker gains plan accounts: refresh state kept per account in a Durable Object.

Trade-offs: a machine's model calls pass through our Worker whenever no desktop serves it (a few ms from an AWS box
near the edge; streamed, not stored). Through the desktop they spend the desktop's own account for that provider:
the owner's, but not necessarily the same stored account the control plane holds.

- [x] The control plane mints machine-bound stand-ins (enrollment, served workspace, generation) and refuses them
  once the enrollment is revoked, paused or no longer serves that workspace. Progress: a stand-in names the
  enrollment, leased as `host:<enrollmentId>` at the serving generation with the host id as its runtime. It is
  bound per enrollment and provider, not per served workspace, because every workspace on the machine spends its
  owner's accounts alike. The broker refuses it once the enrollment is revoked or paused, a new instance serves,
  or the owner leaves the invitation's organization. Each beat builds the rows when they are due
  (`createMachineProviderConfig`, `packages/claxedo-server/src/credentials/machine-provider-config.ts`): at half
  life, on a new serving generation, or once a credential write rings the machine. No alarm is used.
- [ ] OpenCode, Pi, Claude Code and Codex on a connected cloud machine spend the owner's accounts through it; the
  real key is never on the machine. Progress: the build and the owner's push to such a machine carry bindings
  only, the ChatGPT plan included. Pi spends a binding where it has no direct row. Pi refuses a Claude plan's
  binding with `brokered_plan_unsupported`, because pi-ai sends a plan token's Claude Code identity only for a
  token it recognises. Not yet proven: a real harness turn on a connected machine.
- [ ] The hosted broker serves Claude and ChatGPT plan accounts, refresh state in a Durable Object. Progress: the
  ChatGPT plan is delivered brokered, and its stand-in names the plan's account for pi-ai. Not built: Claude plan
  refresh, and refresh coordinated across isolates.
- [x] A machine the owner's desktop reaches on the network spends through the desktop's broker; when the desktop
  is away (asleep, off the network, route broken) it spends through the hosted broker, as decided on 2026-10-22,
  in place of the earlier pause. Progress: built as "LAN path" below and proven on one box.
- [ ] Live: revoke the machine and its next model call is refused; rotate the key in the app and the next call
  uses the new one; nothing on the machine changes. Progress: on the hosted control plane on Miniflare, with a
  machine enrolled by invitation and a scripted upstream, its first beat delivered bound rows with no key. A
  `/bindings/*` call with the stand-in reached the upstream with the real key injected. Pause, restart (new
  generation) and revoke each refused the stand-in it held (403 `binding_unavailable`). After a key rotation, the
  stand-in the machine already held spent the new key. Not yet proven on a deploy.

**LAN path.** How each hard question is answered, and why:

1. **Direction: the desktop dials the machine; nothing listens on the desktop.** While the daemon carries the
   owner's direct route to a machine (W1) it also opens TLS to the machine's direct listener, pinned to the
   machine's key, upgrades `GET /owner-broker` with the owner's Runtime Access Token, and serves its credential
   broker on that socket as an HTTP/2 server. The machine is the HTTP/2 client, so its model calls travel back
   over a connection the desktop opened (`claxedo-host-serving/src/owner-broker-wire.ts` and
   `owner-broker-channel.ts`; `claxedo-local-server/src/workspace/owner-broker-dialer.ts`). A listener on the
   desktop was rejected: the desktop holds every key and would expose a port on whatever network a laptop joins;
   an inbound listener meets the Windows firewall prompt (admin) and macOS's application firewall;
   machine-to-desktop reachability fails where desktop-to-machine works (a Windows "Public" profile, client
   isolation, a roaming address); and the owner's rule is "the desktop reaches the machine", which the channel's
   existence states exactly. HTTP/2 is Node's own and gives streaming both ways, per-call cancel and flow control;
   the relay's JSON tunnel frames were rejected because they carry a request body whole.
2. **Admission, both ends.** The machine admits a channel only with the owner's own token for a workspace it
   serves, checked as the direct route checks it (`admitOwnerRuntimeAccess`, now the one owner of that check in
   session-core); it asks the token's standing again on every offer (5 s) and closes the channel at the token's
   expiry, on a pause (the listener withholds) and on stop. The desktop admits each call only with the machine's
   owner broker pass: minted by the control plane on each beat that serves and reports a direct listener, from the
   admission the hosted broker applies per request (`machineBrokerSubject`: invited, live, unpaused, owner active
   and in the organization), as a pass of the sandbox-pass family (`claxedo-owner-broker` audience, 60 s,
   `claxedo-server-core/src/credentials/owner-broker-pass.ts`) naming the owner, enrollment, host and the
   listener's key hash. The desktop verifies it against the control plane's published key set (Electron main names
   it to the daemon as `CLAXEDO_CONTROL_PLANE_JWKS_URL`) and refuses one that has lapsed or names another key, host
   or owner than the channel's, so a revoked or paused machine is refused within a minute even if it keeps its
   channel open, and at once when it does not. Signing out makes main tell the daemon to forget every route
   (`DELETE /api/claxedo/direct-routes`), which closes every channel. The stand-in the desktop's broker spends is
   minted by the desktop for the machine (`owner-broker:<hostId>`), set on each call inside the daemon and never
   sent; no key and no desktop stand-in reaches the machine.
3. **Choice at the machine, per call.** A loopback shim (`owner-broker-shim.ts`) fronts every row the control plane
   built, so a harness keeps one base URL whatever the route and a route change never changes a row or restarts a
   harness; its port is kept in the host state. While the current channel's last offer names the call's
   provider, the call goes to the desktop and the desktop's answer is final, refusals included; otherwise it goes
   to the row's own hosted binding with the row's own stand-in. Only a call that found no channel goes hosted; one
   whose channel broke after it was sent fails once (502 `owner_broker_unreachable`) and the client's retry finds
   the hosted broker. A caller must present the stand-in its row carries, so a process on the machine that was
   handed no row spends nothing through either broker.
4. **Discovery and pinning: none.** The channel's arrival is the discovery and W1's pin is the pin. Carrying the
   desktop's address and key hash in the owner's push was rejected: the plane seals that push from plaintext it
   sees, a laptop's address moves, and it needs the desktop listener rejected in 1.
5. **Slots.** Unchanged: the machine keeps the control plane's build and the owner's push and spends them layered.
   Only built rows are fronted; a provider the owner pushed by hand goes where the push says.

Live, on the hosted control plane and relay run locally under Miniflare, with this branch's `claxedo connect` on
Node 24 enrolled by invitation and serving on the private alias 10.77.0.2, and the real desktop daemon run from
source with the vendor host pointed at the scripted model server (driver: the scratch `live-w4.ts`, not a
committed flow). Which stored key reached the vendor says which broker spent a call. Final run, with ranges over
three runs where they differ:
- before any desktop, a call through the shim went hosted (36–61 ms); the channel was up 164–365 ms after the
  daemon first carried the owner's token; ten calls then reached the vendor with the desktop's key, median
  10.6–15.7 ms (the hosted binding from the same box: 14.2–29.7 ms); a real Pi turn on the machine finished in
  349–458 ms and both its model calls were spent by the desktop;
- stopping the daemon closed the channel in 61–90 ms and the next call went hosted; a restarted daemon served
  again 6.1–9.0 s after it started, its own boot;
- cutting the machine's port with the channel up: the call in flight failed once after 8.0 s, the next call went
  hosted in 33 ms; in two of the three runs the desktop had already spent the failed call, so the client's retry
  spends it a second time; restored, the desktop served again in 4.0 s;
- the desktop withdrawing its account: the next call got the desktop's 403 `binding_unavailable` and the hosted
  broker saw nothing; once the desktop stopped offering the provider, calls went hosted;
- a pause closed the channel in 26–52 ms, the next call got the hosted broker's 403, and the desktop's redial got
  503; a resume served from the desktop again in 4.0 s; the daemon forgetting its routes (sign-out) closed the
  channel in 3–4 ms;
- no key in any file under the machine's home or in its log; a revoke ended the machine (exit 78) and the hosted
  broker refused its stand-in.

Not proven: two machines on a real LAN or tailnet, macOS and Windows, the signed Electron app (the daemon ran with
the variable set by hand, and main's sign-out call was not driven, only the route it calls), the desktop refusing
a machine that keeps its channel past a pause (proven in `owner-broker-dialer.test.ts`, not live), Claude Code,
Codex and OpenCode turns, and latency on a real network.

Rollout: no schema change. Deploy the control plane (the pass rides the beat's answer), then release the desktop,
then the CLI. Any order is safe: an older CLI ignores the pass; with no pass, or an older desktop, the desktop
offers nothing and the machine spends through the hosted broker.

**Assessment.** The cloud path is built: the machine-shaped stand-in, the per-request check, the row builder,
renewal on the beat, and Pi spending a binding. The LAN path is built as above. Still missing:

- Claude plan refresh, which has no code anywhere;
- refresh coordinated across isolates: today it is per isolate, and OpenAI rotates refresh tokens;
- the desktop serves a machine only while its renderer carries that machine's direct route with fresh tokens, so
  a machine whose workspace nobody has open in the app spends through the hosted broker; a machine-scoped
  credential the daemon could hold itself would lift that;
- the desktop serves only providers the machine already has a built row for, so a provider only the desktop
  holds (a Claude plan today) is not offered, and a turn it spends reports the built row's account;
- a Pi direct row an owner pushed to a machine before this change stays on that machine until the owner pushes
  again or clears the configuration.

### W5 — Getting a machine connected

- [ ] `claxedo doctor` checks and explains in one line each: Git Bash on Windows, PATH, the npm cache, the right
  control plane, a reachable relay, the service state. Progress: `claxedo doctor`
  (`packages/cli/src/commands/doctor.ts`) checks, in one line each, and exits 1 on any failure:
  - Node 24;
  - the control plane and relay this machine uses, each by `/health` within a referenced 10 s deadline;
  - whether `claxedo host` talks to the plane the machine is enrolled with;
  - the enrollment;
  - the service: running, its user manager, and whether its unit carries PATH;
  - `git`;
  - the agent CLIs the runtime finds (`installedTerminalAgents`);
  - on Windows, the bash Pi runs (`piBashPath`).

  Live on staging from a Linux container, through the built CLI on Node 24 and on Node 22: the control plane
  answered in 484–1049 ms and the relay through `/relay` in 281–295 ms. Each of these failed with its own line: a
  host that does not resolve, one that answers 404, a listener that never answers (10 s), the container's missing
  user manager, a unit without PATH, and a deleted unit. Not covered: the npm cache, because no failure mode is
  known (the 29-minute install below is unexplained). Not proven: an enrolled, serving machine (the staging
  credential this run had was refused, so no invitation could be minted), launchd, and Windows.
- [ ] The service finds what the installing shell finds, and Pi finds Git Bash on Windows. Progress: the systemd
  unit and the LaunchAgent carry the installing shell's PATH, absolute entries once each (`servicePath`); before,
  they ran with the service manager's own PATH, where `codex`, `cursor-agent` and every tool an agent runs from
  `~/.local/bin`, Homebrew or nvm were missing. `systemd-analyze verify` accepts a unit written with `%` and `$` in
  its PATH. Pi's bash on Windows is Git Bash under `%ProgramFiles%` or `%ProgramFiles(x86)%` before a bare `bash`,
  as Pi's own lookup does, since Git for Windows puts only `Git\cmd` on PATH. Not proven on macOS or Windows.

The Windows installer, the 29-minute Windows install and adding a machine over SSH are in
[Connecting a machine](./2026-10-23-002-feat-connect-a-machine-ux-plan.md) (C0, C2, C9).

### W6 — Relay placement

Place the relay room near the machine or the person; consider Cloudflare Business or Argo for routes from India
(parked by the owner earlier; revisit with W2's numbers).

- [ ] A room's region follows the machine's reported region at creation; measured before and after. Progress: met
  by the code as it stands, so nothing was built. A machine's room is created by the machine's own tunnel dial,
  before any client can mint (`activeWorkspaceHost`), and placed by that dial's Cloudflare country
  (`relayLocationHint`, pinned by "a machine's room stays beside its machine" in `cloudflare.test.ts`). A machine in
  India gets `apac` and one in us-east-1 `enam`; a country outside the table gets the `apac` floor. No region needs
  reporting. Proposed: close this item; what remains is the parked Business or Argo question.

### W7 — Direct route for the web app

A real certificate for each machine's private address (an IP-encoding hostname under a domain we own), so the web
app at `app.claxedo.dev` can call it without mixed-content blocks.

Trade-offs: certificate issuance at scale (Let's Encrypt allows about 50 certificates a week per registered domain;
a dedicated domain with per-machine wildcards, or a CA arrangement), DNS and certificate infrastructure to run.

- [ ] The web app takes W1's direct route on the same network, in Chrome, Safari and Firefox. Progress:

### W8 — Peer-to-peer across networks

The relay sets the connection up; traffic then goes directly with WebRTC or QUIC NAT traversal; the relay remains
the fallback for networks that cannot connect directly (roughly 10–20 %).

- [ ] Two machines on different home networks in one country: terminal round trip ≤ 50 ms with nothing installed
  beyond the CLI. Progress:
- [ ] A network that blocks direct connections falls back to the relay with no visible error. Progress:

### W9 — End-to-end encryption through the relay

App and machine encrypt with keys pinned at enrollment; the relay forwards ciphertext. Owner decision 2.

- [ ] The relay cannot read session or terminal bytes, shown by a test that inspects what the relay sees.
  Progress:
- [ ] A shared session's viewers receive keys through the share; revoking the share rotates them. Progress:

### W10 — Agents as a separate, low-privilege user

Owner decision 3. Linux (a dedicated user, optionally bubblewrap), macOS (a dedicated user, optionally seatbelt),
Windows (a dedicated user, optionally AppContainer).

- [ ] An agent cannot read the connector's memory or files. Progress:
- [ ] A per-machine "allow admin" switch, defaulting as the owner decides. Progress:

### W11 — Connector auto-update with rollback

Signed releases, staged rollout, a trial start that rolls back on failure, an opt-out per machine. Extends the
runtime-version floor and skew test (`MINIMUM_SERVED_WORKSPACE_RUNTIME_VERSION`) to connector ↔ control plane.

- [ ] A failed update leaves the machine serving its previous version. Progress:

### W12 — Audit trail and a local kill switch

- [ ] The owner sees, per machine, who connected and what ran, and can stop everything from the machine itself
  (`claxedo pause` or a tray icon). Progress: the owner pauses, resumes or removes a machine from its Details in
  Settings → Machines (`machines.pause`, `machines.resume`, `machines.remove`) or with `claxedo host pause|resume
  --machine`, and the pause rings the machine, which closes everything it serves within about 50 ms. Details also
  checks the connection hop by hop (this device, the control plane, the machine through the relay) and copies
  diagnostics. Not built: a pause from the machine itself, and the audit trail.

## 4. Order

1. **Now:** W3 then W1 (W1 needs W3), W2, W4, W5.
2. **Next:** W8, W9 (after decision 2), W6.
3. **Later:** W10 (after decision 3), W11, W12. W7 is parked (owner, 2026-10-23).

Proposed after the 2026-10-22 assessment: W4 first once decision 4 is answered, because it takes raw keys off
machines and needs no other workstream; W5's installers on a Windows box; W3 once decision 1 is answered, then W1;
W2 as reshaped; W6 closed.

## 5. Definition of done

- [ ] On one LAN, the desktop app reaches a connected machine directly: terminal open ≤ 0.5 s, keystroke echo
  ≤ 20 ms; the relay takes over when the LAN path breaks.
- [ ] Over the relay from India, a terminal opens in ≤ 1.5 s and later ones in ≤ 1 s.
- [ ] Revoking access cuts a connected machine within 2 s on every route.
- [ ] OpenCode, Pi, Claude Code and Codex on a connected cloud machine spend the owner's API and plan accounts
  with no key on the machine.
- [ ] Linux, macOS and Windows each install, connect, run a session turn and open a terminal from npm in a nightly
  real-machine run.
- [ ] Each workstream's live proof is recorded in its package README or a `docs/perf` note, and this plan is
  deleted once the work ships.

## 6. Execution

Run workstreams as parallel lanes with disjoint file ownership: W3 (control-plane grants, runtime verification),
W1 (connector listener, desktop route list), W2 (transport across app, relay and runtime), W4 (broker bindings,
push-config), W5 (CLI and installers). Each lane proves its change live first, records evidence, and runs the broad
suites once at merge. Lanes that touch the same file agree an owner before editing.
