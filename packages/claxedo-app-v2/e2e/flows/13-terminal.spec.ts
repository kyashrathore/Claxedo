import type { Page } from "@playwright/test"
import { expect, sessionRoute, test, UI } from "../harness"

const TERMINAL_URL = /\/w\/[^/]+\/terminal\/pty_[^/?]+$/

async function serverTerminalIds(serverUrl: string, directory: string): Promise<readonly string[]> {
  const url = new URL("/api/wr/pty", serverUrl)
  url.searchParams.set("directory", directory)
  const response = await fetch(url)
  expect(response.status).toBe(200)
  const rows = (await response.json()) as readonly { readonly id: string }[]
  return rows.map((row) => row.id)
}

type ReplayInput = { readonly path: string; readonly marker: string }

async function ptyReplay(app: Page, directory: string, terminalId: string, marker: string): Promise<string> {
  const path = `/api/wr/pty/${encodeURIComponent(terminalId)}/connect?cursor=0&directory=${encodeURIComponent(directory)}`
  return await app.evaluate(
    (input: ReplayInput) =>
      new Promise<string>((resolve, reject) => {
        const url = new URL(input.path, window.location.href)
        url.protocol = url.protocol === "https:" ? "wss:" : "ws:"
        const socket = new WebSocket(url)
        socket.binaryType = "arraybuffer"
        const decoder = new TextDecoder()
        let output = ""
        const metaScreen = (bytes: Uint8Array) => {
          const meta: unknown = JSON.parse(new TextDecoder().decode(bytes.subarray(1)))
          const checkpoint = typeof meta === "object" && meta !== null ? Reflect.get(meta, "checkpoint") : undefined
          const screen =
            typeof checkpoint === "object" && checkpoint !== null ? Reflect.get(checkpoint, "screen") : undefined
          return typeof screen === "string" ? screen : ""
        }
        socket.onmessage = (event: MessageEvent<unknown>) => {
          if (typeof event.data === "string") output += event.data
          else if (event.data instanceof ArrayBuffer) {
            const bytes = new Uint8Array(event.data)
            output += bytes[0] === 0 ? metaScreen(bytes) : decoder.decode(bytes, { stream: true })
          }
          if (!output.includes(input.marker)) return
          socket.close()
          resolve(output)
        }
        socket.onclose = (event) => {
          if (!output.includes(input.marker))
            reject(new Error(`PTY closed with ${event.code} before the marker: ${output.slice(-200)}`))
        }
      }),
    { path, marker },
  )
}

function terminalPane(app: Page, terminalId: string) {
  return app.locator(`[data-testid="terminal-pane"][data-terminal-id="${terminalId}"]`)
}

function compactTabs(app: Page) {
  return app.getByRole("navigation", { name: "Workbench panes" }).getByTestId("compact-switcher-tab")
}

async function newShell(app: Page): Promise<string> {
  await app.getByRole("button", { name: "New Terminal", exact: true }).click()
  await app.getByRole("button", { name: /^Shell\b/ }).click()
  await expect(app).toHaveURL(TERMINAL_URL)
  return decodeURIComponent(new URL(app.url()).pathname.split("/").at(-1) ?? "")
}

test.skip(({ isMobile }) => isMobile, "flow 13 runs at desktop width")

test("13 terminal: run a command, its output replays from the server, reload reattaches, closing leaves the draft", async ({ stack, app }) => {
  const workspace = await stack.daemon.makeWorkspace("terminal", "Terminal")

  await app.goto(`${stack.url}${sessionRoute(workspace.id)}`)
  const terminalId = await newShell(app)
  await expect(terminalPane(app, terminalId)).toHaveAttribute("data-terminal-connected", "true")

  await app.getByRole("textbox", { name: "Terminal input" }).focus()
  await app.keyboard.type("echo tools-e2e-$((6*7))")
  await app.keyboard.press("Enter")
  expect(await ptyReplay(app, workspace.directory, terminalId, "tools-e2e-42")).toContain("tools-e2e-42")

  await app.reload()
  await expect(app).toHaveURL(TERMINAL_URL)
  await expect(terminalPane(app, terminalId)).toHaveAttribute("data-terminal-connected", "true")
  expect(await serverTerminalIds(stack.url, workspace.directory)).toContain(terminalId)

  await app.getByRole("button", { name: /^Close terminal: / }).click()
  await expect(terminalPane(app, terminalId)).toHaveCount(0)
  await expect(app.getByRole("button", { name: /^Close terminal: / })).toHaveCount(0)
  await expect(app.getByRole("button", { name: UI.sendIdle })).toBeVisible()
  if (stack.app === "v2") {
    await test.step("v2 approved: closing a terminal ends its PTY (DECISIONS 18:25)", async () => {
      await expect(app).not.toHaveURL(TERMINAL_URL)
      await expect.poll(() => serverTerminalIds(stack.url, workspace.directory)).not.toContain(terminalId)
    })
  }
})

test("13 terminal: a terminal closed in the rail or dead after a restart leaves the compact tabs too", async ({ stack, app }) => {
  const workspace = await stack.daemon.makeWorkspace("terminal", "Terminal")
  await app.goto(`${stack.url}${sessionRoute(workspace.id)}`)

  await newShell(app)
  await app.getByRole("button", { name: /^Close terminal: / }).click()
  await expect(app.getByRole("button", { name: /^Close terminal: / })).toHaveCount(0)
  await app.getByRole("button", { name: "Hide Sidebar" }).click()
  await expect(compactTabs(app).first()).toBeVisible()
  await expect(compactTabs(app).filter({ hasText: /Terminal/ })).toHaveCount(0)
  await app.getByRole("button", { name: "Show Sidebar" }).click()

  const deadId = await newShell(app)
  await app.goto("about:blank")
  const url = new URL(`/api/wr/pty/${encodeURIComponent(deadId)}`, stack.url)
  url.searchParams.set("directory", workspace.directory)
  expect((await fetch(url, { method: "DELETE" })).ok).toBe(true)
  await app.goto(`${stack.url}${sessionRoute(workspace.id)}`)
  await expect(app.getByRole("button", { name: "Hide Sidebar" })).toBeVisible()
  await expect(app.getByRole("button", { name: /^Close terminal: / })).toHaveCount(0)
  await app.getByRole("button", { name: "Hide Sidebar" }).click()
  await expect(compactTabs(app).first()).toBeVisible()
  await expect(compactTabs(app).filter({ hasText: /Terminal/ })).toHaveCount(0)
})
