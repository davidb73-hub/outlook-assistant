#!/usr/bin/env node
/**
 * Gmail MCP server: search, read, and draft (with verified attachments).
 * One process per mailbox, selected by GMAIL_ACCOUNT (a credential slot in
 * local-worker/config.js). There is deliberately no send tool.
 */
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
require('dotenv').config({
  path: path.join(__dirname, '..', '.env'),
  quiet: true,
});
const { Server } = require('@modelcontextprotocol/sdk/server/index.js');
const {
  StdioServerTransport,
} = require('@modelcontextprotocol/sdk/server/stdio.js');
const {
  ListToolsRequestSchema,
  CallToolRequestSchema,
} = require('@modelcontextprotocol/sdk/types.js');
const { buildConfig } = require('../local-worker/config');
const {
  GmailProvider,
  extractPlainText,
} = require('../local-worker/providers/gmail');

const API = 'https://gmail.googleapis.com/gmail/v1/users/me';
const UPLOAD = 'https://gmail.googleapis.com/upload/gmail/v1/users/me';
const MAX_TOTAL = 25 * 1024 * 1024; // Gmail rejects messages over 25 MB of attachments

const sha256 = (buf) => crypto.createHash('sha256').update(buf).digest('hex');
const b64url = (s) => s.replace(/-/g, '+').replace(/_/g, '/');

// RFC 2047 for non-ASCII header text such as subjects.
function encodeHeader(value) {
  return /^[\x20-\x7e]*$/.test(value)
    ? value
    : `=?UTF-8?B?${Buffer.from(value, 'utf8').toString('base64')}?=`;
}

function wrap76(b64) {
  return b64.replace(/.{1,76}/g, '$&\r\n');
}

/**
 * Build an RFC 822 message. attachments: [{ name, buffer }].
 */
function buildMime({
  to,
  cc,
  bcc,
  subject,
  body,
  html,
  inReplyTo,
  references,
  attachments = [],
}) {
  const boundary = `b_${crypto.randomBytes(12).toString('hex')}`;
  const headers = ['MIME-Version: 1.0'];
  if (to) headers.push(`To: ${to}`);
  if (cc) headers.push(`Cc: ${cc}`);
  if (bcc) headers.push(`Bcc: ${bcc}`);
  headers.push(`Subject: ${encodeHeader(subject || '')}`);
  if (inReplyTo) headers.push(`In-Reply-To: ${inReplyTo}`);
  if (references) headers.push(`References: ${references}`);

  const bodyPart = [
    `Content-Type: text/${html ? 'html' : 'plain'}; charset="UTF-8"`,
    'Content-Transfer-Encoding: base64',
    '',
    wrap76(Buffer.from(body || '', 'utf8').toString('base64')),
  ].join('\r\n');

  if (attachments.length === 0) {
    return `${headers.join('\r\n')}\r\n${bodyPart}`;
  }

  headers.push(`Content-Type: multipart/mixed; boundary="${boundary}"`);
  const parts = [bodyPart];
  for (const { name, buffer } of attachments) {
    const encoded = `UTF-8''${encodeURIComponent(name)}`;
    parts.push(
      [
        `Content-Type: application/octet-stream; name="${name.replace(/"/g, '')}"`,
        'Content-Transfer-Encoding: base64',
        `Content-Disposition: attachment; filename*=${encoded}`,
        '',
        wrap76(buffer.toString('base64')),
      ].join('\r\n')
    );
  }
  return `${headers.join('\r\n')}\r\n\r\n${parts
    .map((p) => `--${boundary}\r\n${p}`)
    .join('\r\n')}\r\n--${boundary}--\r\n`;
}

function attachmentParts(part, out = []) {
  if (!part) return out;
  if (part.filename) out.push(part);
  for (const child of part.parts || []) attachmentParts(child, out);
  return out;
}

function headerMap(message) {
  return Object.fromEntries(
    (message.payload?.headers || []).map((h) => [h.name.toLowerCase(), h.value])
  );
}

function readLocalAttachments(paths = []) {
  const files = [];
  let total = 0;
  for (const p of paths) {
    if (!path.isAbsolute(p)) {
      throw new Error(`Attachment path must be absolute: ${p}`);
    }
    if (!fs.statSync(p).isFile()) throw new Error(`Not a file: ${p}`);
    const buffer = fs.readFileSync(p);
    total += buffer.length;
    files.push({
      path: p,
      name: path.basename(p),
      buffer,
      sha256: sha256(buffer),
    });
  }
  if (total > MAX_TOTAL) {
    throw new Error('Attachments total more than the 25 MB Gmail limit.');
  }
  return files;
}

/**
 * Compare stored attachments against local files by SHA-256.
 * stored: [{ name, sha256 }]. Returns one row per local file.
 */
function verifyAttachments(local, stored) {
  return local.map((f) => ({
    name: f.name,
    size: f.buffer.length,
    sha256: f.sha256,
    verified: stored.some((s) => s.sha256 === f.sha256),
  }));
}

class GmailClient {
  constructor(provider) {
    this.provider = provider;
  }

  async call(method, url, { body, contentType, query } = {}) {
    const token = await this.provider.getAccessToken();
    const full = query ? `${url}?${new URLSearchParams(query)}` : url;
    const res = await fetch(full, {
      method,
      headers: {
        authorization: `Bearer ${token}`,
        ...(contentType && { 'content-type': contentType }),
      },
      body,
    });
    if (!res.ok) {
      const detail = await res.text().catch(() => '');
      throw new Error(
        `Gmail ${method} ${url.replace(API, '')} failed: HTTP ${res.status} ${detail.slice(0, 300)}`
      );
    }
    return res.status === 204 ? {} : res.json();
  }

  async storedAttachments(message) {
    const out = [];
    for (const part of attachmentParts(message.payload)) {
      let data = part.body?.data;
      if (!data && part.body?.attachmentId) {
        const att = await this.call(
          'GET',
          `${API}/messages/${message.id}/attachments/${part.body.attachmentId}`
        );
        data = att.data;
      }
      out.push({
        name: part.filename,
        sha256: data ? sha256(Buffer.from(b64url(data), 'base64')) : null,
      });
    }
    return out;
  }
}

const TOOLS = [
  {
    name: 'gmail-search',
    description:
      'Search this Gmail mailbox (read-only). `query` uses Gmail search syntax (from:, subject:, newer_than:7d, has:attachment, in:sent ...). Returns id, threadId, from, to, subject, date, snippet.',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string' },
        maxResults: { type: 'number', description: 'default 10, max 50' },
      },
      additionalProperties: false,
    },
    annotations: { readOnlyHint: true },
  },
  {
    name: 'gmail-read',
    description:
      'Read one message by id (read-only): headers, plain-text body, attachment names and sizes.',
    inputSchema: {
      type: 'object',
      properties: { id: { type: 'string' } },
      required: ['id'],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: true },
  },
  {
    name: 'gmail-draft',
    description:
      'Save a draft in Gmail Drafts (never sends). Optional `attachments`: absolute file paths (25 MB total). Optional `replyToMessageId` threads it as a reply and defaults the subject to "Re: ...". After saving, the draft is read back and each attachment is SHA-256 compared with the local file; the result says VERIFIED or NOT VERIFIED per file.',
    inputSchema: {
      type: 'object',
      properties: {
        to: { type: 'string', description: 'Comma-separated addresses' },
        cc: { type: 'string' },
        bcc: { type: 'string' },
        subject: { type: 'string' },
        body: {
          type: 'string',
          description: 'Plain text, or HTML when html=true',
        },
        html: { type: 'boolean' },
        attachments: { type: 'array', items: { type: 'string' } },
        replyToMessageId: { type: 'string' },
      },
      additionalProperties: false,
    },
    annotations: { readOnlyHint: false, destructiveHint: false },
  },
  {
    name: 'gmail-delete-draft',
    description: 'Permanently delete a Gmail draft by draft id.',
    inputSchema: {
      type: 'object',
      properties: { draftId: { type: 'string' } },
      required: ['draftId'],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: false, destructiveHint: true },
  },
];

async function handle(client, name, args) {
  if (name === 'gmail-search') {
    const listed = await client.call('GET', `${API}/messages`, {
      query: {
        q: args.query || '',
        maxResults: String(Math.min(args.maxResults || 10, 50)),
      },
    });
    const rows = [];
    for (const m of listed.messages || []) {
      const msg = await client.call('GET', `${API}/messages/${m.id}`, {
        query: { format: 'metadata' },
      });
      const h = headerMap(msg);
      rows.push({
        id: msg.id,
        threadId: msg.threadId,
        from: h.from,
        to: h.to,
        subject: h.subject,
        date: h.date,
        snippet: msg.snippet,
      });
    }
    return rows.length ? JSON.stringify(rows, null, 2) : 'No messages found.';
  }

  if (name === 'gmail-read') {
    const msg = await client.call('GET', `${API}/messages/${args.id}`, {
      query: { format: 'full' },
    });
    const h = headerMap(msg);
    const atts = attachmentParts(msg.payload).map(
      (p) => `${p.filename} (${p.body?.size || 0} bytes)`
    );
    return [
      `From: ${h.from || ''}`,
      `To: ${h.to || ''}`,
      h.cc ? `Cc: ${h.cc}` : null,
      `Date: ${h.date || ''}`,
      `Subject: ${h.subject || ''}`,
      `Message-ID: ${h['message-id'] || ''}`,
      `Thread: ${msg.threadId}`,
      atts.length ? `Attachments: ${atts.join(', ')}` : 'Attachments: none',
      '',
      extractPlainText(msg.payload) || msg.snippet || '',
    ]
      .filter((l) => l !== null)
      .join('\n');
  }

  if (name === 'gmail-draft') {
    const local = readLocalAttachments(args.attachments);
    let threadId;
    let inReplyTo;
    let references;
    let subject = args.subject;
    if (args.replyToMessageId) {
      const orig = await client.call(
        'GET',
        `${API}/messages/${args.replyToMessageId}`,
        {
          query: { format: 'metadata' },
        }
      );
      const h = headerMap(orig);
      threadId = orig.threadId;
      inReplyTo = h['message-id'];
      references = [h.references, h['message-id']].filter(Boolean).join(' ');
      if (!subject) {
        subject = /^re:/i.test(h.subject || '')
          ? h.subject
          : `Re: ${h.subject || ''}`;
      }
    }
    const mime = buildMime({
      ...args,
      subject,
      inReplyTo,
      references,
      attachments: local,
    });

    const boundary = `u_${crypto.randomBytes(12).toString('hex')}`;
    const meta = JSON.stringify({ message: threadId ? { threadId } : {} });
    const payload = Buffer.concat([
      Buffer.from(
        `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${meta}\r\n--${boundary}\r\nContent-Type: message/rfc822\r\n\r\n`
      ),
      Buffer.from(mime, 'utf8'),
      Buffer.from(`\r\n--${boundary}--`),
    ]);
    const draft = await client.call('POST', `${UPLOAD}/drafts`, {
      query: { uploadType: 'multipart' },
      body: payload,
      contentType: `multipart/related; boundary=${boundary}`,
    });

    // Read back what Gmail stored.
    const saved = await client.call('GET', `${API}/drafts/${draft.id}`, {
      query: { format: 'full' },
    });
    const h = headerMap(saved.message);
    const rows = verifyAttachments(
      local,
      await client.storedAttachments(saved.message)
    );
    const allOk = rows.every((r) => r.verified);
    const lines = [
      `Draft saved in Gmail Drafts${threadId ? ' (as a reply in the thread)' : ''}.`,
      `Draft ID: ${draft.id}`,
      `Message ID: ${saved.message.id}`,
      `To: ${h.to || ''}`,
      `Subject: ${h.subject || ''}`,
    ];
    for (const r of rows) {
      lines.push(
        `${r.verified ? 'VERIFIED' : 'NOT VERIFIED'}: ${r.name} (${r.size} bytes, sha256 ${r.sha256})`
      );
    }
    if (!allOk) {
      lines.push('Do not rely on the mailbox copy of any NOT VERIFIED file.');
    }
    return lines.join('\n');
  }

  if (name === 'gmail-delete-draft') {
    await client.call('DELETE', `${API}/drafts/${args.draftId}`);
    return `Draft ${args.draftId} deleted.`;
  }

  throw new Error(`Unknown tool ${name}`);
}

function createClient(accountKey = process.env.GMAIL_ACCOUNT) {
  const accountConfig = buildConfig().gmail[accountKey];
  if (!accountConfig) {
    throw new Error(
      `GMAIL_ACCOUNT '${accountKey}' is not in LOCAL_TRIAGE_GMAIL_ACCOUNTS.`
    );
  }
  return new GmailClient(new GmailProvider({ accountConfig, maxEmails: 50 }));
}

async function main() {
  const client = createClient();
  const server = new Server(
    { name: 'gmail-local', version: '1.0.0' },
    { capabilities: { tools: {} } }
  );
  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: TOOLS,
  }));
  server.setRequestHandler(CallToolRequestSchema, async (req) => {
    try {
      const text = await handle(
        client,
        req.params.name,
        req.params.arguments || {}
      );
      return { content: [{ type: 'text', text }] };
    } catch (error) {
      return {
        content: [{ type: 'text', text: `Error: ${error.message}` }],
        isError: true,
      };
    }
  });
  await server.connect(new StdioServerTransport());
}

if (require.main === module) {
  main().catch((error) => {
    console.error(`gmail-mcp failed: ${error.message}`);
    process.exit(1);
  });
}

module.exports = {
  buildMime,
  verifyAttachments,
  attachmentParts,
  handle,
  createClient,
  TOOLS,
};
