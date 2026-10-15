# CI 与正式发布

本文面向发布维护者。使用插件不需要配置 CI 或 npm token，请看 [使用说明](<../README.md>)。

CI 指 GitHub Actions 上运行的自动检查；tgz 是发布的安装包；SHA-256 用于确认包内容没有变化。

## 版本规则与发布要求

每次改动完成并验证通过后，主动提交、推送并发布正式版本，不停留在本地修改，无需再次提醒。版本采用 vX.Y.Z：X 为大版本，Y 为小版本，Z 为 Bug 修复；升级 X 时 Y/Z 归零，升级 Y 时 Z 归零。测试失败时先修复，不跳过发布门禁。发布不授权自动安装或重启当前 DSH。

## 什么时候运行检查

普通分支 push 和 pull request 不触发 CI。推送匹配版本的 vX.Y.Z 标签触发 Ubuntu / Windows × Node 22 / 24 四项测试，全部成功才进入发布。workflow_dispatch 默认只测试；在版本标签上显式 publish=true 可重试发布。

每个测试任务执行锁定依赖安装、真实隔离 Git/SVN 测试、客户端构建/加载测试、严格包文件清单、同一 tgz 的 SHA-256 和生产依赖隔离安装。Windows SVN 下载归档校验 SHA-256；UTF-8 manifest 修改仅针对临时 CI 工具，不改用户机器上的 SVN。

## 单包发布顺序

1. 校验标签等于 package.version，所有 job 固定触发 SHA。
2. release job 下载已通过 Ubuntu / Node 24 验证的 tgz，不重新构建或打包。
3. 复核 SHA-256，对该 tgz 再做一次隔离安装；保留 Actions 制品。
4. npm run release:npm 先检查固定版本。明确区分 absent（元数据 404）、pending（元数据已存在但 tgz 404）、ready（包可读）。pending 只等待不发布，确认存在后即使后续查询退回 404 也不再发布；ready 核对与 CI 制品字节一致并跳过发布；只有首次查询 absent 才使用 NPM_AUTOMATION_TOKEN 发布同一 tgz，随后等待传播核验。网络或权限错误不当成不存在，任何字节不一致立即停止。
5. 发布、独立核验和 GitHub 前置核验统一使用有界传播等待（每阶段最多 60 次、间隔 10 秒，另加请求耗时）；发布 job 预算 45 分钟。等待时记录状态，超时保留制品并报错，不放行 GitHub；发布成功但核验超时后可重跑失败 job，不重新打包。
6. npm run release:github 再核验 npm 和远端标签 SHA。新 Release 先建草稿；已有 Release 核对资产字节，只补缺失资产，不覆盖不一致资产。全部下载核验通过才公开草稿。

缺少 token、npm 认证错误或包校验失败时，不创建 GitHub Release。不能把本地 npm publish 当作替代。若 npm 已发布但后续步骤失败，保留 Actions 制品，必须验证现有版本字节完全相同后再修复 Release；不得覆盖 npm 版本或移动已公开标签。

## 部分成功后的恢复

优先在原始 Actions run 重跑失败的 release job，使其复用原 run 已通过的制品。新 workflow_dispatch 会重新测试打包，若已有 npm 字节不一致则必须停止；此时应取回原 run 保留制品恢复，不得移动标签或使用新包覆盖。npm 已存在时不重复 publish；GitHub 已有资产均先核验，缺失才上传。请求失败后先检查远端，再重跑，不在同一操作里盲目重放写请求。

## 操作

~~~sh
npm ci --include=dev --ignore-scripts
npm run check
npm run verify:package
npm run test:install
# 先更新 package.json、package-lock.json 和版本说明
# 将下面的 X.Y.Z 换成本次新版本，不要复用已经公开的标签
git tag vX.Y.Z
git push origin main
git push origin vX.Y.Z
~~~

正式发布不自动安装、升级或重启当前 DSH。当前真实宿主 GUI / 真实模型端到端未验收，必须在发布说明中保留，不得将 stub host 测试描述为真实 GUI 验收。
