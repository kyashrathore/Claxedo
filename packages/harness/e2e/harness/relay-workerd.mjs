import { spawnSync } from "node:child_process"
import { readFileSync } from "node:fs"
import { createRequire } from "node:module"
import path from "node:path"

const relayRoot = path.resolve(import.meta.dirname, "../../../workspace-relay")
const require = createRequire(path.join(relayRoot, "package.json"))
const { Miniflare } = require("miniflare")
const { unstable_getMiniflareWorkerOptions } = require("wrangler")
const input = JSON.parse(process.env.CLAXEDO_E2E_RELAY_WORKER)

function bundled(config, outdir) {
  const build = spawnSync(process.execPath, [
    path.join(path.dirname(require.resolve("wrangler/package.json")), "bin/wrangler.js"),
    "deploy", "--config", config, "--dry-run", "--outdir", outdir,
  ], { cwd: path.dirname(config), env: process.env, encoding: "utf8" })
  if (build.error) throw build.error
  if (build.status !== 0) throw new Error(`Bundling ${config} failed: ${build.stdout}\n${build.stderr}`)
  const converted = unstable_getMiniflareWorkerOptions(config)
  const bundle = path.join(outdir, path.basename(converted.main).replace(/\.ts$/, ".js"))
  return { workerOptions: converted.workerOptions, modules: [{ type: "ESModule", path: "worker.js", contents: readFileSync(bundle, "utf8") }] }
}

const loopback = (url) => url.hostname === "127.0.0.1" || url.hostname === "[::1]" || url.hostname === "localhost"

async function sessionHostOutbound(request) {
  const url = new URL(request.url)
  const target = loopback(url) ? url : new URL(`${url.pathname}${url.search}`, input.sessionHost.modelUrl)
  return fetch(target, { method: request.method, headers: request.headers, body: request.body, duplex: "half" })
}

async function controlPlane(request) {
  const url = new URL(request.url)
  return fetch(new URL(`${url.pathname}${url.search}`, input.sessionHost.controlPlaneUrl),
    { method: request.method, headers: request.headers, body: request.body, duplex: "half" })
}

const relay = bundled(path.join(relayRoot, "wrangler.toml"), path.join(input.root, "bundle"))
const sessionHost = bundled(input.sessionHost.config, path.join(input.root, "session-host-bundle"))
const mf = new Miniflare({
  host: "127.0.0.1",
  port: input.port,
  durableObjectsPersist: path.join(input.root, "durable-objects"),
  workers: [
    {
      ...relay.workerOptions,
      name: "relay",
      bindings: { ...relay.workerOptions.bindings, ...input.bindings },
      modules: relay.modules,
      outboundService: {
        network: {
          allow: ["127.0.0.1/32", "::1/128"],
          tlsOptions: { trustedCertificates: [readFileSync(input.certificate, "utf8")] },
        },
      },
    },
    {
      ...sessionHost.workerOptions,
      name: "claxedo-session-host",
      modules: sessionHost.modules,
      serviceBindings: { ...sessionHost.workerOptions.serviceBindings, CONTROL_PLANE: controlPlane },
      outboundService: sessionHostOutbound,
    },
  ],
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
