# 开发指南

本文面向修改插件或运行测试的开发者。使用方法见 [使用说明](<../README.md>)。

## 环境与验证命令

需要 Node.js 22 或更新版本、npm、Git。SVN 集成测试还需 svn 和 svnadmin。测试使用临时仓库，不读业务仓库。

~~~sh
npm ci --include=dev --ignore-scripts
npm run check
npm run check:static
npm run test:coverage
npx playwright install chromium
npm run test:browser
npm run verify:package
npm run test:install
~~~

- check：构建界面并运行 Node 回归，含真实临时 Git/SVN、模拟宿主/模型、预算及故障矩阵。
- check:static：解析运行时、脚本、JSX 和 JSON；不执行模块，也不是完整类型检查、依赖边界检查或 lint。
- test:coverage：单独收集覆盖率基线，不用测试数量代替覆盖率，不设未经验证的 100% 指标。
- test:browser：Playwright 真实浏览器加载插件构建产物及真实 ReactDOM，DSH 服务是可控模拟。测试夹具单独使用回环地址，不替换日常 DSH 页面；用例截图与 trace 可能含测试源码，只使用脱敏夹具。
- verify:package：先检查构建来源、包文件白名单及版本一致性，再生成 tgz 与 SHA-256。源码或依赖锁变化后需先 build；该命令不悄悄更新旧构建。
- test:install：在临时目录安装刚生成的包，验证服务端入口并执行客户端 factory、注册两个界面插槽，核对内嵌构建身份；不安装到日常 DSH。

真实宿主、原生自更新、真实模型质量和 SVN HTTP/HTTPS 组合另见 [验收清单](<ACCEPTANCE.md>)。浏览器夹具或隔离安装不能替代它们。开发时不要自动安装、重启用户当前宿主。

## 架构与代码入口

保持一个 npm 安装包、两个运行入口，不另外启动生产 HTTP 服务：

- [宿主入口](<../index.mjs>)：注册 DSH 服务。
- [宿主编排](<../src/host.mjs>)：会话目录、预览生命周期、进度、限流、确认与分片重试。测试依赖注入仅为进程内接口，不接受 RPC 覆盖。
- [共享协议](<../src/protocol.mjs>)：通道和协议版本，不能依赖 Node 或 DSH 服务。v0.10.0 沿用协议版本 3，包含结构化执行恢复状态；v0.7.0 的协议 2 界面不能绕过版本门禁，升级后需重载前后台。
- [采集](<../src/collect.mjs>)、[预算](<../src/budget.mjs>)、[路径](<../src/paths.mjs>)、[进程](<../src/process.mjs>)：固定版本、来源、增量资源控制及取消。
- [远端 Git](<../src/git-remote.mjs>)：读取业务仓库原始远端配置，在临时裸仓库查询和完整抓取，回调后清理；不写业务仓库。
- [证据索引](<../src/evidence.mjs>)：格式版本 2；统一解析文件清单与差异块/源码单元，ID 绑定快照和准确文本，不重写差异正文。SVN property 头和值分开；路径只精确匹配 included 列表，不能按块序号猜测。无可归属文本的 included 文件/目录（含空字符串根路径）生成独立 scope 范围证据，计入片数及输入预算，不当作正文覆盖。SVN 在排除内部路径后逐 entry 读取时可附 diffParts:{path,start,end}，以完整 diff 的 UTF-16 连续区间绑定采集路径，不改原始正文；整仓 diff 或外部旧快照没有此元数据时不能假定同等定位能力。
- [结构化分析](<../src/analysis.mjs>)：保守输入预算、顺序分片、输出与引用校验、确定性 Markdown。旧 analyze API 保留供直接调用兼容，宿主新生成流程不回退自由 Markdown。
- [报告组装](<../src/report.mjs>)、[文本转义](<../src/markdown-text.mjs>)：统一转义标题、来源、哈希、日期、限制与非受信任分析字符串等字段；保留原始 diff 围栏和 snapshot。旧 analyze 字符串仍原样返回，markdown 入口将自由文本安全呈现；markdown 的可选第四参 {structured:true} 仅供宿主传入 analyzeReport 程序生成且字段已转义的分析，不根据输入字符串识别可信标记，也不接受 RPC 任意声明。
- [界面](<../src/client.jsx>)、[结果内存](<../src/result-state.mjs>)：配置、快照、报告分开；不保存模型同意，不把源码自动写入 localStorage。
- [生命周期控制器](<../src/lifecycle-controller.mjs>)：在插件 apply 实例登记模型任务身份，协调业务与安装租约；面板挂载周期不拥有付费任务。该租约不是跨标签或跨客户端的全局锁。
- [更新界面](<../src/UpdatePanel.jsx>)、[更新控制器](<../src/update-client.mjs>)、[版本查询](<../src/updates.mjs>)：明确确认、原生安装、互斥及重启提示。

界面使用构建时版本，后台版本在模块首次加载时固定。主页面先校验包身份、版本和协议，再自动发现一次。刷新页面不重载后台；生产宿主更新需要按原生结果手动处理，不承诺热更新。

## 发现、端点和上下文

首次只扫描根目录和一级子目录，不进入更深目录；最多 500 项目、100000 目录、约 120 秒循环预算。循环预算不保证正在等待的文件系统读取及时返回，不能将其称为文件系统硬时限。跳过点前缀隐藏、常见缓存及链接目录（不按 Windows Hidden 属性筛选）；合并保留已有输入，新项目不选中。

Git 行字段 gitMode 为 remote/local，gitRemote 为远端配置名。UI 新建及旧配置缺字段均默认 remote/origin；选择远端模式即允许访问该配置远端，不另加网络 checkbox。UI 始终显式发送模式；旧 RPC 未提供 gitMode 时，后端兼容为 local，不把这一兼容默认用于新界面。切换模式或远端名清 refs、preview 和 consent，保留 A/B。

远端模式先验证业务 root、读取唯一的原始 remote.<name>.url 与 sha1/sha256 格式；地址仅内部使用，不在返回值或错误中回显。配置名不是 URL。listRemoteRefs 用 ls-remote --symref 查询分支和标签，去重并排除 peeled tag；后续采集重新查询，在独立临时 bare 仓库完整 fetch heads、tags 及可达历史，不依赖业务 object store。支持 file/http/https/ssh/git、scp 和本地路径地址，拒绝 ext:: 与任意 remote helper。withRemoteRepository 回调仅给 {remote,observedAt,source:"remote"}，finally 清理临时目录，不 checkout/pull/merge，不修改业务 objects/refs/worktree；失败不回退本地。完整历史消耗网络、临时磁盘和时间，仍受系统资源限制。

normalizeRemoteRef 仅将匹配所选远端的 origin/name、refs/remotes/origin/name（以 origin 为例）映射为 refs/heads/name；其他 main/develop、标签、SHA 和 HEAD~ 表达式保持 Git 解析，标签可用 refs/tags/name 避免歧义。HEAD 先按远端广告观察，再校验抓取后的目标 hash 相同；移动时失败并要求重采。其他分支取 fetch 时版本，observedAt 是抓取完成后的观察时间，不承诺所有远端引用或跨项目原子一致。A/B SHA、差异及固定版本源码在临时仓库内读取，临时目录释放后生成只使用快照，不重新访问 Git 远端。

网络 runner runGitRemote 的 authenticationRoot 仅用于配置预检 cwd，调用方传入已验证源仓库 canonical root；读取 --includes 后的有效认证配置，只保留 credential.*、http.*、core.sshCommand、ssh.variant，以 GIT_CONFIG_COUNT 重注入实际网络进程。transportOptions 显式剥离 authenticationRoot，实际网络 cwd 始终为自有临时目录，禁用全局/系统配置，不在业务仓库执行传输。旧版只从临时目录读取 global/system 认证，遗漏仓库 local core.sshCommand；修复不表示用户凭据原本错误。

配置预检清除继承的 GIT_*；只有网络进程重新保留显式 GIT_SSH_COMMAND、GIT_SSH、GIT_SSH_VARIANT，其他 GIT_ 注入仍清除。本地 runGitRead 维持严格隔离不变。URL rewrite、hooks、remote uploadpack 与 ext/任意 remote helper 不继承，认证白名单不是复制全部源仓库配置。仓库 local 认证程序与用户 global 认证程序一样是用户信任的可执行代码；不能承诺不执行 helper 或提供 OS 网络/进程沙箱。相对 -i 或命令路径不改写，仍按临时 cwd 执行，建议绝对路径或 SSH 配置；公网认证组合另行验收。

remoteFailureDiagnostic(error) 只返回固定 kind/hint：SSH 身份/公钥/主机密钥、DNS、代理、连接、TLS、HTTP/通用认证、仓库权限、缺失工具及 unknown。safeFailure 维持 code-report/git-remote，在 Error 上附 diagnostic 分类，但不保证宿主 RPC 保留该属性；UI 可见的是固定中文指导。不拼接原始 stderr/stdout/error，不公开 URL、凭据或密钥路径，不自动关闭主机或证书校验。分类用于排查，不是根因证明，未匹配时保留泛化提示。网络 execute 使用 killTree:true：POSIX 独立进程组先 TERM、随后 KILL，Windows 使用 taskkill /T /F，等待自有传输进程树停止及 close 后才返回，由上层 finally 清理临时目录。取消语义是停止本地自有传输进程树并清理临时目录；不保证远端服务器撤销请求，不等于服务器端事务回滚。

本地离线模式、业务元数据及临时仓库内的只读差异/源码使用 runGitRead：清除继承 GIT_*，设置 GIT_NO_LAZY_FETCH=1、空 GIT_ALLOW_PROTOCOL 和 protocol.allow=never；缺对象失败，不自动联网补取。普通 run 供测试建仓等用途，不代替两类专用 runner。Git patch 显式固定前缀、行标记、word diff、算法与 hunk 相关选项，不宣称隔离所有仓库配置。

SVN 两侧仍须仓库相对分支路径；版本可留空取各分支最新一次提交，显式历史版本仅接受数字或 r 前缀。固定两侧 peg/operative 端点并验证 UUID 和仓库根一致，不允许任意 URL，历史读取授权不变。

contextPaths 为显式工作区文件或目录路径列表，允许根目录 `.`；目录递归展开为实际文件。展开跳过点前缀隐藏、敏感、依赖、构建和缓存路径、链接及非普通文件，limitations 记录排除计数；显式敏感路径仍拒绝。隐藏判断只基于点前缀，不读取 Windows Hidden 属性。目录展开不设固定条目、目录和深度上限；任一待附带文件含 NUL、UTF-8 与 GB18030 均无法解码或无法读取都使整次采集失败，不静默跳过或截断。

versionContexts 为 {repository,path,side:A或B} 列表，repository 必须是已选项目，仍仅支持文件、不支持目录；内容只能从固定版本读取，不存在/非普通文件/符号链接/含 NUL/不支持的编码时失败，不回退磁盘。context 条目记录 provenance、repository、revision 和哈希。当前工作区源码不作为历史版本证据。预览展示展开后的实际文件清单与 limitations，操作者核对后才明确授权模型；不改变付费任务生命周期。

## 正文解码与原字节追溯

[正文解码器](<../src/text-encoding.mjs>) 对完整源码先使用 fatal UTF-8，失败后使用 fatal GB18030（兼容 GBK）；差异先按原始 LF 字节分行，每行执行同样顺序，保留 CRLF、孤立 CR、BOM 与末尾换行状态。不按整份 diff 回退，以免把 UTF-8 路径头与 GBK 代码分别占行的内容一起错误解码。编码标签为 `utf-8`、`gb18030` 或差异中的 `utf-8+gb18030`，ASCII 不单独证明某种编码。

此规则不是完整编码检测器，不保证同一行混合编码或同时合法的 UTF-8/GBK 字节的作者意图；不修复已有乱码或 U+FFFD，不修改源文件。含 NUL 先拒绝（不自动解码 UTF-16）；两种 fatal 解码都失败时拒绝，不制造替换字符。默认命令文本输出仍严格 UTF-8，用于路径名单、refs、SVN XML 等元数据；仅正文读取请求 raw 字节并调用解码器。

context 条目的 `encoding` 记录所用编码，`hash` 与 `rawHash` 都校验原始文件字节。仓库 `diffEncoding` 记录差异解码路径，`rawDiffHash` 校验原始 diff 字节，`diffHash` 校验解码后 UTF-8 文本。SVN 排除内部路径后的逐 entry 读取以读取顺序拼接原字节计算 rawDiffHash，不是全仓未过滤 diff 的哈希。报告分别展示原字节与文本哈希；证据索引和片预算使用解码文本，不把文本哈希冒充原字节身份。

## 分析与资源契约

一次仍为 1–12 项目。工作区与固定版本源码路径条目、实际文件数量、单文件大小、总证据和单命令 stdout 不再有默认固定规模上限；采集命令和采集请求不再强制 60/240 秒截止，调用者显式预算及取消仍可生效。stderr 诊断有界，取消等待子进程 close，源码句柄 finally 关闭。旧配置 allowBatches 字段兼容保留，不再充当采集规模开关；采集能力与模型策略分离，宿主/UI 现在默认 single-request 摘要而非 full 分批。项目自动发现仍保留浅层扫描与数量/时间预算，预算中断返回部分发现及提示。这里的无固定规模上限不等于无限资源：快照、证据索引、报告与 UI 清单仍占用内存，受操作系统、工具和模型能力约束；不得静默截断或用提高常量冒充解除上限。

preview 返回 expiresAt、固定版本元数据、本地 Markdown 和 analysisPlan。createHandler 默认计划器强制 strategy:"single-request"，默认 inputBudget=64000；analysis-plan 可在 4000–64000 字节间重规划，不能从 UI 切为 full。计划只公开 ID、所选证据 ID、片数、预算与 coverage，不返回内部 payload。默认计划器规划失败时仍以 localManifest 生成 compact 本地报告，不 full fallback；不要因异常预算/巨大标题就把全部 diff 重新嵌入报告。字节包含提示与 JSON 包装，不是 tokens 或适配器实际 wire 长度；必要项目统计或单条元数据无法容纳时拒绝规划。库级 createAnalysisPlan 默认仍为 strategy:"full"、inputBudget=24000，可完整分片，不代表宿主/UI 默认行为。详见[单次摘要实现与限制](<SINGLE-REQUEST.md>)。

generate 必须提供 sessionId、previewId、匹配的 planId、route、sendToModel=true 及由前端先登记的 operationId；派发前重验会话目录和取消。single-request 计划必须恰好一份 payload，宿主同次生成只允许一次 llm.stream 派发，无隐式第二次模型请求或自动重试；再次明确确认仍可能计费。底层适配器或网络重试不能仅由插件 dispatchCount 证明，次数不是供应商计费承诺。模型只返回五组数组 changes/interfaces/impacts/qa/unknowns，每项 text/evidenceIds。非未知结论必须引用本片有效证据；未知无引用时明确限制。拒绝自由 Markdown、无效引用、工具调用、截断、未 stop 和结束后输出。每片模型输出含推理最多 256 KiB，maxTokens=8192。

计划与 checkpoint 格式版本均为 2；计划 ID 绑定证据格式、提示及分片 payload 哈希。已完成片必须校验格式、payloadHash、planId、batchId、provider/model 与条目 schema；旧格式或异内容不复用，不悄悄当成功。

成功结果附实际已发送 evidence.text、sourceHash/blockHash、证据 ID 与 UTF-16 start/end 偏移；它们不是源码行号或字节位置，实际正文附录可供复核但不是完整原始差异。完整 local manifest 不等于模型收到完整路径元数据或全文。single-request 的 generated/priority 仅为路径启发式，按仓库轮转选取预算内元数据和最多 1024 UTF-16 单元的正文前缀；二进制及识别为生成物的正文不发送。不是语义重要性分析，也不把摘要汇总称为完整跨仓调用图。引用有效只证明定位成立，不证明结论正确；已处理片数不等于代码理解覆盖率。质量评测应人工检查接口漏报、误报、证据支持度及 QA 可执行性，不能只验证 schema。

预览宿主内存最多 16 项，不设固定总源证据字节上限，完整 snapshot 不自动落盘；snapshotJsonChunks 对普通捕获快照按精确 JSON.stringify 字节分块遍历，snapshotJsonBytes 与 snapshotHash 共用该序列，避免整个大 JSON 中间字符串；口径/哈希/计划身份保持不变，但快照本体和后续解析仍占内存。单次摘要 Markdown 不内嵌全部 diff，不能据报告清单或哈希重建原文。当前 UI 无完整快照导出入口，所需归档必须由操作者在预览释放/过期前通过受控本地流程显式保存。开始分析前满 10 分钟拒绝；重规划不延长有效期。进行中预览不被清理；成功删除预览，并按 operationId 在进度缓存中短期保留可只读恢复的报告；若生成响应丢失，只查询 result，不自动重发模型调用。报告缓存不设固定正文总字节上限，终态记录 10 分钟，受进度容量淘汰；未知状态提示操作者先恢复，不保证永久留存。result 结构化区分 completed（正文可用）、pending（仍在运行）、stopped（宿主本地停止）与 unavailable（完成但正文不在）；记录过期或归属变化不能证明未执行。execution 包含 backendInstanceId、dispatch/dispatchCount、completedBatches/totalBatches、resultAvailability 和本地阶段；次数是本地派发记录，不是供应商计费收据。同 operationId 仅允许完全相同的会话/目录/端点/请求指纹：已完成且正文还在可重放结果，其他情况只读核对不重派。后台实例保留最多 1024 个付费 ID 身份，达到上限拒绝新付费任务，不静默忘记后复用。恢复或下载不会释放名额；先核对并下载需要的结果，再由操作者有计划地重载，重载会丢失内存身份及报告，不会续跑或迁移任务。失败保留已校验片及覆盖信息，只有同计划、同路由可再次确认后重试剩余片；改变计划/路由清缓存，不自动重试模型。若请求已发送，撤回与计费依服务端而定。

报告按 session+cwd 在当前插件实例内存保留当前展示与最近成功模型报告，最多 16 会话，按会话数量淘汰，不设默认正文总字节上限；大报告更耗内存；新本地采集不覆盖最近模型副本。修改草稿只作 stale 标记，不把旧报告当新范围结果；切回会话不恢复模型同意或活动预览。未知结果的恢复身份不随报告正文 LRU 淘汰。付费任务归 apply 实例而非 Panel 所有；离开面板或切换会话不等于取消，结果写回原 session+cwd。取消后仍保留任务身份，须只读核对；不能按错误文案推断未派发、未计费或可安全重试。业务、refs 与安装使用同实例租约，最多一个 active/unknown 付费任务；结果未知时阻止新业务及安装。只读恢复和下载不受新业务版本/更新门禁控制，但恢复仍须通过宿主会话权限检查。明确停止后仍需新 operationId 和重新授权才能重试；放弃恢复只标记操作者意图，不释放未知任务租约；仍须宿主明确 stopped/completed 后才能新业务或安装，不停止供应商请求，也不证明免费。刷新/重载会丢失前端内存，不承诺跨刷新、宿主重启恢复或供应商 exactly-once；刷新/重载前应恢复并下载。

## 安全与可重复证明

保留路径包含及敏感路径检查、正文读取前排除 .git/.svn、无 shell、Git 环境清理及禁外部 diff/textconv。不是完整密钥扫描，也不保证所有文件替换竞争被隔离。报告纯文本展示；下载的阅读器有独立安全边界。

固定夹具测试用于证明稳定格式、字节覆盖、结构/引用约束、预算和失败行为；历史发布记录中的 32 场景验证是当时记录，不将它宣称为本次可重跑证明。新增评测样例与逐步验收见 [验收清单](<ACCEPTANCE.md>)。

## 提交与发布

自动流水线仅由版本标签或手动触发，普通分支和 PR 不触发。复用已测制品，不在发布环节重新打包或覆盖异字节资产。见 [发布指南](<RELEASING.md>)。源码、标签与 npm 版本必须一致；发布结果须独立核验，不等于当前 GUI 已更新。
