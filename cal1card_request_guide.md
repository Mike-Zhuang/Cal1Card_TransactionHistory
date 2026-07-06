# Cal1Card 直接请求查余额分析

生成时间：2026-07-06  
分析对象：`cal1card.har`

> 说明：HAR 里包含账户名、账号、交易记录、余额等个人信息。本文档不写出这些敏感值，只保留接口结构、解析方式和可替换的占位符。

## 1. 结论

这个 HAR **足够定位你现在看到余额/交易记录的页面接口**，但 **不够支持脱离浏览器、长期稳定地直接请求查余额**。

原因是：

1. HAR 里关键的余额/交易页面已经抓到了。
2. 这个页面不是 JSON API，而是一个 ASP.NET 返回的 HTML 页面。
3. HAR 里没有可复用的认证信息：没有 `Cookie`、没有 `Authorization`、没有 `Set-Cookie`。
4. 页面返回的是个人账户数据，但请求记录里没有登录凭据，说明这份 HAR 很可能是浏览器导出的“脱敏 HAR”，或者登录态没有被导出。
5. 因此，你可以根据它写解析逻辑；但要让 Python/cURL 在浏览器外请求成功，还需要你在本地拿到当前登录态的 Cookie，或者直接在已登录浏览器上下文里发 `fetch`。

## 2. HAR 里真正有用的请求

HAR 总共有 21 个请求，其中大部分是 CSS、字体、图片等静态资源。真正和余额/交易数据相关的是这两个：

### 2.1 旧路径跳转

```http
GET https://c1capps.sait-west.berkeley.edu/App/CalDining/ViewTransactions.aspx?pln=sumrh
```

返回：

```http
301 Location: /App/CalDining/ViewTransactions?pln=sumrh
```

### 2.2 实际返回数据的页面

```http
GET https://c1capps.sait-west.berkeley.edu/App/CalDining/ViewTransactions?pln=sumrh
```

返回：

```http
200 OK
Content-Type: text/html; charset=utf-8
```

其中：

- `pln=sumrh`：看起来是某个 plan 的代码；从页面标题看，对应 **Summer Res Hall Flex Dollars Activity**。
- 页面里包含交易表。
- 表格 ID 是：

```text
MainContent_gvsumrh
```

- 表头是：

```text
Posted | Amount | New Balance | Location
```

你的余额可以从第一条交易记录的 `New Balance` 列解析出来。

## 3. 页面里可以直接解析的字段

HTML 里有这些稳定的 ID：

```text
MainContent_lbBalanceAsOf
MainContent_lbAccountName
MainContent_lbAccountNumber
MainContent_gvsumrh
```

含义：

| 字段 | 含义 |
|---|---|
| `MainContent_lbBalanceAsOf` | 页面数据更新时间 |
| `MainContent_lbAccountName` | 账户名 |
| `MainContent_lbAccountNumber` | 账户号 |
| `MainContent_gvsumrh` | Summer Res Hall Flex Dollars 的交易表 |

余额不在单独 JSON 字段里，而在表格第一条交易记录的第三列：

```text
#MainContent_gvsumrh
第一行数据
第 3 列 New Balance
```

## 4. 你现在这份包够不够？

分场景看：

| 目标 | 够不够 | 原因 |
|---|---:|---|
| 分析页面结构 | 够 | 已经有完整 HTML 响应 |
| 找到交易/余额页面 URL | 够 | URL 是 `ViewTransactions?pln=sumrh` |
| 从已登录浏览器里直接 `fetch` | 基本够 | 浏览器会自动带登录态 |
| 用 Python/cURL 脱离浏览器请求 | 不够 | HAR 没有 Cookie/Authorization |
| 自动重新登录 CalNet | 不够，也不建议绕过 | 没抓登录流程，且可能涉及 MFA/安全策略 |
| 查所有账户/所有 plan 的余额 | 不够 | 只抓到了 `pln=sumrh` 的交易页面，没有抓 `ViewBalance` 页面和其他 plan |

## 5. 最简单方案：在已登录浏览器里用 fetch

这个方案不需要你手动处理 Cookie。前提是你已经在浏览器里登录了 Cal1Card。

打开 Cal1Card 相关页面后，在 DevTools Console 里运行：

```js
(async () => {
  const url = "/App/CalDining/ViewTransactions?pln=sumrh";

  const res = await fetch(url, {
    method: "GET",
    credentials: "include"
  });

  const html = await res.text();
  const doc = new DOMParser().parseFromString(html, "text/html");

  const asOf = doc.querySelector("#MainContent_lbBalanceAsOf")?.textContent.trim();
  const table = doc.querySelector("#MainContent_gvsumrh");
  const firstDataRow = table?.querySelectorAll("tr")?.[1];

  if (!firstDataRow) {
    console.log("没有解析到交易表。可能是登录过期，或者页面结构变了。");
    console.log("当前响应 URL:", res.url);
    return;
  }

  const cells = [...firstDataRow.querySelectorAll("td")].map(td => td.textContent.trim());

  const result = {
    asOf,
    posted: cells[0],
    amount: cells[1],
    balance: cells[2],
    location: cells[3]
  };

  console.log(result);
  alert(`Balance: ${result.balance}\nAs of: ${result.asOf}`);
})();
```

如果你只是想少点几下，这个方案最稳，因为它复用浏览器现有登录态。

## 6. Bookmarklet 版本

你可以把下面这段保存成浏览器书签 URL。使用时先打开 Cal1Card 已登录页面，然后点这个书签。

```js
javascript:(async()=>{const r=await fetch('/App/CalDining/ViewTransactions?pln=sumrh',{credentials:'include'});const h=await r.text();const d=new DOMParser().parseFromString(h,'text/html');const t=d.querySelector('#MainContent_gvsumrh');const row=t?.querySelectorAll('tr')?.[1];if(!row){alert('没有解析到余额：可能登录过期或页面结构变化');return;}const c=[...row.querySelectorAll('td')].map(x=>x.textContent.trim());const asOf=d.querySelector('#MainContent_lbBalanceAsOf')?.textContent.trim()||'';alert(`Balance: ${c[2]}\nAs of: ${asOf}`);})()
```

限制：

- 只能在已登录的 Cal1Card / 同源页面里用。
- 如果浏览器登录态过期，需要重新登录。
- 如果页面 ID 或表格结构变化，需要改选择器。

## 7. Python/cURL 方案

这个方案适合你想在终端里查余额。问题是你需要 Cookie。

当前 HAR 没有 Cookie，所以不能直接从这个 HAR 生成一个可运行的 Python/cURL 脚本。你需要在自己电脑本地从浏览器里复制请求，方式是：

1. 打开 DevTools。
2. Network 面板。
3. 重新访问余额/交易页面。
4. 找到这个请求：

```text
ViewTransactions?pln=sumrh
```

5. 右键它，选择：

```text
Copy -> Copy as cURL
```

6. 不要把完整 cURL 发给别人，因为里面可能有 Cookie。

### 7.1 cURL 模板

把 `<YOUR_COOKIE_HERE>` 换成你自己本地复制到的 Cookie：

```bash
curl -sS -L --compressed \
  'https://c1capps.sait-west.berkeley.edu/App/CalDining/ViewTransactions?pln=sumrh' \
  -H 'Accept: text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8' \
  -H 'Referer: https://c1capps.sait-west.berkeley.edu/App/CalDining/ViewBalance' \
  -H 'User-Agent: Mozilla/5.0' \
  -H 'Cookie: <YOUR_COOKIE_HERE>'
```

如果 Cookie 有效，返回应该是包含 `MainContent_gvsumrh` 的 HTML。  
如果 Cookie 失效，通常会返回登录页、跳转页，或者没有目标表格。

### 7.2 Python 脚本

安装依赖：

```bash
pip install requests beautifulsoup4
```

把 Cookie 放到环境变量，不要写死在代码里：

```bash
export CAL1CARD_COOKIE='<YOUR_COOKIE_HERE>'
```

脚本：

```python
import os
import sys
import requests
from bs4 import BeautifulSoup

URL = "https://c1capps.sait-west.berkeley.edu/App/CalDining/ViewTransactions?pln=sumrh"

def main():
    cookie = os.environ.get("CAL1CARD_COOKIE")
    if not cookie:
        print("缺少环境变量 CAL1CARD_COOKIE")
        sys.exit(1)

    headers = {
        "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        "Referer": "https://c1capps.sait-west.berkeley.edu/App/CalDining/ViewBalance",
        "User-Agent": "Mozilla/5.0",
        "Cookie": cookie,
    }

    res = requests.get(URL, headers=headers, allow_redirects=True, timeout=20)
    res.raise_for_status()

    html = res.text
    soup = BeautifulSoup(html, "html.parser")

    table = soup.select_one("#MainContent_gvsumrh")
    as_of_el = soup.select_one("#MainContent_lbBalanceAsOf")

    if table is None:
        print("没有找到交易表 #MainContent_gvsumrh。")
        print("可能原因：Cookie 过期、没登录、被重定向到登录页、页面结构变化。")
        print("最终 URL:", res.url)
        sys.exit(2)

    rows = table.select("tr")
    if len(rows) < 2:
        print("交易表存在，但没有数据行。")
        sys.exit(3)

    cells = [td.get_text(strip=True) for td in rows[1].select("td")]
    if len(cells) < 4:
        print("第一条交易记录列数不符合预期。")
        print(cells)
        sys.exit(4)

    posted, amount, balance, location = cells[:4]
    as_of = as_of_el.get_text(strip=True) if as_of_el else ""

    print(f"Balance: {balance}")
    print(f"As of: {as_of}")
    print(f"Latest transaction: {posted} | amount {amount} | {location}")

if __name__ == "__main__":
    main()
```

## 8. HAR 里不需要的东西

这次请求里页面有 ASP.NET 的隐藏字段：

```text
__VIEWSTATE
__VIEWSTATEGENERATOR
```

但你抓到的余额/交易页面是 GET 请求，不需要提交表单。  
所以仅仅查余额时，不需要处理这些 hidden input。

这些字段只有在你要模拟某些 POST 表单操作时才重要。

## 9. 你还应该补抓什么

如果你的目标是“查当前所有余额”，建议再抓一次：

```text
https://c1capps.sait-west.berkeley.edu/App/CalDining/ViewBalance
```

或者：

```text
https://c1capps.sait-west.berkeley.edu/App/CalDining/ViewBalance.aspx
```

这次 HAR 里只有它作为 `Referer` 出现，没有它的响应 HTML。  
所以目前不能确定 `ViewBalance` 页面是否直接列出所有 plan 的余额。

如果你的目标是“查不同账户/不同 meal plan”，建议分别点进去每个余额/交易页面，看 URL 里的 `pln=` 参数是否变化，例如：

```text
pln=sumrh
pln=<OTHER_PLAN_CODE>
```

需要补抓：

1. `ViewBalance` 页面响应。
2. 每个你关心的 `ViewTransactions?pln=...` 页面。
3. 本地复制的带 Cookie 的 cURL，但不要把 Cookie 发给别人。

## 10. 判断请求是否成功的标准

不要只看 HTTP 状态码。因为登录页也可能返回 `200 OK`。

更可靠的判断：

```text
HTML 里存在 #MainContent_gvsumrh
HTML 里存在 #MainContent_lbBalanceAsOf
表格第一条数据有 New Balance 列
```

失败判断：

```text
找不到 #MainContent_gvsumrh
最终 URL 变成登录页
页面文本包含 Login / CalNet / Sign In
响应里没有交易表
```

## 11. 安全注意点

1. HAR 很敏感。它可能包含姓名、账号、余额、交易地点、Cookie、token。
2. 不要把带 Cookie 的 HAR 或 cURL 贴到公开仓库。
3. Cookie 建议只放在本地环境变量、macOS Keychain、1Password CLI、或者系统凭据管理器里。
4. 不建议自动化 CalNet 登录、MFA 或验证码流程。
5. Cookie 过期后，最安全的处理方式是重新在浏览器登录，然后本地重新复制请求。
6. 如果只是为了少点几下，优先用浏览器内 `fetch` 或 bookmarklet，而不是保存长期 Cookie。

## 12. 最小可行路线

按实现成本排序：

### 路线 A：浏览器 Console / Bookmarklet

适合：只想少点几下。  
优点：不用管理 Cookie。  
缺点：必须先打开已登录的 Cal1Card 页面。

### 路线 B：Python + Cookie

适合：想从终端或脚本里查。  
优点：可以接入快捷指令、菜单栏、Raycast、Alfred。  
缺点：Cookie 过期后要更新。

### 路线 C：抓完整登录流程

不建议。CalNet 登录和 MFA 不适合被脚本绕过，也不稳定。

## 13. 当前 HAR 的最终判断

这份 HAR 的价值是：

```text
能确定余额/交易数据来自：
https://c1capps.sait-west.berkeley.edu/App/CalDining/ViewTransactions?pln=sumrh

能确定解析目标是：
#MainContent_gvsumrh 的第一条数据行的 New Balance 列

能确定数据更新时间来自：
#MainContent_lbBalanceAsOf
```

这份 HAR 的不足是：

```text
没有 Cookie / Authorization
没有 ViewBalance 页面响应
没有其他 plan 的 pln 参数
没有登录流程
```

所以结论是：

```text
用于写解析器：够。
用于浏览器内快速查：基本够。
用于 Python/cURL 脱离浏览器长期查：不够，需要本地 Cookie。
用于完整自动登录查余额：不够，也不建议这么做。
```
