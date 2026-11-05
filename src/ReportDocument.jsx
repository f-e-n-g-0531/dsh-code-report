import React from 'react';

// Decode into React text, never back into the syntax parser or HTML.
export function decodeReportText(value){
 return String(value).replace(/&#(x[0-9a-f]+|[0-9]+);/gi,(entity,digits)=>{
  const code=digits[0].toLowerCase()==='x'?parseInt(digits.slice(1),16):Number(digits);
  if(!Number.isInteger(code)||code<32||code>0x10ffff||(code>=0xd800&&code<=0xdfff)||code===127||(code>=0x202a&&code<=0x202e)||(code>=0x2066&&code<=0x2069))return entity;
  return String.fromCodePoint(code);
 });
}
function inline(text){
 const parts=[];
 // Only fixed inline syntax. URLs and image syntax stay inert text.
 const re=/(`+)([^`\n]+?)\1|\*\*([^*\n]+)\*\*|\[([^\]\n]+)\]\(#([A-Za-z][A-Za-z0-9_.:-]*)\)/g;
 let last=0,match;
 while((match=re.exec(text))){
  if(match.index>last)parts.push(decodeReportText(text.slice(last,match.index)));
  const key=match.index;
  if(match[1])parts.push(<code key={key}>{decodeReportText(match[2])}</code>);
  else if(match[3])parts.push(<strong key={key}>{decodeReportText(match[3])}</strong>);
  else if(text[match.index-1]!=='!')parts.push(<a key={key} href={'#'+match[5]}>{decodeReportText(match[4])}</a>);
  else parts.push(decodeReportText(match[0]));
  last=re.lastIndex;
 }
 if(last<text.length)parts.push(decodeReportText(text.slice(last)));
 return parts;
}
function fenceStart(line){return line.match(/^ {0,3}(`{3,}|~{3,})(.*)$/);}
const heading=line=>line.match(/^(#{1,6})\s+(.+)$/);
const list=line=>line.match(/^\s*(?:([-+*])\s+|(\d+)\.\s+)(.+)$/);
const cells=line=>line.trim().replace(/^\|/,'').replace(/\|$/,'').split('|').map(value=>value.trim());
const separator=line=>/^\s*\|?\s*:?-{3,}:?\s*(?:\|\s*:?-{3,}:?\s*)+\|?\s*$/.test(line);
// Keep appendix bodies out of both the parser and the DOM until native details opens.
function ReportAppendix({summary,lines,depth}){
 const [open,setOpen]=React.useState(false);
 const content=React.useMemo(()=>open?blocks(lines,{depth}):null,[open,lines,depth]);
 return <details className="cr-report-appendix" open={open} onToggle={event=>setOpen(event.currentTarget.open)}><summary>{summary}</summary>{content}</details>;
}
function blocks(lines,{depth=0}={}){
 const result=[];let i=0;
 while(i<lines.length){
  const line=lines[i];if(!line.trim()){i++;continue;}
  const key=i,mark=fenceStart(line),title=heading(line);
  if(mark){
   const content=[];i++;
   while(i<lines.length&&!new RegExp('^ {0,3}'+mark[1][0]+'{'+mark[1].length+',}\\s*$').test(lines[i]))content.push(lines[i++]);
   if(i<lines.length)i++;
   result.push(<pre key={key}><code>{content.join('\n')}</code></pre>);continue;
  }
  if(line.trim()==='<details>'&&depth<8){
   const nested=[];let count=1;i++;
   let summary='技术详情';
   const summaryMatch=lines[i]?.match(/^\s*<summary>([^<>]*)<\/summary>\s*$/);
   if(summaryMatch){summary=decodeReportText(summaryMatch[1]);i++;}
   let activeFence=null;
   while(i<lines.length){
    const current=lines[i],nextFence=fenceStart(current);
    if(nextFence){if(!activeFence)activeFence=nextFence[1];else if(nextFence[1][0]===activeFence[0]&&nextFence[1].length>=activeFence.length)activeFence=null;}
    if(!activeFence){if(current.trim()==='<details>')count++;if(current.trim()==='</details>'){count--;if(count===0){i++;break;}}}
    nested.push(current);i++;
   }
   result.push(<ReportAppendix key={key} summary={summary} lines={nested} depth={depth+1}/>);continue;
  }
  if(title){
   result.push(React.createElement('h'+title[1].length,{key},inline(title[2])));i++;continue;
  }
  if(i+1<lines.length&&line.includes('|')&&separator(lines[i+1])){
   const headers=cells(line),rows=[];i+=2;
   while(i<lines.length&&lines[i].includes('|')&&lines[i].trim())rows.push(cells(lines[i++]));
   result.push(<div className="cr-report-table" key={key}><table><thead><tr>{headers.map((cell,n)=><th scope="col" key={n}>{inline(cell)}</th>)}</tr></thead><tbody>{rows.map((row,n)=><tr key={n}>{row.map((cell,c)=><td key={c}>{inline(cell)}</td>)}</tr>)}</tbody></table></div>);continue;
  }
  const entry=list(line);
  if(entry){
   const ordered=!!entry[2],items=[];
   while(i<lines.length){const item=list(lines[i]);if(!item||!!item[2]!==ordered)break;items.push(<li key={i}>{inline(item[3])}</li>);i++;}
   result.push(React.createElement(ordered?'ol':'ul',{key},items));continue;
  }
  const anchor=line.match(/^<a id="([A-Za-z][A-Za-z0-9_.:-]*)"><\/a>$/);
  if(anchor){result.push(<span id={anchor[1]} key={key}/>);i++;continue;}
  const paragraph=[line];i++;
  while(i<lines.length&&lines[i].trim()&&!heading(lines[i])&&!list(lines[i])&&!fenceStart(lines[i])&&lines[i].trim()!=='<details>')paragraph.push(lines[i++]);
  result.push(<p key={key}>{inline(paragraph.join('\n'))}</p>);
 }
 return result;
}
export default React.memo(function ReportDocument({markdown}){
 const text=String(markdown??'');
 const content=React.useMemo(()=>blocks(text.split(/\r?\n/)),[text]);
 return <article className="cr-report cr-report-document" aria-label="报告正文">{content}</article>;
});
