import { Hono } from "hono"
import type { WSContext } from "hono/ws"
import type { UpgradeWebSocket } from "hono/ws"
import { Pty } from "../pty/index"

export function PtyRoutes(upgradeWebSocket: UpgradeWebSocket) {
  return new Hono()
    .get("/", async (c) => {
      return c.json(Pty.list())
    })
    .post("/", async (c) => {
      const body = await c.req.json().catch(() => null)
      const parsed = Pty.CreateInput.safeParse(body)
      if (!parsed.success) {
        return c.json({ error: "Invalid input", details: parsed.error.flatten() }, 400)
      }
      // Strip `managed` — only the process manager (internal caller) may set it
      const { managed: _, ...input } = parsed.data
      const workspaceId = c.req.header("x-workspace-id")
      const directory = c.req.header("x-opencode-directory")
      const info = await Pty.create({
        ...input,
        ...(directory && !input.cwd ? { cwd: directory } : {}),
        env: {
          ...(input.env ?? {}),
          ...(workspaceId ? { CLAXEDO_WORKSPACE_ID: workspaceId } : {}),
        },
      })
      return c.json(info)
    })
    .get("/:ptyID", async (c) => {
      const id = c.req.param("ptyID")
      const info = Pty.get(id)
      if (!info) return c.json({ error: "Session not found" }, 404)
      return c.json(info)
    })
    .put("/:ptyID", async (c) => {
      const id = c.req.param("ptyID")
      const body = await c.req.json().catch(() => null)
      const parsed = Pty.UpdateInput.safeParse(body)
      if (!parsed.success) {
        return c.json({ error: "Invalid input", details: parsed.error.flatten() }, 400)
      }
      const info = await Pty.update(id, parsed.data)
      if (!info) return c.json({ error: "Session not found" }, 404)
      return c.json(info)
    })
    .delete("/:ptyID", async (c) => {
      const id = c.req.param("ptyID")
      await Pty.remove(id)
      return c.json(true)
    })
    .get(
      "/:ptyID/connect",
      upgradeWebSocket((c) => {
        const id = c.req.param("ptyID")!
        const cursor = (() => {
          const value = c.req.query("cursor")
          if (!value) return
          const parsed = Number(value)
          if (!Number.isSafeInteger(parsed) || parsed < -1) return
          return parsed
        })()
        let handler: ReturnType<typeof Pty.connect>

        type Socket = {
          readyState: number
          send: (data: string | Uint8Array | ArrayBuffer) => void
          close: (code?: number, reason?: string) => void
        }

        const isSocket = (value: unknown): value is Socket => {
          if (!value || typeof value !== "object") return false
          if (!("readyState" in value)) return false
          if (!("send" in value) || typeof (value as { send?: unknown }).send !== "function") return false
          if (!("close" in value) || typeof (value as { close?: unknown }).close !== "function") return false
          return typeof (value as { readyState?: unknown }).readyState === "number"
        }

        return {
          onOpen(_event: Event, ws: WSContext) {
            const socket = ws.raw
            if (!isSocket(socket)) {
              ws.close()
              return
            }
            handler = Pty.connect(id, socket as any, cursor)
          },
          onMessage(event: { data: unknown }) {
            if (typeof event.data !== "string") return
            handler?.onMessage(event.data)
          },
          onClose() {
            handler?.onClose()
          },
          onError() {
            handler?.onClose()
          },
        }
      }),
    )
}
