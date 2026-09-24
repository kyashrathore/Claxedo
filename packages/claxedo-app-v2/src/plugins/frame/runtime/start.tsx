import { ErrorBoundary, type JSX } from "solid-js"
import { render } from "solid-js/web"
import type { PluginDefinition } from "@claxedo/plugin-api"
import { failureReason } from "../../failure"
import type { FoundMention, FrameBoot, FrameInvoke, RenderTarget } from "../protocol"
import { createFrameApi, type FrameEntries } from "./api"
import { createFrameLink, type FrameLink } from "./link"

function applyDocument(boot: FrameBoot): void {
  const style = document.createElement("style")
  style.textContent = boot.css
  document.head.append(style)
  const html = document.documentElement
  if (boot.theme.id) html.dataset.theme = boot.theme.id
  if (!boot.theme.colorScheme) return
  html.dataset.colorScheme = boot.theme.colorScheme
  html.style.colorScheme = boot.theme.colorScheme
}

async function importPlugin(code: string): Promise<PluginDefinition> {
  const url = URL.createObjectURL(new Blob([code], { type: "text/javascript" }))
  try {
    const module = (await import(/* @vite-ignore */ url)) as { readonly default?: PluginDefinition }
    if (typeof module.default?.activate !== "function") throw new Error("the bundle's default export is not definePlugin(...)")
    return module.default
  } finally {
    URL.revokeObjectURL(url)
  }
}

function emptyEntries(): FrameEntries {
  return { pages: new Map(), settings: new Map(), overlays: new Map(), commands: new Map(), mentions: new Map() }
}

async function answer(entries: FrameEntries, invoke: FrameInvoke): Promise<unknown> {
  if (invoke.method === "command.run") {
    const command = entries.commands.get(invoke.commandId)
    if (!command) throw new Error(`No command ${invoke.commandId} is registered`)
    return command.run(invoke.context)
  }
  const provider = entries.mentions.get(invoke.mentionId)
  if (!provider) throw new Error(`No mention provider ${invoke.mentionId} is registered`)
  const items = await provider.search(invoke.query, invoke.context)
  return items.map((item): FoundMention => ({ item, insert: provider.insert(item) }))
}

function targetView(target: RenderTarget, entries: FrameEntries, link: FrameLink): () => JSX.Element {
  const missing = () => new Error(`No ${target.kind} ${target.id} is registered`)
  if (target.kind === "page") {
    const page = entries.pages.get(target.id)
    if (!page) throw missing()
    return () => page.render({ path: target.path, params: target.params })
  }
  if (target.kind === "settings") {
    const section = entries.settings.get(target.id)
    if (!section) throw missing()
    return () => section.render()
  }
  const overlay = entries.overlays.get(target.id)
  if (!overlay) throw missing()
  return () => overlay.render({ close: () => void link.call({ method: "overlays.close", overlayId: target.id }) })
}

function FrameFailure(props: { readonly name: string; readonly error: unknown }): JSX.Element {
  return (
    <div role="alert" class="plugin-slot-failure">
      <p class="plugin-slot-failure-title">{props.name} failed</p>
      <p class="plugin-slot-failure-reason">{failureReason(props.error)}</p>
    </div>
  )
}

export async function startFrame(port: MessagePort, boot: FrameBoot): Promise<void> {
  applyDocument(boot)
  const link = createFrameLink(port, boot.mirror)
  const entries = emptyEntries()
  const name = boot.context.pluginId
  try {
    const definition = await importPlugin(boot.code)
    const api = createFrameApi({ link, context: boot.context, entries, forward: !boot.target, signal: new AbortController().signal })
    await definition.activate(api)
    if (!boot.target) {
      link.onInvoke((invoke) => answer(entries, invoke))
      link.send({ type: "activated" })
      return
    }
    const view = targetView(boot.target, entries, link)
    render(() => <ErrorBoundary fallback={(error) => <FrameFailure name={name} error={error} />}>{view()}</ErrorBoundary>, document.body)
  } catch (error) {
    link.send({ type: "failed", reason: failureReason(error) })
    if (boot.target) render(() => <FrameFailure name={name} error={error} />, document.body)
  }
}
