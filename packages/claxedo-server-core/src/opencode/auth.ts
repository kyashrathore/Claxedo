let password = ""

export function configureOpenCodeAuth(next?: string | null) {
  password = next?.trim() ?? ""
}

function auth() {
  if (!password) return
  return `Basic ${Buffer.from(`opencode:${password}`).toString("base64")}`
}

export function opencodeHeaders(headers?: ConstructorParameters<typeof Headers>[0]) {
  const next = new Headers(headers)
  const value = auth()
  if (value && !next.has("authorization")) next.set("authorization", value)
  return next
}
