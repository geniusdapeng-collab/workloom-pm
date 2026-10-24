# PM 专属验收入口

这些入口位于现有 `apps/server/src/industry/**` 产品保留面。公共基座同步不下发 PM 任务、模型评测材料或行业实现依赖；没有为这些入口新增同步例外。

从仓库根目录执行：

```sh
pnpm test:pm-dsh
pnpm pm:eval
```

`test:pm-dsh` 显式使用 Node test runner 运行 `dsh-integration.mts`。它真实启动锁定 DSH 子进程，模型由本地确定性夹具提供，验证读写产物、会话日志、Unicode、越权拒绝、调用预算、配额错误、缺失计量、取消和超时；不调用收费模型。该文件有意不以 `.test.mts` 命名，避免服务端的 Vitest 自动发现把 Node test runner 入口重复执行。

`pm:eval` 运行 `evaluate.mts`，保留真实 HTTP、单员工、跨员工 DAG、独立代码验收、意图与岗位路由及官方搜索评测。它必须由已经配置的 loopback 预算代理保护，真实凭据只存在代理进程；实际调用受同一个持久化预算 run 约束。文件迁移不改变评测数据、收费上限、恢复阶段或判分规则。完整运行规范见仓库根 `docs/PM-EVALUATION.md`。

来源完整性单元测试位于本目录上一级的 `aipm-integrity.test.ts`，由服务端 Vitest 常规发现。可单独执行：

```sh
pnpm -C apps/server exec vitest run src/industry/ai-pm/aipm-integrity.test.ts
```

`PM_DSH_EVIDENCE_ROOT` 可显式保留真实 DSH 夹具证据；`PM_DSH_PACKAGE_ROOT` 仅用于明确选择正式 npm-ci desktop stage。两者都没有设置时，DSH 入口使用服务端自己的声明依赖，临时目录仍位于本任务仓库父目录，完成后按原规则清理。
