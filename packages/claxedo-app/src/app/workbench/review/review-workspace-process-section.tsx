import { Show, createEffect, createMemo } from "solid-js"

import { useProcessPane } from "@/app/workbench/context/process-pane"
import { AddProcessDialog, ProcessPanePanel } from "@/features/processes/ui"
import { RoleGuardedTerminal } from "@/features/terminal/core/role-guarded-terminal"
import { usePlatform } from "@/platform/runtime/platform-provider"
import { ClaxedoIcon as Icon } from "@/ui/controls/claxedo-icon"
import { useDialog } from "@opencode-ai/ui/context/dialog"

export function ReviewWorkspaceProcessSection(props: { processId: string; directory: string; active: boolean }) {
  const processPane = useProcessPane()
  const platform = usePlatform()
  const dialog = useDialog()
  const config = createMemo(() => processPane.configs().find((item) => item.id === props.processId))
  const process = createMemo(() => processPane.processForConfig(props.processId))
  const openEditDialog = () => {
    const hit = config()
    if (!hit) return
    dialog.show(() => (
      <AddProcessDialog
        directory={props.directory}
        request={platform.fetch}
        config={hit}
        onDone={() => processPane.refresh()}
      />
    ))
  }
  createEffect(
    () => [props.processId, processPane.loaded(), config()?.id] as const,
    ([processId, loaded, configId]) => {
      if (!processId || !loaded || configId) return
      void processPane.refresh()
    },
  )

  return (
    <Show
      when={config()}
      fallback={
        <div class="flex h-full flex-col items-center justify-center gap-3 text-text-weak">
          <Show
            when={processPane.loaded()}
            fallback={<div class="size-6 rounded-full border-2 border-text-weak border-t-transparent animate-spin" />}
          >
            <Icon name="console" size="medium" />
            <span class="text-sm">Process not found</span>
          </Show>
        </div>
      }
    >
      <ProcessPanePanel
        config={config()!}
        active={props.active}
        process={process()}
        onStart={() => processPane.start(props.processId)}
        onStop={() => processPane.stop(props.processId)}
        onRestart={() => processPane.restart(props.processId)}
        onResolveConflict={(strategy) => processPane.resolveConflict(props.processId, strategy)}
        onResolveRouteConflict={(strategy) => processPane.resolveRouteConflict(props.processId, strategy)}
        onEdit={openEditDialog}
        portalHeader={props.active}
        renderTerminal={(terminal) => <RoleGuardedTerminal pty={terminal} />}
      />
    </Show>
  )
}
