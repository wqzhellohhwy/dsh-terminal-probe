# dsh-terminal-probe

底部终端面板里 xterm **实际渲染出来的颜色**采集器：皮肤（skin）/主题（theme）切换时，把画布像素与 CSS 变量重算结果一起回传给 host，供 agent 读取分析。纯诊断插件，无任何界面。

## 组成

| 半边 | 文件 | 作用 |
|---|---|---|
| host | `lib/index.js` | 在 `webServer` 上注册 `/api/terminal-probe/*` 路由，样本落盘 `$DSH_HOME/terminal-probe.jsonl` |
| client | `lib/client.js` | 浏览器侧：采样 xterm canvas 像素 + 重算 `--dsw-*` token；挂载后自动跑一次皮肤×主题矩阵，之后每 2s 被动检测变化并上报 |

## 接口（仅回环地址可用）

| 方法 | 路径 | 说明 |
|---|---|---|
| POST | `/api/terminal-probe/report` | 写入样本（`{samples:[...]}` 或单个对象） |
| GET | `/api/terminal-probe/latest` | 最后一条样本 |
| GET | `/api/terminal-probe/reports?limit=N` | 末尾 N 条样本（默认 50） |
| POST | `/api/terminal-probe/reset` | 清空样本文件 |
| POST | `/api/terminal-probe/run?skins=a,b&themes=light,dark` | 下一次采样矩阵的规格，写入 `terminal-probe-run.json` |
| GET | `/api/terminal-probe/run-state` | 当前矩阵任务状态（`pending` 标记） |
| POST | `/api/terminal-probe/run-ack` | 认领矩阵任务（`{runId}`），置 `pending=false` |
| POST | `/api/terminal-probe/refresh` | 请求渲染端整页重载（写 `terminal-probe-refresh.json`） |
| GET | `/api/terminal-probe/refresh-state` | 重载请求状态 |
| POST | `/api/terminal-probe/refresh-ack` | 认领重载请求，客户端随后 `location.reload()` |

样本字段：`t` 时间、`skin`、`theme`、`terminal`（`canvas` / `xterm-no-canvas` / `false`）、`rawBg`、`rawLabel`、`recomputedBg`、`recomputedFg`、`canvas`（像素采样结果）、`canvasNote`、`canvasErr`、`ui`（成功色/标签色等 alias token）、`ver`。

## 落盘位置

- `$DSH_HOME/terminal-probe.jsonl` — 样本流
- `$DSH_HOME/terminal-probe-run.json` — 矩阵任务
- `$DSH_HOME/terminal-probe-refresh.json` — 重载请求

## 安装

作为 bundle 正式装配（`dsh.bundle.patch` 指向本包 `cordis.patch.yml`）：

```powershell
# 在 profile 的 package.json 里
#   dependencies: "dsh-terminal-probe": "link:C:/<插件目录>/dsh-terminal-probe"
#   dsh.profile.bundles: 追加 "dsh-terminal-probe"
```

改完需重启该实例生效。装配成功后 host 路由即应答：

```powershell
Invoke-RestMethod http://127.0.0.1:<端口>/api/terminal-probe/latest
```

## 注意

- 浏览器半边只在带界面的 web/desktop 渲染端运行；headless 实例只有 host 路由。
- 客户端只读地检测终端存在性，绝不点击面板控件（历史事故：点击会把终端关掉）。
- 矩阵默认皮肤表：`official, summer-liquid-glass, harbor, whale-song, blue-fantasy, dragon-heir, mint`。
