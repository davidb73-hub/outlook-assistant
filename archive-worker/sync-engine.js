const INGESTION_ERROR_RECORDED = Symbol('ingestionErrorRecorded');
const UNAGGREGATED_ERROR_COUNT = Symbol('unaggregatedErrorCount');

function metadata(cursorRow) {
  if (!cursorRow?.metadata_json) return {};
  try {
    return JSON.parse(cursorRow.metadata_json);
  } catch {
    return {};
  }
}

function safeError(error) {
  return {
    code: error.code || null,
    message: error.message,
    retryable: error.retryable !== false,
  };
}

function isGmailRateLimit(account, error) {
  return (
    account.provider === 'gmail' &&
    (Number(error?.status) === 429 || Number(error?.code) === 429)
  );
}

function markIngestionErrorRecorded(error, unaggregatedErrors = 0) {
  if (error && (typeof error === 'object' || typeof error === 'function')) {
    error[INGESTION_ERROR_RECORDED] = true;
    error[UNAGGREGATED_ERROR_COUNT] =
      Number(error[UNAGGREGATED_ERROR_COUNT] || 0) + unaggregatedErrors;
  }
  return error;
}

class ArchiveSyncEngine {
  constructor({ database, service, config, providerFactory }) {
    this.database = database;
    this.service = service;
    this.config = config;
    this.providerFactory = providerFactory;
  }

  async recordLocations(account, provider) {
    const locations = await provider.refreshLocations();
    for (const location of locations) {
      this.database.upsertFolder(account.id, location);
    }
    return locations;
  }

  recordError(runId, accountId, providerMessageId, stage, error) {
    const normalized = safeError(error);
    this.database.recordIngestionError({
      runId,
      accountId,
      providerMessageId,
      stage,
      code: normalized.code,
      message: normalized.message,
      retryable: normalized.retryable,
    });
  }

  async archiveRefs(
    account,
    provider,
    refs,
    runId,
    { shouldContinue = () => true } = {}
  ) {
    const counts = { discovered: refs.length, archived: 0, errors: 0 };
    const unique = new Map(refs.map((ref) => [ref.id, ref]));
    const staged = [];
    const recordArchiveError = (error, message, stage) => {
      this.recordError(
        runId,
        account.id,
        message.providerMessageId,
        stage,
        error
      );
      if (isGmailRateLimit(account, error)) {
        throw markIngestionErrorRecorded(error, counts.errors);
      }
      counts.errors += 1;
    };

    for (const ref of unique.values()) {
      try {
        const bundle = await provider.fetchBundle(ref);
        if (bundle.ineligible) {
          this.database.recordTombstone(account.id, bundle.providerMessageId, {
            reason: 'moved_to_excluded_location',
          });
          continue;
        }

        // Persist each fetched message before requesting the next one. A full
        // reconciliation page can contain 500 large messages; retaining every
        // raw message in memory until the page finishes makes interruption lose
        // all progress and creates an unnecessary memory spike.
        staged.push(
          ...(await this.service.stageBundles(
            account.id,
            [bundle],
            recordArchiveError
          ))
        );
      } catch (error) {
        if (error.status === 404) {
          this.database.recordTombstone(account.id, ref.id, {
            reason: 'not_found_during_fetch',
          });
          continue;
        }
        this.recordError(runId, account.id, ref.id, 'message_fetch', error);
        if (isGmailRateLimit(account, error)) {
          throw markIngestionErrorRecorded(error, counts.errors);
        }
        counts.errors += 1;
      }
    }

    // All message records are durable before any potentially slow attachment
    // download starts, so one large attachment cannot hide unrelated messages.
    const completed = await this.service.completeStagedAttachments(
      staged,
      (messageId, attachment) =>
        provider.fetchAttachment(messageId, attachment),
      recordArchiveError,
      { shouldContinue }
    );
    counts.archived += completed.length;
    for (const archived of completed) {
      if (archived.archive_state === 'archived_complete') {
        this.database.resolveIngestionErrors(
          account.id,
          archived.provider_message_id
        );
      }
    }
    return counts;
  }

  async processTombstones(account, provider, removals, runId) {
    const bundles = [];
    let errors = 0;
    for (const removal of removals || []) {
      try {
        if (provider.resolveRemoval) {
          const resolution = await provider.resolveRemoval(removal);
          if (resolution.bundle) bundles.push(resolution.bundle);
          if (resolution.tombstone) {
            this.database.recordTombstone(account.id, removal.id, removal);
          }
        } else {
          this.database.recordTombstone(account.id, removal.id, removal);
        }
      } catch (error) {
        this.recordError(runId, account.id, removal.id, 'tombstone', error);
        if (isGmailRateLimit(account, error)) {
          throw markIngestionErrorRecorded(error, errors);
        }
        errors += 1;
      }
    }
    if (bundles.length > 0) {
      const result = await this.archiveRefs(
        account,
        provider,
        bundles.map((bundle) => ({ id: bundle.message.providerMessageId })),
        runId
      );
      errors += result.errors;
    }
    return errors;
  }

  async runAccountCycle(account) {
    const provider = this.providerFactory(account);
    const runId = this.database.beginRun(account.id, 'scheduled_cycle');
    const counts = { discovered: 0, archived: 0, errors: 0 };
    const details = { phases: [] };
    try {
      const locations = await this.recordLocations(account, provider);
      details.locationCount = locations.length;

      const recentRefs = await provider.listRecent({
        pageSize: this.config.incrementalBatchSize,
      });
      const recent = await this.archiveRefs(
        account,
        provider,
        recentRefs,
        runId
      );
      Object.keys(counts).forEach((key) => (counts[key] += recent[key] || 0));
      details.phases.push({ name: 'recent', ...recent });

      const incrementalCursor = this.database.getCursor(
        account.id,
        'incremental'
      );
      const incrementalPage = await provider.listIncrementalPage(
        incrementalCursor?.cursor || null,
        { pageSize: this.config.incrementalBatchSize }
      );
      const incremental = await this.archiveRefs(
        account,
        provider,
        incrementalPage.refs,
        runId
      );
      try {
        incremental.errors += await this.processTombstones(
          account,
          provider,
          incrementalPage.tombstones,
          runId
        );
      } catch (error) {
        if (error?.[INGESTION_ERROR_RECORDED]) {
          throw markIngestionErrorRecorded(error, incremental.errors);
        }
        throw error;
      }
      Object.keys(counts).forEach(
        (key) => (counts[key] += incremental[key] || 0)
      );
      details.phases.push({
        name: 'incremental',
        ...incremental,
        reset: incrementalPage.reset,
      });
      if (incremental.errors === 0) {
        this.database.setCursor(
          account.id,
          'incremental',
          incrementalPage.nextCursor,
          {
            complete: incrementalPage.complete,
            reset: incrementalPage.reset,
          }
        );
      }

      const pending = this.database.pendingAttachments(
        account.id,
        this.config.attachmentRetryBatchSize
      );
      const pendingRefs = [
        ...new Set(pending.map((item) => item.provider_message_id)),
      ].map((id) => ({ id }));
      if (pendingRefs.length > 0) {
        const retried = await this.archiveRefs(
          account,
          provider,
          pendingRefs,
          runId
        );
        Object.keys(counts).forEach(
          (key) => (counts[key] += retried[key] || 0)
        );
        details.phases.push({ name: 'attachment_retry', ...retried });
      }

      const backfillCursor = this.database.getCursor(account.id, 'backfill');
      const backfillMetadata = metadata(backfillCursor);
      if (!backfillMetadata.complete) {
        const page = await provider.listBackfillPage(
          backfillCursor?.cursor || null,
          { pageSize: this.config.backfillBatchSize }
        );
        const backfill = await this.archiveRefs(
          account,
          provider,
          page.refs,
          runId
        );
        Object.keys(counts).forEach(
          (key) => (counts[key] += backfill[key] || 0)
        );
        details.phases.push({
          name: 'backfill',
          ...backfill,
          complete: page.complete,
          estimate: page.estimate,
        });
        if (backfill.errors === 0) {
          this.database.setCursor(account.id, 'backfill', page.nextCursor, {
            complete: page.complete,
            estimate: page.estimate,
          });
        }
      }

      const status = counts.errors === 0 ? 'completed' : 'failed';
      this.database.finishRun(runId, status, counts, details);
      return { accountId: account.id, status, ...counts, details };
    } catch (error) {
      const unaggregatedErrors = Number(error?.[UNAGGREGATED_ERROR_COUNT] || 0);
      const hadOtherErrors = counts.errors + unaggregatedErrors > 0;
      counts.errors += unaggregatedErrors + 1;
      const rateLimited = isGmailRateLimit(account, error) && !hadOtherErrors;
      if (!error?.[INGESTION_ERROR_RECORDED] && !rateLimited) {
        this.recordError(runId, account.id, null, 'account_cycle', error);
      }
      this.database.finishRun(runId, 'failed', counts, {
        ...details,
        failure: safeError(error),
        outcome: rateLimited ? 'rate_limited' : 'failed',
      });
      return {
        accountId: account.id,
        status: rateLimited ? 'rate_limited' : 'failed',
        ...counts,
        error: safeError(error),
      };
    }
  }

  async runAll(accounts = this.config.accounts) {
    const results = [];
    for (const account of accounts) {
      results.push(await this.runAccountCycle(account));
    }
    return results;
  }

  reconciliationDue(
    account,
    { now = Date.now(), intervalMs = 7 * 24 * 60 * 60 * 1000 } = {}
  ) {
    const backfill = this.database.getCursor(account.id, 'backfill');
    if (!metadata(backfill).complete) return false;
    const reconciliation = this.database.getCursor(
      account.id,
      'reconciliation'
    );
    if (!metadata(reconciliation).complete) return true;
    const reconciliationTime = new Date(reconciliation.updated_at).getTime();
    const backfillTime = new Date(backfill.updated_at).getTime();
    return (
      !Number.isFinite(reconciliationTime) ||
      reconciliationTime < backfillTime ||
      now - reconciliationTime >= intervalMs
    );
  }

  async reconcileAccount(
    account,
    {
      deadlineMs = Number.POSITIVE_INFINITY,
      batchSize = this.config.reconciliationBatchSize || 1,
      now = () => Date.now(),
    } = {}
  ) {
    const provider = this.providerFactory(account);
    const runId = this.database.beginRun(account.id, 'reconciliation');
    const providerIds = new Set();
    const counts = { discovered: 0, archived: 0, errors: 0 };
    const safeBatchSize = Math.max(1, Number.parseInt(batchSize, 10) || 1);
    const budgetExpired = () =>
      Number.isFinite(deadlineMs) && now() >= deadlineMs;
    const defer = (deferredAt) => {
      const localEligible = this.database.listProviderMessageIds(account.id, {
        currentEligible: 1,
      }).length;
      const details = {
        providerEligible: providerIds.size,
        localEligible,
        differences: null,
        outcome: 'deferred',
        deferredAt,
      };
      this.database.finishRun(runId, 'interrupted', counts, details);
      return {
        accountId: account.id,
        status: 'deferred',
        ...counts,
        ...details,
      };
    };
    try {
      if (budgetExpired()) return defer('before_locations');
      await this.recordLocations(account, provider);
      let cursor = null;
      do {
        if (budgetExpired()) return defer('before_inventory_page');
        const page = await provider.listInventoryPage(cursor, {
          pageSize: 500,
        });
        for (const ref of page.refs) providerIds.add(ref.id);
        counts.discovered += page.refs.length;
        const local = new Set(
          this.database.listProviderMessageIds(account.id, {
            currentEligible: 1,
          })
        );
        const missing = page.refs.filter((ref) => !local.has(ref.id));
        for (let offset = 0; offset < missing.length; offset += safeBatchSize) {
          if (budgetExpired()) return defer('before_missing_batch');
          const archived = await this.archiveRefs(
            account,
            provider,
            missing.slice(offset, offset + safeBatchSize),
            runId,
            { shouldContinue: () => !budgetExpired() }
          );
          counts.archived += archived.archived;
          counts.errors += archived.errors;
          if (budgetExpired()) return defer('after_missing_batch');
        }
        cursor = page.nextCursor;
        if (page.complete) break;
      } while (cursor);

      if (counts.errors === 0) {
        const localIds = this.database.listProviderMessageIds(account.id, {
          currentEligible: 1,
        });
        for (const id of localIds) {
          if (!providerIds.has(id)) {
            this.database.recordTombstone(account.id, id, {
              reason: 'absent_from_complete_reconciliation',
            });
          }
        }
      }
      const localEligible = this.database.listProviderMessageIds(account.id, {
        currentEligible: 1,
      }).length;
      const differences = Math.abs(providerIds.size - localEligible);
      const status =
        counts.errors === 0 && differences === 0 ? 'completed' : 'failed';
      const details = {
        providerEligible: providerIds.size,
        localEligible,
        differences,
      };
      this.database.finishRun(runId, status, counts, details);
      if (status === 'completed') {
        this.database.setCursor(account.id, 'backfill', null, {
          complete: true,
          estimate: providerIds.size,
          completedBy: 'full_reconciliation',
        });
        this.database.setCursor(account.id, 'reconciliation', null, {
          complete: true,
          providerEligible: providerIds.size,
          localEligible,
          differences,
        });
      }
      return { accountId: account.id, status, ...counts, ...details };
    } catch (error) {
      const unaggregatedErrors = Number(error?.[UNAGGREGATED_ERROR_COUNT] || 0);
      const hadOtherErrors = counts.errors + unaggregatedErrors > 0;
      counts.errors += unaggregatedErrors + 1;
      const rateLimited = isGmailRateLimit(account, error) && !hadOtherErrors;
      if (!error?.[INGESTION_ERROR_RECORDED] && !rateLimited) {
        this.recordError(runId, account.id, null, 'reconciliation', error);
      }
      this.database.finishRun(runId, 'failed', counts, {
        failure: safeError(error),
        outcome: rateLimited ? 'rate_limited' : 'failed',
      });
      return {
        accountId: account.id,
        status: rateLimited ? 'rate_limited' : 'failed',
        ...counts,
        error: safeError(error),
      };
    }
  }
}

module.exports = {
  ArchiveSyncEngine,
  isGmailRateLimit,
  metadata,
  safeError,
};
