# PM JSON CLI 与 MCP stdio

PM 的调用入口复用已有 `/api/pm` REST 服务。服务端成员权限、围栏、固定模型、物理请求预算、依赖编排、产物存储和代码验收继续生效。客户端只接受 PM 操作，不接受租户覆盖、任意 URL、shell 或模型密钥。

运行需要 Node 24 及已装配 AI-PM 的 PM 服务。调用进程通过环境接收 `PM_BASE_URL`（或 `WORKLOOM_BASE_URL`）和当前成员会话 `WORKLOOM_ACCESS_TOKEN`。客户端没有登录功能；现有应用或受控启动器负责提供会话。URL 只允许 HTTPS 或精确 loopback HTTP origin。模型密钥只留在服务端或预算代理内，不能进入 CLI 参数、请求 JSON 或 MCP 配置示例。

## 使用

```sh
pnpm pm:agent --help
pnpm pm:agent status
pnpm pm:agent deliver --input-file request.json
pnpm pm:agent get --input-file existing-run.json
pnpm pm:agent:mcp
pnpm pm:agent:test
```

也可直接运行 `node scripts/pm-agent.mjs <command> --input-file -` 并从标准输入发送一个 JSON 对象。标准输入或文件上限为 256 KiB。成功时 stdout 只有一个 `workloom.pm-agent-result/v1` JSON，包含 `operation`、`deliveryClaim` 和 `result`；失败时 stderr 只有 `workloom.pm-agent-error/v1` JSON，退出码非零。`--help` 输出 JSON 帮助，不要求已配置会话。

任务示例：

```json
{
  "goal": "根据提供的用户访谈材料整理需求和验收标准，所有产物仅写入隔离沙箱。材料：三名试用用户都表示首次创建任务时无法判断是否成功。",
  "idempotencyKey": "pm-demo-onboarding-001",
  "employee": "requirement-analyst",
  "checks": [
    { "type": "fileExists", "path": "requirements.md" },
    { "type": "fileContains", "path": "requirements.md", "text": "验收" }
  ],
  "timeoutMs": 120000,
  "pollIntervalMs": 500
}
```

不指定 `employee` 时，由产品总监生成实际团队计划。指定员工时，后端按该员工和同一目标创建单节点计划；多个 checks 可以指向同一文件。`fileExists`、字面 `fileContains`、JSON 解析与顶层 `requiredKeys` 是可用的请求检查类型，没有 shell 检查。

| 命令 | 请求字段 | 行为 |
| --- | --- | --- |
| `status` | 无 | 读取配置和已就绪员工，不宣称交付成功 |
| `list` | 可选 `limit` 1–50 | 列出当前成员可访问的运行 |
| `create` | 必填 `goal`、`idempotencyKey`；可选 `employee`、`checks` | 创建或复用运行，不启动模型 |
| `start` | `runId` | 启动既有 created 运行；重复调用仍由服务端状态机处理 |
| `get` | `runId` | 读取状态、任务和产物回执 |
| `wait` | `runId`；可选 `timeoutMs`、`pollIntervalMs` | 有界等待，并核对 completed 的回执和原始产物 |
| `artifact` | `runId`、安全相对 `path` | 读取原始 UTF-8 内容，核对字节数和 SHA-256 |
| `resume` | `runId` | 显式恢复 paused/blocked/failed，可能产生新的收费请求 |
| `cancel` | `runId` | 显式取消运行，保留既有证据 |
| `deliver` | create 字段；可选 wait 时间字段 | 检查真实后端就绪、幂等创建、启动、等待并核对交付 |

同一个实际任务必须复用调用方已保存的 `idempotencyKey`。同键改变目标、员工或 checks 时，后端返回冲突。超时或连接失败后，先读取原运行，复用原键查询或继续等待；不要用新键重建付费任务。`deliver` 不会自动恢复 blocked、failed 或 paused，也没有任何自动审批或付费重试通道。并行提交同键请求仍依赖后端事务和 CAS 避免重复执行。

`timeoutMs` 为 100–1800000，`pollIntervalMs` 为 100–10000。等待超时或客户端取消不会自动取消后端运行。`resume` 必须来自调用者对新尝试的明确授权；`cancel` 也是显式业务操作。

## 交付判断

只有 `wait` 或 `deliver` 通过以下核对，才返回 `deliveryClaim: true`：运行和全部任务 completed；服务端最终 checks 均通过；每个计划产物存在且归属正确；原始文件的 UTF-8 字节数和 SHA-256 与不可变回执一致；请求的字面/JSON checks 在本地再次通过；运行、规划和全部员工尝试的计量相等；最终员工响应与 attempt 回执绑定；岗位和技能有服务端 verified-catalog 来源摘要；DSH 员工有成功终态与逐请求 usage。

该值表示机器回执核对通过。输出总是同时包含 `semanticReview.required: true` 和 `status: not-reviewed`。业务事实是否准确、方案是否合理、代码是否满足未明示需求仍需独立评审。读取 `get` 或单个 `artifact` 的结果不会宣称整体交付通过。客户端不替代服务端 macOS 受限代码执行器，也不会在宿主直接运行模型产物。

## MCP

`node scripts/pm-agent-mcp.mjs` 是 stdio 服务，提供相同的十个 `workloom_pm_*` 工具，环境契约与 CLI 相同。它只向 stdout 发送 UTF-8、按换行分隔的 JSON-RPC 消息。先协商 `initialize`，再发送 `notifications/initialized`，随后使用 `tools/list` 和 `tools/call`。当前支持协议 `2025-11-25`；客户端请求其它版本时返回本服务支持的版本，由客户端决定是否继续。最多八个工具调用同时在途，单帧有字节上限，通知不会派发工具调用。MCP 取消通知只取消该客户端请求；业务取消应显式调用 `workloom_pm_cancel`。

协议依据：[MCP stdio transport](https://modelcontextprotocol.io/specification/2025-11-25/basic/transports) 与 [MCP lifecycle](https://modelcontextprotocol.io/specification/2025-11-25/basic/lifecycle)，本轮于 2026-10-24 实时读取。此服务不提供 Streamable HTTP。

## 本地验证

`pnpm pm:agent:test` 运行真实 localhost HTTP fixture、CLI 子进程与 MCP stdio 子进程测试。fixture 明确是合成数据，不访问数据库、云端、模型或收费接口；它不能作为真实 PM 员工执行、模型效果、生产权限或线上交付证据。真实模型效果另由实际服务及独立验收记录证明。
