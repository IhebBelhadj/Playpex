import { unwrap, type Schemas } from '../http/api'
import type { ApiClient } from '../http/client'

// The server itself (docs/api/discovery.md): its name, version, what it can do.

export type ServerInfo = Schemas['ServerInfo']

export function getServerInfo(client: ApiClient): Promise<ServerInfo> {
  return unwrap(client.api.GET('/server'))
}
