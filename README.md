# Feishu Channel for Claude Code

在飞书里和 Claude Code 对话。发消息给 bot，Claude 读取、处理、回复——全在同一个聊天窗口里完成。

```
你 (飞书 DM) → bot → WebSocket → Claude Code → reply → 飞书回复
```

## 安装

在 Claude Code 里粘贴这一行：

```bash
bash <(curl -fsSL https://raw.githubusercontent.com/AkaiZheng/ClaudeCode-Feishu-Channel/main/install.sh)
```

脚本会自动完成所有步骤：安装依赖、创建飞书应用、配置凭证、验证连接。你只需要在提示时打开浏览器链接完成飞书侧的授权。

安装完成后启动：

```bash
claude --dangerously-load-development-channels server:feishu
```

然后在飞书给你的 bot 发一条消息就行了。

## 首次配对

- **首次安装**：你的 open_id 会自动加入白名单，直接给 bot 发消息即可
- **其他用户**：bot 会回复一个 6 位配对码，在 Claude Code 里运行 `/feishu:access pair <code>` 完成配对

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

<details>
<summary>手动安装</summary>

### 前置依赖

- [Bun](https://bun.sh) — `curl -fsSL https://bun.sh/install | bash`
- [lark-cli](https://github.com/larksuite/cli) — `npm install -g @larksuite/cli`

### 步骤

```bash
git clone https://github.com/AkaiZheng/ClaudeCode-Feishu-Channel.git
cd ClaudeCode-Feishu-Channel
bun install
bun scripts/setup.ts
```

### 飞书应用配置

在[飞书开发者后台](https://open.feishu.cn)配置：

- 事件与回调 → **使用长连接接收事件**
- 订阅事件：`im.message.receive_v1`
- 权限：`im:message:receive_as_bot`, `im:message:send_as_bot`, `im:message`
- 应用可见范围包含你自己
- 创建版本并发布

</details>

<details>
<summary>开发</summary>

```bash
bun test              # 单测（99 tests）
bun run typecheck     # 类型检查
bun scripts/smoke.ts  # 30s 连通性测试
```

</details>

## License

MIT
