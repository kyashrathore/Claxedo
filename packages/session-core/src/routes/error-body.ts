export function errorBody(code: string, message: string, details?: Record<string, unknown>) {
  return {
    error: {
      code,
      message,
      ...(details ? { details } : {}),
    },
  }
}

export function sessionNotFound() {
  return errorBody("session_not_found", "Session not found")
}
