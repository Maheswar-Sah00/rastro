// The Rastro mark: a bull's head drawn on a pixel grid. One pixel, one head of cattle.
// Shared by the header logo, the favicon and the herd assembly scene.

export const BULL = [
  'X.........X',
  'XX.......XX',
  '.XXXXXXXXX.',
  'XXXXXXXXXXX',
  '..XXXXXXX..',
  '..XXXXXXX..',
  '...XXXXX...',
  '...XXXXX...',
  '....XXX....',
];

export const BULL_W = BULL[0].length;
export const BULL_H = BULL.length;

/** Filled cells as [col, row]. */
export const BULL_CELLS: [number, number][] = BULL.flatMap((row, y) =>
  [...row].flatMap((c, x) => (c === 'X' ? [[x, y] as [number, number]] : [])),
);
