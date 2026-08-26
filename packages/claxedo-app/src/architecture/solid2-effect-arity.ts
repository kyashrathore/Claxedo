/**
 * Finds `createEffect`/`createRenderEffect` call sites that pass fewer than two
 * arguments.
 *
 * Solid 2 rc.3 removed the single-callback form, and it removed it in the one
 * way a type checker cannot report: the deprecated overload still ACCEPTS one
 * argument and returns `never`, so `createEffect(fn)` is a well-typed statement.
 * `tsgo -b` is silent, and the call throws — `[MISSING_EFFECT_FN]` in the dev
 * runtime, and in the production runtime a bare `Cannot read properties of
 * undefined (reading 'effect')` from inside minified Solid, because the shipped
 * build reads `effectFn.effect` with no argument check at all.
 *
 * That is why this is a source scan rather than a compiler diagnostic.
 */

/** One offending call site, located in the ORIGINAL text. */
export type EffectAritySite = {
  /** `createEffect` or `createRenderEffect`. */
  callee: string
  /** 1-based line in the file. */
  line: number
  /** Arguments actually passed. */
  args: number
}

const EFFECT_CALL = /\b(createEffect|createRenderEffect)\s*\(/g

/**
 * The source with every comment, string and regex literal blanked to spaces.
 *
 * Offsets and line breaks are preserved, so a match in the masked text maps
 * straight back to the original. Without this the scan reports the docblocks
 * that DESCRIBE the removed form — this file included.
 */
export function maskLiterals(text: string): string {
  const out = [...text]
  const blank = (from: number, to: number) => {
    for (let index = from; index < to && index < out.length; index++) {
      if (out[index] !== "\n") out[index] = " "
    }
  }
  // A `/` opens a regex only where a value cannot already have ended; after an
  // identifier, a literal or a closing bracket it is division.
  const regexOpens = (previous: string) => previous === "" || "([{,;=:!&|?+-*%~^<>".includes(previous)

  let index = 0
  let previous = ""
  while (index < text.length) {
    const char = text[index]
    const pair = text.slice(index, index + 2)
    if (pair === "//") {
      const end = text.indexOf("\n", index)
      const stop = end === -1 ? text.length : end
      blank(index, stop)
      index = stop
      continue
    }
    if (pair === "/*") {
      const end = text.indexOf("*/", index + 2)
      const stop = end === -1 ? text.length : end + 2
      blank(index, stop)
      index = stop
      continue
    }
    if (char === '"' || char === "'" || (char === "/" && regexOpens(previous))) {
      const stop = scanSimpleLiteral(text, index, char)
      blank(index, stop)
      previous = char === "/" ? "x" : char
      index = stop
      continue
    }
    if (char === "`") {
      const stop = scanTemplate(text, index)
      blank(index, stop)
      previous = "`"
      index = stop
      continue
    }
    if (!/\s/.test(char)) previous = char
    index += 1
  }
  return out.join("")
}

/** End offset (exclusive) of a quoted string or regex literal opened at `start`. */
function scanSimpleLiteral(text: string, start: number, quote: string): number {
  let index = start + 1
  while (index < text.length) {
    const char = text[index]
    if (char === "\\") {
      index += 2
      continue
    }
    // An unterminated literal is a syntax error the checker already reports;
    // stopping at the newline keeps the rest of the file scannable.
    if (char === "\n" && quote !== "`") return index
    if (char === quote) return index + 1
    if (quote === "/" && char === "[") {
      // A character class may hold an unescaped `/`.
      while (index < text.length && text[index] !== "]") index += text[index] === "\\" ? 2 : 1
    }
    index += 1
  }
  return text.length
}

/** End offset (exclusive) of the template literal opened at `start`, nesting included. */
function scanTemplate(text: string, start: number): number {
  let index = start + 1
  while (index < text.length) {
    const char = text[index]
    if (char === "\\") {
      index += 2
      continue
    }
    if (char === "`") return index + 1
    if (text.slice(index, index + 2) === "${") {
      // The expression hole is code, and may open templates of its own.
      let depth = 1
      index += 2
      while (index < text.length && depth > 0) {
        const inner = text[index]
        if (inner === "{") depth += 1
        else if (inner === "}") depth -= 1
        else if (inner === "`") {
          index = scanTemplate(text, index)
          continue
        }
        index += 1
      }
      continue
    }
    index += 1
  }
  return text.length
}

/**
 * Arguments passed to the call whose `(` sits at `openParen`, or `undefined`
 * when the parentheses do not balance.
 *
 * Counts commas at the top level of the argument list. A top-level comma can
 * also come from a type argument list (`x as Map<A, B>`), which OVER-counts and
 * therefore only ever misses a violation — never invents one.
 */
export function callArgumentCount(masked: string, openParen: number): number | undefined {
  let depth = 0
  let commas = 0
  let sawArgument = false
  let sawArgumentSinceComma = false
  for (let index = openParen; index < masked.length; index += 1) {
    const char = masked[index]
    if (char === "(" || char === "[" || char === "{") {
      depth += 1
      if (depth > 1) {
        sawArgument = true
        sawArgumentSinceComma = true
      }
      continue
    }
    if (char === ")" || char === "]" || char === "}") {
      depth -= 1
      if (depth === 0) return sawArgument ? commas + (sawArgumentSinceComma ? 1 : 0) : 0
      sawArgument = true
      sawArgumentSinceComma = true
      continue
    }
    if (depth === 1 && char === ",") {
      commas += 1
      sawArgumentSinceComma = false
      continue
    }
    if (!/\s/.test(char)) {
      sawArgument = true
      sawArgumentSinceComma = true
    }
  }
  return undefined
}

/** Every under-argumented effect call in one file's source text. */
export function findSingleArgumentEffects(text: string): EffectAritySite[] {
  const masked = maskLiterals(text)
  const sites: EffectAritySite[] = []
  EFFECT_CALL.lastIndex = 0
  for (let match = EFFECT_CALL.exec(masked); match; match = EFFECT_CALL.exec(masked)) {
    const openParen = match.index + match[0].length - 1
    const args = callArgumentCount(masked, openParen)
    if (args === undefined || args >= 2) continue
    sites.push({
      callee: match[1],
      line: masked.slice(0, match.index).split("\n").length,
      args,
    })
  }
  return sites
}
