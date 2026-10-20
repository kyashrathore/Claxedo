import type { Policy } from "../policy.ts"
import type { Alias } from "../closure.ts"

const DESKTOP = "packages/claxedo-desktop/src"
const APP = "packages/claxedo-app/src"

/**
 * How the renderer build resolves the app's specifiers.
 *
 * `vite.renderer.ts` builds the renderer from the app's own Vite config, so
 * these mirror its aliases: `#app` and `#app/styles` are the renderer's door
 * into the app, `@/` is the app's own source root, and `#account-binding` is
 * the desktop's account binding, which the renderer config always selects.
 * Nothing resolves them from a package manifest, so a walk without this list
 * answers "unresolved" for every app module and reports a clean product it
 * never opened. `#app/styles` comes before `#app`, whose target is a file.
 */
const RENDERER_ALIASES: Alias[] = [
  { prefix: "#app/styles", target: `${APP}/styles.css` },
  { prefix: "#app", target: `${APP}/app.tsx` },
  { prefix: "#account-binding", target: `${APP}/auth/electron-binding.ts` },
  { prefix: "#terminal-backend", target: `${APP}/terminal/backend/xterm.ts` },
  { prefix: "@claxedo/app/ui", target: `${APP}/ui/index.ts` },
  { prefix: "lru_map", target: `${APP}/transcript/diff/lru-map.ts` },
  { prefix: "@", target: APP },
]

/**
 * The desktop renderer: the app, entered through `src/renderer/main.tsx`.
 *
 * This crosses INTO `@claxedo/app` on purpose. The renderer is the app, so
 * "what does the desktop window reach" is unanswerable without following the
 * edge. The module that matters is the browser account binding
 * (`auth/better-auth-binding.ts`, the one file that imports
 * `better-auth/client`): the desktop signs in through Electron main, and the
 * renderer config selects the Electron binding, so that module and its
 * package must never be reached.
 */
export const desktopRenderer: Policy = {
  id: "desktop-renderer",
  summary: "@claxedo/desktop renderer entry (src/renderer/main.tsx)",
  packageDir: "packages/claxedo-desktop",
  entry: `${DESKTOP}/renderer/main.tsx`,
  roots: [DESKTOP, APP],
  aliases: RENDERER_ALIASES,
  followed: [{ name: "@claxedo/app", dir: "packages/claxedo-app" }],

  forbiddenPackages: ["better-auth", "@claxedo/host-connector", "electron"],
  forbiddenModules: [
    `${APP}/auth/better-auth-binding.ts`,
    // Electron main is a different process. A renderer import of `src/main/**`
    // would put the machine private key and the OAuth client secret handling
    // in the window.
    `${DESKTOP}/main/account`,
    `${DESKTOP}/main/host-connector`,
  ],
  // A plugin's code is a blob: URL built at runtime from its bundle text (the
  // one the user installed, or a first-party bundle the build emitted as a
  // string), so neither edge is repository source. `plugins/bundle.ts` loads
  // a desktop plugin into the window; `plugins/frame/document.ts` holds, as a
  // string, the loader the web's sandboxed plugin frame runs.
  permittedOpaqueImports: [
    `${APP}/plugins/bundle.ts -> import(url)`,
    `${APP}/plugins/frame/document.ts -> import(url)`,
  ],

  control: {
    minModules: 700,
    requiredModules: [
      `${DESKTOP}/renderer/main.tsx`,
      // Reached only by crossing into the app through `#app`. Its absence means
      // the walk never left `claxedo-desktop`, which is the state in which
      // every "no browser identity" answer below is worthless.
      `${APP}/app.tsx`,
      `${APP}/auth/electron-binding.ts`,
    ],
    requiredPackages: ["solid-js"],
  },

  // 1,224 modules and 37 packages, no headroom. The Review tab's
  // `review/loaded-diff-identity.ts` is its own module because the benchmark
  // driver imports it to compute the identity it waits for. The workbench
  // store's pane handover (`workbench/handover.ts`, `workbench/reveal-holds.ts`)
  // is the app's session-switch paint: one pane swap per switch, after the view
  // it reveals is complete. A session opens from one first read
  // (`server/wire/first-read.ts`) carrying its row, its turn outline and the
  // page its transcript draws first, sized by `session/transcript-viewport.ts`
  // from the transcript's measured size; the open view
  // (`server/wire/session-open.ts`) carries the facts beside the row. Every
  // later page and a tool row's whole part are read by
  // `server/transcript-reads.ts` and parsed by `server/wire/turn-page.ts`. The
  // rail's turn list (`session/view/nav-turns.ts`) lists every turn before the
  // transcript loads it, and `session/transcript/retained.ts` holds the latest
  // turn a return repaints from. The timeline's render range
  // (`session/view/timeline/timeline-render-range.ts`) is its own module so its
  // unit tests reach it without mounting the timeline.
  // The outgoing slot unmounts after the swap paints
  // (`workbench/view/deferred-unmount.ts`).
  // The kit (`@opencode-ai/ui`) is one of the packages; its source is not
  // walked. `@claxedo/agent-runtime-contract` is one too: among the data the
  // app reads from it, it owns the event streams' heartbeat and the stall
  // timeout the app's stream reader drops a silent stream after. The shell's `shell/daemon-status.ts` and
  // `shell/view/daemon-lost-banner.tsx` are the desktop's one alert that its
  // local service stopped. `server/model-choice.ts` is the one comparison of two
  // model choices, read by the composer's model selection and by the session
  // list's rule for a row that changes only its selections. The Usage settings
  // section (`usage/view/*`) is a renderer screen: its model owns the quota
  // account groups, window risk, the cost estimate, the daily series and the
  // token split, each a module its unit tests reach directly, and it draws the
  // shared `lib/failure.tsx` notice and the kit's collapsible. The rail and
  // settings rows take their height, radius and type size from one stylesheet
  // (`shell/view/sidebar.css`), and `notifications/unseen-failures.ts` owns
  // which failed sessions the reader has not opened, the one fact the rail's
  // failure dot reads. The Review column's file row (`review/view/change-row.tsx`),
  // its muted diff counts (`review/view/change-counts.tsx`), which the review
  // toolbar's totals also draw, and its folder label (`review/folder-label.ts`),
  // which its unit test reaches directly, are modules of their own. Settings'
  // own-or-team account choice reads and writes through
  // `server/account-sources.ts` and draws `accounts/view/hosted-account-source.tsx`;
  // the slash picker reads a harness's runtime and saved commands through
  // `server/harness-commands.ts`, parsed by `server/wire/harness-commands.ts`;
  // and onboarding's choice of where the first project lives, the draft it
  // holds and the creation Finish opens are `onboarding/{place,model,finish}.ts`.
  // A session's activity for the rail, workbench tabs and plugins is one
  // reading (`session/list/activity.ts`); the transcript's background work
  // line and its label are `session/view/timeline/timeline-background-work.tsx`
  // and `background-work-label.ts`, which its unit test reaches directly; and a
  // running background subagent's Stop beside its chip is
  // `transcript/subagent-stop.tsx`.
  // The transcript draws a harness's notices and compaction boundaries from the
  // contract's `transcript-notice.ts` through `transcript/notice-part.tsx`, whose
  // pure view (`notice-view.ts`) its unit test reaches directly, on the divider
  // it shares with the compaction part (`message-divider.tsx`). A response the
  // harness withdrew draws through `transcript/retracted-part.tsx`, and the edit
  // tools' diagnostics list is `transcript/tool-diagnostics.tsx`. A queued
  // message's label, reason and send action, including a steer the harness
  // declined, are `session/view/timeline/queued-message-status.ts`, which its
  // unit test reaches directly.
  // SidePanel owns shared frame, header, tab, resize and motion; the panel and
  // Marketplace wrappers reach it through ui, with workspace data kept outside.
  // side-panel-slot lets the active page use that full-height shell host.
  // Settings' provider model cards share their switch rows and large-provider
  // virtualization through `accounts/view/model-rows.tsx`. A long user prompt
  // folds through `transcript/folded-user-message-body.tsx` and its stylesheet.
  // A child's report and a stored agent-authored opening share the event chrome
  // of `transcript/agent-message-event.tsx`, styled by
  // `transcript/agent-message-notice.css`. Sessions other people shared with
  // the account are read and routed by `server/shared-sessions.ts` and listed
  // by `rail/view/shared-sessions.tsx`. Whether the macOS window buttons cover
  // the shell's top-left corner is `shell/window-controls.ts`, read through the
  // desktop bridge. A comment on text selected in the transcript, a Markdown
  // preview or the plan tab is `composer/quote/selection-comment.tsx` over its
  // selection controller (`quote-selection.ts`), its pure selection reading and
  // box placement (`selected-quote.ts`, which its unit test reaches directly)
  // and its highlight stylesheet; the composer groups quotes through
  // `composer/view/annotations-chip.tsx`, with details and actions in
  // `annotation-card.tsx`, and a sent message through
  // `session/view/timeline/message-comment-chip.tsx`. Every comment box, line,
  // mark or quote, is `transcript/line-comment-editor.tsx`, apart from the
  // anchor and saved comment in `line-comment.tsx`. Composer owns the source
  // registry (`quote/surfaces.tsx`), range lookup (`find-quote.ts`), edit
  // controller (`annotation-editor.tsx`), shared placement and highlight
  // (`anchored-position.ts`, `highlight.ts`) and popup (`quote-box.tsx`). Its
  // context chips share their remove control through `view/context-chip.tsx`;
  // mark and quote positioning share the bounded coordinate in `coordinate.ts`.
  // These renderer interactions add no package edge.
  // The draft context reaches `projects/draft-branches.ts`, which owns the
  // selected placement's live Git status and new-workspace base choice.
  // The Browser tab's retained pages, their eviction and their disposal when a
  // placement is deleted are `browser/tab-cache.ts`, split from the provider
  // that owns the context. The composer's pure prompt edits (insert a part,
  // renumber offsets, set image marks) are `composer/prompt-edits.ts`, split
  // from the draft store; the harness selector's model, effort and fast writes
  // and their refusal toast are `composer/view/selection-writes.ts`.
  // server/startup.ts owns startup failure and retry; shell/view/startup.tsx
  // presents that state through the existing failure notice. Both belong in
  // the shared desktop renderer and add no package edge.
  // `app.tsx` mounts the session state owners through `session/index.ts`'s
  // `SessionStoresProvider` (`session/store/*`): the session list
  // (`session/list/*`), the pending permissions and questions
  // (`session/requests/*`) and each open session's transcript
  // (`session/transcript/*`). The renderer draws all of them; they add no
  // package edge.
  // The session stores derive a row's finished, failed and waiting alerts in
  // `session/store/attention.ts`, and a signed desktop reads its account's
  // hosted event stream through `server/account-events.ts`.
  // A reader's seen and settle writes, and where a signed desktop's marks live,
  // are `server/session-reader.ts`; the list holds each row's reader marks in
  // `session/list/readers.ts` and sends its pending writes from
  // `session/list/reader-writes.ts`; the session view's seen write while a
  // session is shown is `session/view/seen-while-shown.ts`.
  // The rail's Activity view (`rail/view/activity-view.tsx`), its heading,
  // session options menu and filter cycle (`rail/view/sessions-heading.tsx`)
  // and the row navigation both views share (`rail/view/row-navigation.ts`)
  // are renderer views over the session list, and the list reads a settled
  // row a turn end returns through `session/list/turn-end-reads.ts`; they add
  // no package edge.
  // Wire reads decode through their parsers: git answers in
  // `server/wire/git.ts` and the usage summary in `server/wire/usage.ts`; the
  // workbench and plugin panes check stored pane state with `shell/json.ts` and
  // adapt a typed pane kind through `shell/pane-kind-entry.tsx`. They add no
  // package edge.
  // Settings → Models' Sandbox group (owner: the accounts domain's sandbox
  // provider keys) reads and writes the keys through `server/sandbox-keys.ts`
  // and `server/wire/sandbox-keys.ts`, keeps their activity in
  // `accounts/sandbox-store.ts`, and draws them from
  // `accounts/view/sandbox-section.tsx`, `sandbox-key-row.tsx` and
  // `sandbox-key-form.tsx`. They add no package edge.
  // The new-session row's Where chip (owner: the projects domain) groups the
  // draft's placements in `projects/draft-where.ts` and draws them from
  // `projects/view/where-chip.tsx`, creating a cloud workspace through the shared
  // `new-cloud-workspace-dialog.tsx`; its Project chip creates a project in
  // `projects/view/create-project-dialog.tsx`; the Browser tab refuses another
  // machine's localhost in `browser/view/elsewhere-page.tsx`. They add no
  // package edge.
  // The one notice slot above the composer (owner: the composer domain) ranks
  // its notices in `composer/view/notice-slot.ts`; a draft's first send is its
  // machine in `session/view/first-send.ts` and its notice in
  // `session/view/first-send-notice.ts`; a placement's lifecycle notice in
  // `session/view/placement-notice.tsx` replaces the four `workspace-sleep/`
  // cards; the workbench matches a pane by route in `workbench/route-match.ts`.
  // They add no package edge.
  // Settings on the shared surfaces (owner: the app's settings domains): the
  // signed person's memberships and members (`server/organizations.ts`,
  // `server/wire/organizations.ts`, `server/access-types.ts`), the one form
  // dialog and drawer (`ui/controls/form-surface.tsx`), the integration connect
  // dialog (`settings/view/connect-dialog.tsx`), Usage's Cloud view
  // (`usage/view/cloud-usage.tsx`) and a project's Where it runs list, its new
  // cloud workspace dialog and environment drawer (`projects/view/where-it-runs.tsx`,
  // `new-cloud-workspace-dialog.tsx`, `project-environment-drawer.tsx`) replace
  // the cloud domain's section, row and inline create form, the placement list
  // and the inline connect form. They add no package edge.
  // The shell's loading and sign-in surfaces (owner: the app's shell, auth and
  // kit domains): the one placeholder bar (`ui/controls/skeleton.tsx` and its
  // stylesheet), the artwork plate shared by onboarding and sign-in
  // (`ui/controls/artwork-plate.tsx` and its stylesheet), the two-column
  // sign-in layout (`auth/view/auth-split.tsx`), the on-demand view helper the
  // split routes load through (`lib/lazy-view.ts`), and the auth store's read
  // of the last signed-in user for the startup restore (`auth/persistence.ts`,
  // which the renderer did not reach before). They add no package edge.
  // The new-session flow (owner: the app's projects, cloud and browser
  // domains): the create-project dialog (`projects/view/create-project-dialog.tsx`)
  // replaces the inline new-cloud-workspace panel, and the note a localhost
  // link from another machine's workspace opens (`browser/view/elsewhere-page.tsx`).
  // They add no package edge.
  // Product telemetry (owner: the app's server adapter and session requests):
  // the one sender of product events (`server/telemetry.ts`), the allowlisted
  // event contract it sends (`@claxedo/account-contract/product-events`, a
  // package the renderer already reaches) and the permission reply's event
  // (`session/requests/permission-decided.ts`). They add no package edge.
  // The Marketplace's one harness label for its install sheet and plugin
  // facts (owner: the app's marketplace domain): `marketplace/view/harness-label.ts`.
  // It adds no package edge.
  // Review round 1 (owner: the app's server adapter, shell, rail, composer and
  // session list): the workspace's own name decoded by the wire
  // (`server/wire/workspace-name.ts`), the
  // per-user state scope (`shell/principal-scope.ts`), home's no-placement
  // action (`shell/view/home-empty.tsx`), the rail's machine marker
  // (`rail/session-marker.ts`), the picker's empty-model states
  // (`composer/view/models-empty.ts`) and a new session's first-words title
  // (`session/list/pending-title.ts`). They add no package edge.
  // Review round 2 (owner: the app's cloud and marketplace domains): the
  // reader-language name of a cloud workspace with no name of its own
  // (`cloud/view/workspace-name.ts`) and the Marketplace's project-scope copy
  // by sign-in state (`marketplace/view/project-scope.ts`). They add no
  // package edge.
  // The picker's answer for a harness this cloud provider cannot run, with
  // the Pi alternative that spends the same account (owner: the app's
  // composer, `composer/view/harness-unavailable-here.ts`). It adds no
  // package edge.
  // A project's environment, write-only values listed by name through the
  // hosted or local route (owner: the app's server adapter,
  // `server/project-environment.ts`). It adds no package edge.
  // A project's Environment section in its own file, with its loading and
  // failure states (owner: the app's projects domain,
  // `projects/view/project-environment-section.tsx`). It adds no package edge.
  // Panes restored for a workspace the account no longer has, closed once the
  // catalog answers (owner: the app's shell, `shell/gone-placements.tsx`), and
  // a new cloud workspace's machine size choice (owner: the app's cloud
  // domain, `cloud/view/machine-size.tsx`). They add no package edge.
  // Onboarding's first step on a hosted plane, where cloud workspaces run
  // (owner: the app's onboarding domain: `onboarding/cloud-provider.ts`,
  // `onboarding/view/choice-row.tsx`, `onboarding/view/cloud-placement.tsx`).
  // They add no package edge.
  // Usage limits and AI usage, two settings pages over one usage summary read
  // (owner: the app's usage domain, `usage/view/summary-sections.tsx`, with the
  // range choices both usage ranges share, `usage/view/ranges.ts`). Sandbox
  // usage, a third page: the range's totals, one row per workspace merged with
  // the cloud domain's running rows, and where each provider's prices were read
  // (owner: the app's usage domain, `usage/sandbox-rows.ts`,
  // `usage/view/sandbox-usage-section.tsx`, `usage/view/sandbox-totals.tsx`,
  // `usage/view/sandbox-table.tsx`, `usage/view/sandbox-prices.tsx`). They add
  // no package edge.
  // A draft's held session reservation as the pane persists it, with the
  // harness and title it was reserved for (owner: the app's session domain,
  // `session/view/held-reservation.ts`); the draft pane's state and route
  // contract, split from the pane kind so the chosen Where can be tested without
  // the screen (owner: the app's session domain, `session/view/draft-state.ts`);
  // and the repository name a hosted project create names its first workspace by
  // (owner: the app's server adapter, `server/repository-name.ts`). They add no
  // package edge.
  // The account health predicates both the accounts and the composer domains
  // read (owner: `lib/account-health.ts`), and the connect form's state apart
  // from its server reads (owner: the app's accounts domain,
  // `accounts/connect-state.ts`). They add no package edge.
  // A user message's header text (owner: the app's transcript domain,
  // `transcript/user-message-head.ts`) and the product label of the harness a
  // session runs (owner: the app's session domain,
  // `session/view/session-harness-label.ts`). They add no package edge.
  // A cloud placement's lease lifecycle read from its catalog row, which tells
  // a workspace the server is starting from one that is asleep (owner: the
  // app's server adapter, `server/wire/placement-lifecycle.ts`). It adds no
  // package edge.
  // A timeline divider's wording, split from the timeline view when a turn that
  // ends on a tool with no reply gained its "Worked for" divider (owner: the
  // app's session domain, `session/view/timeline/turn-divider-label.ts`). It
  // adds no package edge.
  // A cloud workspace's start said in words with its steps and times, the one
  // wording the session notice, the first run and the terminal creator share
  // (owner: the app's cloud domain, `cloud/view/wake-progress.ts`). It adds no
  // package edge.
  // The placement owner's watch of its two catalog queries, split from the
  // placement reads when it began reading a catalog again on every
  // invalidation (owner: the app's server adapter, `server/merged-catalog.ts`),
  // and the placement notice's wording apart from its view, so a fresh start
  // and a wake can be told apart without the composer (owner: the app's
  // session domain, `session/view/placement-notice-text.ts`). They add no
  // package edge.
  // Every account write's reread of the accounts and provider catalogs,
  // succeeded or refused, which the accounts, account sources, sandbox keys and
  // provider connect writes share (owner: the app's server adapter,
  // `server/account-writes.ts`). It adds no package edge.
  // The harness picker's read of its placement's runtime, split from the
  // picker when an asleep runtime stopped its re-probes (owner: the app's
  // composer domain, `composer/view/selector-runtime.ts`), and the composer's
  // notice for a harness the runtime refuses because it runs in another host
  // (owner: the app's composer domain, `composer/view/harness-elsewhere.ts`).
  // They add no package edge.
  // What a permission ask shows from the request the harness sent (owner: the
  // app's session domain, `session/view/docks/permission-facts.ts`), where a
  // plugin works in the cloud from its MCP servers' reach (owner: the app's
  // marketplace domain, `marketplace/cloud-reach.ts`), and the repository
  // picker's hint about where a code host grants more repositories (owner:
  // the app's projects domain, `projects/repository-access.ts`,
  // `projects/view/project-repository-access.tsx`). They add no package edge.
  // The Check and Remove actions the sandbox keys and a catalog harness's own
  // keys share (owner: the app's accounts domain, `accounts/key-actions.ts`).
  // It adds no package edge.
  // The one Wake now the placement notice and the model picker share (owner:
  // the app's cloud domain, `cloud/view/wake-workspace.ts`), the picker's
  // words for an empty model list split from its wiring (owner: the app's
  // composer domain, `composer/view/models-empty-notice.ts`), and the
  // composer's selected harness that the session screens read to keep a
  // session-host harness free of machine notices (owner: the app's composer
  // domain, `composer/harness/selected-harness.ts`). They add no package edge.
  // The one Start fresh the placement notice, the model picker and Settings →
  // Projects share for a workspace whose checkpoint cannot be restored (owner:
  // the app's cloud domain, `cloud/view/start-fresh.ts`). It adds no package
  // edge.
  // The model picker's reread of its harness once its workspace wakes, which
  // keeps what it read while the workspace slept unshown until the reread
  // lands (owner: the app's composer domain, `composer/view/wake-reread.ts`).
  // It adds no package edge.
  // The words for workspaces found gone, which tell a gone routed workspace
  // apart from closed tabs of other ones (owner: the app's shell domain,
  // `shell/gone-placements-notice.ts`). It adds no package edge.
  // The agent configuration picker a plugin surface's AgentConfigurationPicker
  // draws: the local and cloud pickers, the models a
  // cloud OpenCode configuration offers from OpenCode's provider catalog read
  // with no workspace, the rules they share and their strings (owner: the
  // app's composer domain, `composer/agent-configuration/`). They add no
  // package edge.
  // The signed-out notice Organization and Sandbox providers share, with its
  // Sign in action (owner: the app's access domain,
  // `access/view/signed-out.tsx`). It adds no package edge.
  // AI usage's By account breakdown, its rows and the read behind it (owner:
  // the app's usage domain, `usage/account-spend.ts`,
  // `usage/view/account-spend-section.tsx`,
  // `usage/view/account-spend-table.tsx`). They add no package edge.
  // The account answers a check and a removal decode to, so a removal the
  // server refused is a failure in one line and never a silent success
  // (owner: the app's server domain, `server/account-answers.ts`). It adds
  // no package edge.
  // A session row's Settle button and the icon for where a session or
  // terminal runs, each with its tooltip (owner: the app's rail domain,
  // `rail/view/settle-button.tsx`, `rail/view/session-marker-icon.tsx`). They
  // add no package edge.
  // Native UI surfaces and MCP Apps in the transcript and in app plugin pages:
  // the A2UI renderer over the kit (owner: the app's surface domain,
  // `surface/`), its catalog and message schemas (`@claxedo/plugin-api/surface`),
  // an agent's `ui_show` reply row and the spec it reads
  // (`transcript/surface-reply.tsx`, `transcript/surface-reply-spec.ts`), a plugin's
  // surface page on both platforms (`plugins/surface-page/`,
  // `plugins/frame/host-surfaces.ts`), and the MCP App frame host with its
  // bridge and the session calls behind it (`mcp-apps/`,
  // `server/mcp-apps.ts`, `ui/theme-tokens.ts`). The renderer's page and
  // summary primitives and their stylesheets (`surface/view/page-views.tsx`,
  // `surface/view/summary-views.tsx`, `surface/view/list-item-view.tsx`,
  // `surface/view/surface-layout.css`, `surface/view/surface-fields.css`,
  // `surface/view/surface-display.css`), the source mark that names a
  // surface's producer with its strings (`surface/view/surface-source-mark.tsx`,
  // `surface/i18n.ts`), the repeated-row action roles
  // (`surface/view/row-actions.ts`), the icon that draws a catalog name from
  // the kit or the surface's own glyphs (`surface/view/surface-icon.tsx`,
  // `surface/view/surface-glyphs.tsx`) and the pure rules they draw from
  // (`surface/grid-columns.ts`, `surface/key-value.ts`, `surface/range-fill.ts`,
  // `surface/tab-strip.ts`,
  // `surface/table-alignment.ts`, `surface/tones.ts`) belong to the same
  // renderer, as do the Image view that draws only the URLs the catalog's
  // rule admits (`surface/view/image-view.tsx`) and the key that fires a text
  // field's submit event (`surface/submit-key.ts`). The Board, its lanes, its
  // keyboard grab machine and pointer drop, and the pending move it draws until
  // the producer's patch (`surface/view/board-view.tsx`,
  // `surface/view/board-lane.tsx`, `surface/view/board-interaction.ts`,
  // `surface/view/board-input.ts`, `surface/view/surface-board.css`,
  // `surface/board-moves.ts`, `surface/board-pending.ts`) belong to the same
  // renderer, as do the FilePicker with the file reading and image fitting it
  // owns (`surface/view/file-picker-view.tsx`, `surface/file-read.ts`,
  // `surface/image-fit.ts`) and the Combobox with its options and
  // search debounce (`surface/view/combobox-view.tsx`,
  // `surface/view/combobox-state.ts`, `surface/view/combobox-list.tsx`,
  // `surface/combobox-options.ts`, `surface/search-debounce.ts`,
  // `surface/view/surface-pickers.css`). They add no package edge.
  // The plugin API primitives a surface page and a surface settings section
  // use (owner: the app's plugins domain): the route params a mounted page
  // hands its program (`plugins/surface-page/page-params.ts`), the host
  // component both draw with (`plugins/surface-page/drawn-surface.tsx`), a
  // cloud workspace's start followed for a plugin
  // (`plugins/bindings/workspaces.ts`), and the frame's response bodies over
  // the host's base64 codec (`plugins/frame/response-body.ts`,
  // `plugins/base64.ts`); with the renderer's reference components, the
  // AgentConfigurationPicker view and the rule that reads its bound value
  // (owner: the app's surface domain, `surface/view/surface-references.ts`,
  // `surface/view/agent-configuration-view.tsx`, `surface/agent-configuration.ts`).
  // They add no package edge.
  // 1508/36, no headroom.
  // -1 module (owner: the app's server domain): `server/availability.ts`, the
  // Tasks route probe, is gone; the bootstrap's `deployment.capabilities`
  // says which plugin capabilities the server offers. 1507/36, no headroom.
  // +6 modules (owner: the app's plugins and transcript domains): the bundled
  // first-party plugins the host ships and loads through the same in-app and
  // frame loaders as live plugins (`plugins/first-party/bundles.ts`,
  // `plugins/first-party/load.ts`, `plugins/in-app.ts`), the binding that
  // registers a plugin's transcript card templates
  // (`plugins/bindings/transcript.ts`), the transcript's evaluation of those
  // templates (`transcript/tool-card-template.ts`), and the JSON Pointer
  // parser it shares with the surface renderer (`lib/json-pointer.ts`, moved
  // out of `surface/data-path.ts`). Each bundle is a
  // `@claxedo/<plugin>/app?claxedo-plugin-bundle` chunk, a package edge onto
  // `@claxedo/tasks`, which the closure already counted. 1513/36, no headroom.
  // -7 modules (owner: the Tasks plugin, `@claxedo/tasks` `app/presets/`):
  // Settings → Presets left the app's tasks domain (`tasks/presets/*`) and is
  // the plugin's surface settings section. 1506/36, no headroom.
  // -33 modules (owner: the Tasks plugin, `@claxedo/tasks` `app/page/`): the
  // Tasks page left the app (`tasks/**`, `server/tasks.ts`) and is the
  // plugin's surface page. 1473/36, no headroom.
  // +1 package (owner: the Documents plugin): the app composes its operation
  // table with `@claxedo/documents/operations`, and the Documents app entry
  // ships as a second `@claxedo/<plugin>/app?claxedo-plugin-bundle` chunk; the
  // transcript's two document cases left for that entry's card templates.
  // 1473/37, no headroom.
  // +1 module (owner: the app's shared lib): `lib/route-params.ts`, the one
  // route-params equality the shell's route memos and a plugin page's params
  // memo both compare with. 1474/37, no headroom.
  // A harness's account rows, each account its own row with its kind, masked
  // key and where it works, the cloud-choice help popover, the Check spin while
  // that account's own check runs, the add-account drawer with the step its one
  // submit does, and the Models tab's settings placement for the connections
  // that still need a project (owner: the app's accounts domain,
  // `accounts/view/account-rows.ts`, `accounts/view/account-item.tsx`,
  // `accounts/view/cloud-choice-help.tsx`, `accounts/view/account-actions.css`,
  // `accounts/view/connect-drawer.tsx`, `accounts/connect-submit.ts`,
  // `accounts/settings-placement.ts`), in place of the Team accounts page, its
  // store and form, and the connect dialog. They add no package edge.
  // The session details the workspace panel's Context tab shows, Environment
  // and Background tasks (owner: the app's session domain,
  // `session/view/details/`: the panel view, both cards, their models, their
  // shared card frame and their strings). They add no package edge.
  // Sandbox usage's By provider table and its project and provider grouping
  // (owner: the app's usage domain, `usage/sandbox-groups.ts`,
  // `usage/view/sandbox-provider-table.tsx`). They add no package edge.
  // The lazy doors the web entry chunk needs (owner: the app's transcript
  // domain, `transcript/code-view-lazy.tsx`, `transcript/source-diff.tsx`,
  // `transcript/diff-source.ts`; the app's i18n domain,
  // `i18n/locale-loads.ts`; the app's accounts domain,
  // `accounts/harness-providers-state.tsx`,
  // `accounts/catalog-account-sources.ts`). They add no package edge.
  // Whether a session's live stream covers its snapshot reads, decided by
  // event feed position (owner: the app's server domain,
  // `server/snapshot-coverage.ts`). It adds no package edge.
  // The loaders for the sixteen non-English dictionaries of five more domains
  // (owner: the app's composer, session screen, panel, workbench and access
  // domains, `composer/locales/`, `session/view/locales/`, `panel/locales/`,
  // `workbench/locales/`, `access/locales/`; the composer's and session
  // screen's replace the inline files under their i18n folders), the lazy
  // doors the web entry chunk needs (owner: the app's panel domain,
  // `panel/view/panel-body-lazy.tsx`; projects, `projects/view/project-create-lazy.tsx`;
  // session screen, `session/view/session-docks-lazy.tsx`,
  // `session/view/docks/todo-dock-state.ts`; composer,
  // `composer/view/on-demand-views.tsx`, `composer/view/prompt-popover-ids.ts`;
  // settings, `settings/view/machine-connect.tsx`) and the static shiki
  // language table (owner: the app's transcript domain,
  // `transcript/markdown-code-languages.ts`). They add no package edge.
  // The gate that holds the code viewers', docks', composer's and panel's
  // prefetches until a session's first page has painted, and the paint
  // callback it shares with the workbench's deferred unmount (owner: the
  // app's shell and platform code, `lib/prefetch.tsx`, `lib/after-paint.ts`).
  // They add no package edge.
  // Transcript markdown turns an image, video or audio from another host into
  // a link and drops other remote fetches while it sanitizes (owner: the
  // app's transcript domain, `transcript/markdown-remote-media.ts`). It adds
  // no package edge.
  // The sign-in page's continuation of an authorization request, which waits
  // for a fresh sign-in when the request asks for one (owner: the app's auth
  // domain, `auth/view/login-redirect.ts`). It adds no package edge.
  // The reader of the deployment a hosted deploy publishes into the web shell
  // (owner: the app's server adapter, `server/published-deployment.ts`), which
  // the shared catalog read asks first; the desktop shell carries none, so it
  // answers nothing there. It adds no package edge.
  // The timeline's reader interaction, which owns the overscan band a
  // reader's scroll or toggle raises (owner: the app's session view,
  // `session/view/timeline/timeline-reader-interaction.ts`). It adds no
  // package edge.
  // The app's login route, which hosts the sign-in form on the client router
  // now that the form also renders in the web's signed-out document (owner:
  // the app's auth domain, `auth/view/login-page.tsx`), and the Codex theme's
  // tokens, extracted from the shell's overrides so that document shares them
  // (owner: the app's kit, `ui/codex-tokens.css`). Neither adds a package edge.
  // The session hosts a cloud workspace's sessions are served by, split from
  // the workspace catalog (owner: the app's server adapter,
  // `server/session-hosts.ts`). It adds no package edge.
  // 1546/37, no headroom.
  ceilings: { modules: 1546, packages: 37 },
  emitted: {
    file: "packages/claxedo-desktop/out/product-boundary/desktop-renderer-local.json",
    minModules: 700,
    minChunks: 1,
    requiredModules: [`${DESKTOP}/renderer/main.tsx`, `${APP}/app.tsx`, `${APP}/auth/electron-binding.ts`],
    forbiddenModules: [`${APP}/auth/better-auth-binding.ts`],
    forbiddenChunkMarkers: ["vendor-better-auth"],
  },
}
