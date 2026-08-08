import fs from "node:fs"
import path from "node:path"
import { describe, expect, it } from "vitest"

describe("Claxedo server WorkGraph reachability", () => {
  it("mounts only the embedded v2 service from production startup", () => {
    const server = fs.readFileSync(path.join(import.meta.dirname, "../../../deployments/self-hosted-node/app.ts"), "utf8")
    const composition = fs.readFileSync(path.join(import.meta.dirname, "server-workgraph.ts"), "utf8")

    expect(server).toContain("mountLazyEmbeddedWorkGraph(")
    expect(server).not.toContain("/api/workgraph/legacy")
    expect(server).not.toContain("loadWorkGraphApp")
    expect(server).not.toMatch(/export\s+\{[^}]*mountLazyLocalOnlyWorkGraph/)
    expect(composition).not.toContain("loadWorkGraphApp")
    expect(composition).not.toContain("githubAuthFromConnections")
    expect(composition).not.toContain('execFileAsync("gh"')
    expect(composition).not.toContain("workgraph.createApp")
    expect(composition).not.toContain("mountLazyLocalOnlyWorkGraph")
    expect(composition).not.toContain("localOnlyProjection")
    expect(fs.existsSync(path.join(import.meta.dirname, "../../../workgraph-execution.ts"))).toBe(false)
  })
})
