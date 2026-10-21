// The edge Worker and the writer under local workerd, from one built bundle: what the forward
// costs a write (the edge's `forward` wait less the writer's own `total`), what a bookmarked
// read costs at the edge, and how many times each request was authenticated. One machine and
// one local D1, so it measures the forward's own overhead, never a network hop or a replica.
//
//   bun run --cwd packages/claxedo-server build:workerd-boundary
//   cd packages/claxedo-server && node --import tsx ../../docs/perf/edge-replicas-2026-10-20/split-rig.ts \
//     dist-boundary/workerd/user-deployed-better-auth-d1/better-auth-d1-worker.cf.js [samples]
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
const API = "https://app.example.test"
const BOOKMARK = "00000000-00000001-00000000-00000000000000000000000000000000"
const [bundleArg, samplesArg = "40"] = process.argv.slice(2)
if (!bundleArg) throw new Error("usage: split-rig.ts <bundle.js> [samples]")
const samples = Number(samplesArg)

const vars: Record<string, unknown> = {
  CF_VERSION_METADATA: { id: "11111111-1111-1111-1111-111111111111", tag: "claxedo-0123abcd" },
  CLAXEDO_ADAPTER_PROFILE: "better-auth-d1",
  CLAXEDO_PRODUCT_POSTURE: "user-deployed",
  CLAXEDO_SANDBOX_POSTURE: "control-plane-only",
  CLAXEDO_DEPLOYMENT_ID: "deployment-1",
  CLAXEDO_DEPLOYMENT_MODE: "hosted",
  CLAXEDO_AUTH_METHODS: "github",
  CLAXEDO_AUTH_CONFIGURATION_ID: "sha256:auth-configuration",
  BETTER_AUTH_URL: API,
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
}

const shared = {
  ...hostedWorkerCompatibility(),
  modules: [{ type: "ESModule", path: "worker.js", contents: fs.readFileSync(path.resolve(bundleArg), "utf8") }],
  d1Databases: { AUTH_DB: "auth", CONTROL_PLANE_DB: "control-plane" },
  r2Buckets: ["CLAXEDO_DOCUMENTS"],
  ratelimits: { CLAXEDO_REQUEST_LIMITER: { namespace_id: "1001", simple: { limit: 100_000, period: 60 } } },
  bindings: vars,
}
const split = { ...shared, bindings: { ...vars, CLAXEDO_D1_EDGE_READS: "on" } }
const mf = new Miniflare({
  workers: [
    {
      ...split,
      name: "edge",
      serviceBindings: { CONTROL_PLANE_WRITER: "writer" },
      durableObjects: { LIVE_SYNC_ROOM: { className: "LiveSyncRoom", scriptName: "writer" } },
    },
    { ...split, name: "writer", durableObjects: { LIVE_SYNC_ROOM: { className: "LiveSyncRoom", useSQLite: true } } },
  ],
})
const alone = new Miniflare({ ...shared, durableObjects: { LIVE_SYNC_ROOM: { className: "LiveSyncRoom", useSQLite: true } } })
for (const instance of [mf, alone]) {
  await instance.ready
  const auth = await instance.getD1Database("AUTH_DB")
  for (const name of fs.readdirSync(AUTH_MIGRATIONS).filter((file) => file.endsWith(".sql")).sort()) {
    const migration = fs.readFileSync(`${AUTH_MIGRATIONS}${name}`, "utf8").replace(/^\s*--.*$/gm, "")
    for (const statement of migration.split(/;\s*\n\s*\n/).map((part) => part.trim()).filter(Boolean)) await auth.prepare(statement).run()
  }
  await applyControlPlaneBaseline(await instance.getD1Database("CONTROL_PLANE_DB"))
}

type Sample = { ms: number; timing: string; status: number }

async function measure(send: () => Promise<Response>): Promise<Sample> {
  const started = performance.now()
  const response = await send()
  await response.text()
  return { ms: performance.now() - started, timing: response.headers.get("server-timing") ?? "", status: response.status }
}

const duration = (timing: string, name: string) => Number(new RegExp(`(?:^|, )${name};dur=([\\d.]+)`).exec(timing)?.[1] ?? Number.NaN)
const median = (values: number[]) => values.toSorted((left, right) => left - right)[Math.floor(values.length / 2)] ?? Number.NaN

const read = { headers: { origin: API, cookie: `__Host-claxedo.d1-control=${BOOKMARK}` } }
let client = 0
const write = () => ({
  method: "POST",
  headers: { origin: API, "content-type": "application/json", "cf-connecting-ip": `10.0.${Math.floor(++client / 250)}.${client % 250}` },
  body: JSON.stringify({ provider: "github", callbackURL: "/" }),
})
const cases: Array<[string, () => Promise<Response>]> = [
  ["bookmarked read at the edge (GET /p/:token)", () => mf.dispatchFetch(`${API}/p/missing-token`, read)],
  ["write through the edge (POST sign-in/social)", () => mf.dispatchFetch(`${API}/api/auth/sign-in/social`, write())],
  ["the same write on one Worker, edge reads off", () => alone.dispatchFetch(`${API}/api/auth/sign-in/social`, write())],
]
for (const [, send] of cases) for (let warm = 0; warm < 5; warm++) await measure(send)
const results = new Map<string, Sample[]>(cases.map(([label]) => [label, []]))
for (let round = 0; round < samples; round++) {
  for (const [label, send] of cases) results.get(label)?.push(await measure(send))
}
for (const [label, measured] of results) {
  const statuses = [...new Set(measured.map((sample) => sample.status))].join("/")
  const forward = median(measured.map((sample) => duration(sample.timing, "forward") - duration(sample.timing, "total")))
  console.log([
    label.padEnd(46),
    `status ${statuses}`,
    `wall p50 ${median(measured.map((sample) => sample.ms)).toFixed(2)} ms`,
    `server total p50 ${median(measured.map((sample) => duration(sample.timing, "total"))).toFixed(2)} ms`,
    ...(Number.isNaN(forward) ? [] : [`forward minus writer total p50 ${forward.toFixed(2)} ms`]),
    `auth entries ${measured[0]?.timing.match(/\bauth;dur=/g)?.length ?? 0}`,
  ].join("  "))
}
await mf.dispose()
await alone.dispose()
