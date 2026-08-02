import { createSignal, onMount, Show } from "solid-js";
import { useNavigate } from "@solidjs/router";
import { useAuthSession } from "@/platform/auth/auth-session";

export interface LoginPageProps {
  /** App branding name (defaults to "Claxedo") */
  appName?: string;
  /** App tagline (defaults to "Cloud-first development environment") */
  tagline?: string;
  /** Success redirect URL (defaults to /) */
  redirectUrl?: string;
  /** Custom terms of service URL */
  termsUrl?: string;
  /** Custom privacy policy URL */
  privacyUrl?: string;
}

/**
 * LoginPage component for Claxedo cloud authentication.
 * Uses Clerk for authentication.
 */
export default function LoginPage(props: LoginPageProps = {}) {
  const navigate = useNavigate();
  const auth = useAuthSession();
  const [redirecting, setRedirecting] = createSignal(false);

  const appName = () => props.appName ?? "Claxedo";
  const tagline = () => props.tagline ?? "Cloud-first development environment";
  const redirectUrl = () => props.redirectUrl ?? "/";

  onMount(async () => {
    if (auth.status() === "signed") {
      navigate(redirectUrl(), { replace: true });
      return;
    }
  });

  if (auth.status() === "signed") {
    navigate(redirectUrl(), { replace: true });
    return null;
  }

  const continueToClerk = async () => {
    setRedirecting(true);
    await auth.signIn({ redirectUrl: redirectUrl() }).finally(() => setRedirecting(false));
  };

  return (
    <div class="flex flex-col items-center justify-center min-h-screen bg-background-base text-text-strong p-4">
      <div class="w-full max-w-md">
        <div class="text-center mb-8">
          <h1 class="text-3xl font-bold text-text-strong mb-2">
            {appName()}
          </h1>
          <p class="text-text-weak text-sm">{tagline()}</p>
        </div>

        <button
          type="button"
          class="w-full rounded-lg bg-surface-interactive-base px-4 py-3 text-sm font-medium text-text-on-interactive-base transition hover:bg-surface-interactive-base/90 disabled:cursor-wait disabled:opacity-70"
          disabled={redirecting()}
          onClick={continueToClerk}
        >
          <Show when={redirecting()} fallback="Continue">
            Redirecting...
          </Show>
        </button>

        <div class="mt-8 text-center text-xs text-text-weaker">
          By continuing, you agree to {appName()}'s{" "}
          <a
            href={props.termsUrl ?? "#"}
            class="text-text-interactive-base hover:underline"
          >
            Terms of Service
          </a>{" "}
          and{" "}
          <a
            href={props.privacyUrl ?? "#"}
            class="text-text-interactive-base hover:underline"
          >
            Privacy Policy
          </a>
          .
        </div>
      </div>
    </div>
  );
}
