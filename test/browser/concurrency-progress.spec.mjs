import {test,expect} from '@playwright/test';

const capture=page=>page.getByRole('button',{name:'开始执行 · 采集差异',exact:true});
const generate=page=>page.getByRole('button',{name:'开始执行 · 生成报告',exact:true});
const consent=page=>page.getByRole('checkbox',{name:/我确认向上方指定模型发送/});
const concurrency=page=>page.getByRole('combobox',{name:'模型并发路数'});
const stats=page=>page.evaluate(()=>window.fixture.getStats());
const renderCounts=page=>page.evaluate(()=>window.__progressTest.renders);

async function open(page,options={}){
 const errors=[];page.on('pageerror',error=>errors.push(error.message));
 await page.route('**/*',route=>new URL(route.request().url()).origin==='http://127.0.0.1:4178'?route.continue():route.abort('blockedbyclient'));
 await page.addInitScript(options=>{
  window.__fixtureOptions=options;
  const probe=window.__progressTest={renders:{panel:0,table:0,report:0},polls:0,aborted:0,hangs:0};
  let loader;
  Object.defineProperty(window,'__ModuleLoader__',{get:()=>loader,set(value){
   const load=value.load;
   loader={load(entry){
    const factory=entry.factory;
    load({...entry,factory(require){
     const plugin=factory(id=>{
      const react=require(id),classNames={'cr-root':'panel','cr-repositories':'table','cr-report cr-report-document':'report'};
      return {...react,createElement(type,props,...children){
       const region=classNames[props?.className];if(region)probe.renders[region]++;
       return react.createElement(type,props,...children);
      }};
     });
     return {...plugin,apply(ctx){
      const call=ctx.connection.rpc.call;let operation;
      plugin.apply({...ctx,connection:{rpc:{async call(channel,endpoint,payload,signal){
       if(endpoint==='generate')operation=payload.operationId;
       if(endpoint==='runtime-info'){
        // Exercise the bounded legacy view poll even when the shared fixture gains async capability.
        const reply=await call(channel,endpoint,payload,signal);
        return {...reply,value:{...reply.value,capabilities:{...reply.value.capabilities,asyncGenerate:false}}};
       }
       if(endpoint==='progress'&&payload.operationId===operation){
        probe.polls++;
        if(probe.polls<=probe.hangs){signal.addEventListener('abort',()=>probe.aborted++,{once:true});return new Promise(()=>{});}
        return {ok:true,value:{phase:'analyzing',label:'fixture 模型分析',completed:probe.polls%2,total:6,queued:0,inFlight:2,etaMs:3200,concurrency:4}};
       }
       return call(channel,endpoint,payload,signal);
      }}}});
     }};
    }});
   }};
  }});
 },options);
 await page.goto('/');
 await page.getByRole('checkbox',{name:'纳入项目 1',exact:true}).check();
 await page.getByRole('button',{name:'展开项目 1',exact:true}).click();
 await page.getByRole('combobox',{name:'GIT 分支 A 1',exact:true}).fill('main');
 await page.getByRole('combobox',{name:'GIT 分支 B 1',exact:true}).fill('release');
 await capture(page).click();
 await expect(page.locator('article.cr-report')).toContainText('本地证据');
 return errors;
}

test('full concurrency is transient, clears consent, and leaves expensive regions alone during ticks',async({page})=>{
 const errors=await open(page,{holdGenerate:true,count:60,analysisBatches:6});
 const countdown=page.getByText(/^快照剩余约 \d+ 秒。$/);
 const value=await countdown.textContent(),beforeCountdown=await renderCounts(page);
 expect(beforeCountdown.panel).toBeGreaterThan(0);expect(beforeCountdown.table).toBeGreaterThan(0);expect(beforeCountdown.report).toBeGreaterThan(0);
 await expect(countdown).not.toHaveText(value);
 expect(await renderCounts(page)).toEqual(beforeCountdown);
 await expect(concurrency(page)).toHaveValue('2');
 await expect(concurrency(page).locator('option')).toHaveCount(3);
 await consent(page).check();await expect(generate(page)).toBeEnabled();
 await concurrency(page).selectOption('4');
 await expect(consent(page)).not.toBeChecked();await expect(generate(page)).toBeDisabled();
 await page.getByRole('button',{name:'保存配置',exact:true}).click();
 await expect(page.getByText(/已保存到当前工作目录/)).toBeVisible();
 expect((await stats(page)).calls.find(call=>call.endpoint==='configuration-save').payload.configuration).not.toHaveProperty('concurrency');
 expect((await stats(page)).modelCalls).toBe(0);
 await consent(page).check();await generate(page).click();
 const progress=page.locator('.cr-progress [role=status]');
 await expect(progress).toContainText('排队 0 片 · 进行中 2 片 · 并发 4 路 · 预计剩余约 4 秒');
 const first=await progress.textContent(),beforePolling=await renderCounts(page);
 await expect(progress).not.toHaveText(first);
 expect(await renderCounts(page)).toEqual(beforePolling);
 const generated=(await stats(page)).calls.filter(call=>call.endpoint==='generate');
 expect(generated).toHaveLength(1);expect(generated[0].payload).toMatchObject({concurrency:4,sendToModel:true});
 await page.evaluate(()=>window.fixture.releaseGenerate());
 await expect(page.locator('article.cr-report')).toContainText('模型报告');
 expect(errors).toEqual([]);
});

test('single-request plan always dispatches one lane',async({page})=>{
 const errors=await open(page,{singleRequest:true});
 await expect(concurrency(page)).toHaveCount(0);
 await consent(page).check();await generate(page).click();
 await expect(page.locator('article.cr-report')).toContainText('模型报告');
 const generated=(await stats(page)).calls.filter(call=>call.endpoint==='generate');
 expect(generated).toHaveLength(1);expect(generated[0].payload).toMatchObject({concurrency:1,sendToModel:true});
 expect(errors).toEqual([]);
});

test('hung progress observations time out, warn and recover without re-dispatch',async({page})=>{
 const errors=await open(page,{holdGenerate:true});
 await page.clock.install();
 await page.evaluate(()=>{window.__progressTest.hangs=2;});
 await consent(page).check();await generate(page).click();
 await page.clock.runFor(10800);
 await expect(page.getByText(/进度连接暂时失联.*进度查询超时/)).toBeVisible();
 expect(await page.evaluate(()=>window.__progressTest.aborted)).toBe(2);
 await page.clock.runFor(750);
 await expect(page.getByText(/进度连接暂时失联/)).toHaveCount(0);
 await expect(page.locator('.cr-progress [role=status]')).toContainText('fixture 模型分析');
 const generated=(await stats(page)).calls.filter(call=>call.endpoint==='generate');
 expect(generated).toHaveLength(1);expect(generated[0].payload.concurrency).toBe(2);
 await page.evaluate(()=>window.fixture.releaseGenerate());
 await page.clock.runFor(100);
 await expect(page.locator('article.cr-report')).toContainText('模型报告');
 expect(errors).toEqual([]);
});

test('expiration disables dispatch and clears an already checked consent',async({page})=>{
 await page.clock.install();
 const errors=await open(page,{ttl:15000});
 await consent(page).check();await expect(generate(page)).toBeEnabled();
 await page.clock.runFor(16000);
 await expect(page.getByText('快照已过期。',{exact:true})).toBeVisible();
 await expect(consent(page)).not.toBeChecked();await expect(generate(page)).toBeDisabled();
 expect((await stats(page)).modelCalls).toBe(0);
 expect(errors).toEqual([]);
});
