---
date: 2026-04-10
topic: claxedo-app-layer-boundaries
---

# Claxedo App Layer Boundaries

## Problem Frame

`packages/claxedo-app` currently mixes app composition, shell UI, cloud product behavior, upstream overrides, and shared helpers in ways that look more modular than they really are.

Today the largest mixed surface is `src/claxedo-ui`, but the problem is wider than that:

- `src/index.tsx` exports cloud features, override-backed contexts, UI, and app bootstrap helpers from one package root.
- `src/main.tsx` does more than composition. It initializes analytics, builds the platform adapter, seeds demo state, and writes override-backed persistence before render.
- `src/overrides` is not just cosmetic shadow files. It includes provider topology and app/page composition that the current package depends on.
- Shell-heavy files directly import overrides, analytics, cloud APIs, and event providers, especially around `ClaxedoLayout`, `rail-sidebar`, and `top-tab-bar`.

The problem is not whether the current package works. It does. The problem is that the internal structure does not honestly reflect dependency ownership, which increases sync pain, makes architectural drift easy to hide, and makes it harder to tell which code is safe to move during upstream rebases.

The desired direction for this brainstorm is:

- make `claxedo-app` honest about its internal layers
- keep upstream sync viable by quarantining dangerous override surfaces
- make shell code depend on explicit ports instead of reaching directly into cloud and override details
- preserve a stable package surface while internal boundaries are corrected

## Requirements

**Target Layers**
- R1. `src/app` must own composition only: entrypoints, extension registration, bootstrapping, and app assembly.
- R2. `src/shell` must own the Claxedo workspace shell: rail, tabs, panes, layout state, and shell actions.
- R3. `src/cloud` must own cloud and product behavior: auth, SSE events, provisioning, cloud dialogs, cloud settings, and cloud-facing API clients.
- R4. `src/overrides` must remain the home for upstream shadow files only.
- R5. `src/shared` must contain only small helpers that are genuinely neutral and not shell-specific or cloud-specific.

**Boundary Rules**
- R6. Shell code must not import from overrides.
- R7. Shell code must not import auth, analytics, SSE, or cloud API clients directly.
- R8. Overrides may depend on shell or cloud when needed, but shell and cloud must not depend on overrides as a normal runtime path.
- R9. Cloud may depend on shell only through explicit public APIs, not shell internals.
- R10. Each layer must have a small `index.ts` public surface.
- R11. Once those public surfaces exist, new deep imports across layers must be blocked.

**Migration Safety**
- R12. The refactor must preserve a stable package-level compatibility surface while internal files move.
- R13. The migration must account for current alias and override resolution behavior rather than assuming path strings reflect the real dependency graph.
- R14. The first implementation step must prove at least one real boundary improvement rather than producing only folder churn.
- R15. Any import-policy enforcement must understand temporary compatibility shims during migration.

**Override and Sync Constraints**
- R16. The refactor must not make daily upstream sync harder by spreading override logic across new generic directories.
- R17. Overrides that currently exist because of provider topology or app composition must not be treated as trivial cleanup candidates without a replacement seam.
- R18. The architecture doc must explain which runtime edges are intentionally override-backed during the transition.

## Success Criteria

- A reader can tell which code belongs to app composition, shell, cloud, overrides, and neutral shared helpers without guessing.
- The package root no longer acts as a single mixed barrel for unrelated concerns.
- Shell hot paths stop reaching directly into cloud and override internals.
- Import-policy checks catch genuinely dangerous edges without blocking the migration itself.
- The new structure reduces sync risk instead of only renaming it.

## Scope Boundaries

- This brainstorm does not define the full file-by-file migration map.
- This brainstorm does not require immediate elimination of every override.
- This brainstorm does not require upstream extension-point work to be solved in the first step.
- This brainstorm does not require one-pass movement of all current `components`, `context`, `providers`, `utils`, `pages`, `process`, or `analytics` modules.

## Key Decisions

- Use five explicit internal layers: `app`, `shell`, `cloud`, `overrides`, `shared`.
  Rationale: this is the clearest way to make current ownership visible and keep dangerous sync surfaces quarantined.

- Do not start with a broad `claxedo-ui -> shell` rename.
  Rationale: a rename without dependency cleanup mostly creates churn and can preserve the same coupling under a better folder name.

- Add compatibility shims before physical file moves.
  Rationale: the current package root is already a mixed public surface, so the migration needs stable facades before it can safely relocate implementation files.

- Treat shell decoupling as an adapter problem, not a naming problem.
  Rationale: the current shell pulls in analytics, providers, APIs, and overrides directly, so folder motion alone will not enforce the desired rules.

- Start import-policy enforcement narrowly and make it resolver-aware.
  Rationale: current aliasing and override-first resolution mean naive path-string checks will miss real violations and may block valid bridge imports.

- Shrink overrides only after proving which override-backed edges can be replaced.
  Rationale: several overrides exist because of provider and composition topology, not because shared logic is quietly accumulating there.

## Current Evidence

- `src/index.tsx` is a mixed package surface that exports cloud init/config, auth helpers, pages, providers, override-backed contexts, UI components, and `AppBaseProviders`.
- `src/main.tsx` is a cloud-specific entrypoint that also initializes analytics, demo persistence, config, and events.
- `src/overrides/README.md` documents override-first aliasing and instructs non-override code to import overridden contexts from `@opencode-ai/claxedo-app`.
- A quick repo read found substantial shell leakage in `src/claxedo-ui`, including imports into overrides, cloud APIs, analytics, and providers from core shell files.

## Implementation Risks

- The first wave is not actually "move files only." It is also a public-surface migration because the package root already acts as a compatibility barrel.
- The desired shell/cloud boundary does not exist yet in code, so moving folders first would mostly rename the coupling.
- `src/app` is underspecified if it is expected to contain only composition while current bootstrap code also performs runtime setup concerns.
- A lightweight import checker that does not resolve aliases and compatibility shims will be too noisy or too weak to trust.
- `src/overrides` includes load-bearing composition and context behavior, so "shrink overrides" is likely phase-two work rather than a first-milestone deliverable.

## Recommended Sequencing

1. Write `packages/claxedo-app/ARCHITECTURE.md` and document the five layers plus the current exceptions.
2. Add new layer barrels and compatibility shims so old imports can keep working while internals move.
3. Add a narrow, resolver-aware import-policy check for the most dangerous edges first.
4. Extract adapter seams from the worst shell offenders before broad folder motion.
5. Move one representative slice end-to-end and verify the boundary is real.
6. Only then do wider file moves and the eventual `claxedo-ui -> shell` rename.
7. Revisit override reduction after the new boundaries hold in practice.

## Outstanding Questions

### Resolve Before Planning

- Should `src/app` stay composition-only, or do we need an explicit `bootstrap` or `runtime` namespace under it for setup concerns now living in `main.tsx`?
- What should count as the stable external package surface during migration: only `src/index.tsx`, or temporary layer-specific entrypoints too?

### Deferred to Planning

- Which exact shell adapters should be extracted first from `ClaxedoLayout`, `rail-sidebar`, and `top-tab-bar`?
- How should the import-policy checker resolve aliases, package self-imports, and override-backed shims?
- Which current top-level directories map cleanly to `cloud` or `shared`, and which need to be split first?
- Which overrides are candidates for replacement by extension points versus long-term quarantine?

## Next Steps

→ /prompts:ce-plan for a concrete migration map and phased implementation plan
