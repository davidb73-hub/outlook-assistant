const fs = require('fs/promises');
const os = require('os');
const path = require('path');
const {
  MAX_LOG_BYTES,
  appendOperationalLog,
  eventExitCode,
  problemFingerprint,
  runDownstreamStage,
  scheduledStatus,
  updateFailureNotification,
} = require('../../archive-worker/scheduled');
const { WorkerLock } = require('../../archive-worker/lock');
const {
  appleScriptString,
  notifyArchiveFailure,
} = require('../../archive-worker/notifier');
const {
  LABEL,
  STABLE_NODE_22,
  escapeXml,
  install,
  plist,
  preferredNodePath,
} = require('../../scripts/install-email-archive-launchd');

describe('unattended archive operations', () => {
  let root;

  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'email-operations-test-'));
  });

  afterEach(async () => {
    await fs.rm(root, { recursive: true, force: true });
  });

  test('prevents overlapping workers and recovers a stale lock', async () => {
    const first = new WorkerLock(root);
    const second = new WorkerLock(root);
    await first.acquire();
    await expect(second.acquire()).rejects.toThrow('already running');
    await first.release();

    await fs.writeFile(
      path.join(root, 'worker.lock'),
      JSON.stringify({ pid: 99999999 })
    );
    await second.acquire();
    await second.release();
  });

  test('writes content-free bounded operational logs', async () => {
    const logsDir = path.join(root, 'logs');
    await fs.mkdir(logsDir, { recursive: true });
    await fs.writeFile(
      path.join(logsDir, 'scheduled.jsonl'),
      Buffer.alloc(MAX_LOG_BYTES, 0x20)
    );
    await appendOperationalLog(
      { logsDir },
      {
        timestamp: '2026-07-18T00:00:00.000Z',
        status: 'completed',
        accounts: [{ accountId: 'gmail-personal', archived: 1, errors: 0 }],
      }
    );

    expect(
      await fs.readFile(path.join(logsDir, 'scheduled.jsonl'), 'utf8')
    ).toContain('gmail-personal');
    expect((await fs.stat(path.join(logsDir, 'scheduled.jsonl.1'))).size).toBe(
      MAX_LOG_BYTES
    );
  });

  test('returns a failing service exit code for visible account or backup failure', () => {
    expect(eventExitCode({ status: 'completed' })).toBe(0);
    expect(eventExitCode({ status: 'degraded' })).toBe(0);
    expect(eventExitCode({ status: 'failed' })).toBe(1);
  });

  test('does not execute deferred routing or delivery unless explicitly enabled', async () => {
    const stage = jest.fn().mockResolvedValue(['executed']);

    await expect(
      runDownstreamStage({ downstreamDeliveryEnabled: false }, stage)
    ).resolves.toEqual([]);
    expect(stage).not.toHaveBeenCalled();

    await expect(
      runDownstreamStage({ downstreamDeliveryEnabled: true }, stage)
    ).resolves.toEqual(['executed']);
    expect(stage).toHaveBeenCalledTimes(1);
  });

  test('keeps one rate-limited account visible without reporting a whole-job crash', () => {
    const accounts = [
      { accountId: 'vitasci-outlook', status: 'completed' },
      {
        accountId: 'gmail-ablative',
        status: 'rate_limited',
        error: { code: 429, retryable: true },
      },
      { accountId: 'gmail-personal', status: 'completed' },
    ];

    expect(scheduledStatus(accounts, [], { status: 'not_due' })).toBe(
      'degraded'
    );
    expect(
      scheduledStatus(
        accounts.map((result) => ({ ...result, status: 'completed' })),
        [{ accountId: 'gmail-ablative', status: 'rate_limited' }],
        { status: 'not_due' }
      )
    ).toBe('degraded');
    expect(
      scheduledStatus(
        accounts.map((result) => ({ ...result, status: 'completed' })),
        [{ accountId: 'gmail-ablative', status: 'deferred' }],
        { status: 'not_due' }
      )
    ).toBe('degraded');
    expect(
      scheduledStatus(
        accounts.map((result) =>
          result.accountId === 'gmail-ablative'
            ? { ...result, status: 'failed', error: { code: 'GMAIL_AUTH' } }
            : result
        ),
        [],
        { status: 'not_due' }
      )
    ).toBe('failed');
  });

  test('generates a 15-minute user LaunchAgent without a shell', () => {
    const output = plist({
      nodePath: '/opt/homebrew/bin/node',
      workerPath: '/safe/archive-worker/scheduled.js',
      workingDirectory: '/safe/repository',
      standardOutPath: '/safe/logs/archive-worker.out.log',
      standardErrorPath: '/safe/logs/archive-worker.err.log',
    });
    expect(output).toContain(`<string>${LABEL}</string>`);
    expect(output).toContain('<integer>900</integer>');
    expect(output).toContain('/safe/archive-worker/scheduled.js');
    expect(output).toContain('/safe/logs/archive-worker.out.log');
    expect(output).toContain('/safe/logs/archive-worker.err.log');
    expect(output).not.toContain('/dev/null');
    expect(output).not.toContain('/bin/sh');
    expect(escapeXml('one&two<three')).toBe('one&amp;two&lt;three');
  });

  test('prefers the stable Homebrew Node 22 runtime', async () => {
    await expect(
      preferredNodePath('/fallback/node', jest.fn().mockResolvedValue())
    ).resolves.toBe(STABLE_NODE_22);
    await expect(
      preferredNodePath(
        '/fallback/node',
        jest.fn().mockRejectedValue(new Error('missing'))
      )
    ).resolves.toBe('/fallback/node');
  });

  test('enables a persistently disabled scheduler before bootstrap', async () => {
    const repoRoot = path.join(root, 'repository');
    await fs.mkdir(path.join(repoRoot, 'archive-worker'), { recursive: true });
    await fs.writeFile(
      path.join(repoRoot, 'archive-worker', 'scheduled.js'),
      '#!/usr/bin/env node\n'
    );
    const launchctlRunner = jest.fn().mockResolvedValue({ code: 0 });

    await expect(
      install({
        home: root,
        nodePath: '/safe/node',
        repoRoot,
        launchctlRunner,
      })
    ).resolves.toEqual(
      expect.objectContaining({ label: LABEL, intervalMinutes: 15 })
    );
    const domain = `gui/${process.getuid()}`;
    const plistPath = path.join(
      root,
      'Library',
      'LaunchAgents',
      `${LABEL}.plist`
    );
    expect(launchctlRunner.mock.calls).toEqual([
      [['bootout', domain, plistPath], { allowFailure: true }],
      [['enable', `${domain}/${LABEL}`]],
      [['bootstrap', domain, plistPath]],
    ]);
  });

  test('builds an actionable content-free macOS failure notification without a shell', async () => {
    const execFileImpl = jest.fn((_file, _args, _options, callback) =>
      callback(null)
    );
    await expect(
      notifyArchiveFailure({
        execFileImpl,
        existsSyncImpl: () => true,
        notifierPath: '/safe/terminal-notifier',
        openCommand: '/safe/open-command-centre',
      })
    ).resolves.toEqual({ status: 'sent' });
    expect(execFileImpl).toHaveBeenCalledWith(
      '/safe/terminal-notifier',
      expect.arrayContaining([
        '-message',
        expect.stringContaining('Command Centre'),
        '-execute',
        '/safe/open-command-centre',
      ]),
      { timeout: 10_000 },
      expect.any(Function)
    );
    expect(execFileImpl.mock.calls[0][1].join(' ')).not.toContain('@');
    expect(appleScriptString('one "two"\nthree')).toBe('"one \\"two\\" three"');
  });

  test('notifies once per distinct failure and once on recovery', async () => {
    const config = { logsDir: path.join(root, 'logs') };
    const failureNotifier = jest.fn().mockResolvedValue({ status: 'sent' });
    const recoveryNotifier = jest.fn().mockResolvedValue({ status: 'sent' });
    const failed = {
      timestamp: '2026-08-01T00:00:00.000Z',
      status: 'failed',
      accounts: [
        {
          accountId: 'gmail-personal',
          status: 'failed',
          errorCode: 'GMAIL_AUTH',
        },
      ],
    };

    expect(problemFingerprint(failed)).toHaveLength(64);
    await expect(
      updateFailureNotification(config, failed, {
        failureNotifier,
        recoveryNotifier,
      })
    ).resolves.toEqual({ status: 'sent' });
    await expect(
      updateFailureNotification(config, failed, {
        failureNotifier,
        recoveryNotifier,
      })
    ).resolves.toEqual({
      status: 'suppressed',
      reason: 'unchanged_failure',
    });
    expect(failureNotifier).toHaveBeenCalledTimes(1);

    await expect(
      updateFailureNotification(
        config,
        { timestamp: '2026-08-01T00:15:00.000Z', status: 'completed' },
        { failureNotifier, recoveryNotifier }
      )
    ).resolves.toEqual({ status: 'sent' });
    expect(recoveryNotifier).toHaveBeenCalledTimes(1);
  });
});
