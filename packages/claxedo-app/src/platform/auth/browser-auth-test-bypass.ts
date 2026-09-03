import type { AuthDisplayUser } from "./auth-display"

type TestAuthWindow = typeof window & {
  __CLAXEDO_TEST_AUTH_TOKEN__?: string
  __CLAXEDO_TEST_AUTH_USER__?: AuthDisplayUser
  __CLAXEDO_DISABLE_TEST_AUTH_BYPASS__?: boolean
  __CLAXEDO_TEST_SIGNED_OUT__?: boolean
  __claxedoSignInCalls?: { redirectUrl?: string }[]
}

function testBuild() {
  return import.meta.env.DEV || import.meta.env.MODE === "test" || import.meta.env.VITE_CLAXEDO_E2E === "1"
}

function storedAuth(raw: string): { token?: string; user?: AuthDisplayUser } {
  const parsed: unknown = JSON.parse(raw)
  if (!parsed || typeof parsed !== "object") return {}
  return {
    ...("token" in parsed && typeof parsed.token === "string" ? { token: parsed.token } : {}),
    ...("user" in parsed && parsed.user && typeof parsed.user === "object"
      ? { user: parsed.user as AuthDisplayUser }
      : {}),
  }
}

export function testBrowserAuth(): { token?: string; user?: AuthDisplayUser } {
  if (!testBuild() || typeof window === "undefined") return {}
  const scope = window as TestAuthWindow
  if (scope.__CLAXEDO_TEST_SIGNED_OUT__) return {}
  if (scope.__CLAXEDO_TEST_AUTH_TOKEN__ || scope.__CLAXEDO_TEST_AUTH_USER__) {
    return { token: scope.__CLAXEDO_TEST_AUTH_TOKEN__, user: scope.__CLAXEDO_TEST_AUTH_USER__ }
  }
  if (import.meta.env.VITE_CLAXEDO_DISABLE_TEST_AUTH_BYPASS === "1" || scope.__CLAXEDO_DISABLE_TEST_AUTH_BYPASS__)
    return {}
  try {
    const raw = localStorage.getItem("opencode_test_auth")
    if (raw) return storedAuth(raw)
  } catch {
    // Test harness storage is optional.
  }
  if (typeof navigator !== "undefined" && navigator.webdriver) {
    return {
      token: "test-bypass-token",
      user: {
        id: "test-user",
        primaryEmailAddress: { emailAddress: "test@claxedo.test" },
        fullName: "Test User",
      },
    }
  }
  return {}
}

export function browserAuthTestSignedOut() {
  return testBuild() && typeof window !== "undefined" && (window as TestAuthWindow).__CLAXEDO_TEST_SIGNED_OUT__ === true
}

export function markBrowserAuthTestSignedOut() {
  if (testBuild() && typeof window !== "undefined") {
    ;(window as TestAuthWindow).__CLAXEDO_TEST_SIGNED_OUT__ = true
  }
}

export function recordBrowserAuthTestSignIn(redirectUrl?: string) {
  if (!testBuild() || typeof window === "undefined") return
  const scope = window as TestAuthWindow
  ;(scope.__claxedoSignInCalls ??= []).push({ redirectUrl })
}
