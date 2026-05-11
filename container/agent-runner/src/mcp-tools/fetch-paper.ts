/**
 * fetch_paper MCP tool — download full text of open-access scientific papers.
 *
 * Strategy (in order of attempt):
 *   1. Unpaywall API  — finds legal OA PDF/HTML URL from a DOI.
 *   2. OpenAlex `open_access.oa_url` — fallback when Unpaywall is unavailable.
 *   3. Europe PMC full-text XML — for PubMed-indexed articles.
 *
 * Returns the abstract + a snippet of the full text when available, and
 * saves the raw text to /workspace/agent/papers/<sanitized-title>.txt
 * for later reference by the agent.
 *
 * NOTE: Only open-access content is accessed. Paywalled PDFs are never
 * downloaded. If no OA version exists, the tool returns the abstract only.
 */
import fs from 'fs';
import path from 'path';

import { registerTools } from './server.js';
import type { McpToolDefinition } from './types.js';

function log(msg: string): void {
  console.error(`[fetch-paper] ${msg}`);
}

function ok(text: string) {
  return { content: [{ type: 'text' as const, text }] };
}

function err(text: string) {
  return { content: [{ type: 'text' as const, text: `Error: ${text}` }], isError: true };
}

const PAPERS_DIR = '/workspace/agent/papers';
const MAX_TEXT_CHARS = 80_000; // ~20k tokens — safe context window budget
const UNPAYWALL_EMAIL = 'locus.agent.os@example.com';

/** Sanitize a title string for use as a filename */
function safeFilename(title: string): string {
  return title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80);
}

/** Attempt to fetch the OA URL from Unpaywall given a DOI */
async function resolveUnpaywall(doi: string): Promise<string | null> {
  try {
    const cleanDoi = doi.replace(/^https?:\/\/doi\.org\//i, '');
    const url = `https://api.unpaywall.org/v2/${encodeURIComponent(cleanDoi)}?email=${UNPAYWALL_EMAIL}`;
    const resp = await fetch(url, { signal: AbortSignal.timeout(10_000) });
    if (!resp.ok) return null;
    const data = await resp.json() as {
      best_oa_location?: { url_for_pdf?: string; url?: string } | null;
      is_oa?: boolean;
    };
    if (!data.is_oa) return null;
    return data.best_oa_location?.url_for_pdf || data.best_oa_location?.url || null;
  } catch {
    return null;
  }
}

/** Attempt to fetch full text via Europe PMC (for PMID/DOI-indexed articles) */
async function resolveEuropePMC(doi: string): Promise<string | null> {
  try {
    const cleanDoi = doi.replace(/^https?:\/\/doi\.org\//i, '');
    const searchUrl = `https://www.ebi.ac.uk/europepmc/webservices/rest/search?query=DOI:${encodeURIComponent(cleanDoi)}&format=json&resultType=core`;
    const resp = await fetch(searchUrl, { signal: AbortSignal.timeout(10_000) });
    if (!resp.ok) return null;
    const data = await resp.json() as { resultList?: { result?: Array<{ pmcid?: string }> } };
    const pmcid = data.resultList?.result?.[0]?.pmcid;
    if (!pmcid) return null;

    const ftUrl = `https://www.ebi.ac.uk/europepmc/webservices/rest/${pmcid}/fullTextXML`;
    const ftResp = await fetch(ftUrl, { signal: AbortSignal.timeout(15_000) });
    if (!ftResp.ok) return null;
    const xml = await ftResp.text();
    // Crude XML→text: strip tags, collapse whitespace
    const text = xml
      .replace(/<[^>]+>/g, ' ')
      .replace(/\s{2,}/g, ' ')
      .trim();
    return text.slice(0, MAX_TEXT_CHARS) || null;
  } catch {
    return null;
  }
}

/** Fetch plain text from an OA URL (HTML or PDF-as-text via fetch) */
async function fetchTextFromUrl(url: string): Promise<string | null> {
  try {
    const resp = await fetch(url, {
      headers: { 'User-Agent': 'Locus-AgentOS/1.0 (scientific research; contact locus.agent.os@example.com)' },
      signal: AbortSignal.timeout(20_000),
    });
    if (!resp.ok) return null;

    const contentType = resp.headers.get('content-type') || '';

    if (contentType.includes('text/html')) {
      const html = await resp.text();
      // Strip tags, scripts, and style blocks
      const text = html
        .replace(/<script[\s\S]*?<\/script>/gi, '')
        .replace(/<style[\s\S]*?<\/style>/gi, '')
        .replace(/<[^>]+>/g, ' ')
        .replace(/\s{2,}/g, ' ')
        .trim();
      return text.slice(0, MAX_TEXT_CHARS) || null;
    }

    if (contentType.includes('text/plain')) {
      const text = await resp.text();
      return text.slice(0, MAX_TEXT_CHARS) || null;
    }

    // PDF: we can't parse binary PDFs in-container without a native tool.
    // Return a note instead of binary garbage.
    if (contentType.includes('application/pdf')) {
      return `[PDF available at ${url} — save the URL and use a PDF reader tool to extract text]`;
    }

    return null;
  } catch {
    return null;
  }
}

// ── fetch_paper ───────────────────────────────────────────────────────────────

export const fetchPaper: McpToolDefinition = {
  tool: {
    name: 'fetch_paper',
    description:
      'Download and read the full text (or abstract) of an open-access scientific paper by DOI or OpenAlex ID. ' +
      'Saves the text locally to /workspace/agent/papers/ for reference. ' +
      'Only accesses legally open-access content — never paywalled material.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        doi: {
          type: 'string',
          description: 'DOI of the paper (e.g. "10.1038/s41586-021-03819-2"). Either doi or openalex_id is required.',
        },
        openalex_id: {
          type: 'string',
          description: 'OpenAlex work ID (e.g. "W2741809807"). Used to look up the DOI if doi is not provided.',
        },
        save: {
          type: 'boolean',
          description: 'If true (default), save the full text locally to /workspace/agent/papers/. Set to false to only return the text.',
        },
      },
    },
  },
  async handler(args) {
    let doi = (args.doi as string | undefined)?.trim();
    const openalexId = (args.openalex_id as string | undefined)?.trim();
    const shouldSave = args.save !== false; // default true

    // Resolve DOI from OpenAlex ID if needed
    if (!doi && openalexId) {
      log(`Resolving DOI for OpenAlex ID: ${openalexId}`);
      try {
        const id = openalexId.includes('openalex.org/') ? openalexId.split('openalex.org/')[1] : openalexId;
        const resp = await fetch(
          `https://api.openalex.org/works/${encodeURIComponent(id)}?select=doi,title&mailto=${UNPAYWALL_EMAIL}`,
          { signal: AbortSignal.timeout(10_000) },
        );
        if (resp.ok) {
          const data = await resp.json() as { doi?: string; title?: string };
          doi = data.doi?.replace(/^https?:\/\/doi\.org\//i, '') || undefined;
          log(`Resolved DOI: ${doi}`);
        }
      } catch {
        log('OpenAlex DOI resolution failed');
      }
    }

    if (!doi && !openalexId) {
      return err('Either doi or openalex_id is required.');
    }

    // Fetch abstract + metadata from OpenAlex for context
    let title = 'paper';
    let abstract = '';
    let oaUrl: string | null = null;

    if (doi) {
      try {
        const cleanDoi = doi.replace(/^https?:\/\/doi\.org\//i, '');
        const resp = await fetch(
          `https://api.openalex.org/works/doi:${encodeURIComponent(cleanDoi)}?mailto=${UNPAYWALL_EMAIL}`,
          { signal: AbortSignal.timeout(10_000) },
        );
        if (resp.ok) {
          const work = await resp.json() as {
            title?: string;
            abstract_inverted_index?: Record<string, number[]>;
            open_access?: { oa_url?: string; is_oa?: boolean };
          };
          title = work.title || title;

          if (work.abstract_inverted_index) {
            const words: string[] = [];
            for (const [word, positions] of Object.entries(work.abstract_inverted_index)) {
              for (const pos of positions) words[pos] = word;
            }
            abstract = words.join(' ');
          }

          if (work.open_access?.is_oa) {
            oaUrl = work.open_access.oa_url || null;
          }
        }
      } catch {
        log('OpenAlex metadata fetch failed');
      }
    }

    // Attempt full-text retrieval in priority order
    let fullText: string | null = null;

    // 1. Unpaywall (most reliable OA resolver)
    if (!fullText && doi) {
      log(`Trying Unpaywall for DOI: ${doi}`);
      const unpaywallUrl = await resolveUnpaywall(doi);
      if (unpaywallUrl) {
        log(`Unpaywall OA URL: ${unpaywallUrl}`);
        fullText = await fetchTextFromUrl(unpaywallUrl);
      }
    }

    // 2. OpenAlex oa_url
    if (!fullText && oaUrl) {
      log(`Trying OpenAlex OA URL: ${oaUrl}`);
      fullText = await fetchTextFromUrl(oaUrl);
    }

    // 3. Europe PMC full-text XML
    if (!fullText && doi) {
      log(`Trying Europe PMC for DOI: ${doi}`);
      fullText = await resolveEuropePMC(doi);
    }

    // Build result
    const sections: string[] = [];
    sections.push(`# ${title}`);
    if (doi) sections.push(`**DOI:** https://doi.org/${doi}`);
    if (abstract) sections.push(`\n## Abstract\n\n${abstract}`);

    let savedPath: string | undefined;
    if (fullText) {
      sections.push(`\n## Full Text (excerpt, max ${MAX_TEXT_CHARS} chars)\n\n${fullText.slice(0, MAX_TEXT_CHARS)}`);

      if (shouldSave) {
        fs.mkdirSync(PAPERS_DIR, { recursive: true });
        const fname = `${safeFilename(title)}.txt`;
        const abs = path.join(PAPERS_DIR, fname);
        const fileContent = `Title: ${title}\nDOI: ${doi || 'N/A'}\n\n${abstract ? 'Abstract:\n' + abstract + '\n\n' : ''}Full Text:\n${fullText}`;
        fs.writeFileSync(abs, fileContent, 'utf8');
        savedPath = `papers/${fname}`;
        log(`Saved full text to ${abs}`);
      }
    } else {
      sections.push('\n**Full text not available in open access.** Only the abstract is shown above.');
      if (doi) sections.push(`\nTo access the full text, visit: https://doi.org/${doi}`);
    }

    if (savedPath) {
      sections.push(`\n\n*Full text saved to workspace: \`${savedPath}\`*`);
    }

    log(`fetch_paper complete — title: "${title}", fullText: ${!!fullText}`);
    return ok(sections.join('\n'));
  },
};

registerTools([fetchPaper]);
