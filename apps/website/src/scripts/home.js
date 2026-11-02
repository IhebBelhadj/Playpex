// The home page: the held intro (poster wall → folder → library → the four apps), the screens scene, the remote,
// the rooms, Who's watching, the download dialog. One gold ordered-dither (Bayer) shader is the motif.
import { IMG } from '../lib/images';
import { os } from './nav.js';
import './stage.js';

(function () {
  // ── home page ─────────────────────────────────────────
  var WALL = IMG.wall;
  document.documentElement.classList.add('v-a', 'v-w');
  // phones get their own composition; while the three are compared, #m-a / #m-b / #m-c picks one
  var PHONE = window.matchMedia('(max-width: 767px)').matches;
  var M = PHONE ? ((location.hash.match(/^#m-([abc])$/) || [])[1] || window.PLAYPEX_PHONE || 'c') : null;
  if (M) document.documentElement.classList.add('m-' + M);
  // the phone's hybrid (version C): the intro is the only long scroll scene; the four apps switch by hand, the
  // screens stack as cards, only "And it plays" snaps, the rooms are a carousel
  var HY = M === 'c';
  window.addEventListener('hashchange', function () { if (/^#m-[abc]$/.test(location.hash)) location.reload(); });
  var still = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  var dpr = Math.min(window.devicePixelRatio || 1, 2);
  var DLI = '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M8 2v8m0 0 3.2-3.2M8 10 4.8 6.8M3 13.5h10"/></svg>';
  document.querySelectorAll('[data-dl]').forEach(function (el) { el.innerHTML = DLI + (os && os !== 'Android' ? 'Download for ' + os : 'Download Playpex'); });
  document.querySelectorAll('img[data-img]').forEach(function (el) { el.src = IMG[el.dataset.img]; el.decoding = 'async'; });
  var rio = new IntersectionObserver(function (es) { es.forEach(function (e) { if (e.isIntersecting) { e.target.classList.add('in'); rio.unobserve(e.target); } }); }, { rootMargin: '0px 0px -8% 0px' });
  document.querySelectorAll('.rv').forEach(function (el) { rio.observe(el); });
  window.addEventListener('scroll', function () { var n = document.querySelector('.site-nav'); if (n) n.classList.toggle('scrolled', window.scrollY > 8); }, { passive: true });

  // ── the dot: Bayer dither, dot-matrix letters, dithered posters ──
  var BAYER = [0, 8, 2, 10, 12, 4, 14, 6, 3, 11, 1, 9, 15, 7, 13, 5];
  var GLYPHS = { 'P': '####.#...##...#####.#....#....#....', 'L': '#....#....#....#....#....#....#####', 'A': '.###.#...##...#######...##...##...#',
    'Y': '#...##...#.#.#...#....#....#....#..', 'E': '######....#....####.#....#....#####', 'X': '#...##...#.#.#...#...#.#.#...##...#' };
  function led(text, cls) {
    var cols = text.length * 6 - 1, out = '';
    for (var i = 0; i < text.length; i++) { var g = GLYPHS[text[i]] || ''; for (var k = 0; k < 35; k++) out += '<circle class="' + (g[k] === '#' ? 'l' : 'u') + '" cx="' + (i * 6 + k % 5 + .5) + '" cy="' + (Math.floor(k / 5) + .5) + '" r=".4"/>'; }
    return '<svg class="' + cls + '" viewBox="0 0 ' + cols + ' 7" aria-hidden="true">' + out + '</svg>';
  }
  document.getElementById('mark').innerHTML = led('PLAYPEX', 'mark');
  function dots(img, canvas, cell) {
    var w = canvas.clientWidth || 160, h = canvas.clientHeight || 240;
    canvas.width = Math.round(w * dpr); canvas.height = Math.round(h * dpr);
    var c = Math.max(3, Math.round(cell * dpr)), cw = Math.ceil(canvas.width / c), ch = Math.ceil(canvas.height / c);
    var s = document.createElement('canvas'); s.width = cw; s.height = ch;
    var sg = s.getContext('2d'); sg.drawImage(img, 0, 0, cw, ch);
    var px = sg.getImageData(0, 0, cw, ch).data, g = canvas.getContext('2d');
    g.fillStyle = '#141414'; g.fillRect(0, 0, canvas.width, canvas.height);
    for (var y = 0; y < ch; y++) for (var x = 0; x < cw; x++) {
      var i = (y * cw + x) * 4, l = Math.pow((px[i] * .299 + px[i + 1] * .587 + px[i + 2] * .114) / 255, .8) * 1.15;
      g.fillStyle = l > (BAYER[(y % 4) * 4 + x % 4] + .5) / 16 ? '#edcc75' : '#2b2a27';
      g.beginPath(); g.arc(x * c + c / 2, y * c + c / 2, c * .4, 0, 6.2832); g.fill();
    }
  }

  // ── WebGL helpers ──
  var BAYER_GLSL = 'float b2(vec2 a){a=floor(a);return fract(dot(a,vec2(.5,a.y*.75)));}float bayer(vec2 a){return b2(.25*a)*.0625+b2(.5*a)*.25+b2(a);}';
  var VERT = 'attribute vec2 p; void main(){gl_Position=vec4(p,0.,1.);}';
  function glProgram(canvas, frag) {
    var gl = canvas.getContext('webgl', { antialias: false, alpha: false, preserveDrawingBuffer: false });
    if (!gl) return null;
    function sh(t, src) { var s = gl.createShader(t); gl.shaderSource(s, src); gl.compileShader(s); if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) console.error(gl.getShaderInfoLog(s)); return s; }
    var pr = gl.createProgram(); gl.attachShader(pr, sh(gl.VERTEX_SHADER, VERT)); gl.attachShader(pr, sh(gl.FRAGMENT_SHADER, frag)); gl.linkProgram(pr); gl.useProgram(pr);
    gl.bindBuffer(gl.ARRAY_BUFFER, gl.createBuffer()); gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);
    var loc = gl.getAttribLocation(pr, 'p'); gl.enableVertexAttribArray(loc); gl.vertexAttribPointer(loc, 2, gl.FLOAT, false, 0, 0);
    return { gl: gl, u: function (n) { return gl.getUniformLocation(pr, n); },
      tex: function (src) {
        var t = gl.createTexture(); gl.bindTexture(gl.TEXTURE_2D, t); gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, true);
        gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGB, gl.RGB, gl.UNSIGNED_BYTE, src);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
        return t;
      },
      size: function (w, h) { w = Math.round(w * dpr); h = Math.round(h * dpr); if (w && h && (canvas.width !== w || canvas.height !== h)) { canvas.width = w; canvas.height = h; gl.viewport(0, 0, w, h); } }
    };
  }

  function lerp(a, b, k) { return a + (b - a) * k; }
  // piecewise linear through [x, y] points (x rising)
  function pl(x, pts) { if (x <= pts[0][0]) return pts[0][1]; for (var i = 1; i < pts.length; i++) if (x <= pts[i][0]) { var a = pts[i - 1], b = pts[i]; return a[1] + (b[1] - a[1]) * (x - a[0]) / (b[0] - a[0]); } return pts[pts.length - 1][1]; }
  function clamp01(x) { return Math.max(0, Math.min(1, x)); }
  function ramp(p, a, b) { var k = clamp01((p - a) / (b - a)); return k * k * (3 - 2 * k); }
  var LIB = IMG.s_dashlib;
  // One shader for every version: the poster wall in gold dither everywhere; inside a rounded window,
  // a picture q (0 = the wall, 1 = the folder, 2 = the library) dissolving through gold dots between whole ones.
  var FRAG = [
    'precision highp float;',
    'uniform vec2 r; uniform float t; uniform sampler2D wall; uniform sampler2D a; uniform sampler2D b; uniform vec2 tw; uniform vec2 ta; uniform vec2 tb;',
    'uniform float aw; uniform float pp; uniform vec4 win; uniform float rad; uniform float outVis; uniform float fade; uniform float px; uniform float rise; uniform float dim; uniform float shade; uniform float shadeV; uniform float pan;',
    'float b2(vec2 v){v=floor(v);return fract(dot(v,vec2(.5,v.y*.75)));} float bayer(vec2 v){return b2(.25*v)*.0625+b2(.5*v)*.25+b2(v);}',
    'vec3 wallCol(vec2 fc){ float w=3.*px; vec2 cell=floor(fc/w)*w+w*.5;',
    ' float lanes=3.4; float ly=cell.y/r.y*lanes+.15; float lane=floor(ly); float fy=fract(ly); float gap=smoothstep(0.,.03,fy)*smoothstep(1.,.97,fy);',
    ' float laneW=(r.y/lanes)*tw.x/(tw.y*.5); float dir=mod(lane,2.)<.5?1.:-1.; float x=(cell.x+dir*t*28.+lane*517.)/laneW; float hf=mod(lane,2.)<.5?.5:0.;',
    ' float l=dot(texture2D(wall,vec2(fract(x),hf+fy*.5)).rgb,vec3(.299,.587,.114)); l=pow(clamp(l,0.,1.),.85)*1.14;',
    ' l*=mix(1.,smoothstep(0.,.42*r.y,fc.y),fade);',
    ' float on=step(bayer(fc/w)+.5/64.,l)*gap; return mix(vec3(.078),vec3(.93,.8,.46),on); }',
    'vec2 cover(vec2 uv, vec2 box, vec2 ts){ float s=max(box.x/ts.x,box.y/ts.y); vec2 size=ts*s; return vec2((uv.x*box.x-(box.x-size.x)*pan)/size.x, 1.-(uv.y*box.y)/size.y); }',
    'void main(){ vec2 fc=gl_FragCoord.xy; vec2 pt=vec2(fc.x,r.y-fc.y); vec3 w=wallCol(fc);',
    ' vec2 c=win.xy+win.zw*.5; vec2 d=abs(pt-c)-win.zw*.5+rad; float sd=length(max(d,0.))+min(max(d.x,d.y),0.)-rad;',
    ' vec2 lp=pt-win.xy; vec2 uv=lp/max(win.zw,vec2(1.));',
    ' float p=pp; vec3 A=aw>.5?w:texture2D(a,cover(uv,win.zw,ta)).rgb; vec3 B=texture2D(b,cover(uv,win.zw,tb)).rgb;',
    ' float g=7.*px; vec2 ci=floor(lp/g); vec2 cc=(ci+.5)*g/max(win.zw,vec2(1.));',
    ' float k=step(bayer(ci)+.001,p); vec3 col=mix(A,B,k);',
    ' vec3 As=aw>.5?w:texture2D(a,cover(cc,win.zw,ta)).rgb; vec3 Bs=texture2D(b,cover(cc,win.zw,tb)).rgb;',
    ' float l=pow(dot(mix(As,Bs,k),vec3(.299,.587,.114)),.8)*1.25; float on=step(bayer(ci+vec2(2.,1.))+.5/64.,l);',
    ' float dd=length(fract(lp/g)-.5); vec3 dotted=mix(vec3(.078),mix(vec3(.17,.16,.14),vec3(.93,.8,.46),on),smoothstep(.52,.36,dd));',
    ' col=mix(col,dotted,smoothstep(.04,.55,sin(3.14159*p)));',
    ' vec3 outside=mix(vec3(.078),mix(vec3(.078),w,dim),outVis);',
    ' float sf=shadeV>.5?smoothstep(.78,.36,pt.y/r.y):smoothstep(.6,.28,pt.x/r.x); outside=mix(outside,vec3(.078),shade*sf*.92);',
    ' float hg=11.*px; float band=.55*r.y; float F=rise*(r.y+band); float cv=clamp((F-fc.y)/band,0.,1.);',
    ' vec2 hc=fract(fc/hg)-.5; float hr=cv*.78; float hd=smoothstep(hr+.04,hr-.04,length(hc)); outside=mix(outside,vec3(.93,.8,.46),cv>.999?1.:hd*step(.001,cv));',
    ' gl_FragColor=vec4(mix(col,outside,smoothstep(-1.,1.,sd)),1.); }'
  ].join('\n');
  function Painter(canvas) {
    var gl = canvas.getContext('webgl', { antialias: false, alpha: false });
    if (!gl) return null;
    function sh(tp, src) { var s = gl.createShader(tp); gl.shaderSource(s, src); gl.compileShader(s); if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) console.error(gl.getShaderInfoLog(s)); return s; }
    var pr = gl.createProgram(); gl.attachShader(pr, sh(gl.VERTEX_SHADER, 'attribute vec2 p;void main(){gl_Position=vec4(p,0.,1.);}')); gl.attachShader(pr, sh(gl.FRAGMENT_SHADER, FRAG)); gl.linkProgram(pr); gl.useProgram(pr);
    gl.bindBuffer(gl.ARRAY_BUFFER, gl.createBuffer()); gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);
    var loc = gl.getAttribLocation(pr, 'p'); gl.enableVertexAttribArray(loc); gl.vertexAttribPointer(loc, 2, gl.FLOAT, false, 0, 0);
    var U = {}; ['r', 't', 'wall', 'a', 'b', 'tw', 'ta', 'tb', 'aw', 'pp', 'win', 'rad', 'outVis', 'fade', 'px', 'rise', 'dim', 'shade', 'shadeV', 'pan'].forEach(function (n) { U[n] = gl.getUniformLocation(pr, n); });
    // pictures: q 0 = the wall, 1 = the folder, 2 = the library, 3 = Playpex TV, 4 = the phone app, 5 = Server Manager
    var SRC = [folderPicture(), LIB, IMG.s_tvlib, IMG.s_mtitle, IMG.s_man], T = [], S = [], wallT = null, wallS = null, left = SRC.length + 1;
    var self = { q: 0, win: [0, 0, 0, 0], rad: 0, outVis: 1, fade: 0, rise: 0, dim: 1, shade: 0, shadeV: 0, pan: .5, ready: false, onready: null };
    function tex(src) {
      var t = gl.createTexture(); gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, t); gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, true);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGB, gl.RGB, gl.UNSIGNED_BYTE, src);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      return t;
    }
    function done() { if (--left === 0) { self.ready = true; if (self.onready) self.onready(); } }
    SRC.forEach(function (src, i) {
      if (typeof src !== 'string') { T[i] = tex(src); S[i] = [src.width, src.height]; done(); return; }
      var im = new Image(); im.onload = function () { T[i] = tex(im); S[i] = [im.width, im.height]; done(); }; im.src = src;
    });
    var iw = new Image(); iw.onload = function () { wallT = tex(iw); wallS = [iw.width, iw.height]; done(); }; iw.src = WALL;
    var t0 = performance.now();
    function bind(unit, t) { gl.activeTexture(gl.TEXTURE0 + unit); gl.bindTexture(gl.TEXTURE_2D, t); }
    self.draw = function () {
      if (!self.ready) return;
      var W = Math.round(canvas.clientWidth * dpr), H = Math.round(canvas.clientHeight * dpr);
      if (canvas.width !== W || canvas.height !== H) { canvas.width = W; canvas.height = H; gl.viewport(0, 0, W, H); }
      var q = Math.max(0, Math.min(SRC.length, self.q)), ai, bi, aw = 0, pp;
      if (q < 1) { aw = 1; ai = 0; bi = 0; pp = q; } else { ai = Math.min(Math.floor(q) - 1, SRC.length - 2); bi = ai + 1; pp = q - 1 - ai; }
      bind(0, wallT); bind(1, T[ai]); bind(2, T[bi]);
      gl.uniform1i(U.wall, 0); gl.uniform1i(U.a, 1); gl.uniform1i(U.b, 2);
      gl.uniform2f(U.r, W, H); gl.uniform1f(U.t, still ? 20 : (performance.now() - t0) / 1000 + 20);
      gl.uniform2f(U.tw, wallS[0], wallS[1]); gl.uniform2f(U.ta, S[ai][0], S[ai][1]); gl.uniform2f(U.tb, S[bi][0], S[bi][1]);
      gl.uniform1f(U.aw, aw); gl.uniform1f(U.pp, pp); gl.uniform4f(U.win, self.win[0] * dpr, self.win[1] * dpr, self.win[2] * dpr, self.win[3] * dpr);
      gl.uniform1f(U.rad, self.rad * dpr); gl.uniform1f(U.outVis, self.outVis); gl.uniform1f(U.fade, self.fade); gl.uniform1f(U.px, dpr); gl.uniform1f(U.rise, self.rise); gl.uniform1f(U.dim, self.dim); gl.uniform1f(U.shade, self.shade); gl.uniform1f(U.shadeV, self.shadeV); gl.uniform1f(U.pan, self.pan);
      gl.drawArrays(gl.TRIANGLES, 0, 3);
    };
    // the wall drifts, so draw every frame while on screen
    var vis = true; new IntersectionObserver(function (es) { vis = es[0].isIntersecting; }).observe(canvas);
    (function loop() { if (vis && !document.hidden) self.draw(); requestAnimationFrame(loop); })();
    return self;
  }
  // Morph: a list of pictures; f between two whole numbers dissolves one into the next through gold dots
  // (ordered dither: each cell switches at its Bayer threshold; mid-way the picture is all dots).
  var MORPH_FRAG = [
    'precision highp float; uniform vec2 r; uniform float p; uniform float px; uniform float pan; uniform sampler2D a; uniform sampler2D b; uniform vec2 ta; uniform vec2 tb;', BAYER_GLSL,
    'vec2 cover(vec2 uv, vec2 ts){ float s=max(r.x/ts.x,r.y/ts.y); vec2 size=ts*s; vec2 off=vec2((r.x-size.x)*pan, r.y-size.y); return (uv*r-off)/size; }',
    'void main(){ vec2 fc=gl_FragCoord.xy; vec2 uv=fc/r; vec2 ci=floor(fc/px); vec2 cc=(ci+.5)*px/r;',
    ' float k=step(bayer(ci)+.001,p);',
    ' vec3 col=mix(texture2D(a,cover(uv,ta)).rgb,texture2D(b,cover(uv,tb)).rgb,k);',
    ' vec3 cs=mix(texture2D(a,cover(cc,ta)).rgb,texture2D(b,cover(cc,tb)).rgb,k);',
    ' float l=pow(dot(cs,vec3(.299,.587,.114)),.8)*1.25;',
    ' float on=step(bayer(ci+vec2(2.,1.))+.5/64.,l); float d=length(fract(fc/px)-.5); float dm=smoothstep(.52,.36,d);',
    ' vec3 dotted=mix(vec3(.078),mix(vec3(.17,.16,.14),vec3(.93,.8,.46),on),dm);',
    ' float s=sin(3.14159*p); gl_FragColor=vec4(mix(col,dotted,smoothstep(.04,.55,s)),1.); }'
  ].join('\n');
  function Morph(box, sources) {
    var canvas = box.querySelector('canvas.gl'), P = glProgram(canvas, MORPH_FRAG), self = { f: 0, pan: .5, ok: false, set: function () {} };
    if (!P) return self;
    var gl = P.gl, U = { r: P.u('r'), p: P.u('p'), px: P.u('px'), pan: P.u('pan'), a: P.u('a'), b: P.u('b'), ta: P.u('ta'), tb: P.u('tb') }, texs = [], sizes = [], n = 0;
    function load(src, i) {
      if (src instanceof HTMLCanvasElement) return done(src, i);
      var im = new Image(); im.onload = function () { done(im, i); }; im.src = src;
    }
    function done(src, i) { texs[i] = P.tex(src); sizes[i] = [src.width, src.height]; if (++n === sources.length) { self.ok = true; box.classList.add('has-gl'); draw(); } }
    sources.forEach(load);
    var bw = 0, bh = 0;
    function measure() { var w = box.offsetWidth, h = box.offsetHeight; var big = box.dataset.grow ? Math.max(window.innerWidth / w, window.innerHeight / h) : 1; bw = w * big; bh = h * big; }
    function draw() {
      if (!self.ok) return;
      if (!bw) measure();
      P.size(bw, bh);
      var f = Math.max(0, Math.min(sources.length - 1, self.f)), i = Math.min(sources.length - 2, Math.floor(f)), seg = f - i;
      var lo = M ? .08 : .18, p = seg < lo ? 0 : seg > 1 - lo ? 1 : (seg - lo) / (1 - 2 * lo);           // rests on whole pictures near each stop
      p = p * p * (3 - 2 * p);
      gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, texs[i]);
      gl.activeTexture(gl.TEXTURE1); gl.bindTexture(gl.TEXTURE_2D, texs[i + 1]);
      gl.uniform1i(U.a, 0); gl.uniform1i(U.b, 1); gl.uniform2f(U.ta, sizes[i][0], sizes[i][1]); gl.uniform2f(U.tb, sizes[i + 1][0], sizes[i + 1][1]);
      gl.uniform2f(U.r, canvas.width, canvas.height); gl.uniform1f(U.px, Math.round(7 * dpr * (bw / box.offsetWidth))); gl.uniform1f(U.p, p); gl.uniform1f(U.pan, self.pan);
      gl.drawArrays(gl.TRIANGLES, 0, 3);
    }
    self.set = function (f) { self.f = f; draw(); };
    window.addEventListener('resize', function () { bw = 0; draw(); });
    return self;
  }

  // the "before" picture: a folder of films in a file manager, drawn
  function folderPicture() {
    var c = document.createElement('canvas'); c.width = 1600; c.height = 900; var g = c.getContext('2d');
    var F = '"Jost", "Futura", sans-serif';
    g.fillStyle = '#17171a'; g.fillRect(0, 0, 1600, 900);
    g.fillStyle = '#0f0f11'; g.fillRect(0, 0, 300, 900);
    g.fillStyle = '#26262b'; g.fillRect(0, 0, 1600, 64);
    g.font = '500 24px ' + F; g.fillStyle = '#e4e4e7'; g.fillText('Films', 336, 42);
    g.fillStyle = '#a1a1aa'; g.font = '400 20px ' + F; g.fillText('/media/Films', 420, 42);
    var side = [['Home', 0], ['Desktop', 0], ['Downloads', 0], ['Films', 1], ['Series', 0], ['Music', 0], ['nas (network)', 0]];
    side.forEach(function (s, i) { var y = 120 + i * 54; if (s[1]) { g.fillStyle = '#2a2a30'; g.fillRect(16, y - 34, 268, 48); } g.fillStyle = s[1] ? '#ffffff' : '#a1a1aa'; g.font = '400 22px ' + F; g.fillText(s[0], 40, y); });
    g.fillStyle = '#71717a'; g.font = '500 18px ' + F; g.fillText('Name', 336, 112); g.fillText('Size', 1160, 112); g.fillText('Modified', 1330, 112);
    var files = [['A Trip to the Moon (1902).mkv', '612 MB', '3 Mar 2024'], ['Big Buck Bunny (2008).mkv', '1.1 GB', '9 Jan 2025'], ['Carnival of Souls (1962).mkv', '3.4 GB', '28 Oct 2023'],
      ['Charade (1963).mkv', '4.2 GB', '14 Feb 2024'], ['Coffee Run (2020).mp4', '210 MB', '2 Jul 2025'], ['Cosmos Laundromat (2015).mkv', '1.4 GB', '9 Jan 2025'], ['Detour (1945).avi', '1.2 GB', '11 Nov 2022'],
      ['Elephants Dream (2006).mkv', '890 MB', '9 Jan 2025'], ['His Girl Friday (1940).mkv', '3.9 GB', '5 May 2024'], ['Metropolis (1927).mkv', '6.8 GB', '19 Sep 2023'],
      ['Night of the Living Dead (1968).mkv', '3.1 GB', '31 Oct 2024'], ['Nosferatu (1922).mkv', '2.2 GB', '31 Oct 2024'], ['Sherlock Jr. (1924).mkv', '1.6 GB', '7 Aug 2024']];
    files.forEach(function (f, i) {
      var y = 168 + i * 54;
      if (i === 9) { g.fillStyle = '#27272d'; g.fillRect(320, y - 34, 1260, 50); }
      g.fillStyle = '#3f3f46'; g.fillRect(336, y - 24, 26, 32); g.fillStyle = '#52525b'; g.fillRect(340, y - 18, 18, 4);
      g.fillStyle = '#e4e4e7'; g.font = '400 22px ' + F; g.fillText(f[0], 380, y);
      g.fillStyle = '#a1a1aa'; g.fillText(f[1], 1160, y); g.fillText(f[2], 1330, y);
    });
    return c;
  }

  // ── scenes ──
  function screenScenes() {
    if (!window.Stage) return;
    var start = function () {
      var box = document.getElementById('screens-screen'), video = box.querySelector('video'), scrim = box.querySelector('.scrim');
      video.poster = IMG.loopposter;
      box.dataset.grow = '1';
      var m2 = Morph(box, [IMG.s_dashlib, IMG.s_tvlib, IMG.s_sintel, IMG.s_resume, IMG.s_player]);
      var playing = false;
      function vid(on) {
        if (on === playing) return; playing = on;
        if (on) { if (!video.src) { video.poster = IMG.loopposter; video.src = IMG.loop; } video.play().catch(function () {}); } else video.pause();
      }
      Scenes.screens = function (root) {
        if (HY && Stage.live && !Stage.reduced) return manualScene(root, buildScreens, [0, .19, .38, .57, 1], 'Screens of Playpex');
        return Stage.scene(root, { phone: M === 'b' ? 'rest' : 'same', hold: 4, beats: 5, snap: [0, .25, .5, .75, 1], build: buildScreens });
      };
      function buildScreens(tl, ctx) {
          var st = { f: 0 }, b = ctx.q('.beat'), stage = ctx.stage, wrap = stage.querySelector('.sc-wrap');
          function grow() {
            var x0 = wrap.offsetLeft + box.offsetLeft, y0 = wrap.offsetTop + box.offsetTop, w = box.offsetWidth, h = box.offsetHeight;
            var s = Math.max(stage.clientWidth / w, stage.clientHeight / h);
            return { x: (stage.clientWidth - w * s) / 2 - x0, y: (stage.clientHeight - h * s) / 2 - y0, s: s };
          }
          tl.to(st, { f: 4, duration: .76, onUpdate: function () { if (M) m2.pan = pl(st.f, [[0, .7], [1, .25], [2, .1], [3, .5], [4, .5]]); m2.set(st.f); } }, 0);
          for (var i = 1; i < 5; i++) {
            var t = (i - .5) / 4 * .76 + (i === 4 && !M ? .1 : 0);
            var bd = M ? .1 : .05; tl.to(b[i - 1], { autoAlpha: 0, y: -24, duration: bd }, t - (M ? .08 : 0)).fromTo(b[i], { autoAlpha: 0, y: 24 }, { autoAlpha: 1, y: 0, duration: bd }, t + (M ? -.02 : .04));
          }
          tl.to(box, { x: function () { return grow().x; }, y: function () { return grow().y; }, scale: function () { return grow().s; }, borderRadius: 0, duration: .14 }, .8)
            .to(scrim, { autoAlpha: 1, duration: .06 }, .9)
            .to(video, { autoAlpha: 1, duration: .05, onStart: function () { vid(true); }, onReverseComplete: function () { vid(false); } }, .94);
      }
      Scenes.rooms = function (root) {
        var track = root.querySelector('.rooms'), count = root.querySelectorAll('.rooms-count i');
        return Stage.scene(root, { phone: M === 'b' || HY ? 'rest' : 'same', hold: 3, snap: [0, 1 / 3, 2 / 3, 1], onUpdate: function (p) { var k = Math.round(p * 3); count.forEach(function (c, i) { c.classList.toggle('on', i === k); }); root.querySelectorAll('.room').forEach(function (r, i) { r.classList.toggle('cur', i === k); if (M) r.querySelector('.rtext').style.opacity = String(Math.max(0, 1 - Math.abs(p * 3 - i) * 1.6)); }); },
          build: function (tl, ctx) {
            // every stop centres one room: the track moves by whole rooms
            var rooms = track.querySelectorAll('.room');
            function step() { return rooms[1].offsetLeft - rooms[0].offsetLeft; }
            function first() { return (ctx.stage.clientWidth - rooms[0].offsetWidth) / 2 - rooms[0].offsetLeft; }
            tl.fromTo(track, { x: function () { return first(); } }, { x: function () { return first() - step() * (rooms.length - 1); }, duration: 1 }, 0);
          } });
      };
      if (M === 'b') phoneColumn();
      if (HY) phoneRooms();
      Stage.smooth(); Stage.init();
      // ── the intro: the wall shrinks into the screen, becomes the folder and the library, then the window takes
      // the shape of each app. Phones (M): a, the window fills the lower part of the screen edge to edge and the
      // camera drifts across each picture; c, the pictures fill the whole screen, words at the foot; b, no hold. ──
      (function () {
        var intro = document.getElementById('intro'), stage = intro.querySelector('.istage'), slot = document.getElementById('slot');
        var hero = document.getElementById('heroblock'), b1 = document.getElementById('b1'), b2 = document.getElementById('b2'), b3 = document.getElementById('b3'), scrim = document.getElementById('iscrim');
        var P = Painter(document.getElementById('gl'));
        var wide = window.innerWidth >= 1000;
        var END = HY ? 1.4 : 2.6, STOPS = [0, .5, 1, 1.4, 1.8, 2.2, 2.6];
        function rel(el) { var s = el.getBoundingClientRect(), g = stage.getBoundingClientRect(); return [s.left - g.left, s.top - g.top, s.width, s.height]; }
        function mix4(A, B, k) { return [lerp(A[0], B[0], k), lerp(A[1], B[1], k), lerp(A[2], B[2], k), lerp(A[3], B[3], k)]; }
        function show(el, k, dir) { el.style.opacity = k; el.style.visibility = k > .01 ? 'visible' : 'hidden'; el.style.transform = k > .99 || k < .01 ? '' : 'translateY(' + ((1 - k) * 28 * dir) + 'px)'; }

        // the screen the wall shrinks into, and the four shapes of the window after it
        function box(u) {
          var W = stage.clientWidth, H = stage.clientHeight;
          if (M === 'a') { var y = Math.round(H * lerp(.36, .45, ramp(u || 0, 1.02, 1.2))); return [0, y, W, H - y]; }
          if (M === 'c') return [0, 0, W, H];
          return rel(slot);
        }
        function shapes(u) {
          var B = box(u), W = stage.clientWidth, H = stage.clientHeight;
          if (M === 'a' || M === 'c') {
            var top = M === 'a' ? B[1] + 14 : 76, ph0 = M === 'a' ? B[3] - 28 : H * .5;
            var pa = [W / 2 - ph0 * 540 / 1047 / 2, top, ph0 * 540 / 1047, ph0], pm = [W / 2 - ph0 * 540 / 1077 / 2, top, ph0 * 540 / 1077, ph0];
            return [B, B, M === 'c' ? [0, 0, W, Math.round(H * .6)] : B, pa, pm];
          }
          var cx = B[0] + B[2] / 2, cy = B[1] + B[3] / 2;
          var regionH = wide ? H - 64 - 72 : Math.min(B[3] * 1.5, H * .42);
          var sw = B[2] * .86, sh = sw * 10 / 16, ph = regionH, pw = ph * 540 / 1077, aw2 = ph * 540 / 1047;
          return [B, [cx - sw / 2, cy - sh / 2, sw, sh], B, [cx - aw2 / 2, cy - ph / 2 + (wide ? 32 : 0), aw2, ph], [cx - pw / 2, cy - ph / 2 + (wide ? 32 : 0), pw, ph]];
        }
        var RAD = M === 'a' || M === 'c' ? [0, 0, 0, 26, 26] : [16, 12, 6, 30, 30];
        // phones: where the camera looks across a landscape picture (0 its left edge, 1 its right)
        function panAt(u) { return pl(u, [[0, .2], [.5, .2], [1, .7], [1.4, .9], [1.8, M === 'c' ? .3 : .25], [2.2, .5]]); }

        var NAMES = [['Media Server', 'Keeps the films, finds their posters and streams them. You run it from a browser.', 'Windows, macOS, Linux', 'Server'],
          ['Playpex TV', 'For the computer by your TV. Arrows, OK and Back do everything.', 'Windows, macOS, Linux', 'TV'],
          ['Playpex for Android', 'Plays files as they are, with every track, and picks up at the minute the TV stopped.', 'Phones and tablets', 'Android'],
          ['Server Manager', 'Finds the server on your Wi-Fi and opens its dashboard on your phone: the library, downloads and who is watching.', 'Android', 'Manager']];
        var cur = -1, list = document.getElementById('b3-list'), fact = document.getElementById('b3-fact'), st;
        function setApp(i) {
          if (i === cur) return; cur = i;
          list.querySelectorAll('button').forEach(function (b, k) { b.classList.toggle('on', k === i); });
          fact.innerHTML = '<p>' + NAMES[i][1] + '</p><span>' + NAMES[i][2] + '</span>';
        }
        // phones: which app the window shows, switched by a tap or a swipe (not by scrolling)
        var AV = { v: 0 };
        function pick(i) { i = Math.max(0, Math.min(3, i)); gsap.to(AV, { v: i, duration: still ? 0 : .9, ease: 'power2.inOut', overwrite: true, onUpdate: function () { frame(st.progress); } }); }
        function go(u) { var y = st.start + (st.end - st.start) * u / END; if (Stage.lenis) Stage.lenis.scrollTo(y); else window.scrollTo({ top: y, behavior: 'smooth' }); }

        function frame(p) {
          // when each change happens, in u (stops at 0, .5, 1, 1.4, 1.8, 2.2, 2.6). Phones scroll freely (no snap), so
          // their changes are spread across the whole distance between two stops and follow the thumb continuously
          var T = !M ? { k: [.06, .36], q1: [.34, .5], q2: [.64, .88], hero: [.03, .14], b1: [.26, .36], b1o: [.55, .62], b2: [.68, .78], b2o: [1.04, 1.14], b3: [1.12, 1.24], out: [1.06, 1.3], sh: [.06, .34], qa: [.1, .34] }
            : { k: [.04, .3], q1: M === 'c' ? [.08, .44] : [.22, .46], q2: [.56, .94], hero: [.02, .14], b1: M === 'c' ? [.14, .32] : [.26, .38], b1o: [.56, .66], b2: [.72, .84], b2o: [1.03, 1.13], b3: [1.1, 1.26], out: [1.03, 1.3], sh: [.04, .36], qa: [.04, .36] };
          function R(u, ab, off) { return ramp(u, ab[0] + (off || 0), ab[1] + (off || 0)); }
          var u = p * END; if (HY && u >= 1.399) u = 1.4 + AV.v * .4; else if (HY && AV.v) { gsap.killTweensOf(AV); AV.v = 0; }
          var F = [0, 0, stage.clientWidth, stage.clientHeight], B = box(u), k = R(u, T.k);
          P.win = mix4(F, B, k); P.rad = RAD[0] * k; P.outVis = Math.max(1 - k, R(u, T.out)); P.dim = u > 1 ? .5 : 1; P.shade = M === 'c' ? 0 : R(u, T.out); P.shadeV = wide ? 0 : 1; P.q = R(u, T.q1) + R(u, T.q2); P.rise = 0;
          P.pan = M ? panAt(u) : .5;
          scrim.style.opacity = 1 - k;
          show(hero, 1 - R(u, T.hero), -1);
          show(b1, R(u, T.b1) * (1 - R(u, T.b1o)), R(u, T.b1o) > 0 ? -1 : 1);
          show(b2, R(u, T.b2) * (1 - R(u, T.b2o)), R(u, T.b2o) > 0 ? -1 : 1);
          show(b3, R(u, T.b3), 1);
          var S = shapes(u), w = S[0];
          for (var i = 0; i < 4; i++) w = mix4(w, S[i + 1], R(u, T.sh, 1 + i * .4));
          var r = RAD[0]; for (i = 0; i < 4; i++) r = lerp(r, RAD[i + 1], R(u, T.sh, 1 + i * .4));
          if (u > 1) { P.win = w; P.rad = r; P.q = 2 + R(u, T.qa, 1.4) + R(u, T.qa, 1.8) + R(u, T.qa, 2.2); }
          setApp(Math.max(0, Math.min(3, Math.round((u - 1.4) / .4))));
          if (M === 'c') stage.style.setProperty('--foot', String(ramp(u, .08, .2)));
        }
        if (!P) return;
        if (Stage.live && !Stage.reduced && M !== 'b') {
          intro.classList.add('is-held');
          intro.style.height = (100 + 300 * END) + 'svh';
          document.documentElement.classList.add('held-a');
          list.innerHTML = NAMES.map(function (n) { return '<li><button type="button" tabindex="-1"><span class="long">' + n[0] + '</span><span class="short">' + n[3] + '</span></button></li>'; }).join('');
          list.querySelectorAll('button').forEach(function (b, i) { b.addEventListener('click', function () { if (HY) pick(i); else go(1.4 + i * .4); }); });
          if (HY) {
            list.querySelectorAll('button').forEach(function (b) { b.tabIndex = 0; });
            var x0 = 0, y0 = 0;
            stage.addEventListener('touchstart', function (e) { x0 = e.touches[0].clientX; y0 = e.touches[0].clientY; }, { passive: true });
            stage.addEventListener('touchend', function (e) { if (st.progress * END < 1.3) return; var dx = e.changedTouches[0].clientX - x0, dy = e.changedTouches[0].clientY - y0; if (Math.abs(dx) > 40 && Math.abs(dx) > Math.abs(dy) * 1.3) pick(Math.round(AV.v) + (dx < 0 ? 1 : -1)); }, { passive: true });
          }
          st = ScrollTrigger.create({ trigger: intro, start: 'top top', end: 'bottom bottom', invalidateOnRefresh: true, onUpdate: function (s) { frame(s.progress); },
            // phones (hybrid): quick snaps from the hero to the folder, the library and the four apps, where the intro ends
            snap: HY ? { snapTo: [0, .5 / END, 1 / END, 1], inertia: false, delay: .04, duration: { min: .25, max: .5 }, ease: 'power3.out' }
              : M ? undefined : { snapTo: STOPS.map(function (s) { return s / END; }), inertia: false, delay: .12, duration: { min: .3, max: .8 }, ease: 'power2.inOut' } });
          frame(0); P.onready = function () { frame(st.progress); };
          window.addEventListener('resize', function () { frame(st.progress); });
          document.getElementById('how-link').addEventListener('click', function (e) { e.preventDefault(); go(.5); });
          if (!HY) document.querySelectorAll('a[href="#products"]').forEach(function (a) { a.addEventListener('click', function (e) { e.preventDefault(); go(1.4); }); });
        } else {
          // not held: the wall stays the hero's picture, full screen behind it
          P.win = [0, 0, 0, 0]; P.outVis = 1; P.q = 0;
        }
      })();
    };
    if (document.fonts && document.fonts.ready) document.fonts.ready.then(start); else start();
  }

  // ── phones (hybrid) ──
  var ARROW = function (d) { return '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="' + (d < 0 ? 'M19 12H5m6-6-6 6 6 6' : 'M5 12h14m-6-6 6 6-6 6') + '"/></svg>'; };

  // phones: a carousel to swipe, with two buttons and a row of dots that fills as it moves
  function carousel(track, label, onAt) {
    var items = track.children, n = items.length;
    track.classList.add('pcar'); track.setAttribute('aria-roledescription', 'carousel'); track.setAttribute('aria-label', label); track.tabIndex = 0;
    [].forEach.call(items, function (r, i) { r.setAttribute('aria-roledescription', 'slide'); r.setAttribute('aria-label', (i + 1) + ' of ' + n); });
    var ctl = document.createElement('div'); ctl.className = 'rctl';
    var DOTS = 30, dots = ''; for (var i = 0; i < DOTS; i++) dots += '<i></i>';
    ctl.innerHTML = '<div class="rdots" aria-hidden="true">' + dots + '</div><div class="rbtns"><button type="button" class="rprev" aria-label="Previous">' + ARROW(-1) + '</button><button type="button" class="rnext" aria-label="Next">' + ARROW(1) + '</button></div>';
    track.parentNode.insertBefore(ctl, track.nextSibling);
    var prev = ctl.querySelector('.rprev'), next = ctl.querySelector('.rnext'), ds = ctl.querySelectorAll('.rdots i'), last = -1;
    function step() { return n > 1 ? items[1].offsetLeft - items[0].offsetLeft : 1; }
    function at() { return Math.max(0, Math.min(n - 1, Math.round(track.scrollLeft / step()))); }
    function go(d) { track.scrollTo({ left: (at() + d) * step(), behavior: still ? 'auto' : 'smooth' }); }
    function upd() {
      var max = track.scrollWidth - track.clientWidth, p = max > 0 ? track.scrollLeft / max : 0, lit = Math.round(p * (DOTS - 6)) + 6, k = at();
      ds.forEach(function (d, j) { d.classList.toggle('on', j < lit); });
      prev.disabled = k <= 0; next.disabled = k >= n - 1;
      if (k !== last) { last = k; if (onAt) onAt(k); }
    }
    prev.addEventListener('click', function () { go(-1); }); next.addEventListener('click', function () { go(1); });
    track.addEventListener('keydown', function (e) { var d = { ArrowRight: 1, ArrowLeft: -1 }[e.key]; if (d) { e.preventDefault(); go(d); } });
    track.addEventListener('scroll', function () { requestAnimationFrame(upd); }, { passive: true });
    upd();
    return { at: at };
  }
  // the server does the rest
  function phoneRooms() { carousel(document.getElementById('rooms'), 'What the server does'); }
  // phones: a scene that stays one screen tall and moves from beat to beat with buttons (or a swipe), not with the scroll
  function manualScene(root, build, stops, label) {
    var stage = root.querySelector('.scene-stage');
    root.classList.add('is-live', 'is-manual');
    var tl = gsap.timeline({ paused: true, defaults: { ease: 'none' } });
    build(tl, { root: root, stage: stage, phone: true, q: function (sel) { return [].slice.call(root.querySelectorAll(sel)); } });
    if (tl.duration() < 1) tl.to({}, { duration: 1 - tl.duration() }, tl.duration());
    var ctl = document.createElement('div'); ctl.className = 'rctl mctl';
    var DOTS = 30, dots = ''; for (var i = 0; i < DOTS; i++) dots += '<i></i>';
    ctl.innerHTML = '<div class="rdots" aria-hidden="true">' + dots + '</div><div class="rbtns"><button type="button" class="rprev" aria-label="Previous screen">' + ARROW(-1) + '</button><button type="button" class="rnext" aria-label="Next screen">' + ARROW(1) + '</button></div>';
    stage.appendChild(ctl);
    var prev = ctl.querySelector('.rprev'), next = ctl.querySelector('.rnext'), ds = ctl.querySelectorAll('.rdots i'), k = 0, n = stops.length;
    stage.setAttribute('role', 'group'); stage.setAttribute('aria-roledescription', 'carousel'); stage.setAttribute('aria-label', label);
    function paint() {
      var p = tl.progress(), lit = Math.round(p * (DOTS - 6)) + 6;
      ds.forEach(function (d, j) { d.classList.toggle('on', j < lit); });
    }
    tl.eventCallback('onUpdate', paint);
    function go(d) {
      var to = Math.max(0, Math.min(n - 1, k + d)); if (to === k) return; k = to;
      prev.disabled = k <= 0; next.disabled = k >= n - 1;
      gsap.to(tl, { progress: stops[k], duration: still ? 0 : .5 + Math.abs(stops[k] - tl.progress()) * 1.6, ease: 'power2.inOut', overwrite: true });
    }
    prev.addEventListener('click', function () { go(-1); }); next.addEventListener('click', function () { go(1); });
    stage.tabIndex = 0;
    stage.addEventListener('keydown', function (e) { var d = { ArrowRight: 1, ArrowLeft: -1 }[e.key]; if (d) { e.preventDefault(); go(d); } });
    var x0 = 0, y0 = 0;
    stage.addEventListener('touchstart', function (e) { x0 = e.touches[0].clientX; y0 = e.touches[0].clientY; }, { passive: true });
    stage.addEventListener('touchend', function (e) { var dx = e.changedTouches[0].clientX - x0, dy = e.changedTouches[0].clientY - y0; if (Math.abs(dx) > 40 && Math.abs(dx) > Math.abs(dy) * 1.3) go(dx < 0 ? 1 : -1); }, { passive: true });
    prev.disabled = true; paint();
    return true;
  }
  // phones, b: no holds; every statement gets its own picture, which forms from gold dots as it arrives
  function phoneColumn() {
    var io = new IntersectionObserver(function (es) { es.forEach(function (e) { if (e.isIntersecting) { e.target.__show(true); io.unobserve(e.target); } }); }, { threshold: .35 });
    function fig(src, alt, cls) {
      var f = document.createElement('figure'); f.className = 'pfig' + (cls ? ' ' + cls : ''); f.setAttribute('role', 'img'); f.setAttribute('aria-label', alt);
      var pic = Pic(f); pic.show(src, false); f.__show = function (on) { pic.show(src, on); }; io.observe(f); return f;
    }
    var col = document.createElement('section'); col.className = 'pcol'; col.setAttribute('aria-label', 'From folders to a library');
    [['Your films sit in folders.', 'On the computer that keeps them, or on a network share. Point Playpex at them once.', folderPicture().toDataURL('image/jpeg', .9), 'A folder of films in a file manager, named by title and year'],
     ['Now they\'re a library.', 'Every file is matched to its title, with the poster, the cast and the ratings.', IMG.s_dashlib, 'The Playpex dashboard\'s Library: posters of the films on the server, A to Z']].forEach(function (b) {
      var d = document.createElement('div'); d.className = 'pbeat'; d.innerHTML = '<h2>' + b[0] + '</h2><p>' + b[1] + '</p>'; d.appendChild(fig(b[2], b[3])); col.appendChild(d);
    });
    var intro = document.getElementById('intro'); intro.parentNode.insertBefore(col, intro.nextSibling);
    var SHOTS = [['s_dashlib', 'The dashboard\'s Library in a browser'], ['s_tvlib', 'Playpex TV: Sintel at the top of Recently added'], ['s_sintel', 'Playpex TV: Sintel\'s page'], ['s_resume', 'Playpex TV asking to resume Sintel at 5:18'], ['loopposter', 'Sintel playing in Playpex TV']];
    document.querySelectorAll('.sc-screens .beat').forEach(function (b, i) { b.appendChild(fig(IMG[SHOTS[i][0]], SHOTS[i][1])); });
  }
  screenScenes();

  // ── remote: a row of Playpex TV (the films on the demo server), driven by the pad or the arrow keys ──
  (function () {
    var FILMS = [['Sintel', '2010, on this server, resume at 5:18'], ['The Kid', '1921, on this server'], ['Tears of Steel', '2012, on this server'], ['The Cabinet of Dr. Caligari', '1920, on this server'],
      ['The General', '1926, on this server'], ['Spring', '2019, on this server'], ['Sherlock Jr.', '1924, on this server'], ['Night of the Living Dead', '1968, on this server'], ['Nosferatu', '1922, on this server']];
    var row = document.getElementById('tvrow'), track = document.getElementById('track'), chooser = document.getElementById('chooser');
    var title = document.getElementById('tv-title'), sub = document.getElementById('tv-sub'), hint = document.getElementById('pad-hint');
    document.getElementById('chooser-img').src = IMG.s_resume;
    track.innerHTML = FILMS.map(function (f, i) { return '<div class="poster" role="option" id="pf' + i + '" aria-label="' + f[0] + '"><canvas></canvas><img class="col" alt="" src="' + IMG['p' + i] + '"></div>'; }).join('');
    var posters = track.querySelectorAll('.poster'), at = 0, HINT = 'OK on Sintel opens it, Back closes it.';
    posters.forEach(function (p, i) { var im = new Image(); im.onload = function () { dots(im, p.querySelector('canvas'), 3); }; im.src = IMG['p' + i]; });
    function focus(i) {
      at = Math.max(0, Math.min(FILMS.length - 1, i));
      posters.forEach(function (p, k) { p.classList.toggle('on', k === at); p.setAttribute('aria-selected', String(k === at)); });
      row.setAttribute('aria-activedescendant', 'pf' + at);
      title.textContent = FILMS[at][0]; sub.textContent = FILMS[at][1];
      var w = posters[0].offsetWidth + 14, room = row.clientWidth - 56, shift = Math.max(0, Math.min(at * w - room / 2 + w / 2, FILMS.length * w - 14 - room));
      track.style.transform = 'translateX(' + (-shift) + 'px)';
    }
    function press(k) {
      var btn = document.querySelector('.pad-wrap [data-k="' + k + '"]');
      if (btn) { btn.classList.add('hit'); setTimeout(function () { btn.classList.remove('hit'); }, 140); }
      if (!chooser.hidden) { if (k === 'back') { chooser.hidden = true; hint.textContent = HINT; } return; }
      if (k === 'left') focus(at - 1);
      else if (k === 'right') focus(at + 1);
      else if (k === 'ok') { if (at === 0) { chooser.hidden = false; hint.textContent = 'Press Back to return to the row.'; } else hint.textContent = 'In the app, OK opens ' + FILMS[at][0] + '. Here, only Sintel opens.'; }
      else if (k === 'up' || k === 'down') hint.textContent = 'In the app, up and down move between rows. This sample has one.';
    }
    document.querySelector('.pad-wrap').addEventListener('click', function (e) { var b = e.target.closest('[data-k]'); if (b) press(b.dataset.k); });
    track.addEventListener('click', function (e) { var p = e.target.closest('.poster'); if (!p) return; var i = [].indexOf.call(posters, p); if (i === at) press('ok'); else focus(i); });
    var inView = false;
    new IntersectionObserver(function (es) { inView = es[0].intersectionRatio > .6; }, { threshold: [0, .6, 1] }).observe(row);
    var KEYS = { ArrowLeft: 'left', ArrowRight: 'right', ArrowUp: 'up', ArrowDown: 'down', Enter: 'ok', Escape: 'back', Backspace: 'back' };
    document.addEventListener('keydown', function (e) {
      var k = KEYS[e.key], a = document.activeElement; if (!k || e.altKey || e.ctrlKey || e.metaKey) return;
      var mine = a === row || (a && a.closest && a.closest('.pad-wrap'));
      var idle = !a || a === document.body;
      if (!(mine || (idle && inView))) return;
      if ((k === 'up' || k === 'down') && !mine) return;
      if (k === 'ok' && a && a.closest && a.closest('.pad-wrap')) return;
      e.preventDefault(); press(k);
    });
    window.addEventListener('resize', function () { focus(at); });
    focus(0);
  })();

  // ── switch on what you need: three ways to tell it ──
  // a picture that is gold dots while its switch is off and itself when on; a new picture passes through the dots
  function Pic(fig) {
    var c = document.createElement('canvas'), x = c.getContext('2d'), cache = {}, cur = null, next = null, k = 0, target = 0, raf = 0;
    c.setAttribute('aria-hidden', 'true'); fig.appendChild(c);
    function load(src, cb) {
      var o = cache[src]; if (o && o.ok) return cb(o);
      if (!o) { o = cache[src] = { im: new Image(), ok: false, cbs: [] }; o.im.onload = function () { o.ok = true; o.cbs.forEach(function (f) { f(o); }); }; o.im.src = src; }
      o.cbs.push(cb);
    }
    function size(o) {
      var w = Math.round(fig.clientWidth * dpr), h = Math.round(fig.clientHeight * dpr); if (!w || !h || (o.w === w && o.h === h)) return; o.w = w; o.h = h;
      o.P = document.createElement('canvas'); o.P.width = w; o.P.height = h;
      var g = o.P.getContext('2d'), im = o.im, s = Math.max(w / im.width, h / im.height); g.drawImage(im, (w - im.width * s) / 2, 0, im.width * s, im.height * s);
      var cell = o.cell = Math.round(6 * dpr), cw = Math.ceil(w / cell), ch = Math.ceil(h / cell), sm = document.createElement('canvas'); sm.width = cw; sm.height = ch;
      var sg = sm.getContext('2d'); sg.drawImage(o.P, 0, 0, cw, ch); var px = sg.getImageData(0, 0, cw, ch).data;
      o.D = document.createElement('canvas'); o.D.width = w; o.D.height = h; var d = o.D.getContext('2d'); d.fillStyle = '#141414'; d.fillRect(0, 0, w, h);
      for (var yy = 0; yy < ch; yy++) for (var xx = 0; xx < cw; xx++) {
        var i = (yy * cw + xx) * 4, l = Math.pow((px[i] * .299 + px[i + 1] * .587 + px[i + 2] * .114) / 255, .8) * 1.2;
        d.fillStyle = l > (BAYER[(yy % 4) * 4 + xx % 4] + .5) / 16 ? '#edcc75' : '#2b2a27'; d.beginPath(); d.arc(xx * cell + cell / 2, yy * cell + cell / 2, cell * .38, 0, 6.2832); d.fill();
      }
    }
    function draw() {
      if (!cur) return; size(cur); if (!cur.P) return; var w = cur.w, h = cur.h; if (c.width !== w || c.height !== h) { c.width = w; c.height = h; }
      if (k >= 1) { x.drawImage(cur.P, 0, 0); return; }
      x.drawImage(cur.D, 0, 0); if (k <= 0) return;
      var cell = cur.cell;
      for (var yy = 0, j = 0; yy < h; yy += cell, j++) for (var xx = 0, i = 0; xx < w; xx += cell, i++) if ((BAYER[(j & 3) * 4 + (i & 3)] + .5) / 16 < k) x.drawImage(cur.P, xx, yy, cell, cell, xx, yy, cell, cell);
    }
    function step() {
      var sp = still ? 1 : .07;
      if (next) { k = Math.max(0, k - sp * 1.6); if (k === 0) { cur = next; next = null; } }
      else k = target > k ? Math.min(target, k + sp) : Math.max(target, k - sp);
      draw(); raf = (next || k !== target) ? requestAnimationFrame(step) : 0;
    }
    function kick() { if (!raf) raf = requestAnimationFrame(step); }
    window.addEventListener('resize', function () { draw(); });
    return { show: function (src, on) { load(src, function (o) { if (!cur) cur = o; else if (o !== cur) next = o; target = on ? 1 : 0; kick(); }); }, redraw: draw };
  }
  function sw(id, label, on) { return '<button type="button" class="sw2" role="switch" aria-checked="' + !!on + '" id="' + id + '"><i aria-hidden="true"></i><span>' + label + '</span></button>'; }
  function flip(b, on) { b.setAttribute('aria-checked', String(on)); }
  function isOn(b) { return b.getAttribute('aria-checked') === 'true'; }
  var FT = {
    kids: { sw: 'Kids profile', src: 's_profiles', alt: 'Playpex TV: Who’s watching, with Sam, Alex, Noor and the Kids profile' },
    sound: { sw: 'Sound for every film', src: 's_player', alt: 'Playpex TV playing Sintel' },
    subs: { sw: 'Subtitles in any language', src: 's_subs', alt: 'Playpex TV: the subtitles for Sintel, in English, French, Spanish and German' },
    resume: { sw: 'Resume on any screen', src: 's_mtitle', alt: 'Playpex for Android: Sintel, Resume from 6:31', tall: true },
    remote: { sw: 'Your phone as the remote', src: 's_remote', alt: 'The remote control on a phone: Sintel playing on the Living room TV', tall: true }
  };
  var root = document.getElementById('feats-root');

  (function () {
    // 2 · who's watching: each profile of the demo house, its colour, and what it switches on
    var FACE = function (c, ink) { return '<svg viewBox="0 0 100 100" aria-hidden="true"><circle cx="50" cy="50" r="50" fill="' + c + '"/><circle cx="35" cy="40" r="6" fill="' + ink + '"/><circle cx="65" cy="40" r="6" fill="' + ink + '"/><path d="M30 60 Q50 78 70 60" stroke="' + ink + '" stroke-width="7" fill="none" stroke-linecap="round"/></svg>'; };
    var PEOPLE = [
      ['Sam', '#2f6fe4', '#3b82f6', 'Sam starts on the TV and finishes in bed.', 'resume', 'Sintel opens on Sam’s phone at 6:31, the minute the TV stopped.'],
      ['Alex', '#16803f', '#2bb673', 'Alex keeps the film’s own sound.', 'sound', 'Dolby and DTS tracks are turned into AAC by the server, so no film plays silent.'],
      ['Noor', '#0f7068', '#14b8a6', 'Noor watches with subtitles.', 'subs', 'From the file or online, in Noor’s language, at Noor’s size.'],
      ['Kids', '#f2c31b', '#f5c518', 'The kids see what’s for them.', 'kids', 'Only titles for children, and the grown-ups’ profiles locked with a PIN.'],
      ['Everyone', '#2b2618', '#edcc75', 'Everyone pauses the TV from the sofa.', 'remote', 'Any phone in the house is a remote for any screen, with a touchpad and the keys.']
    ];
    root.innerHTML = '<div class="wrap who-head"><h2 id="feat-title">Four people, one house</h2><p>Profiles keep each person’s list, place and settings. Switch on what each of them needs.</p></div>' +
      '<ul class="who">' + PEOPLE.map(function (p, i) {
        var f = FT[p[4]], dark = i === 3;
        return '<li class="person' + (dark ? ' dark' : '') + '" style="--fill:' + p[1] + '" data-i="' + i + '"><div class="wrap"><div class="pwords"><div class="face">' + (i < 4 ? FACE(p[2], '#141414') : '<span class="all">' + PEOPLE.slice(0, 4).map(function (q) { return FACE(q[2], '#141414'); }).join('') + '</span>') + '</div>' +
          '<h3>' + p[3] + '</h3>' + sw('pp' + i, f.sw, false) + '<p>' + p[5] + '</p></div><figure class="pic' + (f.tall ? ' tall' : '') + '"><img alt="' + f.alt + '"></figure></div></li>';
      }).join('') + '</ul>';
    var rows = root.querySelectorAll('.person'), pics = [], touched = {};
    rows.forEach(function (r, i) { pics[i] = Pic(r.querySelector('.pic')); pics[i].show(IMG[FT[PEOPLE[i][4]].src], false); });
    function set(i, on) { var b = document.getElementById('pp' + i); flip(b, on); rows[i].classList.toggle('on', on); pics[i].show(IMG[FT[PEOPLE[i][4]].src], on); }
    root.addEventListener('click', function (ev) { var b = ev.target.closest('.sw2'); if (!b) return; var i = +b.id.slice(2); touched[i] = true; set(i, !isOn(b)); });
    var io = new IntersectionObserver(function (es) { es.forEach(function (en) { var i = +en.target.dataset.i; if (en.isIntersecting && !touched[i]) { touched[i] = true; setTimeout(function () { set(i, true); }, still ? 0 : 350); } }); }, { rootMargin: '-40% 0px -40% 0px' });
    rows.forEach(function (r) { io.observe(r); });
  })();


  // ── download: the dialog, already open ──
  (function () {
    var FILES = {
      Windows: ['Playpex-Media-Server-Setup-0.10.1-alpha.1.exe', 'Installs for your user only. Windows may ask you to confirm the first time.'],
      macOS: ['Playpex-Media-Server-0.10.1-alpha.1.dmg', 'Drag Playpex Media Server to Applications.'],
      Linux: ['Playpex-Media-Server-0.10.1-alpha.1.AppImage', 'Or the .deb package on the releases page.']
    };
    var seg = document.getElementById('seg'), name = document.getElementById('dl-name'), how = document.getElementById('dl-how'), go = document.getElementById('dl-go');
    var pick = FILES[os] ? os : 'Windows';
    seg.innerHTML = Object.keys(FILES).map(function (k) { return '<button type="button" role="radio" data-k="' + k + '">' + k + '</button>'; }).join('');
    function set(k) {
      pick = k; seg.querySelectorAll('button').forEach(function (b) { var on = b.dataset.k === k; b.setAttribute('aria-checked', String(on)); b.tabIndex = on ? 0 : -1; });
      name.textContent = FILES[k][0]; how.textContent = FILES[k][1]; go.innerHTML = DLI + 'Download for ' + k;
    }
    seg.addEventListener('click', function (e) { var b = e.target.closest('button'); if (b) set(b.dataset.k); });
    seg.addEventListener('keydown', function (e) {
      var d = { ArrowRight: 1, ArrowDown: 1, ArrowLeft: -1, ArrowUp: -1 }[e.key]; if (!d) return; e.preventDefault();
      var ks = Object.keys(FILES), n = ks[(ks.indexOf(pick) + d + 3) % 3]; set(n); seg.querySelector('[data-k="' + n + '"]').focus();
    });
    set(pick);
  })();

  document.addEventListener('click', function (e) { var a = e.target.closest('a[href="#"], a[href="#docs"], a[href="#plugins"], a[href="#releases"], a[href="#home"]'); if (a) e.preventDefault(); });
})();
