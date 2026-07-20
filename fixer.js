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
        .replace(/[`~\[\]{}#>*|_="'\/\\]/g, '') // 标记/标点字符
        .replace(/\s/g, '');              // 空白
    return fp;
}

/**
 * 检测正文区结构格式问题。返回 { hasIssues, issues[] }。
 */
export function detectIssues(text, thinkTags = BOUNDARY_TAGS, knownTags = [], plotTag = 'now_plot') {
    const issues = [];
    if (!text) return { hasIssues: false, issues };

    const plotName = escapeRegExp(plotTag || 'now_plot');
    const plotRe = new RegExp(`<${plotName}>([\\s\\S]*?)</${plotName}>`, 'i');
    // 1. 正文容器缺失或为空
    const plotMatch = text.match(plotRe);
    if (!plotMatch) {
        issues.push(`${plotTag} 缺失`);
    } else if (!plotMatch[1].trim()) {
        issues.push(`${plotTag} 为空`);
    }

    // 2. 正文在容器外：容器为空时，检查 </think> 后是否有大段正文
    if (plotMatch && !plotMatch[1].trim()) {
        const afterThink = text.replace(/[\s\S]*?<\/think>/i, '');
        // 剥离变量块/生图/各种结构 tag 后，剩余纯叙事文字长度
        const narrative = stripNonNarrative(afterThink, thinkTags)
            .replace(/<[^>]*>/g, '')
            .replace(/\s/g, '');
        if (narrative.length > 50) issues.push(`正文在 ${plotTag} 外`);
    }

    // 3. 代码块未配对
    const codeFences = (text.match(/```/g) || []).length;
    if (codeFences % 2 !== 0) issues.push('代码块未配对');

    // 4. 变量块 JSON 语法错
    const jsonPatchRe = /<json_patch>([\s\S]*?)<\/json_patch>/gi;
    let jm;
    let jsonBad = false;
    while ((jm = jsonPatchRe.exec(text)) !== null) {
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

    // 5. 未知 tag（思考区 + 正文区残留非白名单 tag）
    const unknown = findUnknownTags(text, thinkTags, knownTags, SAFE_HTML_TAGS);
    if (unknown.length > 0) issues.push(`未知 tag: ${unknown.join(', ')}`);

    return { hasIssues: issues.length > 0, issues };
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
