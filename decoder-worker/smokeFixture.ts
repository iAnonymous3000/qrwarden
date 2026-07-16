export const SMOKE_TEXT = "QRWarden decoder smoke";

const MODULES = Object.freeze([
  "#######.###.##.##.#######",
  "#.....#.......#...#.....#",
  "#.###.#...#.#.###.#.###.#",
  "#.###.#.###..####.#.###.#",
  "#.###.#.##.#..##..#.###.#",
  "#.....#.######....#.....#",
  "#######.#.#.#.#.#.#######",
  "........##.#..#.#........",
  "#...#.####.##...######..#",
  "#..#.....#.#..###...##.##",
  "###..####..#.###.........",
  ".#.....###.#..##.#....###",
  "##.#######.......###..#.#",
  "###.##.#....#.###..##..##",
  "..###.#..#####.##...#.#..",
  "....#......#..##...##.#..",
  "###...#..#..#...#######.#",
  "........#.#..##.#...#..##",
  "#######.#.#...#.#.#.##...",
  "#.....#...#.#.#.#...#.###",
  "#.###.#.##.#.##.#####.###",
  "#.###.#..##.#.######.#.##",
  "#.###.#..######..###.###.",
  "#.....#..###.#.#.#.#..##.",
  "#######.#...##.#.#..#.###",
] as const);

const QUIET_ZONE_MODULES = 4;
const PIXELS_PER_MODULE = 4;

/** A bundled Version 2 QR fixture; it performs no fetch and needs no asset URL. */
export function createSmokeFixture(): ImageData {
  const moduleCount = MODULES.length + QUIET_ZONE_MODULES * 2;
  const size = moduleCount * PIXELS_PER_MODULE;
  const pixels = new Uint8ClampedArray(size * size * 4);
  pixels.fill(0xff);

  for (let moduleY = 0; moduleY < MODULES.length; moduleY += 1) {
    const row = MODULES[moduleY]!;
    for (let moduleX = 0; moduleX < row.length; moduleX += 1) {
      if (row[moduleX] !== "#") continue;
      const startX = (moduleX + QUIET_ZONE_MODULES) * PIXELS_PER_MODULE;
      const startY = (moduleY + QUIET_ZONE_MODULES) * PIXELS_PER_MODULE;
      for (let y = 0; y < PIXELS_PER_MODULE; y += 1) {
        for (let x = 0; x < PIXELS_PER_MODULE; x += 1) {
          const pixel = ((startY + y) * size + startX + x) * 4;
          pixels[pixel] = 0;
          pixels[pixel + 1] = 0;
          pixels[pixel + 2] = 0;
        }
      }
    }
  }

  return new ImageData(pixels, size, size);
}
