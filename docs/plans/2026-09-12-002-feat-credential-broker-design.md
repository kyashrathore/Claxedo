# Credential broker: the system and the proposed change

Status: implemented for the local deployment, merged to `dev` (2026-09-14). The loopback broker,
the binding authority over the local registry, the projection into every harness and the OpenCode
engine, and the refusal of a selected-but-unusable account all run and are tested. Outstanding: the
hosted credential store, lease identity, and delivery into a cloud sandbox — sections 4 and 6 remain
a proposal. Code checked at `5c7bd5e1f6` (2026-09-14); see the Open findings appendix for what a
third review left standing.

Native delivery into a cloud sandbox is built on this branch for the supervisor rail — Daytona,
Vercel and Cloudflare (`fe285a4cd5`, `e5b854b06d`, `954d848555`) — and Appendix C describes it as
code rather than as a draft. Not built: the hosted rail's own credential store, and attribution of
a vendor 401 seen from inside a natively brokered sandbox. No live vendor turn has run through it,
and two Daytona acceptance criteria named at the end of Appendix C remain unmet.
Owner: Yash Rathore. Date: 2026-09-12.
No backward compatibility anywhere in this design: old snapshot versions, existing hosted credential rows, and the consent flag are removed, not migrated (owner decision, 2026-09-12).
Provenance: rewritten by Codex (`gpt-6-astra`) from the committed draft after its review of that draft; product rules and decisions taken by the owner the same night; the draft's tables are kept as appendices.

**Today, Claxedo gives agents the actual model credential. This proposal keeps it outside the agent’s environment and attaches it to network requests through a trusted broker or provider edge.**

It also introduces personal accounts. **An identity is a user.** Every user gets their own sandbox and working copy per workspace, isolated from every other user's; code moves between them only through the repository.

### Agreed product rules

- **Unsigned local:** no hosted control plane is involved until the user signs in. Credentials saved unsigned live in the local registry on the laptop (SQLite metadata, the encrypted-file secret backend) and are bound through the loopback broker to local workspaces and Docker sandboxes on that laptop. Nothing leaves the machine. A harness with its own CLI login may also run on that login, as today.
- **Signed in:** saved credentials live in the hosted control plane and are automatically eligible for cloud use. No separate cloud-consent toggle; the consent flag and its check are deleted. A signed desktop's local workspaces and Docker sandboxes use the same loopback broker, which pulls the bound credential's current revision from the hosted store (section 4). The local registry serves unsigned use only; a signed user's credentials are hosted, not copied down into it.
- **Per-sandbox attachment:** resolve the credential selection when creating a sandbox. By default, include the user's eligible AI provider credentials. “Include” grants use through native binding or the gateway; it does not mean copying the original secret into the VM.
- **Selection:** a user's AI provider accounts are global across projects: the user adds accounts and marks one active per provider in Settings → Providers, and that choice follows the user into every sandbox they create. The per-project setting has one entry today, "attach my AI provider accounts on every sandbox creation", on by default. An admin binds a team account to a project; sandboxes for that project use it for any member with no active personal account for that provider. More per-project and per-sandbox-creation settings may come later; none is designed here.
- **Resolution order at sandbox creation, per provider:** the user's active personal account, else the project's team binding, else the implicit tier (the harness's own CLI login, local only).
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

This section is the 2026-09-12 picture the proposal was written against. The plaintext paths it
names are gone from the local deployment; Appendix B records which, and design 001's Background
describes the delivery that replaced them.

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

For signed-in use, hosted credential storage remains authoritative for credential bytes. The control plane resolves the user's active accounts and the project's team bindings at sandbox creation and owns bindings. Drivers implement delivery mechanics. Harness adapters translate projections into their native configuration. Unsigned local use creates local bindings against the local registry and never touches the hosted control plane; it uploads nothing.

A binding's **request policy** is part of the binding, not a follow-up: allowed methods and path prefixes per destination (a model binding allows the vendor's messages and responses paths; a GitHub binding the repository's paths; an MCP binding its one resource). The generic broker enforces it with 403; Vercel enforces it with rule matchers; Daytona and Cloudflare cannot express it, so on those drivers the egress allowlist is the only bound and the document says so per driver in Appendix C.

The credential gateway and the existing MCP gateway are **one service**: both resolve `(user, org, lease, binding)` per request and attach a credential; they share code, state, and placement (section 3, Placement).

### One concrete request: Claude through Daytona

This is the proposed model-credential flow, using Daytona’s existing secret-substitution mechanism.

1. Alice opens workspace W. When creating her sandbox, the control plane checks her access, resolves her active Anthropic account (her personal one, else the project's team binding), and creates binding B for lease L.
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
| The user marks another account active, or an admin rebinds the project's team account | Applies to new sandboxes; an existing sandbox keeps its identity until destroyed | The Providers page names the sandboxes still on the old account |
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
| Credential selection | **Decided:** personal accounts global, active per provider in Settings; team accounts bound to a project by an admin; resolution order personal → team → implicit; the project setting is one default-on switch for now |
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

This plan replaces design 001's delivery proposal. Design 001 keeps the accounts model (add accounts, one active per provider, in Settings) and is revised to sequence the accounts work on top of this document.

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
| cloudflare | native named-placeholder injection; no egress control | Outbound Workers since 0.8.0: host allow and deny lists evaluated before handlers, per-host handlers in the Worker, HTTPS intercepted with a per-sandbox CA, header injection in the handler. | 0.8.9 → 0.12.9 |
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
   self-hosted supervisor sends no secrets; resume on Daytona does not
   re-attach; the Cloudflare JWT dies at 15 minutes with no refresh.
   (section 2.D)
   FIXED: the self-hosted supervisor carries `SandboxEnsureInput.secrets`
   through `startRuntime` and `startSandbox`; Daytona reconciles brokered
   secrets on reuse and resume; the Cloudflare JWT and its `/egress` route are
   replaced by native outbound handlers (Appendix E, Cloudflare entries).

   On the clone token, what remains after the 2026-09-13 repair: the runtime
   host installs the placeholder as a github.com-only `http.extraheader` at
   boot and removes it when the placeholder is gone, so any `git` run inside
   the sandbox — an agent's own clone, a `npm i github:…` — carries the
   brokered credential. What still has **no consumer** is the workspace's own
   initial clone. `workspaceRuntimeSourceEnv` (sandbox-manager) and
   `hosts/workspace-runtime/env.ts` (server-core) both write
   `WORKSPACE_RUNTIME_SOURCE_KIND` and `WORKSPACE_RUNTIME_GIT_REPO_URL` into
   every sandbox, and a repository-wide search finds no reader of either on any
   driver: the authenticated clone URL that `authenticatedGitHubCloneSource`
   produces reaches the sandbox and nothing acts on it. `workspace/git.ts`'s
   `cloneRepo` has no callers (dead code; its removal is landing in this
   pass). Cloning the workspace repository at boot is therefore unimplemented
   rather than mis-brokered, and belongs with the runtime host that would
   perform it.
6. **A defect in the one working consumer.** The MCP producer stored
   `Bearer <token>` and the consumer prefixed `Bearer ` again, so a Daytona
   sandbox sent `Bearer Bearer …`. FIXED: the producer
   (`agent-plugins/mcp/runtime-preparation.ts`) emits the complete
   `Authorization` value and the consumer
   (`agent-plugins/runtime/runtime-contribution.ts`) uses the placeholder as
   the whole header, so literal substitution inserts exactly one scheme.
7. **The catalog is stale.** exe.dev and Cloudflare are marked `none` or
   `proxy` while both broker natively; Modal's sidecar and domain allowlist
   are unmodelled; every SDK pin is behind. (Appendix A)
   FIXED for Cloudflare (`native`, no egress control) and for the pins
   (Daytona 0.211.2, Vercel 3.3.0, Modal 0.10.1, Cloudflare 0.12.9). exe.dev
   and Modal stay `none`: their adapters are unbuilt (Appendix C), and the
   catalog declares what a driver does, not what its provider could.
8. **Two paths exist only because of 7.** The Cloudflare proxy Worker and
   the Docker auth copy are workarounds for capabilities the providers now
   have or for a problem (local containers) the generic broker below solves
   once.
9. **Egress auto-allow is org-wide.** Storing any credential adds a network
   policy row with no workspace id, opening that provider's host group for
   every workspace. (`claxedo-server-core/src/sandbox/network/policy.ts`)
   FIXED: the save-time grant and its helpers are gone, a migration deletes
   the rows it wrote, and a restricted sandbox now derives the provider hosts
   at ensure time from the credentials the fanout sends it
   (`claxedo-server/src/sandbox/network/workspace-policy.ts`), writing no row.
10. **Consent is enforced only in the push.** The `shared` scope respects
    the row's consent flag; nothing else does.

## Appendix C. Delivery adapter per driver

Built for the supervisor rail on this branch (`fe285a4cd5` and the two fixes
after it). One module answers both halves of the decision —
`claxedo-server-core/src/credentials/native-delivery.ts` — reading the same
active-account selection and the same destination table the loopback broker
reads, and producing per provider a secret for the driver and a projection for
the runtime. `claxedo-server/src/credentials/sandbox-delivery.ts` merges that
set with whatever the request itself stated (a repository clone token, an MCP
runtime token) and hands the whole desired set to the sandbox manager.

| Driver | apply | rotate | withdraw | Projection |
| --- | --- | --- | --- | --- |
| daytona | `secret.create` per account with `hosts`; referenced at create as the env var it mounts | `secret.update` on the same name, so the mounted names do not change and the sandbox is not restarted | reconcile writes the revoked value and empties `hosts`, keeping the name mounted; `destroy` deletes | vendor origin; `placeholderEnv` names the mounted variable |
| vercel | policy union with a `transform` rule per host; the sandbox boots with the placeholder under the same variable | `update({networkPolicy})` with the new value | remove the rule | vendor origin; `placeholderEnv` names that variable |
| cloudflare | `outboundByHost` registration per host sent server-to-server with the create call; the sandbox boots with the placeholder under the same variable | registration write; no sandbox call | registration write | vendor origin; `placeholderEnv` names that variable |
| exe | `integrations add` (LLM integration for model accounts, HTTP proxy for the rest) attached to the VM over `/exec` | `integrations edit` | `integrations detach` then delete | `https://<name>.int.exe.xyz`; any dummy |
| modal | sidecar proxy from the binding table when the workspace is allowlisted; otherwise the generic broker | sidecar reads the table | table write | sidecar URL or broker URL |
| box, docker | generic broker | table write | table write | broker URL |

The last three rows are unbuilt. A driver declaring `secretBrokering: "none"`
is handed nothing and the manager refuses to provision it
(`secret_brokering_unsupported`) rather than downgrade a value to readable env.

**The placeholder is one shape across the three built drivers.** Each brokered
secret's `name` is the environment variable the sandbox reads its placeholder
from, and the driver guarantees that variable holds a string its own edge
accepts: Daytona mounts the secret and substitutes the value it issued, while
Vercel and Cloudflare boot the sandbox with `claxedo-broker:<name>` and write
the header at the edge. The projection therefore carries `placeholderEnv`
rather than a placeholder, and the runtime resolves it against its own
environment at the config boundary, so every harness keeps reading the one
`{baseUrl, placeholder}` shape the loopback broker already gives it. A variable
the provider never filled resolves to `unavailable`, which refuses the turn
instead of letting it run on the image's own login.

**A vendor header's scheme belongs to the driver.** Daytona substitutes into a
header the harness already wrote, so its secret carries the bare token; Vercel
and Cloudflare write the whole header, so they compose `Bearer ` back in from
the secret's `scheme`. A vendor that also needs a fixed companion header — the
ChatGPT account id — is refused rather than half-delivered, because a provider
edge attaches one header per secret.

**Withdrawal is reconciliation, not an event.** The supervisor resolves the
desired set before it decides whether a warm runtime can answer, so an account
revoked, replaced or marked `auth_failed` since the sandbox went ready is
withdrawn from the provider edge on the next ensure, resume or wake, and the
projection pushed with that config says `unavailable`. A deployment with no
marked account and no stated secret says nothing at all, rather than an empty
set, which would withdraw secrets another caller installed.

A sandbox created before its first account is connected (Daytona's restart
case) is provisioned with the valueless sentinel slot, so the mount exists from
boot and connecting the first account only adds a name. The Docker auth-file
copy and the Cloudflare `/egress` Worker route are deleted when their
replacements land (5.3).

**Two acceptance criteria of the Daytona rail are UNMET, and the rows above
assume both.** Appendix E item 1 has still not been run, so nothing shows that
Daytona substitutes a placeholder inside `x-api-key` rather than only inside
`Authorization` — every Anthropic API-key account on that driver rests on it.
And nothing shows that the placeholder a sandbox holds survives a
`secret.update`: the runtime reads `process.env` once, in
`normalizeRuntimeSnapshot`, so a provider that reissues the placeholder on
rotation would leave the harness sending a string the edge no longer knows,
and the no-restart rotation in the table would be wrong. Both are answered by
the synthetic-value probe in `scratchpad/daytona-feasibility/`, which needs a
Daytona key this branch has not had.

**Not built here.** The hosted create and wake routes still forward only what
`prepareRuntime` returns, because a signed user's accounts live in the hosted
store that section 4 replaces. And a vendor 401 seen from inside a natively
brokered sandbox marks nothing: the classification runs in the sandbox
(`agent-sdk-runtime/src/first-turn-error.ts`) and lands in a session event the
control plane only proxies — the workspace runtime makes no report call back to
it — so attributing that failure needs a runtime-to-server channel that does not
exist yet. On the loopback path the broker still attributes it through
`reportFailure`, because there the request passes through this process.

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
   **Result 2026-09-13: not run.** The `DAYTONA_API_KEY` in
   `packages/claxedo-server/.env` is rejected by `app.daytona.io` with 401
   `Invalid credentials` before any secret or sandbox is created (well
   formed, so revoked or wrong org). The probe
   (`scratchpad/daytona-feasibility/probe.ts`) needs no real secret: a
   synthetic value allowlisted to `httpbin.org`, echoed back through
   `x-api-key`, `Authorization`, a body echo, and a non-allowlisted host.
   It reruns unchanged once a valid key is in that file. Daytona's docs and
   the SDK typings claim substitution in any header on allowlisted hosts
   with response rewriting; unconfirmed.
2. A Vercel `transform` overwrites a header the client sent.
3. Cloudflare 0.12.x outbound handlers intercept HTTPS from Bun and Node
   clients in our runtime image; `setOutboundByHost` changes a running
   sandbox. Interception cannot be narrowed to the registered hosts:
   `@cloudflare/containers` promotes the container to intercept-all the moment
   `setOutboundByHosts` registers one host, latches that promotion until the
   instance restarts, and installs `interceptOutboundHttps('*')` under
   `interceptHttps`; per-host interception is reachable only from the static,
   deploy-time `outboundByHost` class registry, which cannot carry per-sandbox
   registrations. So every HTTPS connection the container makes terminates at
   our Worker. The local probe exercised only Node and Bun clients; the CLIs
   baked into the runtime image — `claude`, `codex`, `gemini`, `pi`,
   `cursor-agent`, `amp`, `droid` — were not probed, and one that pins its own
   CA bundle or ships its own TLS stack fails against an intercepted
   connection. **That is the reason deployed acceptance is still required.**
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

### Experiment log — 2026-09-13, item 3

Provider: Cloudflare Sandbox 0.12.9, local Wrangler 4.127.1, production runtime Dockerfile and compatibility date `2025-04-01`.

Commands (from `packages/claxedo-server/scripts/sandbox`, then its `cloudflare-worker` directory):

- `bun build-sandbox-image.ts --bundle-only --out=cloudflare-worker/.build`: initially failed because the host's first-party MCP dependency was absent from the image manifest roots. After adding the canonical `claxedo-mcp` package root, passed; build ID `30f6471c69`.
- `npx wrangler deploy --dry-run --containers-rollout=none --config feasibility/wrangler.toml --outdir .artifacts/outbound-feasibility`: passed Worker bundling only; no deployment.
- `npx wrangler dev --config feasibility/wrangler.toml --port 8793`: failed building the image at `FROM docker.io/cloudflare/sandbox:0.12.9`, `DeadlineExceeded: context deadline exceeded` while fetching base-image metadata. Docker daemon was running; Wrangler OAuth authentication was available.

Result: **not run: the current runtime container image could not be built because the base-image fetch timed out.** Neither Bun/Node HTTPS interception nor a live handler update is proven. The reproducible local probe is in `cloudflare-worker/feasibility/`; its check must pass before a deployed experiment, and a local pass must not be reported as deployed provider acceptance. The existing 15-minute JWT expiry remains unfixed; the design's native outbound replacement is still gated on this experiment.

### Experiment log — 2026-09-13, item 6 (Pi portion)

Harness: real Pi 0.85.0 process through Claxedo's public agent runtime; upstream is a deterministic local HTTP server, not a live model vendor.

Commands from the repository root:

- `npm install --prefix .artifacts/broker-pi --no-save @earendil-works/pi-coding-agent@0.85.0`
- From `packages/agent-sdk-runtime`: `PI_EXECUTABLE=/Users/yashvardhansingh/test/opencode-broker/.artifacts/broker-pi/node_modules/.bin/pi bun test src/harnesses/pi/native.integration.test.ts`

Result: **yes for Pi custom provider base URL and placeholder transport**. Two native integration tests pass, with 27 assertions. `models.json` uses `providers.<name>.baseUrl`, `api: "openai-completions"`, and `apiKey`; actual requests arrive at the configured `/v1/chat/completions` endpoint with `Authorization: Bearer local-test`. The real runtime executes a native file tool, records usage, resumes its session, and performs compaction. This does not prove every built-in provider override, a model-vendor request, or generic-broker production integration. The OpenCode portion of item 6 remains unverified.

The globally installed Pi 0.85.1 was rejected by the runtime's existing exact-version gate (two failing tests); the experiment used an isolated install of the repository's required 0.85.0 without changing that gate or the global installation.

### Experiment log — 2026-09-13, item 6 (OpenCode portion)

Harness: pinned embedded OpenCode SDK `0.0.0-beta-18684`, Node 26.8.1, Claxedo workspace host's session and prompt HTTP routes. The upstream is a deterministic local HTTP server, not a live model vendor.

Command from `packages/workspace-runtime`: `node scripts/node-provider-feasibility.mjs` (using the current `dist` artifacts produced by the successful sandbox host build).

Result: **yes for an OpenAI-compatible provider's base URL and placeholder transport**. The real SDK sent one request to `/v1/chat/completions` on the configured local endpoint with `Authorization: Bearer broker-placeholder` and model `proof`; its streamed response reached the workspace message snapshot. The keys are `provider.<id>.npm: "@ai-sdk/openai-compatible"`, `provider.<id>.options.baseURL`, and `provider.<id>.options.apiKey`, with the model declared under `provider.<id>.models`. This does not prove every vendor-specific SDK, a live paid-provider request, or automatic binding selection/configuration. The smoke uses an isolated database, workspace, and SDK test home and closes the host and endpoint afterward.

### Access checks — 2026-09-13, items 1 and 2

- Daytona: `daytona sandbox list --limit 1 --format json` failed with `Unauthorized: Invalid credentials - run 'daytona login' to reauthenticate`. Item 1 is **not run: valid Daytona authentication is unavailable**. No login flow was started, and no sandbox or secret was created.
- Vercel: `vercel whoami` and `vercel project ls --format json` succeeded. The current account's returned project list contained no Claxedo project, and this checkout has no `.vercel/project.json`. Item 2 is **not run: intended Vercel project/team is awaiting user input**. No sandbox was created in an unrelated project.

### Experiment log — 2026-09-13, item 3 local result

Command: from `packages/claxedo-server/scripts/sandbox/cloudflare-worker`, run `wrangler dev --config feasibility/wrangler.toml --port 8793` using the task-local Docker client configuration, then `node feasibility/check.mjs`.

Result: **with these changes, local interception passes**: register `outboundHandlers` through the SDK's inherited setter (a static class field shadows it), and enable `enable_ctx_exports`. The actual production runtime image, built from host build ID `195438cb63` on Sandbox 0.12.9, completed four HTTPS requests: Node and Bun at revision 1, followed by both clients at revision 2 after `setOutboundByHost`. The synthetic handler received the expected URL and dummy header. The same sandbox remained running between revisions and was destroyed afterward (`GET /destroy` 200, SDK destroy success).

The unmodified compatibility configuration failed with `ctx.exports is undefined`. Cloudflare documents the opt-in [enable_ctx_exports flag](https://developers.cloudflare.com/workers/configuration/compatibility-flags/#enable-ctxexports); the probe retains compatibility date `2025-04-01` and adds that flag. No production Worker configuration has changed yet.

This supersedes the earlier local build blocker. It is **not deployed Cloudflare acceptance** and does not yet prove native secret injection from the binding authority, withdrawal, or the replacement of `/egress`. Those remain required before claiming the Cloudflare adapter complete.

### Experiment log — 2026-09-13, item 3 deployed attempt

The probe now requires a configured `PROBE_TOKEN`, bearer authentication, and POST before any sandbox operation. The authenticated local check passed unauthenticated rejection, four interception requests, and cleanup. `standard-1` supplies the disk capacity required by the production runtime image.

Command from the Cloudflare Worker: `wrangler deploy --config feasibility/wrangler.toml` with the isolated Docker client configuration. Two attempts uploaded the Worker but failed during container image-layer upload with `use of closed network connection`. Both processes exited with failure; the second reused uploaded layers. No probe token was installed on the deployed Worker, so its sandbox operations remained disabled.

Result: **not run on deployed Cloudflare: container image upload failed twice**. This is an environment failure, not a negative result about outbound interception. Cleanup: `wrangler delete --config feasibility/wrangler.toml --force` succeeded; `wrangler containers list --json` contained no matching probe application. The earlier local pass remains valid but does not establish deployed acceptance.

### Experiment log — 2026-09-13, item 5

Harness: real Cursor SDK 1.0.24, local `Agent.create` and `agent.send`, with an isolated directory and an explicit dummy API key. Command from `packages/agent-sdk-runtime`: `node scripts/cursor-endpoint-feasibility.mjs`.

Result: **yes for endpoint routing using `CURSOR_BACKEND_URL`**. The real SDK sent `POST /auth/exchange_user_api_key` and `GET /v1/models` to the configured local endpoint, both with `Authorization: Bearer broker-probe-placeholder`. The auth-exchange body was `{}`. The local server deliberately returned 401, so this does not establish successful authentication, inference streaming, or end-to-end broker support. No real Cursor credential or vendor request was used. `CURSOR_API_ENDPOINT` was not the tested key; the installed SDK's authoritative implementation reads `CURSOR_BACKEND_URL`.

### Experiment log — 2026-09-13, item 4

Harness: real Codex app-server 0.133.0 (the runtime-image pin), using the repository's `CodexAppServerProcess` and actual `@claxedo/egress-broker` Node listener/delivery adapter. Provider: a live ChatGPT subscription, model `gpt-5.5`, selected from that account's live model catalog.

Setup from the repository root: `npm install --prefix .artifacts/broker-codex --no-save @openai/codex@0.133.0`.

Command from `packages/egress-broker`:

```sh
BROKER_CODEX_AUTH_FILE=/Users/yashvardhansingh/.codex/auth.json \
BROKER_CODEX_BINARY=/Users/yashvardhansingh/test/opencode-broker/.artifacts/broker-codex/node_modules/.bin/codex \
BROKER_CODEX_MODEL=gpt-5.5 \
../workspace-runtime/node_modules/.bin/tsx scripts/codex-subscription-feasibility.ts
```

Result: **yes for the custom model-provider form**. `model_providers.broker` uses `wire_api="responses"`, `requires_openai_auth=false`, the binding-scoped base URL, and an Authorization header containing the signed placeholder. No local ChatGPT login or real provider key is given to the app-server. The actual broker injects the subscription access token for `https://chatgpt.com/backend-api/codex/responses`; the backend returned 200 and Codex completed the requested `BROKER_OK` reply. After binding withdrawal, a second turn from the same running client failed at the broker's missing-binding lookup without another upstream request. The closed app-server's files contained no real credential and its temporary home was removed.

The initial test model `gpt-5.3-codex` was rejected by this account. A read-only `/backend-api/codex/models?client_version=0.133.0` request returned the eligible `gpt-5.5`; the experiment then used that model. This is model availability evidence, not a failed proxy shape. The successful run emitted a client-disconnect warning during stream teardown but exited 0 after all acceptance assertions.

The authority and lease identities in this probe are explicit test fixtures. Production account selection, signed-user propagation, renewal, and hosted binding persistence are not exercised or implemented by this result. The alternative `chatgpt_base_url` form was unnecessary and was not tested.

`scripts/codex-subscription-feasibility.ts` and the in-memory delivery adapter it drove have since been deleted: the binding lifecycle has one owner, `claxedo-local-server`'s `credentials/broker.ts`, and the script's copy had already diverged from it on auth mode. The result above stands as a record of that run and is not repeatable from the tree.

### Access checks — 2026-09-13, items 7–9

- exe.dev: `ssh -oBatchMode=yes -oConnectTimeout=10 -oStrictHostKeyChecking=yes exe.dev help` failed because no trusted host key was configured. Item 7 is **not run: trusted SSH access is not established in this environment**. No host-trust setting or integration was changed.
- Modal: `MODAL_TOKEN_ID` and `MODAL_TOKEN_SECRET` are unset and `~/.modal.toml` is absent. Item 8 is **not run: no configured Modal authentication or identified allowlisted workspace is available**.
- Signed subject in all deployment modes: **not run as a live cross-deployment experiment**. Current source evidence shows a remaining gap: `WorkspaceRouteOptions.prepareRuntime` accepts only `workspaceId`, and `hostedConnectionInfo` calls it without the available signed auth context before `hostManager.ensure`. This does not prove personal account selection or per-user sandbox isolation. Those require the planned authority/lease work; no synthetic user identity was added to production provisioning.

### Cloudflare native replacement implementation — 2026-09-13

The production Worker now uses native HTTPS outbound handlers and named
placeholders, with credential values held in its existing sandbox-keyed KV.
The expiring JWT producer, `/egress` route, vendored helper, exported legacy
helper and runtime MCP proxy rewrite have been removed. Explicit empty
registrations withdraw values and host handlers; omission preserves them for
wake. Malformed registration input rejects provisioning. Native forwarding
selects by exact host and named header placeholder, reads KV on each request,
and rejects redirects. Production compatibility flags now enable ctx.exports.

Commands: root Node Vitest invocation of Worker `registry.test.ts` and
`outbound-credentials.test.ts`: 21 pass. Sandbox-manager `bun test
src/drivers/cloudflare.test.ts src/egress-policy.test.ts`: 58 pass. Local-server
`bun test src/agent-plugins/runtime/runtime-contribution.test.ts`: 4 pass.
Worker `npx wrangler deploy --dry-run --outdir /tmp/broker-native-cf-worker-dry-run`:
pass, including container image build. Three affected package typechecks and
sandbox-manager build pass. Architecture ratchets pass without baseline changes.

These are implementation and local checks, not a new deployed result. The
prior deployed image-upload blocker remains. A real container must still
exercise this production credential handler, including rotation and withdrawal.
This retains the existing KV delivery authority: no revision-aware hosted binding
store, signed-user selection, refresh coordination, immediate global revocation,
or per-binding method/path policy is claimed for this native adapter. Those
remain part of the larger broker integration. Existing sandboxes must be
destroyed and recreated with named registrations when the replacement is deployed.

### Cloudflare production handler through a real local container — 2026-09-13

Provider: Cloudflare Sandbox 0.12.9 under local Wrangler 4.127.1 and Docker,
using the production Sandbox class and runtime image, plus a temporary deployed
HTTPS upstream Worker. No provider account credential was used.

Commands from `cloudflare-worker`: `npx wrangler deploy --config
feasibility/upstream/wrangler.toml`, `npx wrangler secret put PROBE_TOKEN --config
feasibility/upstream/wrangler.toml`, `npx wrangler dev --config
feasibility/wrangler.toml --port 8793`, then `node feasibility/check.mjs` with
`BROKER_PROBE_TOKEN` supplied from the ignored local fixture configuration.

Result: **pass**. Six real HTTPS requests used the production credential handler
and KV lookup. Both Node and Bun authenticated at revisions 1 and 2 without
restarting either client process. Clearing the credential registration and native
host handlers caused both clients to receive HTTP 401 on their next request.
The upstream returned only a verdict/revision, and no fixture credential appeared
in the captured responses. The check destroyed the sandbox and cleared KV.
`npx wrangler delete --config feasibility/upstream/wrangler.toml --force`
succeeded; the local dev process was stopped after verified cleanup.

The `cloudflare-worker/feasibility/` harness has since been deleted; the result
above stands as a record of that run and is not repeatable from the tree.

This supersedes the pending local production-handler acceptance item. It does
not establish deployed Container interception or deployed KV propagation delay;
the previous Container image-upload blocker remains.

### Signed runtime preparation context and withdrawal delivery — 2026-09-13

Appendix E item 9 is **threaded to the routes, and no further**. Initial cloud
creation, cloud connection/wake, and user-hosted connection pass
`{ workspaceId, userId: auth.user.subject }` to preparation and provisioning,
and the shared hook contract requires that context and forwards no
bearer/session token.

The only consumer of the hook ignores the subject. `createHostedMcpRuntimePreparation`
calls `activations.runtimeSnapshot(workspaceId)`, and the D1 activation store
resolves the identity from `workspaces.owner_user_id`; two different signed
callers therefore mint the same gateway credential, with the workspace owner as
its subject. That is pinned by a test
(`agent-plugins/mcp/runtime-preparation.test.ts`, "the runtime credential's
subject is the activation owner, not the signed caller") so the gap cannot close
silently. **Per-user identity arrives with the lease-key change** (section 5):
one identity per sandbox needs a lease key that carries it, and nothing before
that point can honestly resolve a personal account here.

The trace also found a withdrawal bug upstream of the newly verified native
adapter: preparation omitted an empty authoritative secret set, and connection
ensure filtered it out. Preparation now returns the complete set, including
`[]`; creation and wake preserve that explicit empty set through `ensure`.

Commands from claxedo-server: `node node_modules/vitest/vitest.mjs run
src/routes/hosted/workspace.test.ts
src/connections/hosted-connection-info.agent-plugins.test.ts
src/agent-plugins/mcp/runtime-preparation.test.ts
src/agent-plugins/signed-composio.miniflare.test.ts`: **54 pass, 0 fail**.
Failing tests first demonstrated three withdrawal failures, two connection
subject failures, and one creation subject failure. The Miniflare fixture now
retains the producer's complete Authorization header rather than stripping Bearer.

This proves the three hosted HTTP lifecycle paths and the callback boundary,
not signed identity inside every driver's provisioning request or per-user lease
isolation. Provider selection, authoritative binding storage, unsigned-local
identity policy, and per-user leases remain unimplemented; Appendix E item 9
is not an overall pass.

### exe.dev authentication gate revalidated — 2026-09-13

The official [host fingerprint](https://exe.dev/docs/faq/host-key) matched
`ssh-keyscan -T 10 -t rsa exe.dev` followed by `ssh-keygen -lf` on the captured
public key: `SHA256:JJOP/lwiBGOMilfONPWZCXUrfK154cnJFXcqlsi6lPo`.
The key was used only in the task-local
`.artifacts/broker-exe/candidate-known-hosts`; the user's SSH trust was unchanged.

Command: `ssh -o BatchMode=yes -o ConnectTimeout=10 -o StrictHostKeyChecking=yes
-o UserKnownHostsFile=/Users/yashvardhansingh/test/opencode-broker/.artifacts/broker-exe/candidate-known-hosts
exe.dev integrations list --json`.
Result: **not run: SSH authentication rejected** with exit 255 and
`Permission denied (publickey,keyboard-interactive)`. This supersedes the prior
host-trust-only blocker. No integration, VM, or account was created. A registered
SSH key/account access is needed to test personal/team behavior and live edits;
the provider's documented commands are not counted as live evidence.

### Claude API key and subscription token through the loopback broker, local — 2026-09-13

Harness: real Claude Code 2.1.267 through the Claude Agent SDK 0.3.220, driven by
the desktop-local server (`packages/claxedo-server`, `npm run dev`, port 2595) on
a copy of the owner's registry holding one active `claude-sdk` subscription
token. The vendor is the real `https://api.anthropic.com`.

Commands, from `packages/claxedo-server`:

```sh
CLAXEDO_SERVER_PORT=2595 CLAXEDO_DATA_DIR=<registry copy> npm run dev
curl "…/api/claxedo/credentials/effective"
curl "…/api/workspace/resolve?directory=<git init'd scratch dir>&create=true"
curl -X POST "…/api/claxedo/agent-config/harness?directory=…" \
  -d '{"harness":{"kind":"native","harnessId":"claude"}}'
curl -X POST "…/session?directory=…" -d '{}'
curl -X POST "…/session/<id>/message?directory=…" \
  -d '{"parts":[{"type":"text","text":"Reply with exactly the word OK and nothing else."}]}'
```

**Delivery: yes.** The spawned harness received
`ANTHROPIC_BASE_URL=http://127.0.0.1:2595/bindings/90b5fe7b…` and
`ANTHROPIC_AUTH_TOKEN=<sha256:fe3f3fb13db50792>`, and the request that arrived at
`/bindings/90b5fe7b…/v1/messages` carried exactly that value as its bearer — the
same hash, so the harness sent the placeholder and nothing else. The broker
replaced it with the stored token and reached the vendor: the response body is
Anthropic's own error envelope, not the broker's.

**Vendor acceptance: not proven — the supplied credential is rejected by
Anthropic.** The vendor answered `401 {"type":"error","error":{"type":
"authentication_error","message":"OAuth access token is invalid."}}`. An
independent request with the same stored value, sent directly to
`api.anthropic.com` with and without `anthropic-beta: oauth-2025-04-20` and no
broker in the path, returns the same 401. The token is stale, so a successful
assistant reply through the broker remains unverified; every step up to the
vendor's own decision is verified.

**Failure attribution and withdrawal: yes.** That 401 was reported against the
revision the request used and marked the row `auth_failed`; the retry resolved no
binding and received `403 {"error":"binding_unavailable"}`. The turn ended in
3.5 s with `firstTurnErrorClass: "credential"` and the message `Failed to
authenticate. API Error: 403 {"error":"binding_unavailable"}` — a named session
error, not a hang.

**Value containment: yes.** A byte-scan of the stored token across the scratch
workspace, `~/.claude` and the brokered config dir read 14,026 files and found no
occurrence.

**Blocker found and fixed during this run.** Claude Code prefers an account
configured in its config dir over both `ANTHROPIC_API_KEY` and
`ANTHROPIC_AUTH_TOKEN`. With the operator's `~/.claude` visible, the CLI sent its
own OAuth bearer at every attempt and the placeholder was never used; against a
config dir holding no account, both variables deliver it. A brokered turn now
runs under a mirrored, account-free config dir. On a 401 the CLI still falls back
to the credential in the operating system keychain, which no environment variable
reaches — the "no silent switch to ambient auth" criterion is not met by
configuration alone.

**Open defect.** After the account is withdrawn, the next turn projects nothing
and the harness silently runs on the operator's own machine login and succeeds.
A selected-but-unusable account must fail the turn instead; the projection shape
has no way to say "this provider is bound and unavailable" today.

### Codex through a Claxedo-owned home — 2026-09-13

A projection becomes `model_providers.broker` with `wire_api = "responses"`,
`requires_openai_auth = false`, `base_url` = the binding plus the destination's
API path, and `http_headers.Authorization` carrying the placeholder — the exact
form Appendix E item 4 proved. The app-server is spawned with `CODEX_HOME`
pointing at `~/.claxedo/codex/home`, rebuilt on every launch and holding only
that `config.toml`; `thread/start` selects `modelProvider: "broker"`.

The driver no longer sends `account/login/start`; the generated protocol types
in `agent-event-runtime` still declare the method, as they declare every
app-server method. It could never serve the implicit tier: the app-server reads
its own home's `auth.json`, and the driver's only caller passed `undefined`, so
no login params were ever sent. The ChatGPT token refresh the app-server
requests is still served, from `harnesses/codex/operator-login.ts`, against the
operator's own home.

Tests (`harnesses/codex/workspace-behavior.test.ts`): a `claude-sdk` projection
leaves Codex on the operator home and builds no brokered home; a
`codex-app-server` projection launches on the brokered home, whose config
carries the base URL and placeholder and not the operator's stored token, with
no `account/login/start`; an `unavailable` projection throws before any process
is spawned.

**Live, operator machine login, no row bound.** Server on :2595 over the dev
registry copy. `POST /api/claxedo/agent-config/harness` selected `codex`, a
session was created, and `Reply with exactly the word OK and nothing else.`
answered `OK`. `~/.codex/auth.json` sha256 was
`a2eead700192c654252468fcdaf6ad34cffac5a9541905d89fe50a29a5f0334d` before and
after, and `~/.claxedo/codex` was never created.

**Live, brokered: not run — no stored Codex account.** `GET
/api/claxedo/credentials` in that registry holds `daytona`, `cloudflare` and one
`claude-sdk` row; no `codex-app-server` row exists, and none was created from the
machine login.

### Cursor, Pi and the OpenCode engine — 2026-09-13

Cursor writes `CURSOR_BACKEND_URL` (not `CURSOR_API_ENDPOINT`) when the config is
applied, before the driver's lazy `import("@cursor/sdk")`, because the installed
SDK reads that variable at module scope and exposes no option for it. The
placeholder travels as the `apiKey` argument the driver already passed. The
destination is `https://api2.cursor.sh`, the host the SDK's own default names for
the API-key exchange and the Connect services a turn runs over; the cloud REST
host `api.cursor.com` is a second origin the same variable redirects, so a
brokered Cursor turn cannot read that model catalog and falls back to its
default model.

**Still not fixed, and why.** `CURSOR_BACKEND_URL` is one value, so both hosts
would have to sit on one binding, keyed by path prefix (`/v1/models` →
`api.cursor.com`, the Connect services → `api2.cursor.sh`). A destination row
cannot express that on its own: `Binding.destination` in `@claxedo/egress-broker`
carries a single `origin` beside its `pathPrefixes`, and it is read by the
broker's target construction, the delivery adapter's admission check
(`enforceableDestination`) and the local authority's binding construction, with
four test files pinning the shape. Making the origin per-prefix is a change to
the shared binding contract for one vendor's split host, not a row, so it is
left as a follow-up; the fallback to the default model stands until then.

Pi receives a `models.json` overlay `providers.<id>.baseUrl` / `apiKey`, merged
onto its built-in provider so the wire protocol and model list stay Pi's own.
Pi's `anthropic` base URL is the vendor origin and its `openai` base URL the API
root, so only the second takes the binding's API path. A bound provider's own
credential variables are withheld from the launch environment, and the managed
profile scrubs `models.json` alongside `auth.json`.

The OpenCode engine receives `provider.<id>` routing through a catalog transform
(`workspace-runtime/src/opencode/provider-binding.ts`). The bridge no longer
calls the configuration port's `connectKey`, and the ledger it kept — a
plaintext copy of the user's key — is gone; the port method itself is dead
code whose removal is landing in this pass.

Command from `packages/workspace-runtime`: `node
scripts/node-provider-binding-feasibility.mjs`.
Result: **yes for a provider the engine defines itself.** A real engine, a real
session and a real turn; the request arrived at
`/bindings/proof/v1/chat/completions` with `Authorization: Bearer
broker-placeholder`. The endpoint deliberately answers 401, so this establishes
endpoint and placeholder routing only, not vendor acceptance.

**Measured negative, same mechanism:** an overlay does **not** win against a
provider declared in the engine's own config document. An earlier run of the same
script declared `proof` via `configContent` pointing at an unreachable host and
bound it to the live endpoint; no request ever reached that endpoint. Claxedo
binds `anthropic` and `openai`, which are built-ins, so this does not affect the
shipped path — but a future binding for a config-declared provider needs another
mechanism.

`openrouter`, `google`, `groq` and `xai` previously reached the engine as stored
plaintext keys. They now have destination rows and engine provider bindings of
their own, so they reach it as broker endpoints like every other provider;
Gemini's key travels in `x-goog-api-key`, which the broker accepts as a
placeholder carrier and strips before the vendor. A provider with no row still
reaches no harness at all.

The engine's placeholders expire like every other harness's. They are
re-projected from `expiresAt` by `renewSdkCredentialsIfDue`, driven by the same
renewal pass that re-pushes each workspace runtime's snapshot; the engine is one
process serving every workspace, so its due time is held by the bridge rather
than by any workspace.

### Bound but unavailable — 2026-09-13

A withdrawn account used to project nothing, which a harness cannot tell from
"no account chosen": the next turn ran on the machine's own login and succeeded,
under an identity the operator did not select. `auth[providerId]` can now be
`{ unavailable: true, reason }`, produced whenever the marked row for a provider
exists and cannot be bound (`auth_failed`, expired, a status that is not
available, an unreadable secret). Only a provider with no marked row at all falls
to the implicit tier. Every driver reads its projection through
`providerBinding`, which throws `ProviderCredentialUnavailableError` rather than
answering; each driver refuses at launch, never at config apply, so an unusable
account fails the turn instead of the workspace.

The OpenCode engine refuses the same way. An unavailable account reaches it as
`{ unavailable: true, reason }`, which disables that provider in the engine's own
catalog (`provider.activation = "disabled"`, the SDK's authoritative availability
switch) and makes a turn naming it throw `ProviderCredentialUnavailableError`
before the prompt. Leaving it unbound instead — the first version of this
bridge — was indistinguishable from "no account chosen", and the engine answered
that by running the turn on its own login.

`assertNoProviderProjection` is deleted. It failed a harness when ANY provider in
the map carried a projection, and the runtime hands every adapter the whole map,
so one bound `claude-sdk` row made a Codex, Cursor or Pi workspace fail to become
ready. Each driver now reads only the providers it consumes and ignores the rest;
there is a cross-provider test per harness.

**Live.** The dev registry's one `claude-sdk` row is `is_active` with status
`revoked`. A Claude turn ended in milliseconds with
`{"message":"the claude credential selected for this workspace cannot be used:
revoked","firstTurnErrorClass":"credential"}` and no assistant parts — a named
credential error, not a hang and not a silent fallback to the machine login. The
message names the credential because the turn-outcome classifier reads the
message rather than the error type.

Gates: `bun run typecheck` in agent-sdk-runtime, workspace-runtime,
claxedo-server-core, claxedo-local-server and egress-broker — all pass.
`bun test src` in agent-sdk-runtime: 723 pass / 9 skip / 0 fail.
`npx vitest run` in egress-broker: 29 pass; claxedo-local-server
`src/credentials src/app/local-app.behaviour.test.ts`: 81 pass;
claxedo-server-core `src/opencode src/credentials src/agent-config`: 216 pass.
`bunx oxlint` on every touched file: 0 warnings, 0 errors.
`bun run test:architecture-ratchets` from the root: passes, after raising the
local-server closure ceiling by one module for `credentials/destinations.ts`
(`script/product-boundary/policies/local-server.ts`; the ceiling now stands at
60 modules / 26 packages after the later `agent-runtime-contract` edge).

### Live Daytona run — 2026-09-13

Goal: drive a stored `claude-sdk` credential into a real Daytona sandbox
through the branch's own HTTP routes and see the request reach
`api.anthropic.com`. It does not get that far. Two blockers, one of them
architectural.

Setup: worktree `/Users/yashvardhansingh/test/opencode-credentials`, branch
`feat/credentials-integration` at `2fe61ea1d3`; the self-hosted-node server on
`http://127.0.0.1:2595` with `CLAXEDO_DATA_DIR` pointed at a scratch copy of the
dev registry (rows: `daytona` and `cloudflare` `sandbox_driver`, `claude-sdk`
`api_key` `is_active`).

#### 1. Sandbox-backed workspace: created, never provisioned

```
curl -s -X POST http://127.0.0.1:2595/api/workspace/create \
  -H 'Content-Type: application/json' \
  -d '{"driver":"daytona","repoUrl":"https://github.com/octocat/Hello-World.git",
       "workspaceName":"cred-feas","projectName":"cred-feas"}'
```

HTTP 200, `{"workspaceId":"ws_mtzd9zyq_bkya38prqgh74yq9","kind":"cloud",
"driver":"daytona","status":"acquiring_sandbox", ...}`. Background provisioning
(`startCloudWorkspaceProvisioning`) then failed, three attempts, same error:

```
sqlite3 "$CLAXEDO_DATA_DIR/claxedo.db" \
  "select status,retry_count,last_error,sandbox_id from claxedo_workspace_lease"
→ backoff | 2 | Snapshot claxedo-workspace-runtime-0-5-2-v8 not found.
                Did you add it through the Daytona Dashboard? | (empty)
```

**No Daytona sandbox id was ever issued** — `sandbox_id` and
`driver_resource_id` stayed empty, and the workspace settled at `stopped`.

Two things the failure does prove, both new since the 2026-09-12 attempt:

- **The registry's Daytona key works.** That message is a Daytona domain error,
  which only an authenticated call can receive; the `.env` key returns
  `401 Invalid credentials` before any of it. The supervisor reached it through
  `sandboxDriverAuthAsync` → `sandboxDriverAuthManaged` → `resolveSecret`
  (`packages/claxedo-server/src/sandbox/driver-auth.ts`), i.e. the registry row,
  not the environment. Appendix E item 1's "registry key unreachable" no longer
  holds for the server itself.
- **The key has org-secret read and write.** The error comes from
  `client.create`, and in `ensureHost` (`drivers/daytona.ts`)
  `reconcileBrokeredSecrets` runs before it, so `secret.list` and
  `secret.create` had already succeeded. The sentinel slot was created.

Blocker: the org holds no snapshot named `claxedo-workspace-runtime-0-5-2-v8`
(`defaultSnapshotName()` over `workspaceRuntimeVersion()` `0.5.2` and
`SNAPSHOT_SCHEMA_VERSION` `8`). Building and registering one needs a container
build plus a push, and pointing `CLAXEDO_DAYTONA_SNAPSHOT` at an existing
snapshot needs a listing this session could not make.

#### 2. The v4 projection did not reach a sandbox at `2fe61ea1d3` — superseded

At that commit a shared-scope snapshot carried `auth: {}` and nothing turned a
provider credential into a `SandboxBrokeredSecret`; the only producers were the
clone token and the MCP runtime token, so a Claude turn inside the sandbox
would have run on the image's own login.

Superseded by the delivery adapter of Appendix C (`fe285a4cd5`): for a shared
scope the broker's `projectAuth` answers through `projectNativeProviderAuth`
with a `placeholderEnv` projection per marked account, and
`sandboxBrokeredSecrets` (`claxedo-server/src/credentials/sandbox-delivery.ts`)
hands the supervisor the active accounts as brokered secrets beside whatever
the request stated. The self-hosted supervisor forwards them to the driver. The
acceptance criterion "the runtime inside the sandbox received the v4 projection
for `claude-sdk`" is now reachable and still unrun live, for the reason in
item 1 above.

#### 3. Claude turn: not reachable

No sandbox, no runtime, no turn. Nothing was learned about Daytona's
substitution behaviour in `x-api-key`, so Appendix E item 1 stays open.

#### 4. Withdrawal: not reachable live, and a defect found in the path

No brokered credential existed to withdraw. Reading the path for it surfaced a
real defect, fixed on this branch in `1606dfc85f`:

`daytona.ts`'s `destroy` deleted the sandbox and nothing else. Daytona org
secrets are org-scoped, not sandbox-scoped, and the only withdrawal —
`reconcileBrokeredSecrets({ withdraw: true })` — runs solely while ensuring or
resuming the *same* workspace, which a destroyed one never reaches again. So
every credential brokered to a destroyed workspace stayed live in the
organization indefinitely. `destroy` now enumerates the workspace's secret
prefix and withdraws each one through the same revoked-value-then-delete path,
and refuses a target that names no workspace rather than returning with
spendable credentials behind it. Gates: `bun test src` in sandbox-manager
224 pass / 0 fail; `npm run typecheck` in sandbox-manager clean;
`bun run test:architecture-ratchets` from the root passes;
`claxedo-server src/workspace/supervisor/cloud.test.ts` 66 pass.

**Related, deliberately not fixed — owner's call.** On the self-hosted
deployment `DELETE /api/workspace/:id` never reaches `driver.destroy` at all.
`createWorkspaceSupervisorSandboxManager().destroy` calls
`discardSupervisorSandbox` → `stopSupervisorSandbox` → `stopSandbox` →
`manager.stop` → `driver.suspend ?? driver.stop`, so the Daytona sandbox is
suspended and kept; `sandboxDriverForSupervisor` passes neither
`autoStopMinutes` nor `autoDeleteMinutes`, so nothing reclaims it later. Until
that is settled, the fix above only protects the paths that do call `destroy`
(hosted create/GC). Changing delete to destroy changes workspace-delete
semantics for every driver, which is a product decision.

#### 5. Teardown

`curl -X DELETE http://127.0.0.1:2595/api/workspace/ws_mtzd9zyq_bkya38prqgh74yq9`
→ `{"ok":true}`. The lease row is gone and `workspaces.json` holds no `ws_*`
entry. No sandbox was created, so none is running.

**One artifact could not be removed:** the valueless sentinel org secret
`reconcileBrokeredSecrets` created before the failing `create`, named
`claxedo-ws_5Fmtzd9zyq_5Fbkya38prqgh74yq9-CLAXEDO_5FBROKERED_5FSECRET_5FSLOT`.
It has no value and no allowed hosts, so it carries no authority, but deleting
it needs a Daytona API call and this session may not decrypt the registry's
driver key. Follow-up for the owner: delete that one secret from the Daytona
dashboard, and note that every failed provision leaves one behind.

The `claude-sdk` row was left as found — reset to
`status='available', health=NULL, last_error=NULL`; `/credentials/effective`
lists it again.

#### What was not verified

- Whether Daytona substitutes a placeholder inside `x-api-key` (item 1). The
  synthetic-value probe in `scratchpad/daytona-feasibility/probe2.ts` still
  needs the registry key, and running it would mean decrypting a stored secret,
  which this session is not permitted to do. Unchanged from 2026-09-12: the
  blocker is the permission boundary, not the key.
- Any Daytona-side state by direct API read (org secrets by name, sandbox list),
  for the same reason. Every Daytona fact above is inferred from the server's own
  authenticated calls and their recorded errors.
- Anything downstream of a provisioned sandbox: runtime env, config push, turn.

## Appendix F. Open findings from the third review

Each of these was raised, read, and deliberately not fixed on this branch. They
are here so the next person does not re-derive them.

- **A throwing registry read fails the whole projection.** `projectAuth` lets a
  registry outage propagate, so one unreadable row answers nothing for every
  provider rather than marking that one unavailable. Both policies are
  defensible — the current one refuses to let a harness read an outage as "no
  account chosen" — and the choice belongs to the owner, not to a fix.
- **The four engine bindings are unmeasured against the config-declared-provider
  negative.** `sdk-credential-bridge` binds OpenRouter, Gemini, Groq and xAI by
  registry id; nothing proves the engine refuses a provider its own config
  declares but the binding does not name.
- **Broker error classification is measured live for Claude only.** Codex,
  Cursor, Pi and the engine echo the broker's body in their own shapes, and only
  Claude's has been read off a real failing turn.
- **A long turn can outlive its placeholder.** The token's lifetime is one hour
  and renewal replaces it at half that, but a turn already running holds the
  placeholder it launched on; a turn longer than the remaining lifetime fails
  mid-flight with a broker refusal rather than being carried over.
- **The workspace's own `.claude/settings*.json` is not covered.** The Claude SDK
  resolves those from the working directory and the canonical git root, which
  this process must not rewrite. A repository that names `apiKeyHelper` or an
  `env` credential there still reaches the vendor on it.
- **The broker's header denylist is a list, not a rule.** `OpenAI-Organization`
  and any other vendor header a binding does not declare travel from the harness
  to the vendor untouched.
- **The generation counter is not monotonic across a backwards clock step with a
  lost file.** `openGenerationCounter` starts from the wall clock when the
  counter file is missing or unreadable; a machine whose clock moved backwards
  after losing that file can issue a generation a live placeholder already
  names.

### Live Cloudflare deployed run — 2026-09-13

**Outcome: the branch Worker is deployed and serving; the deployed credential
handler was never exercised.** Three blockers, each with its own owner.

#### What was deployed

From `packages/claxedo-server/scripts/sandbox`:

```sh
npx tsx build-sandbox-image.ts --bundle-only --out=cloudflare-worker/.build
```

First run failed: `@claxedo/agent-sdk-runtime`'s `build` runs
`check:source-shape`, which rejected a comment each in `src/first-turn-error.ts`
and `src/provider-projection.ts` as corrective history, so no sandbox
image bundle could be produced at all. Both comments were restated from the code
(commit `466090ee59`); `bun run check:source-shape` then passed and the package's
own `npm test` ran 752 pass / 9 skip / 0 fail. The bundle emitted build id
`69b5dafc45`, core 0.8.0.

Then, from `cloudflare-worker`, `wrangler deploy` (wrangler 4.127.1, account
`683a2c01a4d43b2fa998cde8ddedaf0e`, `kanusdlp@gmail.com`, API token read from
`.env`):

- **Worker script: deployed.** Version `6da0cc71-06c4-4518-8ff4-d3147a3fb569`,
  created 2026-09-13T05:26:56Z, 100% of traffic. `wrangler versions view`
  confirms it is the branch build: compatibility flags `nodejs_compat,
  enable_ctx_exports` (the flag this branch added) and the `EGRESS_SECRETS` KV
  binding the native handler requires. The previous deployment was
  `3309987d-c921-49a7-837f-49a2cdf95bdc` (2026-09-04) — the rollback target,
  `wrangler rollback --version-id 3309987d-c921-49a7-837f-49a2cdf95bdc`.
- **Container image: NOT deployed.** `wrangler deploy` uploads the Worker script
  before it builds the container, so the account is now on the branch's Worker
  code against the container image built on 2026-09-04
  (`wrangler containers list`: `claxedo-sandbox-proxy-sandbox`, last modified
  2026-09-04T08:36:04Z). The handler itself lives in the Worker and is therefore
  live; the runtime bundle inside the container is five builds stale.

#### Blocker 1 — the container image cannot be built on this machine

```
#10 ERROR: error committing vqmn3xcjvgrewi2ou3l8463pn:
  write /var/lib/docker/buildkit/containerd-overlayfs/metadata_v2.db: input/output error
ERROR: failed to build: failed to solve: Internal: error committing ...
✘ [ERROR] Docker build exited with code: 100
```

It failed at Dockerfile line 67 (`npm install` of the runtime's native modules),
after 4/7 steps succeeded (apt 240s, node24 27s, agent CLIs 377s). The cause is
not the network: `df -h` reports `/System/Volumes/Data` at **100% capacity with
485Mi free of 460Gi**, and `docker system df` itself fails with
`input/output error` reading a content blob. The image needs about 5.3GB.

The instruction to retry once was not carried out, deliberately: writing another
5GB to a volume with 485MiB free cannot succeed and risks the machine. This
also supersedes the "use of closed network connection" reading of the earlier
deployed attempt (item 3) — a full disk produces I/O failures that surface as
transport errors.

- Unmet criterion: the deployed `claxedo-sandbox-proxy` container runs the
  branch's runtime image.
- Evidence: the buildkit error above; host volume at 100%.
- Owner: the repository owner (free disk, or build and push the image from a
  machine with headroom).
- Follow-up: rerun `wrangler deploy` from this directory; the Worker script is
  already current, so only the container application changes. The volume has
  since returned to 101Gi free, so the build has room; buildkit's own store may
  still hold the corrupt blob that made `docker system df` fail, and a second
  failure there wants `docker buildx prune` before a third attempt.

#### Blocker 2 — the registry's Cloudflare API token is not the deployed Worker's

With the branch Worker live, one sandbox-backed workspace was created through
the real route:

```sh
curl -s -X POST http://127.0.0.1:2595/api/workspace/create -H 'Content-Type: application/json' \
  -d '{"driver":"cloudflare","repoUrl":"https://github.com/octocat/Hello-World.git",
       "workspaceName":"cf-broker-probe","remoteDirectory":"/workspace"}'
```

It returned `ws_mtze7uik_q25w0vq2pytyxfth`, `status: acquiring_sandbox`,
`driver: cloudflare`. Its lease then went to `backoff` with

```
last_error = Cloudflare ensure-runtime failed (403): forbidden
sandbox_id =        (empty)
```

403 is the Worker's `header.slice(7) !== env.API_TOKEN` branch — a token was
sent and did not match. The Worker's `API_TOKEN` secret was last changed
2026-09-04T08:37Z (two `Secret Change` versions that day); the registry's
`cloudflare` sandbox_driver row was created 2026-08-30T21:16Z and has never been
updated. The row holds a pre-rotation value. Note also that
`packages/claxedo-server/.env` sets `CLOUDFLARE_API_TOKEN` to a value that
`wrangler whoami` accepts as a Cloudflare **account** token, while the driver
and the README use that same name for the **Worker's** `API_TOKEN` secret; the
two are not interchangeable and one of them is wrong in this deployment.

No sandbox was created — the gate runs before `getSandbox`, so no Durable Object
or container instance exists for this attempt. `claxedo-sandbox-proxy-sandbox`
held 3 live instances before the run and 3 after. The workspace was deleted
(`DELETE /api/workspace/ws_mtze7uik_q25w0vq2pytyxfth` → 200; no cloud workspace
and no lease row remain).

- Unmet criterion: a sandbox-backed workspace on the `cloudflare` driver.
- Evidence: the lease's `last_error`; the Worker's 403 branch; the two dates above.
- Owner: the repository owner. Resolving it means either writing the registry's
  current value into the Worker (`wrangler secret put API_TOKEN`) or storing a new
  shared value in both places — both require handling the secret, which this run
  was not permitted to do, and the registry row was left untouched.
- Follow-up: reconcile the two, then rerun the create above.

#### Blocker 3 — no AI-provider registration for a sandbox at the time of this run — superseded

At the time of this run nothing produced a `SandboxBrokeredSecret` for a model
provider and a shared-scope snapshot carried `auth: {}`, so steps 3–5 could not
have passed even with a working token. Superseded by Appendix C
(`fe285a4cd5`): `nativeProviderSecrets` turns each marked account into the
secret the driver registers, and the shared-scope projection names the variable
the Worker fills. What remains unmet for Cloudflare is Blockers 1 and 2 above,
and the deployed acceptance those gate.

#### Unchanged and unverified

The `claude-sdk` row was not reset and no turn was run: no sandbox existed to run
it in. Withdrawal was not exercised. `EGRESS_SIGNING_SECRET` is still present as
a Worker secret although the branch's code no longer reads it. Local gates rerun
in this session: `sandbox-manager` `bun test src/drivers/cloudflare.test.ts
src/egress-policy.test.ts` 58 pass; `agent-sdk-runtime` `npm test` 752 pass /
9 skip / 0 fail.
