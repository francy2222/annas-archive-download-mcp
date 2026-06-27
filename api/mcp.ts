import type { VercelRequest, VercelResponse } from "@vercel/node";

// ─── Mirrors ─────────────────────────────────────────────────────────────────
const AA_MIRRORS = [
  "https://annas-archive.gl",
  "https://annas-archive.li",
  "https://annas-archive.se",
  "https://annas-archive.org",
];
const SCIDB_BASE = "https://annas-archive.se/scidb";   // /scidb/{doi}
const LIBGEN_HOST = "libgen.li";

// ─── Browser headers ──────────────────────────────────────────────────────────
const BROWSER: Record<string, string> = {
  "User-Agent":
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
  Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
  "Accept-Language": "en-US,en;q=0.9,it;q=0.8",
};

function sig(ms: number) { return AbortSignal.timeout(ms); }

// ─── Fetch from first working AA mirror ───────────────────────────────────────
async function fetchAA(path: string, jsonApi = false) {
  let lastErr: unknown;
  for (const mirror of AA_MIRRORS) {
    try {
      const headers: Record<string, string> = { ...BROWSER };
      if (jsonApi) headers["Accept"] = "application/json";
      const res = await fetch(`${mirror}${path}`, { headers, signal: sig(12000) });
      if (res.ok || res.status === 404) return { res, mirror };
    } catch (e) { lastErr = e; }
  }
  throw lastErr ?? new Error("All AA mirrors unreachable");
}

// ─── SEARCH ───────────────────────────────────────────────────────────────────
async function search(query: string, limit = 10, contentType = "book_any") {
  const q = new URLSearchParams({
    q: query, lang: "", content: contentType, ext: "", sort: "", page: "1",
  });
  const { res } = await fetchAA(`/dyn/api/search.json?${q}`, true);
  if (!res.ok) throw new Error(`Search API HTTP ${res.status}`);
  const data: any = await res.json();
  const items: any[] = Array.isArray(data) ? data : (data.results ?? data.hits ?? []);
  return items.slice(0, limit).map((it: any) => ({
    md5: (it.md5 ?? it.id ?? "").toLowerCase(),
    title: it.title ?? "(no title)",
    author: it.author ?? it.authors ?? "",
    year: it.year ?? "",
    language: it.language ?? "",
    format: it.extension ?? it.format ?? "",
    filesize_mb: it.filesize ? `${(Number(it.filesize)/1048576).toFixed(1)} MB` : "",
    source_library: it.source_library_name ?? it.source ?? "",
    cover: it.cover_url ?? it.cover ?? "",
  }));
}

// ─── GET DETAILS ──────────────────────────────────────────────────────────────
async function getDetails(md5: string) {
  const { res } = await fetchAA(`/dyn/api/object.json?md5=${md5.toLowerCase()}`, true);
  if (!res.ok) throw new Error(`Details API HTTP ${res.status}`);
  const d: any = await res.json();
  return {
    md5: md5.toLowerCase(),
    title: d.title ?? "",
    author: d.author ?? "",
    publisher: d.publisher ?? "",
    year: d.year ?? "",
    language: d.language ?? "",
    format: d.extension ?? d.format ?? "",
    filesize_mb: d.filesize ? `${(Number(d.filesize)/1048576).toFixed(1)} MB` : "",
    isbn: d.isbn13 ?? d.isbn ?? "",
    doi: d.doi ?? "",
    description: (d.description ?? "").slice(0, 500),
    source_library: d.source_library_name ?? d.source ?? "",
    cover: d.cover_url ?? d.cover ?? "",
  };
}

// ─── LOOKUP DOI via /scidb/ ───────────────────────────────────────────────────
// /scidb/{doi} on AA is the main DOI resolution page (like Sci-Hub but AA-hosted).
// It shows metadata + download options. We extract MD5 if present.
async function lookupDoi(doi: string) {
  const encoded = doi.replace(/^\//, "").trim();

  // Try /scidb/ page first (Anna's Archive DOI resolver)
  let md5: string | null = null;
  let scidbPageUrl = `${SCIDB_BASE}/${encoded}`;
  try {
    const res = await fetch(scidbPageUrl, { headers: BROWSER, signal: sig(12000) });
    if (res.ok) {
      const html = await res.text();
      const m = html.match(/\/md5\/([0-9a-f]{32})/i);
      if (m) md5 = m[1].toLowerCase();
    }
  } catch (_) {}

  // Fallback: search on AA
  if (!md5) {
    const results = await search(doi, 3);
    if (results.length > 0) {
      md5 = results[0].md5;
      return { doi, md5, source: "search_fallback", metadata: results[0] };
    }
    return { doi, md5: null, error: "DOI not found in Anna's Archive" };
  }

  const details = await getDetails(md5).catch(() => null);
  return { doi, md5, scidb_page: scidbPageUrl, source: "scidb", metadata: details };
}

// ─── GET DOWNLOAD LINKS ───────────────────────────────────────────────────────
// Scrapes the AA /md5/ page for slow-download links, resolves LibGen session key,
// and checks SciDB for DOI-based PDF.
async function getDownloadLinks(md5: string): Promise<any> {
  md5 = md5.toLowerCase();

  // 1. Scrape AA detail page
  const { res, mirror } = await fetchAA(`/md5/${md5}`);
  if (!res.ok) throw new Error(`AA /md5/ page HTTP ${res.status}`);
  const html = await res.text();

  // Extract all js-download-link anchors (excluding fast_download = paid)
  const slowLinks: { label: string; url: string; type: string }[] = [];
  const linkRe = /<a[^>]+class="[^"]*js-download-link[^"]*"[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi;
  let m: RegExpExecArray | null;
  while ((m = linkRe.exec(html)) !== null) {
    const href = m[1];
    if (/fast_download/i.test(href)) continue;
    const label = m[2].replace(/<[^>]+>/g, "").replace(/\s+/g, " ").trim();
    const url = href.startsWith("http") ? href : `${mirror}${href}`;
    if (!slowLinks.find(l => l.url === url)) {
      let type = "partner";
      if (/libgen/i.test(url)) type = "libgen";
      else if (/library\.lol|lib\.lol/i.test(url)) type = "library.lol";
      else if (/sci-hub|scihub/i.test(url)) type = "scihub";
      else if (/ipfs/i.test(url)) type = "ipfs";
      else if (/z-lib|zlibrary/i.test(url)) type = "zlibrary";
      else if (/archive\.org/i.test(url)) type = "internet_archive";
      slowLinks.push({ label: label || type, url, type });
    }
  }
  // Also catch bare libgen/library.lol hrefs not in js-download-link
  const altRe = /href="(https?:\/\/(?:libgen\.li|libgen\.gl|libgen\.la|libgen\.bz|library\.lol|lib\.lol)[^"]+)"/gi;
  while ((m = altRe.exec(html)) !== null) {
    const url = m[1];
    if (!slowLinks.find(l => l.url === url)) {
      const type = /libgen/.test(url) ? "libgen" : "library.lol";
      slowLinks.push({ label: type, url, type });
    }
  }

  // 2. Resolve LibGen session key (free, no API key)
  let libgen: any = null;
  try { libgen = await resolveLibgen(md5); }
  catch (e: any) { libgen = { error: e?.message ?? String(e) }; }

  // 3. Check for DOI → SciDB path
  const doiMatch = html.match(/\b(10\.\d{4,}\/[^\s"<>]+)/);
  const doi = doiMatch ? doiMatch[1].replace(/[.,;]+$/, "") : null;
  let scidb: any = null;
  if (doi) {
    try { scidb = await getScidbPdf(doi); }
    catch (e: any) { scidb = { error: e?.message ?? String(e) }; }
  }

  return {
    md5,
    mirror_used: mirror,
    aa_slow_links: slowLinks,
    libgen,
    doi: doi ?? undefined,
    scidb: scidb ?? undefined,
    summary: [
      `AA slow links: ${slowLinks.length}`,
      `LibGen: ${libgen?.error ? "not found" : "session URL ready"}`,
      doi ? `DOI detected → SciDB: ${scidb?.pdf_url ? "PDF found" : scidb?.error ?? "no PDF"}` : "no DOI",
    ].join(" | "),
  };
}

// ─── LIBGEN 2-STEP ────────────────────────────────────────────────────────────
// GET libgen.li/ads.php?md5={hash} → extract session key → return get.php URL
async function resolveLibgen(md5: string): Promise<any> {
  md5 = md5.toLowerCase();
  const adsUrl = `https://${LIBGEN_HOST}/ads.php?md5=${md5}`;
  const adsRes = await fetch(adsUrl, { headers: BROWSER, signal: sig(10000) });
  if (!adsRes.ok) throw new Error(`LibGen ads.php HTTP ${adsRes.status}`);
  const html = await adsRes.text();

  // Pattern confirmed from ball2jh/annas-archive-mcp source:
  // get.php?md5={32hex}&key={ALPHANUMERIC}
  const keyMatch = html.match(/get\.php\?md5=([0-9a-f]{32})&key=([A-Z0-9]+)/i);
  if (!keyMatch) throw new Error(`LibGen has no copy of MD5 ${md5}`);

  const key = keyMatch[2];
  const getUrl = `https://${LIBGEN_HOST}/get.php?md5=${md5}&key=${key}`;
  return {
    download_url: getUrl,
    session_key: key,
    note: "Session key is short-lived (~minutes). Open the download_url immediately in your browser.",
  };
}

// ─── SCIDB PDF RESOLVER ───────────────────────────────────────────────────────
// annas-archive.se/scidb/{DOI} → HTML page → extract PDF link
// Patterns (from PyPaperBot HTMLparsers.py):
//   1. <iframe id="pdf" src="...">            (Sci-Hub style)
//   2. <div id="plugin" src="...">
//   3. <a href="....pdf">Download</a>         (AA SciDB style)
//   4. <embed original-url="...">
async function getScidbPdf(doi: string): Promise<any> {
  const encoded = doi.replace(/^\//, "").trim();
  // Try each AA mirror for /scidb/ page
  let html = "";
  let pageUrl = "";
  for (const mirror of AA_MIRRORS) {
    try {
      pageUrl = `${mirror}/scidb/${encoded}`;
      const res = await fetch(pageUrl, { headers: BROWSER, signal: sig(12000), redirect: "follow" });
      if (res.ok) { html = await res.text(); break; }
    } catch (_) {}
  }
  if (!html) return { doi, error: "SciDB page not reachable on any mirror", page_url: pageUrl };

  // Pattern 1: <iframe id="pdf" src="...">
  let pdfUrl: string | null = null;
  const iframeM = html.match(/<iframe[^>]+id=["']pdf["'][^>]+src=["']([^"']+)["']/i)
    ?? html.match(/<iframe[^>]+src=["']([^"']+\.pdf[^"']*)["']/i);
  if (iframeM) pdfUrl = iframeM[1];

  // Pattern 2: <div/plugin id="plugin" src="...">
  if (!pdfUrl) {
    const pluginM = html.match(/id=["']plugin["'][^>]+src=["']([^"']+)["']/i);
    if (pluginM) pdfUrl = pluginM[1];
  }

  // Pattern 3: <a href="....pdf">...Download...</a>  (AA SciDB main pattern)
  if (!pdfUrl) {
    const dlM = html.match(/<a[^>]+href=["']([^"']+\.pdf)["'][^>]*>[^<]*[Dd]ownload[^<]*<\/a>/i)
      ?? html.match(/<a[^>]+href=["']([^"']+\.pdf)["']/i);
    if (dlM) pdfUrl = dlM[1];
  }

  // Pattern 4: <embed original-url="...">
  if (!pdfUrl) {
    const embedM = html.match(/<embed[^>]+original-url=["']([^"']+)["']/i);
    if (embedM) pdfUrl = embedM[1];
  }

  // Fix relative URLs
  if (pdfUrl && pdfUrl.startsWith("//")) pdfUrl = "https:" + pdfUrl;
  if (pdfUrl && pdfUrl.startsWith("/")) pdfUrl = `${AA_MIRRORS[0]}${pdfUrl}`;

  if (!pdfUrl) {
    // Check if the page itself IS the PDF redirect
    const metaRefresh = html.match(/content=["'][0-9]+;\s*url=([^"']+)["']/i);
    if (metaRefresh) pdfUrl = metaRefresh[1];
  }

  if (!pdfUrl) return {
    doi, page_url: pageUrl,
    error: "PDF link not found in SciDB page (may require login or article not available)",
  };

  return { doi, page_url: pageUrl, pdf_url: pdfUrl };
}

// ─── TOOL DEFINITIONS ─────────────────────────────────────────────────────────
const TOOLS = [
  {
    name: "search",
    description: "Search Anna's Archive (aggregates LibGen, Z-Library, Sci-Hub, Internet Archive, DuXiu, MagzDB and more). Returns MD5 hashes.",
    inputSchema: {
      type: "object", required: ["query"],
      properties: {
        query: { type: "string", description: "Title, author, ISBN, DOI or keywords" },
        limit: { type: "number", description: "Max results 1-20 (default 10)" },
        content_type: { type: "string", description: "book_any | book_fiction | book_nonfiction | book_comic | journal | magazine | standards_document (default: book_any)" },
      },
    },
  },
  {
    name: "get_details",
    description: "Full metadata for an item by MD5 hash: title, author, publisher, year, ISBN, DOI, format, size, source library.",
    inputSchema: {
      type: "object", required: ["hash"],
      properties: { hash: { type: "string", description: "MD5 hash (32 hex chars)" } },
    },
  },
  {
    name: "lookup_doi",
    description: "Resolve a DOI via Anna's Archive SciDB page (/scidb/{doi}). Returns MD5 hash and metadata. Works for journal articles, papers, books with DOI.",
    inputSchema: {
      type: "object", required: ["doi"],
      properties: { doi: { type: "string", description: "DOI e.g. 10.1038/nature12373" } },
    },
  },
  {
    name: "get_download_links",
    description: "All free download options for an MD5: (1) AA slow partner links scraped from the detail page, (2) LibGen session URL resolved via 2-step ads.php flow, (3) SciDB PDF if DOI is found. No API key required for any of these.",
    inputSchema: {
      type: "object", required: ["hash"],
      properties: { hash: { type: "string", description: "MD5 hash of the item" } },
    },
  },
  {
    name: "get_scidb_pdf",
    description: "Resolve a DOI directly on Anna's Archive SciDB (/scidb/{doi}) and extract the PDF download URL. No API key needed. Best for journal articles and papers.",
    inputSchema: {
      type: "object", required: ["doi"],
      properties: { doi: { type: "string", description: "DOI e.g. 10.1038/nature12373" } },
    },
  },
  {
    name: "resolve_libgen",
    description: "LibGen 2-step: GET ads.php?md5 to extract session key, return ready-to-use get.php URL. Free, no API key. Session key expires in minutes — use immediately.",
    inputSchema: {
      type: "object", required: ["hash"],
      properties: { hash: { type: "string", description: "MD5 hash (32 hex chars)" } },
    },
  },
];

// ─── MCP REQUEST HANDLER ──────────────────────────────────────────────────────
async function handleMCP(body: any): Promise<any> {
  const { method, params, id } = body;
  const ok  = (r: any) => ({ jsonrpc: "2.0", id, result: r });
  const err = (c: number, msg: string) => ({ jsonrpc: "2.0", id, error: { code: c, message: msg } });

  if (method === "initialize") return ok({
    protocolVersion: "2024-11-05",
    capabilities: { tools: {} },
    serverInfo: { name: "annas-archive-download-mcp", version: "3.0.0" },
  });
  if (method === "tools/list") return ok({ tools: TOOLS });
  if (method === "ping" || method?.startsWith("notifications/")) return ok({});

  if (method === "tools/call") {
    const name: string = params?.name;
    const args: any   = params?.arguments ?? {};
    try {
      let result: any;
      if      (name === "search")             result = await search(args.query, args.limit ?? 10, args.content_type ?? "book_any");
      else if (name === "get_details")        result = await getDetails(args.hash);
      else if (name === "lookup_doi")         result = await lookupDoi(args.doi);
      else if (name === "get_download_links") result = await getDownloadLinks(args.hash);
      else if (name === "get_scidb_pdf")      result = await getScidbPdf(args.doi);
      else if (name === "resolve_libgen")     result = await resolveLibgen(args.hash);
      else return err(-32601, `Unknown tool: ${name}`);
      return ok({ content: [{ type: "text", text: JSON.stringify(result, null, 2) }] });
    } catch (e: any) {
      return ok({ content: [{ type: "text", text: JSON.stringify({ error: e?.message ?? String(e) }) }], isError: true });
    }
  }
  return err(-32601, `Method not found: ${method}`);
}

// ─── VERCEL ENTRY POINT ───────────────────────────────────────────────────────
export default async function handler(req: VercelRequest, res: VercelResponse) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
  if (req.method === "OPTIONS") return res.status(204).end();

  if (req.method === "GET") return res.status(200).json({
    name: "annas-archive-download-mcp",
    version: "3.0.0",
    tools: TOOLS.map(t => t.name),
    free_download_sources: [
      "LibGen (libgen.li ads.php → session key → get.php)",
      "Anna's Archive SciDB (/scidb/{doi} → PDF iframe/link)",
      "AA slow partner links (library.lol, IPFS, Z-Lib mirrors, Internet Archive)",
    ],
  });

  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });
  return res.status(200).json(await handleMCP(req.body));
}
