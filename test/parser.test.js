import assert from "node:assert/strict";
import test from "node:test";

import {
  maskAccountNumber,
  parseBalanceHtml,
  parseDisplayedDateTime,
  parseNumericValue,
  parseTransactionsHtml,
} from "../src/cal1card-parser.js";

test("金额、账户号和 Berkeley 时区日期可以可靠标准化", () => {
  assert.equal(parseNumericValue("$1,234.56"), 1234.56);
  assert.equal(parseNumericValue("($4.25)"), -4.25);
  assert.equal(parseNumericValue("-$12.00"), -12);
  assert.equal(parseNumericValue("12 points"), null);
  assert.equal(maskAccountNumber("123456789"), "*****6789");
  assert.equal(parseDisplayedDateTime("07/09/2026 12:18 PM"), "2026-07-09T19:18:00.000Z");
  assert.equal(parseDisplayedDateTime("07/09/2026"), "2026-07-09T07:00:00.000Z");
  assert.equal(parseDisplayedDateTime("02/30/2026 01:00 PM"), null);
  assert.equal(parseDisplayedDateTime("13/09/2026 01:00 PM"), null);
});

test("余额页面解析保留原始文本并提取计划", () => {
  const html = `
    <section id="MainContent_pnlBalance">
      <span id="MainContent_lbAccountName"> Mike  Zhuang </span>
      <span id="MainContent_lbAccountNumber"> 123456789 </span>
      <span id="MainContent_lbBalanceAsOf">07/09/2026 03:45 PM</span>
      <table>
        <tr><td>Cal 1 Card Debit Balance: $184.62
          <a href="/App/CalDining/ViewTransactions?pln=Debit">View Transaction Details</a>
        </td></tr>
        <tr><td>Meal Swipes Balance: 17
          <a href="/App/CalDining/ViewTransactions?pln=MealSwipes">View Transaction Details</a>
        </td></tr>
      </table>
    </section>`;

  const parsed = parseBalanceHtml(
    html,
    "https://c1capps.sait-west.berkeley.edu/App/CalDining/ViewBalance",
  );
  assert.equal(parsed.accountName, "Mike Zhuang");
  assert.equal(parsed.accountNumber, "123456789");
  assert.deepEqual(
    parsed.plans.map(({ planCode, balance, balanceValue, isCurrency }) => ({
      planCode,
      balance,
      balanceValue,
      isCurrency,
    })),
    [
      { planCode: "Debit", balance: "$184.62", balanceValue: 184.62, isCurrency: true },
      { planCode: "MealSwipes", balance: "17", balanceValue: 17, isCurrency: false },
    ],
  );
});

test("交易页面解析无法确认的数值时返回 null", () => {
  const html = `
    <span id="MainContent_lbBalanceAsOf">07/09/2026 03:45 PM</span>
    <table id="MainContent_gvDebit">
      <tr><th>Posted</th><th>Amount</th><th>Balance</th><th>Location</th></tr>
      <tr><td>07/09/2026 12:18 PM</td><td>-$4.25</td><td>$184.62</td><td>Golden Bear Cafe</td></tr>
      <tr><td>Pending</td><td>unknown</td><td>points</td><td>Adjustment</td></tr>
    </table>`;

  const parsed = parseTransactionsHtml(html, "Debit");
  assert.deepEqual(parsed.headers, ["Posted", "Amount", "Balance", "Location"]);
  assert.equal(parsed.transactions[0].postedAt, "2026-07-09T19:18:00.000Z");
  assert.equal(parsed.transactions[0].amountValue, -4.25);
  assert.equal(parsed.transactions[1].postedAt, null);
  assert.equal(parsed.transactions[1].amountValue, null);
  assert.equal(parsed.transactions[1].balanceValue, null);
});
