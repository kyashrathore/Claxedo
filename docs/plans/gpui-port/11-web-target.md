# 11 — Web target (ADR-1 spike & decision)

THE deciding sub-plan. Requirement: same app on web. GPUI has no production
web backend; do not design around a wish.

## Spike W1 — GPUI on wasm/WebGPU (time-boxed hard)
- Attempt: compile a minimal gpui-component app (button + list + text) to
  wasm32, render via WebGPU in Chromium.
- Expected blockers to CATALOG (not fix): platform layer (winit-less
  windowing), text system (CoreText/DirectWrite/fontconfig deps → need
  cosmic-text path), threads (wasm threads + atomics), IME/clipboard/a11y.
- Output: a written feasibility verdict with an effort ORDER-OF-MAGNITUDE.
  Kill criterion: if text rendering alone needs forking GPUI's text system,
  W1 is a platform project (quarters, not weeks) — record and fall back.

## Fallback W2 — dual frontend, shared everything-but-pixels (default)
- Web KEEPS the (now fast) Solid app. Shared: server contract + contract
  tests, design tokens (02 compiler emits CSS + GPUI theme), feature flags,
  parity matrix as the drift ratchet, screenshot-parity harness comparing
  the two frontends per release.
- Cost accounting: measure feature-delivery overhead on 3 real features
  during Phase 2-3 (build each in both frontends; record hours) so the
  decision to keep/kill W2 later is priced with data, not vibes.

## W3 — remote render: rejected by default (latency/offline/cost); keep one
paragraph of rationale so it is not re-litigated.

## Decision record
End of Phase 0: fill in verdict + evidence here; the main plan's phasing is
already W1/W2-agnostic through Phase 3.
