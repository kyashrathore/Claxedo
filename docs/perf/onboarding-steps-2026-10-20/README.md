# The onboarding steps, 20 October 2026

The owner went through the hosted onboarding on staging from India and found every step slow. On that network one warm control-plane call answers in about 0.4 s and a call that lands on a cold isolate in 1.0 to 1.3 s, so what a step costs is the number of control-plane rounds it waits on in series.

## The steps and what each waited on

A signed-in person with no project boots the shell at `/`, whose home route sends them to `/welcome` once the project list and the shared-session list have answered (`HomeRedirect`, `onboardingNeeded`). The hosted wizard then asks Where it runs, Project and AI, and Create workspace creates the cloud workspace, starts it and opens its draft.

Measured on dev `74370a87cf` with the rig's `onboarding` scenario (below), p50 of 3 under the `india-staging` profile; times are from the navigation or the press:

| step | ready when | before | what it waited on, in series |
|---|---|---|---|
| boot → Where it runs | the sandbox-key rows or the provider line are drawn | 1161 ms, 61 requests, 719 kB, 3 waves | the shell's preloaded reads and `main.js` (wave 1, `main.js` answered at 547 ms), the wizard's chunks (wave 2, from 741 ms), then the organization's sandbox listing (`credentials/sandbox-drivers`, 944–1155 ms), which the wizard requested only once its own chunk had evaluated, beside the accounts and the full `integrations` catalog it prefetched on mount |
| Next → Project | the repository entry is drawn | 249 ms, 3 requests | the code-host connections (`integrations?capability=code-host`, one round): the wizard had prefetched `integrations`, a query no step reads |
| Continue → AI | the first account card is drawn | 15 ms, 4 requests | nothing: the accounts, the ones in use and their sources were prefetched; Pi's provider catalog (149 kB) loads beside the cards |
| Create workspace → draft composer | the draft screen's composer is editable | 4752 ms, 30 requests | `workspace/create` (1–211) → the catalog re-read (212–420), then the shared sessions (422–632) → the start's connection (633), its provisioning polls and the `cloudWorkspaceChanged` events until ready → the final connection and the catalog re-read (4074–4306) → the catalog again (4307–4516), then the shared sessions again (4517–4723) → the draft |

The four steps summed waited 6177 ms on this profile.

## What changed

- The route entry's view (`src/onboarding/route.tsx`) stays in the shell's chunk and starts the steps' reads the moment the route matches (`prefetchOnboardingReads`, `src/onboarding/prefetch.ts`): the stored accounts, the ones in use and their sources, and on a hosted plane the organization's sandbox listing and, where Connections are served, the code-host connections. All are reads; none writes or wakes a cloud workspace. They now leave at 758 ms, with the wizard's chunks, instead of after the chunk evaluates. The wizard's own mount-time prefetch, which read the full `integrations` catalog where the Project step reads `integrations?capability=code-host`, is gone.
- `Workspaces.refresh` (`src/server/workspaces.ts`) re-reads the catalog and the shared sessions at once, then invalidates the placement reads; it read them one after the other. The finish refreshes after the create and after the start, so each refresh is one round instead of two.

## Measured

`bun run --cwd packages/claxedo-app e2e:perf-web --reps=3 --profile=india-staging` (100 ms RTT to static, 300 ms to the API, 10 Mbps down; the e2e front over HTTP/2), p50 of 3, same host, two minutes apart: dev `74370a87cf` in a detached worktree with only the rig's files copied in, then this branch.

| step | before | after |
|---|---|---|
| boot → Where it runs | 1161 ms, 61 requests, 719 kB, 3 waves | 986 ms, 61 requests, 719 kB, 3 waves |
| Next → Project | 249 ms, 3 requests | 34 ms, 2 requests (no read; telemetry) |
| Continue → AI | 15 ms, 4 requests | 12 ms, 4 requests |
| Create workspace → draft composer | 4752 ms, 30 requests | 4353 ms, 30 requests |
| the four steps summed | 6177 ms | 5385 ms |

After the change the Where step's reads leave at 758–759 ms and answer by 983, and the step is drawn at 986. The finish: create 1–211, catalog and shared sessions together 212–425, the start's connection at 427 where it was at 633, ready around 3877, the final catalog and shared sessions together 4109–4324, the draft at 4353. Each step loses one control-plane round from its path: on staging, where a round is 0.4 to 1.3 s, that is 0.4 to 1.3 s on the Where step, on the Project step and on each of the finish's two refreshes.

The other scenarios in the same two runs, p50 before → after: cold root 796 → 794 ms, first session press 479 → 475, cold session 1661 → 1668, warm reload 791 → 793, open session 446 → 441, marketplace 347 → 351, settings 11 → 10, signed-out login 368 → 359, with the same requests and bytes.

## The rig's onboarding scenario

`e2e/perf/web/onboarding-scenario.ts` runs on the local target only: each repetition signs up a new person, invites them into the stack owner's organization as an admin and accepts, so they boot into the wizard like the owner of a fresh organization that already holds a sandbox key. It measures the cold boot of `/` to the Where step, the press of Next to the Project step, the press of Continue (a pasted repository URL, the stack's own git server) to the AI step, and the press of Create workspace to the draft screen's composer. The probe marks `onboarding:<step>` when the current step's panel is visible with its content and no spinner, and `draft` when the draft screen's composer is editable. `--onboarding-only` runs this scenario alone.

## Not changed, and why

- The `main.js` download (547 ms of the boot's first wave) and the chunks the wizard's route pulls are the boot lanes' work; the reads this change moved now end with the chunks.

## The finish's remaining rounds

Create workspace → draft composer still waited on three rounds that were not dependencies: the start's connection waited for the create's catalog read, the wake driver read the catalog again after the `cloudWorkspaceChanged` notice had read it, and the hosted create ran its repository lookups one after another.

- A start names its workspace by the placement id (`driveWake`, `src/server/workspace-wakes.ts`), which is the workspace id in both catalogs and what stop and delete already send, so it reads no catalog before its first request. The onboarding starts the workspace in `cloud.create`'s `onCreated` (`src/onboarding/place.ts`), the moment the account's create answers, and `cloud.create` (`src/server/cloud.ts`) waits on that start beside its catalog read; `startCreated` starts only a workspace this run has not started, so a retry after a failed start still starts it.
- When the server's notice that the start ended reached the tab while the start ran, its invalidation has already re-read the bootstrap and the account catalog, and the wake waits on that read (`workspaces.load()`, which joins a read in flight) instead of reading the catalog and the shared sessions again. With no notice (a start of a sandbox that was serving, a lost notice) the wake still refreshes. Every session open and turn start goes through the same driver: the sends that wake a workspace (`wakeIfStopped`) and the follow of a start the server drives read the catalog once per start the server announced, where they read it twice.
- The hosted `POST /api/workspace/create` (`cloudCreateSource`, `packages/claxedo-server/src/workspace/cloud-create-source.ts`) admits the pasted URL's destination, looks up the connection that can read it and reads the organization's sandbox driver together, and for a pasted GitHub URL asks GitHub whether the repository is public beside the connection lookup (`pastedRepositoryConnection`, `repository-connection.ts`). The results are judged in the order a refusal was reported before, and the row is written only after all of them, so each still guards what it guarded: the clone destination, the connection a private repository is bound to (it decides the row's `repoUrl` and `repoConnectionId`, so it cannot run beside the write), and the driver a machine size is checked against. The admission of a connection's clone URL stays after the lookup, since it is the lookup's answer; it is a cached DNS answer for `github.com`.

What the hosted create's lookups cost on staging, from the call shapes (the rig's repository is the stack's own git server, an approved private host that is neither resolved nor a GitHub URL, so the rig measures none of this):

| lookup | what it calls | serial cost on staging |
|---|---|---|
| destination admission | `dohAddressResolver`: A and AAAA together from `https://1.1.1.1/dns-query`, cached per isolate for 60 s | the resolver answers inside Cloudflare; from India the same query takes 100 ms with its TLS set up, so a Worker pays a few tens of ms on a cold isolate and nothing on a warm one |
| connection lookup, no GitHub connection | `createHostedRepositoryAccess`: the membership (`usersMe`, `listOrgs`), then the connection rows | 4 serial D1 rounds (counted with `countD1Rounds` over the real D1 schema), about 320 ms at the staging Worker's 80 ms hop to its ENAM databases |
| GitHub visibility | `anonymousGitHubVisibility`: `GET https://github.com/<owner>/<repo>.git/info/refs?service=git-upload-pack`, body cancelled | from India 400–640 ms to the first byte for a public repository and about 400 ms for a 401, nearly all of it GitHub's own time after a 50 ms connect, so about 0.3–0.5 s from the Worker |
| organization driver | `orgSandboxDrivers.forOrg`: the key rows, the chosen driver, then the key's secret on an isolate's first create | 2–3 serial D1 rounds, 160–240 ms |

Before, a pasted public GitHub URL paid all four in a row, roughly 0.8–1.1 s before the row's own writes; together the create waits for the longest, the GitHub answer or the connection lookup, about 0.3–0.5 s.

Measured with the same rig and profile, p50 of 3, dev `5a6dde937e` in a detached worktree and then this branch on it, back to back on the same host (load 12.5 → 7.4 over the two runs, another lane's suite beside them):

| step | before | after |
|---|---|---|
| boot → Where it runs | 993 ms, 61 requests | 992 ms, 61 requests |
| Next → Project | 37 ms | 37 ms |
| Continue → AI | 14 ms | 14 ms |
| Create workspace → draft composer | 4345 ms (5378 / 4345 / 4318), 30 requests | 3917 ms (3917 / 3934 / 3911), 28 requests |

The finish of the median repetition, before: create 1–212, catalog and shared sessions 213–427, the start's first connection 428–692, the starting notice's catalog read at 673, a poll at 2693, the ready notice at 3878 with its catalog read (3878–4088) and the poll it cut short (3879–4103), the wake's refresh 4104–4316, the draft at 4345. After (3934 ms): create 1–212, the catalog read and the start's first connection together from 213–215, the ready notice at 3677 with its catalog read (3677–3890) and the last poll (3677–3904), the draft at 3934. The start leaves 213 ms earlier and the draft follows the last poll by 30 ms instead of 242; the sandbox's own start, from the first connection to the ready notice, is 3.45 s in both. The other scenarios of the same two runs, p50 before → after: cold root 799 → 798 ms, first session press 481 → 472, cold session 1668 → 1665, warm reload 588 → 569, open session 445 → 449, marketplace 354 → 349, settings 10 → 10, signed-out login 361 → 366, with the same requests and bytes.

## What the finish waits on now

From the press, on the rig: the create (one round), then the start's provisioning, then the start's last connection read, which mints the link and so is a real round after the ready notice; a notice carries no token.

The provisioning is the server's: the first `POST /connection` begins a provisioner run (`sandboxProvisionerClass`, `packages/claxedo-server/src/sandbox/provisioner.cf.ts`), which answers provisioning at once and drives the driver from its alarm, one step per `retryAfterMs`. In the rig the stack's driver is `cloudflare` pointed at the local sandbox emulator (`packages/harness/e2e/harness/hosted-sandbox-worker.ts`), whose `ensure-runtime` blocks while the local brokering driver spawns the workspace runtime as a node process under the TypeScript loader and polls its `/global/health` every 100 ms (`local-brokering.ts`), so the run is one step: 3.45 s from the start's first request to the ready notice in both runs, unchanged by this work. The client's polls do not add to it: the notice ends the wait at once (`workspace-start.ts`).

On staging the step loop is the same and the driver is the organization's key (Boat, Vercel, Modal or Cloudflare). A first start creates the sandbox, boots the runtime image and clones the repository; each driver answers provisioning with a 2 s retry until its host is up (`DEFAULT_PROVISION_INTERVAL_MS`, `boat.ts`; `vercel.ts`, `modal.ts`, `cloudflare.ts`), so the run settles up to 2 s after the host does, and the whole is the provider's sandbox start, seconds to tens of seconds. That is the floor this path keeps; the two client rounds removed here cost 0.4–1.3 s each from India on top of it, and the create's lookups about 0.4–0.6 s.
