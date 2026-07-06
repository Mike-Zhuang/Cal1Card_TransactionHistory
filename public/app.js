const loginPanel = document.querySelector("#loginPanel");
const dashboardPanel = document.querySelector("#dashboardPanel");
const loginForm = document.querySelector("#loginForm");
const passwordInput = document.querySelector("#passwordInput");
const loginStatusText = document.querySelector("#loginStatusText");
const statusText = document.querySelector("#statusText");
const bindingStatusText = document.querySelector("#bindingStatusText");
const bindCommandBox = document.querySelector("#bindCommandBox");
const bindCommandText = document.querySelector("#bindCommandText");
const asOfText = document.querySelector("#asOfText");
const accountText = document.querySelector("#accountText");
const planCountText = document.querySelector("#planCountText");
const fetchTimeText = document.querySelector("#fetchTimeText");
const plansList = document.querySelector("#plansList");
const transactionsBody = document.querySelector("#transactionsBody");
const selectedPlanText = document.querySelector("#selectedPlanText");
const createBindTokenButton = document.querySelector("#createBindTokenButton");
const refreshBalanceButton = document.querySelector("#refreshBalanceButton");
const unbindButton = document.querySelector("#unbindButton");
const logoutButton = document.querySelector("#logoutButton");

let currentPlans = [];

function setStatus(message, type = "neutral") {
  statusText.textContent = message;
  statusText.dataset.type = type;
}

function setLoginStatus(message, type = "neutral") {
  loginStatusText.textContent = message;
  loginStatusText.dataset.type = type;
}

function setBusy(isBusy) {
  createBindTokenButton.disabled = isBusy;
  refreshBalanceButton.disabled = isBusy;
  unbindButton.disabled = isBusy;
  logoutButton.disabled = isBusy;
}

function showDashboard(isAuthenticated) {
  loginPanel.classList.toggle("hidden", isAuthenticated);
  dashboardPanel.classList.toggle("hidden", !isAuthenticated);
}

function formatDateTime(value) {
  if (!value) {
    return "--";
  }

  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return value;
  }

  return new Intl.DateTimeFormat("zh-CN", {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  }).format(date);
}

async function requestJson(url, options = {}) {
  const response = await fetch(url, {
    headers: {
      "Content-Type": "application/json",
      ...(options.headers ?? {}),
    },
    ...options,
  });

  const payload = await response.json();
  if (!response.ok) {
    const error = new Error(payload.reason || payload.error || "请求失败");
    error.payload = payload;
    throw error;
  }

  return payload;
}

function updateBindingStatus(hasBoundStorageState) {
  bindingStatusText.textContent = hasBoundStorageState ? "已绑定 Cal1Card 登录态" : "尚未绑定";
  bindingStatusText.dataset.type = hasBoundStorageState ? "success" : "warning";
}

function clearTransactions(message = "暂无数据") {
  transactionsBody.innerHTML = "";
  const row = document.createElement("tr");
  const cell = document.createElement("td");
  cell.colSpan = 4;
  cell.className = "empty-cell";
  cell.textContent = message;
  row.append(cell);
  transactionsBody.append(row);
}

function resetDashboardData() {
  asOfText.textContent = "--";
  accountText.textContent = "--";
  planCountText.textContent = "0";
  fetchTimeText.textContent = "--";
  selectedPlanText.textContent = "未选择";
  plansList.innerHTML = '<div class="empty-state">暂无数据</div>';
  clearTransactions();
}

function renderPlans(plans) {
  currentPlans = plans;
  plansList.innerHTML = "";
  planCountText.textContent = String(plans.length);

  if (!plans.length) {
    plansList.innerHTML = '<div class="empty-state">暂无余额项</div>';
    return;
  }

  for (const plan of plans) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "plan-row";
    button.dataset.planCode = plan.planCode;

    const name = document.createElement("span");
    name.className = "plan-name";
    name.textContent = plan.name || plan.planCode;

    const meta = document.createElement("span");
    meta.className = "plan-meta";
    meta.textContent = plan.planCode;

    const balance = document.createElement("strong");
    balance.className = "plan-balance";
    balance.textContent = plan.balance || "--";

    const textGroup = document.createElement("span");
    textGroup.className = "plan-text";
    textGroup.append(name, meta);

    button.append(textGroup, balance);
    button.addEventListener("click", () => {
      loadTransactions(plan.planCode);
    });

    plansList.append(button);
  }
}

function renderBalance(snapshot) {
  const accountParts = [snapshot.accountName, snapshot.accountNumberMasked].filter(Boolean);
  asOfText.textContent = snapshot.asOf || "--";
  accountText.textContent = accountParts.join(" · ") || "--";
  fetchTimeText.textContent = formatDateTime(snapshot.fetchedAt);
  renderPlans(snapshot.plans ?? []);

  if (snapshot.plans?.length) {
    loadTransactions(snapshot.plans[0].planCode);
  } else {
    selectedPlanText.textContent = "未选择";
    clearTransactions();
  }
}

function renderTransactions(result) {
  transactionsBody.innerHTML = "";

  if (!result.transactions?.length) {
    clearTransactions("没有记录");
    return;
  }

  for (const transaction of result.transactions) {
    const row = document.createElement("tr");
    for (const value of [
      transaction.posted,
      transaction.amount,
      transaction.balance,
      transaction.location,
    ]) {
      const cell = document.createElement("td");
      cell.textContent = value || "--";
      row.append(cell);
    }
    transactionsBody.append(row);
  }
}

function markSelectedPlan(planCode) {
  const plan = currentPlans.find((item) => item.planCode === planCode);
  selectedPlanText.textContent = plan ? `${plan.name || plan.planCode} · ${planCode}` : planCode;

  for (const button of plansList.querySelectorAll(".plan-row")) {
    button.classList.toggle("selected", button.dataset.planCode === planCode);
  }
}

async function refreshAuthState() {
  const state = await requestJson("/api/auth/me");
  showDashboard(state.authenticated);
  updateBindingStatus(state.hasBoundStorageState);
  return state;
}

async function login(password) {
  setLoginStatus("正在登录", "neutral");
  const state = await requestJson("/api/auth/login", {
    method: "POST",
    body: JSON.stringify({ password }),
  });
  showDashboard(true);
  updateBindingStatus(state.hasBoundStorageState);
  setStatus("已登录控制台", "success");
  setLoginStatus("登录成功", "success");
}

async function createBindToken() {
  setBusy(true);
  setStatus("正在生成绑定码", "neutral");

  try {
    const result = await requestJson("/api/bind-token", { method: "POST" });
    bindCommandText.textContent = result.bindCommand;
    bindCommandBox.classList.remove("hidden");
    setStatus("绑定码已生成，复制命令到本机终端运行", "success");
  } catch (error) {
    if (error.payload?.needsAppLogin) {
      showDashboard(false);
    }
    setStatus(error.message, "error");
  } finally {
    setBusy(false);
  }
}

async function refreshBalance() {
  setBusy(true);
  setStatus("正在刷新余额", "neutral");

  try {
    const snapshot = await requestJson("/api/balance", { method: "POST" });
    renderBalance(snapshot);
    updateBindingStatus(true);
    setStatus("余额已刷新", "success");
  } catch (error) {
    if (error.payload?.needsBinding) {
      updateBindingStatus(false);
      setStatus("需要重新绑定 Cal1Card 登录态", "warning");
    } else if (error.payload?.needsAppLogin) {
      showDashboard(false);
      setLoginStatus("登录已过期，请重新登录", "warning");
    } else {
      setStatus(error.message, "error");
    }
  } finally {
    setBusy(false);
  }
}

async function loadTransactions(planCode) {
  if (!planCode) {
    return;
  }

  markSelectedPlan(planCode);
  clearTransactions("正在加载");
  setStatus("正在拉取消费记录", "neutral");

  try {
    const result = await requestJson(`/api/transactions/${encodeURIComponent(planCode)}`);
    renderTransactions(result);
    setStatus("消费记录已刷新", "success");
  } catch (error) {
    if (error.payload?.needsBinding) {
      updateBindingStatus(false);
      setStatus("需要重新绑定 Cal1Card 登录态", "warning");
    } else if (error.payload?.needsAppLogin) {
      showDashboard(false);
      setLoginStatus("登录已过期，请重新登录", "warning");
    } else {
      setStatus(error.message, "error");
    }
    clearTransactions("加载失败");
  }
}

async function unbind() {
  if (!window.confirm("确定解绑当前 Cal1Card 登录态吗？")) {
    return;
  }

  setBusy(true);
  setStatus("正在解绑", "neutral");

  try {
    const result = await requestJson("/api/bind-storage-state", { method: "DELETE" });
    updateBindingStatus(result.hasBoundStorageState);
    resetDashboardData();
    bindCommandBox.classList.add("hidden");
    setStatus("已解绑", "success");
  } catch (error) {
    setStatus(error.message, "error");
  } finally {
    setBusy(false);
  }
}

async function logout() {
  await requestJson("/api/auth/logout", { method: "POST" });
  showDashboard(false);
  resetDashboardData();
  passwordInput.value = "";
  setLoginStatus("已退出", "success");
}

loginForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  try {
    await login(passwordInput.value);
  } catch (error) {
    setLoginStatus(error.message, "error");
  }
});

createBindTokenButton.addEventListener("click", createBindToken);
refreshBalanceButton.addEventListener("click", refreshBalance);
unbindButton.addEventListener("click", unbind);
logoutButton.addEventListener("click", logout);

refreshAuthState()
  .then((state) => {
    if (state.authenticated) {
      setStatus("就绪", "success");
    } else {
      setLoginStatus("请登录控制台", "neutral");
    }
  })
  .catch(() => {
    setLoginStatus("无法连接服务器", "error");
  });
