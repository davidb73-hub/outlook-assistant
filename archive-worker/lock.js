const fs = require('fs/promises');
const path = require('path');

function processExists(pid) {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code === 'EPERM';
  }
}

class WorkerLock {
  constructor(root) {
    this.path = path.join(root, 'worker.lock');
    this.held = false;
  }

  async acquire() {
    await fs.mkdir(path.dirname(this.path), { recursive: true, mode: 0o700 });
    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        const handle = await fs.open(this.path, 'wx', 0o600);
        await handle.writeFile(
          `${JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() })}\n`
        );
        await handle.close();
        this.held = true;
        return;
      } catch (error) {
        if (error.code !== 'EEXIST') throw error;
        let owner = null;
        try {
          owner = JSON.parse(await fs.readFile(this.path, 'utf8'));
        } catch {
          // A malformed lock cannot identify a live owner and is treated as stale.
        }
        if (owner && processExists(Number(owner.pid))) {
          throw new Error(
            `Archive worker is already running as process ${owner.pid}`,
            { cause: error }
          );
        }
        await fs.unlink(this.path).catch((unlinkError) => {
          if (unlinkError.code !== 'ENOENT') throw unlinkError;
        });
      }
    }
    throw new Error('Could not acquire the archive worker lock');
  }

  async release() {
    if (!this.held) return;
    this.held = false;
    await fs.unlink(this.path).catch((error) => {
      if (error.code !== 'ENOENT') throw error;
    });
  }
}

module.exports = {
  WorkerLock,
  processExists,
};
