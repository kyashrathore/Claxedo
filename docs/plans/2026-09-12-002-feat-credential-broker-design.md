# One credential broker: every secret leaves the sandbox out, never in

Status: proposed; not started
Date: 2026-09-12
Owner: Yash Rathore
Supersedes the delivery half of
`2026-09-12-001-feat-provider-accounts-design.md` (sections 2, 4, 6 and
Phase 3). The active-account choice from that document stays; how the chosen
account reaches a harness is decided here.

## Summary

Today Claxedo hands secrets to agents four different ways: model keys are
pushed in plaintext to every runtime, GitHub clone tokens and MCP gateway
tokens ride a brokered channel that only two drivers honour, a hand-built
Cloudflare proxy reimplements what that provider now ships, and the local
Docker driver copies the operator's own login files into the container. The
provider landscape has moved: Daytona, Vercel, Cloudflare and exe.dev each
inject credentials at the network edge natively, and Modal has an official
sidecar recipe. This design collapses the four paths into one.

**A binding says "requests from this runtime to these hosts carry this
credential".** The control plane owns bindings. A delivery adapter per
sandbox driver makes the binding true using the provider's own brokering.
Where a provider cannot broker, one generic Claxedo egress broker does it,
the same way for every such provider. The harness never holds a real
credential: it is configured with a base URL and a placeholder, and the edge
attaches the real value. Which account a binding carries is decided per
turn, so a personal account can differ per user without the harness knowing.

## Goals

- One contract for every secret an agent uses: model keys, subscription
  tokens, GitHub, MCP, deploy tokens. No special path for AI credentials.
- The credential value never enters the runtime process, its environment,
  its files, or its shell children, on every driver that can broker.
- Native brokering first. The generic broker is the fallback, and it is one
  thing, not one thing per provider.
- Per-user accounts: the same workspace can run turn A on user A's account
  and turn B on user B's, with no harness restart.
- Rotation and refresh happen in the control plane once, never inside a
  sandbox, never in the user's `~/.codex/auth.json`.
- Local runtimes on the user's own machine use the same contract through
  the local server, so Settings and the fanout have one code path.

## Non-goals

- Egress containment. Whether a sandbox may reach the internet at all stays
  the separate `egressControl` axis with its enforce/withhold/refuse
  posture. Brokering decides what a request carries, not whether it leaves.
- Hiding the credential from the operator's own desktop process. The signed
  desktop is the user; it keeps the self-runtime path that receives values.
- Protecting the *response* from exfiltration. A sandbox that can use a key
  can copy what the key returns. Rate limits and path restrictions at the
  broker are a follow-up.
- Rewriting the implicit machine-login tier. A harness with nothing bound
  keeps using its own CLI login on the local machine, exactly as today.

## Background: how it works today, grounded

Four delivery paths exist. File references are to the state at commit
`8e28a21d5e`.

1. **Model credentials, pushed.** `getRuntimeConfigSnapshot`
   (`claxedo-server-core/src/agent-config/index.ts:507`) resolves the org's
   secrets for a scope and the supervisor posts the snapshot to the runtime
   (`claxedo-server/src/workspace/supervisor/config-sync.ts:14`). The runtime
   puts them in the harness child's environment (Claude, Pi) or lets the
   Codex app-server write `CODEX_HOME/auth.json`. The agent's shell inherits
   them. No user is named anywhere in the snapshot.
2. **Brokered secrets, driver channel.** `SandboxBrokeredSecret`
   (`sandbox-manager/src/index.ts:267`) is `{name, value, hosts, header?}`.
   Producers: the GitHub clone token (`workspace/repository-clone.ts`) and
   MCP gateway tokens (`agent-plugins/mcp/runtime-preparation.ts:297`). The
   manager refuses drivers marked `secretBrokering: "none"`.
3. **The Cloudflare egress Worker.** `drivers/cloudflare-egress.ts` mints a
   15 minute JWT per sandbox; the sandbox routes brokered hosts through
   `/egress` with the target in a header. Nothing refreshes the token.
4. **Docker local auth copy.** Opt-in copy of `~/.codex/auth.json`,
   `~/.codex/accounts`, `~/.claude.json` into the container at boot
   (`drivers/docker.ts:76`).

The driver catalog (`sandbox-manager/src/driver-catalog.ts`) records what
each provider could do when the driver was written. Checked against the
providers' current documentation on 2026-09-12:

| Driver | Catalog | Provider today | SDK pinned → latest |
| --- | --- | --- | --- |
| Daytona | native, hosts+CIDRs | secrets with `dtn_secret_…` placeholders swapped in HTTPS headers on allowlisted hosts; responses scrubbed; `updateSecrets` on a running sandbox | 0.192.0 → 0.211.2 |
| Vercel | native, hosts | firewall `transform` header injection per domain; matchers on path/method/query/headers; `forwardURL` to your own proxy with an OIDC token naming the sandbox; live policy updates | 1.10.2 → 3.3.0 |
| Cloudflare | proxy, opt-in; egress none | `allowedHosts`/`deniedHosts`, `outbound`/`outboundByHost` handlers in the Worker, HTTPS intercepted with a per-sandbox CA, header injection in the handler | 0.8.9 → 0.12.9 |
| exe.dev | none, none | Integrations: secret stored server-side, injected at the edge for `<name>.int.exe.xyz`; HTTP proxy, GitHub, S3 signing, and an LLM integration taking Anthropic/OpenAI keys or a ChatGPT subscription; attach per VM, tag, or all | shell over `/exec` |
| Modal | none, none | Secrets are still readable env; Sidecars (alpha, allowlisted) run a proxy holding the secret with the sandbox on `outbound_cidr_allowlist=[]`; `outbound_domain_allowlist` (beta), `updateNetworkPolicy` (alpha) | 0.7.5 → 0.10.1 |
| Box | none | plaintext env in a `docker run` command line; no secret or egress feature | — |
| Docker (local) | none | plaintext `--env`; loopback only | — |

Every harness we run accepts a base URL and a credential from the
environment or config: Claude Code (`ANTHROPIC_BASE_URL`,
`ANTHROPIC_API_KEY` or `ANTHROPIC_AUTH_TOKEN`, `ANTHROPIC_CUSTOM_HEADERS`,
`apiKeyHelper`), Codex (`model_providers.<id>.base_url`, `http_headers`,
`env_http_headers`, `requires_openai_auth`, and `chatgpt_base_url` for the
subscription backend), Cursor (`CURSOR_API_ENDPOINT`, `CURSOR_API_KEY`).
Pi and the embedded OpenCode engine take per-provider base URLs in their
own config; the exact keys are listed under Unverified.

## The one system

### Concepts

Three, and only three, named things.

- **Binding.** `{ runtime, hosts, credential, inject }`. *Runtime* is a
  sandbox lease or a local runtime id. *Hosts* is the egress allowlist the
  credential is valid for. *Credential* is a registry row id plus the
  account selection rule (section "Which account"). *Inject* is how the
  edge attaches it: `header` (name and scheme, e.g. `Authorization: Bearer`,
  `x-api-key`) or `query`/`basic` for the two providers that need them.
  This is today's `SandboxBrokeredSecret` with the value replaced by a
  reference and the runtime named.
- **Delivery adapter.** One per sandbox driver, plus one for local runtimes.
  `apply(runtime, bindings)` makes the bindings true and returns the
  **projection**: the base URL and placeholder the harness must be
  configured with. `update(runtime, bindings)` changes them on a running
  runtime. Native where the provider brokers; the generic broker otherwise.
- **Projection.** What the harness is told. One shape for every harness:
  per provider, a base URL and a placeholder credential. Transparent
  brokers (Daytona, Vercel, Cloudflare) project the vendor's real host as
  the base URL and the placeholder as the key. Proxy brokers (exe.dev,
  Modal sidecar, the generic broker) project the proxy's URL as the base URL
  and a dummy as the key. The harness does not know which it got.

The runtime config snapshot keeps its shape and loses its secrets: `auth`
carries projections instead of values. Version bump to v4; the v3 reader is
deleted with the push of plaintext values, not kept alongside.

### Flow, end to end

A. **Turn starts** for user U in workspace W on harness H.
   A.1 The control plane resolves the account for each provider H needs:
       U's personal row for that provider if U has one and it is active,
       else the org's active row, else nothing (the implicit tier).
   A.2 `bindings(W, U)` is computed: one binding per provider with a row.
       Same inputs, same output, so a second turn by U reuses them.
   A.3 If the runtime's current bindings differ, the adapter's `update`
       runs before the turn is dispatched. Native adapters call the
       provider (Daytona `updateSecrets`, Vercel `update({networkPolicy})`,
       Cloudflare `setOutboundByHost`, exe.dev `integrations edit`/`attach`).
       The generic adapter writes the binding table the broker reads; no
       call to the runtime is needed.
   A.4 The projection is unchanged across account switches (same base URL,
       same placeholder), so the harness process keeps running. This is
       what makes per-user accounts free of harness restarts.
B. **The harness makes a request** to its base URL with the placeholder.
   B.1 Transparent broker: the request goes to the vendor host; the edge
       replaces the placeholder (Daytona) or overwrites the header (Vercel,
       Cloudflare handler) with the real value for the bound account.
   B.2 Proxy broker: the request goes to the proxy; the proxy looks up the
       binding, injects the header, forwards to the vendor, scrubs the
       response.
C. **Refresh.** The control plane refreshes an expiring OAuth token in the
   registry (`refreshCredentialSecret`, already exists) and calls
   `update`. The sandbox sees nothing change. Codex refresh no longer runs
   inside the app-server, because the app-server never holds the token.
D. **Failure.** A 401 from the vendor is reported by the edge (Vercel
   `forwardURL` proxy, Cloudflare handler, generic broker) or by the
   verifier's scheduled check (Daytona, which reports nothing back). The row
   is marked `auth_failed` and the binding is withdrawn; the harness's next
   request fails with a named error, never with a stale credential.
E. **Local runtime on the user's machine.** The local server hosts the
   generic broker on loopback. A stored account is bound the same way; the
   harness gets `http://127.0.0.1:<port>/broker/<binding>` as its base URL.
   The implicit tier (no row bound) is untouched: the CLI uses its own
   login, no base URL is set.

### Per-driver mapping

| Driver | Adapter | Base URL projected | Placeholder | `update` |
| --- | --- | --- | --- | --- |
| Daytona | native secrets | vendor host | `dtn_secret_…` from the secret | `updateSecrets` (seconds; new env only for new processes, so the placeholder is created at boot and only its value changes) |
| Vercel | native transform | vendor host | any dummy | `update({networkPolicy})`, union-merged as today |
| Cloudflare | native outbound handler | vendor host | any dummy | `setOutboundByHost` at runtime; the handler reads the binding table |
| exe.dev | native integrations | `https://<name>.int.exe.xyz` | any dummy | `integrations edit` for the value, `attach`/`detach` per VM; the LLM integration type covers Anthropic, OpenAI keys and ChatGPT subscriptions directly |
| Modal | sidecar proxy when the workspace is allowlisted; generic broker otherwise | sidecar `http://egress-proxy:8080` or the broker URL | any dummy | sidecar restart or broker table |
| Box | generic broker | broker URL | any dummy | broker table |
| Docker | generic broker on the local server's loopback (`host.docker.internal`) | broker URL | any dummy | broker table |
| Local runtime | generic broker on loopback | broker URL | any dummy | broker table |

The Docker auth-file copy is deleted. The Cloudflare hand-built proxy is
deleted once the SDK upgrade lands; until then it is the generic broker's
first host, since its core is already runtime-agnostic.

### The generic broker

One HTTP service, one code path, hosted in the control plane (Node) and as
a Worker, and on the local server for Docker and local runtimes. It is the
existing `cloudflare-egress.ts` core with three changes:

1. **Binding lookup, not sandbox lookup.** The request's token names the
   runtime; the broker resolves `(runtime, target host)` to a binding in the
   binding table at request time. Switching accounts is a table write.
2. **Token refresh.** The runtime's broker token is carried in the runtime
   config snapshot and re-pushed on a schedule shorter than its TTL, the
   same channel that already re-pushes config. The 15 minute dead-end goes
   away.
3. **Base URL form, not a target header.** The broker serves
   `/broker/<binding-id>/<path>` and forwards to the binding's vendor host.
   The target header stays for MCP, whose gateway already uses it; model
   traffic uses the path form because every harness takes a base URL and
   none takes a custom header on every request.

Injection rules the broker enforces on every request: strip the placeholder
header the harness sent, set the bound header, set `Host`, forbid
redirects, drop the injected header from the response, never log the value.
These are the rules the Cloudflare core already has; they become the shared
ones.

### Which account

The accounts design fixed "one active per provider per org". This design
adds the personal layer the connections kit already has for GitHub and
MCP, using the same partition rule:

- A credential row has an `owner`: empty for the org (team), a user id for
  personal. Same column semantics as `claxedo_connection.owner`.
- `active` is per `(owner, provider)`: each user has at most one active
  personal row per provider; the org has at most one active team row.
- Resolution at turn start: the turn's user's active personal row, else
  the org's active team row. Identical to `resolveForCapability`'s
  personal-over-team rule.
- On the unsigned local server there is no user, so every row is team and
  the behaviour is exactly the accounts design as written.

The turn's user comes from the signed request that starts it. Turns not
started by a user (wakes, schedules) resolve to the team row only, the same
fail-safe the connections kit documents: a lost owner degrades to "personal
account unused", never to "personal account spent by automation".

### Settings → Providers

Unchanged in shape. Each harness row gains the owner dimension: "Your
account" and "Team account" lists, each with its Active mark, and the
existing Check. The "In use" line names the account the *viewer's* next
turn would run on, which is now a function of the viewer, so the effective
route takes the user from the signed request.

## Tradeoffs

- **Placeholder in env is still a secret-shaped string.** On Daytona a
  copied placeholder is useless outside the sandbox and only works toward
  allowlisted hosts. Accepted.
- **Transparent brokers terminate TLS or read SNI.** Vercel and Cloudflare
  install a per-sandbox CA. Harnesses with pinned certificates would break;
  none of ours pin. Noted as a check per harness.
- **Proxy brokers see model traffic.** The generic broker forwards prompts
  and completions through Claxedo infrastructure. It never stores them, and
  the logging rules forbid bodies, but it is a new path for the data. Where
  the provider has a transparent broker we use it, precisely to avoid this.
- **Codex subscription accounts through a proxy** need the app-server to
  treat the proxy as its ChatGPT backend. Codex exposes
  `chatgpt_base_url`, and exe.dev's LLM integration proves the shape works,
  but the app-server also expects a local login to exist. Whether a dummy
  login plus `chatgpt_base_url` is enough, or the provider form with
  `requires_openai_auth=false` is needed, is the first thing to verify.
- **Daytona reports nothing.** A rejected credential surfaces only through
  the harness's error or the scheduled verify. Accepted; the verify already
  exists.
- **One more table.** Bindings are state the control plane must keep
  consistent with the providers. The reconcile on wake (re-apply bindings
  to the resumed runtime) is the same shape as today's network policy
  reapply, which the wake paths currently skip; both get fixed together.

## Unverified assumptions, and how to verify each

1. Daytona substitutes the placeholder inside `x-api-key`, not only
   `Authorization`. Their doc says HTTPS headers generally. Verify with a
   Daytona secret and a Claude Code turn.
2. A Vercel `transform` overwrites a header the client sent, so a dummy
   `x-api-key` does not survive. Verify with a Vercel sandbox and curl.
3. Cloudflare outbound handlers arrived between 0.8.9 and 0.12.9; the
   exact version and whether interception covers Bun and Node clients in
   our runtime image. Verify by upgrading the worker's dependency in a
   branch and running the existing egress tests against a live sandbox.
4. Codex on a subscription account through a proxy: `chatgpt_base_url`
   with a dummy local login, or the `model_providers` form. Verify with the
   local generic broker and a real ChatGPT login held only by the broker.
5. Cursor's `CURSOR_API_ENDPOINT` accepts a proxy that injects
   `Authorization`. Verify with the local broker.
6. Pi and the embedded OpenCode engine: the config keys for per-provider
   base URL and headers. Read their provider config code and set them from
   the projection.
7. exe.dev team integrations (`.team.exe.xyz`) versus personal, and whether
   `integrations edit` swaps a stored key without detaching. Verify on an
   exe.dev VM over `/exec`.
8. Modal sidecar allowlisting for our workspace. Ask; until then Modal is a
   generic-broker driver.
9. The turn request carries the user's subject down to where the turn is
   dispatched in every deployment mode. The connections turn-credential
   skeleton (`turn-credentials.ts`) was built for this and is unwired;
   verify by tracing `spawnTurn` callers in hosted and self-hosted apps.

## Phases and acceptance criteria

### Phase 0: catalog and SDKs tell the truth

- Upgrade `@daytona/sdk`, `@vercel/sandbox`, `@cloudflare/sandbox`, `modal`
  to current; fix the driver code the upgrades break.
- Re-declare `secretBrokering` and `egressControl` per driver from the
  provider docs above; delete the two stale JSDoc blocks in
  `sandbox-manager/src/index.ts` that say proxy mode fails closed.
- Fix the two defects found on the current channel: the doubled `Bearer`
  on the Daytona MCP path, and the clone secret that no consumer attaches
  on Daytona.

Acceptance:
- [ ] `sandboxDriverCatalog` matches the table in this document; the
      documentation ratchet in `egress-policy.test.ts` is updated with it.
- [ ] Each driver's existing tests pass on the upgraded SDK.
- [ ] A Daytona MCP call sends exactly one `Bearer`, asserted by test.

### Phase 1: the binding contract and the generic broker

- `Binding` type and binding table in the control plane (SQLite locally,
  the org-partitioned KV on hosted), with `apply`/`update`/`withdraw`.
- The generic broker as a package (`@claxedo/egress-broker`): the
  `cloudflare-egress.ts` core moved and generalised (path form, binding
  lookup, token refresh through the config push). Hosted in the Node app,
  the Worker, and the local server.
- Delivery adapters: generic (all drivers), then Daytona and Vercel native
  (these are the existing driver code moved behind the adapter interface).
- The projection in the runtime config snapshot (v4); the runtime
  configures Claude, Codex, Cursor from it; the plaintext `auth` push is
  deleted with it.
- Local runtimes and Docker on the loopback broker; the Docker auth-file
  copy deleted.

Acceptance:
- [ ] A Claude turn on Docker, on Daytona, and on Vercel runs with a stored
      Anthropic key that never appears in the runtime's env, files, or
      `/proc/*/environ`, asserted by a test that greps the container.
- [ ] Rotating the key in Settings makes the next request use the new
      value with no runtime restart, on all three.
- [ ] Deleting the row makes the next request fail with a named error.
- [ ] The v3 snapshot reader is gone; the runtime rejects a snapshot with
      values in `auth`.
- [ ] `bun run test:architecture-ratchets` green; each package's own
      typecheck and test scripts green.

### Phase 2: native adapters for Cloudflare and exe.dev; Modal sidecar

- Cloudflare: outbound handlers reading the binding table; the hand-built
  `/egress` route and its JWT deleted.
- exe.dev: integrations created and attached over `/exec`; the LLM
  integration for model accounts, HTTP proxy integrations for everything
  else.
- Modal: sidecar adapter behind an allowlist check, generic otherwise.

Acceptance:
- [ ] The Phase 1 three-way test passes on Cloudflare and exe.dev.
- [ ] No brokered request on Cloudflare or exe.dev touches the generic
      broker, asserted by broker access logs being empty in the test.

### Phase 3: per-user accounts

- `owner` on credential rows; `active` per `(owner, provider)`; the
  personal-over-team resolution at turn start; the turn's user carried to
  dispatch (assumption 9).
- Settings → Providers with the two lists per harness.
- Codex subscription accounts through the broker (assumption 4), replacing
  the per-account `CODEX_HOME` plan: the app-server never holds the token,
  so no home isolation is needed.

Acceptance:
- [ ] Two users in one hosted org, one workspace: user A's turn runs on A's
      personal account and user B's on the team account, verified by the
      vendor-side account id in each response.
- [ ] A wake-fired turn runs on the team account even when the session's
      owner has a personal one.
- [ ] `~/.codex/auth.json` on the operator's machine is byte-identical
      before and after a Codex turn on a stored account.

### Definition of done

Every acceptance box checked; the four delivery paths in "Background"
reduced to one; the accounts design's sections 2, 4, 6 and Phase 3 marked
superseded with a pointer here; `public-docs/sandbox-egress.md` rewritten
from the new catalog.

## Glossary

- **Binding**: the rule that requests from one runtime to some hosts carry
  one credential.
- **Delivery adapter**: the per-driver code that makes a binding true.
- **Projection**: the base URL and placeholder a harness is configured with.
- **Transparent broker**: the provider injects on the way out; the harness
  talks to the vendor host (Daytona, Vercel, Cloudflare).
- **Proxy broker**: the harness talks to a proxy that injects and forwards
  (exe.dev, Modal sidecar, the generic broker).
- **Implicit tier**: a harness with no binding uses its own CLI login on
  the local machine. Unchanged.
