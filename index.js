// 格式助手 (format-assistant) - SillyTavern 扩展入口
// detag（思考区 tag 防 <>）+ LLM 格式修复（正文区结构/变量块内部语法）两级接力。
//
// 触发（只处理最近一条 AI 回复）：
//  - 自动：MVU VARIABLE_UPDATE_ENDED + MESSAGE_RECEIVED/GENERATION_ENDED（防抖延迟 autoDelay）
//  - 手动：悬浮球/按钮//detag（仅 detag）、/fix-format（detag + LLM 修复）
// LLM 修复：独立连接，整文重写 + 指纹校验（只比对正文叙事文字，剥离变量块/生图）。

import {
    detagMes,
    detagReasoning,
    findUnknownTags,
    SAFE_HTML_TAGS,
    getDefaultSettings,
    DEFAULT_TAGS,
    BOUNDARY_TAGS,
    MODULE_NAME,
} from './core.js';
import {
    contentFingerprint,
    detectIssues,
    extractFormatRequirements,
    buildFixPrompt,
    lineDiff,
    ruleFixStructure,
} from './fixer.js';

const SETTING_ID = 'think_detagger';
const TAG = `[${MODULE_NAME}]`;

// ---------- 通用 ----------
function getCtx() {
    return SillyTavern.getContext();
}

function getSettings() {
    const ctx = getCtx();
    if (!ctx.extensionSettings[SETTING_ID]) {
        ctx.extensionSettings[SETTING_ID] = getDefaultSettings();
    } else {
        const def = getDefaultSettings();
        const store = ctx.extensionSettings[SETTING_ID];
        for (const k of Object.keys(def)) {
            if (store[k] === undefined) store[k] = def[k];
        }
        // 深补全 fixConnection / formatSource
        if (def.fixConnection && typeof store.fixConnection === 'object') {
            for (const k of Object.keys(def.fixConnection)) {
                if (store.fixConnection[k] === undefined) store.fixConnection[k] = def.fixConnection[k];
            }
        }
        if (def.formatSource && typeof store.formatSource === 'object') {
            for (const k of Object.keys(def.formatSource)) {
                if (store.formatSource[k] === undefined) store.formatSource[k] = def.formatSource[k];
            }
        }
    }
    return ctx.extensionSettings[SETTING_ID];
}

function saveSettings() {
    const ctx = getCtx();
    if (ctx.saveSettingsDebounced) ctx.saveSettingsDebounced();
}

function toast(msg, type = 'success') {
    if (typeof toastr !== 'undefined' && toastr[type]) toastr[type](msg);
    else console.log(TAG, msg);
}

// ---------- 依赖检测 ----------
function getMvu() {
    return typeof window !== 'undefined' && window.Mvu ? window.Mvu : null;
}

function getTavernHelper() {
    // 酒馆助手暴露的全局事件/生成 API（扩展层）
    if (typeof window !== 'undefined' && window.TavernHelper) return window.TavernHelper;
    if (typeof window !== 'undefined' && typeof window.generateRaw === 'function') return window;
    return null;
}

function waitForMvu(timeout = 10000) {
    return new Promise((resolve) => {
        if (window.Mvu) return resolve(window.Mvu);
        const start = Date.now();
        const timer = setInterval(() => {
            if (window.Mvu) { clearInterval(timer); resolve(window.Mvu); }
            else if (Date.now() - start > timeout) { clearInterval(timer); resolve(null); }
        }, 200);
    });
}

function withTimeout(promise, ms) {
    return new Promise((resolve, reject) => {
        const t = setTimeout(() => reject(new Error('LLM 调用超时')), ms);
        promise.then(v => { clearTimeout(t); resolve(v); }, e => { clearTimeout(t); reject(e); });
    });
}

// ---------- 核心：处理单条消息（detag + 可选 LLM 修复）----------
let is_fixing = false;
let lastNotifiedMessageId = -1;

// 写回 mes 并同步当前 swipe（避免 swipe 切换后修复丢失）
function setMes(msg, text) {
    if (!msg) return;
    msg.mes = text;
    if (Array.isArray(msg.swipes)) {
        const sid = Math.max(0, Number(msg.swipe_id ?? 0) || 0);
        if (sid < msg.swipes.length) msg.swipes[sid] = text;
    }
}

async function processMessage(messageId, { force = false, forceFix = false, skipFix = false } = {}) {
    const empty = { changed: false, removedTags: new Set() };
    try {
        const settings = getSettings();
        if (!force && !settings.enabled) return empty;
        if (messageId == null || messageId < 0) return empty;

        const ctx = getCtx();
        const chat = ctx.chat;
        if (!chat || !chat[messageId]) return empty;

        const msg = chat[messageId];
        if (msg.is_user || msg.is_system) return empty;

        const tags = settings.tags || DEFAULT_TAGS;
        const thinkTags = settings.thinkTags || BOUNDARY_TAGS;
        const plotTag = settings.plotTag || 'now_plot';
        let changed = false;
        const removed = new Set();

        // 1. detag（思考区 tag 去 <>）
        if (msg.mes) {
            const r = detagMes(msg.mes, tags, thinkTags);
            if (r.changed) {
                setMes(msg, r.mes);
                changed = true;
                for (const t of r.removedTags) removed.add(t);
            }
        }
        if (settings.processReasoning && msg.extra && msg.extra.reasoning) {
            const r = detagReasoning(msg.extra.reasoning, tags);
            if (r.changed) {
                msg.extra.reasoning = r.reasoning;
                changed = true;
                for (const t of r.removedTags) removed.add(t);
            }
        }

        // 1.5 规则结构修复（零成本，LLM 之前先尝试：代码块迁移 + plotTag 重包裹）
        if (msg.mes) {
            const rf = ruleFixStructure(msg.mes, plotTag, thinkTags);
            if (rf.changed) {
                setMes(msg, rf.text);
                changed = true;
            }
        }

        if (changed) {
            const saveChatDebounced = ctx.saveChatDebounced || window.saveChatDebounced;
            const updateMessageBlock = ctx.updateMessageBlock || window.updateMessageBlock;
            if (saveChatDebounced) saveChatDebounced();
            if (updateMessageBlock) {
                try { updateMessageBlock(messageId, msg); } catch (e) { console.warn(TAG, 'updateMessageBlock 失败', e); }
            }
        }

        // 2. LLM 修复分支（规则修不了的再交 LLM）
        let doLlmFix;
        if (skipFix) doLlmFix = false;
        else if (forceFix) doLlmFix = true;
        else doLlmFix = settings.llmFixEnabled && settings.autoFix;

        if (doLlmFix && !is_fixing && msg.mes) {
            const issues = detectIssues(msg.mes, thinkTags, tags, plotTag);
            if (issues.hasIssues) {
                // 手动总是询问；自动仅未询问过才询问（防重复打扰）
                const shouldAsk = forceFix || lastNotifiedMessageId !== messageId;
                if (shouldAsk) {
                    if (!forceFix) lastNotifiedMessageId = messageId;
                    const ok = confirm(`格式助手：发现可能格式问题：\n${issues.issues.join('\n')}\n\n是否执行 LLM 修复？`);
                    if (ok) await llmFixMessage(messageId, thinkTags, plotTag);
                }
            } else if (forceFix) {
                toast('规则修复后未检测到格式问题，无需 LLM 修复');
            }
        }

        return { changed, removedTags: removed };
    } catch (e) {
        console.error(TAG, 'processMessage 异常', e);
        return empty;
    }
}

// ---------- LLM 修复 ----------
async function llmFixMessage(messageId, thinkTags, plotTag) {
    const ctx = getCtx();
    const chat = ctx.chat;
    const msg = chat[messageId];
    if (!msg || !msg.mes) return;
    is_fixing = true;
    try {
        const settings = getSettings();
        if (!settings.fixConnection || !settings.fixConnection.apiUrl) {
            toast('LLM 修复：未配置独立修复连接，跳过', 'warning');
            return;
        }
        const fp1 = contentFingerprint(msg.mes, thinkTags);
        toast('LLM 修复中…');
        const result = await callFixLLM(msg.mes, thinkTags, plotTag);
        if (!result) { toast('LLM 修复失败，已保留原文', 'warning'); return; }
        if (!result.changed || !result.fixed_text) { toast('LLM 修复：无需改动'); return; }
        const fp2 = contentFingerprint(result.fixed_text, thinkTags);
        if (fp1 !== fp2) {
            console.warn(TAG, '指纹不一致，拒绝应用 LLM 修复');
            toast('LLM 修复未应用：正文叙事文字被改动，已保留原文', 'warning');
            return;
        }
        // 确认窗口：高亮 diff，用户确认才写回
        const confirmed = await showFixConfirmDialog(msg.mes, result.fixed_text, result.reason);
        if (!confirmed) { toast('已取消，未应用修复'); return; }
        setMes(msg, result.fixed_text);
        const saveChatDebounced = ctx.saveChatDebounced || window.saveChatDebounced;
        const updateMessageBlock = ctx.updateMessageBlock || window.updateMessageBlock;
        if (saveChatDebounced) saveChatDebounced();
        if (updateMessageBlock) {
            try { updateMessageBlock(messageId, msg); } catch (e) { console.warn(TAG, 'updateMessageBlock 失败', e); }
        }
        toast('LLM 修复已应用');
    } catch (e) {
        console.error(TAG, 'llmFixMessage 异常', e);
        toast('LLM 修复异常，已保留原文', 'error');
    } finally {
        is_fixing = false;
    }
}

function parseFixResult(result) {
    if (!result) return null;
    if (typeof result === 'string') {
        try { return JSON.parse(result); }
        catch {
            const m = result.match(/\{[\s\S]*\}/);
            if (m) { try { return JSON.parse(m[0]); } catch {} }
            return null;
        }
    }
    if (typeof result === 'object') return result;
    return null;
}

async function callFixLLM(text, thinkTags, plotTag) {
    const ctx = getCtx();
    const settings = getSettings();
    const formatReq = buildFormatRequirements();
    const { system, user, jsonSchema } = buildFixPrompt({ originalText: text, formatRequirements: formatReq, thinkTags, plotTag });
    const conn = settings.fixConnection || {};
    const timeout = (settings.fixTimeout || 60) * 1000;

    // 动态放大 max_tokens：整文重写输出 ≈ 原文长度，需保证不截断
    let inputTokens = Math.ceil(text.length / 2); // 兜底估算（中文约 2 字/token）
    try {
        if (typeof ctx.getTokenCountAsync === 'function') {
            inputTokens = await ctx.getTokenCountAsync(text);
        }
    } catch {}
    const needMax = Math.min(Math.ceil(inputTokens * 1.3) + 256, 32768);
    const maxTokens = Math.max(Number(conn.maxTokens) || 8192, needMax);

    // 优先酒馆助手 generateRaw（独立连接 + json_schema）
    const helper = getTavernHelper();
    if (helper && typeof helper.generateRaw === 'function') {
        try {
            const ordered = [
                { role: 'system', content: system },
                { role: 'user', content: user },
            ];
            const customApi = conn.apiUrl ? {
                apiurl: conn.apiUrl,
                key: conn.apiKey,
                model: conn.model,
                source: 'custom',
                max_tokens: maxTokens,
                temperature: conn.temperature ?? 0.2,
            } : undefined;
            const out = await withTimeout(helper.generateRaw({
                ordered_prompts: ordered,
                custom_api: customApi,
                should_silence: true,
                json_schema: jsonSchema,
            }), timeout);
            return parseFixResult(out);
        } catch (e) {
            console.warn(TAG, '酒馆助手 generateRaw 失败，回退 ST', e);
        }
    }
    // 兜底 ST generateRaw
    try {
        if (typeof ctx.generateRaw !== 'function') {
            console.warn(TAG, 'ST generateRaw 不可用');
            return null;
        }
        const out = await withTimeout(ctx.generateRaw({
            prompt: user,
            systemPrompt: system,
            api: 'openai',
            responseLength: maxTokens,
        }), timeout);
        return parseFixResult(out);
    } catch (e) {
        console.error(TAG, 'ST generateRaw 失败', e);
        return null;
    }
}

// ---------- LLM 修复确认窗口（高亮 diff）----------
function showFixConfirmDialog(original, fixed, reason) {
    return new Promise((resolve) => {
        const lines = lineDiff(original, fixed);
        const eq = lines.filter(l => l.type === 'eq').length;
        const del = lines.filter(l => l.type === 'del').length;
        const add = lines.filter(l => l.type === 'add').length;
        const overlay = document.createElement('div');
        overlay.className = 'td-modal-overlay';
        overlay.innerHTML = `
            <div class="td-modal">
                <h3 class="td-modal-title">LLM 修复确认</h3>
                <div class="td-modal-reason"><b>修改原因：</b>${escapeHtml(reason || '(未提供)')}</div>
                <div class="td-modal-stats"><small>共 ${lines.length} 行：未变 ${eq}，删除 ${del}，新增 ${add}</small></div>
                <div class="td-diff">
                    ${lines.map(l => `<div class="td-diff-${l.type}"><span class="td-diff-mark">${l.type === 'del' ? '-' : l.type === 'add' ? '+' : ' '}</span>${escapeHtml(l.text || ' ')}</div>`).join('')}
                </div>
                <div class="td-modal-buttons">
                    <div class="menu_button" id="td_diff_cancel">取消（不修改）</div>
                    <div class="menu_button" id="td_diff_confirm">确认应用修复</div>
                </div>
            </div>
        `;
        document.body.appendChild(overlay);
        const close = (val) => { overlay.remove(); resolve(val); };
        overlay.querySelector('#td_diff_cancel').addEventListener('click', () => close(false));
        overlay.querySelector('#td_diff_confirm').addEventListener('click', () => close(true));
        overlay.addEventListener('click', (e) => { if (e.target === overlay) close(false); });
    });
}

// ---------- 格式要求来源 ----------
let cachedWiEntries = [];
let cachedPresetPrompts = [];

function loadWorldInfoEntriesForUI() {
    const ctx = getCtx();
    const entries = [];
    try {
        const ch = ctx.characterId;
        const char = ctx.characters?.[ch];
        // 角色卡内嵌书
        if (char?.data?.character_book && typeof ctx.convertCharacterBook === 'function') {
            const book = ctx.convertCharacterBook(char.data.character_book);
            if (book?.entries) {
                for (const [uid, e] of Object.entries(book.entries)) {
                    entries.push({ uid: `charbook.${uid}`, comment: e.comment || `(条目${uid})`, content: e.content || '', source: '角色卡内嵌书' });
                }
            }
        }
        // 角色绑定全局书
        const worldName = char?.data?.extensions?.world;
        if (worldName && typeof ctx.loadWorldInfo === 'function') {
            const wi = ctx.loadWorldInfo(worldName);
            if (wi?.entries) {
                for (const [uid, e] of Object.entries(wi.entries)) {
                    entries.push({ uid: `${worldName}.${uid}`, comment: e.comment || `(条目${uid})`, content: e.content || '', source: worldName });
                }
            }
        }
        // 全局勾选书
        if (typeof ctx.getWorldInfoNames === 'function') {
            for (const name of ctx.getWorldInfoNames()) {
                if (name === worldName) continue;
                try {
                    const wi = ctx.loadWorldInfo(name);
                    if (wi?.entries) {
                        for (const [uid, e] of Object.entries(wi.entries)) {
                            entries.push({ uid: `${name}.${uid}`, comment: e.comment || `(条目${uid})`, content: e.content || '', source: name });
                        }
                    }
                } catch {}
            }
        }
    } catch (e) {
        console.warn(TAG, '加载世界书条目失败', e);
    }
    cachedWiEntries = entries;
    return entries;
}

function loadPresetPromptsForUI() {
    const ctx = getCtx();
    const prompts = [];
    try {
        const oai = ctx.chatCompletionSettings;
        if (!oai?.prompts) { cachedPresetPrompts = prompts; return prompts; }
        const orders = oai.prompt_order || [];
        const enabledIds = new Set();
        for (const po of orders) {
            if (po.character_id === 100001 || po.character_id === ctx.characterId) {
                for (const o of (po.order || [])) {
                    if (o.enabled) enabledIds.add(o.identifier);
                }
            }
        }
        for (const p of oai.prompts) {
            if (p.marker) continue;
            if (enabledIds.size > 0 && !enabledIds.has(p.identifier)) continue;
            prompts.push({ identifier: p.identifier, name: p.name || p.identifier, content: p.content || '' });
        }
    } catch (e) {
        console.warn(TAG, '加载预设 prompt 失败', e);
    }
    cachedPresetPrompts = prompts;
    return prompts;
}

function buildFormatRequirements() {
    const settings = getSettings();
    const fs = settings.formatSource || {};
    const wiContents = [];
    const promptContents = [];
    if (fs.useWorldInfo && Array.isArray(fs.selectedWiUids)) {
        for (const uid of fs.selectedWiUids) {
            const e = cachedWiEntries.find(x => x.uid === uid);
            if (e && e.content) wiContents.push(e.content);
        }
    }
    if (fs.usePreset && Array.isArray(fs.selectedPromptIds)) {
        for (const id of fs.selectedPromptIds) {
            const p = cachedPresetPrompts.find(x => x.identifier === id);
            if (p && p.content) promptContents.push(p.content);
        }
    }
    return extractFormatRequirements({
        wiContents, promptContents, manualText: fs.manualText || '',
        useWorldInfo: !!fs.useWorldInfo, usePreset: !!fs.usePreset, useManual: !!fs.useManual,
    });
}

// ---------- 自动模式：防抖调度 ----------
let pendingTimer = null;
function scheduleProcess(messageId) {
    const settings = getSettings();
    if (!settings.enabled) return;
    const mvu = getMvu();
    const delay = mvu ? (Number(settings.autoDelay) || 0) * 1000 : 0;
    clearTimeout(pendingTimer);
    pendingTimer = setTimeout(() => { processMessage(messageId); }, delay);
}

function onMessageReceived(messageId) { scheduleProcess(messageId); }
function onGenerationEnded() {
    if (is_fixing) return; // 重入保护：LLM 修复触发的 GENERATION_ENDED 不递归
    const chat = getCtx().chat;
    if (chat && chat.length > 0) scheduleProcess(chat.length - 1);
}
function onVarUpdateEnded(...args) {
    const settings = getSettings();
    if (!settings.enabled) return;
    let messageId = null;
    const a = args[0];
    if (typeof a === 'number') messageId = a;
    else if (a && typeof a === 'object') messageId = a.message_id ?? a.messageId ?? a.id ?? null;
    if (messageId == null) { const chat = getCtx().chat; messageId = chat ? chat.length - 1 : null; }
    processMessage(messageId);
}

// ---------- 手动：处理最近一条 ----------
async function processLatestMessage() {
    persistSettingsFromPanel();
    try {
        const ctx = getCtx();
        const chat = ctx.chat;
        if (!chat || chat.length === 0) return { ok: false, msg: '未找到可处理的 AI 消息' };
        let idx = -1;
        for (let i = chat.length - 1; i >= 0; i--) {
            if (chat[i] && !chat[i].is_user && !chat[i].is_system) { idx = i; break; }
        }
        if (idx < 0) return { ok: false, msg: '未找到可处理的 AI 消息' };

        const result = await processMessage(idx, { force: true, skipFix: true });
        const removed = new Set(result.removedTags);

        const settings = getSettings();
        const msgObj = chat[idx];
        const thinkTags = settings.thinkTags || BOUNDARY_TAGS;
        const knownTags = settings.tags || DEFAULT_TAGS;
        let unknown = [];
        if (msgObj.mes) unknown = findUnknownTags(msgObj.mes, thinkTags, knownTags, SAFE_HTML_TAGS);
        if (settings.processReasoning && msgObj.extra?.reasoning) {
            const u2 = findUnknownTags(msgObj.extra.reasoning, thinkTags, knownTags, SAFE_HTML_TAGS);
            unknown = [...new Set([...unknown, ...u2])];
        }

        let addedTags = [];
        if (unknown.length > 0) {
            const list = unknown.map(t => `<${t}>`).join('  ');
            if (confirm(`格式助手 发现思考内容中存在但未在危险名单的 tag：\n${list}\n\n是否将它们加入白名单并重新处理？`)) {
                settings.tags = [...new Set([...knownTags, ...unknown])];
                saveSettings();
                const r2 = await processMessage(idx, { force: true, skipFix: true });
                for (const t of r2.removedTags) removed.add(t);
                addedTags = unknown;
                const $tags = document.getElementById('td_tags');
                if ($tags) $tags.value = settings.tags.join('\n');
            }
        }

        const saveChatDebounced = ctx.saveChatDebounced || window.saveChatDebounced;
        if (saveChatDebounced) saveChatDebounced();

        let msg;
        if (removed.size === 0 && addedTags.length === 0) {
            msg = `最近一条消息（#${idx}）无需处理：未发现危险 tag`;
        } else {
            const parts = [];
            if (removed.size > 0) parts.push(`去掉以下 tag 的尖括号：${[...removed].join(', ')}`);
            if (addedTags.length > 0) parts.push(`已新增白名单：${addedTags.join(', ')}`);
            msg = `已处理最近一条消息（#${idx}）：${parts.join('；')}`;
        }
        return { ok: true, msg };
    } catch (e) {
        console.error(TAG, 'processLatestMessage 异常', e);
        return { ok: false, msg: '处理异常：' + (e && e.message ? e.message : e) };
    }
}

async function processLatestMessageFix() {
    persistSettingsFromPanel();
    try {
        const ctx = getCtx();
        const chat = ctx.chat;
        if (!chat || chat.length === 0) return { ok: false, msg: '未找到可处理的 AI 消息' };
        let idx = -1;
        for (let i = chat.length - 1; i >= 0; i--) {
            if (chat[i] && !chat[i].is_user && !chat[i].is_system) { idx = i; break; }
        }
        if (idx < 0) return { ok: false, msg: '未找到可处理的 AI 消息' };
        const settings = getSettings();
        if (!settings.fixConnection || !settings.fixConnection.apiUrl) {
            return { ok: false, msg: '未配置独立修复连接，请先在设置面板填写 API URL/Key/Model' };
        }
        // 先刷新世界书/预设缓存，确保格式要求来源最新
        loadWorldInfoEntriesForUI();
        loadPresetPromptsForUI();
        await processMessage(idx, { force: true, forceFix: true });
        return { ok: true, msg: 'LLM 修复已执行（见结果提示）' };
    } catch (e) {
        return { ok: false, msg: 'LLM 修复异常：' + (e && e.message ? e.message : e) };
    }
}

// ---------- 悬浮球 ----------
function ensureFloatingBall() {
    const settings = getSettings();
    const existing = document.getElementById('td_floating_ball');
    if (!settings.showFloatingBall) {
        if (existing) existing.remove();
        return;
    }
    if (existing) return;

    const ball = document.createElement('div');
    ball.id = 'td_floating_ball';
    ball.className = 'td-floating-ball';
    ball.title = '格式助手\n左半：去标签 / 右半：LLM修复 / 拖动：移动';
    ball.innerHTML = `
        <div class="td-ball-half td-ball-left" data-action="detag" title="去标签（最近一条）">去标</div>
        <div class="td-ball-half td-ball-right" data-action="fix" title="LLM 修复格式（最近一条）">修复</div>
    `;
    document.body.appendChild(ball);

    makeDraggable(ball, (_e, downTarget) => {
        const action = downTarget && downTarget.closest ? (downTarget.closest('[data-action]') || {}).dataset?.action : null;
        if (action === 'fix') {
            processLatestMessageFix().then(r => { if (!r.ok) toast(r.msg, 'warning'); });
        } else {
            processLatestMessage().then(r => toast(r.msg));
        }
    });
}

function makeDraggable(el, onClick) {
    let dragging = false;
    let startX = 0, startY = 0, origX = 0, origY = 0, moved = false;
    let downTarget = null;

    el.addEventListener('pointerdown', (e) => {
        dragging = true; moved = false; downTarget = e.target;
        startX = e.clientX; startY = e.clientY;
        const rect = el.getBoundingClientRect();
        origX = rect.left; origY = rect.top;
        try { el.setPointerCapture(e.pointerId); } catch {}
        e.preventDefault();
    });
    el.addEventListener('pointermove', (e) => {
        if (!dragging) return;
        const dx = e.clientX - startX, dy = e.clientY - startY;
        if (Math.abs(dx) > 4 || Math.abs(dy) > 4) moved = true;
        el.style.left = (origX + dx) + 'px';
        el.style.top = (origY + dy) + 'px';
        el.style.right = 'auto'; el.style.bottom = 'auto';
    });
    const endDrag = (e) => {
        if (!dragging) return;
        dragging = false;
        try { el.releasePointerCapture(e.pointerId); } catch {}
        if (!moved && typeof onClick === 'function') onClick(e, downTarget);
    };
    el.addEventListener('pointerup', endDrag);
    el.addEventListener('pointercancel', endDrag);
}

// ---------- 设置面板 ----------
// 从设置面板实时读取并保存（无需保存按钮）
function persistSettingsFromPanel() {
    if (!document.getElementById('td_fix_url')) return; // 面板未渲染
    const s = getSettings();
    const val = (id) => { const el = document.getElementById(id); return el ? el.value : ''; };
    const chk = (id) => { const el = document.getElementById(id); return !!(el && el.checked); };
    s.enabled = chk('td_enabled');
    s.processReasoning = chk('td_process_reasoning');
    s.showFloatingBall = chk('td_show_ball');
    s.thinkTags = val('td_think_tags').split('\n').map(t => t.trim()).filter(Boolean);
    s.tags = val('td_tags').split('\n').map(t => t.trim()).filter(Boolean);
    s.autoDelay = Number(val('td_auto_delay')) || 0;
    s.plotTag = val('td_plot_tag').trim() || 'now_plot';
    s.llmFixEnabled = chk('td_llm_fix');
    s.autoFix = chk('td_auto_fix');
    s.fixTimeout = Number(val('td_fix_timeout')) || 60;
    s.fixConnection = s.fixConnection || {};
    s.fixConnection.apiUrl = val('td_fix_url').trim();
    s.fixConnection.apiKey = val('td_fix_key').trim();
    s.fixConnection.model = val('td_fix_model').trim();
    s.fixConnection.maxTokens = Number(val('td_fix_maxtok')) || 8192;
    s.fixConnection.temperature = Number(val('td_fix_temp'));
    s.formatSource = s.formatSource || {};
    s.formatSource.useWorldInfo = chk('td_use_wi');
    s.formatSource.usePreset = chk('td_use_preset');
    s.formatSource.useManual = chk('td_use_manual');
    s.formatSource.manualText = val('td_manual');
    s.formatSource.selectedWiUids = collectChecked('td_wi_list');
    s.formatSource.selectedPromptIds = collectChecked('td_preset_list');
    saveSettings();
    ensureFloatingBall();
}

// 从 API 拉取模型列表，填充下拉
async function refreshModelList() {
    const urlEl = document.getElementById('td_fix_url');
    const keyEl = document.getElementById('td_fix_key');
    if (!urlEl) return;
    const url = urlEl.value.trim();
    const key = keyEl ? keyEl.value.trim() : '';
    if (!url) { toast('请先填写 API URL', 'warning'); return; }
    toast('拉取模型列表中…');
    try {
        let modelUrl = url.replace(/\/+$/, '');
        if (!/\/models$/i.test(modelUrl)) modelUrl += '/models';
        const res = await fetch(modelUrl, {
            method: 'GET',
            headers: key
                ? { 'Authorization': `Bearer ${key}`, 'Content-Type': 'application/json' }
                : { 'Content-Type': 'application/json' },
        });
        if (!res.ok) throw new Error('HTTP ' + res.status);
        const data = await res.json();
        const list = data.data || data.models || data || [];
        const models = list.map(m => (typeof m === 'string' ? m : (m.id || m.name || m.model))).filter(Boolean);
        let dl = document.getElementById('td_fix_model_list');
        if (!dl) {
            dl = document.createElement('datalist');
            dl.id = 'td_fix_model_list';
            document.body.appendChild(dl);
            const modelInput = document.getElementById('td_fix_model');
            if (modelInput) modelInput.setAttribute('list', 'td_fix_model_list');
        }
        dl.innerHTML = models.map(m => `<option value="${escapeHtml(m)}">`).join('');
        toast(`已获取 ${models.length} 个模型，点模型输入框下拉选择`);
    } catch (e) {
        console.warn(TAG, '拉取模型列表失败', e);
        toast('拉取失败：' + (e && e.message ? e.message : e) + '（可能 CORS 限制，可手动填模型名）', 'error');
    }
}

function renderSettingsPanel() {
    const container = document.getElementById('extensions_settings');
    if (!container) { console.warn(TAG, '未找到 #extensions_settings'); return; }
    if (document.getElementById('think_detagger_settings')) return;

    const settings = getSettings();
    const wrap = document.createElement('div');
    wrap.id = 'think_detagger_settings';
    wrap.className = 'think-detagger-settings';
    wrap.innerHTML = `
        <div class="inline-drawer">
            <div class="inline-drawer-toggle inline-drawer-header">
                <b>格式助手</b>
                <div class="inline-drawer-icon fa-solid fa-circle-chevron-down down"></div>
            </div>
            <div class="inline-drawer-content">
                <label class="checkbox_label"><input type="checkbox" id="td_enabled" ${settings.enabled ? 'checked' : ''}><span><b>自动模式</b>：每轮对话接收完整后自动去标签</span></label>
                <label class="checkbox_label"><input type="checkbox" id="td_process_reasoning" ${settings.processReasoning ? 'checked' : ''}><span>同时处理原生 reasoning (extra.reasoning)</span></label>
                <label class="checkbox_label"><input type="checkbox" id="td_show_ball" ${settings.showFloatingBall ? 'checked' : ''}><span>显示悬浮球（点击手动去标签）</span></label>
                <div class="td_section">
                    <label for="td_think_tags"><small>思考内容标签（边界标签，一行一个；如 think / thinking / reasoning / cot）</small></label>
                    <textarea id="td_think_tags" rows="3" class="td_textarea">${(settings.thinkTags || []).join('\n')}</textarea>
                </div>
                <div class="td_section td_row">
                    <label for="td_plot_tag"><small>正文容器标签（默认 now_plot；若预设用别的标签如 story/正文，填这里）</small></label>
                    <input type="text" id="td_plot_tag" value="${settings.plotTag || 'now_plot'}" class="td_input" style="max-width:180px">
                </div>
                <div class="td_section">
                    <label for="td_tags"><small>危险 tag 白名单（一行一个）</small></label>
                    <textarea id="td_tags" rows="8" class="td_textarea">${(settings.tags || []).join('\n')}</textarea>
                </div>
                <div class="td_section td_row">
                    <label for="td_auto_delay"><small>自动模式延迟（秒，装了 MVU 时等待变量解析；0=立即）</small></label>
                    <input type="number" id="td_auto_delay" min="0" max="60" step="1" value="${settings.autoDelay ?? 2}" class="td_number">
                </div>
                <div class="td_buttons">
                    <div class="menu_button" id="td_runall_btn">立即处理最近一条</div>
                </div>

                <hr>
                <div class="td_subhead">LLM 格式修复（可选）</div>
                <label class="checkbox_label"><input type="checkbox" id="td_llm_fix" ${settings.llmFixEnabled ? 'checked' : ''}><span>启用 LLM 格式修复</span></label>
                <label class="checkbox_label"><input type="checkbox" id="td_auto_fix" ${settings.autoFix ? 'checked' : ''}><span>自动检测到格式问题时询问是否修复（不自动执行，需确认）</span></label>
                <div class="td_section td_row">
                    <label for="td_fix_timeout"><small>修复超时（秒）</small></label>
                    <input type="number" id="td_fix_timeout" min="10" max="300" step="5" value="${settings.fixTimeout ?? 60}" class="td_number">
                </div>
                <div class="td_section">
                    <small>独立修复连接（推荐用便宜快速模型）：</small>
                    <input type="text" id="td_fix_url" placeholder="API URL" value="${settings.fixConnection?.apiUrl || ''}" class="td_input">
                    <input type="text" id="td_fix_key" placeholder="API Key" value="${settings.fixConnection?.apiKey || ''}" class="td_input">
                    <div class="td_row">
                        <input type="text" id="td_fix_model" list="td_fix_model_list" placeholder="模型名，如 gemini-2.5-flash" value="${settings.fixConnection?.model || ''}" class="td_input" style="flex:1">
                        <div class="menu_button menu_button_small" id="td_model_refresh" title="从 API 拉取模型列表">刷新模型</div>
                    </div>
                    <datalist id="td_fix_model_list"></datalist>
                    <div class="td_row">
                        <label for="td_fix_maxtok"><small>max_tokens（最大输出长度；整文重写需 ≥ 主对话回复长度，默认 8192，会按原文长度自动放大）</small></label>
                        <input type="number" id="td_fix_maxtok" min="256" max="32768" step="256" value="${settings.fixConnection?.maxTokens ?? 8192}" class="td_number">
                    </div>
                    <div class="td_row">
                        <label for="td_fix_temp"><small>temperature（温度：0 最稳定，越高越发散；修格式建议 0-0.3）</small></label>
                        <input type="number" id="td_fix_temp" min="0" max="2" step="0.1" value="${settings.fixConnection?.temperature ?? 0.2}" class="td_number">
                    </div>
                </div>
                <div class="td_section">
                    <small>格式要求来源（勾选要用的来源）：</small>
                    <label class="checkbox_label"><input type="checkbox" id="td_use_wi" ${settings.formatSource?.useWorldInfo ? 'checked' : ''}><span>使用世界书条目</span></label>
                    <div id="td_wi_list_wrap" class="td_list_wrap" style="display:${settings.formatSource?.useWorldInfo ? 'block' : 'none'}">
                        <div class="td_row"><div class="menu_button menu_button_small" id="td_wi_refresh">刷新世界书条目</div></div>
                        <input type="text" id="td_wi_search" placeholder="搜索条目（comment/内容）…" class="td_input">
                        <div id="td_wi_list" class="td_checklist"></div>
                    </div>
                    <label class="checkbox_label"><input type="checkbox" id="td_use_preset" ${settings.formatSource?.usePreset ? 'checked' : ''}><span>使用预设 prompt</span></label>
                    <div id="td_preset_list_wrap" class="td_list_wrap" style="display:${settings.formatSource?.usePreset ? 'block' : 'none'}">
                        <div class="td_row"><div class="menu_button menu_button_small" id="td_preset_refresh">刷新预设 prompt</div></div>
                        <input type="text" id="td_preset_search" placeholder="搜索 prompt（name/内容）…" class="td_input">
                        <div id="td_preset_list" class="td_checklist"></div>
                    </div>
                    <label class="checkbox_label"><input type="checkbox" id="td_use_manual" ${settings.formatSource?.useManual ? 'checked' : ''}><span>使用手动填写</span></label>
                    <div id="td_manual_wrap" style="display:${settings.formatSource?.useManual ? 'block' : 'none'}">
                        <textarea id="td_manual" rows="6" class="td_textarea" placeholder="手写格式要求…">${settings.formatSource?.manualText || ''}</textarea>
                    </div>
                </div>
                <div class="td_buttons">
                    <div class="menu_button" id="td_fix_btn">立即 LLM 修复最近一条</div>
                </div>
                <small class="td_hint">手动：<code>/detag</code> 仅去标签；<code>/fix-format</code> detag + LLM 修复。LLM 修复需配置独立连接。指纹校验保护正文叙事。</small>
            </div>
        </div>
    `;
    container.appendChild(wrap);

    const $ = (id) => wrap.querySelector('#' + id);
    const persist = persistSettingsFromPanel;

    // 所有输入实时自动保存（无需保存按钮）
    ['td_enabled', 'td_process_reasoning', 'td_show_ball', 'td_llm_fix', 'td_auto_fix'].forEach(id => $(id)?.addEventListener('change', persist));
    ['td_think_tags', 'td_tags', 'td_manual', 'td_auto_delay', 'td_plot_tag', 'td_fix_timeout', 'td_fix_url', 'td_fix_key', 'td_fix_model', 'td_fix_maxtok', 'td_fix_temp'].forEach(id => $(id)?.addEventListener('input', persist));

    $('td_runall_btn').addEventListener('click', () => { persist(); processLatestMessage().then(r => toast(r.msg)); });
    $('td_fix_btn').addEventListener('click', () => { persist(); processLatestMessageFix().then(r => { if (!r.ok) toast(r.msg, 'warning'); }); });
    $('td_model_refresh').addEventListener('click', refreshModelList);

    // 来源开关：显隐 + 保存 + 加载
    $('td_use_wi').addEventListener('change', (e) => {
        $('td_wi_list_wrap').style.display = e.target.checked ? 'block' : 'none';
        persist();
        if (e.target.checked) renderWiList();
    });
    $('td_use_preset').addEventListener('change', (e) => {
        $('td_preset_list_wrap').style.display = e.target.checked ? 'block' : 'none';
        persist();
        if (e.target.checked) renderPresetList();
    });
    $('td_use_manual').addEventListener('change', (e) => {
        $('td_manual_wrap').style.display = e.target.checked ? 'block' : 'none';
        persist();
    });
    // 勾选列表变化保存
    $('td_wi_list').addEventListener('change', persist);
    $('td_preset_list').addEventListener('change', persist);
    $('td_wi_refresh').addEventListener('click', () => { loadWorldInfoEntriesForUI(); renderWiList($('td_wi_search')?.value || ''); });
    $('td_preset_refresh').addEventListener('click', () => { loadPresetPromptsForUI(); renderPresetList($('td_preset_search')?.value || ''); });
    $('td_wi_search').addEventListener('input', (e) => renderWiList(e.target.value));
    $('td_preset_search').addEventListener('input', (e) => renderPresetList(e.target.value));

    // 初次加载列表（若已开启）
    if (settings.formatSource?.useWorldInfo) { loadWorldInfoEntriesForUI(); renderWiList(); }
    if (settings.formatSource?.usePreset) { loadPresetPromptsForUI(); renderPresetList(); }
}

function collectChecked(listId) {
    const list = document.getElementById(listId);
    if (!list) return [];
    return Array.from(list.querySelectorAll('input[type=checkbox]:checked')).map(cb => cb.value);
}

function renderWiList(filter = '') {
    const settings = getSettings();
    const selected = new Set(settings.formatSource?.selectedWiUids || []);
    const list = document.getElementById('td_wi_list');
    if (!list) return;
    let entries = cachedWiEntries;
    if (filter) {
        const f = filter.toLowerCase();
        entries = entries.filter(e =>
            (e.comment || '').toLowerCase().includes(f) ||
            (e.content || '').toLowerCase().includes(f) ||
            (e.source || '').toLowerCase().includes(f)
        );
    }
    if (!entries.length) {
        list.innerHTML = '<small style="opacity:.7">（无匹配条目，点刷新或检查角色卡/世界书）</small>';
        return;
    }
    list.innerHTML = entries.map(e => {
        const preview = (e.content || '').slice(0, 120).replace(/\s+/g, ' ');
        const checked = selected.has(e.uid) ? 'checked' : '';
        return `<label class="td_checkitem"><input type="checkbox" value="${escapeHtml(e.uid)}" ${checked}><span class="td_checktext"><b>[${escapeHtml(e.source)}]</b> ${escapeHtml(e.comment)}<br><small>${escapeHtml(preview)}…</small></span></label>`;
    }).join('');
}

function renderPresetList(filter = '') {
    const settings = getSettings();
    const selected = new Set(settings.formatSource?.selectedPromptIds || []);
    const list = document.getElementById('td_preset_list');
    if (!list) return;
    let prompts = cachedPresetPrompts;
    if (filter) {
        const f = filter.toLowerCase();
        prompts = prompts.filter(p =>
            (p.name || '').toLowerCase().includes(f) ||
            (p.content || '').toLowerCase().includes(f) ||
            (p.identifier || '').toLowerCase().includes(f)
        );
    }
    if (!prompts.length) {
        list.innerHTML = '<small style="opacity:.7">（无匹配 prompt，点刷新或检查预设）</small>';
        return;
    }
    list.innerHTML = prompts.map(p => {
        const preview = (p.content || '').slice(0, 120).replace(/\s+/g, ' ');
        const checked = selected.has(p.identifier) ? 'checked' : '';
        return `<label class="td_checkitem"><input type="checkbox" value="${escapeHtml(p.identifier)}" ${checked}><span class="td_checktext"><b>${escapeHtml(p.name)}</b><br><small>${escapeHtml(preview)}…</small></span></label>`;
    }).join('');
}

function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

// ---------- 斜杠命令 ----------
function registerSlashCommand() {
    const ctx = getCtx();
    const register = ctx.registerSlashCommand || window.registerSlashCommand;
    if (!register) { console.warn(TAG, '未找到 registerSlashCommand'); return; }
    try {
        register('detag', () => {
            processLatestMessage().then(r => toast(r.msg));
            return '处理最近一条（仅去标签）';
        }, [], '处理最近一条 AI 回复的思考 tag，并提示补充未知 tag', true, true);
        register('fix-format', () => {
            processLatestMessageFix().then(r => { if (!r.ok) toast(r.msg, 'warning'); });
            return 'LLM 修复最近一条格式（detag + LLM）';
        }, [], 'detag + LLM 修复最近一条 AI 回复的格式', true, true);
        console.log(TAG, '已注册 /detag, /fix-format');
    } catch (e) {
        console.warn(TAG, '注册斜杠命令失败', e);
    }
}

// ---------- 入口 ----------
jQuery(async () => {
    const ctx = getCtx();
    if (!ctx.extensionSettings[SETTING_ID]) {
        ctx.extensionSettings[SETTING_ID] = getDefaultSettings();
    }

    renderSettingsPanel();
    registerSlashCommand();
    ensureFloatingBall();

    try {
        ctx.eventSource.on(ctx.eventTypes.MESSAGE_RECEIVED, onMessageReceived);
        console.log(TAG, '已注册 MESSAGE_RECEIVED');
    } catch (e) { console.error(TAG, '注册 MESSAGE_RECEIVED 失败', e); }
    try {
        const genEvt = ctx.eventTypes.GENERATION_ENDED;
        if (genEvt) { ctx.eventSource.on(genEvt, onGenerationEnded); console.log(TAG, '已注册 GENERATION_ENDED'); }
    } catch (e) { console.warn(TAG, '注册 GENERATION_ENDED 失败', e); }
    try {
        const editEvt = ctx.eventTypes.MESSAGE_EDITED;
        if (editEvt) {
            ctx.eventSource.on(editEvt, (messageId) => { if (messageId != null) processMessage(messageId); });
            console.log(TAG, '已注册 MESSAGE_EDITED');
        }
    } catch (e) { console.warn(TAG, '注册 MESSAGE_EDITED 失败', e); }

    waitForMvu().then((mvu) => {
        if (!mvu) { console.log(TAG, '未检测到 MVU'); return; }
        const evtName = mvu.events && mvu.events.VARIABLE_UPDATE_ENDED;
        if (!evtName) { console.warn(TAG, 'MVU 未暴露 VARIABLE_UPDATE_ENDED'); return; }
        try { ctx.eventSource.on(evtName, onVarUpdateEnded); console.log(TAG, '已注册 MVU VARIABLE_UPDATE_ENDED:', evtName); }
        catch (e) { console.warn(TAG, '注册 MVU 事件失败', e); }
    });

    // 切换聊天/角色卡时清缓存（UI 重新渲染时重新加载）
    try {
        ctx.eventSource.on(ctx.eventTypes.CHAT_CHANGED, () => {
            cachedWiEntries = [];
            cachedPresetPrompts = [];
            if (document.getElementById('td_wi_list')) { loadWorldInfoEntriesForUI(); renderWiList(document.getElementById('td_wi_search')?.value || ''); }
            if (document.getElementById('td_preset_list')) { loadPresetPromptsForUI(); renderPresetList(document.getElementById('td_preset_search')?.value || ''); }
        });
    } catch (e) { console.warn(TAG, '注册 CHAT_CHANGED 失败', e); }

    console.log(TAG, '已加载 v1.0.0');
});
