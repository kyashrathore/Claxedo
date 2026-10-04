import { describe, expect, test } from "vitest"
import { createChannelsIngress } from "./ingress"

describe("createChannelsIngress", () => {
  test("mounts configured Chat SDK webhook handlers", async () => {
    const app = createChannelsIngress({
      async handleInbound() {},
      async onApproval() {
        return { ok: true }
      },
    }, {
      registrations: [{
        channel: "github",
        enabled: true,
        transport: "chat-sdk",
        reason: "test",
        webhookPath: "/github",
      }],
      bot: {
        webhooks: {
          github: async () => new Response("ok"),
        },
      },
    })

    const res = await app.request("http://channels.test/github", { method: "POST" })

    expect(res.status).toBe(200)
    await expect(res.text()).resolves.toBe("ok")
  })

  test("awaits a lazily-created Chat SDK webhook bot", async () => {
    const app = createChannelsIngress({
      async handleInbound() {},
      async onApproval() {
        return { ok: true }
      },
    }, {
      registrations: [{
        channel: "telegram",
        enabled: true,
        transport: "chat-sdk",
        reason: "test",
        webhookPath: "/telegram",
      }],
      bot: Promise.resolve({
        webhooks: {
          telegram: async () => new Response("telegram-ok"),
        },
      }),
    })

    const res = await app.request("http://channels.test/telegram", { method: "POST" })

    expect(res.status).toBe(200)
    await expect(res.text()).resolves.toBe("telegram-ok")
  })

  test("starts a mounted WhatsApp personal socket transport", async () => {
    let starts = 0
    const app = createChannelsIngress({
      async handleInbound() {},
      async onApproval() {
        return { ok: true }
      },
    }, {
      registrations: [{
        channel: "whatsapp",
        enabled: true,
        transport: "baileys",
        reason: "test",
        webhookPath: "/whatsapp",
      }],
      whatsappBaileys: {
        async start() {
          starts++
        },
        async stop() {},
        status() {
          return { running: true }
        },
        async handleMessage() {},
      },
    })

    const res = await app.request("http://channels.test/whatsapp", { method: "POST" })

    expect(res.status).toBe(200)
    await expect(res.json()).resolves.toEqual({
      ok: true,
      channel: "whatsapp",
      transport: "baileys",
      running: true,
    })
    expect(starts).toBe(1)
  })

  test("keeps healthy channel webhook routes available when another channel is missing", async () => {
    const app = createChannelsIngress({
      async handleInbound() {},
      async onApproval() {
        return { ok: true }
      },
    }, {
      registrations: [{
        channel: "github",
        enabled: true,
        transport: "chat-sdk",
        reason: "test",
        webhookPath: "/github",
      }, {
        channel: "telegram",
        enabled: true,
        transport: "chat-sdk",
        reason: "test",
        webhookPath: "/telegram",
      }],
      bot: {
        webhooks: {
          telegram: async () => new Response("telegram-ok"),
        },
      },
    })

    const missing = await app.request("http://channels.test/github", { method: "POST" })
    const healthy = await app.request("http://channels.test/telegram", { method: "POST" })

    expect(missing.status).toBe(501)
    await expect(missing.json()).resolves.toMatchObject({
      error: { code: "channel_transport_not_mounted" },
    })
    expect(healthy.status).toBe(200)
    await expect(healthy.text()).resolves.toBe("telegram-ok")
  })

  test("keeps route degradation isolated across disabled, missing, and healthy channels", async () => {
    const app = createChannelsIngress({
      async handleInbound() {},
      async onApproval() {
        return { ok: true }
      },
    }, {
      registrations: [{
        channel: "github",
        enabled: true,
        transport: "chat-sdk",
        reason: "test",
        webhookPath: "/github",
      }, {
        channel: "telegram",
        enabled: true,
        transport: "chat-sdk",
        reason: "test",
        webhookPath: "/telegram",
      }, {
        channel: "slack",
        enabled: false,
        transport: "chat-sdk",
        reason: "test",
        webhookPath: "/slack",
      }, {
        channel: "discord",
        enabled: true,
        transport: "chat-sdk",
        reason: "test",
        webhookPath: "/discord",
      }, {
        channel: "whatsapp",
        enabled: true,
        transport: "baileys",
        reason: "test",
        webhookPath: "/whatsapp",
      }],
      bot: Promise.resolve({
        webhooks: {
          telegram: async () => new Response("telegram-ok"),
          discord: async () => new Response("discord-ok"),
        },
      }),
      whatsappBaileys: Promise.resolve(undefined),
    })

    const matrix = await Promise.all([
      app.request("http://channels.test/github", { method: "POST" }),
      app.request("http://channels.test/telegram", { method: "POST" }),
      app.request("http://channels.test/slack", { method: "POST" }),
      app.request("http://channels.test/discord", { method: "POST" }),
      app.request("http://channels.test/whatsapp", { method: "POST" }),
    ])

    expect(matrix.map((res) => res.status)).toEqual([501, 200, 404, 200, 501])
    await expect(matrix[0].json()).resolves.toMatchObject({
      error: { code: "channel_transport_not_mounted" },
    })
    await expect(matrix[1].text()).resolves.toBe("telegram-ok")
    await expect(matrix[2].json()).resolves.toMatchObject({
      error: { code: "channel_disabled" },
    })
    await expect(matrix[3].text()).resolves.toBe("discord-ok")
    await expect(matrix[4].json()).resolves.toMatchObject({
      error: { code: "channel_transport_not_mounted" },
    })
  })
})
