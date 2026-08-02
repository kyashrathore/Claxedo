import { Hono, type Context } from "hono"
import type { ChannelId } from "./envelope"
import type { ChannelCore } from "./core/command-emit"
import { fakeTransportHandler } from "./transport/fake"
import { createChannelRegistry, type ChannelRegistration } from "./registry"
import type { WhatsAppBaileysTransport } from "./transport/whatsapp-baileys"

export type ChannelWebhookHandler = (
  request: Request,
  options?: { waitUntil?: (task: Promise<unknown>) => void },
) => Response | Promise<Response>

export type ChannelWebhookBot = {
  webhooks?: Partial<Record<ChannelId, ChannelWebhookHandler>>
}

type ChannelWebhookBotInput = ChannelWebhookBot | Promise<ChannelWebhookBot | undefined>
type WhatsAppBaileysTransportInput = WhatsAppBaileysTransport | Promise<WhatsAppBaileysTransport | undefined>

function waitUntil(task: Promise<unknown>) {
  task.catch(() => {})
}

function transportNotMounted(item: ChannelRegistration & { channel: ChannelId }) {
  return {
    error: {
      code: item.enabled ? "channel_transport_not_mounted" : "channel_disabled",
      message: item.enabled
        ? `${item.channel} ${item.transport} transport is registered but not mounted in this build`
        : `${item.channel} channel is disabled`,
    },
  }
}

export function createChannelsIngress(core: ChannelCore, options: {
  env?: Record<string, string | undefined>
  includeFake?: boolean
  registrations?: ChannelRegistration[]
  bot?: ChannelWebhookBotInput
  whatsappBaileys?: WhatsAppBaileysTransportInput
} = {}) {
  const app = new Hono()
  const registry = options.registrations ?? createChannelRegistry(options.env ?? {}, {
    includeFake: options.includeFake,
  }).registrations
  if (registry.some((item) => item.channel === "fake" && item.enabled)) {
    app.post("/fake", async (c) => fakeTransportHandler(core, c))
  }
  for (const item of registry.filter((entry): entry is ChannelRegistration & { channel: ChannelId } => entry.channel !== "fake")) {
    if (item.enabled && item.transport === "baileys" && item.channel === "whatsapp" && options.whatsappBaileys) {
      const handler = async (c: Context) => {
        const transport = await Promise.resolve(options.whatsappBaileys).catch(() => undefined)
        if (!transport) return c.json(transportNotMounted(item), 501)
        await transport.start()
        return c.json({ ok: true, channel: item.channel, transport: item.transport, ...transport.status() })
      }
      app.post(item.webhookPath, handler)
      continue
    }
    if (item.enabled && options.bot) {
      const handler = async (c: Context) => {
        const bot = await Promise.resolve(options.bot).catch(() => undefined)
        const webhook = bot?.webhooks?.[item.channel]
        if (!webhook) {
          return c.json(transportNotMounted(item), 501)
        }
        return webhook(c.req.raw, { waitUntil })
      }
      app.all(item.webhookPath, handler)
      app.all(`${item.webhookPath}/*`, handler)
      continue
    }
    const handler = (c: Context) =>
      c.json(transportNotMounted(item), item.enabled ? 501 : 404)
    app.all(item.webhookPath, handler)
    app.all(`${item.webhookPath}/*`, handler)
  }
  return app
}
