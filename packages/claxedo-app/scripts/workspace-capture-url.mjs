export function workspaceCaptureUrl(input) {
  const workspaceId = input.workspaceId?.trim()
  const href = input.override?.trim() || (workspaceId
    ? `${input.origin.replace(/\/+$/, "")}/w/${encodeURIComponent(workspaceId)}/session`
    : undefined)
  if (!href) throw new Error("CLAXEDO_WORKSPACE_ID is required for workspace capture URLs")

  const url = new URL(href)
  const encodedId = url.pathname.match(/^\/w\/([^/]+)(?:\/|$)/)?.[1]
  const decodedId = encodedId ? decodeURIComponent(encodedId) : undefined
  if (!decodedId || decodedId.includes("/") || decodedId.includes("\\") || decodedId.includes("%")) {
    throw new Error("Workspace capture URLs require an opaque workspace ID")
  }
  return href
}
