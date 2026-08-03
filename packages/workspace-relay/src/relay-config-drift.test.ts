import { describe, expect, test } from "bun:test"
import { readFile } from "node:fs/promises"
import { DEFAULT_RELAY_LOCATION_HINT, RELAY_LOCATION_HINTS, relayLocationHint } from "./cloudflare"

/**
 * Guards the two relay settings whose absence is SILENT.
 *
 * Both `CLAXEDO_RELAY_TUNNEL_CHANNEL_CAP` and `CLAXEDO_RELAY_LOCATION_HINT` fall
 * back to a code default when the var is missing from an environment, and both
 * defaults are wrong for production: the channel cap falls back to 16 (below
 * what one real workspace opens — the 17th channel is rejected with a 503) and
 * the location hint pins every newly created Durable Object to one region for
 * the lifetime of that workspace. Neither fallback throws, logs, or shows up in
 * a deploy diff.
 *
 * That is exactly how production ran the default 16-channel cap while staging
 * carried an explicit 32768: `[vars]` is per-environment in wrangler and is NOT
 * inherited from the top level, so adding a key to one block leaves every other
 * block on the code default. This test asserts each block declares both keys
 * itself, and is the drift guard the cf-reliability review asked for (A6).
 */

type VarsBlock = { name: string; body: string }

function varsBlocks(config: string): VarsBlock[] {
  // A block runs from its own header to the next top-level header. Wrangler's
  // TOML has no nested tables inside `vars`, so this is sufficient and keeps the
  // test free of a TOML parser dependency.
  return [...config.matchAll(/^\[((?:env\.[\w-]+\.)?vars)\]\n([\s\S]*?)(?=^\[|\Z)/gm)]
    .map((match) => ({ name: match[1]!, body: match[2]! }))
}

function declaredValue(block: VarsBlock, key: string) {
  const match = block.body.match(new RegExp(`^${key}\\s*=\\s*"([^"]*)"`, "m"))
  return match?.[1]
}

/**
 * Fail with the name of the missing block rather than a TypeError on
 * `block.body`. The regression being guarded is literally "a whole `[vars]`
 * block was absent", so that is the case the message has to name.
 */
function requireBlock(blocks: VarsBlock[], name: string) {
  const block = blocks.find((candidate) => candidate.name === name)
  if (!block) throw new Error(`wrangler.toml is missing the [${name}] block`)
  return block
}

describe("relay wrangler config", () => {
  test("every environment declares the channel cap and the location hint explicitly", async () => {
    const config = await readFile(new URL("../wrangler.toml", import.meta.url), "utf8")
    const blocks = varsBlocks(config)

    // Production (top-level `[vars]`) plus staging. A new environment must add
    // its own block rather than inherit — that is the whole point of the guard.
    expect(blocks.map((block) => block.name).toSorted())
      .toEqual(["env.staging.vars", "vars"])

    for (const block of blocks) {
      const cap = declaredValue(block, "CLAXEDO_RELAY_TUNNEL_CHANNEL_CAP")
      expect(cap, `[${block.name}] must declare CLAXEDO_RELAY_TUNNEL_CHANNEL_CAP`).toBeDefined()
      expect(Number(cap), `[${block.name}] channel cap must be a positive integer`).toBeGreaterThan(0)

      const hint = declaredValue(block, "CLAXEDO_RELAY_LOCATION_HINT")
      expect(hint, `[${block.name}] must declare CLAXEDO_RELAY_LOCATION_HINT`).toBeDefined()
      expect(hint!.length, `[${block.name}] location hint must not be empty`).toBeGreaterThan(0)
    }
  })

  test("production runs a channel cap above the code default", async () => {
    const config = await readFile(new URL("../wrangler.toml", import.meta.url), "utf8")
    const production = requireBlock(varsBlocks(config), "vars")

    // The regression this pins: production silently running
    // TUNNEL_CHANNEL_CAP_DEFAULT (16) because the key lived only under staging.
    expect(Number(declaredValue(production, "CLAXEDO_RELAY_TUNNEL_CHANNEL_CAP"))).toBeGreaterThan(16)
  })

  test("the documented default hint matches what production declares", async () => {
    const config = await readFile(new URL("../wrangler.toml", import.meta.url), "utf8")
    const production = requireBlock(varsBlocks(config), "vars")

    // Not a requirement that they agree forever — it is a requirement that a
    // divergence is deliberate. When production moves off the code default,
    // change DEFAULT_RELAY_LOCATION_HINT with it or delete this assertion.
    expect(declaredValue(production, "CLAXEDO_RELAY_LOCATION_HINT")).toBe(DEFAULT_RELAY_LOCATION_HINT)
  })

  /**
   * `wrangler-h2.toml` is the H2 opener-sharding experiment variant. It pins the
   * same `compatibility_date` as production but sat outside every drift guard, so
   * the binaryType hazard could be reintroduced there silently while
   * wrangler.toml stayed correct. Bringing it under the guard is W6.1's second
   * half.
   */
  test("both relay configs pin the compatibility date below the binaryType flip", async () => {
    for (const name of ["wrangler.toml", "wrangler-h2.toml"]) {
      const config = await readFile(new URL(`../${name}`, import.meta.url), "utf8")
      const declared = config.match(/^compatibility_date = "([\d-]+)"$/m)?.[1]

      expect(declared, `${name} must declare compatibility_date`).toBeDefined()
      // 2026-03-17 is where server-side WebSockets default to binaryType "blob"
      // on the addEventListener path. The decoders handle Blob now
      // (relay-workerd-binary.test.ts proves it on real workerd), so this is no
      // longer a correctness cliff — it stays asserted so a bump is a deliberate
      // edit to a test rather than an unnoticed edit to a toml.
      expect(declared! < "2026-03-17", `${name} is at ${declared}, past the binaryType flip`).toBe(true)
    }
  })

  test("the H2 experiment config keeps its own vars block", async () => {
    // Same "vars are NOT inherited" trap as production: the H2 variant declares
    // OPENER_COUNT and would otherwise fall back to a code default silently.
    const config = await readFile(new URL("../wrangler-h2.toml", import.meta.url), "utf8")
    const block = requireBlock(varsBlocks(config), "vars")

    expect(Number(declaredValue(block, "OPENER_COUNT"))).toBeGreaterThan(0)
  })
})

/**
 * Ties the relay's region→location-hint table to the product's canonical region
 * vocabulary.
 *
 * `DEFAULT_CLAXEDO_REGIONS` (claxedo-server/src/platform/runtime/region/index.ts) is the list a
 * workspace's `homeRegion` is validated against, mirrored as `KNOWN_HOME_REGIONS`
 * in convex/workspaces.ts and in the sqlite workspace authority. If someone adds
 * a sixth region there and not here, workspaces in that region silently get the
 * deployment-wide default hint — permanently, since a Durable Object's location
 * is fixed at first creation. Parsed from source rather than imported: the relay
 * package deliberately does not depend on claxedo-server.
 */
describe("relay region mapping", () => {
  test("every canonical Claxedo region maps to a Cloudflare location hint", async () => {
    const regionSource = await readFile(
      new URL("../../claxedo-server/src/platform/runtime/region/index.ts", import.meta.url),
      "utf8",
    )
    const declared = regionSource.match(/export const DEFAULT_CLAXEDO_REGIONS = \[([^\]]*)\]/)?.[1]
    expect(declared, "could not find DEFAULT_CLAXEDO_REGIONS in claxedo-server").toBeDefined()

    const regions = [...declared!.matchAll(/"([^"]+)"/g)].map((match) => match[1]!)
    expect(regions.length).toBeGreaterThanOrEqual(5)

    for (const region of regions) {
      const hint = relayLocationHint({ region })
      expect(
        RELAY_LOCATION_HINTS.includes(hint as (typeof RELAY_LOCATION_HINTS)[number]),
        `region "${region}" produced "${hint}"`,
      ).toBe(true)
      // The real assertion: it must not silently land on the default. A region
      // that fell through the table would return the configured fallback.
      expect(hint, `region "${region}" is missing from RELAY_REGION_TO_LOCATION_HINT`)
        .not.toBe("__unmapped__")
      const fallbackProbe = relayLocationHint({ region, configured: "__unmapped__" })
      expect(fallbackProbe, `region "${region}" is not in the relay's mapping table`)
        .not.toBe("__unmapped__")
    }
  })
})
