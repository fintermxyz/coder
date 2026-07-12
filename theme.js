// theme.js — 256-color styling helpers for a rich terminal UI.

const ESC = "\x1b[";
export const RESET = ESC + "0m";
export const BOLD = ESC + "1m";
export const DIM = ESC + "2m";
export const ITALIC = ESC + "3m";

const fg = (n) => `${ESC}38;5;${n}m`;
const bg = (n) => `${ESC}48;5;${n}m`;

// Palette (xterm-256).
export const T = {
  accent:  fg(141), // soft purple
  accent2: fg(213), // pink/magenta
  cyan:    fg(45),
  teal:    fg(43),
  green:   fg(42),
  blue:    fg(75),
  yellow:  fg(221),
  orange:  fg(215),
  red:     fg(203),
  gray:    fg(245),
  faint:   fg(240),
  white:   fg(255),
  userc:   fg(80),
  onAccent: bg(54) + fg(231), // text on a purple band
};

// Wrap a string in any number of codes and reset.
export const s = (str, ...codes) => codes.join("") + str + RESET;

const cols = () => process.stdout.columns || 80;

// Visible width (ignores ANSI escape sequences).
export const vlen = (str) => str.replace(/\x1b\[[0-9;]*m/g, "").length;

// A horizontal rule with an optional left-aligned label.
export function rule(label = "", color = T.faint) {
  const width = Math.min(cols(), 78);
  if (!label) return s("─".repeat(width), color);
  const text = ` ${label} `;
  const left = 2;
  const right = Math.max(0, width - left - vlen(text));
  return (
    s("─".repeat(left), color) +
    s(text, T.accent, BOLD) +
    s("─".repeat(right), color)
  );
}

// A left-bar styled block: an accent vertical bar with a heading and body lines.
export function bar(heading, bodyLines = [], color = T.accent) {
  const out = [];
  out.push(s("┃ ", color) + s(heading, BOLD, T.white));
  for (const line of bodyLines) out.push(s("┃ ", color) + line);
  return out.join("\n");
}

// A rounded box around content lines (content may contain ANSI; width is by vlen).
export function box(lines, color = T.accent, pad = 1) {
  const inner = Math.min(
    Math.max(...lines.map(vlen), 1) + pad * 2,
    cols() - 2,
  );
  const top = s("╭" + "─".repeat(inner) + "╮", color);
  const bot = s("╰" + "─".repeat(inner) + "╯", color);
  const body = lines.map((l) => {
    const gap = Math.max(0, inner - pad * 2 - vlen(l));
    return (
      s("│", color) + " ".repeat(pad) + l + " ".repeat(gap + pad) + s("│", color)
    );
  });
  return [top, ...body, bot].join("\n");
}
