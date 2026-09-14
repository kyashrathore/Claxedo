import { mkdtempSync, readdirSync, rmSync } from "node:fs"
import { readFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"

import { build } from "esbuild"
import { afterEach, describe, expect, test } from "vitest"

import { renderHostedCoreWranglerConfig } from "../../../scripts/deploy/render-hosted-core-config"
import {
  STAGED_CONTROL_PLANE_MIGRATIONS_DIR,
  stageWorkerControlPlaneMigrations,
} from "../../../scripts/deploy/staged-control-plane-migrations"
import { certifiedHostedWorkerArtifact } from "./certified-worker-artifacts"

const packageRoot = path.resolve(import.meta.dirname, "../../..")

const lockedCoreBoundary = {
  artifactId: "user-deployed-better-auth-d1-locked" as const,
  deploymentId: "deployment-production",
  authDatabase: { name: "claxedo-auth-production", id: "auth-production-id" },
  controlPlaneDatabase: {
    name: "claxedo-core-production",
    id: "core-production-id",
  },
  controlPlaneMigrationsDir: STAGED_CONTROL_PLANE_MIGRATIONS_DIR,
  limiter: {
    owner: "core",
    environment: "production" as const,
    namespaceId: "3123456789",
  },
}

const cutoverCoreBoundary = {
  ...lockedCoreBoundary,
  artifactId: "user-deployed-better-auth-d1-candidate" as const,
  userDeployedOrganization: { id: "org_deployment", name: "My deployment" },
}

describe("certified core resource ownership", () => {
  test("the generated locked boundary owns only auth/control D1 and the limiter", () => {
    const config = renderHostedCoreWranglerConfig(lockedCoreBoundary)

    expect([...config.matchAll(/^binding = "([A-Z][A-Z0-9_]+)"$/gm)].map((match) => match[1])).toEqual([
      "CF_VERSION_METADATA",
      "AUTH_DB",
      "CONTROL_PLANE_DB",
    ])
    expect([...config.matchAll(/^name = "([A-Z][A-Z0-9_]+)"$/gm)].map((match) => match[1])).toEqual([
      "CLAXEDO_REQUEST_LIMITER",
    ])
    expect(config).not.toMatch(
      /WAKE_LANE|DOCUMENTS|CLAXEDO_DOCUMENTS|LIVE_SYNC_ROOM|r2_buckets|durable_objects|crons|POLAR/i,
    )
  })

  test("maps only to an existing default-exporting Worker, never the core factory", async () => {
    const artifact = certifiedHostedWorkerArtifact(lockedCoreBoundary.artifactId, "production")
    const source = await readFile(path.join(packageRoot, artifact.entrypointFromPackageRoot), "utf8")
    expect(source).toMatch(/export default handler/)
    expect(artifact.entrypointFromPackageRoot).not.toBe("src/deployments/hosted-workerd/core-worker.cf.ts")
  })

  test("the cutover artifact adds LiveSyncRoom v1 to the same release train and no optional-service resource", async () => {
    const artifact = certifiedHostedWorkerArtifact(cutoverCoreBoundary.artifactId, "production")
    const source = await readFile(path.join(packageRoot, artifact.entrypointFromPackageRoot), "utf8")
    const config = renderHostedCoreWranglerConfig(cutoverCoreBoundary)

    expect(source).toMatch(/export default handler/)
    expect(source).toMatch(/export \{ LiveSyncRoom \}/)
    expect(config).toContain('name = "claxedo-user-deployed-locked"')
    expect(config).toContain('name = "LIVE_SYNC_ROOM"')
    expect(config).toContain('tag = "v1"\nnew_sqlite_classes = ["LiveSyncRoom"]')
    expect(config).not.toMatch(/WAKE_LANE|DOCUMENTS|POLAR|BILLING/i)
  })

  test("the lifecycle bridge adds only LiveSyncRoom while retaining the fail-closed bootstrap handler", async () => {
    const artifact = certifiedHostedWorkerArtifact(
      "user-deployed-better-auth-d1-live-sync-migration-bridge",
      "production",
    )
    const source = await readFile(path.join(packageRoot, artifact.entrypointFromPackageRoot), "utf8")

    expect(source).toContain('export { default } from "./better-auth-d1-bootstrap-gate.cf"')
    expect(source).toContain('export { LiveSyncRoom } from "./live-sync-room.cf"')
    expect(artifact.workerName).toBe("claxedo-user-deployed-locked")
    expect(artifact.resources).toMatchObject({ liveSyncRoom: true, optionalServices: false, billing: false })
  })
})

const AGENT_PLUGINS_ENTRY = "src/deployments/hosted-workerd/better-auth-d1-candidate-worker.agent-plugins.cf.ts"
const TASKS_MODULE = "src/deployments/hosted-workerd/tasks-contributions.ts"

const temporaryDirectories: string[] = []

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) rmSync(directory, { recursive: true, force: true })
})

function temporary() {
  const directory = mkdtempSync(path.join(tmpdir(), "claxedo-worker-migrations-"))
  temporaryDirectories.push(directory)
  return directory
}

/**
 * The Tasks half of the Worker artifact this entry emits.
 *
 * `packages: "external"` keeps the walk inside this package's own sources, so
 * the measurement needs no built `dist` for any workspace dependency and still
 * answers which modules contribute bytes and which Tasks specifiers the
 * artifact imports. The whole bundle — every workspace package inlined — is
 * measured by `build:workerd-boundary`, which runs the real Wrangler dry run.
 */
async function emittedTasksClosure() {
  const result = await build({
    absWorkingDir: packageRoot,
    entryPoints: [path.join(packageRoot, AGENT_PLUGINS_ENTRY)],
    outfile: "worker.js",
    bundle: true,
    write: false,
    metafile: true,
    format: "esm",
    platform: "node",
    target: "esnext",
    packages: "external",
    logLevel: "warning",
  })
  const output = Object.values(result.metafile.outputs)[0]
  return {
    modules: Object.entries(output.inputs)
      .filter(([, input]) => input.bytesInOutput > 0)
      .map(([module]) => module),
    imports: [...new Set((output.imports ?? []).filter((entry) => entry.external).map((entry) => entry.path))],
  }
}

describe("the hosted Worker Tasks closure", () => {
  test("the emitted artifact carries Tasks", async () => {
    const emitted = await emittedTasksClosure()

    expect(emitted.modules).toContain(TASKS_MODULE)
    expect(emitted.modules.filter((module) => module.startsWith("src/tasks/")).sort()).toEqual([
      // The grant a cloud root launches with, and the signer that mints it.
      "src/tasks/capability.ts",
      "src/tasks/d1-store.ts",
      "src/tasks/hosted-composition.ts",
      "src/tasks/root-capability.ts",
      "src/tasks/session-bridge.ts",
      "src/tasks/session-reservation.ts",
    ])
    expect(emitted.imports).toContain("@claxedo/tasks")
    expect(emitted.imports).toContain("@claxedo/server-core/tasks-host/session-bridge-core")
    // The kit's routes are mounted through the shared contribution owner, so
    // `@claxedo/tasks/http` reaches this artifact behind that specifier rather
    // than as one of its own imports.
    expect(emitted.imports).toContain("@claxedo/server-core/tasks-host/contribution")
  })

  test("the rendered config points Wrangler at the staged migrations, never at the source directory", () => {
    const config = renderHostedCoreWranglerConfig(cutoverCoreBoundary)
    expect(config).toContain(`migrations_dir = "${STAGED_CONTROL_PLANE_MIGRATIONS_DIR}"`)

    const configDirectory = temporary()
    const staged = stageWorkerControlPlaneMigrations({ configDirectory })
    expect(staged.migrationsDir).toBe(STAGED_CONTROL_PLANE_MIGRATIONS_DIR)
    expect(path.resolve(configDirectory, staged.migrationsDir)).toBe(
      path.join(configDirectory, "migrations", "control-plane"),
    )
  })

  test("the staged copy carries every control-plane migration, the Tasks schema included", () => {
    const source = readdirSync(path.join(packageRoot, "migrations/control-plane")).sort()
    expect(source).toContain("0025_claxedo_tasks.sql")

    const configDirectory = temporary()
    stageWorkerControlPlaneMigrations({ configDirectory })
    expect(readdirSync(path.join(configDirectory, "migrations/control-plane")).sort()).toEqual(source)
    // The source directory every other reader shares is untouched by a staging
    // run; `control-plane-migrations.test.ts` pins its full list.
    expect(readdirSync(path.join(packageRoot, "migrations/control-plane")).sort()).toEqual(source)
  })
})
