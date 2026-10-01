import { asRecord } from "@claxedo/helpers/guards"
import { asText as text } from "@claxedo/agent-runtime-contract"
import type { AgentRuntimeEvent } from "@claxedo/agent-runtime-contract"

function diff(value: unknown) {
  if (!Array.isArray(value) || value.length === 0) return false
  return value.every((item) => {
    const row = asRecord(item)
    if (!row) return false
    return "path" in row || "oldText" in row || "newText" in row
  })
}

function shell(
  input: Record<string, unknown>,
  metadata: Record<string, unknown>,
) {
  if (typeof input.intent === "string") return input.intent === "shell"
  const acp = asRecord(metadata.acp)
  return acp?.intent === "shell"
}

function stringifyProjectionValue(value: unknown): { value: string; issues: string[] } {
  const issues = new Set<string>()
  const seen = new WeakSet<object>()
  const result = JSON.stringify(value, (_key, item: unknown) => {
    if (typeof item === "bigint") {
      issues.add("bigint")
      return item.toString()
    }
    if (typeof item === "function") {
      issues.add("function")
      return `[Function ${item.name || "anonymous"}]`
    }
    if (typeof item === "symbol") {
      issues.add("symbol")
      return String(item)
    }
    if (item && typeof item === "object") {
      if (seen.has(item)) {
        issues.add("circular")
        return "[Circular]"
      }
      seen.add(item)
    }
    return item
  })
  if (result !== undefined) return { value: result, issues: [...issues] }
  return { value: String(value), issues: [...issues, "empty-json"] }
}

export function formatToolOutput(
  value: unknown,
  input: Record<string, unknown>,
  metadata: Record<string, unknown>,
): { value: string; issues: string[] } {
  if (typeof value === "string") return { value, issues: [] }
  if (value == null) return { value: "", issues: [] }

  const row = asRecord(value)
  if (row && shell(input, metadata)) {
    const stdout = text(row.stdout)
    const stderr = text(row.stderr)
    const list = [stdout, stderr].filter((item): item is string => !!item)
    if (list.length > 0) return { value: list.join("\n"), issues: [] }
  }

  if (diff(value)) return { value: "", issues: [] }

  if (row) {
    const body = text(row.content) ?? arrayContentText(row.content) ?? text(row.text) ?? text(row.body) ?? text(row.stdout) ?? text(row.stderr)
    if (body) return { value: body, issues: [] }
    const onlyScalars = Object.values(row).every((item) =>
      item == null || typeof item === "string" || typeof item === "number" || typeof item === "boolean",
    )
    if (onlyScalars) return { value: "", issues: [] }
  }

  const body = arrayContentText(value)
  if (body !== undefined) return { value: body, issues: [] }

  return stringifyProjectionValue(value)
}

function arrayContentText(value: unknown): string | undefined {
  if (!Array.isArray(value)) return undefined
  const content = value.flatMap((item) => {
    if (typeof item === "string") return item
    const row = asRecord(item)
    return text(row?.text) ?? text(row?.content) ?? []
  })
  if (content.length !== value.length) return undefined
  return content.join("\n")
}

export function toolContentText(content: Extract<AgentRuntimeEvent, { type: "tool-content" }>["content"]) {
  if (content.type !== "content") return undefined
  const row = asRecord(content.content)
  return text(row?.text)
}

function isTextContent(item: unknown): boolean {
  if (!item || typeof item !== "object" || (item as { type?: unknown }).type !== "content") return false
  const inner = (item as { content?: unknown }).content
  return !!inner && typeof inner === "object" && (inner as { type?: unknown }).type === "text"
}

export function withoutOutputText(metadata: Record<string, unknown>): Record<string, unknown> {
  const acp = metadata.acp
  if (!acp || typeof acp !== "object" || !Array.isArray((acp as { content?: unknown }).content)) return metadata
  const { content, ...rest } = acp as { content: unknown[] } & Record<string, unknown>
  const kept = content.filter((item) => !isTextContent(item))
  return { ...metadata, acp: kept.length ? { ...rest, content: kept } : rest }
}
