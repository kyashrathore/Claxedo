# Credential broker: the system and the proposed change

Status: proposed; not implemented. Code checked at `47931bd727`.
Owner: Yash Rathore. Date: 2026-09-12.
No backward compatibility anywhere in this design: old snapshot versions, existing hosted credential rows, and the consent flag are removed, not migrated (owner decision, 2026-09-12).
Provenance: rewritten by Codex (`gpt-6-astra`) from the committed draft after its review of that draft; product rules and decisions taken by the owner the same night; the draft's tables are kept as appendices.

**Today, Claxedo gives agents the actual model credential. This proposal keeps it outside the agent’s environment and attaches it to network requests through a trusted broker or provider edge.**

It also introduces personal accounts. **An identity is a user.** Every user gets their own sandbox and working copy per workspace, isolated from every other user's; code moves between them only through the repository.

### Agreed product rules

- **Unsigned local:** no hosted control plane is involved until the user signs in. Credentials saved unsigned live in the local registry on the laptop (SQLite metadata, the encrypted-file secret backend) and are bound through the loopback broker to local workspaces and Docker sandboxes on that laptop. Nothing leaves the machine. A harness with its own CLI login may also run on that login, as today.
- **Signed in:** saved credentials live in the hosted control plane and are automatically eligible for cloud use. No separate cloud-consent toggle; the consent flag and its check are deleted. A signed desktop's local workspaces and Docker sandboxes use the same loopback broker, which pulls the bound credential's current revision from the hosted store (section 4). The local registry serves unsigned use only; a signed user's credentials are hosted, not copied down into it.
- **Per-sandbox attachment:** resolve the credential selection when creating a sandbox. By default, include the user's eligible AI provider credentials. “Include” grants use through native binding or the gateway; it does not mean copying the original secret into the VM.
- **Proposed setting:** project → sandbox credentials, with a per-user selection so one collaborator cannot choose another's personal accounts. Changes affect new sandboxes. Exact UI placement remains open; no new creation-time prompt is required.
- **Routing:** model credentials use verified native binding where supported and our credential gateway otherwise. Authenticated remote MCP retains the existing MCP gateway. Public MCP and local plugin execution do not automatically acquire a gateway hop.

Hosted storage eligibility and attachment are separate: saving makes a credential available for selection; project settings determine whether a particular sandbox receives authority to use it. Vendor expiry/revocation can still prevent requests. These are operational conditions, not another consent workflow.

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

A **workspace** is the logical project location; a **lease** identifies one user's running environment for it, keyed by `(workspace, user)`; a **session** is a conversation inside that environment and belongs to that user. Several of one user's sessions and background processes share one runtime; two users never do.

## 2. How credentials reach an agent today

### A. You save an account

The following describes existing credential plumbing, not the agreed product flow above. Its local-save and cloud-consent behavior must not become requirements for the new design.

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

For signed-in use, hosted credential storage remains authoritative for credential bytes. The control plane resolves the user's project selection at sandbox creation and owns bindings. Drivers implement delivery mechanics. Harness adapters translate projections into their native configuration. Unsigned local use creates local bindings against the local registry and never touches the hosted control plane; it uploads nothing.

A binding's **request policy** is part of the binding, not a follow-up: allowed methods and path prefixes per destination (a model binding allows the vendor's messages and responses paths; a GitHub binding the repository's paths; an MCP binding its one resource). The generic broker enforces it with 403; Vercel enforces it with rule matchers; Daytona and Cloudflare cannot express it, so on those drivers the egress allowlist is the only bound and the document says so per driver in Appendix C.

The credential gateway and the existing MCP gateway are **one service**: both resolve `(user, org, lease, binding)` per request and attach a credential; they share code, state, and placement (section 3, Placement).

### One concrete request: Claude through Daytona

This is the proposed model-credential flow, using Daytona’s existing secret-substitution mechanism.

1. Alice opens workspace W. When creating her sandbox, the control plane checks her access, resolves her project's credential selection (AI provider credentials included by default), and creates binding B for lease L for the selected Anthropic account.
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

Native injection avoids our credential-gateway hop. Where our gateway is needed, choose a nearby instance. The MCP gateway currently lives in the control-plane Worker and becomes one service with the credential gateway; its placement and backing-state reads are evaluated once for both. A nearby handler that repeatedly calls a distant authority still incurs that latency.

Record the selected region/endpoints on the lease and preserve that placement through wake/replacement. Cross-region operation should be an explicit, observable exception. Measure VM-to-relay and VM-to-gateway latency, including authorization/credential lookup and time to first streamed byte. Locality must preserve the same access and revocation checks; regional coordination and failure behavior remain design decisions.

## 4. What happens when something changes

| Event | Intended behavior | Missing detail |
| --- | --- | --- |
| Same account gets a new key | Increment credential revision and reconcile affected bindings | Durable trigger, crash recovery, and protection against delayed old writes |
| Old request returns 401 after rotation | Attribute failure to the old revision | Provider-specific classification; a 403 may mean resource permission, not bad auth |
| Broker token expires | Renew delegated access without exposing the original key | A one-hour token can expire during a long turn; next-turn restart is insufficient |
| Credential is withdrawn | Deny new requests without waiting for the sandbox to reconnect | Native propagation windows, consistent state reads, and in-flight behavior |
| Sandbox wakes or is replaced | Reconcile current bindings before ready; reject the old lease generation | Every create/wake route must enforce this |
| Project credential selection changes | Apply the selection to new sandboxes; do not silently replace authority in an existing sandbox | Explicit replacement/resume UX, if needed |
| Loopback broker on a signed desktop needs a value | Pull the binding's current revision from the hosted store, cache it in the local server process only, re-pull on a revision change pushed with the config | The local server process holds the value; the harness process never does. This is the local guarantee and the whole of it |
| A wake or scheduled turn fires for a session | Runs in the session owner's sandbox with the owner's authority | This replaces the connections kit's rule that automation never spends a personal token; the kit's resolver takes the session owner as the subject |

A successful probe proves one request worked; it does not distinguish two valid keys or establish global edge convergence.

Refresh also needs one authoritative coordinator per credential. [Cloudflare KV is eventually consistent](https://developers.cloudflare.com/kv/concepts/how-kv-works/); a KV record alone does not implement atomic refresh leases or immediate global revocation.

## 5. Why personal accounts change workspace architecture

Suppose Alice starts work in a sandbox, then Bob changes its account. Alice’s next request—or a background process she left running—can spend Bob’s credentials.

The proposal therefore fixes credential identity for a sandbox’s lifetime. Different identities receive different sandboxes and working copies; the user has confirmed this isolation goal. Collaborators exchange changes through Git rather than sharing a live writable checkout in this proposal.

**Today the system has one lease and runtime slot per workspace.** Supporting multiple identities changes lease keys, runtime caches, session routing, relay targets, activity holds, checkpoints, and compute accounting.

Decided (owner, 2026-09-12):

- **An identity is a user**, carrying all of that user's delegated authority: model accounts, GitHub, MCP, deploy tokens. The lease key becomes `(workspace_id, user_id)`; the supervisor's runtime map, session routing, the relay target, holds, checkpoints, and the usage ledger take the user alongside the workspace.
- **Sandboxes are fully isolated.** Each user's sandbox has its own filesystem, cloned or restored for that user; checkpoint and restore stay one lineage per `(workspace, user)`; nothing is shared between two users' sandboxes; code moves through the repository.
- **A session belongs to its owner's sandbox.** Only the owner drives it; other members may read it. A prompt from anyone else is refused, never attributed to the owner's authority. Moving a conversation to another user's sandbox is not supported.

Unsigned local use keeps the local registry and retains local harness authentication. A local process running as the operator can potentially read that operator's CLI login files. A loopback broker does not change this OS boundary; protecting those files from the agent would require separate OS isolation and is not implied by cloud credential brokering. What the loopback broker does guarantee, unsigned or signed: a credential saved in Claxedo is held by the local server process and never by the harness process or a Docker container.

## 6. What approval needs to settle

| Decision | Required answer |
| --- | --- |
| Identity and workspace behavior | **Decided:** identity is the user; one sandbox and checkout per `(workspace, user)`; sessions owner-driven. Remaining: the lease-key change across every table keyed by workspace alone |
| Credential selection | Proposed project setting per user; AI providers included by default; apply on sandbox creation; exact UI placement remains open |
| Broker lifecycle | Active-turn renewal, accepted bearer replay, refresh coordination, revocation timing, and recovery after partial failure |
| Supported combinations | Real tests for each retained harness × auth mode × driver, including streaming, cancellation, native auth files, and policy enforcement |
| Regional placement | Coordinate VM, relay, and gateway selection; measure backing-state latency and define cross-region failure behavior |
| Local guarantee | **Decided:** unsigned local uses the local registry, nothing hosted; in both modes the value is held by the local server process only, never the harness or container; OS isolation from CLI logins is out of scope |
| Migration | **Decided: none.** The v3 reader, the plaintext `auth` producer, the consent flag, the plaintext push from the local registry, the Docker auth copy, the Cloudflare `/egress` route, and the OpenCode SDK bridge are deleted in the change that lands their replacement; the hosted store is replaced by a many-rows-per-provider store with an owner, not migrated; running sandboxes are destroyed and recreated |

The v3 reader is deleted with the plaintext producer; runtimes receive projections only, with no plaintext fallback.

## 7. Implementation order and completion

1. Fix the broker-channel defects in Appendix B in focused changes; upgrade the four sandbox SDKs and re-declare the catalog from Appendix A.
2. Run the feasibility items in Appendix E and record each result there.
3. Replace the hosted credential store: many rows per provider, an owner per row, enumeration, per-project selection per user. No migration of existing rows.
4. Move the lease, supervisor map, session routing, relay target, holds, checkpoints, and usage ledger to `(workspace, user)`; sessions gain an owner.
5. One slice end to end on a signed desktop: Claude API key through Docker via the loopback broker, then Daytona and Vercel native. Exercise save → selection → turn → rotation → withdrawal → wake, with the adversarial checks in the completion list.
6. Add each further harness, auth mode, and driver as its Appendix E result allows; fold GitHub and MCP bindings onto the contract with the merged gateway.
7. Delete every superseded path in the same change as its replacement: plaintext producer and v3 reader, consent flag, the plaintext push from the local registry, Docker auth copy, Cloudflare `/egress` route, OpenCode SDK bridge, Codex login RPC and its mirror into the CLI file.

Completion requires a real turn using the intended vendor account, original credentials absent from isolated runtimes (env, `/proc/*/environ`, disk), cross-org and cross-lease token rejection, replay after withdrawal rejected, a 401 on a stale revision not failing the current one, a request outside policy refused with 403, a 3xx from the vendor returned as 502 without `Location`, two users on one workspace each in their own sandbox on their own account verified by the vendor-side account id, a wake running in the owner's sandbox, `~/.codex/auth.json` on the operator's machine byte-identical across a Codex turn, and no silent switch to ambient auth. Source searches supplement these checks; they cannot prove old snapshots or files are clean.

This plan replaces design 001's delivery proposal and its "active account per provider" with per-project, per-user selection at sandbox creation. Design 001 is superseded in full except for its stress-test findings and live-test record, which remain the evidence for section 2.

**Benefit:** agents can use selected network credentials without receiving their original values. **Cost:** trusted traffic handling, lifecycle coordination, and potentially multiple execution environments per workspace.

Evidence: source and existing tests inspected; historical experiments linked above. No live broker feasibility tests or production changes were made for this document.

---

## Appendix A. Sandbox providers and harnesses, checked against their docs 2026-09-12

Checked against each provider's current documentation on 2026-09-12. The
catalog (`sandbox-manager/src/driver-catalog.ts`) is the left column.

| Driver | Catalog says | Provider today | SDK pinned → latest |
| --- | --- | --- | --- |
| daytona | native; hosts and CIDRs | Placeholder swapped in HTTPS headers to allowed hosts, responses scrubbed. `updateSecrets` on a running sandbox; a value change lands within about 15 seconds; a sandbox created with no secrets must restart to receive one. | 0.192.0 → 0.211.2 |
| vercel | native; hosts | Header transform per domain, with matchers on path, method, query, headers; `forwardURL` to your own proxy with an OIDC token naming the sandbox; denied CIDR ranges; live policy updates. | 1.10.2 → 3.3.0 |
| cloudflare | proxy, opt-in; no egress control | Outbound Workers since 0.8.0: host allow and deny lists evaluated before handlers, per-host handlers in the Worker, HTTPS intercepted with a per-sandbox CA, header injection in the handler. | 0.8.9 → 0.12.9 |
| exe | none; none | Integrations: the secret is stored server-side and injected at the edge when the VM calls `<name>.int.exe.xyz`; HTTP proxy, GitHub, S3 signing, and an LLM integration that takes an Anthropic or OpenAI key or a **ChatGPT subscription** by device-code login. Attach per VM, per tag, or all. No egress allowlist. | driven over `/exec` |
| modal | none; none | Secrets are still readable env. Sandbox Sidecars (alpha, allowlisted workspaces) run a proxy that holds the secret while the sandbox has `outbound_cidr_allowlist=[]`; `outbound_domain_allowlist` (beta); `updateNetworkPolicy` (alpha). | 0.7.5 → 0.10.1 |
| box | none | Plaintext env inside a `docker run` command string; no secret or egress feature. | — |
| docker | none | Plaintext `--env`; loopback only. | — |

And what each harness accepts, verified from the installed binaries:

| Harness | Base URL | Credential | Extra headers |
| --- | --- | --- | --- |
| Claude Code | `ANTHROPIC_BASE_URL` | `ANTHROPIC_API_KEY` (API key mode) or `ANTHROPIC_AUTH_TOKEN` / `CLAUDE_CODE_OAUTH_TOKEN` (bearer modes); `apiKeyHelper` | `ANTHROPIC_CUSTOM_HEADERS` |
| Codex | `model_providers.<id>.base_url`; `chatgpt_base_url` for the subscription backend | `requires_openai_auth` decides whether a login is needed | `http_headers`, `env_http_headers` |
| Cursor | `CURSOR_API_ENDPOINT` (CLI flag `--endpoint`; SDK support unverified) | `CURSOR_API_KEY` | — |
| Pi | per-provider config; keys unverified | env | — |
| OpenCode engine | per-provider `options.baseURL` in its config; unverified | its own auth store | — |

## Appendix B. The ten defects in today's delivery paths

Each is a fact about the code above, not a preference.

1. **Every model credential is readable by the agent.** Claude and Pi put
   it in the child env; Codex writes it to disk; the OpenCode bridge writes
   it to the SDK store. On every driver, including the ones that could
   broker it. (section 2.C)
2. **A stored Codex account clobbers the operator's login.** The app-server
   writes the explicit login into the user's own `~/.codex/auth.json` and
   keeps it in memory across logout. (section 2.C; design 001, finding 12)
3. **No personal accounts.** The snapshot has no user; the registry has no
   owner. Two people in one org run on one account. (section 2.B, 2.D)
4. **Refresh is in the wrong places.** Codex refreshes inside the
   app-server; Claxedo's helper mirrors into the CLI file; Claude
   subscription tokens are never refreshed. (section 2.B)
5. **Brokering is used by two producers and honoured inconsistently.** The
   clone token has no consumer on Daytona; the self-hosted supervisor sends
   no secrets; resume on Daytona does not re-attach; the Cloudflare JWT
   dies at 15 minutes with no refresh. (section 2.D)
6. **A defect in the one working consumer.** The MCP producer stores
   `Bearer <token>` and the consumer prefixes `Bearer ` again, so a Daytona
   sandbox sends `Bearer Bearer …`. (`runtime-preparation.ts:301`,
   `runtime-contribution.ts:174`)
7. **The catalog is stale.** exe.dev and Cloudflare are marked `none` or
   `proxy` while both broker natively; Modal's sidecar and domain allowlist
   are unmodelled; every SDK pin is behind. (Appendix A)
8. **Two paths exist only because of 7.** The Cloudflare proxy Worker and
   the Docker auth copy are workarounds for capabilities the providers now
   have or for a problem (local containers) the generic broker below solves
   once.
9. **Egress auto-allow is org-wide.** Storing any credential adds a network
   policy row with no workspace id, opening that provider's host group for
   every workspace. (`claxedo-server-core/src/sandbox/network/policy.ts:279`)
10. **Consent is enforced only in the push.** The `shared` scope respects
    the row's consent flag; nothing else does.

## Appendix C. Delivery adapter per driver (draft; confirmed only by Appendix E results)

| Driver | apply | rotate | withdraw | Projection |
| --- | --- | --- | --- | --- |
| daytona | `secret.create` per binding with `hosts`; referenced at sandbox create as the placeholder env var | `updateSecrets`; the adapter reports the documented ~15 s propagation and the control plane treats the revision as applied only after a verify probe through the sandbox succeeds | set the value to a revoked sentinel, then delete the secret | vendor host; placeholder = the env var's value |
| vercel | policy union with `transform` rules, plus `match` on the vendor's paths (the policy-level equivalent of the broker's `allow`) | `update({networkPolicy})` with the new value | remove the rule | vendor host; any dummy |
| cloudflare | `outboundByHost` handler reading the binding table; `allowedHosts` from the union of bindings and the network policy | table write; no sandbox call | table write | vendor host; any dummy |
| exe | `integrations add` (LLM integration for model accounts, HTTP proxy for the rest) attached to the VM over `/exec` | `integrations edit` | `integrations detach` then delete | `https://<name>.int.exe.xyz`; any dummy |
| modal | sidecar proxy from the binding table when the workspace is allowlisted; otherwise the generic broker | sidecar reads the table | table write | sidecar URL or broker URL |
| box, docker | generic broker | table write | table write | broker URL |

A sandbox created before its first account is connected (Daytona's restart
case) is provisioned with a placeholder binding per provider the workspace
may use, valueless, so the env var exists from boot and only ever changes
value. The Docker auth-file copy and the Cloudflare `/egress` Worker route
are deleted when their replacements land (5.3).

## Appendix D. Findings from the review of the first draft (section numbers refer to that draft)

From the Codex review of the first draft (2026-09-12, evening).

| Finding | Where addressed |
| --- | --- |
| Runtime-wide per-user switching charges the wrong account; background processes make it worse | 3.1 (one identity per sandbox) |
| Generic broker authentication unspecified: token transport, renewal, scope, replay | 3.3 |
| Native updates propagate in seconds; "next request" is not a guarantee | 3.4, 3.5 (revisions, degraded state, probe) |
| Host-only lookup cannot represent MCP bindings sharing a gateway host | 3.3 (binding id in the path; target header kept for MCP) |
| Selection is not versioning; delayed updates and wakes can reinstall old values; a late 401 can fail a fresh key | 3.5, 3.3 failure reporting |
| Phase 1 deleted plaintext before replacements existed; Pi, OpenCode, the SDK bridge unaddressed | Phase 1 feasibility, Phase 4 deletions, 5.3 tables |
| Consent dropped from binding resolution | 3.6 |
| "Rate limits are a follow-up" unacceptable for GitHub and deploy tokens | 3.3 policy |
| Response scrubbing and redirect handling overstated | 3.3 rules, 3.8 |
| Projection erased API-key versus bearer mode | 3.2 typed projection |
| "Scheduled verifier" and "refresh exists" overstated | 3.7, 3.5 |
| Hosted store holds one row per provider and cannot enumerate | Phase 4 migration |
| "Only two drivers honour" brokering; Cloudflare 0.8.0 not 0.8.9; Vercel CIDRs | Part 2 corrected |
| Ambient auth: `harnessSpawnEnv` strips internal variables, not provider keys | Phase 4 deletion of every plaintext producer, asserted by test |
| Local boundary undefined | 3.3 (loopback broker authenticates with the same token; Docker reaches it via `host.docker.internal`, verified in Phase 2's gate) |

## Appendix E. Feasibility items, each answered in writing before step 5

Each item is a live experiment with a written result in Appendix B.

1. Daytona substitutes inside `x-api-key` (Claude API-key mode), not only
   `Authorization`.
2. A Vercel `transform` overwrites a header the client sent.
3. Cloudflare 0.12.x outbound handlers intercept HTTPS from Bun and Node
   clients in our runtime image; `setOutboundByHost` changes a running
   sandbox.
4. Codex on a ChatGPT subscription through a proxy: `chatgpt_base_url` with
   a dummy local login, or the `model_providers` form with
   `requires_openai_auth=false`. exe.dev's LLM integration proves the shape
   is possible; we need it to work with our app-server driver.
5. Cursor's SDK honours `CURSOR_API_ENDPOINT` or an equivalent.
6. Pi and the OpenCode engine: the config keys for per-provider base URL.
7. exe.dev: team versus personal integrations; `integrations edit` swaps a
   value without detaching.
8. Modal sidecar allowlisting for our workspace.
9. The signed user's subject reaches the sandbox provisioning call in every
   deployment mode (needed by 3.6).

Each item is answered yes, no, or "with this change", with the command, the provider, the date, and the result. A "no" removes that harness or driver from step 6's scope rather than weakening the design.
