# Workers SSH with MCP

基于 [cmliu/CF-Workers-WebSSH](https://github.com/cmliu/CF-Workers-WebSSH) 的 fork，保留原有 WebSSH / SFTP / 进程管理，增加访问密钥、持久化逐级封禁和原生 Workers 远程 MCP 服务。保留 Apache-2.0 许可证和原作者署名。

## 快速初始化

当前部署配置使用自定义域名 `ssh.05s.us`，MCP 地址为 `https://ssh.05s.us/mcp`，并关闭 `workers.dev` 入口。Fork 到其他账号部署时，请将 `wrangler.toml` 中的域名改为自己的域名。

使用 Node.js 22.18+（Windows ARM 请安装 x64 Node.js，以兼容 Cloudflare workerd）：

```bash
npm ci
npm run setup
npm run dev
```

初始化只询问**密钥长度**（最少 10，默认 64，推荐 32–128），使用安全随机数生成密钥并保存到 Git 忽略的 `.dev.vars`，不会在终端打印密钥，也不会覆盖现有密钥。用本地编辑器查看该文件，将值保存到密码管理器。在浏览器打开 `http://localhost:8787`，输入生成的密钥登录。访问密钥与目标服务器的 SSH 密码是不同的凭据。

`npm run deploy` 会上传本地生成的密钥并部署。若使用 Cloudflare Workers Builds，在部署配置中提供 **ACCESS_KEY Secret**（至少 10 位，推荐 32 位以上随机密码）；它是唯一需要手动设置的应用配置。Durable Objects 和 Assets 自动绑定，不需要配置 timeout。密钥不存在或不足 10 位时服务拒绝访问，不会回退为匿名模式。

## 远程 MCP

部署后使用 `https://你的域名/mcp`，传输类型为 **Streamable HTTP**，鉴权头为 `Authorization: Bearer <ACCESS_KEY>`。支持 JSON 响应，不提供 GET SSE 订阅；不依赖服务器文件系统或 stdio，直接运行于 Cloudflare Workers。客户端须支持自定义 Bearer Header；需要 OAuth 自动发现的客户端需要另行接入 OAuth，本项目没有实现 OAuth。

支持如下客户端配置的工具可填写（占位值请在本地替换，勿提交真实密钥）：

```json
{
  "mcpServers": {
    "workers-ssh": {
      "url": "https://你的域名/mcp",
      "headers": { "Authorization": "Bearer <ACCESS_KEY>" }
    }
  }
}
```

| 工具 | 用途 |
| --- | --- |
| `ssh_connect` | 创建 SSH 会话，返回 `connectionId`；必填 `host`、`username`、`authMethod`、`expectedFingerprint`，密码或未加密 OpenSSH / RSA PEM 私钥二选一 |
| `ssh_send` | 传入 `connectionId` 和 `data`，执行命令时自行追加 `\n`；它是交互式终端输入，不返回 exit code |
| `ssh_read` | 读取并清空当前输出缓冲；尚无输出时稍后再调用 |
| `ssh_disconnect` | 关闭连接 |

首次连接示例：

```json
{
  "name": "ssh_connect",
  "arguments": {
    "host": "ssh.example.com",
    "port": 22,
    "username": "admin",
    "authMethod": "password",
    "password": "<SSH_PASSWORD>",
    "expectedFingerprint": "SHA256:<通过服务器控制台等可信渠道核验的43位指纹>"
  }
}
```

MCP 必须提供已在可信渠道核验的主机指纹；不自动接受未知或变更的密钥。SSH 凭据仅在会话内存中使用，不存储到 Durable Objects。每个会话最多 15 分钟，Worker 重启后需重新连接；输出缓冲最多保留 256 KiB 字符，发生截断会标记 `truncated`。所有持有访问密钥的客户端共享管理权限，请只把密钥交给可信客户端，终端输出应视为不可信数据。

## 逐级封禁与恢复

这是适用于 Workers 的 Fail2ban 风格鉴权逻辑，而非需要 Linux 守护进程的 fail2ban 软件。网页与 MCP 按 Cloudflare 提供的客户端 IP 共用计数；每 5 次认证失败升级一次：**1 分钟 → 15 分钟 → 24 小时 → 永久**。正确密钥不能绕过正在生效的封禁；认证成功只清除连续失败次数，不清除历史升级级别。每个 IP 使用独立 SQLite Durable Object，以事务防止并发漏记，状态在重启后保留。

管理员可从**未被封禁的 IP**携带正确 Bearer 密钥调用 `POST /api/admin/unban`，JSON 请求体为 `{"ip":"被封禁的IP"}`；浏览器调用还需同源。若所有管理员出口都被封禁，可在 Cloudflare 的 Durable Objects Data Studio 中定位 `AUTH_GUARD` 对应 IP 的对象并删除 `ban` 记录。轮换访问密钥会使已签发网页登录 Cookie 失效，但不会清除 IP 封禁。共享出口/NAT 下的用户共享 IP 封禁状态。

网页登录采用 HttpOnly、Secure、SameSite=Strict 的签名 Cookie，24 小时过期；退出登录清除本机 Cookie，已复制的 Cookie 在有效期内仍有效，需要立即撤销时轮换 ACCESS_KEY。静态代码资源公开，应用 HTML、SSH API 与 MCP 均受鉴权保护。生产环境应始终使用 HTTPS；本地开发使用 localhost。

## 验证

```bash
npm run check
```

执行 Worker / 前端类型检查、Node 单元测试、真实 workerd + SQLite Durable Objects 集成测试，以及前端构建与 Wrangler 部署 dry-run。集成测试覆盖登录、Cookie 篡改、官方 MCP 客户端、SSH 握手与命令收发、指纹变更前拒绝发送凭据、错误密码、私网拦截、并发封禁及管理员恢复。SSH 测试使用本地受控服务器，仅在测试 bundle 中重定向 TCP；不连接真实公网主机。测试专用状态控制接口只存在于测试 bundle，不进入生产 Worker。

一个运行在 Cloudflare Workers 上的原生 WebSSH 终端。浏览器通过 HTTPS/WebSocket 连接 Worker，Worker 使用 Cloudflare TCP Sockets 直接连接公网 SSH 服务器，并在边缘运行时内完成 SSH 2.0 握手、主机密钥校验、用户认证和交互式 PTY 会话。

运行时无 SSH 第三方依赖，前端、会话网关、SSH 客户端实现和静态资源均由同一个 Worker 部署提供。

> [!IMPORTANT]
> 页面、SSH API 和 MCP 都必须验证访问密钥。可以按需叠加 Cloudflare Access、WAF 与边缘限流；若对 MCP 使用 Access，还需为客户端配置相应的服务身份凭据。

## 功能特性

- Cloudflare Workers 原生部署，使用 Durable Objects 隔离每个 SSH 会话。
- 基于 xterm.js 的响应式终端，支持桌面端和移动端、自动缩放、全屏和会话日志。
- 内置 SFTP 文件管理，可浏览目录、上传/下载文件、新建与删除空目录、删除文件和重命名。
- 内置实时进程管理，通过独立 WebSocket 和 SSH exec channel 展示 `top` 进程、CPU、负载、内存与 Swap 使用率。
- 支持 SSH password 与单密码提示的 keyboard-interactive 认证、Ed25519/RSA/ECDSA 的未加密 OpenSSH 私钥，以及未加密 RSA PEM（PKCS#1 / PKCS#8）私钥认证。
- 首次连接时暂停认证并显示主机 SHA-256 指纹，确认后才会发送 SSH 凭据。
- SSH 连接成功后自动写入浏览器本地"历史记录"，密码使用 AES-256-GCM 加密，私钥不保存。
- 支持 UTF-8、GB18030、Big5 显示编码、初始命令和分享链接（密码认证时链接携带 Base64 密码，粘贴即自动连接）。
- 提供一次性会话票据、同源检查、HTTPS 强制、安全响应头和公网目标校验。
- SSH 数据包、密钥交换、加密、认证和通道逻辑全部使用 TypeScript 与 Web Crypto 实现。

## 工作原理

```text
浏览器（xterm.js）
    │  HTTPS：申请一次性会话票据
    │  WSS：终端输入、输出和控制消息；独立 SFTP 文件通道
    ▼
Cloudflare Worker
    │  同源检查、会话票据、静态资源
    ▼
每会话 Durable Object
    │  消耗一次性票据、校验目标地址、运行 SSH 2.0 客户端
    │  Cloudflare TCP Socket
    ▼
公网 SSH 服务器
```

## 支持范围

| 类别 | 当前支持 |
| --- | --- |
| SSH 协议 | SSH 2.0 交互式 Shell、PTY、SFTP v3、窗口尺寸同步、Keepalive |
| 用户认证 | Password、单密码提示 keyboard-interactive、OpenSSH Ed25519/RSA/ECDSA P-256/P-384/P-521，以及 RSA PEM（PKCS#1 / PKCS#8）私钥 |
| 密钥交换 | `curve25519-sha256`、`ecdh-sha2-nistp256` |
| 主机密钥 | Ed25519、ECDSA P-256/P-384/P-521、RSA SHA-2 |
| 加密算法 | AES-128/256-GCM、AES-128/192/256-CTR |
| MAC | HMAC-SHA2-256、HMAC-SHA2-512（AES-GCM 不使用独立 MAC） |
| 终端编码 | UTF-8、GB18030、Big5（取决于浏览器 `TextDecoder` 支持） |

**限制**：只能连接公网 IP 或解析结果全部为公网地址的域名；不支持出站 TCP 25 端口；不支持需要口令解锁的加密私钥、非 RSA 的 PEM/PKCS#8 私钥、SSH Agent、多因素键盘交互认证、SCP、端口转发、ProxyJump、SSH 压缩和会话内 rekey。文件上传与下载单文件限制为 64 MiB，目录删除仅支持空目录。

私钥文件扩展名（`.key`、`.pem` 等）不决定格式。`BEGIN OPENSSH PRIVATE KEY` 是 OpenSSH 格式，`BEGIN RSA PRIVATE KEY` 是 RSA PKCS#1 PEM，`BEGIN PRIVATE KEY` 是 PKCS#8（本项目支持其中的 RSA 密钥）。“未加密”表示私钥本身不需要额外口令解锁，与网站访问密钥和服务器登录密码无关；SSH 网络连接仍然加密。选择“私钥认证”后可直接选择受支持的文件，原文件不需要转换，私钥不加入历史记录。

## 部署教程

[![Deploy to Cloudflare Workers](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?repository=https://github.com/0511150/Workers-SSH_with_-MCP)

点击上方按钮，授权 Cloudflare 读取你的 GitHub 仓库后即可一键创建并部署 Worker。部署平台会自动读取仓库中的 `wrangler.toml`，并以 `npm run deploy` 作为构建命令完成首次构建与发布。

> [!NOTE]
> 一键部署需要你对自己的仓库有写入权限。若尚未 Fork，请先 Fork 到个人 GitHub 账号，部署时在仓库选择列表中选中你 Fork 后的仓库即可。

1. Fork 该项目到用户自己的 GitHub 仓库。
2. 在 `Cloudflare` > `Workers 和 Pages` > `创建应用程序` > `Continue with GitHub` 按钮，选择已 Fork 的项目进行部署。
3. 在"构建命令"（Build Command）一栏中填入 `npm run deploy`。
4. 设置至少 10 位的 `ACCESS_KEY` Secret（推荐 32 位以上），点击"部署"。不需要配置连接超时。

## 配置项

| 名称 | 类型 | 默认值 | 说明 |
| --- | --- | --- | --- |
| `ACCESS_KEY` | Secret | 无 | 至少 10 位，推荐 32 位以上随机密钥。 |
| `AUTH_GUARD` | Durable Object binding | 已配置 | 持久化鉴权失败计数与封禁。 |
| `MCP_SSH` | Durable Object binding | 已配置 | MCP SSH 会话。 |
| `SSH_SESSIONS` | Durable Object binding | 已配置 | 每个连接独立的会话对象。 |
| `ASSETS` | Workers Assets binding | 已配置 | 将 `dist/` 静态资源交给 Worker 提供。 |

原项目的连接超时环境变量已删除，内部固定保留 10 秒 TCP 建连保护，避免无限等待；无用户可配置 timeout 项。

## 自定义域名与 Cloudflare Access

绑定自定义域名：在 Cloudflare Dashboard 的 `Workers & Pages` -> 选择 Worker -> `Settings` -> `Domains & Routes` -> `Add` -> `Custom domain` 中添加。也可在 `wrangler.toml` 中写入：

```toml
routes = [
  { pattern = "ssh.example.com", custom_domain = true }
]
```

确认自定义域名可用后，将 `workers_dev = false` 关闭公网 `workers.dev` 入口。

在 Cloudflare Zero Trust 中为自定义域名创建 Self-hosted Application，配置只允许指定用户、邮箱域或身份提供商访问。WebSocket 使用同一站点的 Access 会话，可保护整个 WebSSH 页面和 API。建议纵深防御：

- 确保所有可访问域名都受 Access 保护。
- 设置 `workers_dev = false`，避免公开 `workers.dev` 地址绕过自定义域名策略。
- 使用 WAF 规则限制异常请求和不需要的访问区域。
- 对会话申请与 WebSocket 建连路径配置限流，并设置告警。
- 验证 Access 策略同时覆盖页面、`/api/session` 与 `/api/ssh`。

## 本地开发

```bash
npm run setup               # 输入密钥长度，生成 .dev.vars
npm run dev                 # 启动 Wrangler，访问 http://localhost:8787
```

如需前端热更新，使用两个终端：

```bash
# 终端 1
npm run build:web
npx wrangler dev

# 终端 2
npm run dev:web    # 访问 http://localhost:5173，Vite 代理 /api 到 8787
```

> [!NOTE]
> 本地 Worker 仍从你的网络连接目标 SSH 服务器，公网目标限制同样生效。不要使用生产 SSH 凭据测试不受信任的代码分支。

## 常用命令

| 命令 | 作用 |
| --- | --- |
| `npm run dev` | 通过 Wrangler 构建前端并启动本地 Worker |
| `npm run dev:web` | 启动 Vite 前端开发服务器 |
| `npm run build:web` | 将前端构建到 `dist/` |
| `npm run typecheck` | 检查 Worker 与前端 TypeScript |
| `npm run check` | 执行全部检查、构建和部署 dry-run |
| `npm run deploy` | 通过 Wrangler 构建前端并部署到 Cloudflare |

## 项目结构

```text
.
├── frontend/                  # xterm.js 前端
│   ├── index.html
│   └── src/
│       ├── main.ts            # 连接管理、xterm、WebSocket 客户端
│       ├── history.ts         # 历史记录归一化与去重
│       ├── history-key.ts     # IndexedDB 中的 AES-GCM 密钥
│       ├── password-crypto.ts # 历史密码 AES-GCM 加解密
│       ├── ui-state.ts        # 连接按钮与面板状态机
│       └── style.css
├── src/
│   ├── backend/
│   │   ├── durable-object.ts  # 会话票据、TCP Socket 与会话生命周期
│   │   ├── security.ts        # 票据、同源与公网目标校验
│   │   ├── session.ts         # SSH 状态机与浏览器消息桥接
│   │   └── sftp-handler.ts    # SFTP 文件操作与传输状态
│   ├── ssh/                   # SSH 协议、KEX、密码学、认证与通道
│   ├── http-security.ts       # HTTPS 与安全响应头
│   ├── types.ts               # Worker 环境、连接消息和 SSH 类型
│   └── worker.ts              # HTTP/API/Assets 入口
├── wrangler.toml              # Worker、Assets、Durable Object 与 migration
└── package.json
```

## API 概览

| 接口 | 方法 | 用途 |
| --- | --- | --- |
| `/api/health` | `GET` | 返回 Worker 与 SSH 功能健康状态 |
| `/api/session` | `POST` | 鉴权后创建一次性会话票据 |
| `/api/ssh?ticket=...&session=...` | `GET` + WebSocket Upgrade | 进入对应 Durable Object 并建立 SSH 会话 |
| `/api/sftp?session=...&token=...` | `GET` + WebSocket Upgrade | 使用一次性附着令牌进入当前会话的文件通道 |
| `/api/processes?session=...&token=...` | `GET` + WebSocket Upgrade | 使用一次性附着令牌进入当前会话的进程监控通道 |

所有 `/api/*` 响应均允许跨站访问，并支持浏览器 `OPTIONS` 预检请求。公网访问控制应由 Cloudflare Access、WAF 和限流策略提供。

## 安全说明

- 一次性票据使用随机密钥和 HMAC-SHA256 签名，绑定请求端 IP、60 秒过期并立即销毁。
- 域名解析后逐个检查公网地址，直接连接已验证 IP，限制 SSRF 与 DNS 重绑定。
- SSH 主机密钥会验证交换签名并计算 `SHA256:` 指纹；没有固定指纹时，认证会暂停等待用户确认。
- 历史密码使用 AES-256-GCM 加密，密钥保存在 IndexedDB 中，不写入 Local Storage。
- 响应设置 CSP、HSTS、`X-Frame-Options`、`X-Content-Type-Options` 等安全头。
- Worker 是实际的 SSH 客户端，密码或私钥会在 Worker 会话内存中被处理。请使用权限最小化的独立账号或密钥。

## 许可证

[Apache License 2.0](LICENSE)

## 致谢

本项目在开发过程中参考了以下优秀开源项目，特此致谢：

- [huashengdun/webssh](https://github.com/huashengdun/webssh) —— 基于 WebSocket 的 WebSSH 终端，本项目前端兼容其 `wssh` JavaScript API。
- [newbietan/CloudSSH](https://github.com/newbietan/CloudSSH) —— Cloudflare Workers 上的 SSH 实现参考。
- [crazypeace/huashengdun-webssh](https://github.com/crazypeace/huashengdun-webssh) —— huashengdun/webssh 的二次开发维护分支，为本项目前端兼容性提供了参考。
