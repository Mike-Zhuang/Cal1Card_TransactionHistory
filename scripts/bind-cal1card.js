import { chromium } from "playwright";

const CAL1CARD_LOGIN_URL =
  "https://auth.berkeley.edu/cas/login?service=https://c1capps.sait-west.berkeley.edu/LoginModule/CASC1CHomeLogin";
const CAL1CARD_BALANCE_URL = "https://c1capps.sait-west.berkeley.edu/App/CalDining/ViewBalance";
const LOGIN_TIMEOUT_MS = 30 * 60 * 1000;

function parseArgs(argv) {
  const args = new Map();
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (!value.startsWith("--")) {
      continue;
    }

    const key = value.slice(2);
    const nextValue = argv[index + 1];
    if (!nextValue || nextValue.startsWith("--")) {
      args.set(key, "true");
      continue;
    }

    args.set(key, nextValue);
    index += 1;
  }

  return args;
}

function normalizeWhitespace(value) {
  return String(value ?? "").replace(/\s+/g, " ").trim();
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const server = args.get("server")?.replace(/\/$/, "");
  const token = args.get("token");

  if (!server || !token) {
    console.error("用法：npm run bind -- --server https://your-domain.example --token <绑定码>");
    process.exit(1);
  }

  const browser = await chromium.launch({
    headless: false,
  });
  const context = await browser.newContext({
    viewport: { width: 1280, height: 860 },
  });

  const page = await context.newPage();
  await page.goto(CAL1CARD_LOGIN_URL, {
    waitUntil: "domcontentloaded",
    timeout: 45000,
  });

  console.log("已打开带 service 参数的官方 CalNet 登录页。请在弹出的浏览器里完成 CalNet 和 Duo 验证。");
  console.log("登录成功回到 Cal1Card 域名后，脚本会自动上传 storageState。");
  console.log("脚本会等待最多 30 分钟，不会因为 30 秒内没完成验证而关闭浏览器。");

  await page.waitForURL(
    (url) => {
      return url.hostname === "c1capps.sait-west.berkeley.edu";
    },
    { timeout: LOGIN_TIMEOUT_MS },
  );

  await page.waitForLoadState("domcontentloaded").catch(() => {});
  await page.waitForTimeout(2000);

  const accountInfo = await page.evaluate(() => {
    const normalize = (value) => String(value ?? "").replace(/\s+/g, " ").trim();
    return {
      accountName: normalize(document.querySelector("#MainContent_lbAccountName")?.textContent),
      accountNumber: normalize(document.querySelector("#MainContent_lbAccountNumber")?.textContent),
    };
  });

  const storageState = await context.storageState();
  const response = await fetch(`${server}/api/bind-storage-state`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      storageState,
      accountName: normalizeWhitespace(accountInfo.accountName),
      accountNumber: normalizeWhitespace(accountInfo.accountNumber),
    }),
  });

  const payload = await response.json();
  if (!response.ok) {
    throw new Error(payload.error || "上传 storageState 失败");
  }

  console.log("绑定成功。服务器现在可以使用加密保存的 Cal1Card 登录态查询余额。");
  await context.close();
  await browser.close();
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
