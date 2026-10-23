import {readdir,readFile} from 'node:fs/promises';
import path from 'node:path';
import {transform} from 'esbuild';

// Parse source without bundling, emitting files, running modules, or changing formatting.
async function filesIn(directory){
 const names=[];
 for(const entry of await readdir(directory,{withFileTypes:true})){
  const name=path.join(directory,entry.name);
  if(entry.isDirectory())names.push(...await filesIn(name));
  else if(entry.isFile()&&/\.(?:mjs|jsx|json)$/.test(name))names.push(name);
 }
 return names;
}
const roots=(await readdir('.',{withFileTypes:true})).filter(entry=>entry.isFile()&&/\.(?:mjs|json)$/.test(entry.name)).map(entry=>entry.name);
const files=[...roots,...await filesIn('src'),...await filesIn('scripts'),...await filesIn('test')].sort();
for(const file of files){
 const source=await readFile(file,'utf8');
 if(file.endsWith('.json'))JSON.parse(source);
 else await transform(source,{loader:file.endsWith('.jsx')?'jsx':'js',sourcefile:file,target:'es2022',logLevel:'silent'});
}
console.log('Static syntax / JSON checks passed:',files.length,'files (not typechecking or lint coverage)');
