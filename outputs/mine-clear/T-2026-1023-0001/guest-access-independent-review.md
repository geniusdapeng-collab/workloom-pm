## 覆盖率声明

- 本次复核范围内源文件总数：8；精读：8；机检/脚本解析：0；抽样：0；未读：0。
- 完整文件名、当前 SHA256 与逐文件阅读方式见 [guest-access-coverage.json](guest-access-coverage.json)。React、React Router、UI 包实现及无关页面没有重新语义审计；不把这次范围扩展为全仓精读。
- 复核源提交：`cc86cf9dee7101131912cd0e427b78a90d3494aa`。本审查者 `/root/intent_audit` 未修改本次三个修复源文件。

**A：源码结论。** `NavigationAccessDenied` 只在服务端权威响应的 `subject.kind === "guest"` 时给出正式 `/login?next=` 链接；`next` 来自当前 pathname、search、hash 并经过 URL 编码。它没有签发令牌、调用开发登录、改变导航授权集合或绕过行业注册表。已登录但无权限成员保留管理员提示；未安装能力、配置不一致、权限服务失败仍走已有失败路径。通用导航、能力边界与行业边界共用同一禁止呈现，私有页面仍须原授权判断通过才能渲染。

**B：实际回归结果。** 在清空模型及 GitHub 凭据环境的子进程中，对该干净提交独立运行三个文件，实际 `22/22` 通过、`0` failed、`0` skipped/pending/todo：新增游客 DOM 7 例、既有行业注册表 10 例、既有导航权限 5 例。原始 JSON 已保存为 [独立回归记录](discovery/pm-guest-entry-independent-green.json)。它覆盖游客跳正式登录、成员无权、成员获权、身份切换重新读权限、查询错误失败关闭，以及既有路径/命名空间/Bundle来源规则。

**B：发现来源。** 首装真实 production guest 的旧观察显示，派生 PM 产品默认 `/development` 被正确禁止，但主区域只给管理员说明和返回链接。原回执与截图分别保存在 [before 回执](discovery/pm-packaged-guest-before.json) 和 [before 截图](discovery/packaged-guest-access-before.png)。这是派生产品修复期间暴露的首用交付缺口；没有把它表述为原 `e5d76398484cac7d8ac50b6c27905765a59fd50f` 产品的动态失败证据。

**B：台账准备。** `MC-120` 是 `MC-009` 的子修复，作者 `/root/deepseek_research`，独立验收角色 `/root/intent_audit`。新增 `guest_access` 组要求精确三个文件、至少 22 个真实 passed、无 skip、单 worker。台账现有 34 卡（14 问题、20 修复）、19 断言组；actor plan 已绑定上述源提交。正式 MCD 仍须各实际会话依次取得共享执行槽，先全部 repair，再全部 acceptance。这次直接 Vitest 记录不是正式角色运行回执。

## 收尾报告

- 已完成：完整读三个修复源文件及相关导航/客户端接口/测试共八文件；独立读 before receipt/截图；在最终干净提交直接复验 22 例；补录 MC-120、guest_access wrapper、spec、actor plan 和证据散列。
- 未完成/未覆盖：本报告出具时正式 MCD 尚未执行；最终 fresh `.app` 首装 UI 验收由真实打包会话另行记录。这里的 DOM 测试不代表签名发行或生产任务实测。
- 自主追加事项及理由：把既有行业注册表、导航权限用例一起纳入 22 例断言，防止登录入口修复损伤现有权限合同。
- 采用的假设：本次只改善服务端已识别游客的正式登录路径，不改变需要什么权限；新产品来源与原源码历史继续分别保留。
- 置信度：高；完整源文件阅读与 clean SHA 下的独立 DOM/权限合同回归一致。最终安装包行为仍以其真实 fresh support 回执为准。
- 建议复核：MC-120 的来源声明；`NavigationAccessDenied` 的 guest 分支；正式 MCD 运行后 sourceCommit 与实际 actor 分离记录。

## 自检表

- [是] 覆盖了本次委派的全部范围，而非挑了容易的部分。
- [是] 没有把可自主完成的事项推给用户，没有以不必要的问句收尾。
- [是] 结论有源代码、真实测试或明确待执行边界，证据等级没有混用。
- [是] 保留了原始失败观察、独立回归和角色执行边界，可供逐行复核。
