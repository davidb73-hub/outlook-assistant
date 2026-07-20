class DeliveryWorker {
  constructor({ database, adapters, maxAttempts = 3 }) {
    this.database = database;
    this.adapters = adapters;
    this.maxAttempts = maxAttempts;
  }

  async processPending() {
    const jobs = this.database.listDeliveryJobs('pending');
    const results = [];
    for (const job of jobs) results.push(await this.processJob(job));
    return results;
  }

  async processJob(job) {
    if (!job.packageRoot && job.package_root) {
      job.packageRoot = job.package_root;
    }
    if (job.attempts >= this.maxAttempts) {
      return this.database.updateDeliveryJob(job.id, 'review', {
        error: 'retry-limit-exceeded',
      });
    }
    const adapter = this.adapters[job.destination];
    if (!adapter) {
      return this.database.updateDeliveryJob(job.id, 'review', {
        error: 'destination-adapter-missing',
      });
    }
    this.database.updateDeliveryJob(job.id, 'running');
    try {
      const acknowledgement = await adapter.deliver(job);
      if (acknowledgement?.pending) {
        return this.database.updateDeliveryJob(job.id, 'pending', {
          error: acknowledgement.reason,
        });
      }
      if (!acknowledgement?.accepted) {
        return this.database.updateDeliveryJob(job.id, 'rejected', {
          error: acknowledgement?.reason || 'destination-rejected',
        });
      }
      return this.database.updateDeliveryJob(job.id, 'delivered', {
        manifestDigest: acknowledgement.manifestDigest,
        destinationRecordId: acknowledgement.destinationRecordId,
      });
    } catch (error) {
      return this.database.updateDeliveryJob(
        job.id,
        job.attempts + 1 >= this.maxAttempts ? 'review' : 'pending',
        { error: String(error.message || error) }
      );
    }
  }
}

module.exports = { DeliveryWorker };
