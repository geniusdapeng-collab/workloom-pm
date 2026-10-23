---
name: changeset-harvest
version: 1.0.1
description: 变更回收与三道关审计——diff 收集、硬门禁、LLM 评审、上线考。
delivery_contract:
  schema: workloom.pm.skill-evidence/v1
  modelReview: real-passed
  exam: real-completed-pass-or-reviewed-warn
  binding: [tenant, workspace, task, session, contentSha256, examId]
  warningNeedsHumanApproval: true
  missingEvidence: blocked
  mockEvidence: blocked
  humanApprovalSubstitutesEvidence: false
---

# 变更回收与三道关

## 一、何时调用
- 机床会话以 done 终态结束时自动触发（S4）。

## 二、输入契约
- 当前租户/工作区内的任务单、机床会话、worktree（含未提交及未跟踪改动）、验收标准和基线分支；实际测试/模型评审/考试回执。

## 三、执行步骤
1. 回收 git diff 与未跟踪文件、机床自总结；在执行门禁前生成当前受审内容的 SHA-256 快照，绑定租户、工作区、taskId 和 sessionId。自总结、变更统计都不能替代文件内容或运行证据。
2. 第一关：仓库自带 typecheck/lint/test 逐个实际运行并记录命令、退出码和日志，再做变更文件凭据泄露扫描；失败、超时或缺执行证据均不得通过。
3. 第二关：真实模型评审须取得明确 PASS 及依据，回执标记为真实、已完成。模型未配置、调用失败、空报告、模拟报告或未完成状态一律记「未验证/blocked」，停止自动交付；不得降级成放行，也不得把人工批准描述成已完成模型评审。
4. 第三关：真实运行 eval-core 变更考试；从同一工作区的 eval_exams/eval_answers 回读当前 taskId/sessionId 对应考试，要求 status=done、有效分数、完整题目/答案数、完成时间、无红线命中。pass 可以进入待批准；真实完成的 warn 必须显式保留警告并交人批准，不能叫无条件通过。fail、null、未知、模拟、缺题/答案或绑定不一致均阻断，不能只判断「不是 fail」。
5. 回读门禁后的当前文件快照，须与受审 contentSha256 一致；内容变化时原证据失效，重新审计。把版本化门禁、内容摘要、真实考试及依据写入 dev_changesets；有完整合格证据才进入 pending_approval，仍不等于已发布。
6. 区分修复对象：实际检查失败可带依据交 dev-dispatch 返修（≤2 轮）；模型/考试基础设施不可用时先恢复验证条件或转人工处理，不自动重复付费开发。

## 四、边界与围栏
- 硬门禁在 worktree 内执行，超时 180s 逐关熔断
- 评审报告与 diff 原文可互相印证，绝不只给结论不给依据
- 当前模型评审实际消费了哪些材料必须如实说明；仅看变更统计时不能宣称逐行代码审查。
- delivery_contract 是本技能的证据纪律，不是实际通过证明；真实完成状态以服务端回读的同范围、同会话、同内容证据为准。

## 五、与其他技能的协作
- 全过产出发布卡素材（P25 审批视图）；未过原因交 dev-dispatch 组织返修。
