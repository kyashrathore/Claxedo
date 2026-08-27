export function privacySafeResourceName(value: string) {
  try {
    const pathname = new URL(value).pathname
    if (/\/session\/[^/]+\/message$/u.test(pathname)) return "session-message"
    if (/\/session\/[^/]+\/subagents$/u.test(pathname)) return "session-subagents"
    if (/\/session\/[^/]+\/capabilities$/u.test(pathname)) return "session-capabilities"
    if (/\/session\/[^/]+\/todo$/u.test(pathname)) return "session-todo"
    if (pathname === "/session/status") return "session-status"
    if (/\/session\/[^/]+$/u.test(pathname)) return "session-detail"
    if (pathname === "/session" || pathname === "/session/") return "session-list"
    if (/\/session(?:\/|$)/u.test(pathname)) return "session-api"
    if (/\/workspace(?:\/|$)/u.test(pathname)) return "workspace-api"
    return pathname.split("/").filter(Boolean).at(-1) ?? "root"
  } catch {
    return "unknown"
  }
}
