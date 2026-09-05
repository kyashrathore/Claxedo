import type { BrowserTarget } from "./environment"
import type { fixtureFor } from "./fixtures"
import type { Page } from "playwright-core"

export async function installSeedState(page: Page, app: Pick<BrowserTarget, "target" | "mockPort">, fixture: ReturnType<typeof fixtureFor>) {
  const target = app.target
  await page.addInitScript(({ target, directory, project, sessions, claxedoState, serverUrl }) => {
    localStorage.setItem(
      "settings.v3",
      JSON.stringify({ general: { showFileTree: true, showSessionProgressBar: true, editToolPartsExpanded: true } }),
    )
    localStorage.setItem(
      "claxedo.global.dat:layout",
      JSON.stringify({
        sidebar: { opened: true, width: 280, workspaces: {}, workspacesDefault: true },
        terminal: { height: 320, opened: false },
        review: { diffStyle: "split", panelOpened: true },
        fileTree: { opened: true, width: 280, tab: "changes" },
        session: { width: 600 },
        mobileSidebar: { opened: false },
        sessionTabs: {},
        sessionView: {},
        handoff: {},
      }),
    )
    localStorage.setItem(
      "claxedo.global.dat:server",
      JSON.stringify({
        projects: { local: [{ worktree: directory, expanded: true }] },
        lastProject: { local: directory },
      }),
    )
    localStorage.setItem("claxedo.state.v5", JSON.stringify(claxedoState))
    if (target === "claxedo") {
      const win = window as typeof window & {
        __CLAXEDO_TEST_AUTH_TOKEN__?: string
        __CLAXEDO_TEST_AUTH_USER__?: unknown
        __CLAXEDO_E2E_SERVER_URL__?: string
      }
      win.__CLAXEDO_TEST_AUTH_TOKEN__ = "perf-browser-token"
      win.__CLAXEDO_TEST_AUTH_USER__ = { id: "perf-browser-user" }
      win.__CLAXEDO_E2E_SERVER_URL__ = serverUrl
    }
    sessionStorage.setItem("claxedo.perf.fixture", JSON.stringify({ project, sessions }))
  }, {
    target,
    directory: fixture.directory,
    project: fixture.project,
    sessions: fixture.sessions,
    claxedoState: claxedoStateSeed(fixture),
    serverUrl: `http://127.0.0.1:${app.mockPort}`,
  })
}

export function claxedoStateSeed(
  fixture: Pick<ReturnType<typeof fixtureFor>, "directory" | "scenario" | "terminals">,
) {
  const metas = Object.fromEntries(
    fixture.terminals.map((terminal, index) => {
      const id = `terminal_perf_${index}`
      return [
        id,
        {
          id,
          type: "terminal",
          scope: "directory",
          directory: fixture.directory,
          terminalId: terminal.id,
          content: {
            type: "terminal",
            directory: fixture.directory,
            terminalId: terminal.id,
            title: terminal.title,
          },
        },
      ]
    }),
  )
  const contentIds = Object.keys(metas)
  const initialTerminalId = fixture.scenario === "live-terminal-switch" ? contentIds[0] : undefined
  return {
    workbench: {
      panes: initialTerminalId ? [{ id: "pane_perf_terminal", contentId: initialTerminalId }] : [],
      split: initialTerminalId
        ? { direction: "h", sizes: [1], root: { t: "leaf", id: "pane_perf_terminal" } }
        : { direction: "h", sizes: [] },
      contentIds,
      contentRecency: [...contentIds].reverse(),
      focusedPaneId: initialTerminalId ? "pane_perf_terminal" : null,
      layoutSnapshots: {},
    },
    meta: metas,
    rail: { collapsed: false, hovered: false, pinned: true, locked: false },
    workspace: {
      paneWorktree: initialTerminalId
        ? { pane_perf_terminal: { default: fixture.directory, pinned: null } }
        : {},
      recency: {},
      worktreeColor: {},
    },
    workspacePanel: {
      open: false,
      mode: "review",
      workspaceDir: fixture.directory,
    },
    terminal: {
      owner: Object.fromEntries(fixture.terminals.map((terminal, index) => [terminal.id, `terminal_perf_${index}`])),
      agentStatus: Object.fromEntries(fixture.terminals.map((terminal) => [terminal.id, "idle"])),
      agentSeen: {},
      lifecycle: Object.fromEntries(fixture.terminals.map((terminal) => [terminal.id, "attached"])),
    },
    processPane: { crashedWhileClosed: false, pendingAction: null },
  }
}

export function sessionPath(fixture: { directory: string }, sessionId: string) {
  return `/s/${sessionId}`
}

export function workspacePath(directory: string) {
  return `/${base64Encode(directory)}`
}

function base64Encode(value: string) {
  return Buffer.from(value).toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=/g, "")
}
