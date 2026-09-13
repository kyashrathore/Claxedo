/**
 * Where a provider's binding is allowed to reach, and what the broker puts on
 * the request when it gets there.
 *
 * A provider absent from this table gets no binding at all, so adding a harness
 * to the broker means adding its row here and nowhere else. The vendor's host,
 * its allowed methods and paths, and the header shape it accepts are all one
 * fact about that vendor, which is why they are one row.
 */

import { credentialSecretMaterial, isSubscriptionKind } from "@claxedo/server-core/credentials/secret-material"
import type { CredentialKind } from "@claxedo/server-core/credentials/types"

export type ProviderDestination = {
  origin: string
  methods: readonly string[]
  pathPrefixes: readonly string[]
  /**
   * Where the vendor's API root sits under the binding path. A harness whose
   * client appends the whole vendor path itself (Claude Code, the Cursor SDK)
   * configures the binding root; one that is configured with an API root
   * (Codex, Pi, the OpenCode engine) appends this to it.
   */
  apiPath: string
  injection: { header: string; scheme?: string; headers?: Record<string, string | null> }
  /** What the broker injects, which is the token inside a stored login document. */
  value: string
}

/**
 * Which slot a harness must put the credential in, read from the header the
 * vendor accepts it in. Every delivery path answers this question about the
 * same row, so the row answers it once.
 */
export function destinationAuthMode(
  destination: Pick<ProviderDestination, "injection">,
): "api-key" | "bearer" {
  return destination.injection.header.toLowerCase() === "authorization" ? "bearer" : "api-key"
}

type ProviderRow = (material: {
  token: string
  accountId?: string
  form: "api-key" | "subscription"
}) => Omit<ProviderDestination, "value">

const anthropicDestination: ProviderRow = (material) => ({
  origin: "https://api.anthropic.com",
  // The routes a turn needs and no others. `/v1/messages` also covers
  // `/v1/messages/count_tokens`, which the CLI calls before a long prompt;
  // `/v1/models` is the catalog it reads to resolve a model alias. The whole
  // `/v1/` version would additionally open the Files, Batches and
  // organization-admin APIs to anything sharing the sandbox.
  methods: ["POST", "GET"],
  pathPrefixes: ["/v1/messages", "/v1/models"],
  apiPath: "/v1",
  injection: material.form === "subscription"
    ? { header: "Authorization", scheme: "Bearer" }
    : { header: "x-api-key" },
})

/**
 * A ChatGPT subscription is not served by the API host at all: its Codex
 * traffic answers on `chatgpt.com/backend-api/codex`, and the account header is
 * what tells that backend which plan the token spends — the same pair the
 * credential verification probe sends.
 */
const openaiDestination: ProviderRow = (material) => material.form === "subscription"
  ? {
    origin: "https://chatgpt.com",
    methods: ["POST", "GET"],
    // The turn itself, and the catalog the app-server reads to check a model is
    // eligible on this plan (`?client_version=`). Nothing else under
    // `/backend-api/codex/` belongs to a turn.
    pathPrefixes: ["/backend-api/codex/responses", "/backend-api/codex/models"],
    apiPath: "/backend-api/codex",
    injection: {
      header: "Authorization",
      scheme: "Bearer",
      // Declared even when the login names no account: the name is this row's,
      // so the harness's own value never travels beside the operator's token.
      headers: { "ChatGPT-Account-Id": material.accountId ?? null },
    },
  }
  : {
    origin: "https://api.openai.com",
    methods: ["POST", "GET"],
    // `responses` is Codex's wire API; `chat/completions` is what the
    // OpenAI-compatible clients the OpenCode engine and Pi build on send; both
    // resolve a model alias against the catalog. The whole `/v1/` would also
    // open Files, Assistants, fine-tuning and Batches.
    pathPrefixes: ["/v1/responses", "/v1/chat/completions", "/v1/models"],
    apiPath: "/v1",
    injection: { header: "Authorization", scheme: "Bearer" },
  }

/**
 * `api2.cursor.sh` is the host the installed SDK's `CURSOR_BACKEND_URL` default
 * names for the agent itself: the API-key exchange and the Connect services the
 * turn runs over. The cloud REST host (`api.cursor.com`, the model catalog) is
 * a different origin the same variable also redirects, so a brokered Cursor
 * turn cannot read that catalog and falls back to its default model.
 */
const cursorDestination: ProviderRow = () => ({
  origin: "https://api2.cursor.sh",
  methods: ["POST", "GET"],
  pathPrefixes: [
    "/auth/exchange_user_api_key",
    "/agent.v1.AgentService",
    "/aiserver.v1.BidiService",
    "/aiserver.v1.ServerConfigService",
  ],
  apiPath: "",
  injection: { header: "Authorization", scheme: "Bearer" },
})

/**
 * The OpenAI-compatible model vendors the OpenCode engine and Pi define
 * providers for.
 *
 * They reached those harnesses as a plaintext copy of the stored key until the
 * broker took over delivery, and a provider with no row here reaches them not
 * at all — so a row is what keeps each of these accounts working. Each one is
 * the vendor's own API root and the header its SDK sends the key in.
 */
const openAiCompatibleDestination = (input: {
  origin: string
  apiPath: string
  header?: string
  scheme?: string
}): ProviderRow => () => ({
  origin: input.origin,
  methods: ["POST", "GET"],
  pathPrefixes: [`${input.apiPath}/`],
  apiPath: input.apiPath,
  injection: input.header
    ? { header: input.header }
    : { header: "Authorization", scheme: "Bearer" },
})

const PROVIDER_ROWS: Record<string, ProviderRow> = {
  anthropic: anthropicDestination,
  "claude-sdk": anthropicDestination,
  openai: openaiDestination,
  "codex-app-server": openaiDestination,
  cursor: cursorDestination,
  "cursor-sdk": cursorDestination,
  openrouter: openAiCompatibleDestination({ origin: "https://openrouter.ai", apiPath: "/api/v1" }),
  // Gemini takes its key in its own header rather than a bearer.
  google: openAiCompatibleDestination({
    origin: "https://generativelanguage.googleapis.com",
    apiPath: "/v1beta",
    header: "x-goog-api-key",
  }),
  groq: openAiCompatibleDestination({ origin: "https://api.groq.com", apiPath: "/openai/v1" }),
  xai: openAiCompatibleDestination({ origin: "https://api.x.ai", apiPath: "/v1" }),
}

/**
 * Whether this provider can be bound at all, asked without reading its secret.
 *
 * `Object.hasOwn`, because `in` reaches `Object.prototype`: a provider id of
 * `constructor` or `toString` answered true here and then had no row to bind.
 */
export function hasProviderDestination(providerId: string): boolean {
  return Object.hasOwn(PROVIDER_ROWS, providerId)
}

/**
 * The destination a stored row resolves to, asked with the row's shape rather
 * than its value.
 *
 * A surface that lists accounts holds metadata and no secret, and the question
 * it asks — can this account be delivered to a cloud sandbox — is answered by
 * the header shape alone. `accountId` is unknown here, which is the same answer
 * a login that names no account gives: the companion header is declared either
 * way, because the name belongs to the row rather than to the value.
 */
export function providerDestinationShape(input: {
  providerId: string
  kind: CredentialKind
}): Omit<ProviderDestination, "value"> | undefined {
  const row = Object.hasOwn(PROVIDER_ROWS, input.providerId) ? PROVIDER_ROWS[input.providerId] : undefined
  return row?.({ token: "", form: isSubscriptionKind(input.kind) ? "subscription" : "api-key" })
}

export function providerDestination(input: {
  providerId: string
  kind: CredentialKind
  secret: string
}): ProviderDestination | undefined {
  const row = Object.hasOwn(PROVIDER_ROWS, input.providerId) ? PROVIDER_ROWS[input.providerId] : undefined
  if (!row) return undefined
  const material = credentialSecretMaterial({ kind: input.kind, secret: input.secret })
  if (!material) return undefined
  return { ...row(material), value: material.token }
}
