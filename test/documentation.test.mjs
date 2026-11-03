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
 for(const text of ['支持直接填写目录','递归展开','根目录可填 `.`','固定版本源码仍仅支持文件，不支持目录','不设固定规模上限','无 NUL','可用内存','排除计数','显式填写敏感路径仍拒绝','整次采集失败','不静默跳过或截断','实际源码文件清单'])assert.ok(readme.includes(text),text);
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
