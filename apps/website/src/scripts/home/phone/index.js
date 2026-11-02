// The phone site: its scenes on the stage, smooth scrolling (desktop only: the stage leaves touch screens alone), then
// the held intro.
import { initScenes } from './scenes.js';
import { initIntro } from './intro.js';

export function start(apps) {
  initScenes();
  window.Stage.smooth();
  window.Stage.init();
  initIntro(apps);
}
