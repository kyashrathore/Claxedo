import { b as createSignal, o as onMount, i as insert, a as createComponent, u as use, d as Show, e as createRenderEffect, s as setAttribute, t as template } from "./styles-BYu1h1zk.js";
import { d as useNavigate, k as useAuth, w as waitForClerk, l as clerk } from "./main-CfU7H2cy.js";
import "./mermaid-classDiagram-DWBVSOg0.js";
var _tmpl$ = /* @__PURE__ */ template(`<div class=clerk-sign-in>`), _tmpl$2 = /* @__PURE__ */ template(`<div class="flex flex-col items-center justify-center min-h-screen bg-neutral-950 text-white p-4"><div class="w-full max-w-md"><div class="text-center mb-8"><h1 class="text-3xl font-bold bg-clip-text text-transparent bg-gradient-to-r from-blue-400 to-purple-500 mb-2"></h1><p class="text-neutral-400 text-sm"></p></div><style>
          .cl-socialButtonsBlockButton:hover {
            background-color: #f5f5f5 !important;
            border-color: #a3a3a3 !important;
          }
          .cl-socialButtonsBlockButton:hover .cl-socialButtonsBlockButtonText {
            color: #171717 !important;
          }
        </style><div class="mt-8 text-center text-xs text-neutral-500">By continuing, you agree to <!>'s <a class="text-blue-400 hover:underline">Terms of Service</a> and <a class="text-blue-400 hover:underline">Privacy Policy</a>.`), _tmpl$3 = /* @__PURE__ */ template(`<div class="flex items-center justify-center p-8"><span class="animate-spin h-8 w-8 border-2 border-white/20 border-t-white rounded-full">`);
function LoginPage(props = {}) {
  const navigate = useNavigate();
  const {
    isSignedIn,
    loading
  } = useAuth();
  const [clerkReady, setClerkReady] = createSignal(false);
  let signInDiv;
  const appName = () => props.appName ?? "Claxedo";
  const tagline = () => props.tagline ?? "Cloud-first development environment";
  const redirectUrl = () => props.redirectUrl ?? "/";
  onMount(async () => {
    await waitForClerk();
    setClerkReady(true);
    if (clerk.user) {
      navigate(redirectUrl(), {
        replace: true
      });
      return;
    }
    if (signInDiv) {
      clerk.mountSignIn(signInDiv, {
        signUpUrl: "/login",
        // Same page for sign up
        afterSignInUrl: redirectUrl(),
        afterSignUpUrl: redirectUrl(),
        appearance: {
          variables: {
            colorPrimary: "#6366f1",
            colorBackground: "#171717",
            colorText: "#ffffff",
            colorTextSecondary: "#a3a3a3",
            colorInputBackground: "#262626",
            colorInputText: "#ffffff",
            borderRadius: "0.75rem"
          },
          elements: {
            rootBox: {
              width: "100%"
            },
            card: {
              backgroundColor: "#171717",
              border: "1px solid #262626",
              boxShadow: "0 25px 50px -12px rgba(0, 0, 0, 0.25)"
            },
            headerTitle: {
              color: "#ffffff"
            },
            headerSubtitle: {
              color: "#a3a3a3"
            },
            socialButtonsBlockButton: {
              backgroundColor: "#ffffff",
              border: "1px solid #d4d4d4",
              color: "#171717"
            },
            socialButtonsBlockButtonText: {
              color: "#171717",
              fontWeight: "500"
            },
            socialButtonsBlockButtonArrow: {
              color: "#525252"
            },
            dividerLine: {
              backgroundColor: "#404040"
            },
            dividerText: {
              color: "#737373"
            },
            formFieldLabel: {
              color: "#d4d4d4"
            },
            formFieldInput: {
              backgroundColor: "#262626",
              border: "1px solid #404040",
              color: "#ffffff"
            },
            formButtonPrimary: {
              backgroundColor: "#4f46e5",
              color: "#ffffff"
            },
            footerActionLink: {
              color: "#818cf8"
            },
            identityPreviewText: {
              color: "#ffffff"
            },
            identityPreviewEditButton: {
              color: "#818cf8"
            }
          }
        }
      });
    }
  });
  if (!loading() && isSignedIn()) {
    navigate(redirectUrl(), {
      replace: true
    });
    return null;
  }
  return (() => {
    var _el$ = _tmpl$2(), _el$2 = _el$.firstChild, _el$3 = _el$2.firstChild, _el$4 = _el$3.firstChild, _el$5 = _el$4.nextSibling, _el$6 = _el$3.nextSibling, _el$8 = _el$6.nextSibling, _el$9 = _el$8.firstChild, _el$15 = _el$9.nextSibling, _el$0 = _el$15.nextSibling, _el$10 = _el$0.nextSibling, _el$11 = _el$10.nextSibling, _el$14 = _el$11.nextSibling;
    insert(_el$4, appName);
    insert(_el$5, tagline);
    insert(_el$2, createComponent(Show, {
      get when() {
        return clerkReady();
      },
      get fallback() {
        return _tmpl$3();
      },
      get children() {
        var _el$7 = _tmpl$();
        var _ref$ = signInDiv;
        typeof _ref$ === "function" ? use(_ref$, _el$7) : signInDiv = _el$7;
        return _el$7;
      }
    }), _el$8);
    insert(_el$8, appName, _el$15);
    createRenderEffect((_p$) => {
      var _v$ = props.termsUrl ?? "#", _v$2 = props.privacyUrl ?? "#";
      _v$ !== _p$.e && setAttribute(_el$10, "href", _p$.e = _v$);
      _v$2 !== _p$.t && setAttribute(_el$14, "href", _p$.t = _v$2);
      return _p$;
    }, {
      e: void 0,
      t: void 0
    });
    return _el$;
  })();
}
export {
  LoginPage as default
};
