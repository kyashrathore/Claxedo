import type { GithubOptions, GithubProfile } from "@better-auth/core/social-providers"

type GitHubEmail = { email: string; primary: boolean; verified: boolean }

const PROFILE_URL = "https://api.github.com/user"
const EMAILS_URL = "https://api.github.com/user/emails"

/**
 * The person a GitHub sign-in names, as Better Auth 1.7.1's own GitHub provider
 * reads them (`@better-auth/core/dist/social-providers/github.mjs`), with the
 * profile and the address list asked at once: that provider awaits the profile
 * before it asks for the addresses, though both need only the token, so every
 * sign-in callback paid two GitHub round trips in a row for one answer. A
 * refused profile is no person; a refused address list leaves the profile's
 * own public address, unverified, as it did there.
 */
export function githubUserInfo(request: (url: string, init: RequestInit) => Promise<Response>): NonNullable<GithubOptions["getUserInfo"]> {
  return async (token) => {
    const headers = { Authorization: `Bearer ${token.accessToken}`, "User-Agent": "better-auth", Accept: "application/json" }
    const [profileAnswer, emailsAnswer] = await Promise.all([request(PROFILE_URL, { headers }), request(EMAILS_URL, { headers })])
    if (!profileAnswer.ok) return null
    const profile = (await profileAnswer.json()) as GithubProfile
    const emails = emailsAnswer.ok ? ((await emailsAnswer.json()) as GitHubEmail[]) : undefined
    if (!profile.email && emails) profile.email = (emails.find((email) => email.primary) ?? emails[0])?.email ?? profile.email
    return {
      user: {
        name: profile.name || profile.login || "",
        email: profile.email,
        image: profile.avatar_url,
        emailVerified: emails?.find((email) => email.email === profile.email)?.verified ?? false,
      },
      data: profile,
    }
  }
}
