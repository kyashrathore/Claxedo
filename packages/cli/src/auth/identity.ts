import { readCredentials } from "./token-store"

function decodeJwtPayload(token: string) {
  const part = token.split(".")[1]
  if (!part) return {}
  try {
    return JSON.parse(Buffer.from(part, "base64url").toString("utf8")) as Record<string, unknown>
  } catch {
    return {}
  }
}

function claim(input: Record<string, unknown>, names: string[]) {
  for (const name of names) {
    const value = input[name]
    if (typeof value === "string" && value.trim()) return value.trim()
  }
}

export async function whoami() {
  const credentials = await readCredentials()
  if (!credentials) {
    console.log("Not signed in")
    return
  }
  const payload = decodeJwtPayload(credentials.accessToken)
  console.log(credentials.identity ?? claim(payload, ["email", "name", "sub", "user_id"]) ?? "Signed in")
}
