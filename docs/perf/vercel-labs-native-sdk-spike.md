# Vercel Labs Native SDK spike

Date: 2026-08-10

## Decision

**Do not migrate Claxedo's desktop shell to Native SDK in this performance program.** The SDK demonstrates a small, single-process native UI with strong internal first-frame timing, but replacing Electron/Solid/xterm/browser content is a product rewrite, not an optimization candidate. Retain the SDK's semantic automation and model-contract ideas for future native surfaces.

## Scope and provenance

- Upstream: `https://github.com/vercel-labs/native`
- Evaluated upstream revision: `83a7aee7219c5fc21b85f9e8ec72d2417a693009`
- CLI: published `@native-sdk/cli` resolved by `npx`
- Toolchain installed by the CLI: Zig `0.16.0`
- Host: macOS arm64
- Candidate: generated `ts-core` native app, release-fast, with SDK automation enabled

Native SDK uses Zig for the host/rendering layer, `.native` markup, and a restricted TypeScript core compiled through `scriptc`. It can host web frontends, but using a web layer would retain the browser cost Claxedo is trying to reduce.

## Experiments

Commands:

```bash
native init /tmp/native-claxedo-spike --template ts-core
native check /tmp/native-claxedo-spike --strict
native test /tmp/native-claxedo-spike --yes
native build /tmp/native-claxedo-spike --yes -Dautomation=true
```

Results:

- strict subset/markup/manifest check: passed
- SDK test/model-contract build: passed
- ReleaseFast binary: 5,707,240 bytes
- process family at semantic assertion: one process, zero children
- app RSS at semantic assertion: 145,760 KiB
- SDK `automate assert 'Counter'`: passed
- SDK event timestamps: runtime `start` to first `gpu_surface_frame` was about 2.13 ms

A launch followed by `npx native automate assert --timeout-ms 30000 'Counter'` took 1,218.58 ms wall, but this is dominated by starting `npx`; the assertion itself reported a 0 ms wait once the CLI connected. Therefore only the SDK's internal start-to-frame delta is useful as diagnostic evidence, not as a Claxedo-ready measurement.

The first build, including the 49.8 MiB Zig toolchain download, took 72.50 s. The generated app's framework test reported a successful run, with compilation peaks in the 307–364 MiB range.

## Applicability to Claxedo

### What transfers

1. **Semantic automation boundary.** `automate assert`, snapshot, replay, and accessibility output align with Claxedo's strict semantic-readiness rule better than arbitrary sleeps.
2. **Typed model contract.** Generating/validating a narrow core-to-view contract is useful for native helpers and diagnostics surfaces.
3. **Single-process accounting.** The experiment reinforces measuring the exact process family and rejecting survivors.
4. **Native-only focused surfaces.** A future isolated status/menu/diagnostics utility could be evaluated without moving the workbench.

### What does not transfer now

Claxedo depends on Solid application semantics, browser layout/selection, xterm, Markdown/Shiki, Pierre diffs, Mermaid, Electron IPC, and web-accessible extension/runtime behavior. Porting these to `.native` markup and the restricted TS core would replace product behavior and invalidate current semantic/correctness evidence. Embedding the existing frontend in a web layer would not establish a five-times win and would create two desktop shells.

## Adopt/kill criteria

A candidate shell migration would need to preserve all Claxedo readiness and restoration semantics, terminal behavior, rich-content parity, and package/update contracts, then beat the packaged ten-metric targets through the authoritative harness.

The generated app proves SDK viability but not Claxedo parity. The migration is therefore killed for this plan. A separate product roadmap may reopen a narrowly scoped native surface with its own acceptance criteria.

## Teardown

The generated application lived only in `/tmp/native-claxedo-spike`. A first non-automation launch survived a failed assertion and was explicitly killed; the measured automation-enabled launch was also terminated. A final process search found and removed the earlier survivor. No Native SDK dependency or generated source was added to the repository.
