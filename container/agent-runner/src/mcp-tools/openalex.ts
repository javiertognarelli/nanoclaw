/**
 * OpenAlex MCP tools for the ARCHIVIST agent.
 * OpenAlex is a fully open catalog of the global research system.
 */
import { registerTools } from './server.js';
import type { McpToolDefinition } from './types.js';

function log(msg: string): void {
  console.error(`[mcp-tools] ${msg}`);
}

function ok(text: string) {
  return { content: [{ type: 'text' as const, text }] };
}

function err(text: string) {
  return { content: [{ type: 'text' as const, text: `Error: ${text}` }], isError: true };
}

export const openalexSearch: McpToolDefinition = {
  tool: {
    name: 'openalex_search',
    description: 'Search for scientific papers and literature across all disciplines using OpenAlex. Returns metadata and abstracts for the most relevant works.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        query: { type: 'string', description: 'Search terms (keywords, author names, etc.)' },
        limit: { type: 'number', description: 'Number of results to return (max 10)' },
      },
      required: ['query'],
    },
  },
  async handler(args) {
    const query = args.query as string;
    const limit = Math.min((args.limit as number) || 5, 10);
    
    if (!query) return err('query is required');

    log(`openalex_search: "${query}" (limit ${limit})`);

    try {
      // Adding mailto is recommended by OpenAlex for the polite pool (faster response)
      const url = `https://api.openalex.org/works?search=${encodeURIComponent(query)}&per-page=${limit}&mailto=locus.agent.os@example.com`;
      const response = await fetch(url);
      
      if (!response.ok) {
        return err(`OpenAlex API returned status: ${response.status}`);
      }

      const data = await response.json();
      
      if (!data.results || data.results.length === 0) {
        return ok('No results found for that query.');
      }

      const results = data.results.map((work: any) => {
        const authors = work.authorships?.map((a: any) => a.author.display_name).join(', ') || 'Unknown Authors';
        let abstract = 'No abstract available.';
        
        // OpenAlex returns inverted abstracts. We need to reconstruct it if we want it,
        // but wait, they also return abstract_inverted_index. Reconstructing is slightly complex.
        if (work.abstract_inverted_index) {
          const words: string[] = [];
          for (const [word, positions] of Object.entries(work.abstract_inverted_index)) {
            for (const pos of (positions as number[])) {
              words[pos] = word;
            }
          }
          abstract = words.join(' ');
        }

        return `Title: ${work.title}
Authors: ${authors}
Publication Year: ${work.publication_year}
DOI: ${work.doi || 'N/A'}
ID: ${work.id}
Citations: ${work.cited_by_count}
Abstract: ${abstract}
---`;
      });

      return ok(`Found ${data.meta.count} total results. Showing top ${limit}:\n\n${results.join('\n')}`);
    } catch (error) {
      log(`openalex_search error: ${error}`);
      return err('Failed to fetch from OpenAlex.');
    }
  },
};

export const openalexGetWork: McpToolDefinition = {
  tool: {
    name: 'openalex_get_work',
    description: 'Get detailed information about a specific scientific work using its OpenAlex ID (e.g. "W2110599553").',
    inputSchema: {
      type: 'object' as const,
      properties: {
        id: { type: 'string', description: 'The OpenAlex ID of the work' },
      },
      required: ['id'],
    },
  },
  async handler(args) {
    let id = args.id as string;
    if (!id) return err('id is required');

    // Strip URL prefix if agent passed full URL
    if (id.includes('openalex.org/')) {
      id = id.split('openalex.org/')[1];
    }

    log(`openalex_get_work: ${id}`);

    try {
      const url = `https://api.openalex.org/works/${encodeURIComponent(id)}?mailto=locus.agent.os@example.com`;
      const response = await fetch(url);
      
      if (!response.ok) {
        if (response.status === 404) return err('Work not found.');
        return err(`OpenAlex API returned status: ${response.status}`);
      }

      const work = await response.json();
      
      const authors = work.authorships?.map((a: any) => a.author.display_name).join(', ') || 'Unknown Authors';
      let abstract = 'No abstract available.';
      if (work.abstract_inverted_index) {
        const words: string[] = [];
        for (const [word, positions] of Object.entries(work.abstract_inverted_index)) {
          for (const pos of (positions as number[])) {
            words[pos] = word;
          }
        }
        abstract = words.join(' ');
      }

      const result = `Title: ${work.title}
Authors: ${authors}
Publication Date: ${work.publication_date}
DOI: ${work.doi || 'N/A'}
Open Access: ${work.open_access?.is_oa ? 'Yes' : 'No'} (${work.open_access?.oa_status})
URL: ${work.primary_location?.landing_page_url || 'N/A'}
Citations: ${work.cited_by_count}
Concepts: ${work.concepts?.map((c: any) => c.display_name).join(', ') || 'None'}

Abstract:
${abstract}
`;

      return ok(result);
    } catch (error) {
      log(`openalex_get_work error: ${error}`);
      return err('Failed to fetch from OpenAlex.');
    }
  },
};

registerTools([openalexSearch, openalexGetWork]);
