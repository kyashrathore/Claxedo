import type { ErrorMessages } from "./model"

export default {
  auth: ["Entre novamente", "Seu login expirou ou foi recusado. Entre novamente para continuar."],
  rate_limit: ["Muitas solicitações", "O servidor está limitando as solicitações. Aguarde um momento e tente novamente."],
  network: ["Não foi possível acessar o servidor", "Não foi possível conectar ao servidor. Verifique a conexão e tente novamente."],
  not_found: ["Não encontrado", "Isto não existe mais. Pode ter sido excluído."],
  conflict: ["Alterado em outro lugar", "Isto foi alterado antes em outro lugar. Recarregue e tente novamente."],
  invalid: ["Solicitação recusada", "O servidor recusou esta solicitação por ser inválida."],
  internal: ["Algo deu errado", "Ocorreu um erro inesperado. Tente novamente."],
  signIn: "Entrar",
  retry: "Tentar novamente",
  reload: "Recarregar",
} satisfies ErrorMessages
