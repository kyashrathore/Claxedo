# Onboarding Feature

The data paths a first run is built from: AI login discovery and verification
(`ai-connect-*`), the credential rows the server holds and which of them a
cloud sandbox may use (`credential-*`), GitHub connection (`code-host-api`),
sandbox provider catalog and keys (`sandbox-provider-*`), and the funnel events
those steps report (`funnel`). No first-run surface lives here yet; with no
project on the server the app shows `app/workbench/rail/first-project-canvas.tsx`.

```json
{
  "owns": "First-run data paths: AI connect, credential query and cloud-sharing rules, code-host connection, sandbox provider catalog and keys, funnel telemetry",
  "writerOf": [],
  "mustNotImport": ["@/app/*", "@/features/browser/*", "@/features/documents/*", "@/features/extensions/*", "@/features/processes/*", "@/features/review/*", "@/features/session/*", "@/features/settings/*", "@/features/terminal/*", "@/features/workspaces/*", "@/shell/*", "@/context/*", "@/components/*", "@/pages/*", "@/claxedo-ui/*", "@/pane/*", "@/shared/*"]
}
```

## Design rationale

- **Proven, not saved.** The largest silent funnel leak is
  `provider_connected` → `first_turn_ok`: a credential that saved but cannot
  actually work (no billing, org rate cap, stale OAuth token) is the common
  case, not the edge case. So a step's done-state is a real verification
  operation (a probe, a test clone, an actual provision), never a row-exists
  query.
- **Pull, not push, for the cloud.** Cloud and detached sessions are the
  product's differentiator, but they sell best right after the user has felt a
  first local turn. Anything that teaches them belongs after that turn, not in
  front of it.
