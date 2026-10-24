## 覆盖率声明

- 本次组合缝与执行限额专项范围33文件：精读6；当前字节/接口定位机检27；抽样0；未读0。完整清单、哈希、行数与阅读方式见 `composition-limits-coverage.json`。机检的27个直接依赖不代表逐行理解，未将它们写成精读。
- 本代理改动4个源码文件：`apps/server/src/trpc/router.ts`、`apps/server/src/industry/ai-pm/service.ts`、`one-shot-text.test.ts`、`team.pg.test.ts`。另完整复读新PM路由与类型。大组合根逐段读完原3766行至EOF后才修改。
- 更早的130文件原始意图审计、17文件团队实现与26文件门禁实现分别有独立覆盖记录；本报告不把1774个原始跟踪文件宣称为全量语义精读。其它无关传递依赖与第三方包源码未在此专项重新精读。

## 证据分级与结果

- **A：组合根**。行业组合根 `trpc/router.ts:3744` 导出通用 `productHttpRoutes`，仅这里引用 `/api/pm` 与 `createPmTeamRouter`。公共index由主代理消费可选数组；未改变HTTP合同，也未修改sync排除白名单。Hono的私有Variables不应带出组合根，因此使用内部装配用的 `Hono<any>` 显式类型擦除。
- **A：执行限额**。`service.ts:318` 默认DSH编码员工允许8次模型轮次；每次4096输出上限保持，所有实际请求仍受父代理全局预算硬闸。它允许读取上下文、写模块、复读模块、写测试、final等超过4轮的合法流程。
- **A：评测官正文**。`service.ts:71` 仅eval-master单文件正文使用8192输出上限，其余单文件3072、多文件4096。提示要求6条用例时逐条交齐前置、步骤与预期，并尊重任务明确要求的其它数量；`outputTokenLimit`写入成功/失败回执。空正文、截断、秘密、超字节或未知usage继续拒绝。
- **B：红绿证据**。新增两项要求后先跑23例，21通过、2失败；一个捕获评测官仍3072，另一个在真实DSH第5轮前被旧4次限额阻断。修复后4套43例全部通过、0跳过，包含29个合同/正文/结构化协议用例和14个真实PG用例。新PG用例实际运行DSH子进程5轮，产生两份文件，再由OS沙箱运行其测试，模型全部是本地夹具。
- **B：编译**。server typecheck退出0；`git diff --check`退出0。主代理另以独立会话运行167个最终专项用例全部通过、0跳过，原始JSON为主工作区 `work/pm-root-final-all.json`；本代理不把该结果冒充自身执行。
- **D：真实付费复验边界**。这些修改尚未在新付费窗口复验。既有40物理请求窗口已结束，本代理未发任何真实模型或Search/Fetch请求，也未重置父预算。

## 可复跑验证

从代码副本的 `apps/server` 运行，使用已批准的隔离PG55437：

```text
RUN_DB_TESTS=1
DATABASE_URL=postgres://pm_sandbox@127.0.0.1:55437/workloom_pm_sandbox
DATABASE_APP_URL=postgres://workloom_app@127.0.0.1:55437/workloom_pm_sandbox
pnpm exec vitest run src/industry/ai-pm/one-shot-text.test.ts src/industry/ai-pm/one-shot-response.test.ts src/industry/ai-pm/contract.test.ts src/industry/ai-pm/team.pg.test.ts --reporter=json --outputFile=<new-result.json>
```

每次新建随机tenant/workspace夹具，保留append-only业务事件；不重置seed或清除先前真实任务。

## 收尾报告

- 已完成：组合根全文件精读与HTTP扩展数组；DSH默认8轮；评测官单正文8192与其它限额区分；回执记录；2项红色复现；4套43绿色用例；server typecheck与diff检查；MCD12条不变量、9原始问题卡与15修复卡准备。
- 未完成/未覆盖：没有新付费模型复验；MCD正式repair/acceptance需主代理建立干净提交后按真实会话角色运行。公共闭包其它产品脚本位置和runtime锁由并行沙箱代理收口，未在本报告生成时冒充已绿。
- 自主追加事项及理由：给组合根显式Hono装配类型以阻止私有Authorized声明泄漏；在PG用例中实际跑5轮DSH与OS测试，避免仅检查常量就声称修复；回执记录实际输出上限便于费用/截断复盘。
- 采用的假设：评测官需要完整6用例时8192足够性仍须真实模型复验；增加局部轮次不会新增全局授权，父预算必须先拦；本次测试只能使用隔离PG与本地模型夹具。
- 置信度：代码、类型与免费运行行为高；未来真实模型产出质量和新的付费达成率未验证。
- 建议复核：`service.ts:71/318`限额选择；`team.pg.test.ts:152`真实DSH5轮及OS回执；MCD补录过程披露与后续干净提交/独立角色绑定。

## 自检表

- [是] 覆盖本专项全部改动、错误与真实执行路径，没有只检查配置常量。
- [是] 可自主完成项均执行，没有发起不必要确认或付费调用。
- [是] 精读、机检、夹具、真实PG/DSH/OS与付费模型严格区分，每个结论可回读。
- [是] 逐文件完整阅读并审查改动，红绿与类型证据可供独立资深工程师复跑。
