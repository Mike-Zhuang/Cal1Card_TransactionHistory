# Cal1Card V2

Cal1Card V2 是一个单用户 Berkeley 校园钱包：查看余额、积累交易历史、设置地点分类与月度预算，并在网页内完成 CalNet + Duo 登录。

它不是 UC Berkeley 官方产品，也不会绕过 CalNet 或 Duo。

## 功能

- 移动端优先的钱包仪表盘，桌面端提供高密度交易视图。
- 多 plan 切换、消费趋势、分类分布、热门地点和预算进度。
- 7/30/90 天与全部范围、地点搜索、分类筛选、分页和 CSV 导出。
- 地点级分类规则，可立即应用到同地点历史交易。
- 网页内 15 分钟临时 Chromium，通过同源 noVNC 完成 CalNet + Duo。
- 本地绑定命令保留为高级恢复通道。
- SQLite 长期历史；账户、交易、预算和规则按记录 AES-256-GCM 加密。

## 安全模型

- 不保存 CalNet 密码。
- 登录成功后只保留 `c1capps.sait-west.berkeley.edu` 的必要 Cookie；CalNet TGC、Duo Cookie 和浏览器信任状态会被删除。
- 远程画面不在 URL 携带 token。临时 Cookie 为 `HttpOnly`、`SameSite=Strict`、路径受限，生产环境带 `Secure`。
- VNC 只监听 `127.0.0.1`；成功、取消、超时或服务停止时回收 Chromium、x11vnc 和 Xvfb。
- 控制台使用 7 天签名会话、CSRF、同源 Origin 校验、恒定时间密码比较和登录限流。
- API 禁止缓存，并启用 CSP、HSTS 等安全响应头。

临时远程浏览器的代价是登录期间服务器会处理画面与键盘输入，且 Chromium 会短时占用较多内存。若服务器本身被入侵，攻击者可能观察正在进行的会话。因此本项目限制为单用户、单会话、15 分钟，不开放 VNC 公网端口；异常时可关闭 `CAL1CARD_WEB_LOGIN_ENABLED` 回到本地绑定。

## 本地开发

要求 Node.js 22.17 或更高版本。

```bash
npm ci
cp .env.example .env
CAL1CARD_APP_PASSWORD='local-password' npm start
```

默认监听 `http://127.0.0.1:3000`。网页远程登录依赖 Linux 上的 Xvfb 与 x11vnc；macOS 开发时可保持功能关闭。

## 环境变量

生产环境至少设置：

```text
CAL1CARD_APP_PASSWORD
CAL1CARD_ENCRYPTION_KEY
CAL1CARD_PUBLIC_ORIGIN
CAL1CARD_DATA_DIR
CAL1CARD_WEB_LOGIN_ENABLED
PLAYWRIGHT_BROWSERS_PATH
```

完整示例见 `.env.example`。密码和加密密钥必须相互独立，不要提交到 Git。

## 测试

```bash
npm run check:syntax
npm test
npx playwright install chromium webkit
npm run test:e2e
```

测试覆盖解析、金额日期标准化、加密防篡改、V1 密钥迁移、HMAC 去重、SQLite 迁移、分类、预算、会话、CSRF、限流、WebSocket 拒绝和远程进程回收。浏览器测试覆盖 Chromium/WebKit 与 390/768/1440 三档视口，并执行 Axe 检查。

## 服务器部署

建议目录：

```text
/opt/cal1card                 应用代码
/var/lib/cal1card             加密状态、SQLite 和 Playwright 浏览器
/etc/cal1card/cal1card.env    仅 root/www 可读的环境变量
```

部署顺序：

1. 备份旧 `data/` 和环境变量。
2. 先以 `CAL1CARD_WEB_LOGIN_ENABLED=false` 发布并验证旧登录态迁移。
3. 安装 Chromium、Xvfb、x11vnc 与 Playwright 系统依赖。
4. 配置 `deploy/cal1card.service` 和 Nginx WebSocket location。
5. 验证 VNC 只监听本机后再打开网页登录。
6. 在宝塔创建 `17 */4 * * *` 的同步任务，执行 `deploy/cal1card-sync.sh`。

服务器的 gh-proxy 自动部署入口为 `deploy/cal1card-sync-deploy.sh`，默认先尝试 gh-proxy，再尝试备用代理与 GitHub 直连。

计划任务日志只输出时间、成功/失败状态和新增/总交易数，不输出姓名、余额、地点或 Cookie。

## 高级本地绑定

网页登录异常时，在设置页生成一次性命令：

```bash
npm run bind -- --server https://cal1card.example.com --token <一次性绑定码>
```

绑定码默认 10 分钟失效。此通道同样会过滤并加密登录态。
