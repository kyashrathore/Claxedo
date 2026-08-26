import type { IBufferLine, ILink, ILinkProvider } from "@xterm/xterm"

export type LinkProviderLine = Pick<IBufferLine, "translateToString" | "isWrapped">

export interface LinkProviderTerminal {
  buffer: {
    active: {
      getLine: (index: number) => LinkProviderLine | null | undefined
    }
  }
}

export interface LinkMatch {
  text: string
  index: number
  end: number
  combinedText: string
  regexMatch: RegExpMatchArray
}

/**
 * Upper bound on how many wrapped buffer rows get stitched into one search
 * window. At 80 columns this is ~1600 chars — far beyond any real link — and
 * bounds the per-hover stitching cost.
 */
const MAX_STITCHED_ROWS = 20

/** One buffer row inside the stitched window. */
export interface StitchedRow {
  /** 1-based xterm buffer line number (the `y` used in link ranges). */
  y: number
  /** Offset of this row's first char within combinedText. */
  start: number
  /** Length of this row's text (translateToString(true)). */
  length: number
}

/**
 * Stitched view of a buffer line together with ALL of its wrapped neighbours,
 * used by every link provider so the "combine the wrapped rows and locate the
 * current row's slice" math has a single implementation.
 */
export interface WrappedLineContext {
  /** Every stitched row, in buffer order. Always contains the current row. */
  rows: StitchedRow[]
  /** Concatenated text of all stitched rows (the search window). */
  combinedText: string
  /** Offset of the current line's first char within combinedText. */
  currentLineOffset: number
  /** Length of the current line's text. */
  currentLineLength: number
}

// Track whether the link-activation modifier (cmd/ctrl) is held so links only
// advertise clickability (underline + pointer cursor) when a click would
// actually activate them. Without this, xterm's default decorations (all
// enabled) promise a click that the modifier-gated activate() silently ignores.
let activationModifierHeld = false
if (typeof window !== "undefined") {
  const onKey = (event: KeyboardEvent) => {
    if (event.key === "Meta" || event.key === "Control") {
      activationModifierHeld = event.type === "keydown"
    }
  }
  window.addEventListener("keydown", onKey, { capture: true })
  window.addEventListener("keyup", onKey, { capture: true })
  // Modifier keyups are lost when focus leaves the window (cmd+tab).
  window.addEventListener("blur", () => {
    activationModifierHeld = false
  })
}

export function isActivationModifierHeld(): boolean {
  return activationModifierHeld
}

/**
 * Shared geometry base for terminal link providers whose links can span
 * wrapped lines. Owns the line-stitching (`computeLineContext`) and the
 * wrapped-line range math (`calculateLinkRange`) so subclasses never
 * re-implement them. The stitched window covers every wrapped row of the
 * logical line (bounded by {@link MAX_STITCHED_ROWS}), so hovering any row of
 * a wrapped link sees the same complete text.
 *
 * Two flavours extend this:
 *  - {@link MultiLineLinkProvider} — regex-driven (UrlLinkProvider), matching a
 *    single `getPattern()` against the combined text.
 *  - FilePathLinkProvider — override-driven, feeding the combined text through
 *    VSCode's structured link detector instead of one regex, then reusing the
 *    same range math here.
 */
export abstract class WrappedLineLinkProvider implements ILinkProvider {
  constructor(protected readonly terminal: LinkProviderTerminal) {}

  abstract provideLinks(bufferLineNumber: number, callback: (links: ILink[] | undefined) => void): void

  /**
   * Stitch the current buffer line with every wrapped neighbour: walk back
   * while rows are wrap-continuations, then forward while the following rows
   * are wrap-continuations. Returns null when the current line is absent
   * (caller should report no links).
   */
  protected computeLineContext(bufferLineNumber: number): WrappedLineContext | null {
    const buffer = this.terminal.buffer.active
    const lineIndex = bufferLineNumber - 1
    const line = buffer.getLine(lineIndex)
    if (!line) {
      return null
    }

    let firstIndex = lineIndex
    while (lineIndex - firstIndex < MAX_STITCHED_ROWS && firstIndex > 0 && buffer.getLine(firstIndex)?.isWrapped) {
      firstIndex--
    }
    let lastIndex = lineIndex
    while (lastIndex - firstIndex + 1 < MAX_STITCHED_ROWS && buffer.getLine(lastIndex + 1)?.isWrapped) {
      lastIndex++
    }

    const rows: StitchedRow[] = []
    let combinedText = ""
    let currentLineOffset = 0
    let currentLineLength = 0
    for (let index = firstIndex; index <= lastIndex; index++) {
      const rowLine = buffer.getLine(index)
      const text = rowLine ? rowLine.translateToString(true) : ""
      if (index === lineIndex) {
        currentLineOffset = combinedText.length
        currentLineLength = text.length
      }
      rows.push({ y: index + 1, start: combinedText.length, length: text.length })
      combinedText += text
    }

    return { rows, combinedText, currentLineOffset, currentLineLength }
  }

  /**
   * Map a [matchIndex, matchEnd) span of the combined text to an xterm link
   * range. xterm treats both ends as 1-based and INCLUSIVE (Linkifier hits on
   * `x <= end.x`), so the end coordinate is the last character's cell — not
   * one past it.
   */
  protected calculateLinkRange(ctx: WrappedLineContext, matchIndex: number, matchEnd: number): ILink["range"] {
    const locate = (offset: number) => {
      let row = ctx.rows[0]!
      for (const candidate of ctx.rows) {
        if (offset >= candidate.start) {
          row = candidate
        } else {
          break
        }
      }
      return { y: row.y, x: offset - row.start + 1 }
    }

    const start = locate(matchIndex)
    const end = locate(Math.max(matchIndex, matchEnd - 1))
    return {
      start: { x: start.x, y: start.y },
      end: { x: end.x, y: end.y },
    }
  }

  /**
   * Decorations for a new link, reflecting whether a click would actually
   * activate it right now (activation is cmd/ctrl-gated in both providers).
   */
  protected linkDecorations(): ILink["decorations"] {
    const held = isActivationModifierHeld()
    return { pointerCursor: held, underline: held }
  }
}

/**
 * Regex-driven link provider: matches a single {@link getPattern} against the
 * stitched multi-line text. Subclasses supply the pattern, a skip predicate, an
 * optional match transform, and an activation handler.
 */
export abstract class MultiLineLinkProvider extends WrappedLineLinkProvider {
  protected abstract getPattern(): RegExp
  protected abstract shouldSkipMatch(match: LinkMatch): boolean
  protected abstract handleActivation(event: MouseEvent, text: string, regexMatch: RegExpMatchArray): void

  /**
   * Optional hook to transform a match before creating the link.
   * Useful for stripping trailing characters. Return null to skip the match.
   */
  protected transformMatch(match: LinkMatch): LinkMatch | null {
    return match
  }

  provideLinks(bufferLineNumber: number, callback: (links: ILink[] | undefined) => void): void {
    const ctx = this.computeLineContext(bufferLineNumber)
    if (!ctx) {
      callback(undefined)
      return
    }

    const { combinedText, currentLineOffset, currentLineLength } = ctx

    const links: ILink[] = []
    const regex = this.getPattern()

    for (const match of combinedText.matchAll(regex)) {
      const matchText = match[0]
      const matchIndex = match.index ?? 0
      const matchEnd = matchIndex + matchText.length

      let linkMatch: LinkMatch | null = {
        text: matchText,
        index: matchIndex,
        end: matchEnd,
        combinedText,
        regexMatch: match,
      }

      if (this.shouldSkipMatch(linkMatch)) {
        continue
      }

      linkMatch = this.transformMatch(linkMatch)
      if (!linkMatch) {
        continue
      }

      // Only report links that touch the hovered row (post-transform, so a
      // trimmed match no longer claims rows it does not reach).
      const currentLineStart = currentLineOffset
      const currentLineEnd = currentLineOffset + currentLineLength
      if (linkMatch.end <= currentLineStart || linkMatch.index >= currentLineEnd) {
        continue
      }

      const range = this.calculateLinkRange(ctx, linkMatch.index, linkMatch.end)

      links.push({
        range,
        text: linkMatch.text,
        decorations: this.linkDecorations(),
        activate: (event: MouseEvent, text: string) => {
          this.handleActivation(event, text, match)
        },
      })
    }

    callback(links.length > 0 ? links : undefined)
  }
}
