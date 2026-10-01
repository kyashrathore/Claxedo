import { mkdtempSync, readdirSync, rmSync } from "node:fs"
import { readFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"

import { build } from "esbuild"
import { afterEach, describe, expect, test } from "vitest"

import {
  STAGED_CONTROL_PLANE_MIGRATIONS_DIR,
  stageWorkerControlPlaneMigrations,
} from "../../../scripts/deploy/staged-control-plane-migrations"
import { renderWorkerWranglerConfig } from "../../../scripts/deploy/wrangler-config"
import { CERTIFIED_HOSTED_WORKER_ARTIFACT_IDS, certifiedHostedWorkerArtifact } from "./certified-worker-artifacts"

const packageRoot = path.resolve(import.meta.dirname, "../../..")

function coreConfig(artifactId: (typeof CERTIFIED_HOSTED_WORKER_ARTIFACT_IDS)[number]) {
  const artifact = certifiedHostedWorkerArtifact(artifactId)
  return renderWorkerWranglerConfig({
    workerName: "claxedo",
    artifact,
    configDirectory: path.join(packageRoot, ".claxedo-deploy"),
    authDatabase: { name: "claxedo-auth", id: "11111111-1111-4111-8111-111111111111" },
    controlPlaneDatabase: { name: "claxedo-control-plane", id: "22222222-2222-4222-8222-222222222222" },
    controlPlaneMigrationsDir: STAGED_CONTROL_PLANE_MIGRATIONS_DIR,
    requestLimiterNamespaceId: "3123456789",
    ...(artifact.agentPlugins ? { agentPluginsBucket: "claxedo-agent-plugins" } : {}),
    variables: { CLAXEDO_SANDBOX_POSTURE: artifact.sandboxPosture },
  })
}

describe("certified core resource ownership", () => {
  test("every artifact binds auth/control D1, the limiter and LiveSyncRoom, the documents bucket, and only Agent Plugins binds the plugin-backend platform", () => {
    for (const artifactId of CERTIFIED_HOSTED_WORKER_ARTIFACT_IDS) {
      const config = coreConfig(artifactId)
      const agentPlugins = certifiedHostedWorkerArtifact(artifactId).agentPlugins
      expect([...config.matchAll(/^binding = "([A-Z][A-Z0-9_]+)"$/gm)].map((match) => match[1]), artifactId).toEqual([
        "CF_VERSION_METADATA",
        "AUTH_DB",
        "CONTROL_PLANE_DB",
        "CLAXEDO_DOCUMENTS",
        ...(agentPlugins ? ["CLAXEDO_AGENT_PLUGINS", "PLUGIN_LOADER"] : []),
      ])
      expect([...config.matchAll(/^name = "([A-Z][A-Z0-9_]+)"$/gm)].map((match) => match[1])).toEqual([
        "CLAXEDO_REQUEST_LIMITER",
        "LIVE_SYNC_ROOM",
        ...(agentPlugins ? ["PLUGIN_SUPERVISOR"] : []),
      ])
      expect(config).toContain('tag = "v1"\nnew_sqlite_classes = ["LiveSyncRoom"]')
      if (agentPlugins) expect(config).toContain('tag = "v2"\nnew_sqlite_classes = ["PluginSupervisor"]')
      else expect(config).not.toMatch(/PluginSupervisor|worker_loaders/)
      expect(config).not.toMatch(/POLAR|BILLING|crons/i)
    }
  })

  test("maps only to existing default-exporting Workers that export their Durable Object classes, never the core factory", async () => {
    for (const artifactId of CERTIFIED_HOSTED_WORKER_ARTIFACT_IDS) {
      const artifact = certifiedHostedWorkerArtifact(artifactId)
      const source = await readFile(path.join(packageRoot, artifact.entrypointFromPackageRoot), "utf8")
      expect(source).toMatch(/export default handler/)
      expect(source).toMatch(
        artifact.agentPlugins
          ? /export \{ LiveSyncRoom, PluginOutbound, PluginPlatform, PluginSupervisor \}/
          : /export \{ LiveSyncRoom \}/,
      )
      expect(artifact.entrypointFromPackageRoot).not.toBe("src/deployments/hosted-workerd/core-worker.cf.ts")
    }
  })
})

const AGENT_PLUGINS_ENTRY = "src/deployments/hosted-workerd/better-auth-d1-worker.agent-plugins.cf.ts"
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
      "src/tasks/grant-renewal.ts",
      "src/tasks/grant-withdrawal.ts",
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
    const config = coreConfig("user-deployed-better-auth-d1")
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
