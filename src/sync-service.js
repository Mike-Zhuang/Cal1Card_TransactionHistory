import { Cal1CardError } from "./cal1card-client.js";

export class SyncService {
  constructor({ client, repository }) {
    this.client = client;
    this.repository = repository;
    this.activeSync = null;
  }

  async sync(storageState = undefined) {
    if (this.activeSync) {
      return this.activeSync;
    }

    this.activeSync = this.runSync(storageState).finally(() => {
      this.activeSync = null;
    });
    return this.activeSync;
  }

  async runSync(storageState) {
    try {
      const result = await this.client.fetchAll(storageState);
      const persisted = this.repository.recordSync(result.snapshot, result.transactionGroups);
      return {
        ok: true,
        ...persisted,
        snapshot: result.snapshot,
        transactionGroups: result.transactionGroups,
      };
    } catch (error) {
      const code = error instanceof Cal1CardError ? error.code : "SYNC_FAILED";
      const message = error instanceof Error ? error.message : String(error);
      this.repository.recordSyncFailure(code, message);
      throw error;
    }
  }
}
