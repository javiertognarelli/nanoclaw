/**
 * doc_writer MCP tools — file-based document management for SCRIBE.
 *
 * Allows agents to create, read, append to, and list Markdown (and plain
 * text) files inside their agent workspace (/workspace/agent/). Files
 * written here persist across sessions (mounted RW from groups/<folder>/).
 *
 * Tools:
 *   doc_write   — create or overwrite a file
 *   doc_append  — append a section to an existing file (or create it)
 *   doc_read    — read a file's content
 *   doc_list    — list all .md and .txt files in the workspace
 *   doc_delete  — delete a file
 *
 * Security:
 *   All paths are resolved relative to WORKSPACE_DIR and validated to
 *   remain inside it (no path traversal via ../../ etc.).
 *   Only .md, .txt, and .rst extensions are permitted (no code execution).
 */
import fs from 'fs';
import path from 'path';

import { registerTools } from './server.js';
import type { McpToolDefinition } from './types.js';

function log(msg: string): void {
  console.error(`[doc-writer] ${msg}`);
}

const WORKSPACE_DIR = '/workspace/agent';
const ALLOWED_EXTENSIONS = new Set(['.md', '.txt', '.rst']);
const MAX_FILE_SIZE_BYTES = 2 * 1024 * 1024; // 2 MB cap

function ok(text: string) {
  return { content: [{ type: 'text' as const, text }] };
}

function err(text: string) {
  return { content: [{ type: 'text' as const, text: `Error: ${text}` }], isError: true };
}

/**
 * Resolve a caller-supplied filename to an absolute path inside
 * WORKSPACE_DIR. Returns null if the resolved path escapes the workspace
 * or uses a disallowed extension.
 */
function safePath(filename: string): string | null {
  // Strip any leading /workspace/agent prefix so callers can pass either style.
  const cleaned = filename
    .replace(/^\/workspace\/agent\/?/, '')
    .replace(/^\.\//, '');

  const ext = path.extname(cleaned).toLowerCase();
  if (!ALLOWED_EXTENSIONS.has(ext)) return null;

  const resolved = path.resolve(WORKSPACE_DIR, cleaned);
  if (!resolved.startsWith(WORKSPACE_DIR + path.sep) && resolved !== WORKSPACE_DIR) {
    return null; // path traversal attempt
  }
  return resolved;
}

// ── doc_write ─────────────────────────────────────────────────────────────────

export const docWrite: McpToolDefinition = {
  tool: {
    name: 'doc_write',
    description:
      'Create or overwrite a Markdown/text file in the agent workspace. ' +
      'Use this to persist drafts, notes, or formatted documents. ' +
      'Allowed extensions: .md, .txt, .rst. ' +
      'Example filename: "draft-intro.md"',
    inputSchema: {
      type: 'object' as const,
      properties: {
        filename: {
          type: 'string',
          description: 'Filename relative to the agent workspace (e.g. "draft-intro.md", "reports/summary.md")',
        },
        content: {
          type: 'string',
          description: 'Full file content to write',
        },
      },
      required: ['filename', 'content'],
    },
  },
  async handler(args) {
    const filename = args.filename as string;
    const content = args.content as string;
    if (!filename) return err('filename is required');
    if (content === undefined || content === null) return err('content is required');

    const abs = safePath(filename);
    if (!abs) return err(`Invalid filename "${filename}". Use a relative path with extension .md, .txt, or .rst and no path traversal.`);

    if (Buffer.byteLength(content, 'utf8') > MAX_FILE_SIZE_BYTES) {
      return err(`Content too large (max 2 MB). Split into multiple files.`);
    }

    const dir = path.dirname(abs);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(abs, content, 'utf8');

    log(`doc_write: ${abs} (${content.length} chars)`);
    return ok(`File written: ${filename} (${content.length} characters)`);
  },
};

// ── doc_append ────────────────────────────────────────────────────────────────

export const docAppend: McpToolDefinition = {
  tool: {
    name: 'doc_append',
    description:
      'Append a section to an existing Markdown/text file (creates the file if it does not exist). ' +
      'Ideal for incrementally building a document section by section.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        filename: {
          type: 'string',
          description: 'Filename relative to the agent workspace (e.g. "draft-intro.md")',
        },
        content: {
          type: 'string',
          description: 'Text to append (a blank line is automatically inserted before it)',
        },
      },
      required: ['filename', 'content'],
    },
  },
  async handler(args) {
    const filename = args.filename as string;
    const content = args.content as string;
    if (!filename) return err('filename is required');
    if (!content) return err('content is required');

    const abs = safePath(filename);
    if (!abs) return err(`Invalid filename "${filename}".`);

    const dir = path.dirname(abs);
    fs.mkdirSync(dir, { recursive: true });

    // Check total size won't exceed cap
    const existing = fs.existsSync(abs) ? fs.statSync(abs).size : 0;
    if (existing + Buffer.byteLength(content, 'utf8') > MAX_FILE_SIZE_BYTES) {
      return err(`File would exceed 2 MB limit after append.`);
    }

    // Ensure a blank separator line between sections
    const separator = fs.existsSync(abs) ? '\n\n' : '';
    fs.appendFileSync(abs, separator + content, 'utf8');

    log(`doc_append: ${abs} (+${content.length} chars)`);
    return ok(`Appended to ${filename} (+${content.length} characters)`);
  },
};

// ── doc_read ──────────────────────────────────────────────────────────────────

export const docRead: McpToolDefinition = {
  tool: {
    name: 'doc_read',
    description: 'Read the content of a file from the agent workspace.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        filename: {
          type: 'string',
          description: 'Filename relative to the agent workspace',
        },
      },
      required: ['filename'],
    },
  },
  async handler(args) {
    const filename = args.filename as string;
    if (!filename) return err('filename is required');

    const abs = safePath(filename);
    if (!abs) return err(`Invalid filename "${filename}".`);

    if (!fs.existsSync(abs)) return err(`File not found: ${filename}`);

    const stat = fs.statSync(abs);
    if (stat.size > MAX_FILE_SIZE_BYTES) {
      return err(`File too large to read inline (${stat.size} bytes). Use doc_list to see its size.`);
    }

    const content = fs.readFileSync(abs, 'utf8');
    log(`doc_read: ${abs} (${content.length} chars)`);
    return ok(content);
  },
};

// ── doc_list ──────────────────────────────────────────────────────────────────

export const docList: McpToolDefinition = {
  tool: {
    name: 'doc_list',
    description:
      'List all document files (.md, .txt, .rst) in the agent workspace. ' +
      'Returns filename, size in bytes, and last-modified date.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        subfolder: {
          type: 'string',
          description: 'Optional subfolder to list (e.g. "reports"). Lists root workspace if omitted.',
        },
      },
    },
  },
  async handler(args) {
    const subfolder = args.subfolder as string | undefined;
    const baseDir = subfolder ? path.resolve(WORKSPACE_DIR, subfolder) : WORKSPACE_DIR;

    // Validate subfolder doesn't escape workspace
    if (!baseDir.startsWith(WORKSPACE_DIR)) {
      return err('Invalid subfolder path.');
    }

    if (!fs.existsSync(baseDir)) {
      return ok(`No files found (folder does not exist${subfolder ? ': ' + subfolder : ''}).`);
    }

    const files: string[] = [];
    function walk(dir: string, prefix: string): void {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
        if (entry.isDirectory()) {
          walk(path.join(dir, entry.name), rel);
        } else {
          const ext = path.extname(entry.name).toLowerCase();
          if (ALLOWED_EXTENSIONS.has(ext)) {
            const stat = fs.statSync(path.join(dir, entry.name));
            const kb = (stat.size / 1024).toFixed(1);
            const mtime = stat.mtime.toISOString().slice(0, 16).replace('T', ' ');
            files.push(`${rel}  (${kb} KB, modified ${mtime})`);
          }
        }
      }
    }
    walk(baseDir, '');

    if (files.length === 0) return ok('No document files found in workspace.');
    return ok(`Documents in workspace${subfolder ? '/' + subfolder : ''}:\n\n` + files.join('\n'));
  },
};

// ── doc_delete ────────────────────────────────────────────────────────────────

export const docDelete: McpToolDefinition = {
  tool: {
    name: 'doc_delete',
    description: 'Delete a document file from the agent workspace.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        filename: {
          type: 'string',
          description: 'Filename relative to the agent workspace',
        },
      },
      required: ['filename'],
    },
  },
  async handler(args) {
    const filename = args.filename as string;
    if (!filename) return err('filename is required');

    const abs = safePath(filename);
    if (!abs) return err(`Invalid filename "${filename}".`);

    if (!fs.existsSync(abs)) return err(`File not found: ${filename}`);

    fs.unlinkSync(abs);
    log(`doc_delete: ${abs}`);
    return ok(`Deleted: ${filename}`);
  },
};

registerTools([docWrite, docAppend, docRead, docList, docDelete]);
