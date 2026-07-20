// think-detagger - SillyTavern 扩展入口
// 在每轮对话接收完整（含 MVU 变量解析、额外模型生成）后，把模型输出中思考内容里的
// "危险 tag"去掉 <>，防止酒馆助手/浏览器把未知 tag 当 HTML 解析而破坏渲染。
//
// 触发（自动与手动都只处理最近一条 AI 回复）：
//  - 自动模式（enabled）：MVU VARIABLE_UPDATE_ENDED（最精确，立即）+
//    MESSAGE_RECEIVED / GENERATION_ENDED（防抖延迟 autoDelay 秒，让 MVU 先写回）
//  - 手动：悬浮球点击 / 设置面板按钮 / 斜杠命令 /detag
//    手动后会扫描思考区段内残留的未知 tag，提示是否加入白名单并自动重处理。
// 思考内容边界标签可自定义（thinkTags，默认 think/thinking），支持标准配对与仅收尾。
// 边界标签本身保留，只对内部白名单 tag 去尖括号。

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
        // 补全缺失字段（老数据升级时新字段可能缺失），直接合并到原对象
        const def = getDefaultSettings();
        const store = ctx.extensionSettings[SETTING_ID];
        for (const k of Object.keys(def)) {
            if (store[k] === undefined) store[k] = def[k];
        }
    }
    // 返回实际存储对象的引用，使修改能反映到 extensionSettings 并被 saveSettings 持久化
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

function waitForMvu(timeout = 10000) {
    return new Promise((resolve) => {
        if (window.Mvu) return resolve(window.Mvu);
        const start = Date.now();
        const timer = setInterval(() => {
            if (window.Mvu) {
                clearInterval(timer);
                resolve(window.Mvu);
            } else if (Date.now() - start > timeout) {
                clearInterval(timer);
                resolve(null);
            }
        }, 200);
    });
}

// ---------- 核心：处理单条消息 ----------
// 返回 { changed, removedTags }。force=true 时跳过 enabled 检查（手动触发用）。
function processMessage(messageId, { force = false } = {}) {
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
                try { updateMessageBlock(messageId, msg); }
                catch (e) { console.warn(TAG, 'updateMessageBlock 失败', e); }
            }
        }
        return { changed, removedTags: removed };
    } catch (e) {
        console.error(TAG, 'processMessage 异常', e);
        return empty;
    }
}

// ---------- 自动模式：防抖调度 ----------
let pendingTimer = null;
function scheduleProcess(messageId) {
    const settings = getSettings();
    if (!settings.enabled) return;
    const mvu = getMvu();
    const delay = mvu ? (Number(settings.autoDelay) || 0) * 1000 : 0;
    clearTimeout(pendingTimer);
    pendingTimer = setTimeout(() => processMessage(messageId), delay);
}

function onMessageReceived(messageId) {
    scheduleProcess(messageId);
}

function onGenerationEnded() {
    const chat = getCtx().chat;
    if (chat && chat.length > 0) scheduleProcess(chat.length - 1);
}

function onVarUpdateEnded(...args) {
    const settings = getSettings();
    if (!settings.enabled) return;
    let messageId = null;
    const a = args[0];
    if (typeof a === 'number') messageId = a;
    else if (a && typeof a === 'object') {
        messageId = a.message_id ?? a.messageId ?? a.id ?? null;
    }
    if (messageId == null) {
        const chat = getCtx().chat;
        messageId = chat ? chat.length - 1 : null;
    }
    processMessage(messageId);
}

// ---------- 手动：处理最近一条 AI 回复 ----------
// 返回 { ok, msg }，msg 为详细提示文案。会扫描残留未知 tag 并提示加入白名单+重处理。
function processLatestMessage() {
    try {
        const ctx = getCtx();
        const chat = ctx.chat;
        if (!chat || chat.length === 0) return { ok: false, msg: '未找到可处理的 AI 消息' };
        let idx = -1;
        for (let i = chat.length - 1; i >= 0; i--) {
            if (chat[i] && !chat[i].is_user && !chat[i].is_system) { idx = i; break; }
        }
        if (idx < 0) return { ok: false, msg: '未找到可处理的 AI 消息' };

        // 第一次处理
        const result = processMessage(idx, { force: true });
        const removed = new Set(result.removedTags);

        // 扫描思考区段内残留的未知 tag
        const settings = getSettings();
        const msgObj = chat[idx];
        const thinkTags = settings.thinkTags || BOUNDARY_TAGS;
        const knownTags = settings.tags || DEFAULT_TAGS;
        let unknown = [];
        if (msgObj.mes) unknown = findUnknownTags(msgObj.mes, thinkTags, knownTags, SAFE_HTML_TAGS);
        if (settings.processReasoning && msgObj.extra && msgObj.extra.reasoning) {
            const u2 = findUnknownTags(msgObj.extra.reasoning, thinkTags, knownTags, SAFE_HTML_TAGS);
            unknown = [...new Set([...unknown, ...u2])];
        }

        // 提示是否加入白名单并重处理
        let addedTags = [];
        if (unknown.length > 0) {
            const list = unknown.map(t => `<${t}>`).join('  ');
            if (confirm(`Think Detagger 发现思考内容中存在但未在危险名单的 tag：\n${list}\n\n是否将它们加入白名单并重新处理？`)) {
                settings.tags = [...new Set([...knownTags, ...unknown])];
                saveSettings();
                const r2 = processMessage(idx, { force: true });
                for (const t of r2.removedTags) removed.add(t);
                addedTags = unknown;
                // 同步设置面板 textarea（若已渲染）
                const $tags = document.getElementById('td_tags');
                if ($tags) $tags.value = settings.tags.join('\n');
            }
        }

        const saveChatDebounced = ctx.saveChatDebounced || window.saveChatDebounced;
        if (saveChatDebounced) saveChatDebounced();

        // 构建详细提示
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
        const r = processLatestMessage();
        toast(r.msg);
    });
}

function makeDraggable(el, onClick) {
    let dragging = false;
    let startX = 0, startY = 0, origX = 0, origY = 0, moved = false;

    el.addEventListener('mousedown', (e) => {
        dragging = true;
        moved = false;
        startX = e.clientX;
        startY = e.clientY;
        const rect = el.getBoundingClientRect();
        origX = rect.left;
        origY = rect.top;
        e.preventDefault();
    });
    document.addEventListener('mousemove', (e) => {
        if (!dragging) return;
        const dx = e.clientX - startX;
        const dy = e.clientY - startY;
        if (Math.abs(dx) > 4 || Math.abs(dy) > 4) moved = true;
        el.style.left = (origX + dx) + 'px';
        el.style.top = (origY + dy) + 'px';
        el.style.right = 'auto';
        el.style.bottom = 'auto';
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
    if (!container) {
        console.warn(TAG, '未找到 #extensions_settings，设置面板未渲染');
        return;
    }
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
                <label class="checkbox_label">
                    <input type="checkbox" id="td_enabled" ${settings.enabled ? 'checked' : ''}>
                    <span><b>自动模式</b>：每轮对话接收完整后（含额外模型解析）自动去标签</span>
                </label>
                <label class="checkbox_label">
                    <input type="checkbox" id="td_process_reasoning" ${settings.processReasoning ? 'checked' : ''}>
                    <span>同时处理原生 reasoning (extra.reasoning)</span>
                </label>
                <label class="checkbox_label">
                    <input type="checkbox" id="td_show_ball" ${settings.showFloatingBall ? 'checked' : ''}>
                    <span>显示悬浮球（点击手动去标签）</span>
                </label>
                <div class="td_section">
                    <label for="td_think_tags"><small>思考内容标签（边界标签，一行一个；如 think / thinking / reasoning / cot 等。这些标签本身保留，只处理其<b>内部</b>的 tag）</small></label>
                    <textarea id="td_think_tags" rows="3" class="td_textarea">${(settings.thinkTags || []).join('\n')}</textarea>
                </div>
                <div class="td_section">
                    <label for="td_tags"><small>危险 tag 白名单（一行一个；上面的思考标签勿重复加）</small></label>
                    <textarea id="td_tags" rows="8" class="td_textarea">${(settings.tags || []).join('\n')}</textarea>
                </div>
                <div class="td_section td_row">
                    <label for="td_auto_delay"><small>自动模式延迟（秒，装了 MVU 时等待变量解析；0=立即）</small></label>
                    <input type="number" id="td_auto_delay" min="0" max="60" step="1" value="${settings.autoDelay ?? 2}" class="td_number">
                </div>
                <div class="td_buttons">
                    <div class="menu_button" id="td_save_btn" title="保存设置">保存设置</div>
                    <div class="menu_button" id="td_runall_btn" title="手动处理最近一条 AI 回复">立即处理最近一条</div>
                </div>
                <small class="td_hint">自动与手动都只处理最近一条 AI 回复。手动：<code>/detag</code> 或悬浮球。手动后会提示补充未知 tag。</small>
            </div>
        </div>
    `;
    container.appendChild(wrap);

    const $enabled = wrap.querySelector('#td_enabled');
    const $proc = wrap.querySelector('#td_process_reasoning');
    const $ball = wrap.querySelector('#td_show_ball');
    const $thinkTags = wrap.querySelector('#td_think_tags');
    const $tags = wrap.querySelector('#td_tags');
    const $delay = wrap.querySelector('#td_auto_delay');
    const $save = wrap.querySelector('#td_save_btn');
    const $runall = wrap.querySelector('#td_runall_btn');

    const persist = () => {
        const s = getSettings();
        s.enabled = !!$enabled.checked;
        s.processReasoning = !!$proc.checked;
        s.showFloatingBall = !!$ball.checked;
        s.thinkTags = $thinkTags.value.split('\n').map(t => t.trim()).filter(Boolean);
        s.tags = $tags.value.split('\n').map(t => t.trim()).filter(Boolean);
        s.autoDelay = Number($delay.value) || 0;
        saveSettings();
        ensureFloatingBall();
    };

    $save.addEventListener('click', persist);
    $enabled.addEventListener('change', persist);
    $proc.addEventListener('change', persist);
    $ball.addEventListener('change', persist);
    $runall.addEventListener('click', () => {
        persist();
        const r = processLatestMessage();
        toast(r.msg);
    });
}

// ---------- 斜杠命令 ----------
function registerSlashCommand() {
    const ctx = getCtx();
    const register = ctx.registerSlashCommand || window.registerSlashCommand;
    if (!register) {
        console.warn(TAG, '未找到 registerSlashCommand，/detag 未注册（仍可用悬浮球/按钮）');
        return;
    }
    try {
        register('detag', () => {
            const r = processLatestMessage();
            toast(r.msg);
            return r.msg;
        }, [], '处理最近一条 AI 回复的思考 tag，并提示补充未知 tag', true, true);
        console.log(TAG, '已注册 /detag');
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
        ctx.eventSource.on(ctx.event_types.MESSAGE_RECEIVED, onMessageReceived);
        console.log(TAG, '已注册 MESSAGE_RECEIVED');
    } catch (e) {
        console.error(TAG, '注册 MESSAGE_RECEIVED 失败', e);
    }
    try {
        const genEvt = ctx.event_types.GENERATION_ENDED;
        if (genEvt) {
            ctx.eventSource.on(genEvt, onGenerationEnded);
            console.log(TAG, '已注册 GENERATION_ENDED');
        }
    } catch (e) {
        console.warn(TAG, '注册 GENERATION_ENDED 失败', e);
    }

    waitForMvu().then((mvu) => {
        if (!mvu) {
            console.log(TAG, '未检测到 MVU，使用 MESSAGE_RECEIVED + GENERATION_ENDED 触发');
            return;
        }
        const evtName = mvu.events && mvu.events.VARIABLE_UPDATE_ENDED;
        if (!evtName) {
            console.warn(TAG, 'MVU 存在但未暴露 VARIABLE_UPDATE_ENDED 事件');
            return;
        }
        try {
            ctx.eventSource.on(evtName, onVarUpdateEnded);
            console.log(TAG, '已注册 MVU VARIABLE_UPDATE_ENDED:', evtName);
        } catch (e) {
            console.warn(TAG, '注册 MVU 事件失败', e);
        }
    });

    console.log(TAG, '已加载');
});
