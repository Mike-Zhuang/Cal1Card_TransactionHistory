import { load } from "cheerio";

export const PLAN_CODE_PATTERN = /^[A-Za-z0-9_-]{1,32}$/;
const CAMPUS_TIME_ZONE = "America/Los_Angeles";

export function normalizeWhitespace(value) {
  return String(value ?? "").replace(/\s+/g, " ").trim();
}

export function maskAccountNumber(value) {
  const text = normalizeWhitespace(value);
  if (!text) {
    return "";
  }

  return `${"*".repeat(Math.max(text.length - 4, 0))}${text.slice(-4)}`;
}

export function parseNumericValue(value) {
  let text = normalizeWhitespace(value).replace(/,/g, "").replace(/\u2212/g, "-");
  if (!text) {
    return null;
  }

  const isParenthesized = /^\(.*\)$/.test(text);
  const isNegative = isParenthesized || text.includes("-");
  text = text.replace(/[()$\u00a3\u20ac+\-]/g, "").trim();
  if (!/^\d+(?:\.\d+)?$/.test(text)) {
    return null;
  }

  const parsed = Number.parseFloat(text);
  return Number.isFinite(parsed) ? (isNegative ? -parsed : parsed) : null;
}

function getTimeZoneOffsetMilliseconds(date, timeZone) {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  }).formatToParts(date);
  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  const representedAsUtc = Date.UTC(
    Number(values.year),
    Number(values.month) - 1,
    Number(values.day),
    Number(values.hour),
    Number(values.minute),
    Number(values.second),
  );
  return representedAsUtc - date.getTime();
}

function campusDateToIso({ year, month, day, hour, minute, second }) {
  const initial = Date.UTC(year, month - 1, day, hour, minute, second);
  let candidate = initial - getTimeZoneOffsetMilliseconds(new Date(initial), CAMPUS_TIME_ZONE);
  candidate = initial - getTimeZoneOffsetMilliseconds(new Date(candidate), CAMPUS_TIME_ZONE);
  return new Date(candidate).toISOString();
}

export function parseDisplayedDateTime(value) {
  const text = normalizeWhitespace(value);
  const match = text.match(
    /^(\d{1,2})\/(\d{1,2})\/(\d{2,4})(?:\s+(\d{1,2}):(\d{2})(?::(\d{2}))?\s*([AP]M))?/i,
  );
  if (!match) {
    return null;
  }

  let year = Number(match[3]);
  if (year < 100) {
    year += year >= 70 ? 1900 : 2000;
  }
  let hour = Number(match[4] ?? 0);
  const hasTime = match[4] !== undefined;
  const month = Number(match[1]);
  const day = Number(match[2]);
  const minute = Number(match[5] ?? 0);
  const second = Number(match[6] ?? 0);
  const meridiem = String(match[7] ?? "").toUpperCase();
  const maximumDay = new Date(Date.UTC(year, month, 0)).getUTCDate();
  if (
    month < 1 ||
    month > 12 ||
    day < 1 ||
    day > maximumDay ||
    (hasTime && (hour < 1 || hour > 12)) ||
    minute < 0 ||
    minute > 59 ||
    second < 0 ||
    second > 59
  ) {
    return null;
  }
  if (meridiem === "PM" && hour < 12) {
    hour += 12;
  } else if (meridiem === "AM" && hour === 12) {
    hour = 0;
  }

  try {
    return campusDateToIso({
      year,
      month,
      day,
      hour,
      minute,
      second,
    });
  } catch {
    return null;
  }
}

export function parseBalanceHtml(html, currentUrl) {
  const $ = load(html);
  const getText = (selector) => normalizeWhitespace($(selector).text());
  const plans = [];
  const seenPlanCodes = new Set();

  $('a[href*="ViewTransactions"]').each((index, element) => {
    const link = $(element);
    const href = link.attr("href") ?? "";
    const absoluteUrl = new URL(href, currentUrl);
    const planCode = absoluteUrl.searchParams.get("pln") ?? "";
    if (!PLAN_CODE_PATTERN.test(planCode) || seenPlanCodes.has(planCode)) {
      return;
    }

    seenPlanCodes.add(planCode);
    const rowText = normalizeWhitespace(link.closest("tr").text());
    const cleanedText = normalizeWhitespace(rowText.replace(/View Transaction Details/gi, ""));
    const balanceMatch = cleanedText.match(/^(.*?)\s*Balance:\s*([-$\d,]+(?:\.\d{2})?)/i);
    const balance = normalizeWhitespace(balanceMatch?.[2]);
    const hasCurrencyPrecision = /^-?[\d,]+\.\d{2}$/.test(balance);
    plans.push({
      planCode,
      name: normalizeWhitespace(balanceMatch?.[1]) || planCode,
      balance,
      balanceValue: parseNumericValue(balance),
      isCurrency: /[$\u00a3\u20ac]/.test(balance) || hasCurrencyPrecision,
      detailsPath: `${absoluteUrl.pathname}${absoluteUrl.search}`,
    });
  });

  return {
    accountName: getText("#MainContent_lbAccountName"),
    accountNumber: getText("#MainContent_lbAccountNumber"),
    asOf: getText("#MainContent_lbBalanceAsOf"),
    plans,
  };
}

export function parseTransactionsHtml(html, planCode) {
  const $ = load(html);
  const asOf = normalizeWhitespace($("#MainContent_lbBalanceAsOf").text());
  const table = $("table")
    .filter((index, element) => $(element).attr("id") === `MainContent_gv${planCode}`)
    .first();

  if (!table.length) {
    return { asOf, headers: [], transactions: [] };
  }

  const rows = table.find("tr").toArray();
  const headers = $(rows[0])
    .find("th,td")
    .toArray()
    .map((cell) => normalizeWhitespace($(cell).text()));
  let transactions = rows
    .slice(1)
    .map((row) =>
      $(row)
        .find("td")
        .toArray()
        .map((cell) => normalizeWhitespace($(cell).text())),
    )
    .filter((cells) => cells.length > 0)
    .map((cells) => ({
      posted: cells[0] ?? "",
      postedAt: parseDisplayedDateTime(cells[0] ?? ""),
      amount: cells[1] ?? "",
      amountValue: parseNumericValue(cells[1] ?? ""),
      balance: cells[2] ?? "",
      balanceValue: parseNumericValue(cells[2] ?? ""),
      location: cells[3] ?? "",
    }));

  const usesDebitPositiveAmounts = headers.some((header) => /^New Balance$/i.test(header));
  if (usesDebitPositiveAmounts) {
    const chronological = transactions
      .filter((transaction) => transaction.postedAt && transaction.balanceValue !== null)
      .sort((left, right) => Date.parse(right.postedAt) - Date.parse(left.postedAt));
    let debitVotes = 0;
    let creditVotes = 0;
    for (let index = 0; index < chronological.length - 1; index += 1) {
      const newer = chronological[index];
      const older = chronological[index + 1];
      if (newer.amountValue === null) {
        continue;
      }
      const balanceDrop = older.balanceValue - newer.balanceValue;
      const amount = Math.abs(newer.amountValue);
      if (Math.abs(balanceDrop - amount) < 0.005) {
        debitVotes += 1;
      } else if (Math.abs(balanceDrop + amount) < 0.005) {
        creditVotes += 1;
      }
    }

    // Cal1Card 的 New Balance 表以正数表示扣款；余额变化用于防止页面约定改变时反向计算。
    if (debitVotes >= creditVotes) {
      transactions = transactions.map((transaction) => ({
        ...transaction,
        amountValue:
          transaction.amountValue === null ? null : -transaction.amountValue,
      }));
    }
  }

  return { asOf, headers, transactions };
}
