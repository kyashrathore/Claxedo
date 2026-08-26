export namespace ServerConnection {
  type Base = { displayName?: string }

  export type HttpBase = {
    url: string
    username?: string
    password?: string
  }

  export type Http = { type: "http"; http: HttpBase } & Base
  export type Sidecar = { type: "sidecar"; http: HttpBase } & (
    { variant: "base" } | { variant: "wsl"; distro: string }
  ) &
    Base
  export type Any = Http | Sidecar

  export type Key = string & { _brand: "Key" }
  export const Key = { make: (value: string) => value as Key }

  export const key = (connection: Any): Key => {
    if (connection.type === "http") return Key.make(connection.http.url)
    return Key.make(connection.variant === "wsl" ? `wsl:${connection.distro}` : "sidecar")
  }

  export function fromUrl(url: string): Http {
    return { type: "http", http: { url } }
  }
}
