import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import path from "node:path";

import { normalizeWhitespace } from "./cal1card-parser.js";

const DEFAULT_CATEGORY = "uncategorized";

function encryptedText(codec, payload) {
  return JSON.stringify(codec.encrypt(payload));
}

function decryptText(codec, payload) {
  return codec.decrypt(JSON.parse(payload));
}

export function normalizeLocation(value) {
  return normalizeWhitespace(value).toLocaleLowerCase("en-US");
}

export class DataRepository {
  constructor({ databasePath, codec }) {
    mkdirSync(path.dirname(databasePath), { recursive: true, mode: 0o700 });
    this.codec = codec;
    this.database = new DatabaseSync(databasePath);
    this.database.exec("PRAGMA journal_mode = WAL");
    this.database.exec("PRAGMA synchronous = NORMAL");
    this.database.exec("PRAGMA busy_timeout = 5000");
    this.migrate();
  }

  migrate() {
    this.database.exec(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        version INTEGER PRIMARY KEY,
        applied_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS transactions (
        transaction_id TEXT PRIMARY KEY,
        payload TEXT NOT NULL,
        first_seen_at TEXT NOT NULL,
        last_seen_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS snapshots (
        snapshot_id INTEGER PRIMARY KEY AUTOINCREMENT,
        captured_at TEXT NOT NULL,
        payload TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS snapshots_captured_at_idx ON snapshots(captured_at DESC);
      CREATE TABLE IF NOT EXISTS category_rules (
        rule_id TEXT PRIMARY KEY,
        payload TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS budgets (
        budget_id TEXT PRIMARY KEY,
        payload TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS sync_state (
        state_key TEXT PRIMARY KEY,
        payload TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
    `);
    this.database
      .prepare("INSERT OR IGNORE INTO schema_migrations(version, applied_at) VALUES(1, ?)")
      .run(new Date().toISOString());
    this.migrateCrossPlanDuplicates();
  }

  migrateCrossPlanDuplicates() {
    const alreadyApplied = this.database
      .prepare("SELECT 1 FROM schema_migrations WHERE version = 2")
      .get();
    if (alreadyApplied) {
      return;
    }

    this.database.exec("BEGIN IMMEDIATE");
    try {
      const snapshotRow = this.database
        .prepare("SELECT payload FROM snapshots ORDER BY captured_at DESC LIMIT 1")
        .get();
      if (snapshotRow) {
        const snapshot = decryptText(this.codec, snapshotRow.payload);
        const fundedPlanCodes = new Set(
          (snapshot.plans ?? [])
            .filter((plan) => Number.isFinite(plan.balanceValue))
            .map((plan) => plan.planCode),
        );
        const duplicateGroups = new Map();
        for (const row of this.database
          .prepare("SELECT transaction_id, payload FROM transactions")
          .all()) {
          const transaction = decryptText(this.codec, row.payload);
          const identity = JSON.stringify({
            posted: normalizeWhitespace(transaction.posted),
            amount: normalizeWhitespace(transaction.amount),
            balance: normalizeWhitespace(transaction.balance),
            location: normalizeLocation(transaction.location),
          });
          const group = duplicateGroups.get(identity) ?? [];
          group.push({ transactionId: row.transaction_id, planCode: transaction.planCode });
          duplicateGroups.set(identity, group);
        }

        const deleteTransaction = this.database.prepare(
          "DELETE FROM transactions WHERE transaction_id = ?",
        );
        for (const group of duplicateGroups.values()) {
          const fundedMatches = group.filter(({ planCode }) => fundedPlanCodes.has(planCode));
          const fundedMatchesPlanCodes = new Set(fundedMatches.map(({ planCode }) => planCode));
          if (group.length < 2 || fundedMatchesPlanCodes.size !== 1) {
            continue;
          }
          const [authoritativePlanCode] = fundedMatchesPlanCodes;
          for (const transaction of group) {
            if (transaction.planCode !== authoritativePlanCode) {
              deleteTransaction.run(transaction.transactionId);
            }
          }
        }
      }

      this.database
        .prepare("INSERT INTO schema_migrations(version, applied_at) VALUES(2, ?)")
        .run(new Date().toISOString());
      this.database.exec("COMMIT");
    } catch (error) {
      this.database.exec("ROLLBACK");
      throw error;
    }
  }

  createTransactionId(planCode, transaction) {
    return this.codec.fingerprint({
      planCode,
      posted: normalizeWhitespace(transaction.posted),
      amount: normalizeWhitespace(transaction.amount),
      balance: normalizeWhitespace(transaction.balance),
      location: normalizeLocation(transaction.location),
    });
  }

  recordSync(snapshot, transactionGroups) {
    const capturedAt = snapshot.fetchedAt ?? new Date().toISOString();
    const insertTransaction = this.database.prepare(`
      INSERT OR IGNORE INTO transactions(transaction_id, payload, first_seen_at, last_seen_at)
      VALUES(?, ?, ?, ?)
    `);
    const updateTransaction = this.database.prepare(`
      UPDATE transactions SET payload = ?, last_seen_at = ? WHERE transaction_id = ?
    `);
    let insertedCount = 0;
    let totalCount = 0;

    this.database.exec("BEGIN IMMEDIATE");
    try {
      for (const group of transactionGroups) {
        for (const transaction of group.transactions) {
          totalCount += 1;
          const transactionId = this.createTransactionId(group.plan.planCode, transaction);
          const payload = {
            transactionId,
            planCode: group.plan.planCode,
            planName: group.plan.name,
            ...transaction,
          };
          const result = insertTransaction.run(
            transactionId,
            encryptedText(this.codec, payload),
            capturedAt,
            capturedAt,
          );
          if (Number(result.changes) > 0) {
            insertedCount += 1;
          } else {
            updateTransaction.run(encryptedText(this.codec, payload), capturedAt, transactionId);
          }
        }
      }

      this.database
        .prepare("INSERT INTO snapshots(captured_at, payload) VALUES(?, ?)")
        .run(capturedAt, encryptedText(this.codec, snapshot));
      this.database
        .prepare(`
          INSERT INTO sync_state(state_key, payload, updated_at) VALUES('latest', ?, ?)
          ON CONFLICT(state_key) DO UPDATE SET payload = excluded.payload, updated_at = excluded.updated_at
        `)
        .run(
          encryptedText(this.codec, {
            ok: true,
            lastSuccessfulSyncAt: capturedAt,
            transactionCount: totalCount,
          }),
          capturedAt,
        );
      this.database.exec("COMMIT");
    } catch (error) {
      this.database.exec("ROLLBACK");
      throw error;
    }

    return { insertedCount, totalCount, capturedAt };
  }

  recordSyncFailure(errorCode, message) {
    const updatedAt = new Date().toISOString();
    const previous = this.getSyncState();
    const payload = {
      ...previous,
      ok: false,
      errorCode,
      message,
      lastAttemptAt: updatedAt,
    };
    this.database
      .prepare(`
        INSERT INTO sync_state(state_key, payload, updated_at) VALUES('latest', ?, ?)
        ON CONFLICT(state_key) DO UPDATE SET payload = excluded.payload, updated_at = excluded.updated_at
      `)
      .run(encryptedText(this.codec, payload), updatedAt);
  }

  getSyncState() {
    const row = this.database
      .prepare("SELECT payload FROM sync_state WHERE state_key = 'latest'")
      .get();
    return row ? decryptText(this.codec, row.payload) : null;
  }

  getLatestSnapshot() {
    const row = this.database
      .prepare("SELECT payload FROM snapshots ORDER BY captured_at DESC LIMIT 1")
      .get();
    return row ? decryptText(this.codec, row.payload) : null;
  }

  getSnapshots() {
    return this.database
      .prepare("SELECT payload FROM snapshots ORDER BY captured_at ASC")
      .all()
      .map((row) => decryptText(this.codec, row.payload));
  }

  getCategoryRules() {
    const rules = new Map();
    for (const row of this.database.prepare("SELECT payload FROM category_rules").all()) {
      const rule = decryptText(this.codec, row.payload);
      rules.set(normalizeLocation(rule.location), rule);
    }
    return rules;
  }

  setCategoryRule(location, category) {
    const normalizedLocation = normalizeLocation(location);
    if (!normalizedLocation) {
      throw new Error("地点不能为空");
    }
    const updatedAt = new Date().toISOString();
    const rule = { location: normalizeWhitespace(location), category, updatedAt };
    const ruleId = this.codec.fingerprint(normalizedLocation);
    this.database
      .prepare(`
        INSERT INTO category_rules(rule_id, payload, updated_at) VALUES(?, ?, ?)
        ON CONFLICT(rule_id) DO UPDATE SET payload = excluded.payload, updated_at = excluded.updated_at
      `)
      .run(ruleId, encryptedText(this.codec, rule), updatedAt);
    return { ruleId, ...rule };
  }

  deleteCategoryRule(location) {
    const ruleId = this.codec.fingerprint(normalizeLocation(location));
    this.database.prepare("DELETE FROM category_rules WHERE rule_id = ?").run(ruleId);
  }

  getBudgets() {
    const budgets = new Map();
    for (const row of this.database.prepare("SELECT payload FROM budgets").all()) {
      const budget = decryptText(this.codec, row.payload);
      budgets.set(budget.planCode, budget);
    }
    return budgets;
  }

  setBudget(planCode, monthlyAmount) {
    const updatedAt = new Date().toISOString();
    const budgetId = this.codec.fingerprint(`budget:${planCode}`);
    if (monthlyAmount === null) {
      this.database.prepare("DELETE FROM budgets WHERE budget_id = ?").run(budgetId);
      return null;
    }

    const budget = { planCode, monthlyAmount, updatedAt };
    this.database
      .prepare(`
        INSERT INTO budgets(budget_id, payload, updated_at) VALUES(?, ?, ?)
        ON CONFLICT(budget_id) DO UPDATE SET payload = excluded.payload, updated_at = excluded.updated_at
      `)
      .run(budgetId, encryptedText(this.codec, budget), updatedAt);
    return budget;
  }

  getTransactions() {
    const rules = this.getCategoryRules();
    return this.database
      .prepare("SELECT payload, first_seen_at, last_seen_at FROM transactions")
      .all()
      .map((row) => {
        const transaction = decryptText(this.codec, row.payload);
        const rule = rules.get(normalizeLocation(transaction.location));
        return {
          ...transaction,
          category: rule?.category ?? DEFAULT_CATEGORY,
          firstSeenAt: row.first_seen_at,
          lastSeenAt: row.last_seen_at,
        };
      })
      .sort((left, right) => {
        const leftTime = Date.parse(left.postedAt ?? left.firstSeenAt) || 0;
        const rightTime = Date.parse(right.postedAt ?? right.firstSeenAt) || 0;
        return rightTime - leftTime;
      });
  }

  clearHistory() {
    this.database.exec("BEGIN IMMEDIATE");
    try {
      this.database.exec(`
        DELETE FROM transactions;
        DELETE FROM snapshots;
        DELETE FROM category_rules;
        DELETE FROM budgets;
        DELETE FROM sync_state;
      `);
      this.database.exec("COMMIT");
    } catch (error) {
      this.database.exec("ROLLBACK");
      throw error;
    }
  }

  close() {
    this.database.close();
  }
}
