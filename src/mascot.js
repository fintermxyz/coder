// src/mascot.js — coder's mascot: a single-color blue dolphin, drawn from one
// pixel grid so the terminal splash and the desktop GUI share the same art.

// 'B' = dolphin body (one blue), 'e' = eye, everything else transparent.
export const DOLPHIN = [
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

export const DOLPHIN_BLUE = "#3b82f6"; // single brand blue
const EYE = "#0b1220";

// Terminal: 256-color ANSI blocks (blue body, dark eye).
export function dolphinAnsi() {
  const RESET = "\x1b[0m";
  const BODY = "\x1b[38;5;33m██" + RESET; // blue
  const EYEC = "\x1b[38;5;16m██" + RESET; // near-black
  return DOLPHIN
    .map((row) => [...row].map((c) => (c === "B" ? BODY : c === "e" ? EYEC : "  ")).join(""))
    .join("\n");
}

// GUI: a crisp inline SVG built from the same grid (scales to any size).
export function dolphinSvg({ cell = 6, color = DOLPHIN_BLUE } = {}) {
  const w = DOLPHIN[0].length * cell;
  const h = DOLPHIN.length * cell;
  let rects = "";
  DOLPHIN.forEach((row, y) => {
    [...row].forEach((c, x) => {
      if (c === "B") rects += `<rect x="${x * cell}" y="${y * cell}" width="${cell}" height="${cell}" fill="${color}"/>`;
      else if (c === "e") rects += `<rect x="${x * cell}" y="${y * cell}" width="${cell}" height="${cell}" fill="${EYE}"/>`;
    });
  });
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}" shape-rendering="crispEdges">${rects}</svg>`;
}
