// core.js - 纯逻辑，不依赖 SillyTavern，便于 node 单元测试。
// 负责：危险 tag 白名单、思考区段定位、去尖括号、残留未知 tag 扫描。

export const MODULE_NAME = 'think-detagger';

// 边界标签：用于切分思考区段，本身不去 <>（保留折叠结构）。
export const BOUNDARY_TAGS = ['think', 'thinking'];

// 默认危险 tag 白名单（不含 think/thinking，因它们是边界标签需保留）。
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

// 常见合法 HTML 标签，扫描"未知危险 tag"时排除，避免把 <b>/<i> 等误报给用户。
export const SAFE_HTML_TAGS = [
    'b', 'i', 'em', 'strong', 'u', 's', 'del', 'ins', 'mark', 'small', 'sub', 'sup',
    'br', 'hr', 'p', 'div', 'span', 'a', 'img', 'code', 'pre', 'blockquote', 'q', 'cite',
    'ul', 'ol', 'li', 'dl', 'dt', 'dd', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6',
    'table', 'thead', 'tbody', 'tfoot', 'tr', 'td', 'th', 'caption', 'col', 'colgroup',
    'details', 'summary', 'figure', 'figcaption', 'abbr', 'time', 'kbd', 'samp', 'var',
    'font', 'center', 'ruby', 'rt', 'rp', 'wbr', 'bdi', 'bdo', 'data', 'address',
    'article', 'section', 'aside', 'header', 'footer', 'nav', 'main',
    'picture', 'source', 'video', 'audio', 'iframe', 'object', 'embed', 'canvas', 'svg', 'math',
    'custom-style',
];

export function getDefaultSettings() {
    return {
        enabled: true,
        thinkTags: [...BOUNDARY_TAGS],
        tags: [...DEFAULT_TAGS],
        processReasoning: true,
        showFloatingBall: true,
        autoDelay: 2,
        // LLM 格式修复模块（v0.4.0）
        llmFixEnabled: false,
        autoFix: true,
        fixTimeout: 60,
        fixConnection: {
            apiUrl: '',
            apiKey: '',
            model: '',
            maxTokens: 2048,
            temperature: 0.2,
        },
        formatSource: {
            useWorldInfo: false,
            usePreset: false,
            useManual: false,
            selectedWiUids: [],
            selectedPromptIds: [],
            manualText: '',
        },
    };
}

function escapeRegExp(s) {
    return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * 去尖括号：对每个白名单 tag，匹配 <tag...> / </tag...> / <tag.../>，
 * 替换为"去掉首尾 < > 后的中间内容"（保留中间所有字符，包括 / 与属性文字）。
 * 返回 { text, removedTags }，removedTags 记录实际被处理的 tag 名集合。
 * 幂等：对已处理文本再跑无副作用。
 */
export function detag(text, tags) {
    const removed = new Set();
    if (!text || !tags || tags.length === 0) return { text: text || '', removedTags: removed };
    let out = text;
    for (const tag of tags) {
        if (!tag) continue;
        const name = escapeRegExp(tag);
        const re = new RegExp(`<(/?)${name}(?=[\\s>/])[^>]*>`, 'gi');
        out = out.replace(re, (full) => {
            removed.add(tag);
            return full.slice(1, -1);
        });
    }
    return { text: out, removedTags: removed };
}

/**
 * 以闭标签为锚定位思考内容区间。返回位置数组（不复制内容）。
 * 形态：标准配对 / 仅收尾；无闭标签返回空。
 */
export function findThinkRegions(text, thinkTags = BOUNDARY_TAGS) {
    const regions = [];
    if (!text || !thinkTags || thinkTags.length === 0) return regions;
    const names = thinkTags.map(escapeRegExp).join('|');
    const closeRe = new RegExp(`</(${names})>`, 'gi');
    const openRe = new RegExp(`<(${names})>`, 'gi');
    let searchFrom = 0;
    let cm;
    while ((cm = closeRe.exec(text)) !== null) {
        const closeStart = cm.index;
        const closeEnd = closeStart + cm[0].length;
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
        if (contentEnd > contentStart) {
            regions.push({ contentStart, contentEnd, openStart, openEnd, closeStart, closeEnd });
        }
        searchFrom = closeEnd;
    }
    return regions;
}

/**
 * 处理 mes：定位思考区段，从后往前 detag。
 * 返回 { mes, changed, removedTags }。边界标签原样保留。
 */
export function detagMes(mes, tags, thinkTags = BOUNDARY_TAGS) {
    const regions = findThinkRegions(mes, thinkTags);
    if (regions.length === 0) return { mes, changed: false, removedTags: new Set() };
    let out = mes;
    let changed = false;
    const removed = new Set();
    for (let i = regions.length - 1; i >= 0; i--) {
        const r = regions[i];
        const content = out.slice(r.contentStart, r.contentEnd);
        const res = detag(content, tags);
        if (res.text !== content) {
            out = out.slice(0, r.contentStart) + res.text + out.slice(r.contentEnd);
            changed = true;
            for (const t of res.removedTags) removed.add(t);
        }
    }
    return { mes: out, changed, removedTags: removed };
}

/**
 * 处理 extra.reasoning：整段视为思考内容，直接 detag。
 * 返回 { reasoning, changed, removedTags }。
 */
export function detagReasoning(reasoning, tags) {
    if (!reasoning) return { reasoning, changed: false, removedTags: new Set() };
    const res = detag(reasoning, tags);
    return { reasoning: res.text, changed: res.text !== reasoning, removedTags: res.removedTags };
}

/**
 * 扫描思考区段内残留的 <xxx> tag，返回"未在危险名单、非边界标签、非安全 HTML"的 tag 列表。
 * 用于手动处理后提示用户是否补充白名单。应在 detagMes 处理后的文本上调用
 * （白名单 tag 已去 <>，不会被匹配；残留的 <xxx> 都是非白名单的）。
 */
export function findUnknownTags(text, thinkTags = BOUNDARY_TAGS, knownTags = [], safeHtmlTags = SAFE_HTML_TAGS) {
    const regions = findThinkRegions(text, thinkTags);
    const found = new Set();
    const exclude = new Set();
    for (const t of (thinkTags || [])) exclude.add(String(t).toLowerCase());
    for (const t of (knownTags || [])) exclude.add(String(t).toLowerCase());
    for (const t of (safeHtmlTags || [])) exclude.add(String(t).toLowerCase());
    // 匹配 <tagname 或 </tagname，首字符为字母/中文，避免匹配注释 <!-- / PI <?
    const tagRe = /<\/?([A-Za-z\u00C0-\uFFFF][^\s>\/]*)/g;
    for (const r of regions) {
        const content = text.slice(r.contentStart, r.contentEnd);
        tagRe.lastIndex = 0;
        let m;
        while ((m = tagRe.exec(content)) !== null) {
            const name = m[1].toLowerCase();
            if (!exclude.has(name)) found.add(m[1]);
        }
    }
    return [...found];
}
