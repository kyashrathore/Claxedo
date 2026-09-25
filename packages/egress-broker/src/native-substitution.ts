export type NativeBrokeredSecret = Readonly<{
  name: string
  value: string
  hosts: readonly string[]
  header?: string
  scheme?: string
  methods?: readonly string[]
  pathPrefixes?: readonly string[]
}>

export function substituteNativeSecrets(
  target: URL,
  method: string,
  incoming: Headers,
  secrets: readonly NativeBrokeredSecret[],
): Headers {
  const headers = new Headers(incoming)
  const presented = [...headers].filter(([, value]) => value.includes("claxedo-broker:"))
  for (const [, value] of presented) {
    if (!secrets.some((secret) => value.includes(`claxedo-broker:${secret.name}`))) {
      throw new Error("brokered_secret_withdrawn")
    }
  }
  for (const secret of secrets) {
    const slot = secret.header
    if (!slot) continue
    const placeholder = `claxedo-broker:${secret.name}`
    const sent = headers.get(slot)
    if (sent !== placeholder && sent !== `${secret.scheme ?? "Bearer"} ${placeholder}`) continue
    if (!secret.hosts.includes(target.host)
      || (secret.methods && !secret.methods.includes(method))
      || (secret.pathPrefixes && !secret.pathPrefixes.some((prefix) =>
        target.pathname === prefix || target.pathname.startsWith(prefix.endsWith("/") ? prefix : `${prefix}/`)))) {
      throw new Error("brokered_secret_destination_refused")
    }
    headers.set(slot, sent === placeholder ? secret.value : `${secret.scheme ?? "Bearer"} ${secret.value}`)
  }
  if ([...headers].some(([, value]) => value.includes("claxedo-broker:"))) {
    throw new Error("brokered_secret_slot_refused")
  }
  return headers
}
