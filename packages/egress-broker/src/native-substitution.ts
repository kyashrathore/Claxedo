export type NativeBrokeredSecret = Readonly<{
  name: string
  value: string
  hosts: readonly string[]
  header?: string
  scheme?: string
  methods?: readonly string[]
  pathPrefixes?: readonly string[]
}>

/** What a driver registers with its provider edge: the whole header value, with any scheme already composed in. */
export type BrokeredRegistration = Readonly<{
  name: string
  header: string
  value: string
  hosts: readonly string[]
  methods?: readonly string[]
  pathPrefixes?: readonly string[]
}>

const SCHEME_PREFIXED = /^([A-Za-z]+) (.+)$/

/**
 * The secret a broker substitutes for one registration. An `Authorization`
 * value is split into its scheme and credential so that a sandbox presenting
 * `<scheme> <placeholder>` composes the scheme once; either presentation
 * ends up carrying the registration's whole value.
 */
export function brokeredSecretFromRegistration(registration: BrokeredRegistration): NativeBrokeredSecret {
  const match = registration.header.toLowerCase() === "authorization" ? SCHEME_PREFIXED.exec(registration.value) : null
  return {
    name: registration.name,
    value: match?.[2] ?? registration.value,
    hosts: registration.hosts,
    header: registration.header,
    ...(match ? { scheme: match[1] } : {}),
    ...(registration.methods ? { methods: registration.methods } : {}),
    ...(registration.pathPrefixes ? { pathPrefixes: registration.pathPrefixes } : {}),
  }
}

function registeredValue(secret: NativeBrokeredSecret) {
  return secret.scheme ? `${secret.scheme} ${secret.value}` : secret.value
}

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
    headers.set(slot, registeredValue(secret))
  }
  if ([...headers].some(([, value]) => value.includes("claxedo-broker:"))) {
    throw new Error("brokered_secret_slot_refused")
  }
  return headers
}
