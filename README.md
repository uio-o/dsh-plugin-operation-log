# dsh-plugin-operation-log

一个 DeepSeek Harness（DSH）会话面板插件：把一次会话里**发生过的操作**按「轮次 → 步骤」摊开给你看——调用了哪些 Skill、哪些 MCP 工具、读了写了哪些文件、哪一步失败、为什么失败。

它接管右侧边栏的一个标签页（`sidebar.right.pane.tab`），不做主面板、不替代任何宿主界面。

设计目标只有一条：**诚实的局部视图**。面板只回答它确实知道的（源自宿主只追加的会话日志），答不了的直接说「未知 / 未记录」，绝不猜。

---

## 安装

### 方式一：装进 profile（推荐）

本插件以 `link:` 形式随 profile 的 `package.json` 安装，DSH 直接读你的源码目录，改完即生效。

```json
{
  "name": "dsh-profile-yourprofile",
  "dependencies": {
    "dsh-plugin-operation-log": "link:D:/path/to/dsh-plugin-operation-log"
  },
  "dsh": {
    "profile": {
      "bundles": [ "dsh-plugin-operation-log" ]
    }
  }
}
```

改完这两处后在 profile 目录跑一次 `pnpm install`，**重启 DSH** 后启用。

> <details>
> <summary>方式二：GitHub tarball（次选）</summary>
>
> ```powershell
> $p = "<你的 profile 目录>"
> Copy-Item "$p\package.json" "$p\package.json.bak" -Force
> # 下载并解包到 node_modules
> Invoke-WebRequest "https://github.com/uio-o/dsh-plugin-operation-log/archive/refs/heads/main.tar.gz" -OutFile "$env:TEMP\opl.tar.gz"
> tar -xzf "$env:TEMP\opl.tar.gz" -C "$env:TEMP"
> $dst = "$p\node_modules\dsh-plugin-operation-log"
> Move-Item "$env:TEMP\dsh-plugin-operation-log-main" $dst -Force
> # 在 package.json 的 dependencies 与 dsh.profile.bundles 两处各加一行 "dsh-plugin-operation-log"
> ```
>
> tarball 方式装的是**拷贝**不是链接，升级需手动重新拷贝。
> </details>

装完后会话头部右侧会出现「操作日志」按钮，点击即在右侧边栏打开本面板。

### 前置条件

- DSH `0.2.0-rc` 或更高（投影注册表、`sidebarRightTabs`、`ctx.locale.register`）。
- 依赖三个可选服务，缺失时对应子分区自动降级而非报错：`connection`（文件存在性、Git）、`shell`（Git 状态与 diff）、`fs`（文件存在性）。

---

## ⚠️ 头等重要的机制：Host 半改代码必须重启

DSH 的 **Host 插件模块只在应用进程启动时载入一次**。改完 `index.js` 后：

| 改动 | 如何生效 |
|---|---|
| `client.js`（界面） | 刷新浏览器页面即可 |
| `index.js`（数据/投影/路由） | **必须重启 DSH** |

插件管理器的「关掉再开」只重新注册，**不会**重新导入 JS 模块——这是实测结论，别靠它验证 Host 侧改动。

---

## 设计

面板从上到下六个分区，全部可折叠（除筛选结果常开）：

| 分区 | 内容 | 收起状态 |
|---|---|---|
| **概览** | 总会话数、出错总数；`全部 / Skill / MCP / 其他工具 / 出错` 五个可点芯片 | 默认展开 |
| **筛选结果** | 点任一芯片后出现，按主体聚合的统计表 | 有筛选时常开 |
| **任务** | 当前生效的任务清单（状态点 + 文本） | 默认展开 |
| **活动日志** | 逐轮卡片：轮次头（各类计数芯片）+ 调用行 | 默认展开 |
| **文件** | 按文件聚合的读写次数、最近轮次、是否已删除 | 默认收起 |
| **会话变化** | 逐轮由 `workspace/changes` 公告的文件变更行数 | 默认收起 |
| **Git 变化** | `git status` 未提交项 + 点开看 diff | 默认收起 |

每次调用一行：图标块（按类型着色）+ 工具名 + 目标（文件名或技能名）+ 耗时 + 状态。失败行可点开看错误详情。

配色全部走宿主主题 token（`--dsw-alias-*`），明暗主题与第三方主题（bloom-theme 等）下都不会跑偏；柔和底色由 `color-mix()` 叠 token 得到，不硬编码色值。

---

## 功能分节

### 1. 逐轮操作统计

每个轮次卡片头部给出该轮的 Skill / MCP / 其他工具 / 出错计数。超过 12 行的轮次折叠为「展开其余 N 条」；轮次列表默认显示最近 10 轮，更早的用「显示更早的 N 轮」翻页。

PTC（`run_code`）容器之内的子调用会正确归属到它所在轮次与步骤：外壳 `run_code` 本身不计入统计，但其内嵌的 Skill、MCP 调用计入。

### 2. 调用明细：到底调用了什么

每个调用都带**主体**——不只是工具名：

- 文件工具（`read` / `read_image` / `write` / `edit`）→ 显示文件名，悬停看完整路径
- `skill` → 显示**具体加载了哪个技能**（取自参数 `name`）
- MCP 调用 → 工具栏里显示服务名与方法名，筛选面板里按方法聚合

### 3. 失败详情：不止一个红叉

点失败行即在该行下方展开错误详情：

- 宿主附带的 `error.name` / `error.code` / `error.reason`
- 报错正文摘录（截断存储，附「已截断」标注）
- 一键复制整段错误

报错正文在投影状态里有体积上限（每条 ≤ 2048 字符、全文最多保留 300 条），超出后较早的正文会被释放，仅保留错误码——面板会明说「较早的报错正文已释放」，不会假装它还在。

### 4. 按来源筛选与统计

点概览里的芯片即筛选，面板顶部出现「筛选结果」分区：按**主体**聚合的统计表（次数 + 涉及轮次），再点某一行可继续收窄到「某个工具的某次具体调用」。

Skill 筛选给出每个技能被加载几次、分布在哪些轮次；MCP 筛选给出每个方法被调用几次。

### 5. 文件读写与「已删除」标注

「文件」分区把会话里所有文件操作按路径聚合：读多少次、写多少次、最后一次出现在第几轮。

每个文件旁有存在性探测结果（由 Host `fs.stat` 返回，三态）：

| 状态 | 表现 |
|---|---|
| 存在 | 正常显示 |
| 已删除 | 文件名**加删除线** + 「已删除」 |
| 未知 | 不加线、不标注（探测没跑完或沙箱拒绝） |

探测结果附「存在性检测于 HH:MM」时间戳——它是**探测那一刻**的状态，不是实时状态。会话里为完成工作创建的临时文件被删掉后，这里会如实划掉。

### 6. 任务对应

「任务」分区显示当前生效的任务清单。任务清单本身**不编号**（宿主的任务栏也不编号），所以本插件按**任务文本**对应——而宿主工具保证同一清单内文本唯一，这个键是可靠的。

每轮卡片上若该轮改写过任务清单，会标一个「本轮更新」灰字。

### 7. 会话变化 / Git 变化

- **会话变化**：读宿主 `workspace/changes` 公告，逐轮列出变更文件及增删行数。二进制文件、过大文件分别标注，不渲染 diff。
- **Git 变化**：读 `git status --porcelain` 列出未提交项，点开看 `git diff`。工作目录不是 Git 仓库时明说「当前工作目录不是 Git 仓库」，不会显示成「无变化」。

---

## 槽位 / 接口

### 客户端注册

| 槽位 | key | 作用 |
|---|---|---|
| `sidebar.right.pane.tab` | `dsh-plugin-operation-log/tab` | 标签页主体 |
| `sidebar.right.pane.tab.title` | `dsh-plugin-operation-log/tab` | 标签页标题 |
| `conversation.session.header.utilities` | `operation-log-open`（order 15） | 会话头部入口按钮 |

标签页类型通过 `ctx.sidebarRightTabs.register` 注册，`kind` 为 `operationLogTab`，`priority` 为默认档 `extension`。

### 数据来源：会话投影

Host 半注册一个 `operationLog` 投影单元，纯函数折叠**既有**会话事件（不追加任何新事件类型）：

| 事件 | 用途 |
|---|---|
| `turn/start` | 跟踪当前轮次 |
| `todo/write` | 记录该轮生效的任务清单 |
| `tool/call` | 记录调用：名称、轮次、步骤、起始时间、目标 |
| `tool/result` | 配对 `toolCallId`（回退 `message.source.callId`），标记成败、耗时、错误详情 |
| `tool/ptc-dispatch-start` / `tool/ptc-dispatch` | 记录 PTC 子调用，经 `rootCallId` 归属轮次 |
| `workspace/changes` | 记录该轮的变更序号，供「会话变化」按需取详情 |

投影状态版本为 `stateVersion: 2`，旧检查点会自动失效重算。

### HTTP 路由（均带认证栅栏，均注册为可释放 effect）

| 路由 | 方法 | 作用 |
|---|---|---|
| `/api/operation-log.git-status` | GET | `git status --porcelain=v1 -z` |
| `/api/operation-log.git-diff` | GET | `git diff -- "<path>"`（路径含 shell 元字符则拒绝） |
| `/api/operation-log.files-exist` | POST | 批量 `fs.stat`，最多 200 路径，返回 present / missing / unknown 三态 |

三条路由各自**只在自己依赖的服务存在时**注册；缺 `shell` 或 `fs` 的配置下，对应分区显示诚实降级文案，投影半不受影响。

---

## 测试

仓库外置了三套一次性验证脚本（不入库，目的是不污染交付物）。

**Host 半**（投影折叠、分类表、畸形事件、错误正文截断、解析器返回值）：

```powershell
node <你保存的路径>\dsh-oplog-verify.mjs
```

**路由半**（Git 三个分支、文件存在性三态、路径元字符拦截、POST 体校验）：

```powershell
node <你保存的路径>\dsh-oplog-verify-routes.mjs
```

**Client 半**（注册项核对、locale 键集中英一致、槽位 key）：

```powershell
node <你保存的路径>\dsh-oplog-verify-client.mjs
```

三套全绿的预期输出分别是 `ALL HOST CHECKS PASSED` / `ALL ROUTE CHECKS PASSED` / `ALL CLIENT CHECKS PASSED`。

---

## 出处与许可

MIT，见 [LICENSE](LICENSE)。

本插件是**衍生作品**：视觉结构借鉴了 [Abu](https://www.myabu.cn/)（`PM-Shawn/Abu-Cowork`）的设计语言——暖中性表面分层、发丝分隔线、柔和着色芯片、圆角图标块、「图标 + 标题 + 灰字计数 + 折叠箭头」的分区头、`grid-template-rows` 的展开收起过渡。

实现上未使用 Abu 的任何代码：其样式变量基于 Tailwind/shadcn 自己的设计 token，而本插件全部改用 DSH 的主题 token（`--dsw-alias-*`）与 `color-mix()` 重新表达。若原作者认为署名方式不妥，请开 issue，我会调整。

MIT 的唯一义务是保留版权声明，`LICENSE` 顶部已列两份版权行。
