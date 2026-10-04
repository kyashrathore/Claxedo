/**
 * OpenAI/Codex OAuth client constants.
 *
 * Leaf module on purpose: both the interactive device-auth flow
 * (`provider-auth/service.ts`) and the non-interactive credential refresh
 * (`credentials/refresh.ts`) need these, and neither should import the other.
 */
export const OPENAI_CLIENT_ID = "app_EMoamEEZ73f0CkXaXp7hrann"
export const OPENAI_ISSUER = "https://auth.openai.com"
export const OPENAI_TOKEN_URL = `${OPENAI_ISSUER}/oauth/token`
