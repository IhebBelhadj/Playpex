// The site bar, drawn by script into #live: menus open on click, close on Escape or outside; the sheet on phones.
import { IMG } from '../lib/images';

export var os = system();

(function () {
  var I = {
    chev: '<svg class="chev" viewBox="0 0 10 10" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M2 3.8 5 6.6l3-2.8"/></svg>',
    logo: '<svg viewBox="6.5 6.7 20.8 18.6" aria-hidden="true"><defs><linearGradient id="LG" x1="7" y1="16" x2="26.8" y2="16" gradientUnits="userSpaceOnUse"><stop offset="0" stop-color="#E3CC97"/><stop offset=".72" stop-color="#F6E084"/><stop offset=".94" stop-color="#D1B372"/></linearGradient></defs><polygon fill="url(#LG)" points="9.24,11.1 21.58,17.23 14.34,24.17 26.79,16.99 7,7.21 7,11.5 7,24.79"/></svg>',
    gh: '<svg viewBox="0 0 16 16" fill="currentColor" aria-hidden="true"><path d="M8 0C3.58 0 0 3.58 0 8a8 8 0 0 0 5.47 7.59c.4.07.55-.17.55-.38v-1.33c-2.23.48-2.7-1.07-2.7-1.07-.36-.92-.89-1.17-.89-1.17-.73-.5.06-.49.06-.49.8.06 1.23.83 1.23.83.72 1.23 1.88.87 2.34.67.07-.52.28-.87.5-1.07-1.78-.2-3.65-.89-3.65-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82a7.6 7.6 0 0 1 4 0c1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48v2.2c0 .21.15.46.55.38A8 8 0 0 0 16 8c0-4.42-3.58-8-8-8z"/></svg>',
    dl: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M8 2v8m0 0 3.2-3.2M8 10 4.8 6.8M3 13.5h10"/></svg>',
    burger: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" aria-hidden="true"><path d="M4 8h16M4 16h16"/></svg>',
    close: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" aria-hidden="true"><path d="M6 6l12 12M18 6 6 18"/></svg>',
    server: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" aria-hidden="true"><rect x="4" y="3.5" width="16" height="7" rx="2"/><rect x="4" y="13.5" width="16" height="7" rx="2"/><path d="M8 7h.01M8 17h.01"/></svg>',
    tv: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" aria-hidden="true"><rect x="2.5" y="4.5" width="19" height="12.5" rx="2"/><path d="M8 20.5h8"/></svg>',
    phone: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" aria-hidden="true"><rect x="6.5" y="2.5" width="11" height="19" rx="2.5"/><path d="M11 18.5h2"/></svg>',
    manager: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="6.5" y="2.5" width="11" height="19" rx="2.5"/><path d="M9.5 12.5 11 14l3.5-3.5"/></svg>'
  };
  var VERSION = '0.10.1-alpha.1';

  function system() {
    var ua = navigator.userAgent || '';
    if (/Android/i.test(ua)) return 'Android';
    if (/Windows/i.test(ua)) return 'Windows';
    if (/Mac OS X|Macintosh/i.test(ua) && !/iPhone|iPad/i.test(ua)) return 'macOS';
    if (/Linux|X11/i.test(ua)) return 'Linux';
    return null;
  }

  var TV_SHOT = IMG.s_continue;
  var PRODUCTS = [
    ['server', 'Media Server', 'Keeps your films, shows and channels on a computer at home and streams them to every screen in the house. You run it from its dashboard in a browser.', 'Windows, macOS, Linux', null, 'web'],
    ['tv', 'Playpex TV', 'The big-screen app for a computer plugged into your TV. Made for a remote: arrows, OK and Back move everything.', 'Windows, macOS, Linux', TV_SHOT, 'tv'],
    ['phone', 'Playpex for Android', 'Your library on your phone and tablet. Plays files as they are, with every audio track and subtitle.', 'Android', null, 'phone'],
    ['manager', 'Server Manager', 'Finds your server on the Wi-Fi and opens its dashboard on your phone, with the remote control for your TV.', 'Android', null, 'phone']
  ];
  function preview(i) {
    var p = PRODUCTS[i], kind = p[5];
    var screen = p[4] ? '<img src="' + p[4] + '" alt="' + p[1] + ', the Movies page">' : '<div class="empty">Screenshot to come</div>';
    var dev = kind === 'web'
      ? '<div class="dev web"><div class="chrome"><i></i><i></i><i></i><span>playpex.local:28470</span></div>' + screen + '</div>'
      : '<div class="dev ' + kind + '">' + screen + '</div>' + (kind === 'tv' ? '<div class="stand"></div>' : '');
    var amb = p[4] ? '<div class="amb" style="background-image:url(' + p[4] + ')"></div>' : '<div class="amb none"></div>';
    return amb + '<div class="inner"><div class="stage">' + dev + '</div>' +
      '<div class="ptext"><h5>' + p[1] + '</h5><p>' + p[2] + '</p><div class="sys"><span>' + p[3] + '</span><a href="#' + p[0] + '">About ' + p[1] + '</a></div></div></div>';
  }
  var DOCS = [
    { g: 'Use Playpex', t: 'Get started', d: 'Install the server and set it up', meta: 'About 10 minutes',
      body: '<ol class="dsteps"><li>Install the Media Server on the computer that keeps your films</li><li>Open its dashboard and choose an admin password</li><li>Add your film and series folders</li><li>Pair your TV and phones</li></ol>' },
    { g: 'Use Playpex', t: 'Pair a screen', d: 'Connect a TV or phone to your server', meta: 'Once per screen',
      body: '<div class="dcode"><span>Playpex TV shows</span><b>QXRK-M4TD</b></div><p>Approve the code on the dashboard\'s Devices page or from the server\'s tray icon. The screen stays paired after that.</p>' },
    { g: 'Use Playpex', t: 'Add your library', d: 'Folders, network shares, matching titles', meta: 'Folders and network shares',
      body: '<pre class="dtree">Films/\n  Metropolis (1927)/\n    Metropolis (1927).mkv\nSeries/\n  Sherlock/Season 1/\n    Sherlock S01E01.mkv</pre><p>Named like this, every title gets its poster, seasons and details.</p>' },
    { g: 'Use Playpex', t: 'Live TV and channels', d: 'Your channel list and its guide', meta: '' },
    { g: 'Use Playpex', t: 'Troubleshooting', d: 'Windows warnings, firewall, sound', meta: 'Common problems',
      body: '<ul class="dqs"><li>Windows says it protected your PC</li><li>The TV can\'t find the server</li><li>A video plays without sound</li><li>Subtitles are out of sync</li></ul>' },
    { g: 'Build on Playpex', t: 'Client API', d: 'Build an app for Playpex', meta: 'For app developers',
      body: '<pre class="dcode-block"><span class="m">GET</span> /api/v1/library/home\nAuthorization: Bearer &lt;device token&gt;</pre><p>Find a server, pair with it, browse and play: everything an app for Playpex needs.</p>' },
    { g: 'Build on Playpex', t: 'Plugin guide', d: 'Write and publish a plugin', meta: 'For plugin authors',
      body: '<pre class="dcode-block">{\n  "id": "hello",\n  "name": "Hello",\n  "contributes": { "screens": [ … ] }\n}</pre><p>Write a plugin, pack it as a .ppx and publish it from your own repository.</p>' },
    { g: 'Build on Playpex', t: 'API reference', d: 'Every endpoint, from the OpenAPI spec', meta: 'Generated from the OpenAPI spec',
      body: '<ul class="deps"><li><span class="m">GET</span>/catalog/titles/{type}/{id}</li><li><span class="m">POST</span>/play/sources</li><li><span class="m">GET</span>/media/{ref}</li><li><span class="m">WS</span>/events</li></ul><p>Every endpoint, parameter and type.</p>' }
  ];

  function nav(o, id) {
    var cur = function (k) { return o.current === k ? ' aria-current="page"' : ''; };
    var exp = function (k) { return ' aria-expanded="' + (o.open === k) + '" aria-controls="' + id + '-' + k + '"'; };
    var products = '<div class="menu products" data-kind="products" id="' + id + '-products"' + (o.open === 'products' ? '' : ' hidden') + '>' +
      '<div class="plist">' + PRODUCTS.map(function (p, i) { return '<a class="pitem' + (i === (o.sel || 0) ? ' sel' : '') + '" data-i="' + i + '" href="#' + p[0] + '">' + p[1] + '</a>'; }).join('') +
      '<a class="all" href="#download">All downloads</a></div>' +
      '<div class="pview">' + preview(o.sel || 0) + '</div></div>';
    var dlist = function (g, skip) {
      return '<div><h4>' + g + '</h4>' + DOCS.filter(function (d) { return d.g === g && d.t !== skip; }).map(function (d) { return '<a class="ditem" href="#docs">' + d.t + '</a>'; }).join('') + '</div>';
    };
    var docs = '<div class="menu docs" id="' + id + '-docs"' + (o.open === 'docs' ? '' : ' hidden') + '>' +
      '<a class="start" href="#docs"><span><b>New to Playpex?</b><span>Install the server and watch on your TV in about 10 minutes.</span></span><em>Get started</em></a>' +
      '<div class="dcols">' + dlist('Use Playpex', 'Get started') + dlist('Build on Playpex') + '</div></div>';
    var chevUp = '<svg class="schev" viewBox="0 0 10 10" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M2 3.8 5 6.6l3-2.8"/></svg>';
    var popen = o.sproducts !== false;
    var sheet = '<div class="sheet" id="' + id + '-sheet"' + (o.sheet ? '' : ' hidden') + '>' +
      '<nav class="snav">' +
        '<button type="button" class="sbig sprod" aria-expanded="' + popen + '" aria-controls="' + id + '-sp">Products' + chevUp + '</button>' +
        '<div class="ssub" id="' + id + '-sp"' + (popen ? '' : ' hidden') + '>' + PRODUCTS.map(function (p) { return '<a href="#' + p[0] + '">' + p[1] + '<small>' + p[3] + '</small></a>'; }).join('') + '</div>' +
        '<a class="sbig" href="#plugins"' + cur('plugins') + '>Plugins</a>' +
        '<a class="sbig" href="#docs"' + cur('docs') + '>Docs</a>' +
        '<a class="sbig" href="#releases"' + cur('releases') + '>Releases</a>' +
        '<a class="sbig" href="https://github.com/IhebBelhadj/Playpex">GitHub</a>' +
      '</nav>' +
      '<div class="sfoot"><a class="wide" href="#download">' + I.dl + (os ? 'Download for ' + os : 'Download') + '</a>' +
      '<p class="fine">Version ' + VERSION + ', released 1 November 2026</p></div></div>';
    return '<nav class="site-nav' + (o.scrolled ? ' scrolled' : '') + '" aria-label="Main">' +
      '<div class="bar">' +
        '<a class="logo" href="#home">' + I.logo + 'Playpex</a>' +
        '<ul class="links">' +
          '<li><button class="link" type="button" data-menu="products"' + exp('products') + '>Products' + I.chev + '</button>' + products + '</li>' +
          '<li><a class="link" href="#plugins"' + cur('plugins') + '>Plugins</a></li>' +
          '<li><button class="link" type="button" data-menu="docs"' + exp('docs') + (o.current === 'docs' ? ' aria-current="page"' : '') + '>Docs' + I.chev + '</button>' + docs + '</li>' +
          '<li><a class="link" href="#releases"' + cur('releases') + '>Releases <span class="ver">' + VERSION + '</span></a></li>' +
        '</ul>' +
        '<div class="end">' +
          '<a class="gh" href="https://github.com/IhebBelhadj/Playpex">' + I.gh + 'GitHub</a>' +
          '<a class="dl" href="#download">' + I.dl + '<span class="long">' + (os ? 'Download for ' + os : 'Download') + '</span><span class="short">Download</span></a>' +
          '<button class="burger" type="button" aria-label="' + (o.sheet ? 'Close menu' : 'Open menu') + '" aria-expanded="' + !!o.sheet + '" aria-controls="' + id + '-sheet">' + (o.sheet ? I.close : I.burger) + '</button>' +
        '</div>' +
      '</div>' + sheet + '</nav>';
  }

  // the live bar: menus open on click, close on Escape or outside; the sheet on phones
  var live = document.getElementById('live');
  var state = { current: '', open: null, sheet: false, scrolled: false };
  function render() {
    live.innerHTML = nav(state, 'live');
  }
  render();
  live.addEventListener('click', function (e) {
    var m = e.target.closest('[data-menu]');
    if (m) { state.open = state.open === m.dataset.menu ? null : m.dataset.menu; render(); live.querySelector('[data-menu="' + m.dataset.menu + '"]').focus(); return; }
    if (e.target.closest('.burger')) { state.sheet = !state.sheet; render(); live.querySelector('.burger').focus(); return; }
    if (e.target.closest('.sprod')) { state.sproducts = state.sproducts === false; render(); live.querySelector('.sprod').focus(); return; }
    if (e.target.closest('a')) { e.preventDefault(); state.open = null; state.sheet = false; render(); }
  });
  // pointing at (or tabbing to) a product shows it on the right
  function pick(e) {
    var it = e.target.closest && e.target.closest('.pitem');
    if (!it || it.classList.contains('sel')) return;
    var menu = it.closest('.menu');
    menu.querySelectorAll('.pitem').forEach(function (x) { x.classList.toggle('sel', x === it); });
    menu.querySelector('.pview').innerHTML = preview(+it.dataset.i);
  }
  live.addEventListener('mouseover', pick);
  live.addEventListener('focusin', pick);
  document.addEventListener('click', function (e) { if (state.open && !live.contains(e.target)) { state.open = null; render(); } });
  document.addEventListener('keydown', function (e) {
    if (e.key === 'Escape' && (state.open || state.sheet)) { var k = state.open; state.open = null; state.sheet = false; render(); var b = k ? live.querySelector('[data-menu="' + k + '"]') : live.querySelector('.burger'); if (b) b.focus(); }
  });
  window.addEventListener('scroll', function () {
    var s = window.scrollY > 8;
    if (s !== state.scrolled) { state.scrolled = s; live.firstChild.classList.toggle('scrolled', s); }
  }, { passive: true });
})();

function system() {
  var ua = navigator.userAgent || '';
  if (/Android/i.test(ua)) return 'Android';
  if (/Windows/i.test(ua)) return 'Windows';
  if (/Mac OS X|Macintosh/i.test(ua) && !/iPhone|iPad/i.test(ua)) return 'macOS';
  if (/Linux|X11/i.test(ua)) return 'Linux';
  return null;
}
