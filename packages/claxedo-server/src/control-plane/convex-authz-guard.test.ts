import { describe, expect, test } from "vitest"
import fs from "node:fs"
import path from "node:path"

// D8 architecture guard.
//
// Every exported Convex function must be built from the mandatory builders in
// `convex/model.ts` (`authedQuery`/`authedMutation` for end-user identity,
// `serviceQuery`/`serviceMutation` for the control-plane service token,
// `publicQuery`/`publicMutation` for explicitly unauthenticated endpoints).
// Raw `queryGeneric`/`mutationGeneric` construction outside the builder module
// is the "forgotten authorize call" failure mode this decision exists to make
// structurally impossible; the ratchet baseline is ZERO and must stay zero.

const repoRoot = path.resolve(import.meta.dirname, "../../../..")
const convexRoot = path.join(repoRoot, "convex")

const BUILDER_MODULE = "model.ts"
const HTTP_MODULE = "http.ts"

const RAW_BUILDER_IDENTIFIERS =
  /\b(queryGeneric|mutationGeneric|actionGeneric|internalQueryGeneric|internalMutationGeneric|internalActionGeneric|httpActionGeneric)\b/

const ALLOWED_FUNCTION_BUILDERS = new Set([
  "authedQuery",
  "authedMutation",
  "serviceQuery",
  "serviceMutation",
  "publicQuery",
  "publicMutation",
  // D13: cron handlers (convex/crons.ts targets). Wraps
  // `internalMutationGeneric` — internal visibility means NOT callable by any
  // client, only the Convex scheduler/crons: strictly stronger than a service
  // token, so admitting it keeps the ratchet honest rather than loosening it.
  "cronMutation",
  // Appliers invoked by a signature-verified webhook httpAction via
  // `ctx.runMutation`. Also wraps `internalMutationGeneric`, same reasoning as
  // `cronMutation`. See PUBLIC_BUILDERS below for why a webhook applier must
  // never be built from `publicMutation` instead.
  "webhookMutation",
])

// The unauthenticated builders. Every exported Convex function is reachable by
// any client that knows the deployment URL, and the URL is not a secret — it
// ships in the web/desktop bundle as `VITE_CONVEX_URL`. So a `publicMutation`
// is an internet-facing, unauthenticated endpoint, and the only correct number
// of them is zero unless someone has deliberately argued otherwise.
//
// This ratchet exists because `orgs.applyClerkWebhook` was one. Its Svix
// signature check lives in the httpAction, not the mutation, so being public
// made it a second door into the same authority with the signature check
// skipped: any signed-up user could POST `organizationMembership.created` to
// `<deployment>.convex.cloud/api/mutation` and mint themselves an `org:admin`
// membership in an arbitrary org, which `directOrgRole` resolves to admin on
// every workspace in that org. Webhook appliers belong on `webhookMutation`.
//
// Adding a name back to this baseline must come with a written argument for why
// the endpoint is safe to expose unauthenticated — the failure mode is not
// "leaks a bit of data", it is cross-tenant privilege escalation.
const PUBLIC_BUILDERS = ["publicQuery", "publicMutation"] as const
const PUBLIC_BUILDER_BASELINE: string[] = []

// D14: `convex/migrations.ts` functions are built via the
// `@convex-dev/migrations` component (`migrations.define(...)` /
// `migrations.runner()`). They are internal-visibility functions (component-
// managed batching/ledger), invocable only via `npx convex run` with deploy
// credentials or from other internal functions — never by clients — so they
// satisfy the same bar as `cronMutation`. The export-pattern scan below does
// not match method-call builders (`migrations.define`), which is fine: raw
// Convex builder identifiers/imports in that file are still caught by the two
// tests above.

// `httpAction` (Svix-verified webhook surface) is the only permitted
// non-builder function constructor, and only in convex/http.ts.
const ALLOWED_HTTP_CONSTRUCTORS = new Set(["httpAction"])
const ALLOWED_MIGRATION_BUILDERS = new Set(["attentionMigration", "workGraphTenancyMigration"])

function convexModules() {
  return fs.readdirSync(convexRoot)
    .filter((file) => file.endsWith(".ts"))
    .map((file) => ({
      file,
      source: fs.readFileSync(path.join(convexRoot, file), "utf8"),
    }))
}

function offendingLines(source: string, pattern: RegExp) {
  return source.split("\n")
    .map((line, index) => ({ line, number: index + 1 }))
    .filter(({ line }) => pattern.test(line))
    .map(({ line, number }) => `${number}: ${line.trim()}`)
}

describe("Convex authz builder guard (D8)", () => {
  test("no convex module outside the builder module uses raw Convex function builders", () => {
    const violations = convexModules()
      .filter(({ file }) => file !== BUILDER_MODULE)
      .flatMap(({ file, source }) =>
        offendingLines(source, RAW_BUILDER_IDENTIFIERS).map((where) => `convex/${file}:${where}`))
    expect(violations).toEqual([])
  })

  test("no convex module outside the builder module value-imports from convex/server builder entrypoints", () => {
    // Type-only imports (`import type { ... }`) are fine; value imports of the
    // generic builders are how a raw function sneaks back in under an alias.
    const importPattern = /import\s*(type\s)?\{([^}]*)\}\s*from\s*"convex\/server"/g
    const allowedValueImports = new Map<string, Set<string>>([
      // internalMutationGeneric backs the cronMutation builder (D13).
      [BUILDER_MODULE, new Set(["queryGeneric", "mutationGeneric", "internalMutationGeneric"])],
      [HTTP_MODULE, new Set(["httpRouter", "anyApi"])],
      ["schema.ts", new Set(["defineSchema", "defineTable"])],
      // Cron registry only — cronJobs defines schedules, not functions (D13).
      ["crons.ts", new Set(["cronJobs"])],
      // Component app definition only — defineApp registers the migrations
      // component, it cannot construct functions (D14).
      ["convex.config.ts", new Set(["defineApp"])],
    ])
    const violations: string[] = []
    for (const { file, source } of convexModules()) {
      for (const match of source.matchAll(importPattern)) {
        if (match[1]) continue // whole clause is type-only
        const names = match[2]!
          .split(",")
          .map((name) => name.trim())
          .filter(Boolean)
          .filter((name) => !name.startsWith("type "))
          .map((name) => name.split(" as ")[0]!.trim())
        const allowed = allowedValueImports.get(file) ?? new Set<string>()
        for (const name of names) {
          if (!allowed.has(name)) violations.push(`convex/${file}: value import "${name}" from convex/server`)
        }
      }
    }
    expect(violations).toEqual([])
  })

  test("every exported const function declaration uses a mandatory builder", () => {
    const exportPattern = /^export const (\w+)\s*=\s*(\w+)\s*\(/gm
    const violations: string[] = []
    for (const { file, source } of convexModules()) {
      if (file === BUILDER_MODULE) continue
      for (const match of source.matchAll(exportPattern)) {
        const callee = match[2]!
        if (ALLOWED_FUNCTION_BUILDERS.has(callee)) continue
        if (file === HTTP_MODULE && ALLOWED_HTTP_CONSTRUCTORS.has(callee)) continue
        if (file === "migrations.ts" && ALLOWED_MIGRATION_BUILDERS.has(callee)) continue
        violations.push(`convex/${file}: export const ${match[1]} = ${callee}(...)`)
      }
    }
    expect(violations).toEqual([])
  })

  test("no convex module exports an unauthenticated public function", () => {
    const exportPattern = /^export const (\w+)\s*=\s*(\w+)\s*\(/gm
    const publicBuilders = new Set<string>(PUBLIC_BUILDERS)
    const found = convexModules()
      .filter(({ file }) => file !== BUILDER_MODULE)
      .flatMap(({ file, source }) =>
        [...source.matchAll(exportPattern)]
          .filter((match) => publicBuilders.has(match[2]!))
          .map((match) => `convex/${file}: export const ${match[1]} = ${match[2]}(...)`))
    expect(found).toEqual(PUBLIC_BUILDER_BASELINE)
  })

  test("the Clerk webhook applier is internal, not publicly callable", async () => {
    // Regression pin for the escalation described on PUBLIC_BUILDERS. Asserted
    // on the REGISTERED function, not the source text: `isInternal` is the flag
    // Convex itself uses to refuse client calls, so this fails if the builder
    // is swapped back to a public one no matter how the call site is spelled.
    // The applier trusts its `type`/`data` completely because the httpAction has
    // already verified the Svix signature, so its visibility IS its authz.
    const orgs = await import("../../../../convex/orgs")
    expect((orgs.applyClerkWebhook as unknown as { isInternal?: boolean }).isInternal).toBe(true)
  })

  test("the builder module defines exactly the mandatory builder set", () => {
    const source = fs.readFileSync(path.join(convexRoot, BUILDER_MODULE), "utf8")
    for (const builder of ALLOWED_FUNCTION_BUILDERS) {
      expect(source).toContain(`export function ${builder}`)
    }
  })

  test("migration helpers remain internal component builders", () => {
    const source = fs.readFileSync(path.join(convexRoot, "migrations.ts"), "utf8")
    for (const builder of ALLOWED_MIGRATION_BUILDERS) {
      expect(source).toMatch(new RegExp(`function ${builder}\\([^]*?return migrations\\.define\\(`))
    }
  })
})
