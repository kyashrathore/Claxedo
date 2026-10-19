import { decodeBase64, encodeBase64 } from "../base64"
import type { FrameBodyEncoding, FrameResponse } from "./protocol"

const TEXT_TYPE = /^(?:text\/[\w.+-]+|application\/(?:json|javascript|xml|[\w.-]+\+(?:json|xml)))$/

const NULL_BODY_STATUSES: ReadonlySet<number> = new Set([101, 204, 205, 304])

export function frameBodyEncoding(contentType: string | null): FrameBodyEncoding {
  if (!contentType) return "base64"
  const [type = "", ...parameters] = contentType.split(";").map((part) => part.trim().toLowerCase())
  const charset = parameters.find((parameter) => parameter.startsWith("charset="))?.slice("charset=".length).replaceAll('"', "")
  return TEXT_TYPE.test(type) && (charset === undefined || charset === "utf-8") ? "utf8" : "base64"
}

export async function frameResponseOf(response: Response): Promise<FrameResponse> {
  const encoding = frameBodyEncoding(response.headers.get("content-type"))
  const body = encoding === "utf8" ? await response.text() : encodeBase64(new Uint8Array(await response.arrayBuffer()))
  return { status: response.status, statusText: response.statusText, headers: [...response.headers.entries()], body, encoding }
}

export function responseFromFrame(answer: FrameResponse): Response {
  const headers = answer.headers.map(([name, value]): [string, string] => [name, value])
  if (NULL_BODY_STATUSES.has(answer.status)) return new Response(null, { status: answer.status, statusText: answer.statusText, headers })
  const body = answer.encoding === "utf8" ? answer.body : decodeBase64(answer.body)
  return new Response(body, { status: answer.status, statusText: answer.statusText, headers })
}
