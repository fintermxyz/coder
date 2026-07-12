// Terminal output helpers for warnings, errors, and info messages.

import { s, T } from "../theme.js";

export const warn = (m) => process.stdout.write(s(`▲ ${m}\n`, T.yellow));
export const err  = (m) => process.stdout.write(s(`✖ ${m}\n`, T.red));
export const info = (m) => process.stdout.write(s(`${m}\n`, T.faint));
