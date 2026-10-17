# 掘地出笼 · 黑门桌游室

本地可玩的多人桌游 MVP，参考指定网站的深色金棕桌游室风格，依据《Dig Your Way Out》官方核心规则简化改编。前端 React + TypeScript + Vite；后端 Node.js + TypeScript + Express；实时通信 Socket.IO；存档使用 PostgreSQL。

## 立即试玩（当前这台 Windows 电脑）

1. 双击本目录的 **`start.cmd`**。目录内已准备好便携版 Node.js、依赖和构建产物。
2. 等终端显示启动成功，在浏览器打开 **http://127.0.0.1:3000**。
3. 输入代号，保留默认的 3 名电脑，创建房间，再点击“开始越狱”。
4. 停止时在终端按 Ctrl+C，等程序退出后再关闭窗口。重新打开后存档仍在。

两个真人本机测试：使用两个浏览器，或普通窗口与无痕窗口。房主选择 0 名电脑，把房间码交给另一人。**同一浏览器普通标签页共享身份存储，不适合模拟两名不同玩家。**

本地嵌入式 PostgreSQL（PGlite）默认把数据写入 `data/`，不需要单独安装数据库。独立 PostgreSQL 通过 `DATABASE_URL` 启用，表结构会自动初始化。二者使用同一套 SQL 表和事务保存逻辑，不会自动互相迁移数据。

## 已实现

- 2–6 人房间、6 位房间码、邀请链接、房主开局、电脑补位、终局后再开一局。
- 六个地点；每回合两次行动；普通/谨慎移动；搜刮；制作；香烟交易；偷汤匙；挖掘；伤势与治疗。
- 同地点勒索、交出工具、交替出武器、认输/超时战斗结算。
- 私有手牌、公开进度、行动日志、超额手牌选择弃置、牌堆回收。
- 回合超时、自动重连、刷新恢复身份与快照、电脑自动行动、提示音开关。
- 服务端验证输入和规则；房间串行提交；修订号防过期操作；持久化请求 ID 防重复执行。
- 状态快照、事件日志和对局结果以事务一起落库；写入失败时不发布新的状态。
- 本地存档进程锁，防止重复启动写坏存档；进程重启从数据库恢复。
- 桌面和手机布局；随代码提供的 SVG/图标，无远程图片、字体或 CDN 依赖。

## 规则与简化范围

规则来源：[出版商 Borderline Editions 官方英文规则书](https://borderlineeditions.com/digyourwayout/DYWO_RULEBOOK_EN.pdf)，查阅日期 2026-10-17。作者 David Simide，原作插画 Mihajlo Dimitrievski。本项目的图形为代码绘制及 Lucide 图标，未复制原作卡图。界面风格参考用户提供的 http://120.46.214.10:8080/（骷髅宣言桌游站），未使用其源码。

保留原作核心行动框架：每回合最多 2 次行动、搜刮与勒索每回合各限一次、同区勒索、牢房挖掘、地点专属行动、伤势限制、手牌上限 10、2–3/4/5–6 人目标分别 12/10/8 分。

本 MVP 是**简化改编**，不是完整官方数字版：

- 不含帮派、背景技能、Michel/Michelle、团队模式及 Dig In 扩展。
- 材料牌、配方、交易价值、卡牌数量和普通移动骰表采用本版本配置，见 `shared/game.ts`。
- 汤匙/镐头/铁锹的自定义分值为 1/2/3；一张工具只能挖一次，留在玩家地道中，不回到供应。
- 不包含原版全部行动牌；仅保留简化急救包。
- 每回合默认 90 秒；战斗回应和超额弃牌为 30 秒。超时自动处理，防止离线卡住对局。
- 任意在线真人都可与电脑对战，但不提供热座模式、旁观、踢人或中途入局。

游戏内“游戏规则”可随时查看简要教程。

## 开发与构建

需要 Node.js 22.12+（本机便携版为 22.23.3）。将 Node.js 放入 PATH 后执行：

```powershell
npm ci
npm run dev
```

前后端同源运行在 http://127.0.0.1:3000，开发模式由后端挂载 Vite 中间件，不需要开两个端口。

```powershell
npm run build
npm start
```

生产构建会生成 `dist/` 和 `build-server/`。`npm start` 直接运行编译后的 JavaScript。修改代码后先重新执行 `npm run build`；`start.cmd` 只会在产物不存在时自动构建。

本机尚未配置全局 Node 时，可先在 PowerShell 执行：

```powershell
$env:PATH = (Join-Path $PWD '.tools\node-v22.23.3-win-x64') + ';' + $env:PATH
```

## 配置

复制 `.env.example` 为 `.env` 后按需修改。

| 变量 | 默认值 | 含义 |
|---|---|---|
| `PORT` | `3000` | HTTP 和 Socket.IO 共用端口 |
| `HOST` | `127.0.0.1` | 本地监听地址；局域网测试设为 `0.0.0.0` |
| `DATABASE_URL` | 未设置 | 未设置则用 PGlite；设置则连接独立 PostgreSQL |
| `DATA_DIR` | `data` | 嵌入式 PostgreSQL 存档目录 |
| `TURN_SECONDS` | `90` | 回合时间，15–3600 秒 |
| `ALLOWED_ORIGINS` | 同源 | 允许的浏览器 Origin，多个用逗号分隔 |

局域网测试：设置 `HOST=0.0.0.0` 并重启，其他设备访问 `http://这台电脑的局域网IP:3000`。系统防火墙需允许本地网络访问该端口。邀请链接以房主当前访问地址生成，因此房主也应使用局域网 IP 打开网页。

独立 PostgreSQL 示例：

```dotenv
DATABASE_URL=postgresql://digout:your-password@127.0.0.1:5432/digout
```

数据库需预先存在，连接用户需有建表权限。仓库包含锁文件 `package-lock.json`，使用 `npm ci` 重现依赖版本。

## Docker + PostgreSQL

在已安装 Docker Compose 的机器上：

```sh
docker compose up --build -d
```

浏览器访问 http://127.0.0.1:3000。Compose 会先启动 PostgreSQL 17 并等待健康检查，再启动应用。默认只绑定本地地址；数据库没有暴露外部端口。默认密码仅供本地开发，公开部署前在 `.env` 配置自己的 `POSTGRES_PASSWORD`（连接 URL 中使用可直接编码的密码），并按实际域名设置 `ALLOWED_ORIGINS`。

本 MVP 按**单个业务服务实例**设计，暂未接 Redis。上线后使用反向代理提供 HTTPS 和 WebSocket 转发，启用数据库备份，再按需要补充账号系统、管理功能和容量验证。不要直接启动多个应用实例共用同一数据库。

## 部署到华为云 ECS

服务器建议：**2 核 4GiB 起**（构建时要装依赖并编译前端，2GiB 内存容易在 `npm ci` 阶段被 OOM 杀掉），系统镜像任选主流 Linux（CentOS/Ubuntu 均可，脚本会自动装 Docker），带宽 1–5 Mbit/s 足够 6 人房间使用，系统盘 40GiB 以上。

**默认对外端口是 8080 而不是 80/443**：中国大陆云服务器通过 80/443 对外服务需要完成域名 ICP 备案，用 `WEB_PORT` 可改成其他端口（如 3000）。

部署步骤：

1. 在控制台的**安全组**里，入方向放行待使用的端口（默认 TCP 8080，源 `0.0.0.0/0`）。华为云默认只开 22，不放行公网访问会一直超时。
2. 把源码传到服务器。本机已打好源码包（排除了 `node_modules` 和构建产物）：

   ```powershell
   scp E:\digout-source.tgz root@<公网IP>:/opt/
   ```

3. 在服务器上解压并执行一键脚本：

   ```sh
   mkdir -p /opt/digout && tar -xzf /opt/digout-source.tgz -C /opt/digout --strip-components=1
   cd /opt/digout && bash scripts/ecs-bootstrap.sh 8080
   ```

   脚本会自动完成：安装 Docker 与 Compose 插件 → 配置可用的镜像加速（华为云 ECS 直连 Docker Hub 普遍超时，这一步是能否构建成功的关键）→ 生成带随机数据库密码的 `.env` → 构建镜像并启动 → 自检健康检查、首页和 Socket.IO 握手。

   首次构建需要下载 `node:22-bookworm-slim` 和 `postgres:17-alpine` 镜像层并安装依赖，约 **5–10 分钟**，建议放进后台执行避免 SSH 超时：

   ```sh
   nohup bash scripts/ecs-bootstrap.sh 8080 > /opt/deploy.log 2>&1 &
   ```

4. 脚本结束后用浏览器打开 `http://<公网IP>:8080`。若打不开，**先查安全组**，再看 `docker compose logs app`。

常用运维命令（在 `/opt/digout` 下）：

```sh
docker compose ps            # 容器状态
docker compose logs -f app   # 应用日志
docker compose restart app   # 重启应用
docker compose down          # 停止，数据卷保留
```

上线后注意：

- 本 MVP 按**单个业务服务实例**设计，不要扩容到多个副本共用同一个数据库。
- 数据库在 `pgdata` 卷里，定期备份（卷名先由 `docker volume ls` 确认，通常形如 `digout_pgdata`）：
  `docker run --rm -v digout_pgdata:/d -v $PWD:/b alpine tar -czf /b/pgdata-backup.tgz -C /d .`
- 需要 HTTPS 和域名时，在前面加一层 Nginx/Caddy 做反向代理，并转发 WebSocket（`/socket.io/`），同时把 `ALLOWED_ORIGINS` 设为真实站点地址。

## 测试

```powershell
npm test
```

覆盖规则、随机完整对局模拟、鉴权、输入校验、幂等重试、并发提交、并发入房、存储故障不改变状态、重连、重启恢复和事务结算。

浏览器测试使用独立无头 Edge（不访问你的浏览器配置或既有标签页），先启动应用，再执行：

```powershell
npm run test:e2e
```

未安装 Edge 的机器，可安装 Playwright Chromium，并将 `playwright.config.ts` 的 `channel` 设置改为对应浏览器。`TEST_BASE_URL` 可指定测试服务地址，默认 http://127.0.0.1:3000。测试会在该服务创建独立房间，建议指向测试存档。

测试结果与截图见 `TEST_REPORT.md` 和 `artifacts/`。本地实际验证的是 PGlite 模式；本机没有 Docker/独立 PostgreSQL 服务，Compose 部署与独立 PostgreSQL 连接仍需在目标部署环境验证。

## 代码导航

```text
client/main.tsx          大厅、房间、棋盘、手牌、操作和重连
client/style.css         深色桌游室视觉与响应式布局
shared/game.ts           公共类型、卡牌、地点、配方和骰表
server/engine.ts         可独立测试的服务端规则引擎
server/validation.ts     Zod 消息校验
server/app.ts            HTTP、Socket.IO、房间队列、计时与电脑
server/store.ts          PostgreSQL / PGlite 事务与存档锁
server/index.ts          环境配置与服务生命周期
tests/                  规则、接口、持久化和浏览器测试
```

同目录原有的 `engine.py` 与 `server.py` 已保留，当前项目不使用这两份 Python 文件。
