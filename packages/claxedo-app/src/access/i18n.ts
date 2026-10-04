import type { Translations } from "@/i18n"

type AccessKey =
  | "access.org.title"
  | "access.org.description"
  | "access.org.role.owner"
  | "access.org.role.admin"
  | "access.org.role.member"
  | "access.org.you"
  | "access.org.yourRole"
  | "access.org.members"
  | "access.org.membersLoading"
  | "access.org.membersFailed"
  | "access.org.unnamed"
  | "access.org.manager"
  | "access.org.loading"
  | "access.org.failed"
  | "access.org.restricted"
  | "access.org.signedOut"
  | "access.org.none"
  | "access.org.checking"
  | "access.org.signIn"
  | "access.org.signInFailed"

export const accessDictionary = {
  en: {
    "access.org.title": "Organization",
    "access.org.description": "The people you work with. Being in an organization gives nobody access to your machines or projects.",
    "access.org.role.owner": "Owner",
    "access.org.role.admin": "Admin",
    "access.org.role.member": "Member",
    "access.org.you": "You",
    "access.org.yourRole": "Your role: {{role}}",
    "access.org.members": "Members",
    "access.org.membersLoading": "Loading members…",
    "access.org.membersFailed": "Couldn't load the members",
    "access.org.unnamed": "Member without a name",
    "access.org.manager": "As an owner or admin you manage its members and the provider accounts everyone's agents can run on (Settings → Models).",
    "access.org.loading": "Loading your organization…",
    "access.org.failed": "Couldn't load your organization",
    "access.org.restricted": "Only owners and admins can manage the organization.",
    "access.org.signedOut": "Sign in to see your organization.",
    "access.org.none": "You are not in an organization.",
    "access.org.checking": "Checking account…",
    "access.org.signIn": "Sign in",
    "access.org.signInFailed": "Could not sign in",
  },
  ar: {
    "access.org.title": "المؤسسة",
    "access.org.checking": "جارٍ التحقق من الحساب…",
    "access.org.signIn": "تسجيل الدخول",
    "access.org.signInFailed": "تعذّر تسجيل الدخول",
  },
  br: {
    "access.org.title": "Organização",
    "access.org.checking": "Verificando a conta…",
    "access.org.signIn": "Entrar",
    "access.org.signInFailed": "Não foi possível entrar",
  },
  bs: {
    "access.org.title": "Organizacija",
    "access.org.checking": "Provjera računa…",
    "access.org.signIn": "Prijavi se",
    "access.org.signInFailed": "Prijava nije uspjela",
  },
  da: {
    "access.org.title": "Organisation",
    "access.org.checking": "Tjekker konto…",
    "access.org.signIn": "Log ind",
    "access.org.signInFailed": "Kunne ikke logge ind",
  },
  de: {
    "access.org.title": "Organisation",
    "access.org.checking": "Konto wird geprüft…",
    "access.org.signIn": "Anmelden",
    "access.org.signInFailed": "Anmeldung fehlgeschlagen",
  },
  es: {
    "access.org.title": "Organización",
    "access.org.checking": "Comprobando la cuenta…",
    "access.org.signIn": "Iniciar sesión",
    "access.org.signInFailed": "No se pudo iniciar sesión",
  },
  fr: {
    "access.org.title": "Organisation",
    "access.org.checking": "Vérification du compte…",
    "access.org.signIn": "Se connecter",
    "access.org.signInFailed": "Impossible de se connecter",
  },
  ja: {
    "access.org.title": "組織",
    "access.org.checking": "アカウントを確認しています…",
    "access.org.signIn": "サインイン",
    "access.org.signInFailed": "サインインできませんでした",
  },
  ko: {
    "access.org.title": "조직",
    "access.org.checking": "계정을 확인하는 중…",
    "access.org.signIn": "로그인",
    "access.org.signInFailed": "로그인할 수 없습니다",
  },
  no: {
    "access.org.title": "Organisasjon",
    "access.org.checking": "Sjekker kontoen…",
    "access.org.signIn": "Logg inn",
    "access.org.signInFailed": "Kunne ikke logge inn",
  },
  pl: {
    "access.org.title": "Organizacja",
    "access.org.checking": "Sprawdzanie konta…",
    "access.org.signIn": "Zaloguj się",
    "access.org.signInFailed": "Nie udało się zalogować",
  },
  ru: {
    "access.org.title": "Организация",
    "access.org.checking": "Проверка аккаунта…",
    "access.org.signIn": "Войти",
    "access.org.signInFailed": "Не удалось войти",
  },
  th: {
    "access.org.title": "องค์กร",
    "access.org.checking": "กำลังตรวจสอบบัญชี…",
    "access.org.signIn": "ลงชื่อเข้าใช้",
    "access.org.signInFailed": "ไม่สามารถลงชื่อเข้าใช้ได้",
  },
  tr: {
    "access.org.title": "Kuruluş",
    "access.org.checking": "Hesap kontrol ediliyor…",
    "access.org.signIn": "Oturum aç",
    "access.org.signInFailed": "Oturum açılamadı",
  },
  zh: {
    "access.org.title": "组织",
    "access.org.checking": "正在检查账户…",
    "access.org.signIn": "登录",
    "access.org.signInFailed": "无法登录",
  },
  zht: {
    "access.org.title": "組織",
    "access.org.checking": "正在檢查帳戶…",
    "access.org.signIn": "登入",
    "access.org.signInFailed": "無法登入",
  },
} satisfies Translations<AccessKey>
