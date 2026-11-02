// A word in 5 × 7 dot-matrix letters, as an SVG of dots (the footer's name): the lit dots (class l) and the unlit
// ones (class u), each colour one path.
const GLYPHS: Record<string, string> = {
  P: '####.#...##...#####.#....#....#....', L: '#....#....#....#....#....#....#####', A: '.###.#...##...#######...##...##...#',
  Y: '#...##...#.#.#...#....#....#....#..', E: '######....#....####.#....#....#####', X: '#...##...#.#.#...#...#.#.#...##...#',
};

// one circle as path commands (two arcs), so each colour of dots is a single <path> (a short DOM)
const dot = (cx: number, cy: number, r = 0.4) => `M${cx - r} ${cy}a${r} ${r} 0 1 0 ${2 * r} 0a${r} ${r} 0 1 0 ${-2 * r} 0`;

export function led(text: string, cls: string): string {
  let lit = '', unlit = '';
  for (let i = 0; i < text.length; i++) {
    const g = GLYPHS[text[i]] || '';
    for (let k = 0; k < 35; k++) {
      const d = dot(i * 6 + (k % 5) + 0.5, Math.floor(k / 5) + 0.5);
      if (g[k] === '#') lit += d; else unlit += d;
    }
  }
  return `<svg class="${cls}" viewBox="0 0 ${text.length * 6 - 1} 7" aria-hidden="true"><path class="u" d="${unlit}"/><path class="l" d="${lit}"/></svg>`;
}
