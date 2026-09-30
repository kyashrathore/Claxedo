/** The control plane's error body, `{ error: { code, message } }`, for every refusal the platform answers itself. */
export function pluginRefusal(status: number, code: string, message: string) {
  return Response.json({ error: { code, message } }, { status })
}
