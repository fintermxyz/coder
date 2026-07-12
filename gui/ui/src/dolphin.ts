// The blue dolphin mascot, rendered from the same grid as src/mascot.js.
const DOLPHIN = [
  "............BBB...",
  ".......BB..BBBBB..",
  "......BBBBBBBBBBBBB",
  "....BBBBBBBBBBBeBB.",
  "..BBBBBBBBBBBBBBBB.",
  "BBB.BBBBBBBBBBBB...",
  "BB..BBBBBBBBBB.....",
  "BBB..BBBBBBB......",
  "....BB...BB.......",
];

export function dolphinSvg(cell = 6, color = "#3b82f6"): string {
  const w = DOLPHIN[0].length * cell;
  const h = DOLPHIN.length * cell;
  let r = "";
  DOLPHIN.forEach((row, y) => {
    [...row].forEach((c, x) => {
      if (c === "B") r += `<rect x="${x * cell}" y="${y * cell}" width="${cell}" height="${cell}" fill="${color}"/>`;
      else if (c === "e") r += `<rect x="${x * cell}" y="${y * cell}" width="${cell}" height="${cell}" fill="#0b1220"/>`;
    });
  });
  return `<svg width="${w}" height="${h}" viewBox="0 0 ${w} ${h}" shape-rendering="crispEdges">${r}</svg>`;
}
