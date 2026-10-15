import { columnLines, gridLines, gridStep, nearestOnAxis, Slot, stepIndex, visibleFraction } from './moves';

describe('movement moves', () => {

  describe('stepIndex', () => {
    it('steps by index inside the list', () => {
      expect(stepIndex(5, 2, 1)).toBe(3);
      expect(stepIndex(5, 2, -1)).toBe(1);
    });

    it('returns -1 past the ends (the library takes over)', () => {
      expect(stepIndex(5, 4, 1)).toBe(-1);
      expect(stepIndex(5, 0, -1)).toBe(-1);
    });

    it('wraps around when asked', () => {
      expect(stepIndex(5, 4, 1, true)).toBe(0);
      expect(stepIndex(5, 0, -1, true)).toBe(4);
    });

    it('handles empty lists and unknown entries', () => {
      expect(stepIndex(0, 0, 1)).toBe(-1);
      expect(stepIndex(3, -1, 1)).toBe(-1);
    });
  });

  // 3 columns of 100×40 with 10px gaps; the last line has one item
  const grid:Slot[] = [0, 1, 2, 3, 4, 5, 6].map(i => ({ x: (i % 3) * 110, y: Math.floor(i / 3) * 50, w: 100, h: 40 }));

  describe('gridLines', () => {
    it('groups entries by their top', () => {
      expect(gridLines(grid)).toEqual([[0, 1, 2], [3, 4, 5], [6]]);
    });

    it('tolerates small differences of top', () => {
      let slots = [{ x: 0, y: 0, w: 10, h: 10 }, { x: 20, y: 2, w: 10, h: 10 }, { x: 0, y: 30, w: 10, h: 10 }];
      expect(gridLines(slots)).toEqual([[0, 1], [2]]);
    });

    it('columnLines chunks a fixed number of columns', () => {
      expect(columnLines(7, 3)).toEqual([[0, 1, 2], [3, 4, 5], [6]]);
      expect(columnLines(3, 1)).toEqual([[0], [1], [2]]);
    });
  });

  describe('gridStep', () => {
    const lines = gridLines(grid);

    it('moves sideways within a line and stops at its ends', () => {
      expect(gridStep(grid, lines, 4, 'right')).toBe(5);
      expect(gridStep(grid, lines, 5, 'right')).toBe(-1);
      expect(gridStep(grid, lines, 3, 'left')).toBe(-1);
    });

    it('moves up / down to the nearest entry of the next line', () => {
      expect(gridStep(grid, lines, 1, 'down')).toBe(4);
      expect(gridStep(grid, lines, 4, 'up')).toBe(1);
      // the short last line: the nearest one
      expect(gridStep(grid, lines, 5, 'down')).toBe(6);
      expect(gridStep(grid, lines, 6, 'down')).toBe(-1);
      expect(gridStep(grid, lines, 0, 'up')).toBe(-1);
    });

    it('works for a one-column list', () => {
      let list = [0, 1, 2].map(i => ({ x: 0, y: i * 100, w: 600, h: 90 }));
      let one = gridLines(list);
      expect(gridStep(list, one, 1, 'down')).toBe(2);
      expect(gridStep(list, one, 1, 'left')).toBe(-1);
    });
  });

  it('nearestOnAxis picks the closest centre, the first on ties', () => {
    expect(nearestOnAxis(grid, [0, 1, 2], 160, 'x')).toBe(1);
    expect(nearestOnAxis(grid, [0, 1], 105, 'x')).toBe(0);
  });

  it('visibleFraction measures the part inside the viewport', () => {
    expect(visibleFraction(0, 100, 0, 500)).toBe(1);
    expect(visibleFraction(450, 100, 0, 500)).toBe(.5);
    expect(visibleFraction(600, 100, 0, 500)).toBe(0);
  });
});
