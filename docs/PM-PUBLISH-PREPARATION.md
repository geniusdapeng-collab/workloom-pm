# 源码首次发布准备与历史验收边界

本次发布准备收紧继承的镜像范围，将已完成的排雷证据随源码保留，并为附件中的两处无密码测试数据库地址登记内容绑定的扫描误报。`safety-gate.yml` 的 `mirror-backup` 现在只允许 `geniusdapeng-collab/workloom-im` 的 main push；PM 副本继续运行原 `guard-and-classify` 和 `static-and-tests`。其它工作流及镜像实现未在本增量修改。

## 历史证据保持原样

`outputs/mine-clear/T-2026-1023-0001/` 完整复制自本任务外层证据目录：775 个文件、3,096,866 字节。每个文件的相对路径、SHA256、长度与模式见 [附件清单](pm-publish-preparation/attachment-manifest.json)。复制前目标不存在；无覆盖、无冲突，原目录在复制前后未变。

这些证据的最终修复/独立验收精确绑定：

`686c07a7f0e266ff91660c4680f9d8fa4d8c980d`

本次增加镜像仓库 guard、对应策略回归、验收附件及两条精确误报登记，不会把原断言的 commit、命令、角色、结果或 SHA 改成后续提交。附件内保留的绝对路径、旧失败、旧基线和阶段日志仍是原运行的历史事实。它们不是后续提交重新执行的证明；本增量策略回归单独记录，也不扩大真实模型成绩或生产验收结论。

## 本增量的验证与证据等级

- **A：** 完整阅读并修改 `safety-gate.yml`、`release-publisher-policy.test.mjs`、`sync/base-scope.json`，完整阅读现行秘密扫描器；本说明亦按最终内容全文复核。工作流只改镜像 job 的一行条件，未给原 guard/test job 加跳过条件。
- **B：** 775 个附件均作完整字节、模式与摘要校核；其中下列两份因扫描误报另全文阅读（A），其余 773 份没有语义精读。附件清单、实际日志与增量校核 JSON 为机器证据，没有把文件存在当成新提交验收通过。
- 新增策略先在旧 workflow 下实际失败：PM main push 被错误允许（6 用例中 5 通过、1 失败）。修复后，直接发行/Action 信任策略 **10/10 通过、0 跳过**；新增用例执行 8 组仓库/分支/事件条件，并检查原检查 job 和依赖链仍启用。日志见 `pm-publish-preparation/policy-before.log`、`policy-after.log`。
- 首轮完整秘密扫描真实保留 **BLOCKED 两项**：`assertions/run-group.mjs:18` 和 `composition-limits-report.md:22`，均为无密码、无密钥的 loopback 隔离测试 PG 地址。全文审阅后仅在现有 `acceptedBaseSecretScanFindings` 中各登记一次完整文件 SHA、`literal-sensitive-assignment` 规则和准确行号；旧例外、scanner、include/exclude 与其它路径不变。复扫使用这些真实登记生成内容绑定的 diff manifest，原始阻断日志保留，未改成通过。
- [增量校核记录](pm-publish-preparation/validation.json) 绑定本次文件摘要、附件复算及其它工作流原样检查。此次没有联网、调用模型、提交、推送、运行全量测试或重写 MCD 台账。

## 提交说明

仓库既有 `.gitignore` 忽略 `outputs/` 和 `*.log`。发布协调者需对上述任务附件目录和两份策略日志显式纳入本次提交，保留原字节；不要为提交历史证据改变全局忽略策略，也不要将当前任务凭据写入附件、remote、日志或提交。

正式 main/PR 检查和远端回执由发布协调者针对实际新提交记录。原 686 的修复与验收事实保留其原版本，不通过修改旧证据制造新提交的绿记录。
