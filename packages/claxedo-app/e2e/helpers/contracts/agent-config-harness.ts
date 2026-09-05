import type { RuntimeHarnessSelection } from "@claxedo/server-core/agent-config/index"

export class HarnessConfigContractError extends Error {
  constructor(url: string, problems: string[]) {
    super(`POST ${url} violated the canonical harness-config contract:\n  - ${problems.join("\n  - ")}`)
    this.name = "HarnessConfigContractError"
  }
}

function record(input: unknown): Record<string, unknown> | undefined {
  return input && typeof input === "object" && !Array.isArray(input)
    ? input as Record<string, unknown>
    : undefined
}

const NATIVE = new Set(["claude", "codex", "cursor", "pi", "opencode"])

export function parseHarnessConfigRequest(rawBody: unknown, url: string): {
  selection: RuntimeHarnessSelection
  sessionId?: string
} {
  const body = record(rawBody)
  const harness = record(body?.harness)
  const problems: string[] = []
  let selection: RuntimeHarnessSelection | undefined

  if (harness?.kind === "native" && typeof harness.harnessId === "string" && NATIVE.has(harness.harnessId)) {
    selection = { kind: "native", harnessId: harness.harnessId as "claude" | "codex" | "cursor" | "pi" }
  } else if (harness?.kind === "connection" && typeof harness.connectionId === "string" && harness.connectionId.trim()) {
    selection = { kind: "connection", connectionId: harness.connectionId.trim() }
  } else {
    problems.push("harness must be {kind:'native', harnessId} or {kind:'connection', connectionId}")
  }

  for (const key of Object.keys(body ?? {})) {
    if (key !== "harness" && key !== "sessionId") problems.push(`unknown field ${key}`)
  }
  if (body?.sessionId !== undefined && typeof body.sessionId !== "string") problems.push("sessionId must be a string")
  if (problems.length || !selection) throw new HarnessConfigContractError(url, problems)

  return {
    selection,
    ...(typeof body?.sessionId === "string" ? { sessionId: body.sessionId } : {}),
  }
}

export const HARNESS_POST_SUCCESS = { status: 200, body: { ok: true } } as const
