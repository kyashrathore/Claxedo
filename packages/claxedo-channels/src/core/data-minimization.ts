export type ChannelTextMinimizationOptions = {
  maxLength?: number
}

const DEFAULT_MAX_LENGTH = 4000

const SECRET_PATTERNS: Array<[RegExp, string]> = [
  [/\bBearer\s+[A-Za-z0-9._~+/=-]{16,}/g, "Bearer [redacted]"],
  [/\bsk-[A-Za-z0-9_-]{20,}\b/g, "[redacted token]"],
  [/\bxox[baprs]-[A-Za-z0-9-]{20,}\b/g, "[redacted token]"],
  [/\bgh[pousr]_[A-Za-z0-9_]{20,}\b/g, "[redacted token]"],
  [/\bgithub_pat_[A-Za-z0-9_]{20,}\b/g, "[redacted token]"],
  [/\b(runtimeAccessToken|access_token|refresh_token)(["'=:\s]+)[A-Za-z0-9._~+/=-]{16,}/gi, "$1$2[redacted]"],
]

export function sanitizeChannelText(input: string, options: ChannelTextMinimizationOptions = {}) {
  const redacted = SECRET_PATTERNS.reduce((text, pattern) => text.replace(pattern[0], pattern[1]), input)
  const maxLength = options.maxLength ?? DEFAULT_MAX_LENGTH
  if (redacted.length <= maxLength) return redacted
  const suffix = "\n\n[truncated; open the session link for full output]"
  return `${redacted.slice(0, Math.max(0, maxLength - suffix.length))}${suffix}`
}
