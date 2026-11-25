import {markdownText, markdownFence} from './markdown-text.mjs';
import {evidenceGroup, moduleLayout, moduleMarker, takeModule} from './report-modules.mjs';

const sections = [
  ['changes', '改动内容'],
  ['interfaces', '对外接口变更'],
  ['impacts', '影响范围'],
  ['qa', 'QA 测试范围'],
  ['unknowns', '未知和待确认'],
];

const value = input => markdownText(input ?? '未知');

export const qaGroups = [
  ['QA', 'QA 可执行测试'],
  ['研发专项', '研发专项验证'],
  ['待补充', '测试前待补充'],
  [null, '未分类测试建议（需人工确认执行角色与入口）'],
];

export function qaGroup(text) {
  return /^(?:【事项：[^】\r\n]{2,60}】[ \t]*)?(QA|研发专项|待补充)｜/.exec(text)?.[1] ?? null;
}

// Only split at explicit labels, retaining every character (including punctuation
// and whitespace) in its original order. Never infer or rewrite a test contract.
export function qaParts(text) {
  const boundaries = [...text.matchAll(/测试功能[：:]|正常使用[：:]|重点观察[：:]|前置条件[：:]|操作步骤[：:]|步骤[：:]|预期(?:现象|结果)?[：:]|通过标准[：:]|回归边界[：:]|待补充[：:]/g)].map(match => match.index);
  if (!boundaries.length) return [text];
  return [text.slice(0, boundaries[0]), ...boundaries.map((start, index) => text.slice(start, boundaries[index + 1] ?? text.length))];
}

// Shared by both renderers; each caller retains its own citation and layout rules.
export function reportItemGroups(section, items) {
  return section === 'qa'
    ? qaGroups.map(([key, heading]) => [heading, items.filter(item => qaGroup(item.text) === key)])
    : [[null, items]];
}

export function reportItemParts(section, item) {
  if (section === 'qa') return qaParts(item.text);
  if (section === 'interfaces' && item.audience === 'sdk-candidate') {
    return ['SDK 候选接口（发布身份待确认）：' + item.symbol + ' — ' + item.text];
  }
  return [item.text];
}

// A render-only projection of validated results. The checkpoint, evidence
// ledger and original attribution are not rewritten.
export function projectReportItems(batches) {
  const sectionsByKey = Object.fromEntries(sections.map(([key]) => [key, []]));
  const topics = new Map();
  const exactItems = new Map();
  const add = (section, item, repo) => {
    // Interface metadata (including the declaring type) is not represented by
    // the short symbol alone. Untied or cross-project prose is not a match.
    if (!repo || section !== 'changes') { sectionsByKey[section].push(item);return; }
    const key = JSON.stringify([section, item.group, item.text]);
    const previous = exactItems.get(key);
    if (previous) { for (const id of item.evidenceIds) previous.ids.add(id);return; }
    const copy = {...item};
    exactItems.set(key, {copy, ids: new Set(item.evidenceIds)});
    sectionsByKey[section].push(copy);
  };
  for (const {analysis, evidence} of batches) {
    const repositories = new Map(evidence.map(item => [item.id, item.repository]));
    for (const [section] of sections) for (const raw of analysis[section]) {
      const {text, name} = takeModule(raw.text);
      const item = {...raw, text, group:evidenceGroup(raw.evidenceIds, repositories, name)};
      // Explicit, specific topic names only; a file, evidence ID or symbol
      // alone cannot identify a shared business change.
      const reminder = section === 'impacts' && item.text.startsWith('【更新提醒】');
      const tagText = reminder ? item.text.slice('【更新提醒】'.length).trimStart() : item.text;
      const match = (section === 'changes' || reminder) && /^【事项：([^】\r\n]{2,60})】[ \t]*(\S[\s\S]*)$/u.exec(tagText);
      const repo = repositories.get(item.evidenceIds[0]);
      const topic = match?.[1]?.trim();
      const scoped = repo && item.evidenceIds.every(id => repositories.get(id) === repo);
      if (!topic || topic.length < 2 || !scoped) {
        add(section, item, scoped ? repo : null);continue;
      }
      const key = JSON.stringify([item.group, topic]);
      if (!topics.has(key)) topics.set(key, {repo, topic, group:item.group, entries: []});
      topics.get(key).entries.push({section, reminder, item: {...item, text: match[2]}});
    }
  }
  const movedSections = new Set();
  for (const {repo, topic, group, entries} of topics.values()) {
    // Keep test prerequisites and general unknowns in their own sections.
    // Client checks and interface candidates must remain easy to find in
    // their own sections. Only implementation records share a detail topic.
    const reminders = entries.filter(({reminder}) => reminder);
    const reminderRows = new Map();
    for (const {item} of reminders) {
      const ids = reminderRows.get(item.text) ?? new Set();
      for (const id of item.evidenceIds) ids.add(id);
      reminderRows.set(item.text, ids);
    }
    if (reminderRows.size) {
      sectionsByKey.impacts.push({text: topic + '｜' + repo, reminder: true, group, evidenceIds: [],
        details: [...reminderRows].map(([text,evidenceIds]) => ({section:'impacts',text,evidenceIds}))});
    }
    const duplicateChange = ({section,item}) => {
      const ids = reminderRows.get(item.text);
      return section === 'changes' && ids && item.evidenceIds.every(id => ids.has(id));
    };
    const duplicates = entries.filter(duplicateChange);
    if (duplicates.length) movedSections.add('duplicateChanges');
    const adjacent = entries.filter(entry => entry.section === 'changes' && !duplicateChange(entry));
    const canGroup = adjacent.some(({section}) => section === 'changes') && adjacent.length > 1;
    const moved = new Set([...reminders,...duplicates]);
    if (canGroup) {
      const seen = new Map(), details = [];
      for (const entry of adjacent) {
        moved.add(entry);
        const {section, item} = entry;
        movedSections.add(section);
        const key = JSON.stringify([section, item.text]);
        const duplicate = seen.get(key);
        if (duplicate) { for (const id of item.evidenceIds) duplicate.evidenceIds.add(id);continue; }
        const text = '改动：' + item.text.replace(/^改动[：:] */u, '');
        const detail = {section, text, evidenceIds: new Set(item.evidenceIds)};
        details.push(detail);seen.set(key, detail);
      }
      sectionsByKey.changes.push({text: topic + '｜' + repo, group, evidenceIds: [], details});
    }
    for (const entry of entries) if (!moved.has(entry)) sectionsByKey[entry.section].push(entry.item);
  }
  for (const {copy, ids} of exactItems.values()) copy.evidenceIds = [...ids];
  return {items: sectionsByKey, movedSections};
}

export function renderTopic(item, citations) {
  const lines = ['- ' + (item.reminder ? '【更新提醒】' : '') + '**' + markdownText(item.text) + '**'];
  for (const detail of item.details) {
    const parts = detail.section === 'qa' ? qaParts(detail.text) : [detail.text];
    const links = citations([...detail.evidenceIds]);
    lines.push('  - ' + markdownText(parts[0]) + (links ? ' ' + links : ''));
    for (const part of parts.slice(1)) lines.push('    - ' + markdownText(part));
  }
  return lines;
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
  const {items: projected, movedSections} = projectReportItems([{analysis, evidence: batch.snapshot.evidence}]);
  const coverage = plan.coverage;
  const lines = ['本报告为单次摘要：仅基于预算内的合成摘要与选取原文片段，不是全文语义分析；结论与测试建议仍待人工复核。'];
  lines.push(moduleLayout);
  for (const [section, title] of sections) {
    lines.push('', '## ' + title, '');
    for (const [heading, items] of reportItemGroups(section, projected[section])) {
      if (!items.length) continue;
      if (heading) lines.push('### ' + heading, '');
      for (const item of items) {
        lines.push(moduleMarker(item.group));
        if (item.details) {lines.push(...renderTopic(item, citations));continue;}
        const links = citations(item.evidenceIds);
        const suffix = links ? ' ' + links : '';
        const parts = reportItemParts(section, item);
        if (parts.length === 1) lines.push('- ' + markdownText(parts[0]) + suffix);
        else {
          lines.push('- ' + (parts[0] ? markdownText(parts[0]) : '测试建议') + suffix);
          for (const part of parts.slice(1)) lines.push('  - ' + markdownText(part));
        }
      }
      if (heading) lines.push('');
    }
    if (!projected[section].length) {
      lines.push(section === 'changes' && movedSections.has('duplicateChanges') ? '与更新提醒相同的改动已在开头说明，不再重复。'
        : section === 'qa' && movedSections.has('qa')
        ? '相关验证建议已随“改动内容”逐项列出，尚未执行。'
        : section === 'interfaces' && movedSections.has('interfaces')
        ? '相关接口与迁移说明已随“改动内容”逐项列出；候选接口不代表已确认对外发布。'
        : section === 'interfaces'
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
  // Do not expose the local file or attached context inventories.
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
