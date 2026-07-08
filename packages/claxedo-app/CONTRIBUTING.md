# Contributing to Claxedo App

Claxedo extends OpenCode through overrides and shared desktop renderer code while keeping upstream packages easy to sync.

## Scope

Contribute to Claxedo for:

- cloud features
- authentication and account flows
- Claxedo-specific UI
- Electron desktop integration
- remote access and workspace orchestration

Contribute upstream for:

- generic OpenCode improvements
- shared UI or performance work
- reusable extension points

## Development

### Web

```bash
cd packages/claxedo-app
bun run dev
```

### Desktop

```bash
cd packages/claxedo-desktop
bun run dev
```

The Electron renderer source lives in `packages/claxedo-desktop/src/renderer`.

## First-Party Owners

Claxedo keeps custom behavior in explicit first-party owners under `src/**` so
upstream `packages/app` can stay close to `upstream/dev`.

1. Put Claxedo-owned files under `packages/claxedo-app/src/**`.
2. Add an exact alias for upstream `@/...` consumers in the app, Vitest, desktop, and tsconfig alias maps.
3. Do not add production `.ts` or `.tsx` files under `src/overrides`; that directory is only a tombstone for the retired scanner.

## Verification

Run checks from the package directories, not the repo root.

```bash
cd packages/claxedo-app
bun run build

cd ../claxedo-desktop
bun run build
```

If you change behavior, add or update tests in the affected package.

## Before Opening a PR

1. Verify Claxedo changes do not require editing upstream packages unless that is the explicit goal.
2. Run the relevant web and Electron checks.
3. Update docs or changelog entries for user-facing changes.
