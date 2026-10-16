import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile,access} from 'node:fs/promises';
import path from 'node:path';
test('public documentation versions labels links and boundaries match the package',async()=>{
 const pkg=JSON.parse(await readFile('package.json','utf8'));const readme=await readFile('README.md','utf8');const client=await readFile('src/client.jsx','utf8');const development=await readFile('docs/DEVELOPMENT.md','utf8');const notes=await readFile('RELEASE-NOTES.md','utf8');
 for(const match of readme.matchAll(/@feng0531[/]dsh-code-report@([0-9]+[.][0-9]+[.][0-9]+)/g))assert.equal(match[1],pkg.version);
 assert.ok(notes.startsWith('# DSH Code Report v'+pkg.version));
 for(const label of ['保存配置','恢复已保存','扫描 / 重新发现','开始执行 · 采集差异','开始执行 · 生成报告','下载 .md 文件']){assert.ok(readme.includes(label),label);assert.ok(client.includes(label),label);}
 for(const text of ['只刷新页面不会重载旧后台','不支持直接填写目录','不能保证撤回','不是完整密钥扫描','不支持逐个排除']){assert.ok(readme.includes(text),text);}
 assert.ok(development.includes('根目录和一级子目录'));assert.ok(!development.includes('最多 6 层和 1500'));
 for(const filename of ['docs/DEVELOPMENT.md','docs/RELEASING.md']){const source=await readFile(filename,'utf8');const links=source.split('](<').slice(1).map(part=>part.split('>)')[0]);assert.ok(links.length>0,'expected local documentation links');for(const target of links){if(!target.includes('://'))await access(path.resolve(path.dirname(filename),target));}}
});
