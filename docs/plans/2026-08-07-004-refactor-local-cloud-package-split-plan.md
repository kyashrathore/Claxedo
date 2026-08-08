---
title: "refactor: Split desktop-local and hosted Claxedo products"
type: refactor
status: active
date: 2026-08-07
origin: docs/plans/2026-08-07-003-refactor-claxedo-idle-memory-plan.md
origin_unit: U8
deepened: 2026-08-08
artifact_contract: ce-unified-plan/v1
artifact_readiness: implementation-ready
execution: code
independent_execution: true
---

# refactor: Split desktop-local and hosted Claxedo products

## Overview

This plan extracts U8 from the Claxedo idle-memory plan into an independently executable package-boundary refactor. It starts from current `dev` and moves the existing canonical composition and transport producers into product-owned packages while preserving their contracts. It includes every enabling change U8 requires from the parent plan: hosted/default-off WorkGraph and Documents composition, Workspace Runtime harness lifecycle ownership, and runtime-owned session inventory and canonical events. The desktop product then becomes the composition of `@claxedo/app`, `@claxedo/local-server`, `@claxedo/workspace-runtime`, optional harness adapters, and an optional `@claxedo/host-connector` built from the current remote-access service, local host identity, and Workspace Relay host-tunnel implementation. The hosted product becomes the composition of `@claxedo/cloud-app` and `@claxedo/server` over the same lower-level runtime contracts.

Although the origin document labels the package split U8, this standalone artifact is deliberately the complete U8 delivery program: it internalizes only the U5–U7 work that has not yet landed and without which the split cannot close. Those prerequisites remain separate Phase A units with their own acceptance gates; an implementer does not need to consult or first execute the origin plan. This broader boundary is intentional and is not permission to redesign the runtime, provisioning, Relay, or self-hosted products.

The split turns capability placement into a build property. The base local app/local-server build closes over local project, file, diff, PTY, process, session, provider, configuration, credential, and harness-dispatch code. Electron owns an optional account-auth adapter that loads only when the user signs in or restores a signed session. The separately packaged Host Connector closes over machine enrollment and outbound Relay transport. A hosted build closes over cloud authority, relay, remote sandboxes, WorkGraph, Documents, billing, hosted connections, channels, and wakes. Each package manifest states that ownership directly, and source-graph plus emitted-artifact checks enforce it.

This is structural prevention for the memory target. U8 receives no advance memory credit. For independent execution, this document includes the benchmark capture and final Release Qualification Gate needed before production promotion; the origin plan may consume the same evidence but is not an execution dependency.

## Why This Refactor Exists

The current code already has the important behavior: local execution, signed hosted features, user-hosted connection minting, Workspace Relay authorization, outbound host tunnels, and cloud sandboxes. The problem is composition. Desktop-local startup is rooted in `packages/claxedo-server/src/deployments/local`, renderer auth/hosted features share the app package, and `remote-access-service.ts` combines account-bearing control-plane auth with local inventory/tunnel orchestration. That makes product capabilities reachable from processes that do not need them and leaves ownership dependent on runtime convention rather than package/build contracts.

This refactor buys five concrete outcomes:

1. **A smaller enforceable unsigned baseline.** Local app and local-server cannot import hosted auth, sandbox, WorkGraph, Documents, billing, Relay client, or cloud-control-plane implementations. The release benchmark measures a stable package closure rather than chasing accidental eager imports.
2. **One desktop product that grows after sign-in.** Local work remains available immediately. Signing in activates hosted capabilities inside the same shell without moving local execution or forcing the browser to become the main desktop experience.
3. **A narrower credential boundary.** Account credentials live in Electron main. Machine publication moves to a host key and short-lived machine/tunnel credentials, so Host Connector, local-server, and renderer never need the account bearer.
4. **Durable cross-client workspace access.** One explicit enrollment publishes all current and future canonical local workspaces through the existing Relay path. Web, mobile, another desktop, and the signed local desktop use the same Hosted Server authorization and Runtime connection contracts.
5. **Clear local versus cloud availability.** Shared local workspaces use the real laptop working tree and are offline with the laptop. Cloud workspaces use hosted VMs and remain reachable after the laptop closes. The product never silently copies or changes compute placement.

The accepted costs are explicit. Signed desktop activation has an OAuth round trip and lazy-chunk startup cost. Existing remote-sharing links are intentionally not backward-compatible, so each previously linked machine must enroll once again after upgrade. The release contains optional account, hosted-contribution, and Host Connector resources even though unsigned startup does not execute them. Electron main gains a security-sensitive credential/IPC adapter, CI gains package-closure matrices, and remote local work still depends on both the laptop and Workspace Relay. User-hosted Runtime traffic retains the Relay hop instead of becoming direct-to-laptop because the Relay supplies the existing token, role, revocation, header, limit, audit, and target-hiding boundary. This plan's final qualification measures startup, memory, and interaction costs for unsigned and signed cohorts before release.

### What Is Worse Than the Current Solution

- The first release is disruptive for existing Remote Access users: old links and the plaintext host identity are deliberately discarded, and the owner must enroll the machine again. There is no compatibility window.
- Desktop sign-in adds a native security boundary that does not exist in the current browser-owned session: OAuth callback handling, OS-protected credential persistence, narrow IPC, logout/revocation retry, and three-platform release qualification all become Electron responsibilities.
- Adding a hosted feature now requires its browser and Electron adapters to satisfy the same named-operation manifest. That coordination is intentional but costs more than calling `authFetch` directly from any renderer module.
- Shared-local access is not made peer-to-peer. Runtime bytes still take the Workspace Relay hop, so Relay latency and availability remain in the path. This preserves the current authorization and target-hiding boundary.
- A laptop workspace still goes offline when the laptop sleeps, quits, loses network, or loses its connector. The split does not buy cloud durability for local working trees and never silently copies them to a VM.
- Signed desktop features are unavailable where Electron cannot provide protected credential storage. Unsigned local work still functions there.
- “Enable Remote Access for this machine” is intentionally broader than a single-workspace share because it includes future local workspaces. The explicit confirmation and per-workspace collaborator roles are therefore part of the product contract, not incidental copy.

## Mental Model

There are two products, one optional desktop companion, and one lower execution core:

- **Desktop product:** an unsigned-by-default Electron shell whose server is loopback-only and whose durable local execution authority is Workspace Runtime. The user may sign in without changing the local execution path; Electron main owns that optional account session.
- **Hosted product:** a signed browser and control-plane product whose server owns identity, cloud authority, and hosted capabilities.
- **Host Connector:** a separately packaged desktop companion formed by moving and narrowing the current remote-access, local-host identity, and user-hosted tunnel producers. After the signed desktop enrolls its host key once, it turns the machine's canonical local workspace inventory into existing user-hosted Relay targets using machine-scoped credentials.
- **Workspace Runtime:** the lower local workspace/session core used through explicit composition; Phase A completes its ownership of files, diffs, PTYs, processes, local session metadata, canonical events, and harness selection.

The package split follows product ownership rather than deployment technology. Hosted Node and hosted workerd remain two runtimes of `@claxedo/server`. The system browser performs OAuth, then returns the result to Electron; Electron main, not local-server or the renderer, owns the desktop account session.

## Product Launch and End-to-End Runtime Flows

This section describes the product after the split from a user's point of view. The central distinction is between **where identity lives** and **where compute runs**:

- A **local desktop** is unsigned by default. Its compute runs on the laptop and its local-server accepts no account credential.
- A **signed desktop** has an optional account session isolated in Electron main. OAuth runs in the system browser and returns through the registered desktop callback; the renderer receives account state and typed operations but no bearer or refresh token.
- A **linked desktop host** has one revocable machine-scoped enrollment covering every current and future local workspace in that machine's canonical inventory. The signed desktop creates it with account authorization plus proof of the persistent host key. Host Connector later renews with that host key and never receives the account bearer.
- A **signed client** is the signed desktop, cloud-app in a desktop/mobile browser, or another supported client implementing the hosted Client/Protocol contracts. It authenticates to `@claxedo/server`.
- A **cloud workspace** runs Workspace Runtime and harnesses inside a hosted sandbox VM. It does not depend on the user's laptop.

### Supported Product Modes

| User intent | Identity location | Compute location | Reachable from | Laptop requirement | Product outcome |
|---|---|---|---|---|---|
| Work privately on this laptop | None | Laptop Workspace Runtime | This desktop | Laptop and desktop app running | Supported base mode |
| Make this machine's local workspaces remotely accessible | Optional desktop account session creates one machine-scoped host enrollment | Laptop Workspace Runtime | Any authorized signed client through Relay | Laptop awake, desktop/host connector running, outbound network available | Supported linked-host mode |
| Configure a sandbox VM while remaining unsigned | None | VM | None | Cloud authority requires identity | Outside the product contract; Create Cloud Workspace begins desktop sign-in |
| Create and use a cloud workspace | Signed desktop or browser/mobile client | Hosted sandbox VM | Any authorized signed client | Laptop not required after creation | Supported hosted mode |

The native Electron renderer always retains the local composition and execution path. In signed mode it receives an account-status port and lazy hosted contributions, while Electron main retains the credential and attaches it to Hosted Server calls. Remote access uses that desktop account session once to bind a host public key to the account; Host Connector then publishes the machine's complete canonical local-workspace inventory with machine-scoped credentials. Cloud-app remains the browser/mobile composition of the same hosted contracts.

Unsigned local mode remains available on every desktop platform the existing Electron product supports. Signed desktop mode is available only when Electron reports an OS-protected `safeStorage` backend: macOS Keychain, Windows DPAPI, or a Linux Secret Service/KWallet-class backend supported by the packaged Electron version. Linux `basic_text`, a locked/unavailable credential service, or any backend that cannot provide protected storage leaves local mode fully usable but disables Sign in, Enable Remote Access, and cloud-workspace creation with a specific setup message. The account surface explains this requirement before opening OAuth; release CI exercises signed activation on macOS, Windows, and protected-storage Linux fixtures, while the full packaged launch smoke remains on macOS unless the release matrix is expanded.

### The Desktop Pieces, in Plain English

- **Electron main** starts and supervises the desktop processes. Its optional account adapter opens system-browser OAuth, receives the desktop callback, stores account credentials with the platform credential store, refreshes or clears them, and exposes only typed account operations to the renderer.
- **The local app renderer** is the desktop UI. It talks to local-server through an authenticated loopback connection in every mode. When signed in it may lazy-load hosted UI contributions and call Hosted Server through the Electron account port, but it never receives the user's cloud bearer/refresh token or the Host Connector private key.
- **Local-server** exposes the local HTTP and event API used by the renderer. It translates those requests into Workspace Runtime operations.
- **Workspace Runtime** owns the real local workspace state: files, diffs, terminals, processes, sessions, events, and harness selection.
- **A harness adapter** starts only when the user asks an agent to perform work. It runs either on the laptop or inside the cloud VM, depending on the workspace type.
- **Host Connector** is an optional desktop child process used only while setting up or running a shared local workspace. It opens an outbound connection to Workspace Relay; the internet never connects directly to a laptop port.
- **Cloud-app** remains the signed browser/mobile entry and browser auth adapter. **Hosted Server** owns account and workspace authority, machine enrollment, cloud VM creation, and short-lived remote-access credentials for every signed client.

### What Changes in the Signed Desktop UI

Signing in extends the existing shell; it does not replace the local desktop with the hosted website. The existing workspace rail remains the primary navigation and groups runtime placement in that rail: local and shared-local entries are labeled **On this laptop**, while centrally provisioned entries are labeled **Cloud VM**. Within each project, existing workspace/session ordering remains authoritative; signing in does not move a local workspace or create a duplicate cloud row.

Account, Connections, Billing, sandbox configuration, and machine Remote Access are settings/account-menu destinations, not new top-level rails. WorkGraph and Documents remain the existing workspace/session-context surfaces registered through the contribution registry; they appear only where their current role, hosting, and backing gates allow them. **Create Cloud Workspace** remains the existing workspace creation action. On sign-in, contribution IDs and placement are stable, so destinations do not reorder after lazy activation.

OAuth preserves the action that started it. While the system browser is open, the desktop keeps the initiating dialog and form state, shows **Waiting for sign-in**, offers Cancel and Retry, and times out the one-use attempt without changing local state. A valid callback focuses the existing desktop window and resumes exactly one pending action—Enable Remote Access, Create Cloud Workspace, or an explicit Sign in destination. A canceled, expired, replayed, or rejected callback returns to that same surface with the user's nonsecret form state intact and never performs the action implicitly.

Explicit sign-out first handles hosted work predictably. If a hosted form is dirty or a hosted mutation is in flight, the desktop asks for confirmation. After confirmation it cancels client-side requests, pauses machine publication, revokes the provider session as described below, clears account-scoped caches and drafts, unregisters hosted routes/surfaces, and focuses the most recent local workspace or the local welcome surface. Local sessions, terminals, and drafts are not touched. A passive account-expiry error instead locks the current hosted surface behind **Sign in again** so the user can reauthenticate and resume its route; it does not reinterpret the workspace as local or run the operation without authority.

The user-facing distinction is simple: a workspace is shown as either **On this laptop** or **Cloud VM**. A shared laptop machine also uses the complete Remote Access state/count contract defined in Flow B, including Ready, partial Reconnecting, Offline, Paused, Revoked, and the one-time Re-enrollment required state.

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

1. If the desktop is unsigned, the user chooses **Sign in**. Electron main opens the system browser for OAuth with PKCE and receives the result through the registered desktop callback.
2. Electron stores the refreshable account credential with the platform credential store. The renderer receives the signed-in user/organization display state and tokenless account operations over typed IPC.
3. The user chooses **Enable remote access for this machine**. The desktop shows the laptop name, the scope “all current and future local workspaces on this machine,” and the requirement that the laptop remain awake, then requires an explicit confirmation.
4. Electron starts Host Connector in enrollment mode. For first enrollment the connector generates a keypair; for a restart Electron decrypts the existing key. Electron passes the key to the connector only over its one-use private bootstrap channel, and the connector returns the public key plus a fresh signed enrollment proof. Host Connector holds the private key only in memory; Electron is its sole persistent owner.
5. Electron sends the enrollment request to Hosted Server with the desktop account authorization attached. Hosted Server verifies the signed account, organization, declared machine-wide scope, and host-key proof, then atomically creates or rotates one durable machine enrollment. The account bearer never enters Host Connector.
6. The desktop stores the host private key using the platform credential store. It stores only the nonsecret host ID, owner/organization IDs, and enrollment generation beside it. Host Connector subsequently obtains short-lived machine and tunnel credentials by proving the host key.
7. Host Connector asks local-server for the authoritative local workspace inventory. Local-server gets this from Workspace Runtime and returns stable workspace IDs plus safe display metadata, never filesystem paths or provider credentials.
8. Host Connector sends the complete inventory to Hosted Server. Hosted Server reconciles the machine's per-workspace links: new local workspaces are added with the enrolling account as owner, existing links and explicitly granted collaborator roles remain, and locally deleted workspaces are removed.
9. Hosted Server returns a short-lived tunnel credential scoped to exactly that reconciled workspace set.
10. Host Connector publishes the accepted set through the existing Workspace Relay host-tunnel implementation. On the Bun Relay, the current machine tunnel registers multiple workspace IDs on one socket. On the Cloudflare Durable Object Relay, the current gateway keeps one workspace room per socket, so Host Connector maintains one tunnel handle per published workspace. Hosted Server returns the configured registration mode with the Relay assignment; Host Connector does not infer it.
11. Host Connector watches the canonical local inventory. Creating or importing a local workspace triggers another full authority reconciliation and then updates the existing Bun registration or adds the corresponding Cloudflare room tunnel. Deleting a workspace removes its hosted link and removes it from the active tunnel registration or tunnel set.
12. The desktop shows one aggregate machine status plus both accepted and currently reachable counts. Every signed client lists each workspace under that machine using its actual host-link/Relay presence. **Ready — waiting for first workspace** means the enrollment is valid and the accepted inventory is empty. **Online 3/3** means every accepted route is present. **Reconnecting 2/3** means healthy routes remain usable while at least one accepted route is being restored. **Offline 0/3** means presence has expired for every accepted route, even though bounded background retry continues. **Paused** is an owner action, and **Revoked** requires fresh authenticated enrollment. The displayed “published” total is the last server-accepted inventory count; it is never inferred from currently open sockets.

Canceling the desktop confirmation leaves the machine local-only. Enabling remote access with zero local workspaces is valid: the machine enrollment stays ready and the first workspace is published when it appears. Signing out pauses the local connector and remote publication but retains the host key and enrollment record; the same owner can sign in and resume without creating a new machine identity. Stop Sharing or account-side revocation rotates the enrollment generation and requires a new authenticated enrollment.

The release does not adopt the old plaintext host key or per-workspace account-link records. An upgraded profile with legacy sharing evidence shows a one-time **Remote Access: Re-enrollment required** state rather than masquerading as a first-time setup. It explains that the old sharing identity was intentionally discarded by the security cut, confirms that local workspaces, sessions, provider settings, credentials, and separate collaborator role grants remain in place, and offers **Re-enable Remote Access**. After the owner completes or dismisses that explanation, ordinary unlinked profiles use **Not enrolled**. Re-enrollment reconciles the same stable workspace IDs, so existing explicit collaborators regain access to their workspaces when the new links become present.

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

Pause or desktop sign-out keeps the machine enrollment but closes remote access to all of its workspaces. Resume requires the enrolled owner account in the desktop, then reconnects and republishes the full current inventory. Stop Sharing or account-wide revocation invalidates the machine generation and requires a fresh authenticated desktop enrollment before any workspace from that machine can be shared again.

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

The unsigned desktop runs local work directly on the laptop. It does not own cloud VM credentials, VM provisioning, billing, or remote lifecycle management. When an unsigned user chooses **Create Cloud Workspace**, the desktop begins the same optional sign-in flow used for machine enrollment. After sign-in it lazy-loads the hosted workspace contribution and the journey becomes Flow D.

An offline or self-hosted VM product could be designed separately later. It would need its own identity, ownership, cost, connection, and lifecycle rules.

### Flow D — Create and Use a Signed Cloud VM

What the user does: sign in to Claxedo Cloud, create a cloud workspace, and use it from any authorized signed client.

1. From the native desktop, **Create Cloud Workspace** requires the optional desktop account session. Electron performs system-browser OAuth if needed and returns the signed state to the desktop.
2. The desktop lazy-loads the platform-neutral hosted workspace contribution from cloud-app and asks the user for a repository and configuration. A browser/mobile user performs the same operation in cloud-app.
3. Hosted Server checks account membership, entitlement, limits, region, repository access, and credential availability.
4. Hosted Server creates the canonical cloud-workspace record and asks sandbox-manager to provision its VM and lease. The client follows the existing `provision` event contract already consumed by `DialogCreateCloudProject` and `CloudStartupView`; acquiring capacity, cloning, starting, waiting for health, ready, and error remain server/runtime-owned states rather than a new client-only state machine.
5. Sandbox-manager starts the VM, prepares the repository, starts Workspace Runtime inside the VM, and reports the ready runtime target to Hosted Server. Navigating away or closing the initiating desktop does not make the browser the lifecycle owner: provisioning continues according to the server lease, and reopening the canonical workspace reads its current server status and resumes the existing event/connection flow.
6. Hosted Server records the workspace as ready and gives the signed client a short-lived connection descriptor. The client opens it only after the existing `ready` event/status supplies the canonical directory; it never invents readiness from elapsed time.
7. The client connects to Workspace Relay. Relay validates the access and asks hosted authority for the VM's current target.
8. Relay forwards files, sessions, terminals, events, and prompts to Workspace Runtime inside the VM.
9. When a prompt requires a harness, the VM starts the selected harness there, using hosted scoped credentials.
10. Results return from the VM through Relay to the signed client.

The user can later open the same workspace from web, mobile, or any other supported signed client. Every client follows Hosted Server → Relay → VM. The original laptop and native desktop are not part of that runtime path, so closing the laptop has no effect. Hosted infrastructure owns VM wake, suspend, retry, and release behavior.

If provisioning fails, the moved `provision-failure.ts` taxonomy keeps its current recovery ownership: credential/billing/quota failures point to the provider account, region failure returns to provider choice, and unknown failure retries provisioning for the same canonical workspace. Reloading another client shows that same persisted workspace state. This plan does not add a fake local cancel or replacement-workspace path; cancellation or destructive cleanup is available only if the current Hosted Server/sandbox-manager API already owns it after Unit 1 characterization. The system never falls back to running that workspace on the user's laptop.

### Flow E — Run the Existing Self-Hosted Single-Binary Product

What the operator does: deploy the Claxedo Server Docker image or run the package's default `dev`/`start` command, then point users at that deployment's web origin.

1. The process starts `packages/claxedo-server/src/deployments/self-hosted-node`, the explicit replacement for the old mixed `deployments/local` entry.
2. That entry calls the shared trust-neutral `createSignedControlPlaneApp` route core, then supplies and validates self-hosted Node adapters: SQLite authority and central state, embedded auth, Relay/token services, local WorkGraph/Documents/channels, static cloud-app serving, and `@claxedo/local-server/self-hosted-execution`. Cloud Node/workerd keep calling the stricter `createHostedApp` wrapper, which validates hosted posture before invoking the same core.
3. The local-execution adapter starts Workspace Runtime for workspaces owned by this server process. It does not start Electron or import desktop main/preload code.
4. The same process serves the signed control-plane API and, when configured, the cloud-app static bundle. Users sign in to that deployment and use its workspaces through its normal hosted URL and authority.
5. Docker health, data roots, SQLite persistence, environment settings, startup, and shutdown keep the characterized self-hosted product behavior, but every script/export now points directly at the new entry.

This is not a compatibility wrapper around the old server. The old `createApp`, `createDefaultLocalControlPlaneServices`, and `deployments/local` paths are removed after every caller is retargeted. Cloud Node/workerd never import the local-execution adapter; only self-hosted Node does.

### Data, Credential, and Availability Boundaries

| Boundary | Unsigned local | Shared local/user-hosted | Cloud VM |
|---|---|---|---|
| Working tree | Laptop | Laptop; accessed live through Relay | Hosted VM/storage |
| Runtime/session authority | Laptop Workspace Runtime | Laptop Workspace Runtime | VM Workspace Runtime plus hosted projections |
| Account bearer | Not loaded | Electron account adapter and other signed clients only; renderer and Host Connector receive no bearer | Electron account adapter or browser/mobile signed client |
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
- **U8-R2.** `@claxedo/app` owns the local renderer shell, workbench, terminals, session UI, provider UI, and dependency-neutral account/hosted-contribution ports. Its unsigned production entry contains no Clerk, WorkGraph, Documents, provisioning, remote-access, or hosted API client implementation. Carries origin R25.
- **U8-R3.** `@claxedo/server` owns hosted identity, cloud workspace authority, relay, remote sandbox composition, WorkGraph, Documents, billing, hosted connections, channels, and wakes across hosted Node and workerd entrypoints. Carries origin R26.
- **U8-R4.** `@claxedo/cloud-app` owns the hosted browser entry, browser identity adapter, hosted routes, and platform-neutral hosted feature contributions. It composes `@claxedo/app` only through public app contracts and exposes a contribution entry that signed desktop mode can lazy-load with Electron's account port. Carries origin R26.
- **U8-R5.** `@claxedo/workspace-runtime` stays lower than both products and has no runtime dependency on local-server, server, app, or cloud-app.
- **U8-R16.** `@claxedo/host-connector` owns the moved local host keypair producer, signed enrollment-proof creation, complete local-workspace inventory reconciliation, machine-scoped grant rotation, heartbeat/presence, and supervision of the existing user-hosted Workspace Relay tunnel contract. Electron attaches its account authorization only to the initial enrollment request and returns the result over the connector's private bootstrap channel; the account bearer never enters Host Connector. It uses one multi-workspace socket for the Bun Relay and one existing per-workspace room socket for the Cloudflare Durable Object Relay, selected by an explicit Hosted Server Relay-assignment field. It depends on Workspace Runtime relay/protocol contracts and has no runtime dependency on app, cloud-app, local-server implementation, sandbox-manager, server implementation, or an account-auth SDK.

### Product behavior

- **U8-R6.** Unsigned desktop launch, empty-shell hydration, local session inventory, local files/diffs, PTYs, provider configuration, credential management, and explicit harness work retain their approved local contracts after the split.
- **U8-R7.** Desktop is unsigned by default and supports an optional signed mode. Electron main performs system-browser OAuth with PKCE, receives only the registered desktop callback, stores refreshable account credentials with the platform credential store, and exposes sanitized account state plus typed authenticated operations over IPC. The renderer, local-server, and Host Connector never receive account bearer or refresh tokens. Enable Remote Access uses that desktop account session plus host-key proof to create one revocable machine enrollment covering the host's current and future canonical local-workspace inventory. Carries origin R27 while narrowing the desktop credential boundary to Electron main.
- **U8-R8.** Hosted web launch retains its signed-auth gate, cloud workspace flows, WorkGraph, Documents, connections, and hosted route behavior under the cloud-app/server composition.
- **U8-R9.** Existing desktop profile directories, Workspace Runtime stores, provider configuration, credentials, session IDs, PTY behavior, and harness selection keep their canonical paths and formats. A package move does not create a second store or migration namespace.
- **U8-R17.** An authorized signed client can list and request access to every workspace in an enrolled machine's canonical local inventory from Hosted Server, subject to the client's per-workspace role. After connection mint, Runtime HTTP/SSE/WebSocket traffic flows through Workspace Relay → Host Connector → laptop Workspace Runtime. New local workspaces appear after automatic full-set reconciliation; deleted local workspaces disappear. The laptop working trees, provider credentials, runtime stores, and harness execution remain local; laptop or connector unavailability moves the machine's workspaces together to host-offline rather than a cloud fallback.
- **U8-R20.** Host Connector automatically restores lost Relay transport with the existing bounded exponential backoff, jitter, fresh token-provider call, dead-socket watchdog, and registration-update behavior from `workspace-relay-host-tunnel.ts`. Before restoring the configured Bun registration or Cloudflare room-tunnel set, it obtains fresh host-key authorization and a fresh authoritative workspace snapshot. Paused, revoked, deleted, and generation-mismatched enrollments are terminal until user action.
- **U8-R21.** A signed client treats transient user-hosted transport loss as reconnecting, obtains fresh runtime access and placement, resumes canonical events from its last cursor or refetches after a replay gap, reattaches live resources by canonical ID, and never resubmits a prompt solely because the connection dropped.
- **U8-R22.** Signed user-hosted clients preserve the existing control/data split: Hosted Server authenticates the user, lists/authorizes workspaces, and mints or refreshes Runtime Access Tokens; the client sends all workspace HTTP/SSE/WebSocket traffic to Workspace Relay; Relay verifies the token, current target, revocation state, role, and host presence before forwarding through Host Connector. `userHostedConnectionInfo` does not return `directRuntimeUrl`, so the laptop is never a direct remote client target.
- **U8-R23.** The package split preserves the existing Workspace Relay security, frame, and lifetime contracts in `auth.ts`, `server.ts`, `bun.ts`, `cloudflare.ts`, `workspace-relay-host-tunnel.ts`, and `workspace-host-service-auth.ts`. U8 moves and composes these producers. Its Relay-facing support is limited to carrying the configured registration mode, supervising the corresponding existing tunnel handles, and making `updateRegistration`'s latest workspace set the set used to construct the next reconnect URL.
- **U8-R18.** Unsigned desktop supports host-native local execution. Sandbox VM creation and lifecycle require signed mode; a signed desktop lazy-loads the platform-neutral hosted workspace contribution and a browser/mobile client uses cloud-app. Hosted Server provisions the VM and any authorized signed client can reconnect without the laptop.
- **U8-R24.** The self-hosted single-binary control plane remains a supported `@claxedo/server` Node composition. Its Docker image, default `dev`/`start` commands, public server entry, SQLite authority, embedded auth and local execution, signed control-plane routes, Relay resolver/signers, WorkGraph, Documents, channels, and optional static cloud-app serving retain their characterized contract after `deployments/local` is removed.

### Build and enforcement

- **U8-R10.** Desktop development, production build, and packaged macOS launch resolve the same `@claxedo/local-server` entry and the same local app composition contract. Carries origin R28.
- **U8-R11.** Hosted Node and hosted workerd resolve the same hosted service composition from `@claxedo/server`; hosted browser development and deployment resolve the same `@claxedo/cloud-app` entry.
- **U8-R12.** Base local app and local-server source-closure guards validate package manifests and the transitive value-import graph. Hosted-only modules and packages are absent from those unsigned entries; Host Connector, Electron account auth, and signed hosted contributions are evaluated as separate optional closures under U8-R13 and U8-R19.
- **U8-R13.** Emitted local-renderer/local-server manifests reject hosted modules. Electron account auth and signed hosted contributions emit separately fingerprinted lazy chunks that may exist in the packaged artifact but remain absent from the unsigned startup module/process trace. The packaged resource inventory rejects undeclared cross-boundary resources and proves both unsigned and signed entry identities.
- **U8-R14.** Hosted build and integration tests retain auth, authority, remote sandbox, relay, WorkGraph, Documents, billing, connections, channels, and wakes after local code moves away.
- **U8-R15.** The split lands as a sequence of green package boundaries: shared contracts first, authoritative producers moved once, consumers rewired, obsolete entrypoints removed, and enforcement activated after each closure exists.
- **U8-R19.** Host Connector has its own manifest, source graph, emitted artifact, and packaged-resource boundary. Base unsigned launch does not start or import it; Electron starts the separately fingerprinted child only for an explicit machine-enrollment action or an enrolled, unpaused machine, and it exposes only inventory-validated Workspace Runtime route families.

## Scope Boundaries

- U8 owns source placement, package manifests, public composition contracts, development/build entrypoints, deployment-path updates caused by the new package names, and source/emitted-artifact boundary checks.
- U8 owns the optional signed-desktop and linked-host path: Electron account auth, account-authorized host-key enrollment, machine-scoped renewal, automatic full local-inventory reconciliation, host presence, supervision of the existing Relay transport shape, inventory-validated runtime forwarding, machine-wide pause/revoke, tunnel/client reconnection, and the package boundaries that keep account and connector code out of local-server and unsigned app startup.
- U8's Workspace Relay scope is composition and characterization: preserve the existing Runtime Access Token, Host Tunnel Token, Relay Host Token, HTTP/SSE/WebSocket paths, tunnel frames, runtime-specific registration topologies, limits, and established-socket lifetime semantics. Established-socket revocation hardening remains separate Relay security work.
- Self-hosted embedded-auth registration/bootstrap, administrator, TLS, and trusted-proxy policy remain the current self-hosted product contract characterized in Unit 1; this package split does not silently redesign them. Any change from open registration to invite/bootstrap-admin policy is separate self-host security work and a release decision, not an implementation detail for Unit 7.
- Signed user-hosted clients use Hosted Server as control-plane authority and Workspace Relay as the remote Runtime data plane. A direct public client-to-laptop transport is outside this product contract.
- U8 owns the structural Electron resource allowlist, packaged-entry identity, unsigned packaged launch smoke, signed-mode activation smoke, and the final Release Qualification Gate in this document. That gate performs resource trimming, per-harness packaged measurement, unsigned memory acceptance, signed activation measurement, and browser/desktop performance qualification against the same package contract.
- Implementation may merge after the structural gates pass, but production promotion of the non-backward-compatible remote-sharing cut waits for this document's packaged memory/startup/performance acceptance thresholds. If qualification fails, do not ship the hard cut; fix the closure/performance result and rerun qualification rather than adding a compatibility path.
- This standalone plan owns the U5 subset required to create hosted/default-off WorkGraph and Documents contributions and prune unavailable restored surfaces.
- This standalone plan owns the U6–U7 subset required to finish harness process lifecycle, runtime-owned session inventory, canonical events, and historical harness reconciliation before extracting packages.
- Existing user data, profile locations, and externally supported product behavior remain stable where the new architecture still owns them. Internal TypeScript exports, composition APIs, package scripts, deployment entrypoints, and superseded local account-link routes are hard-cut contracts: each owning unit retargets every repository caller and deployment in the same slice, then deletes the old path. This plan creates no forwarding export, compatibility module, legacy route, fallback entrypoint, script alias, or overlap period.
- Preserving current durable user data may require an explicit one-way schema/profile migration when a schema actually changes; it does not require old binaries, old routes, or old exports to keep working against the new state. Superseded remote-sharing credentials/enrollments are explicitly not migrated; Unit 6 removes the old plaintext host-key record and requires one fresh machine enrollment.
- Marketing-site architecture and unrelated package publication are outside this unit; references that describe the deploy-unit package names are updated for accuracy.
- Unsigned sandbox VM orchestration is outside the product contract. Cloud VM actions require the Electron-owned account session in desktop or the browser/mobile account session in cloud-app.

## Independent Execution Starting Point

This document assumes only a clean current-`dev` worktree plus the repository toolchain. It has no implementation dependency on U5, U6, U7, or another plan being executed first.

Execution prerequisites are part of this plan:

- Install the repository's pinned Bun/Node workspace dependencies from the root lockfile before Unit 1; run every test/typecheck command from its package directory as listed below.
- Use the existing local Relay, hosted-server, signed-browser, desktop-auth, sandbox, and deterministic harness fixtures for unit/integration work. Tests mint isolated OAuth callbacks, account sessions, EdDSA keys, and authority records and require no production account, Relay, Convex deployment, cloud VM, or provider credential.
- **Development application registered and validated (2026-08-08) — see `docs/tech-docs/desktop-oauth-development-client.md`.** The public client exists with all three channel callbacks, and the live discovery document offers `S256` PKCE plus `authorization_code`/`refresh_token`, so the design needs no workaround. The interactive half of the spike (system-browser authorization, callback dispatch, refresh, restart restoration, logout/revocation, org switching, cancel/timeout/replay) still requires the Electron adapter. Beta and production applications remain unregistered. Unit 6 owns creation and documentation of Clerk public OAuth applications for the supported desktop channels, with exact registered callback URIs matching Electron's production/beta/development protocol schemes. Only the public client ID and issuer/discovery origin enter the desktop build. Before Unit 6 freezes `AccountPort` or machine-enrollment APIs, a production-like spike against the registered development application must prove system-browser authorization, exact callback dispatch, refresh, restart restoration, provider logout/revocation, organization switching/removal, cancel, timeout, and replay rejection. Repeat callback registration plus one happy-path sign-in/revocation check against beta and production configuration before promotion. A failure rejects the Electron-native Clerk design and blocks Units 6 and 9–11; do not paper over it with a renderer token or generic authenticated proxy.
- Run the unsigned Electron package smoke on macOS and fixture signed-activation tests on all normal runners. Signed desktop release support additionally requires native packaged credential lanes on macOS, Windows, and the supported protected-storage Linux image: create protected credentials, restart/restore, exercise store lock/unavailability and corrupt-record recovery, complete remote provider revocation, and verify Linux `basic_text` is refused. A platform without that lane remains unsigned-local-only and is not advertised as signed-desktop supported.
- Hosted staging access, Clerk development/beta/production application administration, and native macOS/Windows/Linux release runners are explicit external execution prerequisites owned by the release/identity operator. Repository-fixture implementation may begin without them, but Unit 6 cannot be accepted and dependent Units cannot freeze their public contracts until the development spike passes; production promotion requires the beta/production registration and native lanes above.

Phase A below establishes the benchmark baseline, required product contracts, hosted feature seams, harness lifecycle, runtime session authority, and canonical events. Phase B extracts those verified owners into product packages. Phase C rewires delivery and enforces the resulting closures. The final gate measures the exact produced artifacts. The origin plan may reuse these records, but no origin-plan unit must run first or afterward for this plan to be executable and promotable.

Every enabling change follows the repository's authoritative-producer rule: move or repair the canonical producer, migrate every consumer and operational entrypoint in that same unit, then remove the obsolete path before the unit can pass. No unit supplies fallback session data, synthetic events, shadow routes, compatibility exports, compatibility servers, legacy scripts, or dual-running routes as a substitute for the target owner.

## Context and Research

### Current Composition Anchors

- `packages/claxedo-server/src/deployments/local/server.ts` is the current mixed local composition root and route inventory.
- The same `deployments/local/server.ts` is also the live self-hosted signed control-plane composition: `packages/claxedo-server/package.json` points default `dev`/`start` at `deployments/local/main.ts`, and `packages/claxedo-server/Dockerfile` ships that entry with SQLite authority, embedded auth/execution, hosted features, channels, Relay authority, and static SPA serving. The desktop-local extraction and self-hosted migration therefore require separate destinations.
- `packages/claxedo-server/src/deployments/local/embedded-workspace-runtime.ts` is the current bridge that this plan first simplifies through runtime-owned inventory/events and then moves into local-server.
- `packages/claxedo-server/src/deployments/hosted-shared/hosted-app.ts`, `deployments/hosted-node/index.ts`, and `deployments/hosted-workerd/worker.ts` already express the shared-hosted/Node/workerd topology that remains in `@claxedo/server`.
- `packages/claxedo-server/src/deployments/hosted-workerd/worker.import-graph.test.ts` is the strongest existing server-side precedent: it walks a transitive value-import graph and enforces runtime-specific source and package exclusions.
- `packages/claxedo-app/src/ARCHITECTURE.md` defines `app` as the composition owner, features as independent owners, and `app/integrations` as the cross-feature assembly boundary.
- `packages/claxedo-app/src/architecture/import-graph.ts`, `ownership.ts`, and their guard tests provide reusable source-graph and ownership-scanner patterns.
- `packages/claxedo-app/src/features/extensions/data/index.ts` already separates the dependency-light accessor from factory modules that pull larger UI/auth chains.
- `packages/claxedo-app/src/app/integrations/registry.ts` and the contribution types in `first-party-content-surfaces.tsx` provide an existing registration model to extend for hosted composition.
- `packages/claxedo-desktop/scripts/contract.ts` fingerprints build inputs and outputs, while `bundle-claxedo-server.ts` and `electron.vite.config.ts` define the current server and renderer artifact seams.
- `packages/claxedo-server/src/deployments/local/remote-access-service.ts` already lists every local workspace, subscribes to inventory changes, registers host links, and starts the machine tunnel. The extracted Host Connector preserves that orchestration while replacing its long-lived `SignedControlPlaneAuth` input with a one-time Electron-brokered authenticated enrollment followed by host-key renewal, and adds authoritative removal reconciliation.
- `packages/claxedo-server/src/routes/hosted/workspace.ts`, `connections/user-hosted-connection.ts`, and `connections/hosted-connection-info.ts` already implement the signed list/open/connection-mint control path. The returned user-hosted connection contains `relayUrl` and Runtime Access Token and intentionally omits `directRuntimeUrl`.
- `packages/claxedo-app/src/platform/runtime/agent/workspace-relay-connection.ts`, `platform/runtime/cloud/workspace-runtime-store.ts`, and `features/workspaces/data/workspace-connection.ts` already implement client connection mint/refresh, Relay HTTP/WebSocket URL construction, health probing, and reconnecting UI state. These are characterization targets and later move with cloud-app ownership; U8 does not replace their transport behavior.
- `packages/claxedo-server/src/user-hosted-tunnel.ts`, `workspace/local-host.ts`, and `workspace/runtime-dispatch/shared-workspace-endpoint.ts` contain the current host identity, outbound tunnel orchestration, and runtime-route restrictions that move into Host Connector/local-server ownership.
- `packages/workspace-runtime/src/workspace-relay-host-tunnel.ts` already owns Host Tunnel Token acquisition on every connection attempt, exponential backoff with jitter, a three-heartbeat dead-socket watchdog, HTTP/WebSocket multiplexing, bounded pre-open queues, and authenticated registration updates.
- `packages/workspace-relay/src/auth.ts` and `server.ts` already implement Runtime Access Token, Host Tunnel Token, and Relay Host Token verification, role/path enforcement, target/revocation checks, dangerous-header stripping, cookie stripping for user-hosted traffic, and audit events.
- `packages/workspace-relay/src/bun.ts` already supports one host socket registered for multiple workspaces and full registration updates. `packages/workspace-relay/src/cloudflare.ts` deliberately places one workspace per Durable Object room and rejects multi-workspace host sockets at the gateway. Host Connector composes each existing mode through the explicit registration-mode assignment.
- `packages/workspace-runtime/src/workspace-host-service-auth.ts` already verifies the Relay Host Token, workspace/host claims, access/backing pair, workspace header, and Relay-controlled forwarding marker at the laptop Runtime boundary.
- `packages/claxedo-server/src/deployments/shared-routes/internal-relay.ts` and `packages/workspace-relay/src/main.ts` already provide the authenticated Relay-to-Hosted-Server target/revocation resolver channel and short caches used on the data path.
- `packages/claxedo-app/src/platform/auth/auth-client.ts`, `auth-session.ts`, and `principal-provider.tsx` already define lazy account state, token acquisition, and the principal seam. This plan preserves their UI-facing contract while moving the desktop credential producer into Electron main and retaining a browser producer in cloud-app.
- `packages/claxedo-server/src/user-hosted-tunnel.e2e.test.ts`, `packages/claxedo-app/e2e/playwright/web-signed-userhosted.spec.ts`, and `desktop-signed-embedded-shared.spec.ts` already prove major relay, user-hosted, and signed-desktop paths; this plan retargets the desktop lane to Electron-owned account auth plus machine-scoped Host Connector enrollment.
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

The support added for the split is limited to an Electron account adapter and tokenless renderer port, account-authorized host-key enrollment, durable machine authority for future workspaces, atomic full-inventory reconciliation, an explicit Relay registration-mode field, and Electron/Host Connector lifecycle plus IPC. Runtime Access Token, Host Tunnel Token, Relay Host Token, Relay protocol-frame, and Workspace Runtime route contracts stay canonical and unchanged.

### Repository Constraints That Shape the Split

- The workspace includes `packages/*`, so both new packages enter workspace resolution through their manifests; the lockfile changes with the manifest graph.
- `@claxedo/app` deliberately remains in `packages/claxedo-app`; the directory/package-name mismatch is an established convention.
- `@claxedo/server` remains the hosted trust composition across Node and workerd. Hosted describes trust posture; Node and workerd describe runtimes.
- App features communicate across owners through app-owned ports and contributions. Cloud-app supplies hosted implementations through public package exports instead of importing `@claxedo/app` internals by relative path or mirrored aliases.
- Package moves preserve one canonical producer. A landing slice retargets callers directly to the new owner and deletes the old import/export path; it does not commit compatibility imports or forwarding barrels.
- Typechecks run from each package with its declared package script. Tests run from package directories.

### Institutional Learnings

No matching `docs/solutions/` artifact exists. The strongest institutional evidence is executable: worker import-graph guards, app ownership guards, desktop build contracts, and the recent extraction patterns in `packages/sandbox-manager` and `packages/claxedo-connections`.

### External Research

T3 Code validates the broad product shape without replacing Claxedo's existing producers. Its desktop bundles a server runner, and its web, desktop, and mobile clients control environments through typed WebSocket contracts. Its current remote-access model supports direct paired endpoints, trusted private networks such as Tailscale, managed relay tunnels, and desktop-managed SSH. Its hosted web pairing still connects to the chosen backend rather than making the hosted app a byte proxy. See [T3 Code's architecture notes](https://github.com/pingdotgg/t3code/blob/main/AGENTS.md), [user remote-access guide](https://github.com/pingdotgg/t3code/blob/main/docs/user/remote-access.md), and [maintainer remote architecture](https://github.com/pingdotgg/t3code/blob/main/docs/internals/remote.md).

Clerk's current OAuth contract supports public clients that carry no client secret and require Authorization Code with PKCE, and its Frontend API is intended for browser or native clients. That is the supported basis for Electron-main sign-in; the implementation uses Clerk's documented discovery/token endpoints and a pre-registered fixed redirect URI rather than embedding a backend secret. See [Clerk public clients and PKCE](https://clerk.com/docs/guides/configure/auth-strategies/oauth/how-clerk-implements-oauth) and [Clerk API overview](https://clerk.com/docs/reference/api/overview).

Claxedo retains its own stronger hosted authority and runtime model:

- The desktop continues to bundle a local server and run provider harnesses against machine-owned workspaces.
- Web, mobile, and signed desktop remain clients of the same typed workspace/runtime contracts.
- A local machine is published through the existing outbound Workspace Relay tunnel rather than requiring a public laptop listener or direct client address.
- Hosted Server keeps account identity, per-workspace roles, connection minting, revocation, Relay target resolution, and machine enrollment.
- One enrolled host publishes the complete canonical local-workspace inventory; reconnect rereads and reconciles that inventory.
- Cloud workspaces remain a separate hosted compute mode that survives laptop shutdown.

The useful T3 Code lesson is the product boundary: desktop is both a client and an optional host, and remote clients operate the host's real environment. Claxedo implements that shape through its existing Hosted Server, Workspace Relay, Workspace Runtime, and cloud-VM contracts instead of introducing a second remote server model.

## Key Technical Decisions

- **K1 — Product packages are composition roots.** `@claxedo/app` and `@claxedo/local-server` compose unsigned desktop startup; Electron may lazy-load `@claxedo/cloud-app`'s platform-neutral hosted contributions after sign-in. `@claxedo/cloud-app` and `@claxedo/server` compose the hosted browser product. Domain-neutral contracts stay in lower packages.
- **K2 — The local closure is positive and explicit.** The local manifests enumerate their runtime dependencies, and guards compare the actual transitive graph to an approved local capability set. A denylist remains as defense in depth for representative hosted packages.
- **K3 — Cloud-app depends on app through public contracts and exports hosted contributions.** The shared renderer exposes a small composition surface for providers, routes, feature contributions, settings sections, navigation, account state, and authenticated operations. Cloud-app supplies platform-neutral hosted implementations without `@/` aliases into app source; its browser entry supplies browser auth, while desktop supplies Electron auth before dynamically importing the same contribution entry. Both reach server over Client/Protocol HTTP contracts and have no runtime package dependency on server or Core.
- **K4 — Local-server composes Workspace Runtime directly.** Local files, diffs, PTYs, processes, session inventory, canonical events, and harness dispatch come from the Workspace Runtime authority completed in Units 3–4. Local-server owns HTTP/SSE adaptation, local configuration and credentials, loopback policy, startup, and shutdown.
- **K5 — Server keeps one signed control-plane route core with deployment-specific boot wrappers.** Unit 7 extracts `createSignedControlPlaneApp` from the route assembly currently inside `createHostedApp`. Cloud Node/workerd continue to call `createHostedApp`, whose hosted-mode/issuer/authority assertions remain strict. Self-hosted Node calls `createSelfHostedApp`, whose separate posture assertion permits only the characterized SQLite and embedded-auth adapters, then both wrappers invoke the same route core. This preserves the current single-binary product without weakening cloud-hosted boot checks or reusing them for an incompatible trust posture.
- **K6 — Desktop identity is isolated in Electron main.** System-browser OAuth with PKCE returns through an allowlisted desktop callback. Electron main owns credential persistence, refresh, logout, and authenticated Hosted Server calls; renderer code consumes a tokenless account port. Cloud-app separately owns browser identity. Local-server and Host Connector accept neither credential.
- **K7 — Persistent local paths are package-independent.** Data/profile path resolution remains based on product and user directories, never the source package's location. Extraction tests open an existing fixture profile and observe the same records through the new local-server entry.
- **K8 — Source closure and artifact closure are separate gates.** Import-graph tests catch architectural edges; emitted manifests catch bundler aliases, dynamic imports, and packaging configuration that source scans alone can miss.
- **K9 — Missing canonical owners fail loudly.** Local startup and build fail when their declared local entry or artifact is missing. They never fall back to `@claxedo/server`, cloud endpoints, or synthesized responses.
- **K10 — One artifact contract proves both independence and release fitness.** Unit 12's smoke targets built local/hosted entries plus unsigned startup and signed activation. The Release Qualification Gate repeats that exact package contract across harness and platform cohorts and attaches memory/performance evidence; it does not rebuild from another entry or depend on another plan.
- **K11 — Foundations are deliverables, not assumptions.** Hosted feature seams, harness lifecycle, and runtime-owned inventory/events land as Phase A units in this plan. Package extraction begins only after their tests are green within the same execution.
- **K12 — Account identity establishes machine identity once.** The signed desktop explicitly confirms the scope “all current and future local workspaces on this machine.” Host Connector produces a host-key proof, Electron attaches account authorization, and Hosted Server atomically creates or rotates the enrollment. Desktop stores the host private key plus nonsecret enrollment metadata; all subsequent connector authorization uses host-key proof and short-lived machine credentials. Machine-wide future inclusion is an explicit product requirement for this plan, chosen over per-workspace or selected-set consent so “Remote Access for this machine” cannot silently omit a newly created local workspace and all workspaces remain recoverable after reconnect. Per-workspace collaborator roles still control who besides the owner can open each row. If product intent later changes to selected sharing, that is a new authority/schema migration—not an implementation-time interpretation or hidden toggle in this cut.
- **K13 — User-hosted transport is an optional companion boundary.** Enrollment persistence, inventory reconciliation, control-plane calls, Relay/WebSocket transport, and reconnect loops have a distinct security and dependency closure from both the renderer and the loopback server, so they live in a separately built and supervised Host Connector. It is absent from unsigned empty-shell startup and starts only for enrollment work or an enrolled, unpaused machine. It dials Relay outbound and forwards only Workspace Runtime routes whose workspace ID is present in local-server's current canonical inventory.
- **K14 — VM provisioning is a hosted capability.** The unsigned product stays host-native. This keeps sandbox credentials, cost controls, remote lifecycle, and authority in cloud-app/server and gives cloud workspaces laptop-independent availability.
- **K15 — Machine enrollment and workspace presence are separate authority levels.** A durable `host_enrollments` record authorizes one host key to publish the owner's complete local inventory across restarts and future workspace creation. `local_host_links` remains the per-workspace materialization used for listing, roles, presence, and Relay target resolution. A successful full-set reconcile is the sole producer of those materialized links: it ensures the enrolling account's owner role, preserves explicit collaborator roles for unchanged workspaces, and adds or removes workspace routes without another account authorization or a second competing grant source. Failed or partial inventory reads never become an empty reconcile.
- **K16 — Reconnection restores transport, not user intent.** Host Connector reconnects the machine tunnel from durable enrollment plus fresh inventory, while clients independently reacquire runtime access and resume/refetch state. Prompt admission is never repeated as a transport retry; canonical IDs and cursors recover observable state.
- **K17 — Hosted Server is control plane; Workspace Relay is remote data plane.** The signed client uses Hosted Server for identity, listing, authorization, and connection-token mint/refresh. It then sends all user-hosted Runtime HTTP, SSE, and WebSocket traffic to Workspace Relay. Relay remains inline for those bytes and consults Hosted Server only through the existing authenticated target/revocation resolver; the laptop is never a direct client target.
- **K18 — Host Connector adapts to the existing Relay runtime.** Bun's host registry is host-scoped and already accepts multiple workspace IDs plus registration replacement. Cloudflare Durable Object rooms are workspace-scoped and already require one workspace per host-tunnel socket. Hosted Server returns a registration-mode field with the Relay assignment, and Host Connector supervises the corresponding existing handle shape. This confines new work to composition and machine-inventory reconciliation.

## High-Level Technical Design

The package structure works as follows:

1. Electron loads `@claxedo/app` as the native local UI and starts `@claxedo/local-server` as its loopback server.
2. Local-server uses `@claxedo/workspace-runtime` for files, sessions, terminals, processes, events, and harness dispatch. Optional harness adapters remain below Workspace Runtime.
3. When a user signs in, Electron lazy-loads its account adapter, performs system-browser OAuth, persists the account credential outside renderer storage, and binds the app's tokenless account port.
4. When that user enables machine remote access, Electron starts `@claxedo/host-connector` for host-key proof, attaches account authorization to the enrollment request, then leaves Host Connector to read the canonical local inventory and publish it through the existing Relay contract: one multi-workspace registration on Bun or one tunnel handle per Cloudflare workspace room.
5. The hosted browser loads `@claxedo/cloud-app`. Cloud-app reuses public UI and composition contracts from `@claxedo/app`, supplies browser identity, and registers hosted features. Signed desktop mode dynamically imports the same platform-neutral contribution entry and supplies Electron identity.
6. Both signed compositions call `@claxedo/server` over Client and Protocol contracts. Server owns hosted authority, cloud sandboxes, Relay integration, WorkGraph, Documents, and other account capabilities.

### How the Current Claxedo Server Code Splits

This is a movement of existing composition and a small amount of enrollment support, not a server rewrite:

- **`@claxedo/local-server` becomes the desktop-local composition.** The current `packages/claxedo-server/src/deployments/local/server.ts`, the embedded Workspace Runtime bridge, local route mounting, profile/config/credential adapters, and Relay-to-runtime forwarding gate move here. Electron continues to start it as a loopback sidecar. It calls Workspace Runtime; it does not know about accounts, cloud VMs, billing, WorkGraph, Documents, or Hosted Server implementation.
- **`@claxedo/server` owns the shared control plane and its three server deployment closures.** The existing `deployments/hosted-shared/hosted-app.ts`, `deployments/hosted-node`, and `deployments/hosted-workerd` remain its cloud-hosted roots. Unit 7 extracts their trust-neutral signed route assembly to `deployments/hosted-shared/signed-control-plane-app.ts` while keeping hosted boot validation in `createHostedApp`. A dedicated `deployments/self-hosted-node` wrapper preserves the current single-binary product with its own explicit posture validation plus Node/SQLite authority, embedded auth, the public local-execution adapter, local WorkGraph/Documents adapters, channels, Relay resolver/signers, and optional static cloud-app serving. Existing hosted workspace routes, `user-hosted-connection.ts`, connection mint/refresh, machine/workspace authority, `/internal/relay/target`, `/internal/relay/revocation`, cloud sandbox provisioning, WorkGraph, Documents, billing, connections, channels, and wakes stay here. Desktop-local composition does not.
- **`@claxedo/host-connector` becomes the laptop publication companion.** The current `deployments/local/remote-access-service.ts`, `workspace/local-host.ts`, and local-machine branch of `user-hosted-tunnel.ts` move here. The connector adds the host-key enrollment proof and full-set removal reconciliation required by the process boundary, then continues to call `workspace-relay-host-tunnel.ts` for the established tunnel and reconnect behavior.
- **`@claxedo/workspace-runtime` remains the local execution authority.** Units 3–4 complete its ownership of session inventory, canonical events, files, diffs, PTYs, processes, and harness lifecycle so local-server and Host Connector consume one authoritative producer.
- **`@claxedo/workspace-relay` remains the remote byte path.** Its Bun and Cloudflare runtimes, token verification, role/path gates, header rewriting, limits, audit events, target/revocation resolution, and host-tunnel protocol remain in place. The split only supplies the reconciled workspace set and explicit existing registration mode.
- **Electron main is the desktop account adapter, not another server.** It performs OAuth, stores the credential, invokes named Hosted Server operations, and brokers the initial authenticated enrollment. It does not proxy local Runtime traffic, and Hosted Server does not proxy user-hosted Runtime bodies.

After the split there is one desktop-local composition, one shared hosted control-plane composition adapted to cloud Node, workerd, and self-hosted Node deployments, one optional host-publication companion, and the same lower Runtime/Relay producers. Public Server or Protocol changes follow the repository's generated-client workflow; generated Client files are regenerated from the authoritative API and never edited by hand.

### Package Dependency Rules

| Package | Direct local/product dependencies | Capability closure | Representative packages absent from runtime closure |
|---|---|---|---|
| `@claxedo/local-server` | Workspace Runtime, agent/harness contracts and selected adapters, Hono Node transport, local SQLite/PTY/config dependencies | Local HTTP/SSE, project/files/diffs/PTY/process/session/provider/config/credentials/harness dispatch | `@claxedo/server`, Clerk/better-auth, Convex, sandbox-manager, WorkGraph, relay, billing and hosted connection/channel packages |
| `@claxedo/app` | Shared UI/session packages, local runtime client contracts, renderer libraries | Local shell/workbench/session/terminal/provider/settings plus account and hosted-contribution ports | Clerk, WorkGraph, Documents implementation, cloud provisioning/runtime store, remote access implementation, hosted connections clients |
| `@claxedo/server` | Hosted authority, relay, sandbox, WorkGraph, Documents, billing, connections, channels, wakes, and runtime contracts; only `deployments/self-hosted-node` additionally imports `@claxedo/local-server/self-hosted-execution` | Shared hosted control plane on cloud Node/workerd plus the signed self-hosted Node single-binary composition | Desktop/Electron modules and the desktop-local server entry; cloud Node/workerd also exclude all local-server modules |
| `@claxedo/cloud-app` | `@claxedo/app`, browser Clerk adapter, WorkGraph/Document UI dependencies and hosted API clients | Hosted browser boot plus platform-neutral cloud workspace and hosted feature contributions | Electron and desktop main/preload APIs |
| `@claxedo/host-connector` | Workspace Runtime relay/protocol contracts, moved local host identity, nonsecret enrollment state, and existing outbound WebSocket host-tunnel transport | In-memory host-key proof use, full local-inventory reconciliation, host presence, reconnect loop, and Relay-runtime-specific tunnel supervision | Persistent private-key storage, account auth SDK, sandbox-manager, server/app/cloud-app implementations, local provider/config routes |
| `@claxedo/workspace-runtime` | Schema/protocol and harness contracts | Workspace/session core | Product composition packages |
| `@claxedo/desktop` account adapter | Electron main, platform credential store, OAuth/Clerk native client, generated hosted Client/Protocol | Optional account session, OAuth callback, authenticated-operation IPC, signed-contribution activation | Local-server implementation, Workspace Runtime implementation, Host Connector account-token access |

### Capability Placement

| Capability | Desktop/local path | Hosted path |
|---|---|---|
| Health and shell bootstrap | local-server | server-specific hosted contract |
| Files, diffs, PTYs, process dispatch | Workspace Runtime through local-server | hosted placement/runtime policy |
| Session inventory, titles, canonical events | Workspace Runtime through local-server | hosted persistence/event infrastructure |
| Harness selection and dispatch | Workspace Runtime registry | hosted runtime policy |
| Local provider config and credentials | local-server/profile store | hosted account configuration |
| Account identity and auth session | optional Electron-main account adapter; renderer receives tokenless state/operations | cloud-app browser adapter + server |
| Cloud workspace authority | signed desktop lazy contribution | server |
| Enable remote access for local machine | signed desktop confirmation + optional Host Connector host proof | server machine-enrollment authority + Workspace Relay |
| Publish local workspace inventory | local-server/Workspace Runtime snapshot → Host Connector full-set reconcile | server materializes per-workspace host links and scopes Relay registration |
| Remote access to machine workspace | Host Connector forwards inventory-present Workspace Runtime routes only | signed client → server connection mint/refresh; client Runtime traffic → Relay; Relay internal target/revocation lookup → server |
| Remote sandbox management | signed desktop lazy contribution | server and sandbox-manager |
| WorkGraph and Documents | signed desktop lazy hosted contributions | cloud-app + server |
| Billing, hosted connections, channels, wakes | signed desktop account/hosted contributions | hosted products |

### Build Closure Proof

Package independence is proved in five plain steps:

1. Check that each package manifest declares only dependencies allowed for that product.
2. Walk the package's real runtime imports and fail on a cross-product source edge.
3. Build the production entry using only the declared package closure.
4. Inspect the emitted modules and chunks for dependencies inserted by aliases or build tooling.
5. Start the real built entry and pass its deterministic artifact manifest to this plan's Release Qualification Gate.

Every edge must agree. A clean manifest cannot compensate for an alias that reaches another package's source; a clean source scan cannot compensate for a bundler plugin that injects hosted code; a clean bundle-name scan cannot compensate for an entrypoint that silently uses a different composition.

## Flow Analysis

### Flow 1 — Unsigned desktop launch

1. Electron starts the local-server entry from `@claxedo/local-server`.
2. Local-server creates the loopback HTTP/SSE adapter and composes Workspace Runtime.
3. The renderer boots `@claxedo/app` with local contributions.
4. Health, bootstrap, project/session inventory, files/diffs, and terminal gates resolve locally.
5. Harness process count remains governed by Unit 3's lifecycle contract; package loading itself selects no harness.

Terminal states: usable local shell; explicit startup failure naming the missing local owner; clean shutdown of the local server and its owned runtime resources.

### Flow 2 — Desktop user signs in or selects a hosted capability

1. The local renderer asks Electron's account port to sign in and supplies a typed initiating intent such as explicit Sign in, Enable Remote Access, or Create Cloud Workspace. Electron retains only that intent and its nonsecret form draft.
2. Electron lazy-loads the account adapter, creates PKCE/state/nonce material, opens the allowlisted OAuth URL in the system browser, and reports waiting/cancel/retry state to the unchanged initiating surface.
3. The provider redirects only to the registered desktop callback. Electron validates the callback state and issuer, stores the refreshable account credential with the platform credential store, and publishes sanitized signed-in state to the renderer.
4. Electron focuses the existing window and consumes the pending intent exactly once. The renderer dynamically imports cloud-app's platform-neutral hosted contributions. Every contribution call must be present in the reviewed hosted-operation manifest; typed Electron handlers attach the account credential and return decoded Client/Protocol or typed stream results, never the token.
5. Account, WorkGraph, Documents, Billing, and Create Cloud Workspace render inside the signed desktop composition. Browser/mobile clients render the same hosted contracts through cloud-app's browser entry.

Terminal states: signed desktop with hosted contributions active and the initiating action resumed once; canceled/timed-out OAuth with the original surface and nonsecret draft intact; explicit sign-out with hosted state cleared and local state unchanged; passive expiry behind Sign in again; rejected callback for wrong state, issuer, scheme, host, or replay; explicit hosted feature error from its existing owner.

### Flow 3 — Signed-desktop machine remote access

1. The local renderer asks Electron to enable remote access for the machine and confirms the machine-wide scope.
2. Electron starts Host Connector in enrollment mode. For a new link the connector generates the host keypair; for a restart Electron decrypts it from protected storage and transfers it over the one-use private bootstrap channel. The connector returns a fresh signed proof and retains the private key only in memory.
3. Electron sends that proof through its authenticated Hosted Server client. Hosted Server binds the host key to the signed principal and records one machine enrollment; Host Connector receives only the enrollment descriptor and machine-scoped authorization result.
4. Host Connector obtains the complete authoritative local inventory through its loopback grant, reconciles that full set with Hosted Server, receives the Relay URL plus explicit registration mode, and uses the current Workspace Runtime host-tunnel implementation.
5. Inventory changes trigger another full-set authority reconcile. Bun mode updates one multi-workspace registration; Cloudflare mode adds or removes existing per-workspace room tunnels.
6. Signed clients obtain short-lived per-workspace Runtime Access Tokens from Hosted Server. Their Runtime HTTP/SSE/WebSocket calls go directly to Workspace Relay, which authorizes each request and forwards it through Host Connector to the appropriate laptop Workspace Runtime. Hosted Server remains the authority and Relay resolver, not the Runtime byte proxy.
7. A tunnel loss starts Host Connector's fresh-authorization/backoff loop; clients independently park queries, reacquire access, resume/refetch canonical events, and reattach live resources without repeating prompt admission.

Terminal states: machine online with its current inventory; enrollment confirmation canceled with local work unchanged; account authorization or host proof rejected; machine reconnecting or offline; paused/revoked with renewal denied and tunnel closed; automatic reconnect using the same host identity, a fresh inventory, and new short-lived grants.

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
5. If the profile contains the retired plaintext host identity or legacy links, those sharing records are removed and the desktop shows the one-time Re-enrollment required explanation; it does not adopt or retry them.

Terminal states: existing local data visible; legacy Remote Access requiring fresh enrollment; a canonical migration error when a real durable-data schema migration is required; no empty replacement store caused by package-relative path drift.

### Flow 6 — Independent product build

1. A build starts from one product's package manifest and declared entrypoint.
2. The source-closure guard walks transitive value imports, including static re-exports and string-literal dynamic imports.
3. The build emits a machine-readable module/chunk manifest.
4. The artifact guard evaluates the emitted closure and a real entrypoint smoke runs.

Terminal states: build and smoke succeed using only the declared product closure; the first undeclared or cross-product edge fails with its shortest import chain.

### Flow 7 — Structural packaged-desktop acceptance

1. Desktop's normal macOS package path consumes the same fingerprinted local app and local-server entries used by development and production build.
2. Electron-builder includes the local boundary manifests, declared native modules, desktop main/preload/renderer outputs, explicit harness launch assets, Host Connector, and separately fingerprinted optional account/hosted-contribution chunks.
3. The packaged-resource checker inventories the app bundle, rejects undeclared resources, and verifies that optional signed chunks have no edge from the unsigned renderer entry.
4. The unsigned app launches, reaches local server health, renderer readiness, local route gates, and PTY first output, then exits cleanly with no account adapter, hosted contribution, Host Connector, or harness process/module load.
5. A signed-mode smoke activates the account adapter with a fixture OAuth callback, proves the exhaustive operation-handler manifest, lazy-loads the hosted contribution entry, performs representative unary and streaming operations through IPC, signs out, and returns to usable local mode without restarting local-server.
6. Native credential lanes separately package and exercise the Electron account boundary on macOS, Windows, and protected-storage Linux; Linux `basic_text` is refused while unsigned local launch remains usable.

Terminal states: structural package acceptance with machine-readable inventory and smoke evidence; an actionable entry-fingerprint mismatch; the first forbidden/undeclared resource; or the exact readiness/shutdown gate that failed. The same accepted artifact then enters the Release Qualification Gate below.

## Open Questions

### Resolved During Planning

- **Does `@claxedo/app` move directories?** No. `packages/claxedo-app` remains the directory for the local/shared app package, matching the established vocabulary. The hosted browser product is added at `packages/claxedo-cloud-app`.
- **Must U5, U6, or U7 be executed separately first?** No. Units 2–4 include the exact enabling behavior this package split requires, and the later extraction units depend on those units inside this document.
- **Does hosted Node split from workerd?** No. Both remain runtimes of `@claxedo/server` and continue to share the hosted app composition.
- **Does desktop keep account auth?** Yes, as an optional Electron-main adapter. OAuth still uses the system browser, but the validated callback and refreshable session return to Electron. Local-server, renderer JavaScript, and Host Connector never receive the credential.
- **What does "signed desktop" mean after the split?** The local renderer and local execution path remain unchanged, while Electron supplies a tokenless account port and lazy hosted contributions. If remote access is enabled, the signed account establishes one host-key enrollment covering all current and future local workspaces on that machine.
- **How do web/mobile clients reach a machine workspace?** Host Connector reconciles the machine's complete canonical inventory into per-workspace hosted links. Hosted Server authorizes the signed client and mints short-lived access to one of those workspaces; Workspace Relay routes it through the laptop's outbound machine tunnel to the matching Workspace Runtime.
- **What happens after a connection loss?** Host Connector reacquires host authorization, rereads the complete inventory, and replaces the machine tunnel registration. Each client separately reacquires runtime access, resumes canonical events from its cursor or refetches after a gap, and reattaches live resources by ID. Transport recovery never repeats a prompt.
- **Does sharing upload or fail over the local working tree to cloud compute?** The laptop remains authoritative and remote clients see host-offline when it is unavailable. Cloud VM creation is a separate explicit hosted flow.
- **Does unsigned local mode provision sandbox VMs?** No. Create Cloud Workspace first activates desktop sign-in, then lazy-loads the signed hosted workspace contribution. Browser/mobile clients use cloud-app.
- **Can local-server import shared helpers from server?** No runtime edge is allowed. Workspace-owned contracts move to Workspace Runtime; local HTTP/config/credential behavior moves with local-server; hosted behavior remains with server.
- **Can cloud-app import app source through aliases?** No. It depends on the public `@claxedo/app` composition and component contracts, so a package build validates the boundary.
- **Where is final package-resource acceptance?** Unit 12 establishes source/build/package artifact guards, verifies Host Connector and account/hosted contributions remain optional, and runs structural unsigned plus signed-activation package smokes. This document's final Release Qualification Gate owns resource trimming, unsigned memory cohorts, signed activation measurement, harness cohorts, and performance evidence.

### Implementation-Level Degrees of Freedom

- **Local-server file layout:** use `src/server.ts` and `src/main.ts` as the public composition/process seams; place Workspace Runtime adaptation under `src/workspace`, local profile and credentials under `src/config` and `src/credentials`, and HTTP/network enforcement under `src/http`. Keep a helper inline unless it represents one of those independent boundaries or has multiple consumers.
- **Contribution contract:** `product-contributions.ts` is the single registry contract. It exposes the local default set and accepts one platform-neutral hosted contribution set after account activation; WorkGraph and Documents remain lazy members of that hosted set. Cloud-app's browser entry and desktop signed mode supply different identity ports to the same contribution producer. Implementation may refine internal type names without adding a second capability registry.
- **Boundary manifest:** each build emits normalized JSON containing the production entry, module IDs, output chunks, and static/dynamic edges. Unit 12 owns the deterministic normalizer and gives the same JSON to desktop's build contract and the Release Qualification Gate.

## Implementation Units

### Phase A — Establish the authoritative boundaries

- [x] **Unit 1: Freeze the desktop-local, self-hosted, and hosted product contracts before moving source** — *landed except the release measurement baseline*

**Status (2026-08-08):** Route-family table plus local/hosted/self-hosted contract tests, the self-hosted launch-path contract, app-side local/cloud boundary guards with shortest-chain reporting, the desktop product-mode matrix, `docs/tech-docs/desktop-hosted-operation-matrix.md` with its inventory gate, `docs/tech-docs/remote-access-inventory-limits.md`, and the host-tunnel registration characterization are all green.

**Not done:** the immutable clean-`dev` release measurement baseline (five-run fresh-idle / active-harness / post-session-idle desktop cohorts, the five browser flows, and the per-harness numeric ceilings). It needs a packaged Electron build and multi-hour cohort runs on a quiet machine, and it gates only the final Release Qualification Gate — not Units 2–12. The inventory-limit derivation found that the plan's proposed constants do not close: 256 workspaces at 256-byte IDs and labels encode to 133.25 KiB against a 128 KiB cap, so the display-label bound drops to 128 bytes (101.25 KiB, 26.75 KiB headroom). Unit 6 must freeze the adjusted set.

**Goal:** Capture the approved local and hosted route, workflow, dependency, and persistence behavior so each later move has a discriminating gate.

**Requirements:** U8-R6, U8-R8, U8-R9, U8-R12, U8-R14, U8-R15, U8-R17, U8-R18, U8-R20, U8-R21, U8-R22, U8-R23, U8-R24

**Dependencies:** None

**Files:**

- Create: `packages/claxedo-server/src/deployments/local/local-product-contract.test.ts`
- Create: `packages/claxedo-server/src/deployments/hosted-shared/hosted-product-contract.test.ts`
- Create: `packages/claxedo-server/src/deployments/local/self-hosted-product-contract.test.ts`
- Create: `packages/claxedo-server/scripts/self-hosted-entry-contract.test.ts`
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
- Create: `docs/tech-docs/desktop-hosted-operation-matrix.md`
- Create: `packages/claxedo-app/src/architecture/hosted-operation-inventory.test.ts`
- Create: `docs/tech-docs/remote-access-inventory-limits.md`
- Modify: `packages/claxedo-desktop/scripts/measure-idle-memory.ts`
- Create or complete: `packages/claxedo-desktop/scripts/measure-lifecycle-performance.ts`
- Modify: `packages/claxedo-app/perf-harness/src/cli.ts`
- Modify: `packages/claxedo-app/perf-harness/src/browser-runner.ts`
- Modify: `packages/claxedo-app/perf-harness/src/report.ts`
- Modify: `packages/claxedo-app/perf-harness/src/storage.ts`
- Modify: `packages/claxedo-app/perf-harness/src/types.ts`

**Approach:**

- Record the target local route-family allowlist and map each family to its current producer: health/bootstrap, local config/provider/credentials, Workspace Runtime proxy/HTTP/SSE, project/file/diff/PTY/process/session, and diagnostics hooks that are part of the local contract.
- Before Unit 2 changes composition, capture the immutable clean-current-`dev` release baseline with a fresh temporary profile: five-run fresh-idle, active-harness, and post-session-idle desktop cohorts after the fixed sixty-second settle; all five existing real-app browser flows in baseline position; and desktop health, store-only session list, provider first use, PTY first output, cold/warm/idle-restart harness, active-workload, event-loop, CPU, and GC samples. Record commit, production build fingerprint, tool/Electron/harness versions, OS/architecture, machine/thermal state, raw samples, and every correctness gate. Define numeric active-memory/latency ceilings per supported harness in this committed baseline contract before Phase B; the final gate may not loosen them after seeing candidate results.
- Record the hosted route and journey set from `createHostedApp`, including auth, authority, remote sandbox, relay, WorkGraph, Documents, billing, connections, channels, and wakes.
- Record the self-hosted contract independently from the desktop-local contract: default package `dev`/`start`, Docker `CMD`, `src/index.ts` exports, static SPA mount, embedded auth, SQLite authority, JWKS and Relay resolver/signers, local execution, WorkGraph, Documents, channels, signed central routes, profile/data roots, startup/shutdown, and the self-hosted deployment-mode guard. Capture which routes come from the shared hosted core and which are self-hosted Node adapters so Unit 7 can recompose rather than copy the 1,700-line app.
- Record canonical profile/data locations and prove that the current local entry reads a fixture profile containing workspace, session, provider, and credential metadata.
- Record the four-mode product matrix: unsigned local, linked user-hosted, unsigned sandbox-VM destination, and signed cloud VM. Pin identity location, compute location, required processes, remote reachability, offline behavior, and laptop dependency for each.
- Inventory every current authenticated call reachable from the hosted contribution candidates before defining `AccountPort`. `desktop-hosted-operation-matrix.md` records feature owner, stable operation ID, fixed Hosted Server method/path template, generated request/result schema, unary/SSE/WebSocket/upload transport, cancellation, retry/idempotency, browser adapter, Electron-main handler, and whether Runtime traffic instead bypasses the account port for Workspace Relay. `hosted-operation-inventory.test.ts` fails when a hosted contribution imports or calls an authenticated operation missing from the matrix. The matrix must explicitly cover account/org, workspace list/create/lifecycle, user-hosted connection mint/refresh, repository/integration, provisioning events, WorkGraph, Documents, billing, and connections; it may conclude that an existing operation cannot be platform-neutral, which blocks Unit 9 until that operation gets a typed broker contract.
- Characterize the current user-hosted host-link/tunnel/Relay contract before moving it: Hosted Server connection mint, the absence of `directRuntimeUrl` for user-hosted connections, Runtime Access Token verification and role enforcement, authenticated target/revocation resolution, Relay Host Token replacement of client auth, local host-token verification, Bun multi-workspace registration replacement, Cloudflare one-workspace room admission, exponential reconnect, dead-socket watchdog, client reconnecting state, and cursored Runtime-event replay. Record the target Electron account, host-key enrollment, valid-empty inventory, deletion reconciliation, and explicit registration mode as deltas owned by Unit 6; Unit 1 does not assert those new behaviors against the current producer.
- Record evidence for the bounded full-inventory protocol in `remote-access-inventory-limits.md`: observed repository/fixture inventory distributions, encoded worst-case snapshot size, Convex/SQLite transaction cost, Bun registration cost, Cloudflare recovery load at concurrency 1/4/8/16, chosen headroom, and the UI behavior when a bound is crossed. The initial implementation targets 256 workspaces, 256 UTF-8 bytes per ID/label, 128 KiB encoded, and eight concurrent Cloudflare reconnects; if the evidence does not leave at least 4× headroom over the largest supported profile or violates Relay recovery SLOs, Unit 6 must adjust the shared bounded constants before freezing them.
- Make local/cloud source-graph fixtures discriminating by injecting a representative forbidden edge and asserting that the scanner reports the shortest path.
- Preserve the current public URL and event shapes; the tests characterize ownership and behavior, not current file location.

**Execution note:** Add characterization coverage before moving either composition root.

**Patterns to follow:**

- `packages/claxedo-server/src/deployments/hosted-workerd/worker.import-graph.test.ts`
- `packages/claxedo-app/src/architecture/import-graph.guard.test.ts`
- `packages/claxedo-desktop/scripts/contract.test.ts`

**Test scenarios:**

- **Happy path:** unsigned local app exposes every approved local route family and a local session/list/PTY fixture completes without hosted services.
- **Measurement:** the clean baseline produces complete machine-readable desktop/browser records from temporary profiles, all correctness gates pass, and a second parser/fixture run proves missing samples or metadata fail closed. Generated evidence is retained outside the product diff under the declared artifact location.
- **Happy path:** hosted app exposes the existing signed hosted route families and its web journey reaches cloud workspace, WorkGraph, and Documents fixtures.
- **Happy path:** the current self-hosted entry boots from the package default and Docker entry, serves its static SPA plus signed control-plane/local-execution contract, and persists authority/runtime data in a temporary SQLite profile.
- **Edge case:** a fixture profile created through the current entry is opened through the characterized path with the same workspace and session IDs.
- **Error path:** a local source fixture importing Clerk or WorkGraph fails and prints the import chain.
- **Error path:** a hosted source fixture importing an Electron/desktop module fails and prints the import chain.
- **Integration:** desktop boot reaches renderer ready, route gates, and PTY first output through the current entry; this becomes the comparison gate for Unit 11.
- **Integration:** self-hosted `createApp` exposes the characterized hosted-core and Node-adapter route inventories once each; this becomes the parity oracle for Unit 7's `createSelfHostedApp`.
- **Integration:** user-hosted control traffic crosses signed client → Hosted Server for list and connection mint, while Runtime bytes cross signed client → Relay → laptop runtime. Assert that the user-hosted connection has no direct laptop URL and that cloud traffic follows the corresponding Relay → sandbox runtime path.
- **Integration:** the current account-bearing producer enumerates and publishes its current non-empty local workspace set, and the test records its present registration and reconnect behavior without claiming the new host-key enrollment, valid-empty, deletion-reconciliation, or cross-runtime supervision semantics. Unit 6 owns the target two-workspace enrollment, add-third, remove-one, reconnect-to-remaining-set, and no-duplicate-prompt assertions for both Bun and Cloudflare fixtures.
- **Integration:** every authenticated hosted call reachable from the current signed browser entry appears exactly once in the hosted-operation matrix with its real transport semantics; injecting an unlisted call or falsely classifying SSE/upload/WebSocket as unary fails the inventory gate.
- **Capacity:** the inventory/reconnect evidence records the selected bounds and user-visible over-limit behavior; chosen constants pass adapter transaction and both Relay-runtime recovery drills with the documented headroom.

**Verification:** The contract tests fail when any required route is removed, any forbidden product edge is injected, or the profile root changes; they pass against the pre-move composition.

- [x] **Unit 2: Establish hosted-only WorkGraph and Documents contributions** — *landed except hydration pruning and the server-side Documents move*

**Status (2026-08-08):** Workspace Runtime has a dependency-neutral `WorkspaceRuntimeRouteContribution` seam and no longer depends on `@claxedo/workgraph`; the WorkGraph route producers live at `@claxedo/workgraph/runtime-adapter`; the hosted launcher passes them while the kit CLI and the desktop-local embedded runtime pass none; `self-hosted-capabilities.ts` keeps the single binary whole through an explicit capability factory on the create-app seam. On the app side the hosted surfaces moved to `hosted-content-surfaces.tsx` behind `app/composition/product-contributions.ts`, and the eager-surface guard now checks both directions. Evidence: the runtime CLI bundle drops 901.0kb → 867.2kb and `/api/workgraph/*` 404s on a runtime with no contribution.

**Not done:** (1) workbench hydration does not yet prune restored hosted surfaces against `availableContentTypes()` — it only bites once a genuinely local build exists in Unit 9, since both shipped builds currently set `authEnabled`; (2) server-side Documents route/database construction still mounts unconditionally in `createApp` — Unit 7 moves it with the self-hosted composition rather than splitting it across two mechanisms now.

**Goal:** Make WorkGraph and Documents explicit hosted capabilities whose code, routes, state, and lifecycle are absent from the unsigned renderer and server compositions before their packages split.

**Requirements:** U8-F1, U8-R1, U8-R2, U8-R3, U8-R4, U8-R5, U8-R6, U8-R8, U8-R15

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
- Modify: `packages/claxedo-server/src/deployments/local/main.ts`
- Create: `packages/claxedo-server/src/deployments/local/self-hosted-capabilities.ts`
- Create: `packages/claxedo-server/src/deployments/local/self-hosted-capabilities.test.ts`
- Modify: `packages/claxedo-server/src/deployments/hosted-shared/hosted-app.ts`
- Create: `packages/claxedo-server/src/deployments/local/hosted-capability-absence.test.ts`
- Modify: `packages/claxedo-server/src/deployments/hosted-shared/hosted-app.test.ts`
- Create: `packages/workspace-runtime/src/route-contribution.ts`
- Create: `packages/workspace-runtime/src/route-contribution.test.ts`
- Modify: `packages/workspace-runtime/src/server.ts`
- Modify: `packages/workspace-runtime/src/cli.ts`
- Modify: `packages/workspace-runtime/src/index.ts`
- Modify: `packages/workspace-runtime/src/routes.ts`
- Modify: `packages/workspace-runtime/src/routes/manifest.ts`
- Modify: `packages/workspace-runtime/src/public-api.test.ts`
- Modify: `packages/workspace-runtime/package.json`
- Move: `packages/workspace-runtime/src/routes/workgraph-connection-tools.ts` and its test to `packages/workgraph/src/runtime-adapter/workgraph-connection-tools.ts` and its test
- Move: `packages/workspace-runtime/src/routes/workgraph-run-tools.ts` and its test to `packages/workgraph/src/runtime-adapter/workgraph-run-tools.ts` and its test
- Create: `packages/workgraph/src/runtime-adapter/index.ts`
- Create: `packages/workgraph/src/runtime-adapter/index.test.ts`
- Modify: `packages/workgraph/package.json`
- Modify: `packages/claxedo-server/src/hosts/workspace-runtime/runtime-boot.ts`
- Modify: `packages/claxedo-server/src/hosts/workspace-runtime/runtime-boot.test.ts`
- Modify: `packages/claxedo-server/src/deployments/local/embedded-workspace-runtime.ts`
- Modify: `packages/claxedo-server/src/deployments/local/embedded-workspace-runtime.test.ts`

**Approach:**

- Define the single product-contribution registry consumed by app composition. Local registers the core session/terminal/provider/workspace contributions; hosted adds WorkGraph and Documents through named lazy contribution loaders.
- Convert WorkGraph and Documents surface registration, feature ports, routes, navigation, settings, and app integrations into hosted contributions. Dynamic imports begin at the hosted contribution entry rather than inside an otherwise local-owned module.
- Keep contribution IDs, route strings, content types, and persisted workbench payloads stable for the hosted product.
- During local state hydration, remove unavailable WorkGraph, workspace-WorkGraph, page, and pages-index content from content IDs, recency, pane selection, split snapshots, and route projection in one normalized state transition. Preserve local session and terminal content.
- Place server WorkGraph and Documents route/tool/database/timer/subscription construction behind the hosted composition root. The unsigned local composition constructs neither capability.
- Because `deployments/local/server.ts` currently serves both desktop-local and the live self-hosted product, give its create-app seam an explicit capability-contribution input in this unit. Desktop callers pass none. The current self-hosted `main.ts` passes one canonical `self-hosted-capabilities.ts` contribution containing its existing WorkGraph/Documents/runtime-adapter ownership, so Unit 2 is green without stripping those features from self-host. Unit 7 moves that contribution into the new self-hosted composition and deletes this old root; it is a live owner, not a compatibility wrapper.
- Remove Workspace Runtime's unconditional WorkGraph edge. Move its two WorkGraph route/tool producers and tests to the public `@claxedo/workgraph/runtime-adapter` subpath. Add one dependency-neutral `WorkspaceRuntimeRouteContribution` mount/dispose contract to Workspace Runtime; its default application and CLI mount no contributions and its package manifest/public API no longer depend on or export `@claxedo/workgraph` types. The hosted workspace-runtime launcher explicitly imports the WorkGraph adapter and passes it as a route contribution; the desktop-local embedded Runtime passes none. This keeps the canonical Runtime core while moving only hosted composition.
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
- **Integration:** Workspace Runtime and local-server build with `packages/workgraph` source unavailable and expose no `/api/workgraph/*` route; the hosted Runtime launcher builds with `@claxedo/workgraph/runtime-adapter`, mounts the existing routes once, and disposes them on shutdown.

**Verification:** WorkGraph and Documents are fully hosted contributions, unavailable persisted surfaces normalize safely, and local renderer/server production graphs do not reach their implementations.

- [~] **Unit 3: Complete Workspace Runtime harness lifecycle ownership** — *shared contract landed and adopted by every adapter that had a lifecycle; two behaviour changes remain*

**Status (2026-08-08):** `agent-sdk-runtime/src/harnesses/shared/process-lifecycle.ts` owns single-flight startup, generation ownership, activity leases, the idle grace, bounded stop, and parent-loss cleanup, with 21 tests against a deterministic child fixture. Its idle half is extracted as `createIdleReaper` and used by both callers. Adopted: **OpenCode** moved onto the full lifecycle, fixing a cached rejected startup promise that bricked the adapter until process restart and closing an unauthenticated spawned server (`opencode serve` ran with no `OPENCODE_SERVER_PASSWORD`; each launch now gets a fresh credential through the environment, attached at the single request seam, redacted from logs). **ACP** moved onto the idle reaper and leases its prompt turn, so a turn inside one long silent tool call can no longer be reaped mid-flight. **Codex** gained single-flight start, fixing a race that spawned two app-servers and orphaned one.

**Scope correction:** this unit assumes five adapters each need migrating. In fact only OpenCode and ACP owned idle-kill lifecycles — Codex holds its app-server for the driver's life, Claude uses a never-yielding prompt stream, and Pi runs in-process, so there is nothing to migrate for those three.

**Codex idle reaping landed (2026-08-08).** The driver held its app-server for its OWN lifetime rather than the session's, so one turn at breakfast left the child resident at midnight. It now uses the shared idle reaper with a 30s desktop default matching OpenCode. Two things stop a mid-turn reap and neither is redundant: the turn's lease covers the window from spawn to thread registration, and the reap refuses while any thread is live, because a thread can outlive its turn. The timeout is read at construction rather than module load — reading it at import made it silently unsettable by a host that configures its environment after loading the module, which is how the first version of the test passed while reaping nothing.

**Not done:** `deployments/local/server.ts` still holds process-lifecycle responsibility that should become host policy only. Parent-loss cleanup is NOT outstanding: it is already handled a layer up by `watchDesktopParent` in the desktop server child and by the runtime server's `signals` option, so installing it per-adapter would create a second shutdown path racing the host's.

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

- [x] **Unit 4: Make session inventory and canonical events runtime-owned** — *landed*

**Status (2026-08-08):** Landed. Generic session listing is store-only, mutations write through, and the compatibility stream no longer starts a harness.

**How the discovery problem was solved.** Store-only listing was blocked by one thing: it made the explicit `?harness=` path the only route by which sessions predating the store are imported, and nothing triggered that route. The answer was not an app-side affordance but a durable per-directory marker in the store (`session_inventory_import`). The first generic list for a directory runs the full discovery fan-out and records the import; every later list is store-only. That is correct for two distinct populations — a profile upgrading onto the store, and a fresh profile sitting on an existing harness install — and it costs one harness start per directory, once, ever, instead of one or two on every launch.

The measured blocker count went 6 -> 3 -> 2 -> 1 -> 0. The last one, `embedded workspace runtime > reconciles persisted runtime titles when rebuilding a workspace after restart`, passes unchanged: that test starts from a fresh store with a populated upstream, which is exactly the first-import case. The cross-runner isolation test was re-expressed rather than deleted — name the harness that owns the session, then a plain list includes it, which is what the test is actually about.

**The second harness start was one layer over.** `/global/event` proxied to OpenCode by calling `ensure()` plus `getRequestFn()`, and the embedded runtime opens that stream at every workspace rebuild. So even with listing fixed, a desktop configured for OpenCode still spawned it at launch to serve an event stream. The proxy now attaches only to an already-live transport (`transportLive()`), and takes an activity lease for the stream's life (`acquireRequestFn()`) so the idle reaper cannot cut it mid-delivery. When nothing is running the runtime's own hub answers, which is the authoritative producer of canonical events anyway.

**Not done:** the store-backed status projection and the per-transition canonical event for status specifically. Create, update, title, and delete each write through and publish; status transitions still flow only through the live adapter stream, which is correct while a session is running but leaves a restarted shell showing the last persisted status rather than a reconciled one. That is a visible-but-minor staleness, not a harness start, so it does not gate the split.

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

- [~] **Unit 5: Extract the authoritative desktop-local server package** — *preconditions measured and three of the widest edges cut; the package itself is not created*

**Status (2026-08-08): the unit's real shape was measured, and it is not "move `deployments/local/server.ts`".**

`packages/claxedo-server/src/platform/governance/source-closure.ts` walks the transitive first-party graph from an entry, stopping at package boundaries, and reports the SHORTEST chain to a forbidden module. Measured against `src/deployments/local/main.ts`: **259 first-party modules, 42 packages** — including `convex`, `better-auth`, `drizzle-orm`, `@claxedo/workgraph`, `@claxedo/channels`, `@claxedo/connections`, `@claxedo/wakes`, and `@claxedo/sandbox-manager`, all reachable from an unsigned desktop that never signs in. That number is the problem statement U8 has been describing in prose.

**Almost every heavy hosted dependency enters at depth 2, directly from `deployments/local/server.ts`.** That file is the mixed composition Unit 8 deletes, and it stays alive for self-hosted until Units 7-8. So Unit 5 is not a move of that file: it is a NEW composition that mounts only the twelve `local-server`-owned route families from Unit 1's table, over producers that no longer reach hosted surface. The union of those producers' closures was **177 modules / 36 packages / 43 hosted modules reached**.

**Three edges carried most of the hosted surface, and each was cut at the module that owns the choice:**

1. `platform/db/db.ts` imported the whole-product schema barrel as a VALUE, so opening the local SQLite database reached connections, channels, documents, and sandbox table definitions. Drizzle needs that object only for `db.query.*`, which nothing in the repository uses — every call site passes its table explicitly — so it is now a type-only import.
2. `workspace/store/index.ts` imported the supervisor lease table to decide whether an in-flight CLOUD workspace is visible yet, so reading local workspace inventory reached cloud sandbox leasing. `configureWorkspaceSupervisor` now installs the reader; a composition with no supervisor has no cloud workspaces and needs none.
3. `agent-config/index.ts` selected its own runtime workspace authority (Convex when a URL was set), so reading agent configuration reached the cloud control plane. The composition supplies it now.

A fourth edge was one concept repeated four times. Runtime dispatch, agent-config fanout, the agent-extension routes, and `agent-config/extension-support.ts` each imported `workspace/supervisor` to say one of six things — a stream is holding this sandbox open, it closed, it was used, tell the provider it is still wanted, push runtime config, push an extension snapshot. `workspace/supervisor-port.ts` names exactly that surface and the supervisor installs itself into it from `configureWorkspaceSupervisor`. A composition with no supervisor has no cloud sandboxes, so every call is correctly a no-op — and because that no-op would otherwise be silent (a live stream's sandbox reaped mid-response, nothing in the logs), a contract test asserts the composition installs it.

**Result, and this is the precondition Unit 5 was actually blocked on.** The union of the thirteen producers a local-only composition would mount:

| | modules | packages | hosted modules reached |
|---|---|---|---|
| before | 177 | 36 | 43 |
| after | 106 | 29 | 4 |

The four remaining are `sandbox/network/*`, which IS the `network-policy` route family this plan's own table assigns to local-server. No connections, channels, documents, Convex authority, cloud sandbox store, sandbox driver route, or WorkGraph host module is reachable from any of them. All 3264 `claxedo-server` tests stay green, and `local-entry-closure.test.ts` pins the union so a regression names itself.

**The closure walker distinguishes declared from executable edges.** A type-only import is erased whole: no module loads and no capability becomes reachable, so counting it would report hosted surface in a build that cannot execute a line of it. An INLINE type specifier (`import { type A, B }`) is NOT erased and is kept. `runtimeOnly: true` selects the executable graph.

One edge is deliberately left: `src/workspace/routes/index.ts` mounts `connections/routes/connection-routes.ts` and `sandbox/routes/sandbox-driver-routes.ts` beside the local workspace routes. That is a route-composition barrel, not a producer — the local composition mounts its own families, so it resolves by construction and is excluded from the pinned union.

**A structural fact this plan did not account for, measured 2026-08-08.** Of the 106 modules a local composition reaches, **44 are local-only and 62 are also reachable from the hosted entries** (`deployments/hosted-node/index.ts`, `deployments/hosted-workerd/worker.ts`). The 62 are a shared core — `platform/runtime/lib/{log,paths,bus,lazy,strings}`, `platform/http/*`, `platform/db/{db,repair}`, `platform/auth/*`, the whole credential engine and its backends, `session/meta/*`, `session/harness/*`, `agent-config/index.ts`, `workspace/store` — and none of them is a hosted capability implementation, which the pinned test asserts separately.

This changes the unit's shape. The dependency table forbids `@claxedo/local-server` from depending on `@claxedo/server`, and this plan's Unit 5 file list implies local-server writes its own `config/profile.ts`, `credentials/service.ts`, and `http/security.ts`. At 62 modules that is not a few new files: it would put two implementations of logging, paths, HTTP error shape, database access, credential storage, and session metadata in the repository — the exact duplication this codebase's engineering rules forbid.

**The resolution is ordering, not duplication: the shared core moves DOWN before local-server is created.** A package both products depend on takes the 62; `@claxedo/local-server` then takes the 44 and depends on it. `@claxedo/server` keeps its hosted capabilities and depends on the same core. That inserts one prerequisite unit ahead of Unit 5 and leaves every later unit's contract unchanged, because no product package gains a dependency on another product package.

The alternative — `@claxedo/server` depending on `@claxedo/local-server` for the shared 62 — is rejected: it inverts the table, and it would put local composition in the workerd closure, which `worker.import-graph.test.ts` already forbids by name.

**`@claxedo/server-core` exists and two slices have landed (2026-08-08).** It holds no product capability and makes no composition decisions; it exports source subpaths rather than a build artifact, so there is no dist to keep in sync while the remaining slices move.

| slice | modules | desktop-local entry closure |
|---|---|---|
| start | — | 254 modules |
| `platform/runtime/lib/{log,paths,bus,lazy,strings}` | 5 + 1 test | 249 modules |
| `platform/{errors,http,auth}/*`, `platform/runtime/region` | 11 + 5 tests | 238 modules |
| `platform/db/{db,repair}` behind a composition-supplied journal | 2 + 1 test | 237 modules, 39 packages |
| the suite migration journal | — | — |
| credential engine, `session/meta/*`, `sandbox/network/policy`, `workspace/store` | 18 + 6 tests | **219 modules** |

The local producer union is now **70 modules / 25 packages**, from 177 / 36 when the unit started.

**A runtime-only closure is the right gate for CAPABILITY and the wrong basis for a MOVE.** It skips type-only edges, so the credentials slice left `credentials/types.ts` and `workspace/store` behind and did not compile. Measure a move against the declared closure; measure a boundary against the executable one.

**Tests and helpers do not follow their subject automatically.** `workspace/store/index.test.ts` came back to `claxedo-server` because it drives the supervisor's lease store, which stays. `assert-helpers.ts` came back because a dozen product tests use it and nothing in the core does. `platform/auth/auth.test.ts` never left, because it imports `authority/deployment-mode`. Each is a judgment about what the test is really about.

Two things worth carrying forward from the moves. First, `vi.mock` specifiers name modules by PATH, so a rename that misses them leaves a test mocking a module nobody imports — silently, and green. Four had to be rewritten by hand in the first slice. Second, the repository's own governance gates caught their stale registries in the second slice (`architecture-ownership.ts` still claimed `platform/auth/authority.ts`; `src/authority/README.md` still pointed a reader at two moved files), which is exactly what they exist for.

**`platform/db` landed on the second attempt, and the first attempt is why.** The schema-barrel question resolved cleanly — `src/README.md` names it as the migration generator's input, so it stays with the product tables, and `ClaxedoDB.Client` is now schema-less because drizzle's generic only types `db.query.*`, which nothing uses. That removed the last `platform/db` edge to product surface.

The first attempt failed on something only doing it revealed: `db.ts` resolved its migration journal from its own `import.meta.dirname`, and that journal is DDL — documents, credentials, connections, channels — so moving the engine dragged schema with it, and four migration tests plus the desktop bundler reached the journal by relative path. That move was reverted rather than half-landed.

The second attempt made the journal a **composition input**. `claxedo-server/src/platform/db/index.ts` names it and re-exports the engine, so every consumer configures it by importing; forty-five import sites moved to that wrapper. `configureClaxedoMigrations` has NO default and an empty or missing journal throws, because the alternative is the failure this product has already shipped: zero migrations applied, a working handle returned, and every query failing later somewhere else for a reason its stack trace does not name. Two tests cover it — one asserts a fresh profile actually has its tables, the other that the engine alone refuses to open.

**The journal now lives in the core, and the suite reading was adopted.** Both server products open the same `claxedo.db` file format, so its schema is the suite's. Splitting it would split a persisted contract for no gain — every existing desktop profile already holds every table — while carrying it costs a local build a handful of leaf table definitions and no capability. The `*.sql.ts` definitions it is generated FROM stay with their domains: those are a generation-time input, the journal is the runtime artifact, and the platform-boundary gate's sanctioned barrel inversion is untouched. What was, before that decision, 45 blocked shared modules  has since largely moved. Two readings were weighed:

- The journal is *product* schema, so local-server gets its own with only local tables. This splits a persisted contract: existing desktop profiles already hold every table, so the split either drops them (data loss) or leaves them (no benefit).
- The journal is the *suite's* schema, because both products open the same `claxedo.db` file format. It moves to `@claxedo/server-core` with the `*.sql.ts` leaves it is generated from — pure drizzle table definitions, no logic, no capability.

**Not done:** `packages/claxedo-local-server` does not exist. Roughly 27 shared modules remain — `agent-config/index.ts`, `session/harness/*`, `hosts/agent-extensions/*`, `hosts/workspace-runtime/{env,runtime-config}`, `opencode/{auth,engine}`, `authority/{services,adapters/sqlite}`, `workspace/http/sandbox-target-fetch`, `credentials/operations/*`. `opencode/engine` deserves scrutiny before it moves: the embedded engine is a harness capability, not a neutral primitive, and `credentials/engine-bridge.ts` — its only real consumer — is already a lazy dynamic import and can stay with the product behind a port.

The 44/62 split is pinned by `local-entry-closure.test.ts`, so the move set cannot drift.

**Goal:** Create `@claxedo/local-server` and move the Unit 4 local composition, local services, and embedded Workspace Runtime wiring into its independent source and manifest closure.

**Requirements:** U8-R1, U8-R5, U8-R6, U8-R9, U8-R15, U8-R16, U8-R17, U8-R20, U8-R21, U8-R22, U8-R23, U8-R24

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
- Create: `packages/claxedo-local-server/src/self-hosted-execution.ts`
- Create: `packages/claxedo-local-server/src/self-hosted-execution.test.ts`
- Create: `packages/claxedo-local-server/scripts/build.ts`
- Create: `packages/claxedo-local-server/src/config/profile.ts`
- Create: `packages/claxedo-local-server/src/credentials/service.ts`
- Create: `packages/claxedo-local-server/src/http/security.ts`
- Move: `packages/claxedo-server/src/deployments/local/local-product-contract.test.ts` to `packages/claxedo-local-server/src/local-product-contract.test.ts`
- Move: `packages/claxedo-server/src/deployments/local/embedded-workspace-runtime.ts` to `packages/claxedo-local-server/src/workspace/embedded-workspace-runtime.ts`
- Move: `packages/claxedo-server/src/deployments/local/embedded-workspace-runtime.test.ts` to `packages/claxedo-local-server/src/workspace/embedded-workspace-runtime.test.ts`
- Modify: `packages/claxedo-server/src/deployments/local/server.ts`
- Move: `packages/claxedo-server/src/deployments/local/server-workspace-pty-proxy.ts` to `packages/claxedo-local-server/src/workspace/server-workspace-pty-proxy.ts`
- Move and adapt: `packages/claxedo-server/src/workspace/runtime-dispatch/internals.ts` to `packages/claxedo-local-server/src/workspace/runtime-dispatch/internals.ts`
- Move and adapt: `packages/claxedo-server/src/workspace/runtime-dispatch/middleware.ts` to `packages/claxedo-local-server/src/workspace/runtime-dispatch/middleware.ts`
- Modify: `packages/claxedo-server/src/agent-config/extension-support.ts`
- Modify: `packages/claxedo-server/src/agent-config/fanout.ts`
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
- Export the narrow local-execution composition adapter as the explicit `@claxedo/local-server/self-hosted-execution` subpath. It provides embedded Workspace Runtime creation, local route mount, lifecycle/shutdown, profile-root binding, and Unit 2's generic optional Runtime route-contribution input, and exposes no desktop/Electron or WorkGraph-specific contract. Desktop passes no hosted contribution. Unit 7 consumes this public subpath and supplies `@claxedo/workgraph/runtime-adapter` while recomposing self-hosted Node; cloud Node and workerd entry graphs never import local-server.
- Retarget agent-extension fanout and Runtime-dispatch callers to the new canonical local execution adapter or a lower Workspace Runtime contract. Leave no import of `deployments/local/embedded-workspace-runtime.ts` after the move.
- Rewire the desktop server child, development preparation, production bundle input, and boot smoke to the new package in the same unit. The renderer remains on its existing entry until Unit 11, but no desktop process references the old server-local entry when this unit completes. Retarget the still-live self-hosted `deployments/local/server.ts` directly to `@claxedo/local-server/self-hosted-execution` before deleting the embedded Runtime, PTY, and dispatch sources it currently imports. This is a caller migration to the new canonical producer, not a forwarding module; Unit 7 replaces the self-hosted composition root in the next dependent slice.
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
- **Integration:** the current self-hosted entry remains green after the moved local sources are removed because it calls the new public local-execution subpath directly; repository search finds no old embedded Runtime/PTY/dispatch import.

**Verification:** `@claxedo/local-server` typechecks, builds, and passes its route/runtime integration suite using only its manifest closure; no runtime import points at `packages/claxedo-server`.

- [ ] **Unit 6: Establish Electron account auth and extract Host Connector authority**

**Goal:** Make Electron main the sole desktop account-credential owner, then preserve machine-wide remote access to every canonical local workspace—including automatic inventory changes and reconnection—while confining initial account authorization to that Electron producer and all continuing publication authority to the enrolled host key.

**Requirements:** U8-R2, U8-R7, U8-R16, U8-R17, U8-R19, U8-R20, U8-R21, U8-R22, U8-R23, U8-R24

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
- Create: `packages/claxedo-host-connector/src/enrollment/state.ts`
- Create: `packages/claxedo-host-connector/src/enrollment/state.test.ts`
- Create: `packages/claxedo-host-connector/src/inventory/local-inventory-client.ts`
- Create: `packages/claxedo-host-connector/src/inventory/local-inventory-client.test.ts`
- Create: `packages/claxedo-host-connector/src/inventory/reconciler.ts`
- Create: `packages/claxedo-host-connector/src/inventory/reconciler.test.ts`
- Create: `packages/claxedo-host-connector/src/inventory/limits.ts`
- Create: `packages/claxedo-host-connector/src/inventory/limits.test.ts`
- Move and narrow: `packages/claxedo-server/src/deployments/local/remote-access-service.ts` to `packages/claxedo-host-connector/src/enrollment/share-service.ts`
- Move and adapt ownership: `packages/claxedo-server/src/deployments/local/remote-access-service.test.ts` to `packages/claxedo-host-connector/src/enrollment/share-service.test.ts`
- Extract key generation/proof and nonsecret host identity from `packages/claxedo-server/src/workspace/local-host.ts` to `packages/claxedo-host-connector/src/identity/local-host.ts`; do not move its plaintext private-key persistence
- Create: `packages/claxedo-host-connector/src/identity/local-host.test.ts`
- Extract the machine-registration functions from `packages/claxedo-server/src/user-hosted-tunnel.ts` to `packages/claxedo-host-connector/src/tunnel/user-hosted-machine-tunnel.ts`
- Split the machine-registration cases from `packages/claxedo-server/src/user-hosted-tunnel.test.ts` into `packages/claxedo-host-connector/src/tunnel/user-hosted-machine-tunnel.test.ts`
- Create: `packages/claxedo-host-connector/src/tunnel/user-hosted-machine-tunnel.e2e.test.ts`
- Move and rename the surviving server-owned workspace/sandbox producer: `packages/claxedo-server/src/user-hosted-tunnel.ts` to `packages/claxedo-server/src/workspace-runtime-host-tunnel.ts`
- Move the surviving workspace/sandbox test cases: `packages/claxedo-server/src/user-hosted-tunnel.test.ts` to `packages/claxedo-server/src/workspace-runtime-host-tunnel.test.ts`
- Move: `packages/claxedo-server/src/user-hosted-tunnel.e2e.test.ts` to `packages/claxedo-server/src/workspace-runtime-host-tunnel.e2e.test.ts`
- Modify: `packages/claxedo-server/src/index.ts`
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
- Create: `convex/hostEnrollments.ts`
- Create: `convex/host-enrollments.policy.test.ts`
- Create: `convex/hostEnrollmentChallenges.ts`
- Create: `convex/host-enrollment-challenges.policy.test.ts`
- Create: `convex/hostEnrollmentRequests.ts`
- Create: `convex/host-enrollment-requests.policy.test.ts`
- Modify: `convex/localHostLinks.ts`
- Modify: `convex/local-host-links.policy.test.ts`
- Create: `convex/retireLegacyHostLinks.ts`
- Create: `convex/retire-legacy-host-links.policy.test.ts`
- Create: `packages/claxedo-server/scripts/maintenance/cutover-host-enrollments.ts`
- Create: `packages/claxedo-server/scripts/maintenance/tests/cutover-host-enrollments.test.ts`
- Create: `docs/tech-docs/host-enrollment-hard-cut-runbook.md`
- Modify: `packages/claxedo-server/package.json`
- Modify: `convex/orgs.ts`
- Modify: `convex/org-deletion.policy.test.ts`
- Modify: `convex/schema.ts`
- Modify: `packages/claxedo-server/src/routes/hosted/workspace.ts`
- Modify: `packages/claxedo-server/src/routes/hosted/workspace.test.ts`
- Modify: `packages/claxedo-server/src/deployments/hosted-shared/hosted-app.ts`
- Modify: `packages/claxedo-server/src/deployments/hosted-shared/hosted-app.test.ts`
- Modify: `packages/claxedo-server/src/workspace/routes/index.ts`
- Modify: `packages/claxedo-server/src/workspace/routes/index.test.ts`
- Delete after new callers move: `packages/claxedo-server/src/workspace/local-host-link.ts`
- Create: `packages/claxedo-app/src/platform/account/account-port.ts`
- Create: `packages/claxedo-app/src/platform/account/account-port.test.ts`
- Create: `packages/claxedo-app/src/platform/account/browser-account-adapter.ts`
- Create: `packages/claxedo-app/src/platform/account/browser-account-adapter.test.ts`
- Modify: `packages/claxedo-app/src/platform/auth/identity-provider.tsx`
- Modify: `packages/claxedo-app/src/platform/auth/identity-provider.test.ts`
- Modify: `packages/claxedo-app/src/platform/auth/principal-provider.tsx`
- Modify: `packages/claxedo-app/src/platform/auth/principal-provider.vitest.tsx`
- Modify: `packages/claxedo-app/src/app/entry/app.tsx`
- Modify: `packages/claxedo-app/src/app/entry/index.tsx`
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
- Modify: `packages/claxedo-desktop/electron-builder.config.ts`
- Create: `packages/claxedo-desktop/docs/account-auth.md`
- Modify: `packages/claxedo-desktop/src/main/index.ts`
- Create: `packages/claxedo-desktop/src/main/account-auth.ts`
- Create: `packages/claxedo-desktop/src/main/account-auth.test.ts`
- Create: `packages/claxedo-desktop/src/main/account-credentials.ts`
- Create: `packages/claxedo-desktop/src/main/account-credentials.test.ts`
- Create: `packages/claxedo-desktop/src/main/account-callback.ts`
- Create: `packages/claxedo-desktop/src/main/account-callback.test.ts`
- Create: `packages/claxedo-desktop/src/main/optional-session-markers.ts`
- Create: `packages/claxedo-desktop/src/main/optional-session-markers.test.ts`
- Create: `packages/claxedo-desktop/src/main/host-connector.ts`
- Create: `packages/claxedo-desktop/src/main/host-connector.test.ts`
- Create: `packages/claxedo-desktop/src/main/host-connector-credentials.ts`
- Create: `packages/claxedo-desktop/src/main/host-connector-credentials.test.ts`
- Create: `packages/claxedo-desktop/src/main/retire-legacy-host-identity.test.ts`
- Modify: `packages/claxedo-desktop/src/main/ipc.ts`
- Create: `packages/claxedo-desktop/src/main/hosted-operation-handlers.ts`
- Create: `packages/claxedo-desktop/src/main/hosted-operation-handlers.test.ts`
- Modify: `packages/claxedo-desktop/src/preload/index.ts`
- Modify: `packages/claxedo-desktop/src/preload/types.ts`
- Modify: `packages/claxedo-desktop/src/renderer/index.tsx`
- Modify: `packages/claxedo-desktop/src/main/navigation-guard.ts`
- Modify: `packages/claxedo-desktop/src/main/navigation-guard.test.ts`
- Modify: `.github/workflows/release-claxedo.yml`
- Delete after every caller moves: `packages/claxedo-server/src/workspace/local-host.ts`
- Modify: `package.json`
- Modify: `bun.lock`

**Approach:**

- Establish the prerequisite desktop account producer in this unit, before Host Connector becomes canonical. Implement Electron main as an OAuth public client using system-browser Authorization Code plus PKCE. Register and validate the fixed channel callbacks `claxedo://auth/callback`, `claxedo-beta://auth/callback`, and `claxedo-dev://auth/callback`; bind state, nonce, PKCE verifier, exact scheme/authority/path, expiry, and one-use consumption. Preserve the initiating intent and nonsecret form draft in Electron main for one attempt, expose waiting/cancel/retry state, focus the existing primary window on callback, and consume the intent exactly once only after the account state is committed. Store refreshable credentials with Electron `safeStorage` under the existing profile root only when OS-backed encryption is available; reject Electron's unprotected Linux `basic_text` backend and surface signed mode as unavailable before OAuth while leaving unsigned local work usable. Expose only sanitized account state plus schema-named operations through preload/IPC. The renderer, local-server, and Host Connector receive no token, OAuth code, cookie, generic fetch, arbitrary URL, or arbitrary method/path.
- Keep unsigned startup structurally lazy. Core Electron main reads only dependency-neutral, nonsecret presence markers for an encrypted account record and active host enrollment. With neither marker it never imports `account-auth.ts`, decrypts credentials, resolves cloud-app, or resolves/spawns Host Connector. Sign-in dynamically imports the account adapter; a valid account marker restores it; an active-enrollment marker independently starts Host Connector after local-server health. A stale/corrupt marker produces the explicit account or connector recovery state and is never treated as credential material.
- Write account credentials and host private keys as separate ciphertext records using restrictive owner-only permissions, atomic temp-file/rename semantics, and redacted corruption handling. Platform contract tests cover macOS Keychain, Windows DPAPI, supported Linux secret-store backends, locked/unavailable stores, and explicit rejection of `basic_text`; no failure path logs or preserves plaintext.
- Put every account and Host Connector IPC handler behind one central caller guard. It binds `event.sender` and `event.senderFrame` to the current primary `BrowserWindow`, its main frame, and the trusted renderer origin. Reject subframes, auxiliary or DevTools WebContents, destroyed/replaced frames, and navigated/untrusted origins before parsing or executing the named operation. Add hostile-sender tests for sign-in, enrollment, authenticated hosted calls, pause, resume, and revoke.
- Create app's tokenless `AccountPort` here and bind the current renderer to it for sign-in, sign-out, account display, and the one named `enrollCurrentMachine` operation needed by this unit. Refactor shared `Principal`/`PrincipalProvider` now to carry sanitized identity/roles only and remove `getToken`; the current hosted browser entry converts its existing `auth-session.ts` producer through `browser-account-adapter.ts`, while desktop binds Electron IPC. This is the canonical desktop account path immediately; remove every renderer-owned desktop bearer/session use in the same cut. Unit 10 moves the browser adapter with browser auth into cloud-app, and Unit 11 extends this same Electron port for hosted feature activation; neither creates a second auth path.
- Add one authenticated host-enrollment operation to Hosted Server. The request carries the signed principal from normal account middleware, a client-generated enrollment request ID, a fixed machine-wide scope, sanitized host metadata, the host public key, a server-issued nonce, and a host signature over the complete enrollment payload. Hosted Server verifies account/organization authority and host-key proof before atomically creating or rotating the canonical `host_enrollments` record. The request ID supports an exact retry after a lost response only when owner, organization, host key, scope, and payload match; conflicting reuse fails. Enrollment is a single desktop-authenticated operation; continuing challenge, renewal, reconcile, pause, and resume operations authenticate the enrolled host key directly.
- For a new enrollment Host Connector generates the host keypair; for a restart Electron loads/decrypts the already-enrolled key. In both cases the connector receives key material only through its private bootstrap channel and retains it in memory while producing enrollment or renewal proofs. Electron's account adapter attaches account authorization to initial enrollment and returns only the enrollment descriptor; Electron remains the sole persistent private-key owner. The connector then obtains a short-lived host-session credential bound to that machine generation. Renewal starts with a server nonce, requires a signature by the enrolled host private key, and succeeds only for the active generation.
- Do not migrate the existing plaintext private JWK or its old account-link authority. On first upgraded start, remove the superseded plaintext private-key record through the canonical profile path, retain unrelated local profile/workspace/session data, show the one-time **Re-enrollment required** state, and require the signed user to complete one fresh machine enrollment. Tests prove the old host ID/key cannot renew, reconcile, or mint a tunnel after the cut.
- Define `host_enrollments` as the machine authority record with a stable `host_id`, `owner_subject`, optional `org_id`, host `public_key`, literal machine-wide `scope`, monotonic `generation`, `status`, latest accepted `inventory_version`, configured Relay assignment/registration mode, and audit timestamps. The server response returns the signed/bound descriptor and nonsecret routing metadata, not an account credential. Keep one active owner/key binding per host ID; replaying the same enrollment request ID and payload is an idempotent exact retry, while key, owner, organization, scope, or payload conflicts require an explicit rotation path.
- Persist exact-retry state in a bounded `host_enrollment_requests` record keyed by owner plus request ID, containing a canonical enrollment-transcript digest, resulting host ID/generation, terminal status, nonsecret response descriptor, and expiry. The first transaction consumes the challenge and records the result atomically. A matching retry returns only that original result while its generation remains active; it never rotates, resumes, reparents, or resurrects paused/revoked enrollment. Conflicting or expired reuse fails. Enrollment/renewal challenges expire after two minutes, consumed challenge evidence is pruned after ten minutes, and exact-retry results expire after twenty-four hours; Convex and SQLite implement and test the same bounds. These are one canonical policy constants, not adapter defaults.
- Keep `local_host_links` as the canonical per-workspace materialization for listing, roles, presence, and Relay target resolution. A host-key-authorized full-set reconcile against `host_enrollments` atomically upserts current workspace links, leaves unchanged links stable, and revokes links omitted from the new snapshot. The machine enrollment is the sole authority for publishing future workspaces; per-workspace links do not become a competing approval source.
- Make each final `local_host_links` row require its machine enrollment ID and generation. Because backward compatibility is not required, run a bounded pre-cut Convex maintenance mutation that deletes all legacy unenrolled links, their old attestation challenges, and their outstanding Runtime/Host token authority before the final schema deploy; the old service is not kept serving during this maintenance window. SQLite rebuilds the link table into the required final shape and discards legacy link rows. Do not delete workspace records or their separate collaborator role grants. Users re-enable Remote Access once through the new machine enrollment; reconciliation uses the same stable workspace IDs, so prior explicit collaborator roles become reachable again after the new link appears. No legacy link, host ID, plaintext key, token, or route is adopted into the new authority.
- Implement the destructive hosted cut as one resumable, audited runbook rather than ad hoc mutations. `maintenance:cutover-host-enrollments -- <preflight|enter-maintenance|retire-legacy|verify-retirement|verify-new|exit-maintenance>` records a deployment/SHA-bound cutover ID and refuses out-of-order phases. `enter-maintenance` blocks legacy host-link creation/renewal/connection mint and drains/closes host publication before `retire-legacy`; operator confirmation proves no old Hosted Server or Relay writer remains. `retire-legacy` invokes the bounded Convex mutation and is the irreversible point. The final schema/functions, matching Hosted Server/Relay artifacts, and desktop release all use the same reviewed SHA. Before retirement, failure exits maintenance and leaves the old deployment unchanged. After retirement, rollback to the old authority is forbidden: keep Remote Access in maintenance, leave local and cloud-VM work available, fix or redeploy the new SHA forward, rerun `verify-retirement` idempotently, then require `verify-new` to prove zero-workspace enrollment plus Bun and Cloudflare add/remove/reconnect before `exit-maintenance`. SQLite performs the equivalent hard cut transactionally on first new self-hosted boot and preserves a pre-migration backup according to the existing SQLite migration policy, but never starts the old composition or restores legacy sharing authority.
- Implement enrollment, reconcile, and active-link operations through the shared Workspace Authority contract with both Convex and SQLite adapters. Add a dedicated `host_enrollment_challenges` authority record for one-use enrollment and renewal nonces, keyed by challenge ID and bound to host ID, owner/organization, enrollment generation, purpose, nonce digest, expiry, and consumed time. It deliberately has no `workspace_id`: a machine with zero workspaces must be able to enroll and renew without inventing a workspace. Keep the existing required-workspace `host_attestation_challenges` contract unchanged for workspace-scoped attestation; do not make its `workspace_id` nullable or synthesize a placeholder workspace.
- Add the new challenge and idempotency-request tables to Convex schema/functions and SQLite's canonical schema initialization. Because both contain bounded protocol state and this is a hard cut, the SQLite migration creates the new tables and indexes without backfilling old challenge rows; all new enrollment/renewal callers switch to the new producers in this unit. Hosted workerd and self-operated hosted Node then share enrollment generation, full-set replacement, challenge consumption, exact retry, pause, revocation, and concurrency semantics through the same authority contract.
- Revalidate the enrollment owner's current account status, organization membership, and applicable Remote Access entitlement before issuing a host challenge and before renewal, reconciliation, resume, or signed-client connection mint. Account deletion, organization removal/deletion, or entitlement revocation atomically rotates the enrollment generation, revokes its materialized links and active token authority, and denies further host-key challenges. Add both new enrollment tables to Convex's exhaustive organization-deletion accounting and purge enrollment requests, unused/consumed challenges, links, and token state by indexed owner/org lookup. The SQLite embedded-auth adapter applies the equivalent local identity-status check and cascade.
- Require the local renderer's explicit machine-wide confirmation before Electron requests enrollment. The renderer supplies no public key, signature, workspace inventory, path, credential, or target; it invokes a typed `enrollCurrentMachine` operation and displays the sanitized host label and scope supplied by Electron.
- Apply endpoint-specific abuse controls: per-account, per-host, and per-peer limits on enrollment and renewal; fixed-size/shape validation before signature or authority work; one-use enrollment/renewal nonces; maximum inventory size and metadata limits; and audit events for enrollment, reconciliation, pause, resume, sign-out pause, and revoke. Unknown host/generation failures use constant-shape responses. Live machine/workspace display metadata is deleted with enrollment/account/org deletion and replaced on full reconciliation rather than accumulated. Retained audit rows contain opaque host/workspace IDs or transcript digests, event type, outcome, and timestamps—not workspace labels, filesystem paths, repository URLs, provider data, or account credentials—and follow the existing server audit-retention policy.
- Define one shared inventory limit contract consumed by connector and both authority adapters, using Unit 1's capacity evidence: initially at most 256 workspaces per machine, each stable ID and UTF-8 display label at most 256 bytes, and the canonical encoded snapshot at most 128 KiB. Reject the whole snapshot before any write when a bound is exceeded; never truncate it into an authoritative partial set. Keep the last server-accepted link set and healthy tunnels active, but intersect local forwarding with the new canonical inventory so a locally deleted workspace cannot be reached; do not publish the over-limit additions. Remote Access shows **Inventory limit exceeded (257/256)** with the accepted/reachable counts and requires the owner to remove/archive workspaces or Stop Sharing before full reconciliation resumes. Limit Cloudflare workspace-room restoration to eight concurrent connection attempts per host while retaining per-handle exponential backoff. Boundary tests prove 0/1/256 acceptance, 257 rejection without host-wide outage or partial authority write, byte—not code-point—label limits, encoded-size rejection, safe forwarding intersection, and atomic Convex/SQLite behavior. Adjust the constants before acceptance if Unit 1's documented headroom/load gate fails.
- Read local inventory only from Unit 5's connector contract. On connector start and every inventory-change event, obtain a successful complete snapshot and submit it with host-key proof plus the previous accepted reconcile version. Hosted Server accepts one atomic generation/version transition, ensures the enrolling account owns every materialized link, preserves explicit collaborator roles for unchanged workspaces, and returns the exact authorized workspace set. Concurrent or out-of-order snapshots cannot resurrect a removed workspace. A failed or partial read is retried and never submitted as an empty set.
- Extract only `startUserHostedMachineTunnel`, `stopUserHostedMachineTunnel`, and `hasUserHostedMachineTunnel` into Host Connector and keep `startWorkspaceRelayHostTunnel` as the lower transport producer. The existing `startUserHostedWorkspaceTunnel`, workspace store, supervisor, sandbox-manager lease, per-workspace release, and their E2E coverage remain canonical server behavior under `workspace-runtime-host-tunnel.ts`; retarget `src/index.ts` and every server caller directly in this unit. The connector closure contains none of those server branches, and its only local target comes from Unit 5's connector endpoint.
- Extend `ControlPlaneRelay`, `WorkspaceRouteOptions`, and the existing host-tunnel credential/Relay assignment response with a configured registration mode. Hosted composition validates exactly `machine-multiplexed` or `workspace-room` and fails startup on a missing/unknown production value. In `machine-multiplexed` mode, reuse the current Bun behavior: one handle registers the full accepted set and `updateRegistration` replaces that set. In `workspace-room` mode, reuse the current Cloudflare behavior: maintain one existing host-tunnel handle per accepted workspace, adding and closing handles as inventory changes. The Host Tunnel Token scope matches the registration carried by each handle.
- Preserve `workspace-relay-host-tunnel.ts` recovery behavior: socket errors, closes, failed upgrades, and three missed heartbeat intervals enter its exponential backoff with jitter and cap; `tokenProvider` is called before every connection attempt; local HTTP/WebSocket channels close with the lost tunnel; authenticated registration updates use the existing protocol. Extend `updateRegistration` so its normalized workspace set also replaces the set used by `tunnelUrl` on the next reconnect. Host Connector keeps the latest successful inventory reconciled and applies that set before transport reconnect; connector process start and laptop wake force a complete inventory read before publication.
- Preserve the signed client's independent recovery behavior. A disconnected client marks the workspace reconnecting, parks transport-dependent queries, mints fresh runtime access after Relay can route the host again, and restores the workspace connection by canonical workspace ID. Runtime-event SSE resumes from `Last-Event-ID`; a replay-gap response causes an authoritative refetch. Long-lived resources such as PTYs reattach by canonical resource ID when supported. Transport recovery observes an already-admitted prompt through events or refetch and never submits that prompt again.
- Preserve the existing Relay security boundary rather than introducing another tunnel protocol. Hosted Server continues to mint Runtime Access Tokens and Host Tunnel Tokens. Relay continues to verify token signature/claims, current revocation, role/path permission, target identity, and host presence; it continues to replace client auth with a Relay Host Token and strip dangerous headers/cookies. Workspace Runtime continues to verify that Relay Host Token plus the workspace ID and Relay marker. Pause/revoke closes the supervised connector and denies new or refreshed access under the existing token-establishment lifetime semantics.
- Use the connector-only local-server contract from Unit 5. Electron supplies the per-launch local connector credential, fixed loopback base, and decrypted host key over a one-use inherited OS pipe/handle created before child launch, peer-bound to that exact child, omitted from arguments/environment/logs, and closed after an acknowledged bootstrap. Host Connector derives each target from that bootstrap and an inventory-present workspace ID; Relay messages can select an allowed Runtime path but can never supply a host, port, origin, or upstream URL. The route-ownership and current-inventory gates run before every forward.
- Start Host Connector for explicit enrollment or whenever a durable machine enrollment is active and unpaused, including when its inventory is empty. A linked restart restores host identity and reconnects without account authorization unless the machine generation is revoked. Desktop sign-out first requests a host-key-authorized durable pause, closes every tunnel, and calls the identity provider's session-revocation/logout operation before deleting the local account record. If Hosted Server or the identity provider is unreachable, persist separate encrypted pending-pause and pending-session-revocation records, mark the UI locally signed out, deny those credentials to every normal account operation, and use them only in the isolated retry path before final deletion. A copied/replayed refresh credential is rejected after successful remote revocation. The enrolled owner must sign in before resume. Electron restarts a crashed connector under its bounded child policy; quitting desktop intentionally leaves the host offline until next launch.
- Rewire the existing machine-wide Remote Access setup/settings surface through the Host Connector port and typed Electron IPC. The workspace menu may copy/open a particular workspace link, but it does not own per-workspace enrollment. Unit 9 preserves this port while establishing the final local app entry.
- Keep each working tree and Workspace Runtime store authoritative. Enrollment and reconciliation create authority/presence metadata and transport routes; they do not copy working trees or create cloud VMs.

**Execution note:** Start with the tokenless account-port and Electron OAuth/callback/credential tests, then add signed-account plus one-use host-proof enrollment and cross-workspace denial tests before moving the current host identity and tunnel producer. The unit is not complete until the old desktop account-bearing remote-access producer is deleted.

**Patterns to follow:**

- `packages/claxedo-app/src/platform/auth/auth-session.ts`
- `packages/claxedo-server/src/platform/auth/authority.ts`
- `packages/claxedo-server/src/routes/hosted/workspace.ts`
- `convex/localHostLinks.ts`
- `packages/claxedo-server/src/deployments/local/remote-access-service.ts`
- `packages/workspace-runtime/src/workspace-relay-host-tunnel.ts`
- `packages/workspace-runtime/src/routes/runtime-events.ts`
- `packages/claxedo-server/src/user-hosted-tunnel.e2e.test.ts`
- `packages/claxedo-server/src/workspace/runtime-dispatch/shared-workspace-endpoint.ts`

**Test scenarios:**

- **Happy path:** a signed Electron account request plus host-key proof creates one machine enrollment without exposing the bearer to Host Connector; a two-workspace snapshot creates two per-workspace links and successful remote health for both through Bun's one multi-workspace registration and, in the Cloudflare fixture, two existing workspace-room tunnel handles.
- **Happy path:** system-browser sign-in returns through the exact channel callback, stores the refreshable credential in Electron main, exposes sanitized account state through `AccountPort`, focuses the existing window, resumes exactly the initiating enrollment/cloud/sign-in intent once, and can enroll the machine without placing credential material in renderer IPC or the connector bootstrap.
- **Happy path:** creating a third local workspace triggers a full-set reconcile without another account-authorized enrollment and updates the configured existing transport shape; deleting one removes its hosted link and Bun registration entry or closes its Cloudflare room handle while the other two remain reachable.
- **Happy path:** after Bun registration changes from `[A, B]` to `[A]`, a forced socket reconnect upgrades with only `A` in the URL and token scope before replaying the authenticated registration update; `B` never appears transiently in Relay presence.
- **Happy path:** the enrolling account can list and open every reconciled current or future workspace automatically; a separately invited collaborator can open only the workspaces where that collaborator has a role, and that role survives unchanged inventory reconciliations.
- **Happy path:** an enrolled restart with zero, one, or many local workspaces starts one connector child, rotates short-lived machine credentials, reconciles the current snapshot, and reconnects without loading the account credential into Host Connector.
- **Edge case:** a profile with no optional-session markers completes empty-shell boot without resolving account-auth, cloud-app, or Host Connector modules; account and enrollment markers activate only their respective optional closures.
- **Happy path:** a zero-workspace machine receives and consumes an enrollment/renewal challenge from `host_enrollment_challenges`; no workspace row, placeholder workspace ID, or nullable workspace attestation is created.
- **Edge case:** concurrent full snapshots use reconcile version/generation checks so a late `[A, B]` update cannot resurrect B after `[A]` was accepted.
- **Edge case:** two machines owned by the same user maintain separate enrollments, inventories, presence, and tunnels; a workspace-ID collision is rejected rather than reparented.
- **Edge case:** concurrent authenticated enrollment requests using the same nonce consume it exactly once and produce one active enrollment generation; an exact retry with the same request ID returns that result, while conflicting request-ID reuse fails.
- **Edge case:** an exact enrollment retry returns the recorded nonsecret result only while its original generation remains active; expiry, pause, revoke, owner/org change, or transcript mismatch cannot rotate or resurrect it.
- **Error path:** unsigned, expired-account, wrong-organization, replayed-nonce, wrong-host-key, malformed-scope, or generation-mismatched enrollment fails without creating or rotating share state.
- **Error path:** a callback with the wrong channel scheme, authority, path, state, nonce, PKCE verifier, identity, expiry, or replay status fails without changing the Electron account or host-enrollment state.
- **Error path:** unavailable or non-OS-backed `safeStorage`, a locked credential store, decrypt failure, or corrupted credential record disables sign-in/resume and never persists plaintext; unsigned local work still boots and the user receives a specific recovery state.
- **Edge case:** macOS Keychain, Windows DPAPI, and protected-storage Linux fixtures complete sign-in/store/restart/refresh/sign-out; Linux `basic_text` is rejected before browser launch. The account surface describes the missing protected-store requirement without disabling local mode.
- **Edge case:** canceled, expired, replayed, or rejected OAuth restores the initiating surface and nonsecret draft without enrolling, provisioning, or registering hosted contributions; Retry creates a new state/nonce/PKCE attempt rather than reusing the old one.
- **Error path:** offline sign-out closes publication and makes local account operations unavailable immediately, retains only isolated encrypted pending revocation state, and completes both host pause and provider session revocation before deleting that state when connectivity returns.
- **Error path:** a consumed, expired, wrong-purpose, wrong-host, wrong-owner, or wrong-generation machine challenge fails atomically in both Convex and SQLite adapters; it cannot be replayed through the workspace-attestation path.
- **Error path:** excessive enrollment or renewal traffic is rate-limited before expensive signature/authority work; unknown host and generation failures reveal no account or workspace existence.
- **Error path:** laptop sleep/network loss enters reconnecting, presence expires to offline within sixty seconds, and wake obtains fresh authorization plus a fresh full inventory before restoring access; no cloud fallback is provisioned.
- **Edge case:** one Cloudflare workspace-room handle disconnects while two remain open; the affected workspace reports reconnecting, the other two remain reachable, and the aggregate machine status is Reconnecting until the full accepted set is restored.
- **Edge case:** Hosted Server changes an enrollment's Relay assignment from `machine-multiplexed` to `workspace-room`, and back, on fresh authorization. Host Connector drains the old-mode handles, reconciles the current full inventory, opens only the new-mode handles, and never leaves duplicate presence or forwards through a stale assignment.
- **Error path:** a local inventory timeout or malformed/partial response never becomes `[]`, never revokes hosted links, and never opens a replacement tunnel until a successful complete snapshot is available; forwarding fails closed while local membership cannot be validated.
- **Error path:** paused/revoked/generation-mismatched machine authorization stops the reconnect loop in a terminal UI state; transient Relay, DNS, and token-mint failures continue bounded backoff.
- **Error path:** hosted production composition with an absent or unknown registration mode fails before issuing a Host Tunnel Token; a mode/Relay mismatch is caught by the existing Bun and Cloudflare host-admission fixture rather than retried as a generic network failure.
- **Security:** the host enrollment cannot call account, billing, cloud-create, WorkGraph, Documents, local config/provider/credential, or another workspace's runtime routes.
- **Security:** deleting/disabling the owner, removing organization membership, deleting the organization, or revoking the required entitlement invalidates challenges, enrollment generation, materialized links, connection mint, and connector renewal in both authority adapters.
- **Security:** a Relay-supplied absolute URL, alternate loopback port, encoded traversal, control-plane path, deleted/fabricated/cloud workspace ID, or ID absent from the current local snapshot is denied before local fetch.
- **Security:** pause closes the supervised connector immediately and rejects new or refreshed client authorization while preserving the generation for same-owner resume. Revoke increments the machine generation, removes the target from authority resolution, and requires a new enrollment. Both paths expire Relay presence under the existing heartbeat contract. Existing long-lived connection lifetime semantics remain exactly as characterized in Unit 1.
- **Security:** renderer state, enrollment confirmation UI, callback URLs, process listings, persisted nonsecret app state, IPC payload logs, and telemetry contain neither account bearer/refresh token, host private key, machine credential, nor tunnel token.
- **Security:** auxiliary windows, subframes, DevTools, replaced/navigated WebContents, and untrusted origins cannot invoke any account or Host Connector IPC operation; a different local process cannot attach to or replay the one-use connector bootstrap channel.
- **Privacy:** revoke, account deletion, and organization deletion remove live host/workspace display metadata; retained audit evidence contains only the declared opaque identifiers/digests and never inventory labels or paths.
- **Operations:** the hard-cut command rejects phase reordering, wrong SHA/environment, active old writers, and premature maintenance exit; pre-retirement abort is reversible, while post-retirement failure remains maintenance-only and can complete only by forward deploying/verifying the new authority.
- **Security:** the user-hosted connection response contains `relayUrl` and a scoped Runtime Access Token but no laptop or `directRuntimeUrl`; Relay rejects wrong workspace/host/role/revoked tokens, strips client authorization/cookies/dangerous headers, and Workspace Runtime rejects a missing or mismatched Relay Host Token, workspace header, or Relay marker.
- **Integration:** a signed web/mobile-shaped client lists and opens each authorized workspace on the enrolled machine through real Hosted Server, Relay, Host Connector, local-server, and Workspace Runtime; prompt execution starts the matching laptop harness and returns its stream.
- **Integration:** cut the machine tunnel during an active session, allow Host Connector to reconnect, and prove the client reacquires access, resumes events by cursor or full refetch, reattaches a live PTY by ID, and observes one prompt admission.

**Verification:** Desktop sign-in and machine enrollment use the single Electron-owned account producer; one account-authorized, host-key-proven enrollment continuously publishes the exact canonical local-workspace inventory through the configured existing Relay registration mode; signed Runtime traffic always traverses Workspace Relay; base unsigned launch has zero Host Connector process/module activity; account bearer tokens remain confined to Electron's protected account adapter and never enter renderer IPC payloads, Host Connector, local-server, environment variables, process arguments, or logs.

- [ ] **Unit 7: Recompose the self-hosted single-binary on the hosted control-plane core**

**Goal:** Preserve the live self-hosted Node product by extracting the signed control-plane route core from the cloud-hosted boot wrapper and replacing the mixed `deployments/local` composition with `createSelfHostedApp` plus the new public local-execution adapter.

**Requirements:** U8-R3, U8-R8, U8-R9, U8-R11, U8-R14, U8-R15, U8-R24

**Dependencies:** Units 1, 2, 5, and 6

**Files:**

- Create: `packages/claxedo-server/src/deployments/self-hosted-node/app.ts`
- Create: `packages/claxedo-server/src/deployments/self-hosted-node/app.test.ts`
- Create by extracting route assembly: `packages/claxedo-server/src/deployments/hosted-shared/signed-control-plane-app.ts`
- Create: `packages/claxedo-server/src/deployments/hosted-shared/signed-control-plane-app.test.ts`
- Modify: `packages/claxedo-server/src/deployments/hosted-shared/hosted-app.ts`
- Modify: `packages/claxedo-server/src/deployments/hosted-shared/hosted-app.test.ts`
- Move and adapt: `packages/claxedo-server/src/deployments/local/main.ts` to `packages/claxedo-server/src/deployments/self-hosted-node/index.ts`
- Move: `packages/claxedo-server/src/deployments/local/embedded-auth.ts` to `packages/claxedo-server/src/deployments/self-hosted-node/embedded-auth.ts`
- Move: `packages/claxedo-server/src/deployments/local/embedded-auth.test.ts` to `packages/claxedo-server/src/deployments/self-hosted-node/embedded-auth.test.ts`
- Move: `packages/claxedo-server/src/deployments/local/internal-relay-local.ts` to `packages/claxedo-server/src/deployments/self-hosted-node/internal-relay-node.ts`
- Move: `packages/claxedo-server/src/deployments/local/internal-relay-local.test.ts` to `packages/claxedo-server/src/deployments/self-hosted-node/internal-relay-node.test.ts`
- Move and adapt: `packages/claxedo-server/src/deployments/local/self-hosted-capabilities.ts` to `packages/claxedo-server/src/deployments/self-hosted-node/capabilities.ts`
- Move and adapt: `packages/claxedo-server/src/deployments/local/self-hosted-capabilities.test.ts` to `packages/claxedo-server/src/deployments/self-hosted-node/capabilities.test.ts`
- Move and adapt: `packages/claxedo-server/src/deployments/local/self-hosted-product-contract.test.ts` to `packages/claxedo-server/src/deployments/self-hosted-node/self-hosted-product-contract.test.ts`
- Modify: `packages/claxedo-server/package.json`
- Modify: `packages/claxedo-server/src/index.ts`
- Modify: `packages/claxedo-server/Dockerfile`
- Modify: `packages/claxedo-server/fly.toml`
- Modify: `packages/claxedo-server/scripts/self-hosted-entry-contract.test.ts`
- Modify: `packages/claxedo-server/scripts/smoke/documents-session-roundtrip.ts`
- Modify: `packages/claxedo-server/src/authority/services.test.ts`
- Modify: `packages/claxedo-server/src/authority/deployment-mode.ts`
- Modify: `packages/claxedo-server/src/authority/deployment-mode.test.ts`
- Modify: `packages/claxedo-server/src/authority/adapters/sqlite/workspace-authority.test.ts`
- Modify: `packages/claxedo-server/src/billing/invariants.test.ts`
- Modify: `packages/claxedo-server/src/channels/ingress.test.ts`
- Modify: `packages/claxedo-server/src/hosts/workgraph/composition/v2-reachability.test.ts`
- Modify: `packages/claxedo-server/src/platform/governance/frontend-api-contract.test.ts`
- Modify: `packages/claxedo-server/src/sandbox/routes/sandbox-driver-routes.contract.test.ts`
- Modify: `packages/claxedo-server/src/session/meta/bridge.test.ts`
- Modify: `packages/claxedo-server/src/tests/governance/codebase-shape.test.ts`
- Modify: `packages/claxedo-server/src/tests/integration/agent-lifecycle.integration.test.ts`
- Modify: `packages/claxedo-server/src/tests/integration/cloud-create-ui.integration.test.ts`
- Modify: `packages/claxedo-server/src/tests/integration/control-plane.integration.test.ts`
- Modify: `packages/claxedo-server/src/tests/integration/cors.integration.test.ts`
- Modify: `packages/claxedo-server/src/tests/integration/documents.integration.test.ts`
- Modify: `packages/claxedo-server/src/tests/integration/multi-agent.integration.test.ts`
- Modify: `packages/claxedo-server/src/tests/integration/real-acp-boot.integration.test.ts`
- Modify: `packages/claxedo-server/src/tests/integration/session-grouping.integration.test.ts`
- Create from Unit 1's separate self-hosted contract: `packages/claxedo-server/src/deployments/self-hosted-node/app.security-headers.test.ts`

**Approach:**

- Treat Unit 1's self-hosted contract as a separate product oracle. Extract only trust-neutral signed route assembly from `createHostedApp` into `createSignedControlPlaneApp`. `createHostedApp` retains and runs the current hosted deployment-mode, signed issuer, and hosted authority assertions before delegating. `createSelfHostedApp` runs a new explicit self-hosted posture assertion that allows the characterized SQLite authority and embedded auth combination, rejects cloud-only or missing adapters, then supplies Runtime/Relay token signers and resolver, the Unit 5 local-execution adapter configured with Unit 2's `@claxedo/workgraph/runtime-adapter`, local WorkGraph/Documents backends, channels, telemetry, and static cloud-app serving to the shared core.
- Give every route family one owner before mounting. Shared signed control-plane routes come from `createSignedControlPlaneApp`; local filesystem/session/PTY/provider/config routes come from the local-execution adapter; Node-only static assets, embedded auth, boot validation, and process lifecycle come from self-hosted Node. Add a composition contract that rejects duplicate route ownership rather than relying on Hono mount order.
- Keep the current self-host data roots, SQLite formats, environment variables, host/port defaults, static `CLAXEDO_APP_DIST_DIR` behavior, embedded-engine selection, shutdown bounds, and Docker health route. This unit changes composition ownership and entry paths, not the self-hosted product contract.
- Run a current-to-new upgrade fixture, not only a fresh restart fixture. Before deleting the old entry, the Unit 1 producer creates embedded-auth users/sessions, persisted signing material, SQLite workspace/role/hosted-authority rows, representative local execution/session state, configuration, and static-app settings through the current shipped `deployments/local` entry. Boot the built `deployments/self-hosted-node` entry against that exact data root, verify identity and authorization continuity plus every characterized route/local execution flow, mutate state, and verify it again after a second new-entry restart. This preserves current durable self-hosted data while still providing no compatibility entry, route, or old-binary support.
- Retarget tests according to the behavior they actually prove. `authority/services.test.ts`, `authority/deployment-mode.test.ts`, SQLite authority, channels ingress, local WorkGraph/Documents, session grouping, agent lifecycle, real ACP boot, cloud-create UI, control-plane, CORS, multi-agent, frontend API, and self-host governance tests use `createSelfHostedApp`. Runtime-neutral hosted route/security tests use `createHostedApp`. Desktop-local route/security tests have already moved to local-server in Unit 5. Source-text invariants point at the new authoritative composition rather than the deleted path.
- Change the package public entry to export `createSelfHostedApp` and its explicit self-hosted service composer. Update every repository caller in this unit; remove the old `createApp`, `createDefaultLocalControlPlaneServices`, and `deployments/local` public exports with no forwarding export or compatibility module.
- Point package `dev`/`start`, Docker `CMD`, Fly configuration, static cloud-app build input, and smoke scripts directly at `deployments/self-hosted-node`. The old launch/public entry ceases to exist in the same slice, so no deployment can silently keep running the mixed composition; the now-unreachable `deployments/local/server.ts` and empty directory are deleted under Unit 8's closure gate.

**Execution note:** Characterize the current self-hosted entry first, then land the new composition, all caller retargets, deployment rewiring, and removal of the old public entry as one green slice.

**Patterns to follow:**

- `packages/claxedo-server/src/deployments/hosted-shared/hosted-app.ts`
- `packages/claxedo-server/src/deployments/hosted-node/index.ts`
- `packages/claxedo-server/src/deployments/local/server.ts`
- `packages/claxedo-server/src/authority/services.test.ts`
- `packages/claxedo-server/Dockerfile`

**Test scenarios:**

- **Happy path:** the self-hosted app mounts each characterized hosted-core and self-hosted adapter route exactly once and preserves signed auth, local execution, WorkGraph, Documents, channels, Relay authority, and static SPA behavior.
- **Happy path:** package `dev`/`start` and the built Docker image boot the same `deployments/self-hosted-node` entry, pass health/mode checks, open a local workspace, and persist authority/runtime state across restart.
- **Happy path:** the current shipped self-hosted entry creates the full upgrade fixture, then the built new entry opens that same profile with the same user/session/signing/role/workspace identities, performs authorized local and signed operations, and survives a second restart. No export or old entry remains afterward.
- **Edge case:** self-hosted startup with zero workspaces still serves signed control-plane and static UI routes and can create its first local workspace through the canonical local-execution adapter.
- **Error path:** duplicate route ownership, missing SQLite/embedded-auth configuration, missing static bundle when configured, or missing local-execution adapter fails through the characterized explicit error path; no alternate composition starts.
- **Security:** signed route guards, JWKS, Runtime/Host token signers, Relay resolver credentials, CORS, credential-path redaction, and local loopback restrictions match the Unit 1 contract.
- **Integration:** every former import or source-text reference to `deployments/local/server` is either moved to local-server, retargeted to `createSelfHostedApp`, or retargeted to `createHostedApp`; repository search proves the file is dead so Unit 8 can delete it without another caller migration.

**Verification:** The self-hosted single-binary boots and passes its full characterized contract through `deployments/self-hosted-node`; all existing callers have explicit new owners; the old `createApp` public surface and entry path are absent.

- [ ] **Unit 8: Remove desktop-local ownership and enforce each server deployment closure**

**Goal:** Retain the shared control-plane core plus cloud Node, workerd, and self-hosted Node deployments in `@claxedo/server`, remove desktop-only composition ownership, and tighten each production entry graph to its declared adapters.

**Requirements:** U8-R3, U8-R5, U8-R8, U8-R11, U8-R14, U8-R15, U8-R17, U8-R20, U8-R21, U8-R22, U8-R23, U8-R24

**Dependencies:** Units 2, 5, 6, and 7

**Files:**

- Modify: `packages/claxedo-server/package.json`
- Modify: `packages/claxedo-server/src/index.ts`
- Modify: `packages/claxedo-server/src/deployments/hosted-shared/hosted-app.ts`
- Modify: `packages/claxedo-server/src/deployments/hosted-node/index.ts`
- Modify: `packages/claxedo-server/src/deployments/hosted-workerd/worker.ts`
- Modify: `packages/claxedo-server/src/deployments/hosted-workerd/worker.import-graph.test.ts`
- Modify: `packages/claxedo-server/src/deployments/hosted-shared/hosted-app.test.ts`
- Modify: `packages/claxedo-server/src/deployments/self-hosted-node/self-hosted-product-contract.test.ts`
- Modify: `packages/claxedo-server/wrangler.toml`
- Delete after consumers move: `packages/claxedo-server/src/deployments/local/server.ts`
- Delete after all listed sources move: `packages/claxedo-server/src/deployments/local/`

**Approach:**

- Keep `createSignedControlPlaneApp` as the shared route composition. Cloud Node/workerd reach it only through the strict `createHostedApp` wrapper; self-hosted Node reaches it only through `createSelfHostedApp` and its explicit SQLite/embedded-auth posture assertion.
- Keep signed self-operated auth and Relay-node adapters in `deployments/self-hosted-node`. Host enrollment authority remains in hosted routes, while the local connector client already moved in Unit 6.
- Keep Hosted Server's existing user-hosted responsibility intact: signed workspace list/open, `userHostedConnectionInfo` connection mint/refresh, Host Tunnel Token mint, and authenticated `/internal/relay/target` plus `/internal/relay/revocation`. Runtime request bodies and streams continue to enter Workspace Relay directly.
- Move every remaining desktop-local source reached from the deleted local entry into local-server. Unit 7 already retargeted self-hosted consumers. Unit completion requires deleting the empty `deployments/local` directory and rejecting the old path in source-graph/governance tests.
- Place shared workspace/session protocol contracts in their existing lower packages when both product compositions consume them; product-specific adapters stay with their product.
- Keep package `dev`/`start` on the new self-hosted entry and retain explicit cloud-hosted Node/workerd scripts. Desktop development no longer starts server through this manifest.
- Retain and strengthen the Worker import-graph gate so the hosted split does not weaken workerd safety.

**Patterns to follow:**

- `packages/claxedo-server/src/deployments/hosted-shared/hosted-app.ts`
- `packages/claxedo-server/src/deployments/hosted-workerd/worker.import-graph.test.ts`
- `docs/plans/2026-08-02-001-refactor-claxedo-server-organization-plan.md` for the hosted trust/runtime vocabulary

**Test scenarios:**

- **Happy path:** cloud Node, workerd, and self-hosted Node mount the same hosted route contract with their deployment-specific adapters.
- **Happy path:** signed auth, authority, remote sandbox, relay, WorkGraph, Documents, billing, connections, channels, and wakes remain reachable through existing hosted tests.
- **Happy path:** authenticated host enrollment, presence, revocation, user-hosted workspace listing, and runtime-connection mint remain reachable in all supported control-plane deployments.
- **Security:** a user-hosted connection mint checks workspace role and active host link, returns `relayUrl` plus a scoped Runtime Access Token, and contains no `directRuntimeUrl`, laptop address, or Host Connector credential; Relay resolver endpoints accept only the existing resolver trust credential.
- **Edge case:** self-hosted Node retains signed-hosted behavior and optional static cloud-app serving while its explicit local-execution adapter remains absent from cloud Node and workerd entry graphs.
- **Error path:** hosted boot without required signed-auth/authority configuration fails closed through the existing hosted boot assertions.
- **Error path:** workerd import graph rejects Node-only and local-server modules.
- **Integration:** cloud Node/workerd build and test with local-server source excluded; the self-hosted entry separately builds with the declared local-execution adapter and passes the self-hosted contract.

**Verification:** `@claxedo/server` has no `deployments/local` or desktop composition entry; cloud Node/workerd closures exclude local-server, and self-hosted Node alone declares and exercises the local-execution adapter.

- [ ] **Unit 9: Define the local app composition and public hosted contribution seam**

**Goal:** Establish `@claxedo/app`'s local production entry and the smallest public contract cloud-app needs before the hosted implementation files move in Unit 10.

**Requirements:** U8-R2, U8-R4, U8-R5, U8-R6, U8-R7, U8-R12, U8-R15, U8-R16, U8-R17, U8-R18, U8-R20, U8-R21, U8-R22, U8-R23

**Dependencies:** Units 1, 2, and 6

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
- Modify: `packages/claxedo-app/src/platform/account/account-port.ts`
- Modify: `packages/claxedo-app/src/platform/account/account-port.test.ts`
- Create: `packages/claxedo-app/src/platform/account/hosted-operations.ts`
- Create: `packages/claxedo-app/src/platform/account/hosted-operations.test.ts`
- Create: `packages/claxedo-app/src/platform/account/hosted-contribution-port.ts`
- Create: `packages/claxedo-app/src/platform/account/hosted-contribution-port.test.ts`
- Modify: `packages/claxedo-app/src/platform/auth/identity-provider.tsx`
- Modify: `packages/claxedo-app/src/platform/auth/identity-provider.test.ts`
- Modify: `packages/claxedo-app/src/platform/auth/principal-provider.tsx`
- Modify: `packages/claxedo-app/src/platform/auth/principal-provider.vitest.tsx`
- Modify: `packages/claxedo-app/src/platform/auth/role.tsx`
- Modify: `packages/claxedo-app/src/platform/auth/role.test.ts`
- Modify: `packages/claxedo-app/src/platform/auth/role-can.vitest.tsx`
- Modify: `packages/claxedo-app/src/platform/auth/viewer-read-only.vitest.tsx`
- Modify: `packages/claxedo-app/src/platform/auth/auth-display.ts`
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

- Make the package root and local entry dependency-neutral: local defaults, local provider tree, local routes, local feature contributions, a tokenless account port, and a hosted-contribution activation port.
- Keep the dependency-neutral identity and authorization vocabulary in app because local shell, session, terminal, runtime-placement, telemetry, and settings consumers already import it: `identity-provider.tsx`, `principal-provider.tsx`, `role.tsx`, and `auth-display.ts`. Preserve Unit 6's tokenless `Principal` and account-port-driven `PrincipalProvider` while assembling the local entry; do not reintroduce `auth-session.ts`, `getToken`, or authenticated transport as a principal field.
- Keep the contribution seam bounded to the browser and desktop signed compositions. It registers hosted providers, routes, content surfaces, settings/navigation contributions, and cross-feature adapters exactly once after an account adapter reports signed state.
- Preserve the existing `app -> features/platform/ui/lib` dependency direction. Hosted features use their own ports; app composition assembles them.
- Remove Clerk initialization, auth providers/routes, cloud runtime stores, WorkGraph/Documents implementations, account-token-based remote-access clients, hosted connections clients, and cloud provisioning implementations from the local production-entry graph. The dependency-light machine Remote Access UI remains local and talks only to the injected Host Connector port; hosted files and manifest dependencies remain co-located only until Unit 10 moves them.
- Add explicit `dev:local` and `build:local` scripts for the new local entry and `vite.local.config.ts`, but keep the existing default hosted `dev`/`build` entry unchanged in this unit. The Pages workflow and self-hosted Docker static build still invoke that default, so changing it before cloud-app owns and rewires those callers would deploy the local UI. Unit 10 performs the default-script and deployment cutover atomically.
- Keep UI contracts shared only when the local shell genuinely renders them. Hosted-only implementation and copy move with cloud-app.
- Define the account port as sanitized state plus named operations: `signIn`, `signOut`, `getAccount`, discriminated authenticated hosted operations, and hosted-contribution activation. `hosted-operations.ts` is the one app-owned request/result schema registry for operation IDs; each row names its generated Client/Protocol input and output decoder. It contains no transport implementation, bearer, raw URL, arbitrary method/path, or generic fetch escape hatch.
- Expose machine-level Enable/Pause/Resume/Revoke/Status through a narrow injected Host Connector port. The app renders **Not enrolled**, **Re-enrollment required**, **Enrolling**, **Ready — waiting for first workspace**, **Online n/n**, **Reconnecting n/m**, **Offline 0/n**, **Paused**, and **Revoked** from canonical connector status. The accepted inventory count and reachable-route count are distinct fields, and the zero-inventory Ready state is not computed using vacuous “all routes online” logic. Electron and Host Connector own keys, credentials, OAuth launch, inventory reconciliation, tunnel lifecycle, and IPC validation. Per-workspace menus may open or copy an already-published workspace link but do not grant access.
- Preserve the current rail and contribution-registry information architecture described in the product section: runtime placement stays within the existing project/workspace rail, hosted account/service controls register in the existing account/settings surfaces, and WorkGraph/Documents remain contextual. Stable contribution slots and IDs prevent sign-in activation from reordering existing local destinations.
- Use the existing dialog, menu, disclosure, and focus primitives for enrollment and account flows. Enrollment confirmation traps/restores focus, is fully keyboard/touch operable, names the destructive Stop Sharing action, and does not rely on color. Connection transitions announce only meaningful status changes through a polite live region (terminal Revoke/error is assertive), honor reduced motion, and expose the same text/count semantics in responsive browser/mobile surfaces.
- Reduce `@claxedo/app` exports to stable public app/composition contracts and intentional shared components; cloud-app receives no private alias into app source.

**Patterns to follow:**

- `packages/claxedo-app/src/app/integrations/registry.ts`
- `packages/claxedo-app/src/features/extensions/data/index.ts`
- `packages/claxedo-app/src/architecture/ownership.guard.test.ts`
- `packages/claxedo-app/src/platform/runtime/platform-provider.tsx`

**Test scenarios:**

- **Happy path:** local composition renders home, local sessions, terminal, provider/config, settings, and diagnostics without a hosted contribution registration.
- **Happy path:** account state changes from anonymous to signed, then one hosted contribution activation adds its routes/surfaces/providers exactly once without restarting the local shell.
- **Edge case:** persisted WorkGraph/Document surface metadata is handled by Unit 2's unavailable-feature pruning while local session and terminal metadata remains.
- **Edge case:** a direct `@claxedo/app` consumer that registers no hosted contributions receives deterministic local defaults.
- **Error path:** duplicate/conflicting contribution IDs fail deterministically instead of last-writer-wins shadowing.
- **Error path:** an unknown account operation, raw URL, token-shaped payload, or hosted response outside its declared schema is refused at the port boundary.
- **Security:** every shared `Principal` variant is serializable identity/role state and contains no `getToken`, access token, refresh token, cookie, or authenticated-fetch capability; existing app consumers continue to import the neutral identity/role files from their current owner.
- **Error path:** Enable Remote Access is unavailable when the Host Connector port is absent; a per-workspace remote link is unavailable until that workspace has a canonical local ID and has appeared in the accepted machine inventory. Local work remains usable.
- **Edge case:** machine Remote Access shows zero, one, and many published workspaces from connector status and explains that new local workspaces will be included automatically.
- **Edge case:** a legacy-linked upgraded profile shows the one-time Re-enrollment required explanation and preserved-local-data reassurance; a genuinely new profile shows Not enrolled.
- **Edge case:** Ready with zero accepted workspaces, Online 3/3, Reconnecting 2/3, Offline 0/3, Paused, and Revoked expose the correct action and accessible announcement without hiding the two still-reachable workspaces in the partial case.
- **Accessibility:** keyboard-only enrollment/sign-out, callback focus restoration, destructive confirmation, screen-reader status announcements, reduced motion, and the narrow mobile workspace/status presentation use existing shared primitives and pass their component/E2E checks.
- **Integration:** the local app production entry builds and renders without loading Clerk, WorkGraph, Documents, or cloud runtime modules; injected entry-graph imports into them fail the guard.

**Verification:** `@claxedo/app` has an explicit local-only build entry and a bounded public composition surface while the existing default hosted build remains intact for current deployments. Unit 10 completes the physical extraction and atomically retargets default/deployment callers before any desktop consumer rewires.

- [ ] **Unit 10: Create `@claxedo/cloud-app` and move hosted renderer ownership**

**Goal:** Create the hosted browser product package, move browser identity and hosted feature implementations into it, and expose one platform-neutral hosted contribution entry shared by browser and signed desktop compositions.

**Requirements:** U8-R4, U8-R7, U8-R8, U8-R11, U8-R14, U8-R15, U8-R17, U8-R18, U8-R20, U8-R21, U8-R22, U8-R23, U8-R24

**Dependencies:** Units 2, 6, and 9

**Files:**

- Create: `packages/claxedo-cloud-app/package.json`
- Create: `packages/claxedo-cloud-app/tsconfig.json`
- Move: `packages/claxedo-app/index.html` to `packages/claxedo-cloud-app/index.html`
- Move: `packages/claxedo-app/vite.cloud.config.ts` to `packages/claxedo-cloud-app/vite.config.ts`
- Move and adapt composition imports: `packages/claxedo-app/src/app/entry/main.tsx` to `packages/claxedo-cloud-app/src/entry/main.tsx`
- Create: `packages/claxedo-cloud-app/src/composition/hosted-contributions.ts`
- Create: `packages/claxedo-cloud-app/src/composition/hosted-contributions.test.ts`
- Create: `packages/claxedo-cloud-app/src/composition/required-hosted-operations.ts`
- Create: `packages/claxedo-cloud-app/src/composition/required-hosted-operations.test.ts`
- Move and adapt browser producer: `packages/claxedo-app/src/platform/auth/auth-client.ts` and `auth-client.test.ts` to `packages/claxedo-cloud-app/src/platform/auth/browser/auth-client.ts` and its test
- Move and adapt browser producer: `packages/claxedo-app/src/platform/auth/auth-session.ts` and `auth-session.test.ts` to `packages/claxedo-cloud-app/src/platform/auth/browser/auth-session.ts` and its test
- Move and adapt: `packages/claxedo-app/src/platform/account/browser-account-adapter.ts` and its test to `packages/claxedo-cloud-app/src/platform/auth/browser/browser-account-adapter.ts` and its test
- Move hosted routes: `packages/claxedo-app/src/app/routes/login.tsx`, `cli-login.tsx`, `cli-login-token.ts`, and `cli-login-token.test.ts` to `packages/claxedo-cloud-app/src/routes/`
- Modify: `packages/claxedo-app/src/app/routes/index.ts`
- Move: `packages/claxedo-app/src/platform/runtime/cloud` to `packages/claxedo-cloud-app/src/platform/runtime/cloud`
- Move: `packages/claxedo-app/src/features/workgraph` to `packages/claxedo-cloud-app/src/features/workgraph`
- Move: `packages/claxedo-app/src/features/documents` to `packages/claxedo-cloud-app/src/features/documents`
- Move the hosted onboarding modules and adjacent tests from `packages/claxedo-app/src/features/onboarding`: `cloud-credentials-*`, `code-host-*`, `credential-sharing*`, `project-remote-*`, `sandbox-provider-*`, and `remote-access-marker.tsx`. Keep the dependency-light machine Remote Access controller/state/surface in app; signed desktop supplies its account and Host Connector ports. The hosted contribution registers the second-device marker because its current implementation calls authenticated Hosted Server APIs and reads hosted workspace routes.
- Modify: `packages/claxedo-app/src/features/onboarding/index.ts`
- Modify `packages/claxedo-app/src/features/onboarding/state.ts` and `state.test.ts`, `credential-query.ts` and `credential-query.test.ts`, and `ai-connect-api.ts` and `ai-connect-api.test.ts` to make the existing `scope: "local" | "shared"` split explicit at the public onboarding port. Retain local discovery/save/verification plus `ai-connect-state.ts`, `ai-connect-surface.tsx`, and their tests in app; move the shared-account credential producer to cloud-app and register it through that port. Do not leave an authenticated browser call or shared-credential fallback in app.
- Move the hosted settings modules and adjacent tests from `packages/claxedo-app/src/features/settings/ui`: `account-section.tsx`, `connections*`, `sandbox-driver-logo.tsx`, and `sandbox-section*`
- Move the hosted workspace modules and adjacent tests from `packages/claxedo-app/src/features/workspaces`: `data/share-workspace*`, `data/workspace-connection*`, `ui/cloud-auto-switch.tsx`, `ui/dialogs/create-cloud-project*`, `ui/dialogs/provider-facts*`, `ui/dialogs/provision-failure*`, and `ui/dialogs/repository-picker*`
- Move hosted-only deploy/brand/test assets from `packages/claxedo-app/public` to `packages/claxedo-cloud-app/public`: `_headers`, `_redirects`, browser icons/manifests, `demo/`, and browser mock-service-worker files
- Move shared font source: `packages/claxedo-app/public/assets/JetBrainsMonoNerdFontMono-Regular.woff2` to `packages/claxedo-app/src/assets/JetBrainsMonoNerdFontMono-Regular.woff2` and import it through the shared shell stylesheet
- Move and convert shared bootstrap producer: `packages/claxedo-app/public/oc-theme-preload.js` to `packages/claxedo-app/src/platform/theme/preload.ts` with a public app bootstrap export consumed by local and cloud entries
- Create: `packages/claxedo-app/src/architecture/public-asset-ownership.test.ts`
- Create: `packages/claxedo-cloud-app/playwright.config.ts`
- Move: `packages/claxedo-app/e2e/playwright/web-signed-cloud.spec.ts` to `packages/claxedo-cloud-app/e2e/playwright/web-signed-cloud.spec.ts`
- Move: `packages/claxedo-app/e2e/playwright/web-signed-userhosted.spec.ts` to `packages/claxedo-cloud-app/e2e/playwright/web-signed-userhosted.spec.ts`
- Move hosted browser specs from `packages/claxedo-app/e2e/playwright` to `packages/claxedo-cloud-app/e2e/playwright`: `core-cloud-offline-roles.spec.ts`, `core-cloud-provisioning.spec.ts`, `core-composer-hosted-chips.spec.ts`, `core-harness-ownership-cloud.spec.ts`, `core-settings-auth.spec.ts`, `core-user-hosted-workspace.spec.ts`, `core-workgraph.spec.ts`, `deployed-workgraph.spec.ts`, `documents-core.spec.ts`, `live-user-hosted-relay.spec.ts`, `real-cloud-relay.spec.ts`, and `mobile-smoke.spec.ts`
- Modify and split E2E script/config ownership: `packages/claxedo-app/playwright.config.ts`, `packages/claxedo-app/playwright.deployed.config.ts`, `packages/claxedo-app/tsconfig.e2e.json`, and the app/cloud-app package scripts
- Move and adapt package expectations: `packages/claxedo-app/src/architecture/cloud-product-entry.guard.test.ts` to `packages/claxedo-cloud-app/src/architecture/package-boundary.guard.test.ts`
- Modify: `packages/claxedo-app/package.json`
- Modify: `packages/claxedo-app/src/architecture/local-product-boundary.guard.test.ts`
- Modify: `packages/claxedo-server/Dockerfile`
- Modify: `packages/claxedo-server/scripts/deploy/deploy-hosted.ts`
- Modify: `packages/claxedo-server/scripts/deploy/deploy-hosted.test.ts`
- Modify: `.github/workflows/deploy-claxedo-app.yml`
- Modify: `.github/workflows/deploy-claxedo-app-staging.yml`
- Create: `packages/claxedo-cloud-app/scripts/deployment-entry-contract.test.ts`

**Approach:**

- Move the hosted browser entry, build config, hosted-only public assets, browser Clerk implementation, hosted routes, and Unit 2 feature entrypoints into cloud-app. Inventory every current `public/` file: hosted deploy metadata, brand manifests/icons, demos, and browser mocks move; the font becomes a normal imported shared app asset; theme pre-hydration becomes one app-owned bootstrap export consumed by both entries. Do not copy a shared static source or make cloud-app reach into an app-private filesystem path. Keep `identity-provider.tsx`, `principal-provider.tsx`, `role.tsx`, `auth-display.ts`, and their app-owned tests in app; only the Clerk/browser session producer moves. Bind that producer to app's tokenless account and principal contracts through `browser-account-adapter.ts`.
- Keep onboarding destination/funnel/local AI connection, general/keybind/provider/terminal/network settings, local workspace scope/actions/recovery, and shared dependency-neutral UI in app. Where a moved hosted module currently imports one of those internals, export the smallest dependency-neutral contract through `@claxedo/app` and replace the alias import; do not copy the implementation.
- Depend on `@claxedo/app` through exported composition contracts. Cloud-app owns all `@/` aliases within its own source; shared app imports use the package name.
- Export `hosted-contributions.ts` without browser globals or direct Clerk access. The browser entry registers it synchronously after binding the browser account adapter; desktop dynamically imports the same entry after binding its Electron account adapter. Expensive hosted surface implementations remain behind the lazy boundaries established by Unit 2.
- Generate `required-hosted-operations.ts` from Unit 1's reviewed operation matrix and app-owned discriminated operation schemas. The hosted contribution exports this complete declarative requirement set beside its contribution IDs. Browser adapter handlers and the Unit 11 Electron handler registry must each satisfy every required ID and transport kind—unary, cancellable stream, WebSocket session, or upload—through fixed method/path and Protocol decoding. The parity check rejects missing/extra handlers and route/schema drift; it never converts the list into a generic authenticated request primitive. Runtime HTTP/SSE/WebSocket after a connection mint remains the existing direct client-to-Relay path and is not tunneled through Electron account IPC.
- Preserve hosted browser URLs and deployment environment names so existing bookmarks, auth redirects, and control-plane endpoints remain valid.
- Retarget both Pages workflows, the supported `bun run deploy:hosted --target app` command, and the self-hosted Docker static-asset build to invoke `packages/claxedo-cloud-app` in this same unit. Assert the workflow working directory/build command, deploy-command app root, and Docker build context in contract tests before deleting app's hosted entry, so no commit can publish the local UI as the hosted site or omit the self-hosted signed UI.
- Keep cloud-app's package manifest explicit about Clerk, WorkGraph, hosted API/client dependencies, and its build/deploy tooling.
- After the final hosted file moves, change app's default `dev`/`build` scripts to the local entry, remove its old hosted build configuration and dependencies, and make cloud-app's scripts the sole hosted web build producer. In the same commit, retarget Pages workflows and the self-hosted Docker static-UI build to cloud-app before deleting the old app-hosted entry. Run app typecheck/build and its boundary guard with cloud-app source excluded before Unit 10 completes.
- Relocate every spec whose tested production entry requires browser identity or a hosted contribution, including the named cloud, WorkGraph, Documents, user-hosted Relay, mobile, and deployed-browser specs. Keep local-shell, local-harness, desktop, generic workbench, and genuinely shared browser-harness coverage in app. Split Playwright projects, TypeScript inputs, and package scripts so each package typechecks and runs only specs whose source it owns; shared fixture helpers remain public app test utilities rather than copied files.
- Preserve the existing signed user-hosted client sequence as moved code: call Hosted Server for `/:id/connection`, construct Relay HTTP/WebSocket URLs in `workspace-relay-connection.ts`, send the Runtime Access Token only to Relay, and refresh through Hosted Server before expiry or after a Relay 401. The hosted connection descriptor continues to omit `directRuntimeUrl`.

**Patterns to follow:**

- `packages/claxedo-app/src/app/entry/main.tsx`
- `packages/claxedo-app/vite.cloud.config.ts`
- `packages/claxedo-app/src/features/extensions/data/app.tsx`
- `packages/claxedo-app/src/features/extensions/data/server.tsx`

**Test scenarios:**

- **Happy path:** cloud-app anonymous launch renders the login journey and initializes Clerk once.
- **Happy path:** signed launch registers hosted routes/surfaces and completes cloud workspace, WorkGraph, Documents, connections, and hosted session flows.
- **Happy path:** the platform-neutral hosted contribution entry runs with the browser account adapter and with a fixture Electron account port, producing the same workspace IDs, routes, and feature contribution IDs.
- **Happy path:** the browser adapter satisfies the complete generated required-operation set, including the real stream/upload/cancellation modes from Unit 1; a fixture Electron adapter satisfies the same set and returns the same decoded Protocol values.
- **Edge case:** hosted feature chunks load on first use without changing contribution identity or route ownership.
- **Edge case:** browser refresh on `/login`, `/cli-login`, `/s/:sessionId`, and hosted workspace routes resolves through the hosted entry.
- **Edge case:** both local and hosted production builds load the canonical shared font and run the same pre-hydration theme bootstrap, while only cloud-app emits Pages headers/redirects, browser manifests/icons, demos, and service-worker fixtures.
- **Error path:** missing Clerk/hosted configuration produces the existing explicit hosted configuration state rather than a local-mode fallback.
- **Error path:** hosted contribution activation without a signed account port fails before registering routes or starting hosted queries.
- **Error path:** an unlisted hosted call, a required operation without a browser/Electron handler, or a unary handler substituted for a required stream/upload/WebSocket contract fails the parity test before build.
- **Security:** cloud-app can obtain browser credentials inside its browser account adapter, but app's `Principal`, hosted-contribution contract, and onboarding port remain tokenless; a source-graph test rejects any surviving app import of `auth-client.ts` or `auth-session.ts`.
- **Error path:** cloud-app source graph rejects Electron, desktop preload, and local-server imports.
- **Integration:** the production hosted build serves against `@claxedo/server` and passes the existing signed cloud and user-hosted browser suites. The user-hosted suite asserts one control-plane connection mint followed by Runtime HTTP/SSE/WebSocket calls to Workspace Relay, with no direct laptop request.

**Verification:** `@claxedo/cloud-app` is the sole hosted UI build producer used by Pages and self-hosted Docker, exports a browser-independent hosted contribution entry, and `@claxedo/app` is now the default unsigned local/shared closure. Excluding cloud-app source leaves the unsigned app buildable; signed desktop activation deliberately depends on cloud-app's declared contribution subpath.

### Phase C — Rewire and enforce delivery

- [ ] **Unit 11: Rewire desktop to local composition, optional account auth, and Host Connector**

**Goal:** Point desktop development, production build preparation, renderer boot, local-server startup, optional Electron-main account auth, hosted-contribution activation, and linked-host startup at the separated package contracts.

**Requirements:** U8-R6, U8-R7, U8-R9, U8-R10, U8-R13, U8-R15, U8-R16, U8-R17, U8-R18, U8-R19, U8-R20, U8-R21, U8-R22, U8-R23

**Dependencies:** Units 5, 6, and 10

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
- Modify: `packages/claxedo-desktop/src/main/account-auth.ts`
- Modify: `packages/claxedo-desktop/src/main/account-auth.test.ts`
- Modify: `packages/claxedo-desktop/src/main/account-credentials.ts`
- Modify: `packages/claxedo-desktop/src/main/account-credentials.test.ts`
- Modify: `packages/claxedo-desktop/src/main/account-callback.ts`
- Modify: `packages/claxedo-desktop/src/main/account-callback.test.ts`
- Modify: `packages/claxedo-desktop/src/main/host-connector.ts`
- Modify: `packages/claxedo-desktop/src/main/host-connector.test.ts`
- Modify: `packages/claxedo-desktop/src/main/host-connector-credentials.ts`
- Modify: `packages/claxedo-desktop/src/main/host-connector-credentials.test.ts`
- Modify: `packages/claxedo-desktop/src/main/ipc.ts`
- Modify: `packages/claxedo-desktop/src/main/hosted-operation-handlers.ts`
- Modify: `packages/claxedo-desktop/src/main/hosted-operation-handlers.test.ts`
- Modify: `packages/claxedo-desktop/src/preload/index.ts`
- Modify: `packages/claxedo-desktop/src/preload/types.ts`
- Create: `packages/claxedo-desktop/src/renderer/hosted-contributions.ts`
- Create: `packages/claxedo-desktop/src/renderer/hosted-contributions.test.ts`
- Modify: `packages/claxedo-desktop/src/main/navigation-guard.ts`
- Modify: `packages/claxedo-desktop/src/main/navigation-guard.test.ts`
- Move and adapt product expectations: `packages/claxedo-app/e2e/playwright/desktop-signed-embedded-shared.spec.ts` to `packages/claxedo-app/e2e/playwright/desktop-linked-userhosted.spec.ts`
- Modify product expectations: `packages/claxedo-app/e2e/playwright/desktop-signed-cloud.spec.ts`
- Modify: `.github/workflows/release-claxedo.yml`

**Approach:**

- Replace the source-relative server import with the local-server package entry and change the bundle helper's migration/data asset ownership to local-server.
- Make predev, prebuild, production build, and server boot smoke resolve the same local-server package entry. Contract fingerprint inputs follow the new package source and manifest.
- Boot the renderer through the local app entry. Unsigned startup binds an anonymous account port and does not load the account adapter, cloud-app contribution entry, or Host Connector.
- Reuse Unit 6's sole Electron-main OAuth/callback/credential producer; do not create a cloud-app-specific or renderer-owned desktop auth session. Keep its public-client PKCE, fixed per-channel callback, one-use state/nonce, `safeStorage`, serialized refresh, identity-change purge, non-auth deep-link dispatch, and tokenless IPC tests green while the renderer entry changes.
- Extend the existing `@claxedo/app` account-port binding with `activateHostedContributions` and the exact discriminated Hosted Server operations required by Unit 10's manifest. `hosted-operation-handlers.ts` is an exhaustive handler map: fixed origin/method/path, generated input/output decoders, and explicit unary/stream/upload/WebSocket lifecycle for every operation from Unit 1's matrix. IPC still accepts no bearer token, OAuth secret, arbitrary URL, arbitrary method/path, or generic fetch request. Electron attaches the account bearer only after validating the operation, owns cancellation and stream-handle cleanup, and decodes values through Client/Protocol before returning them. A compile/runtime parity test compares this map and the browser adapter to `required-hosted-operations.ts`; no hosted contribution may activate if either adapter is incomplete.
- After sign-in, dynamically import `@claxedo/cloud-app`'s browser-independent hosted-contribution subpath and register it exactly once against the Electron account port. The signed native renderer then exposes account, shared-local workspace, cloud-workspace, WorkGraph, Documents, billing, and connection flows inside the existing shell; the browser cloud-app remains a separate composition using its browser account adapter.
- Preserve the signed UI placement and intent contracts from Unit 9: hosted workspaces join the existing project/workspace rail with **On this laptop** or **Cloud VM** placement labels; account/service controls stay in account/settings; WorkGraph/Documents remain contextual contributions. OAuth callback focuses the existing window and resumes exactly one pending initiating action. Explicit sign-out confirms dirty/in-flight hosted work, then cancels account-scoped operations, unmounts hosted contributions, clears account caches/drafts, and focuses the latest local workspace/welcome surface without touching local sessions or terminals; passive expiry shows Sign in again and preserves the hosted route for reauthentication.
- Rebind Unit 6's existing Host Connector port, child supervision, encrypted host-key record, pending-pause handling, and same-owner resume behavior to the new local renderer entry without changing their authority. Base unsigned launch still does not resolve or spawn its bundle; a linked profile starts it only after local-server health, including with an empty inventory. The renderer still supplies no inventory, host proof, credential, target, or tunnel setting.
- Show account state and machine Remote Access as separate state: the account can be signed in while sharing is paused, and the connector can reconnect with host credentials without receiving the account credential. Remote Access renders the full Unit 9 state/count contract, including zero-workspace Ready, partial `Reconnecting n/m`, and one-time Re-enrollment required.
- Preserve default local server URL, renderer origin policy, diagnostics contract, profile paths, native modules, and parent/child ownership.
- Make electron-builder consume the local-server/app/host-connector boundary manifests and package only their declared structural resources plus separately fingerprinted account-adapter and hosted-contribution chunks. Host Connector remains a separately fingerprinted optional child and is not imported by the renderer or local-server entry. Unit 12 validates both unsigned startup exclusion and signed activation inclusion; final resource trimming may change the allowlist only while the same contract stays green.

**Patterns to follow:**

- `packages/claxedo-desktop/scripts/contract.ts`
- `packages/claxedo-desktop/src/main/index.ts` existing `open-url`, `second-instance`, and `setAsDefaultProtocolClient` flow
- `packages/claxedo-desktop/src/preload/index.ts` existing `contextBridge` boundary
- `packages/claxedo-desktop/src/main/navigation-guard.ts`
- `packages/claxedo-desktop/scripts/claxedo-server-boot.test.ts`

**Test scenarios:**

- **Happy path:** development and production-build desktop launch the same local-server entry and reach renderer/route/PTY readiness.
- **Happy path:** Sign in completes system-browser OAuth, returns through the validated desktop callback, stores the credential in Electron main, updates sanitized account state, and activates hosted contributions once without restarting local-server or the renderer shell.
- **Happy path:** Sign in started by Enable Remote Access or Create Cloud Workspace retains that dialog/form while waiting, focuses the existing window on callback, and resumes exactly that action once; explicit Sign in returns to its originating account surface.
- **Happy path:** Enable Remote Access obtains a host-key proof, performs the account-authorized enrollment in Electron main, starts the optional connector, and changes from enrolling to online with the complete published-workspace count after reconciliation and Relay registration.
- **Happy path:** signed desktop creates a cloud workspace through the hosted contribution, connects through the existing Hosted Server/Relay/Workspace Runtime contracts, and reconnects from a second authorized client after the originating laptop closes.
- **Happy path:** signed desktop lists all authorized shared-local workspaces, mints a connection through Hosted Server, and sends Runtime traffic through Workspace Relay; no account bearer enters Host Connector and no Runtime body traverses Hosted Server.
- **Edge case:** existing profile/session/provider state appears after the entrypoint change.
- **Edge case:** local session/terminal workflows remain usable with cloud-app and server source unavailable.
- **Edge case:** a linked restart waits for local-server health, then starts one connector and restores the exact current inventory, including zero workspaces; an unlinked or paused profile starts none.
- **Edge case:** sign-out pauses connector publication but retains the host-key record; the same owner signs in and resumes, while a different principal cannot reuse it.
- **Edge case:** explicit sign-out with a dirty hosted form or in-flight mutation confirms first; accepted sign-out cancels hosted operations, clears account-scoped UI state, unregisters hosted surfaces, and returns focus to local work without closing local terminals. Passive expiry instead preserves the hosted route behind Sign in again.
- **Edge case:** macOS, Windows, and protected-storage Linux packaged credential lanes restore and revoke a signed session across restart; `basic_text`, locked, and unavailable stores keep the exact same artifact usable in unsigned local mode while signed actions explain why they are unavailable.
- **Error path:** a callback with the wrong scheme/authority/path/state/nonce, an expired attempt, or a replay is refused without changing account state.
- **Error path:** a renderer request containing a raw token, OAuth code, arbitrary Hosted Server URL, or undeclared operation is refused at preload/main validation.
- **Error path:** a missing local-server build fails prebuild/boot with the local artifact named; no server fallback starts.
- **Error path:** connector crash, transient host-token failure, laptop wake, or Relay outage updates Remote Access through reconnecting/offline and leaves local sessions/terminals and the account session usable; revoked authorization becomes terminal and no cloud-VM fallback starts.
- **Security:** renderer input cannot choose an OAuth authority, callback, account token, local target URL, workspace path, connector executable, host proof, or tunnel credential.
- **Security:** the required-operation manifest and Electron/browser exhaustive handler maps agree on every fixed method/path, schema, and transport kind; a missing handler, hidden hosted call, arbitrary proxy input, or leaked stream authorization fails activation/tests.
- **Accessibility:** OAuth wait/cancel/retry and focus return, sign-out confirmation, Remote Access live status, keyboard/touch operation, and reduced-motion behavior pass the shared component and signed desktop E2E contracts.
- **Integration:** unsigned startup's renderer/local-server module and process trace contains no account adapter, hosted contribution, Clerk, WorkGraph, Documents, remote sandbox, Relay client, cloud control plane, or Host Connector. A separate signed activation smoke proves only the expected fingerprinted account/hosted chunks load.
- **Integration:** the unsigned packaged macOS artifact starts the same local-server entry, reaches renderer/route/PTY readiness, and exits without launching a harness during empty-shell boot.

**Verification:** Desktop dev and production build use one local composition contract; unsigned startup loads only the local closure; signed activation keeps credentials in Electron main, activates the declared hosted contribution, and preserves the characterized local, user-hosted Relay, and cloud-workspace behavior from Unit 1.

- [ ] **Unit 12: Enforce all package closures and update hosted delivery paths**

**Goal:** Make the split durable in manifests, source graphs, emitted artifacts, CI/deployment workflows, and documentation references.

**Requirements:** U8-R1–U8-R24

**Dependencies:** Units 2–11

**Files:**

- Modify: `packages/claxedo-local-server/package.json`
- Create: `packages/claxedo-local-server/src/architecture/package-boundary.test.ts`
- Modify: `packages/claxedo-app/package.json`
- Modify: `packages/claxedo-app/src/architecture/local-product-boundary.guard.test.ts`
- Modify: `packages/claxedo-cloud-app/package.json`
- Modify: `packages/claxedo-cloud-app/src/architecture/package-boundary.guard.test.ts`
- Modify: `packages/claxedo-server/package.json`
- Modify: `packages/claxedo-server/src/deployments/hosted-workerd/worker.import-graph.test.ts`
- Modify: `packages/claxedo-host-connector/package.json`
- Create: `packages/claxedo-host-connector/src/architecture/package-boundary.test.ts`
- Create: `script/product-boundary/verify.ts`
- Create: `script/product-boundary/verify.test.ts`
- Create: `script/product-boundary/normalize-build-manifest.ts`
- Create: `script/product-boundary/normalize-build-manifest.test.ts`
- Create: `script/product-boundary/policies/app-local.ts`
- Create: `script/product-boundary/policies/local-server.ts`
- Create: `script/product-boundary/policies/cloud-app.ts`
- Create: `script/product-boundary/policies/host-connector.ts`
- Create: `script/product-boundary/policies/server-cloud-node.ts`
- Create: `script/product-boundary/policies/server-workerd.ts`
- Create: `script/product-boundary/policies/server-self-hosted.ts`
- Create: `script/product-boundary/policies/desktop-account-composition.ts`
- Modify: `packages/claxedo-desktop/scripts/contract.ts`
- Modify: `packages/claxedo-desktop/scripts/contract.test.ts`
- Modify: `packages/claxedo-desktop/package.json`
- Create: `packages/claxedo-desktop/scripts/check-packaged-product-boundary.ts`
- Create: `packages/claxedo-desktop/scripts/check-packaged-product-boundary.test.ts`
- Create: `packages/claxedo-desktop/scripts/verify-account-source-closure.ts`
- Create: `packages/claxedo-desktop/scripts/verify-account-source-closure.test.ts`
- Create: `packages/claxedo-desktop/scripts/u8-packaged-smoke.ts`
- Create: `packages/claxedo-desktop/scripts/u8-signed-activation-smoke.ts`
- Create: `packages/claxedo-desktop/scripts/u8-release-qualification.ts`
- Create: `packages/claxedo-desktop/scripts/u8-release-qualification.test.ts`
- Modify: `turbo.json`
- Modify: `.github/workflows/test.yml`
- Modify: `.github/workflows/typecheck.yml`
- Modify: `.github/workflows/release-claxedo.yml`
- Modify: `packages/claxedo-web/src/content/deployment.ts`
- Modify: `packages/claxedo-web/test/deployment-prompt-drift.test.ts`
- Modify: `packages/claxedo-web/src/content/claims.ts`
- Modify: `docs/plans/README.md`

**Approach:**

- Implement one repository-owned boundary verifier and emitted-manifest normalizer under `script/product-boundary`, driven by declarative per-entry policy modules. Package scripts are thin invocations selecting a policy; they do not copy traversal, temporary-workspace, normalization, native-preparation, or smoke orchestration. Validate each manifest against its package role and walk each production entry's transitive value-import graph. Report the shortest cross-product path.
- Cover static imports, re-exports, side-effect imports, and string-literal dynamic imports; treat type-only imports according to emitted runtime behavior.
- Consume each runtime's build-tool module/chunk metadata to generate normalized JSON manifests with `entry`, sorted `modules`, sorted `chunks`, and sorted static/dynamic `edges` fields for app, local-server, cloud-app, server's cloud Node, workerd, and self-hosted Node entries, and Host Connector. Scan module IDs and output chunks, not minified text alone.
- Assert representative hosted packages and source roots are absent from app/local-server outputs, and representative local/Electron roots are absent from cloud-app/server outputs. Treat desktop as an explicit composition artifact: its unsigned entry trace must exclude the lazy account, cloud-app contribution, and Host Connector chunks, while its signed activation trace may load only those separately fingerprinted optional chunks.
- Assert Host Connector reaches only its enrollment client, in-memory host identity/nonsecret enrollment state, Workspace Runtime relay/protocol contracts, and outbound transport. Reject persistent private-key storage, account auth SDKs, sandbox-manager, server implementation, app implementation, and local-server implementation imports.
- Enforce the Unit 1 hosted-operation inventory and Unit 10 requirement manifest as another closure: every hosted contribution call has one declared operation/schema/transport kind, and both browser and Electron handler registries implement the identical set. Repository search and a negative fixture reject direct authenticated calls outside those adapters and reject a generic proxy handler.
- Exercise build independence by invoking the shared verifier for app, local-server, cloud-app, Host Connector, cloud Node/workerd, self-hosted Node, and desktop account-composition policies. The verifier resolves the allowlisted transitive workspace packages from the selected entry manifest and materializes a temporary workspace. It copies root toolchain files and every workspace manifest needed by the frozen lockfile, but copies source/build inputs only for allowlisted packages; excluded product packages are manifest-only stubs with no exports or source. It performs a frozen, lifecycle-scripts-disabled install, then runs only the repository-owned, allowlisted native preparation commands required by that entry's declared `node-pty`/`better-sqlite3` closure before build and smoke; it does not rely on arbitrary third-party postinstall execution or pre-existing root `node_modules`. It always removes the temporary workspace. Cloud Node/workerd exclude local-server. Self-hosted Node explicitly permits only local-server's public local-execution subpath and rejects desktop/Electron imports. The desktop account closure explicitly permits Electron main's account adapter and cloud-app's public hosted-contribution subpath but rejects cloud-app's browser entry and private source. A hidden source-relative, alias, or undeclared workspace edge therefore has no source target and fails by construction.
- Enforce the Unit 10 hosted-build cutover in closure/CI checks, and change remaining performance targets, source-map upload paths, and deployment documentation from `packages/claxedo-app` to `packages/claxedo-cloud-app` where they describe the hosted web product. The Pages workflows and self-hosted Docker build are already hard-cut in Unit 10 and are verified here, not kept on a second transitional path.
- Add the new packages to typecheck/test/build filters and retain the existing ordering constraints for heavyweight runtime suites.
- Add native signed-credential release jobs for macOS, Windows, and the supported protected-storage Linux runner. Each packages the real Electron main/preload boundary and proves credential create/restart/refresh/revoke/corruption/locked-store behavior; the Linux job additionally proves `basic_text` refusal. Do not mark a platform signed-mode supported from mocked backend contracts alone.
- Feed the emitted manifests into the desktop build contract and Release Qualification Gate so final packaged-resource inspection cannot invent a second boundary definition.
- Add `verify:u8-package-boundary` to desktop. It creates the macOS artifact through the normal package script, inventories its app resources, validates every bundled module/native asset/sidecar against the local, account, hosted-contribution, and Host Connector boundary manifests, runs `u8-packaged-smoke.ts` for unsigned startup, then runs `u8-signed-activation-smoke.ts` with fixture OAuth/Hosted Server authority. The two traces prove optional resources are present for signed mode but absent from unsigned execution.

**Patterns to follow:**

- `packages/claxedo-server/src/deployments/hosted-workerd/worker.import-graph.test.ts`
- `packages/claxedo-app/src/architecture/import-graph.ts`
- `packages/claxedo-app/scripts/check-forbidden-eager-deps.ts`
- `packages/claxedo-desktop/scripts/contract.ts`
- `packages/claxedo-web/test/deployment-prompt-drift.test.ts`

**Test scenarios:**

- **Happy path:** each of the four product packages plus Host Connector passes manifest, source-graph, emitted-manifest, and entry smoke checks; the desktop account composition passes its separate permitted-subpath closure.
- **Happy path:** hosted deploy workflows build cloud-app and server from their new package paths; desktop release builds app, local-server, the lazy Electron account adapter, the hosted-contribution subpath, and Host Connector.
- **Edge case:** dynamic hosted feature chunks appear only in cloud-app's emitted manifest and remain absent from local app.
- **Edge case:** Host Connector is present as a separately fingerprinted packaged resource but absent from the unsigned renderer/local-server import graphs and process inventory.
- **Edge case:** account and hosted-contribution chunks are present and fingerprinted in the packaged artifact, absent from unsigned startup, and loaded once by signed activation.
- **Edge case:** type-only shared contracts remain allowed when the emitted runtime graph stays clean.
- **Error path:** a barrel re-export, alias, dynamic import, or manifest dependency that crosses the product boundary fails with an actionable chain.
- **Error path:** an emitted chunk containing a representative hosted module fails even when the source scanner was bypassed by build configuration.
- **Error path:** an authenticated hosted call missing from the operation inventory/requirement manifest, an adapter with the wrong transport kind, or an extra generic authenticated handler fails the shared closure verifier.
- **Integration:** local app/local-server build with hosted sources unavailable; cloud-app plus cloud Node/workerd build with desktop/local-server sources unavailable; self-hosted Node builds with only the declared local-execution subpath from local-server; desktop account composition builds with only cloud-app's public hosted-contribution subpath; all smoke suites pass.
- **Integration:** `verify:u8-package-boundary` proves the packaged macOS artifact uses the same fingerprinted local entries as development/build, does not execute optional signed resources during unsigned startup, and activates exactly the declared optional resources after fixture sign-in.
- **Integration:** native macOS, Windows, and protected-storage Linux signed lanes qualify the platform credential contract; a failing platform is released as unsigned-local-only until its lane passes.

**Verification:** CI treats package ownership and optional desktop activation as required contracts, deployment workflows point at the owning packages, and the artifacts passed to final qualification carry deterministic unsigned-startup and signed-activation boundary manifests.

## Release Qualification Gate — Included in This Standalone Plan

This is the final step after Unit 12 and before the hard-cut production runbook. It is not delegated to the origin plan. `bun run qualify:u8-release -- --artifact <artifact> --baseline <baseline>` accepts only the already fingerprinted package from Unit 12 and Unit 1's immutable baseline; it does not rebuild another artifact or read a real user profile.

The release owner must satisfy all of these gates:

1. Run five fresh-idle and five post-session-idle cohorts with fresh temporary profiles and a sixty-second settle. Both cohorts require median native physical footprint at or below 300 MiB and every sample at or below 325 MiB. Every record includes process-role footprint, IOSurface, summed RSS, renderer readiness, route, PTY, mounted-surface, and harness-process evidence; any failed correctness gate invalidates the sample rather than lowering the result.
2. Run active and post-teardown cohorts for every packaged OpenCode, Codex, Claude, ACP, and Pi adapter present in the artifact. Each must satisfy Unit 1's precommitted active-memory, cold/warm latency, event-loop, CPU, GC-pause, mutation-safety, stream, idle-exit, and parent-loss ceilings. Empty shell and post-session idle contain zero harness processes.
3. Run the production-renderer browser comparison for all five stored real-app flows in baseline → candidate → candidate → baseline order, isolated contexts, and three iterations per position. Each interactive flow has zero application-attributed renderer intervals above 16.67 ms, satisfies its stored worst-interval budget, and remains within its precommitted baseline-relative completion ceiling. Launch keeps its stored worst-frame/completion ceilings and reports frame drops rather than filtering them.
4. Run the packaged desktop lifecycle comparison for health readiness, store-only session list, provider first use, PTY first output, cold start, warm use, idle restart, active-session stress, event-loop delay, CPU, and GC. Run unsigned startup, signed contribution activation, user-hosted Relay access, cloud-workspace access, sign-out back to local, and a second unsigned settle in the same artifact. Signed activation may load only the fingerprinted account/cloud-app/Host Connector resources, and sign-out may not leave their processes, streams, or account-scoped caches active.
5. Run the real native credential qualification artifacts on macOS, Windows, and protected-storage Linux, plus the hosted development Clerk spike and beta/production callback registration checks. Run the current-to-new self-hosted upgrade fixture and the Remote Access hard-cut dry run. All must refer to the same release SHA and boundary manifests.
6. Store raw JSON plus a Markdown summary containing baseline/candidate commits, artifact hashes, tool versions, machines, thermal state, sample order, raw samples, gate results, and links to structural manifests under `.artifacts/u8-package-split/release/`. The qualification script rejects a missing cohort, changed threshold, mismatched artifact hash, failed product gate, or incomplete metadata.

Failure is a release stop, not a reason to add a compatibility route. Fix the owning package, rebuild and fingerprint a new candidate, then rerun the complete affected cohort and the final aggregate gate. The origin idle-memory plan may reference these artifacts, but this standalone plan is complete without executing another document.

## Integration Sequence

### Independently landable phases

- **Phase A — Units 1–4:** lands only characterization and authoritative lower-layer ownership. It changes no package names, public deployment entrypoints, desktop packaging inputs, or hosted build paths. Phase A is independently mergeable and leaves every current product running through its current composition.
- **Phase B — Units 5–10:** performs producer moves as dependency-ordered hard cuts. Each unit must retarget all repository callers, tests, exports, scripts, and affected deployments before deleting its replaced path; no unit relies on a compatibility shim from a later phase. Unit 7 preserves self-hosted Node, Unit 8 deletes the remaining mixed local server path, and Unit 10 atomically transfers hosted UI builds and deployments.
- **Phase C — Units 11–12:** rewires the desktop composition, then promotes every package/deployment boundary into CI and packaged-artifact enforcement. Unit 11 is green against the real separated packages before Unit 12 adds final closure gates.

The end of each phase is a valid repository landing point. Within Phase B, a move unit is atomic: partial producer/caller cutovers are not supported states.

Execute the implementation in this order:

1. Unit 1 records the current local, linked-host, and cloud product contracts so later moves can be checked against known behavior.
2. Unit 2 separates hosted WorkGraph and Documents contributions from the unsigned composition.
3. Unit 3 completes harness lifecycle ownership in Workspace Runtime.
4. Unit 4 makes Workspace Runtime the canonical owner of local session inventory and events.
5. Unit 5 extracts local-server and immediately makes desktop use it.
6. Unit 6 establishes the sole Electron-owned desktop account producer, extracts Host Connector, adds host-key proof plus account-authorized machine enrollment, and makes it the canonical local-workspace sharing path.
7. Unit 7 recomposes the self-hosted single-binary on the shared hosted core plus the explicit local-execution adapter and retargets every self-hosted caller/deployment.
8. Unit 8 deletes the remaining mixed `deployments/local` composition and enforces cloud Node/workerd versus self-hosted Node entry closures.
9. Unit 9 establishes the explicit local app entry and public composition contract without changing the still-live hosted default build.
10. Unit 10 moves browser identity and hosted features into cloud-app, exposes a browser-independent contribution entry, and atomically retargets app defaults, Pages, and the self-hosted Docker static build.
11. Unit 11 points desktop development, build, packaging, optional Electron-main account auth, hosted contribution activation, and Host Connector at the separated packages.
12. Unit 12 enables closure guards, CI/documentation paths, and separate unsigned-startup/signed-activation packaged checks.
13. Run this document's Release Qualification Gate against Unit 12's exact artifact and Unit 1's immutable baseline; only then begin the hard-cut production runbook.

Each producer moves before its old entry is deleted, and every unit leaves one canonical path.

## Execution and Verification Protocol

Execute units in dependency order and keep the current unit's package checks green before beginning a dependent unit. All four product manifests plus Host Connector must expose `typecheck`, `test`, and `verify:closure`; app, cloud-app, local-server, and Host Connector also expose `build`. Desktop exposes its own account-composition closure and packaged activation checks. Server's `verify:closure` performs cloud Node, workerd, and self-hosted Node entry builds/smokes because those deployments do not share one emitted closure. Unit 12 wires every `verify:closure` to its source-closure and emitted-boundary checks.

Run commands from the named package directory, never from the repository root:

| Gate | Working directory | Required command |
|---|---|---|
| Runtime route boundary and authority after Units 2–4 | `packages/workspace-runtime` | `bun run typecheck && bun run test && bun run build` |
| Hosted WorkGraph Runtime adapter after Unit 2 | `packages/workgraph` | `bun run typecheck && bun run test && bun run build` |
| Harness lifecycle after Unit 3 | `packages/agent-sdk-runtime` | `bun run typecheck && bun run test && bun run build` |
| Local server after Units 5 and 12 | `packages/claxedo-local-server` | `bun run typecheck && bun run test && bun run build && bun run verify:closure` |
| Host enrollment/tunnel after Units 6 and 12 | `packages/claxedo-host-connector` | `bun run typecheck && bun run test && bun run build && bun run verify:closure` |
| Hosted/self-hosted server after Units 2, 6–8, and 12 | `packages/claxedo-server` | `bun run typecheck && bun run test && bun run check:worker-safe && bun run verify:closure` |
| Local/shared app after Units 2, 9–10, and 12 | `packages/claxedo-app` | `bun run typecheck && bun run test && bun run build && bun run verify:closure` |
| Hosted browser after Units 6, 10, and 12 | `packages/claxedo-cloud-app` | `bun run typecheck && bun run test && bun run build && bun run verify:closure` |
| Desktop integration after Unit 11 | `packages/claxedo-desktop` | `bun run typecheck && bun run test && bun run test:contract && bun run build` |
| Structural package acceptance after Unit 12 | `packages/claxedo-desktop` | `bun run verify:u8-package-boundary` |
| Final standalone release qualification | `packages/claxedo-desktop` | `bun run qualify:u8-release -- --artifact <artifact> --baseline <baseline>` |

The final U8 handoff consists of the green command record, normalized boundary manifests for all four product packages plus Host Connector and desktop account composition, source-closure fixture logs, the existing-profile and self-hosted upgrade fixture results, the native credential/Clerk evidence, unsigned-local, signed-desktop activation, linked-user-hosted, and signed-cloud product smoke results, and the accepted release-qualification report. Store generated evidence under each package's ignored `.artifacts/u8-package-split/` directory; commit the tests and normalizers, not generated build output.

## System-Wide Impact

- **Interaction graph:** Electron renderer → local app; Electron sidecar → local-server → Workspace Runtime → selected harness adapter. Optional sign-in is system browser → fixed desktop callback → Electron-main account adapter → Hosted Server; the renderer sees only sanitized state and typed results. Signed desktop dynamically activates cloud-app's platform-neutral contributions inside the local shell. For an enrolled machine, Host Connector reads the full local-server inventory and publishes it through Bun's multi-workspace host registration or Cloudflare's per-workspace room tunnels. Any signed client uses Hosted Server for list and connection-token mint/refresh, then sends Runtime traffic to Workspace Relay → Host Connector → local-server → Workspace Runtime. Relay separately uses its authenticated target/revocation resolver against Hosted Server. Electron controls connector lifecycle but carries no remote runtime traffic. Browser cloud-app → Hosted Server → hosted services/sandbox VMs remains the web path.
- **Entry points:** desktop dev/build/prebuild, local-server main/create-app, cloud-app Vite entry, hosted Node, hosted workerd, Pages deploy, desktop release, performance targets, and source-map paths all change ownership.
- **Error propagation:** missing local owners fail at local build/start; Host Connector enrollment/tunnel failures produce sharing status while local execution remains usable; hosted configuration/provisioning failures stay in hosted flows; external-link validation fails closed before Electron calls the OS.
- **State lifecycle:** package paths do not determine persistent data paths. Existing profile, Workspace Runtime, provider, credential, and session stores stay canonical; Unit 2 prunes only unavailable hosted surfaces.
- **Linked-host lifecycle:** one durable machine enrollment is bound to the enrolling principal and local host key and authorizes publication of the machine's complete current and future local-workspace inventory. Full-set reconciliation materializes per-workspace links; account-authorized enrollment, inventory changes, host-key renewal, pause, revocation, presence expiry, connector restart, and reconnect never change underlying local workspace/session identity. Sign-out pauses publication and retains the record for same-owner resumption; Stop Sharing rotates its generation.
- **API transition:** supported product HTTP/SSE behavior, hosted connection response, Runtime Access Token/Host Tunnel Token/Relay Host Token claims, and Relay paths/frames keep their characterized semantics. Internal composition exports, old mixed local account-link routes, and old build/start paths are intentionally replaced with no compatibility layer; their callers move in the same unit. Public TypeScript exports change intentionally so cloud-app consumes the app contract and desktop consumes the local app contract.
- **Build graph:** local-server, cloud-app, and Host Connector enter Turbo, CI filters, release inputs, and the lockfile. Hosted web build responsibility moves from claxedo-app to claxedo-cloud-app.
- **Security boundary:** desktop account credentials exist only in Electron main and OS-protected storage. Renderer IPC is tokenless; local-server and Host Connector never receive account bearer or refresh tokens. Host Connector holds a machine-scoped inventory-publishing enrollment and short-lived credentials scoped to the exact reconciled workspace set. Hosted Server remains the account/role/token authority, while Workspace Relay remains the Runtime data path.
- **Operational boundary:** hosted deployment variables stay with cloud-app/server. Desktop release carries only the public OAuth configuration and fixed callback/control-plane allowlist needed by its Electron adapter; renderer/local-server receive none of it.
- **Integration coverage:** source closure, emitted closure, real entrypoint smoke, signed hosted browser flows, unsigned desktop startup, signed desktop activation, account-authorized machine enrollment, full-inventory add/remove reconciliation, tunnel/client reconnect, signed cloud-VM access, existing-profile upgrade, PTY, and harness lifecycle together prove the split.
- **Cross-client parity:** web/mobile-shaped signed clients use the same Hosted Server connection mint, reconnect state, cursored Runtime events, and Runtime Protocol for user-hosted and cloud workspaces; only the runtime target behind Relay differs.

## Risks and Controls

| Risk | Impact | Control |
|---|---|---|
| A shared barrel pulls hosted code back into app or local-server | Desktop memory and dependency closure regress silently | Public subpath exports plus shortest-path source graph and emitted module/chunk checks |
| Package move changes profile or migration paths | Existing local workspaces, sessions, providers, or credentials appear lost | Package-independent data-root functions and an existing-profile fixture opened through old and new entries |
| Cloud-app reaches app internals through aliases | The package boundary is nominal and cannot be published/built independently | Only public `@claxedo/app` exports resolve cross-package; boundary guard rejects relative/alias reach-through |
| Hosted features lose route/provider ordering | Login, WorkGraph, Documents, or cloud workspace flows fail after extraction | Synchronous contribution registration before render and signed hosted E2E coverage |
| Electron account credentials leak into renderer, connector, or diagnostics | Renderer compromise or child-process access becomes account compromise | Store refreshable credentials with `safeStorage`, retain them in Electron main, expose only tokenless named IPC operations, redact process/log/crash surfaces, and assert negative payload/process traces |
| OAuth callback is hijacked or replayed | An attacker binds the desktop to the wrong account or steals an authorization result | Public-client Authorization Code with PKCE, fixed callback schemes, exact authority/path checks, state and nonce binding, one-use attempts, short expiry, and identity-change cache purge |
| A generic authenticated IPC proxy becomes a confused deputy | Renderer can make account-authorized requests outside the intended product contract | Schema-named operations only, fixed Hosted Server origin, method/path owned in main, Protocol decoding, no arbitrary URL/headers/body/token contract |
| Host enrollment becomes an account-token backdoor | A stolen desktop record grants broad account access | Electron presents account auth only to the one enrollment endpoint; mint a distinct machine credential, bind renewal to host-key proof and generation, and reject that credential on every account/product route |
| Optional signed chunks enter unsigned startup | Baseline memory and dependency closure regress even though signed mode is optional | Separate chunk fingerprints plus module/process traces for unsigned startup and a distinct signed-activation smoke |
| Host Connector forwards beyond the current Runtime inventory | A compromised Relay or connector reaches local secrets, a deleted workspace, or an unrelated local service | Per-launch loopback credential, current canonical inventory gate before every forward, Runtime route-ownership gate, and negative real-transport tests |
| An out-of-order inventory update resurrects a deleted workspace | A stale route becomes remotely reachable | Versioned, atomic full-set replacement under one machine generation; reject stale reconcile versions and workspace-ID reparenting |
| A failed inventory read looks like an empty machine | Every workspace is accidentally unshared | Make complete success, valid empty success, and read failure distinct; reconcile only a complete versioned snapshot and fail forwarding closed while inventory is unavailable |
| Tunnel or client reconnect repeats user intent | A prompt runs twice or an interactive resource is duplicated | Reconnect only transport; reacquire authorization, resume events by cursor or refetch, reattach resources by canonical ID, and never resubmit an admitted prompt |
| Many disconnected hosts reconnect together | Relay and authority services receive a reconnect storm | One supervised Host Connector per machine, the existing bounded exponential backoff/jitter and dead-socket detection per handle, a host-level cap on concurrent room reconnects, and fresh authorization at each attempt |
| Host Connector guesses the Relay registration topology | Bun replaces per-workspace sockets by host ID, or Cloudflare rejects a multi-workspace socket | Hosted Server returns an explicit `machine-multiplexed` or `workspace-room` assignment; connector tests run against both existing Relay fixtures |
| A Bun registration update reconnects with its original workspace URL | A deleted workspace can briefly reappear in Relay presence after a socket loss | Make the normalized set accepted by `updateRegistration` authoritative for the next upgrade URL and token scope; force `[A, B]` to `[A]` through reconnect in the canonical tunnel test |
| Revocation behavior drifts during extraction | A removed share accepts new connections or the plan accidentally changes established-socket semantics | Characterize the existing Host Tunnel Token, Runtime Access Token, Relay Host Token, target/revocation resolver, presence, and long-lived socket contracts before moving code; pause/revoke closes the supervised connector and blocks new/refresh access |
| Existing self-hosted registration or trusted-proxy defaults are unsafe for an internet-facing operator | An untrusted account could reach powerful signed self-hosted capabilities | Unit 1 records the exact current policy and Unit 7 preserves it without accidental widening; require a separate explicit release decision before claiming an internet-safe closed-registration deployment |
| Users expect shared-local availability while the laptop is asleep | Remote work appears unreliable or silently changes compute | Explicit user-hosted/offline status; laptop requirement in the local enrollment confirmation; no cloud fallback or working-tree copy |
| Sign-out and sharing lifecycle diverge | A signed-out machine stays published or a different account adopts an enrollment | Sign-out synchronously pauses connector publication; owner principal is bound to enrollment metadata; same-owner resume uses host proof; revoke rotates generation and requires enrollment again |
| `@claxedo/server` retains obsolete desktop-local entrypoints | Two local producers drift and desktop can regress to the large graph | Move producer once, rewire consumers in the same slice, delete obsolete local entry before unit completion |
| Source scan misses bundler-injected or dynamic code | Clean architecture test but contaminated output | Build metadata manifest and emitted chunk/module gate |
| Cloud app extraction duplicates shared UI or state | Divergent shell behavior and two sources of truth | Cloud-app composes shared app; shared contracts stay in app, hosted implementations move once |
| Structural and release qualification invent separate artifact logic | Two guards drift and produce contradictory release results | Unit 12 emits one deterministic boundary manifest and the final qualification consumes that exact artifact/hash |
| CI resource ordering changes with three new packages | Heavy tests contend and become flaky | Preserve explicit Turbo ordering for server/app/runtime suites and add package-scoped jobs deliberately |
| Static SPA serving is lost for the self-hosted Node deployment | Self-operated signed deployments lose their web UI | Keep static cloud-app serving in self-hosted Node ownership and cover it in self-hosted integration tests |

## Success Metrics

- Four product packages plus Host Connector and the desktop account composition have manifests and transitive runtime graphs matching the package dependency rules.
- `@claxedo/local-server` and `@claxedo/app` build and smoke with hosted source trees unavailable.
- `@claxedo/cloud-app` and `@claxedo/server`'s cloud Node/workerd entries build and pass hosted integration flows with desktop/local-server source trees unavailable; the self-hosted Node entry separately builds with only local-server's public local-execution subpath allowed.
- Desktop unsigned boot passes health, renderer, local route, PTY, session inventory, explicit harness, and shutdown gates through local-server.
- Desktop sign-in completes browser OAuth with PKCE, returns to a fixed validated desktop callback, keeps the refreshable account credential in Electron main/OS-protected storage, and exposes no token through renderer IPC, local-server, Host Connector, logs, or process arguments.
- Signed desktop activates the same platform-neutral hosted contribution contract as browser cloud-app and completes account, WorkGraph, Documents, cloud-workspace, and shared-local workspace flows inside the native shell.
- One account-authorized, host-key-proven enrollment creates a machine-scoped record; a two-workspace laptop publishes both, a newly created third workspace appears without another enrollment, and deleting one removes only that workspace's hosted link and route.
- A pre-cut linked profile retains local workspaces/sessions/settings but starts in Re-enrollment required; its plaintext host key, legacy links, old challenges, and token authority are removed, cannot renew or reconnect, and a fresh enrollment creates the only accepted machine identity.
- Signing out pauses all machine publication while retaining the host key; the same owner can sign back in and resume, a different owner cannot adopt it, and Stop Sharing rotates the generation before re-enrollment.
- The enrolling account can list and open every current and future reconciled workspace; collaborators see only workspaces with an explicit role, and those roles survive inventory reconciliation.
- After laptop sleep, network loss, Relay restart, or connector restart, Host Connector reacquires authorization, reconciles a fresh complete inventory, and restores exactly the accepted workspace set through Bun registration replacement or Cloudflare room-handle reconciliation.
- After a Bun live registration removes a workspace, the next forced reconnect upgrades and re-registers without that workspace; a Cloudflare room loss changes only that workspace's availability while healthy rooms remain reachable.
- A user-hosted client receives no direct Runtime URL or laptop address: Hosted Server handles list/mint/refresh, Runtime HTTP/SSE/WebSocket traffic goes to Workspace Relay, and Relay's authenticated target/revocation resolver consults Hosted Server without proxying Runtime bodies through it.
- Existing Relay security contract tests remain green for token claim binding, token revocation, role/path gates, active-host presence, origin checks, dangerous-header and cookie stripping, Relay Host Token verification, route ownership, limits, and audits; the package split adds no new Relay protocol frame or public data-path route.
- A disconnected signed client shows reconnecting, reacquires runtime access, resumes Runtime events from its cursor or refetches after a replay gap, reattaches supported resources by ID, and never duplicates prompt admission.
- Paused, revoked, sleeping, closed, or disconnected machines render all of their local workspaces paused/offline together and never create a cloud fallback.
- Signed cloud workspace creation provisions hosted compute that remains reachable from authorized clients after the originating laptop closes.
- Unsigned local mode contains no sandbox-manager or VM lifecycle path; choosing Cloud Workspace starts desktop sign-in, then activates the hosted workspace contribution in the native shell.
- Existing fixture profiles retain workspace, session, provider, credential, and harness-selection state.
- App/local-server emitted manifests contain no hosted auth, WorkGraph, Documents, remote sandbox, relay, or cloud control-plane modules/chunks. The desktop artifact may carry separately fingerprinted optional account/hosted chunks, but unsigned startup loads none of them.
- Cloud Node/workerd emitted manifests contain no Electron main/preload or local-server modules. The self-hosted Node manifest contains the declared local-execution adapter but no desktop/Electron module or private local-server source reach-through.
- The packaged macOS artifact uses the fingerprinted local entries, passes the resource allowlist, completes unsigned structural launch without optional module/process activity, and completes a separate fixture signed-activation smoke.
- The standalone Release Qualification Gate accepts the exact Unit 12 artifact and passes its resource, harness, memory, browser, desktop, signed-mode, and platform cohorts.

## Definition of Done

- Every replaced internal API, export, route, script, and deployment entry is gone after its owning cutover unit; repository search and entrypoint tests prove there is no compatibility shim, alias, fallback, or dual-running producer. Current durable data is handled only by explicit one-way migration where required.
- `packages/claxedo-local-server` exists as the sole desktop-local server composition and depends directly on Workspace Runtime and selected local adapters.
- `packages/claxedo-server` exposes cloud Node, workerd, and explicit self-hosted Node compositions and no desktop-local start entry; only self-hosted Node imports the public local-execution adapter.
- `packages/claxedo-app` is the local/shared app package and has no hosted implementation dependency.
- `packages/claxedo-cloud-app` owns browser identity, browser entry, hosted routes, hosted feature implementations, and one browser-independent hosted-contribution subpath consumable by signed desktop.
- `packages/claxedo-host-connector` owns host-key proof, machine credential use, full local-inventory reconciliation, presence, renewal, reconnect, and supervision of the existing Bun multi-workspace or Cloudflare workspace-room host tunnels; unsigned/unlinked empty-shell launch does not start or import it, while Electron performs the account-authenticated enrollment call and starts the connector.
- Desktop development, production build, and server smoke use `@claxedo/local-server`; renderer boot uses the local `@claxedo/app` composition.
- Hosted Pages/development uses `@claxedo/cloud-app`; hosted Node/workerd uses `@claxedo/server`.
- Desktop sign-in uses system-browser OAuth with PKCE and a fixed, validated Electron callback. Electron main owns OS-protected credentials and exposes only sanitized account state plus tokenless typed operations; renderer, local-server, and Host Connector never receive account bearer or refresh tokens.
- Signed desktop lazy-loads cloud-app's browser-independent hosted contributions and supports account, shared-local, cloud workspace, WorkGraph, Documents, billing, and connection flows within the existing native shell.
- Enabling Remote Access combines explicit local machine-wide confirmation, a one-use Host Connector key proof, and Electron-held account auth to return one revocable enrollment covering all current and future canonical local workspaces; per-workspace roles still decide which signed users may open each workspace.
- Sign-out pauses connector publication and preserves same-owner resume metadata; Stop Sharing/revoke rotates the server generation and requires a new account-authorized enrollment.
- Host and signed-client reconnection satisfy U8-R20 and U8-R21: fresh authorization, fresh full-inventory reconciliation, restoration of the configured existing Relay registration mode, cursor resume or authoritative refetch, resource reattachment by ID, and no prompt resubmission caused by transport loss.
- Signed user-hosted access satisfies U8-R22 and U8-R23: Hosted Server remains the identity/mint/resolver authority; Workspace Relay remains the Runtime data path; the user-hosted connection descriptor exposes no direct laptop target; existing Relay and Workspace Runtime token, role, header, presence, limit, and audit gates retain their characterized behavior.
- Cloud workspace creation runs through cloud-app/server/sandbox-manager, remains accessible without the laptop, and shares the hosted Client/Protocol connection contract with user-hosted workspaces.
- Existing local profiles and durable state open through the new entry with unchanged identity and paths.
- Manifest, transitive source graph, emitted module/chunk manifest, and entry smoke gates pass for all four product packages, Host Connector, and desktop's permitted account/hosted-contribution composition, and fail on injected cross-product edges.
- Hosted auth, cloud workspace, remote sandbox, relay, WorkGraph, Documents, billing, connections, channels, and wakes retain their current integration coverage.
- The structural packaged-resource inventory, unsigned macOS launch smoke, and signed activation smoke use the same local and optional entries as development and production build.
- The Release Qualification Gate consumes the U8 boundary manifests directly; no second plan or rebuilt artifact is required.

## Documentation and Operational Notes

- Release machine remote access as a hard-cut deployment set using `docs/tech-docs/host-enrollment-hard-cut-runbook.md`, owned jointly by the control-plane release operator and desktop release owner. From `packages/claxedo-server`, the operator runs `bun run maintenance:cutover-host-enrollments -- preflight --environment <environment> --sha <sha>`, then `enter-maintenance`, proves the old Hosted Server/Relay writers are drained, runs `retire-legacy` and `verify-retirement`, deploys the same SHA's Convex schema/functions plus Hosted Server and Relay artifacts through the existing control-plane workflow, and runs `verify-new`. The desktop owner publishes that SHA's OAuth/account adapter and Host Connector only after `verify-new`; the operator then runs `exit-maintenance`. The runbook captures commands, actor, timestamps, counts, and evidence for every phase. Before `retire-legacy`, abort returns to the unchanged old authority. After it, there is no rollback or compatibility mode: keep Remote Access under maintenance and repair forward until zero-workspace enrollment plus Bun and Cloudflare add/remove/reconnect and same-owner sign-out/resume pass. Local desktop and cloud-VM paths remain independently available during this Remote Access window.
- Do not run or document the superseded mixed desktop-local producer, legacy account-link route, old enrollment challenge path, or old client shape after the cut. The retirement verification must report zero legacy links/challenges/token authority, and the new verification must report only generation-bound enrollment links.
- Do not promote that deployment set to production until this document's Release Qualification Gate accepts the exact packaged unsigned/signed artifact produced here. This is a release gate, not a dual-version compatibility period.
- Update deploy-unit documentation and CI path assertions from `packages/claxedo-app` to `packages/claxedo-cloud-app` only where they describe the hosted web product.
- Document the two-product/one-runtime plus optional Host Connector mental model in the app, cloud-app, local-server, host-connector, desktop, and server READMEs.
- Document that one account-authorized machine enrollment covers all current and future canonical local workspaces, that machine-wide failures affect all of them, that Cloudflare room failures can affect one workspace independently, and that per-workspace roles still govern signed-client access.
- Add troubleshooting for laptop sleep, network loss, terminal pause/revoke states, automatic backoff, expected presence expiry, client cursor recovery, and the requirement that the laptop and desktop remain running for user-hosted access.
- Record the public app composition exports and their ownership rules in `packages/claxedo-app/src/ARCHITECTURE.md`.
- Keep environment variables with their owning product: browser hosted auth/control-plane variables in cloud-app/server; the desktop public OAuth client ID, fixed callback/control-plane origins, local profile, provider, credential, harness, and telemetry variables in desktop/app/local-server; enrollment endpoint, Relay assignment, and connector lifecycle variables in Host Connector/desktop. Account secrets remain runtime credentials in Electron protected storage, never environment variables.
- Preserve stable hosted URLs, local ports, profile directories, and control-plane route contracts during the package move.
- Treat the boundary manifests as build evidence and retain them with this plan's packaged inventory and release-qualification reports.

## Sources and References

- **Origin:** `docs/plans/2026-08-07-003-refactor-claxedo-idle-memory-plan.md`, U8 plus R24–R28 and KTD8–KTD9
- **External product comparison:** [T3 Code architecture notes](https://github.com/pingdotgg/t3code/blob/main/AGENTS.md), [T3 Code user remote access](https://github.com/pingdotgg/t3code/blob/main/docs/user/remote-access.md), [T3 Code maintainer remote architecture](https://github.com/pingdotgg/t3code/blob/main/docs/internals/remote.md)
- **Desktop OAuth basis:** [Clerk public clients and PKCE](https://clerk.com/docs/guides/configure/auth-strategies/oauth/how-clerk-implements-oauth), [Clerk Frontend/native API overview](https://clerk.com/docs/reference/api/overview)
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
