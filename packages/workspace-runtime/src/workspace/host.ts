import type { Hono } from "hono"
import type { RuntimeRunner, RuntimeSnapshot } from "../routes/config"
import type { WorkspaceCapabilities } from "../capabilities"

export type WorkspaceHost = {
  mount: (app: Hono) => void
  apply: (snapshot: RuntimeSnapshot) => Promise<void>
  detail: () => {
    state: "ready" | "applying" | "error"
    runner: RuntimeRunner
    error: string
    workspaceHarnessEnabled: boolean
  }
  capabilities: () => WorkspaceCapabilities
  dispose: () => void
}
