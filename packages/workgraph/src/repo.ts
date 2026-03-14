export type RepoRef = {
  repo_ref: string
  repo_label: string
}

export type RepoBinding = RepoRef & {
  project_root: string
  project_id?: string | null
  project_name?: string | null
}

export type RepoBucket = {
  repo_ref: string | null
  repo_label: string
  item_count: number
  slice_count: number
  bindings: RepoBinding[]
  bound: boolean
}

export type RepoBindingResolver = () => Promise<RepoBinding[]>

function clean(value: string) {
  return value.trim().replace(/\/+$/, "").replace(/\.git$/i, "")
}

function label(path: string) {
  const bits = path.split("/").filter(Boolean)
  if (bits.length >= 2) return `${bits.at(-2)}/${bits.at(-1)}`
  return bits[0] ?? path
}

function github(remote: string) {
  const txt = clean(remote)
  const match = txt.match(/github\.com[:/](?<owner>[^/]+)\/(?<repo>[^/]+)$/i)
  if (!match?.groups?.owner || !match.groups.repo) return null
  const slug = `${match.groups.owner}/${match.groups.repo}`.toLowerCase()
  return {
    repo_ref: `github:${slug}`,
    repo_label: slug,
  } satisfies RepoRef
}

function generic(remote: string) {
  const txt = clean(remote)
  try {
    const url = new URL(txt)
    const path = clean(url.pathname)
    const host = url.host.toLowerCase()
    return {
      repo_ref: `git:${url.protocol}//${host}${path}`,
      repo_label: `${host}/${label(path)}`,
    } satisfies RepoRef
  } catch {}
  const scp = txt.match(/^(?<user>[^@]+@)?(?<host>[^:]+):(?<path>.+)$/)
  if (!scp?.groups?.host || !scp.groups.path) return null
  const path = clean(`/${scp.groups.path}`)
  const user = scp.groups.user ?? ""
  const host = scp.groups.host.toLowerCase()
  return {
    repo_ref: `git:ssh://${user}${host}${path}`,
    repo_label: `${host}/${label(path)}`,
  } satisfies RepoRef
}

export function normalizeRemote(remote: string) {
  return github(remote) ?? generic(remote)
}

function text(value: unknown) {
  return typeof value === "string" && value.trim() ? value.trim() : null
}

export function inferRepo(provider?: string | null, meta?: Record<string, unknown> | null, url?: string | null) {
  if (provider === "github") {
    const owner = text(meta?.owner)
    const repo = text(meta?.repo)
    if (owner && repo) {
      const slug = `${owner}/${repo}`.toLowerCase()
      return {
        repo_ref: `github:${slug}`,
        repo_label: slug,
      } satisfies RepoRef
    }
    const next = text(url)
    if (!next) return null
    return normalizeRemote(next)
  }
  if (provider) return null
  const next = text(url)
  if (!next) return null
  return normalizeRemote(next)
}

async function top(dir: string) {
  const res = await Bun.$`git -C ${dir} rev-parse --show-toplevel`.quiet().nothrow()
  const txt = res.text().trim()
  if (!txt) return null
  return txt
}

async function remote(dir: string) {
  const origin = await Bun.$`git -C ${dir} remote get-url origin`.quiet().nothrow()
  const direct = origin.text().trim()
  if (direct) return direct
  const list = await Bun.$`git -C ${dir} remote`.quiet().nothrow()
  const name = list
    .text()
    .split(/\r?\n/)
    .map((item) => item.trim())
    .find(Boolean)
  if (!name) return null
  const row = await Bun.$`git -C ${dir} remote get-url ${name}`.quiet().nothrow()
  return row.text().trim() || null
}

export async function resolveRepoDir(
  dir: string,
  meta?: {
    project_id?: string | null
    project_name?: string | null
  },
) {
  const root = await top(dir)
  if (!root) return null
  const url = await remote(root)
  if (!url) return null
  const repo = normalizeRemote(url)
  if (!repo) return null
  return {
    ...repo,
    project_root: root,
    project_id: meta?.project_id ?? null,
    project_name: meta?.project_name ?? null,
  } satisfies RepoBinding
}

type Row = {
  source_id?: string
  item_id?: string
  repo_ref?: string | null
  repo_label?: string | null
  provider?: string | null
  provider_meta?: string | null
  provider_url?: string | null
  import_query?: string | null
  parent_id?: string | null
  plan_run_id?: string | null
  last_run_id?: string | null
}

function parse(value: string | null | undefined) {
  if (!value) return null
  try {
    return JSON.parse(value) as Record<string, unknown>
  } catch {
    return null
  }
}

function table(db: any, name: string) {
  const row = db.query("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?").get(name) as { name?: string } | null
  return !!row?.name
}

function fromDir(binds: RepoBinding[], dir: string | null | undefined) {
  if (!dir) return null
  const hit = binds.find((item) => dir === item.project_root || dir.startsWith(`${item.project_root}/`))
  if (hit) return hit
  return null
}

async function fromRun(db: any, binds: RepoBinding[], id: string | null | undefined) {
  if (!id) return null
  const exec = db.query("SELECT directory FROM run_exec_current WHERE run_id = ?").get(id) as { directory?: string | null } | null
  const bound = fromDir(binds, exec?.directory ?? null)
  if (bound) return bound
  if (!exec?.directory) return null
  return resolveRepoDir(exec.directory)
}

export async function backfillRepos(db: any, binds: RepoBinding[] = []) {
  if (table(db, "sources_current")) {
    for (const row of db.query("SELECT source_id, repo_ref, repo_label, provider, import_query, plan_run_id, last_run_id FROM sources_current").all() as Row[]) {
      if (row.repo_ref) continue
      const repo =
        inferRepo(row.provider, parse(row.import_query), null) ??
        await fromRun(db, binds, row.last_run_id ?? row.plan_run_id ?? null)
      if (!repo) continue
      db.run(
        "UPDATE sources_current SET repo_ref = ?, repo_label = ?, updated_at = ? WHERE source_id = ?",
        [repo.repo_ref, repo.repo_label, new Date().toISOString(), row.source_id],
      )
    }
  }

  if (!table(db, "wg_items")) return
  let dirty = true
  while (dirty) {
    dirty = false
    for (const row of db.query("SELECT id AS item_id, source_id, parent_id, repo_ref, repo_label, provider, provider_meta, provider_url FROM wg_items").all() as Row[]) {
      if (row.repo_ref) continue
      const src = row.source_id
        ? (db.query("SELECT repo_ref, repo_label FROM sources_current WHERE source_id = ?").get(row.source_id) as Row | null)
        : null
      const parent = row.parent_id
        ? (db.query("SELECT repo_ref, repo_label FROM wg_items WHERE id = ?").get(row.parent_id) as Row | null)
        : null
      const repo =
        inferRepo(row.provider, parse(row.provider_meta), row.provider_url) ??
        (src?.repo_ref ? { repo_ref: src.repo_ref, repo_label: src.repo_label ?? src.repo_ref } : null) ??
        (parent?.repo_ref ? { repo_ref: parent.repo_ref, repo_label: parent.repo_label ?? parent.repo_ref } : null)
      if (!repo) continue
      db.run(
        "UPDATE wg_items SET repo_ref = ?, repo_label = ?, updated_at = ? WHERE id = ?",
        [repo.repo_ref, repo.repo_label, new Date().toISOString(), row.item_id],
      )
      dirty = true
    }
  }
}

export function buckets(db: any, binds: RepoBinding[] = []) {
  const map = new Map<string, RepoBucket>()
  const put = (repoRef: string | null, repoLabel: string | null) => {
    const key = repoRef ?? "__unbound__"
    const hit = map.get(key)
    if (hit) return hit
    const next = {
      repo_ref: repoRef,
      repo_label: repoLabel ?? (repoRef ?? "Unbound"),
      item_count: 0,
      slice_count: 0,
      bindings: [],
      bound: false,
    } satisfies RepoBucket
    map.set(key, next)
    return next
  }

  for (const row of db.query("SELECT repo_ref, repo_label, COUNT(*) AS count FROM wg_items WHERE deleted_at IS NULL GROUP BY repo_ref, repo_label").all() as Array<{ repo_ref: string | null; repo_label: string | null; count: number }>) {
    const bucket = put(row.repo_ref, row.repo_label)
    bucket.item_count = Number(row.count) || 0
  }
  for (const row of db.query("SELECT repo_ref, repo_label, COUNT(*) AS count FROM sources_current GROUP BY repo_ref, repo_label").all() as Array<{ repo_ref: string | null; repo_label: string | null; count: number }>) {
    const bucket = put(row.repo_ref, row.repo_label)
    bucket.slice_count = Number(row.count) || 0
  }
  for (const bind of binds) {
    const bucket = put(bind.repo_ref, bind.repo_label)
    bucket.bindings.push(bind)
    bucket.bound = true
  }

  return Array.from(map.values()).sort((a, b) => {
    if (!a.repo_ref) return 1
    if (!b.repo_ref) return -1
    return a.repo_label.localeCompare(b.repo_label)
  })
}
