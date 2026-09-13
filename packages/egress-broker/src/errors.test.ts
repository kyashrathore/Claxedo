import { expect, test } from "vitest"
import { CREDENTIAL_BROKER_ERRORS, type CredentialBrokerErrorCode } from "@claxedo/agent-runtime-contract"
import { brokerErrorBody } from "./errors.js"

test("every refusal is the contract's own code and message", () => {
  for (const code of Object.keys(CREDENTIAL_BROKER_ERRORS) as CredentialBrokerErrorCode[]) {
    expect(brokerErrorBody(code)).toEqual({ error: { code, message: CREDENTIAL_BROKER_ERRORS[code].message } })
  }
})
