---
date: 2026-03-31
topic: cloud-workspace-secret-boundary
---

# Cloud Workspace Secret Boundary

## Problem Frame

Claxedo's current cloud workspace path works, but the hosted trust boundary is still too loose for a durable multi-workspace product.

Today the control plane in `claxedo-server` supervises one remote `workspace-runtime` per cloud workspace, proxies runtime-owned routes to it, and pushes runtime snapshots over `/api/wr/config`. That snapshot currently includes raw provider `auth`, and config fanout can rebroadcast the same shape to every supervised remote runtime.

This creates a few concrete problems:

- Raw provider secrets cross the `claxedo-server` to `workspace-runtime` boundary.
- The remote runtime becomes a long-lived secret holder instead of a narrow execution surface.
- Secret use and outbound egress policy are coupled inside the workspace instead of being enforced by a product-owned boundary.
- The current document shape leaves git credentials and direct outbound traffic under-specified, which is exactly where hosted systems usually leak their secret model.
- Durable runtime ownership and lease semantics are not yet part of the first hardening step, even though process-local ownership is already called out as fragile.

The problem is not whether hosted workspaces basically function. They do. The problem is that the current config and proxy model does not yet define a strong enough secret boundary for hosted cloud execution.

## Requirements

**Topology and Ownership**
- R1. Hosted cloud workspaces must keep the current one-workspace-per-runtime model rather than moving shell, git, PTY, or repo-local execution into the central control plane.
- R2. `claxedo-server` must remain the product-owned control plane for hosted mode, owning auth, org access, workspace lifecycle, runtime scheduling, secret policy, short-lived token issuance, audit, and event fan-in.
- R3. The remote `workspace-runtime` must remain an execution surface for filesystem, PTY, process, git, and runtime-local agent work, but it must not become a durable owner of provider credentials.
- R4. The architecture must fit the current codebase shape, where `workspace-supervisor` manages remote runtimes and `workspaceRuntimeProxy` forwards runtime-owned routes, rather than assuming an entirely separate new control-plane product from day one.

**Hosted Secret Boundary**
- R5. Hosted mode must stop pushing raw provider `auth` values through `/api/wr/config` to remote runtimes as the normal credential path.
- R6. Hosted credentials must be classified into explicit boundary classes: proxy-safe, mount-only, and control-plane-only.
- R7. Proxy-safe credentials must never be materialized inside the hosted workspace. The runtime may receive a short-lived scoped token or reference, but not the upstream secret itself.
- R8. Mount-only credentials may be materialized inside the hosted workspace only when a workflow cannot run through the proxy model and the product explicitly supports that case.
- R9. Control-plane-only credentials must never leave product-owned services.
- R10. Hosted mode must define one explicit supported credential path for git fetch and push, rather than leaving git auth in the gap between HTTP proxying and raw secret mounts.

**Egress and Enforcement**
- R11. For proxy-safe destinations, hosted workspaces must be technically forced through a product-owned egress boundary rather than relying on convention.
- R12. The enforcement model must include destination allowlisting and enough request policy to prevent the workspace from using its scoped token as a broad outbound credential.
- R13. Short-lived workspace tokens must be scoped tightly enough that compromise of one workspace does not grant broad provider or org access.
- R14. Planning must define where direct outbound traffic is blocked, constrained, or observed for hosted runtimes so the proxy is a real trust boundary.

**Current-System Fit**
- R15. Local-first desktop or local-only execution must not be forced into the hosted secret model.
- R16. Hosted config fanout must stop rebroadcasting raw provider secrets to supervised remote runtimes.
- R17. The first hosted hardening phase must move durable runtime ownership and lease semantics earlier in the rollout rather than leaving control-plane fragility until the end.
- R18. Event forwarding, runtime proxying, and session orchestration may stay in the current `claxedo-server` shape for now, but their contracts must align with the tighter secret boundary.

**Observability and Repair**
- R19. Hosted secret use must be auditable enough to answer which workspace used which boundary path, for which upstream service, and whether the request went through proxy-safe or mount-only flow.
- R20. The system must make raw-secret exceptions explicit and measurable so mount-only usage can shrink over time instead of becoming the default escape hatch.
- R21. Planning must define repair and revocation behavior for issued workspace tokens, rotated upstream credentials, and stale runtime leases.

## Success Criteria

- A hosted workspace can perform supported provider calls without the upstream secret being present in remote runtime config.
- Proxy-safe destinations are enforced by architecture, not by developer discipline.
- Git credential handling is explicitly supported and documented for hosted workspaces.
- Hosted secret exceptions are rare, auditable, and intentionally scoped.
- The doc gives planning a concrete boundary story tied to the current Claxedo system rather than a generic future platform.

## Scope Boundaries

- This brainstorm does not require moving shell, git, PTY, or repository-local execution out of the workspace.
- This brainstorm does not require globally canonical PTY stdout or stderr storage.
- This brainstorm does not choose a specific proxy vendor, secret store vendor, or token format.
- This brainstorm does not require every third-party integration to become proxy-safe in the first rollout.
- This brainstorm does not define low-level network enforcement code, schema, or endpoint details.

## Key Decisions

- Keep the current one-runtime-per-workspace shape.
  Rationale: the product still needs real workspace-local execution for shell, git, PTY, and repo-local tools.

- Use `claxedo-server` as the current hosted control plane instead of introducing a new top-level product boundary immediately.
  Rationale: this matches the existing proxy, supervisor, and event model and avoids inventing a second control plane before the secret boundary is corrected.

- Stop treating `/api/wr/config` snapshots as the hosted source of truth for provider auth.
  Rationale: the current snapshot shape is the clearest place where raw secrets cross into remote runtimes today.

- Treat proxy-safe egress as the default hosted path and mount-only secrets as an exception path.
  Rationale: if mount-only remains equally normal, the architecture keeps the same core secret risk under a different name.

- Make git auth an explicit first-class boundary decision.
  Rationale: hosted coding workflows depend on git, so leaving it unspecified would leave the most important credential path unresolved.

- Pull runtime ownership and lease hardening forward in the rollout.
  Rationale: a stronger secret boundary is weaker than it looks if control-plane ownership remains process-local and fragile.

## Dependencies / Assumptions

- `claxedo-server`, `workspace-supervisor`, and `workspace-runtime` remain the relevant hosted architecture surfaces for the near term.
- Some hosted workflows will still need raw credential delivery for a while, but those cases can be explicitly allowlisted and audited.
- The product can distinguish hosted cloud execution from local-only execution and apply different credential rules to each.

## Outstanding Questions

### Resolve Before Planning

None.

### Deferred to Planning

- [Affects R10][Technical] What exact hosted git credential path should we support first: HTTPS via brokered token flow, SSH via mount-only credentials, or both?
- [Affects R11][Technical] Where should proxy-safe egress enforcement live for hosted runtimes: sandbox network policy, sidecar, gateway, or another boundary already available in our runtime environment?
- [Affects R13][Technical] What claims, TTL, audience, and revocation model should workspace-scoped tokens carry?
- [Affects R16][Technical] How should `/api/wr/config` evolve for hosted runtimes: tokenized auth references, per-provider capability flags, or a separate hosted config path?
- [Affects R17][Technical] What lease and ownership state must move out of process-local memory first to make hosted runtime control durable enough for this boundary?
- [Affects R20][Product] Which integrations are allowed to remain mount-only in the first hosted rollout, and what product criteria decide when a new exception is acceptable?

## Next Steps

→ /prompts:ce-plan for structured implementation planning
