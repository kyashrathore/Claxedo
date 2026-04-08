import { Show, createEffect, createMemo } from "solid-js"
import { Select } from "@opencode-ai/ui/select"
import { useParams } from "@solidjs/router"
import { base64Decode } from "@opencode-ai/util/encode"
import { acpScope, useAcpConfig } from "@claxedo/claxedo-ui/context/acp-config"
import { useSessionParams } from "@claxedo/claxedo-ui/context/session-params"
import { useSync } from "@/context/sync"

interface AcpSelectorProps {
  triggerStyle?: Record<string, string | number>
}

export function AcpSelector(props: AcpSelectorProps) {
  const acp = useAcpConfig()
  const sync = useSync()
  const routeParams = useParams()
  let sessionParams: ReturnType<typeof useSessionParams> | undefined
  try {
    sessionParams = useSessionParams()
  } catch {
    /* not in split mode */
  }

  const sessionId = createMemo(() => sessionParams?.sessionId() ?? routeParams.id)
  const directory = createMemo(() => sessionParams?.directory() ?? (routeParams.dir ? base64Decode(routeParams.dir) : undefined))
  const scope = createMemo(() => acpScope({
    directory: directory(),
    sessionId: sessionId(),
    tabId: sessionParams?.tabId?.(),
  }))

  createEffect(() => {
    if (!directory()) return
    void acp.hydrate(scope(), {
      directory: directory(),
      sessionId: sessionId(),
    })
  })

  const liveAgent = createMemo(() => {
    const id = sessionId()
    return id ? sync.data.session_agent[id] : undefined
  })

  return (
    <Show when={acp.isAcpMode(scope()) && acp.models(scope()).length > 0}>
      <span class="text-13-regular text-text-weak px-2 h-7 flex items-center shrink-0">
        {acp.displayName(scope())}
        <Show when={liveAgent() && liveAgent() !== acp.displayName(scope())}>
          <span class="ml-1.5 text-11-regular text-text-weak bg-surface-base-hover rounded px-1 py-0.5">
            {liveAgent()}
          </span>
        </Show>
      </span>
      <Select
        size="normal"
        options={acp.models(scope()).map((m) => m.id)}
        current={acp.selectedModel(scope())}
        label={(id) => acp.models(scope()).find((m) => m.id === id)?.name ?? id}
        onSelect={(id) => {
          if (!id) return
          void acp.setModel(scope(), id, {
            directory: directory(),
            sessionId: sessionId(),
          })
        }}
        class="max-w-[160px]"
        valueClass="truncate text-13-regular"
        triggerStyle={{ height: "28px", ...props.triggerStyle }}
        variant="ghost"
      />
    </Show>
  )
}
