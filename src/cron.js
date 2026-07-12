// src/cron.js — manage user crontab entries created by ai-shell.

import fsp from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { execCommand } from "./exec.js";

const MARKER = "# ai-shell";

async function readCrontab() {
  const { output } = await execCommand("crontab -l 2>/dev/null || true");
  return output || "";
}

async function writeCrontab(content) {
  const tmp = path.join(os.tmpdir(), `crontab-${Date.now()}.txt`);
  await fsp.writeFile(tmp, content.trimEnd() + "\n");
  const { code, output } = await execCommand(`crontab ${tmp}`);
  await fsp.unlink(tmp).catch(() => {});
  if (code !== 0) throw new Error(`crontab write failed: ${output}`);
}

function stripEntry(raw, name) {
  const lines = raw.split("\n");
  const out = [];
  let skip = false;
  for (const line of lines) {
    if (line === `${MARKER} name=${name}`) { skip = true; continue; }
    if (skip) { skip = false; continue; } // skip the actual cron line too
    out.push(line);
  }
  return out.join("\n");
}

export async function listCronJobs() {
  const raw = await readCrontab();
  const jobs = [];
  const lines = raw.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(/^# ai-shell name=(.+)$/);
    if (m && lines[i + 1]) {
      jobs.push({ name: m[1].trim(), entry: lines[i + 1].trim() });
    }
  }
  return jobs;
}

export async function addCronJob(name, schedule, cmd) {
  const raw = await readCrontab();
  const cleaned = stripEntry(raw, name);
  const block = `${MARKER} name=${name}\n${schedule} ${cmd}`;
  await writeCrontab(cleaned.trimEnd() + "\n" + block);
}

export async function removeCronJob(name) {
  const raw = await readCrontab();
  await writeCrontab(stripEntry(raw, name));
}

export function formatCronList(jobs) {
  if (!jobs.length) return "(no ai-shell cron jobs scheduled)";
  return jobs.map((j) => `  ${j.name.padEnd(20)} ${j.entry}`).join("\n");
}
