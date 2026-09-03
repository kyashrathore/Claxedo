import { readFile } from "node:fs/promises"
import { fileURLToPath } from "node:url"
import { afterEach, describe, expect, test } from "vitest"
import { Miniflare } from "miniflare"
import type { D1Database } from "@cloudflare/workers-types"

import { CERTIFIED_ADAPTER_PROFILES } from "../../../deployments/hosted-shared/deployment-profile"

// Every AUTH_DB migration, in order. 0006 narrows the adapter-profile union
// "deploymentRelease" admits for new rows, so the narrowing is exercised
// against a database that already holds a release written under the retired
// profile: history stays, new retired rows are refused.
const AUTH_MIGRATIONS = [
  "0001_better_auth.sql",
  "0002_deployment_release_state.sql",
  "0003_authentication_evidence.sql",
  "0004_cutover_admission.sql",
  "0005_paired_recovery_epoch.sql",
  "0006_certified_adapter_profile.sql",
]

const BEFORE_PROFILE_NARROWING = AUTH_MIGRATIONS.slice(
  0,
  AUTH_MIGRATIONS.indexOf("0006_certified_adapter_profile.sql"),
)

const RETIRED_PROFILE = "clerk-convex"
const CERTIFIED_PROFILE = "better-auth-d1"

const active: Miniflare[] = []

afterEach(async () => {
  await Promise.all(active.splice(0).map((instance) => instance.dispose()))
})

async function database(): Promise<D1Database> {
  const instance = new Miniflare({
    modules: true,
    script: "export default { fetch() { return new Response('ok') } }",
    compatibilityDate: "2025-05-01",
    d1Databases: ["AUTH_DB"],
  })
  active.push(instance)
  return await instance.getD1Database("AUTH_DB")
}

async function apply(target: D1Database, names: readonly string[]) {
  for (const name of names) {
    const path = fileURLToPath(new URL(`../../../../migrations/auth/${name}`, import.meta.url))
    const migration = (await readFile(path, "utf8")).replace(/^\s*--.*$/gm, "")
    for (const statement of migration
      .split(/;\s*\n\s*\n/)
      .map((part) => part.trim())
      .filter(Boolean)) {
      await target.prepare(statement).run()
    }
  }
}

function release(target: D1Database, deploymentId: string, sequence: number, profile: string) {
  return target
    .prepare(
      `insert into "deploymentRelease"
         ("deploymentId", "releaseSequence", "releaseId", "workerBuildId", "platformVersionId",
          "browserBuildId", "relayBuildId", "authConfigurationId", "requestLimiterNamespaceId",
          "adapterProfile", "productPosture", "sandboxPosture", "serviceManifestId", "createdAt")
       values (?, ?, ?, 'worker', 'platform', 'browser', 'relay', 'sha256:auth', 'limiter', ?,
               'user-deployed', 'control-plane-only', 'manifest', '2025-01-01T00:00:00.000Z')`,
    )
    .bind(deploymentId, sequence, `release-${deploymentId}-${sequence}`, profile)
    .run()
}

async function releaseSchemaObjects(target: D1Database) {
  const rows = await target
    .prepare(
      `select type, name from sqlite_master
       where type in ('index', 'trigger') and tbl_name = 'deploymentRelease' and name not like 'sqlite_%'
       order by type, name`,
    )
    .all<{ type: string; name: string }>()
  return rows.results.map((row) => `${row.type}:${row.name}`)
}

describe("auth adapter-profile narrowing", () => {
  test("narrows the union to exactly the certified profiles the code compiles", () => {
    expect([...CERTIFIED_ADAPTER_PROFILES]).toEqual([CERTIFIED_PROFILE])
  })

  test("leaves existing release history in place and only refuses new retired rows", async () => {
    const target = await database()
    await apply(target, BEFORE_PROFILE_NARROWING)
    await release(target, "deployment-retired", 1, RETIRED_PROFILE)
    await release(target, "deployment-kept", 1, CERTIFIED_PROFILE)

    await apply(target, ["0006_certified_adapter_profile.sql"])

    const releases = await target
      .prepare(`select "deploymentId", "adapterProfile" from "deploymentRelease" order by "deploymentId"`)
      .all<{ deploymentId: string; adapterProfile: string }>()
    expect(releases.results).toEqual([
      { deploymentId: "deployment-kept", adapterProfile: CERTIFIED_PROFILE },
      { deploymentId: "deployment-retired", adapterProfile: RETIRED_PROFILE },
    ])
    await expect(release(target, "deployment-retired", 2, RETIRED_PROFILE)).rejects.toThrow(
      /adapter profile is not certified/,
    )
  })

  test("refuses a release written under the retired profile", async () => {
    const target = await database()
    await apply(target, AUTH_MIGRATIONS)

    await expect(release(target, "deployment-retired", 1, RETIRED_PROFILE)).rejects.toThrow(
      /adapter profile is not certified/,
    )
    await expect(release(target, "deployment-kept", 1, CERTIFIED_PROFILE)).resolves.toBeDefined()
  })

  test("keeps releases append-only after the narrowing", async () => {
    const target = await database()
    await apply(target, AUTH_MIGRATIONS)
    await release(target, "deployment-kept", 1, CERTIFIED_PROFILE)

    const objects = await releaseSchemaObjects(target)
    expect(objects).toContain("trigger:deploymentRelease_no_update")
    expect(objects).toContain("trigger:deploymentRelease_no_delete")
    expect(objects).toContain("trigger:deploymentRelease_certified_adapter_profile")

    await expect(
      target.prepare(`update "deploymentRelease" set "workerBuildId" = 'other'`).run(),
    ).rejects.toThrow(/deployment releases are append-only/)
    await expect(target.prepare(`delete from "deploymentRelease"`).run()).rejects.toThrow(
      /deployment releases are append-only/,
    )
  })
})
