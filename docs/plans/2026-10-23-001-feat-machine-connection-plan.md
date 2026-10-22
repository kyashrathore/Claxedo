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

Every byte between the app and a connected machine goes through the relay (`@claxedo/workspace-relay`, a Durable
Object in us-east), and every runtime request asks the control plane whether the caller may act. The connector only
dials out; its runtime listens on loopback; the heartbeat reports that a machine is online, not where it is.

What a connected machine can spend today: Pi gets the owner's accounts through push-config's direct rows. Claude
Code and Codex use the machine's own CLI login. OpenCode gets nothing deliverable without a hand-authored key.

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

### W2 — One connection per workspace

All terminals and requests for a workspace ride one multiplexed connection instead of a new secure connection per
terminal.

Trade-offs: one large transfer can delay keystrokes on a shared connection, so streams need priorities; a transport
change across app, relay and runtime.

- [ ] One connection carries requests, terminal streams and events, with per-stream priority (input and terminal
  output above file transfers). Progress:
- [ ] Live over the relay from India: second and later terminals open ≤ 1 s; a 200 MB download does not raise
  keystroke echo by more than 50 ms. Progress:

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

### W4 — The owner's accounts on connected machines

Cloud machines spend through the hosted broker (`/bindings/*` on the control plane, the same one Boat, Modal and
Docker sandboxes use) with a stand-in bound to the machine's enrollment instead of a sandbox lease. LAN machines
spend through the desktop app's broker, reached over W1's direct route. Push-config delivers `{baseUrl,
placeholder}` rows, a shape it already carries. The hosted broker gains plan accounts: refresh state kept per
account in a Durable Object.

Trade-offs: cloud machines' model calls pass through our Worker (a few ms from an AWS box near the edge; streamed,
not stored). LAN machines depend on the main machine being on (default above).

- [ ] The control plane mints machine-bound stand-ins (enrollment, served workspace, generation) and refuses them
  once the enrollment is revoked, paused or no longer serves that workspace. Progress:
- [ ] OpenCode, Pi, Claude Code and Codex on a connected cloud machine spend the owner's accounts through it; the
  real key is never on the machine. Progress:
- [ ] The hosted broker serves Claude and ChatGPT plan accounts, refresh state in a Durable Object. Progress:
- [ ] A LAN machine's agents spend through the main machine's broker over W1; with the main machine asleep they
  pause with the one-line notice. Progress:
- [ ] Live: revoke the machine and its next model call is refused; rotate the key in the app and the next call
  uses the new one; nothing on the machine changes. Progress:

### W5 — Getting a machine connected

- [ ] `claxedo doctor` checks and explains in one line each: Git Bash on Windows, PATH, the npm cache, the right
  control plane, a reachable relay, the service state. Progress:
- [ ] `install.ps1` for Windows: installs prerequisites it needs, the CLI with install scripts off, and the
  runtime's setup, proven on a fresh Windows Server from npm. Progress:
- [ ] Add a machine over SSH from the desktop app: install, start and enroll, with a checksum-verified release.
  Progress:
- [ ] The 29-minute Windows install is explained and fixed or documented with evidence. Progress:

### W6 — Relay placement

Place the relay room near the machine or the person; consider Cloudflare Business or Argo for routes from India
(parked by the owner earlier; revisit with W2's numbers).

- [ ] A room's region follows the machine's reported region at creation; measured before and after. Progress:

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
  (`claxedo pause` or a tray icon). Progress:

## 4. Order

1. **Now:** W3 then W1 (W1 needs W3), W2, W4, W5.
2. **Next:** W8, W9 (after decision 2), W6.
3. **Later:** W7, W10 (after decision 3), W11, W12.

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
