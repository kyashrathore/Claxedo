import { describe, expect, it } from "vitest"
import fs from "node:fs"
import path from "node:path"
import { sourceClosure } from "@claxedo/server-core/platform/governance/source-closure"

const ROOT = path.resolve(import.meta.dirname, "..")
const SERVER_SRC = path.resolve(ROOT, "../claxedo-server/src")

describe("@claxedo/local-server/self-hosted-execution", () => {
  it("keeps @claxedo/server production imports on the declared composition boundaries", () => {
    // A host reaching a deep module path pins an internal layout this package
    // should be free to change. Tests are exempt on purpose: a test of a moved
    // module names it directly, and forcing those through a public facade would
    // either bloat the facade or stop the module being tested at all.
    const allowed = new Set([
      "@claxedo/local-server/self-hosted-execution",
      // Optional VM image entry: it needs the filesystem materializer without
      // pulling the complete self-hosted server into a cloud workspace image.
      "@claxedo/local-server/agent-plugins/runtime/runtime-contribution",
      // The self-hosted entry mounts the local Agent Plugins module
      // (deployments/self-hosted-node/start.ts), the same module the desktop's
      // server entry mounts. Only that entry may name it.
      "@claxedo/local-server/agent-plugins/local-composition",
      // The same entry mounts local Tasks, the same way and for the same
      // reason: a product that does not name this subpath carries neither the
      // routes nor the kit.
      "@claxedo/local-server/tasks/local-composition",
      // The SIGNED self-hosted Tasks composition
      // (claxedo-server/src/tasks/self-hosted-composition.ts) binds this box's
      // own identity to the kit but starts sessions the same way the unsigned
      // one does, because the box runs them. The bridge is the only piece it
      // shares, and re-implementing it there would be a second copy of the
      // start path rather than a boundary.
      "@claxedo/local-server/tasks/session-bridge",
      // The signed node serves this machine's Marketplace, so its MCP mount,
      // its embedded runtimes and its Tasks grant all have to read the very
      // activation rows those routes write. One reader, named here, rather
      // than a second copy of the resolution on the server side.
      "@claxedo/local-server/agent-plugins/builtin-groups",
    ])
    const offenders: string[] = []
    const walk = (dir: string): string[] =>
      fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
        const full = path.join(dir, entry.name)
        if (entry.isDirectory()) return walk(full)
        if (!entry.name.endsWith(".ts")) return []
        return entry.name.includes(".test.") ? [] : [full]
      })

    for (const file of walk(SERVER_SRC)) {
      for (const match of fs.readFileSync(file, "utf8").matchAll(/["'](@claxedo\/local-server(?:\/[\w./-]+)?)["']/g)) {
        const specifier = match[1]
        if (allowed.has(specifier)) continue
        offenders.push(`${path.relative(SERVER_SRC, file)} -> ${specifier}`)
      }
    }

    expect(offenders).toEqual([])
    expect(fs.readFileSync(path.join(
      SERVER_SRC,
      "hosts/workspace-runtime/host-entry.agent-plugins.ts",
    ), "utf8")).toContain('from "@claxedo/local-server/agent-plugins/runtime/runtime-contribution"')
  })

  it("names nothing about Electron, a hosted capability, or who is signed in", () => {
    // The subpath is product-neutral on purpose: a host that wants a hosted capability
    // routes inside a local runtime passes them as generic route contributions,
    // which is what keeps a hosted capability's absence from an unsigned desktop a
    // composition fact rather than a runtime flag.
    const source = fs.readFileSync(path.join(ROOT, "src/self-hosted-execution.ts"), "utf8")
    const exported = source
      .split("\n")
      .filter((line) => line.trimStart().startsWith("export"))
      .join("\n")

    for (const banned of ["Electron", "electron", "signedIn", "account"]) {
      expect(exported).not.toContain(banned)
    }
  })

  it("closes over no hosted capability package", () => {
    const closure = sourceClosure({
      entry: path.join(ROOT, "src/self-hosted-execution.ts"),
      root: ROOT,
    })
    expect(
      ["@claxedo/server", "@claxedo/channels", "@claxedo/connections"]
        .filter((name) => closure.packages.includes(name)),
    ).toEqual([])
  })
})
