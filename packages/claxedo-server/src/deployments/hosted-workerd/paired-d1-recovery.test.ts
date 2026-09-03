import { readFile } from "node:fs/promises"
import { fileURLToPath } from "node:url"

import { Miniflare } from "miniflare"
import type { D1Database } from "@cloudflare/workers-types"
import { afterAll, describe, expect, test } from "vitest"

import {
  pairedD1RecoveryRegistrationStatements,
  requirePairedD1RecoveryEpoch,
  type PairedD1RecoveryBinding,
} from "./paired-d1-recovery.cf"

const active: Miniflare[] = []
afterAll(async () => Promise.all(active.map((instance) => instance.dispose())))

async function applyMigration(database: D1Database, url: URL) {
  const migration = (await readFile(fileURLToPath(url), "utf8")).replace(/^\s*--.*$/gm, "")
  for (const statement of migration
    .split(/;\s*\n\s*\n/)
    .map((part) => part.trim())
    .filter(Boolean)) {
    await database.prepare(statement).run()
  }
}

const binding: PairedD1RecoveryBinding = {
  deploymentId: "deployment-test-01",
  releaseId: "release-test-0001",
  recoveryEpoch: `paired-d1-v1:sha256:${"1".repeat(64)}`,
}

describe("paired D1 recovery epoch", () => {
  test("fails closed on missing or mismatched halves", async () => {
    const instance = new Miniflare({
      modules: true,
      script: "export default { fetch() { return new Response('ok') } }",
      d1Databases: ["AUTH_DB", "CONTROL_PLANE_DB"],
    })
    active.push(instance)
    const auth = await instance.getD1Database("AUTH_DB")
    const control = await instance.getD1Database("CONTROL_PLANE_DB")
    await applyMigration(auth, new URL("../../../migrations/auth/0002_deployment_release_state.sql", import.meta.url))
    await applyMigration(auth, new URL("../../../migrations/auth/0005_paired_recovery_epoch.sql", import.meta.url))
    await applyMigration(
      control,
      new URL("../../../migrations/control-plane/0007_paired_recovery_epoch.sql", import.meta.url),
    )
    await auth
      .prepare(
        `insert into "deploymentRelease" values (?, 1, ?, 'worker', 'platform', 'browser', 'relay',
        'auth-config', '1001', 'better-auth-d1', 'user-deployed', 'control-plane-only', 'empty-services-v1', ?)`,
      )
      .bind(binding.deploymentId, binding.releaseId, "2026-08-28T00:00:00.000Z")
      .run()
    await expect(requirePairedD1RecoveryEpoch(auth, control, binding)).rejects.toThrow(/AUTH_DB recovery epoch/)
    const statements = pairedD1RecoveryRegistrationStatements(binding, new Date("2026-08-28T00:00:00.000Z"))
    await auth.prepare(statements.auth).run()
    await expect(requirePairedD1RecoveryEpoch(auth, control, binding)).rejects.toThrow(
      /CONTROL_PLANE_DB recovery epoch/,
    )
    await control
      .prepare(statements.controlPlane.replace(binding.recoveryEpoch, `paired-d1-v1:sha256:${"2".repeat(64)}`))
      .run()
    await expect(requirePairedD1RecoveryEpoch(auth, control, binding)).rejects.toThrow(
      /CONTROL_PLANE_DB recovery epoch/,
    )
  })

  test("replays exact registration without mutating either append-only row", async () => {
    const instance = new Miniflare({
      modules: true,
      script: "export default { fetch() { return new Response('ok') } }",
      d1Databases: ["AUTH_DB", "CONTROL_PLANE_DB"],
    })
    active.push(instance)
    const auth = await instance.getD1Database("AUTH_DB")
    const control = await instance.getD1Database("CONTROL_PLANE_DB")
    await applyMigration(auth, new URL("../../../migrations/auth/0002_deployment_release_state.sql", import.meta.url))
    await applyMigration(auth, new URL("../../../migrations/auth/0005_paired_recovery_epoch.sql", import.meta.url))
    await applyMigration(
      control,
      new URL("../../../migrations/control-plane/0007_paired_recovery_epoch.sql", import.meta.url),
    )
    await auth
      .prepare(
        `insert into "deploymentRelease" values (?, 1, ?, 'worker', 'platform', 'browser', 'relay',
        'auth-config', '1001', 'better-auth-d1', 'user-deployed', 'control-plane-only', 'empty-services-v1', ?)`,
      )
      .bind(binding.deploymentId, binding.releaseId, "2026-08-28T00:00:00.000Z")
      .run()
    const statements = pairedD1RecoveryRegistrationStatements(binding, new Date("2026-08-28T00:00:00.000Z"))
    await auth.prepare(statements.auth).run()
    await control.prepare(statements.controlPlane).run()
    await auth.prepare(statements.auth).run()
    await control.prepare(statements.controlPlane).run()
    await expect(requirePairedD1RecoveryEpoch(auth, control, binding)).resolves.toEqual(binding)
    await expect(
      auth
        .prepare(`update "deploymentRecoveryEpoch" set "recoveryEpoch" = ?`)
        .bind(`paired-d1-v1:sha256:${"3".repeat(64)}`)
        .run(),
    ).rejects.toThrow(/append-only/)
  })
})
