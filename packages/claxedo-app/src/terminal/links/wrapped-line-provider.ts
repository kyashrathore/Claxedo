import type { IBufferLine, ILink, ILinkProvider } from "@xterm/xterm"

export type LinkProviderLine = Pick<IBufferLine, "translateToString" | "isWrapped">

export type LinkProviderTerminal = {
  readonly buffer: { readonly active: { getLine: (index: number) => LinkProviderLine | null | undefined } }
}

export type LinkMatch = {
  readonly text: string
  readonly index: number
  readonly end: number
  readonly combinedText: string
  readonly regexMatch: RegExpMatchArray
}

const MAX_STITCHED_ROWS = 20

type StitchedRow = { readonly y: number; readonly start: number; readonly length: number }

export type WrappedLineContext = {
  readonly rows: readonly StitchedRow[]
  readonly combinedText: string
  readonly currentLineOffset: number
  readonly currentLineLength: number
}

function stitchedBounds(buffer: LinkProviderTerminal["buffer"]["active"], lineIndex: number) {
  let first = lineIndex
  while (lineIndex - first < MAX_STITCHED_ROWS && first > 0 && buffer.getLine(first)?.isWrapped) first--
  let last = lineIndex
  while (last - first + 1 < MAX_STITCHED_ROWS && buffer.getLine(last + 1)?.isWrapped) last++
  return { first, last }
}

export abstract class WrappedLineLinkProvider implements ILinkProvider {
  private modifierHeld = false
  private readonly onModifier = (event: KeyboardEvent) => {
    if (event.key === "Meta" || event.key === "Control") this.modifierHeld = event.type === "keydown"
  }
  private readonly onBlur = () => {
    this.modifierHeld = false
  }

  constructor(protected readonly terminal: LinkProviderTerminal) {
    window.addEventListener("keydown", this.onModifier, { capture: true })
    window.addEventListener("keyup", this.onModifier, { capture: true })
    window.addEventListener("blur", this.onBlur)
  }

  dispose(): void {
    window.removeEventListener("keydown", this.onModifier, { capture: true })
    window.removeEventListener("keyup", this.onModifier, { capture: true })
    window.removeEventListener("blur", this.onBlur)
  }

  abstract provideLinks(bufferLineNumber: number, callback: (links: ILink[] | undefined) => void): void

  protected computeLineContext(bufferLineNumber: number): WrappedLineContext | null {
    const buffer = this.terminal.buffer.active
    const lineIndex = bufferLineNumber - 1
    if (!buffer.getLine(lineIndex)) return null
    const { first, last } = stitchedBounds(buffer, lineIndex)
    const rows: StitchedRow[] = []
    let combinedText = ""
    let currentLineOffset = 0
    let currentLineLength = 0
    for (let index = first; index <= last; index++) {
      const text = buffer.getLine(index)?.translateToString(true) ?? ""
      if (index === lineIndex) {
        currentLineOffset = combinedText.length
        currentLineLength = text.length
      }
      rows.push({ y: index + 1, start: combinedText.length, length: text.length })
      combinedText += text
    }
    return { rows, combinedText, currentLineOffset, currentLineLength }
  }

  protected calculateLinkRange(context: WrappedLineContext, matchIndex: number, matchEnd: number): ILink["range"] {
    const locate = (offset: number) => {
      let row = context.rows[0]
      for (const candidate of context.rows) {
        if (offset < candidate.start) break
        row = candidate
      }
      return { y: row.y, x: offset - row.start + 1 }
    }
    const start = locate(matchIndex)
    const end = locate(Math.max(matchIndex, matchEnd - 1))
    return { start, end }
  }

  protected touchesCurrentLine(context: WrappedLineContext, start: number, end: number): boolean {
    const lineStart = context.currentLineOffset
    const lineEnd = context.currentLineOffset + context.currentLineLength
    return end > lineStart && start < lineEnd
  }

  protected linkDecorations(): ILink["decorations"] {
    return { pointerCursor: this.modifierHeld, underline: this.modifierHeld }
  }
}

export abstract class PatternLinkProvider extends WrappedLineLinkProvider {
  protected abstract pattern(): RegExp
  protected abstract transformMatch(match: LinkMatch): LinkMatch | null
  protected abstract handleActivation(event: MouseEvent, text: string, regexMatch: RegExpMatchArray): void

  provideLinks(bufferLineNumber: number, callback: (links: ILink[] | undefined) => void): void {
    const context = this.computeLineContext(bufferLineNumber)
    if (!context) {
      callback(undefined)
      return
    }
    const links: ILink[] = []
    for (const match of context.combinedText.matchAll(this.pattern())) {
      const index = match.index ?? 0
      const linkMatch = this.transformMatch({
        text: match[0],
        index,
        end: index + match[0].length,
        combinedText: context.combinedText,
        regexMatch: match,
      })
      if (!linkMatch || !this.touchesCurrentLine(context, linkMatch.index, linkMatch.end)) continue
      links.push({
        range: this.calculateLinkRange(context, linkMatch.index, linkMatch.end),
        text: linkMatch.text,
        decorations: this.linkDecorations(),
        activate: (event, text) => this.handleActivation(event, text, match),
      })
    }
    callback(links.length > 0 ? links : undefined)
  }
}
