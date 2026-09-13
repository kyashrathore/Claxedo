export type RuntimeIdentity = Readonly<{
  userId: string
  orgId: string
  workspaceId: string
  leaseId: string
  leaseGeneration: number
  runtimeId: string
}>

export type Binding = Readonly<RuntimeIdentity & {
  id: string
  credentialId: string
  revision: number
  status: "active" | "withdrawn"
  destination: Readonly<{
    origin: string
    methods: readonly string[]
    pathPrefixes: readonly string[]
  }>
  /**
   * `header` carries the credential value; `headers` are the fixed companions
   * the vendor requires alongside it (ChatGPT's account id), which the broker
   * sets so the harness never has to be told them.
   *
   * A `null` value names a companion this binding owns and has no value for.
   * The broker strips every name here either way: a row whose account carries
   * no id would otherwise let the harness's own `ChatGPT-Account-Id` travel to
   * the vendor beside the operator's real token, spending one account's
   * credential against another's plan.
   */
  injection: Readonly<{ header: string; scheme?: string; headers?: Readonly<Record<string, string | null>> }>
}>

export type BindingFailure = Readonly<{
  bindingId: string
  credentialId: string
  revision: number
  status: number
}>

export interface BindingAuthority {
  resolve(bindingId: string): Promise<{ binding: Binding; value: string } | undefined>
  currentRuntime(identity: RuntimeIdentity): Promise<boolean>
  reportFailure(failure: BindingFailure): Promise<void>
}

export function sameRuntime(a: RuntimeIdentity, b: RuntimeIdentity) {
  return a.userId === b.userId && a.orgId === b.orgId && a.workspaceId === b.workspaceId
    && a.leaseId === b.leaseId && a.leaseGeneration === b.leaseGeneration && a.runtimeId === b.runtimeId
}

/**
 * The path a projection points a harness at, refusing an origin the broker
 * could not be reached on safely: the placeholder is bearer authority over a
 * credential, so a plaintext origin off the loopback interface hands it to the
 * network, and a path, query or userinfo on the origin would silently move
 * where the harness sends it.
 */
export function bindingBaseUrl(brokerOrigin: string, bindingId: string): string {
  const origin = new URL(brokerOrigin)
  if (origin.protocol !== "https:" && !(origin.protocol === "http:" && ["127.0.0.1", "[::1]", "localhost"].includes(origin.hostname))) {
    throw new Error("Broker must use HTTPS or loopback HTTP")
  }
  if (origin.username || origin.password || origin.pathname !== "/" || origin.search || origin.hash) throw new Error("Invalid broker origin")
  if (!/^[A-Za-z0-9_-]+$/.test(bindingId)) throw new Error("Invalid binding id")
  return `${origin.origin}/bindings/${bindingId}`
}
