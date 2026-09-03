# test-support/

Test-only code. Nothing here may be imported by production modules —
in-process helpers (`assert-helpers`, `guards`,
`cli-session-registry` double) and the `fake-acp` subprocess fixture.

Other test-only artifacts that CANNOT live here because their paths are
hardcoded as spawn strings elsewhere (repo-root script/, claxedo-app e2e):
`src/user-hosted-relay-fixture.mjs`, `src/signed-browser-relay-fixture.mjs`,
`src/text-imports{,-loader}.mjs`. Per-module fixtures colocate with their
suite (`workspace/supervisor/test-helper.ts`,
`hosts/workspace-runtime/` fixtures).
