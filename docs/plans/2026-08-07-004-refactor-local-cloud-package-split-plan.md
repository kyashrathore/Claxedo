---
title: "refactor: Split desktop-local and hosted Claxedo products"
type: refactor
status: active
date: 2026-08-07
origin: docs/plans/2026-08-07-003-refactor-claxedo-idle-memory-plan.md
origin_unit: U8
deepened: 2026-08-07
artifact_contract: ce-unified-plan/v1
artifact_readiness: implementation-ready
execution: code
independent_execution: true
---

# refactor: Split desktop-local and hosted Claxedo products

## Overview

This plan extracts U8 from the Claxedo idle-memory plan into an independently executable package-boundary refactor. It starts from current `dev` and moves the existing canonical composition and transport producers into product-owned packages while preserving their contracts. It includes every enabling change U8 requires from the parent plan: hosted/default-off WorkGraph and Documents composition, Workspace Runtime harness lifecycle ownership, and runtime-owned session inventory and canonical events. The desktop product then becomes the composition of `@claxedo/app`, `@claxedo/local-server`, `@claxedo/workspace-runtime`, optional harness adapters, and an optional `@claxedo/host-connector` built from the current remote-access service, local host identity, and Workspace Relay host-tunnel implementation. The hosted product becomes the composition of `@claxedo/cloud-app` and `@claxedo/server` over the same lower-level runtime contracts.

The split turns capability placement into a build property. The base local app/local-server build closes over local project, file, diff, PTY, process, session, provider, configuration, credential, and harness-dispatch code. The separately packaged Host Connector closes over machine enrollment and outbound Relay transport. A hosted build closes over identity, cloud authority, relay, remote sandboxes, WorkGraph, Documents, billing, hosted connections, channels, and wakes. Each package manifest states that ownership directly, and source-graph plus emitted-artifact checks enforce it.

This is structural prevention for the memory target. U8 receives no advance memory credit; U9 measures the packaged result and performs final performance qualification (see origin: `docs/plans/2026-08-07-003-refactor-claxedo-idle-memory-plan.md`).

## Mental Model

There are two products, one optional desktop companion, and one lower execution core:

- **Desktop local product:** an unsigned Electron shell whose server is loopback-only and whose durable local execution authority is Workspace Runtime.
- **Hosted product:** a signed browser and control-plane product whose server owns identity, cloud authority, and hosted capabilities.
- **Host Connector:** a separately packaged desktop companion formed by moving and narrowing the current remote-access, local-host identity, and user-hosted tunnel producers. It turns the machine's canonical local workspace inventory into existing user-hosted Relay targets after one browser approval.
- **Workspace Runtime:** the lower local workspace/session core used through explicit composition; Phase A completes its ownership of files, diffs, PTYs, processes, local session metadata, canonical events, and harness selection.

The package split follows product ownership rather than deployment technology. Hosted Node and hosted workerd remain two runtimes of `@claxedo/server`; the system browser is the desktop boundary for hosted identity and hosted-product journeys.

## Product Launch and End-to-End Runtime Flows

This section describes the product after the split from a user's point of view. The central distinction is between **where identity lives** and **where compute runs**:

- A **local desktop** is unsigned by default. Its renderer has no account session and its compute runs on the laptop.
- A **linked desktop host** has one revocable machine-scoped enrollment covering every current and future local workspace in that machine's canonical inventory. The user approves the link while signed into cloud-app in the system browser; the Electron renderer still has no account bearer token.
- A **signed client** is cloud-app in a desktop/mobile browser, or another supported client implementing the hosted Client/Protocol contracts. It authenticates to `@claxedo/server`.
- A **cloud workspace** runs Workspace Runtime and harnesses inside a hosted sandbox VM. It does not depend on the user's laptop.

### Supported Product Modes

| User intent | Identity location | Compute location | Reachable from | Laptop requirement | Product outcome |
|---|---|---|---|---|---|
| Work privately on this laptop | None | Laptop Workspace Runtime | This desktop | Laptop and desktop app running | Supported base mode |
| Make this machine's local workspaces remotely accessible | Signed browser/client plus one machine-scoped host enrollment | Laptop Workspace Runtime | Any authorized signed client through Relay | Laptop awake, desktop/host connector running, outbound network available | Supported linked-host mode |
| Configure a sandbox VM while remaining unsigned | None | VM | This desktop | Would still require laptop for identity/orchestration | Outside the product contract; the Cloud Workspace affordance opens cloud-app and requires sign-in |
| Create and use a cloud workspace | Signed browser/client | Hosted sandbox VM | Any authorized signed client | Laptop not required after creation | Supported hosted mode |

The native Electron renderer remains the unsigned local composition across all modes. Desktop account, billing, WorkGraph, Documents, and cloud-workspace journeys run in the system browser. Remote access uses browser identity to approve one machine enrollment, after which Host Connector can publish the machine's complete canonical local-workspace inventory without receiving an account token.

### The Desktop Pieces, in Plain English

- **Electron main** starts and supervises the desktop processes. It also opens the system browser for sign-in, sharing approval, account pages, and cloud workspace creation.
- **The local app renderer** is the desktop UI. It remains unsigned and talks to local-server through an authenticated loopback connection. It never receives the user's cloud account token or the Host Connector private key.
- **Local-server** exposes the local HTTP and event API used by the renderer. It translates those requests into Workspace Runtime operations.
- **Workspace Runtime** owns the real local workspace state: files, diffs, terminals, processes, sessions, events, and harness selection.
- **A harness adapter** starts only when the user asks an agent to perform work. It runs either on the laptop or inside the cloud VM, depending on the workspace type.
- **Host Connector** is an optional desktop child process used only while setting up or running a shared local workspace. It opens an outbound connection to Workspace Relay; the internet never connects directly to a laptop port.
- **Cloud-app and Hosted Server** run outside the native desktop. They own account sign-in, workspace membership, sharing approval, cloud VM creation, and short-lived remote-access credentials.

The user-facing distinction is simple: a workspace is shown as either **On this laptop** or **Cloud VM**. A shared laptop workspace also shows Awaiting approval, Online, Offline, Paused, or Revoked.

### Flow A — Use Claxedo Locally Without Signing In

What the user does: open the desktop app, select a local folder, and work.

1. Electron starts the local renderer and local-server.
2. Local-server opens the existing local profile and creates Workspace Runtime.
3. The renderer asks local-server for projects, sessions, files, diffs, and terminal state. Local-server reads that state from Workspace Runtime.
4. Merely opening the app starts no agent harness. Browsing files, viewing sessions, and using a terminal remain local operations.
5. When the user sends a prompt, Workspace Runtime chooses the configured harness and starts or joins that harness process.
6. The harness works against the local folder using the locally configured provider credential.
7. Results return from the harness to Workspace Runtime, then through local-server to the renderer.
8. Closing the desktop shuts down local-server and its owned terminals, runtime resources, and harness children.

This mode needs the desktop installation, a writable local profile, and access to the chosen folder. A provider credential and provider network access are needed only when an agent operation uses that provider. It needs no Claxedo account, Hosted Server, Relay, or cloud VM. Nothing in this flow is remotely accessible.

### Flow B — Make All Local Workspaces on a Machine Available to Signed Clients

What the user does: enable remote access once for the machine. Every current local workspace, and every local workspace added later, then becomes available to the user's authorized web, mobile, or other supported signed clients while that machine is online.

#### Set up sharing once

1. In desktop setup or settings, the user chooses **Enable remote access for this machine**.
2. Electron starts Host Connector. Host Connector creates or loads a host keypair and asks Hosted Server to begin a short-lived sharing approval.
3. Electron opens the fixed approval page in the system browser.
4. The user signs in there and sees the laptop name, a statement that all current and future local workspaces on this machine will be reachable, and a warning that the laptop must remain awake. The page exposes **Approve** and **Cancel**.
5. Approval alone is insufficient. Host Connector must also prove that it owns the private key from step 2. Hosted Server creates one durable machine enrollment only after both the signed browser approval and host-key proof succeed.
6. The desktop stores the host private key using the platform credential store. It stores only the nonsecret host ID and enrollment generation beside it; cloud account tokens never return to Electron.
7. Host Connector asks local-server for the authoritative local workspace inventory. Local-server gets this from Workspace Runtime and returns stable workspace IDs plus safe display metadata, never filesystem paths or provider credentials.
8. Host Connector sends the complete inventory to Hosted Server. Hosted Server reconciles the machine's per-workspace links: new local workspaces are added with the enrolling account as owner, existing links and explicitly granted collaborator roles remain, and locally deleted workspaces are removed.
9. Hosted Server returns a short-lived tunnel credential scoped to exactly that reconciled workspace set.
10. Host Connector publishes the accepted set through the existing Workspace Relay host-tunnel implementation. On the Bun Relay, the current machine tunnel registers multiple workspace IDs on one socket. On the Cloudflare Durable Object Relay, the current gateway keeps one workspace room per socket, so Host Connector maintains one tunnel handle per published workspace. Hosted Server returns the configured registration mode with the Relay assignment; Host Connector does not infer it.
11. Host Connector watches the canonical local inventory. Creating or importing a local workspace triggers another full authority reconciliation and then updates the existing Bun registration or adds the corresponding Cloudflare room tunnel. Deleting a workspace removes its hosted link and removes it from the active tunnel registration or tunnel set.
12. The desktop shows one aggregate machine status and the published-workspace count. Cloud-app lists each workspace under that machine using its actual host-link/Relay presence. The aggregate is Online when every accepted workspace route is present, Reconnecting when only part of the accepted set is present, and Offline when none is present.

Canceling or allowing the approval to expire leaves the machine local-only. The user can start a fresh approval later. Enabling remote access with zero local workspaces is valid: the machine enrollment stays ready and the first workspace is published when it appears.

#### Use the shared workspace from web, mobile, or another client

1. The remote user signs in on a supported client and asks Hosted Server for their workspace list.
2. Hosted Server returns the shared workspace and whether its laptop is currently online.
3. When the user opens it, Hosted Server checks the user's role and the active host link, then issues short-lived access for that workspace.
4. The client connects to Workspace Relay. Relay sends the request through the laptop's existing outbound Host Connector tunnel.
5. Host Connector forwards the request only when the workspace ID is still present in local-server's current canonical inventory and the route belongs to the allowed Workspace Runtime surface.
6. File reads, terminal operations, sessions, and prompts therefore operate on the live laptop workspace. If a prompt starts a harness, that harness runs on the laptop and uses the laptop's provider credential.
7. The response returns along the same path in reverse: laptop Workspace Runtime, Host Connector, Relay, then the signed client.

The laptop remains the only owner of every working tree and local runtime store. Remote clients receive neither filesystem paths nor provider or host credentials. The account that enrolled the machine automatically owns every current and future workspace link from that machine. Other signed users see a workspace only after receiving an explicit role on that workspace. Host Connector is one logical machine publisher even when the configured Relay uses one physical tunnel per workspace; authorization remains per workspace in both Relay runtimes.

#### Does the client connect directly to the laptop?

No. A signed user-hosted client has two separate paths:

1. **Control path:** the client calls Hosted Server to sign in, list workspaces, and request or refresh `GET/POST /api/workspace/:id/connection`. Hosted Server checks workspace membership, role, and active host-link authority, then returns the existing connection shape from `userHostedConnectionInfo`: `relayUrl`, workspace ID, role, token expiry, and a scoped Runtime Access Token.
2. **Runtime data path:** the client sends workspace HTTP, SSE, and WebSocket traffic to `relayUrl/workspaces/:workspaceId/...`. Workspace Relay verifies and authorizes that traffic, then carries it over the laptop's already-open outbound host tunnel to Workspace Runtime.

Hosted Server is therefore the identity and authorization authority, but it is not the byte proxy for file reads, terminal frames, event streams, or prompt traffic. Workspace Relay remains in the runtime data path for the lifetime of every remote request or socket. Relay also uses its authenticated internal `/internal/relay/target` and `/internal/relay/revocation` resolver calls, with the existing short caches, to confirm the current host target and Runtime Access Token state. The client never receives a laptop IP, loopback URL, or Host Connector credential.

The shared client has a `directRuntimeUrl` seam for explicitly trusted deployments, but the existing `userHostedConnectionInfo` response does not populate it. This plan preserves that behavior: signed user-hosted access always uses Workspace Relay.

#### How the existing Relay path is secured

1. The laptop initiates an outbound WSS host tunnel. Relay cannot dial an arbitrary laptop port, and no laptop listener is exposed to the internet.
2. Host Connector registers with the existing short-lived Host Tunnel Token. Its signed claims bind the token to the host ID and exact workspace ID set; Workspace Relay verifies issuer, audience, signature, expiry, host, and workspace scope before accepting the WebSocket upgrade or registration update.
3. A signed client receives the existing Runtime Access Token. Its signed claims bind subject, organization, workspace, host, role, expiry, and unique token ID. Relay verifies the token, checks current revocation state, resolves the current target, requires the token's workspace and host to match that target, and requires active host-tunnel presence.
4. Relay enforces the existing role gate before forwarding. Viewers receive read-only HTTP access and cannot open PTY routes; editors, admins, and owners retain their current permissions.
5. Relay replaces the client's Authorization header with a short-lived Relay Host Token scoped to the same subject, organization, workspace, host, role, and `user-hosted`/`local-worktree` pairing. It strips spoofable forwarding/internal headers and browser cookies, then adds the Relay-controlled workspace ID and `x-forwarded-by: workspace-relay` marker.
6. Workspace Runtime's existing relay-host middleware verifies that Relay Host Token, the workspace/host match, the access/backing pair, the workspace header, and the Relay marker before admitting the request. Host Connector additionally resolves only inventory-present workspace IDs and the existing `RouteHandler.SandboxRuntime` route family, so Relay messages cannot choose another origin, port, local-server route, provider credential route, or filesystem path.
7. Existing origin allowlists, request/body/channel limits, bounded pre-open queues, slow-consumer handling, heartbeat presence, reconnect caps, and allow/deny audit events remain in force.

The existing token lifetime contract is preserved: Host Tunnel Tokens and Relay Host Tokens authorize connection establishment; Runtime Access Tokens are checked for new Relay requests and refreshes. Pause or revoke closes the supervised Host Connector transport and prevents new or refreshed client access through hosted authority. Established-socket forced-expiry hardening remains tracked as separate Relay security work.

The desktop must be open, Host Connector must be running, the laptop must be awake, and it must have outbound network access. If any machine-wide condition fails, all workspaces on that machine move together to Reconnecting and then Host offline. A single Cloudflare workspace-room failure marks the aggregate machine Reconnecting while unaffected workspace rooms remain reachable and the failed workspace reconnects. Local work remains usable. Claxedo does not create a cloud copy or move execution to a VM.

Pause keeps the machine enrollment but closes remote access to all of its workspaces. Resume reconnects and republishes the full current inventory. Stop sharing or account-wide revocation invalidates the machine generation and requires a fresh approval before any workspace from that machine can be shared again.

#### How Host Connector reconnects

1. Host Connector treats a WebSocket close, relay silence for three heartbeat intervals, network failure, laptop wake, or credential rejection as a lost machine tunnel.
2. It immediately closes the lost tunnel's local HTTP and WebSocket channels and reports Reconnecting. In Bun mode, the replacement machine socket takes over the host registration. In Cloudflare mode, each replacement workspace-room socket takes over that workspace's room registration.
3. It retries with exponential backoff, jitter, and a maximum delay. Every attempt first asks Hosted Server for fresh authorization and proves the persistent host private key; it never reuses the expired tunnel credential.
4. A paused, revoked, deleted, or generation-mismatched enrollment is terminal. Host Connector stops retrying and shows Paused or Revoked instead of looping forever.
5. After authorization succeeds, Host Connector reads a fresh complete inventory from Workspace Runtime, reconciles it with Hosted Server, and restores the configured existing transport shape: one multi-workspace registration for Bun or the required set of per-workspace room tunnels for Cloudflare. A failed or partial inventory read is not treated as an empty inventory: the connector keeps the last hosted records unchanged, forwards nothing it cannot validate locally, and retries the inventory read before restoring transport.
6. The Bun Relay replaces the host's workspace registration with the full accepted set. The Cloudflare Relay restores only the accepted per-workspace room tunnels. In both cases, the hosted target resolver rejects workspace IDs removed by the authoritative reconciliation, even while transport cleanup converges.
7. If only Host Connector crashed, Electron restarts it under the bounded child policy and the same process happens automatically. If the user quit the desktop, reconnection waits until the desktop is launched again.

Connected clients notice a broken transport immediately and show Reconnecting for the affected workspace. Other clients may continue to see its last presence briefly; authority presence expires within sixty seconds and then reports that workspace as Host offline. A connector-wide failure affects every workspace, while a single Cloudflare room failure leaves the other room tunnels reachable.

#### How a remote client reconnects

1. The client parks workspace queries and keeps the current UI state while its event or runtime connection is transiently unavailable.
2. It retries the workspace connection with backoff. Each new attempt asks Hosted Server for fresh short-lived runtime access and the current Relay target; it does not keep using a stale target descriptor.
3. Once the machine tunnel is back, the client reconnects its event stream with the last received event cursor. Workspace Runtime replays buffered canonical events after that cursor. If the cursor has aged out, the client receives a replay-gap signal and refetches the authoritative workspace/session state.
4. Existing terminal and other WebSocket views open new transport channels and reattach to their runtime resource by canonical ID when that resource is still alive. A resource that ended during the outage is shown as ended rather than silently recreated.
5. An in-flight prompt is never submitted a second time merely because the connection dropped. If the laptop and harness stayed running, work continues locally and the client reloads its durable session/messages and live status after reconnect. If execution ended with the desktop process, the client shows the persisted outcome available from Workspace Runtime and requires an explicit new user action for more work.

This gives reconnection two independent loops: Host Connector restores the machine-to-Relay tunnel, and each signed client restores its own Relay-to-workspace connection after the machine becomes reachable.

### Flow C — Use a Sandbox VM While Remaining Unsigned

This mode is not part of the product delivered by this plan.

The unsigned desktop runs local work directly on the laptop. It does not own cloud VM credentials, VM provisioning, billing, or remote lifecycle management. When an unsigned user chooses **Create Cloud Workspace**, Electron opens cloud-app in the system browser and the user signs in. The journey then becomes Flow D.

An offline or self-hosted VM product could be designed separately later. It would need its own identity, ownership, cost, connection, and lifecycle rules.

### Flow D — Create and Use a Signed Cloud VM

What the user does: sign in to Claxedo Cloud, create a cloud workspace, and use it from any authorized signed client.

1. From the native desktop, **Create Cloud Workspace** opens cloud-app in the system browser. The native renderer stays on its local workspace and does not become signed.
2. In cloud-app, the user signs in, chooses a repository and configuration, and requests a cloud workspace.
3. Hosted Server checks account membership, entitlement, limits, region, repository access, and credential availability.
4. Hosted Server asks sandbox-manager to provision a VM and a lease for the workspace.
5. Sandbox-manager starts the VM, prepares the repository, starts Workspace Runtime inside the VM, and reports the ready runtime target to Hosted Server.
6. Hosted Server records the workspace as ready and gives the signed client a short-lived connection descriptor.
7. The client connects to Workspace Relay. Relay validates the access and asks hosted authority for the VM's current target.
8. Relay forwards files, sessions, terminals, events, and prompts to Workspace Runtime inside the VM.
9. When a prompt requires a harness, the VM starts the selected harness there, using hosted scoped credentials.
10. Results return from the VM through Relay to the signed client.

The user can later open the same workspace from web, mobile, or any other supported signed client. Every client follows Hosted Server → Relay → VM. The original laptop and native desktop are not part of that runtime path, so closing the laptop has no effect. Hosted infrastructure owns VM wake, suspend, retry, and release behavior.

If provisioning fails, cloud-app shows a cloud-workspace failure and its retry or recovery action. The system does not fall back to running that workspace on the user's laptop.

### Data, Credential, and Availability Boundaries

| Boundary | Unsigned local | Shared local/user-hosted | Cloud VM |
|---|---|---|---|
| Working tree | Laptop | Laptop; accessed live through Relay | Hosted VM/storage |
| Runtime/session authority | Laptop Workspace Runtime | Laptop Workspace Runtime | VM Workspace Runtime plus hosted projections |
| Account bearer | Not present | Signed clients only; host keeps a private key/enrollment descriptor and receives short-lived host tokens | Signed clients only |
| Provider/harness credential | Local profile/credential store | Stays on laptop and is consumed by laptop harness | Hosted credential broker supplies VM-scoped material |
| Remote transport | None | Client → Relay → outbound Host Connector tunnel | Client → Relay → lease-owned VM runtime target |
| Offline behavior | Local work continues | Remote clients show host offline; local work continues | Clients reconnect/wake according to hosted lifecycle |
| Revocation owner | Local user closes/deletes local state | Hosted authority revokes grant; connector loses renewal and tunnel closes | Hosted authority revokes runtime/client access |

## Problem Frame

The present package graph mixes product ownership:

- `packages/claxedo-server/src/deployments/local/server.ts` mounts local execution alongside auth, authority, relay, remote access, Documents, WorkGraph, connections, channels, and control-plane services.
- `packages/claxedo-server/package.json` therefore declares both local runtime dependencies and hosted control-plane dependencies.
- `packages/claxedo-app/package.json` declares Clerk and WorkGraph while the same source tree supplies the desktop renderer.
- `packages/claxedo-app/src/app/entry/index.tsx` is the public `@claxedo/app` entry and imports Clerk initialization and cloud extension factories.
- `packages/claxedo-app/src/app/entry/app.tsx` installs auth providers and hosted routes in the shared provider tree.
- `packages/claxedo-app/src/app/integrations/feature-ports.ts` and `first-party-content-surfaces.tsx` currently create eager source ownership edges to Documents and WorkGraph.
- `packages/claxedo-desktop/scripts/claxedo-server-entry.ts` imports the local entry from `packages/claxedo-server`, and `packages/claxedo-desktop/src/renderer/index.tsx` initializes the cloud-shaped `@claxedo/app` entry.
- The desktop release workflow currently bakes hosted auth configuration into the renderer.
- User-hosted access is already implemented end to end: `remote-access-service.ts` enumerates local workspaces, `user-hosted-tunnel.ts` calls Workspace Runtime's reconnecting host-tunnel client, Hosted Server mints user-hosted connection credentials, Workspace Relay authorizes and forwards Runtime traffic, and the signed client targets Relay. The ownership problem is that the local remote-access orchestration currently lives inside the mixed server composition and retains an account-bearing auth object.

Runtime flags and lazy imports can reduce startup work, but they cannot prove that a desktop build is independent of hosted source, dependencies, and packaged resources. U8 establishes that proof at the package and artifact boundaries.

## Requirements Trace

### Included foundation

- **U8-F1.** The unsigned renderer and server compositions register no WorkGraph or Documents surfaces, routes, tools, databases, timers, subscriptions, or restored workbench surfaces. Hosted composition registers those capabilities through explicit lazy contribution entrypoints. Carries origin R7 and includes the relevant U5 scope inside this plan.
- **U8-F2.** Workspace Runtime owns local files, diffs, PTYs, process dispatch, durable session inventory, title metadata, canonical events, harness selection, and explicit harness dispatch. Carries origin R9–R11 and includes the relevant U6–U7 scope inside this plan.
- **U8-F3.** An explicit session operation resolves the selected lazy adapter and starts or joins one adapter lifecycle. Concurrent first operations share startup; a failed startup clears pending state for a later retry. Carries origin R11–R12.
- **U8-F4.** Adapter liveness includes requests, response streams, client-owned event streams, and protocol-defined active work. The desktop idle grace is 30 seconds; active work suspends it, and parent/application shutdown terminates adapter children within a bounded interval. Carries origin R13–R16 and R21.
- **U8-F5.** OpenCode, Codex, Claude, ACP, and Pi remain independently selectable through the registry, and Workspace Runtime boots with any supported subset of installed adapter packages. Carries origin R17.
- **U8-F6.** Network harness adapters bind to loopback and authenticate every request with a fresh per-launch credential that stays out of arguments and logs. Pipe transports remain private to the parent. Each adapter preserves its protocol-specific retry and uncertain-delivery rules. Carries origin R15 and R18.
- **U8-F7.** Generic session inventory and empty-shell hydration read the Workspace Runtime store and open no harness-global compatibility stream. Runtime-owned mutations publish canonical local metadata events. A named selected-harness refresh imports historical metadata idempotently. Carries origin R19–R23.

### Package ownership

- **U8-R1.** `@claxedo/local-server` owns the desktop-local HTTP/SSE composition, local profile and credential services, Workspace Runtime wiring, local network policy, and harness dispatch. It builds from its declared package closure when `packages/claxedo-server`, `packages/claxedo-cloud-app`, `packages/sandbox-manager`, `packages/workgraph`, relay packages, and cloud/auth SDK source trees are unavailable. Carries origin R24.
- **U8-R2.** `@claxedo/app` owns the local renderer shell, workbench, terminals, session UI, provider UI, and named links to hosted products. Its production source graph and manifest contain no Clerk, WorkGraph, Documents, provisioning, remote-access, or hosted API client implementation. Carries origin R25.
- **U8-R3.** `@claxedo/server` owns hosted identity, cloud workspace authority, relay, remote sandbox composition, WorkGraph, Documents, billing, hosted connections, channels, and wakes across hosted Node and workerd entrypoints. Carries origin R26.
- **U8-R4.** `@claxedo/cloud-app` owns the hosted browser entry, identity UI and providers, hosted routes, and hosted feature contributions. It composes `@claxedo/app` only through public app contracts. Carries origin R26.
- **U8-R5.** `@claxedo/workspace-runtime` stays lower than both products and has no runtime dependency on local-server, server, app, or cloud-app.
- **U8-R16.** `@claxedo/host-connector` owns browser-mediated machine enrollment, the moved local host keypair producer, complete local-workspace inventory reconciliation, machine-scoped grant rotation, heartbeat/presence, and supervision of the existing user-hosted Workspace Relay tunnel contract. It uses one multi-workspace socket for the Bun Relay and one existing per-workspace room socket for the Cloudflare Durable Object Relay, selected by an explicit Hosted Server Relay-assignment field. It depends on Workspace Runtime relay/protocol contracts and has no runtime dependency on app, cloud-app, local-server implementation, sandbox-manager, or server implementation.

### Product behavior

- **U8-R6.** Unsigned desktop launch, empty-shell hydration, local session inventory, local files/diffs, PTYs, provider configuration, credential management, and explicit harness work retain their approved local contracts after the split.
- **U8-R7.** Desktop sign-in, account, WorkGraph, Documents, billing, cloud-workspace, and other hosted-product affordances resolve to named fixed HTTPS destinations and open in the system browser. Enable Remote Access opens a fixed browser approval journey and returns one revocable machine enrollment covering the host's current and future canonical local-workspace inventory. Account tokens remain in the browser-hosted product. Carries origin R27 and preserves its identity boundary.
- **U8-R8.** Hosted web launch retains its signed-auth gate, cloud workspace flows, WorkGraph, Documents, connections, and hosted route behavior under the cloud-app/server composition.
- **U8-R9.** Existing desktop profile directories, Workspace Runtime stores, provider configuration, credentials, session IDs, PTY behavior, and harness selection keep their canonical paths and formats. A package move does not create a second store or migration namespace.
- **U8-R17.** An authorized signed client can list and request access to every workspace in an enrolled machine's canonical local inventory from Hosted Server, subject to the client's per-workspace role. After connection mint, Runtime HTTP/SSE/WebSocket traffic flows through Workspace Relay → Host Connector → laptop Workspace Runtime. New local workspaces appear after automatic full-set reconciliation; deleted local workspaces disappear. The laptop working trees, provider credentials, runtime stores, and harness execution remain local; laptop or connector unavailability moves the machine's workspaces together to host-offline rather than a cloud fallback.
- **U8-R20.** Host Connector automatically restores lost Relay transport with the existing bounded exponential backoff, jitter, fresh token-provider call, dead-socket watchdog, and registration-update behavior from `workspace-relay-host-tunnel.ts`. Before restoring the configured Bun registration or Cloudflare room-tunnel set, it obtains fresh host-key authorization and a fresh authoritative workspace snapshot. Paused, revoked, deleted, and generation-mismatched enrollments are terminal until user action.
- **U8-R21.** A signed client treats transient user-hosted transport loss as reconnecting, obtains fresh runtime access and placement, resumes canonical events from its last cursor or refetches after a replay gap, reattaches live resources by canonical ID, and never resubmits a prompt solely because the connection dropped.
- **U8-R22.** Signed user-hosted clients preserve the existing control/data split: Hosted Server authenticates the user, lists/authorizes workspaces, and mints or refreshes Runtime Access Tokens; the client sends all workspace HTTP/SSE/WebSocket traffic to Workspace Relay; Relay verifies the token, current target, revocation state, role, and host presence before forwarding through Host Connector. `userHostedConnectionInfo` does not return `directRuntimeUrl`, so the laptop is never a direct remote client target.
- **U8-R23.** The package split preserves the existing Workspace Relay security, frame, and lifetime contracts in `auth.ts`, `server.ts`, `bun.ts`, `cloudflare.ts`, `workspace-relay-host-tunnel.ts`, and `workspace-host-service-auth.ts`. U8 moves and composes these producers. Its Relay-facing support is limited to carrying the configured registration mode, supervising the corresponding existing tunnel handles, and making `updateRegistration`'s latest workspace set the set used to construct the next reconnect URL.
- **U8-R18.** Unsigned desktop supports host-native local execution. Sandbox VM creation and lifecycle require the signed hosted product; cloud-app/server provision the VM and any authorized signed client can reconnect without the laptop.

### Build and enforcement

- **U8-R10.** Desktop development, production build, and packaged macOS launch resolve the same `@claxedo/local-server` entry and the same local app composition contract. Carries origin R28.
- **U8-R11.** Hosted Node and hosted workerd resolve the same hosted service composition from `@claxedo/server`; hosted browser development and deployment resolve the same `@claxedo/cloud-app` entry.
- **U8-R12.** Base local app and local-server source-closure guards validate package manifests and the transitive value-import graph. Hosted-only modules and packages are absent, not merely deferred; Host Connector is evaluated separately under U8-R19.
- **U8-R13.** Emitted renderer/local-server manifests and the packaged Electron resource inventory reject representative hosted package names, source markers, dynamic chunks, and undeclared product resources.
- **U8-R14.** Hosted build and integration tests retain auth, authority, remote sandbox, relay, WorkGraph, Documents, billing, connections, channels, and wakes after local code moves away.
- **U8-R15.** The split lands as a sequence of green package boundaries: shared contracts first, authoritative producers moved once, consumers rewired, obsolete entrypoints removed, and enforcement activated after each closure exists.
- **U8-R19.** Host Connector has its own manifest, source graph, emitted artifact, and packaged-resource boundary. Base unsigned launch does not start or import it; Electron starts the separately fingerprinted child only for an explicit machine-enrollment action or an enrolled, unpaused machine, and it exposes only inventory-validated Workspace Runtime route families.

## Scope Boundaries

- U8 owns source placement, package manifests, public composition contracts, development/build entrypoints, deployment-path updates caused by the new package names, and source/emitted-artifact boundary checks.
- U8 owns the optional linked-host product path: browser approval, machine-scoped enrollment, automatic full local-inventory reconciliation, host presence, supervision of the existing Relay transport shape, inventory-validated runtime forwarding, machine-wide pause/revoke, tunnel/client reconnection, and the package boundary that keeps it out of base local-server/app.
- U8's Workspace Relay scope is composition and characterization: preserve the existing Runtime Access Token, Host Tunnel Token, Relay Host Token, HTTP/SSE/WebSocket paths, tunnel frames, runtime-specific registration topologies, limits, and established-socket lifetime semantics. Established-socket revocation hardening remains separate Relay security work.
- Signed user-hosted clients use Hosted Server as control-plane authority and Workspace Relay as the remote Runtime data plane. A direct public client-to-laptop transport is outside this product contract.
- U8 owns the structural Electron resource allowlist, packaged-entry identity, and one unsigned packaged macOS launch smoke. U9 owns final resource trimming, per-harness packaged measurement, memory acceptance, and browser/desktop performance qualification against that same package contract.
- This standalone plan owns the U5 subset required to create hosted/default-off WorkGraph and Documents contributions and prune unavailable restored surfaces.
- This standalone plan owns the U6–U7 subset required to finish harness process lifecycle, runtime-owned session inventory, canonical events, and historical harness reconciliation before extracting packages.
- Existing public route shapes, persisted record shapes, profile locations, and environment variable semantics used by supported hosted deployments remain stable unless a new package path requires a mechanical build/deploy update. The host-enrollment endpoints and grant-generation fields introduced by this plan are additive; the mixed local account-link routes retire after Host Connector becomes canonical.
- Marketing-site architecture and unrelated package publication are outside this unit; references that describe the deploy-unit package names are updated for accuracy.
- Unsigned sandbox VM orchestration is outside the product contract. Cloud VM actions cross the fixed HTTPS boundary into the signed hosted product.

## Independent Execution Starting Point

This document assumes only a clean current-`dev` worktree plus the repository toolchain. It has no implementation dependency on U5, U6, U7, or another plan being executed first.

Execution prerequisites are part of this plan:

- Install the repository's pinned Bun/Node workspace dependencies from the root lockfile before Unit 1; run every test/typecheck command from its package directory as listed below.
- Use the existing local Relay, hosted-server, signed-browser, sandbox, and deterministic harness fixtures for unit/integration work. Tests mint isolated EdDSA keys and authority records and require no production account, Relay, Convex deployment, cloud VM, or provider credential.
- Run the unsigned Electron package smoke on a macOS runner with the repository's existing Electron packaging prerequisites. Other package closure and product E2Es remain runnable on the normal CI runners.
- Treat access to the hosted staging deployment as a release prerequisite only for the producer-first rollout after all local gates pass; implementation and correctness verification complete against repository fixtures first.

Phase A below establishes the required product contracts, hosted feature seams, harness lifecycle, runtime session authority, and canonical events. Phase B extracts those verified owners into product packages. Phase C rewires delivery and enforces the resulting closures. U1 and U9 benchmark work remains outside this structural plan because U8 receives no memory credit and can hand deterministic artifacts to U9 without needing U1 to implement the package boundary.

Every enabling change follows the repository's authoritative-producer rule: move or repair the canonical producer, migrate consumers, then remove the obsolete path. No unit supplies fallback session data, synthetic events, shadow routes, or a compatibility server as a substitute for the target owner.

## Context and Research

### Current Composition Anchors

- `packages/claxedo-server/src/deployments/local/server.ts` is the current mixed local composition root and route inventory.
- `packages/claxedo-server/src/deployments/local/embedded-workspace-runtime.ts` is the current bridge that this plan first simplifies through runtime-owned inventory/events and then moves into local-server.
- `packages/claxedo-server/src/deployments/hosted-shared/hosted-app.ts`, `deployments/hosted-node/index.ts`, and `deployments/hosted-workerd/worker.ts` already express the shared-hosted/Node/workerd topology that remains in `@claxedo/server`.
- `packages/claxedo-server/src/deployments/hosted-workerd/worker.import-graph.test.ts` is the strongest existing server-side precedent: it walks a transitive value-import graph and enforces runtime-specific source and package exclusions.
- `packages/claxedo-app/src/ARCHITECTURE.md` defines `app` as the composition owner, features as independent owners, and `app/integrations` as the cross-feature assembly boundary.
- `packages/claxedo-app/src/architecture/import-graph.ts`, `ownership.ts`, and their guard tests provide reusable source-graph and ownership-scanner patterns.
- `packages/claxedo-app/src/features/extensions/data/index.ts` already separates the dependency-light accessor from factory modules that pull larger UI/auth chains.
- `packages/claxedo-app/src/app/integrations/registry.ts` and the contribution types in `first-party-content-surfaces.tsx` provide an existing registration model to extend for hosted composition.
- `packages/claxedo-desktop/scripts/contract.ts` fingerprints build inputs and outputs, while `bundle-claxedo-server.ts` and `electron.vite.config.ts` define the current server and renderer artifact seams.
- `packages/claxedo-server/src/deployments/local/remote-access-service.ts` already lists every local workspace, subscribes to inventory changes, registers host links, and starts the machine tunnel. The extracted Host Connector preserves that orchestration while replacing its embedded account bearer with browser-approved machine enrollment and adding authoritative removal reconciliation.
- `packages/claxedo-server/src/routes/hosted/workspace.ts`, `connections/user-hosted-connection.ts`, and `connections/hosted-connection-info.ts` already implement the signed list/open/connection-mint control path. The returned user-hosted connection contains `relayUrl` and Runtime Access Token and intentionally omits `directRuntimeUrl`.
- `packages/claxedo-app/src/platform/runtime/agent/workspace-relay-connection.ts`, `platform/runtime/cloud/workspace-runtime-store.ts`, and `features/workspaces/data/workspace-connection.ts` already implement client connection mint/refresh, Relay HTTP/WebSocket URL construction, health probing, and reconnecting UI state. These are characterization targets and later move with cloud-app ownership; U8 does not replace their transport behavior.
- `packages/claxedo-server/src/user-hosted-tunnel.ts`, `workspace/local-host.ts`, and `workspace/runtime-dispatch/shared-workspace-endpoint.ts` contain the current host identity, outbound tunnel orchestration, and runtime-route restrictions that move into Host Connector/local-server ownership.
- `packages/workspace-runtime/src/workspace-relay-host-tunnel.ts` already owns Host Tunnel Token acquisition on every connection attempt, exponential backoff with jitter, a three-heartbeat dead-socket watchdog, HTTP/WebSocket multiplexing, bounded pre-open queues, and authenticated registration updates.
- `packages/workspace-relay/src/auth.ts` and `server.ts` already implement Runtime Access Token, Host Tunnel Token, and Relay Host Token verification, role/path enforcement, target/revocation checks, dangerous-header stripping, cookie stripping for user-hosted traffic, and audit events.
- `packages/workspace-relay/src/bun.ts` already supports one host socket registered for multiple workspaces and full registration updates. `packages/workspace-relay/src/cloudflare.ts` deliberately places one workspace per Durable Object room and rejects multi-workspace host sockets at the gateway. Host Connector composes each existing mode through the explicit registration-mode assignment.
- `packages/workspace-runtime/src/workspace-host-service-auth.ts` already verifies the Relay Host Token, workspace/host claims, access/backing pair, workspace header, and Relay-controlled forwarding marker at the laptop Runtime boundary.
- `packages/claxedo-server/src/deployments/shared-routes/internal-relay.ts` and `packages/workspace-relay/src/main.ts` already provide the authenticated Relay-to-Hosted-Server target/revocation resolver channel and short caches used on the data path.
- `packages/cli/src/auth/device-code.ts`, `packages/claxedo-server/src/routes/hosted/device-auth.ts`, and cloud-app's `/cli-login` journey provide the existing browser-mediated device authorization pattern. Host enrollment reuses its state/expiry/approval structure while creating a machine-scoped inventory-publishing capability rather than a CLI account session.
- `packages/claxedo-server/src/user-hosted-tunnel.e2e.test.ts`, `packages/claxedo-app/e2e/playwright/web-signed-userhosted.spec.ts`, and `desktop-signed-embedded-shared.spec.ts` already prove major relay and user-hosted paths; this plan retargets the desktop lane from an embedded signed renderer to browser-approved Host Connector enrollment.
- `packages/sandbox-manager` and `packages/claxedo-connections` demonstrate package-local manifests, build scripts, declaration builds, and package-scoped tests in this workspace.

### Existing Producers and Their New Owners

This refactor moves and composes the current implementation along these seams:

- `packages/claxedo-server/src/deployments/local/remote-access-service.ts` already reads all local workspaces, subscribes to workspace changes, registers host links, and starts `startUserHostedMachineTunnel`. It moves into Host Connector. Its account-bearing `SignedControlPlaneAuth` input becomes the new machine-enrollment client, and its append-only `registered` set becomes the required full-set reconciler so deletions and valid empty inventories are represented.
- `packages/claxedo-server/src/workspace/local-host.ts` already owns the persistent local host keypair and signing operations. It moves into Host Connector identity ownership and retains its cryptographic behavior.
- The local-machine branch of `packages/claxedo-server/src/user-hosted-tunnel.ts` already validates local workspace IDs, calls `startWorkspaceRelayHostTunnel`, scopes a registration set, applies `RouteHandler.SandboxRuntime`, updates registrations, and tracks one machine handle. It moves into Host Connector and receives its local target from local-server instead of server store/supervisor imports.
- `packages/claxedo-server/src/workspace/runtime-dispatch/shared-workspace-endpoint.ts` already constrains Relay forwarding to loopback Workspace Runtime traffic. It moves into `@claxedo/local-server` and gains the connector credential plus current-inventory check required by the new process boundary.
- `packages/workspace-runtime/src/workspace-relay-host-tunnel.ts` remains the canonical tunnel protocol and reconnect implementation. Host Connector calls it; the only transport change makes the workspace set accepted by `updateRegistration` authoritative for both the live update frame and the URL/token scope used by the next reconnect.
- `packages/workspace-relay/src/auth.ts`, `server.ts`, `bun.ts`, and `cloudflare.ts` remain the canonical Relay authentication, authorization, routing, multiplexing, limits, and audit producers. Unit 1 adds characterization coverage; Unit 6 consumes their current public contracts.
- `packages/claxedo-server/src/connections/user-hosted-connection.ts` remains the canonical signed connection mint, while `deployments/shared-routes/internal-relay.ts` remains the Relay target/revocation authority channel.
- `packages/claxedo-app/src/platform/runtime/agent/workspace-relay-connection.ts`, `platform/runtime/cloud/workspace-runtime-store.ts`, and `features/workspaces/data/workspace-connection.ts` retain the client mint/refresh, Relay fetch/WebSocket, health-probe, and reconnecting behavior as their hosted composition ownership moves to cloud-app.

The support added for the split is limited to browser-approved machine enrollment, durable machine authority for future workspaces, atomic full-inventory reconciliation, an explicit Relay registration-mode field, and Electron/Host Connector lifecycle plus IPC. Runtime Access Token, Host Tunnel Token, Relay Host Token, Relay protocol-frame, and Workspace Runtime route contracts stay canonical and unchanged.

### Repository Constraints That Shape the Split

- The workspace includes `packages/*`, so both new packages enter workspace resolution through their manifests; the lockfile changes with the manifest graph.
- `@claxedo/app` deliberately remains in `packages/claxedo-app`; the directory/package-name mismatch is an established convention.
- `@claxedo/server` remains the hosted trust composition across Node and workerd. Hosted describes trust posture; Node and workerd describe runtimes.
- App features communicate across owners through app-owned ports and contributions. Cloud-app supplies hosted implementations through public package exports instead of importing `@claxedo/app` internals by relative path or mirrored aliases.
- Package moves preserve one canonical producer. Compatibility imports are temporary only within a single landing slice and are removed before that slice is complete.
- Typechecks run from each package with its declared package script. Tests run from package directories.

### Institutional Learnings

No matching `docs/solutions/` artifact exists. The strongest institutional evidence is executable: worker import-graph guards, app ownership guards, desktop build contracts, and the recent extraction patterns in `packages/sandbox-manager` and `packages/claxedo-connections`.

### External Research

External research is unnecessary for this unit. Package composition and build enforcement are established internally, and the design depends more on Claxedo's current ownership graph than on a framework-level choice.

## Key Technical Decisions

- **K1 — Product packages are composition roots.** `@claxedo/app` and `@claxedo/local-server` compose the desktop product; `@claxedo/cloud-app` and `@claxedo/server` compose the hosted product. Domain-neutral contracts stay in lower packages.
- **K2 — The local closure is positive and explicit.** The local manifests enumerate their runtime dependencies, and guards compare the actual transitive graph to an approved local capability set. A denylist remains as defense in depth for representative hosted packages.
- **K3 — Cloud-app depends on app through public contracts.** The shared renderer exposes a small composition surface for providers, routes, feature contributions, settings sections, navigation, and hosted links. Cloud-app supplies hosted implementations without `@/` aliases into app source; it reaches server over Client/Protocol HTTP contracts and has no runtime package dependency on server or Core.
- **K4 — Local-server composes Workspace Runtime directly.** Local files, diffs, PTYs, processes, session inventory, canonical events, and harness dispatch come from the Workspace Runtime authority completed in Units 3–4. Local-server owns HTTP/SSE adaptation, local configuration and credentials, loopback policy, startup, and shutdown.
- **K5 — Server stays hosted across two runtimes.** Hosted Node and workerd continue to share `createHostedApp`; runtime-specific files retain their existing placement and Worker import-graph contract.
- **K6 — Identity remains browser-hosted.** Cloud-app owns Clerk and signed browser state. Desktop presents named hosted destinations and asks Electron to open those HTTPS URLs externally; no account token crosses back into the desktop product.
- **K7 — Persistent local paths are package-independent.** Data/profile path resolution remains based on product and user directories, never the source package's location. Extraction tests open an existing fixture profile and observe the same records through the new local-server entry.
- **K8 — Source closure and artifact closure are separate gates.** Import-graph tests catch architectural edges; emitted manifests catch bundler aliases, dynamic imports, and packaging configuration that source scans alone can miss.
- **K9 — Missing canonical owners fail loudly.** Local startup and build fail when their declared local entry or artifact is missing. They never fall back to `@claxedo/server`, cloud endpoints, or synthesized responses.
- **K10 — U8 proves build and package independence; U9 proves performance acceptance.** U8's smoke targets built local/hosted entries and one unsigned packaged macOS artifact. U9 repeats the package contract across harness cohorts and attaches memory/performance evidence.
- **K11 — Foundations are deliverables, not assumptions.** Hosted feature seams, harness lifecycle, and runtime-owned inventory/events land as Phase A units in this plan. Package extraction begins only after their tests are green within the same execution.
- **K12 — A linked host is not a signed renderer.** Browser identity approves a device-style machine enrollment bound to a host public key and the explicit scope “all current and future local workspaces on this machine.” Desktop stores the host private key plus nonsecret enrollment metadata and obtains short-lived host tokens by key proof; Clerk/account bearer tokens remain in signed clients.
- **K13 — User-hosted transport is an optional companion boundary.** Enrollment persistence, inventory reconciliation, control-plane calls, Relay/WebSocket transport, and reconnect loops have a distinct security and dependency closure from both the renderer and the loopback server, so they live in a separately built and supervised Host Connector. It is absent from unsigned empty-shell startup and starts only for enrollment work or an enrolled, unpaused machine. It dials Relay outbound and forwards only Workspace Runtime routes whose workspace ID is present in local-server's current canonical inventory.
- **K14 — VM provisioning is a hosted capability.** The unsigned product stays host-native. This keeps sandbox credentials, cost controls, remote lifecycle, and authority in cloud-app/server and gives cloud workspaces laptop-independent availability.
- **K15 — Machine enrollment and workspace presence are separate authority levels.** A durable `host_enrollments` record authorizes one host key to publish the owner's complete local inventory across restarts and future workspace creation. `local_host_links` remains the per-workspace materialization used for listing, roles, presence, and Relay target resolution. A successful full-set reconcile is the sole producer of those materialized links: it ensures the enrolling account's owner role, preserves explicit collaborator roles for unchanged workspaces, and adds or removes workspace routes without another browser approval or a second competing grant source. Failed or partial inventory reads never become an empty reconcile.
- **K16 — Reconnection restores transport, not user intent.** Host Connector reconnects the machine tunnel from durable enrollment plus fresh inventory, while clients independently reacquire runtime access and resume/refetch state. Prompt admission is never repeated as a transport retry; canonical IDs and cursors recover observable state.
- **K17 — Hosted Server is control plane; Workspace Relay is remote data plane.** The signed client uses Hosted Server for identity, listing, authorization, and connection-token mint/refresh. It then sends all user-hosted Runtime HTTP, SSE, and WebSocket traffic to Workspace Relay. Relay remains inline for those bytes and consults Hosted Server only through the existing authenticated target/revocation resolver; the laptop is never a direct client target.
- **K18 — Host Connector adapts to the existing Relay runtime.** Bun's host registry is host-scoped and already accepts multiple workspace IDs plus registration replacement. Cloudflare Durable Object rooms are workspace-scoped and already require one workspace per host-tunnel socket. Hosted Server returns a registration-mode field with the Relay assignment, and Host Connector supervises the corresponding existing handle shape. This confines new work to composition and machine-inventory reconciliation.

## High-Level Technical Design

The package structure works as follows:

1. Electron loads `@claxedo/app` as the native local UI and starts `@claxedo/local-server` as its loopback server.
2. Local-server uses `@claxedo/workspace-runtime` for files, sessions, terminals, processes, events, and harness dispatch. Optional harness adapters remain below Workspace Runtime.
3. When a user enables machine remote access, Electron separately starts `@claxedo/host-connector`. Host Connector reads the complete canonical local inventory through a narrowly scoped local-server grant and publishes that set through the existing Relay contract: one multi-workspace registration on Bun or one tunnel handle per Cloudflare workspace room.
4. The hosted browser loads `@claxedo/cloud-app`. Cloud-app reuses public UI and composition contracts from `@claxedo/app`, then adds hosted identity and hosted-only features.
5. Cloud-app calls `@claxedo/server` over HTTP and Protocol contracts. Server owns hosted authority, cloud sandboxes, Relay integration, WorkGraph, Documents, and other account capabilities.
6. Desktop account and cloud-product buttons open fixed cloud-app URLs in the system browser. Account credentials remain in the hosted browser and server.

### Package Dependency Rules

| Package | Direct local/product dependencies | Capability closure | Representative packages absent from runtime closure |
|---|---|---|---|
| `@claxedo/local-server` | Workspace Runtime, agent/harness contracts and selected adapters, Hono Node transport, local SQLite/PTY/config dependencies | Local HTTP/SSE, project/files/diffs/PTY/process/session/provider/config/credentials/harness dispatch | `@claxedo/server`, Clerk/better-auth, Convex, sandbox-manager, WorkGraph, relay, billing and hosted connection/channel packages |
| `@claxedo/app` | Shared UI/session packages, local runtime client contracts, renderer libraries | Local shell/workbench/session/terminal/provider/settings and hosted-link contracts | Clerk, WorkGraph, Documents implementation, cloud provisioning/runtime store, remote access implementation, hosted connections clients |
| `@claxedo/server` | Hosted authority, relay, sandbox, WorkGraph, Documents, billing, connections, channels, wakes, runtime contracts | Hosted control plane on Node and workerd | Desktop/local-server composition entrypoints |
| `@claxedo/cloud-app` | `@claxedo/app`, Clerk, WorkGraph/Document UI dependencies and hosted API clients | Hosted browser boot, identity, cloud workspace and hosted feature contributions | Electron and desktop main/preload APIs |
| `@claxedo/host-connector` | Workspace Runtime relay/protocol contracts, moved local host identity/credential storage, existing outbound WebSocket host-tunnel transport | Browser-approved machine enrollment, full local-inventory reconciliation, host presence, reconnect loop, and Relay-runtime-specific tunnel supervision | Clerk/browser auth SDK, sandbox-manager, server/app/cloud-app implementations, local provider/config routes |
| `@claxedo/workspace-runtime` | Schema/protocol and harness contracts | Workspace/session core | Product composition packages |

### Capability Placement

| Capability | Desktop/local path | Hosted path |
|---|---|---|
| Health and shell bootstrap | local-server | server-specific hosted contract |
| Files, diffs, PTYs, process dispatch | Workspace Runtime through local-server | hosted placement/runtime policy |
| Session inventory, titles, canonical events | Workspace Runtime through local-server | hosted persistence/event infrastructure |
| Harness selection and dispatch | Workspace Runtime registry | hosted runtime policy |
| Local provider config and credentials | local-server/profile store | hosted account configuration |
| Account identity and auth session | fixed system-browser link; account bearer stays in browser | cloud-app + server |
| Cloud workspace authority | hosted link only | server |
| Enable remote access for local machine | optional Host Connector after browser approval | server machine-enrollment authority + Workspace Relay |
| Publish local workspace inventory | local-server/Workspace Runtime snapshot → Host Connector full-set reconcile | server materializes per-workspace host links and scopes Relay registration |
| Remote access to machine workspace | Host Connector forwards inventory-present Workspace Runtime routes only | signed client → server connection mint/refresh; client Runtime traffic → Relay; Relay internal target/revocation lookup → server |
| Remote sandbox management | hosted link only | server and sandbox-manager |
| WorkGraph and Documents | hosted link only | cloud-app + server |
| Billing, hosted connections, channels, wakes | hosted link only | hosted products |

### Build Closure Proof

Package independence is proved in five plain steps:

1. Check that each package manifest declares only dependencies allowed for that product.
2. Walk the package's real runtime imports and fail on a cross-product source edge.
3. Build the production entry using only the declared package closure.
4. Inspect the emitted modules and chunks for dependencies inserted by aliases or build tooling.
5. Start the real built entry and pass its deterministic artifact manifest to U9 for packaged-resource and performance qualification.

Every edge must agree. A clean manifest cannot compensate for an alias that reaches another package's source; a clean source scan cannot compensate for a bundler plugin that injects hosted code; a clean bundle-name scan cannot compensate for an entrypoint that silently uses a different composition.

## Flow Analysis

### Flow 1 — Unsigned desktop launch

1. Electron starts the local-server entry from `@claxedo/local-server`.
2. Local-server creates the loopback HTTP/SSE adapter and composes Workspace Runtime.
3. The renderer boots `@claxedo/app` with local contributions.
4. Health, bootstrap, project/session inventory, files/diffs, and terminal gates resolve locally.
5. Harness process count remains governed by Unit 3's lifecycle contract; package loading itself selects no harness.

Terminal states: usable local shell; explicit startup failure naming the missing local owner; clean shutdown of the local server and its owned runtime resources.

### Flow 2 — Desktop user selects a hosted capability

1. The local renderer exposes a named hosted-product affordance such as Sign in, Account, WorkGraph, Documents, Billing, or Create Cloud Workspace.
2. The affordance resolves through the app's hosted-destination contract to a fixed `https://app.claxedo.com/...` destination.
3. Electron validates the external URL and opens it in the system browser.
4. Cloud-app owns authentication and the hosted journey; the desktop remains on local state.

Terminal states: browser opens the intended hosted route; an invalid/non-HTTPS destination is refused; closing the browser leaves desktop local state unchanged.

### Flow 3 — Browser-approved machine remote access

1. The local renderer asks Electron to enable remote access for the machine.
2. Host Connector creates or loads the host keypair and one-time enrollment state; Electron opens the fixed cloud-app approval URL.
3. A signed browser user approves access to all current and future local workspaces on that host; Hosted Server records one machine enrollment after host-key proof.
4. Host Connector obtains the complete authoritative local inventory through its loopback grant, reconciles that full set with Hosted Server, receives the Relay URL plus explicit registration mode, and uses the current Workspace Runtime host-tunnel implementation.
5. Inventory changes trigger another full-set authority reconcile. Bun mode updates one multi-workspace registration; Cloudflare mode adds or removes existing per-workspace room tunnels.
6. Signed clients obtain short-lived per-workspace Runtime Access Tokens from Hosted Server. Their Runtime HTTP/SSE/WebSocket calls go directly to Workspace Relay, which authorizes each request and forwards it through Host Connector to the appropriate laptop Workspace Runtime. Hosted Server remains the authority and Relay resolver, not the Runtime byte proxy.
7. A tunnel loss starts Host Connector's fresh-authorization/backoff loop; clients independently park queries, reacquire access, resume/refetch canonical events, and reattach live resources without repeating prompt admission.

Terminal states: machine online with its current inventory; approval canceled/expired with local work unchanged; machine reconnecting or offline; paused/revoked with renewal denied and tunnel closed; automatic reconnect using the same host identity, a fresh inventory, and new short-lived grants.

### Flow 4 — Hosted browser launch

1. Cloudflare Pages or the supported hosted web origin loads `@claxedo/cloud-app`.
2. Cloud-app initializes hosted identity and registers hosted providers, routes, surfaces, settings sections, and API clients through `@claxedo/app`'s public composition contract.
3. The shared app shell renders against `@claxedo/server`.
4. Signed-auth, cloud workspace, WorkGraph, Documents, connections, and hosted session journeys retain their existing outcomes.

Terminal states: signed hosted shell; anonymous login journey; explicit hosted configuration error; feature-level error states from their existing owners.

### Flow 5 — Existing desktop profile after upgrade

1. The new desktop/local-server entries resolve the same profile and data directories as the previous composition.
2. Workspace Runtime opens the existing durable local session and workspace state.
3. Local provider settings and credentials resolve from their canonical stores.
4. Hosted-only persisted surfaces are pruned by Unit 2 while local sessions and terminals remain available.

Terminal states: existing local data visible; a canonical migration error when a real schema migration is required; no empty replacement store caused by package-relative path drift.

### Flow 6 — Independent product build

1. A build starts from one product's package manifest and declared entrypoint.
2. The source-closure guard walks transitive value imports, including static re-exports and string-literal dynamic imports.
3. The build emits a machine-readable module/chunk manifest.
4. The artifact guard evaluates the emitted closure and a real entrypoint smoke runs.

Terminal states: build and smoke succeed using only the declared product closure; the first undeclared or cross-product edge fails with its shortest import chain.

### Flow 7 — Structural packaged-desktop acceptance

1. Desktop's normal macOS package path consumes the same fingerprinted local app and local-server entries used by development and production build.
2. Electron-builder includes only the local boundary manifests, declared native modules, desktop main/preload/renderer outputs, and explicit harness launch assets.
3. The packaged-resource checker inventories the app bundle and rejects cross-product or undeclared resources.
4. The unsigned app launches, reaches local server health, renderer readiness, local route gates, and PTY first output, then exits cleanly with no empty-shell harness process.

Terminal states: structural package acceptance with machine-readable inventory and smoke evidence; an actionable entry-fingerprint mismatch; the first forbidden/undeclared resource; or the exact readiness/shutdown gate that failed. Memory budgets and per-harness cohorts remain U9 acceptance work.

## Open Questions

### Resolved During Planning

- **Does `@claxedo/app` move directories?** No. `packages/claxedo-app` remains the directory for the local/shared app package, matching the established vocabulary. The hosted browser product is added at `packages/claxedo-cloud-app`.
- **Must U5, U6, or U7 be executed separately first?** No. Units 2–4 include the exact enabling behavior this package split requires, and the later extraction units depend on those units inside this document.
- **Does hosted Node split from workerd?** No. Both remain runtimes of `@claxedo/server` and continue to share the hosted app composition.
- **Does desktop keep embedded account auth?** No. The origin product contract places account identity in the hosted browser and requires fixed HTTPS links from desktop.
- **What does "signed desktop" mean after the split?** It is a linked host: the user signs into cloud-app in the system browser and approves one enrollment covering all current and future local workspaces on that machine. Host Connector stores the revocable machine identity; the renderer remains the unsigned local composition.
- **How do web/mobile clients reach a machine workspace?** Host Connector reconciles the machine's complete canonical inventory into per-workspace hosted links. Hosted Server authorizes the signed client and mints short-lived access to one of those workspaces; Workspace Relay routes it through the laptop's outbound machine tunnel to the matching Workspace Runtime.
- **What happens after a connection loss?** Host Connector reacquires host authorization, rereads the complete inventory, and replaces the machine tunnel registration. Each client separately reacquires runtime access, resumes canonical events from its cursor or refetches after a gap, and reattaches live resources by ID. Transport recovery never repeats a prompt.
- **Does sharing upload or fail over the local working tree to cloud compute?** The laptop remains authoritative and remote clients see host-offline when it is unavailable. Cloud VM creation is a separate explicit hosted flow.
- **Does unsigned local mode provision sandbox VMs?** Cloud VM provisioning belongs to the signed hosted product. Desktop's cloud-workspace affordance opens cloud-app.
- **Can local-server import shared helpers from server?** No runtime edge is allowed. Workspace-owned contracts move to Workspace Runtime; local HTTP/config/credential behavior moves with local-server; hosted behavior remains with server.
- **Can cloud-app import app source through aliases?** No. It depends on the public `@claxedo/app` composition and component contracts, so a package build validates the boundary.
- **Where is final package-resource acceptance?** U8 establishes source/build/package artifact guards, verifies the Host Connector remains an optional child, and runs one structural unsigned package smoke. U9 owns resource trimming, harness-cohort memory, and performance evidence.

### Implementation-Level Degrees of Freedom

- **Local-server file layout:** use `src/server.ts` and `src/main.ts` as the public composition/process seams; place Workspace Runtime adaptation under `src/workspace`, local profile and credentials under `src/config` and `src/credentials`, and HTTP/network enforcement under `src/http`. Keep a helper inline unless it represents one of those independent boundaries or has multiple consumers.
- **Contribution contract:** `product-contributions.ts` is the single registry contract. It exposes the local default contribution set and accepts one hosted contribution set before render; WorkGraph and Documents are lazy members of that hosted set. Implementation may refine internal type names without adding a second capability registry.
- **Boundary manifest:** each build emits normalized JSON containing the production entry, module IDs, output chunks, and static/dynamic edges. Unit 11 owns the deterministic normalizer and gives the same JSON to desktop's build contract and U9.

## Implementation Units

### Phase A — Establish the authoritative boundaries

- [ ] **Unit 1: Freeze the two product contracts before moving source**

**Goal:** Capture the approved local and hosted route, workflow, dependency, and persistence behavior so each later move has a discriminating gate.

**Requirements:** U8-R6, U8-R8, U8-R9, U8-R12, U8-R14, U8-R15, U8-R17, U8-R18, U8-R20, U8-R21, U8-R22, U8-R23

**Dependencies:** None

**Files:**

- Create: `packages/claxedo-server/src/deployments/local/local-product-contract.test.ts`
- Create: `packages/claxedo-server/src/deployments/hosted-shared/hosted-product-contract.test.ts`
- Create: `packages/claxedo-app/src/architecture/local-product-boundary.guard.test.ts`
- Create: `packages/claxedo-app/src/architecture/cloud-product-entry.guard.test.ts`
- Modify: `packages/claxedo-app/e2e/playwright/desktop-unsigned-embedded.spec.ts`
- Modify: `packages/claxedo-app/e2e/playwright/web-signed-cloud.spec.ts`
- Modify: `packages/claxedo-app/e2e/playwright/web-signed-userhosted.spec.ts`
- Modify: `packages/claxedo-app/e2e/playwright/desktop-signed-embedded-shared.spec.ts`
- Modify: `packages/claxedo-app/e2e/playwright/desktop-signed-cloud.spec.ts`
- Create: `packages/claxedo-desktop/scripts/product-mode-contract.test.ts`
- Modify: `packages/claxedo-desktop/scripts/claxedo-server-boot.test.ts`
- Modify: `packages/claxedo-desktop/scripts/contract.test.ts`
- Modify: `packages/workspace-relay/src/auth.test.ts`
- Modify: `packages/workspace-relay/src/bun.test.ts`
- Modify: `packages/workspace-relay/src/cloudflare.test.ts`
- Modify: `packages/workspace-runtime/src/workspace-relay-host-tunnel.test.ts`
- Modify: `packages/workspace-runtime/src/workspace-host-service-auth.test.ts`
- Modify: `packages/claxedo-app/src/platform/runtime/agent/workspace-relay-connection.test.ts`
- Modify: `packages/claxedo-app/src/features/workspaces/data/workspace-connection.test.ts`
- Modify: `packages/claxedo-app/src/platform/runtime/connection-placement.test.ts`
- Modify: `packages/workspace-runtime/src/routes/runtime-events.test.ts`

**Approach:**

- Record the target local route-family allowlist and map each family to its current producer: health/bootstrap, local config/provider/credentials, Workspace Runtime proxy/HTTP/SSE, project/file/diff/PTY/process/session, and diagnostics hooks that are part of the local contract.
- Record the hosted route and journey set from `createHostedApp`, including auth, authority, remote sandbox, relay, WorkGraph, Documents, billing, connections, channels, and wakes.
- Record canonical profile/data locations and prove that the current local entry reads a fixture profile containing workspace, session, provider, and credential metadata.
- Record the four-mode product matrix: unsigned local, linked user-hosted, unsigned sandbox-VM destination, and signed cloud VM. Pin identity location, compute location, required processes, remote reachability, offline behavior, and laptop dependency for each.
- Characterize the current user-hosted host-link/tunnel/Relay contract before moving it: Hosted Server connection mint, the absence of `directRuntimeUrl` for user-hosted connections, Runtime Access Token verification and role enforcement, authenticated target/revocation resolution, Relay Host Token replacement of client auth, local host-token verification, Bun multi-workspace registration replacement, Cloudflare one-workspace room admission, exponential reconnect, dead-socket watchdog, client reconnecting state, and cursored Runtime-event replay. Change only the expected desktop identity result to browser approval plus a machine-scoped all-local-workspaces enrollment rather than an account-bearing Electron renderer.
- Make local/cloud source-graph fixtures discriminating by injecting a representative forbidden edge and asserting that the scanner reports the shortest path.
- Preserve the current public URL and event shapes; the tests characterize ownership and behavior, not current file location.

**Execution note:** Add characterization coverage before moving either composition root.

**Patterns to follow:**

- `packages/claxedo-server/src/deployments/hosted-workerd/worker.import-graph.test.ts`
- `packages/claxedo-app/src/architecture/import-graph.guard.test.ts`
- `packages/claxedo-desktop/scripts/contract.test.ts`

**Test scenarios:**

- **Happy path:** unsigned local app exposes every approved local route family and a local session/list/PTY fixture completes without hosted services.
- **Happy path:** hosted app exposes the existing signed hosted route families and its web journey reaches cloud workspace, WorkGraph, and Documents fixtures.
- **Edge case:** a fixture profile created through the current entry is opened through the characterized path with the same workspace and session IDs.
- **Error path:** a local source fixture importing Clerk or WorkGraph fails and prints the import chain.
- **Error path:** a hosted source fixture importing an Electron/desktop module fails and prints the import chain.
- **Integration:** desktop boot reaches renderer ready, route gates, and PTY first output through the current entry; this becomes the comparison gate for Unit 10.
- **Integration:** user-hosted control traffic crosses signed client → Hosted Server for list and connection mint, while Runtime bytes cross signed client → Relay → laptop runtime. Assert that the user-hosted connection has no direct laptop URL and that cloud traffic follows the corresponding Relay → sandbox runtime path.
- **Integration:** a machine with two existing local workspaces enrolls once and publishes both using the configured existing Relay mode. Adding a third needs no approval; removing one removes its route; a Relay loss reconnects to exactly the remaining set. Run the transport assertion once with Bun's multi-workspace registration and once with Cloudflare's per-workspace room handles. A connected client resumes events without a duplicate prompt.

**Verification:** The contract tests fail when any required route is removed, any forbidden product edge is injected, or the profile root changes; they pass against the pre-move composition.

- [ ] **Unit 2: Establish hosted-only WorkGraph and Documents contributions**

**Goal:** Make WorkGraph and Documents explicit hosted capabilities whose code, routes, state, and lifecycle are absent from the unsigned renderer and server compositions before their packages split.

**Requirements:** U8-F1, U8-R2, U8-R3, U8-R4, U8-R6, U8-R8, U8-R15

**Dependencies:** Unit 1

**Files:**

- Create: `packages/claxedo-app/src/app/composition/product-contributions.ts`
- Create: `packages/claxedo-app/src/app/composition/product-contributions.test.ts`
- Modify: `packages/claxedo-app/src/app/integrations/feature-ports.ts`
- Modify: `packages/claxedo-app/src/app/integrations/first-party-content-surfaces.tsx`
- Modify: `packages/claxedo-app/src/app/integrations/registry.ts`
- Modify: `packages/claxedo-app/src/app/workbench/state/orchestration.ts`
- Modify: `packages/claxedo-app/src/app/workbench/state/orchestration.test.ts`
- Modify: `packages/claxedo-app/src/app/workbench/workbench/tests/A-hydration.test.ts`
- Modify: `packages/claxedo-app/src/app/workbench/compact-switcher/switcher-items-from-state.test.ts`
- Modify: `packages/claxedo-app/src/architecture/workgraph-eager-surface.guard.test.ts`
- Create: `packages/claxedo-app/src/architecture/local-hosted-capability.guard.test.ts`
- Modify: `packages/claxedo-server/src/deployments/local/server.ts`
- Modify: `packages/claxedo-server/src/deployments/hosted-shared/hosted-app.ts`
- Create: `packages/claxedo-server/src/deployments/local/hosted-capability-absence.test.ts`
- Modify: `packages/claxedo-server/src/deployments/hosted-shared/hosted-app.test.ts`

**Approach:**

- Define the single product-contribution registry consumed by app composition. Local registers the core session/terminal/provider/workspace contributions; hosted adds WorkGraph and Documents through named lazy contribution loaders.
- Convert WorkGraph and Documents surface registration, feature ports, routes, navigation, settings, and app integrations into hosted contributions. Dynamic imports begin at the hosted contribution entry rather than inside an otherwise local-owned module.
- Keep contribution IDs, route strings, content types, and persisted workbench payloads stable for the hosted product.
- During local state hydration, remove unavailable WorkGraph, workspace-WorkGraph, page, and pages-index content from content IDs, recency, pane selection, split snapshots, and route projection in one normalized state transition. Preserve local session and terminal content.
- Place server WorkGraph and Documents route/tool/database/timer/subscription construction behind the hosted composition root. The unsigned local composition constructs neither capability.
- Make availability explicit at composition time. Runtime feature flags do not repair a local source edge; local production entries must have no value import into the hosted capability implementations.

**Execution note:** Start with failing absence and restored-state characterization tests, then move the authoritative registrations.

**Patterns to follow:**

- `packages/claxedo-app/src/app/integrations/registry.ts`
- `packages/claxedo-app/src/app/workbench/workbench/validate.ts`
- `packages/claxedo-server/src/deployments/hosted-shared/hosted-app.ts`

**Test scenarios:**

- **Happy path:** hosted composition registers WorkGraph and Documents once and retains existing routes, surfaces, and feature behavior.
- **Happy path:** local composition registers session, terminal, provider, and local workspace capabilities with zero WorkGraph/Document registrations.
- **Edge case:** a restored state containing hosted and local surfaces prunes every hosted reference while retaining pane focus on a valid local surface.
- **Edge case:** a state containing only hosted surfaces resolves to the canonical empty/local-home state without dangling pane or route references.
- **Error path:** duplicate hosted contribution IDs fail during composition and do not shadow an existing contribution.
- **Error path:** a local entry value-importing a WorkGraph or Documents implementation fails the architecture guard with its import chain.
- **Integration:** unsigned local boot creates zero hosted routes, tools, databases, timers, and subscriptions; signed hosted boot retains them.

**Verification:** WorkGraph and Documents are fully hosted contributions, unavailable persisted surfaces normalize safely, and local renderer/server production graphs do not reach their implementations.

- [ ] **Unit 3: Complete Workspace Runtime harness lifecycle ownership**

**Goal:** Make Workspace Runtime's lazy harness registry the sole local dispatch path and give each adapter complete start/share/active/idle/stop/restart and transport-security ownership.

**Requirements:** U8-F2, U8-F3, U8-F4, U8-F5, U8-F6, U8-R5, U8-R6, U8-R9, U8-R15

**Dependencies:** Unit 1

**Files:**

- Modify: `packages/workspace-runtime/src/workspace/runtime.ts`
- Modify: `packages/workspace-runtime/src/workspace/runtime.test.ts`
- Modify: `packages/workspace-runtime/src/index.ts`
- Create: `packages/agent-sdk-runtime/src/harnesses/shared/process-lifecycle.ts`
- Create: `packages/agent-sdk-runtime/src/harnesses/shared/process-lifecycle.test.ts`
- Modify: `packages/agent-sdk-runtime/src/harnesses/index.ts`
- Modify: `packages/agent-sdk-runtime/src/harnesses/opencode/index.ts`
- Modify: `packages/agent-sdk-runtime/src/harnesses/opencode/process.ts`
- Create: `packages/agent-sdk-runtime/src/harnesses/opencode/process.test.ts`
- Modify: `packages/agent-sdk-runtime/src/harnesses/opencode/workspace-behavior.test.ts`
- Modify: `packages/agent-sdk-runtime/src/harnesses/acp/index.ts`
- Modify: `packages/agent-sdk-runtime/src/harnesses/acp/process.ts`
- Modify: `packages/agent-sdk-runtime/src/harnesses/acp/process.test.ts`
- Modify: `packages/agent-sdk-runtime/src/harnesses/codex/index.ts`
- Modify: `packages/agent-sdk-runtime/src/harnesses/codex/driver.ts`
- Modify: `packages/agent-sdk-runtime/src/harnesses/claude/index.ts`
- Modify: `packages/agent-sdk-runtime/src/harnesses/claude/driver.ts`
- Modify: `packages/agent-sdk-runtime/src/harnesses/pi/index.ts`
- Modify: `packages/claxedo-server/src/deployments/local/embedded-workspace-runtime.ts`
- Modify: `packages/claxedo-server/src/deployments/local/embedded-workspace-runtime.test.ts`

**Approach:**

- Use `defaultWorkspaceHarnessRegistry()` as the default local registry while allowing hosts to supply any supported subset. Registry entries load adapter modules only when an explicit operation selects them.
- Introduce one shared lifecycle primitive only for semantics common to all five adapters: single-flight startup, generation ownership, active-work leases, 30-second idle grace, bounded stop, parent-loss cleanup, and failure-state reset. Protocol behavior remains in each adapter.
- Count requests, response streams, client-owned event streams, and adapter-reported protocol work as activity leases. Idle countdown begins only after the final lease and protocol activity end.
- Preserve retry classification inside adapters: known non-delivery may retry where safe; stable identities guard replayable mutations; uncertain delivery surfaces an explicit result.
- For native OpenCode network transport, generate a fresh launch credential, bind to `127.0.0.1`, attach Basic authorization to every adapter request, remove the credential before provider dispatch, and redact it from diagnostics/logs. Pipe-based adapters use parent-owned stdio.
- Remove local server process-lifecycle ownership as each responsibility enters the generic Workspace Runtime/adapter contract. The server becomes a host policy/configuration supplier.

**Execution note:** Implement lifecycle behavior test-first against a deterministic child fixture before connecting real harness adapters.

**Patterns to follow:**

- `packages/workspace-runtime/src/workspace/runtime.ts` registry types and lazy loader
- `packages/agent-sdk-runtime/src/harnesses/acp/process.ts`
- `packages/agent-sdk-runtime/src/harnesses/shared/turn-lifecycle.ts`
- `packages/claxedo-desktop/scripts/codex-acp.test.ts`

**Test scenarios:**

- **Happy path:** first explicit operation loads and starts exactly the selected adapter; a second concurrent operation joins the same startup generation.
- **Happy path:** warm operation reuses a live child; the first post-idle operation starts a new generation against durable state.
- **Edge case:** Workspace Runtime boots and serves non-harness routes with each supported adapter package independently absent.
- **Edge case:** active request, response stream, explicit event stream, and protocol-reported work each suspend the idle deadline until released.
- **Error path:** startup failure rejects all joiners, clears pending state, cleans partial children, and allows a later successful start.
- **Error path:** parent loss/application shutdown terminates every adapter-owned descendant within the bounded shutdown interval.
- **Security:** OpenCode rejects missing/incorrect credentials; binds only to loopback; arguments, environment diagnostics, HTTP logs, and provider-bound requests expose no credential.
- **Replay safety:** known-non-delivery read retry follows adapter policy; uncertain mutation delivery is surfaced and never silently replayed.
- **Integration:** explicit operations work for OpenCode, Codex, Claude, ACP, and Pi, and each adapter returns to absent after its liveness contract settles.

**Verification:** Workspace Runtime is the sole local harness dispatcher; process inventory is zero before explicit work and after idle; all adapter lifecycle/security/replay tests pass.

- [ ] **Unit 4: Make session inventory and canonical events runtime-owned**

**Goal:** Make generic local hydration independent of every harness and compatibility stream, with durable runtime metadata and an explicit selected-harness refresh for historical imports.

**Requirements:** U8-F2, U8-F7, U8-R6, U8-R9, U8-R15

**Dependencies:** Unit 3

**Files:**

- Modify: `packages/workspace-runtime/src/store.ts`
- Modify: `packages/workspace-runtime/src/store.test.ts`
- Modify: `packages/workspace-runtime/src/runtime-event-hub.ts`
- Create: `packages/workspace-runtime/src/runtime-event-hub.test.ts`
- Modify: `packages/workspace-runtime/src/workspace/runtime.ts`
- Modify: `packages/workspace-runtime/src/workspace/runtime.test.ts`
- Modify: `packages/workspace-runtime/src/routes/session.ts`
- Modify: `packages/workspace-runtime/src/routes/session.test.ts`
- Modify: `packages/workspace-runtime/src/routes/events.ts`
- Modify: `packages/workspace-runtime/src/routes/events.test.ts`
- Modify: `packages/workspace-runtime/src/routes/runtime-events.ts`
- Modify: `packages/workspace-runtime/src/routes/runtime-events.test.ts`
- Modify: `packages/claxedo-server/src/deployments/local/embedded-workspace-runtime.ts`
- Modify: `packages/claxedo-server/src/deployments/local/embedded-workspace-runtime.test.ts`
- Modify: `packages/claxedo-server/src/session/routes/meta-routes.ts`
- Modify: `packages/claxedo-server/src/session/routes/meta-routes.test.ts`
- Modify: `packages/claxedo-app/src/features/session/data/query/inventory.ts`
- Modify: `packages/claxedo-app/src/features/session/data/query/inventory.test.ts`
- Modify: `packages/claxedo-app/src/features/session/data/sync/session-inventory.ts`
- Modify: `packages/claxedo-app/src/features/session/data/sync/session-inventory.test.ts`

**Approach:**

- Store the local session inventory, selected harness identity, title, status projection, directory/workspace identity, and stable external harness identity in Workspace Runtime's durable store.
- Publish canonical created, updated, status, title, and deleted events from the same store mutation/reconciliation boundary. Each durable transition produces one canonical event.
- Make generic session-list and empty-shell hydration read the runtime store directly. They never call a default adapter and never open OpenCode's global compatibility SSE.
- Scope compatibility SSE to explicit operations that require it and account for that stream in the selected adapter's liveness leases.
- Add a named refresh operation that requires a harness selection, calls that adapter's discovery API, and idempotently binds/imports historical harness metadata using stable identities.
- Reconcile historical projected prompts/metadata through the authoritative runtime store without duplicating sessions or title events.
- Move app inventory queries to the generic runtime-owned route and retain an explicit refresh action for users who request harness discovery.

**Execution note:** Start with store and route tests proving zero adapter selection before changing app hydration.

**Patterns to follow:**

- `packages/workspace-runtime/src/store.ts`
- `packages/workspace-runtime/src/runtime-event-hub.ts`
- `packages/workspace-runtime/src/routes/runtime-events.ts`
- `packages/claxedo-app/src/features/session/data/sync/inventory-source.ts`

**Test scenarios:**

- **Happy path:** local session creation/update/title/status/delete changes the durable store and publishes exactly one corresponding canonical event.
- **Happy path:** empty-shell hydration and session listing return durable rows with zero adapter module loads and zero harness processes.
- **Happy path:** selected-harness refresh imports historical sessions and titles, then releases the adapter lifecycle.
- **Edge case:** repeating refresh with the same stable external IDs leaves the same session rows and emits no duplicate mutation.
- **Edge case:** an exact retry against an already projected historical session reconciles to the existing durable identity.
- **Error path:** discovery failure leaves existing runtime inventory intact and reports the selected harness error without partially imported rows.
- **Error path:** closing the last explicit compatibility stream releases its activity lease and permits idle teardown.
- **Integration:** app launch, local session list, title update, restart, and post-idle inventory all operate while harness process count remains zero outside explicit work.

**Verification:** Workspace Runtime is the authoritative producer for local inventory and canonical events, generic app hydration has no harness side effect, and explicit historical refresh is stable and idempotent.

### Phase B — Extract the product packages

- [ ] **Unit 5: Extract the authoritative desktop-local server package**

**Goal:** Create `@claxedo/local-server` and move the Unit 4 local composition, local services, and embedded Workspace Runtime wiring into its independent source and manifest closure.

**Requirements:** U8-R1, U8-R5, U8-R6, U8-R9, U8-R15, U8-R16, U8-R17, U8-R20, U8-R21, U8-R22, U8-R23

**Dependencies:** Units 1–4

**Files:**

- Create: `packages/claxedo-local-server/package.json`
- Create: `packages/claxedo-local-server/tsconfig.json`
- Create: `packages/claxedo-local-server/tsconfig.build.json`
- Create: `packages/claxedo-local-server/src/index.ts`
- Create: `packages/claxedo-local-server/src/main.ts`
- Create: `packages/claxedo-local-server/src/server.ts`
- Create: `packages/claxedo-local-server/src/server.test.ts`
- Create: `packages/claxedo-local-server/src/main.test.ts`
- Create: `packages/claxedo-local-server/scripts/build.ts`
- Create: `packages/claxedo-local-server/src/config/profile.ts`
- Create: `packages/claxedo-local-server/src/credentials/service.ts`
- Create: `packages/claxedo-local-server/src/http/security.ts`
- Move: `packages/claxedo-server/src/deployments/local/local-product-contract.test.ts` to `packages/claxedo-local-server/src/local-product-contract.test.ts`
- Move: `packages/claxedo-server/src/deployments/local/embedded-workspace-runtime.ts` to `packages/claxedo-local-server/src/workspace/embedded-workspace-runtime.ts`
- Move: `packages/claxedo-server/src/deployments/local/embedded-workspace-runtime.test.ts` to `packages/claxedo-local-server/src/workspace/embedded-workspace-runtime.test.ts`
- Move: `packages/claxedo-server/src/deployments/local/server-workspace-pty-proxy.ts` to `packages/claxedo-local-server/src/workspace/server-workspace-pty-proxy.ts`
- Move: `packages/claxedo-server/src/deployments/local/port.ts` to `packages/claxedo-local-server/src/http/port.ts`
- Move: `packages/claxedo-server/src/deployments/local/server-usage-limits.ts` to `packages/claxedo-local-server/src/http/usage-limits.ts`
- Move: `packages/claxedo-server/src/deployments/local/usage-limits.contract.test.ts` to `packages/claxedo-local-server/src/http/usage-limits.contract.test.ts`
- Move: `packages/claxedo-server/src/deployments/local/server.security-headers.test.ts` to `packages/claxedo-local-server/src/http/security-headers.test.ts`
- Move and simplify: `packages/claxedo-server/src/workspace/runtime-dispatch/shared-workspace-endpoint.ts` to `packages/claxedo-local-server/src/workspace/connector-runtime-endpoint.ts`
- Move and simplify: `packages/claxedo-server/src/workspace/runtime-dispatch/shared-workspace-endpoint.test.ts` to `packages/claxedo-local-server/src/workspace/connector-runtime-endpoint.test.ts`
- Create: `packages/claxedo-local-server/src/workspace/connector-access.ts`
- Create: `packages/claxedo-local-server/src/workspace/connector-access.test.ts`
- Create: `packages/claxedo-local-server/src/workspace/connector-inventory.ts`
- Create: `packages/claxedo-local-server/src/workspace/connector-inventory.test.ts`
- Modify: `packages/claxedo-desktop/package.json`
- Modify: `packages/claxedo-desktop/scripts/claxedo-server-entry.ts`
- Modify: `packages/claxedo-desktop/scripts/bundle-claxedo-server.ts`
- Modify: `packages/claxedo-desktop/scripts/predev.ts`
- Modify: `packages/claxedo-desktop/scripts/prebuild.ts`
- Modify: `packages/claxedo-desktop/scripts/claxedo-server-boot.test.ts`
- Modify: `package.json`
- Modify: `bun.lock`

**Approach:**

- Build the new server around the Unit 4 Workspace Runtime application and event hub, using direct runtime composition for workspace/session/file/diff/PTY/process routes.
- Move local configuration, provider credential, profile, loopback security, telemetry, and shutdown code only when it is part of the approved local capability table. Each moved producer leaves one canonical implementation.
- Keep the server package API small: a create-app seam for tests/embedding, a start seam for process ownership, and package metadata/entry exports needed by desktop.
- Preserve current local URL paths and data roots so renderer clients and existing profiles require no compatibility adapter.
- Declare only the runtime dependencies reachable from the local entry; independently selected harness adapter packages remain explicit rather than entering through `@claxedo/server`.
- Expose the user-hosted surface as a connector-only loopback contract. Electron brokers a fresh per-launch connector credential outside arguments/logs. That contract provides a full canonical local-workspace snapshot, an inventory-change stream, and Runtime forwarding for IDs that are present in the latest snapshot. Each successful response identifies itself as complete and carries a monotonic local inventory version; an error is distinct from a successful empty snapshot. Safe inventory metadata includes stable workspace ID and display name; local directory, provider, and credential fields remain local.
- Validate inventory membership again for every forwarded request so a stale or compromised connector cannot retain access to a deleted workspace. The connector credential permits only inventory read/change events and Workspace Runtime route ownership; configuration, provider credentials, general local HTTP routes, and workspace creation remain outside its scope.
- Keep Relay/WebSocket, host enrollment, hosted reconciliation, account authority, and reconnect logic out of local-server. Its sharing responsibility is authenticating the local connector, producing the canonical inventory from Workspace Runtime, and adapting an inventory-present runtime route.
- Rewire the desktop server child, development preparation, production bundle input, and boot smoke to the new package in the same unit. The renderer remains on its existing entry until Unit 10, but no desktop process references the old server-local entry when this unit completes.
- Keep startup failure explicit when Workspace Runtime, a configured adapter, a native module, or a required local asset is missing.

**Patterns to follow:**

- `packages/workspace-runtime/package.json` and `scripts/build.ts`
- `packages/claxedo-connections/package.json` and `scripts/build.ts`
- `packages/claxedo-server/src/deployments/local/embedded-workspace-runtime.ts`

**Test scenarios:**

- **Happy path:** create-app serves health, bootstrap, project/session inventory, provider/config/credential, file/diff/process, and event routes from a temporary profile.
- **Happy path:** PTY create/output/resize/close crosses the local-server adapter into Workspace Runtime.
- **Happy path:** an explicit selected-harness operation reaches Unit 3's registry while generic session listing starts no adapter.
- **Edge case:** concurrent workspaces resolve isolated Workspace Runtime instances while sharing the local-server process.
- **Edge case:** reopening an existing fixture profile returns the same session, title, harness selection, and provider settings.
- **Edge case:** connector inventory distinguishes a successful empty snapshot from a timeout, malformed response, or interrupted read; only successful complete snapshots advance the monotonic inventory version.
- **Error path:** unavailable configured adapter or native PTY support surfaces a canonical error and leaves the server alive when the owning contract permits recovery.
- **Error path:** parent shutdown closes HTTP/SSE, PTYs, Workspace Runtime instances, and adapter-owned children within their existing bounded contracts.
- **Security:** the connector can reach Runtime routes for current canonical local workspace IDs and no others; deleted, fabricated, cloud, or stale IDs, provider/config routes, and non-Runtime routes fail before local dispatch. Forwarded headers, non-loopback peers, expired generations, and incorrect credentials fail before route resolution.
- **Integration:** adding and deleting workspaces through Workspace Runtime changes the connector inventory stream exactly once and immediately changes the runtime-forwarding allowlist without restarting local-server.
- **Integration:** the package builds and its built entry boots with hosted package source trees unavailable.

**Verification:** `@claxedo/local-server` typechecks, builds, and passes its route/runtime integration suite using only its manifest closure; no runtime import points at `packages/claxedo-server`.

- [ ] **Unit 6: Extract browser-approved Host Connector and user-hosted enrollment**

**Goal:** Preserve machine-wide remote access to every canonical local workspace, including automatic inventory changes and reconnection, without restoring an account-bearing Electron renderer or a hosted dependency edge in local-server.

**Requirements:** U8-R7, U8-R16, U8-R17, U8-R19, U8-R20, U8-R21, U8-R22, U8-R23

**Dependencies:** Units 1, 2, and 5

**Files:**

- Create: `packages/claxedo-host-connector/package.json`
- Create: `packages/claxedo-host-connector/tsconfig.json`
- Create: `packages/claxedo-host-connector/tsconfig.build.json`
- Create: `packages/claxedo-host-connector/scripts/build.ts`
- Create: `packages/claxedo-host-connector/src/index.ts`
- Create: `packages/claxedo-host-connector/src/main.ts`
- Create: `packages/claxedo-host-connector/src/main.test.ts`
- Create: `packages/claxedo-host-connector/src/enrollment/client.ts`
- Create: `packages/claxedo-host-connector/src/enrollment/client.test.ts`
- Create: `packages/claxedo-host-connector/src/enrollment/store.ts`
- Create: `packages/claxedo-host-connector/src/enrollment/store.test.ts`
- Create: `packages/claxedo-host-connector/src/inventory/local-inventory-client.ts`
- Create: `packages/claxedo-host-connector/src/inventory/local-inventory-client.test.ts`
- Create: `packages/claxedo-host-connector/src/inventory/reconciler.ts`
- Create: `packages/claxedo-host-connector/src/inventory/reconciler.test.ts`
- Move and narrow: `packages/claxedo-server/src/deployments/local/remote-access-service.ts` to `packages/claxedo-host-connector/src/enrollment/share-service.ts`
- Move and adapt ownership: `packages/claxedo-server/src/deployments/local/remote-access-service.test.ts` to `packages/claxedo-host-connector/src/enrollment/share-service.test.ts`
- Move: `packages/claxedo-server/src/workspace/local-host.ts` to `packages/claxedo-host-connector/src/identity/local-host.ts`
- Create: `packages/claxedo-host-connector/src/identity/local-host.test.ts`
- Move and narrow: `packages/claxedo-server/src/user-hosted-tunnel.ts` to `packages/claxedo-host-connector/src/tunnel/user-hosted-machine-tunnel.ts`
- Move and adapt ownership: `packages/claxedo-server/src/user-hosted-tunnel.test.ts` to `packages/claxedo-host-connector/src/tunnel/user-hosted-machine-tunnel.test.ts`
- Move and adapt ownership: `packages/claxedo-server/src/user-hosted-tunnel.e2e.test.ts` to `packages/claxedo-host-connector/src/tunnel/user-hosted-machine-tunnel.e2e.test.ts`
- Modify: `packages/workspace-runtime/src/workspace-relay-host-tunnel.ts`
- Modify: `packages/workspace-runtime/src/workspace-relay-host-tunnel.test.ts`
- Create: `packages/claxedo-host-connector/src/runtime/local-runtime-target.ts`
- Create: `packages/claxedo-host-connector/src/runtime/local-runtime-target.test.ts`
- Create: `packages/claxedo-server/src/routes/hosted/host-enrollment.ts`
- Create: `packages/claxedo-server/src/routes/hosted/host-enrollment.test.ts`
- Create: `packages/claxedo-server/src/platform/auth/host-enrollment-token.ts`
- Create: `packages/claxedo-server/src/platform/auth/host-enrollment-token.test.ts`
- Modify: `packages/claxedo-server/src/authority/services.ts`
- Modify: `packages/claxedo-server/src/authority/hosted-services.ts`
- Modify: `packages/claxedo-server/src/authority/hosted-services.test.ts`
- Modify: `packages/claxedo-server/src/workspace/route-support.ts`
- Modify: `packages/claxedo-server/src/platform/auth/authority.ts`
- Modify: `packages/claxedo-server/src/authority/adapters/convex/workspace-authority/api.ts`
- Modify: `packages/claxedo-server/src/authority/adapters/convex/workspace-authority/workspaces.ts`
- Modify: `packages/claxedo-server/src/authority/adapters/convex/workspace-authority/index.test.ts`
- Modify: `packages/claxedo-server/src/authority/adapters/sqlite/workspace-authority-store.ts`
- Modify: `packages/claxedo-server/src/authority/adapters/sqlite/workspace-authority.ts`
- Modify: `packages/claxedo-server/src/authority/adapters/sqlite/workspace-authority.test.ts`
- Create: `convex/hostEnrollmentAttempts.ts`
- Create: `convex/host-enrollment-attempts.policy.test.ts`
- Create: `convex/hostEnrollments.ts`
- Create: `convex/host-enrollments.policy.test.ts`
- Modify: `convex/localHostLinks.ts`
- Modify: `convex/local-host-links.policy.test.ts`
- Modify: `convex/schema.ts`
- Modify: `packages/claxedo-server/src/routes/hosted/workspace.ts`
- Modify: `packages/claxedo-server/src/routes/hosted/workspace.test.ts`
- Modify: `packages/claxedo-server/src/deployments/hosted-shared/hosted-app.ts`
- Modify: `packages/claxedo-server/src/deployments/hosted-shared/hosted-app.test.ts`
- Modify: `packages/claxedo-server/src/workspace/routes/index.ts`
- Modify: `packages/claxedo-server/src/workspace/routes/index.test.ts`
- Delete after new callers move: `packages/claxedo-server/src/workspace/local-host-link.ts`
- Create: `packages/claxedo-app/src/app/routes/host-enrollment.tsx`
- Create: `packages/claxedo-app/src/app/routes/host-enrollment.vitest.tsx`
- Modify: `packages/claxedo-app/src/app/entry/app.tsx`
- Create: `packages/claxedo-app/src/platform/desktop/host-connector-port.ts`
- Create: `packages/claxedo-app/src/platform/desktop/host-connector-port.test.ts`
- Modify: `packages/claxedo-app/src/features/onboarding/remote-access-api.ts`
- Modify: `packages/claxedo-app/src/features/onboarding/remote-access-api.test.ts`
- Modify: `packages/claxedo-app/src/features/onboarding/remote-access-controller.ts`
- Modify: `packages/claxedo-app/src/features/onboarding/remote-access-state.ts`
- Modify: `packages/claxedo-app/src/features/onboarding/remote-access-state.test.ts`
- Modify: `packages/claxedo-app/src/features/onboarding/remote-access-surface.tsx`
- Modify: `packages/claxedo-app/src/features/onboarding/remote-access-surface.vitest.tsx`
- Modify: `packages/claxedo-app/src/app/workbench/rail/rail-sidebar.tsx`
- Modify: `packages/claxedo-app/src/app/workbench/rail/rail-sidebar.logic.ts`
- Modify: `packages/claxedo-app/src/app/workbench/rail/rail-sidebar.logic.test.ts`
- Modify: `packages/claxedo-app/src/app/workbench/rail/rail-sidebar-status.test.ts`
- Modify: `packages/claxedo-app/src/app/integrations/feature-ports.ts`
- Modify: `packages/claxedo-desktop/package.json`
- Create: `packages/claxedo-desktop/scripts/host-connector-entry.ts`
- Create: `packages/claxedo-desktop/scripts/bundle-host-connector.ts`
- Create: `packages/claxedo-desktop/scripts/host-connector-boot.test.ts`
- Modify: `packages/claxedo-desktop/scripts/predev.ts`
- Modify: `packages/claxedo-desktop/scripts/prebuild.ts`
- Modify: `packages/claxedo-desktop/electron.vite.config.ts`
- Modify: `packages/claxedo-desktop/src/main/index.ts`
- Create: `packages/claxedo-desktop/src/main/host-connector.ts`
- Create: `packages/claxedo-desktop/src/main/host-connector.test.ts`
- Create: `packages/claxedo-desktop/src/main/host-connector-credentials.ts`
- Create: `packages/claxedo-desktop/src/main/host-connector-credentials.test.ts`
- Modify: `packages/claxedo-desktop/src/main/ipc.ts`
- Modify: `packages/claxedo-desktop/src/preload/index.ts`
- Modify: `packages/claxedo-desktop/src/preload/types.ts`
- Modify: `packages/claxedo-desktop/src/renderer/index.tsx`
- Modify: `package.json`
- Modify: `bun.lock`

**Approach:**

- Reuse the hosted device-authorization shape with a two-party, ten-minute attempt. Host Connector creates a host keypair plus a random redemption verifier, sends the public key and verifier hash to the public begin endpoint, and receives an opaque public attempt ID plus a fixed approval URL. The signed browser explicitly approves the named host and the scope “all current and future local workspaces on this machine”; Host Connector then redeems once by presenting the verifier and a signature from the same host key.
- Store the pending exchange in `host_enrollment_attempts`. Successful redemption creates or rotates one canonical `host_enrollments` machine record containing owner, host ID, public key, grant generation, state, and approval scope. The connector persists its private key and nonsecret enrollment descriptor, then obtains a short-lived host-session credential bound to that machine generation. Renewal starts with a server nonce, requires a signature by the enrolled host private key, and succeeds only for the active generation.
- Keep `local_host_links` as the canonical per-workspace materialization for listing, roles, presence, and Relay target resolution. A host-key-authorized full-set reconcile against `host_enrollments` atomically upserts current workspace links, leaves unchanged links stable, and revokes links omitted from the new snapshot. The machine enrollment is the sole authority for publishing future workspaces; per-workspace links do not become a competing approval source.
- Implement enrollment, reconcile, and active-link operations through the shared Workspace Authority contract with both Convex and SQLite adapters. Reuse `host_attestation_challenges` for one-use renewal nonces after resolving the machine enrollment by host ID/public key. Hosted workerd and self-operated hosted Node therefore share enrollment generation, full-set replacement, pause, revocation, and concurrency semantics.
- Keep user approval and workspace authorization in Hosted Server. The browser page receives the public attempt ID, sanitized host label, and machine-wide scope statement only; local paths, workspace inventory, repository credentials, redemption material, machine credentials, and tunnel tokens never enter HTML, URLs, telemetry, or logs.
- Apply endpoint-specific abuse controls: per-peer and per-host limits on public begin/status/redeem, per-account limits on approve, fixed-size/shape validation before authority work, constant-shape unknown/expired responses, maximum inventory size and metadata limits, and audit events for approval, reconciliation, pause, and revoke. Approval is a same-origin, authenticated POST protected by the hosted app's state/CSRF convention and requires an explicit user gesture; GET only renders status.
- Read local inventory only from Unit 5's connector contract. On connector start and every inventory-change event, obtain a successful complete snapshot and submit it with host-key proof plus the previous accepted reconcile version. Hosted Server accepts one atomic generation/version transition, ensures the enrolling account owns every materialized link, preserves explicit collaborator roles for unchanged workspaces, and returns the exact authorized workspace set. Concurrent or out-of-order snapshots cannot resurrect a removed workspace. A failed or partial read is retried and never submitted as an empty set.
- Move the local user-hosted branch of `user-hosted-tunnel.ts` into Host Connector and keep `startWorkspaceRelayHostTunnel` as the transport producer. Remove its server-store, supervisor, and cloud-sandbox branches from the extracted closure; the only local target comes from Unit 5's connector endpoint.
- Extend `ControlPlaneRelay`, `WorkspaceRouteOptions`, and the existing host-tunnel credential/Relay assignment response with a configured registration mode. Hosted composition validates exactly `machine-multiplexed` or `workspace-room` and fails startup on a missing/unknown production value. In `machine-multiplexed` mode, reuse the current Bun behavior: one handle registers the full accepted set and `updateRegistration` replaces that set. In `workspace-room` mode, reuse the current Cloudflare behavior: maintain one existing host-tunnel handle per accepted workspace, adding and closing handles as inventory changes. The Host Tunnel Token scope matches the registration carried by each handle.
- Preserve `workspace-relay-host-tunnel.ts` recovery behavior: socket errors, closes, failed upgrades, and three missed heartbeat intervals enter its exponential backoff with jitter and cap; `tokenProvider` is called before every connection attempt; local HTTP/WebSocket channels close with the lost tunnel; authenticated registration updates use the existing protocol. Extend `updateRegistration` so its normalized workspace set also replaces the set used by `tunnelUrl` on the next reconnect. Host Connector keeps the latest successful inventory reconciled and applies that set before transport reconnect; connector process start and laptop wake force a complete inventory read before publication.
- Preserve the signed client's independent recovery behavior. A disconnected client marks the workspace reconnecting, parks transport-dependent queries, mints fresh runtime access after Relay can route the host again, and restores the workspace connection by canonical workspace ID. Runtime-event SSE resumes from `Last-Event-ID`; a replay-gap response causes an authoritative refetch. Long-lived resources such as PTYs reattach by canonical resource ID when supported. Transport recovery observes an already-admitted prompt through events or refetch and never submits that prompt again.
- Preserve the existing Relay security boundary rather than introducing another tunnel protocol. Hosted Server continues to mint Runtime Access Tokens and Host Tunnel Tokens. Relay continues to verify token signature/claims, current revocation, role/path permission, target identity, and host presence; it continues to replace client auth with a Relay Host Token and strip dangerous headers/cookies. Workspace Runtime continues to verify that Relay Host Token plus the workspace ID and Relay marker. Pause/revoke closes the supervised connector and denies new or refreshed access under the existing token-establishment lifetime semantics.
- Use the connector-only local-server contract from Unit 5. Electron supplies the per-launch local connector credential and fixed loopback base over a private bootstrap channel. Host Connector derives each target from that bootstrap and an inventory-present workspace ID; Relay messages can select an allowed Runtime path but can never supply a host, port, origin, or upstream URL. The route-ownership and current-inventory gates run before every forward.
- Start Host Connector for explicit enrollment or whenever a durable machine enrollment is active and unpaused, including when its inventory is empty. A linked restart restores host identity and reconnects without user approval unless the machine generation is revoked. Electron restarts a crashed connector under its bounded child policy; quitting desktop intentionally leaves the host offline until next launch.
- Rewire the existing machine-wide Remote Access setup/settings surface through the Host Connector port and typed Electron IPC. The workspace menu may copy/open a particular workspace link, but it does not own per-workspace enrollment. Unit 8 preserves this port while establishing the final local app entry.
- Keep each working tree and Workspace Runtime store authoritative. Enrollment and reconciliation create authority/presence metadata and transport routes; they do not copy working trees or create cloud VMs.

**Execution note:** Start with expiring/single-use enrollment and cross-workspace denial tests, then move the current host identity and tunnel producer.

**Patterns to follow:**

- `packages/cli/src/auth/device-code.ts`
- `packages/claxedo-server/src/routes/hosted/device-auth.ts`
- `packages/claxedo-server/src/routes/hosted/workspace.ts`
- `convex/localHostLinks.ts`
- `packages/claxedo-server/src/deployments/local/remote-access-service.ts`
- `packages/workspace-runtime/src/workspace-relay-host-tunnel.ts`
- `packages/workspace-runtime/src/routes/runtime-events.ts`
- `packages/claxedo-server/src/user-hosted-tunnel.e2e.test.ts`
- `packages/claxedo-server/src/workspace/runtime-dispatch/shared-workspace-endpoint.ts`

**Test scenarios:**

- **Happy path:** signed browser approval plus host-key proof creates one machine enrollment; a two-workspace snapshot creates two per-workspace links and successful remote health for both through Bun's one multi-workspace registration and, in the Cloudflare fixture, two existing workspace-room tunnel handles.
- **Happy path:** creating a third local workspace triggers a full-set reconcile without another approval and updates the configured existing transport shape; deleting one removes its hosted link and Bun registration entry or closes its Cloudflare room handle while the other two remain reachable.
- **Happy path:** after Bun registration changes from `[A, B]` to `[A]`, a forced socket reconnect upgrades with only `A` in the URL and token scope before replaying the authenticated registration update; `B` never appears transiently in Relay presence.
- **Happy path:** the enrolling account can list and open every reconciled current or future workspace automatically; a separately invited collaborator can open only the workspaces where that collaborator has a role, and that role survives unchanged inventory reconciliations.
- **Happy path:** an enrolled restart with zero, one, or many local workspaces starts one connector child, rotates short-lived credentials, reconciles the current snapshot, and reconnects without loading account auth into Electron.
- **Edge case:** concurrent full snapshots use reconcile version/generation checks so a late `[A, B]` update cannot resurrect B after `[A]` was accepted.
- **Edge case:** two machines owned by the same user maintain separate enrollments, inventories, presence, and tunnels; a workspace-ID collision is rejected rather than reparented.
- **Edge case:** concurrent approval/redeem requests consume the one-time claim exactly once and produce one active enrollment generation.
- **Error path:** canceled, expired, already-used, wrong-user, wrong-host-key, malformed-scope, or generation-mismatched approval/redeem fails without creating share state.
- **Error path:** excessive begin, status, redeem, or approve traffic is rate-limited before expensive signature/authority work; unknown and expired attempt IDs reveal no account or workspace existence.
- **Error path:** laptop sleep/network loss enters reconnecting, presence expires to offline within sixty seconds, and wake obtains fresh authorization plus a fresh full inventory before restoring access; no cloud fallback is provisioned.
- **Edge case:** one Cloudflare workspace-room handle disconnects while two remain open; the affected workspace reports reconnecting, the other two remain reachable, and the aggregate machine status is Reconnecting until the full accepted set is restored.
- **Error path:** a local inventory timeout or malformed/partial response never becomes `[]`, never revokes hosted links, and never opens a replacement tunnel until a successful complete snapshot is available; forwarding fails closed while local membership cannot be validated.
- **Error path:** paused/revoked/generation-mismatched machine authorization stops the reconnect loop in a terminal UI state; transient Relay, DNS, and token-mint failures continue bounded backoff.
- **Error path:** hosted production composition with an absent or unknown registration mode fails before issuing a Host Tunnel Token; a mode/Relay mismatch is caught by the existing Bun and Cloudflare host-admission fixture rather than retried as a generic network failure.
- **Security:** the host enrollment cannot call account, billing, cloud-create, WorkGraph, Documents, local config/provider/credential, or another workspace's runtime routes.
- **Security:** a Relay-supplied absolute URL, alternate loopback port, encoded traversal, control-plane path, deleted/fabricated/cloud workspace ID, or ID absent from the current local snapshot is denied before local fetch.
- **Security:** pause/revoke increments the machine generation, closes the supervised connector immediately, rejects new or refreshed client authorization, removes the target from authority resolution, and expires Relay presence under the existing heartbeat contract. Existing long-lived connection lifetime semantics remain exactly as characterized in Unit 1.
- **Security:** approval HTML, URLs, process listings, persisted app state, IPC payload logs, and telemetry contain neither redemption verifier, account token, machine credential, nor tunnel token.
- **Security:** the user-hosted connection response contains `relayUrl` and a scoped Runtime Access Token but no laptop or `directRuntimeUrl`; Relay rejects wrong workspace/host/role/revoked tokens, strips client authorization/cookies/dangerous headers, and Workspace Runtime rejects a missing or mismatched Relay Host Token, workspace header, or Relay marker.
- **Integration:** a signed web/mobile-shaped client lists and opens each authorized workspace on the enrolled machine through real Hosted Server, Relay, Host Connector, local-server, and Workspace Runtime; prompt execution starts the matching laptop harness and returns its stream.
- **Integration:** cut the machine tunnel during an active session, allow Host Connector to reconnect, and prove the client reacquires access, resumes events by cursor or full refetch, reattaches a live PTY by ID, and observes one prompt admission.

**Verification:** One browser-approved machine enrollment continuously publishes the exact canonical local-workspace inventory through the configured existing Relay registration mode; signed Runtime traffic always traverses Workspace Relay; base unsigned launch has zero Host Connector process/module activity; account bearer tokens never enter desktop storage, IPC, environment, arguments, or logs.

- [ ] **Unit 7: Make `@claxedo/server` a hosted-only composition**

**Goal:** Retain hosted Node and workerd products in `@claxedo/server`, remove local composition ownership, and tighten its manifest to hosted capabilities.

**Requirements:** U8-R3, U8-R5, U8-R8, U8-R11, U8-R14, U8-R15, U8-R17, U8-R20, U8-R21, U8-R22, U8-R23

**Dependencies:** Units 2, 5, and 6

**Files:**

- Modify: `packages/claxedo-server/package.json`
- Modify: `packages/claxedo-server/src/index.ts`
- Modify: `packages/claxedo-server/src/deployments/hosted-shared/hosted-app.ts`
- Modify: `packages/claxedo-server/src/deployments/hosted-node/index.ts`
- Modify: `packages/claxedo-server/src/deployments/hosted-workerd/worker.ts`
- Modify: `packages/claxedo-server/src/deployments/hosted-workerd/worker.import-graph.test.ts`
- Modify: `packages/claxedo-server/src/deployments/hosted-shared/hosted-app.test.ts`
- Modify: `packages/claxedo-server/Dockerfile`
- Modify: `packages/claxedo-server/fly.toml`
- Modify: `packages/claxedo-server/wrangler.toml`
- Move: `packages/claxedo-server/src/deployments/local/embedded-auth.ts` to `packages/claxedo-server/src/deployments/hosted-node/embedded-auth.ts`
- Move: `packages/claxedo-server/src/deployments/local/embedded-auth.test.ts` to `packages/claxedo-server/src/deployments/hosted-node/embedded-auth.test.ts`
- Move: `packages/claxedo-server/src/deployments/local/internal-relay-local.ts` to `packages/claxedo-server/src/deployments/hosted-node/internal-relay-node.ts`
- Move: `packages/claxedo-server/src/deployments/local/internal-relay-local.test.ts` to `packages/claxedo-server/src/deployments/hosted-node/internal-relay-node.test.ts`
- Delete after consumers move: `packages/claxedo-server/src/deployments/local/main.ts`
- Delete after consumers move: `packages/claxedo-server/src/deployments/local/server.ts`
- Delete after all listed sources move: `packages/claxedo-server/src/deployments/local/`

**Approach:**

- Keep `createHostedApp` as the shared hosted composition for Node and workerd, preserving the trust/runtime distinction already encoded in `deployments/`.
- Move signed self-operated auth and relay-node files out of the `local` deployment namespace into the nearest hosted Node or owning feature directory, preserving their current exports and tests. Host enrollment authority remains in hosted routes, while the local connector client already moved in Unit 6.
- Keep Hosted Server's existing user-hosted responsibility intact: signed workspace list/open, `userHostedConnectionInfo` connection mint/refresh, Host Tunnel Token mint, and authenticated `/internal/relay/target` plus `/internal/relay/revocation`. Runtime request bodies and streams continue to enter Workspace Relay directly.
- Move every remaining local-only source reached from the deleted local entry into local-server. Unit completion requires deleting the empty `deployments/local` directory, which makes accidental revival of the mixed composition visible in review.
- Place shared workspace/session protocol contracts in their existing lower packages when both product compositions consume them; product-specific adapters stay with their product.
- Change server's default development/start semantics to explicit hosted entrypoints. Desktop development no longer starts server through this manifest.
- Update hosted deployment files only where they reference moved entrypoints or package scripts.
- Retain and strengthen the Worker import-graph gate so the hosted split does not weaken workerd safety.

**Patterns to follow:**

- `packages/claxedo-server/src/deployments/hosted-shared/hosted-app.ts`
- `packages/claxedo-server/src/deployments/hosted-workerd/worker.import-graph.test.ts`
- `docs/plans/2026-08-02-001-refactor-claxedo-server-organization-plan.md` for the hosted trust/runtime vocabulary

**Test scenarios:**

- **Happy path:** hosted Node and workerd mount the same hosted route contract with their runtime-specific adapters.
- **Happy path:** signed auth, authority, remote sandbox, relay, WorkGraph, Documents, billing, connections, channels, and wakes remain reachable through existing hosted tests.
- **Happy path:** host enrollment approval, presence, revocation, user-hosted workspace listing, and runtime-connection mint remain reachable in both supported hosted runtimes.
- **Security:** a user-hosted connection mint checks workspace role and active host link, returns `relayUrl` plus a scoped Runtime Access Token, and contains no `directRuntimeUrl`, laptop address, or Host Connector credential; Relay resolver endpoints accept only the existing resolver trust credential.
- **Edge case:** a hosted Node self-operated deployment retains signed-hosted behavior and optional static cloud-app serving without selecting local-server.
- **Error path:** hosted boot without required signed-auth/authority configuration fails closed through the existing hosted boot assertions.
- **Error path:** workerd import graph rejects Node-only and local-server modules.
- **Integration:** server builds and its hosted tests pass when local-server source is excluded from the server package closure.

**Verification:** `@claxedo/server` has no local start entry or desktop composition dependency, while both hosted runtime suites retain their contracts.

- [ ] **Unit 8: Define the local app composition and public hosted contribution seam**

**Goal:** Establish `@claxedo/app`'s local production entry and the smallest public contract cloud-app needs before the hosted implementation files move in Unit 9.

**Requirements:** U8-R2, U8-R4, U8-R5, U8-R6, U8-R7, U8-R12, U8-R15, U8-R16, U8-R17, U8-R18, U8-R20, U8-R21, U8-R22, U8-R23

**Dependencies:** Units 1 and 2

**Files:**

- Modify: `packages/claxedo-app/package.json`
- Modify: `packages/claxedo-app/src/app/entry/index.tsx`
- Modify: `packages/claxedo-app/src/app/entry/app.tsx`
- Create: `packages/claxedo-app/src/app/entry/local.tsx`
- Create: `packages/claxedo-app/index.local.html`
- Create: `packages/claxedo-app/vite.local.config.ts`
- Modify: `packages/claxedo-app/src/app/composition/product-contributions.ts`
- Modify: `packages/claxedo-app/src/app/composition/product-contributions.test.ts`
- Modify: `packages/claxedo-app/src/app/integrations/feature-ports.ts`
- Modify: `packages/claxedo-app/src/app/integrations/first-party-content-surfaces.tsx`
- Modify: `packages/claxedo-app/src/app/routes/index.ts`
- Modify: `packages/claxedo-app/src/app/workbench/rail/rail-account-menu.tsx`
- Create: `packages/claxedo-app/src/platform/hosted-products/destinations.ts`
- Create: `packages/claxedo-app/src/platform/hosted-products/destinations.test.ts`
- Modify: `packages/claxedo-app/src/platform/desktop/host-connector-port.ts`
- Modify: `packages/claxedo-app/src/platform/desktop/host-connector-port.test.ts`
- Modify: `packages/claxedo-app/src/features/onboarding/remote-access-controller.ts`
- Modify: `packages/claxedo-app/src/features/onboarding/remote-access-state.ts`
- Modify: `packages/claxedo-app/src/features/onboarding/remote-access-surface.tsx`
- Modify: `packages/claxedo-app/src/features/workspaces/actions/project-actions.tsx`
- Modify: `packages/claxedo-app/src/features/workspaces/actions/project-actions.test.ts`
- Modify: `packages/claxedo-app/src/architecture/import-graph.ts`
- Modify: `packages/claxedo-app/src/architecture/local-product-boundary.guard.test.ts`
- Modify: `packages/claxedo-app/src/ARCHITECTURE.md`
- Modify: `packages/claxedo-app/src/VOCABULARY.md`

**Approach:**

- Make the package root and local entry dependency-neutral: local defaults, local provider tree, local routes, local feature contributions, and hosted-destination affordances.
- Keep the contribution seam bounded to today's second consumer, cloud-app. It can register hosted providers, routes, content surfaces, settings/navigation contributions, and cross-feature adapters before the shared app renders.
- Preserve the existing `app -> features/platform/ui/lib` dependency direction. Hosted features use their own ports; app composition assembles them.
- Remove Clerk initialization, auth providers/routes, cloud runtime stores, WorkGraph/Documents implementations, account-token-based remote-access clients, hosted connections clients, and cloud provisioning implementations from the local production-entry graph. The dependency-light machine Remote Access UI remains local and talks only to the injected Host Connector port; hosted files and temporary manifest dependencies remain co-located only until Unit 9 moves them.
- Change app's default `dev` and `build` scripts to the local entry and `vite.local.config.ts`. Keep an explicitly named temporary hosted build script only until Unit 9 moves the current hosted entry; remove that script in Unit 9.
- Keep UI contracts shared only when the local shell genuinely renders them. Hosted-only implementation and copy move with cloud-app.
- Resolve desktop hosted affordances through named destinations such as sign-in, account, WorkGraph, Documents, billing, and Create Cloud Workspace. The local app returns fixed HTTPS URLs rather than constructing account sessions.
- Expose machine-level Enable/Pause/Resume/Revoke/Status through a narrow injected Host Connector port. The app renders enrollment, inventory count, online, reconnecting, offline, paused, and revoked state. Electron and Host Connector own keys, credentials, browser launch, inventory reconciliation, tunnel lifecycle, and IPC validation. Per-workspace menus may open or copy an already-published workspace link but do not grant access.
- Reduce `@claxedo/app` exports to stable public app/composition contracts and intentional shared components; cloud-app receives no private alias into app source.

**Patterns to follow:**

- `packages/claxedo-app/src/app/integrations/registry.ts`
- `packages/claxedo-app/src/features/extensions/data/index.ts`
- `packages/claxedo-app/src/architecture/ownership.guard.test.ts`
- `packages/claxedo-app/src/platform/runtime/platform-provider.tsx`

**Test scenarios:**

- **Happy path:** local composition renders home, local sessions, terminal, provider/config, settings, and diagnostics without a hosted contribution registration.
- **Happy path:** one hosted contribution registration adds its routes/surfaces/providers exactly once before render.
- **Edge case:** persisted WorkGraph/Document surface metadata is handled by Unit 2's unavailable-feature pruning while local session and terminal metadata remains.
- **Edge case:** a direct `@claxedo/app` consumer that registers no hosted contributions receives deterministic local defaults.
- **Error path:** duplicate/conflicting contribution IDs fail deterministically instead of last-writer-wins shadowing.
- **Error path:** an unknown hosted destination key or non-HTTPS configured destination is refused.
- **Error path:** Enable Remote Access is unavailable when the Host Connector port is absent; a per-workspace remote link is unavailable until that workspace has a canonical local ID and has appeared in the accepted machine inventory. Local work remains usable.
- **Edge case:** machine Remote Access shows zero, one, and many published workspaces from connector status and explains that new local workspaces will be included automatically.
- **Integration:** the local app production entry builds and renders without loading Clerk, WorkGraph, Documents, or cloud runtime modules; injected entry-graph imports into them fail the guard.

**Verification:** `@claxedo/app` has a local-only production entry graph and a bounded public composition surface. Unit 9 completes the physical source and manifest extraction before any desktop consumer rewires.

- [ ] **Unit 9: Create `@claxedo/cloud-app` and move hosted renderer ownership**

**Goal:** Create the hosted browser product package, move hosted identity and feature implementations into it, and compose the shared app through public contracts.

**Requirements:** U8-R4, U8-R7, U8-R8, U8-R11, U8-R14, U8-R15, U8-R17, U8-R18, U8-R20, U8-R21, U8-R22, U8-R23

**Dependencies:** Units 2, 6, and 8

**Files:**

- Create: `packages/claxedo-cloud-app/package.json`
- Create: `packages/claxedo-cloud-app/tsconfig.json`
- Move: `packages/claxedo-app/index.html` to `packages/claxedo-cloud-app/index.html`
- Move: `packages/claxedo-app/vite.cloud.config.ts` to `packages/claxedo-cloud-app/vite.config.ts`
- Move and adapt composition imports: `packages/claxedo-app/src/app/entry/main.tsx` to `packages/claxedo-cloud-app/src/entry/main.tsx`
- Move: `packages/claxedo-app/src/app/routes/host-enrollment.tsx` to `packages/claxedo-cloud-app/src/routes/host-enrollment.tsx`
- Move: `packages/claxedo-app/src/app/routes/host-enrollment.vitest.tsx` to `packages/claxedo-cloud-app/src/routes/host-enrollment.vitest.tsx`
- Create: `packages/claxedo-cloud-app/src/composition/hosted-contributions.ts`
- Create: `packages/claxedo-cloud-app/src/composition/hosted-contributions.test.ts`
- Move: `packages/claxedo-app/src/platform/auth` to `packages/claxedo-cloud-app/src/platform/auth`
- Move: `packages/claxedo-app/src/platform/runtime/cloud` to `packages/claxedo-cloud-app/src/platform/runtime/cloud`
- Move: `packages/claxedo-app/src/features/workgraph` to `packages/claxedo-cloud-app/src/features/workgraph`
- Move: `packages/claxedo-app/src/features/documents` to `packages/claxedo-cloud-app/src/features/documents`
- Move the hosted onboarding modules and adjacent tests from `packages/claxedo-app/src/features/onboarding`: `cloud-credentials-*`, `code-host-*`, `credential-sharing*`, `project-remote-*`, and `sandbox-provider-*`. Keep the dependency-light machine Remote Access controller/state/surface in app; cloud-app owns only the signed approval and management pages.
- Split `packages/claxedo-app/src/features/onboarding/ai-connect-*` at its existing `scope: "local" | "shared"` boundary: retain local discovery/save/verification and UI in app; register shared-account credential behavior from cloud-app through the onboarding app port
- Move the hosted settings modules and adjacent tests from `packages/claxedo-app/src/features/settings/ui`: `account-section.tsx`, `connections*`, `sandbox-driver-logo.tsx`, and `sandbox-section*`
- Move the hosted workspace modules and adjacent tests from `packages/claxedo-app/src/features/workspaces`: `data/share-workspace*`, `data/workspace-connection*`, `ui/cloud-auto-switch.tsx`, `ui/dialogs/create-cloud-project*`, `ui/dialogs/provider-facts*`, `ui/dialogs/provision-failure*`, and `ui/dialogs/repository-picker*`
- Move hosted entry assets from: `packages/claxedo-app/public`
- Create: `packages/claxedo-cloud-app/playwright.config.ts`
- Move: `packages/claxedo-app/e2e/playwright/web-signed-cloud.spec.ts` to `packages/claxedo-cloud-app/e2e/playwright/web-signed-cloud.spec.ts`
- Move: `packages/claxedo-app/e2e/playwright/web-signed-userhosted.spec.ts` to `packages/claxedo-cloud-app/e2e/playwright/web-signed-userhosted.spec.ts`
- Move and adapt package expectations: `packages/claxedo-app/src/architecture/cloud-product-entry.guard.test.ts` to `packages/claxedo-cloud-app/src/architecture/package-boundary.guard.test.ts`
- Modify: `packages/claxedo-app/package.json`
- Modify: `packages/claxedo-app/src/architecture/local-product-boundary.guard.test.ts`

**Approach:**

- Move the hosted browser entry, build config, hosted public assets, Clerk implementation, hosted routes, and Unit 2 feature entrypoints into cloud-app.
- Keep onboarding destination/funnel/local AI connection, general/keybind/provider/terminal/network settings, local workspace scope/actions/recovery, and shared dependency-neutral UI in app. Where a moved hosted module currently imports one of those internals, export the smallest dependency-neutral contract through `@claxedo/app` and replace the alias import; do not copy the implementation.
- Depend on `@claxedo/app` through exported composition contracts. Cloud-app owns all `@/` aliases within its own source; shared app imports use the package name.
- Register hosted contributions synchronously before shared app render; expensive hosted surface implementations remain behind the lazy boundaries established by Unit 2.
- Preserve hosted browser URLs and deployment environment names so existing bookmarks, auth redirects, and control-plane endpoints remain valid.
- Keep cloud-app's package manifest explicit about Clerk, WorkGraph, hosted API/client dependencies, and its build/deploy tooling.
- Move the temporary host-enrollment approval route from app into cloud-app and register it as a hosted identity route. It resumes the signed browser journey, names the requesting host, clearly states that approval covers all current and future local workspaces on that machine, and returns approval/denial only to Hosted Server's authority state.
- Remove those hosted dependencies and the temporary hosted build script from app's manifest after the final hosted file moves. Run app typecheck/build and its boundary guard again with cloud-app's source excluded before Unit 9 completes.
- Relocate web-only E2E configuration/fixtures when their ownership is entirely hosted; keep genuinely shared browser harness code in the shared app package.
- Preserve the existing signed user-hosted client sequence as moved code: call Hosted Server for `/:id/connection`, construct Relay HTTP/WebSocket URLs in `workspace-relay-connection.ts`, send the Runtime Access Token only to Relay, and refresh through Hosted Server before expiry or after a Relay 401. The hosted connection descriptor continues to omit `directRuntimeUrl`.

**Patterns to follow:**

- `packages/claxedo-app/src/app/entry/main.tsx`
- `packages/claxedo-app/vite.cloud.config.ts`
- `packages/claxedo-app/src/features/extensions/data/app.tsx`
- `packages/claxedo-app/src/features/extensions/data/server.tsx`

**Test scenarios:**

- **Happy path:** cloud-app anonymous launch renders the login journey and initializes Clerk once.
- **Happy path:** signed launch registers hosted routes/surfaces and completes cloud workspace, WorkGraph, Documents, connections, and hosted session flows.
- **Happy path:** a signed user opens the enrollment URL, sees the requesting host and machine-wide scope, approves it once, and all reconciled workspaces become visible under that host. The machine shows aggregate status while each workspace reflects its actual Relay presence, including partial Cloudflare room recovery.
- **Edge case:** hosted feature chunks load on first use without changing contribution identity or route ownership.
- **Edge case:** browser refresh on `/login`, `/cli-login`, `/s/:sessionId`, and hosted workspace routes resolves through the hosted entry.
- **Error path:** missing Clerk/hosted configuration produces the existing explicit hosted configuration state rather than a local-mode fallback.
- **Error path:** expired, already-approved, revoked, wrong-user, or malformed enrollment state renders a terminal hosted error and cannot mutate host/workspace authority.
- **Error path:** cloud-app source graph rejects Electron, desktop preload, and local-server imports.
- **Integration:** the production hosted build serves against `@claxedo/server` and passes the existing signed cloud and user-hosted browser suites. The user-hosted suite asserts one control-plane connection mint followed by Runtime HTTP/SSE/WebSocket calls to Workspace Relay, with no direct laptop request.

**Verification:** `@claxedo/cloud-app` builds and deploys the hosted UI; `@claxedo/app`'s manifest and source now form the complete local/shared closure, and excluding cloud-app source leaves the app and desktop renderer buildable.

### Phase C — Rewire and enforce delivery

- [ ] **Unit 10: Rewire desktop to the local package and optional Host Connector contracts**

**Goal:** Point desktop development, production build preparation, renderer boot, local-server startup, and optional linked-host startup at the separated package contracts.

**Requirements:** U8-R6, U8-R7, U8-R9, U8-R10, U8-R13, U8-R15, U8-R16, U8-R17, U8-R18, U8-R19, U8-R20, U8-R21, U8-R22, U8-R23

**Dependencies:** Units 5, 6, and 9

**Files:**

- Modify: `packages/claxedo-desktop/package.json`
- Modify: `packages/claxedo-desktop/tsconfig.json`
- Modify: `packages/claxedo-desktop/vite.renderer.ts`
- Modify: `packages/claxedo-desktop/src/renderer/index.tsx`
- Modify: `packages/claxedo-desktop/scripts/claxedo-server-entry.ts`
- Modify: `packages/claxedo-desktop/scripts/prebuild.ts`
- Modify: `packages/claxedo-desktop/scripts/bundle-claxedo-server.ts`
- Modify: `packages/claxedo-desktop/electron.vite.config.ts`
- Modify: `packages/claxedo-desktop/electron-builder.config.ts`
- Modify: `packages/claxedo-desktop/scripts/package.ts`
- Modify: `packages/claxedo-desktop/scripts/contract.ts`
- Modify: `packages/claxedo-desktop/scripts/claxedo-server-boot.test.ts`
- Modify: `packages/claxedo-desktop/scripts/host-connector-entry.ts`
- Modify: `packages/claxedo-desktop/scripts/bundle-host-connector.ts`
- Modify: `packages/claxedo-desktop/scripts/host-connector-boot.test.ts`
- Modify: `packages/claxedo-desktop/src/main/index.ts`
- Modify: `packages/claxedo-desktop/src/main/host-connector.ts`
- Modify: `packages/claxedo-desktop/src/main/host-connector.test.ts`
- Modify: `packages/claxedo-desktop/src/main/host-connector-credentials.ts`
- Modify: `packages/claxedo-desktop/src/main/host-connector-credentials.test.ts`
- Modify: `packages/claxedo-desktop/src/main/ipc.ts`
- Modify: `packages/claxedo-desktop/src/preload/index.ts`
- Modify: `packages/claxedo-desktop/src/preload/types.ts`
- Modify: `packages/claxedo-desktop/src/main/navigation-guard.ts`
- Modify: `packages/claxedo-desktop/src/main/navigation-guard.test.ts`
- Move and adapt product expectations: `packages/claxedo-app/e2e/playwright/desktop-signed-embedded-shared.spec.ts` to `packages/claxedo-app/e2e/playwright/desktop-linked-userhosted.spec.ts`
- Move and adapt product expectations: `packages/claxedo-app/e2e/playwright/desktop-signed-cloud.spec.ts` to `packages/claxedo-app/e2e/playwright/desktop-hosted-browser-handoff.spec.ts`
- Modify: `.github/workflows/release-claxedo.yml`

**Approach:**

- Replace the source-relative server import with the local-server package entry and change the bundle helper's migration/data asset ownership to local-server.
- Make predev, prebuild, production build, and server boot smoke resolve the same local-server package entry. Contract fingerprint inputs follow the new package source and manifest.
- Boot the renderer through the local app entry. Remove desktop build-time Clerk/auth/cloud-control-plane variables and the auth token provider from renderer composition.
- Implement hosted-product buttons as named external destinations. The renderer sends the resolved fixed HTTPS URL through the existing IPC boundary; Electron keeps general untrusted links scheme-gated and applies the stricter named-host rule to product destinations.
- Bind the app's Host Connector port through typed preload/IPC methods for begin-machine-enrollment, status, pause, resume, revoke, and open-workspace-link. Electron owns the system-browser approval launch; the renderer never supplies an inventory or local target.
- Supervise Host Connector as a separate utility child. Base unsigned launch does not resolve or spawn its bundle. An active durable machine enrollment starts it after local-server health even when inventory is empty, gives it a fresh private local-server connector credential through a non-argument bootstrap channel, and restarts it under the bounded child policy. Pause/revoke/shutdown closes it and every Bun or Cloudflare tunnel handle it owns.
- Persist the host private key as an Electron-safeStorage-encrypted record under the existing desktop profile root and keep the host ID and grant generation as nonsecret metadata. The authoritative workspace set is reread from local-server rather than persisted as enrollment truth. Decrypt the key only for the connector's private bootstrap channel; short-lived host/tunnel tokens remain in connector memory, while logs, diagnostics, renderer IPC, crash metadata, and process arguments receive redacted identity/status fields only.
- Show linked-host state as machine Remote Access with current published-workspace count and Online/Reconnecting/Offline/Paused/Revoked status rather than as a signed-in Electron account. Account/profile UI continues to open cloud-app.
- Preserve default local server URL, renderer origin policy, diagnostics contract, profile paths, native modules, and parent/child ownership.
- Make electron-builder consume the local-server/app/host-connector boundary manifests and package only their declared structural resources. Host Connector remains a separately fingerprinted optional child and is not imported by the renderer or local-server entry. Unit 11 validates the resulting inventory and unsigned launch; U9 may trim the allowlist further only with the same contract green.

**Patterns to follow:**

- `packages/claxedo-desktop/scripts/contract.ts`
- `packages/claxedo-desktop/src/main/navigation-guard.ts`
- `packages/claxedo-desktop/scripts/claxedo-server-boot.test.ts`

**Test scenarios:**

- **Happy path:** development and production-build desktop launch the same local-server entry and reach renderer/route/PTY readiness.
- **Happy path:** Sign in, Account, WorkGraph, Documents, Billing, and Create Cloud Workspace open their exact fixed HTTPS routes in the system browser.
- **Happy path:** Enable Remote Access starts the optional connector, opens the exact machine-enrollment approval URL, and changes from awaiting approval to online with the complete published-workspace count after reconciliation and Relay registration.
- **Happy path:** the former signed-desktop cloud lane now proves native Sign in/Create Cloud Workspace browser handoff and completes cloud creation/reconnect in cloud-app; the native renderer receives no account session or cloud runtime token.
- **Edge case:** existing profile/session/provider state appears after the entrypoint change.
- **Edge case:** local session/terminal workflows remain usable with cloud-app and server source unavailable.
- **Edge case:** a linked restart waits for local-server health, then starts one connector and restores the exact current inventory, including zero workspaces; an unlinked or paused profile starts none.
- **Error path:** a tampered product destination using HTTP, credentials, an unapproved host, or a privileged scheme is refused.
- **Error path:** a missing local-server build fails prebuild/boot with the local artifact named; no server fallback starts.
- **Error path:** connector crash, transient token failure, laptop wake, expired approval, or Relay outage updates Remote Access through reconnecting/offline and leaves local sessions/terminals usable; paused/revoked authorization becomes terminal and no account-auth or cloud-VM fallback starts.
- **Security:** renderer input cannot choose an arbitrary approval host, local target URL, workspace path, connector executable, or tunnel credential.
- **Integration:** desktop renderer and local-server build artifacts contain no Clerk, WorkGraph, Documents, remote sandbox, relay, or cloud control-plane chunks.
- **Integration:** the unsigned packaged macOS artifact starts the same local-server entry, reaches renderer/route/PTY readiness, and exits without launching a harness during empty-shell boot.

**Verification:** Desktop dev and production build use one local composition contract, have no account-auth runtime, and preserve the characterized local behavior from Unit 1.

- [ ] **Unit 11: Enforce all package closures and update hosted delivery paths**

**Goal:** Make the split durable in manifests, source graphs, emitted artifacts, CI/deployment workflows, and documentation references.

**Requirements:** U8-R1–U8-R23

**Dependencies:** Units 2–10

**Files:**

- Modify: `packages/claxedo-local-server/package.json`
- Create: `packages/claxedo-local-server/src/architecture/package-boundary.test.ts`
- Create: `packages/claxedo-local-server/scripts/check-build-boundary.ts`
- Create: `packages/claxedo-local-server/scripts/check-build-boundary.test.ts`
- Create: `packages/claxedo-local-server/scripts/verify-source-closure.ts`
- Create: `packages/claxedo-local-server/scripts/verify-source-closure.test.ts`
- Modify: `packages/claxedo-app/package.json`
- Modify: `packages/claxedo-app/src/architecture/local-product-boundary.guard.test.ts`
- Create: `packages/claxedo-app/scripts/check-local-build-boundary.ts`
- Create: `packages/claxedo-app/scripts/check-local-build-boundary.test.ts`
- Create: `packages/claxedo-app/scripts/verify-local-source-closure.ts`
- Create: `packages/claxedo-app/scripts/verify-local-source-closure.test.ts`
- Modify: `packages/claxedo-cloud-app/package.json`
- Modify: `packages/claxedo-cloud-app/src/architecture/package-boundary.guard.test.ts`
- Create: `packages/claxedo-cloud-app/scripts/check-build-boundary.ts`
- Create: `packages/claxedo-cloud-app/scripts/check-build-boundary.test.ts`
- Create: `packages/claxedo-cloud-app/scripts/verify-source-closure.ts`
- Create: `packages/claxedo-cloud-app/scripts/verify-source-closure.test.ts`
- Modify: `packages/claxedo-server/package.json`
- Modify: `packages/claxedo-server/src/deployments/hosted-workerd/worker.import-graph.test.ts`
- Create: `packages/claxedo-server/scripts/maintenance/check-hosted-build-boundary.ts`
- Create: `packages/claxedo-server/scripts/maintenance/check-hosted-build-boundary.test.ts`
- Create: `packages/claxedo-server/scripts/maintenance/verify-hosted-source-closure.ts`
- Create: `packages/claxedo-server/scripts/maintenance/verify-hosted-source-closure.test.ts`
- Modify: `packages/claxedo-host-connector/package.json`
- Create: `packages/claxedo-host-connector/src/architecture/package-boundary.test.ts`
- Create: `packages/claxedo-host-connector/scripts/check-build-boundary.ts`
- Create: `packages/claxedo-host-connector/scripts/check-build-boundary.test.ts`
- Create: `packages/claxedo-host-connector/scripts/verify-source-closure.ts`
- Create: `packages/claxedo-host-connector/scripts/verify-source-closure.test.ts`
- Modify: `packages/claxedo-desktop/scripts/contract.ts`
- Modify: `packages/claxedo-desktop/scripts/contract.test.ts`
- Modify: `packages/claxedo-desktop/package.json`
- Create: `packages/claxedo-desktop/scripts/check-packaged-product-boundary.ts`
- Create: `packages/claxedo-desktop/scripts/check-packaged-product-boundary.test.ts`
- Create: `packages/claxedo-desktop/scripts/u8-packaged-smoke.ts`
- Modify: `turbo.json`
- Modify: `.github/workflows/test.yml`
- Modify: `.github/workflows/typecheck.yml`
- Modify: `.github/workflows/deploy-claxedo-app.yml`
- Modify: `.github/workflows/deploy-claxedo-app-staging.yml`
- Modify: `.github/workflows/release-claxedo.yml`
- Modify: `packages/claxedo-web/src/content/deployment.ts`
- Modify: `packages/claxedo-web/test/deployment-prompt-drift.test.ts`
- Modify: `packages/claxedo-web/src/content/claims.ts`
- Modify: `docs/plans/README.md`

**Approach:**

- Validate each manifest against its package role and walk each production entry's transitive value-import graph. Report the shortest cross-product path.
- Cover static imports, re-exports, side-effect imports, and string-literal dynamic imports; treat type-only imports according to emitted runtime behavior.
- Consume each runtime's build-tool module/chunk metadata to generate normalized JSON manifests with `entry`, sorted `modules`, sorted `chunks`, and sorted static/dynamic `edges` fields for app, local-server, cloud-app, server's Node/workerd formats, and Host Connector. Scan module IDs and output chunks, not minified text alone.
- Assert representative hosted packages and source roots are absent from local outputs, and representative local/Electron roots are absent from cloud-app/server outputs.
- Assert Host Connector reaches only its enrollment client, host identity/credential storage, Workspace Runtime relay/protocol contracts, and outbound transport. Reject account auth SDKs, sandbox-manager, server implementation, app implementation, and local-server implementation imports.
- Exercise build independence with the five product/companion source-closure verifiers. Each script resolves the allowlisted transitive workspace packages from its product manifest and materializes a temporary workspace. It copies root toolchain files and every workspace manifest needed by the frozen lockfile, but copies source/build inputs only for allowlisted packages; excluded product packages are manifest-only stubs with no exports or source. It performs a frozen, scripts-disabled install, runs the product build and entry smoke, and always removes the temporary workspace. A hidden source-relative, alias, or undeclared workspace edge therefore has no source target and fails by construction.
- Change hosted Pages workflows, performance targets, source-map upload paths, and deployment documentation from `packages/claxedo-app` to `packages/claxedo-cloud-app` where they describe the hosted web product.
- Add the new packages to typecheck/test/build filters and retain the existing ordering constraints for heavyweight runtime suites.
- Feed U8 emitted manifests into the desktop build contract so U9 can inspect the final packaged resource inventory without inventing a second boundary definition.
- Add `verify:u8-package-boundary` to desktop. It creates the unsigned macOS artifact through the normal package script, inventories its app resources, validates every bundled module/native asset/sidecar against the local boundary manifests and explicit Electron allowlist, runs `u8-packaged-smoke.ts`, and retains the machine-readable result for U9.

**Patterns to follow:**

- `packages/claxedo-server/src/deployments/hosted-workerd/worker.import-graph.test.ts`
- `packages/claxedo-app/src/architecture/import-graph.ts`
- `packages/claxedo-app/scripts/check-forbidden-eager-deps.ts`
- `packages/claxedo-desktop/scripts/contract.ts`
- `packages/claxedo-web/test/deployment-prompt-drift.test.ts`

**Test scenarios:**

- **Happy path:** each of the four product packages plus Host Connector passes manifest, source-graph, emitted-manifest, and entry smoke checks.
- **Happy path:** hosted deploy workflows build cloud-app and server from their new package paths; desktop release builds app and local-server.
- **Edge case:** dynamic hosted feature chunks appear only in cloud-app's emitted manifest and remain absent from local app.
- **Edge case:** Host Connector is present as a separately fingerprinted packaged resource but absent from the unsigned renderer/local-server import graphs and process inventory.
- **Edge case:** type-only shared contracts remain allowed when the emitted runtime graph stays clean.
- **Error path:** a barrel re-export, alias, dynamic import, or manifest dependency that crosses the product boundary fails with an actionable chain.
- **Error path:** an emitted chunk containing a representative hosted module fails even when the source scanner was bypassed by build configuration.
- **Integration:** local app/local-server build with hosted sources unavailable; cloud-app/server build with desktop/local-server sources unavailable; both product smoke suites pass.
- **Integration:** `verify:u8-package-boundary` proves the packaged macOS artifact uses the same fingerprinted local entries as development/build and contains no hosted product resources.

**Verification:** CI treats package ownership as a required contract, deployment workflows point at the owning packages, and the artifacts passed to U9 carry deterministic boundary manifests.

## Integration Sequence

Execute the implementation in this order:

1. Unit 1 records the current local, linked-host, and cloud product contracts so later moves can be checked against known behavior.
2. Unit 2 separates hosted WorkGraph and Documents contributions from the unsigned composition.
3. Unit 3 completes harness lifecycle ownership in Workspace Runtime.
4. Unit 4 makes Workspace Runtime the canonical owner of local session inventory and events.
5. Unit 5 extracts local-server and immediately makes desktop use it.
6. Unit 6 extracts Host Connector, adds browser approval, and makes it the canonical local-workspace sharing path.
7. Unit 7 removes the old local composition from server, leaving server hosted-only.
8. Unit 8 establishes the local app entry and the public composition contract needed by cloud-app.
9. Unit 9 moves hosted browser identity and features into cloud-app.
10. Unit 10 points the final desktop development, build, packaging, and optional Host Connector paths at the separated packages.
11. Unit 11 enables the closure guards, CI paths, deployment paths, and packaged-resource checks.
12. U9 then consumes the resulting artifacts for memory and performance qualification.

Each producer moves before its old entry is deleted, and every unit leaves one canonical path.

## Execution and Verification Protocol

Execute units in dependency order and keep the current unit's package checks green before beginning a dependent unit. All four product manifests plus Host Connector must expose `typecheck`, `test`, and `verify:closure`; app, cloud-app, local-server, and Host Connector also expose `build`. Server's `verify:closure` performs both the hosted Node entry build/smoke and workerd's existing worker-safe build because those runtimes do not share one emitted format. Unit 11 wires every `verify:closure` to its source-closure and emitted-boundary checks.

Run commands from the named package directory, never from the repository root:

| Gate | Working directory | Required command |
|---|---|---|
| Runtime authority after Units 3–4 | `packages/workspace-runtime` | `bun typecheck && bun test && bun run build` |
| Harness lifecycle after Unit 3 | `packages/agent-sdk-runtime` | `bun typecheck && bun test && bun run build` |
| Local server after Units 5 and 11 | `packages/claxedo-local-server` | `bun typecheck && bun test && bun run build && bun run verify:closure` |
| Host enrollment/tunnel after Units 6 and 11 | `packages/claxedo-host-connector` | `bun typecheck && bun test && bun run build && bun run verify:closure` |
| Hosted server after Units 2, 6, 7, and 11 | `packages/claxedo-server` | `bun typecheck && bun test && bun run check:worker-safe && bun run verify:closure` |
| Local/shared app after Units 2, 8, and 11 | `packages/claxedo-app` | `bun typecheck && bun test && bun run build && bun run verify:closure` |
| Hosted browser after Units 6, 9, and 11 | `packages/claxedo-cloud-app` | `bun typecheck && bun test && bun run build && bun run verify:closure` |
| Desktop integration after Unit 10 | `packages/claxedo-desktop` | `bun typecheck && bun test && bun run test:contract && bun run build` |
| Structural package acceptance after Unit 11 | `packages/claxedo-desktop` | `bun run verify:u8-package-boundary` |

The final U8 handoff consists of the green command record, normalized boundary manifests for all four product packages plus Host Connector, source-closure fixture logs, the existing-profile upgrade fixture result, and unsigned-local, linked-user-hosted, and signed-cloud product smoke results. Store generated evidence under each package's ignored `.artifacts/u8-package-split/` directory; commit the tests and normalizers, not generated build output.

## System-Wide Impact

- **Interaction graph:** Electron renderer → local app; Electron sidecar → local-server → Workspace Runtime → selected harness adapter. For an enrolled machine, Host Connector reads the full local-server inventory and publishes it through Bun's multi-workspace host registration or Cloudflare's per-workspace room tunnels. A signed client uses Hosted Server for list and connection-token mint/refresh, then sends Runtime traffic to Workspace Relay → Host Connector → local-server → Workspace Runtime. Relay separately uses its authenticated target/revocation resolver against Hosted Server. Electron controls connector lifecycle but carries no remote runtime traffic. System browser → cloud-app → server → hosted services/sandbox VMs.
- **Entry points:** desktop dev/build/prebuild, local-server main/create-app, cloud-app Vite entry, hosted Node, hosted workerd, Pages deploy, desktop release, performance targets, and source-map paths all change ownership.
- **Error propagation:** missing local owners fail at local build/start; Host Connector enrollment/tunnel failures produce sharing status while local execution remains usable; hosted configuration/provisioning failures stay in hosted flows; external-link validation fails closed before Electron calls the OS.
- **State lifecycle:** package paths do not determine persistent data paths. Existing profile, Workspace Runtime, provider, credential, and session stores stay canonical; Unit 2 prunes only unavailable hosted surfaces.
- **Linked-host lifecycle:** one durable machine enrollment is bound to a local host key and authorizes publication of the machine's complete current and future local-workspace inventory. Full-set reconciliation materializes per-workspace links; approval, inventory changes, renewal, pause, revocation, presence expiry, connector restart, and reconnect never change the underlying local workspace/session identity.
- **API parity:** approved local HTTP/SSE shapes, hosted connection response, Runtime Access Token/Host Tunnel Token/Relay Host Token claims, Relay paths and frames, and existing hosted route shapes remain stable. Host-enrollment and registration-mode fields are additive, and the old mixed local account-link route retires only after the new connector path is canonical. Public TypeScript exports change intentionally so cloud-app consumes the app contract and desktop consumes the local app contract.
- **Build graph:** local-server, cloud-app, and Host Connector enter Turbo, CI filters, release inputs, and the lockfile. Hosted web build responsibility moves from claxedo-app to claxedo-cloud-app.
- **Security boundary:** desktop loses hosted account credentials and embedded auth dependencies. Named hosted links are fixed HTTPS destinations; hosted authentication remains in browser/server; Host Connector holds one machine-scoped inventory-publishing enrollment and short-lived credentials scoped to the exact reconciled workspace set.
- **Operational boundary:** hosted deployment variables stay with cloud-app/server. Desktop release stops baking Clerk/Convex/control-plane account configuration into its renderer.
- **Integration coverage:** source closure, emitted closure, real entrypoint smoke, signed hosted browser flows, unsigned desktop flows, browser-approved machine access, full-inventory add/remove reconciliation, tunnel/client reconnect, signed cloud-VM access, existing-profile upgrade, PTY, and harness lifecycle together prove the split.
- **Cross-client parity:** web/mobile-shaped signed clients use the same Hosted Server connection mint, reconnect state, cursored Runtime events, and Runtime Protocol for user-hosted and cloud workspaces; only the runtime target behind Relay differs.

## Risks and Controls

| Risk | Impact | Control |
|---|---|---|
| A shared barrel pulls hosted code back into app or local-server | Desktop memory and dependency closure regress silently | Public subpath exports plus shortest-path source graph and emitted module/chunk checks |
| Package move changes profile or migration paths | Existing local workspaces, sessions, providers, or credentials appear lost | Package-independent data-root functions and an existing-profile fixture opened through old and new entries |
| Cloud-app reaches app internals through aliases | The package boundary is nominal and cannot be published/built independently | Only public `@claxedo/app` exports resolve cross-package; boundary guard rejects relative/alias reach-through |
| Hosted features lose route/provider ordering | Login, WorkGraph, Documents, or cloud workspace flows fail after extraction | Synchronous contribution registration before render and signed hosted E2E coverage |
| Desktop hosted links become an external-launch vector | Crafted renderer input reaches privileged OS handlers or a phishing origin | Named destinations, HTTPS and host/path validation, existing scheme gate retained for general links |
| Host enrollment becomes an account-token backdoor | A stolen desktop record grants broad account access | Mint a distinct machine inventory-publishing credential, bind renewal to host-key proof and generation, and reject it on every non-enrollment/non-tunnel route |
| Host Connector forwards beyond the current Runtime inventory | A compromised Relay or connector reaches local secrets, a deleted workspace, or an unrelated local service | Per-launch loopback credential, current canonical inventory gate before every forward, Runtime route-ownership gate, and negative real-transport tests |
| An out-of-order inventory update resurrects a deleted workspace | A stale route becomes remotely reachable | Versioned, atomic full-set replacement under one machine generation; reject stale reconcile versions and workspace-ID reparenting |
| A failed inventory read looks like an empty machine | Every workspace is accidentally unshared | Make complete success, valid empty success, and read failure distinct; reconcile only a complete versioned snapshot and fail forwarding closed while inventory is unavailable |
| Tunnel or client reconnect repeats user intent | A prompt runs twice or an interactive resource is duplicated | Reconnect only transport; reacquire authorization, resume events by cursor or refetch, reattach resources by canonical ID, and never resubmit an admitted prompt |
| Many disconnected hosts reconnect together | Relay and authority services receive a reconnect storm | One supervised Host Connector per machine, the existing bounded exponential backoff/jitter and dead-socket detection per handle, a host-level cap on concurrent room reconnects, and fresh authorization at each attempt |
| Host Connector guesses the Relay registration topology | Bun replaces per-workspace sockets by host ID, or Cloudflare rejects a multi-workspace socket | Hosted Server returns an explicit `machine-multiplexed` or `workspace-room` assignment; connector tests run against both existing Relay fixtures |
| A Bun registration update reconnects with its original workspace URL | A deleted workspace can briefly reappear in Relay presence after a socket loss | Make the normalized set accepted by `updateRegistration` authoritative for the next upgrade URL and token scope; force `[A, B]` to `[A]` through reconnect in the canonical tunnel test |
| Revocation behavior drifts during extraction | A removed share accepts new connections or the plan accidentally changes established-socket semantics | Characterize the existing Host Tunnel Token, Runtime Access Token, Relay Host Token, target/revocation resolver, presence, and long-lived socket contracts before moving code; pause/revoke closes the supervised connector and blocks new/refresh access |
| Users expect shared-local availability while the laptop is asleep | Remote work appears unreliable or silently changes compute | Explicit user-hosted/offline status; laptop requirement in approval UI; no cloud fallback or working-tree copy |
| `@claxedo/server` retains local compatibility entrypoints | Two local producers drift and desktop can regress to the large graph | Move producer once, rewire consumers in the same slice, delete obsolete local entry before unit completion |
| Source scan misses bundler-injected or dynamic code | Clean architecture test but contaminated output | Build metadata manifest and emitted chunk/module gate |
| Cloud app extraction duplicates shared UI or state | Divergent shell behavior and two sources of truth | Cloud-app composes shared app; shared contracts stay in app, hosted implementations move once |
| U8 and U9 duplicate artifact logic | Two guards drift and produce contradictory release results | U8 emits one deterministic boundary manifest; U9 consumes it for packaged inventory |
| CI resource ordering changes with three new packages | Heavy tests contend and become flaky | Preserve explicit Turbo ordering for server/app/runtime suites and add package-scoped jobs deliberately |
| Hosted static SPA serving is lost for supported hosted Node deployments | Self-operated signed deployments lose their web UI | Move static cloud-app serving to hosted Node ownership and cover it in hosted integration tests |

## Success Metrics

- Four product packages plus Host Connector have manifests and transitive runtime graphs matching the package dependency rules.
- `@claxedo/local-server` and `@claxedo/app` build and smoke with hosted source trees unavailable.
- `@claxedo/server` and `@claxedo/cloud-app` build and pass hosted integration flows with desktop/local-server source trees unavailable.
- Desktop unsigned boot passes health, renderer, local route, PTY, session inventory, explicit harness, and shutdown gates through local-server.
- Desktop account/hosted affordances open only the intended fixed HTTPS destinations and create no local account session.
- One browser approval creates a machine-scoped enrollment; a two-workspace laptop publishes both, a newly created third workspace appears without another approval, and deleting one removes only that workspace's hosted link and route.
- The enrolling account can list and open every current and future reconciled workspace; collaborators see only workspaces with an explicit role, and those roles survive inventory reconciliation.
- After laptop sleep, network loss, Relay restart, or connector restart, Host Connector reacquires authorization, reconciles a fresh complete inventory, and restores exactly the accepted workspace set through Bun registration replacement or Cloudflare room-handle reconciliation.
- After a Bun live registration removes a workspace, the next forced reconnect upgrades and re-registers without that workspace; a Cloudflare room loss changes only that workspace's availability while healthy rooms remain reachable.
- A user-hosted client receives no direct Runtime URL or laptop address: Hosted Server handles list/mint/refresh, Runtime HTTP/SSE/WebSocket traffic goes to Workspace Relay, and Relay's authenticated target/revocation resolver consults Hosted Server without proxying Runtime bodies through it.
- Existing Relay security contract tests remain green for token claim binding, token revocation, role/path gates, active-host presence, origin checks, dangerous-header and cookie stripping, Relay Host Token verification, route ownership, limits, and audits; the package split adds no new Relay protocol frame or public data-path route.
- A disconnected signed client shows reconnecting, reacquires runtime access, resumes Runtime events from its cursor or refetches after a replay gap, reattaches supported resources by ID, and never duplicates prompt admission.
- Paused, revoked, sleeping, closed, or disconnected machines render all of their local workspaces paused/offline together and never create a cloud fallback.
- Signed cloud workspace creation provisions hosted compute that remains reachable from authorized clients after the originating laptop closes.
- Unsigned local mode exposes Cloud Workspace as a hosted browser destination and contains no sandbox-manager or VM lifecycle path.
- Existing fixture profiles retain workspace, session, provider, credential, and harness-selection state.
- Local emitted manifests contain no hosted auth, WorkGraph, Documents, remote sandbox, relay, or cloud control-plane modules/chunks.
- Hosted emitted manifests contain no Electron main/preload or local-server composition modules.
- The unsigned packaged macOS artifact uses the fingerprinted local entries, passes the resource allowlist, and completes the structural launch smoke.
- U9 receives deterministic source/build/package boundary manifests and can focus on resource trimming, harness cohorts, memory, and performance.

## Definition of Done

- `packages/claxedo-local-server` exists as the sole desktop-local server composition and depends directly on Workspace Runtime and selected local adapters.
- `packages/claxedo-server` exposes hosted Node and workerd compositions and no desktop/local start entry.
- `packages/claxedo-app` is the local/shared app package and has no hosted implementation dependency.
- `packages/claxedo-cloud-app` owns hosted identity, browser entry, hosted routes, and hosted feature implementations.
- `packages/claxedo-host-connector` owns machine enrollment, identity proof, full local-inventory reconciliation, presence, renewal, reconnect, and supervision of the existing Bun multi-workspace or Cloudflare workspace-room host tunnels; unsigned/unlinked empty-shell launch does not start or import it, while Enable Remote Access starts it for enrollment.
- Desktop development, production build, and server smoke use `@claxedo/local-server`; renderer boot uses the local `@claxedo/app` composition.
- Hosted Pages/development uses `@claxedo/cloud-app`; hosted Node/workerd uses `@claxedo/server`.
- Desktop sign-in and cloud-product affordances open fixed HTTPS browser routes; account tokens remain hosted.
- Enabling Remote Access uses signed browser approval and returns one revocable machine enrollment covering all current and future canonical local workspaces; per-workspace roles still decide which signed users may open each workspace.
- Host and signed-client reconnection satisfy U8-R20 and U8-R21: fresh authorization, fresh full-inventory reconciliation, restoration of the configured existing Relay registration mode, cursor resume or authoritative refetch, resource reattachment by ID, and no prompt resubmission caused by transport loss.
- Signed user-hosted access satisfies U8-R22 and U8-R23: Hosted Server remains the identity/mint/resolver authority; Workspace Relay remains the Runtime data path; the user-hosted connection descriptor exposes no direct laptop target; existing Relay and Workspace Runtime token, role, header, presence, limit, and audit gates retain their characterized behavior.
- Cloud workspace creation runs through cloud-app/server/sandbox-manager, remains accessible without the laptop, and shares the hosted Client/Protocol connection contract with user-hosted workspaces.
- Existing local profiles and durable state open through the new entry with unchanged identity and paths.
- Manifest, transitive source graph, emitted module/chunk manifest, and entry smoke gates pass for both product compositions—the four product packages—and Host Connector, and fail on injected cross-product edges.
- Hosted auth, cloud workspace, remote sandbox, relay, WorkGraph, Documents, billing, connections, channels, and wakes retain their current integration coverage.
- The structural packaged-resource inventory and unsigned macOS launch smoke use the same local entries as development and production build.
- U9 can consume the U8 boundary manifests for resource trimming and performance qualification.

## Documentation and Operational Notes

- Roll out machine remote access in producer-first order: deploy additive `host_enrollments`, versioned full-inventory reconciliation, both authority adapters, and the Relay-assignment registration-mode field; deploy Hosted Server enrollment/token routes; deploy cloud-app approval/management UI and the desktop release containing Host Connector; verify Bun multi-workspace and Cloudflare workspace-room inventory add/remove and reconnect telemetry; then remove the mixed desktop-local producer. Workspace Relay's established token and tunnel protocols remain compatible throughout, and existing signed clients and user-hosted links continue on their current route shapes during the overlap.
- Update deploy-unit documentation and CI path assertions from `packages/claxedo-app` to `packages/claxedo-cloud-app` only where they describe the hosted web product.
- Document the two-product/one-runtime plus optional Host Connector mental model in the app, cloud-app, local-server, host-connector, desktop, and server READMEs.
- Document that one machine approval covers all current and future canonical local workspaces, that machine-wide failures affect all of them, that Cloudflare room failures can affect one workspace independently, and that per-workspace roles still govern signed-client access.
- Add troubleshooting for laptop sleep, network loss, terminal pause/revoke states, automatic backoff, expected presence expiry, client cursor recovery, and the requirement that the laptop and desktop remain running for user-hosted access.
- Record the public app composition exports and their ownership rules in `packages/claxedo-app/src/ARCHITECTURE.md`.
- Keep environment variables with their owning product: hosted auth/control-plane variables in cloud-app/server; local profile, provider, credential, harness, and telemetry variables in app/local-server/desktop; enrollment endpoint, Relay assignment, and connector lifecycle variables in Host Connector/desktop without account tokens.
- Preserve stable hosted URLs, local ports, profile directories, and control-plane route contracts during the package move.
- Treat the boundary manifests as build evidence and retain them with U9's packaged inventory and performance reports.

## Sources and References

- **Origin:** `docs/plans/2026-08-07-003-refactor-claxedo-idle-memory-plan.md`, U8 plus R24–R28 and KTD8–KTD9
- **Current local server:** `packages/claxedo-server/src/deployments/local/server.ts`
- **Current embedded runtime:** `packages/claxedo-server/src/deployments/local/embedded-workspace-runtime.ts`
- **Hosted composition:** `packages/claxedo-server/src/deployments/hosted-shared/hosted-app.ts`
- **Worker boundary pattern:** `packages/claxedo-server/src/deployments/hosted-workerd/worker.import-graph.test.ts`
- **Current app package entry:** `packages/claxedo-app/src/app/entry/index.tsx`
- **Current hosted web entry:** `packages/claxedo-app/src/app/entry/main.tsx`
- **Current shared provider tree:** `packages/claxedo-app/src/app/entry/app.tsx`
- **Current feature composition:** `packages/claxedo-app/src/app/integrations/feature-ports.ts`
- **App architecture:** `packages/claxedo-app/src/ARCHITECTURE.md`
- **App package vocabulary:** `packages/claxedo-app/src/VOCABULARY.md`
- **App import graph:** `packages/claxedo-app/src/architecture/import-graph.ts`
- **Desktop renderer entry:** `packages/claxedo-desktop/src/renderer/index.tsx`
- **Desktop server entry:** `packages/claxedo-desktop/scripts/claxedo-server-entry.ts`
- **Desktop build contract:** `packages/claxedo-desktop/scripts/contract.ts`
- **Desktop external navigation guard:** `packages/claxedo-desktop/src/main/navigation-guard.ts`
- **Hosted user-hosted routes:** `packages/claxedo-server/src/routes/hosted/workspace.ts`
- **Current machine remote-access orchestration:** `packages/claxedo-server/src/deployments/local/remote-access-service.ts`
- **Current user-hosted connection mint:** `packages/claxedo-server/src/connections/user-hosted-connection.ts`
- **Current Relay target/revocation authority channel:** `packages/claxedo-server/src/deployments/shared-routes/internal-relay.ts`
- **Current local host identity:** `packages/claxedo-server/src/workspace/local-host.ts`
- **Current user-hosted tunnel:** `packages/claxedo-server/src/user-hosted-tunnel.ts`
- **Canonical host-tunnel client and reconnect loop:** `packages/workspace-runtime/src/workspace-relay-host-tunnel.ts`
- **Canonical Relay token/security contract:** `packages/workspace-relay/src/auth.ts`, `packages/workspace-relay/src/server.ts`
- **Relay runtime topologies:** `packages/workspace-relay/src/bun.ts`, `packages/workspace-relay/src/cloudflare.ts`
- **Laptop Runtime Relay Host Token verification:** `packages/workspace-runtime/src/workspace-host-service-auth.ts`
- **Signed client connection and Relay routing:** `packages/claxedo-app/src/platform/runtime/agent/workspace-relay-connection.ts`, `packages/claxedo-app/src/platform/runtime/cloud/workspace-runtime-store.ts`, `packages/claxedo-app/src/features/workspaces/data/workspace-connection.ts`
- **Current local Runtime forwarding gate:** `packages/claxedo-server/src/workspace/runtime-dispatch/shared-workspace-endpoint.ts`
- **Device authorization pattern:** `packages/cli/src/auth/device-code.ts`, `packages/claxedo-server/src/routes/hosted/device-auth.ts`
- **Canonical active host-link authority:** `convex/localHostLinks.ts`, `packages/claxedo-server/src/authority/adapters/convex/workspace-authority/workspaces.ts`, `packages/claxedo-server/src/authority/adapters/sqlite/workspace-authority.ts`
- **Relay host-tunnel authorization and registration updates:** `packages/workspace-relay/src/bun.ts`, `packages/workspace-relay/src/cloudflare.ts`
- **User-hosted E2E:** `packages/claxedo-server/src/user-hosted-tunnel.e2e.test.ts`, `packages/claxedo-app/e2e/playwright/web-signed-userhosted.spec.ts`
- **Extracted package patterns:** `packages/sandbox-manager/package.json`, `packages/claxedo-connections/package.json`
- **Server organization and vocabulary:** `docs/plans/2026-08-02-001-refactor-claxedo-server-organization-plan.md`
