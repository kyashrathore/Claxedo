# Vercel Labs `scriptc` spike

Date: 2026-08-10

## Decision

**Do not adopt `scriptc` for Claxedo's embedded server or desktop startup path.** Keep Bun and the existing bundled server. The measured native artifact used much less RSS, but it was slower on a real Claxedo helper workload and the real server entry is not currently analyzable. No production source was changed for this experiment.

## Scope and provenance

- Upstream: `https://github.com/vercel-labs/scriptc`
- Evaluated upstream revision: `23a2d3309e0ff1ab93a1c538657a8ac198984cc5`
- CLI: published `scriptc@0.0.23`
- Host: macOS arm64; Node `v22.22.0`; Bun from this repository's environment
- Candidate boundary: `packages/claxedo-desktop/scripts/claxedo-server-entry.ts`
- Representative leaf: `packages/claxedo-desktop/src/shared/claxedo-server-lifecycle.ts`

`scriptc` is an experimental TypeScript-to-native compiler with a static tier and an optional dynamic island. It is not a drop-in native compiler for arbitrary Bun/Node applications.

## Experiments

### 1. Real server coverage

Command:

```bash
npx -y scriptc coverage   packages/claxedo-desktop/scripts/claxedo-server-entry.ts --dynamic
```

Result: **rejected before coverage** with 17 type-analysis errors. They include Bun's `process.parentPort`, missing Web API types (`BufferSource`, `CryptoKey`, `HeadersInit`), and object-property narrowing differences. This means neither the static nor dynamic lane can presently measure, much less build, the actual Claxedo server closure without a compatibility fork or production-source rewrites.

### 2. Real Claxedo lifecycle helper

The unmodified helper was rejected in both static and `--dynamic` modes:

```text
SC2020: Number.isInteger of 'number | undefined' values has no scriptc lowering yet
```

A temporary copy added an explicit `typeof candidate.port !== "number"` narrowing. That copy built successfully; the production helper was not edited. The native result and Bun both printed `349950000` for 100,000 create/parse iterations.

Artifact/build:

- native executable: 394,936 bytes
- one-off build wall time: 2.75 s

Thirty warm-host process runs, each including the same 100,000-iteration workload:

| Runtime | median wall | p95 wall | median max RSS |
|---|---:|---:|---:|
| `scriptc` static executable | 25.79 ms | 28.50 ms | 1,671,168 B |
| Bun | 11.11 ms | 12.02 ms | 36,896,768 B |

The executable used about 95.5% less RSS, but took about 2.32x the wall time. These are spike measurements, not Claxedo qualification samples: they isolate a leaf helper and do not represent semantic app readiness.

## Adopt/kill criteria

The spike would advance only if the real embedded-server entry was analyzable without compatibility rewrites and a runnable candidate improved packaged cold readiness or peak process-family RSS without correctness or long-task regressions.

It fails the entry criterion and the runnable leaf regresses runtime. The RSS result does not compensate for requiring a fork of Claxedo's server/runtime contracts.

## Reusable ideas

Keep these ideas, not the dependency:

1. Use compile-coverage reports before attempting runtime migrations.
2. Evaluate small native sidecars only at narrow, stable, CPU-heavy boundaries with an explicit serialization contract.
3. Track executable closure and max RSS alongside latency; a faster startup claim cannot hide steady-work regressions.

## Reproduction notes

The temporary sources and binaries were created under `/tmp` and are not product artifacts. Raw coverage output was `/tmp/scriptc-server-coverage.txt` during the spike. Published decisions rely on the commands and figures above, not those mutable temporary paths.
