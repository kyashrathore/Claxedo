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
- After a start the wake driver (`driveWake`, `src/server/workspace-wakes.ts`) refreshes the catalog that the `cloudWorkspaceChanged` event re-read about 230 ms earlier, one round on the finish's path. Skipping it when the event has settled the wake changes the wake every session open and turn start goes through, so it is left to the lanes that own those flows.
- The create's refresh and the start's connection run in series because `cloud.create` answers only once the catalog lists the workspace; starting the connection from the `onCreated` hold would need the wake driver to wait on the catalog re-read in flight. One round.
- On staging, `POST /api/workspace/create` resolves the repository host over DNS-over-HTTPS and asks GitHub whether a pasted repository is public before it writes the row (`packages/claxedo-server/src/routes/hosted/workspace.ts`); the local stack's create answers in 210 ms, so whatever those lookups cost on staging is not in these numbers, and removing them is a server change.
