// Convex app definition (components).
//
// D14 (launch plan 2026-07-11-012 §1 / ADR 016 §5): schema evolution follows
// expand-migrate-contract, and the MIGRATE step runs exclusively through the
// `@convex-dev/migrations` component (batched, resumable, idempotent, with a
// durable ledger of which migration ran on which deployment). Hand-rolled
// backfill mutations are retired — see convex/migrations.ts and
// docs/tech-docs/convex-schema-evolution.md.
import { defineApp } from "convex/server"
import migrations from "@convex-dev/migrations/convex.config"

const app = defineApp()
app.use(migrations)

export default app
