import type { WhatsAppBaileysAuthStateStore } from "@claxedo/channels"
import type { ControlPlaneCredentials } from "../control-plane/services"

export const defaultWhatsAppBaileysCredentialId = "channel:whatsapp:baileys:auth-state"

export function createCredentialWhatsAppBaileysAuthStateStore(input: {
  credentials: ControlPlaneCredentials
  providerId?: string
}): WhatsAppBaileysAuthStateStore {
  const providerId = input.providerId?.trim() || defaultWhatsAppBaileysCredentialId
  return {
    async load() {
      const raw = await input.credentials.resolveCredentialSecret?.(providerId)
      if (!raw) return undefined
      try {
        return JSON.parse(raw) as unknown
      } catch {
        return undefined
      }
    },
    async save(state) {
      if (state === undefined) return
      await input.credentials.putCredential({
        provider_id: providerId,
        kind: "subscription_session",
        source: "managed",
        label: "WhatsApp Baileys auth state",
        secret: JSON.stringify(state),
      })
    },
  }
}
