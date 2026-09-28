import { expect, test } from "vitest"
import { controlPlaneAuthContext } from "./auth"
import { LOCAL_USER_ID } from "./local-identity"

const config = { enabled: true, issuer: "test", jwksUrl: "https://identity.test/jwks" } as const
const request = new Request("http://localhost/", { headers: { authorization: "Bearer token" } })

test("a signed person whose subject is the unsigned operator's id is refused, so they are never taken for the machine owner", async () => {
  const verifier = async (subject: string) => ({ mode: "signed" as const, user: { subject, tokenIdentifier: subject, issuer: "test" } })
  await expect(controlPlaneAuthContext(request, { config, verifier: () => verifier(LOCAL_USER_ID) }))
    .rejects.toMatchObject({ status: 401, code: "invalid_bearer_token" })
  await expect(controlPlaneAuthContext(request, { config, verifier: () => verifier("usr_real") }))
    .resolves.toMatchObject({ mode: "signed", user: { subject: "usr_real" } })
})
