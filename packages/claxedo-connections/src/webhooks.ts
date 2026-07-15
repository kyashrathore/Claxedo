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
    receivedAt: number
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
      const verified = await provider.verify({
        secret: connection.secret,
        headers: request.headers,
        body: request.body,
        receivedAt: request.receivedAt,
      })
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
      if (!await verifySha256(input.secret, input.body, signature.slice("sha256=".length))) return undefined
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

/** Linear's raw-body HMAC plus its documented one-minute replay window. */
export function linearConnectionWebhookVerifier(input: Readonly<{ maxAgeMs?: number }> = {}): ConnectionWebhookProviderVerifier {
  const maxAgeMs = input.maxAgeMs ?? 60_000
  return {
    async verify(request) {
      const signature = request.headers["linear-signature"]?.trim()
      const deliveryId = request.headers["linear-delivery"]?.trim()
      const event = request.headers["linear-event"]?.trim()
      const headerTimestamp = request.headers["linear-timestamp"]?.trim()
      if (!signature || !deliveryId || !event || !headerTimestamp) return undefined
      if (!await verifySha256(request.secret, request.body, signature)) return undefined
      const body = jsonRecord(request.body)
      if (!body || !Number.isSafeInteger(body.webhookTimestamp)) return undefined
      const webhookTimestamp = body.webhookTimestamp as number
      if (headerTimestamp !== String(webhookTimestamp) || Math.abs(request.receivedAt - webhookTimestamp) > maxAgeMs) return undefined
      const data = record(body.data)
      const team = record(data?.team)
      const identifier = typeof data?.identifier === "string" ? data.identifier : undefined
      const teams = unique([
        typeof data?.teamId === "string" ? data.teamId : undefined,
        typeof team?.id === "string" ? team.id : undefined,
        typeof team?.key === "string" ? team.key : undefined,
        identifier?.includes("-") ? identifier.slice(0, identifier.indexOf("-")) : undefined,
      ])
      return {
        deliveryId,
        event,
        attributes: {
          ...(teams.length ? { team: teams } : {}),
          ...(typeof body.organizationId === "string" ? { organization: body.organizationId } : {}),
          ...(typeof data?.id === "string" ? { issue: data.id } : {}),
        },
      }
    },
  }
}

/** Jira Cloud admin/REST webhook HMAC and retry-stable delivery identity. */
export function jiraConnectionWebhookVerifier(): ConnectionWebhookProviderVerifier {
  return {
    async verify(input) {
      const signature = input.headers["x-hub-signature"]?.trim()
      const deliveryId = input.headers["x-atlassian-webhook-identifier"]?.trim()
      if (!signature?.startsWith("sha256=") || !deliveryId) return undefined
      if (!await verifySha256(input.secret, input.body, signature.slice("sha256=".length))) return undefined
      const body = jsonRecord(input.body)
      const event = typeof body?.webhookEvent === "string" ? body.webhookEvent.trim() : ""
      if (!body || !event) return undefined
      const issue = record(body.issue)
      const fields = record(issue?.fields)
      const project = record(fields?.project)
      const changelog = record(body.changelog)
      const projectChanges = Array.isArray(changelog?.items)
        ? changelog.items.flatMap((value) => {
            const item = record(value)
            if (typeof item?.field !== "string" || item.field.toLowerCase() !== "project") return []
            return [item.from, item.fromString, item.to, item.toString]
              .filter((project): project is string => typeof project === "string")
          })
        : []
      const projects = unique([
        typeof project?.id === "string" ? project.id : undefined,
        typeof project?.key === "string" ? project.key : undefined,
        typeof project?.name === "string" ? project.name : undefined,
        ...projectChanges,
      ])
      return {
        deliveryId,
        event,
        attributes: {
          ...(projects.length ? { project: projects } : {}),
          ...(typeof issue?.id === "string" ? { issue: issue.id } : {}),
          ...(typeof issue?.key === "string" ? { issueKey: issue.key } : {}),
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

async function verifySha256(secret: string, body: Uint8Array, signature: string) {
  const provided = hex(signature)
  if (!provided) return false
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["verify"],
  )
  return crypto.subtle.verify("HMAC", key, buffer(provided), buffer(body))
}

function unique(values: readonly (string | undefined)[]) {
  return [...new Set(values.flatMap((value) => value?.trim() ? [value.trim()] : []))]
}

function buffer(value: Uint8Array) {
  const result = new ArrayBuffer(value.byteLength)
  new Uint8Array(result).set(value)
  return result
}
