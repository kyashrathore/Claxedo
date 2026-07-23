# Reliable Remote Access to Local Workspaces

Status: PLANNED

## Purpose

Claxedo remote access lets a signed-in user reach local workspaces from a
phone or browser through the hosted control plane and Workspace Relay. The
desktop keeps repository access, agent execution, terminals, files, and
processes on the user's machine.

This plan makes that existing path dependable for personal, owner-operated
remote access. It delivers four outcomes:

1. Remote access returns automatically after reboot, sleep, and network
   changes.
2. Relay deployments interrupt connectivity for only a few seconds while
   local work continues.
3. Runtime Access Tokens have a small replay window, and reusable tokens no
   longer travel in WebSocket subprotocols.
4. Desktop and phone show the same live session history whenever the machine
   is online.

The local workspace runtime remains the source of truth for user-hosted
sessions. The hosted service provides authentication, workspace discovery,
and routing without receiving a durable copy of conversation history.

## Current foundation

The existing design already provides the required security boundary:

```text
Phone or browser
      | signed account session + Runtime Access Token
      v
Hosted control plane
      |
      v
Workspace Relay
      | outbound multiplexed WebSocket
      v
Claxedo desktop/server
      |
      v
Local workspace runtime, agent, terminal, files
```

The host tunnel forwards only routes owned by the workspace runtime. Local
control-plane and desktop-server routes remain loopback-only. One machine
tunnel registers every remote-enabled local workspace and updates its
registration when workspaces change.

The work in this plan preserves that topology.

## Product contract

Remote access is available while all of the following are true:

- The computer is powered on and the operating-system user is logged in.
- Claxedo is running through start-at-login or a manual launch.
- The desktop account session is valid.
- The local workspace runtime can open an outbound connection to the relay.

After initial enablement, opening Settings is not required. A reboot, wake,
Wi-Fi change, or relay deployment restores access automatically.

When the computer is offline, the phone shows the machine and workspace as
offline. Session content remains on the computer and becomes available again
after reconnection.

## 1. Durable remote-access supervisor

### Desired state

Enabling remote access creates an account-scoped local enrollment record:

```text
remote_access_enrollment
  account_id
  host_id
  display_name
  enabled
  created_at
  updated_at
  last_connected_at
```

The existing persistent machine signing identity remains the source of
`host_id` and host proof. Access tokens and signed account assertions stay
in memory and are not written into the enrollment record.

Electron start-at-login remains the operating system's source of truth for
whether Claxedo starts after login. Enabling remote access enables
start-at-login. If the user later disables start-at-login, the UI states that
remote access resumes only after Claxedo is opened.

The enrollment is tied to both the machine and the signed-in account. Signing
out stops the active tunnel immediately while retaining the disabled-until-
account-returns desired state. Signing back into the same account resumes it;
switching accounts does not adopt another account's enrollment.

### Supervisor ownership

`claxedo-server` owns the supervisor and tunnel lifecycle. The supervisor has
the following observable states:

```text
disabled
waiting_for_account
connecting
online
retrying
authentication_required
```

The desktop's global authentication bootstrap supplies renewable signed
account authentication to the local server. This bridge is mounted with the
application shell rather than the Settings or onboarding surfaces. The
supervisor owns desired state, workspace registration, token renewal, tunnel
creation, and retries after receiving current account authentication.

On startup or wake, the flow is:

1. Load the durable enrollment and persistent machine identity.
2. Wait for the matching desktop account session.
3. Refresh the list of local workspaces and their hosted registrations.
4. Mint a fresh host-tunnel token.
5. Start or refresh the single machine tunnel.
6. Record connection health and continue supervising it.

The supervisor reconciles whenever one of these inputs changes:

- Desktop startup or authenticated-account restoration.
- Operating-system resume.
- Browser `online` or equivalent desktop network recovery signal.
- Tunnel close, authentication failure, or watchdog timeout.
- Local workspace addition, removal, or identity change.
- Explicit enable, disable, revoke, sign-out, or account switch.

Retries use exponential backoff with jitter and reset after a healthy
connection. Authentication failures request a fresh account assertion before
minting another host-tunnel token. Ordinary network failures reuse the latest
valid registration and reconnect without duplicating it.

### UI responsibility

The remote-access UI observes supervisor state and provides enable, disable,
status, QR link, and host revocation actions. It does not own automatic
startup or reconnection.

### Acceptance criteria

- Enable once, reboot, and reach the machine from a phone without opening
  Settings.
- Sleep beyond the lifetime of every cached token, wake, and reconnect after
  account refresh.
- Change Wi-Fi networks and reconnect without re-enrollment.
- Add or remove a local workspace and update the existing machine tunnel.
- Sign out and observe the tunnel stop; sign back into the same account and
  observe it resume.
- Switch accounts and verify that the new account cannot adopt the previous
  account's host enrollment.

## 2. Relay deployment continuity

Relay continuity is an application-level property. A deployment may close a
physical HTTP stream or WebSocket; the machine and browser restore their
logical connection while the local runtime and its processes continue.

### Host recovery

The machine tunnel reconnects after relay close, restart, or loss of network:

1. Resolve the configured relay endpoint again.
2. Obtain a current host-tunnel token when the previous token is near expiry
   or rejected.
3. Register the complete current workspace set.
4. Resume accepting multiplexed HTTP, event, and WebSocket channels.

The relay treats a newer authenticated connection for the same host as the
current owner and fences messages from the replaced connection. A request is
never routed to a different host merely because a relay process restarted.

### Browser recovery

The browser connection layer owns reconnection for relay-backed workspaces:

- Idempotent reads retry after reconnect.
- Event consumers refetch their authoritative snapshot and then resubscribe,
  so correctness does not depend on replaying an in-memory relay event buffer.
- Terminal connections retain their local PTY identifier and reattach to the
  existing process after transport recovery.
- Agent turns retain their durable prompt/message identifiers. An exact retry
  reconciles the existing admission instead of creating a second prompt.
- Operations without an idempotency contract surface an interrupted state and
  require an explicit user retry.

A draining relay closes long-lived sockets with a service-restart signal and
stops accepting new host ownership before termination. Clients treat an
unannounced crash and an announced drain through the same recovery state
machine.

### Service objective

After the replacement relay endpoint is ready:

- Median machine reachability returns within 3 seconds.
- P95 machine reachability returns within 10 seconds.
- No prompt, command, or mutation is executed twice because of reconnect.
- Local agent and terminal processes survive the relay interruption.
- No request is routed to the wrong machine or workspace.

The first production version may remain a single active relay owner. These
objectives are achieved through supervision, draining, reconnection, fencing,
and idempotency. Relay replication and regional failover are introduced when
measured deployment recovery cannot meet the objective.

### Observability

Record:

- Host disconnect reason and reconnect duration.
- Browser reconnect duration and retry count.
- Tunnel authentication refresh failures.
- Channels interrupted and successfully restored.
- PTY reattachment success.
- Duplicate-admission reconciliations.
- Requests rejected from fenced host connections.

## 3. Runtime token replay hardening

### Threat addressed

A Runtime Access Token is a bearer credential. A copied token can be replayed
from another client until it expires. The token is scoped to one account,
workspace, host, and role, but an owner token can still authorize agent,
terminal, file, and process operations for that workspace.

This plan limits the useful lifetime and exposure of copied tokens. It does
not introduce device-bound proof keys.

### Short-lived Runtime Access Tokens

Runtime Access Tokens use a five-minute default lifetime and refresh
automatically before expiry. The signer permits a narrow configurable range
around that default rather than the current 15-to-60-minute range.

The client keeps the token in memory. Runtime tokens are redacted from:

- Application and relay logs.
- Error reports and telemetry.
- Request tracing.
- Browser persistence, including local and session storage.

Revoking a host stops its active machine tunnel. Existing Runtime Access
Tokens naturally become unusable when the host is unreachable and expire
within the bounded token lifetime.

### Single-use WebSocket tickets

Reusable Runtime Access Tokens no longer appear in WebSocket subprotocols.
The browser instead:

1. Makes an authenticated HTTP request to the relay for a WebSocket ticket.
2. Supplies the intended workspace, host, runtime path, and requested
   subprotocols.
3. Receives a ticket valid for at most 30 seconds.
4. Opens the WebSocket using that ticket.
5. The relay atomically consumes the ticket during the upgrade.

The ticket is bound to the authenticated subject, workspace, host, role,
exact runtime path, and permitted subprotocols. Reuse, expiry, target changes,
and concurrent double-spend fail closed.

Ticket state may live with the active relay owner because tickets are
short-lived. A relay deployment invalidates unconsumed tickets; the browser
mints a fresh ticket through the normal reconnect flow.

### Security boundary

These measures bound bearer-token replay rather than eliminating it. A copied
HTTP Runtime Access Token can be used during its remaining lifetime. Device-
bound tokens using DPoP are a later security milestone when usage and threat
telemetry justify browser key enrollment, replay-cache coordination, and
recovery UX.

### Acceptance criteria

- Runtime Access Tokens expire after five minutes by default and refresh
  transparently during an active account session.
- Runtime tokens never appear in browser storage or captured application logs.
- WebSocket handshakes contain a single-use ticket rather than a Runtime
  Access Token.
- Reusing or modifying a ticket fails.
- A ticket lost during relay deployment is reminted automatically.
- Copying an HTTP token provides access only to its existing workspace, host,
  and role and only until its short expiry.

## 4. Consistent live session history

### Source of truth

The local workspace runtime is authoritative for sessions in a remote-enabled
local workspace. Desktop and phone query and mutate the same runtime-backed
session identities through their respective local or relayed transports.

For a remote-enabled workspace:

- A session created on desktop appears on the phone.
- A session created on the phone appears on desktop.
- Session IDs survive transport reconnects and desktop restarts.
- Rename, archive, status, messages, and last activity come from the same
  runtime source.
- Existing runtime sessions appear on both clients without copying their
  messages to the hosted control plane.

The desktop inventory selects the runtime-backed source for the same
user-hosted workspace identity used by the phone. A separate desktop-local
projection does not override a newer runtime result for that workspace.

### Offline behavior

When the machine is offline, the hosted app uses its machine/workspace
registration to render an explicit offline state. Session content, search,
rename, archive, and continuation become available after the runtime
reconnects.

The hosted service does not maintain a durable conversation projection in
this phase. This keeps repository context, prompts, tool output, diffs, and
attachments on the user's computer.

### Acceptance criteria

- Create, rename, archive, and continue a session from either desktop or
  phone and observe the same result on the other client.
- Reconnect after reboot, sleep, network loss, and relay deployment without
  creating a duplicate session.
- Preserve complete local history across desktop restart.
- Show a clear machine-offline state rather than an empty or divergent
  session list.
- Restore the live session list and content when the machine reconnects.

## Delivery sequence

### Milestone 1: durable machine recovery

- Persist account-scoped remote-access desired state.
- Move tunnel lifecycle into the server-owned supervisor.
- Mount the account-auth bridge at global desktop bootstrap.
- Connect startup, resume, network, workspace, sign-out, and revoke signals.
- Verify reboot, sleep, Wi-Fi, and account lifecycle scenarios.

### Milestone 2: relay continuity

- Add host and browser reconnect state machines.
- Add drain signaling and host-connection fencing.
- Restore events, PTYs, and durable agent admissions after reconnect.
- Add continuity metrics and verify the recovery objective during a relay
  deployment.

### Milestone 3: token replay hardening

- Shorten Runtime Access Token lifetime and update refresh behavior.
- Audit and test token redaction and in-memory-only handling.
- Add single-use, path-bound WebSocket tickets.
- Migrate every relayed WebSocket consumer from token subprotocols to tickets.

### Milestone 4: unified live history

- Use the runtime-backed session identity and inventory for remote-enabled
  workspaces on both clients.
- Route live session metadata operations to that runtime source.
- Add honest offline and reconnect states.
- Verify bidirectional session visibility without hosted conversation storage.

## End-to-end verification matrix

| Scenario | Expected result |
| --- | --- |
| Reboot with start-at-login | Machine becomes reachable without opening Settings |
| Sleep past all token expiries | Wake refreshes authentication and reconnects |
| Wi-Fi change | Tunnel and browser recover without re-enrollment |
| Relay deployment during an agent turn | Turn continues locally; UI reconnects without duplicate admission |
| Relay deployment during a PTY session | PTY process survives and the client reattaches |
| Runtime token copied | Access is limited to its claims and remaining short lifetime |
| WebSocket ticket copied and used twice | The second upgrade is rejected |
| Session created on desktop | Same session appears on phone while online |
| Session created on phone | Same session appears on desktop |
| Machine offline | Phone shows an explicit offline state |
| Machine returns | Existing session identities and content return without duplication |

## Scope boundaries

The following capabilities are tracked as later milestones:

- Cryptographic client-device enrollment and DPoP-bound tokens.
- Independently revocable phone and browser installations.
- A general multi-user capability policy for remote machine control.
- Multi-region relay failover and horizontally distributed host ownership.
- Hosted session metadata or conversation-history synchronization for offline
  viewing.

They become relevant when Claxedo expands beyond owner-operated live access or
when production telemetry shows that the focused reliability and token
hardening in this plan cannot meet the product contract.
