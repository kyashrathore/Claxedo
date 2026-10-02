# Draft worktree branch selection

Owner: this session. Scope: projects draft context, worktree adapter, local worktree creation, preservation of draft choices across failed submissions, and their tests. Other in-progress working-tree changes are outside this lane.

## Behavior

- Existing placements retain their checkout. Their disabled branch chip reads that placement's Git status and marks uncommitted changes only when present.
- Only a new workspace offers a base branch selection. Local worktrees start a generated branch at the selected reference's committed tip when created; source edits and checkout stay untouched.
- An invalid selected reference fails creation without substituting another base. Cloud creation retains its existing branch contract.
- Workspace choices clear a prior base choice. Git data stays in the shared query cache and uses existing event invalidation.
- Creation populates the worktree before returning it. The context row stays mounted but hidden during submission; failed creation retains its choices, and successful creation selects the returned placement for any session retry.

## Progress

- [x] Trace selectors, adapter, local Git producer, callers, and existing coverage.
- [x] Implement the selection and creation contracts.
- [x] Prove regression coverage through local routes and desktop/phone flows.
- [x] Run focused tests, typechecks, app checks, and architecture ratchets; record results and the unrelated repository-wide file-size blocker.

## Validation

All commands below ran from the named package unless marked root. Log redirection is omitted from the command column.

| Location | Command | Result |
| --- | --- | --- |
| `packages/claxedo-local-server` | `node ./node_modules/vitest/vitest.mjs run src/shell/worktree-create.test.ts` | Before the fix: 7 failures, 1 pass. Wrong base commit and invalid bases accepted. |
| `packages/claxedo-app` | `bun run e2e 02-worktree-branches --project=web` | Before the fix: both initial flows failed on the absent read-only current-branch state. |
| `packages/claxedo-app` | `bun run e2e 02-worktree-branches --grep 'missing base' --project=web` | Before the draft-lifetime fix: failed because the chosen destination reset to `main`. |
| `packages/claxedo-app` | `CLAXEDO_E2E_PORT_RANGE=46200-46299 CLAXEDO_E2E_DAEMON_PORT=46200 CLAXEDO_E2E_DIST_DIR=dist-e2e-worktree-session bun run e2e 02-worktree-branches --grep 'refused session' --project=web --output=/tmp/claxedo-worktree-refusal-results --reporter=line` | Before preserving the created placement: failed because session refusal reset the destination to `main`. |
| `packages/claxedo-local-server` | `node ./node_modules/vitest/vitest.mjs run src/shell/worktree-create.test.ts -t 'populated worktree'` | Before removing deferred checkout: failed with ENOENT when reading the selected branch's file immediately after the create response. |
| `packages/claxedo-local-server` | `node ./node_modules/vitest/vitest.mjs run src/shell/worktree-create.test.ts src/shell/git.test.ts` | 28 passed. Covers selected commit, populated files before response, dirty/staged/untracked source preservation, a dirty branch checked out by another session, invalid bases, recovery, and existing worktree access checks. |
| `packages/claxedo-server` | `node ./node_modules/vitest/vitest.mjs run src/workspace/worktree-events.test.ts` | 2 passed; the canonical ready event and returned directory remain consistent. |
| `packages/claxedo-app` | `bun run test` | 483 passed. |
| `packages/claxedo-app` | `bun run typecheck` | Passed. |
| `packages/claxedo-app` | `bun run typecheck:e2e` | Passed. |
| `packages/claxedo-local-server` | `bun run typecheck` | Passed. |
| `packages/claxedo-app` | `bun run check` | All 20 checks passed. Its protected-area advisory names another in-progress change to `src/transcript/message-nav.css`; this lane changes no transcript or timeline implementation. |
| `packages/claxedo-app` | `bun run e2e 02-worktree-branches 02-projects-local --grep 'worktree\|missing base' --project=web --project=phone` | 8 passed, including the existing create-worktree flow and retry after a missing branch. |
| `packages/claxedo-app` | `bun run e2e 02-worktree-branches --project=web --project=phone --repeat-each=20` | Initial run: 84 passed; the remaining 36 failed in fixture setup because another process took port 46100. Replaced by dedicated-port runs below. |
| `packages/claxedo-app` | `CLAXEDO_E2E_PORT_RANGE=46200-46299 CLAXEDO_E2E_DAEMON_PORT=46200 CLAXEDO_E2E_DIST_DIR=dist-e2e-worktree-session bun run e2e 02-worktree-branches --project=web --repeat-each=20 --output=/tmp/claxedo-worktree-web-results --reporter=line` | 80 passed: all four flows passed 20 consecutive runs on desktop. |
| `packages/claxedo-app` | `CLAXEDO_E2E_PORT_RANGE=46300-46399 CLAXEDO_E2E_DAEMON_PORT=46300 CLAXEDO_E2E_DIST_DIR=dist-e2e-worktree-phone bun run e2e 02-worktree-branches --project=phone --repeat-each=20 --output=/tmp/claxedo-worktree-phone-results --reporter=line` | 80 passed: all four flows passed 20 consecutive runs on phone. |
| `packages/claxedo-app` | `CLAXEDO_E2E_PORT_RANGE=46200-46299 CLAXEDO_E2E_DAEMON_PORT=46200 CLAXEDO_E2E_DIST_DIR=dist-e2e-worktree-session bun run e2e 03-send-a-turn --grep 'first send' --project=web --project=phone --output=/tmp/claxedo-worktree-session-results --reporter=line` | 6 passed: first-send creation, the pending-message layout, and refused-request recovery on web and phone. |
| `packages/claxedo-app` | `CLAXEDO_E2E_PORT_RANGE=46200-46299 CLAXEDO_E2E_DAEMON_PORT=46200 CLAXEDO_E2E_DIST_DIR=dist-e2e-worktree-session bun run e2e 02-worktree-branches 03-send-a-turn --grep 'refused session\|missing base\|first send' --project=web --project=phone --output=/tmp/claxedo-worktree-recovery-results --reporter=line` | 12 passed after retaining the hidden context row and selecting the created placement. |
| `packages/claxedo-desktop` | `bun run verify:closure` | Passed: production build, 13 packaged-resource tests, and all three emitted dependency manifests. |
| Root | `bun run test:architecture-ratchets` | 26 tests, all product source closures, and helpers passed. File-size stage reports the unchanged tracked generated `packages/workspace-relay/bench/reports/dialin-agent.bundle.cjs` (4656 versus 800). Its source and ceiling were not changed. |
| Root | `git diff --check` | Passed. |

The renderer's one additional module is `projects/draft-branches.ts`, reached through `renderer/main.tsx → app.tsx → projects/index.ts → draft-context.ts`. It owns the existing placement's Git status and the new workspace's base choice, reusing the existing query cache and packages. After full desktop closure verification, its measured module ceiling is 1265 with no headroom; the package ceiling remains 36.

Unverified release checks: CI's three repeated runs and a before/after agent-app-benchmark comparison were not run in this session. The workspace-relay benchmark owner must resolve the tracked generated bundle's file-size finding before the repository-wide ratchet can pass; re-run the root ratchet afterward. A separate session-core file-size finding changed during other in-progress work and no longer appears in the latest root run.
