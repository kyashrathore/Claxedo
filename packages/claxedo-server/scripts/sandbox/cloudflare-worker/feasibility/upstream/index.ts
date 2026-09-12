export default {
  async fetch(request: Request, env: { PROBE_TOKEN: string }) {
    if (!env.PROBE_TOKEN) return new Response("Disabled", { status: 503 })
    const authorization = request.headers.get("authorization")
    for (const revision of [1, 2]) {
      if (authorization === `Bearer ${env.PROBE_TOKEN}:${revision}`) {
        return Response.json({ authenticated: true, revision })
      }
    }
    return new Response("Unauthorized", { status: 401 })
  },
}
