import fs from "node:fs/promises"
import path from "node:path"

export type PermissionReceipt = { sessionId: string; title: string; outcome: string; optionId?: string }

function receiptFile(dir: string) {
  return path.join(dir, "permission-receipts.jsonl")
}

export async function recordPermissionReceipt(dir: string, receipt: PermissionReceipt) {
  await fs.appendFile(receiptFile(dir), `${JSON.stringify(receipt)}\n`)
}

export async function readPermissionReceipts(dir: string): Promise<PermissionReceipt[]> {
  try {
    const content = await fs.readFile(receiptFile(dir), "utf8")
    return content.trim().split("\n").filter(Boolean).map((line) => JSON.parse(line) as PermissionReceipt)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return []
    throw error
  }
}
