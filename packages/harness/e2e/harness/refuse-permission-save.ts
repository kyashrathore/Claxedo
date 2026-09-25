import { Database } from "bun:sqlite"
import fs from "node:fs/promises"
import path from "node:path"

const TRIGGER = "e2e_refuse_permission_reply"

export async function refusePermissionReplySave(dataDir: string, sessionId: string) {
  if (process.env.CLAXEDO_E2E_OMIT_PERMISSION_SAVE_FAULT === "1") return () => {}
  if (!/^ses_[A-Za-z0-9-]+$/.test(sessionId)) throw new Error(`Unexpected session id ${sessionId}`)
  const candidates = (await fs.readdir(dataDir, { recursive: true }))
    .filter((name) => name.endsWith(`${path.sep}state.db`))
    .map((name) => path.join(dataDir, name))
  if (candidates.length !== 1) throw new Error(`Expected one runtime state.db under ${dataDir}: ${candidates.join(", ")}`)
  const file = candidates[0]
  const db = new Database(file)
  try {
    db.exec(`CREATE TRIGGER ${TRIGGER} BEFORE INSERT ON runtime_journal
      WHEN NEW.type = 'permission.replied' AND NEW.session_id = '${sessionId}'
      BEGIN SELECT RAISE(ABORT, 'e2e permission reply save refused'); END`)
  } finally {
    db.close()
  }
  return () => {
    const restore = new Database(file)
    try {
      restore.exec(`DROP TRIGGER ${TRIGGER}`)
    } finally {
      restore.close()
    }
  }
}
