import { OpenCodeTheme, useMarked } from "@opencode-ai/ui/context/marked"
import { useI18n } from "@opencode-ai/ui/context/i18n"
import morphdom from "morphdom"
import { checksum } from "@opencode-ai/core/util/encode"
import {
  type Accessor,
  type ComponentProps,
  createMemo,
  createRenderEffect,
  createResource,
  createSignal,
  createUniqueId,
  onCleanup,
  type Setter,
  splitProps,
} from "solid-js"
import { isServer, render } from "solid-js/web"
import { Icon } from "@opencode-ai/ui/icon"
import { IconButtonV2 } from "@opencode-ai/ui/v2/icon-button-v2"
import { TooltipV2 } from "@opencode-ai/ui/v2/tooltip-v2"
import { bundledLanguages } from "shiki"
import { canReusePendingBlock, project, type Block, type Projection } from "./markdown-stream"
import {
  disposeStreamingCode,
  highlightStreamingCode,
  MarkdownWorkerDisposedError,
  MarkdownWorkerSupersededError,
  MarkdownWorkerUnavailableError,
} from "./markdown-worker"
import { markdownBlockKey, type MarkdownToken } from "./markdown-worker-protocol"
import { shouldResetCodeTokens, type RenderedCodeState } from "./markdown-code-state"
import {
  getCachedMarkdown,
  sanitizeMarkdown,
  sanitizeSvg,
  touchCachedMarkdown,
  type MarkdownCacheEntry,
} from "./markdown-cache"
import { getCachedCodeHighlight, highlightCodeThroughCache } from "./markdown-code-cache"
import { inlineCodeKind } from "./markdown-inline-code-kind"
import { markdownTableText } from "./markdown-table"
import {
  disposeProgressiveMarkdown,
  stageMarkdownCollections as stageCollections,
} from "./markdown-progressive"
import { parseMarkdownMeasured } from "./markdown-parse-timing"
import {
  completedMarkdownRichDelayMs,
  scheduleCompletedMarkdownRichUpgrade,
} from "./markdown-rich-stage"

type RenderedBlock =
  | (MarkdownCacheEntry & { key: string; mode: Exclude<Block["mode"], "code"> })
  | {
      key: string
      mode: "code"
      raw: string
      hash: string
      language: string
      complete: boolean
      generation: number
      stable: MarkdownToken[]
      unstable: MarkdownToken[]
    }

type RenderResult = {
  text: string
  blocks: RenderedBlock[]
}

const renderedCodeTokens = new WeakMap<HTMLDivElement, RenderedCodeState>()
const highlightedCodeTokenLimit = 800

function escape(text: string) {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;")
}

function fallback(markdown: string) {
  return escape(markdown).replace(/\r\n?/g, "\n").replace(/\n/g, "<br>")
}

function codeLanguageName(language: string | undefined) {
  return language && language in bundledLanguages ? language : "text"
}

async function code(text: string, language: string | undefined, key: string, complete = false) {
  const name = codeLanguageName(language)
  try {
    return await highlightCodeThroughCache(text, name, OpenCodeTheme.name, complete, async () => {
      const result = await highlightStreamingCode(key, text, name, complete)
      return { language: name, generation: result.generation, stable: result.stable, unstable: result.unstable }
    })
  } catch (error) {
    if (
      !(error instanceof MarkdownWorkerDisposedError) &&
      !(error instanceof MarkdownWorkerSupersededError) &&
      !(error instanceof MarkdownWorkerUnavailableError)
    )
      console.error("Markdown highlighting worker failed", error)
    return { language: name, generation: 0, stable: [], unstable: [[text, ""] as MarkdownToken] }
  }
}

type CopyLabels = {
  copy: string
  copied: string
}

type CopyButtonState = {
  setLabels: Setter<CopyLabels>
  setCopied: Setter<boolean>
  dispose: () => void
}

const copyButtonState = new WeakMap<HTMLElement, CopyButtonState>()
const viewButtonState = new WeakMap<HTMLElement, () => void>()

const urlPattern = /^https?:\/\/[^\s<>()`"']+$/

function codeUrl(text: string) {
  const href = text.trim().replace(/[),.;!?]+$/, "")
  if (!urlPattern.test(href)) return
  try {
    const url = new URL(href)
    return url.toString()
  } catch {
    return
  }
}

function createCopyButton(labels: CopyLabels) {
  const host = document.createElement("div")
  host.setAttribute("data-slot", "markdown-copy-button")

  const state: Partial<CopyButtonState> = {}
  const dispose = render(() => {
    const [labelState, setLabels] = createSignal(labels, { equals: false })
    const [copied, setCopied] = createSignal(false)
    state.setLabels = setLabels
    state.setCopied = setCopied
    return <MarkdownCopyButton labels={labelState} copied={copied} />
  }, host)
  state.dispose = dispose
  copyButtonState.set(host, state as CopyButtonState)
  return host
}

function MarkdownCopyButton(props: { labels: Accessor<CopyLabels>; copied: Accessor<boolean> }) {
  const label = () => (props.copied() ? props.labels().copied : props.labels().copy)
  return (
    <TooltipV2 placement="top" value={label()}>
      <IconButtonV2
        type="button"
        size="normal"
        variant="ghost-muted"
        aria-label={label()}
        icon={
          <>
            <Icon name="copy" size="small" data-copy-icon />
            <Icon name="check" size="small" data-check-icon />
          </>
        }
      />
    </TooltipV2>
  )
}

function setCopyState(host: HTMLElement, labels: CopyLabels, copied: boolean) {
  const state = copyButtonState.get(host)
  state?.setLabels(labels)
  state?.setCopied(copied)
  if (copied) {
    host.setAttribute("data-copied", "true")
    return
  }
  host.removeAttribute("data-copied")
}

function disposeCopyButton(host: HTMLElement) {
  copyButtonState.get(host)?.dispose()
  copyButtonState.delete(host)
}

function disposeCopyButtons(root: Element) {
  const hosts = [
    ...(root instanceof HTMLElement && root.getAttribute("data-slot") === "markdown-copy-button" ? [root] : []),
    ...Array.from(root.querySelectorAll('[data-slot="markdown-copy-button"]')).filter(
      (el): el is HTMLElement => el instanceof HTMLElement,
    ),
  ]
  hosts.forEach(disposeCopyButton)
}

function disposeViewButton(host: HTMLElement) {
  viewButtonState.get(host)?.()
  viewButtonState.delete(host)
}

function disposeViewButtons(root: Element) {
  const hosts = [
    ...(root instanceof HTMLElement && root.getAttribute("data-slot") === "markdown-view-button" ? [root] : []),
    ...Array.from(root.querySelectorAll('[data-slot="markdown-view-button"]')).filter(
      (el): el is HTMLElement => el instanceof HTMLElement,
    ),
  ]
  hosts.forEach(disposeViewButton)
}

function disposeMarkdownControls(root: Element) {
  disposeCopyButtons(root)
  disposeViewButtons(root)
}

export function stageMarkdownCollections(root: HTMLElement) {
  stageCollections(root, traceRenderer)
}

const shellLanguages = new Set(["bash", "sh", "shell", "zsh", "fish", "console", "terminal"])

/**
 * Mermaid (T14) — the app registers a renderer (it owns the `mermaid` dep + theming);
 * session-ui stays dependency-free and just calls back. Rendering is idempotent and
 * self-healing: if the block cache replaces the DOM node, decorate re-runs and re-renders.
 * Errors fall back to the plain code block (never mermaid's own error graphics).
 *
 * SECURITY: the diagram source is assistant output, so the SVG that comes back is
 * untrusted no matter what the registered renderer does internally — mermaid's own
 * `securityLevel: "strict"` pass is the exact control its >=11.1.0 <11.10.0
 * advisories bypass. Every SVG therefore goes through `sanitizeSvg` before it can
 * reach `innerHTML`, and an empty result is treated as a render failure rather
 * than a reason to fall back to the raw string.
 */
let mermaidRenderer: ((source: string) => Promise<string>) | undefined
let mermaidViewer: ((source: string) => void) | undefined
let markdownTableViewer: ((table: HTMLTableElement) => void) | undefined

export function setMermaidRenderer(fn: ((source: string) => Promise<string>) | undefined) {
  mermaidRenderer = fn
}

export function setMermaidViewer(fn: ((source: string) => void) | undefined) {
  mermaidViewer = fn
}

export function setMarkdownTableViewer(fn: ((table: HTMLTableElement) => void) | undefined) {
  markdownTableViewer = fn
}

function createViewButton(label: string, onClick: () => void) {
  const host = document.createElement("div")
  host.setAttribute("data-slot", "markdown-view-button")
  const dispose = render(
    () => (
      <TooltipV2 placement="top" value={label}>
        <IconButtonV2
          type="button"
          size="small"
          variant="ghost-muted"
          aria-label={label}
          icon={<Icon name="expand" size="small" />}
          onClick={onClick}
        />
      </TooltipV2>
    ),
    host,
  )
  viewButtonState.set(host, dispose)
  return host
}

function ensureRichControls(wrapper: HTMLElement, label: string, key: string, onView: (() => void) | undefined) {
  let controls = wrapper.querySelector('[data-slot="markdown-rich-controls"]')
  if (!(controls instanceof HTMLElement)) {
    controls = document.createElement("div")
    controls.setAttribute("data-slot", "markdown-rich-controls")
    wrapper.appendChild(controls)
  }

  const copy = wrapper.querySelector('[data-slot="markdown-copy-button"]')
  if (copy && copy.parentElement !== controls) controls.appendChild(copy)

  const existing = controls.querySelector('[data-slot="markdown-view-button"]')
  if (!onView) {
    if (existing instanceof HTMLElement) disposeViewButton(existing)
    existing?.remove()
    return
  }
  if (existing instanceof HTMLElement && existing.dataset.viewKey === key) return
  if (existing instanceof HTMLElement) disposeViewButton(existing)
  existing?.remove()
  const button = createViewButton(label, onView)
  button.dataset.viewKey = key
  controls.prepend(button)
}

function clearRichControls(wrapper: HTMLElement) {
  const controls = wrapper.querySelector('[data-slot="markdown-rich-controls"]')
  if (!(controls instanceof HTMLElement)) return
  const copy = controls.querySelector('[data-slot="markdown-copy-button"]')
  if (copy) wrapper.appendChild(copy)
  disposeViewButtons(controls)
  controls.remove()
}

function ensureMermaidControls(wrapper: HTMLElement, source: string) {
  ensureRichControls(
    wrapper,
    "Open diagram full screen",
    source,
    mermaidViewer ? () => mermaidViewer?.(source) : undefined,
  )
}

function renderMermaidBlocks(root: HTMLElement) {
  if (!mermaidRenderer) return
  const wrappers = Array.from(root.querySelectorAll('[data-component="markdown-code"]'))
  for (const wrapper of wrappers) {
    if (!(wrapper instanceof HTMLElement)) continue
    const code = wrapper.querySelector("code")
    const language = code?.className.match(/(?:^|\s)language-([^\s]+)/)?.[1]
    if (language !== "mermaid" || !code) continue
    // Marked/Shiki preserve the fence-closing line break for nested blocks,
    // while the streaming code projection omits it for top-level fences.
    // Mermaid should receive the same canonical fence body from both paths.
    const source = (code.textContent ?? "").trimEnd()
    if (!source.trim()) continue
    if (largeMermaid(source) && wrapper.dataset.mermaidRenderRequested !== source) {
      traceMermaid("defer", source)
      wrapper.setAttribute("data-mermaid-state", "deferred")
      wrapper.querySelector('[data-slot="mermaid-diagram"]')?.remove()
      wrapper.querySelector('[data-slot="mermaid-view-button"]')?.remove()
      const existing = wrapper.querySelector<HTMLElement>('[data-slot="mermaid-render-button"]')
      if (existing?.dataset.mermaidSource !== source) {
        existing?.remove()
        const button = document.createElement("button")
        button.type = "button"
        button.textContent = "Render diagram"
        button.setAttribute("data-slot", "mermaid-render-button")
        button.dataset.mermaidSource = source
        button.addEventListener("click", () => {
          wrapper.dataset.mermaidRenderRequested = source
          button.remove()
          renderMermaidBlocks(root)
        })
        wrapper.appendChild(button)
      }
      continue
    }
    if (wrapper.getAttribute("data-mermaid-source") === source) {
      if (wrapper.getAttribute("data-mermaid-state") === "rendered") ensureMermaidControls(wrapper, source)
      continue
    }
    wrapper.setAttribute("data-mermaid-source", source)
    traceMermaid("render", source)
    const renderStarted = rendererClock()
    void mermaidRenderer(source)
      .then((svg) => {
        traceMermaid("generate", source, renderStarted)
        // Guard against streaming: skip if the source changed while rendering.
        if (wrapper.getAttribute("data-mermaid-source") !== source) return
        // Fail closed. `sanitizeSvg` returns "" when it cannot vouch for the
        // markup (no DOMPurify, or the sanitizer threw); throwing here routes
        // into the catch below, which keeps the plain code block visible. The
        // raw `svg` must never reach the DOM.
        const sanitizeStarted = rendererClock()
        const safe = sanitizeSvg(svg)
        traceMermaid("sanitize", source, sanitizeStarted)
        if (!safe) throw new Error("mermaid: SVG failed sanitization")
        const commitStarted = rendererClock()
        let diagram = wrapper.querySelector('[data-slot="mermaid-diagram"]')
        if (!diagram) {
          diagram = document.createElement("div")
          diagram.setAttribute("data-slot", "mermaid-diagram")
          wrapper.appendChild(diagram)
        }
        replaceSanitizedMarkup(diagram, safe)
        wrapper.setAttribute("data-mermaid-state", "rendered")
        wrapper.querySelector('[data-slot="mermaid-render-button"]')?.remove()
        wrapper.setAttribute("data-markdown-rich", "mermaid")
        ensureMermaidControls(wrapper, source)
        traceMermaid("commit", source, commitStarted)
      })
      .catch(() => {
        // Fallback: keep the code block, clear the marker so a later retry is possible.
        wrapper.querySelector('[data-slot="mermaid-diagram"]')?.remove()
        clearRichControls(wrapper)
        wrapper.removeAttribute("data-mermaid-source")
        wrapper.removeAttribute("data-mermaid-state")
        wrapper.removeAttribute("data-markdown-rich")
      })
  }
}

function ensureTableWrapper(table: HTMLTableElement, labels: CopyLabels) {
  const current = table.closest('[data-component="markdown-table"]')
  const wrapper = current instanceof HTMLElement ? current : document.createElement("div")
  if (!current) {
    const parent = table.parentElement
    if (!parent) return
    const viewport = document.createElement("div")
    wrapper.setAttribute("data-component", "markdown-table")
    wrapper.setAttribute("data-markdown-rich", "table")
    viewport.setAttribute("data-slot", "markdown-table-scroll")
    parent.replaceChild(wrapper, table)
    viewport.appendChild(table)
    wrapper.appendChild(viewport)
  }

  const existingCopy = wrapper.querySelector('[data-slot="markdown-copy-button"]')
  const copy = existingCopy instanceof HTMLElement ? existingCopy : createCopyButton(labels)
  if (!(existingCopy instanceof HTMLElement)) wrapper.appendChild(copy)
  setCopyState(copy, labels, copy.dataset.copied === "true")
  const openTable = markdownTableViewer
    ? () => {
        const clone = table.cloneNode(true)
        if (clone instanceof HTMLTableElement) markdownTableViewer?.(clone)
      }
    : undefined
  ensureRichControls(wrapper, "Open table full screen", table.textContent ?? "", openTable)
}

function decorateTables(root: HTMLDivElement, labels: CopyLabels) {
  const tables = Array.from(root.querySelectorAll("table"))
  for (const table of tables) {
    if (table instanceof HTMLTableElement) ensureTableWrapper(table, labels)
  }
}

function traceMermaid(
  action: "defer" | "render" | "generate" | "sanitize" | "commit",
  source: string,
  started?: number,
) {
  traceRenderer(
    `mermaid.${action}.chars-${source.length}.lines-${source.split("\n").length}`,
    started,
  )
}

function rendererClock() {
  if (typeof performance === "undefined") return
  return performance.now()
}

function traceRenderer(name: string, started?: number) {
  if (typeof window === "undefined") return
  const target = window as unknown as {
    __claxedoPerfTrace?: boolean
    __claxedoPerfRendererPhases?: Array<{ name: string; durationMs: number }>
  }
  if (!target.__claxedoPerfTrace) return
  target.__claxedoPerfRendererPhases?.push({
    name,
    durationMs: started === undefined ? 0 : performance.now() - started,
  })
}

function largeMermaid(source: string) {
  return source.length > 4_000 || source.split("\n", 33).length > 32
}

function codeKind(language: string | undefined) {
  const value = language?.toLowerCase()
  if (!value) return
  if (shellLanguages.has(value)) return "shell"
}

function codeLanguage(block: HTMLPreElement) {
  const code = block.querySelector("code")
  if (!(code instanceof HTMLElement)) return
  return code.className.match(/(?:^|\s)language-([^\s]+)/)?.[1]
}

function applyCodeMetadata(wrapper: HTMLElement, language: string | undefined) {
  if (!document.body.hasAttribute("data-new-layout")) {
    delete wrapper.dataset.language
    delete wrapper.dataset.codeKind
    return
  }

  if (language) wrapper.dataset.language = language
  else delete wrapper.dataset.language

  const kind = codeKind(language)
  if (kind) wrapper.dataset.codeKind = kind
  else delete wrapper.dataset.codeKind
}

function ensureCodeWrapper(block: HTMLPreElement, labels: CopyLabels) {
  const parent = block.parentElement
  if (!parent) return
  const wrapped = parent.getAttribute("data-component") === "markdown-code"
  if (!wrapped) {
    const wrapper = document.createElement("div")
    wrapper.setAttribute("data-component", "markdown-code")
    applyCodeMetadata(wrapper, codeLanguage(block))
    parent.replaceChild(wrapper, block)
    wrapper.appendChild(block)
    wrapper.appendChild(createCopyButton(labels))
    return
  }

  applyCodeMetadata(parent, codeLanguage(block))

  const buttons = Array.from(parent.querySelectorAll('[data-slot="markdown-copy-button"]')).filter(
    (el): el is HTMLButtonElement => el instanceof HTMLButtonElement,
  )

  if (buttons.length === 0) {
    parent.appendChild(createCopyButton(labels))
    return
  }

  for (const button of buttons.slice(1)) {
    disposeCopyButton(button)
    button.remove()
  }
}

function markCodeLinks(root: HTMLDivElement) {
  const codeNodes = Array.from(root.querySelectorAll(":not(pre) > code"))
  for (const code of codeNodes) {
    const href = codeUrl(code.textContent ?? "")
    const parentLink =
      code.parentElement instanceof HTMLAnchorElement && code.parentElement.classList.contains("external-link")
        ? code.parentElement
        : null

    if (!href) {
      if (parentLink) parentLink.replaceWith(code)
      continue
    }

    if (parentLink) {
      parentLink.href = href
      continue
    }

    const link = document.createElement("a")
    link.href = href
    link.className = "external-link"
    link.target = "_blank"
    link.rel = "noopener noreferrer"
    code.parentNode?.replaceChild(link, code)
    link.appendChild(code)
  }
}

function markInlineCode(root: HTMLDivElement) {
  const codeNodes = Array.from(root.querySelectorAll(":not(pre) > code"))
  for (const code of codeNodes) {
    if (!(code instanceof HTMLElement)) continue
    delete code.dataset.inlineCodeKind
    const kind = inlineCodeKind(code.textContent ?? "")
    if (kind) code.dataset.inlineCodeKind = kind
  }
}

function decorate(root: HTMLDivElement, labels: CopyLabels) {
  const blocks = Array.from(root.querySelectorAll("pre"))
  for (const block of blocks) {
    ensureCodeWrapper(block, labels)
  }
  // Inline-code kinds (path/url) and code links used to be gated behind the dead
  // `data-new-layout` flag; enable them unconditionally so path pills and URL links
  // render in the app (T15/T16).
  markInlineCode(root)
  markCodeLinks(root)
  decorateTables(root, labels)
  renderMermaidBlocks(root)
}

function setupCodeCopy(root: HTMLDivElement, getLabels: () => CopyLabels) {
  const timeouts = new Map<HTMLElement, ReturnType<typeof setTimeout>>()

  const updateLabel = (button: HTMLElement) => {
    const labels = getLabels()
    const copied = button.getAttribute("data-copied") === "true"
    setCopyState(button, labels, copied)
  }

  const handleClick = async (event: MouseEvent) => {
    const target = event.target
    if (!(target instanceof Element)) return

    const button = target.closest('[data-slot="markdown-copy-button"]')
    if (!(button instanceof HTMLElement)) return
    const table = button.closest('[data-component="markdown-table"]')?.querySelector("table")
    const code = button.closest('[data-component="markdown-code"]')?.querySelector("code")
    const content = table instanceof HTMLTableElement ? markdownTableText(table) : (code?.textContent ?? "")
    if (!content) return
    const clipboard = navigator?.clipboard
    if (!clipboard) return
    await clipboard.writeText(content)
    const labels = getLabels()
    setCopyState(button, labels, true)
    const existing = timeouts.get(button)
    if (existing) clearTimeout(existing)
    const timeout = setTimeout(() => setCopyState(button, labels, false), 2000)
    timeouts.set(button, timeout)
  }

  const buttons = Array.from(root.querySelectorAll('[data-slot="markdown-copy-button"]'))
  for (const button of buttons) {
    if (button instanceof HTMLElement) updateLabel(button)
  }

  root.addEventListener("click", handleClick)

  return () => {
    root.removeEventListener("click", handleClick)
    for (const timeout of timeouts.values()) {
      clearTimeout(timeout)
    }
    disposeMarkdownControls(root)
  }
}

function initialResult(text: string, key: string | undefined, projection: Projection, owner: string): RenderResult {
  if (!text) return { text, blocks: [] }
  const base = key ?? checksum(text)
  if (base) {
    const blocks = projection.blocks.flatMap((block, index): RenderedBlock[] => {
      if (block.mode === "code") {
        if (!block.complete) return []
        const cached = getCachedCodeHighlight(block.src, codeLanguageName(block.language), OpenCodeTheme.name)
        if (!cached) return []
        return [
          {
            key: markdownBlockKey(owner, key, index, block.mode),
            mode: block.mode,
            raw: block.raw,
            hash: String(block.raw.length),
            complete: true,
            ...cached,
          },
        ]
      }
      const cacheKey = `${base}:${index}:${block.mode}`
      const cached = getCachedMarkdown(cacheKey)
      if (cached?.raw !== block.raw) return []
      return [{ key: `${owner}:${cacheKey}`, mode: block.mode, ...cached }]
    })
    if (blocks.length === projection.blocks.length) return { text, blocks }
  }
  return {
    text,
    blocks: [
      {
        key: "initial",
        mode: "full",
        raw: text,
        hash: checksum(text) ?? "",
        html: fallback(text),
      },
    ],
  }
}

export function Markdown(
  props: ComponentProps<"div"> & {
    text: string
    cacheKey?: string
    streaming?: boolean
    /** Delay rich work for a newly mounted completed body. Set to 0 for an explicitly non-interactive surface. */
    richAfterMs?: number
    class?: string
    classList?: Record<string, boolean>
  },
) {
  const [local, others] = splitProps(props, ["text", "cacheKey", "streaming", "richAfterMs", "class", "classList"])
  const marked = useMarked()
  const i18n = useI18n()
  const [root, setRoot] = createSignal<HTMLDivElement>()
  const owner = createUniqueId()
  const activeCodeKeys = new Set<string>()
  // Streaming projection already exists before the completed mount boundary and
  // must remain incremental. Only a newly mounted, already-complete body stages
  // its rich representation; SSR also keeps the existing immediate fallback.
  const stageCompleted = !isServer && !(local.streaming ?? false) && (local.richAfterMs ?? completedMarkdownRichDelayMs) > 0
  const [richReady, setRichReady] = createSignal(!stageCompleted)
  const cancelRichUpgrade = stageCompleted
    ? scheduleCompletedMarkdownRichUpgrade(
        () => setRichReady(true),
        local.richAfterMs ?? completedMarkdownRichDelayMs,
      )
    : undefined
  const projection = createMemo<Projection | undefined>((previous) => {
    if (!richReady()) return previous
    const started = rendererClock()
    const result = project(previous, local.text, local.streaming ?? false)
    traceRenderer(`markdown.project.chars-${local.text.length}.blocks-${result.blocks.length}`, started)
    return result
  }, undefined)
  const [html] = createResource(
    () => {
      if (!richReady()) return
      return {
        text: local.text,
        key: local.cacheKey,
        projection: projection()!,
      }
    },
    async (src) => {
      if (isServer)
        return {
          text: src.text,
          blocks: [
            {
              key: "server",
              mode: "full" as const,
              raw: src.text,
              hash: checksum(src.text) ?? "",
              html: fallback(src.text),
            },
          ],
        } satisfies RenderResult
      if (!src.text) return { text: src.text, blocks: [] } satisfies RenderResult

      const base = src.key ?? checksum(src.text)
      return Promise.all(
        src.projection.blocks.map(async (block, index) => {
          const key = base ? `${base}:${index}:${block.mode}` : undefined
          const blockKey = markdownBlockKey(owner, src.key, index, block.mode)

          if (block.mode === "code") {
            const started = rendererClock()
            if (!block.complete) traceRenderer(`markdown.highlightmiss.incomplete.chars-${block.src.length}`)
            else if (!getCachedCodeHighlight(block.src, codeLanguageName(block.language), OpenCodeTheme.name))
              traceRenderer(`markdown.highlightmiss.no-entry.chars-${block.src.length}`)
            // Completed blocks read through the module-scope highlight cache
            // inside `code()`, so a remount resolves without a worker round trip.
            const result = await code(block.src, block.language, blockKey, block.complete)
            traceRenderer(`markdown.highlight.chars-${block.src.length}.language-${result.language}`, started)
            return {
              key: blockKey,
              mode: block.mode,
              raw: block.raw,
              hash: String(block.raw.length),
              complete: !!block.complete,
              ...result,
            }
          }

          if (key) {
            const cached = getCachedMarkdown(key)
            if (cached?.raw === block.raw) {
              touchCachedMarkdown(key, cached)
              return { key: blockKey, mode: block.mode, ...cached }
            }
            traceRenderer(`markdown.parsemiss.${cached ? "raw-mismatch" : "no-entry"}.chars-${block.src.length}`)
          } else {
            traceRenderer(`markdown.parsemiss.no-key.chars-${block.src.length}`)
          }

          const hash = checksum(block.raw)
          const parsed = await parseMarkdownMeasured({
            parse: () => marked.parse(block.src),
            clock: rendererClock,
            trace: (mode, started) => traceRenderer(`markdown.parse.${mode}.chars-${block.src.length}`, started),
          })
          const sanitizeStarted = rendererClock()
          const safe = sanitizeMarkdown(parsed)
          traceRenderer(`markdown.sanitize.chars-${block.src.length}`, sanitizeStarted)
          if (key && hash) touchCachedMarkdown(key, { raw: block.raw, hash, html: safe })
          return { key: blockKey, mode: block.mode, raw: block.raw, hash: hash ?? "", html: safe }
        }),
      )
        .then((blocks) => ({ text: src.text, blocks }) satisfies RenderResult)
        .catch(
          () =>
            ({
              text: src.text,
              blocks: [
                {
                  key: base ?? "fallback",
                  mode: "full" as const,
                  raw: src.text,
                  hash: checksum(src.text) ?? "",
                  html: fallback(src.text),
                },
              ],
            }) satisfies RenderResult,
        )
    },
    {
      initialValue: richReady() ? initialResult(local.text, local.cacheKey, projection()!, owner) : undefined,
    },
  )

  let copyCleanup: (() => void) | undefined

  // This owns the Markdown DOM itself, so its initial commit belongs to
  // Solid's render phase. A deferred user effect left a fully mounted text row
  // empty for one animation frame; the timeline then could not expose
  // canonical first-fold text until the following frame.
  createRenderEffect(() => {
    const container = root()
    if (!container) return
    if (isServer) return
    if (!local.text) {
      disposeMarkdownControls(container)
      Array.from(container.children).forEach(disposeProgressiveMarkdown)
      container.replaceChildren()
      delete container.dataset.markdownStage
      return
    }
    if (!richReady()) {
      disposeMarkdownControls(container)
      Array.from(container.children).forEach(disposeProgressiveMarkdown)
      activeCodeKeys.forEach(disposeCode)
      activeCodeKeys.clear()
      // `textContent` is the escaping boundary. It avoids even DOMParser on the
      // first fold while keeping the complete canonical response selectable and
      // available to assistive technology.
      if (container.textContent !== local.text || container.childNodes.length !== 1) container.textContent = local.text
      container.dataset.markdownStage = "plain"
      return
    }

    // `html()` suspends while the asynchronous parser is pending. This rich
    // upgrade runs after the complete plain-text body has already painted, so
    // suspending here bubbles to the pane boundary and disconnects the entire
    // session surface (header, timeline, and composer) for a non-critical
    // enhancement. `latest` is reactive without throwing the pending promise;
    // keep the canonical plain body in place until rich HTML is ready.
    const result = html.latest
    // A native parser may be asynchronous. Keep the complete plain surface in
    // place until rich HTML is actually ready rather than blanking the response.
    if (!result) return
    const projected = projection()!
    const content = pendingBlocks(result, projected, local.cacheKey, owner)
    const wasPlain = container.dataset.markdownStage === "plain"
    delete container.dataset.markdownStage
    if (wasPlain) container.replaceChildren()
    if (content.length === 0) {
      disposeMarkdownControls(container)
      Array.from(container.children).forEach(disposeProgressiveMarkdown)
      container.replaceChildren()
      return
    }

    const commitStarted = rendererClock()
    const labels = {
      copy: i18n.t("ui.message.copy"),
      copied: i18n.t("ui.message.copied"),
    }
    const nextCodeKeys = new Set(content.filter((block) => block.mode === "code").map((block) => block.key))
    activeCodeKeys.forEach((key) => {
      if (!nextCodeKeys.has(key)) disposeCode(key)
    })
    activeCodeKeys.clear()
    nextCodeKeys.forEach((key) => activeCodeKeys.add(key))
    content.forEach((block, index) => updateBlock(container, index, block, labels))
    while (container.children.length > content.length) {
      const child = container.lastElementChild
      if (!child) break
      disposeMarkdownControls(child)
      disposeProgressiveMarkdown(child)
      child.remove()
    }
    container
      .querySelectorAll<HTMLElement>('[data-slot="markdown-copy-button"]')
      .forEach((button) => setCopyState(button, labels, button.dataset.copied === "true"))
    if (!copyCleanup)
      copyCleanup = setupCodeCopy(container, () => ({
        copy: i18n.t("ui.message.copy"),
        copied: i18n.t("ui.message.copied"),
      }))
    traceRenderer(`markdown.commit.chars-${local.text.length}.blocks-${content.length}`, commitStarted)
  })

  onCleanup(() => {
    cancelRichUpgrade?.()
    if (copyCleanup) copyCleanup()
    activeCodeKeys.forEach(disposeCode)
  })

  return (
    <div
      data-component="markdown"
      classList={{
        "ui-markdown": true,
        ...local.classList,
        [local.class ?? ""]: !!local.class,
      }}
      ref={setRoot}
      {...others}
    />
  )
}

function pendingBlocks(
  result: RenderResult | undefined,
  projection: Projection | undefined,
  cacheKey: string | undefined,
  owner: string,
) {
  if (!result) return []
  if (!projection || result.text === projection.text) return result.blocks
  const initial = result.blocks.length === 1 && result.blocks[0]?.key === "initial"
  return projection.blocks.map((block, index) => {
    const current = initial ? undefined : result.blocks[index]
    if (current && canReusePendingBlock(current, block)) return current
    const key = markdownBlockKey(owner, cacheKey, index, block.mode)
    if (block.mode !== "code")
      return { key, mode: block.mode, raw: block.raw, hash: String(block.raw.length), html: fallback(block.src) }
    return {
      key,
      mode: block.mode,
      raw: block.raw,
      hash: String(block.raw.length),
      language: block.language ?? "text",
      complete: !!block.complete,
      stable: [],
      generation: 0,
      unstable: [[block.src, ""] as MarkdownToken],
    }
  })
}

function disposeCode(key: string) {
  disposeStreamingCode(key)
}

function updateBlock(container: HTMLDivElement, index: number, block: RenderedBlock, labels: CopyLabels) {
  const started = rendererClock()
  const current = container.children[index]
  if (block.mode === "code") {
    const node = updateCodeBlock(container, current, block, labels)
    // A top-level ```mermaid fence is *always* a `mode: "code"` block, and this
    // path never reaches `decorate()`, so mermaid has to be driven from here or
    // it never runs at all. Gated on `complete`: a half-streamed fence cannot
    // parse, and each failed attempt clears the marker, so an ungated call would
    // re-render on every token until the fence closes.
    if (block.complete) renderMermaidBlocks(node)
    traceRenderer(`markdown.block.code.chars-${block.raw.length}`, started)
    return
  }
  if (
    current instanceof HTMLDivElement &&
    current.dataset.markdownKey === block.key &&
    current.dataset.markdownHash === block.hash
  )
    return

  const next = document.createElement("div")
  next.dataset.markdownBlock = ""
  next.dataset.markdownKey = block.key
  next.dataset.markdownHash = block.hash
  next.style.display = "contents"
  replaceSanitizedMarkup(next, block.html)
  const decorateStarted = rendererClock()
  decorate(next, labels)
  traceRenderer(`markdown.decorate.${block.mode}.chars-${block.raw.length}`, decorateStarted)

  if (!(current instanceof HTMLDivElement)) {
    container.appendChild(next)
    stageMarkdownCollections(next)
    traceRenderer(`markdown.block.${block.mode}.chars-${block.raw.length}`, started)
    return
  }

  disposeProgressiveMarkdown(current)
  morphdom(current, next, {
    onBeforeElUpdated: (fromEl, toEl) => {
      if (
        fromEl instanceof HTMLElement &&
        toEl instanceof HTMLElement &&
        fromEl.getAttribute("data-slot") === "markdown-copy-button" &&
        toEl.getAttribute("data-slot") === "markdown-copy-button"
      ) {
        return false
      }
      if (fromEl.isEqualNode(toEl)) return false
      return true
    },
    onBeforeNodeDiscarded: (node) => {
      if (node instanceof Element) {
        disposeMarkdownControls(node)
        disposeProgressiveMarkdown(node)
      }
      return true
    },
  })
  stageMarkdownCollections(current)
  traceRenderer(`markdown.block.${block.mode}.chars-${block.raw.length}`, started)
}

function replaceSanitizedMarkup(element: Element, html: string) {
  const parsed = new DOMParser().parseFromString(html, "text/html")
  element.replaceChildren(...Array.from(parsed.body.childNodes, (node) => document.importNode(node, true)))
}

function updateCodeBlock(
  container: HTMLDivElement,
  current: Element | undefined,
  block: Extract<RenderedBlock, { mode: "code" }>,
  labels: CopyLabels,
): HTMLDivElement {
  const existing = current instanceof HTMLDivElement && current.dataset.markdownKey === block.key ? current : undefined
  const next = existing ?? document.createElement("div")
  next.dataset.markdownBlock = ""
  next.dataset.markdownKey = block.key
  next.dataset.markdownHash = block.hash
  next.dataset.markdownComplete = block.complete ? "true" : "false"
  next.style.display = "contents"

  const code = existing?.querySelector("code")
  if (code instanceof HTMLElement) {
    const wrapper = code.closest('[data-component="markdown-code"]')
    if (wrapper instanceof HTMLElement) applyCodeMetadata(wrapper, block.language)
    code.className = `language-${block.language}`
    const tokens = [...block.stable, ...block.unstable]
    if (tokens.length > highlightedCodeTokenLimit) {
      code.textContent = tokens.map((token) => token[0]).join("")
      code.dataset.markdownCodeRender = "plain-large"
      renderedCodeTokens.delete(next)
      return next
    }
    if (code.dataset.markdownCodeRender) {
      code.textContent = ""
      delete code.dataset.markdownCodeRender
      renderedCodeTokens.delete(next)
    }
    const previous = renderedCodeTokens.get(next)
    const reset = shouldResetCodeTokens(previous, {
      language: block.language,
      generation: block.generation,
      stableCount: block.stable.length,
      raw: block.raw,
    })
    const stableCount = reset ? 0 : previous!.stableCount
    const tail = [...block.stable.slice(stableCount), ...block.unstable]
    const prior = reset ? [] : previous!.unstable
    const prefix = prior.findIndex((token, index) => !sameToken(token, tail[index]))
    const keep = stableCount + (prefix < 0 ? Math.min(prior.length, tail.length) : prefix)
    while (code.children.length > keep) code.lastElementChild?.remove()
    tail
      .slice(keep - stableCount)
      .map(createTokenSpan)
      .forEach((span) => code.appendChild(span))
    renderedCodeTokens.set(next, {
      language: block.language,
      generation: block.generation,
      stableCount: block.stable.length,
      unstable: block.unstable,
      raw: block.raw,
    })
    return next
  }

  const wrapper = document.createElement("div")
  wrapper.setAttribute("data-component", "markdown-code")
  applyCodeMetadata(wrapper, block.language)
  const pre = document.createElement("pre")
  pre.className = "shiki OpenCode"
  const codeElement = document.createElement("code")
  codeElement.className = `language-${block.language}`
  const tokens = [...block.stable, ...block.unstable]
  if (tokens.length > highlightedCodeTokenLimit) {
    codeElement.textContent = tokens.map((token) => token[0]).join("")
    codeElement.dataset.markdownCodeRender = "plain-large"
  } else {
    tokens.map(createTokenSpan).forEach((span) => codeElement.appendChild(span))
  }
  pre.appendChild(codeElement)
  wrapper.appendChild(pre)
  wrapper.appendChild(createCopyButton(labels))
  next.appendChild(wrapper)
  renderedCodeTokens.set(next, {
    language: block.language,
    generation: block.generation,
    stableCount: block.stable.length,
    unstable: block.unstable,
    raw: block.raw,
  })
  if (current) {
    disposeMarkdownControls(current)
    current.replaceWith(next)
    return next
  }
  container.appendChild(next)
  return next
}

function sameToken(left: MarkdownToken, right: MarkdownToken | undefined) {
  return !!right && left[0] === right[0] && left[1] === right[1]
}

function createTokenSpan(token: MarkdownToken) {
  const span = document.createElement("span")
  span.setAttribute("style", token[1])
  span.textContent = token[0]
  return span
}
