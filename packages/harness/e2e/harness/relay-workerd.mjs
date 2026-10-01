import { spawnSync } from "node:child_process"
import { readFileSync } from "node:fs"
import { createRequire } from "node:module"
import path from "node:path"

const relayRoot = path.resolve(import.meta.dirname, "../../../workspace-relay")
const require = createRequire(path.join(relayRoot, "package.json"))
const { Miniflare } = require("miniflare")
const { unstable_getMiniflareWorkerOptions } = require("wrangler")
const raw = process.env.CLAXEDO_E2E_RELAY_WORKER
if (!raw) throw new Error("Missing e2e relay Worker configuration")
const input = JSON.parse(raw)
if (!input.root || !Number.isSafeInteger(input.port) || input.port <= 0 || !input.bindings) {
  throw new Error("Invalid e2e relay Worker configuration")
}
const config = path.join(relayRoot, "wrangler.toml")
const bundleDir = path.join(input.root, "bundle")
const build = spawnSync(process.execPath, [
  path.join(path.dirname(require.resolve("wrangler/package.json")), "bin/wrangler.js"),
  "deploy", "--config", config, "--dry-run", "--outdir", bundleDir,
], { cwd: relayRoot, env: process.env, encoding: "utf8" })
if (build.error) throw build.error
if (build.status !== 0) throw new Error(`Relay Worker bundling failed: ${build.stdout}\n${build.stderr}`)
const converted = unstable_getMiniflareWorkerOptions(config)
if (!converted.main) throw new Error("The relay config declares no Worker entry")
const bundle = path.join(bundleDir, path.basename(converted.main).replace(/\.ts$/, ".js"))
const mf = new Miniflare({
  ...converted.workerOptions,
  bindings: { ...converted.workerOptions.bindings, ...input.bindings },
  modules: [{ type: "ESModule", path: "worker.js", contents: readFileSync(bundle, "utf8") }],
  host: "127.0.0.1",
  port: input.port,
  durableObjectsPersist: path.join(input.root, "durable-objects"),
  outboundService: {
    network: {
      allow: ["127.0.0.1/32"],
      ...(input.certificate ? { tlsOptions: { trustedCertificates: [readFileSync(input.certificate, "utf8")] } } : {}),
    },
  },
})
const stop = () => { void mf.dispose().then(() => process.exit(0)) }
process.once("SIGTERM", stop)
process.once("SIGINT", stop)
try {
  await mf.ready
  console.log("[relay-workerd] ready")
} catch (error) {
  await mf.dispose()
  throw error
}
