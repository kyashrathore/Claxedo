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
  injection: Readonly<{ header: string; scheme?: string }>
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
