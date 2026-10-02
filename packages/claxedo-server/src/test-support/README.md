# test-support/

Test-only code. Nothing here may be imported by production modules —
in-process helpers (`assert-helpers`, `guards`) and the `fake-acp`
subprocess fixture.

`data-isolation.ts` is the suite's `setupFiles` entry rather than a helper a
test imports: it must run before a test file's module graph loads.

`d1-authority.ts` composes the canonical D1 authority against the shipped
control-plane migrations. It admits identities and organization members through
the authority's public lifecycle methods. Runtime fixtures use `composeHost`.
`signed-d1-identity.ts` builds the signed auth for an admitted identity; it
imports no Miniflare, so workerd test bundles (`hosted-session-pull-worker.ts`)
can use it.

Per-module fixtures colocate with their suite (`workspace/supervisor/test-helper.ts`,
`hosts/workspace-runtime/` fixtures).
