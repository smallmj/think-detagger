// core.js — 纯逻辑，不依赖 SillyTavern，便于 node 单元测试。
// 负责：危险 tag 白名单、思考区段定位、去尖括号、文本处理。

export const MODULE_NAME = 'think-detagger';

// 边界标签：用于切分思考区段，本身不去 <>（保留折叠结构）。
export const BOUNDARY_TAGS = ['think', 'thinking'];

// 默认危险 tag 白名单（不含 think/thinking，因它们是边界标签需保留）。
// 覆盖 MVU 格式壳、剧情变量、常见预设结构块、中文非 ASCII tag。
export const DEFAULT_TAGS = [
    // 剧情变量
    'now_plot', 'plot', 'prev_plot', 'next_plot',
    // MVU 格式壳
    'UpdateVariable', 'Analysis', 'StatusPlaceHolderImpl', 'CharView',
    // 预设结构块
    'action', 'summary', 'DiceCombat', 'disclaimer', 'pic', 'thought', 'reasoning',
    // 中文 / 非 ASCII（特别容易破坏 DOM）
    '状态', '剧情', '行动', '思考', '变量',
];

export function getDefaultSettings() {
    return {
        enabled: true,
        tags: [...DEFAULT_TAGS],
        processReasoning: true,
    };
}

/**
 * 转义正则特殊字符，用于把字面 tag 名安全嵌入正则。
 */
function escapeRegExp(s) {
    return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * 去尖括号：对每个白名单 tag，匹配 <tag...> / </tag...> / <tag.../>，
 * 替换为"去掉首尾 < > 后的中间内容"（保留中间所有字符，包括 / 与属性文字）。
 *
 * 用 (?=[\s>/]) 作为 tag 名结束边界，既支持 ASCII 也支持中文 tag
 * （\b 对中文边界不可靠），且避免 plot 误匹配 plotX。
 *
 * 幂等：对已处理文本再跑无副作用。
 */
export function detag(text, tags) {
    if (!text || tags.length === 0) return text;
    let out = text;
    for (const tag of tags) {
        if (!tag) continue;
        const name = escapeRegExp(tag);
        const re = new RegExp(`<(/?)${name}(?=[\\s>/])[^>]*>`, 'gi');
        out = out.replace(re, (full) => full.slice(1, -1));
    }
    return out;
}

/**
 * 以闭标签 </think> / </thinking> 为锚，定位思考内容区间。
 * 返回区间数组（仅位置，不复制内容），便于从后往前原地替换。
 *
 * 形态：
 *  - 标准配对（有开标签）：content = 开标签之后到闭标签之前
 *  - 仅收尾（无开标签）：content = 上一闭标签之后（或开头）到本闭标签之前
 *  - 无闭标签：返回空数组（无法判断边界，不处理）
 *
 * 每个 region：
 *  { contentStart, contentEnd, openStart, openEnd, closeStart, closeEnd }
 *  开/闭标签原文不在 content 区间内（openEnd..closeStart 才是 content）。
 *  openStart/openEnd 为 -1 表示无开标签（仅收尾）。
 */
export function findThinkRegions(text) {
    const regions = [];
    if (!text) return regions;
    const closeRe = /<\/(think|thinking)>/gi;
    const openRe = /<(think|thinking)>/gi;
    let searchFrom = 0;
    let cm;
    while ((cm = closeRe.exec(text)) !== null) {
        const closeStart = cm.index;
        const closeEnd = closeStart + cm[0].length;
        // 在 [searchFrom, closeStart) 内找最后一个开标签
        const sub = text.slice(searchFrom, closeStart);
        let openStart = -1;
        let openEnd = -1;
        openRe.lastIndex = 0;
        let om;
        let last = null;
        while ((om = openRe.exec(sub)) !== null) {
            last = om;
        }
        if (last) {
            openStart = searchFrom + last.index;
            openEnd = openStart + last[0].length;
        }
        const contentStart = openEnd >= 0 ? openEnd : searchFrom;
        const contentEnd = closeStart;
        // 仅当区间非空才记录（空区间无可处理内容）
        if (contentEnd > contentStart) {
            regions.push({ contentStart, contentEnd, openStart, openEnd, closeStart, closeEnd });
        }
        searchFrom = closeEnd;
    }
    return regions;
}

/**
 * 处理 mes：定位思考区段，从后往前对每段 content 应用 detag。
 * 返回 { mes, changed }。边界标签 <think></think> 原样保留。
 */
export function detagMes(mes, tags) {
    const regions = findThinkRegions(mes);
    if (regions.length === 0) return { mes, changed: false };
    let out = mes;
    let changed = false;
    for (let i = regions.length - 1; i >= 0; i--) {
        const r = regions[i];
        const content = out.slice(r.contentStart, r.contentEnd);
        const detagged = detag(content, tags);
        if (detagged !== content) {
            out = out.slice(0, r.contentStart) + detagged + out.slice(r.contentEnd);
            changed = true;
        }
    }
    return { mes: out, changed };
}

/**
 * 处理 extra.reasoning：整段视为思考内容，直接 detag。
 * 返回 { reasoning, changed }。
 */
export function detagReasoning(reasoning, tags) {
    if (!reasoning) return { reasoning, changed: false };
    const out = detag(reasoning, tags);
    return { reasoning: out, changed: out !== reasoning };
}
