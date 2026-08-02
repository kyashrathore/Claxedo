# Contributing to Claxedo App

`packages/claxedo-app` is the first-party Claxedo web application. Its source has one ownership model; there is no upstream override layer.

Read `src/ARCHITECTURE.md` for dependency direction and placement guidance, and `src/VOCABULARY.md` before adding identity or workbench terminology.

## Development

```sh
cd packages/claxedo-app
bun run dev
```

For the desktop renderer:

```sh
cd packages/claxedo-desktop
bun run dev
```

## Adding code

- Put application boot, routes, provider composition, integrations, and workbench chrome under `src/app`.
- Put domain behavior, state, UI, and tests under the matching `src/features/<name>` owner.
- Put shared headless infrastructure under a named `src/platform/<capability>` owner.
- Put reusable product-independent visual controls under `src/ui`.
- Put small dependency-light non-UI primitives under `src/lib`.
- Use `@/` for imports within this package and real package names for cross-package imports.
- Keep features runtime-independent. Assemble feature interactions in `app/integrations` through typed feature ports.
- Follow the nearest `AGENTS.md` charter.

## Tests

Tests are colocated with their subjects.

- `*.test.ts` and `*.test.tsx` use `bun:test` for pure logic and lightweight browser-condition tests.
- `*.vitest.ts` and `*.vitest.tsx` use Vitest plus `@solidjs/testing-library` when a real Solid mount, reactive timing, keyboard interaction, or ARIA state is required.
- Never mix Bun and Vitest imports in one file.
- Mock I/O or explicit feature-port boundaries. Exercise the real production subject and assert concrete values, DOM state, or ordered side effects.
- Architecture and source-topology rules belong in `src/architecture`, not in scattered source-text assertions.

Run the standard package gates from this directory:

```sh
bun typecheck
bun run test:vitest
bun run build
```

Run an individual Bun test with the browser condition and preload when it mounts Solid code:

```sh
bun test --conditions=browser --preload ./happydom.ts path/to/subject.test.ts
```

## Style

- Prefer `const`, early returns, inferred types, and direct property access.
- Keep simple single-use logic inline; extract helpers when they name a real boundary or simplify a complex happy path.
- Avoid `any`, unnecessary `try`/`catch`, and duplicated state mirrors.
- Preserve route strings, command IDs, content IDs, query keys, and persisted workbench shapes unless the change explicitly migrates those contracts.
