/**
 * SPEC: Settings dialog, account/auth, providers/connections/sandbox, and the
 * signed-auth system routes (`/login`, `/cli-login`, the signed gate, the
 * top-level error page)
 *
 * PURPOSE — the app's cross-cutting configuration surface (`DialogSettings`,
 * `src/components/dialog-settings.tsx`) plus everything that decides whether a
 * visitor even gets past the front door (`src/shell/auth/*`, `src/app.tsx`'s
 * `CloudAuthGate`, `src/pages/login.tsx`, `src/pages/cli-login.tsx`,
 * `src/pages/error.tsx`). Settings lets a user manage appearance, shortcuts,
 * providers, external-tool connections, and (when enabled) sandbox
 * credentials/network policy without leaving the workbench. The auth surfaces
 * let a hosted deployment require sign-in while a local/loopback session
 * never does, and let the CLI piggy-back a browser session to mint its own
 * token.
 *
 * STATE MODEL —
 *   Dialog: `DialogSettings` owns two local signals — `active` (which tab,
 *     default `"general"`) and `mobile` (menu vs content mode below 640px,
 *     see ANATOMY). Neither survives dialog close; reopening always starts on
 *     General/menu-mode. The dialog itself lives in the app-wide `DialogProvider`
 *     stack (`useDialog().show()`), opened from the rail sidebar's gear
 *     `IconButton` (`aria-label` = `language.t("sidebar.settings")` = "Settings",
 *     `src/claxedo-ui/layouts/rail-sidebar.tsx`).
 *   Sandbox tab: NOT gated by anything. `src/app/dialogs/settings.tsx` renders
 *     the `value="compute"` `Tabs.Trigger` (:159) and its matching
 *     `Tabs.Content` (:214) unconditionally — there is no
 *     `<Show when={sandboxEnabled()}>` wrapper and no `sandboxEnabled`
 *     reference anywhere in that file at all (`grep -c sandboxEnabled
 *     src/app/dialogs/settings.tsx` ⇒ 0). The former `VITE_SANDBOX_ENABLED`
 *     gate was deleted (owner decision — see the comment at
 *     `src/app/entry/index.tsx:94`), so the tab is ALWAYS present and there is
 *     no flag-off branch left to cover. (An earlier revision of this header
 *     described a `<Show when={sandboxEnabled()}>` gate and called its false
 *     branch "permanently untestable"; that was wrong on both counts and is
 *     corrected here. The `VITE_SANDBOX_ENABLED=true` line still sitting in
 *     `.env.local` is dead config — nothing reads it.)
 *   Principal/auth: `PrincipalProvider` (`src/shell/auth/principal-provider.tsx`)
 *     derives a `Principal` (`"anonymous" | "local" | "signed" | "org-member"`)
 *     from `useAuthSession()` + the `authEnabled` prop. `authEnabled` is
 *     `import.meta.env.VITE_AUTH_ENABLED === "true"` (`src/index.tsx`), also
 *     baked at Vite-start and `true` in this harness — so `principal.kind` is
 *     NEVER `"local"` here (that branch requires `authEnabled === false`); it
 *     is `"signed"`/`"org-member"` when `auth.status() === "signed"`, else
 *     `"anonymous"`. `useAuthSession()` wraps `src/utils/auth-client.ts`'s
 *     `useAuth()`, whose `isSignedIn()` is true whenever a Clerk session, a
 *     Clerk user, OR the test-auth bypass (`testAuth()`) is present. The test
 *     bypass auto-activates whenever `navigator.webdriver === true` (true for
 *     every Playwright session) UNLESS `window.__CLAXEDO_DISABLE_TEST_AUTH_BYPASS__`
 *     is set — so by default every spec in this suite is "signed in" as a
 *     synthetic `test-user`; specs that need `"anonymous"` must opt out via
 *     that flag before the app's first script runs (`addInitScript`).
 *     Capability policy (`src/shell/auth/role.tsx`): `PrincipalPolicy.anonymous`
 *     and `.signed`/`.org-member` all grant `"view.account"`; only `.local`
 *     (empty set) denies it — meaning `Can do="view.account"` around
 *     `AccountSettingsSection` is unconditionally true in this harness.
 *   Sign-out: `auth.signOut()` clears Clerk state + `clearPersistedAuthState()`
 *     (every `opencode.*` / projection-cache localStorage key, preserving the
 *     dedicated `opencode.auth.lastUserId` key), then the caller navigates to
 *     `/login` with `{replace: true}`.
 *   Settings persistence: appearance/notifications/keybinds/sounds live in
 *     `useSettings()` (`src/context/settings.tsx`, localStorage-backed,
 *     survives reload — not re-verified here, owned by that context's own
 *     tests). Theme id + color scheme persist via `@opencode-ai/ui`'s theme
 *     context to dedicated localStorage keys and are applied by writing
 *     `document.documentElement.dataset.theme` / `.colorScheme` synchronously.
 *     `previewTheme`/`previewColorScheme` write the SAME dataset attributes
 *     without persisting; `cancelPreview` reverts them to the committed values.
 *   Providers: connected/popular lists come from `GET /provider` (SDK-shaped,
 *     `providerList.all` + `.connected`), `GET /provider/auth` (per-provider
 *     auth method catalog, empty ⇒ API-key-only fallback). Connect writes go
 *     through `PUT /api/claxedo/credentials` (`claxedoCredentialRequest`, see
 *     `src/utils/credential-request.ts`) for API-key and OAuth-callback via the
 *     SDK `provider.oauth.*` routes; disconnect issues `DELETE
 *     /api/claxedo/credentials/provider/:id` and (for the synthetic
 *     `opencode-go`-style non-key rows) a `disabled_providers` `PATCH /config`.
 *     Custom providers additionally write `provider.<id>` into global config.
 *   Connections: `createConnectionsStore`/`createConnectFlow`
 *     (`src/components/settings-connections-core.ts`) own a small state
 *     machine (`"form" | "submitting" | "confirm-replace" | "oauth-waiting" |
 *     "done"`) over `/api/claxedo/integrations*`. The pasted secret and form
 *     fields live ONLY in this in-memory store; `reset()` (called on the
 *     connect dialog's `onCleanup`, i.e. every close) wipes them and bumps a
 *     `generation` counter that stops any in-flight OAuth poll loop from
 *     acting on stale state.
 *   Sandbox: `SandboxSettingsSection` loads `GET /api/workspace/drivers`
 *     (default provider id + per-provider field/configured metadata) against
 *     `getDefaultBaseUrl()` (reads `window.__OPENCODE__.serverUrl` when set,
 *     else env/origin fallbacks). `shouldUseSandboxDriverMutations` gates every
 *     mutation control on `centralTransportForServer(baseUrl) === "loopback"`;
 *     non-loopback hosts render the same data read-only.
 *   Auth routes: `/login` and `/cli-login` are plain SPA routes (`src/app.tsx`
 *     `<Route path="/login">`/`<Route path="/cli-login">`), not gated
 *     themselves — `CloudAuthGate` (in `AuthenticatedProviders`, wraps
 *     everything BELOW it) computes `needsSignedAuth = authEnabled &&
 *     centralTransportForServer(server.url) !== "loopback"` and redirects to
 *     `/login` only while `needsSignedAuth() && session.status() ===
 *     "anonymous"`. `server.url` here is `ServerProvider`'s resolved default,
 *     which on the web platform ultimately traces back to
 *     `getClaxedoServerUrl()` — hardcoded to the build-time
 *     `VITE_CLAXEDO_SERVER_URL` env var (`http://127.0.0.1:3001` in this repo),
 *     which is ALWAYS a loopback host, so `needsSignedAuth()` is always false
 *     in this harness regardless of principal (see HARNESS NOTES).
 *
 * ANATOMY —
 *   `[data-testid="rail-account-trigger"]` → "Settings" menu item — opens the dialog.
 *   `[data-slot="dialog-container"]` — the settings dialog's root once open.
 *   `[role="tab"][data-value="general"|"shortcuts"|"terminals"|"providers"|
 *     "models"|"connections"|"compute"]` — tab triggers (`aria-selected`
 *     reflects the active tab); `"compute"` (Sandbox) only exists when
 *     `sandboxEnabled`. `[data-slot="tabs-content"]` panels are one-per-tab.
 *   `.settings-mobile-menu` / `.settings-mobile-content` (on the `Tabs` root,
 *     only meaningful under a 639px max-width media query) — menu mode hides
 *     `[data-slot="tabs-content"]`, content mode hides `[data-slot="tabs-
 *     list"]` and shows `.settings-mobile-back` (click → menu mode).
 *   General tab: `[data-action="settings-color-scheme"]` /
 *     `[data-action="settings-theme"]` wrap a `Select`
 *     (`[data-slot="select-select-trigger"]` to open,
 *     `[data-slot="select-select-item"]` options, rendered in a portal);
 *     `[data-action="settings-notifications-agent"|"-permissions"|"-errors"]`
 *     wrap `Switch` (`input[type=checkbox]`); `[data-action="settings-updates-
 *     startup"]` wraps the startup-check switch; the "Check now" button has no
 *     stable testid, select it by its visible text ("Check now"/"Checking...").
 *     Account section (`Can do="view.account"`): header text "Account", a
 *     "Log out" row whose button text is "Log out".
 *   Shortcuts tab: search `TextField` (placeholder "Search shortcuts"),
 *     `data-keybind-id="<command id>"` buttons (text = current binding or
 *     "Unassigned"; "Press keys" while capturing), "Reset to defaults" button
 *     (disabled until an override exists).
 *   Providers tab: `[data-component="connected-providers-section"]` and
 *     `[data-component="custom-provider-section"]` scope rows;
 *     provider rows have no testid, select by the provider's visible name text.
 *   Connections tab: `[data-component="connections-section"]`; no per-row
 *     testid, select by integration/connection name + button text ("Connect",
 *     "Add connection", "Re-verify", "Reconnect", "Disconnect", "Disconnect?",
 *     "Confirm", "Cancel"). `DialogConnectIntegration` fields are plain
 *     `TextField`s selected by `label`; `role="radiogroup"[aria-label=
 *     "Connection scope"]` when `personalScopeEnabled`.
 *   Sandbox tab: `Select` (default provider) via
 *     `[data-slot="select-select-trigger"]`; per-provider rows are plain
 *     `input[type=text|password]` inside an expanded row, "Configure"/
 *     "Update"/"Collapse"/"Remove"/"Save" buttons by text; the read-only
 *     notice text is "Signed hosted sessions can view local sandbox providers
 *     but cannot change local credentials."
 *   `/login`: "Continue" button (disabled + "Redirecting..." while signing
 *     in); a "Terms of Service" link always renders.
 *   `/cli-login`: header text "Claxedo CLI", a single `<p>` status message
 *     that cycles through "Preparing CLI sign-in...", "Opening Claxedo
 *     sign-in...", "Approving CLI sign-in...", or an error message; a spinner
 *     renders whenever `status() !== "error"`.
 *   Error page (`src/pages/error.tsx`, top-level `ErrorBoundary` fallback in
 *     `AppBaseProviders`): title "Something went wrong", a read-only
 *     `TextField` with the formatted error chain, "Restart" button, and (only
 *     when `platform.checkUpdate` exists — never true on web, see HARNESS
 *     NOTES) a "Check for updates" button.
 *
 * BEHAVIORS —
 *   1. Opening Settings renders the General tab active by default; switching
 *      tabs updates `aria-selected` and shows exactly one non-hidden
 *      `[data-slot="tabs-content"]` panel at a time.
 *   2. The Sandbox tab (trigger + content) renders unconditionally — no config
 *      value, env flag, or `<Show>` gates it (see STATE MODEL) — and its
 *      content mounts the real `SandboxSettingsSection`.
 *   3. Under a <640px viewport the dialog boots in menu mode (full-width tab
 *      list, content hidden); selecting a tab flips to content mode (list
 *      hidden, back row + content shown); the back row returns to menu mode.
 *   4. The Account section (`Can do="view.account"`) renders for every
 *      principal kind reachable in this harness (`signed`/`org-member` via
 *      the default test-auth bypass, and `anonymous` with the bypass
 *      disabled) — the identity sub-row (email/name) only appears when a
 *      user object exists; the `local`-kind-hides-it branch requires
 *      `authEnabled=false`, unreachable here (see HARNESS NOTES).
 *   5. Clicking "Log out" calls `signOut()` and navigates to `/login`
 *      (`replace: true`).
 *   6. Hovering a `colorScheme` option live-previews
 *      `document.documentElement.dataset.colorScheme`; moving off without
 *      selecting reverts it to the committed value; selecting an option
 *      commits it.
 *   7. Notification switches (agent/permissions/errors) toggle
 *      `useSettings().notifications.*` and reflect `checked` state. The
 *      settings write is observed through the store's OWN persistence
 *      (`persisted("settings.v3", ...)`, `src/platform/settings/provider.tsx`
 *      → the `settings.v3` localStorage key), not just the checkbox's own
 *      `checked` property — an uncontrolled input flips `checked` on its own
 *      even with the store write completely broken.
 *   8. "Check for updates" / "Check for updates on startup" are disabled
 *      whenever `platform.checkUpdate` is undefined — always true on the web
 *      platform this harness runs (see HARNESS NOTES); the toast-action
 *      contract itself is desktop-only and out of e2e reach here.
 *   9. Shortcuts search filters the grouped command list; a query with zero
 *      matches shows the "No shortcuts found" empty state.
 *   10. Clicking a shortcut's key control enters capture mode ("Press keys");
 *       the next keydown becomes its new binding — asserted as the actual
 *       formatted label of the combination that was pressed
 *       (`formatKeybind`/`displayKeybindParts`, `src/app/providers/
 *       command-palette.tsx:188-243`: non-mac ⇒ `"Alt+Shift+K"`), not merely
 *       "no longer capturing", which an app that silently restored the
 *       ORIGINAL binding would satisfy too.
 *   11. Recording a combination already bound elsewhere shows a "Shortcut
 *       already in use" toast and leaves BOTH bindings unchanged — the
 *       would-be thief's row AND the row that already owned the combination
 *       are each re-read and compared to their pre-attempt labels.
 *   12. "Reset to defaults" is disabled with zero overrides, becomes enabled
 *       after one, and clicking it clears all overrides + shows a "Shortcuts
 *       reset" toast + disables itself again.
 *   13. Providers → Popular lists not-yet-connected `popularProviders`;
 *       "Connect" opens `DialogConnectProvider`; with no `/provider/auth`
 *       entry it falls back to a single API-key method and renders the key
 *       form directly; submitting PUTs `/api/claxedo/credentials` and on
 *       success marks the provider connected, closes the dialog, and toasts.
 *   14. Providers → Connected shows a source `Tag` per provider; a
 *       `source: "env"` row has no Disconnect button and shows the
 *       environment-locked description ("Connected from your environment
 *       variables", `settings.providers.connected.environmentDescription`)
 *       instead; any other source's Disconnect DELETEs
 *       `/api/claxedo/credentials/provider/:id`. The env row's
 *       zero-Disconnect assertion is paired with a positive precondition that
 *       the row locator resolved to exactly ONE element — a selector that
 *       matched nothing would otherwise satisfy the zero-count claim.
 *   15. "Custom provider" → submitting with an empty Provider ID shows an
 *       inline required-field error and sends zero credential/config
 *       requests.
 *   16. Connections lists integrations with a status chip
 *       (Connected/Degraded/Broken); Degraded rows additionally show
 *       "Re-verify"; Degraded/Broken rows show "Reconnect".
 *   17. "Connect"/"Add connection" opens `DialogConnectIntegration`; for a
 *       key-method integration, submitting the secret POSTs
 *       `/:integrationId/connect`; success closes + reloads the list; a
 *       `409 connection_exists` response switches to a confirm-replace step
 *       instead of erroring.
 *   18. For an OAuth-only integration, "Continue with OAuth" POSTs
 *       `method: "oauth"`, opens the returned URL (the spec's `window.open`
 *       stub RECORDS its argument, so "opens the URL" is asserted as the exact
 *       URL the server returned, not merely as "did not crash"), and polls
 *       `GET /attempts/:id` until `status: "complete"` (success).
 *   19. Closing the connect dialog tears the connect flow down
 *       (`onCleanup(() => flow.reset())`, `src/app/dialogs/
 *       connect-integration.tsx:46`).
 *       HONEST SCOPE — what a black-box spec can and cannot prove here:
 *         - NOT PROVABLE from a spec: "the pasted secret is cleared from
 *           memory". `createConnectFlow` is called INSIDE the component body
 *           (same file, :28), so its `createStore` is per-INSTANCE. Closing
 *           disposes the component and the store dies with it; reopening
 *           mounts a brand-new instance with a brand-new empty store. A
 *           "reopen and assert the field is empty" test therefore passes
 *           IDENTICALLY with line 46 deleted — it observes component disposal,
 *           not `reset()`. There is no in-app surface that exposes a disposed
 *           store's contents, so this half is asserted only as far as it is
 *           observable (below) and is deliberately NOT claimed in the test
 *           title.
 *         - PROVABLE and asserted: (a) the reopened form's secret input's
 *           `value` PROPERTY is empty (`toHaveValue`, not a rendered-text
 *           query — `getByText` matches text nodes and structurally cannot
 *           observe a secret sitting in an `<input>`), and no input ANYWHERE
 *           in the document holds the pasted value; (b) closing without
 *           submitting sent zero `/connect` requests, so the secret never left
 *           the browser; (c) the OTHER half of `reset()` — the `generation++`
 *           that cancels in-flight OAuth polling — IS externally observable
 *           and IS discriminating: `pollAttempt`'s loop
 *           (`src/features/settings/ui/connections-logic.ts:305-336`) is a
 *           plain async loop that nothing else cancels, so with line 46
 *           deleted it would keep hitting `GET /attempts/:id` forever after
 *           the dialog is gone. That is pinned by its own test.
 *   20. Disconnect is a two-step inline confirm ("Disconnect" → "Disconnect?"
 *       + Confirm/Cancel); Confirm DELETEs `/connections/:id` and toasts;
 *       Cancel reverts with zero request sent.
 *   21. Sandbox → the Provider dropdown picks ONE provider; when the picked
 *       one already has credentials but is not the active one, "Use for new
 *       workspaces" PUTs `/api/workspace/drivers/default` and then retires
 *       itself (the picked provider is now active).
 *   22. Sandbox → Credentials: the picked provider's field form is always
 *       open (no Configure/Update toggle); Save PUTs
 *       `/api/workspace/drivers/:id/auth` with `default: true` so configuring
 *       a provider also selects it; "Remove" DELETEs the same URL; both
 *       refresh the list and toast.
 *   23. Sandbox mutation controls are all disabled and a read-only notice
 *       renders whenever the resolved base URL is not a loopback host.
 *   24. Network Policy inside the (workspace-less) Sandbox tab always allows
 *       writes (`canWritePolicy()` unconditionally true without a
 *       `workspaceId`) — the admin/owner role gate belongs to a
 *       workspace-scoped host of the same component, not this surface.
 *   25. `/login`: already-signed visitors are redirected via `onMount`
 *       (`replace: true`) before the Continue button ever renders — the
 *       "before it ever renders" half is a real no-FLASH claim, so it is
 *       pinned by a `MutationObserver` installed before the app's first script
 *       that latches if a "Continue" button is ever added to the document, not
 *       by an after-the-fact `toHaveCount(0)` (which any post-redirect page
 *       satisfies trivially). Not-signed visitors see "Continue", which calls
 *       `auth.signIn({redirectUrl})` — recorded by the `__claxedoSignInCalls`
 *       seam (`src/platform/auth/auth-client.ts:337`).
 *   26. `/cli-login`: a missing/invalid `callback` or `state`, or a
 *       non-`http://127.0.0.1|localhost` callback origin, is rejected
 *       immediately with "Invalid CLI sign-in callback." AND zero auth calls —
 *       the zero-call half is asserted against `__claxedoSignInCalls`, the
 *       same seam behavior 25 uses positively (that positive use is this
 *       file's proof the seam is live, so these zeroes are not vacuous).
 *   27. `/cli-login` when not signed calls `auth.signIn({redirectUrl: current
 *       URL})` and shows "Opening Claxedo sign-in..." — both the call AND its
 *       `redirectUrl` argument are asserted (`src/app/routes/cli-login.tsx:27`
 *       passes `window.location.href`, so the recorded argument must carry the
 *       `/cli-login` path plus the original `callback`/`state` query, not the
 *       bare origin that `signIn`'s own default would substitute).
 *   28. `/cli-login` when signed with valid params exchanges the browser
 *       token for a CLI token (`POST /api/auth/cli/exchange`) and auto-submits
 *       a hidden form POST to `callback` carrying `state`/`access_token`/
 *       `identity`.
 *   29. `/cli-login` exchange failure surfaces the server's error message and
 *       status flips to "error"; no form is ever submitted.
 *   30. The signed gate never redirects a loopback-transport session to
 *       `/login`, regardless of principal — verified by loading a session
 *       route as an anonymous principal and asserting the workbench paints
 *       with no redirect. The inverse (anonymous + non-loopback ⇒ forced
 *       redirect with a loading placeholder, no protected-content flash) is
 *       environment-fixed to loopback in this harness and cannot be flipped
 *       from a spec (see HARNESS NOTES).
 *   31. The top-level `ErrorPage` renders Restart always and Check-for-updates
 *       only when `platform.checkUpdate` exists (never on web) — not
 *       independently e2e-reachable here (no crash-injection harness route
 *       exists, unlike `/__e2e/dialog-matrix`; see HARNESS NOTES).
 *   32. Browser Notification permission is requested from the "Agent"/"Errors"
 *       notification toggles' own `onChange` — a real user gesture — and
 *       nowhere else: turning a toggle ON calls
 *       `requestNotificationPermission()` (`src/utils/notification-permission.ts`)
 *       at most once (a no-op once permission is no longer "default"); turn
 *       completion (`platform.notify`, `src/main.tsx`) NEVER calls
 *       `Notification.requestPermission()` itself — it only reads the current
 *       `Notification.permission` and silently no-ops unless it is already
 *       "granted". With the Agent toggle off, a completed turn issues zero
 *       permission requests; with it on, exactly one request total survives
 *       any number of completed turns (regression pin for the "notification
 *       prompt reappears every turn" bug).
 *       FALSE-POSITIVE GUARD — `platform.notify` has a SECOND early return
 *       (`src/app/entry/main.tsx:69`: `document.visibilityState === "visible"
 *       && document.hasFocus()`) that is unconditionally true for a lone
 *       Playwright page, so by default its body never executes and
 *       "requested zero permissions" would be indistinguishable from "the code
 *       never ran". The spec therefore forces `document.hasFocus()` false
 *       before the app boots and asserts a POSITIVE control — the count of
 *       constructed `Notification` instances — so the zero/one request
 *       assertions are made against a notify path that demonstrably executed.
 *
 * INVARIANTS — completed-turn oracle invariants (INVARIANTS.md #1-#4) apply
 *   only to the one scenario in this spec that drives a turn (behavior 32);
 *   every other scenario here neither sends a prompt nor renders an assistant
 *   turn, and that scenario itself asserts on the submit control's busy/ready
 *   `data-icon` state (INVARIANTS.md cross-cutting invariant #4) rather than
 *   the reply-content oracle, since it pins notification-permission plumbing,
 *   not reply rendering. The invariant this spec DOES pin beyond that:
 *   a settings mutation's optimistic UI state (Save-button visibility,
 *   expanded-row state, confirm-step) never survives a failed request as if
 *   it had succeeded — every save/connect/disconnect path is proven via both
 *   the resulting network request AND the resulting DOM state, never one
 *   alone.
 *
 * HARNESS NOTES — several gates in this feature are controlled by
 *   `import.meta.env.VITE_*` flags baked into the bundle when the shared dev
 *   server started, not flippable at runtime by an individual spec:
 *     - `VITE_AUTH_ENABLED=true` is set in `.env.local`, so `authEnabled=false`
 *       (⇒ `principal.kind==="local"`) is permanently untestable here.
 *       (`VITE_SANDBOX_ENABLED=true` is also set, but it is DEAD config — no
 *       source file reads it any more and the Sandbox tab is ungated, so there
 *       is nothing untestable about it. See STATE MODEL.)
 *     - `VITE_CLAXEDO_SERVER_URL=http://127.0.0.1:3001` makes
 *       `getClaxedoServerUrl()` (used by `ServerProvider`'s default server,
 *       hence `CloudAuthGate`'s `server.url`) always resolve to a loopback
 *       host, so the anonymous-forced-`/login` half of the signed gate is
 *       permanently untestable here — the pre-existing
 *       `e2e-legacy/login-roundtrip.spec.ts` hit the same wall for a
 *       different reason (authEnabled baked false at the time). The signed
 *       authentication lane owns that negative contract.
 *     - `platform.checkUpdate` is only implemented by the desktop platform
 *       object; the web platform built in `src/main.tsx` never defines it, so
 *       every update-check affordance is permanently disabled here (behavior
 *       8) and the error page's update button never renders (behavior 31).
 *     - `getDefaultBaseUrl()` (unlike `getClaxedoServerUrl()`) DOES read
 *       `window.__OPENCODE__.serverUrl` when present, so the Sandbox tab's
 *       loopback/non-loopback mutation gate (behavior 23) CAN be flipped at
 *       runtime by overriding that property before the app boots, without
 *       touching `CloudAuthGate`'s unrelated resolution path.
 *     - There is no `/__e2e/error-page` (or similar) crash-injection harness
 *       route analogous to `/__e2e/dialog-matrix`
 *       (`src/e2e/dialog-matrix-harness.tsx`), so the top-level
 *       `ErrorBoundary` fallback cannot be reached deterministically from a
 *       spec; see the finding filed alongside this spec recommending one.
 *     - `isSignedIn()` (`src/utils/auth-client.ts:295`) ORs in
 *       `testAuth().__CLAXEDO_TEST_AUTH_USER__`, which is a pure function of
 *       `navigator.webdriver` — always `true` under Playwright — so the
 *       default-bypass principal is signed-in on EVERY render including the
 *       one right after sign-out, making a full log-out-and-stay-on-/login
 *       round trip permanently unreachable without disabling the bypass
 *       first, which itself removes the "Log out" affordance being tested.
 *       Compounding this,
 *       `initializeClerk()`'s bypass branch
 *       (`src/utils/auth-client.ts:164-173`) never assigns the module-level
 *       `clerkLoadPromise`, so `signOut()`
 *       (`src/utils/auth-client.ts:307-315`) hits its `if
 *       (!clerkLoadPromise) return` guard and never purges session/persisted
 *       state under the bypass — a real, separate app bug, filed as a
 *       finding rather than patched here.
 *
 * OUT OF SCOPE — Models tab content and the model-visibility toggle
 *   (`core-model-effort-agent-controls`); Terminals tab (not in this spec's
 *   assignment); harness/model/agent selection anywhere in the composer
 *   (`core-harness-ownership-local`, `core-model-effort-agent-controls`);
 *   marketplace/extensions install surfaces (`live-agent-extensions-
 *   materialization`); live Clerk/Convex auth end-to-end
 *   (`live-user-hosted-*`); appearance
 *   font-field persistence and sound-effect playback wiring (owned by
 *   `src/context/settings.tsx`'s own tests, not a DOM contract this spec
 *   pins).
 */
import { expect, test, type Page } from "@playwright/test"
import { installMockRuntime, providerCatalogIndex } from "../helpers/mock-runtime"

const DIR = "/tmp/e2e-core-settings-auth"
const SESSION_ID = "ses_core_settings_auth"

function slug(value: string) {
  return Buffer.from(value, "utf-8").toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=/g, "")
}

function corsHeaders() {
  return {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "authorization,content-type,accept",
    "Access-Control-Allow-Methods": "GET,POST,PUT,PATCH,DELETE,OPTIONS",
  }
}

async function json(route: import("@playwright/test").Route, body: unknown, status = 200) {
  await route.fulfill({
    status,
    contentType: "application/json",
    headers: corsHeaders(),
    body: JSON.stringify(body),
  })
}

/**
 * Every custom route this spec registers (credentials, integrations, sandbox
 * providers, network policy, cli/exchange) targets `getClaxedoServerUrl()`
 * (credentials/integrations/cli-exchange) or a deliberately-forced
 * `window.__OPENCODE__.serverUrl` (the sandbox read-only-lock scenario) — both
 * genuinely cross-origin relative to the Playwright test page, through
 * `authFetch`/`api.*`, which always attach `Authorization`/`Content-Type`
 * headers. A real browser performs a real CORS preflight (`OPTIONS`) against
 * those before the actual request, even though the response is mocked — an
 * unhandled preflight (e.g. falling through to a catch-all 404) fails the
 * real GET/PUT/DELETE that follows. Wrap every custom handler so `OPTIONS`
 * short-circuits with a 2xx + CORS headers.
 */
function withCors(handler: (route: import("@playwright/test").Route) => Promise<void> | void) {
  return async (route: import("@playwright/test").Route) => {
    if (route.request().method() === "OPTIONS") {
      await route.fulfill({ status: 204, headers: corsHeaders() })
      return
    }
    await handler(route)
  }
}

/** Seeds one registered local project, optionally forcing a specific `__OPENCODE__.serverUrl`. */
async function seedProject(page: Page, dir: string, opts?: { serverUrl?: string }) {
  await page.addInitScript(
    ({ d, serverUrl }: { d: string; serverUrl?: string }) => {
      localStorage.clear()
      ;(window as typeof window & { __OPENCODE__?: { serverUrl?: string; activeDirectory?: string } }).__OPENCODE__ = {
        serverUrl: serverUrl ?? window.location.origin,
        activeDirectory: d,
      }
      localStorage.setItem(
        "opencode.global.dat:server",
        JSON.stringify({
          list: [],
          projects: { local: [{ worktree: d, expanded: true }] },
          lastProject: {},
          workspaceServer: {},
          closedProjects: {},
        }),
      )
    },
    { d: dir, serverUrl: opts?.serverUrl },
  )
}

/** Opts the page out of the Playwright webdriver auto sign-in bypass (see SPEC STATE MODEL). */
async function disableTestAuthBypass(page: Page) {
  await page.addInitScript(() => {
    ;(window as typeof window & { __CLAXEDO_DISABLE_TEST_AUTH_BYPASS__?: boolean }).__CLAXEDO_DISABLE_TEST_AUTH_BYPASS__ = true
  })
  // `initializeClerk()` runs at app boot whenever authEnabled is true (always,
  // in this harness — see SPEC STATE MODEL) and only short-circuits via the
  // test-auth bypass; with the bypass disabled it falls through to loading the
  // REAL @clerk/clerk-js SDK against clerk.accounts.dev. Tier M must never make
  // a real network call (INVARIANTS.md authoring rule #6), so intercept it.
  // NOT the shared `corsHeaders()` helper here: Clerk's SDK issues these
  // fetches with `credentials: "include"`, and the CORS spec forbids a
  // literal `Access-Control-Allow-Origin: "*"` wildcard when credentials are
  // included — the browser silently fails the request client-side (verified
  // live: `ERR_FAILED` + a CORS console error on every retry) even though
  // this route fulfills it, leaving `initializeClerk()`'s promise never
  // resolved and the app boot permanently stuck behind the loading splash
  // (`[data-claxedo]` never appears). Echo the request's actual Origin and
  // add `Access-Control-Allow-Credentials` instead.
  await page.route("**clerk.accounts.dev**", async (route) => {
    // A small real delay (NOT a test-side `waitForTimeout` — this delays the
    // MOCK RESPONSE itself, the same technique `mock-runtime.ts` uses for its
    // busy→completed→idle staggering, INVARIANTS.md's "never instant" rule):
    // with an instant 200, `redirectToSignIn()` resolves synchronously fast
    // enough that Solid's batched reactivity never gets a chance to paint
    // the intermediate "Redirecting..."/"Opening Claxedo sign-in..." busy
    // state before `.finally()` reverts it — verified live (polled the
    // button's text every 50ms for 500ms after a real click; it read
    // "Continue" on every single tick, never once "Redirecting...", while
    // the URL had already gained Clerk's redirect hash on the very first
    // tick). This delay is what makes that real, observable gap exist.
    await new Promise((resolve) => setTimeout(resolve, 300))
    return route.fulfill({
      status: 200,
      contentType: "application/json",
      headers: {
        "Access-Control-Allow-Origin": route.request().headers()["origin"] ?? "*",
        "Access-Control-Allow-Credentials": "true",
        "Access-Control-Allow-Headers": "authorization,content-type,accept",
        "Access-Control-Allow-Methods": "GET,POST,PUT,PATCH,DELETE,OPTIONS",
      },
      body: "{}",
    })
  })
}

/**
 * Latches (before the app's first script runs) whether a "Continue" button is
 * EVER attached to the document. `/login`'s redirect-if-already-signed guard is
 * a synchronous early `return null` in the component body
 * (`src/app/routes/login.tsx:37-40`), so for a signed visitor the button should
 * never be created at all — a claim that an after-the-fact `toHaveCount(0)`
 * cannot make (any post-redirect page satisfies that trivially, flash or no
 * flash). A MutationObserver started at document-creation time can.
 */
async function recordContinueButtonFlash(page: Page) {
  await page.addInitScript(() => {
    const w = window as typeof window & { __continueButtonSeen__?: boolean }
    w.__continueButtonSeen__ = false
    const scan = () => {
      if (w.__continueButtonSeen__) return
      for (const button of document.querySelectorAll("button")) {
        if ((button.textContent ?? "").includes("Continue")) {
          w.__continueButtonSeen__ = true
          return
        }
      }
    }
    const start = () => {
      scan()
      new MutationObserver(scan).observe(document.documentElement, { childList: true, subtree: true })
    }
    if (document.documentElement) start()
    else document.addEventListener("readystatechange", start, { once: true })
  })
}

function continueButtonFlashed(page: Page) {
  return page.evaluate(() => (window as typeof window & { __continueButtonSeen__?: boolean }).__continueButtonSeen__ === true)
}

/** Reads the `__claxedoSignInCalls` e2e seam (`src/platform/auth/auth-client.ts:337`,
 * DEV || VITE_CLAXEDO_E2E gated) — every `auth.signIn()` invocation with the
 * `redirectUrl` it was given. The `/login` "Continue triggers sign-in" test
 * below asserts a POSITIVE count through this same seam, which is this file's
 * proof the seam is live and therefore that the zero-call assertions elsewhere
 * are not vacuous. */
function signInCalls(page: Page) {
  return page.evaluate(
    () => (window as typeof window & { __claxedoSignInCalls?: { redirectUrl?: string }[] }).__claxedoSignInCalls ?? [],
  )
}

async function openWorkbench(page: Page, dir: string) {
  await page.goto(`/${slug(dir)}/session`)
  await page.waitForLoadState("domcontentloaded")
  await expect(page.locator("[data-claxedo]")).toBeVisible({ timeout: 30_000 })
}

async function openSettings(page: Page) {
  await page.getByTestId("rail-account-trigger").click()
  await page.getByRole("menuitem", { name: "Settings", exact: true }).click()
  const dialog = page.locator('[data-slot="dialog-container"]').last()
  await expect(dialog).toBeVisible({ timeout: 10_000 })
  return dialog
}

/** Escape is the Settings dialog's own close affordance at desktop viewport
 * (the `aria-label="Close settings"` button only renders under the
 * `max-sm:flex` mobile breakpoint) — see this file's own commentary on
 * "the Settings dialog's own escape-to-close handling" in the shortcuts
 * conflict test below for the same fact established elsewhere in this spec. */
async function closeSettings(page: Page) {
  await page.keyboard.press("Escape")
  await expect(page.locator('[data-slot="dialog-container"]').last()).toBeHidden({ timeout: 5_000 })
}

// ---------------------------------------------------------------------------
// Notification-permission mock (behavior 32 — BUG A regression)
// ---------------------------------------------------------------------------

/**
 * Installs a scriptable `window.Notification` stub before the app's first
 * script runs, so BUG A's contract — permission requested at most once, only
 * from the Settings toggle, never from turn completion — can be asserted
 * without ever triggering a REAL OS/browser permission prompt.
 */
async function installMockNotificationApi(page: Page) {
  await page.addInitScript(() => {
    const w = window as typeof window & {
      __notificationRequestCount__?: number
      __notificationInstanceCount__?: number
    }
    w.__notificationRequestCount__ = 0
    w.__notificationInstanceCount__ = 0
    // Force `platform.notify`'s in-view early-return (src/app/entry/main.tsx:69,
    // `document.visibilityState === "visible" && document.hasFocus()`) to be
    // FALSE. Without this the notify body never executes at all for a single
    // Playwright page (always visible, always focused), and "turn completion
    // issued zero permission requests" would be satisfied by notify never
    // running rather than by notify declining to request — i.e. the assertion
    // could not distinguish the contract from a dead code path. Overriding
    // `hasFocus` (its only consumer in the whole app: `grep -rn hasFocus src`
    // ⇒ that one line) makes the body run for real, so the test observes the
    // path it claims to pin and the constructed-Notification counter becomes a
    // positive control that it ran.
    Object.defineProperty(document, "hasFocus", { configurable: true, value: () => false })
    class MockNotification {
      static permission: NotificationPermission = "default"
      static requestPermission(): Promise<NotificationPermission> {
        w.__notificationRequestCount__ = (w.__notificationRequestCount__ ?? 0) + 1
        MockNotification.permission = "granted"
        return Promise.resolve("granted")
      }
      onclick: (() => void) | null = null
      constructor(_title: string, _options?: NotificationOptions) {
        w.__notificationInstanceCount__ = (w.__notificationInstanceCount__ ?? 0) + 1
      }
      close() {}
    }
    Object.defineProperty(window, "Notification", {
      configurable: true,
      writable: true,
      value: MockNotification,
    })
  })
}

function notificationRequestCount(page: Page) {
  return page.evaluate(
    () => (window as typeof window & { __notificationRequestCount__?: number }).__notificationRequestCount__ ?? 0,
  )
}

/** How many `new Notification(...)` the app actually constructed — the positive
 * control that `platform.notify`'s body RAN (see installMockNotificationApi). */
function notificationInstanceCount(page: Page) {
  return page.evaluate(
    () => (window as typeof window & { __notificationInstanceCount__?: number }).__notificationInstanceCount__ ?? 0,
  )
}

/** Fills the composer, submits, and waits for the FULL turn (busy -> ...
 * -> session.idle) to settle — proven via the submit control's `data-icon`
 * leaving "stop" (INVARIANTS.md cross-cutting invariant #4), not a sleep.
 * This spec pins notification-permission plumbing on session.idle here, not
 * reply rendering, so the shared turn-oracle (reply-content assertions) is
 * intentionally not used for this one scenario (see this file's own
 * INVARIANTS section). */
async function driveOneTurn(page: Page, promptText: string) {
  const input = page.getByRole("textbox", { name: /Ask anything/i }).last()
  await expect(input).toBeVisible({ timeout: 10_000 })
  await input.click()
  await input.fill(promptText)
  await expect(input).toContainText(promptText, { timeout: 5_000 })

  const submit = page.locator('[data-action="prompt-submit"]').last()
  await submit.click()
  // Turn START gets the same budget as turn completion below: on loaded CI
  // runners the accepted prompt sat disabled+"send" past a 5s wait twice
  // (runs 354 and 361) before the session went busy.
  await expect(submit).toHaveAttribute("data-icon", "stop", { timeout: 15_000 })
  await expect(submit).not.toHaveAttribute("data-icon", "stop", { timeout: 15_000 })
}

function tabTrigger(page: Page, value: string) {
  return page.locator(`[role="tab"][data-value="${value}"]`)
}

async function selectTab(page: Page, value: string) {
  await tabTrigger(page, value).click()
  await expect(tabTrigger(page, value)).toHaveAttribute("aria-selected", "true")
}

/** Opens the Select at `dataAction`, hovers/clicks the option whose text matches `label`. */
async function openSelect(page: Page, dataAction: string) {
  await page.locator(`[data-action="${dataAction}"] [data-slot="select-select-trigger"]`).click()
}

function selectOption(page: Page, label: string) {
  return page.locator('[data-slot="select-select-item"]').filter({ hasText: label })
}

// ---------------------------------------------------------------------------
// Providers-tab route mocks (not covered by the shared mock-runtime helper)
// ---------------------------------------------------------------------------

type ProviderFixture = {
  id: string
  name: string
  source?: "env" | "api" | "config" | "custom"
  models?: Record<string, unknown>
}

async function mockProviderCatalog(page: Page, input: { connected: ProviderFixture[]; popular: ProviderFixture[] }) {
  const all = [...input.connected, ...input.popular]
  const provider = {
    all: all.map((p) => ({
      id: p.id,
      name: p.name,
      source: p.source,
      env: [],
      models: p.models ?? { "m-1": { id: "m-1", name: "Model 1", cost: {} } },
    })),
    default: {},
    connected: input.connected.map((p) => p.id),
  }
  // Bootstrap owns the initial provider index. Install this route after the shared
  // runtime so the settings page starts from the same canonical catalog that a real
  // control plane supplies. The /provider route below supplies detail metadata after
  // the settings surface identifies which connected providers need it.
  await page.route("**/api/claxedo/bootstrap**", (route) => json(route, {
    healthy: true,
    version: "1.0.0-test",
    path: { state: "", config: "", worktree: DIR, directory: DIR, home: "/tmp" },
    project: [{ id: "proj_mock_runtime", worktree: DIR, name: "mock-runtime", time: { created: Date.now(), updated: Date.now() } }],
    provider: providerCatalogIndex(provider),
    provider_auth: {},
    config: {},
  }))
  // NOT `"**/provider"` (bare, no trailing wildcard): the real request is
  // `/provider?harness=<id>` (see `src/context/global-sync/bootstrap.ts` /
  // `useProviders`'s `queryOptions.providers()`) and Playwright glob route
  // patterns without a trailing wildcard only match a URL that ends EXACTLY
  // at that literal — a query string breaks the match, so a bare `**/provider`
  // silently never fires for this app's actual traffic (confirmed empirically
  // with a throwaway route-order reproduction: `**/xyz` never matched
  // `/xyz?q=1`, and the request fell through to the real network/dev-server
  // fallback). `**/provider*` matches both the bare and `?query` forms while
  // still requiring a literal `/provider` segment (`*` cannot cross `/`, so
  // this never collides with `/provider/auth`).
  await page.route("**/provider*", (route) => {
    if (new URL(route.request().url()).pathname !== "/provider") return route.continue()
    if (route.request().method() !== "GET" && route.request().resourceType() !== "fetch" && route.request().resourceType() !== "xhr") {
      return route.continue()
    }
    return json(route, provider)
  })
}

async function mockCredentialRoutes(page: Page, hits: { put: unknown[]; delete: string[] }) {
  await page.route(
    "**/api/claxedo/credentials",
    withCors(async (route) => {
      if (route.request().method() !== "PUT") return route.continue()
      hits.put.push(route.request().postDataJSON())
      return json(route, { ok: true })
    }),
  )
  await page.route(
    "**/api/claxedo/credentials/provider/**",
    withCors(async (route) => {
      if (route.request().method() !== "DELETE") return route.continue()
      hits.delete.push(new URL(route.request().url()).pathname)
      return json(route, { ok: true })
    }),
  )
}

// ---------------------------------------------------------------------------
// Connections-tab route mock (not covered by the shared mock-runtime helper)
// ---------------------------------------------------------------------------

type IntegrationFixture = { id: string; name: string; methods: ("key" | "oauth")[]; capabilities: string[]; prompts?: { id: string; label: string; secret?: boolean }[] }
type ConnectionFixture = { id: string; integrationId: string; scope: "team" | "personal"; status: "connected" | "degraded" | "broken"; accountLabel?: string }

function mockIntegrations(
  page: Page,
  input: {
    integrations: IntegrationFixture[]
    connections: ConnectionFixture[]
    onConnect?: (integrationId: string, body: Record<string, unknown>) => { status: number; body: Record<string, unknown> }
    onAttempt?: (attemptId: string) => { status: number; body: Record<string, unknown> }
  },
) {
  const connectCalls: { integrationId: string; body: Record<string, unknown> }[] = []
  const attemptCalls: string[] = []
  const disconnectCalls: string[] = []
  const reverifyCalls: string[] = []

  return {
    connectCalls,
    attemptCalls,
    disconnectCalls,
    reverifyCalls,
    async install() {
      await page.route(
        "**/api/claxedo/integrations**",
        withCors(async (route) => {
        const url = new URL(route.request().url())
        const suffix = url.pathname.split("/api/claxedo/integrations")[1] ?? ""
        const method = route.request().method()

        if (suffix === "" && method === "GET") {
          return json(route, {
            integrations: input.integrations,
            connections: input.connections,
            personalScopeEnabled: false,
          })
        }

        const connectMatch = suffix.match(/^\/([^/]+)\/connect$/)
        if (connectMatch && method === "POST") {
          const integrationId = decodeURIComponent(connectMatch[1])
          const body = route.request().postDataJSON() as Record<string, unknown>
          connectCalls.push({ integrationId, body })
          const result = input.onConnect?.(integrationId, body) ?? { status: 200, body: { ok: true } }
          return json(route, result.body, result.status)
        }

        const attemptMatch = suffix.match(/^\/attempts\/([^/]+)$/)
        if (attemptMatch && method === "GET") {
          const attemptId = decodeURIComponent(attemptMatch[1])
          attemptCalls.push(attemptId)
          const result = input.onAttempt?.(attemptId) ?? { status: 200, body: { status: "pending" } }
          return json(route, result.body, result.status)
        }

        const disconnectMatch = suffix.match(/^\/connections\/([^/]+)$/)
        if (disconnectMatch && method === "DELETE") {
          disconnectCalls.push(decodeURIComponent(disconnectMatch[1]))
          return json(route, { ok: true })
        }

        const reverifyMatch = suffix.match(/^\/connections\/([^/]+)\/reverify$/)
        if (reverifyMatch && method === "POST") {
          reverifyCalls.push(decodeURIComponent(reverifyMatch[1]))
          return json(route, { ok: true })
        }

        return route.fulfill({ status: 404, contentType: "application/json", headers: corsHeaders(), body: "{}" })
        }),
      )
    },
  }
}

// ---------------------------------------------------------------------------
// Sandbox-tab route mock (not covered by the shared mock-runtime helper)
// ---------------------------------------------------------------------------

function mockSandboxDrivers(page: Page, initial: { default_driver: string; drivers: { id: string; label: string; fields: { key: string; label: string; secret?: boolean }[]; configured: boolean; source: string; default: boolean }[] }) {
  let state = initial
  const putAuthCalls: { driverId: string; body: unknown }[] = []
  const deleteAuthCalls: string[] = []
  const putDefaultCalls: unknown[] = []
  return {
    putAuthCalls,
    deleteAuthCalls,
    putDefaultCalls,
    async install() {
      await page.route(
        "**/api/workspace/drivers**",
        withCors(async (route) => {
        const url = new URL(route.request().url())
        const method = route.request().method()
        if (url.pathname === "/api/workspace/drivers" && method === "GET") return json(route, state)
        if (url.pathname === "/api/workspace/drivers/default" && method === "PUT") {
          const body = route.request().postDataJSON() as { driver: string }
          putDefaultCalls.push(body)
          state = { ...state, default_driver: body.driver, drivers: state.drivers.map((p) => ({ ...p, default: p.id === body.driver })) }
          return json(route, state)
        }
        const authMatch = url.pathname.match(/^\/api\/workspace\/drivers\/([^/]+)\/auth$/)
        if (authMatch && method === "PUT") {
          const driverId = decodeURIComponent(authMatch[1])
          const body = route.request().postDataJSON()
          putAuthCalls.push({ driverId, body })
          state = { ...state, drivers: state.drivers.map((p) => (p.id === driverId ? { ...p, configured: true } : p)) }
          return json(route, state)
        }
        if (authMatch && method === "DELETE") {
          const driverId = decodeURIComponent(authMatch[1])
          deleteAuthCalls.push(driverId)
          state = { ...state, drivers: state.drivers.map((p) => (p.id === driverId ? { ...p, configured: false } : p)) }
          return json(route, { ok: true })
        }
        return route.fulfill({ status: 404, contentType: "application/json", headers: corsHeaders(), body: "{}" })
        }),
      )
      // The Sandbox tab's Network Policy section (`network-policy.tsx`) fires its
      // own unconditional `createResource` fetches (policy rows + groups) the
      // instant it mounts — independent of anything above, and NOT covered by the
      // `**/api/workspace/drivers**` route. Left unmocked, those hit the real
      // (unreachable in this harness) backend, reject with "Failed to fetch", and
      // — reproduced live — crash the top-level `ErrorBoundary` (src/app/entry/
      // app.tsx:169 wraps `DialogProvider`, so the Settings dialog's own subtree
      // is inside it) partway through an otherwise-passing scenario, which is
      // exactly the class of failure this default exists to prevent for every
      // caller of `.install()`. A test that needs specific policy rows/groups can
      // still register its own more-specific `**/api/claxedo/network-policy**`
      // route AFTER calling `.install()` — Playwright's last-registered-first
      // matching lets it win (see the "Network Policy..." test below, the
      // pattern this default is modeled on).
      await page.route(
        "**/api/claxedo/network-policy**",
        withCors((route) => {
          const url = new URL(route.request().url())
          if (url.pathname === "/api/claxedo/network-policy/groups") return json(route, { groups: {} })
          return json(route, { policies: [] })
        }),
      )
    },
  }
}

test.describe("core settings + auth @core", () => {
  test.describe("settings dialog: tabs, gating, mobile nav", () => {
    test("General is active by default; switching tabs shows exactly one panel — behavior 1", async ({ page }) => {
      await installMockRuntime(page, { dir: DIR, sessionId: SESSION_ID })
      await seedProject(page, DIR)
      await openWorkbench(page, DIR)
      await openSettings(page)

      await expect(tabTrigger(page, "general")).toHaveAttribute("aria-selected", "true")
      await expect(page.locator('[data-slot="tabs-content"]:not([hidden])')).toHaveCount(1)
      await expect(page.getByRole("heading", { name: "General", exact: true })).toBeVisible()

      await selectTab(page, "shortcuts")
      await expect(page.locator('[data-slot="tabs-content"]:not([hidden])')).toHaveCount(1)
      await expect(page.getByRole("heading", { name: "Keyboard shortcuts", exact: true })).toBeVisible()

      await selectTab(page, "providers")
      await expect(page.locator('[data-slot="tabs-content"]:not([hidden])')).toHaveCount(1)
      await expect(page.getByRole("heading", { name: "Providers", exact: true })).toBeVisible()

      await selectTab(page, "connections")
      await expect(page.locator('[data-slot="tabs-content"]:not([hidden])')).toHaveCount(1)
      await expect(page.getByRole("heading", { name: "Connections", exact: true })).toBeVisible()
    })

    // NOT "because sandboxEnabled is baked true in this harness": there is no
    // `sandboxEnabled` gate at all (src/app/dialogs/settings.tsx renders the
    // trigger at :159 and the content at :214 unconditionally; `grep -c
    // sandboxEnabled` on that file returns 0). The tab is unconditional.
    test("the Sandbox tab renders unconditionally — no config or env flag gates it — behavior 2", async ({ page }) => {
      await installMockRuntime(page, { dir: DIR, sessionId: SESSION_ID })
      await seedProject(page, DIR)
      await mockSandboxDrivers(page, { default_driver: "docker", drivers: [] }).install()
      await openWorkbench(page, DIR)
      await openSettings(page)

      await expect(tabTrigger(page, "compute")).toBeVisible()
      await selectTab(page, "compute")
      await expect(page.getByRole("heading", { name: "Sandbox Providers", exact: true })).toBeVisible()
    })

    // The former "Sandbox tab is absent when sandboxEnabled is false" fixme was
    // deleted: VITE_SANDBOX_ENABLED was removed and sandbox surfaces are always
    // present now (owner decision), so there is no flag-off branch left to cover.

    test("mobile viewport: menu mode by default, tab selection drills into content, back returns to menu — behavior 3", async ({ page }) => {
      await installMockRuntime(page, { dir: DIR, sessionId: SESSION_ID })
      await seedProject(page, DIR)
      await openWorkbench(page, DIR)
      // Open at the default (desktop) viewport — the rail sidebar's gear
      // button reachability under <640px is the outer shell's responsive
      // layout, not this spec's territory (OUT OF SCOPE). Resize AFTER the
      // dialog is open so only the dialog's own `.settings-mobile-*` media
      // query (`src/claxedo-ui/claxedo-layout.css`, max-width:639px) is
      // under test.
      const dialog = await openSettings(page)
      await page.setViewportSize({ width: 375, height: 812 })

      await expect(dialog.locator(".settings-mobile-menu")).toHaveCount(1)
      await expect(dialog.locator('[data-slot="tabs-list"]')).toBeVisible()
      // NOT `:not([hidden])` (used for the desktop one-panel-at-a-time checks
      // above): Kobalte's Tabs.Content only toggles the `hidden` ATTRIBUTE on
      // the INACTIVE panels — the active panel never gets `hidden` from
      // Kobalte itself. Menu mode additionally hides the active panel too,
      // but purely via the app's own CSS class rule
      // (`.settings-mobile-menu > [data-slot="tabs-content"] { display: none
      // !important }`, `src/claxedo-ui/claxedo-layout.css`), which never
      // touches the `hidden` attribute — so `:not([hidden])` still matches
      // the (CSS-hidden) active panel and this assertion would always see 1,
      // never 0. `:visible` checks actual computed visibility instead.
      await expect(dialog.locator('[data-slot="tabs-content"]:visible')).toHaveCount(0)

      await tabTrigger(page, "shortcuts").click()
      await expect(dialog.locator(".settings-mobile-content")).toHaveCount(1)
      await expect(dialog.locator('[data-slot="tabs-list"]')).toBeHidden()
      await expect(dialog.locator(".settings-mobile-back")).toBeVisible()
      await expect(page.getByRole("heading", { name: "Keyboard shortcuts", exact: true })).toBeVisible()

      await dialog.locator(".settings-mobile-back").click()
      await expect(dialog.locator(".settings-mobile-menu")).toHaveCount(1)
      await expect(dialog.locator('[data-slot="tabs-list"]')).toBeVisible()
    })
  })

  test.describe("General: account section + sign-out", () => {
    test("account section renders for the default signed test-bypass principal, with identity + sign-out — behavior 4", async ({ page }) => {
      await installMockRuntime(page, { dir: DIR, sessionId: SESSION_ID })
      await seedProject(page, DIR)
      await openWorkbench(page, DIR)
      await openSettings(page)

      await expect(page.getByRole("heading", { name: "Account", exact: true })).toBeVisible()
      await expect(page.getByText("test@claxedo.test")).toBeVisible()
      await expect(page.getByRole("button", { name: "Log out" })).toBeVisible()
    })

    test("account section still renders for an anonymous principal, without an identity row — behavior 4", async ({ page }) => {
      await installMockRuntime(page, { dir: DIR, sessionId: SESSION_ID })
      await seedProject(page, DIR)
      await disableTestAuthBypass(page)
      await openWorkbench(page, DIR)
      await openSettings(page)

      await expect(page.getByRole("heading", { name: "Account", exact: true })).toBeVisible()
      await expect(page.getByRole("button", { name: "Log out" })).toBeVisible()
      await expect(page.getByText("test@claxedo.test")).toHaveCount(0)
    })

    // Entry #17 (decision A). Previously fixme for two reasons, both fixed at
    // the app layer (src/platform/auth/auth-client.ts):
    //   (1) `isSignedIn()` was unconditionally true under Playwright
    //       (navigator.webdriver), so `/login`'s redirect-if-signed guard
    //       bounced back to the workbench. Fixed by an EXPLICIT signed-state
    //       override: `signOut()` sets `__CLAXEDO_TEST_SIGNED_OUT__`, which
    //       `testAuth()` honours to report an anonymous principal — an e2e-only
    //       seam (dev/e2e builds only), NOT a production behavior change.
    //   (2) `signOut()` no-op'd under the bypass because the bypass branch of
    //       `initializeClerk()` never assigns `clerkLoadPromise`, so the old
    //       `if (!clerkLoadPromise) return` short-circuited before the purge.
    //       Fixed: the bypass path now clears state and purges persisted keys.
    test("Log out signs out, purges persisted auth state, and stays on /login — behavior 5", async ({ page }) => {
      await installMockRuntime(page, { dir: DIR, sessionId: SESSION_ID })
      await seedProject(page, DIR)
      await openWorkbench(page, DIR)

      // Seed a persisted `opencode.*` marker that a real sign-out must purge
      // (clearPersistedAuthState wipes every opencode.* / projection-cache key).
      await page.evaluate(() => localStorage.setItem("opencode.marker.should-be-purged", "1"))

      await openSettings(page)
      const logout = page.getByRole("button", { name: "Log out" })
      await expect(logout).toBeVisible()
      await logout.click()

      // The synthetic principal is now signed OUT, so `/login`'s
      // redirect-if-already-signed guard no longer bounces back to the
      // workbench — landing (and staying) on /login proves the principal is
      // anonymous (a still-signed principal would bounce to "/"). Generous
      // timeout: LoginPage is a lazily code-split route whose chunk import is
      // slow under a loaded dev server (never a wall-clock sleep).
      await expect(page).toHaveURL(/\/login$/, { timeout: 20_000 })
      // The anonymous login page's "Continue" CTA renders. A CSS/text locator,
      // not getByRole: the Settings dialog stays in the app-wide DialogProvider
      // stack across the route change and its modal marks siblings aria-inert,
      // so the accessibility-tree query can't see the (rendered) button.
      await expect(page.locator("button").filter({ hasText: "Continue" })).toBeVisible({ timeout: 20_000 })

      // Persisted auth state was purged by the (previously no-op) sign-out.
      const marker = await page.evaluate(() => localStorage.getItem("opencode.marker.should-be-purged"))
      expect(marker).toBeNull()
    })
  })

  test.describe("General: appearance preview/commit + notifications + updates", () => {
    test("hovering a color scheme option live-previews, moving off cancels, selecting commits — behavior 6", async ({ page }) => {
      await installMockRuntime(page, { dir: DIR, sessionId: SESSION_ID })
      await seedProject(page, DIR)
      await openWorkbench(page, DIR)
      await openSettings(page)

      const committedBefore = await page.evaluate(() => document.documentElement.dataset.colorScheme)

      await openSelect(page, "settings-color-scheme")
      const darkOption = selectOption(page, "Dark")
      await expect(darkOption).toBeVisible()
      // `{ force: true }`, not a plain `.hover()`: `onHighlight` (src/
      // components/settings-general.tsx:283-287) writes to a Solid STORE
      // (`previewColorScheme` → `setStore("previewScheme", ...)`,
      // packages/ui/src/theme/context.tsx:339-349) on every mouse-move over
      // the option, and each write's downstream re-render detaches/
      // reattaches this option node — verified live (Playwright's hover
      // stability wait saw "element was detached from the DOM, retrying" in
      // a continuous loop, never settling even at a 15s per-action timeout).
      // The behavior under test is the STORE effect (colorScheme flips to
      // "dark"), asserted for real by the `expect.poll` right below — forcing
      // the hover only skips Playwright's own actionability/stability
      // engine, which this component's live re-render churn defeats by
      // design, not the assertion of the actual outcome.
      await darkOption.hover({ force: true })
      await expect.poll(() => page.evaluate(() => document.documentElement.dataset.colorScheme)).toBe("dark")

      // Move off without selecting — closing the popover cancels the preview.
      // NOT Escape: the Settings dialog's own escape-to-close handling wins
      // the race against the popover's escape-to-dismiss (same class of
      // issue as the shortcuts-conflict test above — verified live with a
      // throwaway reproduction: pressing Escape here makes the select
      // TRIGGER itself disappear, i.e. it closes the whole dialog, not just
      // the popover). Clicking elsewhere in the dialog is a true outside
      // click, dismisses only the popover, and is a more literal match for
      // the spec wording ("moving off without selecting") than a specific
      // key anyway.
      await page.getByRole("heading", { name: "General", exact: true }).click()
      await expect.poll(() => page.evaluate(() => document.documentElement.dataset.colorScheme)).toBe(committedBefore)
      // Wait for the popover to be FULLY gone (not just the preview reverted)
      // before reopening it — reopening while its close transition is still
      // in flight is flaky.
      await expect(page.locator('[data-slot="select-select-item"]')).toHaveCount(0)

      await openSelect(page, "settings-color-scheme")
      // `{ force: true }`: same continuous-re-render churn as the hover
      // above — clicking still passes the cursor over the option first,
      // triggering the same `onHighlight` → store-write → re-render loop.
      await selectOption(page, "Dark").click({ force: true })
      await expect.poll(() => page.evaluate(() => document.documentElement.dataset.colorScheme)).toBe("dark")
      // The EXACT committed value, not merely "something was written":
      // `@opencode-ai/ui`'s theme context writes the raw scheme string to the
      // `opencode-color-scheme` key (packages/ui/src/theme/context.tsx:16 +
      // :312, via a plain `localStorage.setItem(key, value)` — no JSON
      // wrapper), so a commit that persisted the WRONG scheme (or the
      // pre-existing one) would satisfy a bare `toBeTruthy()` and must not.
      const persisted = await page.evaluate(() => localStorage.getItem("opencode-color-scheme"))
      expect(persisted).toBe("dark")
    })

    test("all three notification switches toggle and write through to useSettings().notifications.* — behavior 7", async ({ page }) => {
      await installMockRuntime(page, { dir: DIR, sessionId: SESSION_ID })
      await seedProject(page, DIR)
      await openWorkbench(page, DIR)
      await openSettings(page)

      // All THREE named switches, not just "agent" — behavior 7 names
      // agent/permissions/errors and a per-switch mis-wiring (e.g. two rows
      // bound to the same setter) is invisible if only one is exercised.
      for (const key of ["agent", "permissions", "errors"] as const) {
        const box = page.locator(`[data-action="settings-notifications-${key}"] input[type="checkbox"]`)
        const before = await box.isChecked()
        await page.locator(`[data-action="settings-notifications-${key}"] [data-slot="switch-control"]`).click()
        await expect.poll(() => box.isChecked()).toBe(!before)

        // The `checked` flip alone proves nothing about the CONTEXT write
        // behavior 7 actually claims: a plain uncontrolled checkbox flips its
        // own `checked` with `useSettings().notifications.set*` entirely
        // broken. `useSettings()`'s store is `persisted("settings.v3", ...)`
        // (src/platform/settings/provider.tsx:163) with no storage prefix
        // (=> the bare `settings.v3` localStorage key,
        // src/platform/persistence/persist.ts:355-362), so the store write is
        // observable end-to-end here.
        await expect
          .poll(async () =>
            page.evaluate(
              (k: string) =>
                (JSON.parse(localStorage.getItem("settings.v3") ?? "{}") as { notifications?: Record<string, boolean> })
                  .notifications?.[k],
              key,
            ),
          )
          .toBe(!before)
      }
    })

    test("Notification permission is requested at most once, only from enabling the toggle, never from turn completion — behavior 32", async ({ page }) => {
      await installMockNotificationApi(page)
      await installMockRuntime(page, { dir: DIR, sessionId: SESSION_ID })
      await seedProject(page, DIR)
      await openWorkbench(page, DIR)

      // Agent notifications default ON (`defaultSettings.notifications.agent`,
      // src/context/settings.tsx) — turn it OFF first so the first driven
      // turn below proves the "setting off" half of the contract.
      await openSettings(page)
      const agentSwitch = page.locator('[data-action="settings-notifications-agent"] input[type="checkbox"]')
      const agentControl = page.locator('[data-action="settings-notifications-agent"] [data-slot="switch-control"]')
      if (await agentSwitch.isChecked()) await agentControl.click()
      await expect.poll(() => agentSwitch.isChecked()).toBe(false)
      await closeSettings(page)

      await driveOneTurn(page, "notification setting off turn")
      expect(await notificationRequestCount(page)).toBe(0)
      // With the setting OFF the notification provider never even calls
      // `platform.notify` (src/app/providers/notification.tsx:270 gates on
      // `settings.notifications.agent()`), so nothing should have been
      // constructed either.
      expect(await notificationInstanceCount(page)).toBe(0)

      // Turning the toggle ON is the ONLY point a permission request may
      // fire — assert it fires exactly once, from this click.
      await openSettings(page)
      if (!(await agentSwitch.isChecked())) await agentControl.click()
      await expect.poll(() => agentSwitch.isChecked()).toBe(true)
      await expect.poll(() => notificationRequestCount(page)).toBe(1)
      await closeSettings(page)

      // A second, fully-completed turn with notifications now enabled must
      // NOT request permission again — this is the actual BUG A regression:
      // the browser's permission prompt used to reappear on every single
      // turn completion because `platform.notify` (src/main.tsx) called
      // `Notification.requestPermission()` itself whenever permission was
      // still "default".
      await driveOneTurn(page, "notification setting on turn")
      // POSITIVE CONTROL FIRST: prove `platform.notify`'s body actually RAN
      // this time (it constructed a Notification) — otherwise the zero-new-
      // requests assertion below would be satisfied by the notify path never
      // executing at all, which is exactly the false-positive shape this test
      // exists to avoid. `installMockNotificationApi` forces the in-view
      // early-return false so the body is reachable at all.
      await expect.poll(() => notificationInstanceCount(page), { timeout: 15_000 }).toBeGreaterThanOrEqual(1)
      // ...and STILL exactly one permission request in total: notify read the
      // (already "granted") permission and never re-requested it.
      expect(await notificationRequestCount(page)).toBe(1)
    })

    test("update-check affordances are disabled on the web platform (no platform.checkUpdate) — behavior 8", async ({ page }) => {
      await installMockRuntime(page, { dir: DIR, sessionId: SESSION_ID })
      await seedProject(page, DIR)
      await openWorkbench(page, DIR)
      await openSettings(page)

      await expect(page.locator('[data-action="settings-updates-startup"] input[type="checkbox"]')).toBeDisabled()
      await expect(page.getByRole("button", { name: "Check now" })).toBeDisabled()
    })
  })

  test.describe("Shortcuts: search, rebind, conflict, reset", () => {
    test("search filters the list; a no-match query shows the empty state — behavior 9", async ({ page }) => {
      await installMockRuntime(page, { dir: DIR, sessionId: SESSION_ID })
      await seedProject(page, DIR)
      await openWorkbench(page, DIR)
      await openSettings(page)
      await selectTab(page, "shortcuts")

      const search = page.getByPlaceholder("Search shortcuts")
      await search.fill("Command Palette")
      await expect(page.locator('[data-keybind-id="command.palette"]')).toBeVisible()

      await search.fill("zzz-definitely-not-a-real-shortcut-zzz")
      await expect(page.getByText("No shortcuts found")).toBeVisible()
    })

    test("rebinding a shortcut records the next keydown as its new binding — behaviors 9,10", async ({ page }) => {
      await installMockRuntime(page, { dir: DIR, sessionId: SESSION_ID })
      await seedProject(page, DIR)
      await openWorkbench(page, DIR)
      await openSettings(page)
      await selectTab(page, "shortcuts")

      await page.getByPlaceholder("Search shortcuts").fill("Command Palette")
      const row = page.locator('[data-keybind-id="command.palette"]')
      const originalBinding = await row.textContent()
      expect(originalBinding).toBeTruthy()
      await row.click()
      await expect(row).toHaveText("Press keys")

      await page.keyboard.press("Alt+Shift+K")
      // The ACTUAL new binding's label, not just "no longer capturing":
      // `not.toHaveText("Press keys")` + `not.toHaveText("Unassigned")` is
      // satisfied by an app that silently RESTORED the original binding, which
      // is precisely the regression behavior 10 is meant to catch. The row
      // renders `formatKeybind(...)` (src/features/settings/ui/keybinds.tsx →
      // src/app/providers/command-palette.tsx:239-243), which on a non-mac
      // `navigator.platform` joins the translated modifier labels with "+"
      // ("Alt"/"Shift", src/platform/i18n/en.ts:676-677) and upper-cases a
      // single-character key; on mac it concatenates the glyphs with no
      // separator. Playwright's bundled Chromium reports "Win32" here
      // regardless of host OS (see the conflict test below for the same fact),
      // but resolve it at runtime rather than hardcoding either form.
      const isMac = await page.evaluate(() => /(Mac|iPod|iPhone|iPad)/.test(navigator.platform))
      await expect(row).toHaveText(isMac ? "⌥⇧K" : "Alt+Shift+K")
      expect(await row.textContent()).not.toBe(originalBinding)
    })

    test("rebinding to a combo already used elsewhere shows a conflict toast and changes nothing — behavior 11", async ({ page }) => {
      await installMockRuntime(page, { dir: DIR, sessionId: SESSION_ID })
      await seedProject(page, DIR)
      await openWorkbench(page, DIR)
      await openSettings(page)
      await selectTab(page, "shortcuts")

      // Command Palette's default binding is mod+shift+p — attempt to steal it
      // for a different command (search finds a General-group non-palette row).
      await page.getByPlaceholder("Search shortcuts").fill("Command Palette")
      const paletteBinding = await page.locator('[data-keybind-id="command.palette"]').textContent()
      expect(paletteBinding).toBeTruthy()

      await page.getByPlaceholder("Search shortcuts").fill("")
      const anotherRow = page.locator("[data-keybind-id]").filter({ hasNotText: "Unassigned" }).nth(1)
      const anotherId = await anotherRow.getAttribute("data-keybind-id")
      expect(anotherId).not.toBe("command.palette")
      const beforeText = await anotherRow.textContent()

      await anotherRow.click()
      await expect(anotherRow).toHaveText("Press keys")
      // Capture mode consumes exactly the NEXT keydown and exits (behavior
      // 10) — pressing a second combo as a cross-platform hedge does nothing
      // once the first has already been consumed, so the modifier for this
      // single press must actually match `mod` (src/context/command-
      // upstream.tsx:11, `IS_MAC = /(Mac|iPod|iPhone|iPad)/.test(navigator.
      // platform)`). Playwright's bundled Chromium reports
      // `navigator.platform === "Win32"` in this harness regardless of the
      // host OS, so `mod` is always Ctrl here, never Meta/Cmd — resolve it at
      // runtime instead of hardcoding either.
      const isMac = await page.evaluate(() => /(Mac|iPod|iPhone|iPad)/.test(navigator.platform))
      await page.keyboard.press(isMac ? "Meta+Shift+P" : "Control+Shift+P")

      await expect(page.getByText("Shortcut already in use")).toBeVisible({ timeout: 5_000 })
      // On conflict the capture handler toasts and `return`s WITHOUT calling
      // `stop()` (src/components/settings-keybinds.tsx:241-250) — capture
      // mode deliberately stays active (row still reads "Press keys") so the
      // user can immediately try a different combo. NOT Escape to exit: the
      // Settings dialog has its own escape-to-close handling that wins the
      // race against the capture listener's own Escape handling (verified
      // live — pressing Escape here closes the whole dialog, not just
      // capture mode). Clicking the SAME row again is the app's other exit
      // path (`start(id)`: `if (store.active === id) { stop(); return }`,
      // same file :276-280) and doesn't touch the dialog.
      await anotherRow.click()
      await expect(anotherRow).toHaveText(beforeText ?? "")

      // BOTH bindings, which is what behavior 11 claims: the row that already
      // OWNED the combination must still own it. `paletteBinding` was read at
      // the top of this test and then never compared — without this the
      // "leaves both bindings unchanged" half was pure prose. Re-filter to
      // bring the palette row back into the (currently unfiltered) list.
      await page.getByPlaceholder("Search shortcuts").fill("Command Palette")
      await expect(page.locator('[data-keybind-id="command.palette"]')).toHaveText(paletteBinding ?? "")
    })

    test("Reset to defaults is disabled until an override exists, then clears overrides — behavior 12", async ({ page }) => {
      await installMockRuntime(page, { dir: DIR, sessionId: SESSION_ID })
      await seedProject(page, DIR)
      await openWorkbench(page, DIR)
      await openSettings(page)
      await selectTab(page, "shortcuts")

      const reset = page.getByRole("button", { name: "Reset to defaults" })
      await expect(reset).toBeDisabled()

      await page.getByPlaceholder("Search shortcuts").fill("Command Palette")
      const row = page.locator('[data-keybind-id="command.palette"]')
      await row.click()
      await page.keyboard.press("Alt+Shift+K")
      await expect(reset).toBeEnabled()

      await reset.click()
      await expect(page.getByText("Shortcuts reset")).toBeVisible()
      await expect(reset).toBeDisabled()
    })
  })

  test.describe("Providers: connect, disconnect, env-locked, custom validation", () => {
    test("connecting a popular API-key provider PUTs credentials and marks it connected — behavior 13", async ({ page }) => {
      await installMockRuntime(page, { dir: DIR, sessionId: SESSION_ID })
      await seedProject(page, DIR)
      await mockProviderCatalog(page, {
        connected: [],
        popular: [{ id: "anthropic", name: "Anthropic" }],
      })
      const credHits = { put: [] as unknown[], delete: [] as string[] }
      await mockCredentialRoutes(page, credHits)
      await openWorkbench(page, DIR)
      await openSettings(page)
      await selectTab(page, "providers")

      await expect(page.getByText("Anthropic")).toBeVisible()
      // Popular-provider rows are flat direct children of the same SettingsList
      // wrapper (a sibling of the "custom provider" row) — scope to that
      // wrapper's direct children so `hasText` picks exactly the Anthropic row
      // (not an ancestor that also contains the unrelated "Connect" button on
      // the custom-provider row, or a text-only descendant that lacks it).
      const popularList = page.getByRole("heading", { name: "Popular providers" }).locator("xpath=following-sibling::div[1]")
      const row = popularList.locator("> div").filter({ hasText: "Anthropic" })
      await row.getByRole("button", { name: "Connect" }).click()

      const dialog = page.locator('[data-slot="dialog-container"]').last()
      await expect(dialog.getByText("Connect Anthropic")).toBeVisible()
      await dialog.getByLabel(/Anthropic API key/i).fill("sk-test-anthropic-key")
      await dialog.getByRole("button", { name: "Continue" }).click()

      await expect.poll(() => credHits.put.length, { timeout: 10_000 }).toBe(1)
      expect(credHits.put[0]).toMatchObject({ provider_id: "anthropic", kind: "api_key", secret: "sk-test-anthropic-key" })
      await expect(page.getByText("Anthropic connected")).toBeVisible()
      await expect(dialog).toBeHidden()
    })

    test("an env-sourced connected provider has no Disconnect button; any other source's Disconnect DELETEs credentials — behavior 14", async ({ page }) => {
      await installMockRuntime(page, { dir: DIR, sessionId: SESSION_ID })
      await seedProject(page, DIR)
      await mockProviderCatalog(page, {
        connected: [
          { id: "anthropic", name: "Anthropic", source: "env" },
          { id: "openai", name: "OpenAI", source: "api" },
        ],
        popular: [],
      })
      const credHits = { put: [] as unknown[], delete: [] as string[] }
      await mockCredentialRoutes(page, credHits)
      await openWorkbench(page, DIR)
      await openSettings(page)
      await selectTab(page, "providers")

      // Connected-provider rows are flat direct children of the SettingsList
      // wrapper inside the connected-providers section — scope there so
      // `hasText` lands on the row (which contains the Disconnect button),
      // not a text-only descendant.
      const connectedRows = page.locator('[data-component="connected-providers-section"] > div > div')
      const envRow = connectedRows.filter({ hasText: "Anthropic" })
      // POSITIVE PRECONDITION for the zero-count claim below: a locator that
      // matched NOTHING (renamed section testid, row markup reshuffled, the
      // fixture never rendering) satisfies `toHaveCount(0)` on its descendant
      // button identically to a correctly-rendered env row. Pin that the row
      // resolved to exactly one element first, and that it is the env-sourced
      // one (its source Tag reads "Environment",
      // `settings.providers.tag.environment`).
      await expect(envRow).toHaveCount(1)
      await expect(envRow.getByText("Environment", { exact: true })).toBeVisible()
      await expect(envRow.getByRole("button", { name: "Disconnect" })).toHaveCount(0)
      // The other half of behavior 14 that was never asserted: the env row
      // shows the environment-locked description INSTEAD of the button
      // (`settings.providers.connected.environmentDescription`,
      // src/features/settings/ui/providers.tsx:194). It renders with
      // `opacity-0` until the row is hovered, so assert its presence in the
      // row rather than its visibility.
      await expect(envRow.getByText("Connected from your environment variables")).toHaveCount(1)

      const apiRow = connectedRows.filter({ hasText: "OpenAI" })
      await expect(apiRow).toHaveCount(1)
      await apiRow.getByRole("button", { name: "Disconnect" }).click()

      await expect.poll(() => credHits.delete.length, { timeout: 10_000 }).toBe(1)
      expect(credHits.delete[0]).toContain("/openai")
      await expect(page.getByText("OpenAI disconnected")).toBeVisible()
    })

    test("custom provider: submitting with an empty Provider ID shows an inline error and sends nothing — behavior 15", async ({ page }) => {
      await installMockRuntime(page, { dir: DIR, sessionId: SESSION_ID })
      await seedProject(page, DIR)
      await mockProviderCatalog(page, { connected: [], popular: [] })
      const credHits = { put: [] as unknown[], delete: [] as string[] }
      await mockCredentialRoutes(page, credHits)
      let configPatchCount = 0
      await page.route("**/config", (route) => {
        if (route.request().method() === "PATCH") configPatchCount += 1
        return route.continue()
      })
      await openWorkbench(page, DIR)
      await openSettings(page)
      await selectTab(page, "providers")

      // Scoped to the custom-provider row: the Popular-providers list always
      // renders its own always-on "opencode" promo entry (independent of this
      // test's empty `popular` fixture) with its own "Connect" button, so an
      // unscoped `getByRole("button", {name: "Connect"})` is ambiguous (strict
      // mode violation, 2 matches).
      await page.locator('[data-component="custom-provider-section"]').getByRole("button", { name: "Connect" }).click()
      const dialog = page.locator('[data-slot="dialog-container"]').last()
      await expect(dialog.getByText("Custom provider")).toBeVisible()
      await dialog.getByRole("button", { name: "Submit" }).click()

      await expect(dialog.getByText("Provider ID is required")).toBeVisible()
      expect(credHits.put.length).toBe(0)
      expect(configPatchCount).toBe(0)
    })
  })

  test.describe("Connections: status states, connect flow, OAuth polling, secret hygiene, disconnect", () => {
    test("integration rows show status chips and the right action set per status — behavior 16", async ({ page }) => {
      await installMockRuntime(page, { dir: DIR, sessionId: SESSION_ID })
      await seedProject(page, DIR)
      const mock = mockIntegrations(page, {
        integrations: [{ id: "notion", name: "Notion", methods: ["key"], capabilities: ["docs"], prompts: [{ id: "secret", label: "API secret", secret: true }] }],
        connections: [{ id: "conn-degraded", integrationId: "notion", scope: "team", status: "degraded" }],
      })
      await mock.install()
      await openWorkbench(page, DIR)
      await openSettings(page)
      await selectTab(page, "connections")

      await expect(page.getByText("Degraded")).toBeVisible()
      await expect(page.getByRole("button", { name: "Re-verify" })).toBeVisible()
      await expect(page.getByRole("button", { name: "Reconnect" })).toBeVisible()
    })

    test("connecting a key-method integration POSTs /connect and reloads the list on success — behavior 17", async ({ page }) => {
      await installMockRuntime(page, { dir: DIR, sessionId: SESSION_ID })
      await seedProject(page, DIR)
      const mock = mockIntegrations(page, {
        integrations: [{ id: "notion", name: "Notion", methods: ["key"], capabilities: ["docs"], prompts: [{ id: "secret", label: "API secret", secret: true }] }],
        connections: [],
      })
      await mock.install()
      await openWorkbench(page, DIR)
      await openSettings(page)
      await selectTab(page, "connections")

      await page.getByRole("button", { name: "Connect", exact: true }).click()
      const dialog = page.locator('[data-slot="dialog-container"]').last()
      await expect(dialog.getByText("Connect Notion")).toBeVisible()
      await dialog.getByLabel("API secret").fill("notion-secret-value")
      await dialog.getByRole("button", { name: "Connect" }).click()

      await expect.poll(() => mock.connectCalls.length, { timeout: 10_000 }).toBe(1)
      expect(mock.connectCalls[0].integrationId).toBe("notion")
      await expect(page.getByText("Notion connected")).toBeVisible()
      await expect(dialog).toBeHidden()
    })

    test("a 409 connection_exists response switches to confirm-replace instead of erroring — behavior 17", async ({ page }) => {
      await installMockRuntime(page, { dir: DIR, sessionId: SESSION_ID })
      await seedProject(page, DIR)
      const mock = mockIntegrations(page, {
        integrations: [{ id: "notion", name: "Notion", methods: ["key"], capabilities: ["docs"], prompts: [{ id: "secret", label: "API secret", secret: true }] }],
        connections: [],
        onConnect: (_id, body) =>
          body.confirmReplace === true
            ? { status: 200, body: { ok: true } }
            : { status: 409, body: { code: "connection_exists" } },
      })
      await mock.install()
      await openWorkbench(page, DIR)
      await openSettings(page)
      await selectTab(page, "connections")

      await page.getByRole("button", { name: "Connect", exact: true }).click()
      const dialog = page.locator('[data-slot="dialog-container"]').last()
      await dialog.getByLabel("API secret").fill("notion-secret-value")
      await dialog.getByRole("button", { name: "Connect" }).click()

      await expect(dialog.getByText(/already exists\. Replace the existing connection\?/)).toBeVisible({ timeout: 10_000 })
      await dialog.getByRole("button", { name: "Replace" }).click()
      await expect.poll(() => mock.connectCalls.length, { timeout: 10_000 }).toBe(2)
      await expect(dialog).toBeHidden()
    })

    test("an OAuth-only integration opens the URL and polls attempts until complete — behavior 18", async ({ page }) => {
      await installMockRuntime(page, { dir: DIR, sessionId: SESSION_ID })
      await seedProject(page, DIR)
      let polls = 0
      const mock = mockIntegrations(page, {
        integrations: [{ id: "github", name: "GitHub", methods: ["oauth"], capabilities: ["repos"] }],
        connections: [],
        onConnect: () => ({ status: 200, body: { url: "http://127.0.0.1:9/oauth/authorize", attemptId: "attempt-1" } }),
        onAttempt: () => {
          polls += 1
          return polls < 2 ? { status: 200, body: { status: "pending" } } : { status: 200, body: { status: "complete" } }
        },
      })
      await mock.install()
      // RECORDS its argument. The old stub was `() => null`, which recorded
      // nothing — so the "opens the URL" half of behavior 18 had no assertion
      // behind it at all and would have passed with `options.openUrl?.(url)`
      // (src/features/settings/ui/connections-logic.ts:389) deleted outright.
      await page.addInitScript(() => {
        const w = window as typeof window & { __openedUrls__?: string[]; open: typeof window.open }
        w.__openedUrls__ = []
        w.open = ((url?: string | URL) => {
          w.__openedUrls__?.push(typeof url === "string" ? url : (url?.toString() ?? ""))
          return null
        }) as typeof window.open
      })
      await openWorkbench(page, DIR)
      await openSettings(page)
      await selectTab(page, "connections")

      await page.getByRole("button", { name: "Connect", exact: true }).click()
      const dialog = page.locator('[data-slot="dialog-container"]').last()
      await dialog.getByRole("button", { name: "Continue with OAuth" }).click()

      await expect(dialog.getByText("Waiting for authorization")).toBeVisible()
      // The exact authorization URL the server returned was handed to
      // `window.open` — asserted BEFORE the success poll so a failure here is
      // attributed to the open step, not to polling.
      await expect
        .poll(
          () => page.evaluate(() => (window as typeof window & { __openedUrls__?: string[] }).__openedUrls__ ?? []),
          { timeout: 10_000 },
        )
        .toEqual(["http://127.0.0.1:9/oauth/authorize"])

      await expect(page.getByText("GitHub connected")).toBeVisible({ timeout: 15_000 })
      expect(mock.attemptCalls.length).toBeGreaterThanOrEqual(2)
    })

    // TITLE IS DELIBERATELY NARROWER than the old one ("closing the connect
    // dialog clears the pasted secret from the in-memory flow"), which this
    // test could never have falsified: `createConnectFlow` runs INSIDE the
    // component body (src/app/dialogs/connect-integration.tsx:28), so its
    // store is per-instance and dies with the component. A reopened dialog is
    // a brand-new instance with a brand-new empty store — the old assertion
    // passed identically with the `onCleanup(() => flow.reset())` at :46
    // deleted, and the backup `getByText("leaked-if-not-cleared")` probe
    // matched rendered TEXT NODES, which structurally cannot observe a value
    // sitting in an `<input>`. See behavior 19 in this file's header for the
    // full accounting of what is and is not provable. What IS provable is
    // asserted here (no secret in any input's value, nothing sent) and, for
    // the one externally-visible half of `reset()`, in the next test.
    test("closing the connect dialog leaves no secret in any input and sends nothing — behavior 19 (partial: see header)", async ({ page }) => {
      await installMockRuntime(page, { dir: DIR, sessionId: SESSION_ID })
      await seedProject(page, DIR)
      const mock = mockIntegrations(page, {
        integrations: [{ id: "notion", name: "Notion", methods: ["key"], capabilities: ["docs"], prompts: [{ id: "secret", label: "API secret", secret: true }] }],
        connections: [],
      })
      await mock.install()
      await openWorkbench(page, DIR)
      await openSettings(page)
      await selectTab(page, "connections")

      await page.getByRole("button", { name: "Connect", exact: true }).click()
      const dialog = page.locator('[data-slot="dialog-container"]').last()
      const secretField = dialog.getByLabel("API secret")
      await secretField.fill("leaked-if-not-cleared")
      await dialog.locator('[data-slot="dialog-close-button"]').click()
      // NOT "the Settings dialog underneath" — verified live (a throwaway
      // reproduction polling dialog count every 100ms showed it hit 0
      // immediately and stayed there): `useDialog().show()`
      // (packages/ui/src/context/dialog.tsx:139-148) DISPOSES the entire
      // existing dialog stack before mounting the new one — it is a
      // stack-REPLACE, not a stack-PUSH (that's the separate `push()`
      // method, unused by `DialogConnectIntegration`'s call site). Opening
      // the connect dialog therefore already disposed the Settings dialog;
      // closing the connect dialog leaves NO dialog open at all, not the
      // Settings dialog one layer down. Re-verify secret hygiene by
      // reopening Settings → Connections → Connect from scratch, matching
      // what the app actually does.
      await expect(page.locator('[data-slot="dialog-container"]')).toHaveCount(0)

      await openSettings(page)
      await selectTab(page, "connections")
      await page.getByRole("button", { name: "Connect", exact: true }).click()
      const reopenedDialog = page.locator('[data-slot="dialog-container"]').last()
      const reopenedSecret = reopenedDialog.getByLabel("API secret")
      // Positive precondition: the field actually re-rendered. Without this,
      // an empty-value assertion on a locator that matched nothing would be
      // vacuous in exactly the same way the old text-node probe was.
      await expect(reopenedSecret).toHaveCount(1)
      // `toHaveValue` reads the input's `value` PROPERTY (the only place a
      // password input's contents ever live) — a rendered-text query cannot.
      await expect(reopenedSecret).toHaveValue("")

      // Document-wide value probe, dialog-reference-independent: no input,
      // textarea, or contenteditable anywhere holds the pasted secret. This
      // replaces the old `getByText(...)` backup, which matched text nodes and
      // therefore could never have observed a secret left in a form field.
      const secretLeakedIntoAField = await page.evaluate((needle: string) => {
        const fields = [...document.querySelectorAll<HTMLInputElement | HTMLTextAreaElement>("input, textarea")]
        if (fields.some((field) => field.value.includes(needle))) return true
        return [...document.querySelectorAll<HTMLElement>("[contenteditable]")].some((node) =>
          (node.textContent ?? "").includes(needle),
        )
      }, "leaked-if-not-cleared")
      expect(secretLeakedIntoAField).toBe(false)

      // Never sent: closing without submitting issued zero /connect requests,
      // so the secret never left the browser at all.
      expect(mock.connectCalls.length).toBe(0)
      expect(JSON.stringify(mock.connectCalls)).not.toContain("leaked-if-not-cleared")
    })

    // The DISCRIMINATING half of behavior 19. `onCleanup(() => flow.reset())`
    // (src/app/dialogs/connect-integration.tsx:46) does two things: it clears
    // the store (unobservable — the store dies with the component either way,
    // see the test above) and it bumps `generation`, which is the ONLY thing
    // that stops `pollAttempt`'s loop
    // (src/features/settings/ui/connections-logic.ts:305-336). That loop is a
    // plain async function, not owned by Solid and not tied to the component's
    // lifetime, so with line 46 deleted it would keep issuing
    // `GET /attempts/:id` forever after the dialog is gone. This test fails if
    // that cleanup is removed.
    test("closing the connect dialog mid-OAuth cancels the attempt poll loop — behavior 19", async ({ page }) => {
      await installMockRuntime(page, { dir: DIR, sessionId: SESSION_ID })
      await seedProject(page, DIR)
      const mock = mockIntegrations(page, {
        integrations: [{ id: "github", name: "GitHub", methods: ["oauth"], capabilities: ["repos"] }],
        connections: [],
        onConnect: () => ({ status: 200, body: { url: "http://127.0.0.1:9/oauth/authorize", attemptId: "attempt-1" } }),
        // Never completes: the user closes the dialog while authorization is
        // still outstanding, which is the real-world shape of this cleanup.
        onAttempt: () => ({ status: 200, body: { status: "pending" } }),
      })
      await mock.install()
      await page.addInitScript(() => {
        ;(window as typeof window & { open: typeof window.open }).open = (() => null) as typeof window.open
      })
      await openWorkbench(page, DIR)
      await openSettings(page)
      await selectTab(page, "connections")

      await page.getByRole("button", { name: "Connect", exact: true }).click()
      const dialog = page.locator('[data-slot="dialog-container"]').last()
      await dialog.getByRole("button", { name: "Continue with OAuth" }).click()
      await expect(dialog.getByText("Waiting for authorization")).toBeVisible()

      // Prove the loop is genuinely RUNNING first — otherwise "it stopped"
      // would be satisfied by a loop that never started (the same
      // false-positive shape this test exists to close).
      await expect.poll(() => mock.attemptCalls.length, { timeout: 15_000 }).toBeGreaterThanOrEqual(2)

      await dialog.locator('[data-slot="dialog-close-button"]').click()
      await expect(page.locator('[data-slot="dialog-container"]')).toHaveCount(0)

      // `pollAttempt` re-checks `generation` immediately after each
      // `await sleep(pollIntervalMs)` and again after each fetch resolves, so
      // once the cleanup has run no further request is dispatched. Let one
      // in-flight request settle, then hold an observation window several poll
      // intervals wide (pollIntervalMs defaults to 2000ms) and require the
      // counter to be perfectly flat across it. This is an absence-of-events
      // observation, which is inherently time-boxed — there is no event to
      // await for "a request that must never happen".
      await page.waitForTimeout(500)
      const afterClose = mock.attemptCalls.length
      await page.waitForTimeout(7_000)
      expect(mock.attemptCalls.length).toBe(afterClose)
    })

    test("disconnect is a two-step inline confirm; Cancel sends nothing, Confirm DELETEs — behavior 20", async ({ page }) => {
      await installMockRuntime(page, { dir: DIR, sessionId: SESSION_ID })
      await seedProject(page, DIR)
      const mock = mockIntegrations(page, {
        integrations: [{ id: "notion", name: "Notion", methods: ["key"], capabilities: ["docs"] }],
        connections: [{ id: "conn-1", integrationId: "notion", scope: "team", status: "connected" }],
      })
      await mock.install()
      await openWorkbench(page, DIR)
      await openSettings(page)
      await selectTab(page, "connections")

      await page.getByRole("button", { name: "Disconnect", exact: true }).click()
      await expect(page.getByText("Disconnect?")).toBeVisible()

      await page.getByRole("button", { name: "Cancel" }).click()
      await expect(page.getByText("Disconnect?")).toHaveCount(0)
      expect(mock.disconnectCalls.length).toBe(0)

      await page.getByRole("button", { name: "Disconnect", exact: true }).click()
      await page.getByRole("button", { name: "Confirm" }).click()
      await expect.poll(() => mock.disconnectCalls.length, { timeout: 10_000 }).toBe(1)
      expect(mock.disconnectCalls[0]).toBe("conn-1")
      await expect(page.getByText("Notion disconnected")).toBeVisible()
    })
  })

  test.describe("Sandbox: default provider, credential CRUD, read-only lock, network policy", () => {
    test("switching provider offers 'Use for new workspaces', PUTs default, and clears — behavior 21", async ({ page }) => {
      await installMockRuntime(page, { dir: DIR, sessionId: SESSION_ID })
      await seedProject(page, DIR)
      const sandbox = mockSandboxDrivers(page, {
        default_driver: "docker",
        drivers: [
          { id: "docker", label: "Docker", fields: [{ key: "token", label: "Token", secret: true }], configured: true, source: "config", default: true },
          // Configured on purpose: switching the active provider without
          // retyping a stored key is exactly what this affordance is for, and
          // it only renders for a provider that already has credentials.
          { id: "e2b", label: "E2B", fields: [{ key: "token", label: "Token", secret: true }], configured: true, source: "config", default: false },
        ],
      })
      await sandbox.install()
      await openWorkbench(page, DIR)
      await openSettings(page)
      await selectTab(page, "compute")

      const useForNew = page.getByRole("button", { name: "Use for new workspaces" })
      await expect(useForNew).toHaveCount(0)
      // Scoped to the ACTIVE tabs-content panel, not a bare `.first()`:
      // inactive `Tabs.Content` panels stay mounted (Kobalte hides them via
      // the `hidden` attribute, not removal — see the mobile-menu fix
      // above), so an unscoped `[data-slot="select-select-trigger"]` matches
      // selects from every mounted panel and `.first()`'s resolution is
      // genuinely unstable across retries (verified live: consecutive polls
      // resolved to two DIFFERENT trigger elements with different ids).
      await page.locator('[data-slot="tabs-content"]:not([hidden]) [data-slot="select-select-trigger"]').first().click()
      // `{ force: true }`: this Select's options don't settle under
      // Playwright's hover-stability check (same symptom as the
      // color-scheme popover above — verified live, "element is not
      // stable" then "element was detached from the DOM, retrying", never
      // settling within the full test timeout) — a `packages/ui` Select
      // popover behavior, not specific to this row's own `onHighlight`
      // wiring (this Select has none).
      await page.locator('[data-slot="select-select-item"]').filter({ hasText: "E2B" }).click({ force: true })

      await expect(useForNew).toBeVisible()
      await useForNew.click()

      await expect.poll(() => sandbox.putDefaultCalls.length, { timeout: 10_000 }).toBe(1)
      expect(sandbox.putDefaultCalls[0]).toMatchObject({ driver: "e2b" })
      await expect(page.getByText("Default sandbox provider updated")).toBeVisible()
      // E2B is the active provider now, so the affordance retires itself.
      await expect(useForNew).toHaveCount(0)
    })

    test("credential CRUD: Save PUTs auth, Remove DELETEs — behavior 22", async ({ page }) => {
      await installMockRuntime(page, { dir: DIR, sessionId: SESSION_ID })
      await seedProject(page, DIR)
      const sandbox = mockSandboxDrivers(page, {
        default_driver: "docker",
        drivers: [{ id: "docker", label: "Docker", fields: [{ key: "token", label: "Token", secret: true }], configured: false, source: "config", default: true }],
      })
      await sandbox.install()
      await openWorkbench(page, DIR)
      await openSettings(page)
      await selectTab(page, "compute")

      // No Configure step: the selected provider's form is always open.
      await page.locator('input[type="password"]').first().fill("provider-token-value")
      await page.getByRole("button", { name: "Save", exact: true }).click()

      await expect.poll(() => sandbox.putAuthCalls.length, { timeout: 10_000 }).toBe(1)
      expect(sandbox.putAuthCalls[0].driverId).toBe("docker")
      await expect(page.getByText("Docker credentials saved")).toBeVisible()

      await expect(page.getByRole("button", { name: "Remove" })).toBeVisible()
      await page.getByRole("button", { name: "Remove" }).click()
      await expect.poll(() => sandbox.deleteAuthCalls.length, { timeout: 10_000 }).toBe(1)
      await expect(page.getByText("Docker credentials removed")).toBeVisible()
    })

    test("non-loopback base URL locks every sandbox mutation control and shows the read-only notice — behavior 23", async ({ page }) => {
      await installMockRuntime(page, { dir: DIR, sessionId: SESSION_ID })
      await seedProject(page, DIR, { serverUrl: "https://cloud.claxedo-e2e-test.invalid" })
      const sandbox = mockSandboxDrivers(page, {
        default_driver: "docker",
        drivers: [{ id: "docker", label: "Docker", fields: [{ key: "token", label: "Token", secret: true }], configured: true, source: "config", default: true }],
      })
      await sandbox.install()
      await openWorkbench(page, DIR)
      await openSettings(page)
      await selectTab(page, "compute")

      await expect(
        page.getByText("Signed hosted sessions can view local sandbox providers but cannot change local credentials."),
      ).toBeVisible()
      // Scoped to the active panel — see behavior 21's fix above for why a
      // bare `.first()` is unstable here.
      await expect(page.locator('[data-slot="tabs-content"]:not([hidden]) [data-slot="select-select-trigger"]').first()).toBeDisabled()
      // The always-open form replaced the Update toggle, so the lock has to
      // reach the credential input itself, not just the buttons around it.
      await expect(page.locator('[data-slot="tabs-content"]:not([hidden]) input[type="password"]').first()).toBeDisabled()
      await expect(page.getByRole("button", { name: "Remove" })).toBeDisabled()
    })

    test("Network Policy inside the workspace-less Sandbox tab always allows adding an entry — behavior 24", async ({ page }) => {
      await installMockRuntime(page, { dir: DIR, sessionId: SESSION_ID })
      await seedProject(page, DIR)
      const sandbox = mockSandboxDrivers(page, { default_driver: "docker", drivers: [] })
      await sandbox.install()
      let policyPostCount = 0
      await page.route(
        "**/api/claxedo/network-policy**",
        withCors((route) => {
          const url = new URL(route.request().url())
          if (url.pathname === "/api/claxedo/network-policy/groups") return json(route, { groups: { registries: ["npmjs.org"] } })
          if (route.request().method() === "POST") {
            policyPostCount += 1
            return json(route, { ok: true })
          }
          return json(route, { policies: [] })
        }),
      )
      await openWorkbench(page, DIR)
      await openSettings(page)
      await selectTab(page, "compute")

      await expect(page.getByText(/Only workspace admins and owners can edit network policy\./)).toHaveCount(0)
      const addButton = page.getByRole("button", { name: "Add", exact: true })
      await expect(addButton).toBeDisabled()
      await page.locator('input[placeholder="api.example.com"]').fill("api.example.com")
      await expect(addButton).toBeEnabled()
      await addButton.click()
      await expect.poll(() => policyPostCount, { timeout: 10_000 }).toBe(1)
    })
  })

  test.describe("/login", () => {
    test("already-signed visitors are redirected before Continue ever renders — behavior 25", async ({ page }) => {
      await page.route("**/api/claxedo/bootstrap**", (route) =>
        json(route, {
          healthy: true,
          version: "1.0.0-test",
          path: { state: "", config: "", worktree: "", directory: "", home: "/tmp" },
          project: [],
          provider: { all: {}, default: {}, connected: [] },
          provider_auth: {},
          config: {},
        }),
      )
      await recordContinueButtonFlash(page)
      await page.goto("/login")
      await page.waitForLoadState("domcontentloaded")
      // Signed (default test-bypass) visitor: the component body's synchronous
      // `if (auth.status() === "signed") { navigate(...); return null }`
      // (src/app/routes/login.tsx:37-40) redirects and returns before the JSX
      // is ever created — the URL moves off /login.
      await expect(page).not.toHaveURL(/\/login$/, { timeout: 15_000 })
      // ...and the "BEFORE Continue ever renders" half, which the URL check
      // alone says nothing about: the observer installed before the app's
      // first script never saw a Continue button attached.
      expect(await continueButtonFlashed(page)).toBe(false)
    })

    test("not-signed visitors see Continue, which triggers sign-in — behavior 25", async ({ page }) => {
      await disableTestAuthBypass(page)
      // POSITIVE CONTROL for the no-flash observer used by the signed-visitor
      // test above: the same detector, on the page where Continue DOES render,
      // must latch true. Without this pairing, that test's `toBe(false)` could
      // be passing because the observer is broken rather than because nothing
      // flashed.
      await recordContinueButtonFlash(page)
      await page.goto("/login")
      await page.waitForLoadState("domcontentloaded")
      await expect(page).toHaveURL(/\/login$/)

      const continueButton = page.getByRole("button", { name: "Continue" })
      await expect(continueButton).toBeVisible()
      expect(await continueButtonFlashed(page)).toBe(true)
      await expect(page.getByRole("link", { name: /Terms of Service/i })).toBeVisible()

      await continueButton.click()
      // No Clerk key in this harness ⇒ the redirect is a no-op and the button's
      // "Redirecting..." state clears within a microtask — asserting that label
      // was racy by construction on starved runners. The race-free contract is
      // that the click INVOKED sign-in, recorded by the e2e seam in
      // auth-client.ts (__claxedoSignInCalls, DEV || VITE_CLAXEDO_E2E gated).
      await expect.poll(async () => (await signInCalls(page)).length).toBe(1)
      // `/login` passes its own `redirectUrl()` (default "/",
      // src/app/routes/login.tsx:29 + :44) — assert the ARGUMENT too, not just
      // that something was called.
      expect((await signInCalls(page))[0]?.redirectUrl).toBe("/")
    })
  })

  test.describe("/cli-login", () => {
    test("missing/invalid params are rejected immediately with zero auth calls — behavior 26", async ({ page }) => {
      await page.goto("/cli-login")
      await page.waitForLoadState("domcontentloaded")
      await expect(page.getByText("Claxedo CLI")).toBeVisible()
      await expect(page.getByText("Invalid CLI sign-in callback.")).toBeVisible()
      // "zero auth calls" is half of this behavior's own title and was
      // previously not asserted at all. The `__claxedoSignInCalls` seam is the
      // same one the `/login` test above uses POSITIVELY (it asserts exactly
      // one recorded call), so a zero here is a real zero, not a
      // never-instrumented one. Settle first — the rejection is synchronous in
      // the page's createEffect but a regression that called signIn would do so
      // asynchronously, and an instant read could miss it.
      await expect.poll(async () => (await signInCalls(page)).length, { timeout: 3_000 }).toBe(0)
    })

    test("a non-loopback callback origin is rejected the same way, with zero auth calls — behavior 26", async ({ page }) => {
      await page.goto("/cli-login?callback=https%3A%2F%2Fevil.example.com%2Fcb&state=abc123")
      await page.waitForLoadState("domcontentloaded")
      await expect(page.getByText("Invalid CLI sign-in callback.")).toBeVisible()
      // The security-relevant half: an attacker-supplied callback origin must
      // not even start an auth handshake. See the note above on why this zero
      // is non-vacuous.
      await expect.poll(async () => (await signInCalls(page)).length, { timeout: 3_000 }).toBe(0)
    })

    test("not-signed visitor with valid params calls signIn with the current URL as redirectUrl — behavior 27", async ({ page }) => {
      await disableTestAuthBypass(page)
      await page.goto("/cli-login?callback=http%3A%2F%2F127.0.0.1%3A61234%2Fcb&state=abc123")
      await page.waitForLoadState("domcontentloaded")
      await expect(page.getByText("Opening Claxedo sign-in...")).toBeVisible({ timeout: 10_000 })

      // The status string alone proves only that the page took the
      // not-signed branch. Behavior 27 claims the CALL and its ARGUMENT:
      // `void auth.signIn({ redirectUrl: window.location.href })`
      // (src/app/routes/cli-login.tsx:27). A regression that dropped the
      // argument would fall back to `signIn`'s own default
      // (`window.location.origin`, src/platform/auth/auth-client.ts:341) and
      // silently strand the CLI handshake — the callback/state query would be
      // lost across the round trip — while still painting this exact status.
      await expect.poll(async () => (await signInCalls(page)).length, { timeout: 10_000 }).toBe(1)
      const redirectUrl = (await signInCalls(page))[0]?.redirectUrl ?? ""
      expect(redirectUrl).toContain("/cli-login")
      expect(redirectUrl).toContain("callback=http%3A%2F%2F127.0.0.1%3A61234%2Fcb")
      expect(redirectUrl).toContain("state=abc123")
    })

    test("signed visitor with valid params exchanges a CLI token and auto-submits the callback form — behavior 28", async ({ page }) => {
      let exchangeCalls = 0
      let exchangeAuth: string | null = null
      await page.route(
        "**/api/auth/cli/exchange",
        withCors(async (route) => {
          exchangeCalls += 1
          exchangeAuth = route.request().headers()["authorization"] ?? null
          // Real delay on the mock response (not a test-side wait — see the
          // Clerk mock's identical fix above): an instant response lets the
          // whole approving→exchange→auto-submit→navigate chain finish
          // before "Approving CLI sign-in..." ever paints (verified live —
          // the assertion's own call log showed the page had ALREADY
          // navigated to the callback URL by the time it polled).
          await new Promise((resolve) => setTimeout(resolve, 300))
          return json(route, { access_token: "cli-access-token-xyz", token_type: "bearer", expires_in: 3600 })
        }),
      )
      let callbackHit: URLSearchParams | undefined
      await page.route("**/local-cli-callback**", async (route) => {
        callbackHit = new URL(route.request().url()).searchParams
        if (route.request().method() === "POST") {
          callbackHit = new URLSearchParams(route.request().postData() ?? "")
        }
        return route.fulfill({ status: 200, contentType: "text/plain", body: "ok" })
      })

      await page.goto("/cli-login?callback=http%3A%2F%2F127.0.0.1%3A61234%2Flocal-cli-callback&state=state-xyz")
      await page.waitForLoadState("domcontentloaded")
      await expect(page.getByText("Approving CLI sign-in...")).toBeVisible({ timeout: 10_000 })

      await expect.poll(() => exchangeCalls, { timeout: 10_000 }).toBe(1)
      expect(exchangeAuth).toMatch(/^Bearer /)
      await expect.poll(() => callbackHit?.get("access_token"), { timeout: 10_000 }).toBe("cli-access-token-xyz")
      expect(callbackHit?.get("state")).toBe("state-xyz")
      expect(callbackHit?.get("identity")).toBeTruthy()
    })

    test("an exchange failure surfaces the server's error message and never submits a form — behavior 29", async ({ page }) => {
      let formSubmitted = false
      await page.route(
        "**/api/auth/cli/exchange",
        withCors((route) =>
          route.fulfill({
            status: 401,
            contentType: "application/json",
            headers: corsHeaders(),
            body: JSON.stringify({ error: { message: "The browser session has expired." } }),
          }),
        ),
      )
      await page.route("**/local-cli-callback**", async (route) => {
        formSubmitted = true
        return route.fulfill({ status: 200, contentType: "text/plain", body: "ok" })
      })

      await page.goto("/cli-login?callback=http%3A%2F%2F127.0.0.1%3A61234%2Flocal-cli-callback&state=state-xyz")
      await page.waitForLoadState("domcontentloaded")

      await expect(page.getByText("The browser session has expired.")).toBeVisible({ timeout: 10_000 })
      expect(formSubmitted).toBe(false)
    })

  })

  test.describe("signed gate (CloudAuthGate)", () => {
    test("a loopback-transport session never redirects to /login, even for an anonymous principal — behavior 30", async ({ page }) => {
      await installMockRuntime(page, { dir: DIR, sessionId: SESSION_ID })
      await seedProject(page, DIR)
      await disableTestAuthBypass(page)
      await openWorkbench(page, DIR)

      await expect(page).not.toHaveURL(/\/login$/)
      await expect(page.getByRole("textbox", { name: /Ask anything/i }).last()).toBeVisible({ timeout: 20_000 })
    })

    // Entry #19 (decision A). Provable now via an e2e-only runtime server-URL
    // override: `resolveDefaultUrl()` (src/app/entry/app.tsx) reads
    // `window.__CLAXEDO_E2E_SERVER_URL__` in a dev/e2e build, so a spec can
    // force ServerProvider's resolved default (hence CloudAuthGate's
    // `server.url`) to a non-loopback host. Baked out of production.
    test("an anonymous principal on a non-loopback transport is force-redirected to /login — behavior 30b", async ({ page }) => {
      await installMockRuntime(page, { dir: DIR, sessionId: SESSION_ID })
      await seedProject(page, DIR)
      await disableTestAuthBypass(page)
      // Force the resolved default server to a NON-loopback host, so
      // centralTransportForServer(server.url) !== "loopback" ⇒ needsSignedAuth().
      await page.addInitScript(() => {
        ;(window as typeof window & { __CLAXEDO_E2E_SERVER_URL__?: string }).__CLAXEDO_E2E_SERVER_URL__ =
          "https://cloud.example.test"
      })

      await page.goto(`/${slug(DIR)}/session`)
      await page.waitForLoadState("domcontentloaded")

      // Anonymous + non-loopback ⇒ the signed gate redirects to /login (a brief
      // "Loading..." placeholder shows while the session status resolves first).
      await expect(page).toHaveURL(/\/login$/, { timeout: 20_000 })
      await expect(page.getByRole("button", { name: "Continue" })).toBeVisible({ timeout: 10_000 })
    })
  })

  test.describe("error page (top-level ErrorBoundary fallback)", () => {
    // Entry #20 (decision A). Provable now via the `/__e2e/error-page?variant=`
    // injection route (src/app/routes/error-page-harness.tsx), which mounts the
    // real <ErrorPage> for a chosen InitError variant — the ErrorBoundary
    // fallback content without a real render-time crash. Route is dev/e2e-only.
    test("InitError variants render their formatted chain with Restart (and no Check-for-updates on web) — behavior 31", async ({ page }) => {
      await page.goto("/__e2e/error-page?variant=MCPFailed")
      await page.waitForLoadState("domcontentloaded")

      await expect(page.getByTestId("error-page-harness")).toBeVisible({ timeout: 15_000 })
      await expect(page.getByRole("heading", { name: "Something went wrong" })).toBeVisible()

      // The formatted chain for the chosen InitError variant renders in the
      // read-only Error Details field.
      const details = page.getByRole("textbox", { name: "Error Details" })
      await expect(details).toHaveValue(/MCPFailed[\s\S]*MCP server "github" failed/)

      // Restart is always present; Check-for-updates is web-absent
      // (platform.checkUpdate is undefined on the web platform).
      await expect(page.getByRole("button", { name: "Restart" })).toBeVisible()
      await expect(page.getByRole("button", { name: "Check for updates" })).toHaveCount(0)

      // A different variant re-renders a distinct cause-chain through the same
      // route (proves the formatter's `Caused by:` nesting, not just one shape).
      await page.goto("/__e2e/error-page?variant=causeChain")
      await page.waitForLoadState("domcontentloaded")
      await expect(page.getByRole("textbox", { name: "Error Details" })).toHaveValue(
        /Failed to reach provider[\s\S]*Caused by:[\s\S]*socket hang up/,
      )
    })
  })
})
