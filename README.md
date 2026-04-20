# Feishu Channel for Claude Code

在飞书里和 Claude Code 对话。发消息给 bot，Claude 读取、处理、回复——全在同一个聊天窗口里完成。

## 30 秒概述

```
你 (飞书 DM) → bot → WebSocket → Claude Code → reply → 飞书回复
```

## 快速开始

> **如果你在 Claude Code 里看到这个 README**：直接运行 `bun scripts/setup.ts`，脚本会自动引导你完成所有配置。只需在提示时打开浏览器链接即可。

### 前置依赖

- [Bun](https://bun.sh) — `curl -fsSL https://bun.sh/install | bash`
- [lark-cli](https://github.com/larksuite/cli) — `npm install -g @larksuite/cli`

### 安装

```bash
git clone https://github.com/AkaiZheng/ClaudeCode-Feishu-Channel.git
cd ClaudeCode-Feishu-Channel
bun install
```

### 自动配置（推荐）

```bash
bun scripts/setup.ts
```

脚本会：
1. ✅ 检查环境（Bun, lark-cli）
2. ✅ 检测/创建飞书应用 → 输出链接，你打开完成配置
3. ✅ 检测/完成用户授权 → 输出链接，你打开完成授权
4. ✅ 自动写入 `.env` 凭证
5. ✅ 验证 WebSocket 事件订阅
6. ✅ 输出启动命令

### 启动

```bash
claude --dangerously-load-development-channels server:feishu
```

然后在飞书给你的 bot 发一条消息，Claude Code 就能收到了。

## 手动配置

如果不想用 setup 脚本，手动步骤如下：

<details>
<summary>展开手动配置步骤</summary>

### 1. 飞书应用

需要一个飞书应用，在[飞书开发者后台](https://open.feishu.cn)配置：

- 事件与回调 → **使用长连接接收事件**
- 订阅事件：`im.message.receive_v1`
- 权限：`im:message:receive_as_bot`, `im:message:send_as_bot`, `im:message`
- 应用可见范围包含你自己
- 创建版本并发布

或者用 lark-cli 一键创建：`lark-cli config init --new`

### 2. 凭证配置

```bash
mkdir -p ~/.claude/channels/feishu
cat > ~/.claude/channels/feishu/.env << 'EOF'
FEISHU_APP_ID=cli_xxxxxx
FEISHU_APP_SECRET=xxxxxxxxxxxxxxxx
EOF
chmod 600 ~/.claude/channels/feishu/.env
```

如果已有 lark-cli，channel 会自动从 `~/.lark-cli/config.json` 导入 appId 和 userOpenId。

### 3. 启动

```bash
claude --dangerously-load-development-channels server:feishu
```

</details>

## 首次配对

- **如果有 lark-cli**：你的 open_id 会自动加入白名单，直接给 bot 发消息即可。
- **如果是其他用户**：bot 会回复一个 6 位配对码，在 Claude Code 里运行 `/feishu:access pair <code>` 完成配对。

## Smoke Test

```bash
bun scripts/smoke.ts
# 30 秒内给 bot 发消息，会收到 "smoke ok" 回复
```

## 安全

- 入站消息经 access gate 过滤后才到达 Claude
- 出站回复限定为已允许的 chat，不会向陌生会话泄露
- 凭证文件始终 `chmod 0o600`
- 防 prompt injection 指令内置于 system prompt

## 故障排查

| 现象 | 解法 |
|------|------|
| 没收到消息 | 确认应用开了长连接事件订阅 + `im.message.receive_v1` |
| "FEISHU_APP_SECRET required" | `.env` 没配 secret |
| "chat X is not allowlisted" | 运行 `/feishu:access allow <open_id>` |
| setup 脚本超时 | 用户没在 5 分钟内完成浏览器操作，重试即可 |

## 开发

```bash
bun test          # 单测
bun run typecheck # 类型检查
bun scripts/smoke.ts  # 30s 连通性测试
```

## License

MIT
