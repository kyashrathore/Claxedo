import { createSignal, onCleanup, onMount, Show, type JSX } from "solid-js"
import type { AgentToolPart, ToolMcpFacts } from "@claxedo/agent-runtime-contract"
import { useAccess } from "@/access"
import { useTranslator } from "@/i18n"
import { machine } from "@/lib/machine"
import { useServer } from "@/server"
import { ClaxedoIconButton, requestConfirm, useDialog } from "@/ui"
import { appServerCalls } from "../api"
import { mcpAppPolicy } from "../csp"
import { documentMessage, appFrameDocument } from "../document"
import { mcpAppsDictionary } from "../i18n"
import { appFrameTransition, DEFAULT_APP_HEIGHT, type AppFrameEvent, type AppFrameState } from "../model"
import type { AppPromptSend } from "../requests"
import type { McpAppSession } from "../store"
import { createAppBridge } from "./app-bridge"
import { createAppDisplay } from "./display-mode"
import { AppLoadingNotice } from "./loading-notice"

export type AppFrameProps = {
  readonly html: string
  readonly facts: ToolMcpFacts
  readonly part: AgentToolPart
  readonly session: McpAppSession | undefined
  readonly openLink: (target: Element, href: string) => boolean
  readonly sendPrompt: AppPromptSend | undefined
}

function observeSize(element: HTMLElement, onSize: (size: { width: number; height: number }) => void): () => void {
  const observer = new ResizeObserver(([entry]) => {
    if (entry) onSize({ width: Math.round(entry.contentRect.width), height: Math.round(entry.contentRect.height) })
  })
  observer.observe(element)
  return () => observer.disconnect()
}

export function McpAppFrame(props: AppFrameProps): JSX.Element {
  const t = useTranslator(mcpAppsDictionary)
  const dialog = useDialog()
  const access = useAccess()
  const server = useServer()
  const frameState = machine<AppFrameState, AppFrameEvent>({ kind: "loading" }, appFrameTransition)
  const session = props.session
  const [height, setHeight] = createSignal(session?.heights.read(props.part.id) ?? DEFAULT_APP_HEIGHT)
  const [size, setSize] = createSignal({ width: 0, height: 0 })
  let container: HTMLDivElement | undefined
  let frame: HTMLIFrameElement | undefined
  const display = createAppDisplay(() => container)
  const bridge = createAppBridge({
    server: props.facts.server,
    part: () => props.part,
    frame: () => frame,
    display,
    size,
    reader: () => (session ? access.session(session.ref()) : { owner: false, send: false }),
    calls: session ? appServerCalls(server.sessions, session.ref(), props.facts.server) : undefined,
    sendPrompt: props.sendPrompt,
    openLink: props.openLink,
    confirm: (options) => requestConfirm(dialog, options),
    text: t,
    frameEvent: frameState.send,
    sizeChanged: (next) => {
      setHeight(next)
      session?.heights.remember(props.part.id, next)
    },
  })
  let loads = 0
  const onLoad = () => {
    loads += 1
    if (loads === 1) return frame?.contentWindow?.postMessage(documentMessage(props.html), "*")
    void bridge.teardown()
    display.request("inline")
    frameState.send({ type: "navigated" })
  }
  onMount(() => {
    if (container) onCleanup(observeSize(container, setSize))
  })
  onCleanup(() => void bridge.teardown())
  const srcdoc = appFrameDocument(mcpAppPolicy(props.facts.app?.csp))
  const title = () => t("mcpApps.frame.title", { server: props.facts.server })
  const fullscreen = () => display.mode() === "fullscreen"
  return (
    <div
      ref={container}
      popover="manual"
      data-component="mcp-app"
      data-display-mode={display.mode()}
      data-border={props.facts.app?.prefersBorder === false ? "none" : "frame"}
      style={{ "--mcp-app-height": `${height()}px` }}
    >
      <div data-slot="mcp-app-header">
        <span data-slot="mcp-app-title">{title()}</span>
        <Show when={frameState.state().kind !== "stopped"}>
          <ClaxedoIconButton
            icon={fullscreen() ? "collapse" : "maximize"}
            variant="ghost"
            size="small"
            aria-label={fullscreen() ? t("mcpApps.fullscreen.exit") : t("mcpApps.fullscreen.enter")}
            onClick={() => display.request(fullscreen() ? "inline" : "fullscreen")}
          />
        </Show>
      </div>
      <Show when={frameState.state().kind !== "stopped"} fallback={<p data-slot="mcp-app-notice">{t("mcpApps.stopped")}</p>}>
        <iframe ref={frame} data-slot="mcp-app-frame" title={title()} sandbox="allow-scripts allow-forms" referrerpolicy="no-referrer" srcdoc={srcdoc} onLoad={onLoad} />
      </Show>
      <Show when={frameState.state().kind === "loading"}>
        <AppLoadingNotice />
      </Show>
      <Show when={frameState.state().kind === "unavailable"}>
        <p data-slot="mcp-app-notice">{t("mcpApps.unavailable")}</p>
      </Show>
    </div>
  )
}
