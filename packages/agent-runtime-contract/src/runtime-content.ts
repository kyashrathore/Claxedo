export type RuntimeContentBlock =
  | { type: "text"; text: string }
  | { type: "image"; data: string; mimeType: string; uri?: string | null }
  | { type: "audio"; data: string; mimeType: string }
  | { type: "resource_link"; uri: string; name: string; mimeType?: string | null; title?: string | null }
  | { type: "resource"; resource: unknown }

export type RuntimeToolCallContent =
  | { type: "content"; content: RuntimeContentBlock }
  | { type: "diff"; path: string; oldText?: string | null; newText: string }
  | { type: "terminal"; terminalId: string }
