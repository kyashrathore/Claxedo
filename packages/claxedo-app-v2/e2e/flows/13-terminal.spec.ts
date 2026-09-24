import type { Page } from "@playwright/test"
import { expect, SCRIPTED_ACP_HARNESS, test } from "../harness"

const TERMINAL_URL = /\/w\/[^/]+\/t\/[^/?]+$/

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

test.skip(({ isMobile }) => isMobile, "flow 13 runs at desktop width")

test("13 terminal: run a command, its output replays from the server, reload reattaches, closing ends it", async ({
  stack,
  api,
  app,
}) => {
  const workspace = await stack.daemon.makeWorkspace("terminal", "Terminal")
  const session = await api.createSession(workspace.directory, { title: "Terminal", harness: SCRIPTED_ACP_HARNESS })

  await app.goto(`${stack.url}/w/${encodeURIComponent(workspace.id)}/s/${encodeURIComponent(session.id)}`)
  await expect(app.getByRole("tablist", { name: "Open panes" })).toBeVisible()
  await app.keyboard.press("ControlOrMeta+Shift+P")
  const palette = app.getByRole("dialog", { name: "Command palette" })
  await palette.getByRole("combobox", { name: "Command palette" }).fill("New terminal")
  await palette.getByRole("option", { name: /^New terminal/ }).click()

  const pane = app.getByRole("region", { name: "Terminal pane" })
  await expect(pane).toHaveAttribute("data-terminal-connection", "attached")
  await expect(app).toHaveURL(TERMINAL_URL)
  const terminalId = decodeURIComponent(new URL(app.url()).pathname.split("/").at(-1) ?? "")

  await pane.click()
  await app.keyboard.type("echo tools-e2e-$((6*7))")
  await app.keyboard.press("Enter")
  expect(await ptyReplay(app, workspace.directory, terminalId, "tools-e2e-42")).toContain("tools-e2e-42")

  await app.reload()
  await expect(app).toHaveURL(TERMINAL_URL)
  await expect(app.getByRole("region", { name: "Terminal pane" })).toHaveAttribute(
    "data-terminal-connection",
    "attached",
  )
  expect(await serverTerminalIds(stack.url, workspace.directory)).toContain(terminalId)

  await app.getByRole("tablist", { name: "Open panes" }).getByRole("tab", { name: "Terminal 1" }).press("Delete")
  await expect(app.getByRole("region", { name: "Terminal pane" })).toHaveCount(0)
  await expect.poll(() => serverTerminalIds(stack.url, workspace.directory)).not.toContain(terminalId)
})
