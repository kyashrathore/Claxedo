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

- **Model credentials by machine kind.** A cloud machine (AWS and the like) spends the owner's accounts through
  the hosted egress broker on the control plane, so the real key never reaches it. A machine on the owner's LAN
  spends them through the egress broker on the owner's main machine (the desktop app), so the key never leaves
  that machine. A broker inside the connected machine's own connector is not built.
- **The hosted broker serves plan accounts** (Claude Pro/Max, ChatGPT plans), not only API keys.

Default taken here until the owner says otherwise:

- **A LAN machine whose main machine is away pauses its model calls** with one line ("<main machine> is offline;
  model access resumes when it is back"). It does not fall back to the hosted broker; that would be a fallback,
  which needs an explicit request.

Open, for the owner (each blocks only its own workstream):

1. **W3, access checked on the machine.** Revocation reaches the machine by push within about a second; if the push
   is lost, a grant still lives until it expires (about 60 s). Is "revoked within a second, 60 s at worst"
   acceptable?
2. **W9, end-to-end encryption.** The relay could then not read traffic; shared sessions need keys handed to every
   viewer. Wanted, and when?
3. **W10, agents without admin.** A separate low-privilege OS user stops an agent reading the connector's memory
   or damaging the machine, but tasks such as installing a printer driver need admin. Default on or off per
   machine?
4. **W4, which machines are cloud machines.** The decision above splits model access by machine kind, but nothing
   records a machine's kind. Is it a flag the owner sets per machine, a property of the invitation, or does every
   machine use the hosted broker until W1 gives LAN machines a route to the main machine? Building W4 for every
   machine now would send LAN machines through the hosted broker, against that decision.
   **Answered:** every machine enrolled with `claxedo connect` spends through the hosted broker, and there is no
   per-machine setting. A machine enrolled from an account (the desktop) is unchanged.

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
| W3 | Not built: decision 1. The owner withdrew a 10 s lease window on the same grounds; an alternative is below |
| W1 | Not built: needs W3 at three verifiers, and a LAN with the desktop to prove |
| W2 | Not built as written: most of it already holds, and what is left is small; reshaped below |
| W4 | Cloud path built for every `claxedo connect` machine and proven on Miniflare; plan refresh and a deploy remain |
| W5 | `claxedo doctor`, the service's PATH and Pi's Windows bash built; installers need a Windows box |
| W6 | Already met by how rooms are placed |

### W1 — Direct route on the same network (desktop app first)

The connector also listens on its private interfaces (LAN, tailnet) behind TLS, and reports those addresses in its
heartbeat. The desktop app connects to them directly, pinning the certificate fingerprint the control plane hands
out at enrollment, and falls back to the relay on any failure. It re-checks routes on network change and on focus.

Trade-offs: the machine opens a port on its private network (bound to private interfaces only, TLS plus a W3 grant
required, switchable off per machine). The web app is not covered until W7.

- [ ] The connector serves its runtime routes on its private addresses, TLS only, refusing any request without a
  valid W3 grant. Progress:
- [ ] Heartbeat carries the machine's private addresses and certificate fingerprint; the control plane stores
  neither beyond the enrollment's current state. Progress:
- [ ] The desktop app's route list: loopback, LAN, tailnet, relay, tried best-first with a short probe; moves back
  to a better route on network change. Progress:
- [ ] Live: desktop and machine on one LAN — terminal open ≤ 0.5 s, keystroke echo ≤ 20 ms; pull the LAN cable
  mid-session and the session continues over the relay. Progress:
- [ ] A per-machine switch turns the private listener off; with it off, nothing listens. Progress:

**Assessment.** The dependency on W3 is harder than stated. The daemon's ingress (`localHostRelayActor`), the
runtime's `createRelayHostAuthMiddleware` and the control plane's session authority each admit only a
relay-minted RHT, and a direct caller must never come out as `loopback-direct`, which is the machine's owner.
Without W3 a LAN terminal still pays the machine's authority call to the control plane, so echo drops to about
10 ms but a terminal open keeps that call's 0.4–1.9 s from India (inferred from §1, not measured on a LAN). The renderer path is costly: `connect-src` lists exact origins
stamped at load, the runtime sends no CORS headers, Chromium's Local Network Access gating may apply, certificate
pinning is possible only in main (`setCertificateVerifyProc`), and the repository has no certificate library.
Proposed shape once W3 lands: the direct route lives in the daemon, which reaches the LAN address over Node TLS
pinning the enrollment key's SPKI the control plane already stores, so the renderer keeps talking to loopback. The
heartbeat field ships on the control plane before any connector sends it, because the schema is strict and a 400
stops the connector. Size: 8–9 packages, 30–40 files.

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

The machine verifies a short-lived signed grant itself instead of asking the control plane on every request.
Revocation is pushed over the host-changed event stream; a grant expires in about 60 s regardless. Blocks W1.

Trade-off: owner decision 1.

- [ ] Grants name the person, the workspace, the scopes and an expiry; the machine verifies them with keys the
  control plane delivered. Progress:
- [ ] Revoking a share, removing a member or revoking the machine pushes to the machine; the next request is
  refused within 2 s. Progress:
- [ ] With the push path cut, a revoked grant is refused at its expiry. Progress:
- [ ] Live: a terminal attach no longer pays the 0.4–1.9 s authority round trip. Progress:

**Assessment.** The machine already verifies a short-lived grant, the relay's 60 s RHT, and asks the control plane
anyway, because an RHT keeps verifying after the runtime access token it came from is revoked
(`pty/terminal-authority.ts`). That per-request question is what makes revocation immediate for new requests; open
relay sockets already lag by up to a 30 s check plus a 10 s cache. A machine-side grant needs its own audience or
key (the control plane's one Ed25519 key signs many audiences), per-session share levels or a remote answer for
shared sessions, a revocation payload on `host.changed` (live-sync admission drops every field but type, host,
owner and time, and a share revoke, a member removal, a pause or a token refresh rings nothing), and changes at the
daemon, the runtime and the control plane's oracle. Turn leases and every write stay remote. An alternative that
keeps revocation decided live: grants for read-only decisions only, and a revocation that completes only once the
machine acknowledges it, the relay refusing that machine's tunnel until it does. The relay route then stays
immediate, and only a direct route (W1) is bounded by the grant's life.

### W4 — The owner's accounts on connected machines

Cloud machines spend through the hosted broker (`/bindings/*` on the control plane, the same one Boat, Modal and
Docker sandboxes use) with a stand-in bound to the machine's enrollment instead of a sandbox lease. LAN machines
spend through the desktop app's broker, reached over W1's direct route. Push-config delivers `{baseUrl,
placeholder}` rows, a shape it already carries. The hosted broker gains plan accounts: refresh state kept per
account in a Durable Object.

Trade-offs: cloud machines' model calls pass through our Worker (a few ms from an AWS box near the edge; streamed,
not stored). LAN machines depend on the main machine being on (default above).

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
- [ ] A LAN machine's agents spend through the main machine's broker over W1; with the main machine asleep they
  pause with the one-line notice. Progress:
- [ ] Live: revoke the machine and its next model call is refused; rotate the key in the app and the next call
  uses the new one; nothing on the machine changes. Progress: on the hosted control plane on Miniflare, with a
  machine enrolled by invitation and a scripted upstream, its first beat delivered bound rows with no key. A
  `/bindings/*` call with the stand-in reached the upstream with the real key injected. Pause, restart (new
  generation) and revoke each refused the stand-in it held (403 `binding_unavailable`). After a key rotation, the
  stand-in the machine already held spent the new key. Not yet proven on a deploy.

**Assessment.** The cloud path is built: the machine-shaped stand-in, the per-request check, the row builder,
renewal on the beat, and Pi spending a binding. Still missing:

- Claude plan refresh, which has no code anywhere;
- refresh coordinated across isolates: today it is per isolate, and OpenAI rotates refresh tokens;
- the LAN path through the main machine (W1);
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
- [ ] `install.ps1` for Windows: installs prerequisites it needs, the CLI with install scripts off, and the
  runtime's setup, proven on a fresh Windows Server from npm. Progress:
- [ ] Add a machine over SSH from the desktop app: install, start and enroll, with a checksum-verified release.
  Progress:
- [ ] The 29-minute Windows install is explained and fixed or documented with evidence. Progress:

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
  (`claxedo pause` or a tray icon). Progress: pausing (`POST /api/claxedo/host/enrollments/pause`) has no caller in
  the app or the CLI yet and rings nothing, so a paused machine stops at its next beat, up to 20 s later. The kill
  switch should ring `host.changed` there, as revoking does.

## 4. Order

1. **Now:** W3 then W1 (W1 needs W3), W2, W4, W5.
2. **Next:** W8, W9 (after decision 2), W6.
3. **Later:** W7, W10 (after decision 3), W11, W12.

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
