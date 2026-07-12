// src/search.js — web search via Brave API (BRAVE_API_KEY) or DuckDuckGo HTML.

const UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 " +
  "(KHTML, like Gecko) Chrome/122.0 Safari/537.36";

// Strip HTML tags + decode the handful of entities DDG emits.
function cleanHtml(s) {
  return (s || "")
    .replace(/<[^>]+>/g, "")
    .replace(/&amp;/g, "&").replace(/&#x27;/g, "'").replace(/&#39;/g, "'")
    .replace(/&quot;/g, '"').replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&nbsp;/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

// DDG result links are redirects like //duckduckgo.com/l/?uddg=<encoded-real-url>.
function decodeDdgUrl(href) {
  const m = href.match(/[?&]uddg=([^&]+)/);
  if (m) { try { return decodeURIComponent(m[1]); } catch { /* fall through */ } }
  return href.startsWith("//") ? "https:" + href : href;
}

async function braveSearch(query, count = 6) {
  const res = await fetch(
    `https://api.search.brave.com/res/v1/web/search?q=${encodeURIComponent(query)}&count=${count}&text_decorations=false`,
    {
      headers: {
        Accept: "application/json",
        "Accept-Encoding": "gzip",
        "X-Subscription-Token": process.env.BRAVE_API_KEY,
      },
    },
  );
  if (!res.ok) throw new Error(`Brave search ${res.status}: ${await res.text()}`);
  const data = await res.json();
  return (data.web?.results || []).map((r) => ({
    title: r.title,
    url: r.url,
    snippet: r.description || "",
  }));
}

async function duckduckgoSearch(query, count = 6) {
  // POST to the HTML endpoint — the classic, scrapeable DuckDuckGo surface.
  const res = await fetch("https://html.duckduckgo.com/html/", {
    method: "POST",
    headers: {
      "User-Agent": UA,
      "Content-Type": "application/x-www-form-urlencoded",
      "Accept": "text/html,application/xhtml+xml",
    },
    body: `q=${encodeURIComponent(query)}`,
    redirect: "follow",
  });
  if (!res.ok) throw new Error(`DuckDuckGo ${res.status}`);
  const html = await res.text();

  // Snippets first (positionally aligned with result links).
  const snippets = [];
  const snipRe = /<a[^>]+class="result__snippet"[^>]*>([\s\S]*?)<\/a>/g;
  let sm;
  while ((sm = snipRe.exec(html)) !== null) snippets.push(cleanHtml(sm[1]));

  const results = [];
  const linkRe = /<a[^>]+class="result__a"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/g;
  let m, i = 0;
  while ((m = linkRe.exec(html)) !== null && results.length < count) {
    const title = cleanHtml(m[2]);
    if (title) results.push({ url: decodeDdgUrl(m[1]), title, snippet: snippets[i] || "" });
    i++;
  }
  return results;
}

export async function webSearch(query, count = 6) {
  if (process.env.BRAVE_API_KEY) return braveSearch(query, count);
  return duckduckgoSearch(query, count);
}

export function formatResults(query, results) {
  if (!results.length) {
    return `No web results for "${query}". The search returned nothing (the backend may be ` +
      `rate-limiting or unavailable right now). Do NOT retry with reworded queries — instead ` +
      `answer from your own knowledge, or tell the user web search is unavailable.`;
  }
  const lines = [`Web search results for: "${query}"\n`];
  for (const [i, r] of results.entries()) {
    lines.push(`[${i + 1}] ${r.title}`);
    lines.push(`    ${r.url}`);
    if (r.snippet) lines.push(`    ${r.snippet}`);
    lines.push("");
  }
  return lines.join("\n").trim();
}
