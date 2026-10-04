import type { ErrorMessages } from "./model"

export default {
  auth: ["Erneut anmelden", "Deine Anmeldung ist abgelaufen oder wurde abgelehnt. Melde dich erneut an, um fortzufahren."],
  forbidden: ["Nicht erlaubt", "Dein Konto hat keinen Zugriff darauf. Bitte den Eigentümer um Zugriff."],
  rate_limit: ["Zu viele Anfragen", "Der Server begrenzt Anfragen. Warte einen Moment und versuche es dann erneut."],
  network: ["Server nicht erreichbar", "Der Server konnte nicht erreicht werden. Prüfe die Verbindung und versuche es erneut."],
  not_found: ["Nicht gefunden", "Das existiert nicht mehr. Es wurde möglicherweise gelöscht."],
  conflict: ["Anderswo geändert", "Das wurde zuerst anderswo geändert. Lade neu und versuche es erneut."],
  invalid: ["Anfrage abgelehnt", "Der Server hat diese Anfrage als ungültig abgelehnt."],
  internal: ["Etwas ist schiefgelaufen", "Ein unerwarteter Fehler ist aufgetreten. Versuche es erneut."],
  signIn: "Anmelden",
  retry: "Erneut versuchen",
  reload: "Neu laden",
} satisfies ErrorMessages
