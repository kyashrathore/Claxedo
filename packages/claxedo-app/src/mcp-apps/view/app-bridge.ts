import { createEffect, createSignal, on, onCleanup, type Accessor } from "solid-js"
import type { AgentToolPart } from "@claxedo/agent-runtime-contract"
import { useI18n } from "@/i18n"
import { desktopBridge } from "@/lib/desktop-bridge"
import type { ConfirmOptions } from "@/ui"
import type { AppServerCalls } from "../api"
import { createBridge, type Bridge, type BridgeHost } from "../bridge"
import type { AppReader, ConsentText } from "../consent"
import { hostContext, readHostTheme, watchHostTheme, type HostContext } from "../host-context"
import { rpcResult, rpcError, type JsonRpcParams } from "../jsonrpc"
import { MCP_APP_HOST_INFO, type AppFrameEvent } from "../model"
import { toolReplay } from "../part"
import { createAppRequests, type AppPromptSend } from "../requests"
import type { AppDisplay } from "./display-mode"

export type AppBridgeInput = {
  readonly server: string
  readonly part: () => AgentToolPart
  readonly frame: () => HTMLIFrameElement | undefined
  readonly display: AppDisplay
  readonly size: Accessor<{ readonly width: number; readonly height: number }>
  readonly reader: () => AppReader
  readonly calls: AppServerCalls | undefined
  readonly sendPrompt: AppPromptSend | undefined
  readonly openLink: (target: Element, href: string) => boolean
  readonly confirm: (options: ConfirmOptions) => Promise<boolean>
  readonly text: ConsentText
  readonly frameEvent: (event: AppFrameEvent) => void
  readonly sizeChanged: (height: number) => void
}

function hostCapabilities(input: AppBridgeInput): JsonRpcParams {
  const reader = input.reader()
  const server = reader.owner && input.calls ? { serverTools: {}, serverResources: {} } : {}
  const message = reader.send && input.sendPrompt ? { message: { text: {} } } : {}
  return { openLinks: {}, logging: {}, ...server, ...message }
}

function createHostContextSource(input: AppBridgeInput): () => HostContext {
  const i18n = useI18n()
  const [theme, setTheme] = createSignal(readHostTheme())
  onCleanup(watchHostTheme(setTheme))
  const platform = desktopBridge() ? "desktop" : "web"
  return () => hostContext({ theme: theme(), displayMode: input.display.mode(), width: input.size().width, viewportHeight: input.size().height, locale: i18n.intlTag(), platform })
}

function openLinkFromFrame(input: AppBridgeInput, url: string) {
  const frame = input.frame()
  if (!frame || document.activeElement !== frame || !navigator.userActivation.isActive) return rpcError("Links open only right after a click in the app")
  return input.openLink(frame, url) ? rpcResult() : rpcError("The host has no handler for this link")
}

function bridgeHost(input: AppBridgeInput, context: () => HostContext): BridgeHost {
  const requests = createAppRequests({
    server: input.server,
    reader: input.reader,
    calls: input.calls,
    sendPrompt: input.sendPrompt,
    confirm: (options) => {
      input.display.request("inline")
      return input.confirm(options)
    },
    text: input.text,
    operationUnavailable: () => input.frameEvent({ type: "operationUnavailable" }),
    operationAnswered: () => input.frameEvent({ type: "operationAnswered" }),
  })
  return {
    hostContext: context,
    hostCapabilities: () => hostCapabilities(input),
    replay: () => toolReplay(input.part()),
    initialized: () => input.frameEvent({ type: "initialized" }),
    sizeChanged: input.sizeChanged,
    openLink: (url) => openLinkFromFrame(input, url),
    requestDisplayMode: input.display.request,
    callTool: requests.callTool,
    readResource: requests.readResource,
    message: requests.message,
    log: (params) => console.info("mcp-apps: app log", { server: input.server, level: params.level, data: params.data }),
  }
}

export function createAppBridge(input: AppBridgeInput): Bridge {
  const context = createHostContextSource(input)
  const bridge = createBridge({
    frameWindow: () => input.frame()?.contentWindow,
    post: (message) => input.frame()?.contentWindow?.postMessage(message, "*"),
    host: bridgeHost(input, context),
    hostInfo: MCP_APP_HOST_INFO,
  })
  const receive = (event: MessageEvent) => bridge.receive({ source: event.source, data: event.data })
  window.addEventListener("message", receive)
  onCleanup(() => window.removeEventListener("message", receive))
  createEffect(on(context, () => bridge.contextChanged(), { defer: true }))
  return bridge
}
