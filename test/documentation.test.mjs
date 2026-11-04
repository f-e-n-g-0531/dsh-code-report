import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile,access} from 'node:fs/promises';
import path from 'node:path';
test('public documentation versions labels links and boundaries match the package',async()=>{
 const pkg=JSON.parse(await readFile('package.json','utf8'));const readme=await readFile('README.md','utf8');const client=await readFile('src/client.jsx','utf8');const development=await readFile('docs/DEVELOPMENT.md','utf8');const notes=await readFile('RELEASE-NOTES.md','utf8');
 for(const match of readme.matchAll(/@feng0531[/]dsh-code-report@([0-9]+[.][0-9]+[.][0-9]+)/g))assert.equal(match[1],pkg.version);
 assert.ok(notes.startsWith('# DSH Code Report v'+pkg.version));
 for(const label of ['保存配置','恢复已保存','扫描 / 重新发现','开始执行 · 采集差异','开始执行 · 生成报告','下载 .md 文件']){assert.ok(readme.includes(label),label);assert.ok(client.includes(label),label);}
 for(const text of ['只刷新页面不会重载旧后台','不能保证撤回','不是完整密钥扫描','不支持逐个排除']){assert.ok(readme.includes(text),text);}
 assert.ok(development.includes('根目录和一级子目录'));assert.ok(!development.includes('最多 6 层和 1500'));
 assert.doesNotMatch(development,/SVN 两侧必须有[^。\n]*数字版本/,'SVN versions are optional');
 for(const filename of ['docs/DEVELOPMENT.md','docs/RELEASING.md']){const source=await readFile(filename,'utf8');const links=source.split('](<').slice(1).map(part=>part.split('>)')[0]);assert.ok(links.length>0,'expected local documentation links');for(const target of links){if(!target.includes('://'))await access(path.resolve(path.dirname(filename),target));}}
});

test('directory source documentation states expansion, refusal and authorization boundaries',async()=>{
 const readme=await readFile('README.md','utf8');const client=await readFile('src/client.jsx','utf8');const development=await readFile('docs/DEVELOPMENT.md','utf8');const acceptance=await readFile('docs/ACCEPTANCE.md','utf8');const notes=await readFile('RELEASE-NOTES.md','utf8');
 for(const text of ['支持直接填写目录','递归展开','根目录可填 `.`','固定版本源码仍仅支持文件，不支持目录','不设固定规模上限','解码后 NUL 字符仍拒绝','可用内存','排除计数','显式填写敏感路径仍拒绝','整次采集失败','不制造替换字符或静默截断','实际源码文件清单'])assert.ok(readme.includes(text),text);
 assert.ok(!readme.includes('不支持直接填写目录'),'obsolete directory refusal removed');
 for(const text of ['点前缀隐藏','不按 Windows Hidden 属性筛选','敏感','依赖','构建','缓存','链接','非普通文件'])assert.ok(readme.includes(text),text);
 for(const text of ['不设固定规模上限','不按 Windows Hidden 属性筛选','实际文件清单','授权模型','证据 {preview.bytes} 字节','可能产生多次费用'])assert.ok(client.includes(text),text);
 assert.ok(client.includes("app/src/components"),'folder placeholder');
 for(const text of ['文件或目录路径列表','仍仅支持文件、不支持目录','limitations 记录排除计数','不静默跳过或截断','不改变付费任务生命周期'])assert.ok(development.includes(text),text);
 for(const text of ['文件夹源码契约模拟','原始目录输入保持在 contextPaths 请求','不证明真实文件系统展开','模型派发为零'])assert.ok(acceptance.includes(text),text);
 assert.ok(notes.includes('文件夹源码上下文'));assert.ok(notes.includes('正式发布'));
 for(const source of [readme,client,development,acceptance.split('## v0.8.0')[0],notes.split('### 验证状态')[0]]){assert.doesNotMatch(source,/最多 20 (?:个路径条目|文件)|128 KiB|默认[^。\n]{0,20}1 MiB|最多 8 MiB|最多 32 片|2000 条目、256 目录、20 层|32 MiB/);}
 assert.ok(client.includes('allowBatches:true'));assert.ok(!client.includes('setAllowBatches'));assert.ok(!client.includes('versionContexts.length+context.split'));
 assert.ok(readme.includes('4000–64000'));assert.ok(readme.includes('不设固定片数上限'));assert.ok(readme.includes('12 个项目'));
 assert.ok(acceptance.includes('超过旧路径数量和分析片数门槛'));assert.ok(acceptance.includes('不证明真实大仓库性能'));
});

test('GBK documentation distinguishes decoding, hashes and unverified history',async()=>{
 const readme=await readFile('README.md','utf8');
 const development=await readFile('docs/DEVELOPMENT.md','utf8');
 const acceptance=await readFile('docs/ACCEPTANCE.md','utf8');
 const notes=await readFile('RELEASE-NOTES.md','utf8');
 for(const source of [readme,development,notes.split('## v0.8.0 历史记录')[0]]){
  for(const text of ['GB18030','GBK','UTF-8','同一行混合编码','U+FFFD','不修改源文件','rawDiffHash','diffHash'])assert.ok(source.includes(text),text);
 }
 for(const text of ['源码按完整文件解码','非 BOM 文件仍先尝试 UTF-8、再 GB18030','UTF-16LE／BE','windows-1252-copyright','encodingWarning','不代表支持通用 Windows-1252','不继承源码的 BOM UTF-16 或窄 © 回退'])assert.ok(readme.includes(text),text);
 assert.ok(readme.includes('按原始 LF 字节边界逐行'));
 assert.ok(readme.includes('路径名单、SVN XML 等元数据仍严格要求 UTF-8'));
 const encodingHistory=notes.split('## v0.8.1 历史记录')[1]?.split('## v0.8.0 历史记录')[0];
 assert.ok(encodingHistory?.includes('232/232'));assert.ok(encodingHistory?.includes('29/29'));
 assert.doesNotMatch(readme,/仅支持无 NUL 的有效 UTF-8|GBK[/]GB18030 等非法字节会拒绝/);
 for(const text of ['fatal UTF-8','fatal GB18030','ASCII','读取顺序拼接原字节','不是全仓未过滤 diff 的哈希','不改变付费任务生命周期'])assert.ok(development.includes(text),text);
 assert.ok(acceptance.includes('v0.8.1 编码支持本地验收'));
 assert.ok(acceptance.includes('模拟服务显示中文不证明真实 GBK 字节采集通过'));
 const history=notes.split('## v0.8.0 历史记录')[1];
 assert.ok(history.includes('215/215'));assert.ok(history.includes('29/29'));
 assert.ok(encodingHistory.includes('正式发布以远端门禁'));
 assert.doesNotMatch(encodingHistory,/215[/]215/);
});

test('remote-default documentation exposes network, migration and isolation boundaries',async()=>{
 const readme=await readFile('README.md','utf8'),development=await readFile('docs/DEVELOPMENT.md','utf8'),acceptance=await readFile('docs/ACCEPTANCE.md','utf8'),notes=await readFile('RELEASE-NOTES.md','utf8');
 for(const text of ['远端实时读取','本地离线','remote / origin','会联网','非交互认证','读取远端分支/标签','读取本地分支/标签','不是 URL','完整抓取','失败不会回退本地','不修改业务仓库的 objects、refs 或工作区','HEAD~1','refs/remotes/origin/develop','观察时间','跨项目原子快照','临时磁盘','不重新读取 Git 远端','停止本地自有传输进程树并清理临时目录','不保证远端服务器撤销请求'])assert.ok(readme.includes(text),text);
 assert.doesNotMatch(readme,/Git 读取 \| 严格本地|Git 分支 A\/B \|[^\n]*使用本地已有分支|Git 可点击对应项目的“读取本地 refs”/);
 for(const text of ['旧 RPC 未提供 gitMode','remote/origin','runGitRemote','runGitRead','GIT_CONFIG_COUNT','credential.*','http.*','core.sshCommand','URL rewrite','helper','OS 网络/进程沙箱','observedAt','不承诺所有远端引用或跨项目原子一致','不重新访问 Git 远端'])assert.ok(development.includes(text),text);
 for(const text of ['Git 配置迁移与模式切换','公网 HTTP/HTTPS/SSH','v0.9.0 远端默认','v0.8.1 编码支持本地验收'])assert.ok(acceptance.includes(text),text);
 const remoteHistory=notes.split('## v0.9.0 历史记录')[1]?.split('## v0.8.1 历史记录')[0];assert.ok(remoteHistory?.includes('254/254'));assert.ok(remoteHistory?.includes('32/32'));assert.ok(remoteHistory?.includes('不沿用'));assert.ok(remoteHistory?.includes('正式发布以远端门禁'));assert.doesNotMatch(remoteHistory,/232[/]232|29[/]29/);
});

test('visual refresh documentation keeps workflow and business boundaries separate',async()=>{
 const readme=await readFile('README.md','utf8'),notes=await readFile('RELEASE-NOTES.md','utf8'),acceptance=await readFile('docs/ACCEPTANCE.md','utf8'),client=await readFile('src/client.jsx','utf8'),cards=await readFile('src/RepositoryCards.jsx','utf8');
 for(const label of ['配置发布范围','核对差异证据','生成与导出']){assert.ok(readme.includes(label),label);assert.ok(client.includes(label),label);}
 for(const label of ['A · 比较基线','B · 发布目标']){assert.ok(readme.includes(label),label);assert.ok(cards.includes(label),label);}
 for(const text of ['发布工作台','项目卡片','帮助说明可折叠','深浅主题','窄屏','不代替采集或模型发送确认'])assert.ok(readme.includes(text),text);
 const visualHistory=notes.split('## v0.9.1 历史记录')[1]?.split('## v0.9.0 历史记录')[0];for(const text of ['仅界面','不更改后端','remote/origin','模型发送确认','不表示当前 DSH 已更新','正式发布以远端门禁'])assert.ok(visualHistory?.includes(text),text);assert.ok(visualHistory.includes('256/256'));assert.ok(visualHistory.includes('38/38'));
 assert.ok(acceptance.includes('v0.9.1 视觉升级'));assert.ok(acceptance.includes('截图检查不等于完整无障碍认证'));
 const history=notes.split('## v0.9.0 历史记录')[1]?.split('## v0.8.1 历史记录')[0];assert.ok(history?.includes('254/254'));assert.ok(history?.includes('32/32'));
});

test('source authentication documentation exposes effective configuration and diagnostic boundaries',async()=>{
 const readme=await readFile('README.md','utf8'),development=await readFile('docs/DEVELOPMENT.md','utf8'),notes=await readFile('RELEASE-NOTES.md','utf8'),acceptance=await readFile('docs/ACCEPTANCE.md','utf8');
 for(const text of ['源仓库有效','core.sshCommand','ssh.variant','GIT_SSH_COMMAND','GIT_SSH_VARIANT','相对 -i 路径不会自动改写','不证明用户凭据错误','密钥路径','known_hosts','不会自动关闭 TLS 校验'])assert.ok(readme.includes(text),text);
 for(const text of ['authenticationRoot','配置预检 cwd','credential.*','http.*','core.sshCommand','ssh.variant','GIT_SSH_COMMAND','GIT_SSH_VARIANT','transportOptions','实际网络 cwd 始终为自有临时目录','其他 GIT_ 注入仍清除','runGitRead 维持严格隔离不变','remote uploadpack','相对 -i 或命令路径不改写','remoteFailureDiagnostic(error)','不保证宿主 RPC 保留该属性','不拼接原始 stderr/stdout/error'])assert.ok(development.includes(text),text);
 const current=notes.split('## v0.9.1 历史记录')[0];for(const text of ['不能据此断定用户凭据错误','authenticationRoot','可信可执行配置','不是 OS 沙箱','不回显 URL、凭据或密钥路径','不宣称已实测业务远端认证或安装当前 GUI','正式发布以远端门禁'])assert.ok(current.includes(text),text);
 assert.ok(acceptance.includes('v0.9.2 SSH 认证兼容'));assert.ok(acceptance.includes('相对 -i 不自动改写'));
});

test('maintenance commands and release evidence boundaries stay explicit',async()=>{
 const pkg=JSON.parse(await readFile('package.json','utf8'));
 const releasing=await readFile('docs/RELEASING.md','utf8');
 for(const name of ['check:static','test:coverage','test:browser']){
  assert.equal(typeof pkg.scripts[name],'string');assert.ok(releasing.includes('npm run '+name));
 }
 for(const text of ['build-provenance.json','不自动重建','不会自动重试','不是 DOM','模拟 DSH 服务'])assert.ok(releasing.includes(text),text);
 assert.ok(pkg.files.includes('dist/build-provenance.json'));
 assert.ok(!pkg.files.some(name=>name.startsWith('test/')||name.startsWith('scripts/')));
});
