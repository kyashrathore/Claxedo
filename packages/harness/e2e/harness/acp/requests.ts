import fs from "node:fs/promises"
import path from "node:path"

export type RecordedAcpRequest = {
  method: string
  params: Record<string, unknown>
  headers: Record<string, string>
  authorization: string | null
  source?: string
}

const fileName = "received-requests.jsonl"

export async function recordAcpRequest(dir: string, method: string, params: unknown, headers: Record<string, string>, source?: string) {
  const row: RecordedAcpRequest = {
    method,
    params: params && typeof params === "object" && !Array.isArray(params) ? params as Record<string, unknown> : {},
    headers,
    authorization: Object.entries(headers).find(([name]) => name.toLowerCase() === "authorization")?.[1] ?? null,
    ...(source ? { source } : {}),
  }
  await fs.appendFile(path.join(dir, fileName), `${JSON.stringify(row)}\n`)
}

export async function readAcpRequests(dir: string): Promise<RecordedAcpRequest[]> {
  try {
    const content = await fs.readFile(path.join(dir, fileName), "utf8")
    return content.trim().split("\n").filter(Boolean).map((line) => JSON.parse(line) as RecordedAcpRequest)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return []
    throw error
  }
}
