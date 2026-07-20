// think-detagger - SillyTavern 扩展入口
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
        let changed = false;
        const removed = new Set();

        // 1. detag（思考区 tag 去 <>）
        if (msg.mes) {
            const r = detagMes(msg.mes, tags, thinkTags);
            if (r.changed) {
                msg.mes = r.mes;
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

        if (changed) {
            const saveChatDebounced = ctx.saveChatDebounced || window.saveChatDebounced;
            const updateMessageBlock = ctx.updateMessageBlock || window.updateMessageBlock;
            if (saveChatDebounced) saveChatDebounced();
            if (updateMessageBlock) {
                try { updateMessageBlock(messageId, msg); } catch (e) { console.warn(TAG, 'updateMessageBlock 失败', e); }
            }
        }

        // 2. LLM 修复分支
        let doLlmFix;
        if (skipFix) doLlmFix = false;
        else if (forceFix) doLlmFix = true;
        else doLlmFix = settings.llmFixEnabled && settings.autoFix;

        if (doLlmFix && !is_fixing && msg.mes) {
            const issues = detectIssues(msg.mes, thinkTags, tags);
            if (issues.hasIssues) {
                await llmFixMessage(messageId, thinkTags);
            }
        }

        return { changed, removedTags: removed };
    } catch (e) {
        console.error(TAG, 'processMessage 异常', e);
        return empty;
    }
}

// ---------- LLM 修复 ----------
async function llmFixMessage(messageId, thinkTags) {
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
        const result = await callFixLLM(msg.mes, thinkTags);
        if (!result) { toast('LLM 修复失败，已保留原文', 'warning'); return; }
        if (!result.changed || !result.fixed_text) { toast('LLM 修复：无需改动'); return; }
        const fp2 = contentFingerprint(result.fixed_text, thinkTags);
        if (fp1 !== fp2) {
            console.warn(TAG, '指纹不一致，拒绝应用 LLM 修复');
            toast('LLM 修复未应用：正文叙事文字被改动，已保留原文', 'warning');
            return;
        }
        msg.mes = result.fixed_text;
        const saveChatDebounced = ctx.saveChatDebounced || window.saveChatDebounced;
        const updateMessageBlock = ctx.updateMessageBlock || window.updateMessageBlock;
        if (saveChatDebounced) saveChatDebounced();
        if (updateMessageBlock) {
            try { updateMessageBlock(messageId, msg); } catch (e) { console.warn(TAG, 'updateMessageBlock 失败', e); }
        }
        toast(`LLM 修复完成：${result.reason || '已修复'}`);
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

async function callFixLLM(text, thinkTags) {
    const settings = getSettings();
    const formatReq = buildFormatRequirements();
    const { system, user, jsonSchema } = buildFixPrompt({ originalText: text, formatRequirements: formatReq, thinkTags });
    const conn = settings.fixConnection || {};
    const timeout = (settings.fixTimeout || 60) * 1000;

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
                max_tokens: conn.maxTokens || 2048,
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
        const ctx = getCtx();
        if (typeof ctx.generateRaw !== 'function') {
            console.warn(TAG, 'ST generateRaw 不可用');
            return null;
        }
        const out = await withTimeout(ctx.generateRaw({
            prompt: user,
            systemPrompt: system,
            api: 'openai',
            responseLength: conn.maxTokens || 2048,
        }), timeout);
        return parseFixResult(out);
    } catch (e) {
        console.error(TAG, 'ST generateRaw 失败', e);
        return null;
    }
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
            if (confirm(`Think Detagger 发现思考内容中存在但未在危险名单的 tag：\n${list}\n\n是否将它们加入白名单并重新处理？`)) {
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
    ball.title = 'Think Detagger\n点击：手动去标签（最近一条 AI 回复）\n拖动：移动位置';
    ball.innerHTML = '<i class="fa-solid fa-eraser"></i>';
    document.body.appendChild(ball);

    makeDraggable(ball, () => {
        processLatestMessage().then(r => toast(r.msg));
    });
}

function makeDraggable(el, onClick) {
    let dragging = false;
    let startX = 0, startY = 0, origX = 0, origY = 0, moved = false;
    el.addEventListener('mousedown', (e) => {
        dragging = true; moved = false;
        startX = e.clientX; startY = e.clientY;
        const rect = el.getBoundingClientRect();
        origX = rect.left; origY = rect.top;
        e.preventDefault();
    });
    document.addEventListener('mousemove', (e) => {
        if (!dragging) return;
        const dx = e.clientX - startX, dy = e.clientY - startY;
        if (Math.abs(dx) > 4 || Math.abs(dy) > 4) moved = true;
        el.style.left = (origX + dx) + 'px';
        el.style.top = (origY + dy) + 'px';
        el.style.right = 'auto'; el.style.bottom = 'auto';
    });
    document.addEventListener('mouseup', () => { dragging = false; });
    el.addEventListener('click', () => {
        if (moved) { moved = false; return; }
        if (typeof onClick === 'function') onClick();
    });
}

// ---------- 设置面板 ----------
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
                <b>Think Detagger (思考去tag化)</b>
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
                <div class="td_section">
                    <label for="td_tags"><small>危险 tag 白名单（一行一个）</small></label>
                    <textarea id="td_tags" rows="8" class="td_textarea">${(settings.tags || []).join('\n')}</textarea>
                </div>
                <div class="td_section td_row">
                    <label for="td_auto_delay"><small>自动模式延迟（秒，装了 MVU 时等待变量解析；0=立即）</small></label>
                    <input type="number" id="td_auto_delay" min="0" max="60" step="1" value="${settings.autoDelay ?? 2}" class="td_number">
                </div>
                <div class="td_buttons">
                    <div class="menu_button" id="td_save_btn">保存设置</div>
                    <div class="menu_button" id="td_runall_btn">立即处理最近一条</div>
                </div>

                <hr>
                <div class="td_subhead">LLM 格式修复（可选）</div>
                <label class="checkbox_label"><input type="checkbox" id="td_llm_fix" ${settings.llmFixEnabled ? 'checked' : ''}><span>启用 LLM 格式修复</span></label>
                <label class="checkbox_label"><input type="checkbox" id="td_auto_fix" ${settings.autoFix ? 'checked' : ''}><span>自动模式检测到格式问题时自动调用 LLM 修复</span></label>
                <div class="td_section td_row">
                    <label for="td_fix_timeout"><small>修复超时（秒）</small></label>
                    <input type="number" id="td_fix_timeout" min="10" max="300" step="5" value="${settings.fixTimeout ?? 60}" class="td_number">
                </div>
                <div class="td_section">
                    <small>独立修复连接（推荐用便宜快速模型）：</small>
                    <input type="text" id="td_fix_url" placeholder="API URL" value="${settings.fixConnection?.apiUrl || ''}" class="td_input">
                    <input type="text" id="td_fix_key" placeholder="API Key" value="${settings.fixConnection?.apiKey || ''}" class="td_input">
                    <input type="text" id="td_fix_model" placeholder="模型名，如 gemini-2.5-flash" value="${settings.fixConnection?.model || ''}" class="td_input">
                    <div class="td_row">
                        <input type="number" id="td_fix_maxtok" placeholder="max_tokens" min="256" max="32768" step="256" value="${settings.fixConnection?.maxTokens ?? 2048}" class="td_number">
                        <input type="number" id="td_fix_temp" placeholder="temperature" min="0" max="2" step="0.1" value="${settings.fixConnection?.temperature ?? 0.2}" class="td_number">
                    </div>
                </div>
                <div class="td_section">
                    <small>格式要求来源（勾选要用的来源）：</small>
                    <label class="checkbox_label"><input type="checkbox" id="td_use_wi" ${settings.formatSource?.useWorldInfo ? 'checked' : ''}><span>使用世界书条目</span></label>
                    <div id="td_wi_list_wrap" class="td_list_wrap" style="display:${settings.formatSource?.useWorldInfo ? 'block' : 'none'}">
                        <div class="td_row"><div class="menu_button menu_button_small" id="td_wi_refresh">刷新世界书条目</div></div>
                        <div id="td_wi_list" class="td_checklist"></div>
                    </div>
                    <label class="checkbox_label"><input type="checkbox" id="td_use_preset" ${settings.formatSource?.usePreset ? 'checked' : ''}><span>使用预设 prompt</span></label>
                    <div id="td_preset_list_wrap" class="td_list_wrap" style="display:${settings.formatSource?.usePreset ? 'block' : 'none'}">
                        <div class="td_row"><div class="menu_button menu_button_small" id="td_preset_refresh">刷新预设 prompt</div></div>
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
    const persist = () => {
        const s = getSettings();
        s.enabled = !!$('td_enabled').checked;
        s.processReasoning = !!$('td_process_reasoning').checked;
        s.showFloatingBall = !!$('td_show_ball').checked;
        s.thinkTags = $('td_think_tags').value.split('\n').map(t => t.trim()).filter(Boolean);
        s.tags = $('td_tags').value.split('\n').map(t => t.trim()).filter(Boolean);
        s.autoDelay = Number($('td_auto_delay').value) || 0;
        s.llmFixEnabled = !!$('td_llm_fix').checked;
        s.autoFix = !!$('td_auto_fix').checked;
        s.fixTimeout = Number($('td_fix_timeout').value) || 60;
        s.fixConnection = s.fixConnection || {};
        s.fixConnection.apiUrl = $('td_fix_url').value.trim();
        s.fixConnection.apiKey = $('td_fix_key').value.trim();
        s.fixConnection.model = $('td_fix_model').value.trim();
        s.fixConnection.maxTokens = Number($('td_fix_maxtok').value) || 2048;
        s.fixConnection.temperature = Number($('td_fix_temp').value);
        s.formatSource = s.formatSource || {};
        s.formatSource.useWorldInfo = !!$('td_use_wi').checked;
        s.formatSource.usePreset = !!$('td_use_preset').checked;
        s.formatSource.useManual = !!$('td_use_manual').checked;
        s.formatSource.manualText = $('td_manual').value;
        s.formatSource.selectedWiUids = collectChecked('td_wi_list');
        s.formatSource.selectedPromptIds = collectChecked('td_preset_list');
        saveSettings();
        ensureFloatingBall();
    };

    $('td_save_btn').addEventListener('click', persist);
    $('td_enabled').addEventListener('change', persist);
    $('td_process_reasoning').addEventListener('change', persist);
    $('td_show_ball').addEventListener('change', persist);
    $('td_runall_btn').addEventListener('click', () => { persist(); processLatestMessage().then(r => toast(r.msg)); });
    $('td_fix_btn').addEventListener('click', () => { persist(); processLatestMessageFix().then(r => { if (!r.ok) toast(r.msg, 'warning'); }); });
    $('td_llm_fix').addEventListener('change', persist);
    $('td_auto_fix').addEventListener('change', persist);

    // 来源开关显隐
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
    $('td_wi_refresh').addEventListener('click', () => { loadWorldInfoEntriesForUI(); renderWiList(); });
    $('td_preset_refresh').addEventListener('click', () => { loadPresetPromptsForUI(); renderPresetList(); });

    // 初次加载列表（若已开启）
    if (settings.formatSource?.useWorldInfo) { loadWorldInfoEntriesForUI(); renderWiList(); }
    if (settings.formatSource?.usePreset) { loadPresetPromptsForUI(); renderPresetList(); }
}

function collectChecked(listId) {
    const list = document.getElementById(listId);
    if (!list) return [];
    return Array.from(list.querySelectorAll('input[type=checkbox]:checked')).map(cb => cb.value);
}

function renderWiList() {
    const settings = getSettings();
    const selected = new Set(settings.formatSource?.selectedWiUids || []);
    const list = document.getElementById('td_wi_list');
    if (!list) return;
    if (!cachedWiEntries.length) {
        list.innerHTML = '<small style="opacity:.7">（无世界书条目，点刷新或检查角色卡/世界书）</small>';
        return;
    }
    list.innerHTML = cachedWiEntries.map(e => {
        const preview = (e.content || '').slice(0, 120).replace(/\s+/g, ' ');
        const checked = selected.has(e.uid) ? 'checked' : '';
        return `<label class="td_checkitem"><input type="checkbox" value="${escapeHtml(e.uid)}" ${checked}><span class="td_checktext"><b>[${escapeHtml(e.source)}]</b> ${escapeHtml(e.comment)}<br><small>${escapeHtml(preview)}…</small></span></label>`;
    }).join('');
}

function renderPresetList() {
    const settings = getSettings();
    const selected = new Set(settings.formatSource?.selectedPromptIds || []);
    const list = document.getElementById('td_preset_list');
    if (!list) return;
    if (!cachedPresetPrompts.length) {
        list.innerHTML = '<small style="opacity:.7">（无预设 prompt，点刷新或检查预设）</small>';
        return;
    }
    list.innerHTML = cachedPresetPrompts.map(p => {
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
            if (document.getElementById('td_wi_list')) { loadWorldInfoEntriesForUI(); renderWiList(); }
            if (document.getElementById('td_preset_list')) { loadPresetPromptsForUI(); renderPresetList(); }
        });
    } catch (e) { console.warn(TAG, '注册 CHAT_CHANGED 失败', e); }

    console.log(TAG, '已加载 v0.4.0');
});
