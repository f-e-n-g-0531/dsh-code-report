const MAX_RULES = 24;
export const MAX_DIFF_EXCLUSIONS_TEXT = 4096;

export function normalizeDiffExclusions(rules = [], repositories) {
  if (!Array.isArray(rules) || rules.length > MAX_RULES) throw new Error('差异排除规则最多 24 条');
  const projects = new Set(repositories.map(row => row.path || '.'));
  const seen = new Set();
  return rules.map(rule => {
    if (!rule || !projects.has(rule.repository) || typeof rule.directory !== 'string') throw new Error('差异排除规则必须指定已选仓库及目录');
    const {repository, directory} = rule;
    if (directory.length > 240 || !directory.endsWith('/') || /[\x00-\x1f\x7f:\\*?\[\]|]/.test(directory) ||
        directory.slice(0, -1).split('/').some(part => !part || part === '.' || part === '..' || part !== part.trim())) {
      throw new Error('差异排除目录必须是仓库相对目录，以 / 结尾，不支持通配符');
    }
    const key = JSON.stringify([repository, directory]);
    if (seen.has(key)) throw new Error('差异排除规则重复');
    seen.add(key);
    return {repository, directory};
  });
}

export function parseDiffExclusions(text, repositories) {
  if (typeof text !== 'string' || text.length > MAX_DIFF_EXCLUSIONS_TEXT) throw new Error('差异排除规则文本无效或过长');
  return normalizeDiffExclusions(text.split(/\r?\n/).map(line => line.trim()).filter(Boolean).map(line => {
    const parts = line.split('|');
    if (parts.length !== 2) throw new Error('差异排除规则每行须填写：仓库路径|目录/');
    return {repository: parts[0].trim(), directory: parts[1].trim()};
  }), repositories);
}

export const matchingDiffDirectory = (directories, path, kind) => directories.find(directory => path.startsWith(directory) || (kind === 'dir' && path === directory.slice(0, -1)));
// Keep shader source, scripts, generic config and unknown formats. Resource graphs and
// material/particle assets can affect runtime behavior, but are excluded by default.
const ASSET_SUFFIXES = Object.freeze([
  'png','jpg','jpeg','gif','webp','bmp','ico','tga','dds','ktx','ktx2','psd','tif','tiff','exr','hdr',
  'wav','mp3','ogg','flac','aac','m4a','mp4','mov','webm','avi',
  'fbx','gltf','glb','dae','c3','c3_model','ska','sea','mtl','material','particle',
  'zip','7z','rar','gz','tgz','tar','dll','exe','lib','obj','pdb','map','so','dylib','a','o','class','jar','wasm',
]);
export const DEFAULT_DIFF_SUFFIX_TEXT = ASSET_SUFFIXES.map(ext=>'.'+ext).join(', ');
export const MAX_DIFF_SUFFIX_TEXT = 4096;
export function parseDiffSuffixes(text = DEFAULT_DIFF_SUFFIX_TEXT) {
  if(typeof text!=='string'||text.length>MAX_DIFF_SUFFIX_TEXT)throw new Error('差异排除后缀必须是最多 4096 字符的文本');
  const suffixes = new Set();
  for(const token of text.split(/[\s,，;；]+/).filter(Boolean)){
    if(!/^\.?[a-zA-Z0-9][a-zA-Z0-9_]{0,23}$/.test(token))throw new Error('差异排除后缀仅支持字母、数字及下划线，例如 .c3_model；不支持路径或通配符');
    suffixes.add(token.replace(/^\./,'').toLowerCase());
  }
  if(suffixes.size>128)throw new Error('差异排除后缀最多 128 项');
  return suffixes;
}
export function nonCodeAsset(suffixes, path, kind) {
  if (kind === 'dir') return false;
  const basename = path.slice(path.lastIndexOf('/') + 1);
  const dot = basename.lastIndexOf('.');
  const suffix = basename.slice(dot + 1);
  return dot >= 0 && /^[A-Za-z0-9][A-Za-z0-9_]*$/.test(suffix) && suffixes.has(suffix.toLowerCase()) ? '.'+suffix.toLowerCase() : false;
}
export const DEFAULT_DIFF_FOLDER_TEXT = 'Test';
export const MAX_DIFF_FOLDER_TEXT = 2048;
export function parseDiffFolderNames(text = DEFAULT_DIFF_FOLDER_TEXT) {
  if (typeof text !== 'string' || text.length > MAX_DIFF_FOLDER_TEXT) throw new Error('差异排除文件夹名无效或过长');
  const names = new Set(text.split(/[,，;；\r\n]+/).map(name=>name.trim()).filter(Boolean));
  if (names.size > 32 || [...names].some(name=> !/^[\p{L}\p{N}_. -]{1,64}$/u.test(name) || name === '.' || name === '..')) {
    throw new Error('差异排除文件夹名最多 32 项，只填名称，不支持路径或通配符');
  }
  return names;
}
export function matchingDiffFolderName(names, path, kind) {
  const parts = path.split('/');
  if (kind !== 'dir') parts.pop();
  return parts.find(part=>names.has(part));
}
export const gitFolderNameExclusions = names => [...names].map(name=>':(top,exclude,glob)**/'+name+'/**');
export const gitNonCodeExclusions = suffixes => [...suffixes].map(ext => ':(top,exclude,icase,glob)**/*.' + ext);
const CHANGE_LABELS = {A:'新增', D:'删除', M:'修改', T:'类型变更', added:'新增', deleted:'删除', modified:'修改', none:'属性变更'};
export const diffExclusionLabel = record => (Object.hasOwn(CHANGE_LABELS, record.item) ? CHANGE_LABELS[record.item] : record.item) + (record.reason === 'non-code-asset' ? '；按后缀排除 '+record.suffix : record.reason === 'folder-name' ? '；按文件夹名排除 '+record.folderName : '；按配置排除目录 ' + record.directory);
