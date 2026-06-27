import type { VercelRequest, VercelResponse } from "@vercel/node";

// ─── Mirrors (fallback order) ───────────────────────────────────────────────
const AA_MIRRORS = [
  "https://annas-archive.gl",
  "https://annas-archive.li",
  "https://annas-archive.org",
];
const LIBGEN_HOST = "libgen.li";
const SCINET_HOST = "sci-net.xyz";

// ─── Browser headers ────────────────────────────────────────────────────────
const BROWSER: Record<string, string> = {
  "User-Agent":
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
  Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
  "Accept-Language": "en-US,en;q=0.9,it;q=0.8",
};

// ─── Helpers ────────────────────────────────────────────────────────────────
function timeout(ms: number) {
  return AbortSignal.timeout(ms);
}

async function fetchAA(path: string, jsonApi = false) {
  let lastErr: unknown;
  for (const mirror of AA_MIRRORS) {
    try {
      const headers: Record<string, string> = { ...BROWSER };
      if (jsonApi) headers["Accept"] = "application/json";
      const res = await fetch(`${mirror}${path}`, {
        headers,
        signal: timeout(12000),
      });
      if (res.ok || res.status === 404) return { res, mirror };
    } catch (e) {
      lastErr = e;
    }
  }
  throw lastErr ?? new Error("All Anna's Archive mirrors failed");
}

// ─── SEARCH ─────────────────────────────────────────────────────────────────
async function search(query: string, limit = 10, contentType = "book_any") {
  const q = new URLSearchParams({
    q: query, lang: "", content: contentType, ext: "", sort: "", page: "1",
  });
  const { res } = await fetchAA(`/dyn/api/search.json?${q}`, true);
  if (!res.ok) throw new Error(`Search API: HTTP ${res.status}`);
  const data: any = await res.json();
  const items: any[] = Array.isArray(data)
    ? data
    : data.results ?? data.hits ?? [];
  return items.slice(0, limit).map((it: any) => ({
    md5: (it.md5 ?? it.id ?? "").toLowerCase(),
    title: it.title ?? "(no title)",
    author: it.author ?? it.authors ?? "",
    year: it.year ?? "",
    language: it.language ?? "",
    format: it.extension ?? it.format ?? "",
    filesize_mb: it.filesize
      ? `${(Number(it.filesize) / 1048576).toFixed(1)} MB`
      : "",
    source_library: it.source_library_name ?? it.source ?? "",
    cover: it.cover_url ?? it.cover ?? "",
  }));
}

// ─── GET DETAILS ─────────────────────────────────────────────────────────────
async function getDetails(md5: string) {
  const { res } = await fetchAA(`/dyn/api/object.json?md5=${md5.toLowerCase()}`, true);
  if (!res.ok) throw new Error(`Details API: HTTP ${res.status}`);
  const d: any = await res.json();
  return {
    md5: md5.toLowerCase(),
    title: d.title ?? "",
    author: d.author ?? "",
    publisher: d.publisher ?? "",
    year: d.year ?? "",
    language: d.language ?? "",
    format: d.extension ?? d.format ?? "",
    filesize_mb: d.filesize ? `${(Number(d.filesize) / 1048576).toFixed(1)} MB` : "",
    isbn: d.isbn13 ?? d.isbn ?? "",
    doi: d.doi ?? "",
    description: (d.description ?? "").slice(0, 500),
    source_library: d.source_library_name ?? d.source ?? "",
    cover: d.cover_url ?? d.cover ?? "",
  };
}

// ─── LOOKUP DOI via SciDB ────────────────────────────────────────────────────
async function lookupDoi(doi: string) {
  // Anna's Archive has /scidb/{doi} which resolves to a single item
  const { res, mirror } = await fetchAA(`/scidb/${encodeURIComponent(doi)}`);
  const html = await res.text();
  // Extract MD5 from page (appears in /md5/{hash} links)
  const md5Match = html.match(/\/md5\/([0-9a-f]{32})/i);
  if (md5Match) {
    const md5 = md5Match[1].toLowerCase();
    const details = await getDetails(md5).catch(() => null);
    return { doi, md5, details, source: mirror };
  }
  // Fallback: search
  const results = await search(doi, 3, "book_any");
  if (results.length > 0) return { doi, md5: results[0].md5, details: results[0], source: "search_fallback" };
  return { doi, md5: null, error: "DOI not found in Anna's Archive" };
}

// ─── GET DOWNLOAD LINKS (scraping + LibGen 2-step) ──────────────────────────
async function getDownloadLinks(md5: string): Promise<any> {
  md5 = md5.toLowerCase();

  // 1. Scrape the AA detail page for all slow-download hrefs
  const { res, mirror } = await fetchAA(`/md5/${md5}`);
  if (!res.ok) throw new Error(`AA page: HTTP ${res.status}`);
  const html = await res.text();

  // Extract every <a class="js-download-link" href="..."> excluding fast_download
  const aaLinks: { label: string; url: string; type: string }[] = [];
  const linkRe = /<a[^>]+class="[^"]*js-download-link[^"]*"[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi;
  let m: RegExpExecArray | null;
  while ((m = linkRe.exec(html)) !== null) {
    const href = m[1];
    if (/fast_download/i.test(href)) continue; // skip paid fast download
    const label = m[2].replace(/<[^>]+>/g, "").replace(/\s+/g, " ").trim();
    const url = href.startsWith("http") ? href : `${mirror}${href}`;
    if (!aaLinks.find(l => l.url === url)) {
      let type = "partner";
      if (/libgen/i.test(url)) type = "libgen";
      else if (/library\.lol|lib\.lol/i.test(url)) type = "library.lol";
      else if (/sci-hub|scihub/i.test(url)) type = "scihub";
      else if (/ipfs/i.test(url)) type = "ipfs";
      else if (/z-lib|zlibrary/i.test(url)) type = "zlibrary";
      else if (/archive\.org/i.test(url)) type = "internet_archive";
      aaLinks.push({ label: label || type, url, type });
    }
  }

  // Also catch plain hrefs to known slow-download domains not in js-download-link
  const altRe = /href="(https?:\/\/(?:libgen\.li|libgen\.gl|libgen\.la|libgen\.bz|library\.lol|lib\.lol)[^"]+)"/gi;
  while ((m = altRe.exec(html)) !== null) {
    const url = m[1];
    if (!aaLinks.find(l => l.url === url)) {
      const type = /libgen/.test(url) ? "libgen" : "library.lol";
      aaLinks.push({ label: type, url, type });
    }
  }

  // 2. LibGen 2-step: resolve the actual session-keyed get.php URL (free, no API key)
  let libgenResult: any = null;
  try {
    libgenResult = await resolveLibgen(md5);
  } catch (e: any) {
    libgenResult = { error: e?.message ?? String(e) };
  }

  // 3. Extract DOI from page if present (to offer Sci-Net path)
  const doiMatch = html.match(/\b(10\.\d{4,}\/[^\s"<]+)/);
  const doi = doiMatch ? doiMatch[1] : null;

  return {
    md5,
    mirror_used: mirror,
    aa_slow_links: aaLinks,
    libgen: libgenResult,
    doi: doi ?? undefined,
    scinet_note: doi
      ? `This item has DOI ${doi}. Use 'get_scinet_url' tool to fetch it from Sci-Net (no key needed).`
      : undefined,
    summary: `Found ${aaLinks.length} AA slow link(s). LibGen: ${libgenResult?.error ? "not available" : "session URL resolved"}.`,
  };
}

// ─── LIBGEN 2-STEP RESOLVER ─────────────────────────────────────────────────
// Step 1: GET libgen.li/ads.php?md5={hash} → extract session key
// Step 2: Return the get.php URL (caller can fetch directly)
async function resolveLibgen(md5: string): Promise<any> {
  md5 = md5.toLowerCase();
  const adsUrl = `https://${LIBGEN_HOST}/ads.php?md5=${md5}`;
  const adsRes = await fetch(adsUrl, {
    headers: BROWSER,
    signal: timeout(10000),
  });
  if (!adsRes.ok) throw new Error(`LibGen ads.php: HTTP ${adsRes.status}`);
  const adsHtml = await adsRes.text();

  // Pattern from ball2jh: get.php?md5={32hex}&key={ALPHANUMERIC}
  const keyRe = /get\.php\?md5=([0-9a-f]{32})&key=([A-Z0-9]+)/i;
  const keyMatch = adsHtml.match(keyRe);
  if (!keyMatch) {
    throw new Error(`LibGen has no copy of MD5 ${md5}`);
  }
  const key = keyMatch[2];
  const getUrl = `https://${LIBGEN_HOST}/get.php?md5=${md5}&key=${key}`;
  return {
    ads_url: adsUrl,
    download_url: getUrl,
    note: "Session key is short-lived (~minutes). Use this URL immediately to download.",
  };
}

// ─── SCI-NET URL RESOLVER ────────────────────────────────────────────────────
// GET sci-net.xyz/{DOI} → extract PDF iframe src → return direct PDF URL
async function getScinetUrl(doi: string): Promise<any> {
  const pageUrl = `https://${SCINET_HOST}/${doi.replace(/^\//, "")}`;
  const res = await fetch(pageUrl, {
    headers: BROWSER,
    signal: timeout(12000),
    redirect: "follow",
  });
  if (!res.ok) {
    return { doi, error: `Sci-Net returned HTTP ${res.status}`, page_url: pageUrl };
  }
  const html = await res.text();

  // Pattern from ball2jh: <iframe src="/storage/.../{slug}.pdf">
  const iframeRe = /<iframe[^>]*\bsrc\s*=\s*["'](\/?storage\/[^"']+\.pdf)(?:#[^"']*)?["']/i;
  const iMatch = html.match(iframeRe);
  if (!iMatch) {
    return { doi, error: "Sci-Net has no PDF for this DOI (may require credit upload)", page_url: pageUrl };
  }
  const pdfPath = iMatch[1].startsWith("/") ? iMatch[1] : `/${iMatch[1]}`;
  const pdfUrl = `https://${SCINET_HOST}${pdfPath}`;
  const filename = pdfPath.split("/").pop()?.split("#")[0] ?? "paper.pdf";
  return { doi, page_url: pageUrl, pdf_url: pdfUrl, filename };
}

// ─── MCP TOOL DEFINITIONS ────────────────────────────────────────────────────
const TOOLS = [
  {
    name: "search",
    description:
      "Search Anna's Archive across all source libraries (LibGen, Z-Library, Sci-Hub, Internet Archive, DuXiu, MagzDB…). Returns MD5 hashes for use with other tools.",
    inputSchema: {
      type: "object", required: ["query"],
      properties: {
        query: { type: "string", description: "Title, author, ISBN, DOI or keywords" },
        limit: { type: "number", description: "Max results 1-20 (default 10)" },
        content_type: {
          type: "string",
          description: "book_any (default) | book_fiction | book_nonfiction | book_comic | journal | magazine | standards_document",
        },
      },
    },
  },
  {
    name: "get_details",
    description: "Full metadata for an item: title, author, publisher, year, ISBN, DOI, description, format, size, source library.",
    inputSchema: {
      type: "object", required: ["hash"],
      properties: { hash: { type: "string", description: "MD5 hash (32 hex chars)" } },
    },
  },
  {
    name: "lookup_doi",
    description: "Resolve a DOI to its MD5 hash and metadata via Anna's Archive SciDB.",
    inputSchema: {
      type: "object", required: ["doi"],
      properties: { doi: { type: "string", description: "DOI e.g. 10.1038/nature12373" } },
    },
  },
  {
    name: "get_download_links",
    description:
      "Scrape the Anna's Archive MD5 page for all free slow-download links (LibGen, library.lol, IPFS, Z-Library mirror…). Also resolves the LibGen 2-step session URL (no API key needed) and detects DOI for Sci-Net fallback. Use this instead of fast_download when no API key is available.",
    inputSchema: {
      type: "object", required: ["hash"],
      properties: { hash: { type: "string", description: "MD5 hash of the item" } },
    },
  },
  {
    name: "get_scinet_url",
    description:
      "For journal articles: resolve a DOI on Sci-Net (sci-net.xyz) and return the direct PDF URL. No API key required. Fallback when LibGen doesn't have a paper.",
    inputSchema: {
      type: "object", required: ["doi"],
      properties: { doi: { type: "string", description: "DOI e.g. 10.1038/nature12373" } },
    },
  },
  {
    name: "resolve_libgen",
    description:
      "Directly resolve a LibGen session download URL from an MD5 hash. Returns the short-lived get.php URL ready to use in a browser. No API key needed.",
    inputSchema: {
      type: "object", required: ["hash"],
      properties: { hash: { type: "string", description: "MD5 hash (32 hex chars)" } },
    },
  },
];

// ─── MCP REQUEST HANDLER ─────────────────────────────────────────────────────
async function handleMCP(body: any): Promise<any> {
  const { method, params, id } = body;
  const ok = (result: any) => ({ jsonrpc: "2.0", id, result });
  const err = (code: number, msg: string) => ({ jsonrpc: "2.0", id, error: { code, message: msg } });

  if (method === "initialize") {
    return ok({
      protocolVersion: "2024-11-05",
      capabilities: { tools: {} },
      serverInfo: { name: "annas-archive-download-mcp", version: "2.0.0" },
    });
  }
  if (method === "tools/list") return ok({ tools: TOOLS });
  if (method === "ping" || method?.startsWith("notifications/")) return ok({});

  if (method === "tools/call") {
    const name: string = params?.name;
    const args: any = params?.arguments ?? {};
    try {
      let result: any;
      if (name === "search") result = await search(args.query, args.limit ?? 10, args.content_type ?? "book_any");
      else if (name === "get_details") result = await getDetails(args.hash);
      else if (name === "lookup_doi") result = await lookupDoi(args.doi);
      else if (name === "get_download_links") result = await getDownloadLinks(args.hash);
      else if (name === "get_scinet_url") result = await getScinetUrl(args.doi);
      else if (name === "resolve_libgen") result = await resolveLibgen(args.hash);
      else return err(-32601, `Unknown tool: ${name}`);

      return ok({ content: [{ type: "text", text: JSON.stringify(result, null, 2) }] });
    } catch (e: any) {
      return ok({
        content: [{ type: "text", text: JSON.stringify({ error: e?.message ?? String(e) }) }],
        isError: true,
      });
    }
  }
  return err(-32601, `Method not found: ${method}`);
}

// ─── VERCEL ENTRY POINT ──────────────────────────────────────────────────────
export default async function handler(req: VercelRequest, res: VercelResponse) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
  if (req.method === "OPTIONS") return res.status(204).end();

  if (req.method === "GET") {
    return res.status(200).json({
      name: "annas-archive-download-mcp",
      version: "2.0.0",
      description: "Anna's Archive MCP — search + free slow downloads via LibGen 2-step & Sci-Net. No API key needed.",
      tools: TOOLS.map(t => t.name),
      sources: ["LibGen (libgen.li 2-step ads.php flow)", "Sci-Net (sci-net.xyz PDF iframe)", "AA slow partner links (library.lol, IPFS, etc.)"],
    });
  }
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });

  const response = await handleMCP(req.body);
  return res.status(200).json(response);
}
