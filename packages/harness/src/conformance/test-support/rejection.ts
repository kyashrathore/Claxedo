import { expect } from "bun:test"
import { errorMessage } from "@claxedo/helpers"

export async function rejectionMessage(run: () => Promise<unknown>): Promise<string> {
  const failure = await run().then(() => undefined, (error: unknown) => error)
  expect(failure).toBeInstanceOf(Error)
  return errorMessage(failure)
}
