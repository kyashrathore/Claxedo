import { describe, expect, test } from "vitest"
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
})
