import { isRecord } from "@/lib/record"

export type NativeFolderDialog = (title: string) => Promise<string | undefined>

function chosenPath(result: unknown): string | undefined {
  if (typeof result === "string") return result
  if (Array.isArray(result) && typeof result[0] === "string") return result[0]
  return undefined
}

export function nativeFolderDialog(): NativeFolderDialog | undefined {
  if (typeof window === "undefined") return undefined
  const api: unknown = Reflect.get(window, "api")
  if (!isRecord(api)) return undefined
  const open: unknown = api.openDirectoryPicker
  if (typeof open !== "function") return undefined
  return async (title) => chosenPath(await open.call(api, { multiple: false, title }))
}
