# Onboarding Feature

The first run: the wizard the no-project canvas hosts (`wizard`, one file per
step, the draft it holds until Finish) and the data paths it is built from —
GitHub connection and repository listing (`code-host-api`), the sandbox
provider catalog and keys (`sandbox-provider-api`), machine-login discovery and
verification (`ai-connect-*`, read by Settings → Models), and the funnel events
the steps report (`funnel`). The wizard draws the Models page's own account
rows and provider sections and the workspaces feature's create form through
`app-ports`; it owns no surface those pages do not.

```json
{
  "owns": "First-run wizard (project → AI → where it runs), its draft, and the code-host, sandbox-provider, AI-connect and funnel data paths",
  "writerOf": [],
  "mustNotImport": ["@/app/*", "@/features/browser/*", "@/features/documents/*", "@/features/extensions/*", "@/features/processes/*", "@/features/review/*", "@/features/session/*", "@/features/settings/*", "@/features/terminal/*", "@/features/workspaces/*", "@/shell/*", "@/context/*", "@/components/*", "@/pages/*", "@/claxedo-ui/*", "@/pane/*", "@/shared/*"]
}
```

## Design rationale

- **One reason to show, none to dismiss.** The wizard is the screen a server
  with no project shows, and nothing else: no flag, no dismissal key, no
  overlay on a live rail. Once a project exists every later change is a
  Settings page (Models, Sandbox, Machines), which is why each step reuses
  that page's own components rather than a parallel form.
- **Nothing before Finish.** The desktop's project is posted at Finish and the
  hosted plane's first cloud workspace is created there, so a refused clone
  or a folder that is not a repository is answered on this screen, and an
  abandoned wizard leaves nothing behind on either product.
- **Proven, not saved.** The largest silent funnel leak is
  `provider_connected` → `first_turn_ok`: a credential that saved but cannot
  work (no billing, a rate cap, a stale token) is the common case. Where a
  probe exists — the machine scan and the sandbox key's own verdict — a step
  is done only on it. The hosted plane has no probe for a Pi key; its "done"
  is the catalog reporting the provider connected, and the copy says so.
- **Pull, not push.** Cloud and detached sessions sell themselves after the
  first local turn, not before it. The desktop's step 3 is preselected "Just
  this machine"; the cloud and machine rows are offered, never required.
