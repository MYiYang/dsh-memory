---
name: dsh-plugin-dev
description: 开发、调试、安装 DeepSeek Harness (dsh) 本地插件：host 侧（ctx 服务、webServer 路由、工具注册、agent/pre-step 注入）与 client 侧（Web UI 槽位），含包结构、cordis.patch.yml 挂载、零依赖测试与安装/回滚流程。当用户要给 dsh 加功能、写插件、改 hook、给 dsh 加记忆/工具/面板时使用。
---

# DSH 插件开发（dsh-plugin-dev）

## 1. 先搞清楚插件跑在哪一侧

| 侧 | 入口 | 能力 | 声明方式 |
| --- | --- | --- | --- |
| **host**（Node 主进程） | `index.js` 的 `export function apply(ctx)` | 读写文件、起 HTTP 路由、注册工具、监听 agent/session 事件、注入上下文 | `package.json` 的 `main`/`exports` + `dsh.bundle.patch` |
| **client**（浏览器） | `client.js` | 渲染 UI、调用 host 暴露的 `/xxx/api` | `package.json.dsh.client`（`platform: web`、`inject` 依赖的 UI 包） |

同时要 UI 就两侧都写：client 发请求 → host 路由处理（见 `dsh-git-branch` 这个最小样例）。

## 2. 最小 host 插件骨架

```jsonc
// package.json
{
  "name": "my-plugin",
  "type": "module",
  "main": "index.js",
  "exports": { ".": "./index.js", "./package.json": "./package.json" },
  "dsh": { "bundle": { "patch": "./cordis.patch.yml" } }
}
```

```yaml
# cordis.patch.yml
- insert:
    - id: my-plugin
      name: 'my-plugin'
```

```js
// index.js
export const inject = ['sessions']           // 你依赖的服务，名字必须与 ctx.get/ctx.<svc> 对得上
export function apply(ctx, config = {}) {
  ctx.effect(() => ctx.on('agent/pre-step', async (payload, next) => {
    const decision = await next()            // 永远先调用 next()，再决定是否改写
    // ... return { kind: 'enter', messages: [...] } 以追加/前置消息
    return decision
  }), 'my-plugin: pre-step')
}
```

要点：
- **`ctx.effect(fn, label)`** 注册一切需要随插件卸载回收的资源（路由、监听器、定时器），返回 disposer。
- **`ctx.get('serviceName')`** 拿可选服务，拿不到就降级，不要 throw。
- **日志** 用 `ctx.logger?.info/warn/debug`，别 `console.log`（会污染 host 输出）。

## 3. 三条最常用的扩展点

1. **每轮注入上下文（记忆/时间/规则）**：监听 `agent/pre-step`，构造带 `source` 的 user 消息并返回。**注入内容必须标明「这是上下文不是新指令」**，否则模型会把它当需求执行。
2. **给模型加工具**：`ctx.tools.register({ name, description, parameters, execute })`（以本机 `dsh-tools` 的类型为准）。工具名用下划线命名，避免和内置 `read/pwsh/glob` 冲突。
3. **落库/回流**：优先用 `node:sqlite`（Node ≥22.5 自带，零依赖）+ FTS5；中文用 `tokenize='trigram'`（≥3 字可命中，2 字回退 LIKE）。别引入 better-sqlite3（Windows 要编译）。

## 4. 开发与测试（Windows/沙箱环境）

- **不要用 `node --test test/`**：它会为每个文件 spawn 子进程，沙箱下报 `spawn EPERM`。改用 `node test/foo.test.js` 逐个跑，或 `node --test --test-isolation=none <显式文件列表>`。
- 纯逻辑（存储、检索、格式化）写成不依赖 `ctx` 的模块，单测覆盖；`index.js` 只做「接线 + 错误兜底」。
- 插件里所有 IO 都要 try/catch：**插件挂掉不能拖垮会话**，失败就退化为「不注入/不记录」。

## 5. 安装、验证、回滚

```bash
# 挂到某个 profile（会改 ~/.dsh/profiles/<name>/package.json）
dsh plugin --profile web add link:/abs/path/to/my-plugin
# 或手动在 profile 的 cordis.patch.yml 里加 insert 条目（id 必须唯一）
```

验证顺序：`dsh` 启动日志无 `entry not found` → 会话里触发一次 → 看 `ctx.logger` 输出 → 用 `/health` 类自检命令确认副作用。

回滚：删掉 `cordis.patch.yml` 里的条目 + `dsh plugin remove`，再重启。**改配置前先备份** `~/.dsh/profiles/<name>/` 下的三个文件。

## 6. 常见坑

- `inject` 里写了不存在的服务名 → 插件永远不加载，日志只有一行 warn。
- 忘记 `next()` → 后续监听器不执行，模型可能收不到用户消息。
- 注入内容不带 source / 不区分角色 → 出现在 transcript 里像用户说的话，下一轮被当指令。
- 在 pre-step 里做慢操作（LLM、网络）→ 每步都卡；超过 ~100ms 就应该异步预热或缓存。
- 热更新只覆盖 client bundle；**host 插件改动必须重启 dsh**。
