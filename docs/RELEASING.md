# CI 与正式发布

## 触发与门禁

普通分支 push 和 pull request 不触发 CI。推送匹配版本的 vX.Y.Z 标签触发 Ubuntu / Windows × Node 22 / 24 四项测试，全部成功才进入发布。workflow_dispatch 默认只测试；在版本标签上显式 publish=true 可重试发布。

每个测试任务执行锁定依赖安装、真实隔离 Git/SVN 测试、客户端构建/加载测试、严格包文件清单、同一 tgz 的 SHA-256 和生产依赖隔离安装。Windows SVN 下载归档校验 SHA-256；UTF-8 manifest 修改仅针对临时 CI 工具，不改用户机器上的 SVN。

## 单包发布顺序

1. 校验标签等于 package.version，所有 job 固定触发 SHA。
2. release job 下载已通过 Ubuntu / Node 24 验证的 tgz，不重新构建或打包。
3. 复核 SHA-256，对该 tgz 再做一次隔离安装；保留 Actions 制品。
4. 仓库 Secret NPM_AUTOMATION_TOKEN 注入 NODE_AUTH_TOKEN，npm publish tgz。
5. 最多约 5 分钟等待 npm 传播，下载 npm 包并核对 SHA-256。
6. 只有 npm 包验证通过，才将同一 tgz 与校验文件加入 GitHub Release。

缺少 token、npm 认证错误或包校验失败时，不创建 GitHub Release。不能把本地 npm publish 当作替代。若 npm 已发布但后续步骤失败，保留 Actions 制品，必须验证现有版本字节完全相同后再修复 Release；不得覆盖 npm 版本或移动已公开标签。

## 操作

~~~sh
npm ci --include=dev --ignore-scripts
npm run check
npm run verify:package
npm run test:install
git tag v0.1.1
git push origin main
git push origin v0.1.1
~~~

正式发布不自动安装、升级或重启当前 DSH。当前真实宿主 GUI / 真实模型端到端未验收，必须在发布说明中保留，不得将 stub host 测试描述为真实 GUI 验收。
