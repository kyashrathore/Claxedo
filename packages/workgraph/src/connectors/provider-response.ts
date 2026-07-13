import { z } from "zod"
import { SourceIssueResponseError, SourceIssueTransportError } from "./interface"

export const providerIdentifier = z.union([
  z.string().trim().min(1),
  z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
])

export const providerTimestamp = z.string().datetime({ offset: true })

export function decodeSourceIssueResponse<Output>(
  provider: "github" | "linear" | "jira",
  schema: z.ZodType<Output>,
  value: unknown,
) {
  const result = schema.safeParse(value)
  if (!result.success) throw new SourceIssueResponseError(provider)
  return result.data
}

export async function readSourceIssueResponse(provider: "github" | "linear" | "jira", response: Response) {
  try {
    return await response.json()
  } catch {
    throw new SourceIssueResponseError(provider)
  }
}

export function requestSourceIssue(provider: "github" | "linear" | "jira", request: () => Promise<Response>) {
  return Promise.resolve()
    .then(request)
    .catch(() => { throw new SourceIssueTransportError(provider) })
}
