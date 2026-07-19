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
