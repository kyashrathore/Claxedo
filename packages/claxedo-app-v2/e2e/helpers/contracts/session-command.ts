import type { createSessionRoutes } from "@claxedo/workspace-runtime/routes"

type SessionRouteOpts = Parameters<typeof createSessionRoutes>[0]
type ServerAdapter = Awaited<ReturnType<SessionRouteOpts["resolveAdapter"]>>
type ServerExecuteCommand = NonNullable<ServerAdapter["executeCommand"]>
type ServerCommandArgument = Parameters<ServerExecuteCommand>[1]
type SessionCommandBody = { command?: ServerCommandArgument }

class SessionCommandContractError extends Error {
  constructor(url: string, problems: string[]) {
    super(`POST ${url} violated the workspace-runtime command contract:\n  - ${problems.join("\n  - ")}`)
    this.name = "SessionCommandContractError"
  }
}

// The route has no named request schema. Bind its command value to the adapter
// contract; reject extra fixture fields so tests cannot hide discarded user input.
export function parseSessionCommandRequest(rawBody: unknown, url: string): SessionCommandBody {
  if (rawBody === undefined || rawBody === null) return {}
  if (typeof rawBody !== "object" || Array.isArray(rawBody)) {
    throw new SessionCommandContractError(url, ["body must be a JSON object"])
  }
  const body = rawBody as Record<string, unknown>
  const problems: string[] = []
  if (body.command !== undefined && typeof body.command !== "string") problems.push("command must be a string")
  for (const field of Object.keys(body)) {
    if (field !== "command") problems.push(`unknown field "${field}" would be discarded by the server`)
  }
  if (problems.length) throw new SessionCommandContractError(url, problems)
  return body as SessionCommandBody
}

export const SESSION_COMMAND_SUCCESS = {
  status: 200,
  contentType: "application/json",
  body: JSON.stringify({ ok: true }),
} as const
