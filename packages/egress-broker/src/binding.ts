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
   */
  injection: Readonly<{ header: string; scheme?: string; headers?: Readonly<Record<string, string>> }>
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
