import {createHash} from 'node:crypto';
import {parseRepository,evidenceHash,snapshotHash} from './evidence.mjs';

export const SINGLE_REQUEST_VERSION = 1;
const bytes = text => Buffer.byteLength(text,'utf8');
const compare = (a,b) => a < b ? -1 : a > b ? 1 : 0;
const generated = name => /(?:\.(?:map|pdb|obj|o|a|lib|dll|exe|so|dylib|class|jar|zip|gz|wasm)|\.min\.(?:js|css))$/i.test(name);
// Deterministic path heuristics, not semantic importance or a complete dependency analysis.
const priority = name => /(?:^|[/\\])(?:api|include|public|interface|interfaces|protocol)(?:[/\\]|$)|\.(?:h|hh|hpp|hxx|idl|proto)$/i.test(name) ? 0 : /\.(?:c|cc|cpp|cxx|m|mm|cs|java|kt|go|rs|py|js|jsx|ts|tsx|vue|swift|rb|php|sh|ps1|sql)$/i.test(name) ? 1 : /(?:^|[/\\])(?:CMakeLists\.txt|Makefile|package\.json)|\.(?:cmake|json|ya?ml|toml|ini|cfg|xml)$/i.test(name) ? 2 : 3;
const failure = message => Object.assign(new Error(message),{code:'code-report/analysis-plan'});
const digest = values => evidenceHash(JSON.stringify(values));

function prefix(text, limit) {
  let end=Math.min(limit,text.length);
  if(end>0 && end<text.length && /[\uD800-\uDBFF]/.test(text[end-1]) && /[\uDC00-\uDFFF]/.test(text[end]))end--;
  return text.slice(0,end);
}

/** Full local manifest, bounded model excerpts. This is a digest, never full-source coverage. */
export function buildSingleRequestEvidence(snapshot,{inputBudget,estimate}={}) {
  if(!snapshot || !Array.isArray(snapshot.repositories) || !Array.isArray(snapshot.context))throw failure('无效摘要快照');
  if(!Number.isInteger(inputBudget)||inputBudget<4000||inputBudget>64000||typeof estimate!=='function')throw failure('单次摘要需要 4000–64000 字节预算与请求估算器');
  const manifest=[],excluded=[],repositories=[],contexts=[],lanes=[];
  let originalSourceBytes=0,unassignedSourceBytes=0;
  snapshot.repositories.forEach((repository,index)=>{
    if(typeof repository.diff!=='string')throw failure('差异正文必须是文本');
    const {blocks,manifest:files}=parseRepository(repository),assigned=new Map();
    for(const block of blocks){
      if(block.file===null){unassignedSourceBytes+=bytes(block.text);continue;}
      if(!assigned.has(block.file))assigned.set(block.file,[]);
      assigned.get(block.file).push(block);
    }
    const repositoryBytes=bytes(repository.diff); originalSourceBytes+=repositoryBytes;
    const records=files.map(file=>{
      const parts=assigned.get(file.path)??[],hasher=createHash('sha256');let sourceBytes=0;
      for(const part of parts){hasher.update(part.text);sourceBytes+=bytes(part.text);}
      const record={...file,repositoryIndex:index,source:'repository:'+index,sourceBytes,sourceHash:hasher.digest('hex'),generated:generated(file.path),ranges:parts.map(part=>({start:part.start,end:part.end})),sentMetadata:false,sentText:false,sentSourceBytes:0};
      manifest.push(record);return {record,parts};
    }).sort((a,b)=>Number(a.record.generated)-Number(b.record.generated)||priority(a.record.path)-priority(b.record.path)||compare(a.record.path,b.record.path));
    const summary={repository:repository.path,repositoryIndex:index,repositoryType:repository.type,a:repository.a,b:repository.b,requestedA:repository.requestedA??null,requestedB:repository.requestedB??null,branchA:repository.branchA??null,branchB:repository.branchB??null,gitSource:repository.gitSource??null,remote:repository.remote??null,observedAt:repository.observedAt??null,identity:repository.type==='svn'?{uuid:repository.identity?.uuid??null}:null,sourceBytes:repositoryBytes,sourceHash:evidenceHash(repository.diff),rawHash:repository.rawDiffHash??null,fileCount:records.length,generatedFileCount:records.filter(entry=>entry.record.generated).length,manifestHash:digest(records.map(({record})=>record)),unassignedSourceBytes:blocks.filter(block=>block.file===null).reduce((n,block)=>n+bytes(block.text),0)};
    repositories.push(summary);
    for(const path of repository.excludedPaths??[])excluded.push({repository:repository.path,repositoryIndex:index,path,reason:'internal-path'});
    lanes.push(records.map(({record,parts})=>({record,parts,repository,index})));
  });
  snapshot.context.forEach((context,index)=>{
    if(typeof context.text!=='string')throw failure('上下文正文必须是文本');
    const sourceBytes=bytes(context.text);originalSourceBytes+=sourceBytes;
    const record={repository:context.repository??null,path:context.path,source:'context:'+index,contextIndex:index,revision:context.revision??null,provenance:context.provenance??'current-workspace',sourceBytes,sourceHash:evidenceHash(context.text),rawHash:context.rawHash??context.hash??null,generated:generated(context.path),sentMetadata:false,sentText:false,sentSourceBytes:0};
    contexts.push(record);
  });
  const fingerprint=snapshotHash(snapshot);
  const items=[];
  const item=(metadata,text,start=0)=>{
    const result={...metadata,start,end:start+text.length,text};
    result.id='e-'+digest([SINGLE_REQUEST_VERSION,fingerprint,result]).slice(0,32);return result;
  };
  const synthetic=(source,metadata,value)=>item({...metadata,source,provenance:'version-summary',kind:'scope',file:metadata.file??null,hunk:null},JSON.stringify(value));
  const measured=candidates=>{
    const value=estimate(candidates);
    if(!Number.isFinite(value)||value<0)throw failure('无效请求大小估算');return value;
  };
  for(const summary of repositories){
    items.push(synthetic('single-scope:'+summary.repositoryIndex,{repository:summary.repository,repositoryIndex:summary.repositoryIndex,a:summary.a,b:summary.b},{...summary,sentFileCount:summary.fileCount,omittedFileCount:summary.fileCount,sentTextFileCount:summary.fileCount,note:'仅本地完整统计；模型只收到摘要与明确选择的片段，生成物正文不发送，未发送路径及内容不可推断无变化。'}));
  }
  if(contexts.length)items.push(synthetic('single-context-scope',{repository:null},{contextFiles:contexts.length,sentFileCount:contexts.length,omittedFileCount:contexts.length,sentTextFileCount:contexts.length,sourceBytes:contexts.reduce((n,c)=>n+c.sourceBytes,0),manifestHash:digest(contexts),note:'全部上下文仅本地统计；正文和文件元数据也受同一预算，未选择内容未发送模型。'}));
  if(!items.length)items.push(synthetic('single-empty',{repository:null},{note:'没有提供差异或上下文；无法形成代码结论。'}));
  if(measured(items)>inputBudget)throw failure('单次摘要的项目统计元数据超过预算；请提高输入预算或缩小项目范围，未静默遗漏项目');
  if(contexts.length)lanes.push(contexts.map((record,index)=>({record,context:snapshot.context[index]})));
  const offsets=lanes.map(()=>0), laneSpent=lanes.map(()=>0);
  const laneBudget=Math.floor((inputBudget-measured(items))/Math.max(1,lanes.length));
  function tryAdd(candidate,ceiling){if(measured([...items,candidate])>ceiling)return false;items.push(candidate);return true;}
  function addSample(entry,ceiling){
    const {record}=entry;if(record.generated||record.binary)return;
    let text,start,metadata;
    if(entry.context){text=entry.context.text;start=0;metadata={source:record.source,repository:record.repository,file:record.path,revision:record.revision,provenance:record.provenance,hash:record.rawHash,sourceHash:record.sourceHash,kind:'context',hunk:null};}
    else {
      const part=entry.parts.find(part=>!part.binary);if(!part)return;
      const match=/^(?:@@|##)[^\r\n]*(?:\r?\n|$)/m.exec(part.text);
      start=part.start+(match?.index??0);text=part.text.slice(match?.index??0);
      metadata={source:record.source,repository:record.repository,repositoryIndex:record.repositoryIndex,repositoryType:entry.repository.type,a:entry.repository.a,b:entry.repository.b,file:record.path,provenance:'version-diff',blockHash:record.sourceHash,sourceHash:repositories[record.repositoryIndex].sourceHash,kind:match?'hunk':'file',hunk:match?match[0].trimEnd().slice(0,256):null};
    }
    if(!text)return;
    let low=0,high=Math.min(1024,text.length),best=null;
    while(low<=high){const middle=Math.floor((low+high)/2),selected=prefix(text,middle),candidate=item({...metadata,sampled:selected.length!==text.length||!entry.context},selected,start);
      if(selected && measured([...items,candidate])<=ceiling){best=candidate;low=middle+1;}else if(!selected){low=middle+1;}else high=middle-1;
    }
    if(best){items.push(best);record.sentText=true;record.sentSourceBytes=bytes(best.text);}
  }
  // Round-robin by repository, with one separate context lane. No repository can consume all optional slots first.
  let remaining=true;
  while(remaining){remaining=false;
    for(let lane=0;lane<lanes.length;lane++){
      const entry=lanes[lane][offsets[lane]++];if(!entry)continue;remaining=true;
      const record=entry.record;
      const metadata={repository:record.repository,repositoryIndex:record.repositoryIndex,file:record.path,a:record.a,b:record.b};
      const information={path:record.path,status:record.status??'context',source:record.source,sourceBytes:record.sourceBytes,sourceHash:record.sourceHash,rawHash:record.rawHash??null,generated:record.generated,revision:record.revision??null,provenance:record.provenance??'version-diff',note:record.generated?'生成物仅元数据；正文未发送':'仅文件元数据；可选片段不代表完整文件或完整调用图'};
      const before=measured(items),ceiling=Math.min(inputBudget,before+laneBudget-laneSpent[lane]);
      if(tryAdd(synthetic('single-file:'+digest([record.source,record.path]).slice(0,16),metadata,information),ceiling)){record.sentMetadata=true;addSample(entry,ceiling);laneSpent[lane]+=measured(items)-before;}
    }
  }
  // Reserve counters at their maximum digit length above, then publish exact sent/omitted facts.
  // Counts describe selected content, never whether a model understood a file.
  for(let index=0;index<repositories.length;index++){
    const files=manifest.filter(record=>record.repositoryIndex===index),scope=items[index],value=JSON.parse(scope.text);
    value.sentFileCount=files.filter(record=>record.sentMetadata).length;
    value.omittedFileCount=files.filter(record=>!record.sentMetadata).length;
    value.sentTextFileCount=files.filter(record=>record.sentText).length;
    items[index]=synthetic(scope.source,{repository:scope.repository,repositoryIndex:index,a:scope.a,b:scope.b},value);
  }
  if(contexts.length){
    const index=repositories.length,scope=items[index],value=JSON.parse(scope.text);
    value.sentFileCount=contexts.filter(record=>record.sentMetadata).length;
    value.omittedFileCount=contexts.filter(record=>!record.sentMetadata).length;
    value.sentTextFileCount=contexts.filter(record=>record.sentText).length;
    items[index]=synthetic(scope.source,{repository:null},value);
  }
  if(measured(items)>inputBudget)throw failure('最终摘要统计超出预算，未发送不完整请求');
  const all=[...manifest,...contexts],sent=all.filter(record=>record.sentMetadata);
  const perRepository=repositories.map(summary=>{const files=manifest.filter(record=>record.repositoryIndex===summary.repositoryIndex);return {...summary,sentFileCount:files.filter(record=>record.sentMetadata).length,omittedFileCount:files.filter(record=>!record.sentMetadata).length,sentTextFileCount:files.filter(record=>record.sentText).length};});
  return {items,manifest,excluded,snapshotHash:fingerprint,inputBytes:measured(items),coverage:{strategy:'single-request',digestVersion:SINGLE_REQUEST_VERSION,originalSourceBytes,decodedSourceBytes:originalSourceBytes,sourceBytesBasis:'decoded-utf8',fullManifestFiles:manifest.length,sentFileCount:manifest.filter(record=>record.sentMetadata).length,omittedFileCount:manifest.filter(record=>!record.sentMetadata).length,generatedFileCount:manifest.filter(record=>record.generated).length,sentMetadataFileCount:sent.length,sentTextFileCount:manifest.filter(record=>record.sentText).length,sentContextTextFileCount:contexts.filter(record=>record.sentText).length,omittedMetadataFileCount:all.length-sent.length,sentSourceBytes:all.reduce((n,record)=>n+record.sentSourceBytes,0),unassignedSourceBytes,contextManifest:contexts,contextFiles:contexts.length,sentContextFileCount:contexts.filter(record=>record.sentMetadata).length,omittedContextFileCount:contexts.filter(record=>!record.sentMetadata).length,perRepository,note:'本地完整统计不等于模型全文覆盖；按路径启发式优先接口/头文件、代码与配置，并非语义重要性分析；哈希与引用不能证明结论正确。'}};
}
