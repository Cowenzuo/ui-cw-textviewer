# ui-cw-textviewer（右侧文本查看器 dock 插件）

右侧停靠的**只读文本文件查看器**，为 dsh web 会话区补充：按扩展名分派的渲染器
（代码高亮 / Markdown 渲染 / 纯文本）、编码探测（BOM / UTF-8 / GBK）、大文件
分块流式查看。**纯查看器：不自带文件列表**——文件树由 ui-cw-fileexplorer 提供，
点击文件行经 cordis 事件广播，本插件订阅接收即开即看。全部**零官方源码改动**。

---

## 一、实现介绍

### 功能总览

1. **打开方式（事件驱动）**：ui-cw-fileexplorer 点击文件行 →
   `ctx.emit('ui-cw/fileexplorer/file-open', { name, path, root })` →
   本插件在 **root 上下文**订阅接收（插件 fiber 是兄弟作用域，cordis 上下文
   过滤只匹配发出者的祖先，普通 `ctx.on` 收不到）；同一文件重复点击不重载
2. **布局**：独立右 dock，与 ui-cw-fileexplorer 并排（坐在其左侧）；两插件宽度
   变量联动，共同推挤官方 UI；**默认宽度 = 40% 界面宽**（挂载时计算，手动拖拽
   优先）；宽度上限为动态极限（视口 − 侧栏 − fileexplorer
   最小宽，即压到其他面板地板前可一直撑大）；**默认隐藏**，首次点击文件才
   出现；隐藏 = 彻底消失（无 rail、零推挤），文件点击是唯一重新打开入口
3. **渲染器注册表（预览区，v1）**：
   - `cpp/hpp/h/cc/cxx/…`、`ts/tsx/js/py/java/go/rs/…` → **Shiki**（TextMate
     语法，VS Code 同款着色）+ CSS 计数器行号
   - `md/markdown/mdx` → **react-markdown + remark-gfm**（标题/表格/任务列表等）
   - `yaml/yml/json/toml/ini/…` → Shiki 高亮；其余 → 纯文本（不换行横向滚动）
   - 新格式 = 在 `EXT_LANGS` / `rendererFor` 加一行，注册表天然可扩展；
     完整支持清单见 [docs/支持格式.md](docs/支持格式.md)（与代码同步维护）
4. **主题联动**：监听 `body[data-ds-dark-theme]`（ui-layout 投影），设置切换
   明暗主题时高亮主题（github-light/dark）自动跟随
5. **文本流**：`read-text` 分块（默认 256KB/块，上限 1MB/块）；滚动到底自动
   续载（钉在底部时连续流式），预览上限 2MB；头部显示编码 · 大小 · 部分标记
6. **编码与安全**：BOM 探测（UTF-8/UTF-16LE/UTF-16BE）→ 严格 UTF-8 → 失败回退
   GBK（国内遗留文件）；首块 NUL 嗅探识别二进制（提示不预览）；工作区锁定
   （host 侧强制，路径不可越出事件携带的会话 cwd）

### 架构与数据流

```
浏览器 (dsh web)                              Host (Node)
┌──────────────────────────┐                 ┌──────────────────────────┐
│ shell.overlay 槽（官方）   │                 │ ctx.connection.rpc.handle  │
│ fileexplorer dock（右）    │                 │  read-text     分块解码      │
│   └ 点击文件行 ──emit──┐   │                 │  renderer      懒加载渲染包   │
│                       ▼   │   POST /textviewer/*  └──────────────────────────┘
│ TextviewerDock（右侧） │   │ ─────────────────▶
│   └ 预览区（渲染器注册表）  │ ◀──────────────────
│      ├ Shiki 高亮 + 行号   │    RpcResult
│      ├ react-markdown GFM │
│      └ 纯文本 pre          │
└──────────────────────────┘
```

- **事件桥**：fileexplorer 在自身作用域 `ctx.emit`（向上冒泡到 root）；
  textviewer 在 `ctx.root.on` 订阅——兄弟作用域互不可见是 cordis 上下文过滤
  的既定语义，接收方必须挂 root（或 `{ global: true }`）
- **零官方改动**：挂载用官方 `shell.overlay` 槽；让位用 `#root { margin-right:
  calc(...) }` CSS 推挤（读取 fileexplorer 的宽度变量，两边 dock 合计推挤）；
  数据走插件自有 `/textviewer` RPC 通道
- **只读原则**：全部端点只读，无任何写操作；read-text 只按字节范围读文件
- **启动性能**：Shiki + react-markdown（≈3.4MB）拆成**独立懒加载渲染包**
  `lib/renderer.js`，host 经 `renderer` 端点提供（读取插件包内同目录文件），
  客户端首次打开文件才拉取并以 `new Function('module','exports','require', …)`
  求值（require 仅放行 react 两个模块，其余走主包 require 表）；启动主包仅
  ≈46KB。渲染包加载失败自动降级为纯文本，不白屏
- **高亮在 Web Worker 中执行**（主线程零阻塞）：语言首次编译与大数据块分词
  全部离线；失败自动降级主线程高亮；挂载后后台预热常用语言，首开即现
- **数据跟随**：`useSessions` 全局 hook → 当前会话 cwd = 锁定工作区根

### 目录结构

```
src/
├── index.ts          # node 半：注册 /textviewer 通道（apply）
├── contract.ts       # 双面共享的 RPC 契约 + 跨插件打开事件类型（纯类型）
├── handler.ts        # 通道实现：read-text / renderer + 编码解析纯函数
└── client/           # 浏览器半
    ├── index.ts      # apply：slots.inject('shell.overlay') + root 订阅打开事件
    ├── service.ts    # RPC 客户端封装（readText/renderer）
    ├── TextViewerDock.tsx   # dock 骨架（推挤/拖拽/收起 + 事件订阅）
    ├── TextViewer.tsx       # 预览区：渲染器分派 + 分块流式 + 续载
    ├── renderer-loader.ts   # 懒渲染包拉取/求值/缓存（主包）
    ├── renderer.tsx         # 懒渲染包入口：Shiki 高亮 + Markdown 视图
    ├── renderer-contract.ts # 渲染包导出面（纯类型）
    ├── locales.ts           # 文案（zh 默认 / en）
    └── *.module.css         # 各组件样式
tests/host.spec.ts    # 通道/编码/分块/真文件集成测试
cordis.patch.yml      # bundle 层：插入双面行
tsdown.config.ts      # node 半 + 浏览器半 + 懒渲染包三入口
```

### 加载与开发

仓库只跟踪**源码与配置**：`node_modules/`（依赖）、`lib/`（构建产物）和 `*.tgz`
（打包临时物）均不入库（见 `.gitignore`）。首次拉取后需自行两步：

```sh
pnpm install   # 拉取 npm 依赖（版本由 pnpm-lock.yaml 锁定）
pnpm build     # 生成产物 lib/index.js + lib/client.js + lib/renderer.js
```

其余常用命令：

```sh
pnpm typecheck                    # tsc --noEmit
pnpm test                         # vitest（20 个：解析/端点/真文件集成 + 渲染包 L4）
pnpm build:watch                  # client 面 watch → HMR 热更
.\publish.ps1                     # 一键发布：build+test → npm pack → 上架
                                  #   %USERPROFILE%\.dsh\profiles\web\vendor
                                  #   → 更新依赖（file:./vendor/...tgz）→ pnpm install
.\publish.ps1 -ProfileDir <dir>   # 发布到指定 profile；publish.cmd 可双击运行
```

类型依赖通过 tsconfig paths 指向 dsh 源码的 `lib/types`（开发期，见 tsconfig.json）。
`publish.ps1` 含中文，须保持 **UTF-8 带 BOM** 编码（Windows PowerShell 5.1 按
GBK 解析无 BOM 文件会乱码）；发布后需重启 dsh 生效。

### 已知限制

- **依赖 fileexplorer**：打开事件由 ui-cw-fileexplorer 发出，单独安装本插件
  没有打开入口（v1 定位 = 配套查看器）
- 只读边界：不提供编辑/保存（详情交给真实编辑器）
- 分块续载：块边界按字符对齐（UTF-8/GBK 块尾裁剪，半字符由下一块重读，
  无损拼接；编码提示随请求带回保证多块稳定）；多行结构（如 C 块注释）
  跨块时该处着色可能不完整（按块独立高亮）
- 无 BOM 的 UTF-16 文件无法自动识别（按 GBK 回退路径处理，通常乱码）
- 预览上限 2MB：超出后停止续载并提示
- 二进制判定为首块 8KB NUL 嗅探（首块无 NUL 的罕见二进制可能误判为文本）
- 轮询刷新（2s），非事件推送
- 布局状态（宽度/树比例/展开）刷新后重置

---

## 二、提交信息规范

本仓库所有提交遵循以下格式。

### 格式

```
<type>: <中文摘要>

1. <要点一>
2. <要点二>
3. <要点三>
```

- **标题**：`type: ` + 中文摘要，一行，动词开头、简洁（≤ 50 字）
- **正文**：空一行后接**有序列表**，3～5 行，总结关键要点，**不赘述**；
  没有值得列出的要点时可省略正文

### type 枚举

| type | 用途 |
|---|---|
| `feat` | 新功能 |
| `fix` | 修复缺陷 |
| `refactor` | 重构（不改变行为） |
| `docs` | 文档 |
| `test` | 测试 |
| `chore` | 构建/依赖/杂项 |

### 示例

```text
feat: 右侧文本查看器 dock 插件

1. 渲染器注册表：Shiki 高亮 + 行号 / react-markdown GFM / 纯文本，按扩展名分派
2. read-text 分块流式：编码探测（BOM/UTF-8/GBK）、二进制嗅探、滚动续载
3. 懒加载渲染包：主包轻量，Shiki+Markdown 首次打开文件才经 RPC 拉取
4. 与 fileexplorer 并排的推挤联动（calc 合计 margin），主题随 body 属性切换
5. 24 个测试全绿
```

---

## 三、代码命名规范

### 文件与目录

| 类别 | 规则 | 示例 |
|---|---|---|
| node 半 / 浏览器半入口 | `index.ts` | `src/index.ts`、`src/client/index.ts` |
| 共享契约 / 服务 / 文案 | 小写语义名 | `contract.ts`、`handler.ts`、`service.ts`、`locales.ts` |
| React 组件文件 | PascalCase | `TextViewerDock.tsx`、`FileTree.tsx` |
| 懒渲染包入口 | PascalCase `.tsx` | `renderer.tsx` |
| 组件样式 | 同名 `.module.css` | `TextViewer.module.css` |
| 测试 | `<面>.spec.ts` | `host.spec.ts` |
| CSS Modules 类型声明 | 固定名 | `css-modules.d.ts` |

### TypeScript 标识符

- **接口/类型**：PascalCase，`TextviewerEntry`、`TextviewerSnapshot`、`RendererExports`
- **函数**：camelCase 动词开头，`createTextviewerHandler`、`decodeChunk`、
  `langFor`、`rendererFor`
- **常量**：UPPER_SNAKE，`READ_DEFAULT_LIMIT`、`MAX_VIEW_BYTES`、`EXT_LANGS`
- **ref / state**：camelCase + 语义后缀，`scrollRef`、`bytesRef`、`pathRef`、
  `treeRatio`、`atBottomRef`
- **回调/注入面**：`TextviewerInjected` 等 `*Injected` 后缀；
  客户端面 `*Client` 后缀（`TextviewerClient`）
- **布尔状态**：`*Expanded`、`truncated`、`binary`、`tooLarge` 等形态
- **禁止**：`any`、未使用的 import/变量（typecheck 全绿为提交门槛）

### React 组件与样式

- 组件与文件同名（PascalCase）；纯函数同文件内定义（`formatSize`、`langFor`）
- 组件**不接触 ctx**：数据经 props（runtime / inject / locale）注入；
  apply 内回调经 `inject` 工厂传递
- CSS Modules 类名：camelCase，语义化（`infoRow`、`treeTwisty`、`moreHint`、
  `dividerH`）
- 状态色只允许官方 `--dsw-alias-*` / `--dsw-specific-*` token，禁字面量颜色；
  Shiki 着色来自主题包内联样式（明暗由 body 属性驱动重渲染）
- 内联样式仅限几何/动态值（宽度、flex 比例），静态样式一律进 `.module.css`

### 契约 / RPC / 国际化

- **RPC 端点**：kebab-case，`read-text`（通道前缀 `/textviewer`）
- **请求/响应类型**：`Textviewer*Request` / `TextviewerSnapshot` /
  `TextviewerListing` 命名
- **字段**：camelCase；可选字段用 `?` 且客户端必须兜底
- **错误**：复用官方封闭错误码（`directory-unreadable` / `cancelled` /
  `bad-request` / `internal`），不自定义
- **locale 键**：小写点分（`view.title`、`viewer.binary`、`tree.title`）；
  产品文案中文为默认、en 镜像（`locales.ts` 内 `zh` 为键源）
- **代码注释**：英文；仅产品文案/界面文字用中文

---

## Model Experience

None — 面板是浏览器 chrome，不触及任何模型请求。

#### KV Cache effect

None；本包不组装也不发送任何 provider 请求。
