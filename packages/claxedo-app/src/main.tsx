/**
 * Cloud-specific entry point for Claxedo.
 *
 * This file initializes cloud extensions and renders the OpenCode app
 * with cloud functionality enabled.
 */

// @refresh reload
import { render } from "solid-js/web"
import { AppBaseProviders, AppInterface } from "@/app"
import { PlatformProvider, type Platform } from "@opencode-ai/claxedo-app"
import { initClaxedo, getDefaultConfig } from "./index"
import { getAuthToken } from "./utils/auth-client"
import { isDemoMode, isEmbedMode } from "./utils/api"
import { ConfigProvider } from "./context/config"
import { Persist, rawPersistKey } from "./overrides/utils/persist"

// Initialize cloud extensions before rendering
const config = getDefaultConfig()
initClaxedo(config)

const root = document.getElementById("root")
if (import.meta.env.DEV && !(root instanceof HTMLElement)) {
  throw new Error(
    "Root element not found. Make sure there is an element with id='root' in your index.html",
  )
}

/**
 * Authenticated fetch that adds Clerk JWT token to requests.
 * Handles both URL string and Request object inputs.
 */
const authFetch: typeof fetch = async (input, init) => {
  const token = await getAuthToken()

  // Debug: log message endpoint calls in demo mode
  if (isDemoMode()) {
    const url = typeof input === "string" ? input : input instanceof Request ? input.url : ""
    if (url.includes("/message")) {
      console.log(`[demo-fetch] ${init?.method ?? "GET"} ${url}`)
    }
  }

  // Handle Request object input - headers are on the Request, not in init
  const existingHeaders = input instanceof Request ? input.headers : init?.headers
  const headers = new Headers(existingHeaders)

  if (token) {
    headers.set("Authorization", `Bearer ${token}`)
  }
  return fetch(input, { ...init, headers })
}

/**
 * Platform configuration for cloud/web mode.
 */
const platform: Platform = {
  platform: "web",
  version: "cloud",
  fetch: authFetch,
  getAuthToken,
  openLink(url: string) {
    window.open(url, "_blank")
  },
  restart: async () => {
    window.location.reload()
  },
  back() {
    window.history.back()
  },
  forward() {
    window.history.forward()
  },
  notify: async (title, description, href) => {
    if (isEmbedMode()) return
    if (!("Notification" in window)) return

    const permission =
      Notification.permission === "default"
        ? await Notification.requestPermission().catch(() => "denied")
        : Notification.permission

    if (permission !== "granted") return

    const inView = document.visibilityState === "visible" && document.hasFocus()
    if (inView) return

    await Promise.resolve()
      .then(() => {
        const notification = new Notification(title, {
          body: description ?? "",
          icon: "https://opencode.ai/favicon-96x96-v3.png",
        })
        notification.onclick = () => {
          window.focus()
          if (href) {
            window.history.pushState(null, "", href)
            window.dispatchEvent(new PopStateEvent("popstate"))
          }
          notification.close()
        }
      })
      .catch(() => undefined)
  },
}

async function startApp() {
  // In demo mode, start MSW to mock server responses before rendering
  if (isDemoMode()) {
    const embed = isEmbedMode()

    for (const key of Object.keys(localStorage)) {
      if (!key.startsWith("opencode.demo.")) continue
      localStorage.removeItem(key)
    }

    const seed = (target: { storage?: string; key: string }, value: unknown) => {
      localStorage.setItem(rawPersistKey(target), JSON.stringify(value))
    }

    // Pre-seed the server store so the demo project auto-opens
    const demoProject = "/home/demo/projects/my-app"
    const featureBranch = "/home/demo/projects/my-app-feature-auth"
    const dashboardProject = "/home/demo/projects/dashboard"
    const serverKey = window.location.origin
    const fileTreeLeaf = "leaf-filetree-demo"
    const sessionLeaf = "leaf-session-demo"
    const reviewLeaf = "leaf-review-demo"
    const layoutId = "layout-demo-001"
    const multiPaneTabId = "tab-multi-demo-001"
    const projects = [
      { worktree: demoProject, expanded: true },
      { worktree: featureBranch, expanded: true },
      { worktree: dashboardProject, expanded: true },
    ]
    const pageTabId = "tab-page-demo-001"
    const sessionTabId = "tab-ses-wt-001"
    const emptyPaneTabId = "tab-empty-pane-demo"
    const processTabId = "tab-process-demo"
    const baseTabs = [
      {
        id: multiPaneTabId,
        type: "review-workspace",
        directory: demoProject,
        title: "Fix authentication middleware bug",
        sessionId: "ses_demo_001",
        reviewMode: "session",
        closable: true,
      },
      {
        id: pageTabId,
        type: "page",
        directory: demoProject,
        title: "Project Architecture",
        pageId: "page_demo_001",
        closable: true,
      },
      {
        id: sessionTabId,
        type: "session",
        directory: demoProject,
        title: "Add Google OAuth provider",
        sessionId: "ses_demo_001",
        closable: true,
      },
      {
        id: "tab-ses-wt-002",
        type: "session",
        directory: featureBranch,
        title: "Implement refresh token rotation",
        sessionId: "ses_wt_002",
        closable: true,
      },
      {
        id: "tab-ses-p2-001",
        type: "session",
        directory: dashboardProject,
        title: "Build real-time chart component",
        sessionId: "ses_p2_001",
        closable: true,
      },
      {
        id: emptyPaneTabId,
        type: "multi-pane",
        directory: demoProject,
        title: "New Pane",
        closable: true,
      },
      {
        id: processTabId,
        type: "process",
        directory: demoProject,
        title: "Processes",
        closable: true,
      },
    ]
    const tabs = baseTabs
    const colors = {
      [demoProject]: "#3b82f6",
      [featureBranch]: "#a855f7",
      [dashboardProject]: "#22c55e",
    }
    seed(Persist.global("server"), {
      list: [],
      projects: {
        [serverKey]: projects,
      },
      lastProject: { [serverKey]: demoProject },
      workspaceServer: {},
    })

    // Pre-seed claxedo layout with multi-pane session tab + other tabs
    seed(Persist.global("claxedo.layout.v3"), {
      rail: { collapsed: true, hovered: false, pinned: false, locked: false },
      groups: [
        {
          id: "g-default",
          tabs: {
            items: tabs,
            activeId: pageTabId,
            order: tabs.map((item) => item.id),
            closedTabs: [],
          },
          worktree: { default: demoProject, pinned: null },
          layout: {},
        },
      ],
      split: { direction: "h", sizes: [1], focusedId: "g-default" },
      enabled: true,
      terminalOwner: {},
      terminalAgentStatus: {},
      terminalAgentSeen: {},
      worktreeColorMap: colors,
      multiPane: {
        [multiPaneTabId]: {
          layouts: [
            {
              id: layoutId,
              name: "default",
              pane: {
                t: "split",
                dir: "v",
                a: {
                  t: "split",
                  dir: "v",
                  a: { t: "leaf", id: sessionLeaf },
                  b: { t: "leaf", id: reviewLeaf },
                  size: 0.5,
                },
                b: { t: "leaf", id: fileTreeLeaf },
                size: 0.82,
              },
              contents: {
                [sessionLeaf]: {
                  type: "session",
                  directory: demoProject,
                  sessionId: "ses_demo_001",
                },
                [reviewLeaf]: {
                  type: "review-workspace",
                  directory: demoProject,
                  sessionId: "ses_demo_001",
                  reviewMode: "session",
                },
                [fileTreeLeaf]: {
                  type: "filetree",
                  directory: demoProject,
                },
              },
              focus: sessionLeaf,
            },
          ],
          activeLayoutId: layoutId,
        },
        [pageTabId]: {
          layouts: [
            {
              id: "layout-page-001",
              name: "default",
              pane: { t: "leaf", id: "leaf-page-demo" },
              contents: {
                "leaf-page-demo": {
                  type: "page",
                  directory: demoProject,
                  pageId: "page_demo_001",
                  title: "Project Architecture",
                },
              },
              focus: "leaf-page-demo",
            },
          ],
          activeLayoutId: "layout-page-001",
        },
        [sessionTabId]: {
          layouts: [
            {
              id: "layout-session-001",
              name: "default",
              pane: { t: "leaf", id: "leaf-session-wt" },
              contents: {
                "leaf-session-wt": {
                  type: "session",
                  directory: demoProject,
                  sessionId: "ses_demo_001",
                },
              },
              focus: "leaf-session-wt",
            },
          ],
          activeLayoutId: "layout-session-001",
        },
        "tab-ses-wt-002": {
          layouts: [
            {
              id: "layout-wt-002",
              name: "default",
              pane: { t: "leaf", id: "leaf-ses-wt-002" },
              contents: {
                "leaf-ses-wt-002": {
                  type: "session",
                  directory: featureBranch,
                  sessionId: "ses_wt_002",
                },
              },
              focus: "leaf-ses-wt-002",
            },
          ],
          activeLayoutId: "layout-wt-002",
        },
        "tab-ses-p2-001": {
          layouts: [
            {
              id: "layout-p2-001",
              name: "default",
              pane: { t: "leaf", id: "leaf-ses-p2-001" },
              contents: {
                "leaf-ses-p2-001": {
                  type: "session",
                  directory: dashboardProject,
                  sessionId: "ses_p2_001",
                },
              },
              focus: "leaf-ses-p2-001",
            },
          ],
          activeLayoutId: "layout-p2-001",
        },
        [emptyPaneTabId]: {
          layouts: [
            {
              id: "layout-empty-001",
              name: "default",
              pane: { t: "leaf", id: "leaf-empty-demo" },
              contents: {},
              focus: "leaf-empty-demo",
            },
          ],
          activeLayoutId: "layout-empty-001",
        },
        [processTabId]: {
          layouts: [
            {
              id: "layout-process-001",
              name: "default",
              pane: { t: "leaf", id: "leaf-process-demo" },
              contents: {
                "leaf-process-demo": {
                  type: "process",
                  directory: demoProject,
                },
              },
              focus: "leaf-process-demo",
            },
          ],
          activeLayoutId: "layout-process-001",
        },
      },
    })

    // Start MSW with a hard timeout — never block rendering forever
    console.log("[demo] starting MSW...")
    const mswReady = (async () => {
      try {
        const regs = await navigator.serviceWorker.getRegistrations()
        for (const reg of regs) await reg.unregister()
        console.log("[demo] cleared stale service workers")
      } catch {}
      const { startWorker } = await import("./demo/browser")
      await startWorker({ onUnhandledRequest: "warn", quiet: false })
      console.log("[demo] MSW started")
    })()
    const timeout = new Promise<void>((r) => {
      setTimeout(() => {
        console.warn("[demo] MSW timed out after 4s — rendering anyway")
        r()
      }, 4000)
    })
    await Promise.race([mswReady, timeout])
  }

  // Render the standard app with cloud extensions active
  render(
    () => (
      <ConfigProvider config={config}>
        <PlatformProvider value={platform}>
          <AppBaseProviders>
            <AppInterface />
          </AppBaseProviders>
        </PlatformProvider>
      </ConfigProvider>
    ),
    root!,
  )
}

startApp()
