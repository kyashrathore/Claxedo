import { closeSync, openSync, readSync } from "node:fs"
import { createHash } from "node:crypto"
import { parse } from "@babel/parser"
import type { Node, ObjectExpression } from "@babel/types"
import manifest from "../src/assets/icons/codex-alternatives/manifest.json"
import { appliedIconReplacements } from "../src/storybook/icon-mapping-audit"

// Verify the captured bodies against the exact installed renderer, without executing it.
const fd = openSync(process.argv[2] ?? manifest.source, "r")
const read = (position: number, size: number) => {
  const buffer = Buffer.alloc(size)
  if (readSync(fd, buffer, 0, size, position) !== size) throw new Error("Incomplete archive read")
  return buffer
}
type Entry = { files?: Record<string, Entry>; offset?: string; size?: number; unpacked?: boolean }
const hash = (body: string | Buffer) => createHash("sha256").update(body).digest("hex")
const scalar = (node: Node): string => {
  if (node.type === "StringLiteral" || node.type === "NumericLiteral") return String(node.value)
  if (node.type === "TemplateLiteral" && node.expressions.length === 0) return node.quasis[0].value.cooked!
  throw new Error("Dynamic SVG value cannot be verified as static artwork")
}
const property = (node: ObjectExpression, key: string) => {
  const item = node.properties.find(
    (p) => p.type === "ObjectProperty" && (p.key.type === "Identifier" ? p.key.name : scalar(p.key)) === key,
  )
  if (!item || item.type !== "ObjectProperty") throw new Error("Missing source property: " + key)
  return item.value
}
const escape = (text: string) => text.replaceAll("&", "&amp;").replaceAll('"', "&quot;").replaceAll("<", "&lt;")
const attrs: Record<string, string> = {
  className: "class",
  fillRule: "fill-rule",
  clipRule: "clip-rule",
  strokeWidth: "stroke-width",
  strokeLinecap: "stroke-linecap",
  strokeLinejoin: "stroke-linejoin",
}
function serialize(node: Node): string {
  if (node.type === "ArrayExpression")
    return node.elements
      .map((element) => {
        if (!element) throw new Error("Empty SVG child")
        return serialize(element)
      })
      .join("")
  if (node.type !== "CallExpression" || node.arguments.length < 2) throw new Error("Expected a static JSX call")
  const tag = scalar(node.arguments[0])
  if (!["svg", "path", "g", "circle", "rect", "line", "polyline", "polygon", "ellipse"].includes(tag))
    throw new Error("Unreviewed SVG element: " + tag)
  const props = node.arguments[1]
  if (props.type !== "ObjectExpression") throw new Error("Dynamic SVG props")
  let attributes = "",
    children = ""
  for (const prop of props.properties) {
    if (prop.type === "SpreadElement") continue
    if (prop.type !== "ObjectProperty") throw new Error("Dynamic SVG property")
    const key = prop.key.type === "Identifier" ? prop.key.name : scalar(prop.key)
    if (key === "children") {
      children = serialize(prop.value)
      continue
    }
    attributes += " " + (attrs[key] ?? key) + '="' + escape(scalar(prop.value)) + '"'
  }
  return "<" + tag + attributes + ">" + children + "</" + tag + ">"
}
try {
  const header = read(0, 16)
  const archive: Entry = JSON.parse(read(16, header.readUInt32LE(12)).toString())
  const base = 8 + header.readUInt32LE(4)
  const cache = new Map<string, { code: string; tree: Node; digest: string }>()
  for (const icon of manifest.icons) {
    let source = cache.get(icon.rendererAsset)
    if (!source) {
      let entry = archive
      for (const part of icon.rendererAsset.split("/")) {
        const next = entry.files?.[part]
        if (!next) throw new Error("Missing renderer asset: " + icon.rendererAsset)
        entry = next
      }
      if (entry.unpacked || entry.offset === undefined || entry.size === undefined)
        throw new Error("Expected packed renderer")
      const bytes = read(base + Number(entry.offset), entry.size)
      const code = bytes.toString()
      source = {
        code,
        tree: parse(code, { sourceType: "module" }),
        digest: hash(bytes),
      }
      cache.set(icon.rendererAsset, source)
    }
    if (source.digest !== icon.rendererSha256)
      throw new Error("Renderer changed; re-extract and visually review " + icon.id)
    if (Buffer.byteLength(source.code.slice(0, icon.sourceOffsetUTF16)) !== icon.sourceByteOffset)
      throw new Error("Source offset mismatch: " + icon.id)
    const sourceTree = source.tree
    let match: Node | undefined
    const visit = (node: Node) => {
      const start = node.start ?? 0
      if (start > icon.sourceOffsetUTF16 || (node.end ?? source!.code.length) <= icon.sourceOffsetUTF16) return
      if (
        start === icon.sourceOffsetUTF16 &&
        (icon.kind === "named" ? node.type === "ObjectExpression" : node.type === "CallExpression")
      )
        match = node
      if (match) return
      for (const value of Object.values(node)) {
        if (Array.isArray(value)) {
          for (const item of value) if (item && typeof item === "object" && "type" in item) visit(item as Node)
        } else if (value && typeof value === "object" && "type" in value) visit(value as Node)
      }
    }
    visit(sourceTree)
    if (!match) throw new Error("Source expression not found: " + icon.id)
    let body: string
    if (icon.kind === "named") {
      if (match.type !== "ObjectExpression") throw new Error("Expected native icon definition")
      if (scalar(property(match, "name")) !== icon.sourceName) throw new Error("Native name mismatch")
      const canvas = property(match, "canvas")
      if (canvas.type !== "ObjectExpression" || scalar(property(canvas, "viewBox")) !== icon.viewBox)
        throw new Error("Native viewBox mismatch: " + icon.id)
      body = scalar(property(match, "body"))
    } else {
      const svg = serialize(match)
      const parsed = /^<svg([^>]*)>(.*)<\/svg>$/s.exec(svg)
      if (!parsed || parsed[1] !== icon.rootAttributes) throw new Error("SVG root mismatch: " + icon.id)
      body = parsed[2]
    }
    if (body !== icon.body || hash(body) !== icon.bodySha256)
      throw new Error("Artwork differs from app source: " + icon.id)
  }
  const ids = new Set(manifest.icons.map((icon) => icon.id))
  for (const [name, proposal] of Object.entries(appliedIconReplacements)) {
    if (proposal?.codex && (!("native" in proposal.codex) || !ids.has(proposal.codex.native)))
      throw new Error("Codex replacement must resolve to verified native artwork: " + name)
  }
  const symbols = manifest.icons.map((icon) => {
    const attributes = (
      icon.kind === "named" ? ' viewBox="' + icon.viewBox + '" fill="currentColor"' : icon.rootAttributes!
    ).replace(/ (?:width|height|xmlns)="[^"]*"/g, "")
    return '  <symbol id="' + icon.id + '"' + attributes + ">" + icon.body + "</symbol>"
  })
  const expected = '<svg xmlns="http://www.w3.org/2000/svg">\n' + symbols.join("\n") + "\n</svg>\n"
  const sprite = await Bun.file(new URL("../src/assets/icons/codex-alternatives/sprite.svg", import.meta.url)).text()
  if (sprite !== expected) throw new Error("Native sprite differs from verified manifest")
  const production = await Bun.file(new URL("../src/assets/icons/codex/sprite.svg", import.meta.url)).text()
  for (const symbol of symbols) {
    if (!production.includes(symbol.replace('<symbol id="', '<symbol id="codex-native-')))
      throw new Error("Production sprite differs from verified native artwork")
  }
  console.log(
    "Verified " +
      manifest.icons.length +
      " native SVGs against ChatGPT build " +
      manifest.appBuild +
      "; all applied Codex replacements use native artwork.",
  )
} finally {
  closeSync(fd)
}
