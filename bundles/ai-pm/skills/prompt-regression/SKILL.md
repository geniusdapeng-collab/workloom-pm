---
name: prompt-regression
version: 3.0.1
description: 提示词回归。prompt 新旧版本 eval 回归 diff——通过率变化、退化案例 Top3、成本 delta；未通过阻断、通过转人审（R-PM8 双段门禁的执行器）。
delivery_contract:
  schema: workloom.pm.skill-evidence/v1
  rollbackEvidence: independently-passed-same-red-lines
  knownBadVersionEligible: false
  noSafeVersion: disable-and-human-review
  identicalRegressionContext: true
---

# prompt 变更回归

## 一、何时调用
- 任何生产 prompt 变更提交时（强制）；
- 两个 prompt 版本 A/B 对比评估时（评估方案须人审）。

## 二、输入契约
- prompt 旧版本与新版本（版本库登记）；关联 eval 集（核心路径+历史 badcase 全覆盖，不得只跑抽样好话术）。

## 三、执行步骤
1. 新旧版本在同一 eval 集上分别跑分（同一模型、同一参数）；
2. 产出 diff 报告：通过率变化、退化案例 Top3（具体到条目与差异）、新增通过案例、成本/时延 delta；
3. 判定：通过率下降或出现核心路径退化 → 阻断（R-PM8 block 段）；通过 → 提交人审（review 段）；
4. 人审批准后新版本生效；保留可回退版本及其原始回归证据，而不把「更旧」自动当作「更安全」。回退目标必须已由独立角色在同一安全红线、历史 badcase、模型/参数与数据口径下验证通过，且版本、输入集和运行回执可核对。
5. 材料明确存在漏洞的原问题版本不默认合格，不能在缺证时称它为「上一通过版本」。如果不存在已验证的已知安全版本，停止/停用受影响能力并转人工处理；不得为满足回退动作而恢复已知漏洞。

## 四、边界与围栏
- 权限面：prompt 版本库读写（R-PM8）；跑分走谷时窗口。
- 绝不编造回归结果；judge 参与评分时遵循 85% 一致率校准纪律，失准期 judge 结果仅供参考。
- 指令/数据隔离不能只靠标签声明：回归必须覆盖材料中嵌入闭合标签、伪造系统段与历史注入坏例；提示中「不会执行」不算通过证明。

## 五、与其他技能的协作
- 上游：prompt-curator 的变更登记；eval-forge 的 eval 集；
- 下游：changeset-harvest（DevFabric S4 的 eval 回归门禁即调用本技能）、release-cut（发布附回归摘要）。
