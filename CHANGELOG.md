# 更新日志

## 0.1.0（2026-10-17）— 正式插件化

现状：由"运行时注入的诊断包"升级为可正式装配的 bundle 插件。

- 新增 `cordis.patch.yml`：`dsh.bundle.patch` 装配层，插入 loader 条目 `id: terminal-probe` / `name: dsh-terminal-probe`。
- `package.json`：补 `dsh.bundle.patch` 声明、`exports["./cordis.patch.yml"]`、`files`（lib/index.js、lib/client.js、cordis.patch.yml、README.md、LICENSE）、`keywords`、`engines.node`；`dsh.client.platform=web` 保留。
- 新增 `README.md`（中文，接口与落盘位置表）、`LICENSE`（MIT）、`.gitignore`；目录初始化 git 作第二轨记录。
- 正式装回 legacy 实例：`C:\dsh-homes\legacy\profiles\web\package.json` 的 `dependencies` 加 `dsh-terminal-probe: link:C:/Users/53518/dsh-plugins/dsh-terminal-probe`，`dsh.profile.bundles` 追加 `dsh-terminal-probe`。

装配方式：bundle 渠道（本文件所在包的 patch）与 profile 手工 mount 行二选一，同时存在会 duplicate loader entry id。

生效条件：profile 配置变更后需重启实例。
