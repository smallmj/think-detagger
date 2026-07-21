// fixer.js - LLM 格式修复的纯逻辑：指纹、问题检测、格式要求拼接、prompt 构建。
// 不依赖 SillyTavern，便于 node 单元测试。

import { findThinkRegions, findUnknownTags, SAFE_HTML_TAGS, BOUNDARY_TAGS } from './core.js';

// 变量块标签（指纹计算时剥离，允许 LLM 修内部语法）
const VARIABLE_BLOCK_TAGS = ['UpdateVariable', 'update', 'json_patch', 'update_analysis'];
// 生图 tag（指纹计算时剥离）
const IMAGE_TAGS = ['image', 'pic'];

function escapeRegExp(s) {
    return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * 剥离变量块与生图 tag，保留思考内容（已 detag）、正文叙事、Optional 模组文本。
 * 思考区不剥离：这样指纹包含思考文字，若 LLM 违规改动思考会被指纹校验拒绝。
 */
export function stripNonNarrative(text, thinkTags = BOUNDARY_TAGS) {
    if (!text) return '';
    let out = text;
    for (const tag of [...VARIABLE_BLOCK_TAGS, ...IMAGE_TAGS]) {
        const name = escapeRegExp(tag);
        // 配对块 <tag ...> ... </tag>
        const rePair = new RegExp(`<${name}\\b[^>]*>[\\s\\S]*?</${name}>`, 'gi');
        out = out.replace(rePair, '');
        // 自闭合 <tag .../>
        const reSelf = new RegExp(`<${name}\\b[^>]*/>`, 'gi');
        out = out.replace(reSelf, '');
    }
    return out;
}

/**
 * 内容指纹：stripNonNarrative 后移除所有 tag、代码块/标记字符、空白，剩余纯文字序列。
 * 修复前后必须严格相等 -> LLM 只改格式标记/位置/变量块内部，正文叙事与思考文字不变。
 */
export function contentFingerprint(text, thinkTags = BOUNDARY_TAGS) {
    const stripped = stripNonNarrative(text, thinkTags);
    const fp = stripped
        .replace(/```/g, '')
        .replace(/<[^>]*>/g, '')          // 所有 tag
        .replace(/[`~\[\]{}#>*|_\/\\]/g, '') // 标记字符（保留引号 ="'，检测 LLM 偷换引号类型）
        .replace(/\s/g, '');              // 空白
    return fp;
}

/**
 * 检测正文区结构格式问题。返回 { hasIssues, issues[] }。
 */
export function detectIssues(text, thinkTags = BOUNDARY_TAGS, knownTags = [], plotTag = 'now_plot') {
    const issues = [];
    if (!text) return { hasIssues: false, issues };

    // 剥离 think 区内容（保留 </think> 锚点），避免 think 内问题（未知 tag/落单代码围栏/json_patch 语法错）
    // 触发不可修的 LLM 询问（LLM 被禁止改 think，指纹也保护 think）
    const thinkRegions = findThinkRegions(text, thinkTags);
    let t = text;
    for (let i = thinkRegions.length - 1; i >= 0; i--) {
        const r = thinkRegions[i];
        t = t.slice(0, r.contentStart) + t.slice(r.contentEnd);
    }

    const plotName = escapeRegExp(plotTag || 'now_plot');
    const plotRe = new RegExp(`<${plotName}>([\\s\\S]*?)</${plotName}>`, 'i');
    // 1. 正文容器缺失或为空
    const plotMatch = t.match(plotRe);
    if (!plotMatch) {
        issues.push(`${plotTag} 缺失`);
    } else if (!plotMatch[1].trim()) {
        issues.push(`${plotTag} 为空`);
    }

    // 2. 正文在容器外：容器为空时，检查 </think> 后是否有大段正文
    if (plotMatch && !plotMatch[1].trim()) {
        const afterThink = t.replace(/[\s\S]*?<\/think>/i, '');
        const narrative = stripNonNarrative(afterThink, thinkTags)
            .replace(/<[^>]*>/g, '')
            .replace(/\s/g, '');
        if (narrative.length > 50) issues.push(`正文在 ${plotTag} 外`);
    }

    // 3. 代码块未配对（仅正文区，think 已剥离）
    const codeFences = (t.match(/```/g) || []).length;
    if (codeFences % 2 !== 0) issues.push('代码块未配对');

    // 4. 变量块 JSON 语法错（仅正文区）
    const jsonPatchRe = /<json_patch\b[^>]*>([\s\S]*?)<\/json_patch>/gi;
    let jm;
    let jsonBad = false;
    while ((jm = jsonPatchRe.exec(t)) !== null) {
        const inner = jm[1].trim();
        if (!inner) continue;
        try {
            JSON.parse(inner);
        } catch {
            jsonBad = true;
            break;
        }
    }
    if (jsonBad) issues.push('json_patch 语法错误');

    // 5. 未知 tag（think 已剥离，此处针对正文区残留；think 未知 tag 由 detag 白名单流程处理）
    const unknown = findUnknownTags(t, thinkTags, knownTags, SAFE_HTML_TAGS);
    if (unknown.length > 0) issues.push(`未知 tag: ${unknown.join(', ')}`);

    // 6. plotTag 内 tag 开闭不平衡（嵌套跨越边界）
    for (const ni of checkPlotNesting(t, plotTag)) issues.push(ni);

    return { hasIssues: issues.length > 0, issues };
}

// 检测 plotTag 范围内各 tag 开闭是否平衡（不平衡 = 有 tag 跨越 plotTag 边界）
function checkPlotNesting(text, plotTag) {
    const ranges = getPlotTagRanges(text, plotTag);
    const issues = [];
    for (const range of ranges) {
        const inner = text.slice(range.start, range.end);
        // 自闭合 tag 位置（不计入开闭）
        const selfClose = [];
        const scRe = /<[A-Za-z\u4e00-\u9fa5][\w:-]*\b[^>]*\/>/g;
        let sc;
        while ((sc = scRe.exec(inner)) !== null) selfClose.push([sc.index, sc.index + sc[0].length]);
        const isSelf = (idx) => selfClose.some(([s, e]) => idx >= s && idx < e);
        const openC = {}, closeC = {};
        const tagRe = /<(\/?)([A-Za-z\u4e00-\u9fa5][\w:-]*)\b[^>]*>/g;
        let m;
        while ((m = tagRe.exec(inner)) !== null) {
            if (isSelf(m.index)) continue;
            const name = m[2].toLowerCase();
            if (m[1] === '/') closeC[name] = (closeC[name] || 0) + 1;
            else openC[name] = (openC[name] || 0) + 1;
        }
        for (const name of new Set([...Object.keys(openC), ...Object.keys(closeC)])) {
            if ((openC[name] || 0) !== (closeC[name] || 0)) {
                issues.push(`<${name}> 在 ${plotTag} 内开闭不平衡(开${openC[name] || 0}/闭${closeC[name] || 0})，可能跨越边界`);
            }
        }
    }
    return issues;
}

/**
 * 按来源开关拼接格式要求文本。
 * wiContents / promptContents / manualText 由调用方按用户勾选从世界书/预设/手动区提取后传入。
 */
export function extractFormatRequirements({
    wiContents = [],
    promptContents = [],
    manualText = '',
    useWorldInfo = false,
    usePreset = false,
    useManual = false,
    maxLen = 6000,
} = {}) {
    const parts = [];
    if (useWorldInfo && wiContents.length) {
        parts.push('【世界书格式要求】\n' + wiContents.filter(Boolean).join('\n\n'));
    }
    if (usePreset && promptContents.length) {
        parts.push('【预设格式要求】\n' + promptContents.filter(Boolean).join('\n\n'));
    }
    if (useManual && manualText.trim()) {
        parts.push('【手动格式要求】\n' + manualText.trim());
    }
    let out = parts.join('\n\n');
    if (out.length > maxLen) out = out.slice(0, maxLen) + '\n...(已截断)';
    return out;
}

/**
 * 构造修复 LLM 的 system/user/jsonSchema。
 */
export function buildFixPrompt({ originalText, formatRequirements, thinkTags = BOUNDARY_TAGS, plotTag = 'now_plot' }) {
    const thinkNames = thinkTags.join(' / ');
    const plot = plotTag || 'now_plot';
    const system = `你是一个格式修复器。给定角色扮演 AI 的原始输出和格式要求，你只修复格式问题，绝不改正文叙事文字的内容和措辞。

修复规则：
1. 把写在 <${plot}> 外的正文叙事移入 <${plot}>...</${plot}> 内；Optional 模组（如 DiceCombat/Initiative/DiceCheck/EnemyOverview/SummonOverview/ExperienceLog/LootLog/QuestContract/CombatSnapshot 等）插入正文合适位置，不堆在末尾。
2. 保留所有变量更新块（<UpdateVariable>/<update>/<json_patch>/<update_analysis>）不删除；可修改变量块内部的 JSON 语法错误（括号/引号/op 名/字段完整性），但不改变量的 path 和 value 的语义值。
3. 保留 <image>...</image> 与 <pic>...</pic> 生图 tag 原样不动。
4. 不修改思考内容（</think> 之前的部分；思考边界标签 ${thinkNames} 保留）。
5. 只修格式（结构位置、tag 闭合、tag 名、JSON 语法），不润色不改写正文叙事文字。
6. 若无需修改，changed 设为 false。

${formatRequirements ? '格式要求：\n' + formatRequirements : '（未提供格式要求，仅按通用规则修复）'}

严格只输出 JSON：{"fixed_text": string, "changed": boolean, "reason": string}`;

    const jsonSchema = {
        type: 'object',
        properties: {
            fixed_text: { type: 'string' },
            changed: { type: 'boolean' },
            reason: { type: 'string' },
        },
        required: ['fixed_text', 'changed'],
    };
    return { system, user: originalText, jsonSchema };
}

/**
 * 行级 diff（LCS）。返回 [{type:'eq'|'del'|'add', text}]。
 * type: eq=未变, del=原文有修复后无, add=修复后有原文无。
 * 行数过多时退化为全删全加，避免 O(m*n) 爆炸。
 */
export function lineDiff(original, fixed) {
    const a = original ? original.split('\n') : [];
    const b = fixed ? fixed.split('\n') : [];
    const m = a.length, n = b.length;
    if (m * n > 1000000) {
        const lines = [];
        for (const l of a) lines.push({ type: 'del', text: l });
        for (const l of b) lines.push({ type: 'add', text: l });
        return lines;
    }
    const dp = Array.from({ length: m + 1 }, () => new Array(n + 1).fill(0));
    for (let i = m - 1; i >= 0; i--) {
        for (let j = n - 1; j >= 0; j--) {
            dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
        }
    }
    const lines = [];
    let i = 0, j = 0;
    while (i < m && j < n) {
        if (a[i] === b[j]) { lines.push({ type: 'eq', text: a[i] }); i++; j++; }
        else if (dp[i + 1][j] >= dp[i][j + 1]) { lines.push({ type: 'del', text: a[i] }); i++; }
        else { lines.push({ type: 'add', text: b[j] }); j++; }
    }
    while (i < m) { lines.push({ type: 'del', text: a[i] }); i++; }
    while (j < n) { lines.push({ type: 'add', text: b[j] }); j++; }
    return lines;
}

// ---------- 纯规则结构修复（零成本，LLM 之前先尝试）----------
// 尾部锚点标签：用来切分"正文"与"尾部数据块"。命中其中任一开标签即视为正文结束。
const TAIL_ANCHOR_TAGS = [
    'summary', 'update', 'UpdateVariable', 'update_analysis',
    'TimePeriod', 'StatusPlaceHolderImpl', 'action', 'action_option',
    'ExperienceLog', 'LootLog', 'QuestContract', 'CombatSnapshot',
];

// 找出所有完整的 <plotTag>...</plotTag> 配对区间（栈处理嵌套）
function getPlotTagRanges(text, plotTag) {
    const name = escapeRegExp(plotTag);
    const tagRe = new RegExp(`<\\s*\\/?\\s*${name}\\b[^>]*>`, 'gi');
    const stack = [];
    const ranges = [];
    let match;
    while ((match = tagRe.exec(text)) !== null) {
        const isClose = /^<\s*\//i.test(match[0]);
        if (!isClose) { stack.push(match.index); continue; }
        const openIndex = stack.pop();
        if (Number.isInteger(openIndex)) {
            ranges.push({ start: openIndex, end: match.index + match[0].length });
        }
    }
    return ranges;
}

// 把 plotTag 对内的成对 ``` 代码块移到最后一个 </plotTag> 之后；落单围栏删除。
// 目的：AI 误用代码块包正文会破坏美化，移出 plotTag 既保留内容又不破坏渲染。
function evictPlotCodeFences(text, plotTag) {
    const ranges = getPlotTagRanges(text, plotTag);
    if (ranges.length === 0) return text;
    const CODE_BLOCK_RE = /`{3,}[^\n]*\n?[\s\S]*?`{3,}/g;
    const LONE_FENCE_RE = /`{3,}[ \t]*[A-Za-z0-9_+#.\-]*/g;
    const evicted = [];
    const removalSpans = [];
    for (const range of ranges) {
        const inner = text.slice(range.start, range.end);
        CODE_BLOCK_RE.lastIndex = 0;
        let m;
        while ((m = CODE_BLOCK_RE.exec(inner)) !== null) {
            const absStart = range.start + m.index;
            evicted.push(m[0].replace(/^\s+|\s+$/g, ''));
            removalSpans.push({ start: absStart, end: absStart + m[0].length });
        }
    }
    let result = text;
    if (removalSpans.length) {
        removalSpans.sort((a, b) => b.start - a.start);
        for (const s of removalSpans) {
            result = result.slice(0, s.start) + result.slice(s.end);
        }
    }
    // 落单围栏（成对块已移除后扫残留）：直接删除，不追加（仍落单无意义）
    const loneSpans = [];
    for (const range of getPlotTagRanges(result, plotTag)) {
        const inner = result.slice(range.start, range.end);
        LONE_FENCE_RE.lastIndex = 0;
        let m;
        while ((m = LONE_FENCE_RE.exec(inner)) !== null) {
            loneSpans.push({ start: range.start + m.index, end: range.start + m.index + m[0].length });
        }
    }
    if (loneSpans.length) {
        loneSpans.sort((a, b) => b.start - a.start);
        for (const s of loneSpans) {
            result = result.slice(0, s.start) + result.slice(s.end);
        }
    }
    if (evicted.length === 0) return result;
    const closeRe = new RegExp(`<\\s*\\/\\s*${escapeRegExp(plotTag)}\\s*>`, 'gi');
    let lastCloseEnd = -1;
    let cm;
    while ((cm = closeRe.exec(result)) !== null) {
        lastCloseEnd = cm.index + cm[0].length;
    }
    if (lastCloseEnd < 0) return result;
    return result.slice(0, lastCloseEnd) + '\n\n' + evicted.join('\n\n') + result.slice(lastCloseEnd);
}

// 当 plotTag 完全缺失时，把 </think> 后到第一个尾部锚点前的正文包进 plotTag。
// 已有 plotTag 对 / 无思考闭标签 / 无锚点 -> 不处理（交给 LLM），避免误伤。
function rewrapPlot(text, plotTag, thinkTags) {
    const name = escapeRegExp(plotTag);
    const hasOpen = new RegExp(`<\\s*${name}\\b[^>]*>`, 'i').test(text);
    if (hasOpen) return text; // 已有开标签（含未闭合）不重包裹，避免双重包裹
    const thinkNames = thinkTags.map(escapeRegExp).join('|');
    const thinkCloseRe = new RegExp(`<\\/\\s*(?:${thinkNames})\\s*>`, 'i');
    const thinkMatch = text.match(thinkCloseRe);
    if (!thinkMatch) return text;
    const thinkEnd = thinkMatch.index + thinkMatch[0].length;
    const prefix = text.slice(0, thinkEnd);
    const tail = text.slice(thinkEnd);
    const anchorNames = TAIL_ANCHOR_TAGS.map(escapeRegExp).join('|');
    const anchorRe = new RegExp(`<\\s*(?:${anchorNames})\\b`, 'i');
    const anchorMatch = tail.match(anchorRe);
    if (!anchorMatch) return text; // 无锚点不重包裹，避免把变量块误包
    const anchorIdx = tail.indexOf(anchorMatch[0]);
    const middle = tail.slice(0, anchorIdx).replace(/^\s+|\s+$/g, '');
    const suffix = tail.slice(anchorIdx);
    if (!middle) return text;
    return `${prefix}\n\n<${plotTag}>\n${middle}\n</${plotTag}>\n\n${suffix.replace(/^\s+/, '')}`;
}

// 把"开在 plotTag 内、闭在 plotTag 外"的跨越 tag 移到 plotTag 外：
// 将 </plotTag> 移到该 tag 开标签前，让 tag 完全在 plotTag 外。
// 适用于 details/summary/choice 等尾部块被误开在正文容器内的情况。
function fixCrossingTags(text, plotTag) {
    const plotClose = `</${plotTag}>`;
    let result = text;
    for (let iter = 0; iter < 8; iter++) {
        const ranges = getPlotTagRanges(result, plotTag);
        if (ranges.length === 0) break;
        let fixed = false;
        for (const range of ranges) {
            const inner = result.slice(range.start, range.end);
            // 统计 plotTag 内各 tag 开/闭数量（自闭合不计），参考 checkPlotNesting
            const selfClose = [];
            const scRe = /<[A-Za-z\u4e00-\u9fa5][\w:-]*\b[^>]*\/>/g;
            let sc;
            while ((sc = scRe.exec(inner)) !== null) selfClose.push([sc.index, sc.index + sc[0].length]);
            const isSelf = (idx) => selfClose.some(([s, e]) => idx >= s && idx < e);
            const openC = {}, closeC = {};
            const balanceRe = /<(\/?)([A-Za-z\u4e00-\u9fa5][\w:-]*)\b[^>]*>/g;
            let bm;
            while ((bm = balanceRe.exec(inner)) !== null) {
                if (isSelf(bm.index)) continue;
                const n = bm[2].toLowerCase();
                if (bm[1] === '/') closeC[n] = (closeC[n] || 0) + 1;
                else openC[n] = (openC[n] || 0) + 1;
            }
            // 找第一个开多闭少（openC > closeC）且 plotTag 外有闭标签的 tag 开标签
            const openRe = /<([A-Za-z\u4e00-\u9fa5][\w:-]*)\b[^>]*>/g;
            let m;
            while ((m = openRe.exec(inner)) !== null) {
                if (m[0].endsWith('/>')) continue;
                const tagName = m[1];
                if (tagName.toLowerCase() === plotTag.toLowerCase()) continue;
                const lname = tagName.toLowerCase();
                if ((openC[lname] || 0) <= (closeC[lname] || 0)) continue; // 内部平衡，不跨越
                const openAbs = range.start + m.index;
                // 检查 plotTag 外（之后）是否还有该 tag 的闭标签
                const outsideAfter = result.slice(range.end);
                const closeRe = new RegExp(`</\\s*${escapeRegExp(tagName)}\\s*>`, 'i');
                if (!closeRe.test(outsideAfter)) continue;
                // 跨越：找 </plotTag>（在 openAbs 后、range.end 前）
                const plotCloseStart = (() => {
                    const pcRe = new RegExp(`<\\s*/\\s*${escapeRegExp(plotTag)}\\s*>`, 'gi');
                    let pcm, last = -1;
                    while ((pcm = pcRe.exec(result)) !== null) {
                        if (pcm.index >= range.end) break;
                        if (pcm.index > openAbs) last = pcm.index;
                    }
                    return last;
                })();
                if (plotCloseStart < 0 || plotCloseStart <= openAbs) break;
                const plotCloseEnd = plotCloseStart + result.slice(plotCloseStart).match(new RegExp(`<\\s*/\\s*${escapeRegExp(plotTag)}\\s*>`, 'i'))[0].length;
                // 删除 </plotTag>（在 openAbs 后，不影响 openAbs）
                let r = result.slice(0, plotCloseStart) + result.slice(plotCloseEnd);
                // 在开标签前插入 </plotTag>
                r = r.slice(0, openAbs) + plotClose + '\n' + r.slice(openAbs);
                result = r;
                fixed = true;
                break;
            }
            if (fixed) break;
        }
        if (!fixed) break;
    }
    return result;
}

/**
 * 纯规则结构修复（零成本）：代码块迁移 + plotTag 重包裹 + 跨越 tag 修正。
 * 返回 { text, changed, reason }。LLM 修复前先调它，修得了就不必调 LLM。
 */
export function ruleFixStructure(text, plotTag = 'now_plot', thinkTags = BOUNDARY_TAGS) {
    if (!text) return { text: text || '', changed: false, reason: '' };
    let out = text;
    const reasons = [];
    const a = evictPlotCodeFences(out, plotTag);
    if (a !== out) { out = a; reasons.push('代码块迁移'); }
    const b = rewrapPlot(out, plotTag, thinkTags);
    if (b !== out) { out = b; reasons.push('正文重包裹'); }
    const c = fixCrossingTags(out, plotTag);
    if (c !== out) { out = c; reasons.push('跨越tag修正'); }
    return { text: out, changed: reasons.length > 0, reason: reasons.join('+') };
}
