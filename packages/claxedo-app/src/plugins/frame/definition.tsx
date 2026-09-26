import type { Disposer, PluginApi, PluginDefinition } from "@claxedo/plugin-api"
import { failureReason } from "../failure"
import { frameDocument } from "./document"
import type { FrameControl, HostLink } from "./host-link"
import type { FrameSlots } from "./host-registrations"
import { openFrame, type FrameSource } from "./open"
import { FrameSlot } from "./slot"

export class FrameActivationError extends Error {
  constructor(readonly pluginId: string, reason: string) {
    super(reason)
    this.name = "FrameActivationError"
  }
}

function controlFrame(pluginId: string): HTMLIFrameElement {
  const frame = document.createElement("iframe")
  frame.setAttribute("sandbox", "allow-scripts")
  frame.hidden = true
  frame.title = pluginId
  frame.srcdoc = frameDocument(location.origin)
  return frame
}

function activateInFrame(api: PluginApi, source: FrameSource): Promise<Disposer> {
  const pluginId = api.context.pluginId
  const slots: FrameSlots = (target, title) => <FrameSlot title={title} open={(frame) => openFrame(frame, api, source, target)} />
  return new Promise((resolve, reject) => {
    const frame = controlFrame(pluginId)
    let link: HostLink | undefined
    let active = false
    const remove = () => {
      link?.dispose()
      frame.remove()
    }
    const control: FrameControl = {
      slots,
      activated: () => {
        active = true
        resolve(remove)
      },
      failed: (reason) => {
        if (active) return console.error(`Plugin ${pluginId} failed in its frame after it activated: ${reason}`)
        remove()
        reject(new FrameActivationError(pluginId, reason))
      },
    }
    frame.addEventListener(
      "load",
      () =>
        void openFrame(frame, api, source, undefined, control).then(
          (opened) => {
            link = opened
          },
          (error: unknown) => control.failed(failureReason(error)),
        ),
      { once: true },
    )
    document.body.append(frame)
  })
}

export function frameDefinition(source: FrameSource): PluginDefinition {
  return { activate: (api) => activateInFrame(api, source) }
}
