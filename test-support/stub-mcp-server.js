#!/usr/bin/env node
'use strict';

// A stand-in for ModelBrain's mcp_server, for tests. It speaks the same
// line-by-line MCP messages and answers `diagnostics` and `recall` from
// environment variables. It contains nothing from ModelBrain.

const fs = require('node:fs');

const root = process.env.STUB_ROOT || '';
const log = process.env.STUB_LOG || '';
const mode = process.env.STUB_MODE || '';
const hits = process.env.STUB_HITS ? JSON.parse(process.env.STUB_HITS) : null;

function reply(id, result) {
  process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id, result }) + '\n');
}

function structured(id, value) {
  reply(id, { content: [{ type: 'text', text: JSON.stringify(value) }], structuredContent: value });
}

let buffer = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => {
  buffer += chunk;
  let nl;
  while ((nl = buffer.indexOf('\n')) !== -1) {
    const line = buffer.slice(0, nl).trim();
    buffer = buffer.slice(nl + 1);
    if (!line) continue;
    const msg = JSON.parse(line);
    if (msg.method === 'initialize') {
      if (log) fs.appendFileSync(log, JSON.stringify({ initialize: msg.params }) + '\n');
      reply(msg.id, { protocolVersion: msg.params.protocolVersion, capabilities: {}, serverInfo: { name: 'modelbrain', version: '0.9.4' } });
    } else if (msg.method === 'tools/call') {
      const { name, arguments: args } = msg.params;
      if (log) fs.appendFileSync(log, JSON.stringify({ tool: name, args }) + '\n');
      if (name === 'diagnostics') {
        structured(msg.id, {
          version: '0.9.4',
          degraded: false,
          connectors: (root ? [{ id: 'docs', root, synced: 2 }] : []).concat([
            { id: 'notes', root: '/somewhere/notes', synced: 40 },
            { id: 'mail', root: '/somewhere/mail', kind: 'mail', synced: 900 },
          ]),
        });
      } else if (name === 'partition_list') {
        structured(msg.id, {
          partitions: [
            { id: '00000000000000000000000000', display_name: 'unsorted', archived: false, is_default: true },
            { id: '01PARTITIONWORK00000000000', display_name: 'Work', archived: false, is_default: false },
            { id: '01PARTITIONOLD000000000000', display_name: 'Old', archived: true, is_default: false },
          ],
          status: 'ok',
        });
      } else if (name === 'recall') {
        if (mode === 'busy') {
          process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: msg.id, error: { code: -32603, message: 'store is busy: held by compaction', data: { code: 'store_busy' } } }) + '\n');
        } else if (mode === 'refuse') {
          reply(msg.id, { isError: true, content: [{ type: 'text', text: 'this client is blocked' }] });
        } else if (mode === 'exit') {
          process.exit(3);
        } else {
          const scope = String(args.scope || '');
          const connectorId = scope.startsWith('connector:') ? scope.slice('connector:'.length) : 'docs';
          const partitionId = String(args.partition_scope || '').startsWith('id:') ? args.partition_scope.slice(3) : '00000000000000000000000000';
          const folder = args.folder === undefined || args.folder === '/' ? '' : args.folder + '/';
          structured(msg.id, {
            hits: hits || [
              {
                key: '01ABC',
                text: 'Refunds are issued within 14 days.',
                relevance: 0.81,
                source: 'connector',
                connector_id: connectorId,
                partition_id: partitionId,
                source_uri: `${folder}refunds.md`,
                heading_path: ['Policy', 'Refunds'],
                source_date: '2026-11-01T00:00:00Z',
                source_date_kind: 'indexed',
                injection_flagged: false,
              },
            ],
            status: 'ok',
          });
        }
      } else {
        reply(msg.id, { isError: true, content: [{ type: 'text', text: `unknown tool ${name}` }] });
      }
    }
  }
});
