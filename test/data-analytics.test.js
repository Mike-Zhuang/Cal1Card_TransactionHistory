import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  buildDashboard,
  buildTransactionsCsv,
  filterTransactions,
} from "../src/analytics.js";
import { EncryptedCodec } from "../src/crypto-store.js";
import { DataRepository } from "../src/data-repository.js";

function createFixture() {
  const directory = mkdtempSync(path.join(os.tmpdir(), "cal1card-repository-"));
  const codec = new EncryptedCodec("repository-test-secret");
  const repository = new DataRepository({
    databasePath: path.join(directory, "cal1card.sqlite"),
    codec,
  });
  return { directory, repository };
}

const snapshot = {
  fetchedAt: "2026-07-09T20:00:00.000Z",
  accountName: "PRIVATE ACCOUNT NAME",
  accountNumberMasked: "*****6789",
  asOf: "07/09/2026 01:00 PM",
  plans: [
    {
      planCode: "Debit",
      name: "Cal 1 Card Debit",
      balance: "$80.00",
      balanceValue: 80,
      isCurrency: true,
    },
  ],
};

const transactionGroups = [
  {
    plan: snapshot.plans[0],
    transactions: [
      {
        posted: "07/09/2026 12:00 PM",
        postedAt: "2026-07-09T19:00:00.000Z",
        amount: "-$12.00",
        amountValue: -12,
        balance: "$80.00",
        balanceValue: 80,
        location: "PRIVATE GOLDEN BEAR CAFE",
      },
      {
        posted: "07/03/2026 12:00 PM",
        postedAt: "2026-07-03T19:00:00.000Z",
        amount: "-$8.00",
        amountValue: -8,
        balance: "$92.00",
        balanceValue: 92,
        location: "Moffitt Printing",
      },
    ],
  },
];

test("SQLite 迁移、加密写入和 HMAC 去重保持稳定", () => {
  const fixture = createFixture();
  try {
    const first = fixture.repository.recordSync(snapshot, transactionGroups);
    const second = fixture.repository.recordSync(snapshot, transactionGroups);
    assert.equal(first.insertedCount, 2);
    assert.equal(second.insertedCount, 0);
    assert.equal(fixture.repository.getTransactions().length, 2);

    const rawDatabase = readFileSync(path.join(fixture.directory, "cal1card.sqlite")).toString("latin1");
    assert.equal(rawDatabase.includes("PRIVATE GOLDEN BEAR CAFE"), false);
    assert.equal(rawDatabase.includes("PRIVATE ACCOUNT NAME"), false);
    assert.deepEqual(
      fixture.repository.database
        .prepare("SELECT version FROM schema_migrations")
        .all()
        .map((row) => row.version),
      [1],
    );
  } finally {
    fixture.repository.close();
    rmSync(fixture.directory, { recursive: true, force: true });
  }
});

test("地点分类规则会应用到同地点历史交易", () => {
  const fixture = createFixture();
  try {
    fixture.repository.recordSync(snapshot, transactionGroups);
    fixture.repository.setCategoryRule("private golden bear cafe", "dining");
    const cafe = fixture.repository
      .getTransactions()
      .find((transaction) => transaction.location === "PRIVATE GOLDEN BEAR CAFE");
    assert.equal(cafe.category, "dining");
    fixture.repository.deleteCategoryRule("PRIVATE GOLDEN BEAR CAFE");
    assert.equal(fixture.repository.getTransactions()[0].category, "uncategorized");
  } finally {
    fixture.repository.close();
    rmSync(fixture.directory, { recursive: true, force: true });
  }
});

test("仪表盘预算、趋势与范围筛选按消费负数计算", () => {
  const fixture = createFixture();
  try {
    fixture.repository.recordSync(snapshot, transactionGroups);
    fixture.repository.setCategoryRule("PRIVATE GOLDEN BEAR CAFE", "dining");
    fixture.repository.setBudget("Debit", 100);
    const transactions = fixture.repository.getTransactions();
    const dashboard = buildDashboard({
      snapshot,
      transactions,
      budgets: fixture.repository.getBudgets(),
      range: "30d",
      planCode: "Debit",
      now: new Date("2026-07-10T00:00:00.000Z"),
    });
    assert.equal(dashboard.metrics.monthSpend, 20);
    assert.equal(dashboard.metrics.budget.percent, 20);
    assert.equal(dashboard.metrics.topLocation.location, "PRIVATE GOLDEN BEAR CAFE");
    assert.equal(dashboard.categoryTotals.find((item) => item.id === "dining").value, 12);
    assert.equal(
      filterTransactions(transactions, { range: "7d", planCode: "Debit" }, new Date("2026-07-10T00:00:00Z")).length,
      2,
    );
  } finally {
    fixture.repository.close();
    rmSync(fixture.directory, { recursive: true, force: true });
  }
});

test("CSV 导出阻断表格公式注入", () => {
  const csv = buildTransactionsCsv([
    {
      posted: "07/09/2026",
      amount: "-$1.00",
      balance: "$20.00",
      location: "=HYPERLINK(\"https://example.invalid\")",
      planName: "Debit",
      category: "other",
    },
  ]);
  assert.match(csv, /"'=HYPERLINK/);
  assert.ok(csv.startsWith("\ufeff"));
});
