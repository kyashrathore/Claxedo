import type { ILink } from "@xterm/xterm"
import { detectFallbackLinks, type FallbackLink } from "./fallback-matchers"
import { currentOperatingSystem, detectLinks, type ParsedLink } from "./paths"
import { decodeUrlEncodedPath, removeLinkSuffix } from "./suffix"
import {
  isNumeric,
  isPackageReference,
  isUrl,
  isVersionString,
  looksLikeFile,
  shouldSkipPath,
  stripTrailingPunctuation,
} from "./path-filters"
import { WrappedLineLinkProvider, type LinkProviderTerminal, type WrappedLineContext } from "./wrapped-line-provider"

export type FileLinkOpen = (
  event: MouseEvent,
  path: string,
  line?: number,
  column?: number,
  lineEnd?: number,
  columnEnd?: number,
) => void

type Span = { readonly start: number; readonly end: number }

function linkSpan(link: ParsedLink): Span {
  const start = link.prefix?.index ?? link.path.index
  const end = link.suffix
    ? link.suffix.suffix.index + link.suffix.suffix.text.length
    : link.path.index + link.path.text.length
  return { start, end }
}

function overlaps(spans: readonly Span[], span: Span): boolean {
  return spans.some((other) => span.start < other.end && span.end > other.start)
}

function trailingLineColumn(path: string): { path: string; line?: number; column?: number } {
  const match = path.match(/:(\d+)(?::(\d+))?$/)
  if (!match) return { path }
  return {
    path: path.replace(/:(\d+)(?::(\d+))?$/, ""),
    line: Number.parseInt(match[1], 10),
    column: match[2] ? Number.parseInt(match[2], 10) : undefined,
  }
}

export class FilePathLinkProvider extends WrappedLineLinkProvider {
  constructor(
    terminal: LinkProviderTerminal,
    private readonly onOpen: FileLinkOpen,
  ) {
    super(terminal)
  }

  provideLinks(bufferLineNumber: number, callback: (links: ILink[] | undefined) => void): void {
    const context = this.computeLineContext(bufferLineNumber)
    if (!context) {
      callback(undefined)
      return
    }
    const links: ILink[] = []
    const fallbackSpans: Span[] = []
    for (const fallback of detectFallbackLinks(context.combinedText)) {
      if (shouldSkipPath(fallback.path) || !looksLikeFile(fallback.path)) continue
      const span = { start: fallback.index, end: fallback.index + fallback.link.length }
      fallbackSpans.push(span)
      if (!this.touchesCurrentLine(context, span.start, span.end)) continue
      links.push(this.link(context, span, fallback.link, (event) => this.activateFallback(event, fallback)))
    }
    for (const detected of detectLinks(context.combinedText, currentOperatingSystem())) {
      const link = detected.suffix ? detected : stripTrailingPunctuation(detected, context.combinedText)
      const span = linkSpan(link)
      if (overlaps(fallbackSpans, span) || !this.touchesCurrentLine(context, span.start, span.end)) continue
      if (!this.accepts(link.path.text, span.start, context.combinedText)) continue
      const text = context.combinedText.substring(span.start, span.end)
      links.push(this.link(context, span, text, (event) => this.activate(event, link)))
    }
    callback(links.length > 0 ? links : undefined)
  }

  private accepts(path: string, start: number, combinedText: string): boolean {
    if (isUrl(path, start, combinedText) || shouldSkipPath(path) || isVersionString(path)) return false
    if (isPackageReference(path, start, combinedText) || isNumeric(path)) return false
    return looksLikeFile(path)
  }

  private link(context: WrappedLineContext, span: Span, text: string, activate: (event: MouseEvent) => void): ILink {
    return {
      range: this.calculateLinkRange(context, span.start, span.end),
      text,
      decorations: this.linkDecorations(),
      activate,
    }
  }

  private activate(event: MouseEvent, link: ParsedLink): void {
    if (!event.metaKey && !event.ctrlKey) return
    event.preventDefault()
    const cleaned = decodeUrlEncodedPath(removeLinkSuffix(link.path.text))
    if (!cleaned) return
    const suffix = link.suffix
    const target = suffix?.row === undefined ? trailingLineColumn(cleaned) : { path: cleaned, line: suffix.row, column: suffix.col }
    this.onOpen(event, target.path, target.line, target.column, suffix?.rowEnd, suffix?.colEnd)
  }

  private activateFallback(event: MouseEvent, fallback: FallbackLink): void {
    if (!event.metaKey && !event.ctrlKey) return
    event.preventDefault()
    const cleaned = decodeUrlEncodedPath(fallback.path)
    if (cleaned) this.onOpen(event, cleaned, fallback.line, fallback.col)
  }
}
