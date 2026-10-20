export const shellRoutes = {
  fillPattern: (pattern: string) => pattern,
  sessionPath: (ref: { placementId: string; sessionId: string }) => `${ref.placementId}/${ref.sessionId}`,
  settingsPath: (section: string) => `/settings/${encodeURIComponent(section)}`,
}
