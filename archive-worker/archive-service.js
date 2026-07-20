const { scanAttachment } = require('./security-gate');

class ArchiveService {
  constructor({ database, contentStore, security = {} }) {
    this.database = database;
    this.contentStore = contentStore;
    this.security = security;
  }

  async initialise(accounts) {
    await this.contentStore.initialise();
    for (const account of accounts) this.database.upsertAccount(account);
  }

  async stageMessage(accountId, message, rawContent) {
    const rawBlob = rawContent
      ? await this.contentStore.write(
          'raw-message',
          rawContent,
          message.rawMediaType || 'message/rfc822'
        )
      : null;
    return this.database.stageMessage(accountId, message, rawBlob);
  }

  async completeAttachment(
    messageId,
    providerAttachmentId,
    content,
    mediaType = null
  ) {
    const blob = await this.contentStore.write(
      'attachment',
      content,
      mediaType
    );
    const scan = await scanAttachment({
      filePath: this.contentStore.blobPath('attachment', blob.hash),
      fileName: this.database.db
        .prepare(
          'SELECT file_name FROM attachments WHERE message_id = ? AND provider_attachment_id = ?'
        )
        .get(messageId, providerAttachmentId)?.file_name,
      clamscanPath: this.security.clamScanPath,
    });
    this.database.recordAttachmentSecurity(
      messageId,
      providerAttachmentId,
      scan
    );
    return this.database.completeAttachment(
      messageId,
      providerAttachmentId,
      blob
    );
  }

  async stageBundles(accountId, bundles, onError = null) {
    const staged = [];
    for (const bundle of bundles) {
      try {
        const archived = await this.stageMessage(
          accountId,
          bundle.message,
          bundle.rawContent
        );
        staged.push({
          archived,
          providerMessageId: bundle.message.providerMessageId,
          attachments: bundle.message.attachments || [],
        });
      } catch (error) {
        if (onError) await onError(error, bundle.message, 'message');
      }
    }
    return staged;
  }

  async completeStagedAttachments(staged, fetchAttachment, onError = null) {
    for (const { archived, providerMessageId, attachments } of staged) {
      for (const attachment of attachments) {
        const current = archived.attachments.find(
          (item) =>
            item.provider_attachment_id === attachment.providerAttachmentId
        );
        if (current?.archive_state === 'complete') continue;
        try {
          const content = await fetchAttachment(providerMessageId, attachment);
          await this.completeAttachment(
            archived.id,
            attachment.providerAttachmentId,
            content,
            attachment.mediaType || null
          );
        } catch (error) {
          this.database.markAttachmentFailure(
            archived.id,
            attachment.providerAttachmentId,
            error.message
          );
          if (onError) {
            await onError(error, { providerMessageId }, 'attachment');
          }
        }
      }
    }

    return staged.map(({ archived }) =>
      this.database.getMessageById(archived.id)
    );
  }

  async archiveBatch(accountId, bundles, fetchAttachment, onError = null) {
    const staged = await this.stageBundles(accountId, bundles, onError);
    return this.completeStagedAttachments(staged, fetchAttachment, onError);
  }
}

module.exports = {
  ArchiveService,
};
