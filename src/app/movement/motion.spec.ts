import { TransformMotion } from './motion';

describe('movement TransformMotion', () => {
  let motion:TransformMotion;
  let host:HTMLElement;

  // a 300×100 clipping host whose track holds 2000×400 of content
  const build = (withTrack:boolean) => {
    host = document.createElement('div');
    host.style.cssText = 'position:absolute;left:-9999px;top:0;width:300px;height:100px';
    host.innerHTML = withTrack
      ? '<div class="overlay"></div><div pxTrack><div style="width:2000px;height:400px"></div></div>'
      : '<div style="width:2000px;height:20px"></div>';
    document.body.appendChild(host);
    motion = new TransformMotion();
    motion.attach(host, ['left', 'top']);
  };

  afterEach(() => host.remove());

  it('translates the pxTrack child and lets the host clip', () => {
    build(true);
    let track = host.querySelector('[pxTrack]') as HTMLElement;
    expect(motion.trackOf(host)).toBe(track);
    expect(host.classList).toContain('px-clip');
    motion.moveTo(host, { top: 120 }, { instant: true });
    expect(track.style.transform).toBe('translate3d(0px, -120px, 0px)');
    expect(motion.offset(host, 'top')).toBe(120);
  });

  it('translates the host itself when it has no track (a row)', () => {
    build(false);
    expect(motion.trackOf(host)).toBe(host);
    expect(host.classList).not.toContain('px-clip');
    motion.moveTo(host, { left: 500 });
    expect(host.style.transform).toBe('translate3d(-500px, 0px, 0px)');
    expect(host.style.transition).toContain('transform');
  });

  it('measures the content in offsets, wherever the track is', () => {
    build(true);
    motion.moveTo(host, { left: 700 }, { instant: true });
    let view = motion.viewport(host, 'left');
    expect(view.scroll).toBe(700);
    expect(view.size).toBe(300);
    expect(view.content).toBe(2000);
    expect(motion.viewport(host, 'top').content).toBe(400);
  });

  it('moveBy adds up from the target and stays within the content', () => {
    build(false);
    motion.moveBy(host, { left: 1000 });
    motion.moveBy(host, { left: 1000 });
    expect(motion.offset(host, 'left')).toBe(1700);
    motion.moveBy(host, { left: -5000 });
    expect(motion.offset(host, 'left')).toBe(0);
  });

  it('maps screen points to content coordinates', () => {
    build(true);
    motion.moveTo(host, { top: 50 }, { instant: true });
    let rect = host.getBoundingClientRect();
    let point = motion.toContent(host, rect.left + 10, rect.top + 10);
    expect(Math.round(point.x)).toBe(10);
    expect(Math.round(point.y)).toBe(60);
  });
});
