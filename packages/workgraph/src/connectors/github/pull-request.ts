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

export function createGitHubCodeHostConnector(input: Readonly<{
  baseUrl?: string
  fetch?: typeof globalThis.fetch
}> = {}): CodeHostConnector {
  const baseUrl = (input.baseUrl ?? "https://api.github.com").replace(/\/$/, "")
  const request = input.fetch ?? globalThis.fetch
  return {
    provider: "github",
    async openPullRequest(authorization, operation) {
      const result = await request(`${baseUrl}/repos/${operation.repository}/pulls`, {
        method: "POST",
        headers: {
          accept: "application/vnd.github+json",
          "content-type": "application/json",
          authorization: `${authorization.tokenType === "basic" ? "Basic" : "Bearer"} ${authorization.token}`,
          "idempotency-key": operation.idempotencyKey,
        },
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
      const parsed = response.parse(await result.json())
      return { pullRequestId: String(parsed.id), url: parsed.html_url, draft: parsed.draft ?? operation.draft }
    },
  }
}
