import { asRecord } from "@claxedo/helpers/guards"
import type { DecodeResult, Decoder } from "./operation-definition"

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
