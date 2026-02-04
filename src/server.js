#!/usr/bin/env node

/**
 * legitify-mcp — MCP server (stdio)
 *
 * Legitify provides human attestation (approval receipts) for high-impact AI actions.
 * This server lets OpenClaw (and other MCP clients) submit attestation requests and
 * fetch policy/status.
 */

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { z } from 'zod';

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';

const DIR = process.env.LEGITIFY_QUEUE_DIR || path.join(os.homedir(), '.legitify');
const QUEUE_PATH = process.env.LEGITIFY_QUEUE_PATH || path.join(DIR, 'attestation-requests.jsonl');
const RESP_PATH = process.env.LEGITIFY_RESPONSES_PATH || path.join(DIR, 'attestation-responses.jsonl');
fs.mkdirSync(DIR, { recursive: true });

const AttestationRequestSchema = z.object({
  kind: z.enum(['contract','filing','compliance_action','financial_instruction','deploy','access']).default('compliance_action'),
  title: z.string().min(1),
  summary: z.string().min(1),
  risk_level: z.enum(['low','medium','high']).default('medium'),
  links: z.array(z.string().url()).optional().default([]),
  evidence: z.array(z.string()).optional().default([]),
  requested_action: z.enum(['approve','deny','needs_info']).optional().default('approve'),
  spend_usd: z.number().nonnegative().optional(),
  currency: z.string().optional().default('USD')
});

function jsonlAppend(filePath, obj){
  fs.appendFileSync(filePath, JSON.stringify(obj) + '\n', 'utf8');
}

function readJsonl(filePath){
  if (!fs.existsSync(filePath)) return [];
  const lines = fs.readFileSync(filePath, 'utf8').split('\n').map(l => l.trim()).filter(Boolean);
  const out = [];
  for (const line of lines) {
    try { out.push(JSON.parse(line)); } catch {}
  }
  return out;
}

function findLatestReceipt(attestationRequestId){
  if (!attestationRequestId) return null;
  const items = readJsonl(RESP_PATH);
  for (let i = items.length - 1; i >= 0; i--) {
    const obj = items[i];
    if (obj?.attestation_request_id === attestationRequestId) return obj;
  }
  return null;
}

function listPending(limit = 25){
  const items = readJsonl(QUEUE_PATH);
  const pending = items.filter(x => (x.status || 'pending') === 'pending');
  return pending.slice(-limit).reverse();
}

function appendReceipt(receipt){
  jsonlAppend(RESP_PATH, receipt);
}

const server = new Server(
  { name: 'legitify-mcp', version: '0.2.0' },
  { capabilities: { tools: {} } }
);

server.setRequestHandler(ListToolsRequestSchema, async () => {
  return {
    tools: [
      {
        name: 'legitify.submit_attestation_request',
        description: 'Submit a request for human attestation (approval receipt). Returns attestation_request_id and status=pending.',
        inputSchema: {
          type: 'object',
          properties: {
            kind: { type: 'string', enum: ['contract','filing','compliance_action','financial_instruction','deploy','access'] },
            title: { type: 'string' },
            summary: { type: 'string' },
            risk_level: { type: 'string', enum: ['low','medium','high'] },
            links: { type: 'array', items: { type: 'string' } },
            evidence: { type: 'array', items: { type: 'string' } },
            requested_action: { type: 'string', enum: ['approve','deny','needs_info'] },
            spend_usd: { type: 'number' },
            currency: { type: 'string' }
          },
          required: ['title','summary']
        }
      },
      {
        name: 'legitify.get_attestation_status',
        description: 'Get status for an attestation_request_id (MVP: pending unless manually processed).',
        inputSchema: {
          type: 'object',
          properties: { attestation_request_id: { type: 'string' } },
          required: ['attestation_request_id']
        }
      },
      {
        name: 'legitify.get_policy',
        description: 'Get default policy info (caps, required evidence expectations).',
        inputSchema: { type: 'object', properties: {} }
      },
      {
        name: 'legitify.list_pending_requests',
        description: 'List pending attestation requests (from local queue).',
        inputSchema: {
          type: 'object',
          properties: {
            limit: { type: 'number', minimum: 1, maximum: 100 }
          }
        }
      },
      {
        name: 'legitify.review_request',
        description: 'Write a human attestation receipt for an existing attestation_request_id (approved/denied/needs_info).',
        inputSchema: {
          type: 'object',
          required: ['attestation_request_id', 'decision'],
          properties: {
            attestation_request_id: { type: 'string' },
            decision: { type: 'string', enum: ['approved','denied','needs_info'] },
            scope: { type: 'string' },
            notes: { type: 'string' },
            reviewed_by: { type: 'string' }
          }
        }
      },
      {
        name: 'legitify.get_pending_request_details',
        description: 'Fetch full details for a pending request by id (including evidence).',
        inputSchema: {
          type: 'object',
          required: ['attestation_request_id'],
          properties: {
            attestation_request_id: { type: 'string' }
          }
        }
      }
    ]
  };
});

server.setRequestHandler(CallToolRequestSchema, async (req) => {
  const { name, arguments: args } = req.params;

  if (name === 'legitify.get_policy') {
    const payload = {
      ok: true,
      policy_version: 'v1',
      default_monthly_approval_cap_usd: 2000,
      decisions: ['approved','denied','needs_info'],
      guidance: {
        required_evidence_examples: [
          'PR link + diff summary + staging proof (deploy)',
          'Invoice/checkout link + vendor domain + purpose (spend)',
          'Who/what/why + duration + scope (access)'
        ]
      }
    };
    return { content: [{ type: 'text', text: JSON.stringify(payload, null, 2) }] };
  }

  if (name === 'legitify.get_attestation_status') {
    const id = String(args?.attestation_request_id || '');
    if (!id) {
      return { content: [{ type: 'text', text: JSON.stringify({ ok:false, status:'needs_info', error:'missing attestation_request_id' }) }] };
    }

    const receipt = findLatestReceipt(id);
    if (!receipt) {
      return { content: [{ type: 'text', text: JSON.stringify({ ok:true, status:'pending', attestation_request_id: id }) }] };
    }

    const status = receipt.decision || 'approved';
    return { content: [{
      type: 'text',
      text: JSON.stringify({ ok:true, status, attestation_request_id: id, receipt }, null, 2)
    }] };
  }

  if (name === 'legitify.submit_attestation_request') {
    const parsed = AttestationRequestSchema.safeParse(args || {});
    if (!parsed.success) {
      const out = { ok:false, status:'needs_info', errors: parsed.error.flatten() };
      return { content: [{ type: 'text', text: JSON.stringify(out, null, 2) }] };
    }

    const reqData = parsed.data;
    const id = `attreq_${Date.now()}_${Math.random().toString(16).slice(2)}`;
    jsonlAppend(QUEUE_PATH, { id, status: 'pending', createdAt: new Date().toISOString(), request: reqData });

    const out = {
      ok: true,
      status: 'pending',
      attestation_request_id: id,
      next: { message: 'Queued for human review. Attach evidence links if available.' }
    };
    return { content: [{ type: 'text', text: JSON.stringify(out, null, 2) }] };
  }

  if (name === 'legitify.list_pending_requests') {
    const limit = Number(args?.limit || 25);
    const items = listPending(Number.isFinite(limit) ? Math.max(1, Math.min(100, limit)) : 25);
    const out = {
      ok: true,
      pendingCount: items.length,
      pending: items.map((x) => ({
        id: x.id,
        createdAt: x.createdAt,
        kind: x.request?.kind,
        risk_level: x.request?.risk_level,
        title: x.request?.title,
        summary: x.request?.summary,
        links: x.request?.links || [],
        spend_usd: x.request?.spend_usd,
        currency: x.request?.currency || 'USD'
      }))
    };
    return { content: [{ type: 'text', text: JSON.stringify(out, null, 2) }] };
  }

  const findPendingById = (attestation_request_id) => {
    const items = readJsonl(QUEUE_PATH);
    for (let i = items.length - 1; i >= 0; i--) {
      if (items[i]?.id === attestation_request_id) return items[i];
    }
    return null;
  };

  if (name === 'legitify.get_pending_request_details') {
    const attestation_request_id = String(args?.attestation_request_id || '');
    if (!attestation_request_id) {
      return { content: [{ type: 'text', text: JSON.stringify({ ok:false, status:'needs_info', error:'missing attestation_request_id' }) }] };
    }
    const req = findPendingById(attestation_request_id);
    if (!req) {
      return { content: [{ type: 'text', text: JSON.stringify({ ok:false, status:'needs_info', error:'request not found in queue' }) }] };
    }
    const out = {
      ok: true,
      status: req.status || 'pending',
      attestation_request_id,
      request: req
    };
    return { content: [{ type: 'text', text: JSON.stringify(out, null, 2) }] };
  }

  if (name === 'legitify.review_request') {
    const attestation_request_id = String(args?.attestation_request_id || '');
    const decision = String(args?.decision || '').toLowerCase();
    if (!attestation_request_id || !['approved','denied','needs_info'].includes(decision)) {
      return { content: [{ type: 'text', text: JSON.stringify({ ok:false, status:'needs_info', error:'missing/invalid attestation_request_id or decision' }) }] };
    }

    const req = findPendingById(attestation_request_id);
    if (!req) {
      return { content: [{ type: 'text', text: JSON.stringify({ ok:false, status:'needs_info', error:'request not found in queue' }) }] };
    }

    // If already has a receipt, return it (idempotent)
    const existing = findLatestReceipt(attestation_request_id);
    if (existing) {
      return { content: [{ type: 'text', text: JSON.stringify({ ok:true, status: existing.decision || 'approved', attestation_request_id, receipt: existing }, null, 2) }] };
    }

    const now = new Date().toISOString();
    const attestation_id = `att_${Date.now()}_${Math.random().toString(16).slice(2)}`;
    const reviewed_by = String(args?.reviewed_by || 'neely');
    const scope = String(args?.scope || 'human_attestation_v1');
    const notes = String(args?.notes || '');

    const receipt = {
      ok: true,
      attestation_id,
      attestation_request_id,
      reviewed_by,
      timestamp: now,
      scope,
      decision,
      policy_version: 'v1',
      notes,
      request: {
        kind: req.request?.kind,
        title: req.request?.title,
        summary: req.request?.summary,
        risk_level: req.request?.risk_level,
        links: req.request?.links || [],
        evidence: req.request?.evidence || [],
        spend_usd: req.request?.spend_usd,
        currency: req.request?.currency || 'USD'
      }
    };

    appendReceipt(receipt);

    return { content: [{ type: 'text', text: JSON.stringify({ ok:true, status: decision, attestation_request_id, receipt }, null, 2) }] };
  }

  return { content: [{ type: 'text', text: JSON.stringify({ ok:false, status:'needs_info', error:`unknown tool: ${name}` }) }] };
});

const transport = new StdioServerTransport();
await server.connect(transport);
// eslint-disable-next-line no-console
console.error(`legitify-mcp ready (stdio). queue=${QUEUE_PATH}`);
