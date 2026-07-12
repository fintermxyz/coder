// src/browser.js — headless Chromium via Playwright: page text extraction + screenshots.
// Lazy-loads playwright so non-browser usage has zero startup cost.

import { state } from "./state.js";

const CHROMIUM = process.env.CHROMIUM_PATH || "/usr/bin/chromium";
const TIMEOUT  = Number(process.env.BROWSE_TIMEOUT) || 25000;
const TEXT_CAP = 6000;

async function launch() {
  const { chromium } = await import("playwright");
  return chromium.launch({
    executablePath: CHROMIUM,
    args: [
      "--no-sandbox",
      "--disable-setuid-sandbox",
      "--disable-gpu",
      "--disable-dev-shm-usage",
      "--single-process",
    ],
  });
}

export async function browsePage(url) {
  const browser = await launch();
  try {
    const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: TIMEOUT });

    const title = await page.title();

    const text = await page.evaluate(() => {
      for (const el of document.querySelectorAll("script,style,nav,footer,aside,iframe"))
        el.remove();
      return (document.body?.innerText || "").replace(/\n{3,}/g, "\n\n").trim();
    });

    const buf = await page.screenshot({ type: "png", fullPage: false });
    return {
      url,
      title,
      text: text.length > TEXT_CAP ? text.slice(0, TEXT_CAP) + "\n…(truncated)" : text,
      screenshotB64: buf.toString("base64"),
    };
  } finally {
    await browser.close();
  }
}

// Ask the current provider to visually describe the screenshot.
// Returns null silently if the model doesn't support vision.
async function describeScreenshot(b64, url) {
  if (!state.provider?.queryVision) return null;
  try {
    return await state.provider.queryVision(
      b64,
      "image/png",
      `This is a screenshot of: ${url}\n` +
      "Describe the main content, any visible errors or warnings, key UI elements, " +
      "and information relevant to a developer. Be concise.",
    );
  } catch {
    return null;
  }
}

export async function browse(url) {
  const { title, text, screenshotB64 } = await browsePage(url);
  const visual = await describeScreenshot(screenshotB64, url);

  const parts = [`Page: ${title}`, `URL: ${url}`, ""];
  if (visual) parts.push("Visual description:", visual, "");
  parts.push("Text content:", text);
  return parts.join("\n");
}
