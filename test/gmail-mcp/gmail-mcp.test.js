const crypto = require('crypto');
const {
  buildMime,
  verifyAttachments,
  attachmentParts,
} = require('../../gmail-mcp');

const sha = (b) => crypto.createHash('sha256').update(b).digest('hex');

describe('buildMime', () => {
  it('builds a plain message without multipart when no attachments', () => {
    const m = buildMime({ to: 'a@x.com', subject: 'Hi', body: 'hello' });
    expect(m).toContain('To: a@x.com');
    expect(m).toContain('Subject: Hi');
    expect(m).not.toContain('multipart');
    expect(m).toContain(Buffer.from('hello').toString('base64'));
  });

  it('encodes non-ASCII subjects and attachment names', () => {
    const m = buildMime({
      subject: 'Café',
      body: 'x',
      attachments: [{ name: 'résumé.pdf', buffer: Buffer.from('pdf') }],
    });
    expect(m).toContain(
      `Subject: =?UTF-8?B?${Buffer.from('Café').toString('base64')}?=`
    );
    expect(m).toContain("filename*=UTF-8''r%C3%A9sum%C3%A9.pdf");
  });

  it('round-trips attachment bytes exactly', () => {
    const bytes = crypto.randomBytes(5000);
    const m = buildMime({
      body: 'x',
      attachments: [{ name: 'a.bin', buffer: bytes }],
    });
    const boundary = m.match(/boundary="([^"]+)"/)[1];
    const part = m.split(`--${boundary}`)[2];
    const b64 = part.split('\r\n\r\n')[1].replace(/\s/g, '');
    expect(sha(Buffer.from(b64, 'base64'))).toBe(sha(bytes));
  });

  it('sets reply headers', () => {
    const m = buildMime({
      body: 'x',
      inReplyTo: '<id@x>',
      references: '<r@x> <id@x>',
    });
    expect(m).toContain('In-Reply-To: <id@x>');
    expect(m).toContain('References: <r@x> <id@x>');
  });
});

describe('verifyAttachments', () => {
  const local = [
    {
      name: 'a.pdf',
      buffer: Buffer.from('aaa'),
      sha256: sha(Buffer.from('aaa')),
    },
  ];
  it('verifies on hash match', () => {
    expect(
      verifyAttachments(local, [
        { name: 'a.pdf', sha256: sha(Buffer.from('aaa')) },
      ])[0].verified
    ).toBe(true);
  });
  it('does not verify on same name, different bytes', () => {
    expect(
      verifyAttachments(local, [
        { name: 'a.pdf', sha256: sha(Buffer.from('bbb')) },
      ])[0].verified
    ).toBe(false);
  });
});

it('attachmentParts finds nested parts with filenames', () => {
  const payload = {
    parts: [
      { mimeType: 'text/plain' },
      { parts: [{ filename: 'x.pdf', body: {} }] },
    ],
  };
  expect(attachmentParts(payload).map((p) => p.filename)).toEqual(['x.pdf']);
});
