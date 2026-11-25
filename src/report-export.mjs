import {moduleLayout, readModuleMarker} from './report-modules.mjs';

// Reader export is a derived copy; internal evidence and original text are retained.
const pendingTitle='待补充与待确认';
const scopeTitle='本次比较范围', interfaceTitle='对外接口变更', changeTitle='改动内容';
const sections=[scopeTitle,interfaceTitle,'QA 测试范围',pendingTitle,changeTitle];
const impactTitle='### 更新后要注意什么';
const actionSummary='查看其他接入与回归说明';
const riskTitle='### 这些情况需要确认';
const legacyImpactTitles=new Set(['### 客户端接入与影响','### 使用方接入与影响']);
const legacyGuides=new Set([
 '- **换包前**：如果项目直接调用这次变更的接口，先看「对外接口变更」，按适用条目核对配套头文件、库和旧调用。',
 '- **换包后**：从「QA 测试范围」挑项目已经使用的场景，用同一套样例对比换包前后。',
 '- **不能确定时**：先看下方是否列出交付风险；其他问题查「待补充与待确认」。未确认不等于通过，回归建议尚未执行。',
 '- **不能确定时**：旧包能否混用、功能是否启用、缺哪些样例，看「待补充与待确认」。未确认不等于已经通过。'
]);
const legacyActionSummary='查看逐项接入与回归建议';
const qaTitle='QA 测试范围';
const specialistTitle='### 研发专项验证';
const specialistSummary='研发专项验证（由引擎执行）';
const actionTitles=['换包前核对','换包后回归','等引擎确认'];
const rebuildTitle='成套重编与链接（仅适用于以下条目）：使用同批头文件和库重编并验证链接，具体条件以各条为准。';
const urgentTitle='### P0 发布前优先核对（由引擎执行）';
const urgentBullet=/^- 研发专项(?:[｜|]|&#(?:124|65372|x0*(?:7c|ff5c));)\s*P0\s*(?:[｜|]|&#(?:124|65372|x0*(?:7c|ff5c));)/iu;
const blankOrBullet=line=>/^\s*(?:- |$)/.test(line);
const readerFolds=new Map([[changeTitle,'逐项改动明细']]);
const foldLead=new Map([[changeTitle,'下列为逐项变更，按需展开查阅。']]);
const singleSummaryNotice='本报告为单次摘要，仅基于预算内的摘要与选取原文片段，不是全文语义分析；覆盖可能不完整，结论与测试建议仍待人工复核。';
const fullScopeNotice='全量证据模式：覆盖已纳入的差异，不代表语义完整，结论仍需人工复核。';
const emptySection='未提供可对外展示的内容，待确认。';
function readerLine(line){
 line=line.replace(/ ?\[\d+\]\(#evidence-\d+\)/g,'');
 // Classify a decoded shadow, but slice the original so metadata remains inert
 // Markdown. In particular markdownText encodes URL colons, slashes and backticks.
 const entities=[];let shift=0;
 const text=line.replace(/&#(x[0-9a-f]+|[0-9]+);/gi,(encoded,value,start)=>{
  const code=Number.parseInt(value.replace(/^x/i,''),/^x/i.test(value)?16:10);
  if(!Number.isInteger(code)||code>0x10ffff)return encoded;
  const decoded=String.fromCodePoint(code),from=start-shift;
  shift+=encoded.length-decoded.length;
  entities.push({from,to:from+decoded.length,start,end:start+encoded.length,shift});
  return decoded;
 });
 const originalOffset=(index,end)=>{
  let lo=0,hi=entities.length;
  while(lo<hi){const mid=(lo+hi)>>>1;if(entities[mid].from<=index)lo=mid+1;else hi=mid;}
  const entity=entities[lo-1];
  if(entity&&index<entity.to)return end?entity.end:entity.start;
  return index+(entity?.shift??0)+(end?1:0);
 };
 // Public URLs and root-relative endpoints are contracts, even when their path
 // or query contains a source-looking filename. Match them before source cleanup.
 const endpoints=[];
 for(const match of text.matchAll(/https?:\/\/|(?<![\w.\/\\:])\//gi)){
  if(endpoints.some(endpoint=>match.index<endpoint.end))continue;
  let end=match.index,depth=0,query=false;
  for(;end<text.length;end++){
   const character=text[end];
   if(/[\s`<>"'，。；（）]/.test(character))break;
   if(character===')'){if(!depth)break;depth--;}
   if(character==='(')depth++;
   if(character==='?'||character==='#')query=true;
   if(!query&&(character===','||character===';'))break;
  }
  endpoints.push({start:match.index,end});
 }
 const patterns=[
  /`[^`\s]*[/\\][^`\s]*[.](?:h|hpp|hh|c|cc|cpp|cxx|cs|mjs|jsx|js|ts|tsx|shader|hlsl|glsl|cginc)`/gi,
  /(?:[A-Za-z]:[/\\]|[\w.@~\-]+[/\\])[\w.@~\/\\-]*[.](?:h|hpp|hh|c|cc|cpp|cxx|cs|mjs|jsx|js|ts|tsx|shader|hlsl|glsl|cginc)\b/gi,
  /\b[A-Za-z_][A-Za-z0-9_.-]*\.(?:h|hpp|hh|c|cc|cpp|cxx|cs|mjs|jsx|js|ts|tsx|shader|hlsl|glsl|cginc)\b/gi,
 ];
 const removed=[];
 for(const pattern of patterns)for(const match of text.matchAll(pattern)){
  const start=match.index,end=start+match[0].length;
  if(!endpoints.some(endpoint=>start<endpoint.end&&end>endpoint.start))removed.push({start:originalOffset(start,false),end:originalOffset(end-1,true)});
 }
 let result='',cursor=0;
 for(const range of removed.sort((a,b)=>a.start-b.start||b.end-a.end)){
  if(range.start<cursor)continue;
  result+=line.slice(cursor,range.start)+'相关源码文件';
  cursor=range.end;
 }
 return result+line.slice(cursor);
}
const cleanReaderLine=line=>readerLine(line).replace(/【事项(?:：|&#58;)[^】\r\n]{2,60}】[ \t]*/gu,'').replace(/(?:改动(?:：|&#58;)){2,}/g,'改动：').trimEnd();
// Use only producer-supplied action labels. Unclassified text stays visible;
// never infer equivalence from similar wording or take only the first N items.
function clientActions(lines,{deduplicate=true}={}){
 const groups=new Map(actionTitles.map(title=>[title,[]])), other=[];
 const rebuild=[], reminders=[];
 let target=other;
 for(const line of lines){
  const reminder=/^- 【更新提醒】\s*(\S.*)$/u.exec(line);
  if(reminder){target=reminders;target.push('- '+reminder[1]);continue;}
  const labeled=/^- 【(换包前核对|换包后回归|等引擎确认)】\s*(\S.*)$/u.exec(line);
  if(labeled){
   const shared=labeled[1]==='换包前核对'&&/^【成套重编】\s*(\S.*)$/u.exec(labeled[2]);
   target=shared?rebuild:groups.get(labeled[1]);target.push('- '+(shared?shared[1]:labeled[2]));continue;
  }
  if(!line.trim()||/^ {2,}\S/.test(line)){target.push(line);continue;}
  target=other;other.push(line);
 }
 const out=[];
 const actionBody=items=>polish(items,deduplicate?'影响范围':'');
 for(const [title,items] of groups){
  const body=actionBody(items);
  const shared=title==='换包前核对'&&rebuild.length
   ? '- '+rebuildTitle+'\n'+actionBody(rebuild).split('\n').filter(Boolean).map(line=>'  '+line).join('\n') : '';
  if(shared||body)out.push([shared,body].filter(Boolean).join('\n'), '');
 }
 const rest=actionBody(other);
 if(rest)out.push(rest);
 return {main:polish(reminders,'更新提醒'),details:out.join('\n').trim()};
}
// Deduplicate complete top-level list items, not individual QA steps or table rows.
function polish(lines, title){
 const out=[], seen=new Set();
 let group='', displayedGroup='';
 for(let i=0;i<lines.length;i++){
  const line=lines[i];
  if(line===impactTitle){out.push('',line,'');group='';displayedGroup='';continue;}
  if(/^#{3,4} /.test(line)){group=line;continue;}
  if(!line.trim()){if(out.length&&out.at(-1)!=='')out.push('');continue;}
  const block=[line];
  if(/^- /.test(line)){
   while(/^ {2,}\S/.test(lines[i+1]??''))block.push(lines[++i]);
   const key=JSON.stringify([group,block]);
   // Distinct source paths may have been replaced by the same placeholder.
   if(title==='影响范围'&&!block.some(part=>part.includes('相关源码文件')||part.includes('SDK 候选接口')||part.includes('对外接口：'))){
    if(seen.has(key))continue;
    seen.add(key);
   }
  }
  if(group!==displayedGroup){if(group)out.push('',group,'');displayedGroup=group;}
  out.push(...block);
 }
 return out.join('\n').replace(/\n{3,}/g,'\n\n').trim();
}
// Separate complete specialist list blocks so P0 never opens the whole appendix.
function splitDeliveryRisks(lines){
 const risks=[], rest=[];let target=rest;
 for(const line of lines){
  const risk=/^- (?:待确认：)?【交付风险】\s*(\S.*)$/u.exec(line);
  if(risk){target=risks;target.push('- '+risk[1]);continue;}
  if(line.trim()&&!/^ {2,}\S/.test(line))target=rest;
  target.push(line);
 }
 return {risks:polish(risks,pendingTitle),rest};
}
function actionFold(body){
 // Do not fold unstructured or legacy Markdown whose layout cannot be restored.
 if(!body.split('\n').every(line=>blankOrBullet(line)||/^#### /.test(line)))return body;
 return '<details>\n<summary>'+actionSummary+'</summary>\n\n'+body+'\n\n</details>';
}
function polishQa(body){
 const urgent=[];
 const ordinary=body.replace(/^### (?:研发专项验证|P0 发布前优先核对（由引擎执行）)\n+([\s\S]*?)(?=^### |(?![\s\S]))/gm,(section,content)=>{
  const lines=content.trimEnd().split('\n');
  if(!lines.length||!lines.every(blankOrBullet)||!lines.some(line=>line.startsWith('- ')))return section;
  const routine=[], visible=[];let target=routine;
  for(const line of lines){
   if(line.startsWith('- '))target=urgentBullet.test(line)?urgent:/^- (?:QA|待补充)(?:[｜|]|&#(?:124|65372|x0*(?:7c|ff5c));)/iu.test(line)?visible:routine;
   target.push(line);
  }
  const rows=routine.join('\n').trim();
  const conflicts=visible.join('\n').trim();
  return (rows?'<details>\n<summary>'+specialistSummary+'</summary>\n\n'+rows+'\n\n</details>\n\n':'')+(conflicts?'### 专项角色待核对\n\n'+conflicts+'\n\n':'');
 }).trimEnd();
 if(!urgent.length)return ordinary;
 const lead=ordinary.startsWith(qaNotice)?qaNotice:'';
 const rest=lead?ordinary.slice(lead.length).trimStart():ordinary;
 return [lead,urgentTitle+'\n\n'+urgent.join('\n').trimEnd(),rest].filter(Boolean).join('\n\n');
}
const qaNotice='以下为建议回归，尚未执行；只验证项目已接入的场景。';
const moduleGuide='正文按项目与功能模块归并；跨项目事项和归属待确认事项单列。';
const previousChapterModuleGuide='各章节内按项目与功能模块归并；跨项目事项和归属待确认事项单列。';
const chapterModuleGuide='QA 测试范围统一列出可执行回归；其他内容按项目与功能模块归并。';
const readerModuleGuides=new Set([moduleGuide,previousChapterModuleGuide,chapterModuleGuide]);
const moduleSummaries=new Set([actionSummary,specialistSummary,'逐项改动明细']);
const pendingSummary='查看待补充与待确认事项';
// Previously exported modular reports contain only sanitized headings, prose,
// lists and the reader-facing folds we produce here.
function readModuleCopy(markdown){
 const lines=markdown.split(/\r?\n/);
 if(lines[0]!=='## '+scopeTitle||!lines.some(line=>readerModuleGuides.has(line)))return null;
 const output=[];let chapter=null,chapterFold=null;
 for(let i=0;i<lines.length;i++){
  const line=lines[i];
  if(/^#{1,2} /.test(line)){
   if(chapterFold)return null;
   chapter=line;
  }
  if(chapterFold&&line==='</details>'){chapterFold=null;output.push(line);continue;}
  if(line==='<details>'){
   const summary=/^<summary>([^<>]+)<\/summary>$/.exec(lines[i+1]??'')?.[1];
   const chapterSummary=chapter==='## '+pendingTitle?pendingSummary:chapter==='## '+changeTitle?readerFolds.get(changeTitle):null;
   if(!chapterFold&&summary&&summary===chapterSummary){
    chapterFold=chapter;output.push(line,lines[++i]);continue;
   }
   if(!moduleSummaries.has(summary)||(chapterFold&&(chapterFold!=='## '+pendingTitle||summary!==specialistSummary)))return null;
   const start=i+2;let end=start;
   while(end<lines.length&&blankOrBullet(lines[end])&&!/[<>]/.test(lines[end]))end++;
   if(lines[end]!=='</details>')return null;
   output.push(line,lines[i+1],...lines.slice(start,end).map(cleanReaderLine),lines[end]);i=end;continue;
  }
  if(/[<>]/.test(line)||/^ {0,3}(?:`{3,}|~{3,})/.test(line))return null;
  output.push(cleanReaderLine(line));
 }
 return chapterFold?null:output.join('\n');
}
// Route whole list items by explicit role, not by implementation keywords.
const qaRole=/^- (QA|研发专项|待补充)(?:[｜|]|&#(?:124|65372|x0*(?:7c|ff5c));)/iu;
function partitionModuleQa(lines){
 const result={qa:[],specialist:[],pending:[]};
 let section=null,target=null;
 for(const line of lines){
  if(/^### /.test(line)){section=line;target=null;continue;}
  if(line.startsWith('- ')){
   const role=qaRole.exec(line)?.[1];
   target=role==='QA'?result.qa:role==='研发专项'||(!role&&section===specialistTitle)?result.specialist:result.pending;
  }else if(line.trim()&&!/^ {2,}\S/.test(line))target=result.pending;
  if(target)target.push(line);
 }
 return result;
}
function renderModuleReport(scope, groups, buckets) {
 const projectOrder=new Map();
 for(const line of scope){const match=/^- \*\*(.+?)\*\*：/.exec(line);if(match)projectOrder.set(match[1],projectOrder.size);}
 const rank={repo:0,cross:1,unassigned:2};
 const ordered=[...groups.values()].sort(({key:a},{key:b})=>rank[a[0]]-rank[b[0]]
  ||(projectOrder.get(a[1])??Infinity)-(projectOrder.get(b[1])??Infinity)
  ||(a[1]<b[1]?-1:a[1]>b[1]?1:0)||Number(a[2]===null)-Number(b[2]===null));
 const projectName=([kind,repo])=>kind==='repo'?repo:kind==='cross'?'跨项目联调':'归属待确认';
 const moduleName=([kind,,name])=>name??(kind==='repo'?'其他事项（功能模块待确认）':'其他事项');
 const inside=(render,{flat=false}={})=>{
  const output=[];let project;
  for(const {key,rows} of ordered){
   const body=render(rows);if(!body)continue;
   const [kind,repo]=key,id=JSON.stringify([kind,repo]);
   if(!flat&&id!==project){output.push('### '+projectName(key));project=id;}
   output.push('#### '+(flat?projectName(key)+' · ':'')+moduleName(key),body);
  }
  return output.join('\n\n');
 };
 const impacts=inside(rows=>{
  const {main,details}=clientActions(rows.get('影响范围')??[],{deduplicate:false});
  return [main,details&&actionFold(details)].filter(Boolean).join('\n\n');
 },{flat:true});
 const risks=inside(rows=>splitDeliveryRisks(rows.get(pendingTitle)??[]).risks,{flat:true});
 const roles=new Map(ordered.map(({rows})=>[rows,partitionModuleQa(rows.get(qaTitle)??[])]));
 // QA reads one checklist. Keep the complete items (including similar tests
 // with different steps) without exposing project or module headings.
 const qa=polish(ordered.flatMap(({rows})=>roles.get(rows).qa),qaTitle);
 const pending=inside(rows=>polish([...splitDeliveryRisks(rows.get(pendingTitle)??[]).rest,...roles.get(rows).pending],pendingTitle));
 const specialist=inside(rows=>{
  const items=polish(roles.get(rows).specialist,qaTitle);
  return items?polishQa(specialistTitle+'\n\n'+items).replace(/^### /gm,'##### '):'';
 },{flat:true});
 const change=inside(rows=>polish(rows.get(changeTitle)??[],changeTitle));
 const interfaceBody=inside(rows=>polish(rows.get(interfaceTitle)??[],interfaceTitle));
 const bodies=new Map([
  [scopeTitle,[polish(scope,scopeTitle),chapterModuleGuide,impacts&&impactTitle,impacts,risks&&riskTitle,risks]],
  [interfaceTitle,[interfaceBody||polish(buckets.get(interfaceTitle),interfaceTitle)]],
  [qaTitle,[qa&&qaNotice,qa]],
  [pendingTitle,[pending|| (risks?'需确认的交付风险已列在「这些情况需要确认」。':''),specialist&&'### 研发专项验证（不由 QA 执行）',specialist]],
  [changeTitle,[change]],
 ]);
 return sections.map(title=>{
  const body=bodies.get(title).filter(Boolean).join('\n\n')||emptySection;
  const summary=title===pendingTitle?pendingSummary:readerFolds.get(title);
  return '## '+title+'\n\n'+(summary
   ?'<details>\n<summary>'+summary+'</summary>\n\n'+body+'\n\n</details>'
   :body);
 }).join('\n\n')+'\n';
}
export function reportDownloadText(markdown,kind,{source="reader"}={}){
 if(kind!=='analysis')return markdown;
 if(source==='reader'){const copy=readModuleCopy(markdown);if(copy!==null)return copy;}
 const buckets=new Map([...sections,'影响范围'].map(title=>[title,[]]));let active=null,fence=null,details=0,scopeNotice=null,qaPending=false,technicalScope=false,legacyStage=null;
 const groups=new Map(),lastQaHeadings=new WeakMap();let modular=false,group=null,qaHeading=null;
 const lines=markdown.split(/\r?\n/);
 for(let i=0;i<lines.length;i++){
  const line=legacyImpactTitles.has(lines[i])&&active===scopeTitle?impactTitle:lines[i];
  const marker=line.match(/^ {0,3}(`{3,}|~{3,})/);
  if(marker){if(!fence)fence={char:marker[1][0],length:marker[1].length};else if(marker[1][0]===fence.char&&marker[1].length>=fence.length)fence=null;continue;}
  if(fence)continue;
  if(line.trim()==='<details>'){
   const specialist=active===qaTitle&&lines[i+1]==='<summary>'+specialistSummary+'</summary>';
   const action=active===scopeTitle&&[actionSummary,legacyActionSummary].find(label=>lines[i+1]==='<summary>'+label+'</summary>');
   const summary=action|| (specialist?specialistSummary:readerFolds.get(active));
   if(source==='reader'&&!details&&summary&&lines[i+1]==='<summary>'+summary+'</summary>'){
    // Accept only our own flat, sanitized reader folds on re-export. Any
    // nested block inside is still treated as a private appendix.
    const start=i+2;let end=start;
    while(end<lines.length&&(blankOrBullet(lines[end])||(action&&/^#### /.test(lines[end]))))end++;
    if(lines[end]==='</details>'){
     const bucket=buckets.get(qaPending?pendingTitle:active);
     if(action){
      bucket.push('<details>','<summary>'+actionSummary+'</summary>');
      for(const part of lines.slice(start,end))if(!/^#### (?:换包前核对|换包后回归|等引擎确认|未分类事项（待确认）)$/.test(part))bucket.push(cleanReaderLine(part));
      bucket.push(lines[end]);i=end;continue;
     }
     if(specialist&&!qaPending)bucket.push(specialistTitle);
     for(const part of lines.slice(start,end))bucket.push(cleanReaderLine(part));
     i=end;continue;
    }
   }
   details++;continue;
  }
  if(line.trim()==='</details>'){details=Math.max(0,details-1);continue;}
  if(details)continue;
  if(line===moduleLayout){modular=true;continue;}
  const moduleKey=modular&&active&&active!==scopeTitle?readModuleMarker(line):null;
  if(moduleKey){
   const id=JSON.stringify(moduleKey);
   if(!groups.has(id))groups.set(id,{key:moduleKey,rows:new Map()});
   group=groups.get(id).rows;
   continue;
  }
  const heading=line.match(/^ {0,3}(#{1,2}) +(.+?)\s*#*$/);
  if(heading){
   const title=heading[2];qaPending=false;technicalScope=false;legacyStage=null;group=null;qaHeading=null;
   active=heading[1].length!==2?null:title==='未知和待确认'?pendingTitle:title==='影响范围'?'影响范围':buckets.has(title)?title:null;
   continue;
  }
  if(/^本报告为单次摘要：/.test(line)){scopeNotice=singleSummaryNotice;continue;}
  if(/^本次比较范围：全量证据模式；/.test(line)){scopeNotice=fullScopeNotice;continue;}
  // Older internal reports included collection limitations inside comparison scope.
  if(active==='本次比较范围'&&/^### /.test(line)){
   technicalScope=/^### 采集覆盖限制(?:（非业务结论）)?\s*$/.test(line);
   if(technicalScope)continue;
  }
  if(technicalScope)continue;
  if(active===scopeTitle){
   if(/^#{3,4} /.test(line)){
    const stage=line.startsWith('#### ')?line.slice(5):null;
    legacyStage=actionTitles.includes(stage)?stage:stage==='未分类事项（待确认）'?'':null;
    if(legacyStage!==null)continue;
   }
   if(legacyStage!==null){
    const cleaned=cleanReaderLine(line);
    buckets.get('影响范围').push(legacyStage&&cleaned.startsWith('- ')?'- 【'+legacyStage+'】'+cleaned.slice(2):cleaned);
    continue;
   }
  }
  if(active==='QA 测试范围'&&/^### /.test(line)){
   qaPending=/^### (?:测试前待补充|待补充与待确认)\s*$/.test(line);
   if(modular){qaHeading=qaPending?null:line;group=null;continue;}
   if(qaPending)continue;
  }
  if(active===scopeTitle&&legacyGuides.has(line))continue;
  if(!active||line===foldLead.get(active)||/^本地清单含 |^已处理证据 |^模型：/.test(line))continue;
  // Remove producer boilerplate, not user-authored uncertainty or QA details.
  if(line==='模型未列出本节条目，不表示已证明不存在相关影响或未知项。'||(modular&&line==='与更新提醒相同的改动已在开头说明，不再重复。'))continue;
  const cleaned=cleanReaderLine(line);
  if(line.trim()&&!cleaned.trim())continue;
  const section=qaPending?pendingTitle:active;
  if(group){
   if(!group.has(section))group.set(section,[]);
   const rows=group.get(section);
   if(section===qaTitle&&qaHeading&&lastQaHeadings.get(rows)!==qaHeading){
    rows.push('',qaHeading,'');lastQaHeadings.set(rows,qaHeading);
   }
   rows.push(cleaned);
  }else buckets.get(section).push(cleaned);
 }
 const scope=buckets.get(scopeTitle);
 if(scopeNotice)scope.push('',scopeNotice);
 if(modular&&groups.size){
  const fallback=['unassigned','',null],id=JSON.stringify(fallback);
  for(const title of [changeTitle,qaTitle,pendingTitle,'影响范围',interfaceTitle]){
   const rows=buckets.get(title);
   // Keep the standard coverage notice ungrouped; it is not a project finding.
   if(!rows.some(line=>line.trim())||(title===interfaceTitle&&rows.every(line=>!line.trim()||line.startsWith('当前提供证据中未列出对外接口变化'))))continue;
   if(!groups.has(id))groups.set(id,{key:fallback,rows:new Map()});
   const target=groups.get(id).rows;
   target.set(title,[...(target.get(title)??[]),'',...rows]);
  }
  return renderModuleReport(scope,groups,buckets);
 }
 const impact=clientActions(buckets.get('影响范围'));
 const pending=splitDeliveryRisks(buckets.get(pendingTitle));
 buckets.set(pendingTitle,pending.risks&&!pending.rest.some(line=>line.trim())?['需确认的交付风险已列在「这些情况需要确认」。']:pending.rest);
 if(impact.main||impact.details||pending.risks){
  if(!scope.includes(impactTitle))scope.push('',impactTitle);
  if(impact.main)scope.push('',...impact.main.split('\n'));
  if(pending.risks)scope.push('',riskTitle,'',...pending.risks.split('\n'));
  if(impact.details)scope.push('',...actionFold(impact.details).split('\n'));
 }
 const qa=buckets.get('QA 测试范围');
 if(qa.some(line=>line.trim()&&line!==emptySection)&&!qa.includes(qaNotice))qa.unshift(qaNotice,'');
 return sections.map(title=>{
  // A reader action fold contains its own subheadings; polish only outside it.
  const rows=buckets.get(title);
  const actionStart=title===scopeTitle?rows.findIndex((line,index)=>line==='<details>'&&rows[index+1]==='<summary>'+actionSummary+'</summary>'):-1;
  const bodyBefore=actionStart<0?rows:rows.slice(0,actionStart);
  let body=polish(bodyBefore,title);
  if(actionStart>=0){
   const actionEnd=rows.indexOf('</details>',actionStart);
   body=[body,rows.slice(actionStart,actionEnd+1).join('\n'),polish(rows.slice(actionEnd+1),title)].filter(Boolean).join('\n\n');
  }
  if(title===qaTitle)body=polishQa(body);
  const summary=readerFolds.get(title);
  const fold=summary&&body&&body.split('\n').every(blankOrBullet);
  const lead=foldLead.get(title);
  return '## '+title+'\n\n'+(fold?lead+'\n\n<details>\n<summary>'+summary+'</summary>\n\n'+body+'\n\n</details>':body||emptySection);
 }).join('\n\n')+'\n';
}
