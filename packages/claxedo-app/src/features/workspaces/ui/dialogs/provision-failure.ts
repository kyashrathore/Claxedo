export type ProvisionFailureClass = "bad_key" | "no_payment_method" | "quota" | "region" | "unknown"

export type ProvisionFailure = {
  class: ProvisionFailureClass
  title: string
  guidance: string
  action: string
}

export function classifyProvisionFailure(message: string): ProvisionFailure {
  if (/payment method|billing/i.test(message)) {
    return {
      class: "no_payment_method",
      title: "Your provider needs billing setup",
      guidance: "Add a payment method with the compute provider, then retry this same workspace.",
      action: "Open provider billing",
    }
  }
  if (/quota|capacity limit|limit exceeded/i.test(message)) {
    return {
      class: "quota",
      title: "Provider quota reached",
      guidance: "Raise the provider quota or select another configured provider, then retry.",
      action: "Review provider quota",
    }
  }
  if (/region|location.*unavailable/i.test(message)) {
    return {
      class: "region",
      title: "That region is unavailable",
      guidance: "Choose another supported region and retry the same provision.",
      action: "Choose another region",
    }
  }
  if (/api key|unauthori[sz]ed|invalid credential|\b401\b|\b403\b/i.test(message)) {
    return {
      class: "bad_key",
      title: "The provider rejected this key",
      guidance: "Update the provider credential, then retry this same workspace.",
      action: "Update API key",
    }
  }
  return {
    class: "unknown",
    title: "Provisioning stopped",
    guidance: "Review the provider response and retry this same workspace.",
    action: "Retry provisioning",
  }
}

export function readyProvisionDirectory(status: string | null | undefined, path: string) {
  if (status !== "ready") return
  return path
}
