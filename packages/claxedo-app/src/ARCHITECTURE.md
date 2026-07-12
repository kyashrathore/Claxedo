# Claxedo App Architecture

`packages/claxedo-app/src` is organized by ownership. Production code lives under five roots: `app`, `features`, `platform`, `ui`, and `lib`. The `architecture` root contains guards and their tests.

## Dependency direction

Runtime dependencies follow this direction:

```text
app
 ├─ features/*
 ├─ platform/*
 ├─ ui
 └─ lib

features/* → platform/*, ui, lib
platform/* → platform/*, lib
ui         → lib
lib        → external dependency-light utilities only
```

Features are independent runtime owners. Cross-feature behavior is assembled by `app/integrations`; a feature exposes a small contract and the app supplies its adapters. Type-only imports may describe those contracts without creating runtime ownership edges.

The ownership guard in `architecture/ownership.guard.test.ts` classifies every source file and enforces this graph. Per-owner `AGENTS.md` files add local rules.

## Owners

### `app/`

Application composition and product chrome:

- `entry/`: web/package boot and the top-level provider tree
- `routes/`: URL ownership and route-level gates
- `providers/`: app-wide composition contexts
- `integrations/`: feature ports, commands, events, and surface registration
- `connection/`: server selection and health UI
- `workbench/`: panes, rail, titlebar, layout state, navigation, and content assembly
- `dialogs/`, `controls/`, `styles/`, and `demo/`: app-owned presentation and alternate boot support

Add a route in `app/routes`. Add a provider here only when it composes multiple owners or its lifetime is the entire application.

### `features/`

User-facing vertical capabilities. Each feature owns its domain logic, state, UI, tests, and public contract. Current owners include session, terminal, workspaces, documents, review, settings, processes, browser, and extensions.

Add domain behavior to its feature. Add a feature API client beside the feature's data/query code when it is specific to that capability. A feature may use platform services and reusable UI but does not import another feature at runtime.

### `platform/`

Headless capabilities shared by multiple features, including API transport, auth, identity, query infrastructure, persistence, runtime placement, synchronization, files, notifications, telemetry, settings, i18n, and comments.

Platform modules express infrastructure semantics and remain independent of feature and workbench UI.

### `ui/`

Reusable visual primitives and policies that are independent of product state. A module belongs here when it is genuinely reusable and imports only `lib` plus external design/runtime packages.

Add a reusable control here. A dialog tied to a feature or app workflow stays with that owner.

### `lib/`

Small dependency-light utilities: path and URL helpers, encoding, retry, IDs, caches, and similarly owner-neutral functions. Add a primitive here only when it has no UI, platform, feature, or app knowledge.

### `architecture/`

Executable topology rules, source scanners, baselines, and migration guards. The migration manifest is empty after the cutover; new production roots are rejected.

## Composition boundary

`app/integrations/feature-ports.ts` supplies app-owned implementations to feature contracts. `app/entry/app.tsx` installs the ports before the application renders, so web, desktop, and direct package consumers share the same graph.

Surface registration remains lazy where a feature is expensive. Route strings, command IDs, content IDs, query keys, and persisted workbench shapes are behavior contracts and are independent of module location.

## Where code goes

| Change | Owner |
|---|---|
| New URL or route gate | `app/routes` |
| Session, terminal, document, review, workspace, or settings behavior | matching `features/<name>` owner |
| Shared transport, identity, storage, query, filesystem, or runtime capability | named `platform/<capability>` owner |
| Cross-feature command or adapter | `app/integrations` |
| Pane, rail, titlebar, or layout behavior | `app/workbench` |
| Reusable visual control with no product state | `ui` |
| Dependency-light non-UI primitive | `lib` |

## Verification

Run from `packages/claxedo-app`:

```sh
bun typecheck
bun run test:vitest
bun run build
```

`bun typecheck` includes theme-token linting, the complete architecture suite, TypeScript, and the workbench performance checks.
