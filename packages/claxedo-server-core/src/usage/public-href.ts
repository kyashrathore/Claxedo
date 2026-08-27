function opaqueWorkspaceId(value: string) {
  if (!value || value.includes("/") || value.includes("\\") || value.includes("%")) return
  return value
}

export function publicUsageHref(dimension: string, value: string) {
  if (dimension === "workspace") {
    const workspaceId = value === "unavailable" ? undefined : opaqueWorkspaceId(value)
    return workspaceId ? `/w/${encodeURIComponent(workspaceId)}` : undefined
  }
  if (dimension !== "session") return undefined
  const id = value.startsWith("central:") ? value.slice("central:".length) : value.match(/:session:([^:]+)$/)?.[1]
  return id && /^(ses_|session_)/.test(id) ? `/s/${encodeURIComponent(id)}` : undefined
}
