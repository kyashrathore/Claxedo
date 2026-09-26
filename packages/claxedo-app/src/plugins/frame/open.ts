import type { PluginApi } from "@claxedo/plugin-api"
import type { HostServices } from "../bindings"
import { createHostLink, frameMirror, type FrameControl, type HostLink } from "./host-link"
import { FRAME_BOOT, type FrameBoot, type RenderTarget } from "./protocol"
import { appStylesheetText, appTheme } from "./styles"

export type FrameSource = {
  readonly code: string
  readonly runtime: () => Promise<string>
  readonly services: HostServices
}

export class FrameClosedError extends Error {
  constructor(readonly pluginId: string) {
    super(`The frame for ${pluginId} closed before it booted`)
    this.name = "FrameClosedError"
  }
}

export async function openFrame(frame: HTMLIFrameElement, api: PluginApi, source: FrameSource, target?: RenderTarget, control?: FrameControl): Promise<HostLink> {
  const runtime = await source.runtime()
  const window = frame.contentWindow
  if (!window) throw new FrameClosedError(api.context.pluginId)
  const channel = new MessageChannel()
  const link = createHostLink({ port: channel.port1, api, services: source.services, control })
  const boot: FrameBoot = {
    type: FRAME_BOOT,
    runtime,
    code: source.code,
    css: appStylesheetText(),
    theme: appTheme(),
    context: { pluginId: api.context.pluginId, pluginVersion: api.context.pluginVersion, platform: "web" },
    mirror: frameMirror(api, source.services),
    ...(target ? { target } : {}),
  }
  window.postMessage(boot, "*", [channel.port2])
  return link
}
