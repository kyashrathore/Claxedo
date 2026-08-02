# architecture.test.ts — test-by-test keep/delete classification

Wave 1 of plan `2026-08-02-001`. 43 tests, 1263 lines. Read in full 2026-08-02.

Classification rule: **does the test assert on program STRUCTURE (imports,
graph, contracts) or on SOURCE TEXT (banned words, file listings, tombstones)?**
Structure survives a rename; text does not.

## KEEP (13) — real invariants TypeScript cannot express

| Line | Test | Why it earns its place |
|---|---|---|
| 10 | classifies host primitive modules with owners | The registry driver. Shrinks with the registry but the mechanism (every canonical module has an owner + live tests) is sound. |
| 112 | server host bridge out of harness adapter execution | Runtime-coupling boundary; correctly strips `import type` lines before scanning — text-aware but structure-intended. |
| 139 | workspace-runtime must not import claxedo-server | **Circular package dependency.** Uses `importPattern`, not substring. |
| 155 | product strings / ambient env out of the kit | Kit-vs-host classification rule; keeps the kit reusable. |
| 248 | production source must not import legacy host-control modules | Real import guard via `importPattern` over 9 retired module paths. |
| 276 | SandboxDriver focused on host lifecycle | Parses the actual `SandboxDriver` type body and asserts absent methods — a contract test, not a word grep. |
| 299 | sandbox-manager public types not sandbox handles | Same shape. |
| 317 | SandboxManager wired to a driver, not a provider object | Same shape. |
| 329 | SandboxManager storage/auth pluggable | Same shape. |
| 361 | generic control-plane core free of Convex tokens (R8) | **This is what keeps self-host working without Convex.** |
| 1106 | API error response bodies structured | Regex over `c.json({error: "..."})` — enforces a live response contract across all routes. |
| 1158 | package Agent Extension lifecycle free of server deps | Package-boundary guard. |
| 1252 | WorkGraph out of Control Plane module load | Enforces the dynamic-import boundary that keeps WorkGraph off the CP hot path. **Caveat: also does `toContain('import("./workgraph-session-gateway")')` — path-coupled; must be updated in Wave 4.** |

## DELETE (30) — source-text greps

### Tombstones (assert absence of already-absent things)
- `190` retired compatibility wrappers — ~55 paths incl. `harness/*`, `process/*`,
  `pty/*`, `mcp/*`. **Absent from git history (squashed at hard-fork)** — asserts
  the absence of files no current contributor has seen. A nonexistent file cannot
  be imported; TypeScript already enforces this.
- `733` retired supervisor runtime entrypoint names deleted — same pattern.

### Directory-listing locks (break on any file add)
- `50` covers discovered host primitive modules — hardcodes 33 module paths.
- `90` keeps src/cloud limited to 3 modules — hardcoded `toEqual` listing.
- `968` server route modules mounted or accounted for — **hardcodes a full
  alphabetical listing of every file in `routes/`.** Adding one route breaks it.

### Vocabulary greps (the `"ensure" + "WorkspaceRuntime"` family)
`175`, `181`, `381`, `404`, `427`, `462`, `497`, `531`, `570`, `579`, `594`,
`601`, `611`, `623`, `643`, `720`, `761`, `948`, `1122`, `1137`, `1144`, `1182`,
`1224`, `1238`.

Representative: `761` "keeps remaining legacy cloud-host compatibility terms
auditable" asserts ~20 banned words absent, written as
`filesContaining("ensure" + "WorkspaceRuntime")` — **string-split so the test
does not match itself.** That workaround is the proof it greps text, not
structure. It cannot distinguish an import from a comment from a variable name.

Several must also exempt their own registry:
`expect(filesContaining("cloud/lifecycle")).toEqual(["architecture-ownership.ts"])`
— the registry records deletions, then must be excused from the rule about them.

## Registry consequence

`architecture-ownership.ts` (53 entries) exists mostly to feed tests `10`, `50`,
and `90`. Keeping test `10` means keeping the registry, but entries whose only
consumer was a deleted test can go. Target: retain entries for modules the 13
kept tests actually reference.

## Honest limit

This repo has ONE commit touching `architecture.test.ts` (`728cedf2a "Initial
release"`) — history was squashed, so there is no evidence any of these guards
ever fired. Classification is by mechanism, not track record.

## Execution result (2026-08-02)

1263 lines / 43 tests → **309 lines / 13 tests**. Registry trimmed 53 → 43
entries by removing the 10 `Deleted`-status tombstones (same category as the
deleted test-file tombstone list).

### Fault injection — the guards were proven to bite, not assumed

A green suite is a claim. Each of these was injected, observed RED, then reverted:

| Guard | Injected violation | Result |
|---|---|---|
| control-plane core Convex-free (R8) | added `const _inject = "CONVEX_URL"` to `control-plane/authority.ts` | **RED** — named `authority.ts` |
| API error bodies structured | added `c.json({ error: "raw string" }, 400)` to `routes/events.ts` | **RED** |
| workspace-runtime must not import claxedo-server | added `import { createApp } from "@claxedo/server"` to `workspace-runtime/src/config.ts` | **RED** — named `config.ts:@claxedo/server` |

Suite confirmed green again after every revert.

### Pre-existing gap found while injecting (out of scope, not introduced here)

`test-helpers/guards.ts` `importPattern` only matches `from "..."` and
`import * as x from "..."`. A **bare side-effect import** — `import "@claxedo/server"`
— is invisible to it. My first injection used that form and the guard stayed
green, which initially looked like a dead guard; it is actually a real blind spot
in the matcher.

Every import guard built on `importPattern` inherits it (the circular-dep guard,
the legacy-module guard). Worth fixing separately: add an
`import\s+["'][^"']*<mod>` alternative to the pattern.

### Note

`OwnershipStatus.Deleted` is now unreferenced outside the enum and the surviving
test's dead `if` branch. Left in place — the branch is harmless and future
deletions may reuse it.
