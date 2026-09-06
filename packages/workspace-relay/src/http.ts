export function bearerToken(header: string | null | undefined): string | undefined {
  if (!header) return undefined
  const match = /^Bearer\s+(.+)$/i.exec(header.trim())
  return match?.[1]?.trim() || undefined
}

export function errorBody(code: string, message: string) {
  return {
    error: {
      code,
      message,
    },
  }
}
