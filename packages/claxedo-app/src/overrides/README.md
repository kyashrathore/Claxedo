# Claxedo File Override Tombstone

This directory is intentionally empty of production TypeScript and TSX files.
It remains as a tombstone for the former upstream `@opencode-ai/app` override
layer and as a guardrail against reintroducing dynamic override scanning.

## How It Works

The override system no longer scans this directory. Claxedo-owned replacements
for upstream `@/...` modules live in normal first-party `src/**` locations and
are wired through explicit aliases in `vite.cloud.config.ts`,
`vitest.config.ts`, `packages/claxedo-desktop/vite.renderer.ts`, and the
package tsconfigs. The broad `@/*` fallback now points only at
`packages/app/src/*`.

## File Manifest

No production override files remain under `src/overrides`.

The Claxedo app shell now lives at `src/app.tsx`. Upstream `@/app` consumers
are mapped there by a first-party owner alias so auth, hosted routes, query
persistence, and Workbench layout mounting no longer depend on an override file.

The Claxedo route layout now lives at `src/pages/layout.tsx`. Upstream
`@/pages/layout` consumers are mapped there by a first-party owner alias so
route prefetch, navigation, project/theme command surfaces, and sidebar state no
longer depend on an override file.

The Claxedo session page now lives at `src/pages/session.tsx`. Upstream
`@/pages/session` consumers are mapped there by a first-party owner alias so
Workbench session rendering, message timeline wiring, and composer handoff no
longer depend on an override file.

The Claxedo global-sync provider now lives at `src/context/global-sync.tsx`.
Upstream `@/context/global-sync` consumers are mapped there by a first-party
owner alias so query factories, event stream projection, and global session
inventory no longer depend on an override file.

The Claxedo GlobalSDK provider now lives at `src/context/global-sdk.tsx`.
Upstream `@/context/global-sdk` consumers are mapped there by a first-party
owner alias so signed event access, runtime event projection, and live-session
event routing no longer depend on an override file.

The Claxedo Terminal provider now lives at `src/context/terminal.tsx`.
Upstream `@/context/terminal` consumers are mapped there by a first-party
owner alias so server-scoped persistence, PTY lifecycle routing, terminal cache
release handles, and workspace-runtime terminal relay support no longer depend
on an override file.

The Claxedo Layout provider now lives at `src/context/layout.tsx`. Upstream
`@/context/layout` consumers are mapped there by a first-party owner alias so
project inventory, layout persistence, tabs, workspace/session view state, and
project metadata updates no longer depend on an override file.

The Claxedo status popover intentionally hides upstream global status from
session chrome, but that implementation now lives at
`src/components/status-popover.tsx` and is imported through `@claxedo/...`
instead of this override directory.

The Claxedo home page now lives at `src/pages/home.tsx` and is imported through
`@claxedo/...`; upstream `@/pages/home` consumers are mapped there by a
first-party owner alias so hosted project creation and loopback project ensure
do not depend on an override file.

The Claxedo SDK provider now lives at `src/context/sdk.tsx`. Upstream
`@/context/sdk` consumers are mapped there by a first-party owner alias so
signed workspace file/search routing and provider-scoped runtime request
dedupe do not depend on an override file.

The Claxedo File provider now lives at `src/context/file.tsx`. Upstream
`@/context/file` consumers are mapped there by a first-party owner alias so
file tree, read cache, and view state no longer depend on an override file.

The Claxedo Prompt provider now lives at `src/context/prompt.tsx`. Upstream
`@/context/prompt` consumers are mapped there by a first-party owner alias so
prompt persistence, comment context, and per-session prompt caches no longer
depend on an override file.

The Claxedo Local provider now lives at `src/context/local.tsx`. Upstream
`@/context/local` consumers are mapped there by a first-party owner alias so
provider/model selection, local handoff, and session-config sync no longer
depend on an override file.

The Claxedo session command hook now lives at
`src/pages/session/use-session-commands.tsx`. Upstream
`@/pages/session/use-session-commands` consumers are mapped there by a
first-party owner alias so Workbench-pane command routing no longer depends on
an override file.

The Claxedo directory route pass-through now lives at
`src/pages/directory-layout.tsx` and is imported through `@claxedo/...`
instead of this override directory.

The Claxedo error page now lives at `src/pages/error.tsx` and is imported
through `@claxedo/...`; upstream `@/pages/error` consumers are mapped there by
a first-party owner alias so Sentry-backed upstream error UI does not return.

The Claxedo new-session empty view now lives at
`src/components/session/session-new-view.tsx` and is imported through
`@claxedo/components/session`; upstream `@/components/session/session-new-view`
consumers are mapped there by a first-party owner alias.

The Claxedo session header now lives at
`src/components/session/session-header.tsx` and is imported through
`@claxedo/components/session`; upstream `@/components/session/session-header`
consumers are mapped there by a first-party owner alias.

The Claxedo session context tab now lives at
`src/components/session/session-context-tab.tsx` and is imported through
`@claxedo/components/session`; upstream
`@/components/session/session-context-tab` consumers are mapped there by a
first-party owner alias.

The Claxedo language context now lives at `src/context/language.tsx` and is
imported through `@claxedo/...` so extension strings merge into the same
provider instance used by upstream `/context/language` consumers.

The Claxedo server context now lives at `src/context/server.tsx` and is imported
through `@claxedo/...`; upstream `@/context/server` consumers are mapped there
by a first-party owner alias.

The Claxedo notification context now lives at `src/context/notification.tsx`
and is imported through `@claxedo/...`; upstream `@/context/notification`
consumers are mapped there by a first-party owner alias.

The Claxedo provider-selection dialog now lives at
`src/components/dialog-select-provider.tsx` and is imported through
`@claxedo/...`; upstream `@/components/dialog-select-provider` consumers are
mapped there by the first-party owner alias.

The Claxedo custom-provider dialog now lives at
`src/components/dialog-custom-provider.tsx` and is imported through
`@claxedo/...`; upstream `@/components/dialog-custom-provider` consumers are
mapped there by the first-party owner alias.

The Claxedo provider-connect dialog now lives at
`src/components/dialog-connect-provider.tsx` and is imported through
`@claxedo/...`; upstream `@/components/dialog-connect-provider` consumers are
mapped there by the first-party owner alias.

The Claxedo directory and file picker dialogs now live at
`src/components/dialog-select-directory.tsx` and
`src/components/dialog-select-file.tsx`; upstream
`@/components/dialog-select-directory` and `@/components/dialog-select-file`
consumers are mapped there by first-party owner aliases.

The Claxedo model-management dialog now lives at
`src/components/dialog-manage-models.tsx` and is imported through
`@claxedo/...`; upstream `@/components/dialog-manage-models` consumers are
mapped there by the first-party owner alias.

The Claxedo unpaid-model selection dialog now lives at
`src/components/dialog-select-model-unpaid.tsx` and is imported through
`@claxedo/...`; upstream `@/components/dialog-select-model-unpaid` consumers are
mapped there by the first-party owner alias.

The Claxedo model-selection dialog and popover now live at
`src/components/dialog-select-model.tsx` and are imported through
`@claxedo/...`; upstream `@/components/dialog-select-model` consumers are
mapped there by the first-party owner alias.

The Claxedo MCP marketplace dialog now lives at
`src/components/dialog-select-mcp.tsx` and is imported through
`@claxedo/...`; upstream `@/components/dialog-select-mcp` consumers are mapped
there by the first-party owner alias.

The Claxedo settings dialog, general settings, and provider settings now live
at `src/components/dialog-settings.tsx`, `src/components/settings-general.tsx`,
and `src/components/settings-providers.tsx`; upstream `@/components/...`
consumers are mapped there by first-party owner aliases.

The Claxedo persisted-storage helpers now live at `src/utils/persist.ts` and
are imported through `@claxedo/...`; upstream `@/utils/persist` consumers are
mapped there by a first-party owner alias.

## Adding First-Party Owners

Do not add production `.ts` or `.tsx` files to this directory. Put Claxedo code
under `packages/claxedo-app/src/**`, then add an explicit first-party owner alias
for any upstream `@/...` module that must resolve to the Claxedo implementation.

## Import Conventions

### Within First-Party Owner Files

Always use `@/...` for imports from the app package:

```typescript
// Good
import { useSDK } from "@/context/sdk"
import { Link } from "@/components/link"

// Bad - relative imports to upstream files split owner identity
import { useSDK } from "./sdk"
import { Link } from "./link"
```

### From Other Claxedo Files

When importing contexts/hooks/components that are overridden, import from `@opencode-ai/claxedo-app` instead of `@opencode-ai/app`:

```typescript
// Good - gets the overridden version
import { useGlobalSync, useGlobalSDK, useServer } from "@opencode-ai/claxedo-app"

// Bad - gets the upstream version (may cause context mismatch errors)
import { useGlobalSync, useGlobalSDK, useServer } from "@opencode-ai/claxedo-app"
```

The following should be imported from `@opencode-ai/claxedo-app`:
- `useGlobalSync`, `GlobalSyncProvider`
- `useGlobalSDK`, `GlobalSDKProvider`
- `useLayout`, `LayoutProvider`
- `useServer`, `ServerProvider`
- `usePlatform`, `PlatformProvider`
- `useTerminal`, `TerminalProvider`
- `useSettings`, `SettingsProvider`
- `useCommand`, `CommandProvider`
- `useLanguage`, `LanguageProvider`
- `useSync`, `SyncProvider`
- `useFile`, `FileProvider`
- `useComments`, `CommentsProvider`
- `usePrompt`, `PromptProvider`
- `Persist`, `persisted`
- `Terminal`, `PromptInput`, `Titlebar`

The following can still be imported from `@opencode-ai/app`:
- `AppBaseProviders`, `AppInterface`
- `AppProvider` components that don't depend on overridden contexts

Use `@claxedo/...` for imports from claxedo-app's own modules:

```typescript
import { getExtensions } from "@claxedo/extensions"
```

## Context Level Architecture

The app has two levels of context providers:

### App Level (Outside SDKProvider)
- `ClaxedoLayoutProvider`
- `CommandProvider`
- `GlobalSyncProvider` (overridden)
- `GlobalSDKProvider` (overridden)
- `ServerProvider` (overridden)
- etc.

### Directory Level (Inside SDKProvider)
- `TerminalProvider` (first-party owner alias)
- `SyncProvider`
- `FileProvider`
- etc.

**Important**: Components at the app level cannot use hooks that depend on directory-level providers:

| Component | Level | Uses | Required Provider | Status |
|-----------|-------|------|-------------------|--------|
| `TabSession` | App | `useSync()` | `SyncProvider` (directory) | ❌ Cannot render |
| `TabTerminal` | App | `useTerminal()` | `TerminalProvider` (directory) | ❌ Cannot render |
| `TabReview` | App | `useSync()` | `SyncProvider` (directory) | ❌ Cannot render |

### Solution: Portal Pattern

To render directory-scoped content inside app-scoped UI, we use **Solid's Portal**:

1. **App scope** renders a DOM *host* (mount point) with a stable ID
2. **Directory scope** creates the content under providers and **Portals** it into the host

**Why this works**: Solid context is tied to component owner (creation site), not DOM insertion.

```
App branch (no directory providers)
ClaxedoLayout
└─ RailLayout
   └─ TabContentArea
      └─ <div id="claxedo-tab-host-TAB_ID" />  ← Host

Directory branch (has directory providers)
DirectoryLayout
└─ SDKProvider
   └─ SyncProvider
      └─ GroupContentRenderer / DirectoryScope  ✅ hooks work!
```

### Implementation

**TabContentArea** (app scope): Renders host elements
```tsx
<div id={getTabHostId(tab.id)} />
```

Session/review/terminal content is rendered directly in group-scoped directory trees (`GroupContentRenderer` + `DirectoryScope`).

See `../../../../docs/tech-docs/ai-infra/README.md` for the active Claxedo architecture.

For more detail, keep local notes in `.dev-docs/` (gitignored).

## Build Commands

```bash
# Development
bun run dev

# Production build
bun run build

# Electron desktop dev
bun --cwd ../claxedo-desktop dev
```

## Maintenance

When upstream changes a first-party-owned file:

1. Compare upstream changes against our overrides (example: `git diff upstream/dev -- packages/app/src/components/terminal.tsx`)
2. Manually merge relevant changes into the corresponding first-party owner under `packages/claxedo-app/src/**`
3. Test: `bun run --cwd packages/claxedo-app build`
 
You can also detect changes by comparing upstream files under `packages/app/src/**`
with the explicit first-party owner aliases in the app, test, and desktop
configs.
