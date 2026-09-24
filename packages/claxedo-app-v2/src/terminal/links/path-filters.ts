import type { ParsedLink } from "./paths"

const IGNORED_SEGMENTS =
  /(^|[\\/])(?:node_modules|\.git|\.next|dist|build|coverage|out|vendor|target|__pycache__|\.turbo|\.cache|\.pytest_cache|\.mypy_cache|\.ruff_cache|\.venv)([\\/]|$)/

export function shouldSkipPath(path: string): boolean {
  if (path === "/dev/null" || path.startsWith("/dev/fd/")) return true
  if (/^--?[a-zA-Z0-9][a-zA-Z0-9_-]*(?:=|$)/.test(path)) return true
  if (/[*?[\]]/.test(path)) return true
  if (path.startsWith("node:")) return true
  if (/^[0-9a-f]+\.\.[0-9a-f]+$/i.test(path)) return true
  return IGNORED_SEGMENTS.test(path)
}

export function isExplicitPath(path: string): boolean {
  return /^(?:file:\/\/\/|~\/|\.{1,2}\/|\/|\\\\|[a-zA-Z]:[\\/])/.test(path)
}

export function hasDotBasename(path: string): boolean {
  const base = path.split(/[\\/]/).pop() ?? ""
  const dot = base.lastIndexOf(".")
  if (dot <= -1 || dot === base.length - 1) return false
  return /[a-zA-Z]/.test(base.slice(dot + 1))
}

export function looksLikeFile(path: string): boolean {
  return isExplicitPath(path) || hasDotBasename(path)
}

export function isUrl(path: string, linkStart: number, combinedText: string): boolean {
  if (/^(?:https?|ftp):\/\//.test(path)) return true
  if (linkStart < 1) return false
  const context = combinedText.substring(Math.max(0, linkStart - 10), linkStart + 2)
  return /(?:https?|ftp):\/\//.test(context)
}

export function isVersionString(path: string): boolean {
  return /^v?\d+\.\d+(\.\d+)*$/.test(path)
}

export function isPackageReference(path: string, linkStart: number, combinedText: string): boolean {
  if (/@\d+\.\d+/.test(path)) return true
  return /^@\d+\.\d+/.test(combinedText.slice(linkStart + path.length))
}

export function isNumeric(path: string): boolean {
  return /^\d+(:\d+)*$/.test(path) || /^\d+(?:\/\d+)+$/.test(path)
}

export function stripTrailingPunctuation(link: ParsedLink, combinedText: string): ParsedLink {
  const text = link.path.text
  const trailing = text.match(/([.,;:!?)]+)$/)
  if (!trailing) return link
  const punctuation = trailing[1]
  const after = combinedText[link.path.index + text.length]
  const boundary = after === undefined || /\s/.test(after) || after === '"' || after === "'"
  if (!boundary) return link
  if (punctuation === "." && /\.[a-zA-Z0-9]{1,4}$/.test(text)) return link
  return { ...link, path: { index: link.path.index, text: text.slice(0, -punctuation.length) } }
}
