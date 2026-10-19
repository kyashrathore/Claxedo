export type Json = string | number | boolean | null | Json[] | { [key: string]: Json }

export type JsonObject = { [key: string]: Json }

export function escapePointerKey(key: string): string {
  return key.replaceAll("~", "~0").replaceAll("/", "~1")
}
