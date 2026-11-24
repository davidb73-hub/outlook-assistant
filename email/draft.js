/**
 * Draft email functionality
 *
 * Supports creating, updating, sending, and deleting drafts,
 * plus creating reply/reply-all/forward drafts from existing messages.
 */
const { callGraphAPI } = require('../utils/graph-api');
const { ensureAuthenticated } = require('../auth');
const {
  checkRateLimit,
  checkRecipientAllowlist,
  formatDryRunPreview,
} = require('../utils/safety');
const { handleGetMailTips } = require('./mail-tips');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

// Graph: inline POST up to 3 MB; larger needs an upload session (max 150 MB).
const INLINE_LIMIT = 3 * 1024 * 1024;
const MAX_ATTACHMENT = 150 * 1024 * 1024;
const CHUNK = 327680 * 12; // chunks must be multiples of 320 KiB

/**
 * Format comma-separated email string into Graph API recipient objects
 * @param {string} recipientString - Comma-separated email addresses
 * @returns {Array<{emailAddress: {address: string}}>}
 */
function formatRecipients(recipientString) {
  if (!recipientString) return [];
  return recipientString.split(',').map((email) => ({
    emailAddress: { address: email.trim() },
  }));
}

/**
 * Auto-detect HTML vs plain text body
 * @param {string} body - Email body content
 * @returns {'html'|'text'}
 */
function detectContentType(body) {
  if (!body) return 'text';
  return /<(html|div|p|h[1-6]|br|table|ul|ol|li|span|a\s|img|strong|em|b|i)\b/i.test(
    body
  )
    ? 'html'
    : 'text';
}

/**
 * Build a message object from draft parameters
 * @param {object} args - Draft parameters
 * @returns {object} - Graph API message object
 */
function buildMessageObject(args) {
  const { to, cc, bcc, subject, body, importance } = args;
  const message = {};

  if (subject !== undefined) message.subject = subject;
  if (body !== undefined) {
    message.body = {
      contentType: detectContentType(body),
      content: body,
    };
  }
  if (importance) message.importance = importance;

  const toRecipients = formatRecipients(to);
  const ccRecipients = formatRecipients(cc);
  const bccRecipients = formatRecipients(bcc);

  if (toRecipients.length > 0) message.toRecipients = toRecipients;
  if (ccRecipients.length > 0) message.ccRecipients = ccRecipients;
  if (bccRecipients.length > 0) message.bccRecipients = bccRecipients;

  return message;
}

/**
 * Format a draft response with key details
 * @param {object} draft - Graph API message response
 * @param {string} actionLabel - Human-readable action (e.g. "created", "updated")
 * @returns {object} - MCP response
 */
function formatDraftResponse(draft, actionLabel) {
  const to = (draft.toRecipients || [])
    .map((r) => r.emailAddress?.address)
    .join(', ');

  let text = `Draft ${actionLabel}.\n\n`;
  text += `**ID**: \`${draft.id}\`\n`;
  if (draft.subject) text += `**Subject**: ${draft.subject}\n`;
  if (to) text += `**To**: ${to}\n`;
  if (draft.lastModifiedDateTime) {
    text += `**Modified**: ${draft.lastModifiedDateTime}\n`;
  }
  if (draft.hasAttachments) text += `**Attachments**: yes\n`;

  return {
    content: [{ type: 'text', text }],
    _meta: { draftId: draft.id },
  };
}

/**
 * Draft handler — routes to action-specific logic
 * @param {object} args - Tool arguments
 * @returns {object} - MCP response
 */
async function handleDraft(args) {
  const { action } = args;

  if (!action) {
    return {
      content: [
        {
          type: 'text',
          text: "Action is required. Use 'create', 'update', 'send', 'delete', 'reply', 'reply-all', 'forward', or 'attach'.",
        },
      ],
    };
  }

  switch (action) {
    case 'create':
      return handleCreateDraft(args);
    case 'update':
      return handleUpdateDraft(args);
    case 'send':
      return handleSendDraft(args);
    case 'delete':
      return handleDeleteDraft(args);
    case 'reply':
      return handleReplyDraft(args, 'createReply');
    case 'reply-all':
      return handleReplyDraft(args, 'createReplyAll');
    case 'forward':
      return handleForwardDraft(args);
    case 'attach':
      return handleAttachDraft(args);
    default:
      return {
        content: [
          {
            type: 'text',
            text: `Invalid action '${action}'. Use 'create', 'update', 'send', 'delete', 'reply', 'reply-all', 'forward', or 'attach'.`,
          },
        ],
      };
  }
}

/**
 * Create a new draft
 */
async function handleCreateDraft(args) {
  const { dryRun = false, checkRecipients: doCheckRecipients = false } = args;
  const message = buildMessageObject(args);

  // Drafts are private mailbox state, so recipient allowlists are enforced only
  // when the draft is sent. Recipients are still collected here for mail tips.
  const allRecipients = [
    ...(message.toRecipients || []),
    ...(message.ccRecipients || []),
    ...(message.bccRecipients || []),
  ];

  // Pre-save recipient validation via mail-tips
  if (doCheckRecipients && allRecipients.length > 0) {
    const allAddresses = allRecipients.map((r) => r.emailAddress.address);
    const tipsResult = await handleGetMailTips({ recipients: allAddresses });
    const tipsText = tipsResult.content[0]?.text || '';

    if (dryRun) {
      const preview = formatDryRunPreview({ message, saveToSentItems: true });
      return {
        content: [
          {
            type: 'text',
            text: `${tipsText}\n\n---\n\n${preview.content[0].text.replace(
              'Email NOT sent',
              'Draft NOT saved'
            )}`,
          },
        ],
        _meta: { mailTips: tipsResult._meta },
      };
    }
  }

  // Dry-run mode: preview without saving
  if (dryRun) {
    const preview = formatDryRunPreview({ message, saveToSentItems: true });
    return {
      content: [
        {
          type: 'text',
          text: preview.content[0].text.replace(
            'Email NOT sent',
            'Draft NOT saved'
          ),
        },
      ],
    };
  }

  // Rate limit check
  const rateLimitError = checkRateLimit('draft');
  if (rateLimitError) return rateLimitError;

  try {
    const accessToken = await ensureAuthenticated();
    const draft = await callGraphAPI(
      accessToken,
      'POST',
      'me/messages',
      message
    );
    return formatDraftResponse(draft, 'created');
  } catch (error) {
    return handleError('creating draft', error);
  }
}

/**
 * Update an existing draft
 */
async function handleUpdateDraft(args) {
  const { id } = args;

  if (!id) {
    return {
      content: [
        { type: 'text', text: 'Draft ID (id) is required for update.' },
      ],
    };
  }

  const message = buildMessageObject(args);

  // Rate limit check
  const rateLimitError = checkRateLimit('draft');
  if (rateLimitError) return rateLimitError;

  try {
    const accessToken = await ensureAuthenticated();
    const draft = await callGraphAPI(
      accessToken,
      'PATCH',
      `me/messages/${id}`,
      message
    );
    return formatDraftResponse(draft, 'updated');
  } catch (error) {
    return handleError('updating draft', error);
  }
}

/**
 * Send an existing draft
 */
async function handleSendDraft(args) {
  const { id } = args;

  if (!id) {
    return {
      content: [{ type: 'text', text: 'Draft ID (id) is required for send.' }],
    };
  }

  try {
    const accessToken = await ensureAuthenticated();

    // A draft may contain recipients that were not allowlisted when it was
    // created or edited. Read its current recipient set and enforce delivery
    // policy immediately before the irreversible send action.
    const draft = await callGraphAPI(
      accessToken,
      'GET',
      `me/messages/${id}`,
      null,
      {
        $select: 'toRecipients,ccRecipients,bccRecipients',
      }
    );
    const allRecipients = [
      ...(draft.toRecipients || []),
      ...(draft.ccRecipients || []),
      ...(draft.bccRecipients || []),
    ];
    const allowlistError = checkRecipientAllowlist(allRecipients);
    if (allowlistError) return allowlistError;

    // Rate limit via send-email counter (shares limit with direct sends)
    const rateLimitError = checkRateLimit('send-email');
    if (rateLimitError) return rateLimitError;

    await callGraphAPI(accessToken, 'POST', `me/messages/${id}/send`);
    return {
      content: [
        {
          type: 'text',
          text: `Draft sent successfully.\n\n**Note**: The draft ID \`${id}\` is no longer valid — the message has been moved to Sent Items with a new ID.`,
        },
      ],
    };
  } catch (error) {
    return handleError('sending draft', error);
  }
}

/**
 * Delete a draft
 */
async function handleDeleteDraft(args) {
  const { id } = args;

  if (!id) {
    return {
      content: [
        { type: 'text', text: 'Draft ID (id) is required for delete.' },
      ],
    };
  }

  try {
    const accessToken = await ensureAuthenticated();
    await callGraphAPI(accessToken, 'DELETE', `me/messages/${id}`);
    return {
      content: [
        {
          type: 'text',
          text: `Draft \`${id}\` deleted.`,
        },
      ],
    };
  } catch (error) {
    return handleError('deleting draft', error);
  }
}

/**
 * Create a reply or reply-all draft from an existing message
 */
async function handleReplyDraft(args, endpoint) {
  const { id, body, comment } = args;

  if (!id) {
    return {
      content: [
        {
          type: 'text',
          text: `Message ID (id) is required for ${endpoint === 'createReplyAll' ? 'reply-all' : 'reply'}.`,
        },
      ],
    };
  }

  if (comment && body) {
    return {
      content: [
        {
          type: 'text',
          text: 'Cannot use both comment and body. Use comment for a short prepended note, or body for full HTML/text content.',
        },
      ],
    };
  }

  const requestBody = {};
  if (comment) {
    requestBody.comment = comment;
  } else if (body) {
    requestBody.message = {
      body: {
        contentType: detectContentType(body),
        content: body,
      },
    };
  }

  try {
    const accessToken = await ensureAuthenticated();
    const draft = await callGraphAPI(
      accessToken,
      'POST',
      `me/messages/${id}/${endpoint}`,
      Object.keys(requestBody).length > 0 ? requestBody : null
    );
    const label =
      endpoint === 'createReplyAll'
        ? 'reply-all draft created'
        : 'reply draft created';
    return formatDraftResponse(draft, label);
  } catch (error) {
    return handleError(
      `creating ${endpoint === 'createReplyAll' ? 'reply-all' : 'reply'} draft`,
      error
    );
  }
}

/**
 * Create a forward draft from an existing message
 */
async function handleForwardDraft(args) {
  const { id, to, body, comment } = args;

  if (!id) {
    return {
      content: [
        { type: 'text', text: 'Message ID (id) is required for forward.' },
      ],
    };
  }

  if (!to) {
    return {
      content: [
        {
          type: 'text',
          text: 'Forward recipient (to) is required for forward.',
        },
      ],
    };
  }

  if (comment && body) {
    return {
      content: [
        {
          type: 'text',
          text: 'Cannot use both comment and body. Use comment for a short prepended note, or body for full HTML/text content.',
        },
      ],
    };
  }

  const toRecipients = formatRecipients(to);

  const requestBody = {
    toRecipients,
  };

  if (comment) {
    requestBody.comment = comment;
  } else if (body) {
    requestBody.message = {
      body: {
        contentType: detectContentType(body),
        content: body,
      },
    };
  }

  try {
    const accessToken = await ensureAuthenticated();
    const draft = await callGraphAPI(
      accessToken,
      'POST',
      `me/messages/${id}/createForward`,
      requestBody
    );
    return formatDraftResponse(draft, 'forward draft created');
  } catch (error) {
    return handleError('creating forward draft', error);
  }
}

const sha256 = (buf) => crypto.createHash('sha256').update(buf).digest('hex');
const textResult = (text) => ({ content: [{ type: 'text', text }] });

async function uploadLargeAttachment(accessToken, id, name, buffer) {
  const session = await callGraphAPI(
    accessToken,
    'POST',
    `me/messages/${id}/attachments/createUploadSession`,
    { AttachmentItem: { attachmentType: 'file', name, size: buffer.length } }
  );
  // The upload URL is pre-authorised; Graph rejects an Authorization header on it.
  for (let start = 0; start < buffer.length; start += CHUNK) {
    const end = Math.min(start + CHUNK, buffer.length);
    const res = await fetch(session.uploadUrl, {
      method: 'PUT',
      headers: {
        'Content-Length': String(end - start),
        'Content-Range': `bytes ${start}-${end - 1}/${buffer.length}`,
      },
      body: buffer.subarray(start, end),
    });
    if (!res.ok) {
      throw new Error(
        `upload chunk ${start}-${end - 1} failed: HTTP ${res.status}`
      );
    }
  }
}

/**
 * Attach a local file to an existing draft, then read it back from the
 * mailbox and compare SHA-256 so the caller knows the stored bytes match.
 */
async function handleAttachDraft(args) {
  const { id, filePath } = args;
  if (!id) return textResult('Draft ID (id) is required for attach.');
  if (!filePath) return textResult('filePath is required for attach.');
  if (!path.isAbsolute(filePath)) {
    return textResult('filePath must be an absolute path.');
  }

  let buffer;
  try {
    if (!fs.statSync(filePath).isFile()) {
      return textResult(`Not a file: ${filePath}`);
    }
    buffer = fs.readFileSync(filePath);
  } catch (error) {
    return textResult(`Cannot read ${filePath}: ${error.message}`);
  }
  if (buffer.length === 0) return textResult(`File is empty: ${filePath}`);
  if (buffer.length > MAX_ATTACHMENT) {
    return textResult(`File is over the 150 MB Outlook limit: ${filePath}`);
  }

  const rateLimitError = checkRateLimit('draft');
  if (rateLimitError) return rateLimitError;

  const name = path.basename(filePath);
  const localHash = sha256(buffer);

  try {
    const accessToken = await ensureAuthenticated();
    if (buffer.length < INLINE_LIMIT) {
      await callGraphAPI(accessToken, 'POST', `me/messages/${id}/attachments`, {
        '@odata.type': '#microsoft.graph.fileAttachment',
        name,
        contentBytes: buffer.toString('base64'),
      });
    } else {
      await uploadLargeAttachment(accessToken, id, name, buffer);
    }

    // Read back every attachment with this name and hash its stored bytes.
    const list = await callGraphAPI(
      accessToken,
      'GET',
      `me/messages/${id}/attachments`,
      null,
      { $select: 'id,name,size' }
    );
    const sameName = (list.value || []).filter((a) => a.name === name);
    let match = null;
    for (const att of sameName) {
      const full = await callGraphAPI(
        accessToken,
        'GET',
        `me/messages/${id}/attachments/${att.id}`
      );
      if (
        full.contentBytes &&
        sha256(Buffer.from(full.contentBytes, 'base64')) === localHash
      ) {
        match = att;
        break;
      }
    }

    let text = `**File**: ${name}\n**Size**: ${buffer.length} bytes\n**Local SHA-256**: ${localHash}\n`;
    if (match) {
      text = `Attachment added and VERIFIED in mailbox.\n\n${text}**Mailbox SHA-256**: ${localHash} (match)\n**Attachment ID**: \`${match.id}\`\n`;
    } else {
      text = `Attachment upload finished but NOT VERIFIED: no stored copy of ${name} on draft \`${id}\` matches the local SHA-256. Do not rely on the mailbox copy.\n\n${text}`;
    }
    return {
      content: [{ type: 'text', text }],
      _meta: {
        verified: Boolean(match),
        sha256: localHash,
        attachmentId: match?.id,
      },
    };
  } catch (error) {
    return handleError('attaching file to draft', error);
  }
}

/**
 * Standard error handler
 */
function handleError(actionLabel, error) {
  if (error.message === 'Authentication required') {
    return {
      content: [
        {
          type: 'text',
          text: "Authentication required. Please use the 'auth' tool with action=authenticate first.",
        },
      ],
    };
  }

  return {
    content: [
      {
        type: 'text',
        text: `Error ${actionLabel}: ${error.message}`,
      },
    ],
  };
}

module.exports = handleDraft;
