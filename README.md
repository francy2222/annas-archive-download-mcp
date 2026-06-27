# Anna's Archive MCP — Download Links (no API key required)

MCP server for searching Anna's Archive and extracting **free slow download links** (LibGen, library.lol, IPFS) from the detail page — no paid API key needed.

## Tools

| Tool | Description |
|------|-------------|
| `search` | Search by title, author, ISBN, DOI |
| `get_details` | Full metadata by MD5 hash |
| `lookup_doi` | Resolve DOI to MD5 |
| `get_download_links` | **Scrape slow download links from the MD5 page (free!)** |
| `resolve_download` | Follow a partner URL to the real file URL |

## Endpoint

```
https://annas-archive-download-mcp.vercel.app/api/mcp
```

## Usage in Claude.ai

Add as a custom MCP connector with the URL above.

## How slow downloads work

Anna's Archive lists "partner" sites (LibGen, library.lol) as free slow alternatives to the paid fast download API.  
`get_download_links` scrapes those links directly from the HTML page using browser headers.  
`resolve_download` follows the redirect chain to give you the final direct file URL.

## Deployment

```bash
vercel deploy --prod
```
