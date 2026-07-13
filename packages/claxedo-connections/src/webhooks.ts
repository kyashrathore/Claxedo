export type ConnectionWebhookRequest = Readonly<{
  connectionId: string
  provider: string
  headers: Readonly<Record<string, string>>
  body: Uint8Array
  receivedAt: number
}>

/**
 * The only value allowed to cross from provider webhook authentication into
 * a consuming feature. Provider bodies and signing secrets stay inside the
 * Connection-owned verifier.
 */
export type VerifiedConnectionWebhookSignal = Readonly<{
  connectionId: string
  provider: string
  deliveryId: string
  event: string
  attributes: Readonly<Record<string, string | readonly string[]>>
  receivedAt: number
}>

export type ConnectionWebhookVerifier = Readonly<{
  verify(request: ConnectionWebhookRequest): Promise<VerifiedConnectionWebhookSignal | undefined>
}>

export type ConnectionWebhookProviderVerifier = Readonly<{
  verify(input: Readonly<{
    secret: string
    headers: Readonly<Record<string, string>>
    body: Uint8Array
  }>): Promise<Readonly<{
    deliveryId: string
    event: string
    attributes: Readonly<Record<string, string | readonly string[]>>
  }> | undefined>
}>

export function createConnectionWebhookVerifier(input: Readonly<{
  resolve(connectionId: string): Promise<Readonly<{ provider: string; secret: string }> | undefined>
  providers: Readonly<Record<string, ConnectionWebhookProviderVerifier>>
}>): ConnectionWebhookVerifier {
  return {
    async verify(request) {
      const connection = await input.resolve(request.connectionId)
      if (!connection || connection.provider !== request.provider) return undefined
      const provider = input.providers[connection.provider]
      if (!provider) return undefined
      const verified = await provider.verify({ secret: connection.secret, headers: request.headers, body: request.body })
      if (!verified) return undefined
      return { ...verified, connectionId: request.connectionId, provider: request.provider, receivedAt: request.receivedAt }
    },
  }
}

export function githubConnectionWebhookVerifier(): ConnectionWebhookProviderVerifier {
  return {
    async verify(input) {
      const signature = input.headers["x-hub-signature-256"]?.trim()
      const deliveryId = input.headers["x-github-delivery"]?.trim()
      const event = input.headers["x-github-event"]?.trim()
      if (!signature?.startsWith("sha256=") || !deliveryId || !event) return undefined
      const provided = hex(signature.slice("sha256=".length))
      if (!provided) return undefined
      const key = await crypto.subtle.importKey(
        "raw",
        new TextEncoder().encode(input.secret),
        { name: "HMAC", hash: "SHA-256" },
        false,
        ["verify"],
      )
      if (!await crypto.subtle.verify("HMAC", key, buffer(provided), buffer(input.body))) return undefined
      const body = jsonRecord(input.body)
      if (!body) return undefined
      const repository = record(body.repository)
      const issue = record(body.issue)
      const labels = Array.isArray(issue?.labels)
        ? issue.labels.flatMap((label) => typeof label === "string" ? [label] : typeof record(label)?.name === "string" ? [record(label)!.name as string] : [])
        : []
      return {
        deliveryId,
        event,
        attributes: {
          ...(typeof repository?.full_name === "string" ? { repo: repository.full_name } : {}),
          ...(typeof issue?.state === "string" ? { state: issue.state } : {}),
          ...(labels.length ? { labels } : {}),
        },
      }
    },
  }
}

function record(value: unknown) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined
  return value as Record<string, unknown>
}

function jsonRecord(value: Uint8Array) {
  try {
    return record(JSON.parse(new TextDecoder().decode(value)))
  } catch {
    return undefined
  }
}

function hex(value: string) {
  if (!/^[a-f0-9]{64}$/i.test(value)) return undefined
  return Uint8Array.from(value.match(/../g)!.map((byte) => Number.parseInt(byte, 16)))
}

function buffer(value: Uint8Array) {
  const result = new ArrayBuffer(value.byteLength)
  new Uint8Array(result).set(value)
  return result
}
