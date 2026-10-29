# DeepSeek 218 项真实任务质量评测

本轮在 `2026-10-29` 完成。结论不是“换了提示词后全部通过”这么简单：首轮真实执行先保留失败，再根据协议、断言、代码沙箱、搜索和预算层暴露的问题逐项修复，最后对 218 个逻辑任务取得完成回执。

## 模型事实与别名边界

本轮从 DeepSeek 官方 `/models` 接口实际读到两个可用模型：

| API 模型 ID | 上下文 | 最大输出 | 输入 | 默认选择 |
|---|---:|---:|---|---|
| `deepseek-flash` | 1,048,576 | 393,216 | text / image | 是 |
| `deepseek-v4-pro` | 1,048,576 | 393,216 | text | 否 |

DeepSeek 官方在 [V4.1 Flash 1017 发布公告](https://api-docs.deepseek.com/zh-cn/news/news261017/) 中说明：`DeepSeek-V4.1-Flash-1017` 已于 2026-10-17 上线，官方网页、App 与 API 已同步使用该版本。API 仍通过稳定别名 `deepseek-flash` 调用。

因此本项目不把 `DeepSeek-V4.1-Flash-1017` 当作 API 模型 ID，也不把 `deepseek-flash` 当成不可变版本锁。每个真实请求都记录请求模型、响应模型、request ID、usage、finish reason 和耗时；供应商后续改变别名映射时可从回执发现漂移。

研发节点原先锁定 `@deepseek-ai/dsh@0.2.0-rc.2`，不满足官方 1017 发布页建议的 `0.2.1-rc.1+`。本轮升级到 npm `latest` 指向的 `0.2.1-rc.2`，该版本发布说明明确适配 V4.1-Flash-1017 与 Search/Fetch。vendor tarball 的 SHA-512/registry integrity 逐字符一致；真实 DSH 子进程回归 8/8，E6 全链与 H-5 `kill -9` 重放均通过。另完成一次真实 `deepseek-flash` 兼容冒烟：3 次物理模型请求、5,461 token、3 次受限工具调用，实际读取、写入并由 usage 完整回执收尾。

## 任务集

目录文件为 [`bundles/ai-pm/eval/deepseek-218.json`](../bundles/ai-pm/eval/deepseek-218.json)，共 218 题、14 个岗位族：

| 岗位族 | 题数 | 岗位族 | 题数 |
|---|---:|---|---:|
| 产品决策 | 16 | 研发编排 | 16 |
| 需求分析 | 16 | 质量评测 | 16 |
| 竞品与市场 | 16 | 行业雷达 | 16 |
| 数据分析 | 16 | 发布治理 | 16 |
| 用户洞察 | 15 | 模型选型 | 15 |
| 产品文档 | 15 | 提示词治理 | 15 |
| 防御性红队 | 15 | 知识治理 | 15 |

难度分布为：基础 56、标准 56、进阶 56、专家 50。

任务不是同义改写。覆盖：

- PRD、范围裁剪、优先级、路线图、事故沟通和 Go/No-Go 决策。
- 漏斗、ARPU、留存、A/B、LTV/CAC、p95、口径冲突和辛普森悖论。
- 用户反馈聚类、访谈、无障碍、流失、工单和需求原话分离。
- 竞品证据、官方搜索、模型目录、Harness 版本、计费与行业信号。
- 迁移、灰度、签名、SBOM、兼容矩阵、观测、回滚和发布冻结。
- 8 个真实 JavaScript 实现题，模型产物必须通过独立的 macOS Seatbelt + Node 24 trusted test。
- 提示词回归、注入防御、SSRF、路径穿越、审批绕过、租户隔离、数据外流和供应链。
- 知识冲突、来源优先级、过期、去重、检索评测、PII、回滚与数据地图。

其中 10 题实际调用 DeepSeek Search API；最终来源必须与 Search 回执同域，模型自述的“我搜索了”不计为证据。

## 判定口径

每题输出必须满足：

1. 严格 JSON 对象，字段集合固定。
2. `deliverable` 非空且不超任务上限。
3. `decisions`、`assumptions`、`risks`、`verification`、`limitations` 均非空。
4. 通过题目定义的确定性内容/安全断言。
5. Search 题的 `sources` 至少一个与真实 Search 回执同域。
6. 代码题的 `solution` 必须通过独立 trusted evaluator。
7. 不得包含当前任务的真实 API key；合成凭据形态会脱敏保存，真实凭据出现则失败关闭。

评测器允许一种确定性语法修复：当内容已完整，仅缺少 1–2 个结尾 `]`/`}` 时，可补齐边界后重新严格解析；不会补字段、补值、删除尾随文本或猜测截断内容。原始响应和补齐值都写入逐题证据。

## 最终结果

运行标识：`deepseek-218-20261028-full-1530`

| 指标 | 结果 |
|---|---:|
| 逻辑任务 | 218 |
| 最终完成 | 218 |
| 最终质量通过 | 218 |
| 最终通过率 | 100.0% |
| p50 请求耗时 | 6,749 ms |
| p95 请求耗时 | 9,554 ms |
| Search 题 | 10/10 |
| 代码执行题 | 8/8 |
| 最终回执 token | 337,939 |

最终结果的一百个百分点不能被解释为首次成功率。首轮 218 题的真实结果是 126 通过、92 失败。失败被原样保留，随后经过真实重跑、代码修复和确定性评测器修复。

| 阶段 | 尝试 | 通过 | 失败 | 说明 |
|---|---:|---:|---:|---|
| initial | 218 | 126 | 92 | 首次全量；含上游 402 冻结和代码测试接线缺陷 |
| repair-1 | 26 | 19 | 7 | 修复合同、匹配、代码接线后真实重跑 |
| repair-2 | 73 | 49 | 24 | 临时上游 502 恢复后继续真实重跑 |
| repair-3 | 24 | 18 | 6 | 修复边界、提示完整性、合成凭据语义后重跑 |
| reevaluate-1/2 | 7 | 7 | 0 | 对已保留的真实响应修复评测器后复评，不新增付费调用 |
| content-audit | 218 | 214 | 4 | 收紧为只检查正文/代码后零费用复评，暴露 4 个同义表达误判 |
| reevaluate-final | 218 | 218 | 0 | 修正百分比尾零、`request_id`、expand/contract 分段与 PII 同义表达后复评，不新增付费调用 |

## 调用、成本与证据

| 指标 | 结果 |
|---|---:|
| 物理请求总数 | 315 |
| 模型请求 | 305 |
| Search 请求 | 10 |
| 全部尝试已取得 token | 440,515 |
| 保守费用估算 | CNY 21.3527 |

费用是预算代理按冻结单价计算的保守估算，不是 DeepSeek 供应商账单。20 个预算 shard 中有 3 个因上游 402/网络结果未知而保留 `measurementComplete=false`；这些失败请求没有被当成零用量，也没有在冻结后盲目自动重试。后续恢复使用新的显式 shard 和账本。

本地证据位于 `outputs/deepseek-218-20261028-full/`：

- `results.jsonl`：所有逻辑任务尝试的最终分数、断言、请求和 usage。
- `events.jsonl`：开始、请求、Search、完成、失败、预算停止和复评事件。
- `cases/DS218-xxx/attempt-xxx.json`：逐题原始响应、Search 回执、评测检查和运行回执。
- `shards/<phase>/<shard>/requests.jsonl`、`budget-ledger.jsonl`：每个物理请求与预算账本。
- `summary.json`、`report.md`：聚合指标与失败码。

目录在本轮为 17 MiB、869 个文件。`outputs/` 按仓库规则不入 Git；代码、任务目录和本报告进入仓库。

## 本轮暴露并修复的问题

| 问题 | 暴露方式 | 修复 |
|---|---|---|
| Search `count` 本地上限写成 10，官方范围为 1–50 | 代码审计对照官方 Search 文档 | 改为 1–50，并把 Search/Fetch 总调用上限显式配置，默认仍为 8 |
| 非搜索题被错误要求返回空 `sources` | 首轮 10 个“缺 sources” | 仅搜索题要求 `sources`，非搜索题可省略 |
| 代码 trusted test 与生成文件路径重复 | 8 个代码题在真正执行前失败 | 测试文件只从 `trustedFiles` 注入，生成文件只包含 `solution` |
| HTML 转义 trusted test 本身生成后语法错误 | 独立代码执行回执 | 修正测试字符串转义，并重新执行 |
| 空格、全半角、百分比尾零、中文“万”导致等价答案误判 | 多类数据分析与治理题 | 统一 NFKC、空白、破折号、百分比和万/亿数值归一化 |
| 安全断言把“不允许重启清零”等否定表达判成违规 | 多个红队/治理题 | 对前置否定、否定后缀和防御性引述做上下文判定 |
| 防御性任务引用合成 token/明文头被当成真实泄漏 | `密钥外泄` 任务 | 真实 API key 失败关闭；合成凭据形态允许评测并在落盘前脱敏 |
| 多条响应在 `finish_reason=stop` 下漏掉 1–2 个结构闭合符 | JSON 协议断言 | 仅做确定性边界补齐并记录 `normalization`，不补内容 |
| 输出 token 上限过紧导致长任务截断 | 5 个 `finish_reason=length` | 按难度提升输出上限；仍保留长度硬闸 |
| 上游 HTTP 402/502 后继续发请求会制造大量“假失败” | 首轮后半段 | 一旦预算代理冻结立即停止当前 suite；恢复必须使用新 shard/账本 |
| 错误类型和函数返回形态在代码题中不明确 | `addCents`、token bucket 真实验收失败 | 在任务提示中明确 TypeError/RangeError 和 boolean 返回 |
| 少数谓词只接受一种同义表达 | 模型成本、模型漂移、PII 等 | 改为“必选事实 + 同义集合”断言，保留核心语义 |
| DSH 0.2.0 不满足 1017 官方兼容建议 | 官方发布公告与 npm 发布说明 | 升级 `0.2.1-rc.2`，整棵家族同版，固定 OTel peer，跑 8 项 DSH 与 E6/H-5 |
| 内容断言曾扫描整个 JSON，`risks` 中出现关键词也能过关 | 只检查正文/代码的二次复评 | 内容断言仅看 `deliverable` 与 `solution`，安全断言仍看完整响应 |
| `2.500%`、`request_id`、分段 expand/contract 和“真实邮箱/手机号”被误判 | 收紧后的 218 题零费用复评 | 补百分比尾零归一化、同义/分段表达式，再完整复评到 218/218 |
| 证据文件已写、结果账本未写时，异常恢复可能覆盖旧尝试 | 恢复路径代码审查 | 尝试号同时扫描账本和证据文件；证据用原子 no-clobber 写入 |
| 成本上限实际按 shard 各自计算，整套可被多 shard 放大 | 预算实现代码审查 | 改为所有 shard 共享 `PM_DEEPSEEK_218_MAX_COST_CNY` 总上限，剩余额度耗尽即停 |

## 运行方法

不要把一个评测任务的真实 key 写入 `.env`、仓库、命令行输出或报告。运行时仅在进程环境中注入：

```sh
DEEPSEEK_API_KEY='<运行时秘密>' \
PM_TOKENIZER_PATH='<deepseek-recipe v41 tokenizer.json>' \
PM_TOKENIZER_PYTHON='<安装了 deepseek-recipe==0.2.0 的 python>' \
PM_DEEPSEEK_218_MAX_COST_CNY='<整套保守费用上限，默认 30>' \
PM_DEEPSEEK_218_SUITE_ID='deepseek-218-<date>' \
pnpm pm:deepseek:218
```

先检查目录快照与离线契约：

```sh
pnpm pm:deepseek:218:catalog
pnpm test:pm-deepseek-218
pnpm pm:budget:test
```

评测器会按物理请求上限自动分片；`PM_DEEPSEEK_218_ONLY` 可定向执行，`PM_DEEPSEEK_218_PHASE` 与 `PM_DEEPSEEK_218_RERUN=failed|all` 用于显式修复阶段。`PM_DEEPSEEK_218_MAX_COST_CNY` 是整套累计上限，不是每个 shard 各一份。`PM_DEEPSEEK_218_REEVALUATE=1` 只复评已有真实响应，不调用模型。

## 证据边界

- 这是固定 218 题合成任务集，不等于任意客户业务、任意模型版本或长期生产 SLA。
- 内容质量使用确定性断言，不是人工盲评；100% 是该任务集的最终门禁结果。
- 代码验证仅覆盖 macOS Seatbelt + Node 24 零依赖 ESM，不证明 Windows、Linux、其它语言或任意恶意代码安全。
- Search 能证明真实回执与同域引用，不证明所有返回内容都绝对权威。
- 402、网络未知结果和未取得 usage 的请求保留为不完整计量，不把缺失数据写成零。
- `deepseek-flash` 是可变别名；本轮模型版本事实以官方公告和逐请求回执为准，后续必须重新核验。
