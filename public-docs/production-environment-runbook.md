# Production Environment Runbook (retired)

The Clerk + Convex production doctrine documented here was removed from the
main codebase with that product. The live path is the Better Auth + D1
user-deployed control plane:

- Guide: [`user-deployed-cloudflare.md`](./user-deployed-cloudflare.md)
- Release operator: `packages/claxedo-server/scripts/deploy/release-better-auth-d1.ts`
- Cutover status: `packages/claxedo-server/scripts/deploy/cutover-better-auth-d1.ts --status`
- Re-add path for the retired product: the `clerk-convex-cp` skill.
