// The desktop site's scroll scenes (scripts/stage.js): the screens (server → TV → title → resume → playing, the
// picture growing to the whole screen at the end), held while you scroll with a snap at each, and the rooms (what
// the server does), a track moving by whole rooms.
import '../../stage.js';
import { Morph } from '../gl.js';
import { IMG, LOOP } from '../assets.js';

const { Stage, Scenes } = window;

export function initScenes() {
  const box = document.getElementById('screens-screen'), video = box.querySelector('video'), scrim = box.querySelector('.scrim');
  box.dataset.grow = '1';
  const morph = Morph(box, [IMG.s_dashlib, IMG.s_tvlib, IMG.s_sintel, IMG.s_resume, IMG.s_player], .18);
  let playing = false;
  function play(on) {
    if (on === playing) return;
    playing = on;
    if (!on) { video.pause(); return; }
    if (!video.src) { video.poster = IMG.loopposter; video.src = LOOP; }
    video.play().catch(() => {});
  }

  Scenes.screens = (root) => Stage.scene(root, {
    hold: 4, beats: 5, snap: [0, .25, .5, .75, 1],
    build(tl, ctx) {
      const st = { f: 0 }, beats = ctx.q('.beat'), stage = ctx.stage, wrap = stage.querySelector('.sc-wrap');
      // the transform that makes the picture cover the whole stage
      function grow() {
        const x0 = wrap.offsetLeft + box.offsetLeft, y0 = wrap.offsetTop + box.offsetTop, w = box.offsetWidth, h = box.offsetHeight;
        const s = Math.max(stage.clientWidth / w, stage.clientHeight / h);
        return { x: (stage.clientWidth - w * s) / 2 - x0, y: (stage.clientHeight - h * s) / 2 - y0, s };
      }
      tl.to(st, { f: 4, duration: .76, onUpdate() { morph.set(st.f); } }, 0);
      // the words change half-way between two pictures; the last one waits for the picture to settle
      for (let i = 1; i < 5; i++) {
        const t = (i - .5) / 4 * .76 + (i === 4 ? .1 : 0);
        tl.to(beats[i - 1], { autoAlpha: 0, y: -24, duration: .05 }, t)
          .fromTo(beats[i], { autoAlpha: 0, y: 24 }, { autoAlpha: 1, y: 0, duration: .05 }, t + .04);
      }
      tl.to(box, { x: () => grow().x, y: () => grow().y, scale: () => grow().s, borderRadius: 0, duration: .14 }, .8)
        .to(scrim, { autoAlpha: 1, duration: .06 }, .9)
        .to(video, { autoAlpha: 1, duration: .05, onStart: () => play(true), onReverseComplete: () => play(false) }, .94);
    },
  });

  Scenes.rooms = (root) => {
    const track = root.querySelector('.rooms'), count = root.querySelectorAll('.rooms-count i'), rooms = track.querySelectorAll('.room');
    return Stage.scene(root, {
      hold: 3, snap: [0, 1 / 3, 2 / 3, 1],
      onUpdate(p) {
        const k = Math.round(p * 3);
        count.forEach((c, i) => c.classList.toggle('on', i === k));
        rooms.forEach((r, i) => r.classList.toggle('cur', i === k));
      },
      // every stop centres one room: the track moves by whole rooms
      build(tl, ctx) {
        const step = () => rooms[1].offsetLeft - rooms[0].offsetLeft;
        const first = () => (ctx.stage.clientWidth - rooms[0].offsetWidth) / 2 - rooms[0].offsetLeft;
        tl.fromTo(track, { x: () => first() }, { x: () => first() - step() * (rooms.length - 1), duration: 1 }, 0);
      },
    });
  };
}
