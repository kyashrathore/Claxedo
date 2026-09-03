# Hosted Control Plane on Cloudflare Workers (retired)

The Clerk + Convex hosted control plane documented here was removed from the
main codebase. The live path is the Better Auth + D1 user-deployed control
plane:

- Guide: [`user-deployed-cloudflare.md`](./user-deployed-cloudflare.md)
- Worker composition:
  `packages/claxedo-server/src/deployments/hosted-workerd/better-auth-d1-locked-worker.cf.ts`
- Re-add path for the retired product: the `clerk-convex-cp` skill.

`CLAXEDO_SANDBOX_DRIVER` and per-driver credentials are still configured per
the user-deployed guide; the sandbox manager contract is unchanged
(`packages/sandbox-manager/README.md`).
