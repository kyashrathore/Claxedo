import { spawnSync } from "node:child_process"
import fs from "node:fs"
import path from "node:path"

import {
  normalizeEsbuildBuildManifest,
  serializeBuildManifest,
  type EsbuildMetafile,
} from "../../../../script/product-boundary/normalize-build-manifest"
import { certifiedHostedWorkerArtifact } from "../../src/deployments/hosted-workerd/certified-worker-artifacts"
import { renderHostedCoreWranglerConfig } from "../deploy/render-hosted-core-config"
import { stageWorkerControlPlaneMigrations } from "../deploy/worker-build-selection"
import {
  REPO_ROOT,
  SERVER_ROOT,
  WORKERD_BOUNDARY_DIST,
  WORKERD_BOUNDARY_ENVIRONMENT,
  WORKERD_BOUNDARY_MANIFEST_ARTIFACT,
  WORKERD_BOUNDARY_TARGETS,
  type WorkerdBoundaryTarget,
} from "./certified-workerd-boundary"
import { asRecord, isRecord, parseJson } from "@claxedo/server-core/platform/json/index"

/**
 * Placeholder Cloudflare resource identities.
 *
 * `wrangler deploy --dry-run` bundles and validates the config locally and
 * never authenticates or resolves a resource, so the gate hands the real
 * renderer obviously-fake ids rather than duplicating the config it renders.
 * The Wrangler invocation below removes every Cloudflare credential from the
 * subprocess environment, so a real account can neither be reached nor named
 * by accident.
 */
const PLACEHOLDER = {
  deploymentId: "boundary-dry-run-deployment",
  authDatabase: { name: "claxedo-auth-boundary-dry-run", id: "00000000-0000-4000-8000-00000000dead" },
  controlPlaneDatabase: { name: "claxedo-core-boundary-dry-run", id: "00000000-0000-4000-8000-00000000beef" },
  limiter: { owner: "core" as const, environment: WORKERD_BOUNDARY_ENVIRONMENT, namespaceId: "3999999999" },
  userDeployedOrganization: { id: "org_boundary_dry_run", name: "Boundary dry run" },
}

const CONFIG_FILE = path.join(SERVER_ROOT, ".claxedo-workerd-boundary-wrangler.toml")
const STAGED_MIGRATIONS = path.join(SERVER_ROOT, ".claxedo-workerd-boundary-migrations")
const WRANGLER = path.join(SERVER_ROOT, "node_modules/.bin/wrangler")

function boundaryWranglerConfig(target: WorkerdBoundaryTarget, controlPlaneMigrationsDir: string) {
  const artifact = certifiedHostedWorkerArtifact(target.artifactId, WORKERD_BOUNDARY_ENVIRONMENT)
  return renderHostedCoreWranglerConfig({
    artifactId: target.artifactId,
    deploymentId: PLACEHOLDER.deploymentId,
    authDatabase: PLACEHOLDER.authDatabase,
    controlPlaneDatabase: PLACEHOLDER.controlPlaneDatabase,
    controlPlaneMigrationsDir,
    limiter: PLACEHOLDER.limiter,
    // The renderer rejects the pairing in either direction: only a
    // cutover-capable artifact carries the one user-deployed organization.
    ...(artifact.resources.liveSyncRoom ? { userDeployedOrganization: PLACEHOLDER.userDeployedOrganization } : {}),
  })
}

/**
 * A Wrangler environment that cannot reach Cloudflare.
 *
 * `--dry-run` performs no API call, and dropping every credential proves it:
 * if a future Wrangler release starts authenticating, this gate fails instead
 * of quietly depending on a CI token.
 */
function offlineWranglerEnvironment() {
  const env: NodeJS.ProcessEnv = { ...process.env, WRANGLER_SEND_METRICS: "false" }
  for (const name of [
    "CF_API_TOKEN",
    "CLOUDFLARE_ACCOUNT_ID",
    "CLOUDFLARE_API_KEY",
    "CLOUDFLARE_API_TOKEN",
    "CLOUDFLARE_EMAIL",
  ]) delete env[name]
  return env
}

/**
 * The two maps `normalizeEsbuildBuildManifest` walks. Their entries are read
 * defensively there (every nested field is optional), so the check that matters
 * here is that the file is a metafile at all rather than, say, an error report
 * esbuild wrote in its place.
 */
function isEsbuildMetafile(value: Record<string, unknown> | undefined): value is EsbuildMetafile {
  return !!value && isRecord(value.inputs) && isRecord(value.outputs)
}

function buildManifest(target: WorkerdBoundaryTarget) {
  const metafile = asRecord(parseJson(fs.readFileSync(target.metafileFile, "utf8")))
  if (!isEsbuildMetafile(metafile)) throw new Error(`${target.metafileFile} is not an esbuild metafile`)
  return normalizeEsbuildBuildManifest({
    entry: path.join(SERVER_ROOT, target.entrypointFromPackageRoot),
    metafile,
    // Wrangler runs esbuild from the package root, so the metafile's relative
    // module ids resolve against it.
    workingDirectory: SERVER_ROOT,
    workspaceRoot: REPO_ROOT,
  })
}

function buildEveryCertifiedArtifact() {
  // The gate bundles the selection the environment asks for, and the staged
  // directory the config names is what a `d1 migrations apply` would read.
  fs.rmSync(STAGED_MIGRATIONS, { recursive: true, force: true })
  const staged = stageWorkerControlPlaneMigrations({ configDirectory: SERVER_ROOT, stageInto: STAGED_MIGRATIONS })
  for (const target of WORKERD_BOUNDARY_TARGETS) {
    fs.mkdirSync(target.outputDirectory, { recursive: true })
    // The renderer resolves `main` and `migrations_dir` from the package root,
    // so its config has to be written there.
    const config = boundaryWranglerConfig(target, staged.migrationsDir)
    fs.writeFileSync(CONFIG_FILE, config)
    const result = spawnSync(
      WRANGLER,
      [
        "deploy",
        "--config", CONFIG_FILE,
        "--dry-run",
        "--outdir", target.outputDirectory,
        "--metafile", target.metafileFile,
        "--tsconfig", path.join(SERVER_ROOT, "tsconfig.auth-d1.json"),
      ],
      { cwd: SERVER_ROOT, env: offlineWranglerEnvironment(), stdio: "inherit" },
    )
    if (result.error) throw result.error
    if (result.status !== 0) return result.status ?? 2
    if (!fs.existsSync(target.bundleFile)) {
      throw new Error(`Wrangler did not emit the certified entry bundle: ${target.bundleFile}`)
    }
    // The smoke boots the emitted module under the compatibility contract this
    // bundle was produced with, rather than restating it.
    fs.writeFileSync(target.configFile, config)
    const manifest = buildManifest(target)
    if (target.artifactId === WORKERD_BOUNDARY_MANIFEST_ARTIFACT) {
      const manifestFile = path.join(SERVER_ROOT, ".artifacts/u8-package-split/manifests/server-workerd.json")
      fs.mkdirSync(path.dirname(manifestFile), { recursive: true })
      fs.writeFileSync(manifestFile, serializeBuildManifest(manifest))
    }
    console.log(
      `[server-workerd] ${target.artifactId}: built ${manifest.modules.length} modules in ${manifest.chunks.length} chunk` +
        (staged.excluded.length > 0 ? `, migrations excluded: ${staged.excluded.join(", ")}` : ""),
    )
  }
  return 0
}

fs.rmSync(WORKERD_BOUNDARY_DIST, { recursive: true, force: true })
let status: number
try {
  status = buildEveryCertifiedArtifact()
} finally {
  // The rendered config lives at the package root only for the build; leaving
  // one behind would put a placeholder-id Wrangler config beside the real ones,
  // and a staged migration copy beside the source directory.
  fs.rmSync(CONFIG_FILE, { force: true })
  fs.rmSync(STAGED_MIGRATIONS, { recursive: true, force: true })
}
if (status !== 0) process.exit(status)
