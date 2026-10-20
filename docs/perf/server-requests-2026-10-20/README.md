# Onboarding requests: sign-in, connect windows and account setup, 20 October 2026

The owner, signed in on the web from India: "Onboarding has individual requests taking long times; the redirect URL after OAuth is done, on the redirecting window, is slow. Same when setting up an AI provider or a sandbox provider etc." This note inventories every request those flows make, from the app's call to the Worker's handler, and for each the serial chain the person waits on; says what changed on `perf/server-requests` and what each change saves; and says what staging will show and how to capture it. The local stack scripts every vendor, so vendor and GitHub latency are not measured here; the chains are counted on the real composition (`countD1Rounds`) and the savings are estimated from costs measured on staging by earlier notes.

## What one wait costs

| wait | cost | source |
|---|---|---|
| a browser round trip to the control plane from India (warm isolate, reused connection) | 0.35–0.45 s, median 0.37 s | [worker-cold-starts-2026-10-19](../worker-cold-starts-2026-10-19/README.md) |
| the same on a cold isolate | 0.7–1.5 s, median 0.97 s; half of the requests after a 30 s pause | same |
| one serial D1 round from the Worker (IAD) to D1 (ENAM) | 34–50 ms alone, 77–107 ms when several requests share the isolate | [d1-signed-reads-2026-10-18](../d1-signed-reads-2026-10-18/README.md) |
| one serial call from the Worker to GitHub, OpenAI, Anthropic or a sandbox provider | not measured; the new `upstream-host` entries below measure it | this note |

A browser round trip is worth four to ten D1 rounds, so the client-side chains, the waits between a person's action and the screen settling, dominate; the server-side rounds add up where a handler pays many.

## Flow a: sign in with GitHub

The signed-out document (`login.html`) serves the form with its descriptor published into the page; the click runs `signIn` (`packages/claxedo-app/src/auth/better-auth-actions.ts`), which posts `POST /api/auth/sign-in/social` and leaves for GitHub. GitHub sends the browser to `GET /api/auth/callback/github`, which Better Auth answers with a redirect to `/`, the app's document with the session cookie (`shellDocument`) and its six preloaded reads.

| step | before | after |
|---|---|---|
| click → leave for GitHub | `GET /api/claxedo/auth/descriptor` (the live descriptor), then `POST /api/auth/sign-in/social` (rate-limit binding, one D1 insert of the state row): two browser round trips in a row | the two together (`disableRedirect`, then `window.location.assign` once the live descriptor agrees): one round trip; saves 0.37 s warm, about 1 s cold |
| `GET /api/auth/callback/github`, a returning person | rate-limit binding; state: read, read again, delete expired rows (two statements), pre-read and delete the used row (five D1 rounds); GitHub token exchange; `GET api.github.com/user`; then `GET /user/emails`; account lookup joined to the user; write GitHub's tokens onto the account; insert the session; insert the sign-in evidence: **nine D1 rounds and three GitHub calls in a row** | state three rounds; token exchange; `/user` and `/user/emails` together (`githubUserInfo`); account lookup; session; evidence: **six D1 rounds and two GitHub calls** (`better-auth-d1-github-sign-in.d1.test.ts`); the expired-row deletion runs after the response (`retireExpiredVerifications` under `waitUntil`); saves three rounds (0.1–0.3 s) and one GitHub round |
| the same, a person signing in for the first time | ten D1 rounds (no account write; a user-by-email read and one batched user-and-account insert instead) and three GitHub calls | eight D1 rounds and two GitHub calls |
| `GET /` after the redirect | the app document and its six preloads, each re-verifying the cookie | unchanged here (the boot's reads are other lanes') |

The callback's state stays in the database with Better Auth's signed state cookie. Better Auth's cookie strategy would remove the remaining three state rounds and the sign-in start's insert, but it carries the whole state, a native client's authorize query included, in one encrypted cookie that can outgrow a browser's 4 KB cookie limit, so it was not taken.

## Flow b: the windows the app opens for a provider

The web app manages no popup. Every connect window is `openExternal` (`window.open` with `noopener`) or a link, so the opener has no handle on it; it learns of completion by polling or by one held request. No callback boots the app: the Connections callback answers a static page.

| window | how the opener learns | before | after |
|---|---|---|---|
| ChatGPT / Codex sign-in (device authorization; Settings → Models and the AI step) | one held request, `POST /provider/:id/oauth/callback`, which polls OpenAI from the Worker | the Worker polled `deviceauth/token` every interval **plus 3 s**: an approval sat unnoticed up to 8 s (4 s on average) at OpenAI's 5 s interval, then the token exchange, the account write, and the app's two serial rereads | polls at exactly the interval, as OpenAI's own Codex login does (`codex-rs/login/src/device_code_auth.rs`): up to 5 s (2.5 s on average), saving 1.5 s on average and 3 s at worst; the app's rereads run together, saving one browser round trip |
| GitHub connection (device grant; Settings → Connections, the Project step) | the app polls `GET /api/claxedo/integrations/attempts/:state` every GitHub interval (5 s) | each poll read the person and their organizations in two serial rounds, the attempt's owner twice, and resolved every retained MCP server's discovery (R2 artifact reads, probe POSTs, DNS-over-HTTPS) before asking GitHub; the completing poll then read GitHub's `/user` before writing the connection | the person and organizations together, the owner once, no MCP discovery on a poll (`builtInOnly`): two D1 rounds fewer per poll and no discovery; the completing poll names the account while it writes the secret (`storeDeviceGrant`), so GitHub's `/user` overlaps three D1 rounds; the connect asks GitHub for the device code beside the existing-row read, one round fewer |
| MCP server sign-in (redirect + PKCE, Settings → Connections) | the same poll; the provider redirects the opened tab to `/api/claxedo/integrations/callback`, a static "Connection complete" page | the app noticed on its next 5 s poll, which also began only 5 s after the window opened; a poll was six D1 rounds plus the discovery above | the app reads the attempt the moment the person comes back to it (visibility or focus, `awaitGrant`); a poll is four D1 rounds (`setup.test.ts`); saves up to 5 s after the person returns |

Not taken: the static callback page could post on a `BroadcastChannel` the app listens to, but every Worker response carries the API's `default-src 'none'` policy, so the page would need its own script hash in that policy; returning to the app is the moment the person is ready to see the result anyway.

## Flow c: AI provider accounts and sandbox provider keys

Every account write in the app runs through `accountWrites` (`packages/claxedo-app/src/server/account-writes.ts`), which rereads the accounts (every query under the accounts prefix: the list, the ones in use, the sources, the sandbox keys, each harness's model list) and the provider catalogs when the write settles.

| action | before (browser round trips in a row) | after |
|---|---|---|
| paste an API key or a `claude setup-token` and Save (harness row) | `PUT /api/claxedo/credentials`, accounts reread, then catalogs reread, then a rescan (`machine-logins` then the accounts again): five | `PUT`, then accounts and catalogs together: two; saves three, about 1.1 s warm |
| the same from a provider row under Settings → Models | `PUT`, accounts, catalogs, then the catalog again: four | two |
| add a sandbox provider key (the Where step, Settings → Sandbox providers) | `PUT`, accounts, catalogs, then `POST /:id/verify`, accounts, catalogs: six | `PUT`, verify, then both rereads together: three; saves three, about 1.1 s warm |
| choose one of the person's own accounts | `PUT /account-sources`, two rereads, `POST /activate`, two rereads: six | `PUT`, `POST`, then both rereads together: three |
| Check an account or key | verify, then two rereads: three | two |

On the server, for each request (D1 rounds after the session's own verification):

| handler | before | after |
|---|---|---|
| `GET /api/claxedo/credentials` (list) and `/effective` | three | two (`signed-read-rounds.d1.test.ts`) |
| `GET /credentials/sandbox-drivers` | four | two |
| `PUT /credentials/sandbox-drivers/default` | about eight (a second `usersMe` reading the principal, the organizations and a Better Auth profile; the list and the manage check twice) | four |
| `PUT /credentials` with a sandbox provider key | the save, wrapped in reading every running workspace's delivery before and after (each a full `sandbox_leases` scan with two owner lookups per ready lease), then the retry-wait lift | five, with no delivery reads: no workspace is delivered a sandbox key (`deliverableRows`) |
| `PUT /credentials` with an account | the delivery reads, the row lookup, a read of a fresh id that cannot exist, the person's other accounts, the write, the delivery reads | the same minus the impossible read, with the mark read beside the other accounts |
| `POST /credentials/:id/verify` | unchanged: the row, the vendor's probe, the health, usage and label writes | unchanged |
| every hosted credential route | the session verified per call that needed it, each with its own principal read | verified once per request (`signed`) |

Vendor probes (`verify.ts`, `sandbox-verify.ts`) are one call each, except an Anthropic subscription's three (catalog, then usage, then profile). Running usage and profile together was tried and reverted: it would also ask the profile when the usage read refuses a setup-token, which the verify tests hold it must not.

## What Server-Timing shows on staging

Every Worker response carries `Server-Timing` (`packages/claxedo-server/src/platform/http/server-timing.ts`). New on this branch:

- `upstream;dur=…`: the time the request waited on its outbound calls until their response headers arrived, overlapping calls counted once.
- `upstream-host;desc="<host>";dur=…`: the same per host: `github.com` and `api.github.com` on the sign-in callback and a connection's polls, `auth.openai.com` on the ChatGPT sign-in, `api.anthropic.com`, `api.openai.com`, `chatgpt.com`, `api.cursor.com`, `boat.dev`, `api.vercel.com` on a Check.
- The Agent Plugins and full-hosted entries now count their own control-plane statements and the Connections authentication in `d1` and `auth`; before, a connection request's `d1` held only the authority's reads, not its attempt, connection and credential statements.

On the Workers runtime the clock advances only across I/O, so `total` minus `auth`, `limit`, `d1`, `do` and `upstream` is close to zero; a request whose remainder is large waited on something else (KV, R2, the cache API). A request over 1 s is also written to the Worker's log as `[timing] <method> <path> <status> <entries>`.

Expected on a returning person's GitHub callback: `d1` about six rounds' worth (0.2–0.6 s), `upstream-host;desc="github.com"` one token exchange and `upstream-host;desc="api.github.com"` one overlapped read.

## Capturing a staging trace

Signed in on `https://app.claxedo.dev` with the browser's DevTools open (Network, Preserve log):

1. Run `trace.sh` beside this file in another terminal; it tails `claxedo-user-deployed-locked-staging` and prints every `[timing]` line (the requests over 1 s, which the sign-in callback and the held ChatGPT callback are).
2. Walk the flow: sign out and sign in with GitHub; Settings → Models, add a key, Check it, choose it; Settings → Sandbox providers, add a key; Settings → Connections, connect GitHub.
3. The callback's own `Server-Timing` is on the 302 hop in the Network panel (Response Headers of `callback/github`). For everything the page fetched, paste in the console:

```js
copy(performance.getEntriesByType("resource").filter((entry) => entry.serverTiming.length).map((entry) => [new URL(entry.name).pathname, Math.round(entry.responseStart - entry.requestStart), entry.serverTiming.map((timing) => `${timing.name}${timing.description ? `(${timing.description})` : ""}=${Math.round(timing.duration)}`).join(" ")].join("  ")).join("\n"))
```

Each line is the path, the time to first byte the browser saw, and where the Worker's share of it went; the difference between the two is the network and the isolate's start.

## What only a staging trace can confirm

- What one GitHub, OpenAI, Anthropic and sandbox-provider call costs from IAD, and so what the overlapped GitHub read and the ChatGPT interval are worth in absolute terms.
- That the GitHub callback's `d1` falls by about three rounds and its `upstream` by one GitHub round.
- What the MCP discovery a Connections poll no longer runs cost on an organization with retained MCP servers (nothing on one without).

## Left on these paths, with their owners

- **An account write's delivery reads** (`workspace/hosted-runtime-delivery.ts`, `credentialChange`): every AI-account save, choice and removal still reads the organization's running workspaces' delivery before and after, each a full `sandbox_leases` scan (every organization's leases) with two serial owner lookups per ready lease, and awaits the redelivery before it answers. A lease query filtered to the organization would cut the scan; moving the redelivery after the response would change how a failed delivery is reported (`credential_delivery_failed`), which the routes promise today.
- **Better Auth's state consume** (three rounds: read, pre-read, delete) could be one `DELETE … RETURNING` through the existing `better-auth@1.7.1` patch, and the session and evidence inserts one batch.
- **The app document after sign-in** preloads six reads that each verify the same cookie (boot lanes).
- **A sandbox key's save** reads every lease to lift the retry waits the new key may fix (one round, `liftOrgKeyRetryWaits`).
- **The Connections list** reads one credential per connection (`summarize`).
