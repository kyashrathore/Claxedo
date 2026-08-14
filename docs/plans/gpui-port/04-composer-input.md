# 04 — Composer & input

## Scope
Prompt editor, mode/slash commands, attachments, model/harness selectors,
keybindings, IME.

## Current implementation
- Composer: `packages/claxedo-app/src/features/session/composer/**` (v2
  engine `v2/engine.ts` + `controller-engine.ts` via the light
  session-kit-prompt boundary), region/state
  `features/session/ui/composer/session-composer-*`.
- Keybindings: inventory + collision policy in
  `src/architecture/keybind-collisions.guard.test.ts` (the canonical chord
  table — port THIS as the source of truth); command palette registry.
- Selectors: model picker (`features/session/providers/models.tsx` — note
  the per-provider detail loading fix), harness selector.

## Target design
- gpui-component Input/TextArea for the editor; if multiline+decorations
  outgrow it, GPUI's text editing primitives (Zed's editor is the ceiling —
  we need ~5% of it). Attachments as chips; drag-drop via GPUI drop events.
- Command/keymap: GPUI has first-class keymap contexts — port the chord
  inventory verbatim, keep the collision guard as a Rust test.
- IME: EXPLICIT acceptance item per platform (CJK composition in the
  composer; GPUI IME support exists but verify wayland/windows paths).

## Acceptance
Typing latency: keypress→paint < 16.7 ms p99 on reference hardware (measure
with GPUI's frame instrumentation); all chords from the inventory work; IME
composition verified on all three desktops (manual checklist, recorded).
