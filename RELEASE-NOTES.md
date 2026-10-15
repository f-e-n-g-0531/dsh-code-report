# DSH Code Report v0.4.6

## 修复子模块指针变化被本地配置隐藏

在变更路径、差异正文和统计三类 Git diff 命令中统一指定 --ignore-submodules=none，避免 diff.ignoreSubmodules=all 或子模块本地 ignore 配置将实际指针变化静默当成无变更。仍仅记录新旧 Subproject commit，不获取或递归分析子模块内部源码。不会修改用户仓库配置。

新增同一固定提交对在默认配置与两种 ignore=all 配置下，变更路径、正文和统计完全一致的回归。原有扫描、报告保留和安全边界保持不变。

真实 GUI、自更新和模型端到端仍未验收；此前页面退出的直接原因仍未确定。本版不自动安装或重启当前 DSH。
