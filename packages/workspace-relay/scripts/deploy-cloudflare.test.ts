import { describe, expect, test } from "bun:test"
import { readFile } from "node:fs/promises"

import { relayWorkerDeployCommand, verifyRelayHealth } from "./deploy-cloudflare"

const STAGING = {
  workerName: "claxedo-workspace-relay-acc-stg-260830-3851",
  centralUrl: "https://cf-acc-stg-260830-232009-3851.claxedo.dev",
  appOrigins: "https://app-acc-stg-260830-232009-3851.claxedo.dev",
} as const

describe("relay Worker deploy command", () => {
  test("deploys the staging environment under the deployment's own Worker name", () => {
    expect(relayWorkerDeployCommand(STAGING)).toEqual([
      "deploy",
      "--config",
      "wrangler.toml",
      "--env",
      "staging",
      "--name",
      "claxedo-workspace-relay-acc-stg-260830-3851",
      "--var",
      "CLAXEDO_CENTRAL_URL:https://cf-acc-stg-260830-232009-3851.claxedo.dev",
      "--var",
      "CLAXEDO_APP_ORIGINS:https://app-acc-stg-260830-232009-3851.claxedo.dev",
    ])
  })

  /**
   * The Worker running on staging carries both, `wrangler.toml` declares
   * neither, and `wrangler deploy` replaces the var set with what it is given —
   * so a command missing either silently removes it from the live Worker.
   */
  test("carries the two vars wrangler.toml cannot declare", async () => {
    const config = await readFile(new URL("../wrangler.toml", import.meta.url), "utf8")
    const declared = config
      .split(/\r?\n/)
      .filter((line) => !line.trimStart().startsWith("#"))
      .join("\n")
    const command = relayWorkerDeployCommand(STAGING).join(" ")

    for (const name of ["CLAXEDO_CENTRAL_URL", "CLAXEDO_APP_ORIGINS"]) {
      expect(declared).not.toMatch(new RegExp(`^${name}\\s*=`, "m"))
      expect(command).toContain(`--var ${name}:`)
    }
  })

  test("adds the outdir --dry-run needs and nothing else", () => {
    expect(relayWorkerDeployCommand({ ...STAGING, dryRun: true }).slice(-3)).toEqual([
      "--dry-run",
      "--outdir",
      "dist-worker",
    ])
  })

  test("refuses a Worker name Cloudflare would reject", () => {
    expect(() => relayWorkerDeployCommand({ ...STAGING, workerName: "Relay_Staging" })).toThrow(/Worker identifier/)
  })

  test("refuses a blank deployment var rather than dropping it from the Worker", () => {
    expect(() => relayWorkerDeployCommand({ ...STAGING, centralUrl: "  " })).toThrow(/CLAXEDO_CENTRAL_URL/)
    expect(() => relayWorkerDeployCommand({ ...STAGING, appOrigins: "" })).toThrow(/CLAXEDO_APP_ORIGINS/)
  })
})

describe("relay health verification", () => {
  const healthy = { ok: true, service: "workspace-relay", mode: "cloudflare-durable-object" }
  const body = (value: unknown) => Promise.resolve(new Response(JSON.stringify(value), { status: 200 }))

  test("accepts the Durable Object relay", async () => {
    expect(
      await verifyRelayHealth({ relayUrl: "https://relay.test", fetcher: () => body(healthy), wait: () => Promise.resolve() }),
    ).toMatchObject({ mode: "cloudflare-durable-object" })
  })

  test("probes /health on the relay URL without doubling a trailing slash", async () => {
    const seen: string[] = []

    await verifyRelayHealth({
      relayUrl: "https://relay.test/",
      fetcher: (url) => {
        seen.push(url)
        return body(healthy)
      },
      wait: () => Promise.resolve(),
    })

    expect(seen).toEqual(["https://relay.test/health"])
  })

  test("refuses a relay answering as the node process rather than the Durable Object", async () => {
    await expect(
      verifyRelayHealth({
        relayUrl: "https://relay.test",
        attempts: 2,
        fetcher: () => body({ ok: true, service: "workspace-relay", mode: "node" }),
        wait: () => Promise.resolve(),
      }),
    ).rejects.toThrow(/reported/)
  })

  test("retries while the new version is still propagating", async () => {
    let call = 0

    const health = await verifyRelayHealth({
      relayUrl: "https://relay.test",
      fetcher: () => {
        call += 1
        return call === 1 ? Promise.reject(new Error("fetch failed")) : body(healthy)
      },
      wait: () => Promise.resolve(),
    })

    expect(health.ok).toBe(true)
  })
})
