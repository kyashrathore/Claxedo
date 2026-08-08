# Convex schema evolution — expand-migrate-contract is law

Decision D14 of the cloud-subscription launch work, argued alongside the
operational-floor design. Context that raises the
stakes: **Convex has no rollback** — recovery is re-pushing old code from a git
SHA, which only works if every schema change stayed additive. This discipline is
the substitute for a rollback button, not hygiene.

## The law

1. **Expand.** Schema pushes are additive only: new tables, optional fields,
   widen-with-unions before type changes. Never narrow or require a field in the
   same deploy that introduces it. Code must read around both shapes until the
   migration below is verifiably complete.
2. **Migrate.** Every backfill runs through the `@convex-dev/migrations`
   component — defined in `convex/migrations.ts`, with the component registered
   in `convex/convex.config.ts`. The component provides what hand-rolled
   mutations re-solve badly: batching (execution limits), resumability,
   idempotency (a migration never double-runs), and a durable per-deployment
   ledger of what ran. Run with
   `npx convex run migrations:run '{"fn": "migrations:<name>"}'` (add `--prod`
   for production), or directly by name.
3. **Contract.** Drop/require fields only after the migration's completion is
   verified on EVERY deployment (staging and prod share the same migration
   lineage). The component ledger — not operator memory — is the completion
   signal.
4. **Schema changes deploy alone**, before dependent code (the Convex analog of
   the DO-migrations-ship-solo rule; see ADR 016 §2.3 ordering: Convex first).

## No ad-hoc backfill mutations

Do not add hand-rolled backfill mutations (a `serviceMutation` that sweeps and
rewrites a table). That pattern is retired: it has no double-run protection, no
batching, and no record of which deployment it ran against — a double-run over
billing tables is a customer-facing money bug. The last survivor,
`sandboxLeases.normalizeLegacyFields`, is retro-registered as migration #001
(`convex/migrations.ts` → `normalizeRuntimeLeaseLegacyFields`) and its export
remains only for the break-glass maintenance script
(`packages/claxedo-server/scripts/maintenance/normalize-convex-sandbox-leases.ts`).

## What is deliberately NOT required (pre-PMF honesty, ADR 016 §5.2)

- Down-migrations for every change — write them only where the table is money
  (`orgs` billing fields, seats); elsewhere fix forward.
- CI schema-diff gates — Convex's own push validation already rejects the
  dangerous class (a narrowing schema over nonconforming rows will not push).
- Any data-versioning ceremony beyond the component's own ledger. Schema should
  still churn fast; the discipline makes churn safe, not slow.

## Guards that keep this honest

The Convex functions and their policy suites live in the repo-root `convex/`
directory, not under a server package.

- `convex/migrations-discipline.policy.test.ts` pins the component registration
  and internal-only visibility of migration functions, and pins that migration
  #001 reuses the `runtime_leases` normalize logic rather than forking a second
  implementation of it.
- `convex/authz-guard.policy.test.ts` (D8) bans raw Convex builders, so a new
  backfill cannot bypass the builder set.
- `convex/sandbox-leases.policy.test.ts` pins the behaviour of that
  `runtime_leases` legacy-normalize logic, which lives in
  `convex/sandboxLeases.ts` and is reached from `convex/migrations.ts`.
