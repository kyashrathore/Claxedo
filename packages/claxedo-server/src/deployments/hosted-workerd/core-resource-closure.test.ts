import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs"
import { readFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"

import { build } from "esbuild"
import { afterEach, describe, expect, test } from "vitest"
import { runtimeImportSpecifiers, sourceClosure } from "@claxedo/server-core/platform/governance/source-closure"

import { renderHostedCoreWranglerConfig } from "../../../scripts/deploy/render-hosted-core-config"
import {
  STAGED_CONTROL_PLANE_MIGRATIONS_DIR,
  renderWorkerBuildSelectionDefine,
  stageWorkerControlPlaneMigrations,
} from "../../../scripts/deploy/worker-build-selection"
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
const FULL_HOSTED_ENTRY = "src/deployments/hosted-workerd/better-auth-d1-candidate-worker.agent-plugins.full-hosted.cf.ts"
const GATED_MODULE = "src/deployments/hosted-workerd/tasks-contributions.ts"
const TASKS_SPECIFIER = /^@claxedo\/(tasks|server-core\/tasks-host)(\/|$)|(^|\/)tasks\/(hosted-composition|session-bridge|d1-store)$/

const temporaryDirectories: string[] = []

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) rmSync(directory, { recursive: true, force: true })
})

function temporary() {
  const directory = mkdtempSync(path.join(tmpdir(), "claxedo-worker-selection-"))
  temporaryDirectories.push(directory)
  return directory
}

/**
 * The Tasks half of the Worker artifact the selection actually emits.
 *
 * `packages: "external"` keeps the walk inside this package's own sources, so
 * the measurement needs no built `dist` for any workspace dependency and still
 * answers the only question the gate decides: which modules contribute bytes,
 * and which Tasks specifiers the artifact still imports, under the `[define]`
 * Wrangler renders. The whole bundle — every workspace package inlined — is
 * measured by `build:workerd-boundary`, which runs the real Wrangler dry run.
 */
async function emittedTasksClosure(selection: string) {
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
    define: { "process.env.CLAXEDO_BUILD_TASKS": JSON.stringify(selection) },
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

describe("the hosted Worker Tasks selection", () => {
  test("the gate owns the only edge into Tasks in the whole Worker closure", () => {
    // The full-hosted entry's closure is a superset of the plain Agent Plugins
    // one, so this scans both. A second edge from any module either entry
    // reaches puts the kit back into the artifact with the gate still present
    // and reading correctly.
    const closure = sourceClosure({ entry: path.join(packageRoot, FULL_HOSTED_ENTRY), root: packageRoot })
    expect(closure.opaque).toEqual([])
    const edges: string[] = []
    for (const module of closure.modules) {
      if (module.relative === GATED_MODULE) continue
      for (const specifier of runtimeImportSpecifiers(readFileSync(module.file, "utf8"))) {
        if (TASKS_SPECIFIER.test(specifier)) edges.push(`${module.relative} -> ${specifier}`)
      }
    }
    expect(edges.filter((edge) => !edge.startsWith("src/tasks/"))).toEqual([])
    // Positive control: a walk that reached nothing reports the same empty list.
    expect(closure.modules.map((module) => module.relative)).toContain(GATED_MODULE)
  })

  test("the gate is a literal dynamic import inside the folded branch", () => {
    const source = readFileSync(path.join(packageRoot, AGENT_PLUGINS_ENTRY), "utf8")
    // Measured on this entry: a folded `if` around a static import still
    // emitted every Tasks module, because esbuild drops a module only when
    // nothing references it at all.
    expect(source).toContain(
      'process.env.CLAXEDO_BUILD_TASKS !== "0"\n    ? (await import("./tasks-contributions")).hostedTasksRouteContributions',
    )
  })

  test("the emitted artifact carries Tasks when selected and none of it when not", async () => {
    const on = await emittedTasksClosure("1")
    const off = await emittedTasksClosure("0")

    expect(on.modules).toContain(GATED_MODULE)
    expect(on.modules.filter((module) => module.startsWith("src/tasks/")).sort()).toEqual([
      "src/tasks/d1-store.ts",
      "src/tasks/hosted-composition.ts",
      "src/tasks/session-bridge.ts",
    ])
    expect(on.imports).toContain("@claxedo/tasks")
    expect(on.imports).toContain("@claxedo/tasks/http")
    expect(on.imports).toContain("@claxedo/server-core/tasks-host/session-bridge-core")
    expect(on.imports).toContain("@claxedo/server-core/tasks-host/authorization")

    expect(off.modules).not.toContain(GATED_MODULE)
    expect(off.modules.filter((module) => module.startsWith("src/tasks/"))).toEqual([])
    expect(off.imports.filter((specifier) => TASKS_SPECIFIER.test(specifier))).toEqual([])
    // Both builds are of the same entry, so an off measurement that dropped
    // the whole graph would also satisfy the assertions above.
    expect(off.modules.length).toBeGreaterThan(on.modules.length - 10)
    expect(off.modules).toContain(AGENT_PLUGINS_ENTRY)
  })

  test("only an explicit 0 bakes Tasks out of a rendered Worker config", () => {
    expect(renderWorkerBuildSelectionDefine({})).toContain('"process.env.CLAXEDO_BUILD_TASKS" = "\\"1\\""')
    expect(renderWorkerBuildSelectionDefine({ CLAXEDO_BUILD_TASKS: "1" })).toContain(
      '"process.env.CLAXEDO_BUILD_TASKS" = "\\"1\\""',
    )
    expect(renderWorkerBuildSelectionDefine({ CLAXEDO_BUILD_TASKS: "0" })).toContain(
      '"process.env.CLAXEDO_BUILD_TASKS" = "\\"0\\""',
    )
  })

  test("the rendered config points Wrangler at the staged migrations, never at the source directory", () => {
    const config = renderHostedCoreWranglerConfig(cutoverCoreBoundary)
    expect(config).toContain(`migrations_dir = "${STAGED_CONTROL_PLANE_MIGRATIONS_DIR}"`)
    expect(config).toContain("[define]")

    const configDirectory = temporary()
    const staged = stageWorkerControlPlaneMigrations({ configDirectory, env: {} })
    expect(staged.migrationsDir).toBe(STAGED_CONTROL_PLANE_MIGRATIONS_DIR)
    expect(path.resolve(configDirectory, staged.migrationsDir)).toBe(
      path.join(configDirectory, "migrations", "control-plane"),
    )
  })

  test("the staged control-plane migrations carry the Tasks schema only when selected", () => {
    const source = readdirSync(path.join(packageRoot, "migrations/control-plane")).sort()
    expect(source).toContain("0024_claxedo_tasks.sql")

    const on = temporary()
    expect(stageWorkerControlPlaneMigrations({ configDirectory: on, env: {} }).excluded).toEqual([])
    expect(readdirSync(path.join(on, "migrations/control-plane")).sort()).toEqual(source)

    const off = temporary()
    expect(
      stageWorkerControlPlaneMigrations({ configDirectory: off, env: { CLAXEDO_BUILD_TASKS: "0" } }).excluded,
    ).toEqual(["0024_claxedo_tasks.sql"])
    expect(readdirSync(path.join(off, "migrations/control-plane")).sort()).toEqual(
      source.filter((name) => name !== "0024_claxedo_tasks.sql"),
    )
    // The source directory every other reader shares is untouched by either
    // staging run; `control-plane-migrations.test.ts` pins its full list.
    expect(readdirSync(path.join(packageRoot, "migrations/control-plane")).sort()).toEqual(source)
  })
})
