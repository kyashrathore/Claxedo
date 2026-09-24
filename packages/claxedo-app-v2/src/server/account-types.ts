export type Account = {
  readonly id: string
  readonly providerId: string
  readonly kind: string
  readonly source: string
  readonly label?: string
  readonly accountId?: string
  readonly active: boolean
  readonly status?: string
  readonly health?: string
  readonly hasSecret: boolean
  readonly expiresAt?: number
  readonly scope: string
}
