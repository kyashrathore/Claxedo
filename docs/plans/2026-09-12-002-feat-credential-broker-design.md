# Credential broker: the system and the proposed change

Status: proposed; not implemented. Code checked at `47931bd727`.
Owner: Yash Rathore. Date: 2026-09-12.

**Today, Claxedo gives agents the actual model credential. This proposal keeps it outside the agent’s environment and attaches it to network requests through a trusted broker or provider edge.**

It also introduces personal accounts. That requires a second, larger change: deciding which user’s execution environment a workspace opens.

## 1. The pieces

When you open a workspace and send a prompt, these components cooperate:

| Piece | What it does | Example |
| --- | --- | --- |
| App | Shows Settings, workspaces, and conversations | You select Claude and send a prompt |
| Control plane | Stores credentials, authorizes access, and arranges execution | Decides which account and workspace you may use |
| Supervisor / sandbox manager | Starts or finds an execution environment | Wakes a container or VM |
| Sandbox driver | Talks to the machine provider | Docker, Daytona, Vercel |
| Workspace runtime | Receives configuration and drives agent sessions | Runs inside the sandbox, or embedded locally |
| Harness | Runs the agent and calls its model service | Claude Code, Codex, Pi, Cursor, OpenCode |

**Daytona + Claude** means Daytona supplies the machine and Claude supplies the agent. Their authentication mechanisms are separate.

A **workspace** is the logical project location; a **lease** identifies its running environment; a **session** is a conversation inside it. Several sessions and background processes can share one runtime.

## 2. How credentials reach an agent today

### A. You save an account

The [credential route](../../packages/claxedo-local-server/src/credentials/routes/credential.ts) resolves your organization, accepts the credential, and records consent if you allow cloud use.

It calls [registry.putCredential](../../packages/claxedo-server-core/src/credentials/registry.ts), which stores:

- Metadata in SQLite: provider, account ID, status, sharing scope, and a secret reference.
- Secret bytes through a backend. The default local backend uses [encrypted files with a nearby seed file](../../packages/claxedo-server-core/src/credentials/backends/local.ts), **not the OS keychain**.

Settings receives redacted metadata. “Stored” does not mean “accepted by the vendor” or “applied to every running agent.”

Local storage already supports multiple account rows, but has no personal owner or explicit active-account selection within an org. The [hosted adapter](../../packages/claxedo-server/src/credentials/worker/index.ts) instead stores one record per provider and does not enumerate accounts.

### B. You open a workspace

On the supervisor path, [runtimeState](../../packages/claxedo-server/src/workspace/supervisor/state.ts) finds state by workspace ID. The [lease table](../../packages/claxedo-server/src/sandbox/stores/lease.sql.ts) also has one row per workspace.

The supervisor starts or attaches the runtime, then [pushRuntimeConfig](../../packages/claxedo-server/src/workspace/supervisor/config-sync.ts) obtains a snapshot from [getRuntimeConfigSnapshot](../../packages/claxedo-server-core/src/agent-config/index.ts).

That producer:

1. Resolves eligible credentials for the org.
2. For cloud use, excludes credentials without sharing consent.
3. Picks one credential per provider using a preference order.
4. Sends version 3 config containing **provider → actual secret string**.

It receives no user identity for personal model-account selection. A management-authenticated POST protects who can configure the runtime; the runtime still reads the secret inside the payload.

The [runtime validator](../../packages/workspace-runtime/src/routes/config.ts) accepts the snapshot, and the [runtime](../../packages/workspace-runtime/src/workspace/runtime.ts) passes auth to its adapters. Locally, the runtime can be embedded in the server, avoiding the POST but retaining the same credential handoff.

Hosted provisioning has separate [create](../../packages/claxedo-server/src/routes/hosted/workspace.ts) and [connection/wake](../../packages/claxedo-server/src/connections/hosted-connection-info.ts) entrypoints. They must migrate too.

### C. You send a prompt

Each harness consumes auth differently:

| Harness | Current credential handoff |
| --- | --- |
| [Claude](../../packages/agent-sdk-runtime/src/harnesses/claude/auth.ts) | API key or subscription token in its process environment |
| [Codex](../../packages/agent-sdk-runtime/src/harnesses/codex/process-auth.ts) | Login RPC to the app-server, which maintains its own login state |
| [Pi](../../packages/agent-sdk-runtime/src/harnesses/pi/driver.ts) | Environment variables and an auth profile on disk |
| [Cursor](../../packages/agent-sdk-runtime/src/harnesses/cursor/driver.ts) | API key passed to SDK Agent.create |
| [OpenCode](../../packages/claxedo-server-core/src/opencode/sdk-credential-bridge.ts) | Separate bridge writes registry credentials into the engine’s configuration |

The harness calls the vendor, then returns session events through the runtime to the app.

This exposes credentials to the execution environment. Codex has another concrete problem: the [earlier live API-key experiment](2026-09-12-001-feat-provider-accounts-design.md#live-explicit-path-test-2026-09-12-codex) overwrote the operator’s own auth.json. That result was not rerun here and does not establish identical behavior for every login mode.

With no managed credential, a harness may use its existing machine login. The proposal must distinguish this deliberate choice from a managed credential failing; failure must not silently change the billed account.

### D. GitHub and MCP already take a different path

The [sandbox manager](../../packages/sandbox-manager/src/index.ts) accepts a separate secret channel containing a value, allowed hosts, and optional header.

- GitHub cloning supplies a complete authorization header.
- MCP supplies a scoped gateway token. The [gateway](../../packages/claxedo-server/src/agent-plugins/mcp/routes.ts) then checks access and resolves the actual integration credential.

Daytona substitutes placeholders in outbound headers; Vercel installs header transforms; Cloudflare currently uses a custom proxy. Unsupported brokering drivers refuse these secrets.

This path is incomplete: the inspected self-host supervisor supplies none, Daytona’s git placeholder lacks a consumer, and MCP’s producer/consumer formatting produces a doubled Bearer scheme under literal substitution. Docker also has an opt-in path that copies local login files into containers.

**The proposal extends this existing separation between secret storage and network use to model credentials.**

## 3. What changes

Three proposed records/responsibilities replace the raw-secret handoff:

| Concept | Meaning |
| --- | --- |
| Binding | This runtime generation may use credential C toward these destinations and permitted operations |
| Delivery adapter | Installs, rotates, and withdraws that authority through a provider edge or generic broker |
| Projection | The endpoint, auth mode, and placeholder the harness receives |

The registry remains authoritative for credential bytes. The control plane owns selection and bindings. Drivers implement delivery mechanics. Harness adapters translate projections into their native configuration.

### One concrete request: Claude through Daytona

This is the proposed model-credential flow, using Daytona’s existing secret-substitution mechanism.

1. Alice opens workspace W. The control plane checks her access, selects an eligible account, and creates binding B for lease L.
2. The Daytona adapter stores the real Anthropic key in Daytona’s secret system, restricted to `api.anthropic.com`, and attaches that secret to the sandbox at creation.
3. Inside the sandbox, the mapped environment variable contains an opaque placeholder such as `dtn_secret_…`. The runtime configures Claude’s API-key slot with that placeholder, not the original key.
4. Claude sends `POST https://api.anthropic.com/v1/messages` with `x-api-key: dtn_secret_…`.
5. Daytona’s outbound proxy recognizes the placeholder and allowed destination, substitutes the real key in the header, and forwards the request to Anthropic.
6. The response streams back to Claude; normal session events return to the app.

**Claxedo selects the account; Daytona attaches its credential.** The request does not pass through Claxedo’s generic broker. Code inside the sandbox can still use the placeholder toward the allowed host; hiding the key does not restrict individual API operations or spending.

Credential substitution hides the original key. Request policy limits its use. Network egress policy limits where the agent sends data. **Those are three separate protections**, and Daytona’s host-based substitution alone does not implement all three.

### Native provider edges

Where supported, the harness calls the vendor and the provider attaches auth, avoiding the generic broker hop.

[Daytona](https://www.daytona.io/docs/en/secrets/), [Vercel](https://vercel.com/docs/sandbox/concepts/firewall), and [Cloudflare](https://developers.cloudflare.com/sandbox/guides/outbound-traffic/) document relevant mechanisms. Our exact harness/SDK combinations still require live verification. Host substitution alone does not establish method/path restrictions, and generic-broker monitoring cannot observe traffic that bypasses it.

Other driver integrations remain feasibility work. The plan cannot yet promise every harness, subscription mode, and driver.

On the generic-broker path, the harness instead receives a broker URL and signed capability token. That broker must validate the binding, org, current lease generation, and request policy before attaching the real key. The capability remains usable delegated authority; its runtime claim does not prove the caller’s physical location.

### Placement: keep the request path near the VM

**Place or route the relay, credential gateway, and MCP gateway as close to the VM as practical.** Select them together with the sandbox’s region, and prefer the same region where supported. These are separate paths: model/MCP traffic need not pass through the relay.

Native injection avoids our credential-gateway hop. Where our gateway is needed, choose a nearby instance. The MCP gateway currently lives in the control-plane Worker; its placement and backing-state reads must be evaluated together. A nearby handler that repeatedly calls a distant authority still incurs that latency.

Record the selected region/endpoints on the lease and preserve that placement through wake/replacement. Cross-region operation should be an explicit, observable exception. Measure VM-to-relay and VM-to-gateway latency, including authorization/credential lookup and time to first streamed byte. Locality must preserve the same access and revocation checks; regional coordination and failure behavior remain design decisions.

## 4. What happens when something changes

| Event | Intended behavior | Missing detail |
| --- | --- | --- |
| Same account gets a new key | Increment credential revision and reconcile affected bindings | Durable trigger, crash recovery, and protection against delayed old writes |
| Old request returns 401 after rotation | Attribute failure to the old revision | Provider-specific classification; a 403 may mean resource permission, not bad auth |
| Broker token expires | Renew delegated access without exposing the original key | A one-hour token can expire during a long turn; next-turn restart is insufficient |
| Credential is withdrawn | Deny new requests without waiting for the sandbox to reconnect | Native propagation windows, consistent state reads, and in-flight behavior |
| Sandbox wakes or is replaced | Reconcile current bindings before ready; reject the old lease generation | Every create/wake route must enforce this |
| Account changes | Route future work to the appropriate fixed identity | What happens to existing sessions and files |

A successful probe proves one request worked; it does not distinguish two valid keys or establish global edge convergence.

Refresh also needs one authoritative coordinator per credential. [Cloudflare KV is eventually consistent](https://developers.cloudflare.com/kv/concepts/how-kv-works/); a KV record alone does not implement atomic refresh leases or immediate global revocation.

## 5. Why personal accounts change workspace architecture

Suppose Alice starts work in a sandbox, then Bob changes its account. Alice’s next request—or a background process she left running—can spend Bob’s credentials.

The proposal therefore fixes credential identity for a sandbox’s lifetime. Different identities receive different sandboxes.

**Today the system has one lease and runtime slot per workspace.** Supporting multiple identities changes lease keys, runtime caches, session routing, relay targets, activity holds, checkpoints, and compute accounting.

Two decisions remain central:

- **What constitutes an identity?** Sharing a model account does not imply sharing GitHub/MCP permissions. Identity must account for all delegated authority.
- **How do files and sessions behave across sandboxes?** Existing checkpoint/restore preserves one runtime’s lineage; it does not merge concurrent edits. A shared writable volume can also let Alice modify code Bob executes with Bob’s authority.

Locally, a loopback broker does not isolate same-user processes from credential files or ambient CLI logins. The local promise must either be narrower—no deliberate secret delivery—or include a real OS isolation boundary.

## 6. What approval needs to settle

| Decision | Required answer |
| --- | --- |
| Identity and workspace behavior | Which accounts/permissions define identity, how existing sessions survive switching, and how files/checkpoints are shared |
| Broker lifecycle | Active-turn renewal, accepted bearer replay, refresh coordination, revocation timing, and recovery after partial failure |
| Supported combinations | Real tests for each retained harness × auth mode × driver, including streaming, cancellation, native auth files, and policy enforcement |
| Regional placement | Coordinate VM, relay, and gateway selection; measure backing-state latency and define cross-region failure behavior |
| Local guarantee | Delivery hygiene or actual isolation from the operator’s credentials |
| Migration | Explicit v3/v4 version handling, durable credential-change reconciliation, and draining old runtimes |

The current v3 reader rejects unknown versions and fields. Sending v4 “alongside” raw v3 auth defeats confidentiality. Migrated runtimes must receive projections only, with no automatic plaintext fallback.

## 7. Implementation order and completion

1. Fix existing broker-channel contract defects in focused changes.
2. Resolve the decisions required for the first slice and record live feasibility results.
3. Complete one slice: Claude API key through Docker, then supported native edges. Exercise save → selection → turn → rotation → withdrawal → wake.
4. Add other proven harness/auth/driver combinations and migrate GitHub/MCP without removing their existing authorization checks.
5. Enable personal identities only after routing, persistence, and concurrent-user behavior are defined and tested.
6. Drain old runtimes and remove superseded plaintext producers, auth copies, and readers.

Completion requires a real turn using the intended vendor account, original credentials absent from isolated runtimes, cross-org/lease rejection, successful lifecycle tests, and no silent switch to ambient auth. Source searches supplement these checks; they cannot prove old snapshots or files are clean.

This plan retains design 001’s active-account concept but replaces its delivery proposal. Its older switching and delivery sections must be marked superseded when this design is finalized. Until then, both documents remain proposals.

**Benefit:** agents can use selected network credentials without receiving their original values. **Cost:** trusted traffic handling, lifecycle coordination, and potentially multiple execution environments per workspace.

Evidence: source and existing tests inspected; historical experiments linked above. No live broker feasibility tests or production changes were made for this document.
