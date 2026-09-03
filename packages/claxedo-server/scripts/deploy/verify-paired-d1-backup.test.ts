import { readFile } from "node:fs/promises"

import { describe, expect, test } from "vitest"

import { verifyPairedD1BackupExports } from "./verify-paired-d1-backup"

const deploymentId = "deployment-backup-0001"
const releaseId = "release-backup-0001"
const recoveryEpoch = `paired-d1-v1:sha256:${"5".repeat(64)}`

async function migrations(directory: "auth" | "control-plane", names: readonly string[]) {
  return (
    await Promise.all(
      names.map((name) => readFile(new URL(`../../migrations/${directory}/${name}`, import.meta.url), "utf8")),
    )
  ).join("\n")
}

async function exports(phase = "provider_sync") {
  const phaseRevision = phase === "provider_sync" ? 2 : 0
  const firstTargetWriteAt = phase === "provider_sync" ? "'2026-08-28T00:01:00.000Z'" : "null"
  const auth = `${await migrations("auth", [
    "0001_better_auth.sql",
    "0002_deployment_release_state.sql",
    "0003_authentication_evidence.sql",
    "0004_cutover_admission.sql",
    "0005_paired_recovery_epoch.sql",
  ])}
    insert into "deploymentRelease" values
      ('${deploymentId}', 1, '${releaseId}', 'worker', 'platform', 'browser', 'relay', 'auth-config', '1001',
       'better-auth-d1', 'user-deployed', 'control-plane-only', 'empty-services-v1', '2026-08-28T00:00:00.000Z');
    insert into "deploymentReleaseStateHistory" values
      ('${deploymentId}', 0, 'initialize:${releaseId}', '${releaseId}', null, null, 'initialize', '${phase}', ${phaseRevision},
       ${firstTargetWriteAt}, '2026-08-28T00:01:00.000Z');
    insert into "deploymentReleaseActive" values (1, '${deploymentId}', 0, '2026-08-28T00:01:00.000Z');
    insert into "deploymentRecoveryEpoch" values
      ('${deploymentId}', '${releaseId}', '${recoveryEpoch}', '2026-08-28T00:00:00.000Z');`
  const control = `${await migrations("control-plane", [
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
    "0017_drop_agent_extensions.sql",
  ])}
    insert into control_plane_recovery_epochs values
      ('${deploymentId}', '${releaseId}', '${recoveryEpoch}', '2026-08-28T00:00:00.000Z');`
  return { auth: new TextEncoder().encode(auth), control: new TextEncoder().encode(control) }
}

const input = {
  authDatabaseId: "11111111-1111-1111-1111-111111111111",
  controlPlaneDatabaseId: "22222222-2222-2222-2222-222222222222",
  binding: { deploymentId, releaseId, recoveryEpoch },
} as const

describe("paired D1 export backup verifier", () => {
  test("restores both full schemas and emits exact hashes/counts for one provider-sync pair", async () => {
    const fixture = await exports()
    const evidence = verifyPairedD1BackupExports({
      ...input,
      authSql: fixture.auth,
      controlPlaneSql: fixture.control,
    })
    expect(evidence).toMatchObject({
      recoveryEpoch,
      authBackupSha256: expect.stringMatching(/^sha256:[0-9a-f]{64}$/),
      controlPlaneBackupSha256: expect.stringMatching(/^sha256:[0-9a-f]{64}$/),
      databases: [
        { binding: "AUTH_DB", databaseId: input.authDatabaseId, integrity: "ok" },
        { binding: "CONTROL_PLANE_DB", databaseId: input.controlPlaneDatabaseId, integrity: "ok" },
      ],
    })
    expect(evidence.databases[0]?.tables.find((table) => table.table === "deploymentRecoveryEpoch")?.rows).toBe(1)
    expect(evidence.databases[1]?.tables.find((table) => table.table === "control_plane_recovery_epochs")?.rows).toBe(1)
  })

  test("restores a D1 export whose trigger precedes its target view", async () => {
    const fixture = await exports()
    const outOfOrderSchema = `
CREATE TRIGGER export_order_trigger
INSTEAD OF INSERT ON export_order_view
BEGIN
  SELECT 1;
END;
CREATE VIEW export_order_view AS SELECT 1 AS value;
`
    const evidence = verifyPairedD1BackupExports({
      ...input,
      authSql: fixture.auth,
      controlPlaneSql: new TextEncoder().encode(`${outOfOrderSchema}\n${new TextDecoder().decode(fixture.control)}`),
    })
    expect(evidence.databases[1]).toMatchObject({ binding: "CONTROL_PLANE_DB", integrity: "ok" })
  })

  test("rejects an epoch mismatch, pre-provider-sync capture, schema loss, and unsafe export SQL", async () => {
    const fixture = await exports()
    expect(() =>
      verifyPairedD1BackupExports({
        ...input,
        authSql: fixture.auth,
        controlPlaneSql: new TextEncoder().encode(
          new TextDecoder().decode(fixture.control).replace(recoveryEpoch, `paired-d1-v1:sha256:${"6".repeat(64)}`),
        ),
      }),
    ).toThrow(/CONTROL_PLANE_DB restored recovery epoch/)
    const locked = await exports("locked")
    expect(() =>
      verifyPairedD1BackupExports({ ...input, authSql: locked.auth, controlPlaneSql: locked.control }),
    ).toThrow(/provider_sync/)
    expect(() =>
      verifyPairedD1BackupExports({
        ...input,
        authSql: new TextEncoder().encode(`${new TextDecoder().decode(fixture.auth)}\ndrop table verification;`),
        controlPlaneSql: fixture.control,
      }),
    ).toThrow(/restored schema drifted/)
    expect(() =>
      verifyPairedD1BackupExports({
        ...input,
        authSql: new TextEncoder().encode(`${new TextDecoder().decode(fixture.auth)}\nattach database '/tmp/x' as x;`),
        controlPlaneSql: fixture.control,
      }),
    ).toThrow(/unsafe SQLite export/)
  })
})
