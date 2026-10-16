import { ApiReferenceReact } from '@scalar/api-reference-react'
import '@scalar/api-reference-react/style.css'

// The API reference rendered from the spec this server serves. Everything
// stays on the LAN: no telemetry, no developer toolbar, no hosted agent / MCP,
// no web fonts, no request proxy ("Test request" calls this server directly,
// same origin).
export default function DocsReference() {
  const dark = document.documentElement.classList.contains('dark')
  return (
    <ApiReferenceReact
      configuration={{
        url: '/api/v1/openapi.yaml',
        servers: [{ url: `${window.location.origin}/api/v1`, description: 'This server' }],
        telemetry: false,
        // its toolbar's Share / Deploy upload the spec to scalar.com
        showDeveloperTools: 'never',
        agent: { disabled: true },
        mcp: { disabled: true },
        withDefaultFonts: false,
        hideDarkModeToggle: true,
        forceDarkModeState: dark ? 'dark' : 'light',
        documentDownloadType: 'yaml',
        theme: 'default',
      }}
    />
  )
}
