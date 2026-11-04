import {markdownText, markdownFence} from './markdown-text.mjs';

const sections = [
  ['changes', '改动内容'],
  ['interfaces', '对外接口变更'],
  ['impacts', '影响范围'],
  ['qa', 'QA 测试范围'],
  ['unknowns', '未知和待确认'],
];

const value = input => markdownText(input ?? '未知');

// Only split at explicit labels, retaining every character (including punctuation
// and whitespace) in its original order. Never infer or rewrite a test contract.
function qaParts(text) {
  const boundaries = [...text.matchAll(/前置条件[：:]|步骤[：:]|预期(?:结果)?[：:]|回归边界[：:]/g)].map(match => match.index);
  if (boundaries.length < 2) return [text];
  return [text.slice(0, boundaries[0]), ...boundaries.map((start, index) => text.slice(start, boundaries[index + 1] ?? text.length))];
}

function evidenceKind(item) {
  if (item.provenance === 'version-summary' || item.kind === 'scope') return '合成范围摘要（独立来源，不是原始差异或上下文）';
  if (item.provenance === 'version-diff') return '原始差异片段';
  return '原始上下文片段（不能据此补造历史契约）';
}

/** Reader-facing presentation only; called after single-request result validation. */
export function renderReadableAnalysis(plan, completed) {
  if (plan.strategy !== 'single-request' || plan.batches.length !== 1) {
    throw new TypeError('可读摘要仅适用于单次请求计划');
  }
  const batch = plan.batches[0];
  const analysis = completed.get(batch.id)?.analysis;
  if (!analysis) throw new TypeError('单次请求尚未完成，不能生成可读摘要');
  const evidence = new Map(batch.snapshot.evidence.map(item => [item.id, item]));
  const numbers = new Map();
  const cited = new Set();
  const numberFor = id => {
    if (!evidence.has(id)) throw new TypeError('可读摘要引用了未提供的证据');
    if (!numbers.has(id)) numbers.set(id, numbers.size + 1);
    return numbers.get(id);
  };
  const citations = ids => ids.map(id => {
    cited.add(id);
    const number = numberFor(id);
    return '[' + number + '](#evidence-' + number + ')';
  }).join(' ');
  const coverage = plan.coverage;
  let scope = '本报告为单次摘要：模型仅收到预算内的合成摘要与选取原文片段，不是全文语义分析。本地清单含 ' + value(coverage.fullManifestFiles) + ' 个变更文件；模型收到文件专用证据 ' + value(coverage.sentFileCount) + ' 个，其中含原文片段 ' + value(coverage.sentTextFileCount) + ' 个；' + value(coverage.omittedFileCount) + ' 个未收到文件专用证据。';
  if (coverage.contextFiles) scope += ' 另有上下文文件 ' + value(coverage.contextFiles) + ' 个，原文片段覆盖 ' + value(coverage.sentContextTextFileCount) + ' 个，未发送文件专用证据 ' + value(coverage.omittedContextFileCount) + ' 个。';
  scope += ' 引用只对应已提供证据，不证明结论正确；结论与测试建议仍待人工复核。';
  const lines = [scope];
  for (const [section, title] of sections) {
    lines.push('', '## ' + title, '');
    for (const item of analysis[section]) {
      const links = citations(item.evidenceIds);
      const suffix = links ? ' ' + links : '';
      const parts = section === 'qa' ? qaParts(item.text) : [item.text];
      if (parts.length === 1) lines.push('- ' + markdownText(item.text) + suffix);
      else {
        lines.push('- ' + (parts[0] ? markdownText(parts[0]) : '测试建议') + suffix);
        for (const part of parts.slice(1)) lines.push('  - ' + markdownText(part));
      }
    }
    if (!analysis[section].length) {
      lines.push(section === 'interfaces'
        ? '当前提供证据中未列出对外接口变化，不保证完整覆盖；需人工核对。'
        : '模型未列出本节条目，不表示已证明不存在相关影响或未知项。');
    }
  }

  // Assign uncited evidence after first-use citations, so every sent item has one
  // stable numeric target, while no source-derived value becomes an HTML attribute.
  for (const id of evidence.keys()) numberFor(id);
  const unreferencedIds = [...evidence.keys()].filter(id => !cited.has(id));
  lines.push('', '<details>', '<summary>技术附录：证据与覆盖记录</summary>', '',
    '### 覆盖记录', '',
    '已处理证据 ' + value(batch.evidenceIds.length) + ' / ' + value(coverage.total) + '；被结论引用 ' + value(cited.size) + '；未引用 ' + value(unreferencedIds.length) + '。',
    '已处理仅指结果返回并通过结构与引用校验，不代表每条证据有结论或已被正确理解。', '');
  for (const [key, field] of Object.entries({planId: plan.id, snapshotHash: plan.snapshotHash, batchId: batch.id, payloadHash: batch.payloadHash, inputBudget: plan.inputBudget, estimatedInputBytes: batch.inputBytes})) {
    if (field !== undefined) lines.push('- ' + markdownText(key) + '：' + value(field));
  }
  const {files, contextManifest, ...coverageRecord} = coverage;
  lines.push('', markdownFence(JSON.stringify({...coverageRecord, processed: batch.evidenceIds.length, analyzed: batch.evidenceIds.length, remaining: coverage.total - batch.evidenceIds.length, cited: cited.size, unreferencedIds, completedBatches: 1, totalBatches: 1, failedBatches: 0, pendingBatchIds: []}, null, 2), 'json'));
  lines.push('', '### 实际发送的证据', '', '每条证据的定位、哈希及发送文本在此保留一次；合成摘要与原文片段分别标注。');
  for (const [id, number] of numbers) {
    const item = evidence.get(id);
    lines.push('', '<a id="evidence-' + number + '"></a>', '',
      '#### [' + number + '] ' + evidenceKind(item), '',
      'UTF-16 字符偏移（非源码行号/字节）：' + value(item.start) + '–' + value(item.end) + '。',
      cited.has(id) ? '引用状态：已引用。' : '引用状态：未被结论引用，需人工核对。', '');
    // Preserve every locator/hash field, including future source metadata, without
    // exposing the full local manifest or repeating the selected text.
    for (const [key, field] of Object.entries(item)) {
      if (key !== 'text') lines.push('- ' + markdownText(key) + '：' + value(typeof field === 'object' && field !== null ? JSON.stringify(field) : field));
    }
    lines.push('', markdownFence(item.text, 'text'));
  }
  lines.push('', '</details>');
  return lines.join('\n') + '\n';
}
