# 2026-08-13 session — web bundle + app memory/size effort

Continuation of the five-times effort (see HANDOFF.md), run on a Linux cloud
container against `claude/claxedo-perf-optimization-1yzgej`. The macOS gate
suite cannot run here (HANDOFF §12.4); this session worked the two lanes that
CAN be measured headless — the web surface (never measured before, §1.2) and
everything server-side/build-time — plus renderer work that transfers to the
desktop per §1.2's transfer list.

## Headline results (all measured, commands in the commits)

| metric | before | after | delta |
|---|---:|---:|---:|
| Web eager main chunk (raw) | 2,585.3 kB | 959.7 kB | **−63%** |
| Web eager main chunk (gzip) | 748.4 kB | 292.4 kB | **−61%** |
| Main CSS (raw) | 475.1 kB | 441.4 kB | −7% |
| Embedded engine artifact | 23.08 MB | 9.96 MB + 3.66 MB sibling JSON | **−41% shipped** |
| Engine import (Node 22, n=3) | ~1,385 ms | ~1,118 ms | **−267 ms** |
| Server-child RSS after engine import | ~281.7 MiB | ~244.4 MiB | **−37 MiB** |
| sqlite page-cache ceilings (×2 DBs) | 64 MiB each | 8 MiB each | −112 MiB ceiling |
| Windows desktop download (node-pty removal + .pdb) | — | — | **~−33 MB** (est. from measured file sizes) |
| claxedo-app architecture suite | 245/260 | 260/260 | 15 pre-existing failures fixed |
| claxedo-app full bun suite | 5,148/5,173 | +14 fixed, 0 new | strictly better |
| repo-wide turbo typecheck | FAILED (opencode) | 37/37 | fixed |

## What landed (web bucket — transfers to desktop renderer)

- **Guard enforcement**: all five deps the repo's own forbidden-eager-deps
  guard flags were leaking (katex, marked, @pierre/diffs+shiki,
  @tanstack/ai-client, qrcode). All evicted; the static walker gained
  session-ui resolution (its blind spot) and a boot-closure scope that also
  covers the pre-first-paint chunks (`preloadRuntimeProviders` roots).
- **session-kit fan-out cut**: light boundaries (session-kit-prompt,
  session-kit-context) so the eager composer and boot-time directory-scope
  stop pulling pierre+shiki through the barrel. Eager closure 686 → 349 files.
- **Entry barrel trim**: `app/entry/index.tsx` re-exported settings, routes,
  dialogs, terminal, titlebar to nobody; now exports only what its three
  consumers import. This also severed the published entry's last hosted reach
  (login route) — boundary pin is now null.
- **zod eviction** (~252 kB): plain predicate in global-sdk, lazy boundaries at
  feature-ports/documents/workgraph/processes seams, guarded permanently.
- **katex dedupe**: one version (0.16.47) instead of two full copies.
- **luxon removal** (~70 kB): three call sites, replaced with Intl formatting
  (same output spellings, verified).
- **Highlight cache fix** (HANDOFF's recorded-UNFIXED defect): completed code
  blocks now render from a bounded module LRU on remount instead of re-paying
  the worker round trip (52–58 ms/switch measured in the desktop effort).
- **Idle periodics** now pause hidden windows (10 s wake detector, 20 s
  harness-health poll) — lands in the desktop quiescent-CPU window too.
- **Dead code**: legacy titlebar/menu cluster deleted (also resolved 11
  documented keybind collisions), orphan barrels removed.

## What landed (app bucket)

- **Engine artifact**: minified (the CLI build already was; the SHIPPED one
  wasn't) and the ~3.7 MB models.dev catalog de-inlined to a sibling JSON read
  lazily module-relative. Falsifier test boots the packaged layout cold.
- **Desktop build**: electron-vite main/preload/renderer now minify (the
  presets default OFF — nothing shipped minified before); ACP adapters,
  host-connector, engine worker minified; compression maximum; node-pty's
  27 MB of win32 .pdb and ~4.2 MB of node-gyp input trees excluded;
  out/**/*.map excluded from the asar; per-artifact size ratchet added to
  verify-package-contents.
- **One PTY module**: workspace-runtime migrated to @lydell/node-pty;
  node-pty (63 MB installed, 30 MB win32 prebuild) fully removed, with a real
  /bin/sh spawn/resize/exit falsifier under node --test.
- **Server child DB boot**: both `cache_size=-64000` → `-8000`; migration SQL
  reads are lazy (warm boot reads zero of 37 files); `repair()` gated on a
  sqlite_master fingerprint, failing open; two unconditional full-table
  UPDATEs no longer run per boot.

## Broken things fixed along the way (branch inherited a dirty-worktree handoff)

- `renderer-trace.ts` and `claxedo-server-lifecycle.ts` were imported but
  never committed — web build and desktop typecheck were broken at the branch
  point. Recreated as canonical modules.
- `bundle-single-instance.test` bundled the wrong entry (pre-boot-stub).
- Routed LOCAL sessions blocked on the directory cache warm and fell to the
  retry screen when it failed (both gating tests red at branch point).
- MCP SDK typing drift broke repo typecheck (9 errors); the two shipped
  defects HANDOFF names (model picker, saved model selection) were already
  committed on this branch.

## Still open, with pointers

- The remaining eager items: features/session app code (~241 kB),
  @kobalte/core (~90 kB), sdk.gen (~49 kB), icon.tsx (~45 kB — sprite
  experiment outcome recorded separately), i18n en fallback (~54 kB,
  inherent). CSS 441 kB is untouched.
- `test/mcp/session-recovery.test.ts` fails at the branch point (SDK retry
  drift) — not perf, not fixed here.
- 12 pre-existing claxedo-app test failures (upstream-contract pins,
  signed-transport suite) — red at branch point, unchanged.
- The macOS ten-gate suite still needs a run on real hardware to price the
  renderer-side wins in gate terms (M2/M3/M5), and the isolated-vs-ambient
  experiment (HANDOFF §7.2) remains the decisive one for M1.
- Renderer `--js-flags` (HANDOFF §1.1) deliberately NOT set: no way to
  measure renderer RSS here, and unmeasured flags on the interaction path
  violate the measurement rules.
