export const isRefusal = (verdict: string) => verdict === "auth_failed" || verdict === "no_billing" || verdict === "expired"

export const isUnavailable = (verdict: string) => verdict === "rate_capped" || verdict === "unknown"
