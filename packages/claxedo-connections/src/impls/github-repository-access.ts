import type { CodeHostAppInstallation, CodeHostRepositoryAccess, IntegrationFetch } from "../types.js"
import { record, text } from "../json.js"
import { publicApiFailure } from "@claxedo/helpers/api-error"

export const GITHUB_TOKEN_SETTINGS_URL = "https://github.com/settings/personal-access-tokens"

function installationFromGitHub(value: unknown): CodeHostAppInstallation[] {
  const row = record(value)
  const account = text(record(row?.account)?.login)
  const settingsUrl = text(row?.html_url)
  const selection = row?.repository_selection
  if (!account || !settingsUrl || (selection !== "all" && selection !== "selected")) return []
  return [{ account, settingsUrl, repositorySelection: selection }]
}

/**
 * A GitHub App's user token lists only the repositories the app is installed
 * on, so the installations say where more can be granted. GitHub answers 403
 * to a token that belongs to no app: a personal access token, whose own
 * repository selection decides what it lists.
 */
export async function githubRepositoryAccess(fetchImpl: IntegrationFetch, secret: string): Promise<CodeHostRepositoryAccess> {
  const res = await fetchImpl("https://api.github.com/user/installations?per_page=100", {
    headers: {
      Authorization: `Bearer ${secret}`,
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
      "User-Agent": "claxedo",
    },
  }).catch(() => undefined)
  if (!res) throw publicApiFailure("repository_provider_unavailable", "github_installations_unavailable")
  if (res.status === 403) return { kind: "token", settingsUrl: GITHUB_TOKEN_SETTINGS_URL }
  if (res.status === 401) throw publicApiFailure("repository_provider_unauthorized", "github_installations_unauthorized")
  if (!res.ok) throw publicApiFailure("repository_provider_unavailable", "github_installations_unavailable")
  const body = record(await res.json().catch(() => undefined))
  if (!body || !Array.isArray(body.installations)) {
    throw publicApiFailure("repository_provider_unavailable", "github_installations_invalid_response")
  }
  return { kind: "app", installations: body.installations.flatMap(installationFromGitHub) }
}
