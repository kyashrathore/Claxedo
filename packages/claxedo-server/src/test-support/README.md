# test-support/

Test-only code. Nothing here may be imported by production modules —
in-process helpers (`assert-helpers`, `guards`,
`cli-session-registry` double) and the `fake-acp` subprocess fixture.

`data-isolation.ts` is the suite's `setupFiles` entry rather than a helper a
test imports: it must run before a test file's module graph loads.

Other test-only artifacts that CANNOT live here because their paths are
hardcoded as spawn strings elsewhere (repo-root script/, claxedo-app e2e):
`src/host-tunnel-relay-fixture.mjs`, `src/signed-browser-relay-fixture.mjs`,
`src/text-imports{,-loader}.mjs`. Per-module fixtures colocate with their
suite (`workspace/supervisor/test-helper.ts`,
`hosts/workspace-runtime/` fixtures).
