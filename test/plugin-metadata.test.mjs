import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {name} from '../index.mjs';

test('host locale metadata provides friendly names without changing install identity',async()=>{
 const pkg=JSON.parse(await readFile('package.json','utf8'));
 assert.equal(pkg.name,'@feng0531/dsh-code-report');assert.equal(name,'dsh-code-report');
 assert.ok(pkg.files.includes('locale/'));
 for(const [language,title]of [['zh-CN','发布报告'],['en','Release Reports']]){
  const resource='./locale/'+language+'.json';assert.equal(pkg.exports[resource],resource);
  const locale=JSON.parse(await readFile(resource,'utf8'));assert.equal(locale.meta.title,title);
  assert.ok(locale.meta.description.includes('Git/SVN'));assert.ok(locale.meta.description.length<160);
 }
 assert.equal(pkg.dsh.bundle.patch,'./cordis.patch.yml');
});
