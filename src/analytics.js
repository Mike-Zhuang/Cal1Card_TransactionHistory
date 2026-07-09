const VALID_RANGES = new Set(["7d", "30d", "90d", "all"]);
const VALID_CATEGORIES = new Set([
  "uncategorized",
  "dining",
  "printing",
  "laundry",
  "retail",
  "transit",
  "other",
]);

export const CATEGORY_OPTIONS = [
  { id: "uncategorized", label: "未分类", color: "#8b9098" },
  { id: "dining", label: "餐饮", color: "#1f6f78" },
  { id: "printing", label: "打印", color: "#4f6fae" },
  { id: "laundry", label: "洗衣", color: "#d28d3f" },
  { id: "retail", label: "零售", color: "#bd5f5a" },
  { id: "transit", label: "交通", color: "#677d4d" },
  { id: "other", label: "其他", color: "#746087" },
];

function getRangeStart(range, now) {
  if (range === "all") {
    return null;
  }
  const days = Number.parseInt(range, 10);
  return new Date(now.getTime() - days * 24 * 60 * 60 * 1000);
}

function formatCampusDate(date, options) {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/Los_Angeles",
    ...options,
  }).format(date);
}

function campusDayKey(date) {
  return formatCampusDate(date, { year: "numeric", month: "2-digit", day: "2-digit" });
}

function campusMonthKey(date) {
  return formatCampusDate(date, { year: "numeric", month: "2-digit" });
}

function isSpend(transaction) {
  return typeof transaction.amountValue === "number" && transaction.amountValue < 0;
}

function spendValue(transaction) {
  return isSpend(transaction) ? Math.abs(transaction.amountValue) : 0;
}

function sumSpend(transactions) {
  return transactions.reduce((total, transaction) => total + spendValue(transaction), 0);
}

export function validateCategory(category) {
  return VALID_CATEGORIES.has(category);
}

export function filterTransactions(transactions, filters = {}, now = new Date()) {
  const range = VALID_RANGES.has(filters.range) ? filters.range : "30d";
  const rangeStart = getRangeStart(range, now);
  const query = String(filters.query ?? "").trim().toLocaleLowerCase("zh-CN");
  return transactions.filter((transaction) => {
    if (filters.planCode && transaction.planCode !== filters.planCode) {
      return false;
    }
    if (filters.category && transaction.category !== filters.category) {
      return false;
    }
    if (query && !String(transaction.location).toLocaleLowerCase("zh-CN").includes(query)) {
      return false;
    }
    if (rangeStart) {
      const postedAt = Date.parse(transaction.postedAt ?? "");
      if (!Number.isFinite(postedAt) || postedAt < rangeStart.getTime()) {
        return false;
      }
    }
    return true;
  });
}

function buildTrend(transactions, range) {
  const dated = transactions.filter((transaction) => transaction.postedAt && isSpend(transaction));
  const useMonths = range === "all" && dated.length > 180;
  const totals = new Map();
  for (const transaction of dated) {
    const date = new Date(transaction.postedAt);
    const key = useMonths ? campusMonthKey(date) : campusDayKey(date);
    totals.set(key, (totals.get(key) ?? 0) + spendValue(transaction));
  }
  return [...totals.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([label, value]) => ({ label, value: Number(value.toFixed(2)) }));
}

function buildCategoryTotals(transactions) {
  const totals = new Map();
  for (const transaction of transactions) {
    if (!isSpend(transaction)) {
      continue;
    }
    totals.set(transaction.category, (totals.get(transaction.category) ?? 0) + spendValue(transaction));
  }
  return CATEGORY_OPTIONS.map((category) => ({
    ...category,
    value: Number((totals.get(category.id) ?? 0).toFixed(2)),
  })).filter((category) => category.value > 0);
}

function getTopLocation(transactions) {
  const totals = new Map();
  for (const transaction of transactions) {
    if (!isSpend(transaction) || !transaction.location) {
      continue;
    }
    totals.set(transaction.location, (totals.get(transaction.location) ?? 0) + spendValue(transaction));
  }
  const [entry] = [...totals.entries()].sort((left, right) => right[1] - left[1]);
  return entry ? { location: entry[0], amount: Number(entry[1].toFixed(2)) } : null;
}

export function buildDashboard({ snapshot, transactions, budgets, range = "30d", planCode, now }) {
  const effectiveNow = now ?? new Date();
  const normalizedRange = VALID_RANGES.has(range) ? range : "30d";
  const plans = snapshot?.plans ?? [];
  const selectedPlanCode = planCode && plans.some((plan) => plan.planCode === planCode)
    ? planCode
    : plans[0]?.planCode ?? "";
  const selectedPlan = plans.find((plan) => plan.planCode === selectedPlanCode) ?? null;
  const selectedTransactions = filterTransactions(
    transactions,
    { range: normalizedRange, planCode: selectedPlanCode },
    effectiveNow,
  );

  const monthKey = campusMonthKey(effectiveNow);
  const monthTransactions = transactions.filter(
    (transaction) =>
      transaction.planCode === selectedPlanCode &&
      transaction.postedAt &&
      campusMonthKey(new Date(transaction.postedAt)) === monthKey,
  );
  const sevenDaysAgo = new Date(effectiveNow.getTime() - 7 * 24 * 60 * 60 * 1000);
  const fourteenDaysAgo = new Date(effectiveNow.getTime() - 14 * 24 * 60 * 60 * 1000);
  const recent = transactions.filter((transaction) => {
    const timestamp = Date.parse(transaction.postedAt ?? "");
    return transaction.planCode === selectedPlanCode && timestamp >= sevenDaysAgo.getTime();
  });
  const previous = transactions.filter((transaction) => {
    const timestamp = Date.parse(transaction.postedAt ?? "");
    return (
      transaction.planCode === selectedPlanCode &&
      timestamp >= fourteenDaysAgo.getTime() &&
      timestamp < sevenDaysAgo.getTime()
    );
  });
  const recentSpend = sumSpend(recent);
  const previousSpend = sumSpend(previous);
  const budget = budgets.get(selectedPlanCode) ?? null;
  const monthSpend = sumSpend(monthTransactions);

  return {
    accountName: snapshot?.accountName ?? "",
    accountNumberMasked: snapshot?.accountNumberMasked ?? "",
    asOf: snapshot?.asOf ?? "",
    fetchedAt: snapshot?.fetchedAt ?? null,
    plans,
    selectedPlan,
    range: normalizedRange,
    metrics: {
      monthSpend: Number(monthSpend.toFixed(2)),
      sevenDaySpend: Number(recentSpend.toFixed(2)),
      sevenDayChangePercent:
        previousSpend > 0
          ? Number((((recentSpend - previousSpend) / previousSpend) * 100).toFixed(1))
          : null,
      transactionCount: selectedTransactions.length,
      topLocation: getTopLocation(selectedTransactions),
      budget: budget
        ? {
            ...budget,
            spent: Number(monthSpend.toFixed(2)),
            percent:
              budget.monthlyAmount > 0
                ? Number(Math.min((monthSpend / budget.monthlyAmount) * 100, 999).toFixed(1))
                : 0,
          }
        : null,
    },
    trend: buildTrend(selectedTransactions, normalizedRange),
    categoryTotals: buildCategoryTotals(selectedTransactions),
  };
}

function escapeCsvValue(value) {
  let text = String(value ?? "");
  if (/^[=+\-@]/.test(text)) {
    text = `'${text}`;
  }
  return `"${text.replace(/"/g, '""')}"`;
}

export function buildTransactionsCsv(transactions) {
  const rows = [
    ["Posted", "Amount", "Balance", "Location", "Plan", "Category"],
    ...transactions.map((transaction) => [
      transaction.posted,
      transaction.amount,
      transaction.balance,
      transaction.location,
      transaction.planName,
      transaction.category,
    ]),
  ];
  return `\ufeff${rows.map((row) => row.map(escapeCsvValue).join(",")).join("\r\n")}\r\n`;
}
