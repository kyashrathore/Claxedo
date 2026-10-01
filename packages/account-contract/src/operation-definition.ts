import { asRecord } from "@claxedo/helpers/guards"

export type DecodeResult<T> = { ok: true; value: T } | { ok: false; reason: string }
type Decoder<T> = (raw: unknown) => DecodeResult<T>
type Method = "GET" | "POST" | "PUT" | "PATCH" | "DELETE"
type Scalar = string | number | boolean | bigint
type Input = Readonly<Record<string, unknown>>

export type ResolvedRequest = {
  method: Method
  path: string
  body?: Record<string, unknown>
  headers?: Record<string, string>
  response?: "http"
}

export type OperationDefinition<I, O> = {
  method: Method | ((input: NoInfer<I>) => Method)
  path: ((input: NoInfer<I>) => string) & { pattern?: string }
  input: Decoder<I>
  output: Decoder<O>
  retry: "safe" | "never"
  exposure: { renderer: boolean; app: boolean; stream?: boolean }
  body?: (input: NoInfer<I>) => Record<string, unknown> | undefined
  headers?: (input: NoInfer<I>) => Record<string, string>
  response?: "http"
}

export class UnknownHostedOperation extends Error {}
export class MissingOperationParameter extends Error {}

export function defineOperation<I, O>(definition: OperationDefinition<I, O>) {
  return {
    ...definition,
    request(raw: unknown): ResolvedRequest {
      const decoded = definition.input(raw)
      if (!decoded.ok) throw new MissingOperationParameter(decoded.reason)
      const input = decoded.value
      const method = typeof definition.method === "function" ? definition.method(input) : definition.method
      const path = definition.path(input)
      const body = definition.body?.(input)
      if (body && method === "GET") throw new MissingOperationParameter("GET cannot send a body")
      const headers = definition.headers?.(input)
      return {
        method,
        path,
        ...(body ? { body } : {}),
        ...(headers && Object.keys(headers).length ? { headers } : {}),
        ...(definition.response ? { response: definition.response } : {}),
      }
    },
  }
}

export const requiredParameter: Decoder<Scalar> = (raw) => {
  if (typeof raw === "string" && raw !== "") return { ok: true, value: raw }
  if (typeof raw === "number" || typeof raw === "boolean" || typeof raw === "bigint") return { ok: true, value: raw }
  return { ok: false, reason: "requires a non-empty string, number or boolean" }
}

export const optionalParameter: Decoder<Scalar | undefined> = (raw) =>
  raw === undefined || raw === null || raw === "" ? { ok: true, value: undefined } : requiredParameter(raw)

export const bodyField: Decoder<unknown> = (raw) => ({ ok: true, value: raw })

type DecodedFields<S extends Record<string, Decoder<unknown>>> = {
  [K in keyof S as undefined extends DecodedField<S[K]> ? never : K]: DecodedField<S[K]>
} & {
  [K in keyof S as undefined extends DecodedField<S[K]> ? K : never]?: DecodedField<S[K]>
}
type DecodedField<D> = D extends Decoder<infer T> ? T : never

export function operationInput<const S extends Record<string, Decoder<unknown>>>(
  fields: S,
): NoInfer<Decoder<DecodedFields<S>>> {
  return (raw: unknown): DecodeResult<DecodedFields<S>> => {
    const input = raw === undefined ? {} : asRecord(raw)
    if (!input) return { ok: false, reason: "the input is not an object" }
    const result: Record<string, unknown> = {}
    for (const [key, decode] of Object.entries(fields)) {
      const decoded = decode(input[key])
      if (!decoded.ok) return { ok: false, reason: `${key}: ${decoded.reason}` }
      result[key] = decoded.value
    }
    return { ok: true, value: result as DecodedFields<S> }
  }
}

type PathOptions = {
  query?: readonly string[]
  optionalQuery?: readonly string[]
  accepts?: Readonly<Record<string, (value: string) => boolean>>
}

export function operationPath(template: string, options: PathOptions = {}) {
  const pathOf = (input: Input): string => {
    const rest = template.endsWith("/*")
    let path = (rest ? template.slice(0, -2) : template).replace(/:([A-Za-z][A-Za-z0-9]*)/g, (_match, key: string) => {
      const decoded = requiredParameter(input[key])
      if (!decoded.ok) throw new MissingOperationParameter(`${key}: ${decoded.reason}`)
      const text = String(decoded.value)
      // URL normalization resolves dot segments even after encodeURIComponent.
      if (text === "." || text === ".." || options.accepts?.[key]?.(text) === false) {
        throw new MissingOperationParameter(`does not accept ${key} ${JSON.stringify(text)}`)
      }
      return encodeURIComponent(text)
    })
    if (rest) path += restOfPath(input.path)
    if (new URL(path, "http://hosted.invalid").pathname !== path.split("?")[0]) {
      throw new MissingOperationParameter("resolved to a path the URL parser would rewrite")
    }
    const query = new URLSearchParams()
    for (const key of options.query ?? []) {
      const decoded = requiredParameter(input[key])
      if (!decoded.ok) throw new MissingOperationParameter(`${key}: ${decoded.reason}`)
      query.set(key, String(decoded.value))
    }
    for (const key of options.optionalQuery ?? []) {
      const decoded = optionalParameter(input[key])
      if (!decoded.ok) throw new MissingOperationParameter(`${key}: ${decoded.reason}`)
      if (decoded.value !== undefined) query.set(key, String(decoded.value))
    }
    if (query.size) path += `${path.includes("?") ? "&" : "?"}${query}`
    return path
  }
  return Object.assign(pathOf, { pattern: template })
}

function restOfPath(raw: unknown): string {
  const path = String(raw)
  if (path === "/") return "/"
  const segments = path.startsWith("/") ? path.slice(1).split("/") : undefined
  if (!segments || segments.some((segment) => segment === "" || segment === "." || segment === "..")) {
    throw new MissingOperationParameter('requires path to be absolute with no empty, "." or ".." segment')
  }
  return segments.map((segment) => `/${encodeURIComponent(segment)}`).join("")
}

export function selectBody(...keys: string[]) {
  return (input: Input): Record<string, unknown> =>
    Object.fromEntries(keys.filter((key) => input[key] !== undefined).map((key) => [key, input[key]]))
}

export function operationHeaders(fields: Readonly<Record<string, string>>) {
  return (input: Input): Record<string, string> =>
    Object.fromEntries(
      Object.entries(fields)
        .filter(([key]) => input[key] !== undefined)
        .map(([key, header]) => [header, String(input[key])]),
    )
}

export const pluginMethod: Decoder<Method> = (raw) => {
  if (raw === "GET" || raw === "POST" || raw === "PUT" || raw === "PATCH" || raw === "DELETE")
    return { ok: true, value: raw }
  return { ok: false, reason: "requires method to be GET, POST, PUT, PATCH or DELETE" }
}

export function pluginBody(input: Input): Record<string, unknown> | undefined {
  if (input.body === undefined) return undefined
  const body = asRecord(input.body)
  if (!body) throw new MissingOperationParameter("sends body only as an object")
  return body
}

export function connectedRepositoryBody(input: Input): Record<string, unknown> {
  const { repoFullName, ...body } = Object.fromEntries(Object.entries(input).filter(([, value]) => value !== undefined))
  return { ...body, ...(typeof repoFullName === "string" && repoFullName ? { repo: { fullName: repoFullName } } : {}) }
}
