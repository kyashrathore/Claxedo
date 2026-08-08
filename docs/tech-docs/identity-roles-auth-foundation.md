# Identity, Roles, And Auth Foundation

Status: retained code-grounded reference
Last updated: 2026-08-09

This document is retained because `public-docs/hosted-control-plane-worker.md`
cites signed-mode Phase A from it.

## Current Implementation

- Control-plane auth config and adapters:
  `packages/claxedo-server-core/src/platform/auth/auth.ts`
- Service composition:
  `packages/claxedo-server/src/authority/services.ts`
- Hosted service composition:
  `packages/claxedo-server/src/authority/hosted-services.ts`
- Hosted device login:
  `packages/claxedo-server/src/routes/hosted/device-auth.ts`
- Hosted workspace authorization:
  `packages/claxedo-server/src/routes/hosted/workspace.ts`
- Convex policy coverage: the `*.policy.test.ts` suites in the repo-root
  `convex/` directory
- App auth bootstrap:
  `packages/claxedo-app/src/app/entry/auth.ts`
- App signed runtime access:
  `packages/claxedo-app/src/app/providers/global-sdk/provider.tsx`

## Current Signed-Mode Rules

- `CLAXEDO_SIGNED_CLOUD_AUTH` enables signed/cloud auth.
- Clerk issuer and JWKS settings are read by the control-plane auth adapter.
- Signed auth can carry `org_id`/`orgId` claims when the issuer provides them.
- Hosted control-plane composition fails closed when required signed/hosted
  configuration is missing.
- Device-login endpoints exist, but fail closed with
  `device_login_unconfigured` until a trusted issuer is configured.

## Current Role/Identity Grounding

Current authorization behavior is covered by authority and Convex policy tests
rather than by this document. Before changing identity behavior, read the
authority suites under `packages/claxedo-server/src/authority` and the Convex
policy tests in the repo-root `convex/` directory, especially:

- `convex/orgs.policy.test.ts`
- `convex/users.policy.test.ts`
- `convex/sessions.policy.test.ts`
- `convex/workspace-region.policy.test.ts`
- `convex/local-host-links.policy.test.ts`
- `convex/share-revoke.policy.test.ts`

## Maintenance Rule

Keep this file limited to current auth/role code pointers. Do not use it as a
roadmap for org/project work unless each claim is re-grounded in current source
and tests.
