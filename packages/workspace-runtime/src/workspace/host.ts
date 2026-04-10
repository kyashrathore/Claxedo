import type { Hono } from "hono"
import type { RuntimeRunner, RuntimeSnapshot } from "../routes/config"

export type WorkspaceHost = {
  mount: (app: Hono) => void
  apply: (snapshot: RuntimeSnapshot) => Promise<void>
  detail: () => {
    state: "ready" | "applying" | "error"
    runner: RuntimeRunner
    error: string
  }
  dispose: () => void
}
