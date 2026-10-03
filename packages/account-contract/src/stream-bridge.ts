export type HostedStreamBridge = {
  readonly streamOpen: (operation: string, input?: Record<string, unknown>) => Promise<{ streamId: string }>
  readonly streamStart: (streamId: string) => Promise<void>
  readonly streamClose: (streamId: string) => Promise<void>
  readonly onStreamChunk: (listener: (payload: { streamId: string; text: string }) => void) => () => void
  readonly onStreamEnd: (listener: (payload: { streamId: string }) => void) => () => void
  readonly onStreamError: (listener: (payload: { streamId: string; message: string }) => void) => () => void
}
