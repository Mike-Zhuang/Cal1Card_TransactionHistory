# Cal1Card 控制台

这是一个“服务器网站 + 本地绑定工具”的 Cal1Card 查询原型。

核心原则：

- CalNet / Duo 登录只在你的本机浏览器里完成。
- 服务器不保存 CalNet 密码。
- 服务器只保存加密后的 Playwright `storageState`。
- 登录态失效后重新绑定，不自动绕过 CalNet / Duo。

## 1. 服务器启动

先设置你自己网站的控制台密码：

```bash
export CAL1CARD_APP_PASSWORD='换成一个强密码'
```

建议服务器上也固定一个加密密钥，避免换机器或清空 `data/server-secret.key` 后无法解密旧登录态：

```bash
export CAL1CARD_ENCRYPTION_KEY='换成一个足够长的随机字符串'
```

启动：

```bash
cd /Users/mike/Documents/Website/Cal1Card
npm install
npm start
```

默认监听：

```text
http://127.0.0.1:3000
```

部署到服务器时可以改：

```bash
HOST=0.0.0.0 PORT=3000 npm start
```

公网部署必须放在 HTTPS 后面，例如 Nginx / Caddy / Cloudflare Tunnel。

## 2. 网页使用流程

1. 打开服务器网站。
2. 输入 `CAL1CARD_APP_PASSWORD` 登录你的控制台。
3. 点击“生成绑定码”。
4. 复制网页里显示的 `npm run bind -- ...` 命令。
5. 在你的本机项目目录运行这个命令。
6. 本机会弹出 Playwright 浏览器，你在官方 Berkeley 页面完成 CalNet + Duo。
7. 绑定脚本自动上传 storageState。
8. 回到网页点击“刷新余额”。

## 3. 本地绑定工具

示例命令格式：

```bash
npm run bind -- --server https://your-domain.example --token <绑定码>
```

本地绑定工具会：

1. 打开官方 Cal1Card 页面。
2. 等你手动完成 CalNet / Duo。
3. 确认页面出现 Cal1Card 账户信息。
4. 导出 Playwright storageState。
5. 用一次性绑定码上传到你的服务器。

绑定码有效期 10 分钟，且只能使用一次。

## 4. 文件与安全

运行时敏感文件：

```text
data/
.cal1card-bind-profile/
```

这些已经被 `.gitignore` 忽略。

不要上传：

- `data/`
- `.cal1card-bind-profile/`
- HAR
- 完整 cURL
- Cookie
- Cal1Card 页面截图

## 5. 登录态失效

如果网页提示需要重新绑定：

1. 登录控制台。
2. 点击“生成绑定码”。
3. 在本机重新运行绑定命令。
4. 完成 CalNet / Duo 后再刷新余额。

## 6. 开发默认密码

如果没有设置 `CAL1CARD_APP_PASSWORD`，程序会临时使用：

```text
cal1card-dev
```

这个只适合本地开发。部署服务器前必须设置环境变量。
