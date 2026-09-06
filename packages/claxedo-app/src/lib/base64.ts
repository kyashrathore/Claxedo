import { base64Decode } from "@opencode-ai/ui/utils/encode"

export function decode64(value: string | undefined) {
  if (value === undefined) return undefined
  try {
    return base64Decode(value)
  } catch {
    return undefined
  }
}
