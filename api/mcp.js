// Anna's Archive MCP — v4.0.0
// Incorpora le migliorie di Opus: validazione input, retry con backoff,
// content type esteso, versioning corretto.

const AA_MIRRORS = [
  "https://annas-archive.gl",
  "https://annas-archive.li",
  "https://annas-archive.se",
  "https://annas-archive.org",
];
const LIBGEN_HOST = "libgen.li";
const SEP = " \u00b7 ";

const BROWSER = {
  "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
  Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
  "Accept-Language": "en-US,en;q=0.9,it;q=0.8",
};

// ── Validazione input (da Opus) ───────────────────────────────────────────────
const VALID_CONTENT_TYPES = new Set([
  "book_any","book_fiction","book_nonfiction","book_comic",
  "journal","magazine","standards_document","musical_score","other",
]);

function normContentType(ct) {
  const v = (ct ?? "").trim();
  return VALID_CONTENT_TYPES.has(v) ? v : "book_any";
}

function clampLimit(n, def = 10) {
  const x = Number(n);
  if (!Number.isFinite(x)) return def;
  return Math.min(20, Math.max(1, Math.trunc(x)));
}

function assertMd5(hash) {
  const h = String(hash ?? "").trim().toLowerCase();
  if (!/^[0-9a-f]{32}$/.test(h))
    throw new Error(`Invalid MD5 hash: expected 32 hex chars, got "${hash}"`);
  return h;
}

function assertDoi(doi) {
  const d = String(doi ?? "").trim().replace(/^doi:/i,"").replace(/^\//,"");
  if (!/^10\.\d{4,}\/\S+$/.test(d))
    throw new Error(`Invalid DOI: expected format like 10.1038/nature12373, got "${doi}"`);
  return d;
}

// ── Fetch con retry su 429/5xx (da Opus) ─────────────────────────────────────
async function fetchRetry(url, init, attempts = 2) {
  let lastErr;
  for (let i = 0; i < attempts; i++) {
    try {
      const res = await fetch(url, init);
      if (res.status === 429 || res.status >= 500) {
        lastErr = new Error(`HTTP ${res.status}`);
        if (i < attempts - 1) { await new Promise(r => setTimeout(r, 400 * (i+1))); continue; }
      }
      return res;
    } catch(e) {
      lastErr = e;
      if (i < attempts - 1) { await new Promise(r => setTimeout(r, 400 * (i+1))); continue; }
    }
  }
  throw lastErr ?? new Error("fetchRetry failed");
}

async function fetchAA(path, jsonApi = false) {
  let lastErr;
  for (const mirror of AA_MIRRORS) {
    try {
      const headers = { ...BROWSER };
      if (jsonApi) headers["Accept"] = "application/json";
      const res = await fetchRetry(`${mirror}${path}`, { headers, signal: AbortSignal.timeout(12000) });
      if (res.ok || res.status === 404) return { res, mirror };
    } catch(e) { lastErr = e; }
  }
  throw lastErr ?? new Error("All AA mirrors unreachable");
}

// ── Parser HTML search ────────────────────────────────────────────────────────
function extractAuthor(snippet) {
  const re = /<a[^>]+href="[^"]*\/search[^"]*"[^>]*>([\s\S]*?)<\/a>/gi;
  let m;
  while ((m = re.exec(snippet)) !== null) {
    if (/user-edit|lucide-user/i.test(m[1])) {
      const text = m[1].replace(/<span[^>]*>[\s\S]*?<\/span>/gi,"")
                       .replace(/<[^>]+>/g,"").trim();
      if (text) return text;
    }
  }
  return "";
}

function extractMeta(snippet) {
  const patterns = [
    /<div[^>]+class="[^"]*font-semibold[^"]*text-sm[^"]*mt-2[^"]*"[^>]*>([\s\S]*?)<\/div>/i,
    /<div[^>]+class="[^"]*text-sm[^"]*mt-2[^"]*"[^>]*>([\s\S]*?)<\/div>/i,
    /<div[^>]+class="[^"]*mt-2[^"]*text-sm[^"]*"[^>]*>([\s\S]*?)<\/div>/i,
  ];
  let raw = "";
  for (const pat of patterns) {
    const m = snippet.match(pat);
    if (m) { raw = m[1].replace(/<[^>]+>/g,"").trim(); break; }
  }
  if (!raw) return { language:"", format:"", filesize:"", year:"" };
  const parts = raw.split(SEP).map(p => p.trim());
  let language = parts[0] || "";
  const lcIdx = language.indexOf(" [");
  if (lcIdx > 0) language = language.slice(0, lcIdx).trim();
  const format = (parts[1] || "").toLowerCase();
  const filesize = parts[2] || "";
  const yearM = raw.match(/\b((?:19|20)\d{2})\b/);
  return { language, format, filesize, year: yearM ? yearM[1] : "" };
}

// ── SEARCH ────────────────────────────────────────────────────────────────────
async function search(query, limit = 10, contentType = "book_any") {
  const safeLimit = clampLimit(limit);
  const contentParam = normContentType(contentType) === "book_any" ? "" : normContentType(contentType);
  const params = new URLSearchParams({ q: query, lang:"", content: contentParam, ext:"", sort:"" });
  const { res } = await fetchAA(`/search?${params}`);
  if (!res.ok) throw new Error(`Search page HTTP ${res.status}`);
  const html = await res.text();

  const results = [];
  const titleRe = /href="(\/md5\/([0-9a-f]{32}))"[^>]*class="[^"]*(?:js-vim-focus|font-semibold)[^"]*"[^>]*>([\s\S]*?)<\/a>/gi;
  let m;
  while ((m = titleRe.exec(html)) !== null && results.length < safeLimit) {
    const md5 = m[2].toLowerCase();
    if (results.find(r => r.md5 === md5)) continue;
    const title = m[3].replace(/<[^>]+>/g,"").trim();
    if (!title) continue;
    const start = Math.max(0, m.index - 200);
    const snippet = html.slice(start, m.index + 2000);
    const author = extractAuthor(snippet);
    const { language, format, filesize, year } = extractMeta(snippet);
    results.push({ md5, title, author, year, language, format, filesize_mb: filesize });
  }

  if (results.length === 0) {
    const seen = new Set();
    const simpleRe = /href="\/md5\/([0-9a-f]{32})"/gi;
    while ((m = simpleRe.exec(html)) !== null && results.length < safeLimit) {
      const md5 = m[1].toLowerCase();
      if (!seen.has(md5)) { seen.add(md5); results.push({ md5, title:"(use get_details for metadata)", author:"", year:"", language:"", format:"", filesize_mb:"" }); }
    }
  }
  return results;
}

// ── GET DETAILS ───────────────────────────────────────────────────────────────
async function getDetails(md5) {
  const { res } = await fetchAA(`/dyn/api/object.json?md5=${md5}`, true);
  if (!res.ok) throw new Error(`Details API HTTP ${res.status}`);
  const d = await res.json();
  return {
    md5,
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
  };
}

// ── LOOKUP DOI ────────────────────────────────────────────────────────────────
async function lookupDoi(doi) {
  let md5 = null;
  const scidbPageUrl = `https://annas-archive.se/scidb/${doi}`;
  try {
    const res = await fetchRetry(scidbPageUrl, { headers: BROWSER, signal: AbortSignal.timeout(12000) });
    if (res.ok) {
      const html = await res.text();
      const m = html.match(/\/md5\/([0-9a-f]{32})/i);
      if (m) md5 = m[1].toLowerCase();
    }
  } catch(_) {}

  if (!md5) {
    const results = await search(doi, 3);
    if (results.length > 0) return { doi, md5: results[0].md5, source:"search_fallback", metadata: results[0] };
    return { doi, md5: null, error:"DOI not found in Anna's Archive" };
  }
  const details = await getDetails(md5).catch(() => null);
  return { doi, md5, scidb_page: scidbPageUrl, source:"scidb", metadata: details };
}

// ── RESOLVE LIBGEN ────────────────────────────────────────────────────────────
async function resolveLibgen(md5) {
  const adsUrl = `https://${LIBGEN_HOST}/ads.php?md5=${md5}`;
  const adsRes = await fetchRetry(adsUrl, { headers: BROWSER, signal: AbortSignal.timeout(10000) });
  if (!adsRes.ok) throw new Error(`LibGen ads.php HTTP ${adsRes.status}`);
  const html = await adsRes.text();
  const keyMatch = html.match(/get\.php\?md5=([0-9a-f]{32})&key=([A-Z0-9]+)/i);
  if (!keyMatch) throw new Error(`LibGen has no copy of MD5 ${md5}`);
  return {
    download_url: `https://${LIBGEN_HOST}/get.php?md5=${md5}&key=${keyMatch[2]}`,
    session_key: keyMatch[2],
    note: "Session key is short-lived (~minutes). Open download_url immediately in your browser.",
  };
}

// ── GET SCIDB PDF ─────────────────────────────────────────────────────────────
async function getScidbPdf(doi) {
  let html = "", pageUrl = "";
  for (const mirror of AA_MIRRORS) {
    try {
      pageUrl = `${mirror}/scidb/${doi}`;
      const res = await fetchRetry(pageUrl, { headers: BROWSER, signal: AbortSignal.timeout(12000), redirect:"follow" });
      if (res.ok) { html = await res.text(); break; }
    } catch(_) {}
  }
  if (!html) return { doi, error:"SciDB page not reachable", page_url: pageUrl };

  let pdfUrl = null;
  const checks = [
    /<iframe[^>]+id=["']pdf["'][^>]+src=["']([^"']+)["']/i,
    /<iframe[^>]+src=["']([^"']+\.pdf[^"']*)["']/i,
    /id=["']plugin["'][^>]+src=["']([^"']+)["']/i,
    /<a[^>]+href=["']([^"']+\.pdf)["'][^>]*>[^<]*[Dd]ownload[^<]*<\/a>/i,
    /<a[^>]+href=["']([^"']+\.pdf)["']/i,
    /<embed[^>]+original-url=["']([^"']+)["']/i,
    /content=["'][0-9]+;\s*url=([^"']+)["']/i,
  ];
  for (const re of checks) {
    const m = html.match(re);
    if (m) { pdfUrl = m[1]; break; }
  }
  if (pdfUrl?.startsWith("//")) pdfUrl = "https:" + pdfUrl;
  if (pdfUrl?.startsWith("/")) pdfUrl = `${AA_MIRRORS[0]}${pdfUrl}`;
  if (!pdfUrl) return { doi, page_url: pageUrl, error:"PDF not found in SciDB page" };
  return { doi, page_url: pageUrl, pdf_url: pdfUrl };
}

// ── GET DOWNLOAD LINKS ────────────────────────────────────────────────────────
async function getDownloadLinks(md5) {
  const { res, mirror } = await fetchAA(`/md5/${md5}`);
  if (!res.ok) throw new Error(`AA /md5/ page HTTP ${res.status}`);
  const html = await res.text();

  const slowLinks = [];
  const linkRe = /<a[^>]+class="[^"]*js-download-link[^"]*"[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi;
  let m;
  while ((m = linkRe.exec(html)) !== null) {
    const href = m[1];
    if (/fast_download/i.test(href)) continue;
    const label = m[2].replace(/<[^>]+>/g,"").replace(/\s+/g," ").trim();
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
  const altRe = /href="(https?:\/\/(?:libgen\.li|libgen\.gl|libgen\.la|library\.lol|lib\.lol)[^"]+)"/gi;
  while ((m = altRe.exec(html)) !== null) {
    const url = m[1];
    if (!slowLinks.find(l => l.url === url))
      slowLinks.push({ label:/libgen/.test(url)?"libgen":"library.lol", url, type:/libgen/.test(url)?"libgen":"library.lol" });
  }

  let libgen = null;
  try { libgen = await resolveLibgen(md5); } catch(e) { libgen = { error: e?.message ?? String(e) }; }

  const doiMatch = html.match(/\b(10\.\d{4,}\/[^\s"<>]+)/);
  const doi = doiMatch ? doiMatch[1].replace(/[.,;]+$/,"") : null;
  let scidb = null;
  if (doi) { try { scidb = await getScidbPdf(doi); } catch(e) { scidb = { error: e?.message }; } }

  return {
    md5, mirror_used: mirror,
    aa_slow_links: slowLinks,
    libgen,
    doi: doi ?? undefined,
    scidb: scidb ?? undefined,
    summary: [
      `AA slow links: ${slowLinks.length}`,
      `LibGen: ${libgen?.error ? "not found" : "session URL ready"}`,
      doi ? `SciDB: ${scidb?.pdf_url ? "PDF found" : (scidb?.error ?? "no PDF")}` : "no DOI",
    ].join(" | "),
  };
}

// ── TOOLS ─────────────────────────────────────────────────────────────────────
const TOOLS = [
  { name:"search",
    description:"Search Anna's Archive (LibGen, Z-Library, Sci-Hub, Internet Archive, DuXiu, MagzDB…). Returns MD5 hashes + title/author.",
    inputSchema:{ type:"object", required:["query"], properties:{
      query:{ type:"string" },
      limit:{ type:"number", description:"1-20, default 10" },
      content_type:{ type:"string", description:"book_any|book_fiction|book_nonfiction|book_comic|journal|magazine|standards_document|musical_score|other" },
    }}},
  { name:"get_details",
    description:"Full metadata by MD5: title, author, publisher, year, ISBN, DOI, format, size, source library.",
    inputSchema:{ type:"object", required:["hash"], properties:{ hash:{ type:"string" } }}},
  { name:"lookup_doi",
    description:"Resolve DOI via Anna's Archive /scidb/{doi}. Returns MD5 + metadata.",
    inputSchema:{ type:"object", required:["doi"], properties:{ doi:{ type:"string", description:"e.g. 10.1038/nature12373" } }}},
  { name:"get_download_links",
    description:"All free download options for an MD5: AA slow partner links + LibGen 2-step session URL + SciDB PDF if DOI found. No API key needed.",
    inputSchema:{ type:"object", required:["hash"], properties:{ hash:{ type:"string" } }}},
  { name:"get_scidb_pdf",
    description:"DOI → PDF URL via Anna's Archive /scidb/{doi}. No API key.",
    inputSchema:{ type:"object", required:["doi"], properties:{ doi:{ type:"string" } }}},
  { name:"resolve_libgen",
    description:"LibGen 2-step: ads.php → session key → get.php URL. Free, no API key. Key expires in minutes.",
    inputSchema:{ type:"object", required:["hash"], properties:{ hash:{ type:"string" } }}},
];

// ── MCP HANDLER ───────────────────────────────────────────────────────────────
async function handleMCP(body) {
  const { method, params, id } = body;
  const ok  = r => ({ jsonrpc:"2.0", id, result: r });
  const err = (c, msg) => ({ jsonrpc:"2.0", id, error:{ code:c, message:msg } });

  if (method === "initialize") return ok({ protocolVersion:"2024-11-05", capabilities:{ tools:{} }, serverInfo:{ name:"annas-archive-download-mcp", version:"4.0.0" } });
  if (method === "tools/list") return ok({ tools: TOOLS });
  if (method === "ping" || method?.startsWith("notifications/")) return ok({});

  if (method === "tools/call") {
    const name = params?.name;
    const args = params?.arguments ?? {};
    try {
      let result;
      if      (name === "search")             result = await search(String(args.query ?? ""), clampLimit(args.limit), normContentType(args.content_type));
      else if (name === "get_details")        result = await getDetails(assertMd5(args.hash));
      else if (name === "lookup_doi")         result = await lookupDoi(assertDoi(args.doi));
      else if (name === "get_download_links") result = await getDownloadLinks(assertMd5(args.hash));
      else if (name === "get_scidb_pdf")      result = await getScidbPdf(assertDoi(args.doi));
      else if (name === "resolve_libgen")     result = await resolveLibgen(assertMd5(args.hash));
      else return err(-32601, `Unknown tool: ${name}`);
      return ok({ content:[{ type:"text", text: JSON.stringify(result, null, 2) }] });
    } catch(e) {
      return ok({ content:[{ type:"text", text: JSON.stringify({ error: e?.message ?? String(e) }) }], isError: true });
    }
  }
  return err(-32601, `Method not found: ${method}`);
}

// ── VERCEL ENTRY POINT ────────────────────────────────────────────────────────
export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin","*");
  res.setHeader("Access-Control-Allow-Methods","GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers","Content-Type, Authorization");
  if (req.method === "OPTIONS") return res.status(204).end();
  if (req.method === "GET") return res.status(200).json({ name:"annas-archive-download-mcp", version:"4.0.0", tools: TOOLS.map(t=>t.name) });
  if (req.method !== "POST") return res.status(405).json({ error:"Method not allowed" });
  return res.status(200).json(await handleMCP(req.body));
}
