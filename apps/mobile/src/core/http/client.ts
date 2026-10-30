import { API_PREFIX, authHeaders, createApi, type Api, type LostReason } from './api'

// One server as the rest of the app talks to it: who it is, the typed API with
// this device's credentials, and the URLs that leave the API client (the
// player's stream, images, subtitle files) with the same credentials. Screens
// and services never build a server URL or an Authorization header themselves.

export type ServerIdentity = {
  id: string
  name: string
  /** http://<address>:<port> */
  url: string
  token: string | null
}

/** An image or file the native side fetches: with the headers when it is the server's */
export type RemoteSource = { uri: string; headers?: Record<string, string> }

export class ApiClient {
  readonly api: Api
  private readonly auth: Record<string, string>

  constructor(
    readonly server: ServerIdentity,
    readonly deviceId: string,
    onLost: (reason: LostReason) => void,
  ) {
    this.auth = authHeaders(server.token, deviceId)
    this.api = createApi({ url: server.url, token: server.token, deviceId, onLost })
  }

  /** The headers every request to this server carries (the player and image loaders send them too) */
  headers(): Record<string, string> {
    return { ...this.auth }
  }

  /** `Name: value` lines, as mpv's http-header-fields takes them */
  headerLines(): string[] {
    return Object.entries(this.auth).map(([name, value]) => `${name}: ${value}`)
  }

  /** A URL of the API: a path under the prefix or not, or a full URL the server gave */
  url(path: string): string {
    if (/^https?:\/\//.test(path)) return path
    return this.server.url + (path.startsWith(API_PREFIX) ? path : API_PREFIX + path)
  }

  /** A media ref's URL: the stream itself, or one of its routes (`/index.m3u8`, `/subtitles/file/f2`) */
  mediaUrl(ref: string, suffix = ''): string {
    return this.url(`/media/${encodeURIComponent(ref)}${suffix}`)
  }

  /** Something to load natively: the server's URLs with credentials, others as they are */
  source(pathOrUrl: string): RemoteSource {
    const uri = this.url(pathOrUrl)
    return uri.startsWith(this.server.url) ? { uri, headers: this.headers() } : { uri }
  }
}
