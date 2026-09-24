import { Terminal as XTerm } from "@xterm/xterm"
import { FitAddon } from "@xterm/addon-fit"
import { ClipboardAddon } from "@xterm/addon-clipboard"
import { Unicode11Addon } from "@xterm/addon-unicode11"
import { SerializeAddon } from "@xterm/addon-serialize"
import { TERMINAL_OPTIONS } from "./options"
import { loadRenderer, type RendererHandle } from "./renderer-webgl"
import type { FileLinkClick, TerminalColors } from "./types"
import type { RendererBudget } from "./renderer-budget"
import { FilePathLinkProvider, UrlLinkProvider } from "../links"

export type TerminalInstance = {
  readonly xterm: XTerm
  readonly fitAddon: FitAddon
  readonly serializeAddon: SerializeAddon
  readonly renderer: RendererHandle
  readonly cleanup: () => void
}

export type TerminalInstanceOptions = {
  readonly theme: TerminalColors
  readonly fontFamily: string
  readonly renderers: RendererBudget
  readonly onFileLinkClick?: FileLinkClick
  readonly onUrlClick: (event: MouseEvent, url: string) => void
}

export function scrollToBottom(xterm: XTerm): void {
  const viewport = xterm.element?.querySelector(".xterm-viewport")
  if (!viewport) {
    xterm.scrollToBottom()
    return
  }
  viewport.scrollTo({ top: viewport.scrollHeight, behavior: "instant" })
}

function registerLinks(xterm: XTerm, options: TerminalInstanceOptions): () => void {
  const url = new UrlLinkProvider(xterm, options.onUrlClick)
  const providers: { dispose(): void }[] = [url]
  const registrations = [xterm.registerLinkProvider(url)]
  const onFile = options.onFileLinkClick
  if (onFile) {
    const file = new FilePathLinkProvider(xterm, (_event, ...target) => onFile(...target))
    providers.push(file)
    registrations.push(xterm.registerLinkProvider(file))
  }
  return () => {
    for (const registration of registrations) registration.dispose()
    for (const provider of providers) provider.dispose()
  }
}

export function createTerminalInstance(container: HTMLDivElement, options: TerminalInstanceOptions): TerminalInstance {
  const xterm = new XTerm({ ...TERMINAL_OPTIONS, theme: options.theme, fontFamily: options.fontFamily })
  const fitAddon = new FitAddon()
  const serializeAddon = new SerializeAddon()
  xterm.open(container)
  xterm.loadAddon(fitAddon)
  xterm.loadAddon(new ClipboardAddon())
  xterm.loadAddon(new Unicode11Addon())
  xterm.loadAddon(serializeAddon)
  xterm.unicode.activeVersion = "11"
  const disposeLinks = registerLinks(xterm, options)
  const renderer = loadRenderer(xterm, options.renderers)
  if (fitAddon.proposeDimensions()) fitAddon.fit()
  return {
    xterm,
    fitAddon,
    serializeAddon,
    renderer,
    cleanup: () => {
      disposeLinks()
      renderer.dispose()
    },
  }
}
