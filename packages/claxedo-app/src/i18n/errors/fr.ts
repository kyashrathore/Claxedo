import type { ErrorMessages } from "./model"

export default {
  auth: ["Reconnectez-vous", "Votre connexion a expiré ou a été refusée. Reconnectez-vous pour continuer."],
  rate_limit: ["Trop de requêtes", "Le serveur limite les requêtes. Patientez un instant, puis réessayez."],
  network: ["Serveur injoignable", "Le serveur est injoignable. Vérifiez la connexion, puis réessayez."],
  not_found: ["Introuvable", "Cet élément n'existe plus. Il a peut-être été supprimé."],
  conflict: ["Modifié ailleurs", "Cet élément a d'abord été modifié ailleurs. Rechargez, puis réessayez."],
  invalid: ["Requête refusée", "Le serveur a refusé cette requête car elle n'est pas valide."],
  internal: ["Une erreur s'est produite", "Une erreur inattendue s'est produite. Réessayez."],
  signIn: "Se connecter",
  retry: "Réessayer",
  reload: "Recharger",
} satisfies ErrorMessages
