export { asRecord as rec, asString as str } from "@claxedo/helpers/guards"

export function num(input: unknown): number | undefined {
  return typeof input === "number" ? input : undefined
}

export function arr(input: unknown): unknown[] | undefined {
  return Array.isArray(input) ? input : undefined
}
