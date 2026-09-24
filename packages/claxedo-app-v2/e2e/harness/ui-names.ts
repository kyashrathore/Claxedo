export const UI = {
  composer: "Ask anything, / for commands, @ for context...",
  sendIdle: "Type a message to get started",
  send: "Send",
  newSession: "New Session",
  rail: "Projects and sessions",
  hideSidebar: "Hide Sidebar",
  openRail: "Open navigation sidebar",
  openPanel: "Open workspace panel",
  workedFor: /^Worked for/,
  explored: /^Explored/,
} as const

export function sessionRoute(workspaceId: string, sessionId?: string) {
  return sessionId ? `/w/${workspaceId}/session/${sessionId}` : `/w/${workspaceId}/session`
}
