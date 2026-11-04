import {test,expect} from '@playwright/test';

// Real Chromium rendering with synthetic DSH services/theme tokens, not live-host acceptance.
const before=process.env.DSH_VISUAL_BEFORE==='1';
for(const theme of ['light','dark'])for(const width of [380,768,1280])test('visual '+theme+' '+width+' workspace, focus, contrast and overflow',async({page},info)=>{
 const errors=[];page.on('pageerror',error=>errors.push(error.message));
 await page.route('**/*',route=>new URL(route.request().url()).origin==='http://127.0.0.1:4178'?route.continue():route.abort('blockedbyclient'));
 await page.emulateMedia({colorScheme:theme,reducedMotion:'reduce'});await page.setViewportSize({width,height:1100});
 await page.addInitScript(value=>window.__fixtureOptions=value,{theme,count:3,...(before?{runningVersion:'0.9.0'}:{})});await page.goto('/');
 await expect(page.getByRole('heading',{name:'发布报告配置',exact:true})).toBeVisible();
 await page.getByRole('checkbox',{name:'纳入项目 1',exact:true}).check();
 if(!before){await expect(page.getByRole('button',{name:'展开项目 1',exact:true})).toHaveAttribute('aria-expanded','false');await expect(page.locator('#cr-row-0 [aria-label="项目路径 1"]')).not.toBeVisible();const collapsed=info.outputPath('collapsed-'+theme+'-'+width+'.png');await page.locator('.cr-repositories').screenshot({path:collapsed});await info.attach('collapsed-'+theme+'-'+width,{path:collapsed,contentType:'image/png'});await page.getByRole('button',{name:'展开项目 1',exact:true}).click();await expect(page.getByRole('button',{name:'收起项目 1',exact:true})).toHaveAttribute('aria-expanded','true');}
 await page.getByRole('combobox',{name:'GIT 分支 A 1',exact:true}).fill('main');await page.getByRole('combobox',{name:'GIT 分支 B 1',exact:true}).fill('release/2026.11');
 const path=page.getByRole('textbox',{name:'项目路径 1',exact:true});await path.fill('frontend/packages/release-workspace/very-long-project-name');await path.focus();await page.keyboard.press('Tab');
 if(!before){
  const focused=await page.evaluate(()=>{const element=document.activeElement,style=getComputedStyle(element);return {visible:element.matches(':focus-visible'),outline:style.outlineStyle,shadow:style.boxShadow};});
  expect(focused.visible).toBe(true);expect(focused.outline!=='none'||focused.shadow!=='none').toBe(true);
  const controls=page.locator('#cr-row-0').getByRole('combobox',{name:'Git 读取方式 1',exact:true});
  expect(await controls.evaluate(element=>{const style=getComputedStyle(element),canvas=document.createElement('canvas'),context=canvas.getContext('2d');context.font=style.font;return element.clientWidth-context.measureText(element.selectedOptions[0].textContent).width-parseFloat(style.paddingLeft)-parseFloat(style.paddingRight);})).toBeGreaterThanOrEqual(14);
 }
 const overflow=await page.evaluate(()=>({page:document.documentElement.scrollWidth,viewport:innerWidth,root:document.querySelector('.cr-root').scrollWidth,rootWidth:document.querySelector('.cr-root').clientWidth}));
 if(!before&&width===380)expect(await page.locator('.cr-workspace-bar').evaluate(element=>element.getBoundingClientRect().height),'compact mobile workspace bar').toBeLessThan(120);
 if(!before){expect(overflow.page).toBeLessThanOrEqual(overflow.viewport+2);expect(overflow.root).toBeLessThanOrEqual(overflow.rootWidth+2);}
 // Computed foreground/background contrast including alpha compositing, not a theme-name assertion.
 const measureContrast=()=>{
  const canvas=document.createElement('canvas');canvas.width=canvas.height=1;const context=canvas.getContext('2d',{willReadFrequently:true});
  const rgba=value=>{context.clearRect(0,0,1,1);context.fillStyle=value;context.fillRect(0,0,1,1);const c=context.getImageData(0,0,1,1).data;return [c[0],c[1],c[2],c[3]/255];};
  const over=(top,bottom)=>[0,1,2].map(i=>top[i]*top[3]+bottom[i]*(1-top[3])).concat(1);
  const background=element=>{let color=[255,255,255,1];for(const parent of [element,...function*(node){while(node.parentElement){node=node.parentElement;yield node;}}(element)].reverse())color=over(rgba(getComputedStyle(parent).backgroundColor),color);return color;};
  const luminance=color=>color.slice(0,3).map(value=>{value/=255;return value<=.04045?value/12.92:((value+.055)/1.055)**2.4;}).reduce((sum,value,i)=>sum+value*[.2126,.7152,.0722][i],0);
  return [...document.querySelectorAll('.cr-root h1,.cr-root h2,.cr-root .cr-hint,.cr-root .cr-stage strong,.cr-root .cr-stage span,.cr-root .cr-source-notice,.cr-root label')].filter(element=>element.getClientRects().length&&element.textContent.trim()&&!element.closest('[disabled]')).map(element=>{const style=getComputedStyle(element),bg=background(element),fg=over(rgba(style.color),bg),a=luminance(fg),b=luminance(bg);return {text:element.textContent.trim().slice(0,60),ratio:(Math.max(a,b)+.05)/(Math.min(a,b)+.05),large:parseFloat(style.fontSize)>=24||(parseFloat(style.fontSize)>=18.66&&Number(style.fontWeight)>=700)};});
 };
 const contrast=await page.evaluate(measureContrast);
 if(!before)for(const item of contrast)expect(item.ratio,item.text+' contrast').toBeGreaterThanOrEqual(item.large?3:4.5);
 if(!before){await page.emulateMedia({colorScheme:theme==='dark'?'light':'dark',reducedMotion:'reduce'});const opposite=await page.evaluate(measureContrast);for(const item of opposite)expect(item.ratio,'host '+theme+' opposite OS '+item.text).toBeGreaterThanOrEqual(item.large?3:4.5);await page.emulateMedia({colorScheme:theme,reducedMotion:'reduce'});}
 await page.evaluate(()=>{document.querySelector('.cr-root').scrollTop=0;window.scrollTo(0,0);});
 const prefix=(before?'before':'after')+'-'+theme+'-'+width;
 const workspace=info.outputPath(prefix+'-workspace.png');await page.screenshot({path:workspace});await info.attach(prefix+'-workspace',{path:workspace,contentType:'image/png'});
 if(!before&&theme==='dark'&&width===1280&&process.env.DSH_SHOWCASE_PATH){await page.setViewportSize({width,height:1500});await page.locator('.cr-root').screenshot({path:process.env.DSH_SHOWCASE_PATH});await info.attach('dark-workspace-showcase',{path:process.env.DSH_SHOWCASE_PATH,contentType:'image/png'});await page.setViewportSize({width,height:1100});}
 await page.getByRole('button',{name:'开始执行 · 采集差异',exact:true}).click();const preview=page.getByRole('group',{name:'3. 确认分析范围',exact:true});await expect(preview).toBeVisible();await preview.scrollIntoViewIfNeeded();
 const evidence=info.outputPath(prefix+'-preview.png');await page.screenshot({path:evidence});await info.attach(prefix+'-preview',{path:evidence,contentType:'image/png'});
 expect(await page.evaluate(()=>window.fixture.getStats().modelCalls)).toBe(0);expect(errors).toEqual([]);
});
