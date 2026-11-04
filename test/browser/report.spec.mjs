import {test,expect} from '@playwright/test';
import {readFile} from 'node:fs/promises';

const pageErrors=new WeakMap();
test.beforeEach(async({page})=>{
 const errors=[];pageErrors.set(page,errors);page.on('pageerror',error=>errors.push(error.message));
 await page.route('**/*',async route=>{const url=new URL(route.request().url());if(url.protocol==='http:'&&url.origin==='http://127.0.0.1:4178')return route.continue();errors.push('Unexpected external request '+url.origin);return route.abort('blockedbyclient');});
});
test.afterEach(async({page})=>{expect(pageErrors.get(page)||[],'no uncaught browser exception').toEqual([]);});

const capture=page=>page.getByRole('button',{name:'开始执行 · 采集差异',exact:true});
const generate=page=>page.getByRole('button',{name:'开始执行 · 生成报告',exact:true});
const report=page=>page.locator('article.cr-report');
const consent=page=>page.getByRole('checkbox',{name:/我确认向上方指定模型发送/});
const stats=page=>page.evaluate(()=>window.fixture.getStats());
async function open(page,options={}){
 const errors=[];page.on('pageerror',error=>errors.push(error.message));
 await page.addInitScript(value=>{window.__fixtureOptions=value;},options);
 await page.goto('/');await expect(page.getByRole('heading',{name:'发布报告配置'})).toBeVisible();
 return errors;
}
async function expandProject(page,index=1){const expand=page.getByRole('button',{name:'展开项目 '+index,exact:true});if(await expand.count())await expand.click();await expect(page.getByRole('button',{name:'收起项目 '+index,exact:true})).toHaveAttribute('aria-expanded','true');}
async function selectGit(page){
 await expect(page.getByRole('checkbox',{name:'纳入项目 1',exact:true})).toBeVisible();
 await page.getByRole('checkbox',{name:'纳入项目 1',exact:true}).check();await expandProject(page);
 await page.getByRole('combobox',{name:'GIT 分支 A 1',exact:true}).fill('main');
 await page.getByRole('combobox',{name:'GIT 分支 B 1',exact:true}).fill('release');
 await expect(capture(page)).toBeEnabled();
}
async function workflow(page,states){await expect(page.locator('.cr-stage')).toHaveCount(3);for(const [index,state]of states.entries())await expect(page.locator('.cr-stage').nth(index)).toHaveAttribute('data-state',state);await expect(page.locator('.cr-stage[aria-current=step]')).toHaveCount(states.filter(state=>state==='active').length);}
async function collect(page){await capture(page).click();await expect(report(page)).toContainText('本地证据');}
async function route(page){await page.getByRole('textbox',{name:'DSH 提供方 ID',exact:true}).fill('fixture');await page.getByRole('textbox',{name:'模型 ID',exact:true}).fill('mock');}
async function analyze(page){await route(page);await consent(page).check();await generate(page).click();await expect(report(page)).toContainText('模型报告');}

for(const width of [380,1280])test('projects default collapsed, toggle independently, preserve values and locate hidden errors '+width,async({page},info)=>{
 await page.setViewportSize({width,height:1100});await open(page,{count:2,mixed:true});const row1=page.locator('#cr-row-0'),row2=page.locator('#cr-row-1');await expect(row1).toBeVisible();await expect(row2).toBeVisible();await expect(row1.locator(':scope > td')).toHaveCount(5);await expect(row2.locator(':scope > td')).toHaveCount(5);
 const toggle=index=>page.getByRole('button',{name:new RegExp('^(?:展开|收起)项目 '+index+'$')});for(const index of [1,2]){await expect(toggle(index)).toHaveAttribute('aria-expanded','false');await expect(page.getByRole('button',{name:'移除项目 '+index,exact:true})).toBeVisible();}
 await expect(row1.locator('[aria-label="项目路径 1"]')).toHaveCount(1);await expect(row1.locator('[aria-label="项目路径 1"]')).not.toBeVisible();await page.getByRole('checkbox',{name:'纳入项目 1',exact:true}).check();await page.getByRole('checkbox',{name:'纳入项目 2',exact:true}).check();await expect(toggle(1)).toHaveAttribute('aria-expanded','false');await expect(toggle(2)).toHaveAttribute('aria-expanded','false');
 await toggle(1).focus();await page.keyboard.press('Enter');await expect(toggle(1)).toHaveAttribute('aria-expanded','true');await expect(toggle(2)).toHaveAttribute('aria-expanded','false');await page.getByRole('combobox',{name:'GIT 分支 A 1',exact:true}).fill('main');await page.getByRole('combobox',{name:'GIT 分支 B 1',exact:true}).fill('release');await page.getByRole('combobox',{name:'版本 A 1',exact:true}).fill('v1');await toggle(2).focus();await page.keyboard.press('Space');await expect(toggle(2)).toHaveAttribute('aria-expanded','true');await expect(page.getByRole('textbox',{name:'SVN 分支 A 2',exact:true})).toHaveValue('trunk');
 await toggle(1).click();await expect(toggle(1)).toHaveAttribute('aria-expanded','false');await expect(toggle(2)).toHaveAttribute('aria-expanded','true');await expect(row1.locator('[aria-label="版本 A 1"]')).toHaveValue('v1');await expect(row1.locator('[aria-label="版本 A 1"]')).not.toBeVisible();await expect(page.getByRole('checkbox',{name:'纳入项目 1',exact:true})).toBeChecked();await toggle(2).click();await expandProject(page,2);
 const search=page.getByRole('textbox',{name:'搜索项目路径',exact:true});await search.fill('project-1');await expect(row1).toHaveCount(0);await page.locator('.cr-bulk summary').click();await page.locator('.cr-bulk').getByRole('textbox',{name:'B 目标',exact:true}).fill('v2');await page.getByRole('button',{name:'应用到已选 GIT 项目',exact:true}).click();await search.fill('');await expect(row1.locator('[aria-label="版本 A 1"]')).toHaveValue('v1');await expect(row1.locator('[aria-label="版本 B 1"]')).toHaveValue('v2');await expect(toggle(1)).toHaveAttribute('aria-expanded','false');await expect(toggle(2)).toHaveAttribute('aria-expanded','true');
 await expandProject(page);await expect(page.getByRole('combobox',{name:'GIT 分支 A 1',exact:true})).toHaveValue('main');await page.getByRole('textbox',{name:'项目路径 1',exact:true}).fill('');await toggle(1).click();await expect(row1.locator('.cr-project-error')).toBeVisible();await search.fill('project-1');await page.getByRole('button',{name:'定位首个错误项目',exact:true}).click();await expect(search).toHaveValue('');await expect(toggle(1)).toHaveAttribute('aria-expanded','true');await expect(page.getByRole('textbox',{name:'项目路径 1',exact:true})).toBeFocused();
 const observed=await stats(page);expect(observed.calls.filter(call=>['refs','preview','generate'].includes(call.endpoint))).toHaveLength(0);expect(observed.modelCalls).toBe(0);expect(observed.installCalls).toBe(0);await expect(page.getByRole('checkbox',{name:'纳入项目 2',exact:true})).toBeChecked();const screenshot=info.outputPath('project-collapse-'+width+'.png');await page.locator('.cr-repositories').screenshot({path:screenshot});await info.attach('project-collapse-'+width,{path:screenshot,contentType:'image/png'});
});

test('reader report renders semantic headings tables decoded identifiers and inert source with collapsed appendices (contract mock)',async({page},info)=>{
 const markdown=['# 模型报告 · 可读发布摘要','','## 对外接口变更','','- 标识符 auth&#95;token 与 hex&#x5f;id','- 结论仍需人工复核','','| 接口 | 影响 |','| --- | --- |','| GET /api&#95;user | 待确认 |','','[证据 E1](#evidence-1)','','<details>','<summary>技术附录 · 证据索引</summary>','','<a id="evidence-1"></a>','','### 差异证据','','仅供复核的细节。','','</details>','','源文本：<script>window.fixtureInjected=true</script>','<img src="https://attacker.invalid/beacon" onerror="window.fixtureInjected=true">','[危险跳转](javascript:window.fixtureInjected=true)','![外部图片](https://attacker.invalid/image.png)','','~~~js','const literal = "auth&#95;token <script>not executable</script>";','~~~'].join('\n');
 await open(page,{richReport:markdown});await selectGit(page);await collect(page);await analyze(page);const document=report(page);await expect(document).toHaveCount(1);await expect(document.getByRole('heading',{name:'模型报告 · 可读发布摘要',level:1,exact:true})).toBeVisible();await expect(document.getByRole('heading',{name:'对外接口变更',level:2,exact:true})).toBeVisible();await expect(document.getByRole('listitem')).toHaveCount(2);await expect(document.getByRole('listitem').first()).toHaveText('标识符 auth_token 与 hex_id');
 await expect(document.getByRole('table')).toBeVisible();await expect(document.getByRole('columnheader',{name:'接口',exact:true})).toBeVisible();await expect(document.getByRole('cell',{name:'GET /api_user',exact:true})).toBeVisible();await expect(document.locator('pre code')).toHaveText('const literal = "auth&#95;token <script>not executable</script>";');
 const appendix=document.locator('details');await expect(appendix).toHaveCount(1);await expect(appendix).not.toHaveAttribute('open','');await expect(document.getByRole('heading',{name:'差异证据',exact:true})).not.toBeVisible();const raw=page.locator('.cr-report-raw');await expect(raw).not.toHaveAttribute('open','');await expect(raw.locator('pre')).not.toBeVisible();
 await expect(document.getByRole('link',{name:'证据 E1',exact:true})).toHaveAttribute('href','#evidence-1');await expect(document.locator('script,img,iframe,object,embed,svg,[onerror],[onclick],a[href^="javascript:"],a[href^="http"]')).toHaveCount(0);await expect(document).toContainText('<script>window.fixtureInjected=true</script>');expect(await page.evaluate(()=>window.fixtureInjected)).toBeUndefined();
 await appendix.locator('summary').click();await expect(document.getByRole('heading',{name:'差异证据',level:3,exact:true})).toBeVisible();await raw.locator('summary').click();await expect(raw.locator('pre')).toHaveText(markdown);await raw.locator('summary').click();await expect(raw.locator('pre')).not.toBeVisible();
 const pending=page.waitForEvent('download');await page.getByRole('button',{name:'下载 .md 文件',exact:true}).click();const download=await pending;expect(await readFile(await download.path(),'utf8')).toBe(markdown);expect((await stats(page)).modelCalls).toBe(1);expect((await stats(page)).calls.filter(call=>call.endpoint==='generate')).toHaveLength(1);
 await appendix.locator('summary').click();const image=info.outputPath('readable-report.png');await page.locator('.cr-result').screenshot({path:image});await info.attach('safe-readable-report',{path:image,contentType:'image/png'});
});

test('single request preview distinguishes local coverage and budgeted excerpts, replan resets consent and recovery never redispatches (contract mock)',async({page})=>{
 await open(page,{singleRequest:true,failGenerateResponse:true,resultPending:true});await selectGit(page);await collect(page);
 const scope=page.getByRole('region',{name:'单次摘要覆盖范围',exact:true});await expect(scope).toContainText('非模型全文覆盖');await expect(scope).toContainText('本地差异文本字节 987654');await expect(scope).toContainText('已解码 UTF-8 口径，非原始网络字节');await expect(scope).toContainText('完整文件清单 12 个');await expect(scope).toContainText('发送文件专属元数据或片段 7 个');await expect(scope).toContainText('实际发送正文片段 2 个');await expect(scope).toContainText('完全未发送文件专属证据 5 个');await expect(scope).toContainText('生成物 4 个');await expect(scope).toContainText('已发送文件也不代表其全文已发送');await expect(scope).toContainText('生成物可能只发送元数据');
 const budget=page.getByRole('spinbutton',{name:'单次输入预算',exact:true});await expect(budget).toHaveValue('64000');await expect(page.getByRole('spinbutton',{name:'单片输入预算',exact:true})).toHaveCount(0);await expect(page.locator('.cr-preview-metrics')).toContainText('模型请求1');
 await route(page);await expect(consent(page)).toHaveAccessibleName(/一次请求可能计费/);await expect(consent(page)).toHaveAccessibleName(/未发送正文不属于模型全文分析/);await expect(generate(page)).toBeDisabled();await consent(page).check();await budget.fill('48000');await expect(consent(page)).not.toBeChecked();await expect(generate(page)).toBeDisabled();await page.getByRole('button',{name:'更新分析计划',exact:true}).click();await expect(consent(page)).toBeEnabled();await expect(budget).toHaveValue('48000');
 expect((await stats(page)).calls.filter(call=>call.endpoint==='analysis-plan').at(-1).payload.inputBudget).toBe(48000);expect((await stats(page)).modelCalls).toBe(0);await consent(page).check();await generate(page).click();
 const recover=page.getByRole('button',{name:'恢复已完成报告',exact:true});await expect(recover).toBeVisible();expect((await stats(page)).modelCalls).toBe(1);await recover.click();await expect(recover).toBeEnabled();await page.evaluate(()=>window.fixture.configure({resultPending:false}));await recover.click();await expect(report(page)).toContainText('模型报告 a');await expect(scope).toContainText('本地完整统计不等于模型全文覆盖');await expect(scope).toContainText('完全未发送文件专属证据 5 个');
 const observed=await stats(page);expect(observed.modelCalls).toBe(1);expect(observed.calls.filter(call=>call.endpoint==='generate')).toHaveLength(1);expect(observed.calls.filter(call=>call.endpoint==='result').length).toBeGreaterThanOrEqual(2);expect(observed.installCalls).toBe(0);
});

test('real DOM scan → select → local evidence → explicit consent → safe download',async({page})=>{
 const errors=await open(page);await selectGit(page);await workflow(page,['active','pending','pending']);await collect(page);await workflow(page,['complete','active','pending']);
 expect((await stats(page)).modelCalls).toBe(0);await route(page);await expect(generate(page)).toBeDisabled();
 expect((await stats(page)).calls.filter(x=>x.endpoint==='generate')).toHaveLength(0);
 await consent(page).check();await generate(page).click();await expect(report(page)).toContainText('模型报告 a');
 await workflow(page,['complete','complete','complete']);expect((await stats(page)).modelCalls).toBe(1);expect(await page.evaluate(()=>window.fixtureInjected)).toBeUndefined();
 const pending=page.waitForEvent('download');await page.getByRole('button',{name:'下载 .md 文件'}).click();const download=await pending;
 expect(download.suggestedFilename()).toMatch(/^release-report-.*[.]md$/);
 expect(await readFile(await download.path(),'utf8')).toContain('模型报告 a');expect(errors).toEqual([]);
});

test('mixed Git and SVN requires explicit history authorization before capture',async({page})=>{
 await open(page,{count:2,mixed:true});await selectGit(page);await page.getByRole('checkbox',{name:'纳入项目 2',exact:true}).check();
 await expect(capture(page)).toBeDisabled();expect((await stats(page)).calls.filter(x=>x.endpoint==='preview')).toHaveLength(0);
 await page.getByRole('checkbox',{name:/允许通过 SVN 工作副本地址读取历史版本/}).check();await collect(page);
 const request=(await stats(page)).calls.find(x=>x.endpoint==='preview').payload.request;expect(request.allowSvnNetwork).toBe(true);expect(request.repositories.map(x=>x.type)).toEqual(['git','svn']);expect((await stats(page)).modelCalls).toBe(0);
});

test('local refs and automatic batch/context inputs retain authorization boundaries',async({page})=>{
 await open(page);await selectGit(page);await page.getByRole('combobox',{name:'Git 读取方式 1',exact:true}).selectOption('local');await page.getByRole('button',{name:/^读取(?:远端|本地)分支\/标签$/}).click();
 await expect(page.getByText('已载入 3 个本地引用，在 A/B 输入中选择；不会 fetch。')).toBeVisible();
 await expect(page.getByRole('checkbox',{name:/允许分批分析较大差异/})).toHaveCount(0);await page.getByText('2. 附带项目源码（可选）',{exact:true}).click();
 await page.getByRole('textbox',{name:'源码上下文路径',exact:true}).fill('client/current.ts');
 await page.getByRole('textbox',{name:'固定版本源码路径',exact:true}).fill('client|A|src/api.ts');await collect(page);
 const request=(await stats(page)).calls.find(x=>x.endpoint==='preview').payload.request;expect(request.allowBatches).toBe(true);expect(request.contextPaths).toEqual(['client/current.ts']);expect(request.versionContexts).toEqual([{repository:'client',side:'A',path:'src/api.ts'}]);
 await route(page);await consent(page).check();await page.getByRole('textbox',{name:'模型 ID',exact:true}).fill('other');await expect(consent(page)).not.toBeChecked();
 await consent(page).check();await page.getByRole('spinbutton',{name:'单片输入预算',exact:true}).fill('12000');await expect(consent(page)).not.toBeChecked();await expect(generate(page)).toBeDisabled();
 await page.getByRole('button',{name:'更新分析计划',exact:true}).click();await expect(consent(page)).toBeEnabled();expect((await stats(page)).modelCalls).toBe(0);
 expect((await stats(page)).calls.filter(x=>x.endpoint==='refs')).toHaveLength(1);expect((await stats(page)).calls.find(x=>x.endpoint==='analysis-plan').payload.inputBudget).toBe(12000);
});

test('Git defaults to explicit remote origin in refs and collection with visible source provenance',async({page})=>{
 await open(page);await selectGit(page);await expect(page.getByRole('combobox',{name:'Git 读取方式 1',exact:true})).toHaveValue('remote');
 await expect(page.getByRole('textbox',{name:'Git 远端名 1',exact:true})).toHaveValue('origin');await expect(page.getByText(/远端.*(联网|访问)|联网.*远端/).first()).toBeVisible();const safety=page.locator('#cr-row-0 details');if(await safety.count())await safety.locator('summary').click();await expect(page.locator('#cr-row-0')).toContainText('不修改');await expect(page.locator('#cr-row-0')).toContainText(/不(?:会)?回退/);
 await page.getByRole('button',{name:'读取远端分支/标签',exact:true}).click();await expect.poll(async()=>(await stats(page)).calls.filter(call=>call.endpoint==='refs').length).toBe(1);
 const refs=(await stats(page)).calls.find(call=>call.endpoint==='refs').payload;expect(refs).toMatchObject({sessionId:'a',repositoryPath:'client',gitMode:'remote',gitRemote:'origin'});
 await collect(page);const row=(await stats(page)).calls.find(call=>call.endpoint==='preview').payload.request.repositories[0];expect(row).toMatchObject({gitMode:'remote',gitRemote:'origin'});
 await expect(page.getByRole('group',{name:'3. 确认分析范围',exact:true})).toContainText('origin');await expect(page.getByRole('group',{name:'3. 确认分析范围',exact:true})).toContainText('2026-11-03T10:00:00.000Z');expect((await stats(page)).modelCalls).toBe(0);
});

test('classified remote authentication failure is safe, remains remote and permits explicit retry (contract mock)',async({page})=>{
 await open(page,{refsAuthFailure:true});await selectGit(page);const query=page.getByRole('button',{name:'读取远端分支/标签',exact:true});await query.click();
 const alert=page.locator('#cr-row-0').getByRole('alert');await expect(alert).toContainText('SSH 公钥认证被拒绝');await expect(alert).toContainText('DSH 运行用户使用');await expect(alert).toContainText('未回退本地版本');await expect(query).toBeEnabled();
 await expect(page.getByRole('combobox',{name:'Git 读取方式 1',exact:true})).toHaveValue('remote');await expect(page.getByRole('textbox',{name:'Git 远端名 1',exact:true})).toHaveValue('origin');await expect(page.locator('#cr-refs-0 option')).toHaveCount(0);
 // This mock sends only a classified safe hint. Backend unit tests own raw-stderr/secret filtering.
 const text=await page.locator('.cr-root').innerText();expect(text).not.toMatch(/PRIVATE KEY|raw-secret|password=|https:\/\/[^ ]+@/i);
 let calls=(await stats(page)).calls.filter(call=>call.endpoint==='refs');expect(calls).toHaveLength(1);expect(calls[0].payload).toMatchObject({gitMode:'remote',gitRemote:'origin'});
 expect((await stats(page)).calls.some(call=>call.endpoint==='preview'||call.endpoint==='generate')).toBe(false);
 await page.evaluate(()=>window.fixture.configure({refsAuthFailure:false}));await query.click();await expect(alert).toHaveCount(0);await expect(page.locator('#cr-refs-0 option')).toHaveCount(3);
 calls=(await stats(page)).calls.filter(call=>call.endpoint==='refs');expect(calls).toHaveLength(2);expect(calls.every(call=>call.payload.gitMode==='remote'&&call.payload.gitRemote==='origin')).toBe(true);expect((await stats(page)).modelCalls).toBe(0);expect((await stats(page)).installCalls).toBe(0);
});

test('Git local offline mode is explicit and stays local for refs and collection',async({page})=>{
 await open(page);await selectGit(page);await page.getByRole('combobox',{name:'Git 读取方式 1',exact:true}).selectOption('local');
 await page.getByRole('button',{name:'读取本地分支/标签',exact:true}).click();await expect(page.getByText('已载入 3 个本地引用，在 A/B 输入中选择；不会 fetch。')).toBeVisible();
 const refs=(await stats(page)).calls.find(call=>call.endpoint==='refs').payload;expect(refs).toMatchObject({sessionId:'a',repositoryPath:'client',gitMode:'local',gitRemote:'origin'});
 await collect(page);expect((await stats(page)).calls.find(call=>call.endpoint==='preview').payload.request.repositories[0].gitMode).toBe('local');
 await expect(page.getByRole('group',{name:'3. 确认分析范围',exact:true})).toContainText('本地');expect((await stats(page)).modelCalls).toBe(0);
});

test('Git mode and remote edits invalidate preview and consent without changing user A B selections',async({page})=>{
 await open(page);await selectGit(page);const branchA=page.getByRole('combobox',{name:'GIT 分支 A 1',exact:true}),branchB=page.getByRole('combobox',{name:'GIT 分支 B 1',exact:true});
 await branchA.fill('custom-baseline');await branchB.fill('origin/develop');await page.getByRole('button',{name:'读取远端分支/标签',exact:true}).click();await expect(page.locator('#cr-refs-0 option')).toHaveCount(3);
 await collect(page);await route(page);await consent(page).check();await page.getByRole('textbox',{name:'Git 远端名 1',exact:true}).fill('upstream');
 await expect(page.locator('#cr-refs-0 option')).toHaveCount(0);await expect(consent(page)).toHaveCount(0);await expect(branchA).toHaveValue('custom-baseline');await expect(branchB).toHaveValue('origin/develop');
 await page.getByRole('button',{name:'读取远端分支/标签',exact:true}).click();await expect(page.locator('#cr-refs-0 option')).toHaveCount(3);
 expect((await stats(page)).calls.filter(call=>call.endpoint==='refs').at(-1).payload).toMatchObject({gitMode:'remote',gitRemote:'upstream'});
 await collect(page);await route(page);await consent(page).check();expect((await stats(page)).calls.filter(call=>call.endpoint==='preview').at(-1).payload.request.repositories[0].gitRemote).toBe('upstream');
 await page.getByRole('combobox',{name:'Git 读取方式 1',exact:true}).selectOption('local');await expect(page.locator('#cr-refs-0 option')).toHaveCount(0);await expect(consent(page)).toHaveCount(0);await expect(branchA).toHaveValue('custom-baseline');await expect(branchB).toHaveValue('origin/develop');
 expect((await stats(page)).modelCalls).toBe(0);expect((await stats(page)).calls.filter(call=>call.endpoint==='generate')).toHaveLength(0);
});

test('folder input preserves original request and expanded preview is visible before model authorization (contract mock)',async({page})=>{
 const directoryContextPreview={context:[
  {path:'client/src/components/Button.tsx',provenance:'workspace',encoding:'gb18030',rawHash:'1'.repeat(64),hash:'1'.repeat(64)},
  {path:'client/src/components/nested/Panel.tsx',provenance:'workspace',hash:'2'.repeat(64)},
  {path:'client/current.ts',provenance:'workspace',hash:'3'.repeat(64)},
  {repository:'client',path:'src/api.ts',provenance:'version-A',revision:'a'.repeat(40),hash:'4'.repeat(64)}
 ],limitations:['目录展开排除计数（契约模拟）：hidden=1、sensitive=1、dependency/build/cache=2、links=1、nonregular=1；未读取真实文件系统']};
 await open(page,{directoryContextPreview});await selectGit(page);
 await page.getByText('2. 附带项目源码（可选）',{exact:true}).click();
 const input=page.getByRole('textbox',{name:'源码上下文路径',exact:true});
 await expect(input).toHaveAttribute('placeholder',/app\/src\/components/);
 await input.fill('client/src/components\nclient/current.ts');
 await page.getByRole('textbox',{name:'固定版本源码路径',exact:true}).fill('client|A|src/api.ts');
 await collect(page);
 const calls=(await stats(page)).calls;const requests=calls.filter(call=>call.endpoint==='preview');expect(requests).toHaveLength(1);
 expect(requests[0].payload.request.contextPaths).toEqual(['client/src/components','client/current.ts']);
 expect(requests[0].payload.request.versionContexts).toEqual([{repository:'client',side:'A',path:'src/api.ts'}]);
 await expect(input).toHaveValue('client/src/components\nclient/current.ts');
 const files=page.getByRole('list',{name:'实际源码文件清单',exact:true});await expect(files).toBeVisible();await expect(files.getByRole('listitem')).toHaveCount(4);
 for(const item of directoryContextPreview.context){await expect(files).toContainText(item.path);await expect(files).toContainText(item.hash);}
 await expect(files).toContainText('当前工作区');await expect(files).toContainText('版本 A');await expect(files).toContainText('编码 gb18030');await expect(files).toContainText('原始字节 SHA-256');
 await expect(page.getByText('4 个实际源码文件（目录已展开）。',{exact:false})).toBeVisible();
 const limitations=page.getByRole('list',{name:'源码及采集限制',exact:true});await expect(limitations).toBeVisible();await expect(limitations).toContainText(directoryContextPreview.limitations[0]);
 await route(page);await expect(consent(page)).not.toBeChecked();await expect(generate(page)).toBeDisabled();
 expect((await stats(page)).modelCalls).toBe(0);expect((await stats(page)).calls.filter(call=>call.endpoint==='generate')).toHaveLength(0);
});

test('large context lists and over 32 batches remain bound to explicit preview authorization (contract mock)',async({page})=>{
 const contextPaths=Array.from({length:25},(_,index)=>'client/src/dir-'+index);
 const versionContexts=Array.from({length:25},(_,index)=>({repository:'client',side:'A',path:'src/old-'+index+'.ts'}));
 const directoryContextPreview={bytes:9*1024*1024,context:[...contextPaths.map((path,index)=>({path:path+'/file.ts',provenance:'workspace',hash:String(index).padStart(64,'0')})),...versionContexts.map((item,index)=>({...item,provenance:'version-A',revision:'a'.repeat(40),hash:String(index+25).padStart(64,'0')}))],limitations:['大范围契约模拟；未读取真实大仓库，不代表性能验收']};
 await open(page,{directoryContextPreview,analysisBatches:40});await selectGit(page);
 await page.getByText('2. 附带项目源码（可选）',{exact:true}).click();
 await page.getByRole('textbox',{name:'源码上下文路径',exact:true}).fill(contextPaths.join('\n'));
 await page.getByRole('textbox',{name:'固定版本源码路径',exact:true}).fill(versionContexts.map(item=>item.repository+'|'+item.side+'|'+item.path).join('\n'));
 await expect(capture(page)).toBeEnabled();await collect(page);
 const previewCall=(await stats(page)).calls.find(call=>call.endpoint==='preview');expect(previewCall.payload.request.contextPaths).toEqual(contextPaths);expect(previewCall.payload.request.versionContexts).toEqual(versionContexts);expect(previewCall.payload.request.allowBatches).toBe(true);
 const files=page.getByRole('list',{name:'实际源码文件清单',exact:true});await expect(files.getByRole('listitem')).toHaveCount(50);await expect(files).toContainText('client/src/dir-24/file.ts');await expect(files).toContainText('src/old-24.ts');
 await expect(page.getByText('证据 9437184 字节（约 9216.0 KiB）；',{exact:false})).toBeVisible();
 await expect(page.getByText('本计划 40 片，按顺序调用模型，可能产生多次费用；',{exact:false})).toBeVisible();
 await route(page);await expect(generate(page)).toBeDisabled();expect((await stats(page)).modelCalls).toBe(0);
 await consent(page).check();await expect(generate(page)).toBeEnabled();await generate(page).click();await expect(report(page)).toContainText('模型报告');
 const generated=(await stats(page)).calls.filter(call=>call.endpoint==='generate');expect(generated).toHaveLength(1);expect(generated[0].payload).toMatchObject({previewId:'preview-1',planId:'plan-fixture',sendToModel:true,route:{provider:'fixture',model:'mock'}});
 await expect(consent(page)).toHaveCount(0);
});

test('progress connection loss is visible without redispatching a pending operation',async({page})=>{
 await open(page,{delayPreview:1700,progressFailure:true});await selectGit(page);await capture(page).click();
 await expect(page.getByRole('status').filter({hasText:'进度连接暂时失联'})).toBeVisible();await expect(capture(page)).toBeDisabled();
 await expect(report(page)).toContainText('本地证据');expect((await stats(page)).calls.filter(x=>x.endpoint==='preview')).toHaveLength(1);expect((await stats(page)).modelCalls).toBe(0);
});

test('editing draft and failing a new capture preserve the previous export',async({page})=>{
 await open(page);await selectGit(page);await collect(page);await analyze(page);
 await page.getByRole('textbox',{name:'报告标题',exact:true}).fill('下一轮范围');
 await expect(report(page)).toContainText('模型报告 a');await expect(page.getByText(/报告.*(旧|变化|不同|过时)|旧报告/).first()).toBeVisible();
 await page.evaluate(()=>window.fixture.configure({failPreview:true}));await capture(page).click();
 await expect(page.getByRole('alert').filter({hasText:'fixture 采集失败'})).toBeVisible();await expect(report(page)).toContainText('模型报告 a');
 await expect(page.getByRole('button',{name:'下载 .md 文件'})).toBeEnabled();
});

test('failed model attempt requires fresh consent before paid retry',async({page})=>{
 await open(page);await selectGit(page);await collect(page);await route(page);
 await page.evaluate(()=>window.fixture.configure({failGenerate:true}));await consent(page).check();await generate(page).click();
 await expect(page.getByRole('alert').filter({hasText:'fixture 模型失败'})).toBeVisible();
 await expect(consent(page)).not.toBeChecked();await expect(generate(page)).toBeDisabled();expect((await stats(page)).modelCalls).toBe(1);
 await page.evaluate(()=>window.fixture.configure({failGenerate:false}));await consent(page).check();await generate(page).click();
 await expect(report(page)).toContainText('模型报告 a');expect((await stats(page)).modelCalls).toBe(2);
});

test('lost generate response recovers completed result without another model call',async({page})=>{
 await open(page,{failGenerateResponse:true});await selectGit(page);await collect(page);await route(page);await consent(page).check();await generate(page).click();
 await expect(report(page)).toContainText('模型报告 a');expect((await stats(page)).modelCalls).toBe(1);
 const calls=(await stats(page)).calls;expect(calls.filter(x=>x.endpoint==='generate')).toHaveLength(1);expect(calls.filter(x=>x.endpoint==='result')).toHaveLength(1);
 expect(calls.find(x=>x.endpoint==='result').payload.operationId).toBe(calls.find(x=>x.endpoint==='generate').payload.operationId);
});

test('pending lost response blocks duplicate generation and manual recovery is read only',async({page})=>{
 await open(page,{failGenerateResponse:true,resultPending:true});await selectGit(page);await collect(page);await route(page);await consent(page).check();await generate(page).click();
 const recover=page.getByRole('button',{name:'恢复已完成报告',exact:true});await expect(recover).toBeVisible();await expect(generate(page)).toBeDisabled();
 expect((await stats(page)).modelCalls).toBe(1);await recover.click();await expect(recover).toBeEnabled();await expect(generate(page)).toBeDisabled();
 await page.evaluate(()=>window.fixture.configure({resultPending:false}));await recover.click();await expect(report(page)).toContainText('模型报告 a');
 expect((await stats(page)).modelCalls).toBe(1);expect((await stats(page)).calls.filter(x=>x.endpoint==='generate')).toHaveLength(1);expect((await stats(page)).calls.filter(x=>x.endpoint==='result')).toHaveLength(3);
});

test('pending recovery survives session switch and blocks duplicate work and native installation',async({page})=>{
 await open(page,{failGenerateResponse:true,resultPending:true});await selectGit(page);await collect(page);await route(page);
 await page.getByText(/插件版本与更新 ·/).click();await page.getByRole('button',{name:'检查更新',exact:true}).click();await page.getByRole('checkbox',{name:/我确认将此插件更新到/}).check();
 await expect(page.getByRole('button',{name:'更新到 99.0.0',exact:true})).toBeEnabled();await consent(page).check();await generate(page).click();
 const recover=page.getByRole('button',{name:'恢复已完成报告',exact:true});await expect(recover).toBeVisible();await expect(page.getByRole('button',{name:'更新到 99.0.0',exact:true})).toBeDisabled();
 await page.getByRole('button',{name:'测试会话 B',exact:true}).click();await expect(recover).toHaveCount(0);
 await page.getByRole('button',{name:'测试会话 A',exact:true}).click();await expect(recover).toBeVisible();await expect(capture(page)).toBeDisabled();
 if(await generate(page).count())await expect(generate(page)).toBeDisabled();
 await page.getByText(/插件版本与更新 ·/).click();await expect(page.getByRole('button',{name:'检查更新',exact:true})).toBeDisabled();
 expect((await stats(page)).installCalls).toBe(0);await page.evaluate(()=>window.fixture.configure({resultPending:false}));await recover.click();
 await expect(report(page)).toContainText('模型报告 a');expect((await stats(page)).modelCalls).toBe(1);expect((await stats(page)).calls.filter(x=>x.endpoint==='generate')).toHaveLength(1);
});

test('successful local recapture and subsequent analysis failure retain prior AI export',async({page})=>{
 await open(page);await selectGit(page);await collect(page);await analyze(page);
 await page.getByRole('textbox',{name:'报告标题',exact:true}).fill('下一次成功采集');await collect(page);
 await page.evaluate(()=>window.fixture.configure({failGenerate:true}));await route(page);await consent(page).check();await generate(page).click();
 await expect(page.getByRole('alert').filter({hasText:'fixture 模型失败'})).toBeVisible();
 await page.getByRole('button',{name:'查看上一份模型报告',exact:true}).click();await expect(report(page)).toContainText('模型报告 a');
 const pending=page.waitForEvent('download');await page.getByRole('button',{name:'下载 .md 文件'}).click();const download=await pending;
 expect(await readFile(await download.path(),'utf8')).toContain('模型报告 a');expect((await stats(page)).modelCalls).toBe(2);
});

test('expired snapshot disables generation and allows recollection with consent reset',async({page})=>{
 await page.clock.install();await open(page,{ttl:60000});await selectGit(page);await collect(page);await route(page);await consent(page).check();await page.clock.fastForward(61000);
 await expect(page.getByText(/预览已过期|快照已过期/).first()).toBeVisible({timeout:6000});await expect(generate(page)).toBeDisabled();await workflow(page,['active','pending','pending']);
 expect((await stats(page)).modelCalls).toBe(0);await page.evaluate(()=>window.fixture.configure({ttl:600000}));
 await page.getByRole('button',{name:'重新采集',exact:true}).click();await expect(consent(page)).not.toBeChecked();await expect(generate(page)).toBeDisabled();
});

test('session switch isolates reports and never restores active preview or consent',async({page})=>{
 await open(page);await selectGit(page);await collect(page);await analyze(page);
 await page.getByRole('button',{name:'测试会话 B',exact:true}).click();await expect(page.locator('.cr-workspace')).toContainText('G:/fixture/b');
 await expect(report(page)).toHaveCount(0);await selectGit(page);await collect(page);await expect(report(page)).toContainText('本地证据 b');
 await page.getByRole('button',{name:'测试会话 A',exact:true}).click();await expect(report(page)).toContainText('模型报告 a');await expect(consent(page)).toHaveCount(0);
 const storage=await page.evaluate(()=>JSON.stringify({...localStorage}));expect(storage).not.toContain('模型报告');
});

test('cancelled delayed capture cannot overwrite a retained report',async({page})=>{
 await open(page);await selectGit(page);await collect(page);await analyze(page);
 await page.evaluate(()=>window.fixture.configure({delayPreview:500,ignoreAbort:true}));await capture(page).click();
 await page.getByRole('button',{name:'取消',exact:true}).click();await expect(page.getByText(/^执行已取消；已有报告已保留$/)).toBeVisible();
 await expect.poll(async()=>await page.evaluate(()=>window.fixture.getStats().settledPreviews)).toBe(2);
 await expect(report(page)).toContainText('模型报告 a');expect((await stats(page)).modelCalls).toBe(1);
});

test('late response after session unmount does not leak a report into another session',async({page})=>{
 await open(page,{delayPreview:500,ignoreAbort:true});await selectGit(page);await capture(page).click();
 await page.getByRole('button',{name:'测试会话 B',exact:true}).click();
 await expect.poll(async()=>await page.evaluate(()=>window.fixture.getStats().settledPreviews)).toBe(1);
 await expect(report(page)).toHaveCount(0);await expect(page.locator('.cr-workspace')).toContainText('G:/fixture/b');
});

test('no workspace and incompatible backend never dispatch collection or model',async({page})=>{
 await open(page,{noSession:true,runtimeMismatch:true});await expect(page.getByText('请先打开一个带工作目录的会话。')).toBeVisible();
 await page.getByRole('button',{name:'测试会话 A',exact:true}).click();
 await expect(page.getByRole('alert').filter({hasText:/界面与后台版本/}).first()).toBeVisible();
 expect((await stats(page)).calls.filter(x=>['discover','preview','generate'].includes(x.endpoint))).toHaveLength(0);expect((await stats(page)).modelCalls).toBe(0);
});

test('native update restart barrier survives session remount and prevents repeat installation',async({page})=>{
 await open(page);await expect(page.getByRole('checkbox',{name:'纳入项目 1',exact:true})).toBeVisible();
 await page.getByText(/插件版本与更新 ·/).click();await page.getByRole('button',{name:'检查更新',exact:true}).click();
 await page.getByRole('checkbox',{name:/我确认将此插件更新到/}).check();await page.getByRole('button',{name:'更新到 99.0.0',exact:true}).click();
 await expect(page.getByText(/新版已安装/).first()).toBeVisible();await expect(page.getByRole('button',{name:'扫描 / 重新发现'})).toBeDisabled();
 await page.getByRole('button',{name:'测试会话 B',exact:true}).click();await expect(page.getByRole('button',{name:'扫描 / 重新发现'})).toBeDisabled();
 expect((await stats(page)).installCalls).toBe(1);expect((await stats(page)).modelCalls).toBe(0);
});


async function startHeldAnalysis(page,options={}){
 await open(page,{holdGenerate:true,...options});await selectGit(page);await collect(page);await route(page);await consent(page).check();await generate(page).click();
 await expect.poll(async()=>(await stats(page)).modelCalls).toBe(1);await workflow(page,['complete','complete','active']);
}
async function assertPaidProof(page,{dispatches=1,installs=0}={}){
 const value=await stats(page);expect(value.modelCalls).toBe(dispatches);expect(value.calls.filter(call=>call.endpoint==='generate')).toHaveLength(dispatches);expect(value.installCalls).toBe(installs);
 const identifiers=value.calls.filter(call=>call.endpoint==='generate').map(call=>call.payload.operationId);expect(new Set(identifiers).size).toBe(identifiers.length);
 return value;
}
async function downloadCurrent(page){const pending=page.waitForEvent('download');await page.getByRole('button',{name:'下载 .md 文件',exact:true}).click();return readFile(await (await pending).path(),'utf8');}

test('terminal paid completion and stopped proof clear a previously polled analyzing state',async({page})=>{
 for(const failGenerate of [false,true]){
  await startHeldAnalysis(page,{failGenerate});await expect(page.locator('.cr-progress')).toContainText('fixture analyzing');
  const before=await stats(page);const operationId=before.calls.find(call=>call.endpoint==='generate').payload.operationId;
  expect(before.calls.some(call=>call.endpoint==='progress'&&call.payload.operationId===operationId)).toBe(true);
  await page.evaluate(()=>window.fixture.releaseGenerate());
  if(failGenerate){await expect(page.getByRole('alert').filter({hasText:'fixture 模型失败'})).toBeVisible();await expect(page.locator('.cr-progress')).toContainText('fixture 模型失败');}
  else {await expect(report(page)).toContainText('模型报告 a');await expect(page.locator('.cr-progress')).toContainText('模型分析完成');}
  await expect(page.locator('.cr-progress')).not.toContainText('fixture analyzing');await expect(capture(page)).toBeEnabled();await assertPaidProof(page);
 }
});

test('in-place successful analysis is fresh and session restoration remains conservatively stale',async({page})=>{
 await startHeldAnalysis(page);await expect(page.locator('.cr-progress')).toContainText('fixture analyzing');
 await page.evaluate(()=>window.fixture.releaseGenerate());await expect(report(page)).toContainText('模型报告 a');
 const stale=page.getByRole('status').filter({hasText:'已有报告与当前草稿可能不同，旧结果已保留'});await expect(stale).toHaveCount(0);
 await page.getByRole('button',{name:'测试会话 B',exact:true}).click();await expect(report(page)).toHaveCount(0);
 await page.getByRole('button',{name:'测试会话 A',exact:true}).click();await expect(report(page)).toContainText('模型报告 a');await expect(stale).toBeVisible();await assertPaidProof(page);
});

test('in-flight paid work survives Panel detach and late success returns only to original session',async({page})=>{
 await startHeldAnalysis(page);await page.getByRole('button',{name:'测试会话 B',exact:true}).click();
 await expect(page.locator('.cr-workspace')).toContainText('G:/fixture/b');await expect(report(page)).toHaveCount(0);
 await expect(capture(page)).toBeDisabled();await page.evaluate(()=>window.fixture.releaseGenerate());
 await expect.poll(async()=>(await stats(page)).settledGenerations).toBe(1);await page.getByRole('button',{name:'测试会话 A',exact:true}).click();
 await expect(report(page)).toContainText('模型报告 a');expect((await stats(page)).generateAborts).toBe(0);await assertPaidProof(page);
});

test('detached paid response loss retains same operation for read-only recovery',async({page})=>{
 await startHeldAnalysis(page,{failGenerateResponse:true});await page.getByRole('button',{name:'测试会话 B',exact:true}).click();await page.evaluate(()=>window.fixture.releaseGenerate());
 await expect.poll(async()=>(await stats(page)).settledGenerations).toBe(1);await expect(report(page)).toHaveCount(0);
 await page.getByRole('button',{name:'测试会话 A',exact:true}).click();
 const recovery=page.getByRole('button',{name:'恢复已完成报告',exact:true});
 if(await recovery.count())await recovery.click();await expect(report(page)).toContainText('模型报告 a');
 const proof=await assertPaidProof(page);expect(proof.generateAborts).toBe(0);const paid=proof.calls.find(call=>call.endpoint==='generate');const reads=proof.calls.filter(call=>call.endpoint==='result');expect(reads.length).toBeGreaterThan(0);expect(reads.every(call=>call.payload.operationId===paid.payload.operationId&&call.payload.sessionId==='a')).toBe(true);
});

test('explicit paid cancellation retains unknown identity and later completion restores without dispatch',async({page})=>{
 await startHeldAnalysis(page);await page.getByRole('button',{name:'取消模型任务',exact:true}).click();
 await expect(page.getByRole('button',{name:'恢复已完成报告',exact:true})).toBeVisible();await expect(capture(page)).toBeDisabled();
 const before=await assertPaidProof(page);expect(before.generateAborts).toBe(1);const operation=before.calls.find(call=>call.endpoint==='generate').payload.operationId;
 await page.getByRole('checkbox',{name:'我确认标记放弃恢复；未知任务屏障仍保留，不解锁新业务或安装',exact:true}).check();await page.getByRole('button',{name:'放弃恢复',exact:true}).click();await expect(capture(page)).toBeDisabled();await expect(generate(page)).toBeDisabled();
 await page.getByRole('button',{name:'恢复已完成报告',exact:true}).click();await expect(capture(page)).toBeDisabled();
 await page.evaluate(()=>window.fixture.releaseGenerate());await expect.poll(async()=>(await stats(page)).settledGenerations).toBe(1);
 await page.getByRole('button',{name:'恢复已完成报告',exact:true}).click();await expect(report(page)).toContainText('模型报告 a');
 const after=await assertPaidProof(page);expect(after.calls.filter(call=>call.endpoint==='result').every(call=>call.payload.operationId===operation)).toBe(true);
});

test('unknown paid work in A blocks installation and refs in B while downloads remain local',async({page})=>{
 await open(page);await selectGit(page);await collect(page);await analyze(page);await page.getByRole('button',{name:'保存配置',exact:true}).click();
 await page.getByRole('button',{name:'测试会话 B',exact:true}).click();await selectGit(page);await collect(page);await page.getByRole('button',{name:'保存配置',exact:true}).click();
 await page.getByRole('button',{name:'测试会话 A',exact:true}).click();await collect(page);await route(page);
 await page.evaluate(()=>window.fixture.configure({holdGenerate:true}));await consent(page).check();await generate(page).click();await expect.poll(async()=>(await stats(page)).modelCalls).toBe(2);
 await page.getByRole('button',{name:'取消模型任务',exact:true}).click();await expect(page.getByRole('button',{name:'恢复已完成报告',exact:true})).toBeVisible();
 await page.getByRole('button',{name:'测试会话 B',exact:true}).click();await expect(report(page)).toContainText('本地证据 b');await expect(capture(page)).toBeDisabled();
 await expect(page.getByRole('button',{name:/^读取(?:远端|本地)分支\/标签$/,includeHidden:true})).toBeDisabled();
 await page.getByText(/插件版本与更新 ·/).click();const update=page.getByRole('button',{name:'检查更新',exact:true});if(await update.isEnabled())await update.click();
 const install=page.getByRole('button',{name:'更新到 99.0.0',exact:true});if(await install.count())await expect(install).toBeDisabled();
 const before=await stats(page);expect(await downloadCurrent(page)).toContain('本地证据 b');expect((await stats(page)).calls).toEqual(before.calls);
 await page.evaluate(()=>window.fixture.releaseGenerate());await expect.poll(async()=>(await stats(page)).settledGenerations).toBe(2);
 await page.getByRole('button',{name:'测试会话 A',exact:true}).click();await page.getByRole('button',{name:'恢复已完成报告',exact:true}).click();await expect(report(page)).toContainText('模型报告 a');await assertPaidProof(page,{dispatches:2});
});

test('native installation lease blocks cross-session refs and collection but preserves downloads',async({page})=>{
 await open(page,{holdInstall:true});await selectGit(page);await collect(page);await page.getByRole('button',{name:'保存配置',exact:true}).click();
 await page.getByRole('button',{name:'测试会话 B',exact:true}).click();await selectGit(page);await collect(page);await page.getByRole('button',{name:'保存配置',exact:true}).click();
 await page.getByRole('button',{name:'测试会话 A',exact:true}).click();await page.getByText(/插件版本与更新 ·/).click();await page.getByRole('button',{name:'检查更新',exact:true}).click();await page.getByRole('checkbox',{name:/我确认将此插件更新到/}).check();await page.getByRole('button',{name:'更新到 99.0.0',exact:true}).click();
 await expect.poll(async()=>(await stats(page)).installCalls).toBe(1);await page.getByRole('button',{name:'测试会话 B',exact:true}).click();
 await expect(capture(page)).toBeDisabled();await expect(page.getByRole('button',{name:/^读取(?:远端|本地)分支\/标签$/,includeHidden:true})).toBeDisabled();const before=await stats(page);expect(await downloadCurrent(page)).toContain('本地证据 b');expect((await stats(page)).calls).toEqual(before.calls);
 await page.evaluate(()=>window.fixture.releaseInstall());await expect(page.getByRole('alert').filter({hasText:/重启/}).first()).toBeVisible();await assertPaidProof(page,{dispatches:0,installs:1});
});

test('a held refs request owns the business lease and prevents concurrent native installation',async({page})=>{
 await open(page,{holdRefs:true});await selectGit(page);await page.getByText(/插件版本与更新 ·/).click();await page.getByRole('button',{name:'检查更新',exact:true}).click();await page.getByRole('checkbox',{name:/我确认将此插件更新到/}).check();
 await page.getByRole('button',{name:/^读取(?:远端|本地)分支\/标签$/}).click();await expect.poll(async()=>(await stats(page)).calls.filter(call=>call.endpoint==='refs').length).toBe(1);
 await expect(page.getByRole('button',{name:'更新到 99.0.0',exact:true})).toBeDisabled();await expect(capture(page)).toBeDisabled();await assertPaidProof(page,{dispatches:0});
 await page.evaluate(()=>window.fixture.releaseRefs());await expect(page.getByText('已载入 3 个远端引用，在 A/B 输入中选择；此次查询观察值，采集时会重新获取。')).toBeVisible();await expect(page.getByRole('button',{name:'更新到 99.0.0',exact:true})).toBeEnabled();
});

for(const width of [320,680,1280])test('viewport '+width+' supports long paths, 500 rows and keyboard selection',async({page},testInfo)=>{
 await page.setViewportSize({width,height:900});const errors=await open(page,{count:500});
 await expect(page.getByRole('checkbox',{name:/^纳入项目 [0-9]+$/})).toHaveCount(500);
 const search=page.getByRole('textbox',{name:'搜索项目路径',exact:true});await search.fill('project-499');
 const only=page.getByRole('checkbox',{name:'纳入项目 500',exact:true});await only.focus();await page.keyboard.press('Space');await expect(only).toBeChecked();
 await expandProject(page,500);await page.getByRole('combobox',{name:'GIT 分支 A 500',exact:true}).fill('main');await page.getByRole('combobox',{name:'GIT 分支 B 500',exact:true}).fill('release');
 const path=page.getByRole('textbox',{name:'项目路径 500',exact:true});await path.focus();await expect(path).toBeFocused();expect(await path.inputValue()).toContain('very-long-path');
 await expect(page.getByRole('button',{name:'开始执行 · 采集差异',exact:true})).toBeEnabled();
 const dimensions=await page.evaluate(()=>({scroll:document.documentElement.scrollWidth,viewport:innerWidth}));expect(dimensions.scroll).toBeLessThanOrEqual(dimensions.viewport+2);
 const screenshot=testInfo.outputPath('viewport-'+width+'.png');await page.screenshot({path:screenshot});await testInfo.attach('viewport-'+width,{path:screenshot,contentType:'image/png'});expect(errors).toEqual([]);
});
