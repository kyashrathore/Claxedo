# Linux benchmark round, 2026-10-18: raw material

The findings are in [the round's report](../../reports/2026-10-18-agent-app-benchmark-linux-round.md). This folder keeps what produced them, as it was on the cloud host (paths under `/home/user/...` are that host's).

- `INFRA.md`: how the packaged Linux build, the driver and the framework were set up, with every deviation from the macOS protocol.
- `scripts/`: `repack.sh` (full or renderer-only package of a worktree), `bench-run.sh` (one framework run under Xvfb), `queue.sh` and `queue2.sh` (serial build-and-run queues), `compact.sh` and `pooled.py` (comparisons against pooled controls).
- `tools/`: `claxedo-runs.mjs` (tables and control/candidate verdicts with the framework's own statistics), the renderer-only repack helpers and the asar marker check.
- `sep-driver-linux.patch`: the Linux deviations applied to the 29 September build's own driver.
- `EXPERIMENTS.md` and `experiments/`: every candidate as a patch. The `bench-*` patches apply to `24980400`; `perf-first-read-first.patch` applies to `05c70d3c`. `bench-combo2` is what was merged before the first-read change.
- `runs/`: each run's `result.json` per scenario and its host-conditions log. `control-*` are controls of `24980400`, `sep-*` the 29 September build, `final-*` `05c70d3c`, `cand-ab-*` the first-read change. Runs before the host change and after it are not comparable; the report says which is which.
