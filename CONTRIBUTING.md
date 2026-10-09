# 贡献指南

面向想改代码、二次开发或发布新版本的人。功能与安装见 [README.md](README.md)；「这个插件是怎么写出来的」的完整心路见 [一行代码不写-复现DSH番茄钟.md](一行代码不写-复现DSH番茄钟.md)。

## 架构

与已安装的第三方插件同构：**host 半 + 预构建 client 半**，两半通过插件自己注册的 HTTP 路由通信。

```
lib/
  index.js          host 半：webServer 路由、状态读写、统计、CSV 导出、会话项目名解析
  client.js         client 半：__ModuleLoader__ 预构建包，计时引擎 + 侧边栏图标 + 面板
  core/
    state.js        规范化、默认值、范围钳制（纯函数，无框架依赖）
    stats.js        统计聚合：按日/周/月/项目/时段、完成率、连续打卡
    csv.js          RFC 4180 + BOM 的 CSV 生成
    store.js        原子 JSON 存储，串行化写入，损坏文件留档
test/               105 项测试
```

### 两半如何通信

| 动作 | 方法 | 路径 |
| --- | --- | --- |
| 读状态 + 统计 + 最近项目 | `state` | `/api/dsh-pomodoro/state`（GET 或 POST） |
| 解析当前会话的项目名候选 | `context` | `/api/dsh-pomodoro/context` |
| 记录一次运行 | `record` | `/api/dsh-pomodoro/record` |
| 改设置 | `settings` | `/api/dsh-pomodoro/settings` |
| 删除一条 | `delete` | `/api/dsh-pomodoro/delete` |
| 清空（全部或区间） | `clear` | `/api/dsh-pomodoro/clear` |
| 导出 CSV | `export` | `/api/dsh-pomodoro/export?from=&to=`（GET，便于直接下载） |

除 `state` / `export` 外都是 POST-only，避免浏览器或代理预取造成写入。

### 界面的挂载点

| 插槽 | 用途 |
| --- | --- |
| `sidebar.panellist` | 侧边栏单色番茄图标，其 `id` 同时作为 `main` 的键 |
| `main`（key `pomodoro`） | 独立面板（计时 / 统计 / 记录 / 设置四页） |
| `conversation.input.dock` | 记录当前会话 ID（渲染为 `null`），供项目名解析使用 |
| `conversation.composer.dock`（order `-10`） | 状态栏计时行 |

`order` 的语义已核对过运行时实现：列表槽位按 `sort((a, b) => a.order - b.order)` 排序，所以负值即排在已装条目之前。

### 关键设计取舍

- **时钟在浏览器半**：只有浏览器知道用户是否在看，也只有它能跨标签页感知性能节流；host 只负责持久化。
- **运行状态镜像到 localStorage**：进行中的运行只存本地，完成/中断时才写入 host，避免 host 高频心跳。
- **热力图序列由 host 生成**：稠密网格（含空缺日、月份标签、分级基准）在 host 侧一次算好，client 只负责上色——"哪些天算空缺"只有一个权威定义，也便于测试。
- **零运行时依赖**：CSV 用自带生成器，存储用 `node:` 内置模块，因此插件可整包复制、无需 postinstall。
- **JSON 而非 SQLite**：番茄钟记录量级是每年几千条，单文件 JSON 足够快，用户可直接打开查看、备份、手改。

## 本地开发

```powershell
# 普通终端 / CI：全部测试（Node 原生并行跑多文件）
npm test

# DSH 会话内（沙箱不允许 spawn 子进程，需切到单进程隔离）：
npm run test:sandbox
```

两个命令等价，只是 `test:sandbox` 会加 `--experimental-test-isolation=none`——因为在 DSH 里 pwsh 是沙箱化的、node 不能 fork。你在 DSH 会话里做二次开发就用后者，普通终端和 GitHub Actions 就用前者。

测试分四层，共 105 项：

- `test/core.test.js` — 纯函数：规范化、统计口径（完成/中断/放弃/跳过的分离记账）、中断原因聚合、CSV 转义与 BOM、热力图网格。
- `test/store.test.js` — 原子写入、并发串行化、损坏文件留档、条数上限。
- `test/host.test.js` — 驱动真实路由处理真实请求/响应流。
- `test/client.test.js` — 通过迷你 React 运行时**真实求值并挂载 `lib/client.js`**，每个 host 调用都走真实路由，覆盖两半之间的完整链路。

`test/helpers/` 下的迷你 React 与 DOM 只实现本插件用到的 API，不是通用实现。

### 改动生效范围：client 半热重载，host 半需重启

| 改动位置 | 生效方式 |
| --- | --- |
| `lib/client.js`（界面、图标、状态栏、热力图绘制） | 页面刷新即可；`patchReload: live` 下通常自动热重载 |
| `lib/index.js` 与 `lib/core/**`（路由、存储、统计、CSV 结构） | **必须重启 DSH**：host 半是启动时载入的 Node 模块 |

典型症状：状态栏/图标变了，但新设置项不存在、统计里没有热力图字段——这就是 host 半还是旧代码。两者都改过时请直接重启，别只刷新页面。

### 安装后校验

```powershell
# 1) 复刻 DSH 加载器的判定条件，检查已安装副本
npm run check:install

# 2) 用真实的 @deepseek-ai/cordis 挂载 host 半，验证服务注入、路由与卸载
npm run check:cordis
```

`check:install` 会逐项核对：bundle 已登记、host 半可导入且导出 `name`/`apply`/`inject`、`dsh.client.platform` 为 `web`、`exports["./client"]` 可解析、client bundle 是纯脚本且每个 `require()` 都是平台种子词或已声明的 inject、patch 行名与包名一致，最后**逐字节比对已安装 `lib/` 与源码**——这一步能抓出"文件都在、结构也对，但装的是旧版本"这种其他检查看不见的失效。

这两条脚本存在的原因是：插件无法在会话内通过重启 DSH 来验证（重启会终止当前会话），所以改为在重启前把加载器的判定条件全部跑一遍。

## 发布到 npm（维护者）

包名是 scoped 的 `@yongfanbeta/dsh-pomodoro`。首次发布是一次性的，之后每次发版只有三步。

**一次性准备**

1. 在 <https://www.npmjs.com> 用 `yongfanbeta` 注册（或确认已有）账号，并**开启 Two-Factor Authentication**；publish 权限设为需要 OTP 或 trusted publisher。
2. 本机登录：`npm login`（registry 是 `registry.npmjs.org`）。
3. `npm profile get` 应打印 `yongfanbeta`。

**每次发布**

```powershell
# 1) 先升版本号：package.json 的 "version"（0.x 期间破坏性改动升 minor，其余升 patch）
# 2) 在 CHANGELOG.md 补一段对应版本
# 3) 发布——prepublishOnly 钩子会先自动跑 npm test，测试不过就发不出去
npm publish
```

`publishConfig.access` 已在 `package.json` 写成 `public`，所以 scoped 包默认就是公开的，`npm publish` 不需要额外参数。

**发布后**

- 打 tag：`git tag v0.1.0 && git push origin v0.1.0`，并在 GitHub 建对应 Release（写清适配的 DSH 版本）。
- `npm view @yongfanbeta/dsh-pomodoro versions` 应能看到新版本。

**⚠️ scoped 名的已知不确定点**

`@scope/name` 里的斜杠，官方 `dsh plugin` CLI 与 DSH 的 bundle 解析器在不同版本上的处理不一定一致。首次发版后，**务必**在一台装了 DSH 的干净机器上实跑一次 `dsh plugin --profile web add @yongfanbeta/dsh-pomodoro` 确认加载成功；若 CLI 拒收斜杠名，把包名换成非作用域的独特名（届时 `package.json`、`cordis.patch.yml`、`lib/index.js` 的 `name`、`lib/client.js` 的 `id`、两个安装脚本与两处校验常量需同步回改，`npm run check:install` 会立刻指出没对齐的那一处）。

## 文件清单

```
dsh-pomodoro/
├── package.json              包清单（dsh.bundle.patch + dsh.client.platform）
├── cordis.patch.yml          把插件插入 profile 的行
├── README.md / CHANGELOG.md / CONTRIBUTING.md / LICENSE
├── docs/images/              README 截图
├── lib/                      host 半 + client 半 + core/ 纯函数
├── scripts/                  install.ps1 / install.sh / check-install.mjs / verify-cordis-load.mjs
└── test/                     105 项测试
```
