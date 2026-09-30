import { spawnSync } from "node:child_process"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { HOSTED_WORKER_BUNDLE_CONTRACT } from "../../scripts/deploy/hosted-worker-bundle"

const SERVER_ROOT = fileURLToPath(new URL("../../", import.meta.url))

/**
 * `entry` as Wrangler bundles a hosted Worker: its esbuild settings and its
 * Node compatibility layer decide what a CommonJS dependency sees at import,
 * and a hand-rolled esbuild call would decide differently.
 */
export function wranglerBundle(entry: string): string {
  const workdir = fs.mkdtempSync(path.join(os.tmpdir(), "claxedo-worker-bundle-"))
  try {
    const config = path.join(workdir, "wrangler.toml")
    fs.writeFileSync(config, `name = "claxedo-test-worker"\nmain = ${JSON.stringify(entry)}\n${HOSTED_WORKER_BUNDLE_CONTRACT}\n`)
    const env: NodeJS.ProcessEnv = { ...process.env, WRANGLER_SEND_METRICS: "false" }
    for (const name of ["CF_API_TOKEN", "CLOUDFLARE_ACCOUNT_ID", "CLOUDFLARE_API_KEY", "CLOUDFLARE_API_TOKEN", "CLOUDFLARE_EMAIL"]) {
      delete env[name]
    }
    const outdir = path.join(workdir, "out")
    const result = spawnSync(
      path.join(SERVER_ROOT, "node_modules/.bin/wrangler"),
      ["deploy", "--config", config, "--dry-run", "--outdir", outdir],
      { cwd: SERVER_ROOT, env, encoding: "utf8" },
    )
    if (result.status !== 0) throw new Error(`wrangler could not bundle ${entry}:\n${result.stdout}\n${result.stderr}`)
    return fs.readFileSync(path.join(outdir, `${path.basename(entry).replace(/\.ts$/, "")}.js`), "utf8")
  } finally {
    fs.rmSync(workdir, { recursive: true, force: true })
  }
}

/** The compatibility date and flags every hosted Worker is built and booted under, as Miniflare options. */
export function hostedWorkerCompatibility() {
  const date = /^compatibility_date = "([^"]+)"$/m.exec(HOSTED_WORKER_BUNDLE_CONTRACT)?.[1]
  const flags = /^compatibility_flags = \[([^\]]*)\]$/m.exec(HOSTED_WORKER_BUNDLE_CONTRACT)?.[1]
  if (!date || flags === undefined) throw new Error("the hosted Worker bundle contract declares no compatibility")
  return { compatibilityDate: date, compatibilityFlags: [...flags.matchAll(/"([^"]+)"/g)].map((match) => match[1]) }
}
