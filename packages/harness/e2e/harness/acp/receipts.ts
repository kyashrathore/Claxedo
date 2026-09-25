import fs from "node:fs/promises"
import path from "node:path"

export type PermissionReceipt = { sessionId: string; title: string; outcome: string; optionId?: string }
export type ElicitationReceipt = { sessionId: string; message: string; action: string; content?: unknown }

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

export async function recordElicitationReceipt(dir: string, receipt: ElicitationReceipt) {
  await fs.appendFile(path.join(dir, "elicitation-receipts.jsonl"), `${JSON.stringify(receipt)}\n`)
}

export async function readElicitationReceipts(dir: string): Promise<ElicitationReceipt[]> {
  try {
    const content = await fs.readFile(path.join(dir, "elicitation-receipts.jsonl"), "utf8")
    return content.trim().split("\n").filter(Boolean).map((line) => JSON.parse(line) as ElicitationReceipt)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return []
    throw error
  }
}
