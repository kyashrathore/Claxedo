/**
 * Boot every built certified Worker entry in workerd and prove it fails closed.
 *
 * Run under Node (`node --import tsx`), not Bun: Miniflare's control channel to
 * the workerd child hangs on Bun once several isolates have been created and
 * disposed in one process, which stalls the gate instead of failing it.
 */
import fs from "node:fs"

import { Miniflare } from "miniflare"

import { WORKERD_BOUNDARY_TARGETS, type WorkerdBoundaryTarget } from "./certified-workerd-boundary"

/**
 * Read the compatibility contract out of the config Wrangler bundled with.
 *
 * Booting the emitted module under a different date or flag set would prove
 * nothing about the artifact a release publishes.
 */
function compatibility(target: WorkerdBoundaryTarget) {
  if (!fs.existsSync(target.configFile)) {
    throw new Error(`built Workerd config is missing — run build:workerd-boundary first: ${target.configFile}`)
  }
  const config = fs.readFileSync(target.configFile, "utf8")
  const date = /^compatibility_date = "([^"]+)"$/m.exec(config)?.[1]
  const flags = /^compatibility_flags = \[([^\]]*)\]$/m.exec(config)?.[1]
  if (!date || flags === undefined) throw new Error(`built Workerd config declares no compatibility contract: ${target.configFile}`)
  return {
    compatibilityDate: date,
    compatibilityFlags: [...flags.matchAll(/"([^"]+)"/g)].map((match) => match[1]!),
  }
}

/**
 * Boot one built certified entry with no bindings and no vars.
 *
 * An unconfigured deployment must refuse the public health probe with its
 * documented fail-closed answer. Loading the emitted module also proves the
 * entry has no top-level work that a Workers isolate cannot run.
 */
async function assertFailsClosed(target: WorkerdBoundaryTarget) {
  if (!fs.existsSync(target.bundleFile)) {
    throw new Error(`built Workerd entry is missing — run build:workerd-boundary first: ${target.bundleFile}`)
  }
  const miniflare = new Miniflare({
    ...compatibility(target),
    modules: [{ type: "ESModule", path: "worker.js", contents: fs.readFileSync(target.bundleFile, "utf8") }],
  })
  try {
    const response = await miniflare.dispatchFetch("http://boundary.test/api/claxedo/health")
    const body = await response.text()
    if (response.status !== target.failClosed.status) {
      throw new Error(
        `unconfigured ${target.artifactId} must fail closed with ${target.failClosed.status}; got ${response.status}: ${body}`,
      )
    }
    const code = (JSON.parse(body) as { error?: { code?: unknown } }).error?.code
    if (code !== target.failClosed.code) {
      throw new Error(
        `unconfigured ${target.artifactId} must fail closed with ${target.failClosed.code}; got ${JSON.stringify(code)}`,
      )
    }
    console.log(`[server-workerd] ${target.artifactId}: built entry loaded and failed closed (${code})`)
  } finally {
    await miniflare.dispose()
  }
}

for (const target of WORKERD_BOUNDARY_TARGETS) await assertFailsClosed(target)
