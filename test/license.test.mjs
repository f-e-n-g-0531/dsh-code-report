import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
test('project MIT license retains copyright, grant, notice and disclaimer with matching metadata',async()=>{
 const license=await readFile('LICENSE','utf8');
 const pkg=JSON.parse(await readFile('package.json','utf8'));
 const lock=JSON.parse(await readFile('package-lock.json','utf8'));
 assert.equal(pkg.license,'MIT');assert.equal(lock.packages[''].license,'MIT');
 assert.ok(license.startsWith('MIT License\n\nCopyright (c) 2026 f-e-n-g-0531 and contributors'));
 for(const clause of ['Permission is hereby granted, free of charge','use, copy, modify, merge, publish, distribute, sublicense, and/or sell','The above copyright notice and this permission notice shall be included','THE SOFTWARE IS PROVIDED "AS IS"','AUTHORS OR COPYRIGHT HOLDERS BE LIABLE'])assert.ok(license.includes(clause),clause);
 const readme=await readFile('README.md','utf8');assert.match(readme,/MIT License/);assert.doesNotMatch(readme,/非商业源码公开许可证|商业用途需先取得书面授权|不是 OSI/);assert.match(readme,/第三方材料仍适用各自许可证/);
 const packaging=await readFile('scripts/package.mjs','utf8');assert.ok(packaging.includes("assert.equal(pkg.license,'MIT')"));
});
