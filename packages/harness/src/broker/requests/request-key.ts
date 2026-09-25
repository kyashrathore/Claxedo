export function requestKey(sessionId: string, requestId: string): string {
  return JSON.stringify([sessionId, requestId])
}
