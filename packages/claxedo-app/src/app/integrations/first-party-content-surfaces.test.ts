import { beforeAll, describe, expect, mock, test } from "bun:test"
import type { ContentSurfaceContribution } from "./first-party-content-surfaces"

let mod: typeof import("./first-party-content-surfaces")

beforeAll(async () => {
  mock.module("../../features/session/ui/content/session-content", () => ({
    SessionContent: () => null,
  }))
  mock.module("../../features/terminal/ui/content/terminal-content", () => ({
    TerminalContent: () => null,
  }))
  mock.module("../../features/documents/ui/content/page-content", () => ({
    PageContent: () => null,
  }))
  mock.module("../workbench/content/context-content", () => ({
    ContextContent: () => null,
  }))
  mock.module("../../features/documents/ui/content/pages-index-content", () => ({
    PagesIndexContent: () => null,
  }))
  mock.module("@/features/extensions/marketplace", () => ({
    MarketplaceContent: () => null,
  }))
  mock.module("../../features/workgraph", () => ({
    WorkGraphContent: () => null,
  }))

  mod = await import("./first-party-content-surfaces")
})

describe("content surface contributions", () => {
  test("seeds built-in workbench renderers through the shared surface registry", () => {
    const registry = mod.createContentSurfaceRegistry()

    expect(registry.all().surfaces.map((surface) => surface.id)).toEqual(mod.firstPartyContentSurfaces.map((surface) => surface.id))
    expect(mod.contentSurface("session", {}, registry)?.id).toBe("surface.content.session")
    expect(mod.contentSurface("terminal", {}, registry)?.id).toBe("surface.content.terminal")
  })

  test("resolves extension content surfaces through the same registry path as first-party surfaces", () => {
    const extensionSurface: ContentSurfaceContribution = {
      id: "surface.content.agent-review",
      tier: "lease-bound-agent",
      lease: { leaseId: "lease_1", agentId: "agent_1" },
      surface: "agent-review",
      slot: "ext:agent-review",
      gate: { backing: "real" },
      renderer: () => null,
    }
    const registry = mod.createContentSurfaceRegistry([...mod.firstPartyContentSurfaces, extensionSurface])

    expect(mod.contentSurface("agent-review", {
      sessionRef: {
        sessionId: "ses_central",
        host: "central",
        toolSandbox: { kind: "virtual" },
      },
    }, registry)).toBeUndefined()
    expect(mod.contentSurface("agent-review", {
      sessionRef: {
        sessionId: "ses_workspace",
        host: "workspace",
        toolSandbox: { kind: "local", cwd: "/repo" },
      },
    }, registry)?.id).toBe("surface.content.agent-review")
  })

})
