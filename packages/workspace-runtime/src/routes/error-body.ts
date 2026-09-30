/** The `{ error: { code, message } }` envelope every runtime route and every host route contribution answers with. */
export function errorBody(code: string, message: string, details?: Record<string, unknown>) {
  return {
    error: {
      code,
      message,
      ...(details ? { details } : {}),
    },
  }
}
