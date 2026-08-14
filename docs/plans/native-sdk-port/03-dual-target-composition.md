# 03 — Dual-target composition: one definition, web-direct + native-compiled

Goal (owner's directive): structure the app so its parts COMPOSE into both
targets — running in the browser directly (plain TS/DOM, no wasm) and
compiling into the Native SDK binary — instead of maintaining two apps that
merely look alike.

## Why this is possible here at all

Native SDK's app model is the portable shape by accident of design:
- **Logic is Elm-ish TypeScript** (Model → Msg → one `update`) with no JS
  runtime dependencies. Plain TS in that shape runs in a browser natively —
  the same file can be both a browser module and a compiled core, IF it
  stays inside the cores subset.
- **Views are a closed declarative grammar** (fixed widget list, bounded
  expressions, token-only styling). A closed grammar is small enough to
  have a second implementation — and we already OWN web implementations of
  every widget class it names (`packages/ui`, `packages/session-ui`,
  solid-virtual lists, the pane splitter). A web renderer for the grammar
  is component mapping, not framework building.
- **Tokens already dual-emit** by plan (ADR-4: one source → CSS variables +
  native tokens).

So the composition is: one logic layer + one view definition + two thin
renderers + two shells. Nothing is written twice except the renderer
bindings and the per-platform escape hatches.

## The layers

```
L0  server child (unchanged)        — HTTP/SSE contract, both targets' backend
L1  shared core   packages/app-core — pure TS: api types, query-cache logic,
                                      session/timeline row model, composer
                                      state machine. NO imports beyond an
                                      allowlist; NO DOM/Node globals; effects
                                      through injected ports (fetch, SSE,
                                      storage, clock). Guard-enforced.
L2  view definition                 — the surface trees in the closed widget
                                      grammar (markup files, or a typed TS
                                      builder that emits it), bound to L1
                                      state by name.
L3a web renderer                    — grammar → existing Solid components +
                                      CSS tokens; ships INSIDE the current
                                      web app, surface by surface.
L3b native renderer                 — the Native SDK engine itself (free).
L4  shells                          — web: existing app shell (strangler);
                                      native: app.zon, windows, server-child
                                      spawn, Zig surfaces.
esc escape-hatch registry           — per-surface platform impls: terminal
                                      (web: existing / native: Zig canvas),
                                      math+mermaid (web: katex+mermaid /
                                      native: server-render or WebView
                                      island), auth (web: Clerk / native:
                                      system browser or WebView).
```

The L1 constraint is the load-bearing one: code written to the cores
subset with injected ports is trivially browser-runnable; the reverse is
not true. So the rule is "write L1 for native, run it on web" — never the
other way around.

## What this adds to the uncertainty MVP (extends 01)

- **U9 — grammar round-trip.** Define ONE surface (session timeline) once
  in the grammar; render it with the native engine AND the web kit;
  screenshot-diff both against each other and against today's app. This
  is the pivot's core bet — if the closed grammar cannot express the
  timeline (or the web mapping can't match it), the composition degrades
  to "shared L1, hand-written views per target," which is still worth
  having but is a different (weaker) promise. Decide per evidence.
- **U10 — same-file dual execution.** Write the query-cache core once;
  run its unit tests under BOTH a browser-env runner and the Native SDK
  core test runner, from the same source file. This subsumes and
  sharpens U3: it proves not just "cores are expressive enough" but
  "the exact artifact is shared," including module format and the
  ports-injection seam.

U1–U8 from sub-plan 01 stand unchanged; S1/S3a merge naturally into
U9/U10's slices.

## Migration order (strangler — every step ships in the web app now)

1. **Extract L1** into `packages/app-core` with a guard test (import
   allowlist, no DOM/Node globals — same style as the existing
   architecture suite). First residents, chosen because they are already
   nearly pure: the timeline row model (`timeline-row-model.ts`, already
   extracted during the perf effort), `relative-time`, the query
   staleTime/single-flight logic, the composer readiness state machine.
   The current Solid app consumes them from the new package immediately —
   refactor, not fork.
2. **Token dual-emitter** (ADR-4) — CSS vars for web, token file for
   native; the web app switches to the emitted CSS to prove the source of
   truth.
3. **U9 slice**: timeline in the grammar + web renderer behind a flag in
   the current app. The web app is the grammar's first production
   consumer — the native engine has to match IT.
4. **Native shell skeleton** (S3b): spawn server child, render the same
   timeline definition natively; U9 parity gate.
5. Surface by surface: composer → rail → settings → panes. Terminal last
   (Zig, esc-registry). Parity matrix tracks which surfaces are
   grammar-defined vs escape-hatched per platform.

## Web renderer framework — decision record (2026-08-14)

**Owner's decision: Solid 2.0.** Evaluated field: Solid 1.x (full widget-kit
reuse, `reconcile` built in, measured fast in this app), Solid 2.0 (RC;
staged microtask writes, compute/apply effects, stores in core,
`@solidjs/web`, removed `batch`/`onMount`/`createResource`/`produce`),
Svelte 5 (best codegen target, stable, no kit reuse), Vue Vapor / Preact /
Lit (no kit reuse, weaker fit), React (wrong update model for token
streaming). The grammar keeps the framework swappable — emitters are
per-framework, definitions never change — so this decision binds the
emitter, the widget kit, and the `runCore` bridge, not the view sources.

Consequences accepted with the decision:
- **The existing web app migrates Solid 1 → 2 as its own workstream**
  (breaking changes touch effects, stores, resources, and mount points
  across the app). Running Solid 1 host + Solid 2 islands in one page —
  two reactive runtimes — is rejected: it re-introduces exactly the
  duplicate-dependency weight this perf effort removed. Migration lands
  first, gated by the existing e2e suite and perf gates.
- **Two moving platforms at once** (Solid 2 RC + Native SDK pre-1.0).
  Mitigations: pin exact RC versions; upgrade deliberately per release,
  never transitively; the `runCore` bridge and widget kit are the ONLY
  code allowed to touch framework APIs directly (guard-enforced), so
  churn is contained to two modules.
- **Verify the Elm bridge on Solid 2 semantics**: writes are staged and
  commit on microtasks, and `produce` is gone in favor of draft-mutating
  store setters. Whether a `reconcile` equivalent ships in 2.0 is
  unconfirmed — if absent, the bridge carries its own keyed structural
  diff applied through a draft setter. This is U11's spike, not an
  assumption.

## Failure containment

If Native SDK stalls (pre-1.0 churn, U8) or the grammar proves too
narrow (U9), what survives is real: L1 extraction and the token emitter
improve the existing web app's structure regardless, and the grammar/IR
plus web renderer would work against ANY future native backend that can
implement ~30 widgets. The sunk cost of the pivot is bounded to L3b
bindings and Zig surfaces.
