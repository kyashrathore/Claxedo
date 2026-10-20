import type { SqlStorage } from "@cloudflare/workers-types"

/**
 * The bytes each of one plugin's blobs holds, in its supervisor's storage. The
 * supervisor is the only writer of the plugin's blobs, so its count is the
 * quota's authority, and a put reserves its size before the host stores it.
 */
export class PluginBlobUsage {
  constructor(private readonly sql: Pick<SqlStorage, "exec">) {}

  createSchema() {
    this.sql.exec("create table if not exists plugin_blob_usage (key text primary key, size integer not null)")
  }

  sizeOf(key: string): number | undefined {
    return this.sql.exec<{ size: number }>("select size from plugin_blob_usage where key = ?", key).toArray()[0]?.size
  }

  total(): number {
    return this.sql.exec<{ total: number | null }>("select sum(size) as total from plugin_blob_usage").toArray()[0]?.total ?? 0
  }

  record(key: string, size: number) {
    this.sql.exec("insert into plugin_blob_usage (key, size) values (?, ?) on conflict (key) do update set size = excluded.size", key, size)
  }

  forget(key: string) {
    this.sql.exec("delete from plugin_blob_usage where key = ?", key)
  }
}
