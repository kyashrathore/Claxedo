export type Combinator = " " | ">" | "+" | "~"

export type Compound = { readonly text: string; readonly combinator: Combinator | undefined }

const structuralPseudo = /:(first-child|last-child|only-child|nth-child|nth-last-child|first-of-type|last-of-type|only-of-type|nth-of-type|nth-last-of-type|empty)\b/
const statePseudo = /:(hover|active|focus|focus-visible|focus-within)\b/
const identityAttributes = new Set(["data-component", "data-slot", "data-testid"])

export function compounds(selector: string): Compound[] {
  const out: Compound[] = []
  let current = ""
  let combinator: Combinator | undefined
  let depth = 0
  let quote: string | undefined
  const flush = () => {
    if (!current) return
    out.push({ text: current, combinator })
    current = ""
    combinator = undefined
  }
  for (const char of selector) {
    if (quote) {
      current += char
      if (char === quote) quote = undefined
      continue
    }
    if (char === '"' || char === "'") quote = char
    else if (char === "(" || char === "[") depth += 1
    else if (char === ")" || char === "]") depth = Math.max(0, depth - 1)
    if (depth > 0 || quote) {
      current += char
      continue
    }
    if (/\s/.test(char)) {
      flush()
      if (out.length > 0 && combinator === undefined) combinator = " "
      continue
    }
    if (char === ">" || char === "+" || char === "~") {
      flush()
      combinator = char
      continue
    }
    current += char
  }
  flush()
  return out
}

export function rightmost(selector: string): Compound | undefined {
  return compounds(selector).at(-1)
}

export function isFeatureless(compound: string): boolean {
  const bare = withoutArguments(compound)
  if (bare.includes("&")) return false
  if (/^[a-zA-Z_-]/.test(bare)) return false
  return !/[.#[]/.test(bare)
}

export function isStructural(compound: string): boolean {
  return structuralPseudo.test(compound)
}

export function carriesState(compound: string): boolean {
  if (statePseudo.test(compound)) return true
  return [...compound.matchAll(/\[\s*([\w-]+)/g)].some((match) => !identityAttributes.has(match[1] ?? ""))
}

function withoutArguments(compound: string): string {
  let out = ""
  let depth = 0
  for (const char of compound) {
    if (char === "(") depth += 1
    else if (char === ")") depth = Math.max(0, depth - 1)
    else if (depth === 0) out += char
  }
  return out
}
