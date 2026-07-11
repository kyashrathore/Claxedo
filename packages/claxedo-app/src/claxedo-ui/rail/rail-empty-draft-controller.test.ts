import { describe, expect, test } from "bun:test"
import { createRoot, createSignal } from "solid-js"

import type { ContentMeta } from "../state"
import { useRailEmptyDraftController } from "./rail-empty-draft-controller"

describe("useRailEmptyDraftController", () => {
  test("opens a draft session for the active workspace when the workbench is empty", async () => {
    const opened: (string | undefined)[] = []
    await withController({
      activeWorkspaceId: "/repo/active",
      onNewSession: (workspaceDir) => opened.push(workspaceDir),
    }, async () => {
      await settleMicrotasks()
      expect(opened).toEqual(["/repo/active"])
    })
  })

  test("does not auto-open while disabled by route state or recent last-tab close", async () => {
    const opened: (string | undefined)[] = []
    await withController({
      activeWorkspaceId: "/repo/active",
      autoOpenDisabled: true,
      onNewSession: (workspaceDir) => opened.push(workspaceDir),
    }, async () => {
      await settleMicrotasks()
      expect(opened).toEqual([])
    })

    await withSuppressibleCloseSequence((controller, closeLastSurface) => {
      controller.blockNextAutoOpen()
      closeLastSurface()
    }, async () => {
      await settleMicrotasks()
      expect(opened).toEqual([])
    }, (workspaceDir) => opened.push(workspaceDir))
  })

  test("does not auto-open when a visible renderable surface exists", async () => {
    const opened: (string | undefined)[] = []
    await withController({
      activeWorkspaceId: "/repo/active",
      contents: [sessionMeta("surface-session", "/repo/active")],
      panes: [{ contentId: "surface-session" }],
      focusedContentId: "surface-session",
      onNewSession: (workspaceDir) => opened.push(workspaceDir),
    }, async (controller) => {
      await settleMicrotasks()
      expect(opened).toEqual([])
      expect(controller.hasOpenSurfaces()).toBe(true)
      expect(controller.sidebarEligible()).toBe(true)
    })
  })

  test("derives sidebar eligibility and active global state from real surfaces", async () => {
    await withController({}, async (controller) => {
      expect(controller.sidebarEligible()).toBe(false)
      expect(controller.activeGlobal()).toBe(false)
    })

    await withController({
      projects: [{ worktree: "/repo/main" }],
    }, async (controller) => {
      expect(controller.sidebarEligible()).toBe(true)
      expect(controller.emptyDraftDirectory()).toBe("/repo/main")
    })

    await withController({
      contents: [globalPageMeta()],
      panes: [{ contentId: "global-page" }],
      focusedContentId: "global-page",
    }, async (controller) => {
      expect(controller.sidebarEligible()).toBe(true)
      expect(controller.activeGlobal()).toBe(true)
    })
  })
})

async function withController(
  input: {
    projects?: readonly { worktree: string }[]
    activeWorkspaceId?: string
    autoOpenDisabled?: boolean
    contents?: readonly ContentMeta[]
    panes?: readonly { contentId?: string }[]
    focusedContentId?: string
    onNewSession?: (workspaceDir?: string) => void
  },
  run: (controller: ReturnType<typeof useRailEmptyDraftController>) => void | Promise<void>,
) {
  let dispose: (() => void) | undefined
  const controller = createRoot((rootDispose) => {
    dispose = rootDispose
    return useRailEmptyDraftController({
      state: fakeState(input),
      projects: () => input.projects ?? [],
      activeWorkspaceId: () => input.activeWorkspaceId,
      autoOpenDisabled: () => input.autoOpenDisabled,
      onNewSession: input.onNewSession,
    })
  })
  try {
    await run(controller)
  } finally {
    dispose?.()
  }
}

async function withSuppressibleCloseSequence(
  beforeSettle: (
    controller: ReturnType<typeof useRailEmptyDraftController>,
    closeLastSurface: () => void,
  ) => void,
  run: () => void | Promise<void>,
  onNewSession: (workspaceDir?: string) => void,
) {
  let dispose: (() => void) | undefined
  const [panes, setPanes] = createRoot((rootDispose) => {
    dispose = rootDispose
    return createSignal<readonly { contentId?: string }[]>([{ contentId: "surface-session" }])
  })
  const controller = createRoot((rootDispose) => {
    const previousDispose = dispose
    dispose = () => {
      previousDispose?.()
      rootDispose()
    }
    return useRailEmptyDraftController({
      state: {
        wb: {
          selectors: {
            aliveContents: () => ["surface-session"],
            visiblePanes: panes,
            focusedContent: () => panes()[0]?.contentId,
          },
        },
        meta: {
          get: (contentId) => contentId === "surface-session" ? sessionMeta("surface-session", "/repo/active") : undefined,
        },
      },
      projects: () => [],
      activeWorkspaceId: () => "/repo/active",
      autoOpenDisabled: () => false,
      onNewSession,
    })
  })
  try {
    beforeSettle(controller, () => setPanes([]))
    await run()
  } finally {
    dispose?.()
  }
}

function fakeState(input: {
  contents?: readonly ContentMeta[]
  panes?: readonly { contentId?: string }[]
  focusedContentId?: string
}) {
  return {
    wb: {
      selectors: {
        aliveContents: () => (input.contents ?? []).map((content) => content.id),
        visiblePanes: () => input.panes ?? [],
        focusedContent: () => input.focusedContentId,
      },
    },
    meta: {
      get: (contentId: string) => input.contents?.find((content) => content.id === contentId),
    },
  }
}

function sessionMeta(id: string, workspaceDir: string): ContentMeta {
  return {
    id,
    type: "session",
    scope: "directory",
    directory: workspaceDir,
    sessionId: "ses_surface",
    content: {
      type: "session",
      directory: workspaceDir,
      sessionId: "ses_surface",
    },
  }
}

function globalPageMeta(): ContentMeta {
  return {
    id: "global-page",
    type: "page",
    scope: "global",
    content: {
      type: "page",
      pageId: "page-1",
    },
  }
}

async function settleMicrotasks() {
  await Promise.resolve()
  await new Promise<void>((resolve) => queueMicrotask(resolve))
}
