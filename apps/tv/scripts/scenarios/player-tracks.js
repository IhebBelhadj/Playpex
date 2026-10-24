'use strict';

// Audio & subtitles in the player (docs/providers-plan.md step 3, §10.3): a
// file with an AAC English and an AC-3 French track, SRT English and ASS
// French subtitles inside. It starts on English, played directly (the shell's
// native audioTracks); French is converted by the server (/transcode?audio=1)
// from where the video was; English again goes back to the file itself; an
// embedded subtitle shows its cues. Then the profile's languages (Settings ›
// Playback) choose the tracks a video starts with.
// Needs a server with such a library file: PLAYPEX_TEST_REF=f_<id> --server <url>
// (a throwaway one: see the scratch script used to build it in the plan's step 3 notes).

const video = "document.querySelector('.moviePlayer')";

async function setLanguages(t, values) {
  return t.js(`(async () => {
    const api = window.playpexDev.api;
    const list = await (await fetch(api + '/profiles')).json();
    const r = await fetch(api + '/profiles/' + list.lastUsedId + '/settings', {
      method: 'PATCH', headers: { 'Content-Type': 'application/json', 'X-Playpex-Device': window.playpexDev.deviceId },
      body: JSON.stringify(${JSON.stringify(values)}),
    });
    return r.status;
  })()`);
}

async function openTracks(t) {
  await t.key('Down');
  await t.until(`document.querySelector('.player.controlsShown')`, 3000);
  await t.click('[data-px-key="tracks"]');
  return t.until("document.querySelector('#playerTracks .trackRow')", 3000);
}

function rows(column) {
  return `Array.from(document.querySelectorAll('#playerTracks .trackColumn:nth-of-type(${column}) .trackRow'))
    .map(r => (r.classList.contains('selected') ? '* ' : '') + r.querySelector('.trackName').textContent.trim())`;
}

module.exports = async function (t) {
  const ref = process.env.PLAYPEX_TEST_REF;
  if (!ref) throw new Error('set PLAYPEX_TEST_REF to a media ref of a file with two audio tracks (f_…)');
  await t.dev('profile()');
  t.check('languages reset', await setLanguages(t, { 'player.audioLanguage': null, 'player.subtitleLanguage': null }) === 200);
  await t.wait(500);

  // 1. starts on the default track, directly
  await t.dev(`player(${JSON.stringify(ref)})`);
  t.check('plays', await t.until(`${video}?.currentTime > 2`, 20000));
  t.check('English, natively (the file itself, its AAC track on)', await t.js(`(() => { const v = ${video};
    return !/transcode/.test(v.src) && v.audioTracks.length == 1 && v.audioTracks[0].enabled; })()`),
    { src: await t.js(`${video}.src`) });

  // 2. the panel: two columns, the current ones marked
  t.check('Audio & subtitles opens', await openTracks(t));
  await t.wait(400);
  t.check('audio column', JSON.stringify(await t.js(rows(1))) == JSON.stringify(['* English · Mono', 'French · Mono']), await t.js(rows(1)));
  t.check('subtitles column', JSON.stringify(await t.js(rows(2))) == JSON.stringify(['* Off', 'English', 'French', 'Find subtitles…']), await t.js(rows(2)));
  t.check('focus on the current audio track', (await t.focused()).key == 'a:0', await t.focused());
  await t.shot('player-tracks');

  // 3. French: converted, from where it was
  const before = await t.js(`${video}.currentTime`);
  await t.key('Down');
  await t.key('Return');
  t.check('French: the server converts it (?audio=1)', await t.until(`/transcode/.test(${video}.src) && /audio=1/.test(${video}.src)`, 5000),
    { src: await t.js(`${video}.src`) });
  t.check('… and plays on from about there', await t.until(`${video}.currentTime > 0.5`, 15000));
  const position = await t.js("Number(document.querySelector('.times .now')?.textContent.split(':').pop())");
  t.check('… not from the start', position >= Math.floor(before) - 3, { before, position });

  // 4. English again: the file itself
  await t.key('Up');
  await t.key('Return');
  t.check('English again: direct play', await t.until(`!/transcode/.test(${video}.src) && ${video}.currentTime > ${Math.max(0, before - 3)}`, 10000),
    { src: await t.js(`${video}.src`), time: await t.js(`${video}.currentTime`) });

  // 5. a subtitle inside the file
  await t.key('Right');
  t.check('→ the subtitles column, on Off', (await t.focused()).key == 'off', await t.focused());
  await t.key('Down');
  await t.key('Return');
  t.check('English subtitles: from the file', await t.until(`(() => { const tr = ${video}.querySelector('track');
    return tr && /subtitles\\/embedded\\/0/.test(tr.src) && ${video}.textTracks[0]?.cues?.length > 0; })()`, 8000));
  await t.key('Escape');
  t.check('Back closes the panel', await t.until("!document.querySelector('#playerTracks')", 2000));

  // 6. the profile's languages choose the tracks a video starts with
  await t.dev("input('back')");
  await t.dev("input('back')");
  await t.until("window.playpexDev.screen() != 'core.player'", 5000);
  t.check('French chosen in the settings', await setLanguages(t, { 'player.audioLanguage': 'fr', 'player.subtitleLanguage': 'fr' }) === 200);
  await t.wait(800);
  await t.dev(`player(${JSON.stringify(ref)})`);
  t.check('starts converted on French', await t.until(`/transcode/.test(${video}?.src || '') && /audio=1/.test(${video}.src)`, 15000),
    { src: await t.js(`${video}?.src`) });
  t.check('… with the French subtitles on', await t.until(`/subtitles\\/embedded\\/1/.test(${video}.querySelector('track')?.src || '')`, 8000));
  await t.dev("input('back')");
  await t.dev("input('back')");
  await setLanguages(t, { 'player.audioLanguage': null, 'player.subtitleLanguage': null });
};
