/**
 * Calendar MCP tools: add_event, list_events, delete_event
 *
 * Uses a local SQLite database (calendar.db) stored in the agent's working
 * directory (/workspace/agent/calendar.db) to persist events.
 */
import Database from 'better-sqlite3';
import path from 'path';
import { TIMEZONE, parseZonedToUtc } from '../timezone.js';
import { registerTools } from './server.js';
import type { McpToolDefinition } from './types.js';

function log(msg: string): void {
  console.error(`[mcp-tools] ${msg}`);
}

const DB_PATH = path.join('/workspace/agent', 'calendar.db');

let _db: Database.Database | null = null;
function getDb(): Database.Database {
  if (!_db) {
    _db = new Database(DB_PATH);
    _db.pragma('journal_mode = WAL');
    _db.exec(`
      CREATE TABLE IF NOT EXISTS events (
        id TEXT PRIMARY KEY,
        title TEXT NOT NULL,
        description TEXT,
        start_time TEXT NOT NULL,
        end_time TEXT NOT NULL,
        created_at TEXT NOT NULL
      )
    `);
  }
  return _db;
}

function ok(text: string) {
  return { content: [{ type: 'text' as const, text }] };
}

function err(text: string) {
  return { content: [{ type: 'text' as const, text: `Error: ${text}` }], isError: true };
}

export const addEvent: McpToolDefinition = {
  tool: {
    name: 'add_event',
    description: 'Add an event to the calendar. The start_time and end_time accept ISO 8601 strings (e.g., "2026-05-01T14:00:00" for 2pm local time in the user timezone).',
    inputSchema: {
      type: 'object' as const,
      properties: {
        title: { type: 'string', description: 'Event title' },
        description: { type: 'string', description: 'Optional event description' },
        start_time: { type: 'string', description: 'Start time (e.g., 2026-05-01T14:00:00)' },
        end_time: { type: 'string', description: 'End time (e.g., 2026-05-01T15:00:00)' },
      },
      required: ['title', 'start_time', 'end_time'],
    },
  },
  async handler(args) {
    const { title, description = '', start_time, end_time } = args;
    if (!title || !start_time || !end_time) return err('title, start_time, and end_time are required');

    let startUtc: string;
    let endUtc: string;
    try {
      startUtc = parseZonedToUtc(start_time as string, TIMEZONE).toISOString();
      endUtc = parseZonedToUtc(end_time as string, TIMEZONE).toISOString();
    } catch {
      return err('Invalid start_time or end_time format');
    }

    const id = `evt-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const db = getDb();
    
    db.prepare(`
      INSERT INTO events (id, title, description, start_time, end_time, created_at)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(id, title, description, startUtc, endUtc, new Date().toISOString());

    log(`add_event: ${id} - ${title}`);
    return ok(`Event added successfully with ID: ${id}`);
  },
};

export const listEvents: McpToolDefinition = {
  tool: {
    name: 'list_events',
    description: 'List calendar events. Optionally filter by date range. Dates should be in ISO 8601 format (e.g., "2026-05-01").',
    inputSchema: {
      type: 'object' as const,
      properties: {
        from_date: { type: 'string', description: 'List events starting after this time (e.g., 2026-05-01T00:00:00)' },
        to_date: { type: 'string', description: 'List events starting before this time (e.g., 2026-05-07T23:59:59)' },
      },
    },
  },
  async handler(args) {
    let fromUtc: string | undefined;
    let toUtc: string | undefined;

    if (args.from_date) {
      try {
        fromUtc = parseZonedToUtc(args.from_date as string, TIMEZONE).toISOString();
      } catch {
        return err('Invalid from_date format');
      }
    }
    if (args.to_date) {
      try {
        toUtc = parseZonedToUtc(args.to_date as string, TIMEZONE).toISOString();
      } catch {
        return err('Invalid to_date format');
      }
    }

    const db = getDb();
    let query = 'SELECT * FROM events';
    const params: string[] = [];
    const conditions: string[] = [];

    if (fromUtc) {
      conditions.push('start_time >= ?');
      params.push(fromUtc);
    }
    if (toUtc) {
      conditions.push('start_time <= ?');
      params.push(toUtc);
    }

    if (conditions.length > 0) {
      query += ' WHERE ' + conditions.join(' AND ');
    }
    query += ' ORDER BY start_time ASC';

    const rows = db.prepare(query).all(...params) as Array<{
      id: string;
      title: string;
      description: string;
      start_time: string;
      end_time: string;
    }>;

    if (rows.length === 0) return ok('No events found in the specified range.');

    const lines = rows.map((r) => {
      // Return UTC time since the agent knows how to format it based on its context timezone.
      return `- [${r.id}] ${r.title} (Start: ${r.start_time}, End: ${r.end_time})\n  Desc: ${r.description}`;
    });

    return ok(lines.join('\n'));
  },
};

export const deleteEvent: McpToolDefinition = {
  tool: {
    name: 'delete_event',
    description: 'Delete a calendar event by its ID.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        eventId: { type: 'string', description: 'The ID of the event to delete' },
      },
      required: ['eventId'],
    },
  },
  async handler(args) {
    const eventId = args.eventId as string;
    if (!eventId) return err('eventId is required');

    const db = getDb();
    const info = db.prepare('DELETE FROM events WHERE id = ?').run(eventId);

    if (info.changes === 0) {
      return err(`Event not found with ID: ${eventId}`);
    }

    log(`delete_event: ${eventId}`);
    return ok(`Event ${eventId} deleted successfully.`);
  },
};

registerTools([addEvent, listEvents, deleteEvent]);
