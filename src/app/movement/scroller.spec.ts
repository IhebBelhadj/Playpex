import { alignedScroll, Clock, easeOutCubic, maxScroll, Scroller, Viewport } from './scroller';

describe('movement scroller', () => {

  // a 1000px wide row of 2000px content, 10px padding each side
  const view = (scroll = 0):Viewport => ({ scroll, size: 1000, content: 2000, padStart: 10, padEnd: 10 });

  describe('alignedScroll', () => {
    it("'start' puts the item at the padding edge", () => {
      expect(alignedScroll(view(), { start: 500, size: 180 }, 'start')).toBe(490);
    });

    it("'third' puts the item about a third in", () => {
      expect(alignedScroll(view(), { start: 1000, size: 100 }, 'third')).toBe(700);
    });

    it("'nearest' scrolls only when the item is cut", () => {
      expect(alignedScroll(view(300), { start: 500, size: 180 }, 'nearest')).toBe(300);
      expect(alignedScroll(view(300), { start: 1250, size: 180 }, 'nearest')).toBe(440);
      expect(alignedScroll(view(300), { start: 200, size: 180 }, 'nearest')).toBe(190);
    });

    it('clamps to what the container can scroll', () => {
      expect(alignedScroll(view(), { start: 1900, size: 100 }, 'start')).toBe(1000);
      expect(alignedScroll(view(), { start: 5, size: 100 }, 'start')).toBe(0);
      expect(maxScroll({ scroll: 0, size: 500, content: 300, padStart: 0, padEnd: 0 })).toBe(0);
    });
  });

  it('easeOutCubic runs from 0 to 1', () => {
    expect(easeOutCubic(0)).toBe(0);
    expect(easeOutCubic(1)).toBe(1);
    expect(easeOutCubic(.5)).toBeGreaterThan(.5);
  });

  describe('tween', () => {
    let time:number;
    let frames:Map<number, (t:number) => void>;
    let nextId:number;
    let scroller:Scroller;
    let container:HTMLElement;

    const clock:Clock = {
      now: () => time,
      frame: cb => { frames.set(++nextId, cb); return nextId; },
      cancel: id => { frames.delete(id); },
    };
    const tick = (ms:number) => {
      time += ms;
      let pending = Array.from(frames.values());
      frames.clear();
      pending.forEach(cb => cb(time));
    };

    beforeEach(() => {
      time = 0;
      frames = new Map();
      nextId = 0;
      scroller = new Scroller();
      scroller.clock = clock;
      container = document.createElement('div');
      container.style.cssText = 'width:200px;height:50px;overflow:auto;position:absolute;left:-9999px';
      container.innerHTML = '<div style="width:5000px;height:10px"></div>';
      document.body.appendChild(container);
    });

    afterEach(() => container.remove());

    it('glides to the target and stops', () => {
      scroller.scrollTo(container, { left: 1000 });
      expect(container.scrollLeft).toBe(0);
      tick(100);
      let mid = container.scrollLeft;
      expect(mid).toBeGreaterThan(0);
      expect(mid).toBeLessThan(1000);
      tick(300);
      expect(container.scrollLeft).toBe(1000);
      expect(scroller.isAnimating(container)).toBeFalse();
    });

    it('re-targets a running tween from where it is (no jump back, no queue)', () => {
      scroller.scrollTo(container, { left: 1000 });
      tick(100);
      let before = container.scrollLeft;
      scroller.scrollTo(container, { left: 1500 });
      expect(scroller.targetOf(container, 'left')).toBe(1500);
      tick(16);
      expect(container.scrollLeft).toBeGreaterThanOrEqual(before);
      tick(400);
      expect(container.scrollLeft).toBe(1500);
    });

    it('scrolls instantly when asked', () => {
      scroller.scrollTo(container, { left: 700 }, { instant: true });
      expect(container.scrollLeft).toBe(700);
      expect(frames.size).toBe(0);
    });

    it('stops when the user takes over with the wheel', () => {
      scroller.scrollTo(container, { left: 1000 });
      tick(50);
      container.dispatchEvent(new WheelEvent('wheel'));
      expect(scroller.isAnimating(container)).toBeFalse();
    });

    it('scrollBy adds up from the running target (row paddles)', () => {
      scroller.scrollBy(container, { left: 300 });
      scroller.scrollBy(container, { left: 300 });
      expect(scroller.targetOf(container, 'left')).toBe(600);
    });
  });
});
