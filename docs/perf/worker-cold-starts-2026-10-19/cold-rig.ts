// A built certified Worker bundle under local workerd: the isolate's ready time, then the
// first requests an app boot sends, each with its wall time and Server-Timing marks.
//
//   bun run --cwd packages/claxedo-server build:workerd-boundary
//   cd packages/claxedo-server && node --import tsx ../../docs/perf/worker-cold-starts-2026-10-19/cold-rig.ts \
//     dist-boundary/workerd/user-deployed-better-auth-d1/better-auth-d1-worker.cf.js [rounds]
//
// Node, not Bun: Miniflare's control channel to workerd hangs on Bun once several isolates
// have been created and disposed in one process (scripts/boundary/smoke-workerd.ts).
import fs from "node:fs"
import path from "node:path"
import { performance } from "node:perf_hooks"

const SERVER = path.resolve(import.meta.dirname, "../../../packages/claxedo-server")
const { Miniflare } = await import(path.join(SERVER, "node_modules/miniflare/dist/src/index.js"))
const { applyControlPlaneBaseline } = await import(path.join(SERVER, "src/test-support/control-plane-migrations.ts"))
const { hostedWorkerCompatibility } = await import(path.join(SERVER, "src/test-support/hosted-worker-bundle.ts"))

const AUTH_MIGRATIONS = path.join(SERVER, "migrations/auth/")
const API = "https://api.example.test"
const APP = "https://app.example.test"
const [bundleArg, roundsArg = "3"] = process.argv.slice(2)
if (!bundleArg) throw new Error("usage: cold-rig.ts <bundle.js> [rounds]")
const bundle = path.resolve(bundleArg)
const rounds = Number(roundsArg)
const fullHosted = bundle.includes("full-hosted")
const agentPlugins = bundle.includes("agent-plugins")

const vars: Record<string, unknown> = {
  CF_VERSION_METADATA: { id: "11111111-1111-1111-1111-111111111111", tag: "claxedo-0123abcd" },
  CLAXEDO_ADAPTER_PROFILE: "better-auth-d1",
  CLAXEDO_PRODUCT_POSTURE: "user-deployed",
  CLAXEDO_SANDBOX_POSTURE: fullHosted ? "full-hosted" : "control-plane-only",
  CLAXEDO_DEPLOYMENT_ID: "deployment-1",
  CLAXEDO_DEPLOYMENT_MODE: "hosted",
  CLAXEDO_AUTH_METHODS: "github",
  CLAXEDO_AUTH_CONFIGURATION_ID: "sha256:auth-configuration",
  BETTER_AUTH_URL: API,
  CLAXEDO_APP_ORIGIN: APP,
  BETTER_AUTH_SECRET: "better-auth-secret-that-is-at-least-thirty-two-bytes",
  CLAXEDO_AUTH_INTROSPECTION_SECRET: "introspection-secret-that-is-also-at-least-thirty-two-bytes",
  GITHUB_CLIENT_ID: "github-client",
  GITHUB_CLIENT_SECRET: "github-secret",
  CLAXEDO_WORKSPACE_RELAY_URL: "https://relay.example.test",
  CLAXEDO_RELAY_RESOLVER_TOKEN: "relay-resolver-secret",
  CLAXEDO_RUNTIME_ACCESS_TOKEN_PRIVATE_KEY_PEM: [
    "-----BEGIN PRIVATE KEY-----",
    "MC4CAQAwBQYDK2VwBCIEIO9Cnka2wu8+h1a1Rd+bDejAsq2oUxO6BnDKjrHrpw54",
    "-----END PRIVATE KEY-----",
  ].join("\n"),
  CLAXEDO_RUNTIME_ACCESS_TOKEN_PUBLIC_KEY_PEM: [
    "-----BEGIN PUBLIC KEY-----",
    "MCowBQYDK2VwAyEAvy35aYUPAjG/Zac6ER0AiB0BZteRmYnpMZ5b1U0SJGs=",
    "-----END PUBLIC KEY-----",
  ].join("\n"),
  CLAXEDO_USER_DEPLOYED_ORGANIZATION_ID: "org_deployment",
  CLAXEDO_USER_DEPLOYED_ORGANIZATION_NAME: "My deployment",
  ...(fullHosted ? { CLAXEDO_SANDBOX_IMAGE: "ghcr.io/claxedo/runtime:test" } : {}),
}

function marks(response: Response) {
  return (response.headers.get("server-timing") ?? "").split(", ").filter((entry) => !entry.includes(";")).join("+") || "-"
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

async function round(n: number) {
  const t0 = performance.now()
  const mf = new Miniflare({
    ...hostedWorkerCompatibility(),
    modules: [{ type: "ESModule", path: "worker.js", contents: fs.readFileSync(bundle, "utf8") }],
    d1Databases: ["AUTH_DB", "CONTROL_PLANE_DB"],
    r2Buckets: ["CLAXEDO_DOCUMENTS", "CLAXEDO_AGENT_PLUGINS"],
    ratelimits: { CLAXEDO_REQUEST_LIMITER: { namespace_id: "1001", simple: { limit: 600, period: 60 } } },
    durableObjects: {
      LIVE_SYNC_ROOM: { className: "LiveSyncRoom", useSQLite: true },
      ...(agentPlugins ? { PLUGIN_SUPERVISOR: { className: "PluginSupervisor", useSQLite: true } } : {}),
      ...(fullHosted ? { SANDBOX_PROVISIONER: { className: "SandboxProvisioner", useSQLite: true } } : {}),
    },
    ...(agentPlugins ? { workerLoaders: { PLUGIN_LOADER: {} } } : {}),
    bindings: vars,
  })
  await mf.ready
  const tReady = performance.now()
  const auth = await mf.getD1Database("AUTH_DB")
  for (const name of fs.readdirSync(AUTH_MIGRATIONS).filter((file) => file.endsWith(".sql")).sort()) {
    const migration = fs.readFileSync(`${AUTH_MIGRATIONS}${name}`, "utf8").replace(/^\s*--.*$/gm, "")
    for (const statement of migration.split(/;\s*\n\s*\n/).map((part) => part.trim()).filter(Boolean)) {
      await auth.prepare(statement).run()
    }
  }
  await applyControlPlaneBaseline((await mf.getD1Database("CONTROL_PLANE_DB")) as never)
  const rows: string[] = []
  const hit = async (label: string, route: string, headers: Record<string, string> = { origin: APP }) => {
    const t = performance.now()
    const response = await mf.dispatchFetch(`${API}${route}`, { headers })
    await response.text()
    const ms = performance.now() - t
    rows.push(`${label.padEnd(14)} ${route.padEnd(30)} ${String(response.status).padEnd(4)} ${ms.toFixed(0).padStart(5)} ms  ${marks(response)}`)
  }
  await hit("health-1", "/health", {})
  await hit("health-2", "/health", {})
  for (let i = 1; i <= 4; i++) {
    await hit(`descriptor-${i}`, "/api/claxedo/auth/descriptor")
    await sleep(300)
  }
  for (let i = 1; i <= 3; i++) {
    await hit(`get-session-${i}`, "/api/auth/get-session")
    await sleep(300)
  }
  for (let i = 1; i <= 2; i++) {
    await hit(`bootstrap-${i}`, "/api/claxedo/bootstrap")
    await sleep(300)
  }
  console.log(`round ${n}: workerd ready ${(tReady - t0).toFixed(0)} ms`)
  for (const row of rows) console.log(`  ${row}`)
  await mf.dispose()
}

for (let n = 1; n <= rounds; n++) await round(n)
