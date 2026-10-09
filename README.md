# dsh-pomodoro

DeepSeek Harness 番茄钟插件：经典 25/5/15 计时，可关联当前会话任务或手动输入项目名，自带独立统计面板，数据本地持久化并支持导出 CSV（Excel 双击可直接打开）。

> **非官方第三方插件**。本项目独立于 DeepSeek / DSH 官方，为 DSH（DeepSeek Harness）扩展一个番茄钟；插件问题请开在本仓库，不要报到 DSH 官方。

## 界面预览

> 📷 截图待补充。建议放三张：计时面板、全年热力图统计页、状态栏药丸 + 完成卡片。截好后存到 `docs/` 下，把下面的注释取消并核对文件名即可。

<!--
| 计时面板 | 全年热力图 | 状态栏药丸 |
| --- | --- | --- |
| ![计时面板](docs/screenshot-timer.png) | ![热力图](docs/screenshot-stats.png) | ![状态栏](docs/screenshot-statusbar.png) |
-->

想了解这个插件**是怎么写的**（DSH 插件的进程边界、中断记账、挂载点、装错 profile 的坑、两把自检尺），见 [一行代码不写-复现DSH番茄钟.md](一行代码不写-复现DSH番茄钟.md)。

## 前置条件

这是 DSH 的插件，不是独立应用。装它之前你需要：

1. **已安装 DSH（DeepSeek Harness）并至少成功运行过一次**——插件是往 DSH 的 profile 里注册的，DSH 没跑过就没有可写入的 profile。
2. **Node.js ≥ 20**（跑测试 / 安装脚本的 JSON 处理用）。
3. 平台：
   - **Windows**：自带 `pwsh`，直接用 `scripts/install.ps1`。
   - **macOS / Linux**：用 `scripts/install.sh`（只需 `bash` + `node`，不依赖 PowerShell），或按下面的手动方式安装。

## 功能

### 1. 基本番茄钟

- 专注 25 分钟 / 短休息 5 分钟 / 长休息 15 分钟，三者时长与"每几个番茄进入长休息"都可在设置里改。
- 开始、暂停、继续、暂停并记录中断、跳过、重置、放弃这个番茄。
- 倒计时以截止时间戳为准，不累加漂移；标签页后台节流后回到前台会自动校正。
- **专注结束会自动开始休息倒计时并弹通知卡片**；休息结束同样弹卡片，但**不会自动开始下一个专注**（开始 25 分钟的新承诺应当由你决定）。
- 可选提示音与系统通知。
- **刷新或重开页面不会丢失正在进行的番茄**：进行中的运行会镜像到浏览器本地存储，重新载入后按真实时间恢复；如果关闭期间已到点，会按完成计入。
- **暂停不丢时间**：计时按"片段"累加，暂停期间不计入专注时长，继续后接着算。

### 2. 关联当前任务 / 手动输入项目名

- 在对话中打开某个会话后，侧边栏图标对应的面板会自动解析该会话的**工作区名**与**会话标题**，作为一键可选的候选项。
- 也可以从**最近使用的项目**里挑，或随时手动输入任意项目名。
- 都没选时使用设置里的默认项目名（默认「未命名项目」）。
- 每条记录都会保存项目名、来源（会话 / 工作区 / 最近 / 手动 / 默认）与关联的会话 ID，便于日后核对。

### 3. 独立统计界面

侧边栏会出现一个番茄图标，点击即进入**独立的整屏面板**（不是浮动小窗），分为四个标签页：

- **计时**：圆盘倒计时、进度条、当前项目与控制按钮。
- **统计**：今日 / 本周 / 本月 / 累计四个口径的完成数与专注时长，连续打卡天数，**全年热力图（近 365 天）**，本周每日专注与时段分布（同一行），项目分布表。
- **记录**：逐条明细（时间、项目、阶段、时长、状态），可单条删除或清空全部，并在此导出 CSV。
- **设置**：时长、行为开关、显示位置、默认项目名，以及数据文件路径。

统计口径明确区分**完成 / 中断 / 跳过**：中断不计入完成数，所以完成率是可信的。

#### 全年热力图

仿 GitHub 贡献图：53 个周列 × 7 行，覆盖最近 365 天。

- **绿色分级**，与 GitHub 一致。用平台自带的 `--dsw-static-green-500` 作为色相，靠透明度分 4 级与卡面混合，所以同一份定义在浅色主题下是薄荷绿、在深色主题下是森林绿。
- 网格是**稠密**的——没有记录的日子也占一格（空色），因为热力图的信息量一半来自空缺。
- 分级基准是**窗口内最忙的一天**，因此个人基线一眼可读。
- 悬停显示「日期：N 个番茄 · 时长」；今天之后的日子画成**空心描边**（"尚未到来"而非"零"），且不计入统计。
- 底部图例给出活跃天数、窗口内总番茄数与单日最高。
- 日期推进用 `setDate` 而非固定加 86400000 毫秒，跨越夏令时切换也不会重复或跳过某一天。

### 4. 状态栏计时

输入框下方的常驻状态栏会有**一个药丸**（**位于「会话统计」之前**）：

- 收起时**只有番茄图标 + 跳动的时间**，与该行现有的「会话统计」药丸密度一致；没有状态点、没有项目名、没有内联按钮。
- 运行时数字有轻微脉动（`@keyframes`），静止的数字在长时间专注里会像卡住；已提供 `prefers-reduced-motion` 关闭。
- **点一下展开详情**：当前项目、当前阶段与剩余时间、今日已专注的番茄数与时长、本轮已完成数，以及开始/暂停/放弃按钮。点外部或按 Esc 收起。
- 可在设置 → 显示位置里整体关闭。

### 5. 完成通知与自动休息

一个阶段结束时，界面**右下角**会弹出一张卡片（`shell.overlay` 浮层，所以在任何面板下都能看到）：

**专注结束** → 卡片显示「专注完成 🍅」、完成的项目、本轮是否中断过，以及**下一个休息阶段的名字与实时倒计时**。此时 5 分钟（或 15 分钟长休息）**已经自动开始**，卡片里的数字就是它的倒计时。

**休息结束** → 卡片显示「休息结束」与即将回到的专注项目，并给出 25 分钟倒计时。但**默认不会自动开始**：卡片上是「知道了」与一个手动开始按钮。

长休息按同一个逻辑组织：每 `longBreakEvery`（默认 4）个完成的番茄之后，`nextPhaseAfter` 返回 `long-break`，因此卡片会显示「长休息 15 分钟」并启动 15 分钟倒计时。

设计要点：

- 卡片**永不自动消失**——会自动消失的通知恰好是你离开屏幕时会错过的那种。只能手动关闭。
- 两个开关分开：`autoStartBreak`（默认开）控制专注结束是否直接进入休息；`autoStartNext`（默认关）控制休息结束是否直接开始下一个专注。
- `cardEnabled` 可整体关闭卡片；关闭后计时逻辑不受影响。
- 若专注是在**页面关闭期间**到点的，同样会弹卡片，并尊重上面的自动开始设置。

### 6. 中断记录是如何考虑的

**一个番茄只有在真正走到终点时才算「完成」**；中断不计入完成数，否则完成率就没有意义。关键在于把**中断事件**与**番茄结局**分开记账：

| 动作 | 记录的状态 | 计入完成数 | 这个番茄还能继续吗 | 推进长休息 |
| --- | --- | --- | --- | --- |
| 自然走到 0（含关页期间到点） | `completed` | ✅ | — | ✅ |
| **暂停并记录中断** | `interrupted` | ❌ | ✅ **能**，点「继续」接着专注 | ❌（未结束） |
| 放弃这个番茄 | `aborted` | ❌ | ❌（回到同一阶段重来） | ❌ |
| 跳过 | `skipped` | ❌ | ❌ | ❌ |
| 重置 | **不记录** | ❌ | — | ❌ |

**中断原因**：点「暂停并记录中断」会弹出原因选择——预设 7 项（被叫走 / 开会 / 临时任务 / 接电话回消息 / 分心 / 到点吃饭休息 / 其他）一键选，也可以自己写。确认后计时暂停、中断被记录，**但番茄保留**：点「继续」接着专注，最终完成时仍算一个完成的番茄。

为什么 `interrupted` 必须独立于 `aborted`：

- 一个被中断后又完成的番茄，如果中断记成 `aborted`，就会**同时**出现一条「中断」和一条「完成」，完成率被腰斩（50% 而不是 100%）。
- 中断事件**不计入专注时长**：那条完成记录已经拥有完整的 25 分钟，重复计算会让「今天专注了多久」超过实际时钟。
- 因此统计里有三个不同的数：`中断`（含已继续的，`interruptions`）、`放弃`（`aborted`）、`跳过`（`skipped`）。完成率 = 完成 ÷ (完成 + 放弃 + 跳过)，**只按已结束的番茄**计算。

其他规则：

- **30 秒地板**：专注不足 30 秒就中断，视为误触，不写任何记录，避免日志被刷满。
- **中断保留真实时长**：中断事件记录的是**当时已经专注了多久**（如 6 分钟）。
- **原因可统计**：中断原因直接作为**记录明细表里的一列**（中断行带淡底色与原因标签），CSV 也含独立的「中断原因」区块与「中断原因」列，并把**没记录原因**的历史记录单列一行（`已记录=否`），以免把"没问过"误读成"其他"。
- **取消（Esc / 「取消」）是真正的空操作**：计时继续跑，不暂停、不记录——反悔不该偷走你的专注时间。
- 中断记录可在设置里整体关闭（`recordAborted`）。

### 7. 数据本地保存与导出

- 数据保存在本机 `${DSH_HOME:-~/.dsh}/storages/pomodoro/state.json`，一份**全局共享**的日志，跨会话、跨工作区都能看到同一份统计。
- 写入是**原子**的（临时文件 + rename）并串行化，两个并发写入不会把文件写坏。
- 文件损坏时不会被静默丢弃，而是重命名为 `state.json.corrupt-<时间戳>` 留档，然后从空日志继续。
- **导出 CSV**：带 UTF-8 BOM、CRLF 换行、RFC 4180 转义，Excel 双击即可正确显示中文。文件含五个区块：汇总指标、按日聚合、按项目聚合、**中断原因**、逐条明细（含「中断原因」列）。可选择起止日期导出，留空即全部。

### 8. 其他

- **侧边栏图标是番茄线性图标**，与平台上「插件」「日程」「会话统计」的图标同一套语言：16×16 viewBox、`fill="none"`、1px `currentColor` 描边。它**不显示倒计时**——那个位置（16px）放数字根本看不清；剩余时间在状态栏药丸和面板圆盘里。专注进行中时果身会填充，可在设置里关掉。
- 整个标记只用 `currentColor` 与描边，不依赖任何背景色，因此自动跟随侧边栏的选中/悬停态与深浅主题。
- 面板渲染不会写任何数据；只有点开始/停止/改设置等明确动作才落盘。

## 安装

> npm 包名：`@yongfanbeta/dsh-pomodoro`。插件的 Cordis id / bundle 行名 / npm 包名三者必须一致，所以任何"装"的动作都用带 scope 的全名。

### 路径 A（推荐）：官方 `dsh plugin` CLI

DSH 自带插件安装器，从 npm 直接装：

```powershell
dsh plugin --profile web add @yongfanbeta/dsh-pomodoro
dsh web   # 或重启桌面端 profile
```

装完左侧边栏出现 🍅 图标即生效。卸载：`dsh plugin --profile web remove @yongfanbeta/dsh-pomodoro`。

> ⚠️ 若 CLI 拒绝带 `/` 的 scoped 名（DSH 版本相关），走下面的"路径 B"绕开。

### 路径 B：从源码装

克隆本仓库后，在插件目录里执行对应平台的脚本：

```powershell
# Windows（PowerShell）：自动定位活动 profile 并复制
pwsh -File scripts/install.ps1
```

```bash
# macOS / Linux：同样自动定位 profile，改 profile JSON 时调用 node，不依赖 pwsh
bash scripts/install.sh
```

两个脚本做的是同一件事（scoped 路径会规范化为 `node_modules/@yongfanbeta/dsh-pomodoro`）：

1. 把插件目录复制到 `<profile>/node_modules/@yongfanbeta/dsh-pomodoro`。
2. 在 `<profile>/package.json` 的 `dsh.profile.bundles` 数组末尾加入 `@yongfanbeta/dsh-pomodoro`，并同步写 `dependencies`，让市场"已安装"页也能看到。
3. 打印下一步：重启 DSH（`dsh web` / 桌面端）。

### ⚠️ 装错 profile 是唯一真正会"装了却看不见"的原因

DSH 有多个 profile（`~/.dsh/profiles/<name>/`），**只有正在运行的那个会加载插件**。往另一个 profile 里装，脚本会开心地报告成功，重启后却什么都没有。

脚本按这个优先级选 profile：

1. `-Profile <name>` 显式指定；
2. `$env:DSH_PROFILE` —— **在 DSH 会话内执行时，这就是正在运行的 profile**（首选）；
3. `$env:DSH_PROFILE_DIR` 的目录名；
4. 都没有时才回退猜测（优先 `desktop`，因为那是你实际看到的界面）。

因此**请在 DSH 会话内运行安装脚本**，或先确认：

```powershell
$env:DSH_PROFILE      # 正在运行的 profile，例如 desktop
$env:DSH_PROFILE_DIR  # 其目录
```

装完用 `npm run check:install` 复核——它会校验 `$DSH_PROFILE` 指向的那个 profile，并明确打印 `profile : <name>`，装错 profile 时会直接报"插件不在 bundles 里"。如果它显示的不是你正在用的 profile，就说明装错了地方。

也可以手动安装：

```jsonc
// <profile>/package.json
{
  "dsh": {
    "profile": {
      "bundles": [
        // ...
        "@yongfanbeta/dsh-pomodoro"
      ]
    }
  }
}
```

卸载：把 `@yongfanbeta/dsh-pomodoro` 从 `bundles` 里删掉，并删除 `<profile>/node_modules/@yongfanbeta/dsh-pomodoro`（或用 `pwsh -File scripts/install.ps1 -Profile <name> -Uninstall` / `bash scripts/install.sh --uninstall`）。数据文件会保留，如需清除请手动删除 `storages/pomodoro/`。

## 使用

1. 重启 DSH 后，左侧边栏出现番茄图标。
2. 点图标进入面板的「计时」页。
3. 若要关联当前任务：先打开对应会话，回到面板点候选项即可；也可点「手动输入」。
4. 点「开始专注」。焦点落在自己选择的项目上。
5. 到点后会自动记录并切到休息阶段（若不希望自动开始休息，保持设置里的自动开始为关闭）。
6. 在「统计」页看全年热力图与汇总，「记录」页导出 CSV。
7. 输入框下方的状态栏也会显示倒计时，可直接在那里开始 / 暂停 / 停止。

### ⚠️ 改动生效范围：client 半热重载，host 半需重启

两半的更新时机不同，遇到"改了没生效"时先看这里：

| 改动位置 | 生效方式 |
| --- | --- |
| `lib/client.js`（界面、图标、状态栏、热力图绘制） | 页面刷新即可；`patchReload: live` 下通常自动热重载 |
| `lib/index.js` 与 `lib/core/**`（路由、存储、统计、CSV 结构） | **必须重启 DSH**：host 半是启动时载入的 Node 模块 |

典型症状：状态栏/图标变了，但新设置项不存在、统计里没有热力图字段——这就是 host 半还是旧代码。两者都改过时请直接重启，别只刷新页面。

## 架构

与已安装的第三方插件同构：**host 半 + 预构建 client 半**，两半通过插件自己注册的 HTTP 路由通信。

```
lib/
  index.js          host 半：webServer 路由、状态读写、统计、CSV 导出、会话项目名解析
  client.js         client 半：__ModuleLoader__ 预构建包，计时引擎 + 侧边栏图标 + 独立面板
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
| `main`（key `pomodoro`） | 独立整屏面板 |
| `conversation.input.dock` | 记录当前会话 ID（渲染为 `null`），供项目名解析使用 |
| `conversation.composer.dock`（order `-10`） | 状态栏计时行，排在「会话统计」（order `0`）之前 |

`order` 的语义已核对过运行时实现：列表槽位按 `sort((a, b) => a.order - b.order)` 排序，所以负值即排在已装条目之前。

### 设计取舍

- **时钟在浏览器半**：只有浏览器知道用户是否在看，也只有它能跨标签页感知性能节流；host 只负责持久化。
- **运行状态镜像到 localStorage**：host 每 250ms 收一次心跳是浪费，因此进行中的运行只存本地，完成/中断时才写入 host。
- **热力图序列由 host 生成**：稠密的 371 天网格（含空缺日、月份标签、分级基准）在 host 侧一次算好，client 只负责上色——这样"哪些天算空缺"只有一个权威定义，也便于测试。
- **零运行时依赖**：不引入 xlsx 或其他库，CSV 用自带生成器（选中方案即"CSV + BOM"），存储用 `node:` 内置模块，因此插件可整包复制、无需 postinstall。
- **JSON 而非 SQLite**：番茄钟的记录量级是每年几千条，单文件 JSON 足够快，而且用户可以直接打开查看、备份和手改。
- **图标不承载文字**：侧边栏格位只有 16–18px，塞倒计时必然糊成一团。图标只负责"识别"，时间交给有空间的状态栏与面板——这是需求里"太小了看不清"的直接修法。

## 开发

```powershell
# 全部测试（Node 24；沙箱内需要 --experimental-test-isolation=none）
npm test

# 等价于：
node --test --experimental-test-isolation=none test/core.test.js test/store.test.js test/host.test.js test/client.test.js
```

测试分四层，共 105 项：

- `test/core.test.js` — 纯函数：规范化、统计口径（完成/中断/放弃/跳过的分离记账）、中断原因聚合、CSV 转义与 BOM、热力图网格。
- `test/store.test.js` — 原子写入、并发串行化、损坏文件留档、条数上限。
- `test/host.test.js` — 驱动真实路由处理真实请求/响应流。
- `test/client.test.js` — 通过迷你 React 运行时**真实求值并挂载 `lib/client.js`**，每个 host 调用都走真实路由，覆盖两半之间的完整链路。包括：**暂停并记录中断后番茄仍可继续且只算一个完成**、中断原因日志与占比、完成卡片与自动休息、取消是空操作、长休息节奏、刷新恢复、导出、热力图、图标与槽位顺序。

`test/helpers/` 下的迷你 React 与 DOM 只实现本插件用到的 API，不是通用实现。

### 安装后校验

```powershell
# 1) 复刻 DSH 加载器的判定条件，检查已安装副本
npm run check:install

# 2) 用真实的 @deepseek-ai/cordis 挂载 host 半，验证服务注入、路由与卸载
npm run check:cordis
```

`check:install` 会逐项核对：bundle 已登记、host 半可导入且导出 `name`/`apply`/`inject`、`dsh.client.platform` 为 `web`、`exports["./client"]` 可解析、client bundle 是纯脚本且每个 `require()` 都是平台种子词或已声明的 inject、patch 行名与包名一致，最后**逐字节比对已安装 `lib/` 与源码**——这一步能抓出"文件都在、结构也对，但装的是旧版本"这种其他检查看不见的失效。

这两条脚本存在的原因是：插件无法在会话内通过重启 DSH 来验证（重启会终止当前会话），所以改为在重启前把加载器的判定条件全部跑一遍。

## 文件清单

```
dsh-pomodoro/
├── package.json              包清单（dsh.bundle.patch + dsh.client.platform）
├── cordis.patch.yml          把插件插入 profile 的行
├── README.md
├── LICENSE
├── lib/
│   ├── index.js              host 半
│   ├── client.js             client 半（预构建 ModuleLoader 包）
│   └── core/
│       ├── state.js          规范化 / 默认值 / 范围钳制
│       ├── stats.js          统计聚合
│       ├── csv.js            CSV 生成
│       └── store.js          原子 JSON 存储
├── scripts/
│   ├── install.ps1           安装 / 卸载（-Uninstall）
│   ├── check-install.mjs     加载契约 + 源码一致性校验
│   └── verify-cordis-load.mjs 真实 Cordis 挂载验证
└── test/                     105 项测试
```

## 已知限制

- 提示音依赖浏览器 `AudioContext`，需要用户先与页面交互过（浏览器自动播放策略）；系统通知需要授予权限，未授予时静默跳过。
- 会话标题来自 host 的 `sessionTitle` 服务；服务不可用时退化为工作区名或目录名。
- 数据为全局一份，不按工作区隔离（这是已确认的取舍）。
- 导出格式为 CSV（不是 .xlsx）。如需多工作表或单元格格式，需要另行引入 xlsx 生成器。

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

`@scope/name` 里的斜杠，官方 `dsh plugin` CLI 与 DSH 的 bundle 解析器在不同版本上的处理不一定一致。首次发版后，**务必**在一台装了 DSH 的干净机器上实跑一次 `dsh plugin --profile web add @yongfanbeta/dsh-pomodoro` 确认加载成功；若 CLI 拒收斜杠名，把包名换成非作用域的独特名（届时 `package.json`、`cordis.patch.yml`、`lib/index.js` 的 `name`、`lib/client.js` 的 `id`、两个安装脚本与两处校验常量需同步回改，`README` 与 `check:install` 也会立刻指出没对齐的那一处）。

## 许可证

MIT



