# Credentials in Claxedo: how they reach an agent today, why that is wrong, and one design to replace it

Status: proposed; not started. Revised 2026-09-13 after an independent
review (Codex, `gpt-6-astra`) rejected the first draft; the findings are
folded in and listed in Appendix A.
Date: 2026-09-12
Owner: Yash Rathore
Code references are to commit `5942e131e7` unless noted.
Relationship to `2026-09-12-001-feat-provider-accounts-design.md`: that
document's "one active account per provider, chosen in Settings" stands.
Everything it said about how the chosen account reaches a harness
(sections 2, 4, 6, Phase 3) is replaced by this document.

---

## Part 1. The problem in one page

An agent needs secrets to do its job: a model provider key or subscription
token, a GitHub token to clone and push, tokens for MCP servers, a deploy
key. Claxedo has to get those secrets from wherever the user stored them to
wherever the agent runs, which may be the user's laptop, a container on
that laptop, or a virtual machine at one of six sandbox providers.

Today it does this in **four unrelated ways**, built at different times for
different secret types:

1. Model credentials are **pushed in plaintext** to every runtime and end up
   in the agent's process environment or on its disk.
2. GitHub and MCP tokens ride a **brokered channel** that keeps the value out
   of the sandbox, but only some providers honour it and only two producers
   use it.
3. Cloudflare sandboxes use a **hand-built proxy** that the provider has
   since made redundant.
4. The local Docker driver **copies the operator's own login files** into
   the container.

The consequences, each of which is shown with code in Part 2:

- An agent can read, print, or exfiltrate every model credential it runs
  with, on every driver, including a user's ChatGPT or Claude subscription
  token.
- A stored Codex account overwrites the user's own `~/.codex/auth.json`
  (proven live on 2026-09-12; design 001, finding 12).
- The same credential is the org's, for everyone: there is no personal
  account, because the push carries no user.
- Rotation and refresh happen inside sandboxes, in the harness's own
  process, or not at all.
- The driver catalog that decides what each sandbox provider can do is
  behind what those providers ship, so we refuse brokering where it is now
  native and hand-roll it where it is now built in.

The proposal (Part 3) is one mechanism for every secret: the control plane
records a **binding** ("this runtime may use this credential toward these
hosts"), a per-provider **delivery adapter** makes it true at the network
edge using the provider's own injection, and one **generic broker** covers
the providers that have none. The agent is configured with a base URL and a
placeholder; the real value is attached after the request leaves the
sandbox. Bindings are fixed for a sandbox's lifetime, so a sandbox has
exactly one credential identity and two users can never spend each other's
accounts inside one. Part 4 states what this buys and what it costs; Part 5
is the plan with its gates.

---

## Part 2. How it works today

### 2.1 The pieces

Four kinds of thing appear in every flow below.

- **The control plane.** The Claxedo server the app talks to. It exists in
  three trust modes, which decide who a request is from:
  - *Local unsigned.* The desktop app's own server on the laptop, reached
    over the loopback interface, no login. Every request is "the operator".
  - *Local signed.* The same server reached remotely through the relay with
    a signed token. The request names a user.
  - *Web hosted.* The multi-tenant Worker deployment. The request names a
    user in an org.
- **The credential registry.** Where stored secrets live. Locally a SQLite
  table (`claxedo_provider_credential`) with the secret in the OS keychain;
  hosted, an envelope-encrypted KV store partitioned per org. Every row is
  keyed by org; there is no user column. Hosted holds **one row per
  provider id** and cannot enumerate rows
  (`claxedo-server/src/credentials/worker/index.ts:167`).
- **The runtime.** The process that runs harnesses. On a *local workspace*
  it is embedded in the local server on the laptop. On a *cloud workspace*
  it is the `workspace-runtime` process inside a sandbox at a provider. The
  same runtime code runs in both places.
- **The harness.** The agent binary the runtime drives: Claude Code, the
  Codex app-server, Cursor's agent, Pi, or the embedded OpenCode engine.
  Each authenticates to its vendor its own way.

And two orthogonal choices that decide which path a secret takes:

- **Workspace kind:** local (on the laptop) or cloud (in a sandbox).
- **Sandbox driver:** `docker` (a container on the laptop), or one of
  `daytona`, `vercel`, `cloudflare`, `exe`, `modal`, `box` at a provider.

### 2.2 Path 1: model credentials, pushed

This is how Anthropic, OpenAI, Codex, Claude, Cursor, and Pi credentials
reach a harness.

A. **A workspace starts** (or the config changes). The supervisor asks for a
   runtime config snapshot
   (`claxedo-server/src/workspace/supervisor/config-sync.ts:12`), choosing
   the secret scope: `shared` if the workspace is cloud or remote, `local`
   otherwise.
   A.1 `getRuntimeConfigSnapshot`
       (`claxedo-server-core/src/agent-config/index.ts:507`) resolves the
       org's secrets for that scope. `shared` includes only rows the user
       consented to share with sandboxes
       (`credentials/registry.ts:641`). It picks one row per provider by a
       preference order, not by any explicit choice (design 001, finding 14).
   A.2 The result is `{ version: 3, mcp, connections, auth: { providerId:
       secretValue, ... } }`. Secret values, in plaintext, keyed by provider.
       Nothing in it names a user.
   A.3 The supervisor POSTs it to the runtime's `/api/wr/config`
       (`config-sync.ts:21`) over the relay for a sandbox, or applies it in
       process for a local workspace.
B. **The runtime applies it.** `normalizeRuntimeSnapshot`
   (`workspace-runtime/src/routes/config.ts:167`) accepts only `version: 3`
   with string values in `auth`. The runtime keeps the values in memory and
   hands them to the harness adapter (`workspace/runtime.ts:1341`).
C. **The harness receives it**, per harness:
   - *Claude Code:* the value becomes `ANTHROPIC_API_KEY`,
     `ANTHROPIC_AUTH_TOKEN`, or `CLAUDE_CODE_OAUTH_TOKEN` in the child
     process environment, chosen by the token's shape
     (`agent-sdk-runtime/src/harnesses/claude/auth.ts:9`). A subscription
     token (`sk-ant-oat…`) becomes `CLAUDE_CODE_OAUTH_TOKEN`; anything else
     becomes an API key. The CLI's own shell tool inherits that environment,
     so `echo $ANTHROPIC_API_KEY` in an agent-run command prints it.
   - *Codex:* not env. The driver sends the app-server an
     `account/login/start` RPC with the key or the ChatGPT tokens
     (`harnesses/codex/process-auth.ts:56`). The app-server then **writes
     `CODEX_HOME/auth.json`**, and `CODEX_HOME` is the user's own `~/.codex`
     because the factory's `codexHome` option is never passed
     (`harnesses/codex/driver.ts:146`). The app-server also refreshes the
     token itself and rewrites the file.
   - *Pi:* env (`ANTHROPIC_API_KEY`, `OPENAI_API_KEY`) plus a projection
     written to `${agentDir}/auth.json` (`harnesses/pi/driver.ts:201`). Pi
     refuses to rotate mid-turn and throws.
   - *Cursor:* `apiKey` passed to the SDK's `Agent.create`
     (`harnesses/cursor/driver.ts:231`).
   - *OpenCode engine:* a separate bridge writes the registry's secrets into
     the embedded SDK's own auth store on disk
     (`claxedo-server-core/src/opencode/sdk-credential-bridge.ts:68`).
D. **Refresh.** Only Codex OAuth has a refresh helper
   (`credentials/operations/refresh.ts:29`), and when it renews an imported
   login it deliberately mirrors the new tokens into the user's CLI file
   (`authority/default-credentials.ts:91`) so the CLI is not stranded.
   Nothing refreshes a Claude subscription token.
E. **Nothing stored:** the implicit tier. Claude uses its keychain login,
   Codex reads its own `~/.codex/auth.json`, and both work with no Claxedo
   involvement. Design 001, finding 1.

What the runtime's own shell hides: the runtime's PTY filters
`ANTHROPIC_API_KEY` and friends out of terminals it opens
(`workspace-runtime/src/pty/env.ts`). That protects the user's terminal
tab, not the agent: the harness's children inherit the harness's env.

### 2.3 Path 2: brokered secrets, driver channel

Built for GitHub clone tokens and MCP gateway tokens on cloud workspaces.

A. **A producer makes a `SandboxBrokeredSecret`**
   (`sandbox-manager/src/index.ts:267`): `{ name, value, hosts, header? }`.
   Exactly two producers exist:
   - the GitHub clone token, built when a cloud workspace is created from a
     repository the user connected (`claxedo-server/src/workspace/
     repository-clone.ts`): `Authorization: Basic …` for `github.com`;
   - MCP gateway tokens for agent plugins (`agent-plugins/mcp/
     runtime-preparation.ts:297`): a signed token naming user, org,
     workspace, harness, plugin, server, and integration, for one gateway
     host per server.
B. **The manager passes it on its own channel**, never into env or labels
   (`index.ts:684`), unions its hosts into the egress allowlist
   (`index.ts:396`), and refuses to provision on a driver whose catalog
   entry says `secretBrokering: "none"` (`index.ts:851`). `native` and
   `proxy` both pass. Two doc comments in the same file still say `proxy`
   fails closed; the code disagrees.
C. **The driver makes it true**, per driver:
   - *Daytona:* creates an org secret with `hosts`, references it by env var
     name at sandbox create; the sandbox sees an opaque `dtn_secret_…`
     placeholder and Daytona's egress proxy swaps it in HTTPS request
     headers to allowed hosts, scrubbing responses. `header` is ignored.
     Secrets are attached only at create (`drivers/daytona.ts:394`); resume
     never re-attaches.
   - *Vercel:* after create, replaces the sandbox's network policy with a
     union that adds `transform: [{ headers: { [header]: value } }]` for each
     host (`drivers/vercel.ts:402`). The sandbox sees nothing; the firewall
     splices the header on egress. `header` is required. Every resume is a
     new sandbox.
   - *Cloudflare:* registers `{hosts, header, value}` with our own Worker,
     which gives the container a proxy URL, a host list, and a 15-minute
     JWT (`drivers/cloudflare.ts:218`, `cloudflare-egress.ts`). The sandbox
     must route brokered requests to the proxy with the target URL in a
     header. Nothing refreshes the JWT.
   - *exe, modal, box, docker:* `none`. The manager refuses.
D. **The sandbox uses it.** The only in-sandbox consumer is the MCP
   projection (`claxedo-local-server/src/agent-plugins/runtime/
   runtime-contribution.ts:136`), which reads the placeholder env var and
   sends `Authorization: Bearer <placeholder>`, or on Cloudflare rewrites
   the MCP URL to the proxy. **Nothing consumes the GitHub clone secret on
   Daytona**: the driver drops `header`, the env var holds a placeholder,
   and no code attaches it to git. It works on Vercel only because the
   firewall injects without the sandbox's help.
E. **Who calls it.** The hosted create and wake paths pass secrets
   (`routes/hosted/workspace.ts:498`, `connections/
   hosted-connection-info.ts:97`). The self-hosted supervisor passes none
   (`workspace/supervisor/sandbox.ts:122`), so on a self-hosted deployment
   these tokens never reach a sandbox at all.

### 2.4 Path 3: the Cloudflare proxy, and Path 4: the Docker auth copy

Path 3 is described under C above. It exists because, when the driver was
written, the Cloudflare Sandbox SDK had no egress interception. The SDK
gained outbound Workers at 0.8.0 (Cloudflare changelog, 2026-03-26) and now
has `allowedHosts`/`deniedHosts`, `outbound`/`outboundByHost` handlers
running in the Worker, and HTTPS interception with a per-sandbox CA. Our
worker pins 0.8.9 and does not use any of it.

Path 4: `drivers/docker.ts:76`, opt-in by environment variable, copies
`~/.codex/auth.json`, `~/.codex/accounts`, `~/.local/share/opencode/
auth.json`, and `~/.claude.json` into every container at boot. Its own
comment says why it is dangerous: on a shared self-host it is cross-user
secret exposure.

### 2.5 The connections kit: the one place ownership exists

GitHub, Notion, Atlassian, Linear, Google, and MCP servers are
"connections" (`@claxedo/connections`). A connection row has an **owner**:
empty means the org (team), a user id means personal. The gate decides the
owner per request: loopback and unsigned means team, a signed token means
that user (`claxedo-server/src/connections/index.ts:92`). Lookup takes team
rows plus the caller's personal rows and lets personal win per integration
(`claxedo-connections/src/service.ts:126`). Hosted uses `user:<id>` and
`org:<id>` partitions and refuses ownerless rows.

Consumption is **pull, per request**: the workspace-create route resolves
the user's GitHub connection at the moment it needs the clone token; the
hosted MCP gateway resolves the user's connection on every MCP call. The
connection's secret is stored in the same registry as everything else under
`integration:<connection id>`, which is why the fanout skips provider ids
containing a colon.

Model credentials never get a connection row. That single fact is why they
are org-wide and pushed with no user in them.

### 2.6 What each sandbox provider can do now

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

### 2.7 The issues, numbered

Each is a fact about the code above, not a preference.

1. **Every model credential is readable by the agent.** Claude and Pi put
   it in the child env; Codex writes it to disk; the OpenCode bridge writes
   it to the SDK store. On every driver, including the ones that could
   broker it. (2.2 C)
2. **A stored Codex account clobbers the operator's login.** The app-server
   writes the explicit login into the user's own `~/.codex/auth.json` and
   keeps it in memory across logout. (2.2 C; design 001, finding 12)
3. **No personal accounts.** The snapshot has no user; the registry has no
   owner. Two people in one org run on one account. (2.2 A.2, 2.5)
4. **Refresh is in the wrong places.** Codex refreshes inside the
   app-server; Claxedo's helper mirrors into the CLI file; Claude
   subscription tokens are never refreshed. (2.2 D)
5. **Brokering is used by two producers and honoured inconsistently.** The
   clone token has no consumer on Daytona; the self-hosted supervisor sends
   no secrets; resume on Daytona does not re-attach; the Cloudflare JWT
   dies at 15 minutes with no refresh. (2.3)
6. **A defect in the one working consumer.** The MCP producer stores
   `Bearer <token>` and the consumer prefixes `Bearer ` again, so a Daytona
   sandbox sends `Bearer Bearer …`. (`runtime-preparation.ts:301`,
   `runtime-contribution.ts:174`)
7. **The catalog is stale.** exe.dev and Cloudflare are marked `none` or
   `proxy` while both broker natively; Modal's sidecar and domain allowlist
   are unmodelled; every SDK pin is behind. (2.6)
8. **Two paths exist only because of 7.** The Cloudflare proxy Worker and
   the Docker auth copy are workarounds for capabilities the providers now
   have or for a problem (local containers) the generic broker below solves
   once.
9. **Egress auto-allow is org-wide.** Storing any credential adds a network
   policy row with no workspace id, opening that provider's host group for
   every workspace. (`claxedo-server-core/src/sandbox/network/policy.ts:279`)
10. **Consent is enforced only in the push.** The `shared` scope respects
    the row's consent flag; nothing else does.

---

## Part 3. The proposal

### 3.1 Decision: one credential identity per sandbox

A sandbox has exactly one set of credentials for its whole life. Bindings
are created when the sandbox is provisioned and only their *values* change
afterwards (rotation, refresh), never *which account* they are.

This is the answer to the review's central objection. The first draft
switched a shared runtime's account before each turn. That fails the moment
two users share a sandbox: user A's still-running turn, or a background
process A left behind, makes requests after user B's turn rebinds the
sandbox, and A's requests spend B's account. No injector at the edge can
tell A's process from B's, because inside the sandbox they are the same
trust domain. Serialising the switches does not help; the authority has to
cover every request a turn makes, and requests keep coming after turns end.

So: **a personal account means a personal sandbox.** A cloud workspace
provisions one sandbox per credential identity that opens it. For an org
where everyone runs on the team account, that is one sandbox, exactly as
today. For a user with a personal account, it is their own sandbox for that
workspace. Local workspaces on a laptop are already one identity: the
operator.

Cost: more sandboxes for orgs that mix personal and team accounts, and the
workspace's files must be shared across those sandboxes the way they are
shared across restarts today (checkpoint and restore, or the provider's
volume). Part 4 weighs it. The alternative, turn-scoped authority through a
mediator, is recorded in Part 6 and rejected because it still lets two
processes in one sandbox read each other's authority.

### 3.2 The three concepts

- **Binding.** `{ id, runtime, hosts, credentialRef, inject, revision }`.
  *Runtime* is a sandbox lease (id and epoch) or a local runtime id.
  *Hosts* is the list of destinations the credential is valid for. *Inject*
  is the header name and scheme (`Authorization: Bearer`, `x-api-key`,
  `Authorization: Basic`) or, for the two vendors that need it, a query
  parameter. *Revision* increments on every value change, so an adapter can
  tell "applied revision 3" from "desired revision 4" and a wake can never
  reinstall an old value. This is today's `SandboxBrokeredSecret` with the
  value replaced by a reference, the runtime named, and a revision added.
- **Delivery adapter.** One per driver plus one for local runtimes. Three
  operations: `apply(runtime, bindings)` at provision, `rotate(binding,
  revision)` when a value changes, `withdraw(binding)` when a row is deleted
  or rejected. Each returns the revision the provider acknowledged and, for
  providers that propagate asynchronously, the delay to expect. Native
  where the provider injects at its edge; generic otherwise.
- **Projection.** What the harness is configured with. A typed record per
  provider, not a string: `{ baseUrl, authMode, placeholder, headers }`.
  *authMode* is `apiKey` or `bearer`, because Claude Code selects a
  different code path for each and the projection must preserve which one
  the stored credential is. Transparent adapters project the vendor host as
  `baseUrl`; proxy adapters project the proxy URL.

The runtime config snapshot moves to version 4: `auth` carries projections,
never values. The v3 reader stays until every consumer in 5.3's table has
migrated, then is deleted in one change with a drain of running sandboxes.

### 3.3 The generic broker

One HTTP service, one package (`@claxedo/egress-broker`), hosted in the Node
control plane, in the hosted Worker, and in the local server for Docker and
local runtimes. It grows out of `cloudflare-egress.ts`, which is already
Web-Crypto-and-fetch only, with these specified behaviours:

**Addressing.** `https://<broker>/b/<bindingId>/<path>`. The broker
forwards to the binding's vendor host with `path` appended. The
target-in-a-header form stays for MCP, which already uses it.

**Authentication.** The placeholder the harness is configured with *is*
the runtime token: the harness sends it as its credential header, and the
broker reads it as authorisation to use a binding. There is no second
secret for the runtime to hold, because anything the runtime holds the
agent can read too. It is a signed token with claims
`{ iss, aud: <broker>, sub: <runtime id>, lease: <epoch>, org, bindings:
[ids], exp }`, TTL one hour, signed with a key the control plane rotates;
the broker verifies signature, audience, expiry, and that the requested
`bindingId` is in the token's list and belongs to the token's org and
runtime. A token is a capability to *use* the listed bindings from that
runtime; it is not the credential, and it cannot be used to read one.

**Renewal.** The control plane pushes a fresh token in the runtime config
before the old one expires (the existing config push, on a timer at half
the TTL). The runtime rewrites the harness projection's placeholder and
re-applies it. For harnesses that read the value once at start (Claude Code
reads env at spawn), the runtime restarts the harness process at the next
turn boundary; a long-running turn keeps its old token until it ends, so
the TTL is chosen so that a turn cannot outlive it by more than one
boundary. The revoke path (3.5) does not wait for expiry.

**Injection rules,** enforced on every request: strip `Authorization`,
`Cookie`, and any header named in the binding from the incoming request;
set the bound header from the current revision's value; set `Host`; refuse
methods other than GET, POST, PUT, PATCH, DELETE; forward with manual
redirects and **return a 502 on any 3xx** rather than the upstream's
`Location`; on the response, delete the injected header and every header
the binding lists as sensitive. Bodies are streamed, not scanned: the broker
does not claim to scrub a value an upstream chooses to echo in a body, and
the document says so (Part 4).

**Policy.** A binding may carry `allow: { methods, pathPrefixes }`. The
broker rejects anything outside it with 403. Model bindings allow the
vendor's chat and messages paths; a GitHub binding allows the repository's
own paths; an MCP binding allows its one resource. This is not a follow-up:
without it a brokered GitHub token is a full-account token.

**Failure reporting.** A 401 or 403 from the vendor is reported to the
control plane with the binding id and the revision used. The control plane
marks the row `auth_failed` only if that revision is the current one; a
stale request's 401 after a rotation is ignored.

### 3.4 Native adapters

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

### 3.5 Lifecycle and reconciliation

State the control plane keeps per binding: `desiredRevision`,
`appliedRevision`, `appliedAt`, `status` in `{pending, applied, degraded,
withdrawn}`. Transitions:

- **provision:** bindings computed from the sandbox's identity (3.6) →
  `apply` → `applied` at revision 1. A failure leaves the sandbox
  `unavailable` with a named error; the manager already fails closed.
- **rotate** (value changed by refresh or by the user): `desiredRevision++`
  → `rotate` → `applied` when the adapter acknowledges; `degraded` if the
  provider has not acknowledged within its propagation window; the verify
  probe (3.7) confirms.
- **withdraw** (row deleted, consent removed, or `auth_failed` on the
  current revision): `withdraw` → `withdrawn`; the harness's next request
  gets 403 from the broker or 401 from the vendor, both surfaced as
  "credential withdrawn" in the session, never as a silent fallback to the
  implicit tier. Deleting a row while a sandbox runs is a deliberate
  break, and the session says so.
- **wake:** before the runtime is handed to the caller, every binding whose
  `appliedRevision < desiredRevision`, or whose sandbox was replaced, is
  re-applied. The wake paths that today pass no network policy get the same
  reconcile for policy.
- **destroy:** every binding withdrawn; native secrets deleted at the
  provider.

Refresh runs in the control plane only, one flight per credential row
(a lease row in the registry), for every kind with a refresh grant. The
mirror into `~/.codex/auth.json` is deleted along with imported Codex rows
(design 001, finding 13: they never worked).

### 3.6 Which account, and consent

A credential row gains `owner` (empty for team, a user id for personal)
and `active` per `(owner, provider)`, mirroring the connections kit. The
**credential identity** of a sandbox is computed once at provision from the
requesting user: for each provider the workspace may use, the user's active
personal row if present, else the org's active team row, else none. The
identity is recorded on the lease. A user whose identity differs from a
running sandbox's gets their own sandbox for that workspace (3.1). Turns not
started by a signed user (wakes, schedules) run in the team-identity
sandbox.

Consent stays: a personal row is never bound into a sandbox unless the
user marked it shareable, the same flag the push honours today, and the
Settings row says which of a user's accounts are usable in the cloud. On
the unsigned local server there is no user, every row is team, and the
behaviour is design 001 as written.

### 3.7 Verification and health

The live check built on 2026-09-12 (usage read for subscription tokens,
minimal call for API keys) becomes the probe the lifecycle uses: after
`apply` and `rotate`, the control plane makes one request *through the
binding* (through the broker, or through a probe process in the sandbox for
transparent adapters) and records the revision it succeeded on. The
Providers page shows, per account, the last probe and the sandboxes it is
bound into.

### 3.8 The trust boundary, stated honestly

What the design guarantees on every brokering driver: the credential value
is never in the sandbox's environment, files, or process memory, so an
agent cannot copy it out, and rotation happens without the sandbox's help.

What it does not guarantee: an agent can still *use* the credential for
anything the binding's `allow` policy permits, for as long as the sandbox
holds a valid runtime token, and can send what it receives anywhere the
egress policy allows. Containment of egress is the separate `egressControl`
axis; the `allow` policy bounds delegated authority; neither is
confidentiality of responses. A malicious upstream can echo a value in a
body and the broker will not catch it. Two identities never share a
sandbox, which is the only reason a runtime token can be a plain bearer
capability.

Transparent adapters (Daytona, Vercel, Cloudflare) terminate TLS or read
SNI at the provider's edge, so the provider is trusted with model traffic
in the clear at that hop. The generic broker means Claxedo is. The design
prefers the provider's edge wherever it exists for exactly that reason.

---

## Part 4. Scope and benefits

**In scope:** every secret an agent uses toward a network destination:
model keys and subscription tokens for all five harnesses, GitHub and other
code-host tokens, MCP server credentials, deploy tokens. Every driver.
Local workspaces and Docker through the loopback broker. Personal accounts
on signed deployments.

**Out of scope:** egress containment (unchanged axis); the desktop's own
signed self-runtime, which is the user and keeps receiving values; secrets
the agent uses toward non-HTTP destinations (Postgres over TLS on Vercel is
the one exception the provider handles; everything else is a follow-up).

What changes for each person:

| Who | Today | After |
| --- | --- | --- |
| A user with a Claude or ChatGPT subscription running cloud workspaces | The token is in the sandbox; an agent, a plugin, or a compromised dependency can read it. A stored Codex account overwrites their laptop login. | The token never enters the sandbox; their laptop login is never touched; rotation and refresh are invisible to them. |
| A team on a hosted org | One account per provider for everyone. | Team accounts stay; a member can bind their own account and gets their own sandbox for it. |
| An operator self-hosting | GitHub and MCP tokens never reach sandboxes; Cloudflare needs a hand-run secret; Docker copies their login files. | One broker for every driver; the supervisor sends bindings like every other path; no auth-file copy. |
| The codebase | Four delivery paths, a stale catalog, four SDK pins behind, two known defects on the brokered path. | One contract, one broker package, adapters that are the driver's own code, a catalog that is tested against the providers. |

Costs, honestly: more sandboxes when identities mix (3.1); model traffic
through Claxedo's broker on drivers without a native edge; a new binding
table to keep consistent; a v4 snapshot migration across running sandboxes;
five harness integrations to verify one by one before anything is deleted.

---

## Part 5. The plan

Each phase is a reviewable slice with a gate. Nothing in Phase 1 or 2
deletes an existing path; deletions are Phase 4, after every consumer has a
proven replacement.

### Phase 0: truth and hygiene (no behaviour change)

- Upgrade `@daytona/sdk`, `@vercel/sandbox`, `@cloudflare/sandbox`, `modal`
  to current and fix what breaks.
- Re-declare `secretBrokering` and `egressControl` per driver from 2.6,
  with the documentation ratchet in `egress-policy.test.ts` updated.
  Declare only what the driver code enforces; a capability the provider has
  but the driver does not use stays undeclared.
- Delete the two JSDoc blocks claiming proxy mode fails closed.
- Fix the doubled `Bearer` on the Daytona MCP path.
- Make the clone secret usable on Daytona: the runtime sets git's
  `http.https://github.com/.extraheader` from the placeholder env var.
- Scope the auto-added network policy to the workspace that stored the
  credential, or drop the auto-add.

Gate:
- [ ] Catalog equals 2.6's enforced subset; ratchet green.
- [ ] Each driver's tests pass on the upgraded SDK.
- [ ] A Daytona MCP request carries exactly one `Bearer`; a Daytona clone
      succeeds against a private repository in a live run.

### Phase 1: feasibility, measured before anything is built on it

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

Gate: every item answered yes, no, or "with this change", in writing. A
"no" removes that harness or driver from Phase 2's scope rather than
weakening the design.

### Phase 2: the binding contract, the generic broker, Claude on API keys

- `Binding` and the binding table (SQLite locally; hosted KV with a new
  org-partitioned key space, since the credential store cannot enumerate).
- `@claxedo/egress-broker` with the protocol in 3.3, hosted in the Node
  app, the Worker, and the local server.
- Generic adapter for every driver; Daytona and Vercel native adapters.
- Projection in a v4 snapshot alongside v3 values; the runtime prefers v4
  when present.
- Claude Code on a stored Anthropic API key, on Docker, Daytona, and
  Vercel, through the projection.

Gate (adversarial, not smoke):
- [ ] The key is absent from the runtime's env, `/proc/*/environ`, and disk
      after a turn, on all three drivers.
- [ ] A runtime token from sandbox A is rejected for sandbox B's binding,
      for another org's binding, and after expiry; a replayed token after
      withdraw is rejected.
- [ ] Rotation: the next request after the adapter acknowledges uses the
      new value; a request in flight during rotation that returns 401 does
      not mark the new revision failed.
- [ ] Withdraw while the sandbox is disconnected: on reconnect the binding
      is withdrawn before the first request.
- [ ] A request outside the binding's `allow` gets 403 at the broker.
- [ ] A 3xx from the vendor is returned as 502 without `Location`.
- [ ] Consent: a personal row not marked shareable is never bound.
- [ ] `bun run test:architecture-ratchets` green; each package's own
      typecheck and tests green.

### Phase 3: the remaining harnesses and native adapters

- Codex (API key, then subscription per Phase 1 item 4), Cursor, Pi, the
  OpenCode engine, each behind its feasibility result.
- Cloudflare and exe.dev native adapters; Modal sidecar where allowlisted.
- GitHub and MCP bindings moved onto the contract; the supervisor sends
  bindings.

Gate: Phase 2's list passes per harness and per driver added; no brokered
request on a native driver touches the generic broker (broker access log
empty in the test).

### Phase 4: identities, and deletions

- `owner` and per-owner `active` on credential rows; the hosted store
  migrated to many rows per provider with enumeration.
- One sandbox per credential identity per workspace (3.1); Settings shows
  personal and team accounts per harness and which sandboxes each is bound
  into.
- Delete: plaintext `auth` in the snapshot and the v3 reader (with a drain
  of running sandboxes), the Codex login RPC and the per-account
  `CODEX_HOME` plan, the Docker auth copy, the Cloudflare `/egress` route,
  the OpenCode SDK credential bridge, the Codex mirror into the CLI file.

Gate:
- [ ] Two users, one hosted workspace: each runs in their own sandbox on
      their own account, verified by the vendor-side account id; a wake
      runs in the team sandbox.
- [ ] `~/.codex/auth.json` on the operator's machine is byte-identical
      before and after a Codex turn on a stored account.
- [ ] No producer of plaintext secrets to a runtime remains, asserted by a
      repository search in the test suite.

### Definition of done

Every gate checked; Part 2's four paths reduced to one; design 001's
superseded sections marked; `public-docs/sandbox-egress.md` rewritten from
the new catalog with a brokering section that states 3.8 verbatim.

---

## Part 6. Alternatives considered

- **Turn-scoped authority through a mediator.** Each request carries an
  authority tied to its turn; the broker honours that instead of a
  runtime-wide binding. Gives attribution, but two mutually untrusted
  processes inside one sandbox can read each other's authority, so it does
  not isolate users. Rejected in favour of 3.1. It remains the right shape
  for *audit* within one identity and can be added later without changing
  the contract.
- **Keep the push, add an owner.** Cheapest: put the user's account in the
  snapshot per sandbox. Fixes issue 3 and nothing else; the value is still
  in the sandbox. Rejected.
- **Provider-only, no generic broker.** Use native edges and refuse the
  rest. Leaves Docker, Box, Modal-without-sidecar, and every local
  workspace on plaintext. Rejected; the generic broker is small and its
  core exists.
- **Vendor gateways instead of our broker** (exe.dev's LLM integration,
  Vercel's AI Gateway). Used where they are the native adapter. Not adopted
  as the only path because each covers one provider's sandboxes.

---

## Appendix A. Review findings and where each landed

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

## Appendix B. Feasibility results

Empty until Phase 1 runs. One entry per item, with the command, the
provider, the date, and the result.

## Glossary

- **Binding:** the rule that one runtime may use one credential toward some
  hosts, at a revision.
- **Credential identity:** the set of accounts a sandbox is bound to for
  its whole life.
- **Delivery adapter:** per-driver code that makes bindings true at the
  provider's edge or through the generic broker.
- **Projection:** the base URL, auth mode, and placeholder a harness is
  configured with.
- **Transparent adapter:** the provider injects on the way out and the
  harness talks to the vendor host (Daytona, Vercel, Cloudflare).
- **Proxy adapter:** the harness talks to a proxy that injects and forwards
  (exe.dev, Modal sidecar, the generic broker).
- **Implicit tier:** a harness with no binding uses its own CLI login on the
  laptop. Unchanged by this design.
