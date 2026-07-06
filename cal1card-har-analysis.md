# Cal1Card 直接请求查余额分析

生成时间：2026-07-06  
分析对象：`/Users/mike/Downloads/cal1card.har`  
结论类型：HAR 静态分析 + 无 Cookie 对照请求验证

> 安全说明：Cal1Card 的 HAR、Cookie、cURL 和页面 HTML 都可能包含姓名、账号、余额、交易地点、交易时间等个人信息。本文档只保留接口结构、选择器和实现模板，不写出任何个人值。

## 1. 最终结论

这份 HAR **足够定位余额/交易页面和解析规则**，但 **不够直接生成一个脱离浏览器长期可用的脚本**。

原因很明确：

1. HAR 里抓到了真正返回交易页面的请求。
2. 这个接口不是 JSON API，而是 ASP.NET 返回的 HTML 页面。
3. HAR 里没有 `Cookie`、`Authorization`、`Set-Cookie` 等登录态信息。
4. 我做了无 Cookie 对照请求，最终落到 `https://auth.berkeley.edu/cas/logout`，页面里没有目标交易表。
5. 所以，直接请求可行，但必须复用已登录会话，最简单是浏览器内 `fetch`，终端脚本则需要本地 Cookie。

一句话判断：

```text
用于写解析器：够。
用于浏览器内快速查余额：够。
用于 Python/cURL 脱离浏览器查余额：还缺 Cookie。
用于完整自动登录 CalNet/MFA：不够，也不建议绕过。
```

## 2. HAR 里真正有用的请求

HAR 一共有 21 条请求：

| 类型 | 数量 |
|---|---:|
| Cal1Card 页面请求 | 2 |
| Berkeley 静态资源 | 17 |
| Google Fonts | 2 |

真正有用的是这两条。

### 2.1 旧路径跳转

```http
GET https://c1capps.sait-west.berkeley.edu/App/CalDining/ViewTransactions.aspx?pln=sumrh
```

返回：

```http
301 Location: /App/CalDining/ViewTransactions?pln=sumrh
```

### 2.2 实际返回交易数据的页面

```http
GET https://c1capps.sait-west.berkeley.edu/App/CalDining/ViewTransactions?pln=sumrh
```

返回：

```http
200 OK
Content-Type: text/html; charset=utf-8
```

关键点：

| 字段 | 判断 |
|---|---|
| 请求方法 | `GET` |
| 路径 | `/App/CalDining/ViewTransactions` |
| 查询参数 | `pln=sumrh` |
| 返回格式 | HTML，不是 JSON |
| HAR 中 Cookie | 没有 |
| HAR 中 Authorization | 没有 |

`pln=sumrh` 看起来是 Summer Res Hall Flex Dollars 相关 plan 的代码。其他余额类型可能对应不同的 `pln=` 值，需要从 `ViewBalance` 页面或其他交易页继续抓。

## 3. 页面解析规则

页面标题是：

```text
Cal 1 Card -- UC Berkeley
```

HTML 里有这些稳定元素：

| 选择器 | 含义 |
|---|---|
| `#MainContent_lbBalanceAsOf` | 数据更新时间 |
| `#MainContent_lbAccountName` | 账户名 |
| `#MainContent_lbAccountNumber` | 账户号 |
| `#MainContent_gvsumrh` | `sumrh` plan 的交易表 |

交易表：

```text
#MainContent_gvsumrh
```

表头：

```text
Posted | Amount | New Balance | Location
```

余额解析方式：

```text
取 #MainContent_gvsumrh 的第一条数据行
再取第 3 列 New Balance
```

也就是：

```js
const table = doc.querySelector("#MainContent_gvsumrh");
const firstDataRow = table?.querySelectorAll("tr")?.[1];
const cells = [...firstDataRow.querySelectorAll("td")].map((cell) => cell.textContent.trim());
const balance = cells[2];
```

## 4. 为什么这份 HAR 没法直接变成可运行脚本

HAR 里和登录态相关的检查结果：

| 检查项 | 结果 |
|---|---|
| 请求 Cookie | 无 |
| 响应 Set-Cookie | 无 |
| Authorization | 无 |
| CSRF/XSRF header | 无 |
| 登录跳转链路 | 无 |

我又做了一个无 Cookie 对照请求：

```text
GET https://c1capps.sait-west.berkeley.edu/App/CalDining/ViewTransactions?pln=sumrh
```

结果：

```text
HTTP status: 200
最终 URL: https://auth.berkeley.edu/cas/logout
存在 #MainContent_gvsumrh: false
存在 #MainContent_lbBalanceAsOf: false
页面含 login/sign in/CalNet 相关文本: true
```

这说明服务器确实需要登录态。HAR 之所以看不到登录态，大概率是浏览器导出 HAR 时没有包含敏感信息，或者登录态没有进入导出的 HAR 字段。

## 5. 推荐路线 A：浏览器内 fetch

这是最简单、最稳的方案。你先正常在浏览器里登录 Cal1Card，然后在同一个 `c1capps.sait-west.berkeley.edu` 页面运行下面脚本。浏览器会自动携带当前登录态，不需要你复制 Cookie。

适用场景：

| 需求 | 是否适合 |
|---|---:|
| 少点几下查余额 | 适合 |
| 不想保存 Cookie | 适合 |
| 想在终端定时查 | 不适合 |

使用前先打开任意同源页面，例如：

```text
https://c1capps.sait-west.berkeley.edu/App/CalDining/ViewBalance.aspx
```

然后在 DevTools Console 运行：

```js
(async () => {
  const url = "/App/CalDining/ViewTransactions?pln=sumrh";

  const response = await fetch(url, {
    method: "GET",
    credentials: "include"
  });

  const html = await response.text();
  const doc = new DOMParser().parseFromString(html, "text/html");

  const asOf = doc.querySelector("#MainContent_lbBalanceAsOf")?.textContent.trim() ?? "";
  const table = doc.querySelector("#MainContent_gvsumrh");
  const firstDataRow = table?.querySelectorAll("tr")?.[1];

  if (!firstDataRow) {
    console.log("没有解析到交易表，可能是登录过期、被重定向到登录页，或者页面结构变化。");
    console.log("最终响应 URL:", response.url);
    alert("没有解析到余额，请先重新登录 Cal1Card。");
    return;
  }

  const cells = [...firstDataRow.querySelectorAll("td")].map((cell) => cell.textContent.trim());
  const result = {
    posted: cells[0],
    amount: cells[1],
    balance: cells[2],
    location: cells[3],
    asOf
  };

  console.log(result);
  alert(`Balance: ${result.balance}\nAs of: ${result.asOf}`);
})();
```

## 6. 推荐路线 B：Bookmarklet

如果你只是想点一下就弹出余额，可以把下面这段保存成浏览器书签的 URL。

使用方法：

1. 先打开已登录的 Cal1Card 页面，必须是 `c1capps.sait-west.berkeley.edu` 域名。
2. 点击这个书签。
3. 浏览器弹窗显示余额。

```js
javascript:(async()=>{const response=await fetch('/App/CalDining/ViewTransactions?pln=sumrh',{credentials:'include'});const html=await response.text();const doc=new DOMParser().parseFromString(html,'text/html');const table=doc.querySelector('#MainContent_gvsumrh');const firstDataRow=table?.querySelectorAll('tr')?.[1];if(!firstDataRow){alert('没有解析到余额：可能登录过期或页面结构变化');return;}const cells=[...firstDataRow.querySelectorAll('td')].map((cell)=>cell.textContent.trim());const asOf=doc.querySelector('#MainContent_lbBalanceAsOf')?.textContent.trim()||'';alert(`Balance: ${cells[2]}\nAs of: ${asOf}`);})()
```

限制：

| 限制 | 说明 |
|---|---|
| 必须已登录 | 依赖浏览器当前会话 |
| 必须同源 | 最好在 `c1capps.sait-west.berkeley.edu` 页面上点 |
| 登录过期会失败 | 重新登录后再点 |
| 只查 `sumrh` | 其他 plan 要换 `pln=` |

## 7. 推荐路线 C：cURL/Python

这个方案适合你想在终端、Raycast、Alfred、macOS 快捷指令里查余额。

但当前 HAR 没有 Cookie，所以需要你在本地浏览器里重新复制一次请求。

### 7.1 怎么拿到本地 Cookie

推荐操作：

1. 打开 Cal1Card 并完成登录。
2. 打开 DevTools。
3. 进入 Network 面板。
4. 重新访问交易页或余额页。
5. 找到请求：

```text
ViewTransactions?pln=sumrh
```

6. 右键选择：

```text
Copy -> Copy as cURL
```

7. 不要把完整 cURL 发给别人，因为里面可能有 Cookie。

如果要让我继续分析，可以只发脱敏版：

```text
Cookie: <REDACTED>
```

保留 URL、method、header 名称即可。

### 7.2 cURL 模板

把 `<YOUR_COOKIE_HERE>` 换成你本地复制到的 Cookie：

```bash
curl -sS -L --compressed \
  'https://c1capps.sait-west.berkeley.edu/App/CalDining/ViewTransactions?pln=sumrh' \
  -H 'Accept: text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8' \
  -H 'Referer: https://c1capps.sait-west.berkeley.edu/App/CalDining/ViewBalance' \
  -H 'User-Agent: Mozilla/5.0' \
  -H 'Cookie: <YOUR_COOKIE_HERE>'
```

成功标准不是 `200 OK`，而是 HTML 里存在：

```text
MainContent_gvsumrh
MainContent_lbBalanceAsOf
```

失败时常见表现：

```text
最终 URL 变成 auth.berkeley.edu
页面文本包含 Login / Sign In / CalNet
没有 MainContent_gvsumrh
```

### 7.3 Python 脚本模板

安装依赖：

```bash
python3 -m pip install requests beautifulsoup4
```

把 Cookie 放到环境变量，不要写死进脚本：

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


def fetchBalance() -> None:
    cookieHeader = os.environ.get("CAL1CARD_COOKIE")
    if not cookieHeader:
        print("缺少环境变量 CAL1CARD_COOKIE")
        sys.exit(1)

    headers = {
        "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        "Referer": "https://c1capps.sait-west.berkeley.edu/App/CalDining/ViewBalance",
        "User-Agent": "Mozilla/5.0",
        "Cookie": cookieHeader,
    }

    response = requests.get(URL, headers=headers, allow_redirects=True, timeout=20)
    response.raise_for_status()

    soup = BeautifulSoup(response.text, "html.parser")
    table = soup.select_one("#MainContent_gvsumrh")
    asOfElement = soup.select_one("#MainContent_lbBalanceAsOf")

    if table is None:
        print("没有找到交易表 #MainContent_gvsumrh")
        print("可能原因：Cookie 过期、未登录、被重定向到登录页，或页面结构变化")
        print("最终 URL:", response.url)
        sys.exit(2)

    rows = table.select("tr")
    if len(rows) < 2:
        print("交易表存在，但没有数据行")
        sys.exit(3)

    cells = [cell.get_text(strip=True) for cell in rows[1].select("td")]
    if len(cells) < 4:
        print("第一条交易记录列数不符合预期")
        sys.exit(4)

    posted, amount, balance, location = cells[:4]
    asOf = asOfElement.get_text(strip=True) if asOfElement else ""

    print(f"Balance: {balance}")
    print(f"As of: {asOf}")
    print(f"Latest transaction: {posted} | amount {amount} | {location}")


if __name__ == "__main__":
    fetchBalance()
```

## 8. 还应该补抓什么

如果目标只是 `sumrh` 当前余额，现有 HAR 已经够写浏览器内脚本。

如果目标是“所有 Cal1Card/meal plan 余额”，还需要补抓：

| 需要补抓 | 原因 |
|---|---|
| `ViewBalance.aspx` 或 `ViewBalance` 页面 HTML | 可能列出所有 plan 和余额 |
| 每个 plan 的 `ViewTransactions?pln=...` 页面 | 找到其他 `pln` 代码 |
| 登录后同一请求的带 Cookie cURL | 终端脚本需要 |

这次 HAR 只出现了 `ViewBalance.aspx` 作为链接，没有抓到它的响应 HTML，所以目前不能确认它是否直接列出所有余额。

## 9. 我可以配合你补抓浏览器请求

可以打开一个受控浏览器，你自己输入 CalNet/账户内容，我这边只看 Network 请求结构。建议补抓时按这个范围做：

1. 打开 `ViewBalance.aspx`。
2. 点击每个你关心的余额/交易入口。
3. 我记录 URL、method、status、选择器、`pln=` 参数。
4. Cookie、账号、余额、交易明细全部在文档里脱敏。

不建议做的事：

| 不建议 | 原因 |
|---|---|
| 自动化 CalNet 登录 | 可能触发 MFA、安全策略或违反使用规则 |
| 保存长期 Cookie 到源码 | Cookie 泄露风险高 |
| 把完整 HAR 上传公开仓库 | 可能包含个人账户数据 |

## 10. 最小可行方案

按实现成本排序：

### 方案 A：浏览器 Console

最适合现在马上用。  
登录 Cal1Card 后，打开 Console，运行第 5 节脚本。

### 方案 B：Bookmarklet

适合日常少点几下。  
登录后点书签直接弹余额。

### 方案 C：Python + Cookie

适合终端、Raycast、Alfred、快捷指令。  
缺点是 Cookie 过期后需要重新复制。

### 方案 D：完整登录自动化

不推荐。  
CalNet/MFA 本来就是为了防自动化绕过，工程上也更脆弱。

## 11. 当前 HAR 的最终判断

能确定：

```text
余额/交易数据来自：
https://c1capps.sait-west.berkeley.edu/App/CalDining/ViewTransactions?pln=sumrh

余额解析目标：
#MainContent_gvsumrh 第一条数据行的 New Balance 列

数据更新时间解析目标：
#MainContent_lbBalanceAsOf
```

不能确定：

```text
有效 Cookie 是什么
Cookie 有效期多久
ViewBalance 页面是否直接列出所有余额
还有哪些 pln 参数
是否存在 JSON API
```

最推荐你先落地：

```text
先用 Bookmarklet 解决“少点几下查余额”的问题；
需要终端自动化时，再补抓带 Cookie 的 Copy as cURL。
```
