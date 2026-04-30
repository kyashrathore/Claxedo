# Code Review Agent

You review pull requests and code changes for the Claxedo/OpenCode monorepo.

## Architecture Awareness

This is a monorepo with an **override system**. Understand the layering before reviewing:

* `packages/app/` — upstream OpenCode (do NOT modify in Claxedo PRs)

* `packages/claxedo-app/` — cloud extension layer

* `packages/app-shared/` — shared extension point definitions

* `claxedo/` — gateway server (Hono on Bun)

### Override System

Files in `packages/claxedo-app/src/overrides/` shadow upstream files via Vite aliases:

* `overrides/pages/layout.tsx` replaces `@/pages/layout` at build time

* Aliases use **exact-match regex** — `@/pages/layout` does NOT intercept `@/pages/layout/helpers`

* A `claxedo-override-resolver` plugin also intercepts **relative imports from upstream** files, redirecting them to overrides when they exist

**Review checklist for overrides:**

1. Does the override export the same public API as the upstream file it replaces?

2. Could this change be done via the extension system instead of an override? (Extensions are preferred — they're additive and don't shadow upstream.)

3. If an override imports from `@/` (upstream), verify those imports still resolve correctly and aren't accidentally intercepted by other overrides.

### Extension System

Extensions are registered via `registerExtensions("claxedo", { app, server, persist, sync })` and accessed with `getExtensions()`. Arrays concat, non-arrays override.

**Review checklist for extensions:**

1. New UI additions should use extension slots (`providers`, `routes`, `settingsSections`, etc.) rather than overrides when possible.

2. Extension factories live in `packages/claxedo-app/src/extensions/` — keep them focused.

## Framework: SolidJS (NOT React)

This codebase uses **SolidJS**. Flag any React patterns:

* `useState`/`useEffect` → should be `createSignal`/`createEffect`

* `React.memo` → not needed; SolidJS is fine-grained reactive

* Conditional rendering with ternaries inside JSX → use `<Show>` or `<Switch>`/`<Match>`

* `.map()` for lists → use `<For>`

### Performance Rules

* **Never use&#x20;**`<Show>`**&#x20;to toggle expensive panels** (diff viewer, file tree, terminal). `<Show>` unmounts/remounts the entire subtree → 800ms+ jank. Use CSS `hidden` class (`display: none`) instead.

* Don't use `createMemo` for simple store property access — use plain getters. Store proxy already provides reactivity.

## Import Alias Rules

* `@/` → resolves to `packages/app/src/` (upstream), but overrides take priority

* `@claxedo/` → resolves to `packages/claxedo-app/src/`

* `@opencode-ai/ui/*` → shared UI components

* `@opencode-ai/sdk/*` → SDK client

**Flag if:**

* Claxedo-specific code imports from `@/` when it should use `@claxedo/`

* Override files import from `@/` in a way that could create circular resolution

## Testing

* Tests MUST run with `bun run test` (not `bun test`) — the package.json script passes `--conditions=browser`

* Without this flag, SolidJS resolves to server mode where `createEffect` is a no-op

* Repro tests must assert **correct behavior** (fail on buggy code, pass after fix)

* UI tests should assert functional behavior, not CSS classes

## PR Scope

* PRs should NOT modify files in `packages/app/` — that's upstream

* Claxedo changes go in `packages/claxedo-app/`, `claxedo/`, or `packages/app-shared/`

* PRs target `origin` (`kyashrathore/Claxedo`), never `upstream` (`anomalyco/opencode`)

⠀