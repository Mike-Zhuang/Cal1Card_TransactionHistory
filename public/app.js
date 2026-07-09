import RFB from "/vendor/novnc/core/rfb.js";

const elements = Object.fromEntries(
  [
    "loginView",
    "bootView",
    "loginForm",
    "passwordInput",
    "togglePasswordButton",
    "loginButton",
    "loginStatus",
    "authenticatedShell",
    "brandHomeButton",
    "headerAccount",
    "connectionDot",
    "connectionStateText",
    "syncButton",
    "settingsButton",
    "connectionBanner",
    "connectionBannerText",
    "bannerConnectButton",
    "loadingView",
    "errorView",
    "errorMessage",
    "retryAppButton",
    "connectView",
    "startRemoteLoginButton",
    "webLoginDisabledNotice",
    "generateFallbackButton",
    "fallbackBox",
    "fallbackCommand",
    "copyFallbackButton",
    "remoteLoginView",
    "remoteCountdown",
    "remoteStatusText",
    "remoteStageStatus",
    "remoteDesktop",
    "focusRemoteButton",
    "cancelRemoteButton",
    "retryRemoteButton",
    "dashboardView",
    "dataFreshness",
    "planSwitcher",
    "selectedPlanName",
    "selectedBalance",
    "balanceAsOf",
    "monthSpend",
    "sevenDaySpend",
    "sevenDayChange",
    "topLocation",
    "topLocationAmount",
    "budgetMetricButton",
    "budgetProgress",
    "budgetDetail",
    "trendTotal",
    "trendChart",
    "trendEmpty",
    "categoryChart",
    "categoryEmpty",
    "categoryLegend",
    "exportButton",
    "rangeControl",
    "transactionSearch",
    "categoryFilter",
    "transactionsSkeleton",
    "transactionsBody",
    "transactionList",
    "transactionsEmpty",
    "paginationText",
    "previousPageButton",
    "nextPageButton",
    "settingsDialog",
    "settingsConnection",
    "settingsConnectButton",
    "settingsLastSync",
    "settingsSyncButton",
    "openBudgetButton",
    "unbindButton",
    "clearDataButton",
    "logoutButton",
    "budgetDialog",
    "budgetForm",
    "budgetPlanName",
    "budgetInput",
    "removeBudgetButton",
    "unbindDialog",
    "unbindForm",
    "clearDataDialog",
    "clearDataForm",
    "clearDataPassword",
    "toast",
    "liveRegion",
  ].map((id) => [id, document.getElementById(id)]),
);

const state = {
  authenticated: false,
  csrfToken: "",
  hasBoundStorageState: false,
  webLoginEnabled: false,
  syncState: null,
  dashboard: null,
  categories: [],
  filters: {
    range: "30d",
    planCode: "",
    category: "",
    query: "",
    page: 1,
    limit: 25,
  },
  transactions: [],
  totalPages: 1,
  trendChart: null,
  categoryChart: null,
  remoteSession: null,
  remotePollTimer: null,
  countdownTimer: null,
  rfb: null,
  toastTimer: null,
  searchTimer: null,
};

function refreshIcons() {
  window.lucide?.createIcons({ attrs: { "aria-hidden": "true" } });
}

function announce(message) {
  elements.liveRegion.textContent = "";
  requestAnimationFrame(() => {
    elements.liveRegion.textContent = message;
  });
}

function showToast(message, type = "neutral") {
  clearTimeout(state.toastTimer);
  elements.toast.textContent = message;
  elements.toast.dataset.type = type;
  elements.toast.classList.add("visible");
  state.toastTimer = setTimeout(() => elements.toast.classList.remove("visible"), 3_400);
  announce(message);
}

function setButtonBusy(button, busy) {
  if (!button) {
    return;
  }
  button.disabled = busy;
  button.dataset.busy = String(busy);
}

function setLoginStatus(message, type = "neutral") {
  elements.loginStatus.textContent = message;
  elements.loginStatus.dataset.type = type;
}

function closeDialogs() {
  for (const dialog of document.querySelectorAll("dialog[open]")) {
    dialog.close();
  }
}

function showLogin() {
  state.authenticated = false;
  state.csrfToken = "";
  disconnectRemoteDesktop();
  closeDialogs();
  elements.bootView.classList.add("hidden");
  elements.loginView.classList.remove("hidden");
  elements.authenticatedShell.classList.add("hidden");
  window.setTimeout(() => elements.passwordInput.focus(), 0);
}

function showAuthenticatedView(viewName) {
  elements.bootView.classList.add("hidden");
  elements.loginView.classList.add("hidden");
  elements.authenticatedShell.classList.remove("hidden");
  elements.loadingView.classList.toggle("hidden", viewName !== "loading");
  elements.errorView.classList.toggle("hidden", viewName !== "error");
  elements.connectView.classList.toggle("hidden", viewName !== "connect");
  elements.remoteLoginView.classList.toggle("hidden", viewName !== "remote");
  elements.dashboardView.classList.toggle("hidden", viewName !== "dashboard");
  window.scrollTo({ top: 0, behavior: "smooth" });
  refreshIcons();
}

function showLoadingView() {
  showAuthenticatedView("loading");
}

function showErrorView(error) {
  const message = error instanceof Error ? error.message : "服务器连接失败，请稍后重试。";
  elements.errorMessage.textContent = message;
  showAuthenticatedView("error");
  announce(`读取钱包失败：${message}`);
}

async function requestJson(url, options = {}) {
  const method = String(options.method ?? "GET").toUpperCase();
  const headers = new Headers(options.headers ?? {});
  if (options.body !== undefined && !headers.has("Content-Type")) {
    headers.set("Content-Type", "application/json");
  }
  if (!["GET", "HEAD"].includes(method) && state.csrfToken && !headers.has("X-CSRF-Token")) {
    headers.set("X-CSRF-Token", state.csrfToken);
  }
  const response = await fetch(url, { ...options, method, headers });
  const contentType = response.headers.get("content-type") ?? "";
  const payload = contentType.includes("application/json")
    ? await response.json()
    : { ok: response.ok, error: await response.text() };
  if (!response.ok) {
    const error = new Error(payload.error || payload.reason || "请求失败");
    error.payload = payload;
    error.status = response.status;
    if (payload.needsAppLogin) {
      setLoginStatus("登录已过期，请重新进入", "error");
      showLogin();
    }
    throw error;
  }
  return payload;
}

function formatDateTime(value, includeSeconds = false) {
  if (!value) {
    return "--";
  }
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return String(value);
  }
  return new Intl.DateTimeFormat("zh-CN", {
    timeZone: "America/Los_Angeles",
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    ...(includeSeconds ? { second: "2-digit" } : {}),
  }).format(date);
}

function formatTransactionDate(transaction) {
  if (!transaction.postedAt) {
    return transaction.posted || "--";
  }
  return new Intl.DateTimeFormat("zh-CN", {
    timeZone: "America/Los_Angeles",
    month: "2-digit",
    day: "2-digit",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  }).format(new Date(transaction.postedAt));
}

function formatCurrency(value) {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return "--";
  }
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: 2,
  }).format(value);
}

function currentSelectedPlan() {
  return state.dashboard?.plans?.find((plan) => plan.planCode === state.filters.planCode) ?? null;
}

function updateConnectionUi() {
  const needsBinding =
    !state.hasBoundStorageState || state.syncState?.errorCode === "NEEDS_BINDING";
  elements.connectionDot.className = `status-dot ${needsBinding ? "expired" : "connected"}`;
  elements.connectionStateText.textContent = needsBinding ? "需要连接" : "已连接";
  elements.settingsConnection.textContent = needsBinding ? "需要重新登录" : "已连接 Cal1Card";
  elements.settingsConnectButton.textContent = needsBinding ? "连接" : "重新连接";
  elements.connectionBanner.classList.toggle("hidden", !needsBinding || !state.dashboard?.ready);
  elements.connectionBannerText.textContent = state.hasBoundStorageState
    ? "CalNet 登录态已过期，历史数据仍可查看"
    : "CalNet 尚未连接，历史数据仍可查看";
  elements.settingsLastSync.textContent = state.syncState?.lastSuccessfulSyncAt
    ? formatDateTime(state.syncState.lastSuccessfulSyncAt)
    : "暂无成功同步";
}

async function refreshAuthState() {
  const auth = await requestJson("/api/auth/me");
  if (!auth.authenticated) {
    showLogin();
    setLoginStatus("请输入控制台密码");
    return;
  }
  state.authenticated = true;
  state.csrfToken = auth.csrfToken;
  state.hasBoundStorageState = Boolean(auth.hasBoundStorageState);
  state.webLoginEnabled = Boolean(auth.webLoginEnabled);
  state.syncState = auth.syncState;
  elements.webLoginDisabledNotice.classList.toggle("hidden", state.webLoginEnabled);
  elements.startRemoteLoginButton.disabled = !state.webLoginEnabled;
  showLoadingView();
  await loadDashboard({ allowInitialSync: true });
}

async function login(password) {
  setButtonBusy(elements.loginButton, true);
  setLoginStatus("正在验证");
  try {
    const result = await requestJson("/api/auth/login", {
      method: "POST",
      body: JSON.stringify({ password }),
    });
    state.authenticated = true;
    state.csrfToken = result.csrfToken;
    state.hasBoundStorageState = Boolean(result.hasBoundStorageState);
    state.webLoginEnabled = Boolean(result.webLoginEnabled);
    elements.passwordInput.value = "";
    setLoginStatus("登录成功", "success");
    showLoadingView();
    await loadDashboard({ allowInitialSync: true });
  } finally {
    setButtonBusy(elements.loginButton, false);
  }
}

function showConnectView() {
  updateConnectionUi();
  elements.webLoginDisabledNotice.classList.toggle("hidden", state.webLoginEnabled);
  elements.startRemoteLoginButton.disabled = !state.webLoginEnabled;
  showAuthenticatedView("connect");
}

async function loadDashboard({ allowInitialSync = false } = {}) {
  const parameters = new URLSearchParams({ range: state.filters.range });
  if (state.filters.planCode) {
    parameters.set("planCode", state.filters.planCode);
  }
  const dashboard = await requestJson(`/api/dashboard?${parameters}`);
  state.dashboard = dashboard;
  state.hasBoundStorageState = Boolean(dashboard.hasBoundStorageState);
  state.syncState = dashboard.syncState;
  state.categories = dashboard.categories ?? [];

  if (!dashboard.ready && state.hasBoundStorageState && allowInitialSync) {
    try {
      await runSync({ silent: true });
      return;
    } catch (error) {
      if (!error.payload?.needsBinding) {
        showToast(error.message, "error");
      }
    }
  }
  if (!dashboard.ready) {
    showConnectView();
    return;
  }

  if (!state.filters.planCode || !dashboard.plans.some((plan) => plan.planCode === state.filters.planCode)) {
    state.filters.planCode = dashboard.selectedPlan?.planCode ?? dashboard.plans[0]?.planCode ?? "";
    if (state.filters.planCode !== dashboard.selectedPlan?.planCode) {
      return loadDashboard();
    }
  }
  renderDashboard(dashboard);
  updateConnectionUi();
  showAuthenticatedView("dashboard");
  await loadTransactions();
}

function renderDashboard(dashboard) {
  const selectedPlan = dashboard.selectedPlan;
  elements.headerAccount.textContent = [dashboard.accountName, dashboard.accountNumberMasked]
    .filter(Boolean)
    .join(" · ") || "个人钱包";
  elements.dataFreshness.textContent = dashboard.fetchedAt
    ? `更新于 ${formatDateTime(dashboard.fetchedAt)}`
    : "等待数据";
  renderPlanSwitcher(dashboard.plans, selectedPlan?.planCode);
  elements.selectedPlanName.textContent = selectedPlan?.name ?? "当前余额";
  const selectedBalance = selectedPlan?.balance || "--";
  elements.selectedBalance.textContent = selectedBalance;
  elements.selectedBalance.classList.toggle("balance-value-compact", selectedBalance.length > 7);
  elements.selectedBalance.classList.toggle("balance-value-tight", selectedBalance.length > 10);
  elements.balanceAsOf.textContent = dashboard.asOf || "--";
  elements.monthSpend.textContent = formatCurrency(dashboard.metrics.monthSpend);
  elements.sevenDaySpend.textContent = formatCurrency(dashboard.metrics.sevenDaySpend);

  const change = dashboard.metrics.sevenDayChangePercent;
  elements.sevenDayChange.textContent = change === null
    ? "暂无上期对比"
    : `${change > 0 ? "+" : ""}${change}% 较前 7 天`;
  elements.sevenDayChange.style.color = change > 0 ? "#f2c14e" : "";
  const top = dashboard.metrics.topLocation;
  elements.topLocation.textContent = top?.location ?? "--";
  elements.topLocationAmount.textContent = top ? `${formatCurrency(top.amount)} 当前范围` : "暂无记录";
  renderBudget(dashboard.metrics.budget);
  renderTrendChart(dashboard.trend);
  renderCategoryChart(dashboard.categoryTotals);
  refreshIcons();
}

function renderPlanSwitcher(plans, selectedPlanCode) {
  elements.planSwitcher.replaceChildren();
  for (const plan of plans) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = `plan-option${plan.planCode === selectedPlanCode ? " selected" : ""}`;
    button.setAttribute("aria-pressed", String(plan.planCode === selectedPlanCode));
    const text = document.createElement("span");
    const name = document.createElement("span");
    name.textContent = plan.name || plan.planCode;
    const code = document.createElement("small");
    code.textContent = plan.planCode;
    text.append(name, code);
    const balance = document.createElement("strong");
    balance.textContent = plan.balance || "--";
    button.append(text, balance);
    button.addEventListener("click", async () => {
      if (state.filters.planCode === plan.planCode) {
        return;
      }
      state.filters.planCode = plan.planCode;
      state.filters.page = 1;
      await loadDashboard();
    });
    elements.planSwitcher.append(button);
  }
}

function renderBudget(budget) {
  if (!budget) {
    elements.budgetMetricButton.textContent = "设置预算";
    elements.budgetProgress.style.width = "0%";
    elements.budgetDetail.textContent = "未设置";
    return;
  }
  elements.budgetMetricButton.textContent = formatCurrency(budget.monthlyAmount);
  elements.budgetProgress.style.width = `${Math.min(budget.percent, 100)}%`;
  elements.budgetDetail.textContent = `${formatCurrency(budget.spent)} 已使用 · ${budget.percent}%`;
}

function chartAnimationDuration() {
  return window.matchMedia("(prefers-reduced-motion: reduce)").matches ? 0 : 320;
}

function renderTrendChart(trend) {
  state.trendChart?.destroy();
  const total = trend.reduce((sum, item) => sum + item.value, 0);
  elements.trendTotal.textContent = formatCurrency(total);
  elements.trendEmpty.classList.toggle("hidden", trend.length > 0);
  elements.trendChart.classList.toggle("hidden", trend.length === 0);
  if (!trend.length || !window.Chart) {
    state.trendChart = null;
    return;
  }
  state.trendChart = new window.Chart(elements.trendChart, {
    type: "line",
    data: {
      labels: trend.map((item) => item.label),
      datasets: [
        {
          data: trend.map((item) => item.value),
          borderColor: "#003262",
          backgroundColor: "rgba(0, 50, 98, 0.08)",
          borderWidth: 2,
          pointRadius: trend.length < 18 ? 3 : 0,
          pointHoverRadius: 4,
          pointBackgroundColor: "#f2c14e",
          fill: true,
          tension: 0.28,
        },
      ],
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      animation: { duration: chartAnimationDuration() },
      interaction: { intersect: false, mode: "index" },
      plugins: {
        legend: { display: false },
        tooltip: {
          displayColors: false,
          callbacks: { label: (context) => formatCurrency(context.parsed.y) },
        },
      },
      scales: {
        x: {
          grid: { display: false },
          border: { display: false },
          ticks: { color: "#7a848b", maxTicksLimit: 7, font: { family: "Geist Mono Variable" } },
        },
        y: {
          beginAtZero: true,
          border: { display: false },
          grid: { color: "rgba(190, 200, 193, 0.42)" },
          ticks: {
            color: "#7a848b",
            callback: (value) => `$${value}`,
            font: { family: "Geist Mono Variable" },
          },
        },
      },
    },
  });
}

function renderCategoryChart(categories) {
  state.categoryChart?.destroy();
  elements.categoryLegend.replaceChildren();
  elements.categoryEmpty.classList.toggle("hidden", categories.length > 0);
  elements.categoryChart.classList.toggle("hidden", categories.length === 0);
  for (const category of categories) {
    const row = document.createElement("div");
    row.className = "category-legend-row";
    const swatch = document.createElement("i");
    swatch.style.backgroundColor = category.color;
    const label = document.createElement("span");
    label.textContent = category.label;
    const value = document.createElement("strong");
    value.textContent = formatCurrency(category.value);
    row.append(swatch, label, value);
    elements.categoryLegend.append(row);
  }
  if (!categories.length || !window.Chart) {
    state.categoryChart = null;
    return;
  }
  state.categoryChart = new window.Chart(elements.categoryChart, {
    type: "bar",
    data: {
      labels: categories.map((category) => category.label),
      datasets: [{
        data: categories.map((category) => category.value),
        backgroundColor: categories.map((category) => category.color),
        borderWidth: 0,
        borderRadius: 3,
        barThickness: 13,
      }],
    },
    options: {
      indexAxis: "y",
      responsive: true,
      maintainAspectRatio: false,
      animation: { duration: chartAnimationDuration() },
      plugins: { legend: { display: false }, tooltip: { displayColors: false } },
      scales: {
        x: { display: false, beginAtZero: true },
        y: {
          border: { display: false },
          grid: { display: false },
          ticks: { color: "#69727a", font: { family: "Geist Variable" } },
        },
      },
    },
  });
}

function transactionQuery({ includePage = true } = {}) {
  const parameters = new URLSearchParams({
    range: state.filters.range,
    planCode: state.filters.planCode,
  });
  if (state.filters.category) {
    parameters.set("category", state.filters.category);
  }
  if (state.filters.query) {
    parameters.set("query", state.filters.query);
  }
  if (includePage) {
    parameters.set("page", String(state.filters.page));
    parameters.set("limit", String(state.filters.limit));
  }
  return parameters;
}

function populateCategoryFilter() {
  const current = state.filters.category;
  elements.categoryFilter.replaceChildren(new Option("全部分类", ""));
  for (const category of state.categories) {
    elements.categoryFilter.append(new Option(category.label, category.id));
  }
  elements.categoryFilter.value = current;
}

async function loadTransactions() {
  if (!state.filters.planCode) {
    renderTransactions({ transactions: [], total: 0, page: 1, totalPages: 1 });
    return;
  }
  elements.transactionsSkeleton.classList.remove("hidden");
  elements.transactionsBody.closest(".transaction-table-wrap").classList.add("hidden");
  elements.transactionList.classList.add("hidden");
  elements.transactionsEmpty.classList.add("hidden");
  try {
    const result = await requestJson(`/api/transactions?${transactionQuery()}`);
    state.transactions = result.transactions;
    state.totalPages = result.totalPages;
    renderTransactions(result);
    populateCategoryFilter();
  } finally {
    elements.transactionsSkeleton.classList.add("hidden");
  }
}

function categorySelect(transaction) {
  const select = document.createElement("select");
  select.className = "category-select";
  select.setAttribute("aria-label", `设置 ${transaction.location || "该交易"} 的分类`);
  for (const category of state.categories) {
    select.append(new Option(category.label, category.id));
  }
  select.value = transaction.category;
  select.addEventListener("change", async () => {
    select.disabled = true;
    try {
      await requestJson("/api/category-rules", {
        method: "PUT",
        body: JSON.stringify({ location: transaction.location, category: select.value }),
      });
      showToast(`已将 ${transaction.location || "该地点"} 归入${select.selectedOptions[0].textContent}`);
      await loadDashboard();
    } catch (error) {
      select.value = transaction.category;
      showToast(error.message, "error");
    } finally {
      select.disabled = false;
    }
  });
  return select;
}

function amountClass(transaction) {
  if (typeof transaction.amountValue !== "number") {
    return "";
  }
  return transaction.amountValue < 0 ? "debit" : "credit";
}

function renderTransactions(result) {
  elements.transactionsBody.replaceChildren();
  elements.transactionList.replaceChildren();
  const hasTransactions = result.transactions.length > 0;
  elements.transactionsBody.closest(".transaction-table-wrap").classList.toggle("hidden", !hasTransactions);
  elements.transactionList.classList.toggle("hidden", !hasTransactions);
  elements.transactionsEmpty.classList.toggle("hidden", hasTransactions);

  for (const transaction of result.transactions) {
    const row = document.createElement("tr");
    const dateCell = document.createElement("td");
    dateCell.textContent = formatTransactionDate(transaction);
    const locationCell = document.createElement("td");
    locationCell.textContent = transaction.location || "--";
    locationCell.title = transaction.location || "";
    const categoryCell = document.createElement("td");
    categoryCell.append(categorySelect(transaction));
    const amountCell = document.createElement("td");
    amountCell.className = amountClass(transaction);
    amountCell.textContent = transaction.amount || "--";
    const balanceCell = document.createElement("td");
    balanceCell.textContent = transaction.balance || "--";
    row.append(dateCell, locationCell, categoryCell, amountCell, balanceCell);
    elements.transactionsBody.append(row);

    const item = document.createElement("article");
    item.className = "transaction-item";
    const main = document.createElement("div");
    main.className = "transaction-item-main";
    const location = document.createElement("strong");
    location.textContent = transaction.location || "未知地点";
    const posted = document.createElement("span");
    posted.textContent = formatTransactionDate(transaction);
    main.append(location, posted);
    const amount = document.createElement("strong");
    amount.className = `transaction-item-amount ${amountClass(transaction)}`;
    amount.textContent = transaction.amount || "--";
    const select = categorySelect(transaction);
    const balance = document.createElement("span");
    balance.className = "transaction-item-balance";
    balance.textContent = `余额 ${transaction.balance || "--"}`;
    item.append(main, amount, select, balance);
    elements.transactionList.append(item);
  }

  elements.paginationText.textContent = `${result.total} 条记录 · 第 ${result.page}/${result.totalPages} 页`;
  elements.previousPageButton.disabled = result.page <= 1;
  elements.nextPageButton.disabled = result.page >= result.totalPages;
  refreshIcons();
}

async function runSync({ silent = false } = {}) {
  setButtonBusy(elements.syncButton, true);
  elements.syncButton.classList.add("spinning");
  try {
    const result = await requestJson("/api/sync", { method: "POST", body: "{}" });
    if (!silent) {
      showToast(`同步完成，新增 ${result.insertedCount} 条记录`);
    }
    await loadDashboard();
    return result;
  } catch (error) {
    if (error.payload?.needsBinding) {
      state.syncState = { ok: false, errorCode: "NEEDS_BINDING" };
      state.hasBoundStorageState = true;
      updateConnectionUi();
      if (!state.dashboard?.ready) {
        showConnectView();
      }
      if (!silent) {
        showToast("CalNet 登录态已过期，请重新连接", "error");
      }
    }
    throw error;
  } finally {
    setButtonBusy(elements.syncButton, false);
    elements.syncButton.classList.remove("spinning");
  }
}

async function generateFallbackCommand() {
  setButtonBusy(elements.generateFallbackButton, true);
  try {
    const result = await requestJson("/api/bind-token", { method: "POST", body: "{}" });
    elements.fallbackCommand.textContent = result.bindCommand;
    elements.fallbackBox.classList.remove("hidden");
    refreshIcons();
  } catch (error) {
    showToast(error.message, "error");
  } finally {
    setButtonBusy(elements.generateFallbackButton, false);
  }
}

function disconnectRemoteDesktop() {
  if (state.rfb) {
    state.rfb.disconnect();
    state.rfb = null;
  }
  elements.remoteDesktop.replaceChildren();
}

function clearRemoteTimers() {
  clearInterval(state.remotePollTimer);
  clearInterval(state.countdownTimer);
  state.remotePollTimer = null;
  state.countdownTimer = null;
}

function updateRemoteCountdown() {
  if (!state.remoteSession?.expiresAt) {
    elements.remoteCountdown.textContent = "15:00";
    return;
  }
  const remaining = Math.max(Date.parse(state.remoteSession.expiresAt) - Date.now(), 0);
  const minutes = Math.floor(remaining / 60_000);
  const seconds = Math.floor((remaining % 60_000) / 1_000);
  elements.remoteCountdown.textContent = `${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`;
}

function connectRemoteDesktop(streamPath) {
  if (state.rfb) {
    return;
  }
  elements.remoteDesktop.replaceChildren();
  const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
  const webSocketUrl = `${protocol}//${window.location.host}${streamPath}`;
  const rfb = new RFB(elements.remoteDesktop, webSocketUrl, { shared: true });
  rfb.scaleViewport = true;
  rfb.clipViewport = false;
  rfb.resizeSession = false;
  rfb.focusOnClick = true;
  rfb.qualityLevel = 6;
  rfb.compressionLevel = 2;
  rfb.addEventListener("connect", () => {
    elements.remoteStageStatus.classList.add("hidden");
    elements.remoteStatusText.textContent = "请完成 CalNet 和 Duo Push";
    rfb.focus();
  });
  rfb.addEventListener("disconnect", (event) => {
    state.rfb = null;
    if (!event.detail.clean && !["bound", "cancelled", "expired"].includes(state.remoteSession?.status)) {
      elements.remoteStageStatus.classList.remove("hidden");
      elements.remoteStageStatus.lastElementChild.textContent = "远程画面连接中断";
    }
  });
  rfb.addEventListener("securityfailure", () => {
    showToast("远程画面安全协商失败", "error");
  });
  state.rfb = rfb;
}

async function startRemoteLogin() {
  if (!state.webLoginEnabled) {
    showToast("网页登录尚未在服务器启用", "error");
    return;
  }
  setButtonBusy(elements.startRemoteLoginButton, true);
  clearRemoteTimers();
  disconnectRemoteDesktop();
  elements.remoteStageStatus.classList.remove("hidden");
  elements.remoteStageStatus.lastElementChild.textContent = "正在准备远程浏览器";
  elements.retryRemoteButton.classList.add("hidden");
  try {
    const result = await requestJson("/api/calnet-login-sessions", { method: "POST", body: "{}" });
    state.remoteSession = result.session;
    showAuthenticatedView("remote");
    elements.remoteStatusText.textContent = result.session.message;
    updateRemoteCountdown();
    state.countdownTimer = setInterval(updateRemoteCountdown, 1_000);
    await pollRemoteSession();
    state.remotePollTimer = setInterval(() => pollRemoteSession().catch(() => {}), 1_000);
  } catch (error) {
    if (error.payload?.session) {
      state.remoteSession = error.payload.session;
      showAuthenticatedView("remote");
      await pollRemoteSession();
    } else {
      showToast(error.message, "error");
    }
  } finally {
    setButtonBusy(elements.startRemoteLoginButton, false);
  }
}

async function pollRemoteSession() {
  if (!state.remoteSession?.sessionId) {
    return;
  }
  const result = await requestJson(
    `/api/calnet-login-sessions/${encodeURIComponent(state.remoteSession.sessionId)}`,
  );
  state.remoteSession = { ...state.remoteSession, ...result.session };
  elements.remoteStatusText.textContent = result.session.message;
  updateRemoteCountdown();
  if (result.session.streamReady && state.remoteSession.streamPath) {
    connectRemoteDesktop(state.remoteSession.streamPath);
  }
  if (result.session.status === "bound") {
    clearRemoteTimers();
    disconnectRemoteDesktop();
    showToast("CalNet 已连接，数据同步完成");
    await refreshAuthState();
    return;
  }
  if (["failed", "expired", "cancelled"].includes(result.session.status)) {
    clearRemoteTimers();
    disconnectRemoteDesktop();
    elements.remoteStageStatus.classList.remove("hidden");
    elements.remoteStageStatus.lastElementChild.textContent = result.session.message;
    elements.retryRemoteButton.classList.toggle("hidden", result.session.status === "cancelled");
  }
}

async function cancelRemoteLogin() {
  const sessionId = state.remoteSession?.sessionId;
  clearRemoteTimers();
  disconnectRemoteDesktop();
  if (sessionId) {
    try {
      await requestJson(`/api/calnet-login-sessions/${encodeURIComponent(sessionId)}`, {
        method: "DELETE",
        body: "{}",
      });
    } catch {
      // 会话已经结束时直接返回钱包即可。
    }
  }
  state.remoteSession = null;
  if (state.dashboard?.ready) {
    showAuthenticatedView("dashboard");
  } else {
    showConnectView();
  }
}

function openSettings() {
  updateConnectionUi();
  elements.settingsDialog.showModal();
  refreshIcons();
}

function openBudgetDialog() {
  const plan = currentSelectedPlan();
  if (!plan) {
    showToast("请先选择余额类型", "error");
    return;
  }
  if (!plan.isCurrency) {
    showToast("该余额类型不支持金额预算", "error");
    return;
  }
  const budget = state.dashboard?.metrics?.budget;
  elements.budgetPlanName.textContent = plan.name || plan.planCode;
  elements.budgetInput.value = budget?.monthlyAmount ?? "";
  elements.removeBudgetButton.classList.toggle("hidden", !budget);
  elements.budgetDialog.showModal();
  window.setTimeout(() => elements.budgetInput.focus(), 0);
}

async function saveBudget(monthlyAmount) {
  const plan = currentSelectedPlan();
  if (!plan) {
    return;
  }
  await requestJson(`/api/budgets/${encodeURIComponent(plan.planCode)}`, {
    method: "PUT",
    body: JSON.stringify({ monthlyAmount }),
  });
  elements.budgetDialog.close();
  showToast(monthlyAmount === null ? "预算已移除" : "预算已保存");
  await loadDashboard();
}

async function logout() {
  await requestJson("/api/auth/logout", { method: "POST", body: "{}" });
  state.dashboard = null;
  state.transactions = [];
  showLogin();
  setLoginStatus("已退出控制台", "success");
}

function bindEvents() {
  elements.loginForm.addEventListener("submit", async (event) => {
    event.preventDefault();
    const password = elements.passwordInput.value;
    if (!password) {
      setLoginStatus("请输入控制台密码", "error");
      elements.passwordInput.focus();
      return;
    }
    try {
      await login(password);
    } catch (error) {
      if (state.authenticated) {
        showErrorView(error);
      } else {
        setLoginStatus(error.message, "error");
      }
    }
  });

  elements.togglePasswordButton.addEventListener("click", () => {
    const showing = elements.passwordInput.type === "text";
    elements.passwordInput.type = showing ? "password" : "text";
    elements.togglePasswordButton.setAttribute("aria-label", showing ? "显示密码" : "隐藏密码");
    elements.togglePasswordButton.title = showing ? "显示密码" : "隐藏密码";
    elements.togglePasswordButton.replaceChildren();
    const icon = document.createElement("i");
    icon.dataset.lucide = showing ? "eye" : "eye-off";
    elements.togglePasswordButton.append(icon);
    refreshIcons();
  });

  elements.syncButton.addEventListener("click", () => runSync().catch((error) => {
    if (!error.payload?.needsBinding) showToast(error.message, "error");
  }));
  elements.settingsButton.addEventListener("click", openSettings);
  elements.brandHomeButton.addEventListener("click", () => {
    if (state.dashboard?.ready) showAuthenticatedView("dashboard");
    else showConnectView();
  });
  elements.bannerConnectButton.addEventListener("click", startRemoteLogin);
  elements.startRemoteLoginButton.addEventListener("click", startRemoteLogin);
  elements.generateFallbackButton.addEventListener("click", generateFallbackCommand);
  elements.copyFallbackButton.addEventListener("click", async () => {
    try {
      await navigator.clipboard.writeText(elements.fallbackCommand.textContent);
      showToast("绑定命令已复制");
    } catch {
      showToast("浏览器未允许复制，请手动选择命令", "error");
    }
  });
  elements.focusRemoteButton.addEventListener("click", () => state.rfb?.focus());
  elements.cancelRemoteButton.addEventListener("click", cancelRemoteLogin);
  elements.retryRemoteButton.addEventListener("click", startRemoteLogin);
  elements.retryAppButton.addEventListener("click", () => {
    setButtonBusy(elements.retryAppButton, true);
    refreshAuthState()
      .catch(showErrorView)
      .finally(() => setButtonBusy(elements.retryAppButton, false));
  });

  elements.rangeControl.addEventListener("click", async (event) => {
    const button = event.target.closest("button[data-range]");
    if (!button || button.dataset.range === state.filters.range) return;
    state.filters.range = button.dataset.range;
    state.filters.page = 1;
    for (const candidate of elements.rangeControl.querySelectorAll("button")) {
      candidate.classList.toggle("selected", candidate === button);
    }
    await loadDashboard();
  });
  elements.transactionSearch.addEventListener("input", () => {
    clearTimeout(state.searchTimer);
    state.searchTimer = setTimeout(async () => {
      state.filters.query = elements.transactionSearch.value.trim();
      state.filters.page = 1;
      await loadTransactions();
    }, 280);
  });
  elements.categoryFilter.addEventListener("change", async () => {
    state.filters.category = elements.categoryFilter.value;
    state.filters.page = 1;
    await loadTransactions();
  });
  elements.previousPageButton.addEventListener("click", async () => {
    if (state.filters.page > 1) {
      state.filters.page -= 1;
      await loadTransactions();
    }
  });
  elements.nextPageButton.addEventListener("click", async () => {
    if (state.filters.page < state.totalPages) {
      state.filters.page += 1;
      await loadTransactions();
    }
  });
  elements.exportButton.addEventListener("click", () => {
    const link = document.createElement("a");
    link.href = `/api/export.csv?${transactionQuery({ includePage: false })}`;
    link.download = "cal1card-transactions.csv";
    document.body.append(link);
    link.click();
    link.remove();
  });

  elements.budgetMetricButton.addEventListener("click", openBudgetDialog);
  elements.openBudgetButton.addEventListener("click", openBudgetDialog);
  elements.budgetForm.addEventListener("submit", async (event) => {
    event.preventDefault();
    const amount = Number(elements.budgetInput.value);
    if (!Number.isFinite(amount) || amount <= 0) {
      showToast("请输入有效的预算金额", "error");
      return;
    }
    try {
      await saveBudget(amount);
    } catch (error) {
      showToast(error.message, "error");
    }
  });
  elements.removeBudgetButton.addEventListener("click", () => saveBudget(null).catch((error) => showToast(error.message, "error")));

  elements.settingsConnectButton.addEventListener("click", () => {
    elements.settingsDialog.close();
    startRemoteLogin();
  });
  elements.settingsSyncButton.addEventListener("click", () => runSync().catch((error) => {
    if (!error.payload?.needsBinding) showToast(error.message, "error");
  }));
  elements.unbindButton.addEventListener("click", () => elements.unbindDialog.showModal());
  elements.clearDataButton.addEventListener("click", () => {
    elements.clearDataPassword.value = "";
    elements.clearDataDialog.showModal();
  });
  elements.logoutButton.addEventListener("click", () => logout().catch((error) => showToast(error.message, "error")));

  elements.unbindForm.addEventListener("submit", async (event) => {
    event.preventDefault();
    try {
      await requestJson("/api/bind-storage-state", { method: "DELETE", body: "{}" });
      state.hasBoundStorageState = false;
      state.syncState = { ok: false, errorCode: "NEEDS_BINDING" };
      elements.unbindDialog.close();
      elements.settingsDialog.close();
      updateConnectionUi();
      showToast("CalNet 连接已解除");
      if (!state.dashboard?.ready) showConnectView();
    } catch (error) {
      showToast(error.message, "error");
    }
  });

  elements.clearDataForm.addEventListener("submit", async (event) => {
    event.preventDefault();
    try {
      await requestJson("/api/data", {
        method: "DELETE",
        body: JSON.stringify({ password: elements.clearDataPassword.value }),
      });
      elements.clearDataDialog.close();
      elements.settingsDialog.close();
      state.dashboard = null;
      showToast("历史数据已清空");
      showConnectView();
    } catch (error) {
      showToast(error.message, "error");
    }
  });

  for (const button of document.querySelectorAll("[data-dialog-close]")) {
    button.addEventListener("click", () => button.closest("dialog")?.close());
  }
}

bindEvents();
refreshIcons();
refreshAuthState().catch(showErrorView);
