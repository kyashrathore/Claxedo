import type { LiveConnectionAuthorization } from "../../ports/connections"

export type OpenPullRequestInput = Readonly<{
  repository: string
  head: string
  base: string
  title: string
  body?: string
  draft: boolean
  idempotencyKey: string
}>

export type OpenPullRequestResult = Readonly<{
  pullRequestId: string
  url: string
  draft: boolean
}>

export type CodeHostConnector = Readonly<{
  provider: string
  openPullRequest(
    authorization: LiveConnectionAuthorization,
    input: OpenPullRequestInput,
  ): Promise<OpenPullRequestResult>
  /** Provider-verified repository visibility. The public-PR confirmation gate
   *  must never trust an agent-supplied visibility flag; callers treat any
   *  failure here as public (fail closed into requiring confirmation). */
  repositoryVisibility(
    authorization: LiveConnectionAuthorization,
    repository: string,
  ): Promise<"public" | "private">
}>

export class CodeHostUnauthorizedError extends Error {
  readonly code = "connection_provider_unauthorized"
}

export class CodeHostProviderError extends Error {
  readonly code = "connection_provider_rejected"

  constructor(readonly provider: string, readonly status: number) {
    super(`${provider} rejected the code-host operation (${status})`)
  }
}
