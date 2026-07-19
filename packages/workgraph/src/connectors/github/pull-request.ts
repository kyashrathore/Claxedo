import { z } from "zod"
import {
  CodeHostProviderError,
  CodeHostUnauthorizedError,
  type CodeHostConnector,
} from "../code-host/interface"

const response = z.object({
  id: z.union([z.string(), z.number()]),
  html_url: z.string().url(),
  draft: z.boolean().optional(),
}).passthrough()

const repository = z.object({ private: z.boolean() }).passthrough()

export function createGitHubCodeHostConnector(input: Readonly<{
  baseUrl?: string
  fetch?: typeof globalThis.fetch
}> = {}): CodeHostConnector {
  const baseUrl = (input.baseUrl ?? "https://api.github.com").replace(/\/$/, "")
  const request = input.fetch ?? globalThis.fetch
  const headers = (authorization: { tokenType?: string; token: string }, extra: Record<string, string> = {}) => ({
    accept: "application/vnd.github+json",
    authorization: `${authorization.tokenType === "basic" ? "Basic" : "Bearer"} ${authorization.token}`,
    ...extra,
  })
  // Transport and parse failures surface as the typed provider errors every
  // caller maps (503 = retryable transport, 502 = malformed body) — a raw
  // TypeError/ZodError would be misclassified as a hard failure and burn the
  // effect ledger's retry budget.
  const send = async (url: string, init?: Parameters<typeof request>[1]) => {
    try {
      return await request(url, init)
    } catch {
      throw new CodeHostProviderError("github", 503)
    }
  }
  const parse = async <Value>(result: Response, schema: z.ZodType<Value>): Promise<Value> => {
    try {
      return schema.parse(await result.json())
    } catch {
      throw new CodeHostProviderError("github", 502)
    }
  }
  return {
    provider: "github",
    async openPullRequest(authorization, operation) {
      const result = await send(`${baseUrl}/repos/${operation.repository}/pulls`, {
        method: "POST",
        headers: headers(authorization, {
          "content-type": "application/json",
          "idempotency-key": operation.idempotencyKey,
        }),
        body: JSON.stringify({
          head: operation.head,
          base: operation.base,
          title: operation.title,
          ...(operation.body === undefined ? {} : { body: operation.body }),
          draft: operation.draft,
        }),
      })
      if (result.status === 401 || result.status === 403) throw new CodeHostUnauthorizedError("github authorization failed")
      if (!result.ok) throw new CodeHostProviderError("github", result.status)
      const parsed = await parse(result, response)
      return { pullRequestId: String(parsed.id), url: parsed.html_url, draft: parsed.draft ?? operation.draft }
    },
    async repositoryVisibility(authorization, name) {
      const result = await send(`${baseUrl}/repos/${name}`, { headers: headers(authorization) })
      if (result.status === 401 || result.status === 403) throw new CodeHostUnauthorizedError("github authorization failed")
      if (!result.ok) throw new CodeHostProviderError("github", result.status)
      return (await parse(result, repository)).private ? "private" : "public"
    },
  }
}
