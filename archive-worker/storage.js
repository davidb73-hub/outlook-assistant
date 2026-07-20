const crypto = require('crypto');
const fs = require('fs/promises');
const path = require('path');

const KIND_DIRECTORIES = Object.freeze({
  'raw-message': 'raw-messages',
  attachment: 'attachments',
});

function sha256(buffer) {
  return crypto.createHash('sha256').update(buffer).digest('hex');
}

function assertBuffer(value) {
  if (!Buffer.isBuffer(value)) {
    throw new TypeError('Archive blob content must be a Buffer');
  }
}

class ContentStore {
  constructor(root) {
    this.root = path.resolve(root);
  }

  async initialise() {
    await fs.mkdir(this.root, { recursive: true, mode: 0o700 });
    for (const directory of Object.values(KIND_DIRECTORIES)) {
      await fs.mkdir(path.join(this.root, directory), {
        recursive: true,
        mode: 0o700,
      });
    }
    await fs.chmod(this.root, 0o700);
  }

  blobPath(kind, hash) {
    const directory = KIND_DIRECTORIES[kind];
    if (!directory) throw new Error(`Unsupported archive blob kind: ${kind}`);
    if (!/^[a-f0-9]{64}$/.test(hash)) {
      throw new Error('Archive blob hash must be a lowercase SHA-256 value');
    }
    return path.join(this.root, directory, hash.slice(0, 2), hash);
  }

  async write(kind, content, mediaType = null) {
    assertBuffer(content);
    const hash = sha256(content);
    const absolutePath = this.blobPath(kind, hash);
    const relativePath = path.relative(this.root, absolutePath);

    await fs.mkdir(path.dirname(absolutePath), {
      recursive: true,
      mode: 0o700,
    });

    let created = false;
    try {
      const handle = await fs.open(absolutePath, 'wx', 0o600);
      try {
        await handle.writeFile(content);
        await handle.sync();
        created = true;
      } finally {
        await handle.close();
      }
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
    }

    const verified = await this.verify({
      hash,
      relativePath,
      size: content.length,
    });
    if (!verified) {
      throw new Error(`Archive blob verification failed for ${hash}`);
    }

    return {
      hash,
      kind,
      relativePath,
      size: content.length,
      mediaType,
      created,
    };
  }

  async verify(blob) {
    const absolutePath = path.resolve(this.root, blob.relativePath);
    const relative = path.relative(this.root, absolutePath);
    if (relative.startsWith('..') || path.isAbsolute(relative)) return false;

    try {
      const content = await fs.readFile(absolutePath);
      return content.length === blob.size && sha256(content) === blob.hash;
    } catch (error) {
      if (error.code === 'ENOENT') return false;
      throw error;
    }
  }
}

module.exports = {
  ContentStore,
  KIND_DIRECTORIES,
  sha256,
};
