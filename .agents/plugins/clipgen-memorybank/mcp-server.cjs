#!/usr/bin/env node
'use strict';

const path = require('path');

const REPO_ROOT = path.resolve(__dirname, '../../..');
if (!process.env.MEMORYBANK_DIR) {
  process.env.MEMORYBANK_DIR = path.join(REPO_ROOT, '.memorybank');
}

const DEFAULT_NAMESPACE = process.env.MEMORYBANK_DEFAULT_NAMESPACE || 'clipgen-studio';

let store;
try {
  store = require(path.join(REPO_ROOT, 'node_modules/@ura-dev/memorybank/lib/store.js'));
} catch {
  store = require('@ura-dev/memorybank/lib/store');
}

const TOOLS = [
  {
    name: 'memory_store',
    description:
      'Store a new memory. Use this to save information that should persist across sessions — user preferences, project context, decisions, references.',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Short name for this memory' },
        type: {
          type: 'string',
          enum: ['user', 'project', 'feedback', 'reference', 'custom'],
          description:
            'Memory type: user, project, feedback, reference, or custom',
        },
        content: { type: 'string', description: 'The memory content — what to remember' },
        description: { type: 'string', description: 'One-line description for indexing and recall' },
        tags: { type: 'array', items: { type: 'string' }, description: 'Optional tags for categorization' },
        namespace: {
          type: 'string',
          description: `Project namespace (default: "${DEFAULT_NAMESPACE}")`,
        },
      },
      required: ['name', 'type', 'content'],
    },
  },
  {
    name: 'memory_recall',
    description:
      'Recall memories matching a query. Returns full content of the most relevant memories. Use this at the start of a session to load project context.',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'What to search for' },
        namespace: {
          type: 'string',
          description: `Project namespace (default: "${DEFAULT_NAMESPACE}")`,
        },
        limit: { type: 'number', description: 'Max results (default: 5)' },
      },
      required: ['query'],
    },
  },
  {
    name: 'memory_list',
    description: 'List stored memories. Optionally filter by type or tag.',
    inputSchema: {
      type: 'object',
      properties: {
        type: {
          type: 'string',
          enum: ['user', 'project', 'feedback', 'reference', 'custom'],
          description: 'Filter by memory type',
        },
        tag: { type: 'string', description: 'Filter by tag' },
        namespace: {
          type: 'string',
          description: `Project namespace (default: "${DEFAULT_NAMESPACE}")`,
        },
        limit: { type: 'number', description: 'Max results (default: 50)' },
      },
    },
  },
  {
    name: 'memory_get',
    description: 'Get a specific memory by its ID. Returns full content.',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'Memory ID (12-char hex)' },
        namespace: {
          type: 'string',
          description: `Project namespace (default: "${DEFAULT_NAMESPACE}")`,
        },
      },
      required: ['id'],
    },
  },
  {
    name: 'memory_update',
    description: 'Update an existing memory. Only provided fields are changed.',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'Memory ID to update' },
        name: { type: 'string', description: 'New name' },
        type: {
          type: 'string',
          enum: ['user', 'project', 'feedback', 'reference', 'custom'],
          description: 'New type',
        },
        content: { type: 'string', description: 'New content' },
        description: { type: 'string', description: 'New description' },
        tags: { type: 'array', items: { type: 'string' }, description: 'New tags' },
        namespace: {
          type: 'string',
          description: `Project namespace (default: "${DEFAULT_NAMESPACE}")`,
        },
      },
      required: ['id'],
    },
  },
  {
    name: 'memory_delete',
    description: 'Delete a memory by ID.',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'Memory ID to delete' },
        namespace: {
          type: 'string',
          description: `Project namespace (default: "${DEFAULT_NAMESPACE}")`,
        },
      },
      required: ['id'],
    },
  },
  {
    name: 'memory_search',
    description: 'Full-text search across all memories. Returns matches ranked by relevance.',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Search query' },
        namespace: {
          type: 'string',
          description: `Project namespace (default: "${DEFAULT_NAMESPACE}")`,
        },
        limit: { type: 'number', description: 'Max results (default: 20)' },
      },
      required: ['query'],
    },
  },
  {
    name: 'memory_stats',
    description: 'Get statistics about stored memories — counts by type, total size.',
    inputSchema: {
      type: 'object',
      properties: {
        namespace: {
          type: 'string',
          description: `Project namespace (default: "${DEFAULT_NAMESPACE}")`,
        },
      },
    },
  },
];

function handleToolCall(name, rawArgs) {
  const args = { ...(rawArgs || {}) };
  if (!args.namespace) {
    args.namespace = DEFAULT_NAMESPACE;
  }

  switch (name) {
    case 'memory_store':
      return store.store(args);
    case 'memory_recall':
      return store.recall(args.query, args);
    case 'memory_list':
      return store.list(args);
    case 'memory_get': {
      const mem = store.get(args.id, args.namespace);
      if (!mem) return { error: `Memory ${args.id} not found` };
      return mem;
    }
    case 'memory_update':
      return store.update(args.id, args);
    case 'memory_delete':
      return store.remove(args.id, args.namespace);
    case 'memory_search':
      return store.search(args.query, args);
    case 'memory_stats':
      return store.stats(args.namespace);
    default:
      return { error: `Unknown tool: ${name}` };
  }
}

// Byte-accurate dual-framing stdio MCP transport (supports newline-delimited JSON AND Content-Length)
let rxBuffer = Buffer.alloc(0);
let replyMode = 'line';

function send(obj) {
  const json = JSON.stringify(obj);
  if (replyMode === 'content-length') {
    const byteLen = Buffer.byteLength(json, 'utf8');
    process.stdout.write(`Content-Length: ${byteLen}\r\n\r\n${json}`, 'utf8');
  } else {
    process.stdout.write(`${json}\n`, 'utf8');
  }
}

function sendResponse(id, result) {
  send({ jsonrpc: '2.0', id, result });
}

function sendError(id, code, message) {
  send({ jsonrpc: '2.0', id, error: { code, message } });
}

function handleMessage(raw) {
  let req;
  try {
    req = JSON.parse(raw);
  } catch (e) {
    process.stderr.write(`bad JSON-RPC: ${e.message}\n`);
    return;
  }

  const { id, method, params } = req;

  switch (method) {
    case 'initialize': {
      const clientProto =
        params && typeof params.protocolVersion === 'string' && params.protocolVersion
          ? params.protocolVersion
          : '2024-11-05';
      sendResponse(id, {
        protocolVersion: clientProto,
        capabilities: { tools: {} },
        serverInfo: { name: 'clipgen-memorybank', version: '1.0.0' },
      });
      break;
    }

    case 'notifications/initialized':
      break;

    case 'tools/list':
      sendResponse(id, { tools: TOOLS });
      break;

    case 'resources/list':
      sendResponse(id, { resources: [] });
      break;

    case 'prompts/list':
      sendResponse(id, { prompts: [] });
      break;

    case 'tools/call': {
      const { name, arguments: args } = params || {};
      try {
        const result = handleToolCall(name, args);
        const hasError = Boolean(result && result.error);
        sendResponse(id, {
          content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
          isError: hasError,
        });
      } catch (e) {
        sendResponse(id, {
          content: [{ type: 'text', text: JSON.stringify({ error: e.message }) }],
          isError: true,
        });
      }
      break;
    }

    case 'ping':
      sendResponse(id, {});
      break;

    default:
      if (id !== undefined && id !== null) {
        sendError(id, -32601, `Method not found: ${method}`);
      }
  }
}

function parseMessages() {
  while (rxBuffer.length > 0) {
    const peek = rxBuffer.subarray(0, Math.min(64, rxBuffer.length)).toString('utf8');
    if (/^\s*Content-Length:/i.test(peek)) {
      const headerStart = peek.search(/Content-Length:/i);
      if (headerStart > 0) {
        rxBuffer = rxBuffer.subarray(headerStart);
      }

      const crlfIdx = rxBuffer.indexOf('\r\n\r\n');
      const lfIdx = crlfIdx === -1 ? rxBuffer.indexOf('\n\n') : -1;
      const headerEnd = crlfIdx !== -1 ? crlfIdx : lfIdx;
      const sepLen = crlfIdx !== -1 ? 4 : 2;
      if (headerEnd === -1) break;

      const headerText = rxBuffer.subarray(0, headerEnd).toString('utf8');
      const match = headerText.match(/Content-Length:\s*(\d+)/i);
      if (!match) {
        rxBuffer = rxBuffer.subarray(headerEnd + sepLen);
        continue;
      }

      const len = parseInt(match[1], 10);
      const bodyStart = headerEnd + sepLen;
      if (rxBuffer.length < bodyStart + len) break;

      const body = rxBuffer.subarray(bodyStart, bodyStart + len).toString('utf8');
      rxBuffer = rxBuffer.subarray(bodyStart + len);
      replyMode = 'content-length';
      handleMessage(body);
      continue;
    }

    const nlIdx = rxBuffer.indexOf(0x0a);
    if (nlIdx === -1) break;

    const line = rxBuffer.subarray(0, nlIdx).toString('utf8').replace(/\r$/, '').trim();
    rxBuffer = rxBuffer.subarray(nlIdx + 1);
    if (!line) continue;

    replyMode = 'line';
    handleMessage(line);
  }
}

process.stdin.on('data', (chunk) => {
  const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk, 'utf8');
  rxBuffer = Buffer.concat([rxBuffer, buf]);
  parseMessages();
});
process.stdin.on('end', () => process.exit(0));

process.stderr.write(`clipgen-memorybank MCP server running on stdio (dir=${process.env.MEMORYBANK_DIR}, ns=${DEFAULT_NAMESPACE})\n`);
