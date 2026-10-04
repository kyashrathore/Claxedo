import type { ErrorMessages } from "./model"

export default {
  auth: ["Vuelve a iniciar sesión", "Tu sesión caducó o fue rechazada. Inicia sesión de nuevo para continuar."],
  rate_limit: ["Demasiadas solicitudes", "El servidor está limitando las solicitudes. Espera un momento y vuelve a intentarlo."],
  network: ["No se puede conectar con el servidor", "No se pudo conectar con el servidor. Comprueba la conexión y vuelve a intentarlo."],
  not_found: ["No encontrado", "Esto ya no existe. Es posible que se haya eliminado."],
  conflict: ["Cambiado en otro lugar", "Esto se cambió antes en otro lugar. Recarga y vuelve a intentarlo."],
  invalid: ["Solicitud rechazada", "El servidor rechazó esta solicitud por no ser válida."],
  internal: ["Algo salió mal", "Se produjo un error inesperado. Vuelve a intentarlo."],
  signIn: "Iniciar sesión",
  retry: "Reintentar",
  reload: "Recargar",
} satisfies ErrorMessages
