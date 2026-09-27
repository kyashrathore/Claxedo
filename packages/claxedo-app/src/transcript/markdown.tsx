import { useMarked, useDialog, ImagePreview, Icon, IconButton, Tooltip } from "@/ui"
import { reportUiError } from "@/ui/utils"
import { codeTheme } from "./code-theme"
import { useTranscriptI18n } from "./i18n"
import { useOptionalData } from "./data"
import morphdom from "morphdom"
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
import { getCachedMermaidSvg, sanitizeSvg, touchCachedMermaidSvg } from "./markdown-cache"
import {
  blockHash,
  codeLanguageName,
  enhanceTextBlock,
  entryBase,
  fallback,
  initialResult,
  syncBlock,
  syncRenderResult,
  type RenderedBlock,
  type RenderResult,
} from "./markdown-blocks"
import { rendererClock, traceRenderer } from "./markdown-trace"
import { getCachedCodeHighlight, highlightCodeThroughCache } from "./markdown-code-cache"
import { inlineCodeKind } from "./markdown-inline-code-kind"
import { markdownTableText } from "./markdown-table"
import { handleTranscriptLinkClick, transcriptLinkHref } from "./transcript-link"
import { parseMarkdownMeasured } from "./markdown-parse-timing"
import { createImageWaits, stabilizeImages, type ImageFiles, type ImageWaits } from "./markdown-images"
import { nextIdleSlice } from "@/lib/idle"
import { createMarkdownEdges, keepMarkdownEdge } from "./markdown-edges"

const renderedCodeTokens = new WeakMap<HTMLDivElement, RenderedCodeState>()
const highlightedCodeTokenLimit = 800

async function code(text: string, language: string | undefined, key: string, complete = false) {
  const name = codeLanguageName(language)
  try {
    return await highlightCodeThroughCache(text, name, codeTheme.name, complete, async () => {
      const result = await highlightStreamingCode(key, text, name, complete)
      return { language: name, generation: result.generation, stable: result.stable, unstable: result.unstable }
    })
  } catch (error) {
    if (
      !(error instanceof MarkdownWorkerDisposedError) &&
      !(error instanceof MarkdownWorkerSupersededError) &&
      !(error instanceof MarkdownWorkerUnavailableError)
    )
      reportUiError(error, "markdown-highlight")
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

function createCopyButton(labels: CopyLabels) {
  const host = document.createElement("div")
  host.setAttribute("data-slot", "markdown-copy-button")

  let setLabelsRef: CopyButtonState["setLabels"] | undefined
  let setCopiedRef: CopyButtonState["setCopied"] | undefined
  const dispose = render(() => {
    const [labelState, setLabels] = createSignal(labels, { equals: sameCopyLabels })
    const [copied, setCopied] = createSignal(false)
    setLabelsRef = setLabels
    setCopiedRef = setCopied
    return <MarkdownCopyButton labels={labelState} copied={copied} />
  }, host)
  if (!setLabelsRef || !setCopiedRef) throw new Error("markdown copy button rendered without its setters")
  copyButtonState.set(host, { setLabels: setLabelsRef, setCopied: setCopiedRef, dispose })
  return host
}

function sameCopyLabels(left: CopyLabels, right: CopyLabels) {
  return left.copy === right.copy && left.copied === right.copied
}

function MarkdownCopyButton(props: { labels: Accessor<CopyLabels>; copied: Accessor<boolean> }) {
  const label = () => (props.copied() ? props.labels().copied : props.labels().copy)
  return (
    <Tooltip placement="top" value={label()}>
      <IconButton
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
    </Tooltip>
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

const shellLanguages = new Set(["bash", "sh", "shell", "zsh", "fish", "console", "terminal"])

let mermaidRenderer: ((source: string) => Promise<string>) | undefined
let mermaidViewer: ((source: string) => void) | undefined
const mermaidInFlight = new Map<string, Promise<string>>()

function renderMermaidSource(source: string): Promise<string> {
  const pending = mermaidInFlight.get(source)
  if (pending) return pending
  const started = mermaidRenderer!(source).finally(() => {
    if (mermaidInFlight.get(source) === started) mermaidInFlight.delete(source)
  })
  mermaidInFlight.set(source, started)
  return started
}
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
      <Tooltip placement="top" value={label}>
        <IconButton
          type="button"
          size="small"
          variant="ghost-muted"
          aria-label={label}
          icon={<Icon name="expand" size="small" />}
          onClick={onClick}
        />
      </Tooltip>
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

function commitMermaidDiagram(wrapper: HTMLElement, source: string, svg: string) {
  let diagram = wrapper.querySelector('[data-slot="mermaid-diagram"]')
  if (!diagram) {
    diagram = document.createElement("div")
    diagram.setAttribute("data-slot", "mermaid-diagram")
    wrapper.appendChild(diagram)
  }
  replaceSanitizedMarkup(diagram, svg)
  wrapper.setAttribute("data-mermaid-source", source)
  wrapper.setAttribute("data-mermaid-state", "rendered")
  wrapper.querySelector('[data-slot="mermaid-render-button"]')?.remove()
  wrapper.setAttribute("data-markdown-rich", "mermaid")
  ensureMermaidControls(wrapper, source)
}

function renderMermaidBlocks(root: HTMLElement) {
  if (!mermaidRenderer) return
  const wrappers = Array.from(root.querySelectorAll('[data-component="markdown-code"]'))
  for (const wrapper of wrappers) {
    if (!(wrapper instanceof HTMLElement)) continue
    const code = wrapper.querySelector("code")
    const language = code?.className.match(/(?:^|\s)language-([^\s]+)/)?.[1]
    if (language !== "mermaid" || !code) continue
    const source = (code.textContent ?? "").trimEnd()
    if (!source.trim()) continue
    if (largeMermaid(source) && wrapper.dataset.mermaidRenderRequested !== source) {
      traceMermaid("defer", source)
      wrapper.setAttribute("data-mermaid-state", "deferred")
      wrapper.querySelector('[data-slot="mermaid-diagram"]')?.remove()
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
    const cached = getCachedMermaidSvg(source)
    if (cached) {
      commitMermaidDiagram(wrapper, source, cached)
      continue
    }
    wrapper.setAttribute("data-mermaid-source", source)
    traceMermaid("render", source)
    const renderStarted = rendererClock()
    void renderMermaidSource(source)
      .then(async (svg) => {
        await nextIdleSlice()
        traceMermaid("generate", source, renderStarted)
        if (wrapper.getAttribute("data-mermaid-source") !== source) return
        const sanitizeStarted = rendererClock()
        const safe = sanitizeSvg(svg)
        traceMermaid("sanitize", source, sanitizeStarted)
        if (!safe) throw new Error("mermaid: SVG failed sanitization")
        touchCachedMermaidSvg(source, safe)
        const commitStarted = rendererClock()
        commitMermaidDiagram(wrapper, source, safe)
        traceMermaid("commit", source, commitStarted)
      })
      .catch((error: unknown) => {
        console.warn("A mermaid diagram could not be rendered; its code block stays", { error })
        wrapper.querySelector('[data-slot="mermaid-diagram"]')?.remove()
        clearRichControls(wrapper)
        wrapper.removeAttribute("data-mermaid-source")
        wrapper.removeAttribute("data-mermaid-state")
        wrapper.removeAttribute("data-markdown-rich")
      })
  }
}

function ensureTableWrapper(table: HTMLTableElement) {
  if (table.closest('[data-component="markdown-table"]')) return
  const parent = table.parentElement
  if (!parent) return
  const wrapper = document.createElement("div")
  const viewport = document.createElement("div")
  wrapper.setAttribute("data-component", "markdown-table")
  wrapper.setAttribute("data-markdown-rich", "table")
  viewport.setAttribute("data-slot", "markdown-table-scroll")
  parent.replaceChild(wrapper, table)
  viewport.appendChild(table)
  wrapper.appendChild(viewport)
}

function decorateTables(root: HTMLDivElement) {
  for (const table of Array.from(root.querySelectorAll("table"))) ensureTableWrapper(table)
}

function ensureTableControls(wrapper: HTMLElement, labels: CopyLabels) {
  ensureCopyButton(wrapper, labels)
  const openTable = markdownTableViewer
    ? () => {
        const clone = wrapper.querySelector("table")?.cloneNode(true)
        if (clone instanceof HTMLTableElement) markdownTableViewer?.(clone)
      }
    : undefined
  ensureRichControls(wrapper, "Open table full screen", "table", openTable)
}

function ensureCopyButton(wrapper: HTMLElement, labels: CopyLabels) {
  const [first, ...extra] = Array.from(wrapper.querySelectorAll<HTMLElement>('[data-slot="markdown-copy-button"]'))
  for (const button of extra) {
    disposeCopyButton(button)
    button.remove()
  }
  if (first) return
  wrapper.appendChild(createCopyButton(labels))
}

function attachControls(root: Element, labels: CopyLabels) {
  for (const wrapper of Array.from(root.querySelectorAll<HTMLElement>('[data-component="markdown-code"]'))) ensureCopyButton(wrapper, labels)
  for (const wrapper of Array.from(root.querySelectorAll<HTMLElement>('[data-component="markdown-table"]'))) ensureTableControls(wrapper, labels)
}

function isControl(node: Node) {
  if (!(node instanceof HTMLElement)) return false
  const slot = node.getAttribute("data-slot")
  return slot === "markdown-copy-button" || slot === "markdown-view-button" || slot === "markdown-rich-controls"
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

function largeMermaid(source: string) {
  return source.length > 4_000 || source.split("\n", 33).length > 32
}

function codeKind(language: string | undefined): "shell" | undefined {
  const value = language?.toLowerCase()
  if (!value) return undefined
  if (shellLanguages.has(value)) return "shell"
  return undefined
}

function codeLanguage(block: HTMLPreElement): string | undefined {
  const code = block.querySelector("code")
  if (!(code instanceof HTMLElement)) return undefined
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

function ensureCodeWrapper(block: HTMLPreElement) {
  const parent = block.parentElement
  if (!parent) return
  if (parent.getAttribute("data-component") === "markdown-code") {
    applyCodeMetadata(parent, codeLanguage(block))
    return
  }
  const wrapper = document.createElement("div")
  wrapper.setAttribute("data-component", "markdown-code")
  applyCodeMetadata(wrapper, codeLanguage(block))
  parent.replaceChild(wrapper, block)
  wrapper.appendChild(block)
}

function markCodeLinks(root: HTMLDivElement) {
  const codeNodes = Array.from(root.querySelectorAll(":not(pre) > code"))
  for (const code of codeNodes) {
    const href = transcriptLinkHref(code.textContent ?? "")
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

function decorate(root: HTMLDivElement, images: ImageWaits, data?: ImageFiles) {
  for (const block of Array.from(root.querySelectorAll("pre"))) ensureCodeWrapper(block)
  markInlineCode(root)
  markCodeLinks(root)
  decorateTables(root)
  stabilizeImages(root, images, data)
  renderMermaidBlocks(root)
}

function setupLinkOpen(root: HTMLDivElement, openImage?: (src: string, alt?: string) => void) {
  const handleClick = (event: MouseEvent) => {
    const target = event.target instanceof Element ? event.target : undefined
    const tile = target?.closest('[data-component="markdown-image-tile"]')
    const img = tile?.querySelector("img")
    if (openImage && img && event.button === 0) {
      event.preventDefault()
      event.stopPropagation()
      openImage(img.src, img.getAttribute("alt") ?? undefined)
      return
    }
    handleTranscriptLinkClick(event)
  }
  root.addEventListener("click", handleClick, { capture: true })
  return () => root.removeEventListener("click", handleClick, { capture: true })
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

export function Markdown(
  props: ComponentProps<"div"> & {
    text: string
    cacheKey?: string
    streaming?: boolean
    richAfterMs?: number
    class?: string
    classList?: Record<string, boolean>
  },
) {
  const [local, others] = splitProps(props, ["text", "cacheKey", "streaming", "richAfterMs", "class", "classList"])
  const marked = useMarked()
  const i18n = useTranscriptI18n()
  const dialog = useDialog()
  const openImage = (src: string, alt?: string) => void dialog.show(() => <ImagePreview src={src} alt={alt} />)
  const data = useOptionalData()
  const images = createImageWaits()
  const edges = createMarkdownEdges()
  const [root, setRoot] = createSignal<HTMLDivElement>()
  const owner = createUniqueId()
  const activeCodeKeys = new Set<string>()
  let liveBlock: RenderedBlock | undefined
  const renderSync = (index: number, block: Block): RenderedBlock => {
    if (block.mode !== "live") return syncBlock(owner, local.cacheKey, index, block)
    const key = markdownBlockKey(owner, local.cacheKey, index, block.mode)
    if (liveBlock?.key !== key || liveBlock.raw !== block.raw) liveBlock = syncBlock(owner, local.cacheKey, index, block)
    return liveBlock
  }
  const projection = createMemo<Projection | undefined>((previous) => {
    const started = rendererClock()
    const result = project(previous, local.text, local.streaming ?? false)
    traceRenderer(`markdown.project.chars-${local.text.length}.blocks-${result.blocks.length}`, started)
    return result
  }, undefined)
  const initial = initialResult(local.text, local.cacheKey, projection()!, owner)
  const [html] = createResource(
    () => {
      return {
        text: local.text,
        key: local.cacheKey,
        projection: projection()!,
        streaming: local.streaming,
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
              hash: blockHash(src.text, false),
              html: fallback(src.text),
              final: false,
            },
          ],
        } satisfies RenderResult
      if (!src.text) return { text: src.text, blocks: [] } satisfies RenderResult

      const base = entryBase(src.text, src.key)
      return Promise.all(
        src.projection.blocks.map(async (block, index) => {
          if (block.mode === "code") {
            const blockKey = markdownBlockKey(owner, src.key, index, block.mode)
            const started = rendererClock()
            if (!block.complete) traceRenderer(`markdown.highlightmiss.incomplete.chars-${block.src.length}`)
            else if (!getCachedCodeHighlight(block.src, codeLanguageName(block.language), codeTheme.name))
              traceRenderer(`markdown.highlightmiss.no-entry.chars-${block.src.length}`)
            const result = await code(block.src, block.language, blockKey, block.complete)
            traceRenderer(`markdown.highlight.chars-${block.src.length}.language-${result.language}`, started)
            return {
              key: blockKey,
              mode: block.mode,
              raw: block.raw,
              hash: blockHash(block.raw, true),
              complete: !!block.complete,
              ...result,
            }
          }

          if (src.streaming && block.mode === "live") return renderSync(index, block)

          return enhanceTextBlock({
            initial,
            owner,
            cacheKey: src.key,
            base,
            text: src.text,
            index,
            block,
            mode: block.mode,
            parse: (text) =>
              parseMarkdownMeasured({
                parse: () => marked.parse(text),
                clock: rendererClock,
                trace: (mode, started) => traceRenderer(`markdown.parse.${mode}.chars-${text.length}`, started),
              }),
          })
        }),
      )
        .then((blocks) => ({ text: src.text, blocks }) satisfies RenderResult)
        .catch((error: unknown) => {
          console.warn("Markdown blocks could not be rendered", { error })
          if (!src.streaming) return { text: src.text, blocks: [] } satisfies RenderResult
          return syncRenderResult(src.text, src.projection, owner, src.key)
        })
    },
    {
      initialValue: initial,
    },
  )

  let copyCleanup: (() => void) | undefined
  let linkCleanup: (() => void) | undefined

  createRenderEffect(() => {
    const container = root()
    if (!container) return
    if (isServer) return
    if (!local.text) {
      disposeMarkdownControls(container)
      container.replaceChildren()
      delete container.dataset.markdownStage
      return
    }

    const result = html.latest
    if (!result) return
    const projected = projection()!
    const content = pendingBlocks(result, projected, local.streaming, renderSync)
    if (!local.streaming && content.length === 1 && content[0]?.key === "initial") return
    const wasPlain = container.dataset.markdownStage === "plain"
    delete container.dataset.markdownStage
    if (wasPlain) container.replaceChildren()
    if (content.length === 0) {
      if (!local.streaming && container.childElementCount > 0) return
      disposeMarkdownControls(container)
      container.replaceChildren()
      return
    }

    const commitStarted = rendererClock()
    const labels = {
      copy: i18n.t("transcript.message.copy"),
      copied: i18n.t("transcript.message.copied"),
    }
    const nextCodeKeys = new Set(content.filter((block) => block.mode === "code").map((block) => block.key))
    activeCodeKeys.forEach((key) => {
      if (!nextCodeKeys.has(key)) disposeCode(key)
    })
    activeCodeKeys.clear()
    nextCodeKeys.forEach((key) => activeCodeKeys.add(key))
    content.forEach((block, index) => updateBlock(container, index, block, labels, images, data))
    while (container.children.length > content.length) {
      const child = container.lastElementChild
      if (!child) break
      disposeMarkdownControls(child)
      child.remove()
    }
    images.commit(container)
    edges.mark(container)
    container
      .querySelectorAll<HTMLElement>('[data-slot="markdown-copy-button"]')
      .forEach((button) => setCopyState(button, labels, button.dataset.copied === "true"))
    if (!copyCleanup)
      copyCleanup = setupCodeCopy(container, () => ({
        copy: i18n.t("transcript.message.copy"),
        copied: i18n.t("transcript.message.copied"),
      }))
    if (!linkCleanup) linkCleanup = setupLinkOpen(container, openImage)
    traceRenderer(`markdown.commit.chars-${local.text.length}.blocks-${content.length}`, commitStarted)
  })

  onCleanup(() => {
    if (copyCleanup) copyCleanup()
    if (linkCleanup) linkCleanup()
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
  streaming: boolean | undefined,
  renderSync: (index: number, block: Block) => RenderedBlock,
) {
  if (!result) return []
  if (!projection || result.text === projection.text) return result.blocks
  if (!streaming) return []
  const initial = result.blocks.length === 1 && result.blocks[0]?.key === "initial"
  return projection.blocks.map((block, index) => {
    const current = initial ? undefined : result.blocks[index]
    if (block.mode === "code") {
      if (current?.mode === "code" && canReusePendingBlock(current, block)) return current
      return renderSync(index, block)
    }
    if (current && current.mode !== "code" && current.raw === block.raw && "html" in current) return current
    return renderSync(index, block)
  })
}

function disposeCode(key: string) {
  disposeStreamingCode(key)
}

function updateBlock(
  container: HTMLDivElement,
  index: number,
  block: RenderedBlock,
  labels: CopyLabels,
  images: ImageWaits,
  data?: ImageFiles,
) {
  const started = rendererClock()
  const current = container.children[index]
  if (block.mode === "code") {
    const node = updateCodeBlock(container, current, block, labels)
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
  decorate(next, images, data)
  traceRenderer(`markdown.decorate.${block.mode}.chars-${block.raw.length}`, decorateStarted)

  if (!(current instanceof HTMLDivElement)) {
    container.appendChild(next)
    attachControls(next, labels)
    traceRenderer(`markdown.block.${block.mode}.chars-${block.raw.length}`, started)
    return
  }

  morphdom(current, next, {
    onBeforeElUpdated: (fromEl, toEl) => {
      keepMarkdownEdge(fromEl, toEl)
      return !fromEl.isEqualNode(toEl)
    },
    onBeforeNodeDiscarded: (node) => {
      if (isControl(node)) return false
      if (node instanceof Element) disposeMarkdownControls(node)
      return true
    },
  })
  attachControls(current, labels)
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
  pre.className = `shiki ${codeTheme.name}`
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
