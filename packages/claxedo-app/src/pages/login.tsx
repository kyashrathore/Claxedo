import { createSignal, onMount, Show } from "solid-js";
import { useNavigate } from "@solidjs/router";
import { clerk, waitForClerk, useAuth } from "../utils/auth-client";

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
  const { isSignedIn, loading } = useAuth();
  const [clerkReady, setClerkReady] = createSignal(false);
  let signInDiv: HTMLDivElement | undefined;

  const appName = () => props.appName ?? "Claxedo";
  const tagline = () => props.tagline ?? "Cloud-first development environment";
  const redirectUrl = () => props.redirectUrl ?? "/";

  // Redirect if already signed in
  onMount(async () => {
    await waitForClerk();
    setClerkReady(true);

    if (clerk.user) {
      navigate(redirectUrl(), { replace: true });
      return;
    }

    // Mount Clerk sign-in component
    if (signInDiv) {
      clerk.mountSignIn(signInDiv, {
        signUpUrl: "/login", // Same page for sign up
        afterSignInUrl: redirectUrl(),
        afterSignUpUrl: redirectUrl(),
        appearance: {
          variables: {
            colorPrimary: "var(--surface-interactive-base)",
            colorBackground: "var(--background-base)",
            colorText: "var(--text-strong)",
            colorTextSecondary: "var(--text-weak)",
            colorInputBackground: "var(--surface-inset-base)",
            colorInputText: "var(--text-strong)",
            borderRadius: "0.75rem",
          },
          elements: {
            rootBox: { width: "100%" },
            card: {
              backgroundColor: "var(--background-base)",
              border: "1px solid var(--border-weak-base)",
              boxShadow: "var(--shadow-lg)",
            },
            headerTitle: { color: "var(--text-strong)" },
            headerSubtitle: { color: "var(--text-weak)" },
            socialButtonsBlockButton: {
              backgroundColor: "var(--surface-raised-stronger)",
              border: "1px solid var(--border-weak-base)",
              color: "var(--text-strong)",
            },
            socialButtonsBlockButtonText: {
              color: "var(--text-strong)",
              fontWeight: "500",
            },
            socialButtonsBlockButtonArrow: { color: "var(--icon-base)" },
            dividerLine: { backgroundColor: "var(--border-weak-base)" },
            dividerText: { color: "var(--text-weaker)" },
            formFieldLabel: { color: "var(--text-base)" },
            formFieldInput: {
              backgroundColor: "var(--surface-inset-base)",
              border: "1px solid var(--border-base)",
              color: "var(--text-strong)",
            },
            formButtonPrimary: {
              backgroundColor: "var(--surface-interactive-base)",
              color: "var(--text-on-interactive-base)",
            },
            footerActionLink: { color: "var(--text-interactive-base)" },
            identityPreviewText: { color: "var(--text-strong)" },
            identityPreviewEditButton: { color: "var(--text-interactive-base)" },
          },
        },
      });
    }
  });

  // If signed in, redirect
  if (!loading() && isSignedIn()) {
    navigate(redirectUrl(), { replace: true });
    return null;
  }

  return (
    <div class="flex flex-col items-center justify-center min-h-screen bg-background-base text-text-strong p-4">
      <div class="w-full max-w-md">
        <div class="text-center mb-8">
          <h1 class="text-3xl font-bold text-text-strong mb-2">
            {appName()}
          </h1>
          <p class="text-text-weak text-sm">{tagline()}</p>
        </div>

        {/* Fix Clerk social button hover - inline CSS since Tailwind doesn't apply to Clerk components */}
        <style>{`
          .cl-socialButtonsBlockButton:hover {
            background-color: var(--surface-raised-base-hover) !important;
            border-color: var(--border-hover) !important;
          }
          .cl-socialButtonsBlockButton:hover .cl-socialButtonsBlockButtonText {
            color: var(--text-strong) !important;
          }
        `}</style>

        <Show
          when={clerkReady()}
          fallback={
            <div class="flex items-center justify-center p-8">
              <span class="animate-spin h-8 w-8 border-2 border-border-weak-base border-t-border-strong-base rounded-full" />
            </div>
          }
        >
          {/* Clerk Sign-In component will be mounted here */}
          <div ref={signInDiv} class="clerk-sign-in" />
        </Show>

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
