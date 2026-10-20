export const shellRoutes = {
  fillPattern: (pattern: string, params: Readonly<Record<string, string>> = {}) => pattern.replace(/:(\w+)\??/g, (_, name: string) => params[name] ?? ""),
  sessionPath: (ref: { readonly placementId: string; readonly sessionId: string }) => `${ref.placementId}/${ref.sessionId}`,
  settingsPath: (section: string) => `/settings/${encodeURIComponent(section)}`,
}
