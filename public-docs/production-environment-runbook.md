# Production Environment Runbook (retired)

The hosted production doctrine documented here was removed from the main
codebase along with the control plane it described. The live path is the
Better Auth + D1 user-deployed control plane:

- Guide: [`user-deployed-cloudflare.md`](./user-deployed-cloudflare.md)
- Release operator: `packages/claxedo-server/scripts/deploy/release-better-auth-d1.ts`
- Cutover status: `packages/claxedo-server/scripts/deploy/cutover-better-auth-d1.ts --status`
