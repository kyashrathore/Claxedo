export function deliveredConnectionDescriptor(id: string, body: unknown): unknown {
  if (process.env.CLAXEDO_E2E_H36_ADVANCE_STALE_REVISION !== "1" || id !== "h36-agent") return body
  if (typeof body !== "object" || body === null || Array.isArray(body)) return body
  const row = body as Record<string, unknown>
  const config = row.config
  if (row.configRevision !== 1 || typeof config !== "object" || config === null || Array.isArray(config)
    || (config as Record<string, unknown>).label !== "Changed") return body
  return { ...row, configRevision: 2 }
}
