import type { CDPSession, Page } from "@playwright/test"
import fs from "node:fs"
import path from "node:path"
import { SourceMapConsumer } from "../../../../../node_modules/.bun/node_modules/source-map/source-map.js"
import { normalizeSource } from "./bytes"

type Range = { readonly startOffset: number; readonly endOffset: number; readonly count: number }
type ScriptCoverage = { readonly url: string; readonly functions: readonly { readonly ranges: readonly Range[] }[] }

export type ModuleUse = { readonly source: string; readonly bytes: number; readonly used: number }

export type FileUse = {
  readonly path: string
  readonly kind: "js" | "css"
  readonly bytes: number
  readonly used: number
  readonly modules: readonly ModuleUse[]
}

export type Coverage = { take(page: Page): Promise<readonly FileUse[]> }

function executed(length: number, functions: ScriptCoverage["functions"]) {
  const used = new Uint8Array(length)
  const ranges = functions.flatMap((fn) => fn.ranges).sort((a, b) => a.startOffset - b.startOffset || b.endOffset - a.endOffset)
  for (const range of ranges) used.fill(range.count > 0 ? 1 : 0, range.startOffset, Math.min(range.endOffset, length))
  return used
}

function lineStarts(text: string) {
  const starts = [0]
  for (let index = 0; index < text.length; index += 1) if (text.charCodeAt(index) === 10) starts.push(index + 1)
  return starts
}

function moduleUse(mapFile: string, text: string, used: Uint8Array): ModuleUse[] {
  if (!fs.existsSync(mapFile)) return []
  const consumer = new SourceMapConsumer(JSON.parse(fs.readFileSync(mapFile, "utf8")))
  const starts = lineStarts(text)
  const sums = new Uint32Array(used.length + 1)
  for (let index = 0; index < used.length; index += 1) sums[index + 1] = sums[index] + used[index]
  const totals = new Map<string, { bytes: number; used: number }>()
  let previous: { source: string; offset: number } | undefined
  const credit = (end: number) => {
    if (!previous || end <= previous.offset) return
    const entry = totals.get(previous.source) ?? { bytes: 0, used: 0 }
    entry.bytes += end - previous.offset
    entry.used += sums[end] - sums[previous.offset]
    totals.set(previous.source, entry)
  }
  consumer.eachMapping((mapping) => {
    const offset = (starts[mapping.generatedLine - 1] ?? text.length) + mapping.generatedColumn
    credit(offset)
    previous = mapping.source ? { source: normalizeSource(mapping.source), offset } : undefined
  }, undefined, SourceMapConsumer.GENERATED_ORDER)
  credit(text.length)
  return [...totals.entries()].map(([source, entry]) => ({ source, ...entry })).sort((a, b) => b.bytes - b.used - (a.bytes - a.used))
}

function scriptUse(distDir: string, script: ScriptCoverage): FileUse | undefined {
  const pathname = URL.canParse(script.url) ? new URL(script.url).pathname : ""
  const file = path.join(distDir, pathname)
  if (!pathname.startsWith("/assets/") || !fs.existsSync(file)) return undefined
  const text = fs.readFileSync(file, "utf8")
  const used = executed(text.length, script.functions)
  return { path: pathname, kind: "js", bytes: text.length, used: used.reduce((sum, value) => sum + value, 0), modules: moduleUse(`${file}.map`, text, used) }
}

function matchedStyleRules() {
  const interactive = /::?(?:before|after|placeholder|selection|marker|backdrop|-webkit-[\w-]+|-moz-[\w-]+|scrollbar[\w-]*)|:(?:hover|focus|focus-visible|focus-within|active|visited|checked|disabled|indeterminate|placeholder-shown|autofill|open|popover-open|user-invalid|empty)\b/g
  const matches = (selector: string) => {
    try {
      return document.querySelector(selector.replace(interactive, "").replace(/&/g, "").trim() || "*") !== null
    } catch {
      return true
    }
  }
  const tally = (rules: CSSRuleList): { bytes: number; matched: number } => {
    let bytes = 0
    let matched = 0
    for (const rule of Array.from(rules)) {
      if (rule instanceof CSSStyleRule) {
        bytes += rule.cssText.length
        if (rule.selectorText.split(",").some(matches)) matched += rule.cssText.length
      } else if ("cssRules" in rule && !(rule instanceof CSSKeyframesRule) && rule.cssRules instanceof CSSRuleList) {
        const inner = tally(rule.cssRules)
        bytes += inner.bytes
        matched += inner.matched
      } else {
        bytes += rule.cssText.length
        matched += rule.cssText.length
      }
    }
    return { bytes, matched }
  }
  return Array.from(document.styleSheets).filter((sheet) => sheet.href).map((sheet) => ({ href: sheet.href ?? "", ...tally(sheet.cssRules) }))
}

export async function startCoverage(cdp: CDPSession, distDir: string): Promise<Coverage> {
  await cdp.send("Profiler.enable")
  await cdp.send("Profiler.startPreciseCoverage", { callCount: false, detailed: true })
  return {
    take: async (page) => {
      const { result } = await cdp.send("Profiler.takePreciseCoverage")
      await cdp.send("Profiler.stopPreciseCoverage")
      const sheets = await page.evaluate(matchedStyleRules)
      const scripts = result.map((script: ScriptCoverage) => scriptUse(distDir, script)).filter((file): file is FileUse => file !== undefined)
      const styles = sheets.map((sheet): FileUse => ({ path: new URL(sheet.href).pathname, kind: "css", bytes: sheet.bytes, used: sheet.matched, modules: [] }))
      return [...scripts, ...styles].sort((a, b) => b.bytes - a.bytes)
    },
  }
}
