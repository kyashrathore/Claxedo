import type { AuthConfig } from "convex/server"

export default {
  providers: [
    {
      domain: process.env.CLERK_JWT_ISSUER_DOMAIN ?? process.env.CLERK_JWT_ISSUER!,
      applicationID: process.env.CLERK_JWT_AUDIENCE ?? "convex",
    },
  ],
} satisfies AuthConfig
