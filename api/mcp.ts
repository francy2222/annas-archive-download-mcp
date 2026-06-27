import type { VercelRequest, VercelResponse } from "@vercel/node";

// ─── Anna's Archive mirrors (rotation order) ───────────────────────────────
const MIRRORS = [
  "https://annas-archive.gl",
  "https://annas-archive.li",
  "https://annas-archive.org",
];

// ─── Shared headers to look like a real browser ────────────────────────────
const BROWSER_HEADERS = {
  "User-Agent":
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
  Accept:
    "text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8",
  "Accept-Language": "en-US,en;q=0.9,it;q=0.8",
  "Accept-Encoding": "gzip, deflate, br",
};

// ─── Try each mirror until one responds ────────────────────────────────────
async function fetchFromMirror(
  path: string,
  options: RequestInit = {}
): Promise<{ response: Response; mirror: string }> {
  let lastError: unknown;
  for (const mirror of MIRRORS) {
    try {
      const res = await fetch(`${mirror}${path}`, {
        ...options,
        headers: { ...BROWSER_HEADERS, ...(options.headers as any) },
        signal: AbortSignal.timeout(12000),
      });
      if (res.ok || res.status === 404) {
        return { response: res, mirror };
      }
    } catch (e) {
      lastError = e;
    }
  }
  throw lastError ?? new Error("All mirrors failed");
}

// ─── Parse search results from JSON API ────────────────────────────────────
async function searchBooks(query: string, limit = 10, contentType = "book_any") {
  const params = new URLSearchParams({
    q: query,
    lang: "",
    content: contentType,
    ext: "",
    sort: "",
    page: "1",
  });
  const { response } = await fetchFromMirror(`/dyn/api/search.json?${params}`);
  if (!response.ok) throw new Error(`Search failed: ${response.status}`);
  const data = await response.json() as any;
  // API returns array directly or {results:[]}
  const items: any[] = Array.isArray(data) ? data : (data.results ?? data.hits ?? []);
  return items.slice(0, limit).map((item: any) => ({
    md5: item.md5 ?? item.id ?? "",
    title: item.title ?? item.extension_calculated ?? "(no title)",
    author: item.author ?? item.authors ?? "",
    year: item.year ?? "",
    language: item.language ?? "",
    format: item.extension ?? item.format ?? "",
    filesize_mb: item.filesize
      ? `${(Number(item.filesize) / 1048576).toFixed(1)} MB`
      : "",
    cover: item.cover_url ?? item.cover ?? "",
    source_library: item.source_library_name ?? item.source ?? "",
  }));
}

// ─── Get full metadata for a single MD5 ────────────────────────────────────
async function getDetails(md5: string) {
  const { response } = await fetchFromMirror(
    `/dyn/api/object.json?md5=${md5}`
  );
  if (!response.ok) throw new Error(`Details failed: ${response.status}`);
  const d = await response.json() as any;
  return {
    md5,
    title: d.title ?? "",
    author: d.author ?? "",
    publisher: d.publisher ?? "",
    year: d.year ?? "",
    language: d.language ?? "",
    format: d.extension ?? d.format ?? "",
    filesize_mb: d.filesize ? `${(Number(d.filesize) / 1048576).toFixed(1)} MB` : "",
    isbn: d.isbn13 ?? d.isbn ?? "",
    doi: d.doi ?? "",
    description: (d.description ?? "").slice(0, 400),
    cover: d.cover_url ?? d.cover ?? "",
    source_library: d.source_library_name ?? d.source ?? "",
  };
}

// ─── Scrape slow download links from the MD5 detail page ───────────────────
async function getDownloadLinks(md5: string): Promise<{
  mirror_used: string;
  slow_links: { label: string; url: string; type: string }[];
  notes: string;
}> {
  const { response, mirror } = await fetchFromMirror(`/md5/${md5}`);
  if (!response.ok) {
    throw new Error(`Page fetch failed: ${response.status} from ${mirror}`);
  }
  const html = await response.text();

  // Extract all <a class="js-download-link" href="..."> elements
  const slowLinks: { label: string; url: string; type: string }[] = [];

  // Regex-based extraction (no DOM parser needed on Vercel Edge)
  const linkRe = /<a[^>]+class="[^"]*js-download-link[^"]*"[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi;
  let match: RegExpExecArray | null;
  while ((match = linkRe.exec(html)) !== null) {
    const href = match[1];
    const innerText = match[2].replace(/<[^>]+>/g, "").trim();

    // Absolute URL
    const url = href.startsWith("http") ? href : `${mirror}${href}`;

    // Classify by domain/content
    let type = "partner";
    if (/libgen/i.test(url) || /libgen/i.test(innerText)) type = "libgen";
    else if (/library\.lol/i.test(url)) type = "library.lol";
    else if (/sci-hub/i.test(url)) type = "scihub";
    else if (/ipfs/i.test(url)) type = "ipfs";

    // Skip fast-download API links (require API key)
    if (/fast_download/i.test(url)) continue;

    // Skip if already added
    if (!slowLinks.find((l) => l.url === url)) {
      slowLinks.push({ label: innerText || type, url, type });
    }
  }

  // Also extract plain slow-download section links (some mirrors use different markup)
  const altRe = /href="(https?:\/\/(?:libgen\.li|libgen\.gl|libgen\.la|library\.lol|lib\.lol)[^"]+)"/gi;
  while ((match = altRe.exec(html)) !== null) {
    const url = match[1];
    if (!slowLinks.find((l) => l.url === url)) {
      const type = /libgen/.test(url) ? "libgen" : "library.lol";
      slowLinks.push({ label: type, url, type });
    }
  }

  const notes =
    slowLinks.length === 0
      ? "No slow download links found. The file may require an API key (fast download only), or the page structure changed."
      : `Found ${slowLinks.length} slow download link(s). LibGen links usually work directly; library.lol may show ads.`;

  return { mirror_used: mirror, slow_links: slowLinks, notes };
}

// ─── Resolve a partner redirect to get the real download URL ───────────────
async function resolveDownloadUrl(url: string): Promise<{
  final_url: string;
  resolved: boolean;
  notes: string;
}> {
  // We do a HEAD request with redirect following to find the real file URL
  try {
    const res = await fetch(url, {
      method: "HEAD",
      headers: BROWSER_HEADERS,
      redirect: "follow",
      signal: AbortSignal.timeout(10000),
    });
    const finalUrl = res.url;
    const ct = res.headers.get("content-type") ?? "";
    const size = res.headers.get("content-length");
    const isFile = ct.includes("pdf") || ct.includes("epub") || ct.includes("octet-stream");
    return {
      final_url: finalUrl,
      resolved: isFile,
      notes: isFile
        ? `Direct file URL. Content-Type: ${ct}. Size: ${size ? `${(Number(size) / 1048576).toFixed(1)} MB` : "unknown"}`
        : `Redirected to: ${finalUrl} (may be a landing page, not a direct file)`,
    };
  } catch (e: any) {
    return {
      final_url: url,
      resolved: false,
      notes: `Could not follow redirect: ${e?.message ?? e}`,
    };
  }
}


// ─── MCP Protocol types ─────────────────────────────────────────────────────
interface MCPTool {
  name: string;
  description: string;
  inputSchema: object;
}

const TOOLS: MCPTool[] = [
  {
    name: "search",
    description:
      "Search Anna's Archive for books, papers, comics, magazines. Returns MD5 hashes usable with other tools.",
    inputSchema: {
      type: "object",
      required: ["query"],
      properties: {
        query: { type: "string", description: "Search keywords, title, author, ISBN or DOI" },
        limit: { type: "number", description: "Max results (1-20, default 10)", default: 10 },
        content_type: {
          type: "string",
          description: "Filter: book_any (default), book_nonfiction, book_fiction, journal, magazine",
          default: "book_any",
        },
      },
    },
  },
  {
    name: "get_details",
    description:
      "Get full metadata for an item by its MD5 hash (title, author, publisher, year, ISBN, DOI, description, format, size).",
    inputSchema: {
      type: "object",
      required: ["hash"],
      properties: {
        hash: { type: "string", description: "MD5 hash from search results" },
      },
    },
  },
  {
    name: "lookup_doi",
    description: "Resolve a DOI to paper metadata and its MD5 hash on Anna's Archive.",
    inputSchema: {
      type: "object",
      required: ["doi"],
      properties: {
        doi: { type: "string", description: "DOI e.g. 10.1038/nature12373" },
      },
    },
  },
  {
    name: "get_download_links",
    description:
      "Scrape the Anna's Archive detail page for a given MD5 and return all free slow-download links (LibGen, library.lol, IPFS, etc.). No API key required.",
    inputSchema: {
      type: "object",
      required: ["hash"],
      properties: {
        hash: { type: "string", description: "MD5 hash of the item to download" },
      },
    },
  },
  {
    name: "resolve_download",
    description:
      "Follow a partner download URL (from get_download_links) and return the final direct file URL after redirects.",
    inputSchema: {
      type: "object",
      required: ["url"],
      properties: {
        url: { type: "string", description: "Partner download URL from get_download_links" },
      },
    },
  },
];

// ─── MCP Request Router ─────────────────────────────────────────────────────
async function handleMcpRequest(body: any): Promise<any> {
  const { method, params, id } = body;

  const ok = (result: any) => ({ jsonrpc: "2.0", id, result });
  const err = (code: number, message: string) => ({
    jsonrpc: "2.0",
    id,
    error: { code, message },
  });

  if (method === "initialize") {
    return ok({
      protocolVersion: "2024-11-05",
      capabilities: { tools: {} },
      serverInfo: { name: "annas-archive-download-mcp", version: "1.0.0" },
    });
  }

  if (method === "tools/list") {
    return ok({ tools: TOOLS });
  }

  if (method === "tools/call") {
    const toolName: string = params?.name;
    const args: any = params?.arguments ?? {};

    try {
      let result: any;

      if (toolName === "search") {
        result = await searchBooks(args.query, args.limit ?? 10, args.content_type ?? "book_any");
      } else if (toolName === "get_details") {
        result = await getDetails(args.hash);
      } else if (toolName === "lookup_doi") {
        // Reuse search with DOI as query
        const items = await searchBooks(args.doi, 3, "book_any");
        result = items.length > 0 ? items : { error: "DOI not found in Anna's Archive" };
      } else if (toolName === "get_download_links") {
        result = await getDownloadLinks(args.hash);
      } else if (toolName === "resolve_download") {
        result = await resolveDownloadUrl(args.url);
      } else {
        return err(-32601, `Unknown tool: ${toolName}`);
      }

      return ok({
        content: [
          {
            type: "text",
            text: JSON.stringify(result, null, 2),
          },
        ],
      });
    } catch (e: any) {
      return ok({
        content: [
          {
            type: "text",
            text: JSON.stringify({ error: e?.message ?? String(e) }),
          },
        ],
        isError: true,
      });
    }
  }

  // Ping/notifications
  if (method === "ping") return ok({});
  if (method?.startsWith("notifications/")) return ok({});

  return err(-32601, `Method not found: ${method}`);
}

// ─── Vercel Handler (Streamable HTTP / stateless JSON) ──────────────────────
export default async function handler(req: VercelRequest, res: VercelResponse) {
  // CORS
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
  if (req.method === "OPTIONS") return res.status(204).end();

  // Health check
  if (req.method === "GET") {
    return res.status(200).json({
      name: "annas-archive-download-mcp",
      version: "1.0.0",
      description: "MCP server for Anna's Archive — search + slow download links (no API key needed)",
      tools: TOOLS.map((t) => t.name),
    });
  }

  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  const body = req.body;
  const response = await handleMcpRequest(body);
  return res.status(200).json(response);
}
