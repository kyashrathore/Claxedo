# Provider model cards

Owner: this chat. Scope: Accounts Models provider-card presentation, expansion state, model browsing, localized footer copy and flow 15 acceptance. Unrelated plans and transcript work belong to other chats.

- [x] One card with header (provider, count, bulk action), body (search and shared model rows), footer (shown count and load-more action).
- [x] Keep expansion independent of model enablement; bulk actions preserve open and closed state.
- [x] Load ten more matching models, reset the preview when the search changes, and virtualize lists beyond 100 rows.
- [x] Implement desktop and phone acceptance, demonstrate red failures, and inspect settled light/dark captures.
- [x] Replace the production Models tab group rendering with `ProviderModelCard`; remove the old preview helper and group markup. The running dev app received the update through HMR. `bun run typecheck` passes after the final component naming cleanup.
- [ ] Clear repository check failures and complete the required repeat/CI and benchmark gates before merging.

Validation (2026-10-01):

- `bun run typecheck` and `bun run typecheck:e2e` in `packages/claxedo-app`: pass.
- `bun run test` in that package: 405 passed, zero failed. Log: `/tmp/claxedo-provider-card-tests.log`.
- `bun run check`: 18 of 19 steps passed; existing Composer (+66 lines) and Notifications (+52 lines) budgets remain. Log: `/tmp/claxedo-provider-card-check-final.log`. These domains are outside this slice.
- `bun run test:architecture-ratchets` at the root: 21 tests and all six product source policies passed. The file-size scanner still fails on three generated tracked Storybook assets. Log: `/tmp/claxedo-provider-card-ratchets-final.log`.
- `bun run verify:closure` in `packages/claxedo-desktop`: production build, 14 packaged checks and all three emitted policies passed. Log: `/tmp/claxedo-provider-card-closure.log`. Renderer imports add exactly one module, `accounts/view/model-rows`, with no additional package edges.
- `CLAXEDO_E2E_DIST_DIR=/tmp/claxedo-provider-card-preview-dist CLAXEDO_E2E_PORT_RANGE=46961-46979 CLAXEDO_E2E_DAEMON_PORT=46961 bun run e2e --project=web --project=phone --grep '15 settings:.*provider' --output=/tmp/claxedo-provider-card-preview --reporter=list`: all three desktop flows and the first phone flow passed. A concurrent regression build reused this output directory, replacing assets while the phone test navigated and producing an Internal Server Error. Rerun phone checks with their own build directory; do not share build output across concurrent runs.
- Red proof: temporarily blocked bulk and footer button clicks at the browser entrypoint; all three desktop assertions failed as expected. The temporary interceptor was removed. Log: `/tmp/claxedo-provider-card-red.log`.
- `CLAXEDO_E2E_DIST_DIR=/tmp/claxedo-provider-card-isolated-dist CLAXEDO_E2E_PORT_RANGE=47001-47019 CLAXEDO_E2E_DAEMON_PORT=47001 bun run e2e --project=phone --grep '15 settings:.*provider' --output=/tmp/claxedo-provider-card-isolated-phone --reporter=list`: all three phone flows passed using an isolated build. Combined with the desktop run, all six new acceptance cases pass.
- Existing Models regressions: account management and composer visibility passed on desktop and phone; the request-count flow failed on both, reporting a duplicate `/api/claxedo/agent-config/providers?opencode` read. Provider query owners were not changed in this slice. This failure needs an independently verified baseline and ownership fix before merge. Log: `/tmp/claxedo-provider-card-regressions.log`.
- Initial preview screenshots captured before the theme applied. Captures now wait for the root `data-color-scheme` and for animations to settle. Inspected consistent dark and light page, card and search field backgrounds. Saved captures: `.artifacts/provider-model-cards/dark.png` and `light.png`.
- Twenty consecutive local runs, three CI repeats and the cross-build benchmark have not been run; no commit or merge is included in this provider-card slice.
- Collapsed-state preview: `CLAXEDO_E2E_DIST_DIR=/tmp/claxedo-provider-collapsed-dist CLAXEDO_E2E_PORT_RANGE=47021-47039 CLAXEDO_E2E_DAEMON_PORT=47021 bun run e2e --project=web --grep '15 settings: multiple provider' --output=/tmp/claxedo-provider-collapsed --reporter=list` passed (one case); `bun run typecheck:e2e` also passed. The added assertions verify that collapsing the first provider removes its search, model rows and footer while the adjacent provider remains expanded and enabled. Capture: `.artifacts/provider-model-cards/collapsed.png`.
