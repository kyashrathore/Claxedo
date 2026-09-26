import { toAppError } from "./errors"
import type { Transport } from "./transport"
import type { AppError } from "./types"

export type Answer =
  | { readonly kind: "answered"; readonly status: number; readonly ok: boolean; readonly body: unknown }
  | { readonly kind: "unreachable"; readonly error: AppError }

async function jsonBody(response: Response): Promise<unknown> {
  if (!(response.headers.get("content-type") ?? "").includes("json")) return undefined
  const text = await response.text()
  return text.trim() === "" ? undefined : JSON.parse(text)
}

export async function ask(transport: Transport, path: string, init?: RequestInit): Promise<Answer> {
  let response: Response
  try {
    response = await transport.request(path, init)
  } catch (error) {
    return { kind: "unreachable", error: toAppError(error) }
  }
  return { kind: "answered", status: response.status, ok: response.ok, body: await jsonBody(response) }
}
