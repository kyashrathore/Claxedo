import { createEffect, createMemo, createRoot, on, runWithOwner } from "solid-js"
import type { PluginApi, WorkspaceStartResult } from "@claxedo/plugin-api"
import { useWakeProgress } from "@/cloud"
import { placementId, type PlacementId } from "@/server"
import { usePluginsText } from "../i18n"
import type { BindingScope } from "./services"

function reportProgress(scope: BindingScope, id: PlacementId, onProgress: (text: string | undefined) => void): () => void {
  const { owner, server } = scope.services
  return createRoot((dispose) => {
    const text = createMemo(useWakeProgress(() => server.cloud.runtime(id)))
    createEffect(on(text, (current, previous) => {
      if (current !== previous) onProgress(current)
    }))
    return dispose
  }, owner)
}

export function workspacesBinding(scope: BindingScope): PluginApi["workspaces"] {
  const { owner, server } = scope.services
  return {
    followStart: async (workspaceId, onProgress): Promise<WorkspaceStartResult> => {
      const id = placementId(workspaceId)
      let stopReporting: (() => void) | undefined
      try {
        const run = await server.cloud.followStart(id, () => {
          stopReporting = reportProgress(scope, id, onProgress)
        })
        if (run.kind === "running") return { kind: "running" }
        return { kind: "failed", message: run.error?.message ?? runWithOwner(owner, usePluginsText)?.("plugins.workspaces.startFailed") ?? "" }
      } finally {
        stopReporting?.()
      }
    },
  }
}
