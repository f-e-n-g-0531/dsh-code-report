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
const report=page=>page.locator('pre.cr-report');
const consent=page=>page.getByRole('checkbox',{name:/我确认向上方指定模型发送/});
const stats=page=>page.evaluate(()=>window.fixture.getStats());
async function open(page,options={}){
 const errors=[];page.on('pageerror',error=>errors.push(error.message));
 await page.addInitScript(value=>{window.__fixtureOptions=value;},options);
 await page.goto('/');await expect(page.getByRole('heading',{name:'发布报告配置'})).toBeVisible();
 return errors;
}
async function selectGit(page){
 await expect(page.getByRole('checkbox',{name:'纳入项目 1',exact:true})).toBeVisible();
 await page.getByRole('checkbox',{name:'纳入项目 1',exact:true}).check();
 await page.getByRole('combobox',{name:'GIT 分支 B 1',exact:true}).fill('release');
 await expect(capture(page)).toBeEnabled();
}
async function collect(page){await capture(page).click();await expect(report(page)).toContainText('本地证据');}
async function route(page){await page.getByRole('textbox',{name:'DSH 提供方 ID',exact:true}).fill('fixture');await page.getByRole('textbox',{name:'模型 ID',exact:true}).fill('mock');}
async function analyze(page){await route(page);await consent(page).check();await generate(page).click();await expect(report(page)).toContainText('模型报告');}

test('real DOM scan → select → local evidence → explicit consent → safe download',async({page})=>{
 const errors=await open(page);await selectGit(page);await collect(page);
 expect((await stats(page)).modelCalls).toBe(0);await route(page);await expect(generate(page)).toBeDisabled();
 expect((await stats(page)).calls.filter(x=>x.endpoint==='generate')).toHaveLength(0);
 await consent(page).check();await generate(page).click();await expect(report(page)).toContainText('模型报告 a');
 expect((await stats(page)).modelCalls).toBe(1);expect(await page.evaluate(()=>window.fixtureInjected)).toBeUndefined();
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
 await open(page);await selectGit(page);await page.getByRole('button',{name:'读取本地分支/标签',exact:true}).click();
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

test('folder input preserves original request and expanded preview is visible before model authorization (contract mock)',async({page})=>{
 const directoryContextPreview={context:[
  {path:'client/src/components/Button.tsx',provenance:'workspace',hash:'1'.repeat(64)},
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
 await expect(files).toContainText('当前工作区');await expect(files).toContainText('版本 A');
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
 await expect(page.getByText(/预览已过期|快照已过期/).first()).toBeVisible({timeout:6000});await expect(generate(page)).toBeDisabled();
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
 await expect.poll(async()=>(await stats(page)).modelCalls).toBe(1);
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
 await expect(page.getByRole('button',{name:'读取本地分支/标签',exact:true})).toBeDisabled();
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
 await expect(capture(page)).toBeDisabled();await expect(page.getByRole('button',{name:'读取本地分支/标签',exact:true})).toBeDisabled();const before=await stats(page);expect(await downloadCurrent(page)).toContain('本地证据 b');expect((await stats(page)).calls).toEqual(before.calls);
 await page.evaluate(()=>window.fixture.releaseInstall());await expect(page.getByRole('alert').filter({hasText:/重启/}).first()).toBeVisible();await assertPaidProof(page,{dispatches:0,installs:1});
});

test('a held refs request owns the business lease and prevents concurrent native installation',async({page})=>{
 await open(page,{holdRefs:true});await selectGit(page);await page.getByText(/插件版本与更新 ·/).click();await page.getByRole('button',{name:'检查更新',exact:true}).click();await page.getByRole('checkbox',{name:/我确认将此插件更新到/}).check();
 await page.getByRole('button',{name:'读取本地分支/标签',exact:true}).click();await expect.poll(async()=>(await stats(page)).calls.filter(call=>call.endpoint==='refs').length).toBe(1);
 await expect(page.getByRole('button',{name:'更新到 99.0.0',exact:true})).toBeDisabled();await expect(capture(page)).toBeDisabled();await assertPaidProof(page,{dispatches:0});
 await page.evaluate(()=>window.fixture.releaseRefs());await expect(page.getByText('已载入 3 个本地引用，在 A/B 输入中选择；不会 fetch。')).toBeVisible();await expect(page.getByRole('button',{name:'更新到 99.0.0',exact:true})).toBeEnabled();
});

for(const width of [320,680,1280])test('viewport '+width+' supports long paths, 500 rows and keyboard selection',async({page},testInfo)=>{
 await page.setViewportSize({width,height:900});const errors=await open(page,{count:500});
 await expect(page.getByRole('checkbox',{name:/^纳入项目 [0-9]+$/})).toHaveCount(500);
 const search=page.getByRole('textbox',{name:'搜索项目路径',exact:true});await search.fill('project-499');
 const only=page.getByRole('checkbox',{name:'纳入项目 500',exact:true});await only.focus();await page.keyboard.press('Space');await expect(only).toBeChecked();
 const path=page.getByRole('textbox',{name:'项目路径 500',exact:true});await path.focus();await expect(path).toBeFocused();expect(await path.inputValue()).toContain('very-long-path');
 await expect(page.getByRole('button',{name:'开始执行 · 采集差异',exact:true})).toBeEnabled();
 const dimensions=await page.evaluate(()=>({scroll:document.documentElement.scrollWidth,viewport:innerWidth}));expect(dimensions.scroll).toBeLessThanOrEqual(dimensions.viewport+2);
 const screenshot=testInfo.outputPath('viewport-'+width+'.png');await page.screenshot({path:screenshot});await testInfo.attach('viewport-'+width,{path:screenshot,contentType:'image/png'});expect(errors).toEqual([]);
});
