import type {
  CloudflareOptionalServiceResources,
  CloudflareProvisionedServiceResources,
} from "../cloudflare-deployment-driver"

type CloudflareEnvelope<T> = Readonly<{
  success?: boolean
  result?: T
  errors?: readonly Readonly<{ code?: number; message?: string }>[]
}>

type D1DatabaseRecord = Readonly<{ uuid?: string; name?: string }>

export class CloudflareOptionalServiceResourceError extends Error {
  constructor(
    public readonly code: "api_failure" | "ambiguous_resource" | "resource_missing" | "resource_mismatch",
    message: string,
  ) {
    super(message)
    this.name = "CloudflareOptionalServiceResourceError"
  }
}

export type CloudflareAccountOptionalServiceResourcesInput = Readonly<{
  accountId: string
  apiToken: string
  fetch?: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>
  apiOrigin?: string
}>

function required(value: string, field: string) {
  if (!value || value.trim() !== value) throw new Error(`${field} must be a non-empty trimmed string`)
  return value
}

/**
 * Exact-account Cloudflare resource owner used only by an explicit optional
 * service install/uninstall workflow. Core boot never constructs this class.
 */
export class CloudflareAccountOptionalServiceResources implements CloudflareOptionalServiceResources {
  private readonly accountId: string
  private readonly apiToken: string
  private readonly fetch: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>
  private readonly apiOrigin: string

  constructor(input: CloudflareAccountOptionalServiceResourcesInput) {
    this.accountId = required(input.accountId, "accountId")
    this.apiToken = required(input.apiToken, "apiToken")
    this.fetch = input.fetch ?? globalThis.fetch
    this.apiOrigin = (input.apiOrigin ?? "https://api.cloudflare.com/client/v4").replace(/\/$/, "")
  }

  async provision(input: {
    serviceId: "documents"
    workerName: string
    databaseName: string
    bucketName?: string
  }): Promise<CloudflareProvisionedServiceResources> {
    const database = await this.findD1(input.databaseName)
    const databaseId = database?.uuid ?? (await this.createD1(input.databaseName)).uuid
    if (!databaseId) throw new CloudflareOptionalServiceResourceError("api_failure", "D1 create omitted its UUID")
    const bucketName = required(input.bucketName ?? "", "bucketName")
    if (!(await this.bucketExists(bucketName))) {
      await this.request(`/accounts/${encodeURIComponent(this.accountId)}/r2/buckets/${encodeURIComponent(bucketName)}`, {
        method: "PUT",
      })
    }
    return Object.freeze({ databaseId, bucketName })
  }

  async inspect(input: {
    serviceId: "documents"
    workerName: string
    databaseName: string
    bucketName?: string
  }): Promise<CloudflareProvisionedServiceResources> {
    const database = await this.findD1(input.databaseName)
    if (!database?.uuid) {
      throw new CloudflareOptionalServiceResourceError("resource_missing", `${input.databaseName} D1 does not exist`)
    }
    const bucketName = required(input.bucketName ?? "", "bucketName")
    if (!(await this.bucketExists(bucketName))) {
      throw new CloudflareOptionalServiceResourceError("resource_missing", `${bucketName} R2 bucket does not exist`)
    }
    return Object.freeze({ databaseId: database.uuid, bucketName })
  }

  async retire(input: {
    serviceId: "documents"
    workerName: string
    databaseName: string
    databaseId: string
    bucketName?: string
    retirementAuthorization: string
  }) {
    required(input.retirementAuthorization, "retirementAuthorization")
    const current = await this.findD1(input.databaseName)
    if (current && current.uuid !== input.databaseId) {
      throw new CloudflareOptionalServiceResourceError(
        "resource_mismatch",
        "refusing to retire a D1 database whose immutable UUID changed",
      )
    }
    const bucketName = required(input.bucketName ?? "", "bucketName")
    if (await this.bucketExists(bucketName)) {
      await this.request(`/accounts/${encodeURIComponent(this.accountId)}/r2/buckets/${encodeURIComponent(bucketName)}`, {
        method: "DELETE",
      })
    }
    if (current) {
      await this.request(
        `/accounts/${encodeURIComponent(this.accountId)}/d1/database/${encodeURIComponent(input.databaseId)}`,
        { method: "DELETE" },
      )
    }
  }

  async workerExists(workerName: string) {
    const response = await this.fetch(
      `${this.apiOrigin}/accounts/${encodeURIComponent(this.accountId)}/workers/scripts/${encodeURIComponent(required(workerName, "workerName"))}/deployments`,
      { headers: this.headers() },
    )
    if (response.status === 404) return false
    if (!response.ok) {
      throw new CloudflareOptionalServiceResourceError(
        "api_failure",
        `Cloudflare Worker lookup returned HTTP ${response.status}`,
      )
    }
    return true
  }

  private async findD1(name: string): Promise<Required<Pick<D1DatabaseRecord, "uuid" | "name">> | null> {
    const expectedName = required(name, "databaseName")
    const result = await this.request<D1DatabaseRecord[]>(
      `/accounts/${encodeURIComponent(this.accountId)}/d1/database?name=${encodeURIComponent(expectedName)}&per_page=100`,
    )
    const matches = result.filter((item) => item.name === expectedName)
    if (matches.length > 1) {
      throw new CloudflareOptionalServiceResourceError("ambiguous_resource", `${expectedName} resolved multiple D1 databases`)
    }
    const match = matches[0]
    if (!match) return null
    if (!match.uuid || match.name !== expectedName) {
      throw new CloudflareOptionalServiceResourceError("api_failure", "Cloudflare returned a malformed D1 record")
    }
    return { uuid: match.uuid, name: match.name }
  }

  private async createD1(name: string) {
    const created = await this.request<D1DatabaseRecord>(
      `/accounts/${encodeURIComponent(this.accountId)}/d1/database`,
      { method: "POST", body: JSON.stringify({ name: required(name, "databaseName") }) },
    )
    if (!created.uuid || created.name !== name) {
      throw new CloudflareOptionalServiceResourceError("api_failure", "Cloudflare returned another D1 database")
    }
    return created as Required<Pick<D1DatabaseRecord, "uuid" | "name">>
  }

  private async bucketExists(name: string) {
    const response = await this.fetch(
      `${this.apiOrigin}/accounts/${encodeURIComponent(this.accountId)}/r2/buckets/${encodeURIComponent(name)}`,
      { headers: this.headers() },
    )
    if (response.status === 404) return false
    await this.response<unknown>(response)
    return true
  }

  private async request<T>(path: string, init: RequestInit = {}) {
    const response = await this.fetch(`${this.apiOrigin}${path}`, {
      ...init,
      headers: { ...this.headers(), ...(init.body ? { "content-type": "application/json" } : {}) },
    })
    return this.response<T>(response)
  }

  private async response<T>(response: Response): Promise<T> {
    let body: CloudflareEnvelope<T>
    try {
      body = (await response.json()) as CloudflareEnvelope<T>
    } catch {
      throw new CloudflareOptionalServiceResourceError("api_failure", `Cloudflare API returned HTTP ${response.status}`)
    }
    if (!response.ok || body.success !== true || body.result === undefined) {
      const message = body.errors?.map((item) => item.message).filter(Boolean).join("; ")
      throw new CloudflareOptionalServiceResourceError(
        "api_failure",
        message || `Cloudflare API returned HTTP ${response.status}`,
      )
    }
    return body.result
  }

  private headers() {
    return { authorization: `Bearer ${this.apiToken}` }
  }
}
