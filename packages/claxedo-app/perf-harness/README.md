# Claxedo benchmark driver

The application-owned driver of the public [agent-app-benchmark](https://github.com/kyashrathore/agent-app-benchmark). The benchmark's registry apps `claxedo` and `claxedo-v2` declare `"driverOwnership": "application-repository"`, and the benchmark resolves the driver at the fixed path `$CLAXEDO_ROOT/packages/claxedo-app/perf-harness/src/public-agent-app-driver.ts`. Do not move it.

- `src/public-agent-app-driver.ts`: the NDJSON driver. It lists the scenario ids it serves and dispatches each to its kind: app start, session switch, session navigation, workspace panel.
- `src/public-corpus-materializer.ts`, `src/fixture-registration.ts`, `src/opencode-corpus.ts`: write the benchmark corpus into a Claxedo data directory through the app's own server-core and workspace-runtime writers (`src/production-modules.ts`).
- `src/agent-claxedo-launcher.ts`, `src/agent-cdp-page.ts`: launch the packaged app and attach over CDP.
- `src/agent-browser-observer.ts`, `src/public-workspace-panel.ts`, `src/frame-sampler.ts`: the readiness predicates and frame timing. They read the app's `data-testid`, `data-slot` and `data-component` hooks, so the app's `claxedo-names` check counts this folder as a reader.

The same driver measures the archived packaged v1 app and today's app, so a precondition it enforces must hold for both.

## Install and verify

This package is not a workspace member; the root install does not install it. Its framework dependency is the benchmark checkout that runs it, linked:

```sh
cd /path/to/agent-app-benchmark && bun link
cd packages/claxedo-app/perf-harness && bun install
bun run verify
```

`verify` typechecks `src/` and `test/` and runs `test/`. From the app package, `bun run test:perf-harness` runs the same.

## Run

See the benchmark's `docs/presets/claxedo-v1-vs-v2-fast.md`: `CLAXEDO_ROOT` names this checkout, and `CLAXEDO_BENCHMARK_EXECUTABLE` / `CLAXEDO_V2_BENCHMARK_EXECUTABLE` name the packaged apps.
