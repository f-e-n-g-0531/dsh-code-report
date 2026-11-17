// Offline model fixtures explicitly dispose evidence not cited by their conclusions.
export function withDispositions(analysis, evidence) {
  const cited = new Set(['changes', 'interfaces', 'impacts', 'qa', 'unknowns'].flatMap(section => (analysis[section] ?? []).flatMap(item => item.evidenceIds)));
  return {...analysis, evidenceDispositions: evidence.filter(item => !cited.has(item.id)).map(item => ({evidenceId: item.id, status: 'no-conclusion', reasonCode: 'insufficient-context', reason: '离线夹具未模拟此证据的语义结论，需人工复核。'}))};
}
