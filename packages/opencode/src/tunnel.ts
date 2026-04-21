/**
 * Tunnel management for remote access via Cloudflare tunnels.
 */

export interface TunnelStatus {
  enabled: boolean
  url: string | null
  provider: "cloudflare" | null
}

export interface TailscaleInfo {
  ip: string
  hostname: string
}

export const Tunnel = {
  getStatus(): TunnelStatus {
    return { enabled: false, url: null, provider: null }
  },
  async start(): Promise<string> {
    throw new Error("Tunnel not implemented")
  },
  async stop(): Promise<void> {},
}

export async function detectTailscale(): Promise<TailscaleInfo | null> {
  return null
}
