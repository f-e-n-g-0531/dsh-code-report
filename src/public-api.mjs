// Operator-declared candidate boundaries only: not proof of historical publication,
// compatibility promises, or an external contract. Consumers need separate evidence.
// Keep this module browser-compatible for configuration parsing in the client.
const SENSITIVE = /(^|[/\\])(?:\.env(?:\..*)?|\.git|\.svn|node_modules|id_rsa|id_ed25519|credentials?)([/\\]|$)|\.(pem|key|p12|pfx)$/i;
const invalid = () => new Error('公开 API 边界必须指定已选项目及安全的仓库相对文件或目录（目录以 / 结尾，不支持 glob）');
function normalizedPath(value, {repository = false} = {}) {
 if (typeof value !== 'string' || !value.trim() || value.length > 4096 || /[\x00-\x1f\x7f-\x9f:*?\[\]{}|<>]/.test(value)) throw invalid();
 const name = value.trim().replace(/\\/g, '/');
 if (name.startsWith('/') || SENSITIVE.test(name.replace(/\/$/, ''))) throw invalid();
 if (repository && name === '.') return name;
 const parts = name.replace(/\/$/, '').split('/');
 if (parts.some(part => !part || part === '.' || part === '..')) throw invalid();
 return repository ? parts.join('/') : name;
}
/** Validate explicit declarations without filesystem probing (historical files may be deleted). */
export function normalizePublicApiPaths(entries, repositories) {
 if (!Array.isArray(entries) || !Array.isArray(repositories)) throw invalid();
 const selected = new Set(repositories.filter(row => row && row.enabled !== false).map(row => normalizedPath(row.path, {repository:true})));
 const seen = new Set(), paths = [];
 for (const entry of entries) {
  if (!entry || typeof entry !== 'object' || Array.isArray(entry)) throw invalid();
  const repository = normalizedPath(entry.repository, {repository:true});
  const path = normalizedPath(entry.path);
  if (!selected.has(repository)) throw invalid();
  const key = JSON.stringify([repository, path]);
  if (!seen.has(key)) { seen.add(key); paths.push({repository, path}); }
 }
 return paths;
}
/** UI format: one project|repository-relative-file-or-directory/ declaration per line. */
export function parsePublicApiPaths(text, repositories) {
 if (typeof text !== 'string') throw invalid();
 const entries = [];
 for (const line of text.split(/\r?\n/)) {
  if (!line.trim()) continue;
  const parts = line.split('|');
  if (parts.length !== 2) throw invalid();
  entries.push({repository:parts[0], path:parts[1]});
 }
 return normalizePublicApiPaths(entries, repositories);
}
/** True means only inside an operator-declared candidate boundary, never published API proof. */
export function isPublicApiEvidence(item, paths) {
 if (!item || !Array.isArray(paths)) return false;
 try {
  const repository = normalizedPath(item.repository, {repository:true});
  const file = normalizedPath(item.file ?? item.path);
  if (file.endsWith('/')) return false;
  return paths.some(entry => {
   if (!entry || normalizedPath(entry.repository, {repository:true}) !== repository) return false;
   const boundary = normalizedPath(entry.path);
   return boundary.endsWith('/') ? file.startsWith(boundary) : file === boundary;
  });
 } catch { return false; }
}
