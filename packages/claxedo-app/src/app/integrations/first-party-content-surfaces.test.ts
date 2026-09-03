import { beforeAll, describe, expect, mock, test } from "bun:test"
import type { ContentSurfaceContribution } from "./content-surface-contract"

let mod: typeof import("./first-party-content-surfaces")
let documents: typeof import("./documents-content-surfaces")

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

  mod = await import("./first-party-content-surfaces")
  // The hosted set is a SEPARATE module now — importing it here is exactly the
  // edge the local composition must not have, which is why the test has to
  // reach for it explicitly.
  documents = await import("./documents-content-surfaces")
})

describe("content surface contributions", () => {
  test("seeds built-in workbench renderers through the shared surface registry", () => {
    const registry = mod.createContentSurfaceRegistry()

    expect(registry.all().surfaces.map((surface) => surface.id)).toEqual(mod.localContentSurfaces.map((surface) => surface.id))
    expect(mod.contentSurface("session", {}, registry)?.id).toBe("surface.content.session")
    expect(mod.contentSurface("terminal", {}, registry)?.id).toBe("surface.content.terminal")
  })

  test("the default registry renders no hosted surface until the hosted set is added", () => {
    // The Unit 2 acceptance criterion on the app side. Not "Documents is
    // hidden" — Documents has no renderer at all in a local composition.
    const registry = mod.createContentSurfaceRegistry()

    for (const type of ["page", "pages-index"]) {
      expect(mod.contentSurface(type, {}, registry), type).toBeUndefined()
    }

    const withHosted = mod.createContentSurfaceRegistry([
      ...mod.localContentSurfaces,
      ...documents.documentsContentSurfaces,
    ])
    expect(mod.contentSurface("page", {}, withHosted)?.id).toBe("surface.content.page")
  })

  test("un-registers a surface from the shared registry, so it stops resolving", () => {
    // The removal half of the composition seam. `registerContentSurface` and
    // `unregisterContentSurface` both act on the ONE shared registry the
    // workbench resolves against, which is what makes a sign-out observable
    // without a reload.
    const page = documents.documentsContentSurfaces.find((surface) => surface.surface === "page")!

    mod.registerContentSurface(page)
    expect(mod.contentSurface("page", {})?.id).toBe(page.id)

    mod.unregisterContentSurface(page)
    expect(mod.contentSurface("page", {})).toBeUndefined()
    // The local surfaces the same registry seeded are untouched.
    expect(mod.contentSurface("session", {})?.id).toBe("surface.content.session")
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
    const registry = mod.createContentSurfaceRegistry([...mod.localContentSurfaces, extensionSurface])

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
