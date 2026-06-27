# Anna's Archive MCP — Free Slow Downloads (no API key)

MCP server per cercare su Anna's Archive e scaricare **gratis** via i canali slow:
- **LibGen 2-step** (`ads.php` → session key → `get.php`) — funziona per libri e articoli
- **Sci-Net** (`sci-net.xyz`) — PDF da DOI per articoli scientifici, senza chiave
- **AA slow partner links** (library.lol, IPFS, Z-Library mirrors) — estratti dalla pagina HTML

## Tool disponibili

| Tool | Descrizione |
|------|-------------|
| `search` | Cerca per titolo, autore, ISBN, DOI (tutte le fonti: LibGen, Z-Lib, Sci-Hub, DuXiu…) |
| `get_details` | Metadati completi per MD5 hash |
| `lookup_doi` | Risolve un DOI → MD5 + metadati via SciDB di AA |
| `get_download_links` | Scrapa la pagina AA, risolve LibGen session URL, detecta DOI per Sci-Net |
| `resolve_libgen` | Resolve diretto LibGen: ads.php → get.php con session key |
| `get_scinet_url` | DOI → PDF diretto su Sci-Net (per articoli scientifici) |

## Endpoint

```
https://annas-archive-download-mcp.vercel.app/api/mcp
```

## Come funziona il download free

### Libri (LibGen 2-step)
1. `resolve_libgen(hash)` → `ads.php?md5=hash` → estrae session key
2. Ritorna `get.php?md5=hash&key=SESSION` — URL diretto al file
3. La session key è valida pochi minuti, usarla subito nel browser

### Articoli scientifici (Sci-Net)
1. `lookup_doi(doi)` per trovare l'MD5
2. `get_scinet_url(doi)` → `sci-net.xyz/{doi}` → iframe PDF → URL diretto

### Flusso consigliato per Claude
1. `search` → ottieni MD5
2. `get_download_links` → tutti i link slow + LibGen session URL già risolto
3. Se è un articolo con DOI → `get_scinet_url` come alternativa
