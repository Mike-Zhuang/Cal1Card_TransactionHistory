import AxeBuilder from "@axe-core/playwright";
import { expect, test } from "playwright/test";

const categories = [
  { id: "uncategorized", label: "未分类", color: "#8b9098" },
  { id: "dining", label: "餐饮", color: "#1f6f78" },
  { id: "printing", label: "打印", color: "#4f6fae" },
  { id: "laundry", label: "洗衣", color: "#d28d3f" },
  { id: "retail", label: "零售", color: "#bd5f5a" },
  { id: "transit", label: "交通", color: "#677d4d" },
  { id: "other", label: "其他", color: "#746087" },
];

const plans = [
  {
    planCode: "Debit",
    name: "Cal 1 Card Debit",
    balance: "$184.62",
    balanceValue: 184.62,
    isCurrency: true,
  },
  {
    planCode: "MealSwipes",
    name: "Summer Meal Swipes",
    balance: "17",
    balanceValue: 17,
    isCurrency: false,
  },
  {
    planCode: "Flex",
    name: "Flex Dollars",
    balance: "$42.18",
    balanceValue: 42.18,
    isCurrency: true,
  },
];

const transactions = Array.from({ length: 25 }, (_, index) => {
  const amount = -(4.25 + (index % 8) * 1.17);
  return {
    transactionId: String(index),
    planCode: "Debit",
    planName: "Cal 1 Card Debit",
    posted: "07/09/2026 12:18 PM",
    postedAt: new Date(Date.parse("2026-07-09T19:18:00.000Z") - index * 86_400_000).toISOString(),
    amount: `-$${Math.abs(amount).toFixed(2)}`,
    amountValue: amount,
    balance: `$${(184.62 + index * 4.25).toFixed(2)}`,
    balanceValue: 184.62 + index * 4.25,
    location:
      index === 0
        ? "Martin Luther King Jr. Student Union - Golden Bear Cafe"
        : ["Crossroads Dining", "Moffitt Library Printing", "Bear Market", "Unit 2 Laundry"][index % 4],
    category: ["dining", "printing", "retail", "laundry", "uncategorized"][index % 5],
  };
});

function dashboardFixture({ empty = false } = {}) {
  return {
    ok: true,
    ready: true,
    hasBoundStorageState: true,
    syncState: { ok: true, lastSuccessfulSyncAt: "2026-07-09T22:45:00.000Z" },
    categories,
    accountName: "MIKE ZHUANG",
    accountNumberMasked: "******4821",
    asOf: "07/09/2026 03:45 PM",
    fetchedAt: "2026-07-09T22:45:00.000Z",
    plans,
    selectedPlan: plans[0],
    range: "30d",
    metrics: {
      monthSpend: empty ? 0 : 146.28,
      sevenDaySpend: empty ? 0 : 54.17,
      sevenDayChangePercent: empty ? null : 12.4,
      transactionCount: empty ? 0 : 25,
      topLocation: empty ? null : { location: "Crossroads Dining", amount: 72.18 },
      budget: { planCode: "Debit", monthlyAmount: 200, spent: empty ? 0 : 146.28, percent: empty ? 0 : 73.1 },
    },
    trend: empty
      ? []
      : Array.from({ length: 14 }, (_, index) => ({
          label: `2026-07-${String(index + 1).padStart(2, "0")}`,
          value: 3 + ((index * 7) % 19),
        })),
    categoryTotals: empty
      ? []
      : [
          { id: "dining", label: "餐饮", color: "#1f6f78", value: 72.18 },
          { id: "printing", label: "打印", color: "#4f6fae", value: 21.4 },
          { id: "laundry", label: "洗衣", color: "#d28d3f", value: 18 },
          { id: "retail", label: "零售", color: "#bd5f5a", value: 34.7 },
        ],
  };
}

async function assertNoHorizontalOverflow(page) {
  const widths = await page.evaluate(() => ({
    viewport: document.documentElement.clientWidth,
    document: document.documentElement.scrollWidth,
    body: document.body.scrollWidth,
  }));
  expect(widths.document).toBeLessThanOrEqual(widths.viewport);
  expect(widths.body).toBeLessThanOrEqual(widths.viewport);
}

async function assertNoSeriousAccessibilityViolations(page) {
  const audit = await new AxeBuilder({ page }).analyze();
  const blocking = audit.violations.filter((violation) =>
    ["serious", "critical"].includes(violation.impact),
  );
  expect(blocking).toEqual([]);
}

async function mockAuthenticatedWallet(page, { empty = false, transactionDelay = 0 } = {}) {
  await page.route("**/api/auth/me", (route) =>
    route.fulfill({
      json: {
        ok: true,
        authenticated: true,
        csrfToken: "e2e-csrf-token",
        hasBoundStorageState: true,
        webLoginEnabled: true,
        syncState: { ok: true, lastSuccessfulSyncAt: "2026-07-09T22:45:00.000Z" },
      },
    }),
  );
  await page.route("**/api/dashboard?*", (route) => route.fulfill({ json: dashboardFixture({ empty }) }));
  await page.route("**/api/transactions?*", async (route) => {
    if (transactionDelay) await new Promise((resolve) => setTimeout(resolve, transactionDelay));
    const result = empty ? [] : transactions;
    await route.fulfill({
      json: { ok: true, page: 1, limit: 25, total: result.length, totalPages: 1, transactions: result },
    });
  });
  await page.route("**/api/category-rules", (route) => route.fulfill({ json: { ok: true } }));
}

test("登录页与未绑定页可访问且无横向溢出", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByRole("heading", { name: "查看你的校园消费" })).toBeVisible();
  await expect(page.locator("#passwordInput")).toBeFocused();
  await assertNoHorizontalOverflow(page);
  await assertNoSeriousAccessibilityViolations(page);

  await page.locator("#passwordInput").fill("e2e-console-password");
  await page.getByRole("button", { name: "进入钱包" }).click();
  await expect(page.getByRole("heading", { name: "连接你的 Cal1Card" })).toBeVisible();
  await expect(page.locator("#startRemoteLoginButton")).toBeDisabled();
  await assertNoHorizontalOverflow(page);
  await assertNoSeriousAccessibilityViolations(page);
});

test("正常数据、交易骨架和图表在视口矩阵中稳定", async ({ page }, testInfo) => {
  await mockAuthenticatedWallet(page, { transactionDelay: 350 });
  await page.goto("/");
  await expect(page.getByRole("heading", { name: "你的 Cal1Card" })).toBeVisible();
  await expect(page.locator("#transactionsSkeleton")).toBeVisible();
  await expect(page.locator("#transactionsSkeleton")).toBeHidden();
  await expect(page.locator("#monthSpend")).toHaveText("$146.28");
  await expect(page.locator("#trendChart")).toBeVisible();
  await expect(page.locator("#categoryChart")).toBeVisible();
  await expect(page.locator("#transactionsBody tr")).toHaveCount(25);
  await expect(page.locator("#transactionList .transaction-item")).toHaveCount(25);
  await assertNoHorizontalOverflow(page);
  await assertNoSeriousAccessibilityViolations(page);
  await page.screenshot({ path: testInfo.outputPath("dashboard.png"), fullPage: true });
});

test("空数据和服务器错误使用明确状态而不是伪造内容", async ({ page }) => {
  await mockAuthenticatedWallet(page, { empty: true });
  await page.goto("/");
  await expect(page.locator("#trendEmpty")).toBeVisible();
  await expect(page.locator("#categoryEmpty")).toBeVisible();
  await expect(page.locator("#transactionsEmpty")).toBeVisible();
  await expect(page.locator("#selectedBalance")).toHaveText("$184.62");
  await assertNoHorizontalOverflow(page);

  await page.unrouteAll({ behavior: "ignoreErrors" });
  await page.route("**/api/auth/me", (route) =>
    route.fulfill({ json: { ok: true, authenticated: true, csrfToken: "token", hasBoundStorageState: true } }),
  );
  await page.route("**/api/dashboard?*", (route) =>
    route.fulfill({ status: 500, json: { ok: false, error: "测试用上游错误" } }),
  );
  await page.reload();
  await expect(page.getByRole("heading", { name: "暂时无法读取钱包" })).toBeVisible();
  await expect(page.locator("#errorMessage")).toHaveText("测试用上游错误");
  await assertNoSeriousAccessibilityViolations(page);
});

test("临时远程浏览器和会话过期状态可清晰呈现", async ({ page }) => {
  let sessionPolls = 0;
  await page.route("**/api/auth/me", (route) =>
    route.fulfill({
      json: {
        ok: true,
        authenticated: true,
        csrfToken: "token",
        hasBoundStorageState: false,
        webLoginEnabled: true,
        syncState: null,
      },
    }),
  );
  await page.route("**/api/dashboard?*", (route) =>
    route.fulfill({ json: { ...dashboardFixture({ empty: true }), ready: false, plans: [], selectedPlan: null } }),
  );
  await page.route("**/api/calnet-login-sessions", (route) =>
    route.fulfill({
      status: 202,
      json: {
        ok: true,
        session: {
          sessionId: "session-1",
          status: "starting",
          message: "正在启动安全登录环境",
          createdAt: new Date().toISOString(),
          expiresAt: new Date(Date.now() + 900_000).toISOString(),
          streamReady: false,
          streamPath: "/api/calnet-login-sessions/session-1/stream",
        },
      },
    }),
  );
  await page.route("**/api/calnet-login-sessions/session-1", (route) => {
    sessionPolls += 1;
    return route.fulfill({
      json: {
        ok: true,
        session: {
          sessionId: "session-1",
          status: "awaiting_input",
          message: "请完成 CalNet 和 Duo Push",
          expiresAt: new Date(Date.now() + 900_000).toISOString(),
          streamReady: false,
        },
      },
    });
  });
  await page.goto("/");
  await page.getByRole("button", { name: "使用 CalNet 连接" }).click();
  await expect(page.getByRole("heading", { name: "CalNet 登录" })).toBeVisible();
  await expect(page.locator("#remoteStatusText")).toHaveText("请完成 CalNet 和 Duo Push");
  expect(sessionPolls).toBeGreaterThan(0);
  await assertNoHorizontalOverflow(page);

  await page.unrouteAll({ behavior: "ignoreErrors" });
  await page.route("**/api/auth/me", (route) =>
    route.fulfill({ json: { ok: true, authenticated: false } }),
  );
  await page.reload();
  await expect(page.locator("#loginStatus")).toHaveText("请输入控制台密码");
});
