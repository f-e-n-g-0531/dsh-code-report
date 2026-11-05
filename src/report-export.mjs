// Reader export is a derived copy; internal evidence and original text are retained.
const sections=['本次比较范围','改动内容','对外接口变更','影响范围','QA 测试范围'];
function readerLine(line){
 return line.replace(/ ?\[\d+\]\(#evidence-\d+\)/g,'')
  .replace(/`[^`]*(?:[/\\]|&#47;|&#92;)[^`]*[.](?:h|hpp|hh|c|cc|cpp|cxx|cs|mjs|jsx|js|ts|tsx|shader|hlsl|glsl|cginc)`/gi,'')
  .replace(/(?:[A-Za-z]:)?(?:[\w.@~\-]|&#95;)+(?:[/\\]|&#47;|&#92;)(?:[\w.@~\-]|&#95;|[/\\]|&#47;|&#92;)*[.](?:h|hpp|hh|c|cc|cpp|cxx|cs|mjs|jsx|js|ts|tsx|shader|hlsl|glsl|cginc)\b/gi,'')
  .replace(/\b[A-Za-z_][A-Za-z0-9_.-]*\.(?:h|hpp|hh|c|cc|cpp|cxx|cs|mjs|jsx|js|ts|tsx|shader|hlsl|glsl|cginc)\b/gi,'');
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
  if(active&&!/^本报告为单次摘要：|^本地清单含 |^已处理证据 |^模型：/.test(line))buckets.get(active).push(readerLine(line));
 }
 return sections.map(title=>'## '+title+'\n\n'+(buckets.get(title).join('\n').trim()||'未提供可对外展示的内容，待确认。')).join('\n\n')+'\n';
}
