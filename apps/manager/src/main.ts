import '@fontsource-variable/jost'
import './style.css'
import { canDiscover, probe, startDiscovery, toUrl, type Server } from './discovery'
import { canOpenWifiSettings, network, onNetwork, wifiSettings, type Network } from './connection'

// Playpex Server Manager's own page: which server to manage. At launch it opens
// the last one at once when it answers (not after Back, nor when the dashboard's
// "Switch server" sent us here: #pick), else lists the servers found on the network (the native
// plugin: mDNS + UDP, each confirmed), with a field for an address. Choosing
// one loads that server's dashboard in this WebView; Back returns here.
// Without a network it shows "No connection" (and "Not on Wi-Fi" above the list on mobile data
// only); a dashboard that can't be reached comes back here as #offline=<its URL> (PlaypexConnection.java)
// and returns to that page by itself once its server answers again.

const LAST_KEY = 'playpex.manager.last'
const AUTO_KEY = 'playpex.manager.autoOpened'   // sessionStorage: this app session already opened it
type Last = { id: string; name: string; url: string }

function loadLast(): Last | null {
  try {
    const v = JSON.parse(localStorage.getItem(LAST_KEY) ?? 'null')
    return v && typeof v.url === 'string' ? v : null
  } catch {
    return null
  }
}

function saveLast(s: Server) {
  try {
    localStorage.setItem(LAST_KEY, JSON.stringify({ id: s.id, name: s.name, url: s.url }))
  } catch {
    // storage off: the app simply asks again next time
  }
}

const state = {
  servers: new Map<string, Server>(),
  searchingSince: Date.now(),
  notice: null as string | null,
  error: null as string | null,
  busy: false,
  net: { connected: true, local: true } as Network,
  /** the "can't reach" screen: the dashboard page to go back to */
  offline: null as string | null,
  /** the last server still to open at launch, once there is a network */
  autoOpen: false,
  retrying: false,
}

const last = loadLast()
const app = document.getElementById('app')!

function open(server: Server) {
  saveLast(server)
  state.busy = true
  render()
  location.href = `${server.url}/`
}

function h<K extends keyof HTMLElementTagNameMap>(tag: K, props: Partial<HTMLElementTagNameMap[K]> & { class?: string } = {}, ...children: (Node | string | null | false)[]) {
  const el = document.createElement(tag)
  const { class: cls, ...rest } = props
  if (cls) el.className = cls
  Object.assign(el, rest)
  for (const c of children) if (c) el.append(c)
  return el
}

function serverRow(s: Server) {
  const isLast = last?.id === s.id
  const detail = [s.host ? `${s.host}:${s.port}` : `${s.address}:${s.port}`, s.version && `version ${s.version}`].filter(Boolean).join(', ')
  return h(
    'li',
    {},
    h(
      'button',
      { class: 'server', type: 'button', onclick: () => open(s), disabled: state.busy },
      h('span', { class: 'server-text' }, h('span', { class: 'server-name', textContent: s.name }), h('span', { class: 'server-detail', textContent: detail })),
      isLast ? h('span', { class: 'server-mark', textContent: 'Last used' }) : null,
      h('span', { class: 'chevron', textContent: '›', ariaHidden: 'true' }),
    ),
  )
}

// The page is built once; only its parts that change are redrawn (the list,
// the notice, the error, the button), so typing an address is never interrupted
const ui = {
  notice: h('div'),
  found: h('div'),
  error: h('div'),
  submit: h('button', { type: 'submit', class: 'primary', textContent: 'Open' }),
  input: h('input', {
    type: 'text',
    inputMode: 'url',
    autocomplete: 'off',
    autocapitalize: 'off',
    spellcheck: false,
    placeholder: 'playpex.local or 192.168.1.20',
    ariaLabel: 'Server address',
  }),
  built: false,
}

function build() {
  const form = h(
    'form',
    {
      class: 'address',
      onsubmit: async (e: Event) => {
        e.preventDefault()
        const text = ui.input.value.trim()
        if (!text || state.busy) return
        state.error = null
        state.busy = true
        render()
        try {
          toUrl(text)
          open(await probe(text))
        } catch (err) {
          state.busy = false
          state.error = `No Playpex server answered at ${text}.${err instanceof Error && err.message && err.message !== text ? ` ${err.message}` : ''}`
          render()
        }
      },
    },
    ui.input,
    ui.submit,
  )
  app.replaceChildren(
    h('header', { class: 'brand' }, h('img', { src: './logo.svg', alt: '' }), h('span', { textContent: 'Playpex' })),
    h('h1', { textContent: 'Choose a server' }),
    h('p', { class: 'lead', textContent: 'Servers on your Wi-Fi show up here by themselves. Pick one to manage it.' }),
    ui.notice,
    h('section', { class: 'block' }, h('h2', { textContent: 'On this network' }), ui.found),
    h('section', { class: 'block' }, h('h2', { textContent: 'Enter an address' }), form, ui.error),
  )
  ui.built = true
}

const RETRY_MS = 5000
let retryTimer: ReturnType<typeof setTimeout> | undefined

function wifiButton() {
  return canOpenWifiSettings ? h('button', { type: 'button', class: 'primary', textContent: 'Wi-Fi settings', onclick: () => void wifiSettings() }) : null
}

function hostOf(url: string) {
  try {
    return new URL(url).host
  } catch {
    return url
  }
}

/** The server a dashboard URL belongs to, by its name when it's the last one opened */
function serverName(url: string) {
  try {
    const origin = new URL(url).origin
    if (last && new URL(last.url).origin === origin) return last.name
  } catch {
    // not a URL: its text
  }
  return hostOf(url)
}

/** A whole-page screen: no network, or a dashboard that can't be reached */
function screen(title: string, text: string, waiting: string | null, ...actions: (HTMLElement | null)[]) {
  ui.built = false
  app.replaceChildren(
    h('header', { class: 'brand' }, h('img', { src: './logo.svg', alt: '' }), h('span', { textContent: 'Playpex' })),
    h(
      'section',
      { class: 'screen', role: 'alert' },
      h('span', { class: 'screen-mark', ariaHidden: 'true' }),
      h('h1', { textContent: title }),
      h('p', { class: 'lead', textContent: text }),
      h('div', { class: 'actions' }, ...actions),
      waiting ? h('p', { class: 'searching waiting' }, h('span', { class: 'pulse', ariaHidden: 'true' }), waiting) : null,
    ),
  )
}

function renderOffline(url: string) {
  const name = serverName(url)
  const again = h('button', { type: 'button', class: 'secondary', textContent: state.retrying ? 'Trying…' : 'Try again', disabled: state.retrying, onclick: () => void retry() })
  const other = h('button', { type: 'button', class: 'text', textContent: 'Choose another server', onclick: () => showPicker() })
  if (!state.net.connected) {
    screen('No connection', `This phone isn’t connected to any network. Turn on Wi-Fi to reach ${name}.`, 'Waiting for a network…', wifiButton(), again, other)
  } else if (!state.net.local) {
    screen(
      'Not on Wi-Fi',
      `${name} is on your home network, and this phone is on mobile data. Connect it to the same Wi-Fi as the server.`,
      'Trying again by itself…',
      wifiButton(),
      again,
      other,
    )
  } else {
    screen(
      `Can’t reach ${name}`,
      `It isn’t answering at ${hostOf(url)}. Check that the server is running, and that this phone is on the same Wi-Fi as it.`,
      'Trying again by itself…',
      again,
      other,
    )
  }
}

function render() {
  if (state.offline) return renderOffline(state.offline)
  if (!state.net.connected) {
    return screen('No connection', 'This phone isn’t connected to any network. Turn on Wi-Fi to find your Playpex servers.', 'Waiting for a network…', wifiButton())
  }
  if (!ui.built) build()
  const list = [...state.servers.values()].sort((a, b) => Number(b.id === last?.id) - Number(a.id === last?.id) || a.name.localeCompare(b.name))
  const waited = Date.now() - state.searchingSince > 8000

  ui.notice.replaceChildren(state.notice ? h('p', { class: 'notice', textContent: state.notice }) : '')
  ui.found.replaceChildren(
    !state.net.local && canDiscover
      ? h(
          'div',
          { class: 'empty' },
          h('p', { class: 'empty-title', textContent: 'Not on Wi-Fi' }),
          h('p', {
            class: 'hint',
            textContent: 'This phone is on mobile data, so servers can’t be found by themselves. Connect it to the server’s Wi-Fi, or enter an address below if you reach the server another way (a VPN).',
          }),
          canOpenWifiSettings ? h('div', { class: 'actions' }, wifiButton()) : null,
        )
      : '',
    list.length
      ? h('ul', { class: 'servers' }, ...list.map(serverRow))
      : !state.net.local && canDiscover
        ? ''
        : h(
          'div',
          { class: 'empty' },
          canDiscover
            ? h('p', { class: 'searching' }, h('span', { class: 'pulse', ariaHidden: 'true' }), 'Looking for Playpex servers…')
            : h('p', { textContent: 'Finding servers works in the Android app. Here, enter an address below.' }),
          canDiscover && waited
            ? h('p', {
                class: 'hint',
                textContent:
                  'None found yet. Check that the server is running and this phone is on the same Wi-Fi. Some networks block finding devices: enter the server’s address instead, as the dashboard shows it (Overview › Addresses).',
              })
            : null,
        ),
  )
  ui.error.replaceChildren(state.error ? h('p', { class: 'error', role: 'alert', textContent: state.error }) : '')
  ui.submit.textContent = state.busy ? 'Opening…' : 'Open'
  ui.submit.disabled = state.busy
}

/** The "can't reach" screen's server: back to its page once it answers */
async function retry() {
  const url = state.offline
  if (!url || state.retrying) return
  clearTimeout(retryTimer)
  state.retrying = true
  render()
  try {
    await probe(new URL(url).origin)
    location.replace(url)
    return
  } catch {
    // still unreachable
  }
  state.retrying = false
  if (state.offline === url) {
    render()
    if (state.net.connected) retryTimer = setTimeout(() => void retry(), RETRY_MS)
  }
}

let stopDiscovery: (() => void) | null = null

async function discover() {
  stopDiscovery?.()
  stopDiscovery = await startDiscovery((s) => {
    state.servers.set(s.id, s)
    render()
  })
  state.searchingSince = Date.now()
  // the "none found" hint appears after a while
  setTimeout(render, 8500)
}

/** From the "can't reach" screen: the list of servers */
function showPicker() {
  clearTimeout(retryTimer)
  state.offline = null
  state.retrying = false
  history.replaceState(null, '', '#pick')
  render()
  void discover()
}

/** The last server, straight away when it answers (at launch, once there is a network) */
async function openLast() {
  if (!last) return
  state.autoOpen = false
  app.replaceChildren(h('p', { class: 'opening', textContent: `Opening ${last.name}…` }))
  ui.built = false
  try {
    const s = await Promise.race([probe(last.url), new Promise<never>((_, no) => setTimeout(() => no(new Error('timeout')), 3000))])
    if (!canDiscover || s.id === last.id) return open(s)
  } catch {
    state.notice = `${last.name} didn’t answer at ${last.url.replace(/^https?:\/\//, '')}. It shows up below once it’s found.`
  }
  render()
}

async function main() {
  state.net = await network()
  onNetwork((n) => {
    const backOnWifi = n.local && !state.net.local
    state.net = n
    if (state.offline) {
      render()
      if (n.connected) void retry()
      return
    }
    if (state.busy) return
    if (n.connected && state.autoOpen) return void openLast()
    render()
    // the sockets were on the old network: browse again on the new one
    if (backOnWifi) void discover()
  })

  const offline = location.hash.match(/^#offline(?:=(.*))?$/)
  if (offline) {
    state.offline = offline[1] ? decodeURIComponent(offline[1]) : last?.url ?? null
    if (state.offline) {
      render()
      retryTimer = setTimeout(() => void retry(), RETRY_MS)
      return
    }
    history.replaceState(null, '', '#pick')
  }

  const picking = location.hash === '#pick'
  // the last server, straight away when it answers: once per app session, so Back from its
  // dashboard lands here (and a second Back leaves the app) instead of opening it again
  let first = true
  try {
    first = !sessionStorage.getItem(AUTO_KEY)
    sessionStorage.setItem(AUTO_KEY, '1')
  } catch {
    // no storage: open it every time, as before
  }
  if (last && !picking && first) {
    // without a network: "No connection" first, then the server once one comes
    state.autoOpen = true
    if (state.net.connected) {
      await openLast()
      if (state.busy) return
    } else {
      render()
    }
  } else {
    render()
  }
  await discover()
}

void main()
