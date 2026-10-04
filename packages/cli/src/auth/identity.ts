import { jwtPayload } from "./jwt"
import { readCredentials } from "./token-store"

function claim(input: Record<string, unknown>, names: string[]): string | undefined {
  for (const name of names) {
    const value = input[name]
    if (typeof value === "string" && value.trim()) return value.trim()
  }
  return undefined
}

export async function whoami() {
  const credentials = await readCredentials()
  if (!credentials) {
    console.log("Not signed in")
    return
  }
  const payload = jwtPayload(credentials.accessToken)
  console.log(credentials.identity ?? claim(payload, ["email", "name", "sub", "user_id"]) ?? "Signed in")
}
