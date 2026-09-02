/**
 * SPEC: Workspace lifecycle — project/workspace creation, editing, deletion, recovery
 *
 * PURPOSE — everything a user does to a *project* or *workspace* entry in the rail
 * sidebar that isn't sending a prompt: registering a new project directory, adding a
 * new local/cloud workspace to an existing project, renaming a project, deleting a
 * workspace (or destroying a cloud sandbox), removing a project entirely, and
 * recovering a workspace whose backing local worktree has gone missing on disk.
 *
 * STATE MODEL —
 *   - A "project" is a git worktree root the client knows about. Membership lives in
 *     TWO places that must agree: (a) `opencode.global.dat:server` localStorage (the
 *     user-local list of open/closed project worktrees + expand state, read/written by
 *     `server.projects.*` in `src/context/server.tsx`), and (b) the server's `/project`
 *     (`GET`) list, which the client treats as the source of truth for which worktrees
 *     even exist — `projectCatalog()` (`src/context/layout-projects.ts`) requires a
 *     worktree be present in the server list (`meta.has(root)`) before it can appear in
 *     the sidebar at all, and a **cross effect prunes any localStorage-listed project
 *     whose worktree the server no longer reports** (`src/context/layout.tsx`, "Effect
 *     2: Remove sidebar projects that no longer exist in API", runs even when
 *     `server.isLocal()`). A project's `sandboxes`/`workspaces` map (secondary
 *     worktrees, cloud sandboxes, availability) comes entirely from the server's
 *     `/project` payload — nothing about them is ever persisted client-side.
 *   - `validWorktree()` (`src/utils/worktree.ts`) is the client-side gate for "is this
 *     an addressable local worktree at all": non-empty, absolute (`/...`,
 *     `C:\...`/`C:/...`, or `\\...`), no NUL byte, not `/`, not a bare drive root, no
 *     `.`/`..` path segment, and never the literal `/workspace` (the cloud sandbox
 *     container's reserved `WORKSPACE_DIR`). Because `projectCatalog()` also runs this
 *     filter when building its `meta` map (`src/context/layout-projects.ts:47`), an
 *     invalid worktree can never become a registered *project* — the ONLY place
 *     `validWorktree()` can still reject a user choice at runtime is the raw directory
 *     search inside "+ New project"'s picker, before a project is registered.
 *   - Each project's `workspaces[dir]` record (`WorkspaceInfo`, `rail-sidebar.tsx:172`)
 *     carries `kind: "local" | "cloud" | "user-hosted"` and `available?: boolean`. A
 *     `local` workspace with `available === false` is the "missing worktree" state
 *     (`missingLocalWorkspace()`, `claxedo-layout-actions/shared.ts:126`) — the backing
 *     directory existed once but is gone from disk; the sidebar still lists it, but
 *     opening a session/terminal on it routes through a recovery dialog instead.
 *   - Deleting/removing/renaming are ALL server-authoritative: the client only ever
 *     reflects what `/project` reports on the next refetch. Two of the three mutation
 *     flows are deliberately **optimistic and fire-and-forget** (see BEHAVIORS 6, 9) —
 *     the sidebar entry disappears and navigation happens synchronously, before the
 *     server call that actually performs the deletion has resolved or even been
 *     awaited by the caller; a server failure surfaces a toast but does not restore the
 *     already-removed UI state.
 *
 * ANATOMY —
 *   `[data-testid="rail-sidebar"]` — sidebar root.
 *   `button[aria-label="New Project"]` — the "+ New project" row (icon `plus-small`).
 *     Source (`src/i18n/en.ts`) defines its label key `workspace.new` as literally
 *     "New workspace", but the LIVE running app renders "New Project" — confirmed via
 *     a standalone probe against this exact dev server (see HARNESS NOTES); this
 *     spec pins the observed runtime text since that is what the test must interact
 *     with, not the static source string. Either way, the copy and the action are
 *     deliberately mismatched: clicking it opens `DialogSelectDirectory`, which
 *     REGISTERS a project, not `DialogNewProject`'s Local/Cloud workspace picker (see
 *     BEHAVIOR 8 for why that dialog is currently unreachable from here despite the
 *     label suggesting otherwise).
 *   `DialogSelectDirectory` (`src/components/dialog-select-directory.tsx`) — title
 *     defaults to `language.t("command.project.open")`, which the cloud-branding
 *     extension override (see HARNESS NOTES) renders as "New Project", not the
 *     "Open project" `src/i18n/en.ts` defines standalone;
 *     `[data-slot="list-search-container"] input` (placeholder "Search folders") — NOT
 *     `[data-slot="list-search-input"]`, which `list.tsx` passes to `<TextField>` but
 *     `TextField` (`packages/ui/src/components/text-field.tsx`) silently discards: its
 *     `<Kobalte.Input {...others} data-slot="input-input" .../>` spreads the caller's
 *     `data-slot` first, then a hardcoded literal `data-slot="input-input"` overrides
 *     it (later JSX props win) — so `[data-slot="list-search-input"]` NEVER matches
 *     anything in the real DOM (confirmed live: `locator(...).toBeVisible()` times out
 *     100% of the time even while the input is visibly rendered on screen, per this
 *     spec's own repeated failures before the fix — a real app testability bug worth
 *     fixing upstream, not a suite flake). This search
 *     drives a fuzzy recent-projects + live filesystem search; each result is a
 *     `button[data-slot="list-item"][data-key="<absolute path>"]`; selecting one calls
 *     `onSelect(absolute)` → `handleNewProject`'s `handleProjectSelected`
 *     (`claxedo-layout-actions/project-actions.tsx:96`): `!validWorktree(dir)` → toast
 *     "Invalid project path" (description = the rejected path) and returns before any
 *     network call; on `platform !== "web"` a failed `ensureLocalProject()` (not a git
 *     repo) → toast "Not a git repository"; otherwise the project opens and a new
 *     session draft is navigated to.
 *   rail account menu → "View options" submenu with a "Group by" radio (`Project` /
 *     `Workspace`). "Project" (default) renders one row per project
 *     (`[data-testid="project-header"]`, always the MAIN worktree). "Workspace" renders
 *     one row per workspace directory (`[data-testid="workspace-header"][data-workspace-
 *     id="<dir>"]`), including secondary/sandbox/missing ones — this is required to
 *     reach any non-main workspace's kebab menu or hover actions.
 *   Per-row hover actions (`HeaderActions`, rendered for both header kinds) —
 *     `button[aria-label="New session in <label>"]`, `"New terminal in <label>"`,
 *     `"New Claude terminal in <label>"`, `"New Codex terminal in <label>"`, and a kebab
 *     `button[aria-label="More options for <label>"]` opening a `role="menuitem"` menu.
 *     `<label>` here is `workspaceDisplayName()`'s WORKSPACE-scoped name, not the
 *     project's display name shown in the row's own text: for the project header
 *     (default "Project" grouping), `<label>` is `workspaces[project.worktree]
 *     .workspace_name ?? "main"` — literally "main" unless that workspace record
 *     carries a custom name — even though the row text next to it shows the
 *     project's `name`/folder. A workspace-grouped row's `<label>` is
 *     `workspaces[dir].workspace_name ?? getFilename(dir)`:
 *       - "Edit" → `DialogEditProject` (title "Edit project"): a `TextField` (default
 *         value = current display name) + `PATCH /project/:projectID` on Save.
 *       - "Delete workspace" (shown when `canDelete`, i.e. any non-main workspace, or a
 *         cloud-backed MAIN workspace) → `DialogDeleteWorkspace`. The kebab MENU ITEM's
 *         own label is always the literal text "Delete workspace" — it never becomes
 *         "Destroy Sandbox" itself; only the DIALOG it opens re-labels for the
 *         cloud-main case (see below). For a non-main local
 *         workspace: title "Delete workspace", body checks `GET /file/status` for
 *         uncommitted changes and shows one of "Checking for unmerged changes...",
 *         "Unmerged changes detected in this workspace.", "No unmerged changes
 *         detected.", or "Unable to verify git status." — the primary button is
 *         disabled while that check is in flight AND again once the delete itself is
 *         in flight. For a cloud-backed MAIN workspace, the SAME dialog instead renders
 *         with title/button "Destroy Sandbox", skips the file-status check entirely,
 *         and its confirm text warns the VM and all data will be deleted.
 *       - "Remove project" (main row only) → no confirmation dialog; removes the
 *         project from the client inventory and navigates away synchronously (see
 *         BEHAVIORS 6, 9).
 *   `DialogRecoverWorkspace` (title "Worktree not found") — shown instead of a new
 *     session/terminal draft when the target workspace is `missingLocalWorkspace()`;
 *     body: `The backing worktree for "<name>" is gone.`; primary button "Continue in
 *     new worktree" re-runs worktree creation (`POST /experimental/worktree`) and waits
 *     for a `worktree.ready`/`worktree.failed` event on the central Claxedo event
 *     stream before opening the recovered session.
 *   `DialogNewProject` (`src/components/dialog-new-project.tsx`, title "New Workspace")
 *     — Local Worktree / Cloud Sandbox choice cards; Cloud is disabled unless
 *     `config.sandboxEnabled`. `DialogCreateCloudWorkspace`
 *     (`src/components/dialog-create-cloud-workspace.tsx`, title "Cloud Workspace") —
 *     provider radio cards (each a `button` with the provider label + "Ready"/"API key
 *     not configured"), a warning paragraph "Configure provider credentials in Settings
 *     before creating cloud workspaces." when zero providers are `configured`, an
 *     optional Name field (placeholder "feature-auth"), and Create/Cancel. On submit it
 *     switches to a 4-step pipeline view ("Acquiring sandbox", "Cloning repository",
 *     "Starting runtime", "Waiting for health check", then "Ready" / "Redirecting to
 *     new session..."), driven by `provision` events on the SAME central event stream;
 *     a `step: "error"` event shows a critical banner with "Retrying automatically..."
 *     and a "Back" button that returns to the form.
 *
 * BEHAVIORS —
 *   1. Selecting a directory-search result whose resolved absolute path fails
 *      `validWorktree()` (e.g. the literal blocked `/workspace`) shows an "Invalid
 *      project path" toast naming the rejected path and creates zero sessions/projects
 *      — the dialog does not even attempt a network call.
 *   2. `handleProjectSelected`'s "not a git repository" branch
 *      (`project-actions.tsx:113`) only runs when `platform.platform !== "web"`; under
 *      this Playwright tier (served by the Vite dev build, always `"web"`) it is
 *      permanently unreachable — not merely hard to set up.
 *   3. Kebab "Edit" renames a project via `PATCH /project/:projectID` and the sidebar
 *      label reflects the new name once the dialog closes.
 *   4. Kebab "Delete workspace" on a non-main local workspace shows the dirty/clean
 *      file-status copy, disables the confirm button while that check is loading and
 *      again while the delete itself is in flight, Cancel closes with zero mutation,
 *      and confirming calls `worktree.remove` and removes the row.
 *   5. Kebab "Delete workspace" on a cloud-backed MAIN workspace renders as "Destroy
 *      Sandbox" (no file-status check) and confirming calls `DELETE
 *      /api/experimental/sandbox` and navigates away with a success toast.
 *   6. Kebab "Remove project" removes the project from the sidebar and navigates away
 *      SYNCHRONOUSLY, before its background `DELETE /api/workspace/:id` call resolves —
 *      a forced server failure surfaces a "Failed to remove project" toast but the
 *      already-removed sidebar row does not come back (fire-and-forget by design).
 *   7. "New session in <label>" on a workspace whose `workspaces[dir].available` is
 *      `false` opens `DialogRecoverWorkspace` instead of a draft composer; confirming
 *      re-creates the worktree and opens a session at the recreated directory once a
 *      `worktree.ready` event names it.
 *   8/9. DELETED per docs/e2e-decisions.md #16 (2026-07-20): `DialogNewProject`'s
 *      Local/Cloud picker, `DialogCreateCloudWorkspace`, `handleNewWorkspace` (and its
 *      hang-prone `onWorktreeCreated(..., wait=true)` branch), and the `onNewWorkspace`
 *      threading (`app-shell.tsx` → `rail-sidebar-shell.tsx` → `rail-sidebar.tsx`) were
 *      all dead code — confirmed zero reachable UI trigger and zero call sites for the
 *      wait=true branch outside the dead path. Live workspace creation goes through the
 *      session composer's environment selector (`submit-directory.ts`'s
 *      `resolveCloudSessionDirectory` for cloud; `handleNewLocalWorkspace`/
 *      `handleNewCloudWorkspace` in `project-actions.tsx` for the direct-create paths),
 *      covered by `core-cloud-provisioning.spec.ts` and this file's live tests.
 *
 * INVARIANTS — a project can never be listed with an invalid worktree (the client-side
 *   catalog gate applies to both the API-sourced `meta` map and the localStorage-
 *   sourced `current` list, per STATE MODEL); optimistic mutations (BEHAVIORS 5, 6) may
 *   diverge from server truth until the next `/project` refetch — this suite treats
 *   that divergence as intentional product behavior, not a bug, per BEHAVIOR 6.
 *
 * HARNESS NOTES — workspace lifecycle is otherwise harness-agnostic (it operates on
 *   projects/worktrees, not sessions). One real, BY-DESIGN string override worth
 *   flagging so nobody "fixes" these selectors back: `src/index.tsx` calls
 *   `setExtensions({ app: appExtensions(config), ... })`, and `appExtensions()`
 *   (`src/extensions/app.tsx`) sets `strings: cloudStrings` from
 *   `src/i18n/cloud-strings.ts` — which overrides BOTH `workspace.new` AND
 *   `command.project.open` to the literal string `"New Project"` (per-locale; the `en`
 *   entry reads `"workspace.new": "New Project", "command.project.open": "New
 *   Project"`). `src/context/language.tsx`'s `dict` memo layers `ext.app.strings?.[
 *   current]` on top of the base `en.ts`/`@opencode-ai/ui` dictionaries, so BOTH the
 *   "+ New project" button AND `DialogSelectDirectory`'s title render "New Project" —
 *   not the "New workspace"/"Open project" `src/i18n/en.ts` defines standalone. Every
 *   selector in this file pins the actual rendered (cloud-branded) string.
 *
 * OUT OF SCOPE — composer-driven create-cloud-workspace-at-submit-time pipeline and its
 *   reload-mid-provisioning/create-failure handling (`core-cloud-provisioning`);
 *   harness/config-option ownership across a cloud/relay session
 *   (`core-harness-ownership-cloud`); relay offline/403/role gating
 *   (`core-cloud-offline-roles`); user-hosted connect pipeline
 *   (`core-user-hosted-workspace`); sidebar view-options persistence/group-by mechanics
 *   beyond the minimum needed to reach a non-main workspace row (`core-sidebar-tree`
 *   owns the full view-options surface); the directory-search fuzzy-matching algorithm
 *   itself (only its `validWorktree` boundary is pinned here).
 */
import { sessionListRoute } from "../helpers/contracts/session-list"
import { isOrgListPath, orgListResponse } from "../helpers/contracts/org-list"
import { expect, test, type Page } from "@playwright/test"

const DIR = "/tmp/e2e-core-lifecycle-main"
const PROJECT_ID = "proj_core_lifecycle"
const PROJECT_NAME = "core-lifecycle-main"

function slug(value: string) {
  return Buffer.from(value, "utf-8").toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=/g, "")
}

function api(request: { resourceType: () => string }) {
  const type = request.resourceType()
  return type === "fetch" || type === "xhr"
}

function json(route: import("@playwright/test").Route, body: unknown, status = 200) {
  return route.fulfill({ status, contentType: "application/json", body: JSON.stringify(body) })
}

type SeedProject = {
  id?: string
  worktree?: string
  name?: string
  sandboxes?: string[]
  workspaces?: Record<string, {
    id?: string
    workspaceId?: string
    directory?: string
    workspace_name?: string | null
    kind?: "local" | "cloud" | "user-hosted"
    available?: boolean
  }>
}

/** Seeds localStorage with one open project at DIR — same shape every core-* spec uses. */
async function seedProject(page: Page, dir: string = DIR) {
  await page.addInitScript((d: string) => {
    localStorage.clear()
    ;(window as typeof window & { __OPENCODE__?: { serverUrl?: string; activeDirectory?: string } }).__OPENCODE__ = {
      serverUrl: window.location.origin,
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
  }, dir)
}

/**
 * Minimal standalone runtime mock for this spec's surface: bootstrap/project/session-
 * list/provider/config/global-event plumbing (same shapes `installMockRuntime` uses,
 * duplicated narrowly here because this spec's project record needs custom
 * `sandboxes`/`workspaces` fields the shared helper's fixture does not expose a knob
 * for — see findings). No prompt/turn flow is exercised in this spec, so the shared
 * turn-streaming machinery is intentionally not installed.
 */
async function installLifecycleMock(page: Page, project: SeedProject = {}) {
  const proj = {
    id: project.id ?? PROJECT_ID,
    worktree: project.worktree ?? DIR,
    name: project.name ?? PROJECT_NAME,
    sandboxes: project.sandboxes ?? [],
    workspaces: project.workspaces ?? {},
    time: { created: Date.now(), updated: Date.now() },
  }

  const bootstrapBody = {
    healthy: true,
    version: "1.0.0-test",
    path: { state: "", config: "", worktree: DIR, directory: DIR, home: "/tmp" },
    project: [proj],
    provider: {
      all: [{ id: "opencode", name: "opencode", env: [], models: { "big-pickle": { id: "big-pickle", name: "Big Pickle", release_date: "2026-01-01", attachment: true, reasoning: true, temperature: true, tool_call: true, limit: { context: 200000, output: 8192 }, cost: { input: 0, output: 0 }, options: {} } } }],
      default: { opencode: "big-pickle" },
      connected: ["opencode"],
    },
    provider_auth: { opencode: [{ type: "api", label: "API key" }] },
    config: { provider: { id: "opencode", model: "big-pickle" }, agent: { id: "build" } },
  }

  await page.route("**/api/claxedo/bootstrap**", (r) => (api(r.request()) ? json(r, bootstrapBody) : r.continue()))

  const handleProjectList = (r: import("@playwright/test").Route) => {
    if (!api(r.request())) return r.continue()
    if (r.request().method() !== "GET") return r.fallback()
    return json(r, [proj])
  }
  await page.route("**/project", handleProjectList)
  await page.route("**/project?**", handleProjectList)
  // A PATCH to `/project/:id` fires unprompted on EVERY load (some "touch project"
  // call unrelated to the Edit dialog — confirmed live: it fires even when a test
  // never opens Edit at all), so this generic fallback lives here, not only in the
  // Edit-rename test. Tests that assert on the PATCH body (Edit rename) register
  // their OWN more specific `**/project/${PROJECT_ID}**` route AFTER this one runs,
  // which — per Playwright's route-matching order (last-registered runs first) —
  // correctly takes priority for those tests.
  await page.route("**/project/*", (r) => {
    if (!api(r.request())) return r.continue()
    if (r.request().method() !== "PATCH") return r.fallback()
    return json(r, proj)
  })
  // `/project/current` — a DIFFERENT endpoint from the list above (SDK
  // `Project.current()`), fired unprompted on load by something that reads the
  // active project. Trailing `**` throughout this file matters: Playwright glob
  // routes are fully anchored (`^...$`), so a pattern ending in the bare path
  // segment does NOT match a URL with a trailing `?query` — confirmed live via a
  // standalone probe against this exact dev server: unmocked, `/provider`,
  // `/config`, and `/project/:id` (all called WITH query params in this real
  // build) silently fell through to a real `http://127.0.0.1:3001` connection
  // that refuses (nothing listens there in this environment) — `getClaxedoServerUrl()`
  // in `src/utils/api.ts` hardcodes that host as its final fallback when no
  // `VITE_CLAXEDO_SERVER_URL`/desktop-sidecar config is present, so anything
  // this mock fails to intercept silently leaks onto real network I/O.
  await page.route("**/project/current**", (r) => (api(r.request()) ? json(r, proj) : r.continue()))
  await page.route("**/experimental/project", handleProjectList)
  await page.route("**/experimental/project?**", handleProjectList)

  await page.route("**/health**", (r) => (api(r.request()) ? json(r, { healthy: true }) : r.continue()))
  // `DialogSelectDirectory`'s search box (behavior 1) fires an initial empty-query
  // lookup against `/find/file` the instant it opens, before any typing — a
  // DIFFERENT endpoint from `/file` (which only the "contains a path segment"
  // branch of `useDirectorySearch` hits, mocked per-test where needed).
  await page.route("**/find/file**", (r) => (api(r.request()) ? json(r, []) : r.continue()))
  await page.route("**/path**", (r) => {
    if (!api(r.request())) return r.continue()
    if (new URL(r.request().url()).pathname !== "/path") return r.fallback()
    return json(r, { worktree: DIR })
  })
  await page.route("**/agent**", (r) => {
    if (!api(r.request())) return r.continue()
    if (!["/agent", "/app/agents"].includes(new URL(r.request().url()).pathname)) return r.fallback()
    return json(r, [{ id: "build", name: "build", description: "Build agent" }])
  })
  await page.route("**/provider**", (r) => {
    if (!api(r.request())) return r.continue()
    if (new URL(r.request().url()).pathname !== "/provider") return r.fallback()
    return json(r, bootstrapBody.provider)
  })
  await page.route("**/provider/auth**", (r) => {
    if (!api(r.request())) return r.continue()
    if (new URL(r.request().url()).pathname !== "/provider/auth") return r.fallback()
    return json(r, bootstrapBody.provider_auth)
  })
  await page.route("**/config**", (r) => {
    if (!api(r.request())) return r.continue()
    if (new URL(r.request().url()).pathname !== "/config") return r.fallback()
    return json(r, bootstrapBody.config)
  })
  await page.route("**/mcp**", (r) => (api(r.request()) && new URL(r.request().url()).pathname === "/mcp" ? json(r, {}) : r.continue()))
  await page.route("**/lsp**", (r) => (api(r.request()) && new URL(r.request().url()).pathname === "/lsp" ? json(r, []) : r.continue()))
  await page.route("**/vcs**", (r) => (api(r.request()) && new URL(r.request().url()).pathname === "/vcs" ? json(r, {}) : r.continue()))
  await page.route("**/command**", (r) => (api(r.request()) && new URL(r.request().url()).pathname === "/command" ? json(r, []) : r.continue()))
  await page.route("**/permission**", (r) => (api(r.request()) && new URL(r.request().url()).pathname === "/permission" ? json(r, []) : r.continue()))
  await page.route("**/question**", (r) => (api(r.request()) && new URL(r.request().url()).pathname === "/question" ? json(r, []) : r.continue()))
  // Workspace resolve — BOTH twins. `workspaceResolveUrl`
  // (src/platform/runtime/agent/workspace-control-routes.ts:33-50) rewrites the
  // path to `/api/claxedo/workspace/resolve` whenever the server base URL is a
  // loopback transport — which the default `http://127.0.0.1:3001` control-plane
  // origin always is under this Playwright tier. Without the claxedo twin every
  // resolve (workspace-connection's `prepareWorkspaceRuntime` drive loop,
  // http-backend's vcs/mcp/lsp warmups) escapes onto the dead real network, so a
  // cloud-backed workspace never reaches "ready", never mints its connection, and
  // role-gated UI (the "Delete workspace" kebab item behind `canMutateWorkspace`,
  // rail-sidebar.tsx:1558) never renders — the exact behavior-5 failure. The
  // response mirrors the server's canonical projection (`workspaceResponse`,
  // packages/claxedo-server-core/src/workspace/store/response.ts): workspaceId/
  // projectId/directory/workspaceName/access/backing/kind/driver/status/git —
  // derived from THIS fixture's seeded `workspaces` map so a project seeded with a
  // cloud main workspace resolves as cloud (same twin-stub pattern as
  // e2e/helpers/mock-runtime.ts:2014-2015, added in 9410092).
  const resolveHandler = (r: import("@playwright/test").Route) => {
    if (!api(r.request())) return r.continue()
    const url = new URL(r.request().url())
    const wantedId = url.searchParams.get("workspaceId") ?? undefined
    const wantedDir = url.searchParams.get("directory") ?? undefined
    const hit = Object.entries(proj.workspaces as NonNullable<SeedProject["workspaces"]>).find(([key, ws]) =>
      (wantedId && (ws.workspaceId === wantedId || ws.id === wantedId || key === wantedId)) ||
      (wantedDir && ((ws.directory ?? key) === wantedDir)),
    )
    const record = hit?.[1]
    const directory = record?.directory ?? hit?.[0] ?? wantedDir ?? DIR
    const kind = record?.kind ?? "local"
    const backing = kind === "cloud" ? { kind: "cloud-vm" } : kind === "user-hosted" ? { kind: "user-hosted" } : { kind: "local-worktree" }
    return json(r, {
      workspaceId: record?.workspaceId ?? record?.id ?? `local-${proj.id}`,
      projectId: proj.id,
      directory,
      workspaceName: record?.workspace_name ?? null,
      access: kind === "cloud" ? "cloud" : kind === "user-hosted" ? "user-hosted" : "local",
      backing,
      kind,
      driver: null,
      status: "ready",
      git: { repo: null, branch: null, remote: null },
    })
  }
  await page.route("**/api/workspace/resolve**", resolveHandler)
  await page.route("**/api/claxedo/workspace/resolve**", resolveHandler)
  await page.route("**/api/claxedo/agent-config/**", (r) => (api(r.request()) ? json(r, { source: "runner", stale: false, options: [] }) : r.continue()))

  const eventStreamHandler = async (route: import("@playwright/test").Route) => {
    if (!api(route.request())) return route.continue()
    await route.fulfill({ status: 200, contentType: "text/event-stream", body: ": heartbeat\n\n" }).catch(() => {})
  }
  // One stream, three spellings. Both real servers mount a SINGLE handler on
  // `/global/event`, `/api/wr/events` and `/api/claxedo/events`
  // (claxedo-local-server src/opencode/compat-routes/index.ts, claxedo-server
  // src/routes/hosted/shell.ts), so every spelling the app may connect on has
  // to answer here or the central stream falls through to the real, unreachable
  // 127.0.0.1:3001.
  await page.route("**/global/event?**", eventStreamHandler)
  await page.route("**/event?**", eventStreamHandler)
  await page.route("**/api/wr/events**", eventStreamHandler)
  await page.route("**/api/claxedo/events**", eventStreamHandler)
  // The rail's org/team switcher mounts with the header actions this spec
  // drives, and its read was leaking onto the real (unreachable) backend as a
  // vite proxy ECONNREFUSED. `[]` is the authority's own answer for a principal
  // in no organization — see ../helpers/contracts/org-list.ts.
  await page.route("**/api/control/orgs**", (r) => {
    if (!api(r.request())) return r.continue()
    if (!isOrgListPath(new URL(r.request().url()).pathname)) return r.fallback()
    return json(r, orgListResponse())
  })
  // Review/diff panel calls — benign-empty so the panel shows "no changes"
  // instead of leaking onto the real (unreachable) backend.
  await page.route("**/api/wr/diff/**", (r) => {
    if (!api(r.request())) return r.continue()
    const pathname = new URL(r.request().url()).pathname
    const body = pathname.endsWith("/refs") ? { branches: [], tags: [], recent: [] } : pathname.endsWith("/targets") ? {} : []
    return json(r, body)
  })

  const handleSessionList = (r: import("@playwright/test").Route) => (api(r.request()) ? json(r, []) : r.continue())
  await page.route("**/session", handleSessionList)
  await page.route("**/session?**", handleSessionList)
  await page.route("**/experimental/session", handleSessionList)
  await page.route("**/experimental/session?**", handleSessionList)
  await page.route("**/session/*/message**", (r) => (api(r.request()) ? json(r, []) : r.continue()))
  await page.route("**/session/*/capabilities**", (r) => (api(r.request()) ? json(r, { transport: "opencode" }) : r.continue()))
  await page.route("**/session/status**", (r) => (api(r.request()) ? json(r, {}) : r.continue()))

  // The sidebar is docked/visible by default (`sidebarPinned()` in
  // `src/shell/app-shell-layout.tsx` defaults true), so every ProjectBlock/
  // WorkspaceBlock row mounts immediately and queries these two DISTINCT
  // endpoints (`sessionListQueryOptions` in `src/shared/query/session-list.ts`
  // always hits `/api/control/session-list`, signed or not; something else
  // separately hits the plural `/api/control/sessions` — both confirmed live via
  // the same standalone probe referenced above).
  await page.route(sessionListRoute, (r) =>
    api(r.request())
      ? json(r, { view: { scope: "workspace", groupBy: "none", sort: "updated_desc", limit: 50 }, items: [], totalKnown: 0 })
      : r.continue(),
  )
  await page.route("**/api/control/sessions**", (r) => (api(r.request()) ? json(r, []) : r.continue()))

  return { project: proj }
}

async function openApp(page: Page, dir: string = DIR) {
  await page.goto(`/${slug(dir)}/session`)
  await page.waitForLoadState("domcontentloaded")
  await expect(page.locator("[data-claxedo]")).toBeVisible({ timeout: 30_000 })
  await expect(page.locator('[data-testid="rail-sidebar"]')).toBeVisible({ timeout: 20_000 })
}

/** Switches the sidebar's "Group by" view option to "Workspace" so non-main workspace
 * rows (`[data-testid="workspace-header"]`) render — required to reach any secondary/
 * sandbox/missing workspace's hover actions or kebab menu.
 *
 * In this grouping mode each project renders as a collapsible
 * `[data-testid="workspace-project-header"]` folder (`WorkspaceGroupBlock`,
 * `rail-sidebar.tsx:2443`) that only auto-opens when the project is the
 * "active" one (`projectMatches()`, keyed off the route-derived
 * `activeProjectId`) OR at least one of its workspace sections already has
 * session rows (`group.items.some(item => item.rows.length > 0)`,
 * `rail-sidebar.tsx:2444`) — neither is true for this fixture (no sessions
 * seeded, and this spec's minimal mock does not thread a real active-project
 * match through route state), so the folder renders collapsed with zero
 * `workspace-header` children until explicitly expanded. Click its
 * "Expand project" disclosure toggle to reach them.
 */
async function groupByWorkspace(page: Page) {
  await page.getByTestId("rail-account-trigger").click()
  await page.getByRole("menuitem", { name: "View options" }).hover()
  await page.getByRole("menuitemradio", { name: "Workspace" }).click()
  // Close the account menu DETERMINISTICALLY, then prove it closed. The radio
  // item has `closeOnSelect={false}` (rail-sidebar.tsx FilterMenu), so the menu
  // stays open by design — but a bare fire-and-forget double-Escape here loses a
  // race 100% of the time on the prebuilt bundle: Kobalte's selectable-collection
  // keydown handler (createSelectableCollection, `case "Escape": preventDefault()
  // + clearSelection()`) consumes Escapes that land in the immediate post-click
  // window, and the dismissable layer's own document listener skips dismissal for
  // any already-`defaultPrevented` Escape — so BOTH menus stay open, Kobalte's
  // hide-outside keeps the entire app `aria-hidden`, and every later
  // `getByRole(...)` in the test resolves nothing while bare CSS locators still
  // match (reproduced live: menu count stayed 2 after both Escapes; two LATER
  // Escapes closed submenu then menu). Press-and-verify with a poll instead.
  await expect
    .poll(async () => {
      await page.keyboard.press("Escape")
      return page.getByRole("menu").count()
    }, { timeout: 10_000 })
    .toBe(0)
  // Wait for the workspace-grouped view to actually render first —
  // `[data-testid="workspace-project-header"]` always renders once
  // grouped-by-workspace (only its `workspace-header` CHILDREN are
  // conditional on `open()`, rail-sidebar.tsx's `WorkspaceGroupBlock`).
  await expect(page.locator('[data-testid="workspace-project-header"]').first()).toBeVisible({ timeout: 10_000 })
  // The outer header's disclosure caret is a `<span role="button"
  // aria-label="Expand project"|"Collapse project">` that
  // `page.getByRole("button", { name: "Expand project" })` never matches here
  // — reproduced live: `.count()` reliably returns 0 for this exact element
  // even though its own `aria-label` attribute reads exactly "Expand
  // project" (a Playwright accessible-name computation quirk with this
  // span's sibling icon children, not a real absence of the element/label).
  // A direct `[role="button"]` CSS locator scoped to the header finds and
  // clicks it correctly, so target it that way instead of via role/name.
  const expandToggle = page.locator('[data-testid="workspace-project-header"] [role="button"]').first()
  if ((await expandToggle.getAttribute("aria-label")) === "Expand project") await expandToggle.click()
}

function toastTitle(page: Page) {
  return page.locator('[data-slot="toast-title"]')
}

test.describe("core workspace lifecycle @core", () => {
  test.beforeEach(async ({ page }) => {
    page.on("console", (message) => {
      if (message.type() === "error") {
        // eslint-disable-next-line no-console
        console.log(`[browser console error] ${message.text()}`)
      }
    })
  })

  test("selecting an invalid resolved path shows a toast and creates nothing — behavior 1", async ({ page }) => {
    await seedProject(page)
    await installLifecycleMock(page)

    // The directory-search backend for "/workspace": mocks the root listing so the
    // literal blocked worktree `/workspace` (see STATE MODEL) is a selectable search
    // result without needing a real filesystem.
    await page.route("**/file?**", (r) => {
      if (!api(r.request())) return r.continue()
      if (new URL(r.request().url()).pathname !== "/file") return r.fallback()
      return json(r, [{ name: "workspace", absolute: "/workspace", type: "directory" }])
    })

    let createSessionCount = 0
    await page.route("**/session", async (r) => {
      if (!api(r.request())) return r.continue()
      if (r.request().method() === "POST") createSessionCount += 1
      return json(r, [])
    })

    await openApp(page)

    // Both this button's label AND the dialog's title render "New Project" — the
    // `cloudStrings` extension override (src/i18n/cloud-strings.ts, see HARNESS
    // NOTES) overrides `workspace.new` AND `command.project.open` to the SAME
    // literal string, not the "New workspace"/"Open project" `src/i18n/en.ts`
    // defines standalone.
    await page.getByRole("button", { name: "New Project", exact: true }).click()
    await expect(page.locator('[data-slot="dialog-title"]')).toHaveText("New Project")

    // NOT `[data-slot="list-search-input"]` — `TextField`
    // (packages/ui/src/components/text-field.tsx) silently overrides any caller-
    // supplied `data-slot` with a hardcoded `"input-input"` on the real `<input>`
    // (later JSX prop wins over the earlier `{...others}` spread); confirmed live,
    // 100% reproducible — see ANATOMY and findings.
    const search = page.locator('[data-slot="list-search-container"] input')
    await expect(search).toBeVisible({ timeout: 10_000 })
    await search.fill("/workspace")

    const row = page.locator('[data-slot="list-item"]').filter({ hasText: "workspace" })
    await expect(row.first()).toBeVisible({ timeout: 10_000 })
    await row.first().click()

    await expect(toastTitle(page)).toHaveText("Invalid project path", { timeout: 10_000 })
    await expect(page.getByText("/workspace", { exact: true }).last()).toBeVisible()

    // Dialog closed on the toast path? No — handleProjectSelected returns before
    // calling dialog.close(); the picker stays open so the user can pick again. Prove
    // no project was ever registered/session created as a result of the bad selection.
    expect(createSessionCount).toBe(0)
  })

  // behaviors 8/9 (New workspace Local/Cloud dialog: dead trigger, hang-forever
  // wait=true branch, and the cloud create dialog reachable only through it) —
  // DELETED per docs/e2e-decisions.md #16 (2026-07-20). The dead code itself
  // (onNewWorkspace threading, handleNewWorkspace, DialogNewProject,
  // DialogCreateCloudWorkspace) was removed from src/. See this file's ANATOMY
  // header for what was there.

  test("kebab Edit renames a project — behavior 3", async ({ page }) => {
    await installLifecycleMock(page)
    await seedProject(page)
    await openApp(page)

    let patchBody: unknown
    // Trailing `**` is required: `Project.update()` sends `directory` as a query
    // param (`PATCH /project/:id?directory=...`), and Playwright glob routes are
    // fully anchored (`^...$`) — a pattern ending in the bare projectID would NOT
    // match a URL with a trailing `?query`, silently falling through to no mock.
    await page.route(`**/project/${PROJECT_ID}**`, async (r) => {
      if (!api(r.request())) return r.continue()
      if (r.request().method() !== "PATCH") return r.fallback()
      patchBody = r.request().postDataJSON()
      return json(r, { id: PROJECT_ID, worktree: DIR, name: "renamed-lifecycle-project" })
    })

    // The kebab's own aria-label uses the WORKSPACE label ("main" — the project's
    // own worktree has no `workspaces[dir].workspace_name` override), not the
    // project's display name shown in the row text (`workspaceDisplayName()` in
    // `src/claxedo-ui/utils/workspace-display.ts`: `directory === project.worktree
    // ? workspace?.workspace_name ?? "main" : ...`).
    // MOUNT-ON-ENGAGEMENT (rail-hover-engagement.ts, commit 40e02011): the
    // header's action cluster — kebab included — is not in the DOM until the
    // header itself is hovered/focused, so engage the header first.
    await page.locator('[data-testid="project-header"]').hover()
    await page.getByRole("button", { name: "More options for main" }).click()
    await page.getByRole("menuitem", { name: "Edit", exact: true }).click()

    await expect(page.locator('[data-slot="dialog-title"]')).toHaveText("Edit project")
    const nameField = page.getByLabel("Name", { exact: true })
    await expect(nameField).toBeVisible({ timeout: 10_000 })
    await nameField.fill("renamed-lifecycle-project")
    await page.screenshot({ path: "test-results/evidence/core-workspace-lifecycle/edit-project-dialog.png" })
    await page.getByRole("button", { name: "Save", exact: true }).click()

    await expect.poll(() => patchBody, { timeout: 10_000 }).toMatchObject({ name: "renamed-lifecycle-project" })
    await expect(page.locator('[data-slot="dialog-title"]')).toHaveCount(0, { timeout: 10_000 })
  })

  test("kebab Delete workspace on a non-main worktree: dirty check, cancel, disabled states, confirm — behavior 4", async ({ page }) => {
    const SECOND_DIR = "/tmp/e2e-core-lifecycle-second"
    const lifecycle = await installLifecycleMock(page, {
      sandboxes: [SECOND_DIR],
      workspaces: { [SECOND_DIR]: { kind: "local", available: true, directory: SECOND_DIR } },
    })
    await seedProject(page)

    let statusResolve: (() => void) | undefined
    const statusGate = new Promise<void>((resolve) => (statusResolve = resolve))
    let statusCalls = 0
    await page.route("**/file/status**", async (r) => {
      if (!api(r.request())) return r.continue()
      statusCalls += 1
      await statusGate
      return json(r, [{ path: "src/index.ts", status: "modified" }])
    })

    let removeBody: unknown
    let removeResolve: (() => void) | undefined
    const removeGate = new Promise<void>((resolve) => (removeResolve = resolve))
    await page.route("**/experimental/worktree**", async (r) => {
      if (!api(r.request())) return r.continue()
      if (r.request().method() !== "DELETE") return r.fallback()
      removeBody = r.request().postDataJSON()
      await removeGate
      // The real DELETE commits the Project row through `project.removeSandbox`
      // before returning 200, so every later `/project` read and the emitted
      // `project.updated` event agree that this workspace no longer exists.
      // Keep this fixture's authoritative producer in the same state instead of
      // allowing a late catalog read to resurrect the immutable seed under load.
      lifecycle.project.sandboxes = lifecycle.project.sandboxes.filter((directory) => directory !== SECOND_DIR)
      delete lifecycle.project.workspaces[SECOND_DIR]
      lifecycle.project.time.updated = Date.now()
      return json(r, { ok: true })
    })

    await openApp(page)
    await groupByWorkspace(page)

    const row = page.locator('[data-testid="workspace-header"][data-workspace-id="' + SECOND_DIR + '"]')
    await expect(row).toBeVisible({ timeout: 15_000 })
    // MOUNT-ON-ENGAGEMENT (rail-hover-engagement.ts, commit 40e02011): the
    // kebab only mounts once its owning header is hovered/focused.
    await row.hover()
    await row.getByRole("button", { name: /^More options for /, exact: false }).click()
    await page.getByRole("menuitem", { name: "Delete workspace", exact: true }).click()

    await expect(page.locator('[data-slot="dialog-title"]')).toHaveText("Delete workspace")
    const deleteButton = page.getByRole("button", { name: "Delete workspace", exact: true })
    // Confirm button is disabled while the file-status check is in flight.
    await expect(deleteButton).toBeDisabled()
    await expect(page.getByText("Checking for unmerged changes...")).toBeVisible()

    // Cancel closes with zero mutation while the check is still pending.
    await page.getByRole("button", { name: "Cancel", exact: true }).click()
    await expect(page.locator('[data-slot="dialog-title"]')).toHaveCount(0)
    expect(removeBody).toBeUndefined()

    // Reopen and let the check resolve this time. (Re-hover: closing the dialog
    // leaves the pointer over where the Cancel button was, so the header is
    // disengaged and its kebab unmounted again.)
    await row.hover()
    await row.getByRole("button", { name: /^More options for /, exact: false }).click()
    await page.getByRole("menuitem", { name: "Delete workspace", exact: true }).click()
    statusResolve?.()
    await expect(page.getByText("Unmerged changes detected in this workspace.")).toBeVisible({ timeout: 10_000 })
    await expect(deleteButton).toBeEnabled()

    await deleteButton.click()
    // Disabled again once the delete itself is in flight.
    await expect(deleteButton).toBeDisabled()
    removeResolve?.()

    await expect(page.locator('[data-slot="dialog-title"]')).toHaveCount(0, { timeout: 10_000 })
    expect(statusCalls).toBeGreaterThanOrEqual(1)
    expect(removeBody).toMatchObject({ directory: SECOND_DIR })
    const projectList = await page.evaluate(async () => (await fetch("/project")).json()) as Array<{
      sandboxes?: string[]
      workspaces?: Record<string, unknown>
    }>
    expect(projectList[0]?.sandboxes).not.toContain(SECOND_DIR)
    expect(projectList[0]?.workspaces).not.toHaveProperty(SECOND_DIR)
    await expect(row).toHaveCount(0, { timeout: 10_000 })
  })

  test("kebab Delete workspace on a cloud MAIN workspace renders Destroy Sandbox and destroys it — behavior 5", async ({ page }) => {
    await installLifecycleMock(page, {
      workspaces: { [DIR]: { kind: "cloud", available: true, directory: DIR, workspaceId: "wsid_main_cloud" } },
    })
    await seedProject(page)

    let sandboxDeleteCalls = 0
    await page.route("**/api/experimental/sandbox**", async (r) => {
      if (!api(r.request())) return r.continue()
      if (r.request().method() !== "DELETE") return r.fallback()
      sandboxDeleteCalls += 1
      return json(r, { ok: true })
    })

    // The kebab's "Delete workspace"/"Destroy Sandbox" item is gated behind
    // `canMutateWorkspace()` (rail-sidebar.tsx:1567), which for a cloud-backed
    // workspace (non-empty `workspaceId`) requires `workspacePlacement()` to
    // resolve a role — that only happens once `WorkspaceGate` (mounted around
    // the session surface for this active cloud workspace) actually mints a
    // connection via `GET /api/workspace/:id/connection`
    // (`openWorkspaceConnection`, `src/utils/workspace-relay-connection.ts`)
    // and the resulting `role` flows into `applyWorkspaceConnectionInfo`
    // (`src/shell/workspace/workspace-connection.ts`). Without this mock the
    // mint silently fails (nothing listens on the real backend), the
    // connection never reaches "ready" with a role, and the whole "Delete
    // workspace" menu item stays hidden — not a route this spec's shared
    // `installLifecycleMock` needs generically (every OTHER test here is a
    // local/no-workspaceId workspace, which short-circuits this gate via
    // `!workspace.workspaceId`), so it is mocked spec-locally here.
    await page.route("**/api/workspace/*/connection**", (r) =>
      api(r.request())
        ? json(r, {
            access: "cloud",
            backing: "cloud-vm",
            runtimeKind: "cloud",
            workspaceId: "wsid_main_cloud",
            role: "owner",
            relayUrl: "https://relay.test",
            runtimeAccessToken: "test-runtime-access-token",
            tokenExpiresAt: Date.now() + 3_600_000,
          })
        : r.continue(),
    )

    await openApp(page)

    // Same "main" label nuance as the Edit test above — the kebab's aria-label is
    // workspace-scoped ("main"), not the project's display name. Hover the
    // header first: the kebab mounts on engagement (rail-hover-engagement.ts).
    await page.locator('[data-testid="project-header"]').hover()
    await page.getByRole("button", { name: "More options for main" }).click()
    // The kebab menu item's own label is always "Delete workspace" — only the
    // DIALOG it opens (title + confirm button) renders "Destroy Sandbox" for a
    // cloud-backed main workspace (`HeaderActions`'s DropdownMenu.Item text is
    // unconditional in rail-sidebar.tsx; only DialogDeleteWorkspace's
    // `isCloudSandbox()` branch changes copy).
    await expect(page.getByRole("menuitem", { name: "Delete workspace", exact: true })).toBeVisible({ timeout: 10_000 })
    await page.getByRole("menuitem", { name: "Delete workspace", exact: true }).click()

    await expect(page.locator('[data-slot="dialog-title"]')).toHaveText("Destroy Sandbox")
    // No file-status check for a cloud sandbox: no "Checking..." copy ever appears.
    await expect(page.getByText("Checking for unmerged changes...")).toHaveCount(0)
    await page.screenshot({ path: "test-results/evidence/core-workspace-lifecycle/destroy-sandbox-dialog.png" })

    await page.getByRole("button", { name: "Destroy Sandbox", exact: true }).click()

    await expect.poll(() => sandboxDeleteCalls, { timeout: 10_000 }).toBe(1)
    await expect(toastTitle(page)).toHaveText("Sandbox Destroyed", { timeout: 10_000 })
  })

  test("kebab Remove project removes optimistically; forced server failure surfaces a toast without restoring it — behavior 6", async ({ page }) => {
    await installLifecycleMock(page)
    await seedProject(page)

    let deleteCalls = 0
    await page.route(`**/api/workspace/${PROJECT_ID}`, async (r) => {
      if (!api(r.request())) return r.continue()
      if (r.request().method() !== "DELETE") return r.fallback()
      deleteCalls += 1
      return json(r, { error: "workspace store is locked" }, 500)
    })

    await openApp(page)

    const projectHeader = page.locator('[data-testid="project-header"]').filter({ hasText: PROJECT_NAME })
    await expect(projectHeader).toBeVisible({ timeout: 10_000 })

    // Engage the header so its kebab mounts (rail-hover-engagement.ts).
    await projectHeader.hover()
    await page.getByRole("button", { name: "More options for main" }).click()
    await page.getByRole("menuitem", { name: "Remove project", exact: true }).click()

    // Optimistic: the project disappears from the sidebar immediately, synchronously
    // with the click — before the (failing) server DELETE has even resolved.
    await expect(projectHeader).toHaveCount(0, { timeout: 5_000 })

    await expect.poll(() => deleteCalls, { timeout: 10_000 }).toBe(1)
    // Background reconnect/reload failures may legitimately surface their own
    // toast at the same time. Assert the removal contract by content instead
    // of requiring this to be the only toast in the global stack.
    await expect(toastTitle(page).filter({ hasText: "Failed to remove project" }))
      .toHaveText("Failed to remove project", { timeout: 10_000 })

    // The already-removed row does not come back after the failure.
    await expect(projectHeader).toHaveCount(0)
  })

  test("New session on a missing local workspace opens the recovery dialog and recreates it — behavior 7", async ({ page }) => {
    const MISSING_DIR = "/tmp/e2e-core-lifecycle-missing"
    await installLifecycleMock(page, {
      sandboxes: [MISSING_DIR],
      workspaces: { [MISSING_DIR]: { kind: "local", available: false, directory: MISSING_DIR } },
    })
    await seedProject(page)

    let createBody: unknown
    await page.route("**/experimental/worktree**", async (r) => {
      if (!api(r.request())) return r.continue()
      if (r.request().method() !== "POST") return r.fallback()
      createBody = r.request().postDataJSON()
      return json(r, { directory: MISSING_DIR, name: "recovered" })
    })

    // `createLocalWorkspace` (workspace-recovery.tsx) waits for a `worktree.ready`
    // event on the central Claxedo event stream. The documented injection point
    // (`window.__claxedoEmitTestEvent`, `src/app/integrations/claxedo-events.tsx`)
    // is gated behind `import.meta.env.DEV` — confirmed live against THIS server
    // (not just this spec's mock) that the flag is false here: both
    // `__claxedoEmitTestEvent` and the sibling DEV-only
    // `__claxedoConnections.markReconnecting`/`markReconnected` are absent from
    // `window` after a full app boot, so the hook does not exist to call. This
    // spec instead drives the REAL delivery path: the central stream is a
    // `GET /api/claxedo/events` SSE connection (`claxedoEventStreamTargets` ->
    // `controlPlaneEventsUrl`, `src/app/integrations/claxedo-events.tsx`) — the
    // same one handler both real servers also mount on `/global/event` and
    // `/api/wr/events`, which is why every spelling is overridden below. It
    // reconnects on a steady ~2s cadence
    // whenever each HTTP-level connect succeeds (`state.failures` resets to 0 on
    // every 200 OK before the delay is computed, so the backoff never actually
    // grows here — only a network/HTTP failure would escalate it). Flipping
    // `deliverWorktreeReady` makes the NEXT reconnect's response body carry a
    // real `data: {...}\n\n` SSE frame instead of the heartbeat comment, which
    // the provider parses and feeds into the exact same emitter
    // `props.events.on("worktree.ready", ...)` subscribes to — equivalent to the
    // DEV hook's effect, but reachable without it.
    let deliverWorktreeReady = false
    const eventStreamOverride = async (route: import("@playwright/test").Route) => {
      if (!api(route.request())) return route.continue()
      const body = deliverWorktreeReady
        ? `data: ${JSON.stringify({ type: "worktree.ready", directory: MISSING_DIR, name: "recovered", branch: "main" })}\n\n`
        : ": heartbeat\n\n"
      await route.fulfill({ status: 200, contentType: "text/event-stream", body }).catch(() => {})
    }
    await page.route("**/global/event?**", eventStreamOverride)
    await page.route("**/event?**", eventStreamOverride)
    await page.route("**/api/wr/events**", eventStreamOverride)
    await page.route("**/api/claxedo/events**", eventStreamOverride)

    await openApp(page)
    await groupByWorkspace(page)

    const row = page.locator('[data-testid="workspace-header"][data-workspace-id="' + MISSING_DIR + '"]')
    await expect(row).toBeVisible({ timeout: 15_000 })
    // "New session in" is part of the header's engagement-mounted action
    // cluster (rail-hover-engagement.ts) — hover the header to mount it.
    await row.hover()
    await row.getByRole("button", { name: /^New session in /, exact: false }).click()

    await expect(page.locator('[data-slot="dialog-title"]')).toHaveText("Worktree not found")
    await expect(page.getByText(/The backing worktree for/)).toBeVisible()
    await page.screenshot({ path: "test-results/evidence/core-workspace-lifecycle/recover-workspace-dialog.png" })

    await page.getByRole("button", { name: "Continue in new worktree", exact: true }).click()

    await expect.poll(() => createBody, { timeout: 10_000 }).toBeTruthy()

    deliverWorktreeReady = true

    await expect(page.locator('[data-slot="dialog-title"]')).toHaveCount(0, { timeout: 20_000 })
    // Recovery creates a new local workspace identity for the project. The
    // authoritative resolve response above carries that opaque route ID;
    // filesystem directories never leak into browser URLs.
    await expect(page).toHaveURL(`/w/local-${PROJECT_ID}`, { timeout: 10_000 })
  })
})
