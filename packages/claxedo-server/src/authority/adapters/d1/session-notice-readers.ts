import { maySqlForPrincipalRow } from "./authorization"

/** The caller binds the canonical refs JSON once; all reader standing is re-read by this shared query. */
export function sessionNoticeReadersSql(action: "read" | "read_removed") {
  const access = maySqlForPrincipalRow({ userId: "recipient.user_id", actorId: "recipient.actor_id" }, action, { kind: "session", alias: "s" })
  return `FROM sessions s JOIN actors recipient ON recipient.kind = 'human'
    WHERE EXISTS (SELECT 1 FROM json_each(?) selected
      WHERE json_extract(selected.value, '$.sessionId') = s.session_id
        AND json_extract(selected.value, '$.workspaceId') = s.workspace_id)
      AND s.parent_session_id IS NULL
      AND EXISTS (SELECT 1 FROM auth_identities identity WHERE identity.user_id = recipient.user_id AND identity.unlinked_at IS NULL)
      AND ${access}`
}
