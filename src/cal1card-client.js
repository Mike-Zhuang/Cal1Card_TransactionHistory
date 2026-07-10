import { request as playwrightRequest } from "playwright";

import {
  PLAN_CODE_PATTERN,
  maskAccountNumber,
  parseBalanceHtml,
  parseTransactionsHtml,
} from "./cal1card-parser.js";

export class Cal1CardError extends Error {
  constructor(message, { code = "CAL1CARD_ERROR", status = 502, needsBinding = false } = {}) {
    super(message);
    this.name = "Cal1CardError";
    this.code = code;
    this.status = status;
    this.needsBinding = needsBinding;
  }
}

export class NeedsBindingError extends Cal1CardError {
  constructor(message = "Cal1Card 登录态已失效") {
    super(message, { code: "NEEDS_BINDING", status: 401, needsBinding: true });
    this.name = "NeedsBindingError";
  }
}

function isAuthenticationUrl(url) {
  try {
    const parsed = new URL(url);
    return parsed.hostname === "auth.berkeley.edu" || parsed.pathname.includes("/cas/");
  } catch {
    return false;
  }
}

export class Cal1CardClient {
  constructor({ config, storageStateStore, requestFactory = playwrightRequest }) {
    this.config = config;
    this.storageStateStore = storageStateStore;
    this.requestFactory = requestFactory;
  }

  getStoredState() {
    const saved = this.storageStateStore.load();
    if (!saved?.storageState) {
      throw new NeedsBindingError("还没有绑定 Cal1Card 登录态");
    }
    return saved.storageState;
  }

  async createContext(storageState) {
    return this.requestFactory.newContext({
      baseURL: this.config.baseUrl,
      storageState,
      extraHTTPHeaders: {
        Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        Referer: `${this.config.baseUrl}${this.config.balancePath}`,
        "User-Agent":
          "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 " +
          "(KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
      },
    });
  }

  async fetchPage(context, pathname, searchParams, requiredSelector) {
    const url = new URL(pathname, this.config.baseUrl);
    for (const [key, value] of Object.entries(searchParams ?? {})) {
      url.searchParams.set(key, value);
    }
    const response = await context.get(`${url.pathname}${url.search}`, { timeout: 45_000 });
    const finalUrl = response.url();
    const html = await response.text();

    if (isAuthenticationUrl(finalUrl)) {
      throw new NeedsBindingError();
    }
    if (!response.ok()) {
      throw new Cal1CardError(`Cal1Card 返回 HTTP ${response.status()}`, {
        code: "UPSTREAM_HTTP_ERROR",
        status: 502,
      });
    }
    const hasSelector = html.includes(requiredSelector.replace(/^#/, 'id="')) || html.includes(requiredSelector);
    if (!hasSelector) {
      const parsed = requiredSelector.startsWith("#")
        ? new RegExp(`id=["']${requiredSelector.slice(1)}["']`).test(html)
        : true;
      if (!parsed) {
        throw new NeedsBindingError("登录态无法读取 Cal1Card 目标页面");
      }
    }

    return { html, finalUrl };
  }

  async fetchSnapshotWithContext(context) {
    const page = await this.fetchPage(
      context,
      this.config.balancePath,
      undefined,
      "#MainContent_pnlBalance",
    );
    const parsed = parseBalanceHtml(page.html, page.finalUrl);
    if (!parsed.accountName && !parsed.accountNumber) {
      throw new NeedsBindingError("Cal1Card 没有返回账户信息");
    }

    return {
      ok: true,
      fetchedAt: new Date().toISOString(),
      accountName: parsed.accountName,
      accountNumberMasked: maskAccountNumber(parsed.accountNumber),
      asOf: parsed.asOf,
      plans: parsed.plans,
    };
  }

  async fetchTransactionsWithContext(context, planCode) {
    if (!PLAN_CODE_PATTERN.test(planCode)) {
      throw new Cal1CardError("非法 planCode", { code: "INVALID_PLAN_CODE", status: 400 });
    }
    const page = await this.fetchPage(
      context,
      this.config.transactionPath,
      { pln: planCode },
      "MainContent_gv",
    );
    const parsed = parseTransactionsHtml(page.html, planCode);
    return {
      ok: true,
      fetchedAt: new Date().toISOString(),
      planCode,
      asOf: parsed.asOf,
      headers: parsed.headers,
      transactions: parsed.transactions,
    };
  }

  async fetchAll(storageState = undefined) {
    const context = await this.createContext(storageState ?? this.getStoredState());
    try {
      const snapshot = await this.fetchSnapshotWithContext(context);
      const transactionGroups = [];
      for (const plan of snapshot.plans) {
        const result = await this.fetchTransactionsWithContext(context, plan.planCode);
        transactionGroups.push({ plan, ...result });
      }
      return { snapshot, transactionGroups };
    } finally {
      await context.dispose();
    }
  }

  async verifyStorageState(storageState) {
    const context = await this.createContext(storageState);
    try {
      return await this.fetchSnapshotWithContext(context);
    } finally {
      await context.dispose();
    }
  }

  async fetchPlan(planCode) {
    const context = await this.createContext(this.getStoredState());
    try {
      return await this.fetchTransactionsWithContext(context, planCode);
    } finally {
      await context.dispose();
    }
  }
}
