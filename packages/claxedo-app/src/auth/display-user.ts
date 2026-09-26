export type AuthUser = {
  id: string
  fullName?: string
  email?: string
  imageUrl?: string
}

export function authUserLabel(user: AuthUser | null | undefined): string | undefined {
  return user?.fullName ?? user?.email ?? user?.id
}
