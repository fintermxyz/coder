// src/projectinfo.js — build a structured map of the current project directory.
// Sent to the model as `project_context` so it can reason about the codebase,
// suggest correct file paths, detect frameworks, and give precise debugging help.

import fsp from "node:fs/promises";
import path from "node:path";

const SKIP = new Set([
  "node_modules", ".git", ".next", ".nuxt", "dist", "build", "out",
  "__pycache__", ".venv", "venv", ".tox", "env",
  "target", "vendor", ".yarn", "coverage", ".turbo", ".cache",
  ".svelte-kit", ".expo", ".gradle", "Pods", ".idea", ".vscode",
  "tmp", "temp", "logs", ".DS_Store",
]);

// Ordered: first match wins as the primary project type.
const MANIFESTS = [
  ["package.json",    "Node.js"],
  ["deno.json",       "Deno"],
  ["pyproject.toml",  "Python"],
  ["requirements.txt","Python"],
  ["Cargo.toml",      "Rust"],
  ["go.mod",          "Go"],
  ["pom.xml",         "Java (Maven)"],
  ["build.gradle",    "Java (Gradle)"],
  ["mix.exs",         "Elixir"],
  ["Gemfile",         "Ruby"],
  ["composer.json",   "PHP"],
  ["pubspec.yaml",    "Dart/Flutter"],
];

const KB = 1024;
const MB = 1024 * KB;

export function fmtBytes(n) {
  if (n >= MB) return `${(n / MB).toFixed(1)}MB`;
  if (n >= KB) return `${Math.round(n / KB)}KB`;
  return `${n}B`;
}

async function walk(dir, cwd, depth, maxDepth) {
  const out = [];
  let ents;
  try { ents = await fsp.readdir(dir, { withFileTypes: true }); }
  catch { return out; }

  ents.sort((a, b) => {
    if (a.isDirectory() !== b.isDirectory()) return a.isDirectory() ? -1 : 1;
    return a.name.localeCompare(b.name);
  });

  for (const e of ents) {
    if (SKIP.has(e.name)) continue;
    if (depth === 0 && e.name.startsWith(".")) continue; // hide root dotfiles in tree

    const full = path.join(dir, e.name);
    const rel = path.relative(cwd, full);

    if (e.isDirectory()) {
      out.push({ rel, isDir: true, size: 0, depth });
      if (depth < maxDepth) out.push(...await walk(full, cwd, depth + 1, maxDepth));
    } else {
      let size = 0;
      try { size = (await fsp.stat(full)).size; } catch {}
      out.push({ rel, isDir: false, size, depth });
    }
  }
  return out;
}

export async function collectProjectInfo(
  maxDepth = Number(process.env.AI_SHELL_PROJECT_DEPTH) || 4,
) {
  const cwd = process.cwd();

  let projectType = "unknown";
  let manifestName = null;
  let manifestRaw = null;
  for (const [file, lang] of MANIFESTS) {
    try {
      const content = await fsp.readFile(path.join(cwd, file), "utf8");
      projectType = lang;
      manifestName = file;
      manifestRaw = content;
      break;
    } catch { /* not present */ }
  }

  const [tree, readmeRaw] = await Promise.all([
    walk(cwd, cwd, 0, maxDepth),
    fsp.readFile(path.join(cwd, "README.md"), "utf8").catch(() => null),
  ]);

  const fileNodes = tree.filter((e) => !e.isDir);
  const dirNodes  = tree.filter((e) =>  e.isDir);
  const totalSize = fileNodes.reduce((s, e) => s + e.size, 0);

  return {
    cwd,
    projectType,
    manifestName,
    manifestRaw,
    readmeSnippet: readmeRaw ? readmeRaw.slice(0, 800) : null,
    tree,
    stats: { files: fileNodes.length, dirs: dirNodes.length, totalSize },
  };
}

// Render the tree as indented text, stopping when charBudget is exhausted.
function renderTree(tree, charBudget) {
  const lines = [];
  let used = 0;
  for (const e of tree) {
    const indent = "  ".repeat(e.depth);
    const name   = path.basename(e.rel) + (e.isDir ? "/" : "");
    const tag    = e.isDir ? "" : `  [${fmtBytes(e.size)}]`;
    const line   = `${indent}${name}${tag}`;
    used += line.length + 1;
    if (used > charBudget) { lines.push(`${indent}…`); break; }
    lines.push(line);
  }
  return lines.join("\n");
}

// Format the raw info object into a system-prompt section.
// maxChars is the total character budget for the whole section.
export function formatProjectContext(info, maxChars = 10000) {
  if (!info) return "";
  const { cwd, projectType, manifestName, manifestRaw, readmeSnippet, tree, stats } = info;

  let budget = maxChars;
  const parts = [];

  const header =
    `Working directory: ${cwd}\n` +
    `Project type: ${projectType}${manifestName ? ` (${manifestName})` : ""}\n` +
    `Size: ${stats.files} files across ${stats.dirs} directories, ~${fmtBytes(stats.totalSize)}`;
  parts.push(header);
  budget -= header.length;

  if (budget > 300) {
    const treeMax = Math.min(Math.floor(budget * 0.55), 5000);
    const treeText = "\nFile tree:\n" + renderTree(tree, treeMax);
    parts.push(treeText);
    budget -= treeText.length;
  }

  if (manifestName && manifestRaw && budget > 200) {
    const cap = Math.min(Math.floor(budget * 0.50), 2500);
    const body = manifestRaw.length <= cap
      ? manifestRaw
      : manifestRaw.slice(0, cap) + "\n… (truncated)";
    const block = `\n${manifestName}:\n${body}`;
    parts.push(block);
    budget -= block.length;
  }

  if (readmeSnippet && budget > 100) {
    const cap = Math.min(budget - 20, 700);
    const snippet = readmeSnippet.length <= cap ? readmeSnippet : readmeSnippet.slice(0, cap) + "\n…";
    parts.push(`\nREADME.md (excerpt):\n${snippet}`);
  }

  return "project_context:\n" + parts.join("\n");
}
