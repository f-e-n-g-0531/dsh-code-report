// Reader export is a derived copy; internal evidence and original text are retained.
const sections=['本次比较范围','改动内容','对外接口变更','影响范围','QA 测试范围'];
function readerLine(line){
 line=line.replace(/ ?\[\d+\]\(#evidence-\d+\)/g,'');
 // Classify a decoded shadow, but slice the original so metadata remains inert
 // Markdown. In particular markdownText encodes URL colons, slashes and backticks.
 const offsets=[];let text='';
 for(const match of line.matchAll(/&#(?:[0-9]+|x[0-9a-f]+);|[\s\S]/gi)){
  const entity=/^&#(x[0-9a-f]+|[0-9]+);$/i.exec(match[0]);
  const code=entity?Number.parseInt(entity[1].replace(/^x/i,''),/^x/i.test(entity[1])?16:10):NaN;
  const decoded=Number.isInteger(code)&&code<=0x10ffff?String.fromCodePoint(code):match[0];
  for(let index=0;index<decoded.length;index++)offsets.push({start:match.index,end:match.index+match[0].length});
  text+=decoded;
 }
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
  /(?:[A-Za-z]:)?[\w.@~\-]+[/\\][\w.@~\/\\-]*[.](?:h|hpp|hh|c|cc|cpp|cxx|cs|mjs|jsx|js|ts|tsx|shader|hlsl|glsl|cginc)\b/gi,
  /\b[A-Za-z_][A-Za-z0-9_.-]*\.(?:h|hpp|hh|c|cc|cpp|cxx|cs|mjs|jsx|js|ts|tsx|shader|hlsl|glsl|cginc)\b/gi,
 ];
 const removed=[];
 for(const pattern of patterns)for(const match of text.matchAll(pattern)){
  const start=match.index,end=start+match[0].length;
  if(!endpoints.some(endpoint=>start<endpoint.end&&end>endpoint.start))removed.push({start:offsets[start].start,end:offsets[end-1].end});
 }
 let result='',cursor=0;
 for(const range of removed.sort((a,b)=>a.start-b.start)){
  if(range.start>cursor)result+=line.slice(cursor,range.start);
  cursor=Math.max(cursor,range.end);
 }
 return result+line.slice(cursor);
}
export function reportDownloadText(markdown,kind){
 if(kind!=='analysis')return markdown;
 const buckets=new Map(sections.map(title=>[title,[]]));let active=null,fence=null,details=0;
 for(const line of markdown.split(/\r?\n/)){
  const marker=line.match(/^ {0,3}(`{3,}|~{3,})/);
  if(marker){if(!fence)fence={char:marker[1][0],length:marker[1].length};else if(marker[1][0]===fence.char&&marker[1].length>=fence.length)fence=null;continue;}
  if(fence)continue;
  if(line.trim()==='<details>'){details++;continue;}
  if(line.trim()==='</details>'){details=Math.max(0,details-1);continue;}
  if(details)continue;
  const heading=line.match(/^ {0,3}(#{1,2}) +(.+?)\s*#*$/);
  if(heading){active=heading[1].length===2&&buckets.has(heading[2])?heading[2]:null;continue;}
  if(active&&!/^本报告为单次摘要：|^本地清单含 |^已处理证据 |^模型：/.test(line))buckets.get(active).push(active==='本次比较范围'?line:readerLine(line));
 }
 return sections.map(title=>'## '+title+'\n\n'+(buckets.get(title).join('\n').trim()||'未提供可对外展示的内容，待确认。')).join('\n\n')+'\n';
}
