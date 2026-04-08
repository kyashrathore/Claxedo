import { backfillRepos, type RepoBinding, type RepoBindingResolver } from "../repo";
import type { SqliteDb } from "../sqlite";

/**
 * Creates a memoized repo-sync function that calls backfillRepos at most once
 * every 10 seconds (unless forced).
 */
export function createRepoSync(
  db: SqliteDb,
  repos?: RepoBindingResolver,
): (force?: boolean) => Promise<RepoBinding[]> {
  let tick = 0;
  let memo: Promise<RepoBinding[]> | null = null;

  return async (force = false): Promise<RepoBinding[]> => {
    if (!repos) {
      await backfillRepos(db, []);
      return [];
    }
    const now = Date.now();
    if (!force && memo && now - tick < 10_000) return memo;
    tick = now;
    memo = repos().then(async (list) => {
      await backfillRepos(db, list);
      return list;
    });
    return memo;
  };
}
