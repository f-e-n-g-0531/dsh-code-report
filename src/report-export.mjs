// Reader export is a derived copy; internal evidence and original text are retained.
const pendingTitle='待补充与待确认';
const sections=['本次比较范围','对外接口变更','改动内容','QA 测试范围',pendingTitle];
const singleSummaryNotice='本报告为单次摘要，仅基于预算内的摘要与选取原文片段，不是全文语义分析；覆盖可能不完整，结论与测试建议仍待人工复核。';
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
// Deduplicate complete top-level list items, not individual QA steps or table rows.
function polish(lines){
 const out=[], seen=new Set();
 let group='', displayedGroup='';
 for(let i=0;i<lines.length;i++){
  const line=lines[i];
  if(/^### /.test(line)){group=line;continue;}
  if(!line.trim()){if(out.length&&out.at(-1)!=='')out.push('');continue;}
  const block=[line];
  if(/^- /.test(line)){
   while(/^ {2,}\S/.test(lines[i+1]??''))block.push(lines[++i]);
   const key=JSON.stringify([group,block]);
   // Distinct source paths may have been replaced by the same placeholder.
   if(!block.some(part=>part.includes('相关源码文件'))){
    if(seen.has(key))continue;
    seen.add(key);
   }
  }
  if(group!==displayedGroup){if(group)out.push('',group,'');displayedGroup=group;}
  out.push(...block);
 }
 return out.join('\n').replace(/\n{3,}/g,'\n\n').trim();
}
export function reportDownloadText(markdown,kind){
 if(kind!=='analysis')return markdown;
 const buckets=new Map(sections.map(title=>[title,[]]));let active=null,fence=null,details=0,singleSummary=false,qaPending=false;
 for(const line of markdown.split(/\r?\n/)){
  const marker=line.match(/^ {0,3}(`{3,}|~{3,})/);
  if(marker){if(!fence)fence={char:marker[1][0],length:marker[1].length};else if(marker[1][0]===fence.char&&marker[1].length>=fence.length)fence=null;continue;}
  if(fence)continue;
  if(line.trim()==='<details>'){details++;continue;}
  if(line.trim()==='</details>'){details=Math.max(0,details-1);continue;}
  if(details)continue;
  const heading=line.match(/^ {0,3}(#{1,2}) +(.+?)\s*#*$/);
  if(heading){
   const title=heading[2];qaPending=false;
   active=heading[1].length!==2?null:title==='未知和待确认'?pendingTitle:buckets.has(title)?title:null;
   continue;
  }
  if(/^本报告为单次摘要：/.test(line)){singleSummary=true;continue;}
  if(/^本次比较范围：全量证据模式；/.test(line)){buckets.get('本次比较范围').push('', '全量证据模式：覆盖已纳入的差异，不代表语义完整，结论仍需人工复核。');continue;}
  if(active==='QA 测试范围'&&/^### /.test(line)){
   qaPending=/^### (?:测试前待补充|待补充与待确认)\s*$/.test(line);
   if(qaPending)continue;
  }
  if(!active||/^本地清单含 |^已处理证据 |^模型：/.test(line))continue;
  // Remove producer boilerplate, not user-authored uncertainty or QA details.
  if(line==='模型未列出本节条目，不表示已证明不存在相关影响或未知项。')continue;
  const cleaned=readerLine(line).trimEnd();
  if(line.trim()&&!cleaned.trim())continue;
  buckets.get(qaPending?pendingTitle:active).push(cleaned);
 }
 if(singleSummary)buckets.get('本次比较范围').push('',singleSummaryNotice);
 return sections.map(title=>'## '+title+'\n\n'+(polish(buckets.get(title))||emptySection)).join('\n\n')+'\n';
}
