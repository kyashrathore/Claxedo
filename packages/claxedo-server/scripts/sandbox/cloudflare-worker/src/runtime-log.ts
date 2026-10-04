const SECRET_NAME = String.raw`[A-Za-z0-9_-]*(?:TOKEN|SECRET|PASSWORD|PASSWD|PRIVATE_KEY|API_KEY|COOKIE|CREDENTIAL)[A-Za-z0-9_-]*`

/**
 * The tail of a runtime's output with the credentials it may carry blanked,
 * for the Worker's log and the boot reason a person reads. A failed git or HTTP
 * call prints its headers, URLs and environment as they were.
 */
export function safeRuntimeLog(value: string) {
  return value
    .slice(-4_000)
    .replace(/-----BEGIN [^-]+-----[\s\S]*?-----END [^-]+-----/g, "[REDACTED PEM]")
    .replace(/\b(Bearer|Basic|token)\s+[A-Za-z0-9._~+/=-]+/gi, "$1 [REDACTED]")
    .replace(/\b(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,})/g, "[REDACTED]")
    .replace(/(\/\/)[^/\s:@]+:[^/\s@]+@/g, "$1[REDACTED]@")
    .replace(new RegExp(String.raw`("${SECRET_NAME}"\s*:\s*)"(?:[^"\\]|\\.)*"`, "gi"), '$1"[REDACTED]"')
    .replace(new RegExp(String.raw`\b(${SECRET_NAME})=[^\s&"']+`, "gi"), "$1=[REDACTED]")
}
