import { expect, test, type Page, type Route } from "@playwright/test"

const DIR = "/tmp/e2e-cloud-runtime-relay-routing"
const WORKSPACE_ID = "ws_cloud"
const USER_HOSTED_WORKSPACE_ID = "ws_user_hosted"
const SIGNED_WORKSPACE_DIR = WORKSPACE_ID
const SIGNED_USER_HOSTED_DIR = `${DIR}/.claxedo/user-hosted/workspaces/${USER_HOSTED_WORKSPACE_ID}`
const RELAY_ORIGIN = "https://relay.e2e.test"
const DIFF_FILE = "src/cloud-change.ts"
const FILE_PATH = "runtime-file.md"

type RequestHit = {
  method: string
  url: string
  authorization?: string
}

type Hits = {
  forbiddenOldRuntime: RequestHit[]
  relayRuntime: RequestHit[]
  unexpectedRelayRuntime: RequestHit[]
  connections: RequestHit[]
  controlPlaneEvents: RequestHit[]
  localControlPlaneEvents: RequestHit[]
  controlPlaneSessionEvents: RequestHit[]
  controlPlaneSessionMessages: RequestHit[]
  controlPlaneSessionCapabilities: RequestHit[]
  controlPlaneWorkspaceLists: RequestHit[]
  controlPlaneSessionLists: RequestHit[]
  refreshes: RequestHit[]
  knownCompatBootstrap: RequestHit[]
  unhandledApi: RequestHit[]
  console: string[]
  failed: string[]
}

let configs: Array<Record<string, unknown>>
let pty = 1

function hits(): Hits {
  return {
    forbiddenOldRuntime: [],
    relayRuntime: [],
    unexpectedRelayRuntime: [],
    connections: [],
    controlPlaneEvents: [],
    localControlPlaneEvents: [],
    controlPlaneSessionEvents: [],
    controlPlaneSessionMessages: [],
    controlPlaneSessionCapabilities: [],
    controlPlaneWorkspaceLists: [],
    controlPlaneSessionLists: [],
    refreshes: [],
    knownCompatBootstrap: [],
    unhandledApi: [],
    console: [],
    failed: [],
  }
}

function slug(value: string) {
  return Buffer.from(value, "utf-8").toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=/g, "")
}

function corsHeaders() {
  return {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "authorization,content-type,accept",
    "Access-Control-Allow-Methods": "GET,POST,PUT,PATCH,DELETE,OPTIONS",
  }
}

async function json(route: Route, body: unknown, status = 200) {
  await route.fulfill({
    status,
    contentType: "application/json",
    headers: corsHeaders(),
    body: JSON.stringify(body),
  })
}

function sseEvent(input: unknown) {
  return `data: ${JSON.stringify(input)}\n\n`
}

function runtimeHits(hit: Hits, input: { workspaceId: string; path: string; method?: string }) {
  return hit.relayRuntime.filter((item) => {
    const url = new URL(item.url)
    return url.pathname === `/workspaces/${input.workspaceId}${input.path}` &&
      (!input.method || item.method === input.method)
  })
}

async function seed(page: Page) {
  await page.addInitScript((input: { directory: string; userHostedDirectory: string }) => {
    localStorage.clear()
    ;(window as typeof window & {
      __OPENCODE__?: {
        serverUrl?: string
        activeDirectory?: string
      }
    }).__OPENCODE__ = {
      serverUrl: window.location.origin,
      activeDirectory: input.directory,
    }
    ;(window as typeof window & {
      __CLAXEDO_TEST_AUTH_TOKEN__?: string
      __CLAXEDO_TEST_AUTH_USER__?: { id: string }
    }).__CLAXEDO_TEST_AUTH_TOKEN__ = "signed-browser-token"
    ;(window as typeof window & {
      __CLAXEDO_TEST_AUTH_TOKEN__?: string
      __CLAXEDO_TEST_AUTH_USER__?: { id: string }
    }).__CLAXEDO_TEST_AUTH_USER__ = { id: "user_browser" }
    localStorage.setItem(
      "opencode.global.dat:server",
      JSON.stringify({
        list: [],
        projects: {
          local: [{ worktree: input.directory, expanded: true }],
        },
        lastProject: {},
        workspaceServer: {},
        closedProjects: {},
      }),
    )
    localStorage.setItem(
      "opencode.global.dat:globalSync.project",
      JSON.stringify({
        value: [{
          id: "proj_cloud",
          name: "cloud-runtime",
          worktree: input.directory,
          sandboxes: [input.directory, input.userHostedDirectory],
          workspaces: {
            [input.directory]: {
              id: "ws_cloud",
              kind: "cloud",
              workspace_name: "main",
              directory: input.directory,
            },
            [input.userHostedDirectory]: {
              id: "ws_user_hosted",
              kind: "user-hosted",
              workspace_name: "shared",
              directory: input.userHostedDirectory,
            },
          },
        }],
      }),
    )
    localStorage.setItem(
      "opencode.global.dat:model",
      JSON.stringify({
        recent: [{ providerID: "claude-acp", modelID: "claude-sonnet-4-6" }],
        user: [],
        variant: {},
      }),
    )
  }, { directory: SIGNED_WORKSPACE_DIR, userHostedDirectory: SIGNED_USER_HOSTED_DIR })
}

function api(route: Route) {
  const type = route.request().resourceType()
  return type === "fetch" || type === "xhr" || type === "eventsource" || route.request().method() === "OPTIONS"
}

async function setup(page: Page, hits: Hits, options: {
  initialTokenExpiresAt?: number
  relayRole?: "editor" | "viewer"
} = {}) {
  configs = []
  pty = 1

  page.on("requestfailed", (request) => {
    if (new URL(request.url()).hostname.endsWith(".clerk.accounts.dev")) return
    hits.failed.push(`${request.method()} ${request.url()} ${request.failure()?.errorText ?? ""}`.trim())
  })
  page.on("console", (message) => {
    if (message.type() === "error" || message.type() === "warning") {
      hits.console.push(`${message.type()}: ${message.text()}`)
    }
  })
  page.on("pageerror", (error) => {
    hits.console.push(`pageerror: ${error.message}`)
  })

  await page.route("**/*", async (route) => {
    if (!api(route)) return route.continue()

    const request = route.request()
    const url = new URL(request.url())
    const hit = {
      method: request.method(),
      url: request.url(),
      authorization: request.headers().authorization,
    }

    if (request.method() === "OPTIONS") {
      await route.fulfill({ status: 204, headers: corsHeaders() })
      return
    }

    if (url.hostname.endsWith(".clerk.accounts.dev")) {
      await json(route, {})
      return
    }

    if (
      url.hostname !== "relay.e2e.test" &&
      /^\/api\/claxedo\/(pty|process|diff)(?:\/|$)/.test(url.pathname)
    ) {
      hits.forbiddenOldRuntime.push(hit)
      await json(route, { error: "old runtime proxy path used" }, 599)
      return
    }

    if (
      url.pathname === "/global/dispose" ||
      url.pathname === "/global/event" ||
      url.pathname === "/event" ||
      url.pathname === "/permission" ||
      url.pathname.startsWith("/permission/") ||
      url.pathname === "/question" ||
      url.pathname.startsWith("/question/") ||
      url.pathname === "/session" ||
      url.pathname === "/experimental/session" ||
      url.pathname.startsWith("/session/")
    ) {
      hits.forbiddenOldRuntime.push(hit)
      await json(route, { error: "old OpenCode-compatible path used" }, 599)
      return
    }

    if (url.pathname === "/experimental/worktree" || url.pathname.startsWith("/experimental/worktree/")) {
      hits.forbiddenOldRuntime.push(hit)
      await json(route, { error: "old local worktree compatibility path used" }, 599)
      return
    }

    const relayWorkspaceId = url.pathname.startsWith("/workspaces/")
      ? url.pathname.split("/")[2]
      : undefined
    if (relayWorkspaceId === WORKSPACE_ID || relayWorkspaceId === USER_HOSTED_WORKSPACE_ID) {
      hits.relayRuntime.push(hit)
      const runtimePath = url.pathname.replace(`/workspaces/${relayWorkspaceId}`, "")

      if (runtimePath === "/vcs") {
        await json(route, { branch: "main", default_branch: "main" })
        return
      }

      if (runtimePath === "/mcp") {
        await json(route, {})
        return
      }

      if (runtimePath === "/lsp") {
        await json(route, [])
        return
      }

      if (runtimePath === "/agent") {
        await json(route, [{ name: "build", description: "Default agent", mode: "primary" }])
        return
      }

      if (runtimePath === "/command") {
        await json(route, [])
        return
      }

      if (runtimePath === "/provider") {
        await json(route, {
          all: [{
            id: "opencode",
            name: "OpenCode",
            env: [],
            models: { "big-pickle": { id: "big-pickle", name: "Big Pickle", providerID: "opencode" } },
          }],
          connected: ["opencode"],
          default: { opencode: "big-pickle" },
        })
        return
      }

      if (
        runtimePath === "/api/claxedo/runtime-events" ||
        runtimePath === "/api/wr/events" ||
        runtimePath === "/api/wr/runtime-events"
      ) {
        await route.fulfill({
          status: 200,
          contentType: "text/event-stream",
          headers: corsHeaders(),
          body: sseEvent({ type: "heartbeat" }),
        })
        return
      }

      if (runtimePath === "/api/claxedo/health" || runtimePath === "/api/wr/health" || runtimePath === "/health") {
        await json(route, { healthy: true, version: "1.0.0-test" })
        return
      }

      if (runtimePath === "/session") {
        const sessionId = relayWorkspaceId === USER_HOSTED_WORKSPACE_ID ? "cp-user-hosted-1" : "cp-cloud-1"
        await json(route, [{
          id: sessionId,
          sessionID: sessionId,
          title: relayWorkspaceId === USER_HOSTED_WORKSPACE_ID ? "User-hosted session" : "Cloud session",
          time: { created: 1, updated: 2 },
          directory: relayWorkspaceId === USER_HOSTED_WORKSPACE_ID ? SIGNED_USER_HOSTED_DIR : SIGNED_WORKSPACE_DIR,
        }])
        return
      }

      if (runtimePath === "/session/status") {
        await json(route, {
          "cp-cloud-1": { type: "idle" },
          "cp-user-hosted-1": { type: "idle" },
        })
        return
      }

      if (runtimePath === "/permission" || runtimePath === "/question") {
        await json(route, [])
        return
      }

      if (/^\/session\/[^/]+$/.test(runtimePath)) {
        await json(route, {
          id: decodeURIComponent(runtimePath.split("/")[2] ?? ""),
          title: "Cloud session",
        })
        return
      }

      if (/^\/session\/[^/]+\/capabilities$/.test(runtimePath)) {
        await json(route, {
          transport: "claude-acp",
          abort: true,
          reconnect: true,
          replay: true,
          permissions: false,
          questions: false,
          todos: false,
          commands: false,
          fork: true,
          revert: false,
          unrevert: false,
          configOptions: false,
        })
        return
      }

      if (/^\/session\/[^/]+\/message$/.test(runtimePath)) {
        const sessionId = decodeURIComponent(runtimePath.split("/")[2] ?? "cp-cloud-1")
        await json(route, [{
          info: {
            id: "msg_control_signed",
            sessionID: sessionId,
            role: "user",
            time: { created: 1_700_000_000_100 },
          },
          parts: [{
            id: "part_control_signed",
            sessionID: sessionId,
            messageID: "msg_control_signed",
            type: "text",
            text: "Signed Control Plane replay message",
          }],
        }])
        return
      }

      if (/^\/session\/[^/]+\/todo$/.test(runtimePath)) {
        await json(route, [])
        return
      }

      if (/^\/session\/[^/]+\/config$/.test(runtimePath)) {
        if (request.method() === "GET") {
          await json(route, {
            runner: { type: "opencode", model: "big-pickle" },
            model: { providerID: "opencode", modelID: "big-pickle" },
          })
          return
        }
        await json(route, { ok: true })
        return
      }

      if (runtimePath === "/global/event" || runtimePath === "/event") {
        hits.controlPlaneSessionEvents.push(hit)
        const sessionId = url.searchParams.get("sessionID") ?? "cp-cloud-1"
        const replayedMessage = {
          info: {
            id: "msg_control_signed",
            sessionID: sessionId,
            role: "user",
            time: { created: 1_700_000_000_100 },
          },
          part: {
            id: "part_control_signed",
            sessionID: sessionId,
            messageID: "msg_control_signed",
            type: "text",
            text: "Signed Control Plane replay message",
          },
        }
        const body = [
          sseEvent({
            directory: "global",
            payload: { type: "server.connected", properties: {} },
          }),
          sseEvent({
            directory: DIR,
            payload: {
              type: "message.updated",
              properties: { info: replayedMessage.info },
            },
          }),
          sseEvent({
            directory: DIR,
            payload: {
              type: "message.part.updated",
              properties: { part: replayedMessage.part },
            },
          }),
        ].join("")
        await route.fulfill({
          status: 200,
          contentType: "text/event-stream",
          headers: corsHeaders(),
          body,
        })
        return
      }

      if (/^\/session\/[^/]+\/prompt_async$/.test(runtimePath)) {
        await json(route, { ok: true })
        return
      }

      if (runtimePath === "/file/status") {
        await json(route, [{ path: FILE_PATH, status: "modified" }])
        return
      }

      if (runtimePath === "/file") {
        await json(route, [{
          name: FILE_PATH,
          path: FILE_PATH,
          absolute: `${DIR}/${FILE_PATH}`,
          type: "file",
          ignored: false,
        }])
        return
      }

      if (runtimePath === "/file/content") {
        await json(route, {
          type: "text",
          content: "# Cloud file routed through relay\n\nThis file came from the workspace relay.\n",
        })
        return
      }

      if (runtimePath === "/find/file") {
        await json(route, [FILE_PATH])
        return
      }

      if (runtimePath === "/api/claxedo/process" || runtimePath === "/api/wr/process") {
        if (request.method() === "GET") {
          await json(route, { configs, processes: [] })
          return
        }
        if (options.relayRole === "viewer") {
          await json(route, { error: "viewer runtime token is read-only" }, 403)
          return
        }
        if (request.method() === "POST") {
          const body = request.postDataJSON() as { name?: string; command?: string }
          const config = {
            id: "cfg-cloud",
            name: body.name ?? "cloud-dev",
            command: body.command ?? "echo cloud",
            args: [],
            cwd: "",
            env: {},
            autoStart: false,
            restartPolicy: "never",
            maxRestarts: 3,
            color: "",
          }
          configs.push(config)
          await json(route, config, 201)
          return
        }
      }

      if (runtimePath === "/api/claxedo/pty" || runtimePath === "/api/wr/pty") {
        const body = request.postDataJSON() as { title?: string; cwd?: string } | undefined
        const id = `pty-${pty++}`
        await json(route, { id, title: body?.title ?? "Claude", cwd: body?.cwd ?? DIR })
        return
      }

      if (/^\/api\/claxedo\/pty\/[^/]+$/.test(runtimePath) || /^\/api\/wr\/pty\/[^/]+$/.test(runtimePath)) {
        await json(route, true)
        return
      }

      if (runtimePath === "/api/claxedo/hook/terminal-session" || runtimePath === "/api/wr/hook/terminal-session") {
        await json(route, {
          success: true,
          source: "none",
          terminalId: url.searchParams.get("terminalId"),
          session: null,
        })
        return
      }

      if (runtimePath === "/api/wr/diff/refs") {
        await json(route, { branches: ["main"], tags: [], recent: [] })
        return
      }

      if (runtimePath === "/api/wr/diff/targets") {
        await json(route, { defaultRef: "main", candidates: ["main", "HEAD~1"] })
        return
      }

      if (runtimePath === "/api/claxedo/diff/vcs" || runtimePath === "/api/wr/diff/vcs") {
        await json(route, [{
          file: DIFF_FILE,
          additions: 1,
          deletions: 1,
          status: "modified",
        }])
        return
      }

      if (runtimePath === "/api/claxedo/diff/vcs/file" || runtimePath === "/api/wr/diff/vcs/file") {
        await json(route, {
          file: DIFF_FILE,
          before: "export const value = 1\n",
          after: "export const value = 2\n",
          patch: [
            `diff --git a/${DIFF_FILE} b/${DIFF_FILE}`,
            `--- a/${DIFF_FILE}`,
            `+++ b/${DIFF_FILE}`,
            "@@ -1 +1 @@",
            "-export const value = 1",
            "+export const value = 2",
            "",
          ].join("\n"),
          additions: 1,
          deletions: 1,
          status: "modified",
        })
        return
      }

      if (runtimePath === "/api/claxedo/diff/refs") {
        await json(route, { branches: ["main"], tags: [], recent: [] })
        return
      }

      if (runtimePath === "/api/claxedo/diff/targets") {
        await json(route, { defaultRef: "main", candidates: ["main", "HEAD~1"] })
        return
      }

      hits.unexpectedRelayRuntime.push(hit)
      await json(route, { error: "unexpected Workspace Relay runtime path used" }, 598)
      return
    }

    if (url.pathname === `/api/workspace/${WORKSPACE_ID}/connection` || url.pathname === `/api/workspace/${USER_HOSTED_WORKSPACE_ID}/connection`) {
      const userHosted = url.pathname.includes(USER_HOSTED_WORKSPACE_ID)
      hits.connections.push(hit)
      await json(route, {
        access: userHosted ? "user-hosted" : "cloud",
        backing: userHosted ? "local-worktree" : "cloud-vm",
        workspaceId: userHosted ? USER_HOSTED_WORKSPACE_ID : WORKSPACE_ID,
        role: options.relayRole ?? "owner",
        relayUrl: RELAY_ORIGIN,
        runtimeAccessToken: userHosted
          ? options.relayRole === "viewer" ? "rat_browser_user_hosted_viewer" : "rat_browser_user_hosted"
          : options.relayRole === "viewer" ? "rat_browser_cloud_viewer" : "rat_browser_cloud",
        tokenExpiresAt: options.initialTokenExpiresAt ?? Date.now() + 120_000,
      })
      return
    }

    if (url.pathname === `/api/workspace/${WORKSPACE_ID}/connection/refresh` || url.pathname === `/api/workspace/${USER_HOSTED_WORKSPACE_ID}/connection/refresh`) {
      const userHosted = url.pathname.includes(USER_HOSTED_WORKSPACE_ID)
      hits.refreshes.push(hit)
      await json(route, {
        access: userHosted ? "user-hosted" : "cloud",
        backing: userHosted ? "local-worktree" : "cloud-vm",
        workspaceId: userHosted ? USER_HOSTED_WORKSPACE_ID : WORKSPACE_ID,
        role: options.relayRole ?? "owner",
        relayUrl: RELAY_ORIGIN,
        runtimeAccessToken: userHosted ? "rat_browser_user_hosted_refreshed" : "rat_browser_cloud_refreshed",
        tokenExpiresAt: Date.now() + 120_000,
      })
      return
    }

    if (url.pathname === "/api/claxedo/events" || url.pathname === "/api/wr/events") {
      hits.controlPlaneEvents.push(hit)
      await route.fulfill({
        status: 200,
        contentType: "text/event-stream",
        headers: corsHeaders(),
        body: "data: {\"directory\":\"global\",\"payload\":{\"type\":\"server.connected\",\"properties\":{}}}\n\n",
      })
      return
    }

    if (/^\/api\/control\/sessions\/[^/]+\/messages$/.test(url.pathname)) {
      hits.controlPlaneSessionMessages.push(hit)
      await json(route, {
        messages: [{
          info: {
            id: "msg_control_signed",
            sessionID: url.pathname.split("/")[4],
            role: "user",
            time: { created: 1_700_000_000_100 },
          },
          parts: [{
            id: "part_control_signed",
            sessionID: url.pathname.split("/")[4],
            messageID: "msg_control_signed",
            type: "text",
            text: "Signed Control Plane replay message",
          }],
        }],
      })
      return
    }

    if (/^\/api\/control\/sessions\/[^/]+\/capabilities$/.test(url.pathname)) {
      hits.controlPlaneSessionCapabilities.push(hit)
      await json(route, {
        transport: "claude-acp",
        abort: true,
        reconnect: true,
        replay: true,
        permissions: false,
        questions: false,
        todos: false,
        commands: false,
        fork: true,
        revert: false,
        unrevert: false,
        configOptions: false,
      })
      return
    }

    if (/^\/api\/control\/sessions\/[^/]+\/gateway$/.test(url.pathname)) {
      await json(route, {
        gatewayUrl: null,
      })
      return
    }

    if (/^\/api\/claxedo\/session\/[^/]+\/meta$/.test(url.pathname)) {
      const sessionID = url.pathname.split("/")[4]
      const userHosted = sessionID === "cp-user-hosted-1"
      await json(route, {
        sessionID,
        title: userHosted ? "User-hosted session" : "Cloud session",
        directory: userHosted ? SIGNED_USER_HOSTED_DIR : SIGNED_WORKSPACE_DIR,
        workspaceId: userHosted ? USER_HOSTED_WORKSPACE_ID : WORKSPACE_ID,
        tags: [],
        attachments: [],
      })
      return
    }

    if (url.pathname === "/api/control/session-list") {
      hits.controlPlaneSessionLists.push(hit)
      const workspaceId = url.searchParams.get("workspaceId")
      const rows = [
        {
          type: "session",
          sessionRef: `workspace:${WORKSPACE_ID}:session:cp-cloud-1`,
          sessionId: "cp-cloud-1",
          title: "Cloud session",
          directory: SIGNED_WORKSPACE_DIR,
          workspaceId: WORKSPACE_ID,
          projectId: "proj_cloud",
          createdAt: 1,
          updatedAt: 2,
          tags: [],
          attachments: [],
        },
        {
          type: "session",
          sessionRef: `workspace:${USER_HOSTED_WORKSPACE_ID}:session:cp-user-hosted-1`,
          sessionId: "cp-user-hosted-1",
          title: "User-hosted session",
          directory: SIGNED_USER_HOSTED_DIR,
          workspaceId: USER_HOSTED_WORKSPACE_ID,
          projectId: "proj_cloud",
          createdAt: 3,
          updatedAt: 4,
          tags: [],
          attachments: [],
        },
      ].filter((item) => !workspaceId || item.workspaceId === workspaceId)
      await json(route, {
        view: {
          scope: url.searchParams.get("scope") ?? "project",
          groupBy: url.searchParams.get("groupBy") ?? "none",
          sort: "updated_desc",
          limit: Number(url.searchParams.get("limit") ?? "5"),
        },
        items: rows,
        totalKnown: rows.length,
      })
      return
    }

    if (url.pathname === "/api/workspace" && url.searchParams.get("access") === "cloud") {
      hits.controlPlaneWorkspaceLists.push(hit)
      await json(route, {
        workspaces: [{
          workspace_id: WORKSPACE_ID,
          project_id: "proj_cloud",
          backing: "cloud-vm",
          access: "cloud",
          display_name: "Cloud workspace",
        }],
      })
      return
    }

    if (url.pathname === "/api/workspace" && url.searchParams.get("access") === "user-hosted") {
      hits.controlPlaneWorkspaceLists.push(hit)
      await json(route, {
        workspaces: [{
          workspace_id: USER_HOSTED_WORKSPACE_ID,
          project_id: "proj_cloud",
          backing: "local-worktree",
          access: "user-hosted",
          display_name: "Shared local workspace",
        }],
      })
      return
    }

    if (url.pathname === "/api/control/sessions") {
      const workspaceId = url.searchParams.get("workspaceId")
      hits.controlPlaneSessionLists.push(hit)
      await json(route, {
        sessions: workspaceId === USER_HOSTED_WORKSPACE_ID
          ? [{
            session_id: "cp-user-hosted-1",
            title: "User-hosted session",
            created_at: 3,
            updated_at: 4,
          }]
          : [{
            session_id: "cp-cloud-1",
            title: "Cloud session",
            created_at: 1,
            updated_at: 2,
          }],
      })
      return
    }

    if (url.pathname === "/api/workspace/resolve") {
      const directory = url.searchParams.get("directory")
      const workspaceId = url.searchParams.get("workspaceId")
      const userHosted = directory === SIGNED_USER_HOSTED_DIR || workspaceId === USER_HOSTED_WORKSPACE_ID
      await json(route, {
        workspaceId: userHosted ? USER_HOSTED_WORKSPACE_ID : WORKSPACE_ID,
        directory: DIR,
        kind: userHosted ? "user-hosted" : "cloud",
        status: "ready",
      })
      return
    }

    if (url.pathname === "/health" || url.pathname === "/global/health" || url.pathname === "/api/claxedo/health") {
      await json(route, { healthy: true, version: "1.0.0-test" })
      return
    }

    if (url.pathname === "/api/claxedo/bootstrap") {
      hits.knownCompatBootstrap.push(hit)
      await json(route, {
        healthy: true,
        version: "1.0.0-test",
        path: { state: "", config: "", worktree: SIGNED_WORKSPACE_DIR, directory: SIGNED_WORKSPACE_DIR, home: "" },
        project: [{
          id: "proj_cloud",
          name: "cloud-runtime",
          worktree: SIGNED_WORKSPACE_DIR,
          sandboxes: [SIGNED_WORKSPACE_DIR, SIGNED_USER_HOSTED_DIR],
          workspaces: {
            [SIGNED_WORKSPACE_DIR]: {
              id: WORKSPACE_ID,
              kind: "cloud",
              workspace_name: "main",
              directory: SIGNED_WORKSPACE_DIR,
            },
            [SIGNED_USER_HOSTED_DIR]: {
              id: USER_HOSTED_WORKSPACE_ID,
              kind: "user-hosted",
              workspace_name: "shared",
              directory: SIGNED_USER_HOSTED_DIR,
            },
          },
        }],
        provider: {
          all: [
            {
              id: "claude-acp",
              name: "Claude",
              models: {
                "claude-sonnet-4-6": {
                  id: "claude-sonnet-4-6",
                  name: "Sonnet 4.6",
                  providerID: "claude-acp",
                },
              },
            },
          ],
          default: { "claude-acp": "claude-sonnet-4-6" },
          connected: [],
        },
        provider_auth: { "claude-acp": [{ type: "api", label: "API key" }] },
        config: {},
        workspaceMode: "cloud",
        remoteAccess: {
          enabled: true,
        },
      })
      return
    }

    if (url.pathname === "/api/claxedo/events") {
      hits.localControlPlaneEvents.push(hit)
      await route.fulfill({
        status: 200,
        contentType: "text/event-stream",
        headers: corsHeaders(),
        body: "data: {}\n\n",
      })
      return
    }

    if (url.pathname === "/path" || url.pathname === "/project/current" || url.pathname === "/config") {
      hits.forbiddenOldRuntime.push(hit)
      await json(route, { error: "old directory bootstrap path used" }, 599)
      return
    }

    if (url.pathname === "/project/proj_cloud" && request.method() === "PATCH") {
      hits.forbiddenOldRuntime.push(hit)
      await json(route, { error: "old project metadata path used" }, 599)
      return
    }

    if (url.pathname === "/project") {
      hits.forbiddenOldRuntime.push(hit)
      await json(route, { error: "old project list path used" }, 599)
      return
    }

    if (url.pathname === "/global/config") {
      hits.forbiddenOldRuntime.push(hit)
      await json(route, { error: "old global config path used" }, 599)
      return
    }

    if (url.pathname === "/app/agents") {
      hits.forbiddenOldRuntime.push(hit)
      await json(route, { error: "old app agent discovery path used" }, 599)
      return
    }

    if (url.pathname === "/agent") {
      hits.forbiddenOldRuntime.push(hit)
      await json(route, { error: "old agent discovery path used" }, 599)
      return
    }

    if (url.pathname === "/command") {
      hits.forbiddenOldRuntime.push(hit)
      await json(route, { error: "old command discovery path used" }, 599)
      return
    }

    if (url.pathname === "/mcp") {
      hits.forbiddenOldRuntime.push(hit)
      await json(route, { error: "old MCP status path used" }, 599)
      return
    }

    if (url.pathname === "/lsp") {
      hits.forbiddenOldRuntime.push(hit)
      await json(route, { error: "old LSP status path used" }, 599)
      return
    }

    if (url.pathname === "/vcs") {
      hits.forbiddenOldRuntime.push(hit)
      await json(route, { error: "old VCS status path used" }, 599)
      return
    }

    if (url.pathname === "/find" || url.pathname === "/find/file" || url.pathname.startsWith("/find/")) {
      hits.forbiddenOldRuntime.push(hit)
      await json(route, { error: "old file search path used" }, 599)
      return
    }

    if (url.pathname === "/file" || url.pathname === "/file/status" || url.pathname === "/file/content" || url.pathname.startsWith("/file/")) {
      hits.forbiddenOldRuntime.push(hit)
      await json(route, { error: "old file runtime path used" }, 599)
      return
    }

    if (url.pathname === "/status") {
      hits.forbiddenOldRuntime.push(hit)
      await json(route, { error: "old status path used" }, 599)
      return
    }

    if (url.pathname === "/provider" || url.pathname === "/provider/auth" || url.pathname === "/config/providers") {
      hits.forbiddenOldRuntime.push(hit)
      await json(route, { error: "old provider config path used" }, 599)
      return
    }

    if (url.pathname === "/api/claxedo/agent-config/harness") {
      await json(route, { type: "opencode", model: "big-pickle", status: "ready", ready: true })
      return
    }

    if (url.pathname.startsWith("/api/claxedo/agent-config/harness/")) {
      await json(route, [])
      return
    }

    if (url.pathname.startsWith("/api/claxedo/hook")) {
      hits.forbiddenOldRuntime.push(hit)
      await json(route, { error: "old hook runtime path used" }, 599)
      return
    }

    hits.unhandledApi.push(hit)
    await json(route, { error: "unhandled signed browser API request" }, 598)
  })
}

async function ready(page: Page, hits: Hits) {
  await page.goto(`/${slug(SIGNED_WORKSPACE_DIR)}/session`)
  await page.waitForLoadState("domcontentloaded")
  try {
    await expect(page.locator("[data-claxedo]")).toBeVisible({ timeout: 30_000 })
  } catch (err) {
    throw new Error(`${err instanceof Error ? err.message : String(err)}

Unhandled API requests:
${hits.unhandledApi.map((hit) => `${hit.method} ${hit.url}`).join("\n") || "(none)"}

Unexpected relay runtime requests:
${hits.unexpectedRelayRuntime.map((hit) => `${hit.method} ${hit.url}`).join("\n") || "(none)"}

Failed requests:
${hits.failed.join("\n") || "(none)"}

Console/page errors:
${hits.console.join("\n") || "(none)"}`)
  }
}

async function openWorkspaceNavigator(page: Page, navigator: "Files" | "Changes" | "Processes") {
  const openPanel = page.getByRole("button", { name: "Open workspace panel", exact: true }).first()
  if (await openPanel.isVisible({ timeout: 1_000 }).catch(() => false)) {
    await openPanel.click({ timeout: 5_000 }).catch(() => {})
  }
  if (!await page.getByRole("button", { name: `Open ${navigator}`, exact: true }).first().isVisible().catch(() => false)) {
    await page.getByRole("button", { name: "New Session" }).first().click()
    await expect(page.getByRole("textbox", { name: /Ask anything/i })).toBeVisible({ timeout: 10_000 })
    if (await page.getByRole("button", { name: "Open workspace panel", exact: true }).isVisible().catch(() => false)) {
      await page.getByRole("button", { name: "Open workspace panel", exact: true }).click()
    }
  }
  await expect(page.getByRole("button", { name: `Open ${navigator}`, exact: true }).last()).toBeVisible({ timeout: 10_000 })
  await page.getByRole("button", { name: `Open ${navigator}`, exact: true }).last().click()
}

async function openProcessPanel(page: Page) {
  await openWorkspaceNavigator(page, "Processes")
  await expect(page.getByRole("button", { name: "Add process" }).first()).toBeVisible({ timeout: 10_000 })
}

async function openChangesPanel(page: Page) {
  await openWorkspaceNavigator(page, "Changes")
}

async function openFilesPanel(page: Page) {
  await openWorkspaceNavigator(page, "Files")
}

async function openPrompt(page: Page) {
  if (await page.getByRole("textbox", { name: /Ask anything/i }).isVisible().catch(() => false)) return
  await page.getByRole("button", { name: "New Session" }).first().click()
  await expect(page.getByRole("textbox", { name: /Ask anything/i })).toBeVisible({ timeout: 10_000 })
}

async function selectRuntimeModel(page: Page) {
  if (await page.getByRole("button", { name: /Big Pickle/i }).isVisible().catch(() => false)) return
  await page.locator('[data-action="prompt-model"]').last().click()
  await page.locator('[data-slot="list-item"][data-key="opencode:big-pickle"]').click()
}

function expectNoFallbacks(hit: Hits) {
  expect(hit.forbiddenOldRuntime).toEqual([])
  expect(hit.unexpectedRelayRuntime).toEqual([])
  expect(hit.unhandledApi).toEqual([])
  expect(hit.failed).toEqual([])
  const allowedCompat = new Set([
    "/api/claxedo/bootstrap",
  ])
  expect([...new Set(hit.knownCompatBootstrap.map((item) => new URL(item.url).pathname))]
    .filter((pathname) => !allowedCompat.has(pathname))).toEqual([])
  const allowedLocalControlPlaneEvents = new Set([
    "/api/claxedo/events",
  ])
  expect([...new Set(hit.localControlPlaneEvents.map((item) => new URL(item.url).pathname))]
    .filter((pathname) => !allowedLocalControlPlaneEvents.has(pathname))).toEqual([])
  expect(hit.localControlPlaneEvents.filter((item) => item.authorization !== "Bearer signed-browser-token")).toEqual([])
  expect(hit.controlPlaneSessionCapabilities.filter((item) => item.authorization !== "Bearer signed-browser-token")).toEqual([])
}

function expectNoWorkspaceRuntimeFallbacks(hit: Hits) {
  expect(hit.forbiddenOldRuntime.filter((item) => {
    const pathname = new URL(item.url).pathname
    return (!pathname.startsWith("/api/claxedo/agent-config/") && pathname.startsWith("/api/claxedo/")) ||
      pathname === "/mcp" ||
      pathname === "/lsp" ||
      pathname === "/vcs" ||
      pathname === "/file" ||
      pathname.startsWith("/file/") ||
      pathname === "/find" ||
      pathname.startsWith("/find/")
  })).toEqual([])
  expect(hit.unexpectedRelayRuntime).toEqual([])
  expect(hit.unhandledApi).toEqual([])
  expect(hit.failed.filter((item) => !expectedEventStreamAbort(item))).toEqual([])
}

function expectedEventStreamAbort(item: string) {
  if (!item.endsWith(" net::ERR_ABORTED")) return false
  const url = item.match(/^GET (\S+) net::ERR_ABORTED$/)?.[1]
  if (!url) return false
  const pathname = new URL(url).pathname
  return pathname === "/api/wr/events" ||
    pathname === "/api/wr/runtime-events" ||
    pathname.endsWith("/api/wr/events") ||
    pathname.endsWith("/api/wr/runtime-events") ||
    pathname.endsWith("/global/event")
}

function expectObservedSignedControlPlaneAuth(hit: Hits) {
  expect([
    ...hit.connections,
    ...hit.controlPlaneWorkspaceLists,
    ...hit.controlPlaneSessionMessages,
    ...hit.controlPlaneSessionCapabilities,
  ].filter((item) => new URL(item.url).host === "127.0.0.1:3001")
    .filter((item) => item.authorization !== "Bearer signed-browser-token")).toEqual([])
}

test.describe("cloud runtime browser routing", () => {
  test("process panel uses Workspace Relay for cloud runtime requests", async ({ page }) => {
    const hit = hits()
    await seed(page)
    await setup(page, hit)
    await ready(page, hit)
    hit.forbiddenOldRuntime.splice(0)

    await openWorkspaceNavigator(page, "Processes")
    await expect.poll(() => hit.relayRuntime.map((item) => `${item.method} ${new URL(item.url).pathname}`), {
      timeout: 10_000,
    }).toContain(`GET /workspaces/${WORKSPACE_ID}/api/wr/process`)

    expectNoWorkspaceRuntimeFallbacks(hit)
    expect(hit.relayRuntime.map((item) => `${item.method} ${new URL(item.url).pathname}`)).toContain(
      `GET /workspaces/${WORKSPACE_ID}/api/wr/process`,
    )
    expect(hit.relayRuntime.map((item) => new URL(item.url).pathname)).toContain(`/workspaces/${WORKSPACE_ID}/vcs`)
  })

  test("user-hosted session runtime requests are routed through Workspace Relay", async ({ page }) => {
    const hit = hits()
    await seed(page)
    await setup(page, hit)

    await ready(page, hit)
    await page.getByRole("button", { name: /User-hosted session/ }).first().click()
    await expect(page).toHaveURL(/(?:\/s\/cp-user-hosted-1|\/w\/[^/]+\/session\/cp-user-hosted-1)/)
    const connectionDebug = async () => `connections:\n${
      JSON.stringify(await page.evaluate((workspaceId) => {
        const inspector = (window as typeof window & {
          __claxedoConnections?: { snapshot?: () => Record<string, unknown> }
        }).__claxedoConnections
        return inspector?.snapshot?.()[workspaceId]
      }, USER_HOSTED_WORKSPACE_ID), null, 2)
    }\n\nrelay:\n${hit.relayRuntime.map((item) => `${item.method} ${item.url}`).join("\n") || "(none)"}`
    await expect.poll(async () => await page.evaluate((workspaceId) => {
      const inspector = (window as typeof window & {
        __claxedoConnections?: { snapshot?: () => Record<string, { status?: unknown }> }
      }).__claxedoConnections
      return inspector?.snapshot?.()[workspaceId]?.status
    }, USER_HOSTED_WORKSPACE_ID), {
      message: await connectionDebug(),
      timeout: 15_000,
    }).toBe("ready")
    await openWorkspaceNavigator(page, "Processes")
    await expect.poll(() => hit.relayRuntime.map((item) => `${item.method} ${new URL(item.url).pathname}`), {
      timeout: 10_000,
    }).toContain(`GET /workspaces/${USER_HOSTED_WORKSPACE_ID}/api/wr/process`)

    expectNoWorkspaceRuntimeFallbacks(hit)
    expect(hit.relayRuntime.map((item) => `${item.method} ${new URL(item.url).pathname}`)).toContain(
      `GET /workspaces/${USER_HOSTED_WORKSPACE_ID}/api/wr/process`,
    )
  })

  test("viewer runtime write UI stays read-only without local fallback", async ({ page }) => {
    const hit = hits()
    await seed(page)
    await setup(page, hit, { relayRole: "viewer" })
    await ready(page, hit)

    await openWorkspaceNavigator(page, "Processes")
    await expect(page.getByRole("button", { name: "Add process" })).toHaveCount(0)

    await expect.poll(() => hit.relayRuntime.some((item) =>
      item.method === "POST" && new URL(item.url).pathname === `/workspaces/${WORKSPACE_ID}/api/claxedo/process`,
    )).toBe(false)
    await expect.poll(() => hit.unexpectedRelayRuntime.some((item) =>
      item.method === "POST" && new URL(item.url).pathname === `/workspaces/${WORKSPACE_ID}/api/wr/process`,
    )).toBe(false)
    await expect.poll(() => hit.relayRuntime.some((item) =>
      item.method === "POST" && new URL(item.url).pathname === `/workspaces/${WORKSPACE_ID}/api/wr/process`,
    )).toBe(false)

    expect(hit.forbiddenOldRuntime.filter((item) => new URL(item.url).pathname.startsWith("/api/claxedo/"))).toEqual([])
  })

  test("terminal creation uses Workspace Relay for cloud runtimes", async ({ page }) => {
    const hit = hits()
    await seed(page)
    await setup(page, hit)
    await ready(page, hit)

    await page.getByRole("button", { name: "New Claude Terminal" }).first().click()
    await expect.poll(() => hit.relayRuntime.some((item) =>
      item.method === "POST" && new URL(item.url).pathname === `/workspaces/${WORKSPACE_ID}/api/wr/pty`,
    )).toBe(true)
    await expect(page.getByRole("textbox", { name: "Terminal input" })).toBeVisible({ timeout: 10_000 })

    expectNoWorkspaceRuntimeFallbacks(hit)
  })

  test("changes panel uses Workspace Relay for cloud diff requests", async ({ page }) => {
    const hit = hits()
    await seed(page)
    await setup(page, hit)
    await ready(page, hit)

    await openChangesPanel(page)
    await expect(page.locator(`[data-review-file="${DIFF_FILE}"]`)).toBeVisible({ timeout: 15_000 })
    await expect(page.getByText("export const value = 2")).toBeVisible({ timeout: 10_000 })

    expectNoWorkspaceRuntimeFallbacks(hit)
    expect(hit.relayRuntime.map((item) => `${item.method} ${new URL(item.url).pathname}`)).toContain(
      `GET /workspaces/${WORKSPACE_ID}/api/wr/diff/vcs`,
    )
    expect(hit.relayRuntime.map((item) => `${item.method} ${new URL(item.url).pathname}`)).toContain(
      `GET /workspaces/${WORKSPACE_ID}/api/wr/diff/vcs/file`,
    )
  })

  test("files panel lists and reads files through Workspace Relay for cloud runtimes", async ({ page }) => {
    const hit = hits()
    await seed(page)
    await setup(page, hit)
    await ready(page, hit)

    await openFilesPanel(page)
    await page.getByRole("button", { name: /runtime-file\.md/ }).click()
    await expect(page.getByText("Cloud file routed through relay")).toBeVisible({ timeout: 10_000 })

    expectNoWorkspaceRuntimeFallbacks(hit)
    for (const path of ["/file/status", "/file", "/file/content"]) {
      expect(hit.relayRuntime.map((item) => new URL(item.url).pathname)).toContain(`/workspaces/${WORKSPACE_ID}${path}`)
    }
  })

  test("file picker search uses Workspace Relay for cloud runtimes", async ({ page }) => {
    const hit = hits()
    await seed(page)
    await setup(page, hit)
    await ready(page, hit)

    await openChangesPanel(page)
    await page.getByRole("button", { name: "Add workspace tab" }).click()
    await page.getByRole("menuitem", { name: "File" }).click()
    await page.getByRole("textbox", { name: "Search files" }).fill("runtime")
    await page.getByRole("dialog").getByRole("button", { name: /runtime-file\.md/ }).click()
    await expect(page.getByText("Cloud file routed through relay")).toBeVisible({ timeout: 10_000 })

    expectNoFallbacks(hit)
    expectObservedSignedControlPlaneAuth(hit)
    expect(hit.relayRuntime.map((item) => new URL(item.url).pathname)).toContain(`/workspaces/${WORKSPACE_ID}/find/file`)
    expect(hit.relayRuntime.map((item) => new URL(item.url).pathname)).toContain(`/workspaces/${WORKSPACE_ID}/file/content`)
  })

  test("expired cloud Runtime Access Token does not fall back from loopback workspace proxy", async ({ page }) => {
    const hit = hits()
    await seed(page)
    await setup(page, hit, { initialTokenExpiresAt: Date.now() + 500 })
    await ready(page, hit)

    await openWorkspaceNavigator(page, "Processes")
    await expect.poll(() => hit.relayRuntime.map((item) => `${item.method} ${new URL(item.url).pathname}`), {
      timeout: 10_000,
    }).toContain(`GET /workspaces/${WORKSPACE_ID}/api/wr/process`)

    expectNoFallbacks(hit)
    expectObservedSignedControlPlaneAuth(hit)
    expect(hit.refreshes).toEqual([])
    expect(runtimeHits(hit, { workspaceId: WORKSPACE_ID, path: "/vcs", method: "GET" }).length).toBeGreaterThan(0)
  })

  test.skip("signed cloud prompt submit posts through Workspace Relay", async ({ page }) => {
    const hit = hits()
    await seed(page)
    await setup(page, hit)
    await page.goto(`/${slug(SIGNED_WORKSPACE_DIR)}/session/cp-cloud-1`)
    await page.waitForLoadState("domcontentloaded")
    await expect(page).toHaveURL(/\/session\/cp-cloud-1/)
    await expect(page.getByText("Signed Control Plane replay message")).toBeVisible({ timeout: 10_000 })
    await selectRuntimeModel(page)
    await page.getByRole("textbox", { name: /Ask anything/i }).last().fill("send through relay")
    await expect(page.locator('[data-action="prompt-submit"]').last()).toBeEnabled({ timeout: 10_000 })
    await page.locator('[data-action="prompt-submit"]').last().click()
    await expect.poll(() => hit.relayRuntime.some((item) =>
      item.method === "POST" && new URL(item.url).pathname === `/workspaces/${WORKSPACE_ID}/session/cp-cloud-1/prompt_async`,
    )).toBe(true)

    expectNoFallbacks(hit)
    expectObservedSignedControlPlaneAuth(hit)
  })

  test.skip("signed session replay renders from DB and reconnects to live Control Plane events without duplicate render", async ({ page }) => {
    const hit = hits()
    await seed(page)
    await setup(page, hit)
    await ready(page, hit)
    await page.goto(`/${slug(SIGNED_WORKSPACE_DIR)}/session/cp-cloud-1`)
    await page.waitForLoadState("domcontentloaded")
    await expect(page).toHaveURL(/\/session\/cp-cloud-1/)
    const messageRequestDebug = () => `signed session message requests:\n${
      runtimeHits(hit, {
        workspaceId: WORKSPACE_ID,
        path: "/session/cp-cloud-1/message",
        method: "GET",
      }).map((item) => item.url).join("\n") || "(none)"
    }\n\nunhandled:\n${hit.unhandledApi.map((item) => `${item.method} ${item.url}`).join("\n") || "(none)"}`
    await expect.poll(() => runtimeHits(hit, {
      workspaceId: WORKSPACE_ID,
      path: "/session/cp-cloud-1/message",
      method: "GET",
    }).length, {
      message: messageRequestDebug(),
    }).toBeGreaterThan(0)
    await expect(page.getByText("Signed Control Plane replay message")).toBeVisible({ timeout: 10_000 })
    await expect.poll(() => runtimeHits(hit, {
      workspaceId: WORKSPACE_ID,
      path: "/api/wr/events",
      method: "GET",
    }).length).toBeGreaterThan(0)
    await expect(page.getByText("Signed Control Plane replay message")).toHaveCount(1)

    await page.reload()
    await expect(page.locator('[data-message-id="msg_control_signed"]')).toBeVisible({ timeout: 30_000 })
    await expect(page.getByText("Signed Control Plane replay message")).toHaveCount(1)
    await expect.poll(() => runtimeHits(hit, {
      workspaceId: WORKSPACE_ID,
      path: "/session/cp-cloud-1/message",
      method: "GET",
    }).length).toBeGreaterThan(1)
    await expect.poll(() => runtimeHits(hit, {
      workspaceId: WORKSPACE_ID,
      path: "/api/wr/events",
      method: "GET",
    }).length).toBeGreaterThan(1)

    hit.failed.splice(0, hit.failed.length, ...hit.failed.filter((item) => !item.endsWith(" net::ERR_ABORTED")))
    expectNoWorkspaceRuntimeFallbacks(hit)
    expect(runtimeHits(hit, {
      workspaceId: WORKSPACE_ID,
      path: "/session/cp-cloud-1/capabilities",
      method: "GET",
    }).length).toBeGreaterThan(0)
  })
})
