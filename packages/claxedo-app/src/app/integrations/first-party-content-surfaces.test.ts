import { beforeAll, describe, expect, mock, test } from "bun:test"
import type { ContentSurfaceContribution } from "./content-surface-contract"

let mod: typeof import("./first-party-content-surfaces")
let hosted: typeof import("./hosted-content-surfaces")

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
  // The hosted set is a SEPARATE module now — importing it here is exactly the
  // edge the local composition must not have, which is why the test has to
  // reach for it explicitly.
  hosted = await import("./hosted-content-surfaces")
})

describe("content surface contributions", () => {
  test("opens a WorkGraph Session with its authoritative project and harness", async () => {
    const open = mock(() => {})
    const navigate = mock(() => {})
    const request = mock(async () => new Response(undefined, { status: 500 }))

    await hosted.openWorkGraphSession({
      reference: {
        sessionId: "ses_workgraph",
        workspaceId: "envelope_reference",
        harness: "codex-acp",
        environment: { kind: "local_worktree", placement: "shared", directory: "/repo" },
      },
      request,
      serverUrl: "http://claxedo.test",
      projects: [],
      inventory: {
        loaded: true,
        byWorkspace: {},
        byProject: {
          project_claxedo: [{
            id: "ses_workgraph",
            directory: "/repo/.worktrees/workgraph",
            title: "Review WorkGraph",
          }],
        },
      },
      open,
      navigate,
    })

    expect(request).not.toHaveBeenCalled()
    expect(open).toHaveBeenCalledWith({
      directory: "/repo/.worktrees/workgraph",
      sessionId: "ses_workgraph",
      title: "Review WorkGraph",
      sessionRef: {
        sessionId: "ses_workgraph",
        host: "workspace",
        cwd: "/repo/.worktrees/workgraph",
        toolSandbox: { kind: "local", cwd: "/repo/.worktrees/workgraph" },
        harness: { id: "codex-acp" },
      },
    })
    expect(navigate).toHaveBeenCalledWith("/s/ses_workgraph")
  })

  test("does not open a placeholder when Session project metadata is unavailable", async () => {
    const open = mock(() => {})
    const navigate = mock(() => {})

    await expect(hosted.openWorkGraphSession({
      reference: { sessionId: "ses_missing", harness: "codex-acp" },
      request: async () => new Response(undefined, { status: 404 }),
      serverUrl: "http://claxedo.test",
      projects: [],
      open,
      navigate,
    })).rejects.toThrow("Session unavailable (404)")
    expect(open).not.toHaveBeenCalled()
    expect(navigate).not.toHaveBeenCalled()
  })

  test("seeds built-in workbench renderers through the shared surface registry", () => {
    const registry = mod.createContentSurfaceRegistry()

    expect(registry.all().surfaces.map((surface) => surface.id)).toEqual(mod.localContentSurfaces.map((surface) => surface.id))
    expect(mod.contentSurface("session", {}, registry)?.id).toBe("surface.content.session")
    expect(mod.contentSurface("terminal", {}, registry)?.id).toBe("surface.content.terminal")
  })

  test("the default registry renders no hosted surface until the hosted set is added", () => {
    // The Unit 2 acceptance criterion on the app side. Not "WorkGraph is
    // hidden" — WorkGraph has no renderer at all in a local composition.
    const registry = mod.createContentSurfaceRegistry()

    for (const type of ["workgraph", "workspace-workgraph", "task-composer", "page", "pages-index"]) {
      expect(mod.contentSurface(type, {}, registry), type).toBeUndefined()
    }

    const withHosted = mod.createContentSurfaceRegistry([...mod.localContentSurfaces, ...hosted.hostedContentSurfaces])
    expect(mod.contentSurface("workgraph", {}, withHosted)?.id).toBe("surface.content.workgraph")
    expect(mod.contentSurface("page", {}, withHosted)?.id).toBe("surface.content.page")
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
