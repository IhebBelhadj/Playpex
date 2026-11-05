// The WebGL ordered-dither (Bayer) shaders, the page's one motif.
// Painter: the poster wall drifting in gold dots, and inside a rounded window a picture q (0 the wall, 1 the folder,
//   2 the library, 3 Playpex TV, 4 the phone app, 5 Server Manager) that dissolves through gold dots into the next;
//   clear (0…1) dissolves the wall around the window, dot by dot, into the plain ground; mask (a canvas) and mk show the
//   wall in that shape inside the window (the Playpex mark at the hero).
// Morph: a list of pictures; f between two whole numbers dissolves one into the next through gold dots.
// The colours are the theme's (--ground, --dot, --unlit), passed in as uniforms.
import { THEME, dpr, still, whenNear } from './util.js';

const BAYER_GLSL = 'float b2(vec2 v){v=floor(v);return fract(dot(v,vec2(.5,v.y*.75)));} float bayer(vec2 v){return b2(.25*v)*.0625+b2(.5*v)*.25+b2(v);}';
const COLOURS_GLSL = 'uniform vec3 cG; uniform vec3 cD; uniform vec3 cU;';   // ground, dot, unlit dot

function glProgram(canvas, frag) {
  const gl = canvas.getContext('webgl', { antialias: false, alpha: false });
  if (!gl) return null;
  const shader = (type, src) => {
    const s = gl.createShader(type);
    gl.shaderSource(s, src); gl.compileShader(s);
    if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) console.error(gl.getShaderInfoLog(s));
    return s;
  };
  const pr = gl.createProgram();
  gl.attachShader(pr, shader(gl.VERTEX_SHADER, 'attribute vec2 p; void main(){gl_Position=vec4(p,0.,1.);}'));
  gl.attachShader(pr, shader(gl.FRAGMENT_SHADER, frag));
  gl.linkProgram(pr); gl.useProgram(pr);
  gl.bindBuffer(gl.ARRAY_BUFFER, gl.createBuffer());
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);
  const loc = gl.getAttribLocation(pr, 'p');
  gl.enableVertexAttribArray(loc); gl.vertexAttribPointer(loc, 2, gl.FLOAT, false, 0, 0);
  const T = THEME.gl;
  gl.uniform3fv(gl.getUniformLocation(pr, 'cG'), T.ground);
  gl.uniform3fv(gl.getUniformLocation(pr, 'cD'), T.dot);
  gl.uniform3fv(gl.getUniformLocation(pr, 'cU'), T.unlit);
  return {
    gl,
    uniforms(names) { const U = {}; names.forEach((n) => { U[n] = gl.getUniformLocation(pr, n); }); return U; },
    tex(src) {
      const t = gl.createTexture();
      gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, t);
      gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, true);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGB, gl.RGB, gl.UNSIGNED_BYTE, src);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      return t;
    },
    bind(unit, t) { gl.activeTexture(gl.TEXTURE0 + unit); gl.bindTexture(gl.TEXTURE_2D, t); },
    size(w, h) {
      w = Math.round(w * dpr); h = Math.round(h * dpr);
      if (w && h && (canvas.width !== w || canvas.height !== h)) { canvas.width = w; canvas.height = h; gl.viewport(0, 0, w, h); }
    },
  };
}

// loads every source (a URL or a canvas) and calls back with the images in order, each decoded off the main thread
// first (an image handed to texImage2D undecoded is decoded there and then, inside the frame: a quarter-second hitch
// on a phone)
function loadAll(sources, cb) {
  const out = [];
  let left = sources.length;
  const done = (i, im) => { out[i] = im; if (--left === 0) cb(out); };
  sources.forEach((src, i) => {
    if (typeof src !== 'string') { done(i, src); return; }
    const im = new Image();
    im.decoding = 'async';
    im.src = src;
    if (im.decode) im.decode().then(() => done(i, im), () => { if (im.complete && im.naturalWidth) done(i, im); else im.onload = () => done(i, im); });
    else im.onload = () => done(i, im);
  });
}

// turns images into textures one per frame (each upload copies a whole picture: all at once is a long frame), and
// only while the page is still (a move is never what pays for them: the swipe that brings a scene near would), then
// calls back with them
let scrolledAt = 0;
window.addEventListener('scroll', () => { scrolledAt = performance.now(); }, { passive: true });
function uploadAll(P, ims, cb) {
  const out = [];
  (function next(i) {
    if (i === ims.length) { cb(out); return; }
    if (performance.now() - scrolledAt < 200) { requestAnimationFrame(() => next(i)); return; }
    out[i] = P.tex(ims[i]);
    requestAnimationFrame(() => next(i + 1));
  })(0);
}

const PAINTER_FRAG = [
  'precision highp float;', COLOURS_GLSL, BAYER_GLSL,
  'uniform vec2 r; uniform float t; uniform sampler2D wall; uniform sampler2D a; uniform sampler2D b; uniform vec2 tw; uniform vec2 ta; uniform vec2 tb;',
  'uniform float aw; uniform float pp; uniform vec4 win; uniform float rad; uniform float outVis; uniform float px; uniform float dim; uniform float shade; uniform float shadeV; uniform float pan;',
  'uniform float clear; uniform sampler2D mask; uniform float mk; uniform vec3 hole;',
  // the wall: posters in lanes drifting left and right, in gold dots
  'float wallOn(vec2 fc){ float w=3.*px; vec2 cell=floor(fc/w)*w+w*.5;',
  ' float lanes=3.4; float ly=cell.y/r.y*lanes+.15; float lane=floor(ly); float fy=fract(ly); float gap=smoothstep(0.,.03,fy)*smoothstep(1.,.97,fy);',
  ' float laneW=(r.y/lanes)*tw.x/(tw.y*.5); float dir=mod(lane,2.)<.5?1.:-1.; float x=(cell.x+dir*t*28.+lane*517.)/laneW; float hf=mod(lane,2.)<.5?.5:0.;',
  ' float l=dot(texture2D(wall,vec2(fract(x),hf+fy*.5)).rgb,vec3(.299,.587,.114)); l=pow(clamp(l,0.,1.),.85)*1.14;',
  ' return step(bayer(fc/w)+.5/64.,l)*gap; }',
  'vec2 cover(vec2 uv, vec2 box, vec2 ts){ float s=max(box.x/ts.x,box.y/ts.y); vec2 size=ts*s; return vec2((uv.x*box.x-(box.x-size.x)*pan)/size.x, 1.-(uv.y*box.y)/size.y); }',
  'void main(){ vec2 fc=gl_FragCoord.xy; vec2 pt=vec2(fc.x,r.y-fc.y); float won=wallOn(fc); vec3 w=mix(cG,cD,won);',
  ' vec2 c=win.xy+win.zw*.5; vec2 d=abs(pt-c)-win.zw*.5+rad; float sd=length(max(d,0.))+min(max(d.x,d.y),0.)-rad;',
  ' vec2 lp=pt-win.xy; vec2 uv=lp/max(win.zw,vec2(1.));',
  ' float p=pp; vec3 A=aw>.5?w:texture2D(a,cover(uv,win.zw,ta)).rgb; vec3 B=texture2D(b,cover(uv,win.zw,tb)).rgb;',
  ' float g=7.*px; vec2 ci=floor(lp/g); vec2 cc=(ci+.5)*g/max(win.zw,vec2(1.));',
  ' float k=step(bayer(ci)+.001,p); vec3 col=mix(A,B,k);',
  ' vec3 As=aw>.5?w:texture2D(a,cover(cc,win.zw,ta)).rgb; vec3 Bs=texture2D(b,cover(cc,win.zw,tb)).rgb;',
  ' float l=pow(dot(mix(As,Bs,k),vec3(.299,.587,.114)),.8)*1.25; float on=step(bayer(ci+vec2(2.,1.))+.5/64.,l);',
  ' float dd=length(fract(lp/g)-.5); vec3 dotted=mix(cG,mix(cU,cD,on),smoothstep(.52,.36,dd));',
  ' col=mix(col,dotted,smoothstep(.04,.55,sin(3.14159*p)));',
  ' vec3 outside=mix(cG,mix(cG,w,dim),outVis);',
  ' outside=mix(outside,cG,step(bayer(floor(pt/(7.*px)))+.001,clear));',
  ' float sf=shadeV>.5?smoothstep(.78,.36,pt.y/r.y):smoothstep(.6,.28,pt.x/r.x); outside=mix(outside,cG,shade*sf*.92);',
  // mk (the home page's hero): while on, the window holds the wall in the mask's shape (the Playpex mark), tested per wall
  // cell so its edge follows the dots, its dark cells the unlit dot; around it the ground. The dissolve's cells (k, the
  // same grid and order) open onto the next picture inside the mark and around it alike: the mark becomes the picture
  ' if(mk>0.){ float wc=3.*px; vec2 c3=(floor(fc/wc)+.5)*wc; vec2 um=(vec2(c3.x,r.y-c3.y)-win.xy)/max(win.zw,vec2(1.));',
  '  float mm=step(.5,texture2D(mask,vec2(um.x,1.-um.y)).r); col=mix(mix(cG,mix(cU,cD,won),mm),col,k); }',
  // hole (x, y, radius): a round clearing in the dots, its edge ragged in dither order (the hero's scroll cue sits in it)
  ' vec3 fin=mix(col,outside,smoothstep(-1.,1.,sd));',
  ' if(hole.z>0.){ float hc=3.*px; vec2 h3=(floor(fc/hc)+.5)*hc; float hd=length(vec2(h3.x,r.y-h3.y)-hole.xy);',
  '  fin=mix(fin,cG,step(hd+bayer(floor(fc/hc))*hole.z*.4,hole.z)); }',
  ' gl_FragColor=vec4(fin,1.); }',
].join('\n');

// pictures: the wall, then SRC (q 1… 5)
export function Painter(canvas, wall, sources) {
  const P = glProgram(canvas, PAINTER_FRAG);
  if (!P) return null;
  const gl = P.gl;
  const U = P.uniforms(['r', 't', 'wall', 'a', 'b', 'tw', 'ta', 'tb', 'aw', 'pp', 'win', 'rad', 'outVis', 'px', 'dim', 'shade', 'shadeV', 'pan', 'clear', 'mask', 'mk', 'hole']);
  const self = { clear: 0, mask: null, mk: 0, hole: [0, 0, 0], q: 0, win: [0, 0, 0, 0], rad: 0, outVis: 1, dim: 1, shade: 0, shadeV: 0, pan: .5, ready: false, onready: null };
  let T = [], S = [], maskTex = null;
  loadAll([wall].concat(sources), (ims) => uploadAll(P, ims, (texs) => {
    T = texs; S = ims.map((im) => [im.width, im.height]);
    self.ready = true;
    if (self.onready) self.onready();
    self.invalidate();
    self.drift();
  }));
  const n = sources.length, t0 = performance.now();
  self.draw = () => {
    if (!self.ready) return;
    if (self.mask && !maskTex) maskTex = P.tex(self.mask);   // before the pictures are bound (tex() uses unit 0)
    P.size(canvas.clientWidth, canvas.clientHeight);
    // q < 1: the wall dissolving into the first picture; above: picture ai into ai + 1
    const q = Math.max(0, Math.min(n, self.q));
    let ai, bi, aw = 0, pp;
    if (q < 1) { aw = 1; ai = 0; bi = 0; pp = q; } else { ai = Math.min(Math.floor(q) - 1, n - 2); bi = ai + 1; pp = q - 1 - ai; }
    P.bind(0, T[0]); P.bind(1, T[ai + 1]); P.bind(2, T[bi + 1]);
    gl.uniform1i(U.wall, 0); gl.uniform1i(U.a, 1); gl.uniform1i(U.b, 2); gl.uniform1f(U.clear, self.clear);
    gl.uniform2f(U.r, canvas.width, canvas.height); gl.uniform1f(U.t, still ? 20 : (performance.now() - t0) / 1000 + 20);
    gl.uniform2fv(U.tw, S[0]); gl.uniform2fv(U.ta, S[ai + 1]); gl.uniform2fv(U.tb, S[bi + 1]);
    gl.uniform1f(U.aw, aw); gl.uniform1f(U.pp, pp);
    gl.uniform4f(U.win, self.win[0] * dpr, self.win[1] * dpr, self.win[2] * dpr, self.win[3] * dpr);
    gl.uniform1f(U.rad, self.rad * dpr); gl.uniform1f(U.outVis, self.outVis); gl.uniform1f(U.px, dpr);
    gl.uniform1f(U.dim, self.dim); gl.uniform1f(U.shade, self.shade); gl.uniform1f(U.shadeV, self.shadeV); gl.uniform1f(U.pan, self.pan);
    if (maskTex) { P.bind(3, maskTex); gl.uniform1i(U.mask, 3); }
    gl.uniform1f(U.mk, maskTex ? self.mk : 0);
    gl.uniform3f(U.hole, self.hole[0] * dpr, self.hole[1] * dpr, self.hole[2] * dpr);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
  };
  // the wall drifts, so once its pictures are in, every frame is drawn while it is on screen; before that (and with
  // reduced motion, where it stands still) a frame is drawn when something changes. paused (set by the page while the
  // wall can't be seen, the phone's hero): no drift, a frame only when something changes
  let vis = true, drifting = false, queued = false;
  self.paused = false;
  new IntersectionObserver((es) => { vis = es[0].isIntersecting; }).observe(canvas);
  self.invalidate = () => {
    if ((drifting && !self.paused) || queued) return;
    queued = true;
    requestAnimationFrame(() => { queued = false; self.draw(); });
  };
  self.drift = () => {
    if (drifting || still) return;
    drifting = true;
    (function loop() { if (vis && !document.hidden && !self.paused) self.draw(); requestAnimationFrame(loop); })();
  };
  return self;
}

const MORPH_FRAG = [
  'precision highp float;', COLOURS_GLSL, BAYER_GLSL,
  'uniform vec2 r; uniform float p; uniform float px; uniform float pan; uniform sampler2D a; uniform sampler2D b; uniform vec2 ta; uniform vec2 tb;',
  'vec2 cover(vec2 uv, vec2 ts){ float s=max(r.x/ts.x,r.y/ts.y); vec2 size=ts*s; vec2 off=vec2((r.x-size.x)*pan, r.y-size.y); return (uv*r-off)/size; }',
  'void main(){ vec2 fc=gl_FragCoord.xy; vec2 uv=fc/r; vec2 ci=floor(fc/px); vec2 cc=(ci+.5)*px/r;',
  ' float k=step(bayer(ci)+.001,p);',
  ' vec3 col=mix(texture2D(a,cover(uv,ta)).rgb,texture2D(b,cover(uv,tb)).rgb,k);',
  ' vec3 cs=mix(texture2D(a,cover(cc,ta)).rgb,texture2D(b,cover(cc,tb)).rgb,k);',
  ' float l=pow(dot(cs,vec3(.299,.587,.114)),.8)*1.25;',
  ' float on=step(bayer(ci+vec2(2.,1.))+.5/64.,l); float d=length(fract(fc/px)-.5); float dm=smoothstep(.52,.36,d);',
  ' vec3 dotted=mix(cG,mix(cU,cD,on),dm);',
  ' float s=sin(3.14159*p); gl_FragColor=vec4(mix(col,dotted,smoothstep(.04,.55,s)),1.); }',
].join('\n');

// rest: the share of each step spent on a whole picture at either end
export function Morph(box, sources, rest) {
  const canvas = box.querySelector('canvas.gl'), P = glProgram(canvas, MORPH_FRAG);
  const self = { f: 0, pan: .5, ok: false, set() {} };
  if (!P) return self;
  const gl = P.gl, U = P.uniforms(['r', 'p', 'px', 'pan', 'a', 'b', 'ta', 'tb']);
  let texs = [], sizes = [], bw = 0, bh = 0;
  // the pictures load when the box comes near (until then the still image shows)
  whenNear(box, () => loadAll(sources, (ims) => uploadAll(P, ims, (t) => {
    texs = t; sizes = ims.map((im) => [im.width, im.height]);
    self.ok = true; box.classList.add('has-gl'); draw();
  })));
  // the box may grow to fill the screen: render at the grown size
  function measure() {
    const w = box.offsetWidth, h = box.offsetHeight;
    const big = box.dataset.grow ? Math.max(window.innerWidth / w, window.innerHeight / h) : 1;
    bw = w * big; bh = h * big;
  }
  function draw() {
    if (!self.ok) return;
    if (!bw) measure();
    P.size(bw, bh);
    const f = Math.max(0, Math.min(sources.length - 1, self.f)), i = Math.min(sources.length - 2, Math.floor(f)), seg = f - i;
    let p = seg < rest ? 0 : seg > 1 - rest ? 1 : (seg - rest) / (1 - 2 * rest);
    p = p * p * (3 - 2 * p);
    P.bind(0, texs[i]); P.bind(1, texs[i + 1]);
    gl.uniform1i(U.a, 0); gl.uniform1i(U.b, 1); gl.uniform2fv(U.ta, sizes[i]); gl.uniform2fv(U.tb, sizes[i + 1]);
    gl.uniform2f(U.r, canvas.width, canvas.height); gl.uniform1f(U.px, Math.round(7 * dpr * (bw / box.offsetWidth)));
    gl.uniform1f(U.p, p); gl.uniform1f(U.pan, self.pan);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
  }
  self.set = (f) => { self.f = f; draw(); };
  window.addEventListener('resize', () => { bw = 0; draw(); });
  return self;
}
