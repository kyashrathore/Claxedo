# App-level demo benchmark (real-browser, offline)

Real-browser session-switch + launch measurement that does NOT need the
agent-app-benchmark framework, a backend, or the frozen corpus. It serves a
`CLAXEDO_BUILD_TARGET=demo` build (MSW mock backend, `/demo/` path) in Chromium
and drives the REAL `activateSession` path via client-side route navigation.

Not a substitute for the frozen-corpus contract benchmark (small synthetic
transcripts only), but a fast, reproducible way to compare two builds' real
app-level switch latency, launch time, and baseline heap.

## Usage
    cd packages/claxedo-app
    CLAXEDO_BUILD_TARGET=demo bun run build            # produces dist-demo
    PLAYWRIGHT_BROWSERS_PATH=/opt/pw-browsers \
      node perf-harness/app-level-demo-bench/switch-url-bench.mjs "$(pwd)/dist-demo" candidate 80
    node perf-harness/app-level-demo-bench/launch-bench.mjs "$(pwd)/dist-demo" candidate 6

Chromium executablePath is pinned to the container's build (1194); adjust for
your environment. Compare two builds by building each into its own dir and
running both, interleaved, several times.

## Result on this experiment (candidate HEAD vs base 62456bb5, both Solid 2)
Statistical PARITY: switch median ~237 vs ~241 ms (tied), launch ~1134 vs
~1099 ms (tied), baseline heap ~21 vs ~19 MiB (noisy). The refactor's
reactive-graph savings do not surface as an app-level win at demo scale.
See ..//ce-optimize/solid2-beat-solid1-v3/experiment-log.yaml
