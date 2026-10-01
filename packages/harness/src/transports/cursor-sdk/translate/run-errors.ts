import type { FirstTurnErrorClass } from "@claxedo/agent-runtime-contract"

const CODE_CLASSES: ReadonlyArray<readonly [FirstTurnErrorClass, readonly string[]]> = [
  ["usage_limit", ["FREE_USER_USAGE_LIMIT", "PRO_USER_USAGE_LIMIT"]],
  ["rate_limit", ["FREE_USER_RATE_LIMIT_EXCEEDED", "PRO_USER_RATE_LIMIT_EXCEEDED", "RESOURCE_EXHAUSTED", "resource_exhausted",
    "OPENAI_RATE_LIMIT_EXCEEDED", "GENERIC_RATE_LIMIT_EXCEEDED", "GPT_4_VISION_PREVIEW_RATE_LIMIT", "API_KEY_RATE_LIMIT", "RATE_LIMITED",
    "RATE_LIMITED_CHANGEABLE"]],
  ["credential", ["NOT_LOGGED_IN", "INVALID_AUTH_ID", "NOT_HIGH_ENOUGH_PERMISSIONS", "AGENT_REQUIRES_LOGIN", "AUTH_TOKEN_NOT_FOUND",
    "AUTH_TOKEN_EXPIRED", "UNAUTHORIZED", "BAD_API_KEY", "BAD_USER_API_KEY", "unauthenticated"]],
  ["model", ["BAD_MODEL_NAME", "MODEL_BLOCKED"]],
]

export function cursorErrorClass(code: string | undefined): FirstTurnErrorClass | undefined {
  return code === undefined ? undefined : CODE_CLASSES.find(([, codes]) => codes.includes(code))?.[0]
}
