import { readFile } from "node:fs/promises"
import { fileURLToPath } from "node:url"

import { Miniflare } from "miniflare"
import { afterAll, describe, expect, test } from "vitest"

import {
  GREENFIELD_AUTH_TABLE_COUNTS,
  GREENFIELD_CONTROL_PLANE_TABLE_COUNTS,
  greenfieldTargetAbsenceCommands,
  greenfieldTargetCountsSql,
  greenfieldTargetSchemaSql,
  verifyGreenfieldDeploymentManifest,
  verifyGreenfieldTargetAbsence,
} from "./prove-greenfield-target-absence"

const active: Miniflare[] = []
afterAll(async () => Promise.all(active.map((instance) => instance.dispose())))

function d1Rows(rows: readonly Record<string, unknown>[]) {
  return JSON.stringify([{ success: true, results: rows }])
}

function schema(expected: Readonly<Record<string, number>>) {
  return d1Rows(
    Object.keys(expected)
      .sort()
      .map((table) => ({ table })),
  )
}

function counts(expected: Readonly<Record<string, number>>, override: Record<string, number> = {}) {
  return d1Rows([
    Object.fromEntries(
      Object.entries(expected)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([table, count]) => [table, override[table] ?? count]),
    ),
  ])
}

async function applyMigration(database: Awaited<ReturnType<Miniflare["getD1Database"]>>, migrationPath: URL) {
  const migration = (await readFile(fileURLToPath(migrationPath), "utf8")).replace(/^\s*--.*$/gm, "")
  for (const statement of migration
    .split(/;\s*\n\s*\n/)
    .map((part) => part.trim())
    .filter(Boolean)) {
    await database.prepare(statement).run()
  }
}

const valid = {
  deploymentId: "deployment-greenfield-0001",
  releaseId: "release-greenfield-0001",
  deploymentManifestSha256: `sha256:${"1".repeat(64)}`,
  authDatabaseId: "11111111-1111-1111-1111-111111111111",
  controlPlaneDatabaseId: "22222222-2222-2222-2222-222222222222",
  outputs: {
    "AUTH_DB:schema": schema(GREENFIELD_AUTH_TABLE_COUNTS),
    "AUTH_DB:counts": counts(GREENFIELD_AUTH_TABLE_COUNTS),
    "CONTROL_PLANE_DB:schema": schema(GREENFIELD_CONTROL_PLANE_TABLE_COUNTS),
    "CONTROL_PLANE_DB:counts": counts(GREENFIELD_CONTROL_PLANE_TABLE_COUNTS),
  },
} as const

describe("greenfield target-absence proof", () => {
  test("binds the generated manifest to the live locked release and exact D1 pair", () => {
    const activeRelease = {
      deploymentId: valid.deploymentId,
      releaseId: valid.releaseId,
      workerBuildId: `sha256:${"2".repeat(64)}`,
      platformVersionId: "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa",
      browserBuildId: "browser-absent-v1",
      relayBuildId: "relay-absent-v1",
      authConfigurationId: `sha256:${"3".repeat(64)}`,
      adapterProfile: "better-auth-d1",
      productPosture: "user-deployed",
      sandboxPosture: "control-plane-only",
      serviceManifestId: "empty-services-v1",
      phase: "locked",
      phaseRevision: 0,
    }
    const recoveryEpoch = `paired-d1-v1:sha256:${"4".repeat(64)}`
    const manifest = {
      schemaVersion: 1,
      ...activeRelease,
      environment: "production",
      apiOrigin: "https://api.claxedo.test",
      appOrigin: "https://app.claxedo.test",
      recoveryEpoch,
      resources: {
        authDatabase: { binding: "AUTH_DB", databaseId: valid.authDatabaseId },
        controlPlaneDatabase: { binding: "CONTROL_PLANE_DB", databaseId: valid.controlPlaneDatabaseId },
      },
    }
    const verification = {
      manifest,
      activeRelease,
      environment: "production" as const,
      apiOrigin: manifest.apiOrigin,
      appOrigin: manifest.appOrigin,
      authDatabaseId: valid.authDatabaseId,
      controlPlaneDatabaseId: valid.controlPlaneDatabaseId,
      recoveryEpoch,
    }
    expect(verifyGreenfieldDeploymentManifest(verification)).toBe(manifest)
    expect(() =>
      verifyGreenfieldDeploymentManifest({
        ...verification,
        manifest: {
          ...manifest,
          resources: {
            ...manifest.resources,
            authDatabase: { ...manifest.resources.authDatabase, databaseId: valid.controlPlaneDatabaseId },
          },
        },
      }),
    ).toThrow(/AUTH_DB databaseId/)
    expect(() =>
      verifyGreenfieldDeploymentManifest({
        ...verification,
        activeRelease: { ...activeRelease, phase: "canary", phaseRevision: 1 },
      }),
    ).toThrow(/active phase/)
  })

  test("proves the real migrated D1 schemas after exact locked static provisioning", async () => {
    const instance = new Miniflare({
      modules: true,
      script: "export default { fetch() { return new Response('ok') } }",
      d1Databases: ["AUTH_DB", "CONTROL_PLANE_DB"],
    })
    active.push(instance)
    const auth = await instance.getD1Database("AUTH_DB")
    const control = await instance.getD1Database("CONTROL_PLANE_DB")
    for (const name of [
      "0001_better_auth.sql",
      "0002_deployment_release_state.sql",
      "0003_authentication_evidence.sql",
      "0004_cutover_admission.sql",
      "0005_paired_recovery_epoch.sql",
    ]) {
      await applyMigration(auth, new URL(`../../migrations/auth/${name}`, import.meta.url))
    }
    for (const name of [
      "0001_service_installations.sql",
      "0002_workspace_authority.sql",
      "0003_private_sessions.sql",
      "0004_host_access_and_sharing.sql",
      "0005_agent_extensions_and_audit.sql",
      "0006_channel_identity_and_canonical_runtime.sql",
      "0007_paired_recovery_epoch.sql",
      "0008_user_deployed_owner_bootstrap.sql",
      "0009_optional_service_deployment.sql",
      "0010_session_turn_leases.sql",
      "0011_session_turn_producers.sql",
      "0012_cold_local_host_challenges.sql",
      "0013_org_team_session_sharing.sql",
      "0014_host_workspace_assignments.sql",
      "0015_drop_local_host_links.sql",
      "0016_host_session_authority.sql",
      "0018_drop_agent_extensions.sql",
    ]) {
      await applyMigration(control, new URL(`../../migrations/control-plane/${name}`, import.meta.url))
    }
    for (const statement of [
      `insert into "oauthClient" ("id", "clientId", "redirectUris") values
        ('client-1', 'claxedo-cli', '[]'), ('client-2', 'claxedo-desktop', '[]'),
        ('client-3', 'claxedo-control-plane', '[]')`,
      `insert into "oauthResource" ("id", "identifier", "name") values
        ('resource-1', 'https://api.claxedo.test/control-plane', 'Claxedo control plane')`,
      `insert into "oauthClientResource" ("id", "clientId", "resourceId") values
        ('link-1', 'claxedo-cli', 'https://api.claxedo.test/control-plane'),
        ('link-2', 'claxedo-desktop', 'https://api.claxedo.test/control-plane'),
        ('link-3', 'claxedo-control-plane', 'https://api.claxedo.test/control-plane')`,
      `insert into "deploymentRelease" values
        ('deployment-greenfield-0001', 1, 'release-greenfield-0001', 'worker-build', 'platform-version',
         'browser-absent-v1', 'relay-absent-v1', 'auth-config', '1001', 'better-auth-d1', 'user-deployed',
         'control-plane-only', 'empty-services-v1', '2026-08-28T00:00:00.000Z')`,
      `insert into "deploymentReleaseStateHistory" values
        ('deployment-greenfield-0001', 0, 'initialize:release-greenfield-0001', 'release-greenfield-0001',
         null, null, 'initialize', 'locked', 0, null, '2026-08-28T00:00:00.000Z')`,
      `insert into "deploymentReleaseActive" values
        (1, 'deployment-greenfield-0001', 0, '2026-08-28T00:00:00.000Z')`,
      `insert into "deploymentRecoveryEpoch" values
        ('deployment-greenfield-0001', 'release-greenfield-0001', 'paired-d1-v1:sha256:${"1".repeat(64)}',
         '2026-08-28T00:00:00.000Z')`,
    ]) {
      await auth.prepare(statement).run()
    }
    await control
      .prepare(`insert into control_plane_recovery_epochs values (?, ?, ?, ?)`)
      .bind(
        "deployment-greenfield-0001",
        "release-greenfield-0001",
        `paired-d1-v1:sha256:${"1".repeat(64)}`,
        "2026-08-28T00:00:00.000Z",
      )
      .run()
    const output = async (database: typeof auth, sql: string) => {
      const result = await database.prepare(sql).all()
      return JSON.stringify([{ success: result.success, results: result.results }])
    }
    const proof = verifyGreenfieldTargetAbsence({
      ...valid,
      outputs: {
        "AUTH_DB:schema": await output(auth, greenfieldTargetSchemaSql()),
        "AUTH_DB:counts": await output(auth, greenfieldTargetCountsSql(GREENFIELD_AUTH_TABLE_COUNTS)),
        "CONTROL_PLANE_DB:schema": await output(control, greenfieldTargetSchemaSql()),
        "CONTROL_PLANE_DB:counts": await output(
          control,
          greenfieldTargetCountsSql(GREENFIELD_CONTROL_PLANE_TABLE_COUNTS),
        ),
      },
    })
    expect(proof.targetAbsenceSha256).toMatch(/^sha256:[0-9a-f]{64}$/)
  })

  test("queries both exact remote D1 schemas and every certified table", () => {
    const commands = greenfieldTargetAbsenceCommands("/tmp/generated-core.toml")
    expect(commands).toHaveLength(4)
    expect(commands.map((command) => `${command.binding}:${command.kind}`)).toEqual([
      "AUTH_DB:schema",
      "AUTH_DB:counts",
      "CONTROL_PLANE_DB:schema",
      "CONTROL_PLANE_DB:counts",
    ])
    for (const command of commands) {
      expect(command.args).toContain("--remote")
      expect(command.args).toContain("--json")
      expect(command.args).toContain("/tmp/generated-core.toml")
    }
  })

  test("produces deterministic release, manifest, database, schema, and row-bound evidence", () => {
    const first = verifyGreenfieldTargetAbsence(valid)
    const second = verifyGreenfieldTargetAbsence(valid)
    expect(first).toEqual(second)
    expect(first.targetAbsenceSha256).toMatch(/^sha256:[0-9a-f]{64}$/)
    expect(first.databases[0]).toMatchObject({ binding: "AUTH_DB", databaseId: valid.authDatabaseId })
    expect(first.databases[1]).toMatchObject({
      binding: "CONTROL_PLANE_DB",
      databaseId: valid.controlPlaneDatabaseId,
    })
  })

  test("rejects any user or application row instead of accepting an operator hash", () => {
    expect(() =>
      verifyGreenfieldTargetAbsence({
        ...valid,
        outputs: { ...valid.outputs, "AUTH_DB:counts": counts(GREENFIELD_AUTH_TABLE_COUNTS, { user: 1 }) },
      }),
    ).toThrow(/AUTH_DB\.user expected 0 rows but observed 1/)
    expect(() =>
      verifyGreenfieldTargetAbsence({
        ...valid,
        outputs: {
          ...valid.outputs,
          "CONTROL_PLANE_DB:counts": counts(GREENFIELD_CONTROL_PLANE_TABLE_COUNTS, { orgs: 1 }),
        },
      }),
    ).toThrow(/CONTROL_PLANE_DB\.orgs expected 0 rows but observed 1/)
  })

  test("allows append-only release history while preserving exact greenfield product counts", () => {
    const proof = verifyGreenfieldTargetAbsence({
      ...valid,
      outputs: {
        ...valid.outputs,
        "AUTH_DB:counts": counts(GREENFIELD_AUTH_TABLE_COUNTS, {
          deploymentRelease: 6,
          deploymentReleaseStateHistory: 10,
          deploymentRecoveryEpoch: 6,
        }),
        "CONTROL_PLANE_DB:counts": counts(GREENFIELD_CONTROL_PLANE_TABLE_COUNTS, {
          control_plane_recovery_epochs: 6,
        }),
      },
    })
    expect(proof.databases[0]?.rows.find((row) => row.table === "deploymentRelease")?.count).toBe(6)
    expect(proof.databases[1]?.rows.find((row) => row.table === "control_plane_recovery_epochs")?.count).toBe(6)
  })

  test("rejects unknown, missing, duplicate, and malformed schema evidence", () => {
    expect(() =>
      verifyGreenfieldTargetAbsence({
        ...valid,
        outputs: {
          ...valid.outputs,
          "AUTH_DB:schema": d1Rows(
            [...Object.keys(GREENFIELD_AUTH_TABLE_COUNTS), "shadow_users"].sort().map((table) => ({ table })),
          ),
        },
      }),
    ).toThrow(/exact certified greenfield schema/)
    expect(() =>
      verifyGreenfieldTargetAbsence({
        ...valid,
        outputs: { ...valid.outputs, "AUTH_DB:counts": "not-json" },
      }),
    ).toThrow(/did not return JSON/)
  })
})
