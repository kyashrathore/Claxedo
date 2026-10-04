import type { ErrorMessages } from "./model"

export default {
  auth: ["Zaloguj się ponownie", "Twoje logowanie wygasło lub zostało odrzucone. Zaloguj się ponownie, aby kontynuować."],
  forbidden: ["Brak dostępu", "Twoje konto nie ma do tego dostępu. Poproś właściciela o dostęp."],
  rate_limit: ["Zbyt wiele żądań", "Serwer ogranicza liczbę żądań. Poczekaj chwilę i spróbuj ponownie."],
  network: ["Brak połączenia z serwerem", "Nie udało się połączyć z serwerem. Sprawdź połączenie i spróbuj ponownie."],
  not_found: ["Nie znaleziono", "To już nie istnieje. Mogło zostać usunięte."],
  conflict: ["Zmieniono w innym miejscu", "To zostało wcześniej zmienione w innym miejscu. Odśwież i spróbuj ponownie."],
  invalid: ["Żądanie odrzucone", "Serwer odrzucił to żądanie jako nieprawidłowe."],
  internal: ["Coś poszło nie tak", "Wystąpił nieoczekiwany błąd. Spróbuj ponownie."],
  signIn: "Zaloguj się",
  retry: "Spróbuj ponownie",
  reload: "Odśwież",
} satisfies ErrorMessages
