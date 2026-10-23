---
name: metric-digest
version: 1.0.1
description: 指标序列计算（同比/环比/阈值异动），产出日报/周报骨架。
delivery_contract:
  schema: workloom.pm.skill-evidence/v1
  claimTypes: [calculation, observation, hypothesis]
  denominatorAndWindowRequired: true
  zeroDenominator: undefined
  pointThresholdAloneFalsifies: false
  experimentFields: [effect, allocation, sampleSizeOrPower, statisticalDecision, uncertainty, guardrails]
---

# 指标日报与异动检测

## 一、何时调用
- 由对应数字员工按岗位任务触发；夜班任务按编排窗口执行。

## 二、输入契约
- 行业包种子数据/运行时事件流；外部信息必须带来源回执。

## 三、执行步骤
1. 读取带来源的指标序列，先记录每个指标的分子、分母、统计窗口、口径和 cohort。空数据或分母为零时标「未定义/不可计算」，不编成 0% 或成功率。
2. 逐式计算同比/环比/均线与阶段/全链转化率；独立复核人数、比例、百分点差和相对变化，给公式与舍入规则，不混用百分比和百分点。窗口或口径不一致时停止直接比较并列出缺失项。
3. 报告分开三类陈述：可复算的 calculation、材料直接支持的 observation、待验证的 hypothesis。阈值异动只能提示排查；跨周汇总不能推出新/存量用户或渠道的个体表现，点估计相同不能声称无显著影响，没有因果设计不能写成原因已证实。
4. 提出可证伪实验时，预先写清效应/最小有意义变化、随机分配、样本量或功效依据、统计判定规则、置信区间/不确定性与护栏；样本不足时结论为「证据不足」，不是假设已被证伪。不能仅凭观测提升低于一个百分点阈值就否定效应，也不能把随机实验对某个干预的作用直接等同于历史下降的成因。
5. 交付前交叉核对结论与表格公式，检查每个“说明/导致/显著/无影响”是否超出材料；所有疑似原因、实验参数假设和待核实混杂因素明确标出，生成可读的日报/周报。

## 四、边界与围栏
- 权限面：只读指标库（R-PM4）；报告写库（L1）。
- 写入级动作严格走 preset 的 fence_bindings；引用外部信息必须标注来源。
- 绝不编造：无工具回执的事实标「未核实」。

## 五、与其他技能的协作
- 产出进晨报素材池；异常与高威胁项挂审批台（review-console）。
