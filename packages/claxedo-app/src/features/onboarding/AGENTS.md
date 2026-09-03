# Onboarding Feature

Pure setup derivation, step definitions, dismissal state, onboarding shell, and
the shared setup surfaces that render those contracts.

```json
{
  "owns": "Onboarding derivation, registry, dismissals, setup shell, and setup UI",
  "writerOf": [],
  "mustNotImport": ["@/app/*", "@/features/browser/*", "@/features/documents/*", "@/features/extensions/*", "@/features/processes/*", "@/features/review/*", "@/features/session/*", "@/features/settings/*", "@/features/terminal/*", "@/features/workspaces/*", "@/shell/*", "@/context/*", "@/components/*", "@/pages/*", "@/claxedo-ui/*", "@/pane/*", "@/shared/*"]
}
```

## Design rationale

Carried forward from the retired onboarding product/UX plan before it was
deleted, so the reasoning behind a few non-obvious choices in this feature
isn't lost:

- **Funnel-leak reasoning behind "proven, not saved" checkmarks.** The
  largest silent funnel leak is `provider_connected` → `first_turn_ok`: a
  credential that saved but can't actually work (no billing, org rate cap,
  stale OAuth token) is the common case, not the edge case. That's why every
  step's done-state is a real verification operation (a test call, a test
  clone, an actual provision) rather than a row-exists query.
- **Why remote-access-as-education failed.** An earlier design pitched
  "access remotely" as a pure education step pre-first-turn; it landed flat
  in the first stress test and was cut. Reframed as an action instead — scan
  a QR, watch the agent work from your phone — it became the cheapest wow in
  the funnel and the moment Ramp 2 (cloud/detached sessions) stops being
  abstract.
- **The Ramp-2 pull-not-push strategy.** Ramp 2 (graduating to cloud/detached
  sessions) is the product's real differentiator, but it sells itself best
  right after the user has felt Ramp 1 (first local turn) rather than being
  pushed in front of it — its education cards ("Go further": any
  harness, deploy on your own infra) appear only after the first successful
  turn, and land better there than any pre-first-turn tutorial could.
- **Self-host signed-in trust motivation.** Today's `claxedo deploy` ends
  with a warning that anyone with the URL can use the instance. Self-host is
  the same product as hosted, so its first minute must carry the same trust
  bar: deploy ends authenticated, with a first-admin claim step, not an
  open door.
