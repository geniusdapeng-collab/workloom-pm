---
name: release-cut
version: 1.0.1
description: 发布与版本——合并基线、semver 建议、tag、changelog、版本台账。
delivery_contract:
  schema: workloom.pm.skill-evidence/v1
  modelReview: real-passed
  exam: real-completed-pass-or-reviewed-warn
  binding: [tenant, workspace, task, session, contentSha256, examId]
  warningNeedsHumanApproval: true
  missingEvidence: blocked
  mockEvidence: blocked
  humanApprovalSubstitutesEvidence: false
  recheckBeforeGitWrite: true
---

# 发布与版本

## 一、何时调用
- 人类在审批台批准发布（S5）后触发（S6）。

## 二、输入契约
- 当前租户/工作区的 pending_approval 任务单、对应机床 session、最新版本化 changeset、真实模型评审、同任务/会话考试原始记录、受审内容 SHA-256 与目标基线；人类批准记录。

## 三、执行步骤
1. 在任何 commit/merge/tag 写操作之前，重新回读当前 changeset 和真实 eval_exams/eval_answers，核对 tenant/workspace/task/session/examId、完成状态、分数、题目/答案数、完成时间与无红线记录；重新计算 worktree 内容 SHA-256，须与受审快照一致。旧 gates_passed=true 或人类批准本身都不能替代这一步。
2. 真实模型评审须明确 PASS；考试须真实完成且 pass，或保留全部真实 warn 证据并经人明确批准。缺模型、缺考试、mock、null/未知结论、绑定漂移、内容变化或检查失败均「未验证/blocked」，此时不提交、不合并、不打 tag。
3. 合格后才由系统在隔离分支兜底提交未提交改动，再 --no-ff 合并回目标基线；冲突自动中止转人工，绝不强合。
4. semver 建议 feat→minor / fix→patch / breaking→major（人类可改）；创建 git tag 与 changelog。changelog 可用明确标注的确定性文字模板，但这种文案兜底不能填补或绕过任何质量验证。
5. releases 版本台账登记版本、任务、审计哈希、实际合并 commit 与批准人；回读实际结果，不以计划文字声称发布成功。
6. 成功记录后清理该任务的隔离 worktree，场域反馈版本时间线；失败保留日志与可恢复证据，不清除业务事件或客户资料。

## 四、边界与围栏
- 推送远端永远走人类审批（默认关，开了也逐次批准）
- releases 属客户资产：一键清空不删（红线同 biz_events）
- 审计哈希随版本落库——每版都可回溯到三道关原始记录

## 五、与其他技能的协作
- changelog 复用 release-notes 技能口径；发布后反馈回流 user-listener 观察口碑。
