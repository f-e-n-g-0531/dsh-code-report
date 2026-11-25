import {markdownText} from './markdown-text.mjs';

export const moduleLayout = '<!-- code-report:modules-v1 -->';
const groupStart = '<!-- code-report:group ';

// Presentation aliases are exact, project-independent names for one subsystem.
// Do not infer ownership from a shared prefix (e.g. 资源打包 is a different concern).
const moduleParents = new Map([
  ['资源配置', '资源管理'],
  ['资源预加载', '资源管理'],
  ['资源加载', '资源管理'],
]);

// Module names describe presentation only. Repository ownership comes from evidence.
export function takeModule(text) {
  const prefix = /^(?:内部接口：|对外性待确认：|待确认：|公共SDK身份待确认：(?:声明\/发布契约无法绑定同一符号或声明证据不全在公共候选边界；)?)?(?:【(?:更新提醒|交付风险|换包前核对|换包后回归|等引擎确认)】[ \t]*)?/u.exec(text)[0];
  const match = /^【模块[：:]([^】\r\n\u0085\u2028\u2029]{1,40})】[ \t]*(\S[\s\S]*)$/u.exec(text.slice(prefix.length));
  if (!match) return {text, name:null};
  const name = match[1].trim().replace(/\s+/gu, ' ');
  const valid = /^[\p{L}\p{N}][\p{L}\p{N} _·、&-]*$/u.test(name);
  return {text:prefix+match[2], name:valid ? name : null};
}

export function evidenceGroup(ids, repositories, name = null) {
  const repos = new Set(ids.map(id => repositories.get(id)));
  const known = [...repos].filter(repo => typeof repo === 'string' && repo.trim());
  if (known.length > 1) return ['cross', '', name];
  if (known.length === 1 && repos.size === 1) return ['repo', known[0], name];
  return ['unassigned', '', null];
}

export function moduleMarker([kind, repo, name]) {
  return groupStart+JSON.stringify([kind, markdownText(repo), name ? markdownText(name) : null])+' -->';
}

export function readModuleMarker(line) {
  if (!line.startsWith(groupStart) || !line.endsWith(' -->')) return null;
  let key;
  try { key = JSON.parse(line.slice(groupStart.length, -4)); } catch { return null; }
  const safeLabel = value => typeof value === 'string' && !/[<>\r\n\u0085\u2028\u2029]/u.test(value);
  if (!Array.isArray(key) || key.length !== 3 || !['repo','cross','unassigned'].includes(key[0]) || !safeLabel(key[1]) || (key[2] !== null && !safeLabel(key[2]))) return null;
  return [key[0], key[1], moduleParents.get(key[2]) ?? key[2]];
}
