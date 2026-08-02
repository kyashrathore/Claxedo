import { afterEach, describe, expect, test, vi } from "vitest"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import {
  publishRuntimePackages,
  rewriteRuntimePackageJson,
  runtimePackages,
  workspaceDependencies,
} from "../publish-runtime-packages"

describe("publish-runtime-packages", () => {
  afterEach(() => {
    vi.useRealTimers()
  })

  test("publishes runtime packages in dependency order", () => {
    expect(runtimePackages.map((item) => item.name)).toEqual([
      "@claxedo/workspace-relay-protocol",
      "@claxedo/workspace-relay",
      "@claxedo/agent-event-runtime",
      "@claxedo/agent-sdk-runtime",
      "@claxedo/agent-extensions",
      "@claxedo/workspace-runtime",
    ])
  })

  test("pins internal runtime dependencies to the release version", () => {
    expect(rewriteRuntimePackageJson({
      name: "@claxedo/workspace-runtime",
      version: "0.5.0",
      dependencies: {
        "@claxedo/workspace-relay": "workspace:0.1.0",
        hono: "4.12.12",
      },
      optionalDependencies: {
        "@claxedo/agent-sdk-runtime": "workspace:0.1.0",
      },
    }, "0.5.1")).toMatchObject({
      version: "0.5.1",
      dependencies: {
        "@claxedo/workspace-relay": "0.5.1",
        hono: "4.12.12",
      },
      optionalDependencies: {
        "@claxedo/agent-sdk-runtime": "0.5.1",
      },
    })
  })

  test("detects workspace dependencies that would leak into npm artifacts", () => {
    expect(workspaceDependencies({
      dependencies: {
        "@claxedo/workspace-relay": "workspace:0.1.0",
      },
      devDependencies: {
        typescript: "5.8.2",
      },
    })).toEqual(["dependencies.@claxedo/workspace-relay=workspace:0.1.0"])
  })

  test("skips exact versions that are already published", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "claxedo-runtime-release-"))
    for (const item of runtimePackages) {
      const dir = path.join(root, item.dir)
      fs.mkdirSync(dir, { recursive: true })
      fs.writeFileSync(path.join(dir, "package.json"), JSON.stringify({
        name: item.name,
        version: "0.0.0",
        scripts: { build: "echo build" },
      }, null, 2))
    }

    const calls: string[][] = []
    const published = new Set(["@claxedo/workspace-relay-protocol@0.5.1"])
    const result = await publishRuntimePackages({
      root,
      version: "0.5.1",
      run: (cmd, args) => {
        calls.push([cmd, ...args])
        const spec = args[1]
        if (cmd === "npm" && args[0] === "view" && published.has(spec)) return "0.5.1"
        if (cmd === "npm" && args[0] === "publish") {
          published.add(`${args[2]}@0.5.1`)
          return ""
        }
        if (cmd === "npm" && args[0] === "view") throw new Error("not published")
        return ""
      },
    })

    expect(result).toEqual(runtimePackages.map((item) => `${item.name}@0.5.1`))
    expect(calls).not.toContainEqual([
      "npm",
      "publish",
      "--workspace",
      "@claxedo/workspace-relay-protocol",
      "--access",
      "public",
      "--provenance",
      "--tag",
      "latest",
    ])
    expect(calls.filter((call) => call[0] === "npm" && call[1] === "publish")).toHaveLength(5)
    expect(calls.filter((call) => call[0] === "npm" && call[1] === "run" && call[2] === "build")).toHaveLength(6)
    expect(published).toEqual(new Set(runtimePackages.map((item) => `${item.name}@0.5.1`)))
  })

  test("waits out npm read propagation instead of failing a publish that landed", async () => {
    // The 0.7.0 release published all six packages and then reported red: the
    // verification read ran against a CDN edge that had not caught up yet. A
    // publish is not a failure because the next read was early.
    const { root, run, published } = releaseFixture({ visibleAfterReads: 3 })
    const waits: number[] = []

    const result = await publishRuntimePackages({
      root,
      version: "0.5.1",
      run,
      wait: async (ms) => void waits.push(ms),
    })

    expect(result).toEqual(runtimePackages.map((item) => `${item.name}@0.5.1`))
    expect(published).toEqual(new Set(runtimePackages.map((item) => `${item.name}@0.5.1`)))
    // Two re-reads per package after the initial miss, all six packages.
    expect(waits).toHaveLength(12)
  })

  test("still fails when a publish never becomes visible", async () => {
    const { root, run } = releaseFixture({ visibleAfterReads: Number.POSITIVE_INFINITY })
    let elapsed = 0
    vi.useFakeTimers({ shouldAdvanceTime: false })

    await expect(
      publishRuntimePackages({
        root,
        version: "0.5.1",
        run,
        // Advancing the clock is what ends the poll; a wait that never advanced
        // it would hang here rather than fail, which is the bug in the other
        // direction.
        wait: async (ms) => {
          elapsed += ms
          vi.setSystemTime(Date.now() + ms)
        },
      }),
    ).rejects.toThrow(/npm did not expose @claxedo\/workspace-relay-protocol@0\.5\.1 within 120s of publish/)
    expect(elapsed).toBeGreaterThanOrEqual(120_000)
  })
})

/**
 * A throwaway workspace plus an `npm` double whose `view` reports a package as
 * absent for its first `visibleAfterReads - 1` reads after publish, standing in
 * for the registry's eventually-consistent read path.
 */
function releaseFixture(input: { visibleAfterReads: number }) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "claxedo-runtime-release-"))
  for (const item of runtimePackages) {
    const dir = path.join(root, item.dir)
    fs.mkdirSync(dir, { recursive: true })
    fs.writeFileSync(
      path.join(dir, "package.json"),
      JSON.stringify({ name: item.name, version: "0.0.0", scripts: { build: "echo build" } }, null, 2),
    )
  }
  const published = new Set<string>()
  const readsAfterPublish = new Map<string, number>()
  const run = (cmd: string, args: string[]) => {
    if (cmd === "npm" && args[0] === "publish") {
      published.add(`${args[2]}@0.5.1`)
      return ""
    }
    if (cmd === "npm" && args[0] === "view") {
      const spec = args[1]
      if (!published.has(spec)) throw new Error("not published")
      const reads = (readsAfterPublish.get(spec) ?? 0) + 1
      readsAfterPublish.set(spec, reads)
      if (reads < input.visibleAfterReads) throw new Error("not published")
      return "0.5.1"
    }
    return ""
  }
  return { root, run, published }
}
