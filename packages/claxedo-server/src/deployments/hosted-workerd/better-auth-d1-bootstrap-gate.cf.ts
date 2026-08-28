export default {
  fetch() {
    return Response.json(
      { error: { code: "deployment_bootstrap" } },
      {
        status: 503,
        headers: {
          "cache-control": "no-store",
          "content-security-policy": "default-src 'none'; frame-ancestors 'none'",
          "x-content-type-options": "nosniff",
        },
      },
    )
  },
}
