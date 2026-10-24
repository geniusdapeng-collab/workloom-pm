# PM 默认验收配置

`acceptance/profile.json` 声明的是 WorkLoom PM 的验收目标和运行边界。配置有效只说明字段、岗位和任务契约彼此一致；它不表示真实模型、用户体验、团队交付或完整 RDAS 已通过。

原上游 profile 已原样保存为 `docs/upstream/acceptance-profile.json`。这份快照保留原产品身份、预览命令、模型清单、生图、生视频、宿主 bash 和多模态任务，用于追溯继承来源。对应实现没有删除；它们不属于本轮 PM 默认授权代表任务。

默认产品身份来自 `product.manifest.json`：`geniusdapeng-collab/workloom-pm`、WorkLoom PM、industry、ai-pm。源码预览首入口为 `/development`。默认仍是 `local-preview`、`dataMode=simulated`、`allowWrites=false`，不能把它解释成生产客户端已经验收。

## 启动声明

profile 使用现有源码入口组合成四进程命令，不调用上游 `preview:all`。

| 方案 | 实际行为 | 适配选择 |
|---|---|---|
| 上游 `preview:all` | 固定旧端口，清理监听进程，执行迁移和所有种子 | 保留资产，不作 PM 默认命令 |
| `pnpm app:dev` | 按产品身份启动 PC/server 和 Electron，可能补下载 Electron；不启动两个移动端 | 保留为桌面开发入口 |
| 显式 server start 与三个 Vite 入口 | 指定本产品四个端口，前端 strictPort、loopback；不迁移、不 seed、不清理已有端口 | 作为 profile 的源码预览声明 |

| 端点 | 声明端口 | 来源 |
|---|---:|---|
| PC | 5373 | PC 源码默认 5173 + 产品偏移 200 |
| B 移动 | 5375 | B 源码默认 5175 + 产品偏移 200，以 WEBB_PORT/CLI 明确传入 |
| C 移动 | 5376 | C 源码默认 5176 + 产品偏移 200，以 WEBC_PORT/CLI 明确传入 |
| server | 8987 | server 默认 8787 + 产品偏移 200 |

这些是 profile 命令的标准端口，不是已经启动的证据。本轮只读校验没有执行该命令。真正启动前，使用本产品专属测试数据库和受控模型预算；现有 server 包含线程恢复逻辑，不能指向原 IM 或客户数据库。需要其它隔离端口的验收轮次应保存单独的显式 profile，记录其实际目标，不能将本配置的地址当作另一实例的指纹。

## 代表目标与证据

通用 O 域套件仍声明 chief-pm 的需求澄清正常、输入失败和无身份权限三路径；正常 P0 任务保留 k=5。该执行器使用 legacy thread 及事件读回，不能替代新 PM API 的团队 DAG 结果。

新 PM 团队的代表目标在 profile 的 `pmEvaluation` 中单列，由现有 `pnpm pm:eval` 驱动执行：

- 单员工需求文档：场景、优先级、字段和验收边界有具体产物。
- 四角色 Todo 项目：需求、实现、自身测试、评测和交付说明沿依赖传递，独立沙箱验证业务行为及长文尾标。
- 四角色容量账本：验证幂等、容量错误不改状态、释放、输入边界和副本隔离。

真实执行必须有本轮模型/responseId/usage、实际计划、产物及 SHA-256 读回、真正运行的独立断言和同一预算账本。首次、最新、所有 attempt 以及人工修复分开；没有运行的模型召回保持 null，规则路由另列。profile 中没有预填这些结果或伪造回执。

通用 `live.enabled` 默认关闭，models/tasks 为空，图像和视频可用数量为零。关闭的原因是该通用入口不能证明本产品 PM API 使用相同的逐请求预算合同；真实 PM 模型任务应使用本仓的专用 driver 和预算代理。不能为了满足配置 schema 添加虚构模型。

## 只读配置校验

```sh
node scripts/acceptance/profile-check.mjs
node scripts/acceptance/outcome.mjs --validate-only
```

上述命令只校验配置、Bundle 岗位引用与任务契约；`outcome --validate-only` 在登录、派单、数据库和模型调用前返回。合法配置可以退出 0，同时保留 `businessVerified=false`、`verified=false` 和 `status=unverified`。这与业务通过是不同的结论。

完整 `docs/acceptance/checklist.v3.json` 的 276 项继续保留在覆盖率分母。未执行项保持 not-run/unverified；移出默认代表任务不构成条目豁免，也不自动产生任何 pass。完整 UI、生产模型、长跑和 RDAS 结果需要对应真实执行证据。
