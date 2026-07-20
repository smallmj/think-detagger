// think-detagger - SillyTavern 扩展入口
// 在每轮对话接收完整（含 MVU 变量解析）后，把主对话 <think>/<thinking> 思考内容里
// 的"危险 tag"去掉 <>，防止酒馆助手/浏览器把未知 tag 当 HTML 解析而破坏渲染。
//
// 时机：MVU VARIABLE_UPDATE_ENDED 优先（最精确，变量已落盘）；未装 MVU 时回退
// MESSAGE_RECEIVED（MVU 存在时延迟执行，让 MVU 先写回，避免被覆盖）。
// 持久化：写回 chat[id].mes / extra.reasoning + saveChatDebounced + updateMessageBlock。
// 边界标签 <think>/<thinking> 本身保留，只对内部白名单 tag 去尖括号。

import {
    detagMes,
    detagReasoning,
    getDefaultSettings,
    DEFAULT_TAGS,
    MODULE_NAME,
} from './core.js';

// extension_settings 的 key（ST 习惯用下划线）
const SETTING_ID = 'think_detagger';
const TAG = `[${MODULE_NAME}]`;

// ---------- 设置读写 ----------
function getCtx() {
    return SillyTavern.getContext();
}

function getSettings() {
    const ctx = getCtx();
    const store = ctx.extensionSettings?.[SETTING_ID];
    if (!store) {
        const def = getDefaultSettings();
        ctx.extensionSettings[SETTING_ID] = def;
        return def;
    }
    // 兼容老数据 / 补全字段
    return Object.assign(getDefaultSettings(), store);
}

function saveSettings() {
    const ctx = getCtx();
    if (ctx.saveSettingsDebounced) ctx.saveSettingsDebounced();
}

// ---------- 依赖检测 ----------
function getMvu() {
    return typeof window !== 'undefined' && window.Mvu ? window.Mvu : null;
}

// 轮询等待 MVU 就绪（MVU 可能晚于本扩展加载）
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
function processMessage(messageId) {
    try {
        const settings = getSettings();
        if (!settings.enabled) return;
        if (messageId == null || messageId < 0) return;

        const ctx = getCtx();
        const chat = ctx.chat;
        if (!chat || !chat[messageId]) return;

        const msg = chat[messageId];
        if (msg.is_user || msg.is_system) return;

        const tags = settings.tags || DEFAULT_TAGS;
        let changed = false;

        // 1. 处理 mes 里的 think 区段（边界标签保留，内部去尖括号）
        if (msg.mes) {
            const r = detagMes(msg.mes, tags);
            if (r.changed) {
                msg.mes = r.mes;
                changed = true;
            }
        }

        // 2. 处理 extra.reasoning（原生 API 思考字段，整段去尖括号）
        if (settings.processReasoning && msg.extra && msg.extra.reasoning) {
            const r = detagReasoning(msg.extra.reasoning, tags);
            if (r.changed) {
                msg.extra.reasoning = r.reasoning;
                changed = true;
            }
        }

        if (!changed) return;

        // 3. 持久化 + 重渲
        const saveChatDebounced = ctx.saveChatDebounced || window.saveChatDebounced;
        const updateMessageBlock = ctx.updateMessageBlock || window.updateMessageBlock;
        if (saveChatDebounced) saveChatDebounced();
        if (updateMessageBlock) {
            try {
                updateMessageBlock(messageId, msg);
            } catch (e) {
                console.warn(TAG, 'updateMessageBlock 失败', e);
            }
        }
    } catch (e) {
        console.error(TAG, 'processMessage 异常', e);
    }
}

// ---------- 事件回调 ----------
function onMessageReceived(messageId, _type) {
    const settings = getSettings();
    if (!settings.enabled) return;
    // MVU 存在时延迟执行，让 MVU（含额外模型模式）先解析并写回，避免被覆盖。
    // 未装 MVU 时立即处理。
    const mvu = getMvu();
    if (mvu) {
        setTimeout(() => processMessage(messageId), 2000);
    } else {
        processMessage(messageId);
    }
}

function onVarUpdateEnded(...args) {
    const settings = getSettings();
    if (!settings.enabled) return;
    // MVU 事件载荷形态不确定，尝试多种取法
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

// ---------- 批处理：当前聊天所有 AI 消息 ----------
function processAllInChat() {
    try {
        const ctx = getCtx();
        const chat = ctx.chat;
        if (!chat) return 0;
        let count = 0;
        for (let i = 0; i < chat.length; i++) {
            const msg = chat[i];
            if (!msg || msg.is_user || msg.is_system) continue;
            processMessage(i);
            count++;
        }
        const saveChatDebounced = ctx.saveChatDebounced || window.saveChatDebounced;
        if (saveChatDebounced) saveChatDebounced();
        console.log(TAG, `批处理完成，扫描 ${count} 条 AI 消息`);
        return count;
    } catch (e) {
        console.error(TAG, 'processAllInChat 异常', e);
        return 0;
    }
}

// ---------- 设置面板 UI ----------
function renderSettingsPanel() {
    const ctx = getCtx();
    const container = document.getElementById('extensions_settings');
    if (!container) {
        console.warn(TAG, '未找到 #extensions_settings，设置面板未渲染');
        return;
    }
    if (document.getElementById('think_detagger_settings')) return; // 已渲染

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
                    <span>启用自动去 tag 化</span>
                </label>
                <label class="checkbox_label">
                    <input type="checkbox" id="td_process_reasoning" ${settings.processReasoning ? 'checked' : ''}>
                    <span>同时处理原生 reasoning (extra.reasoning)</span>
                </label>
                <div class="td_section">
                    <label for="td_tags"><small>危险 tag 白名单（一行一个；<b>think / thinking 是边界标签，勿加</b>）</small></label>
                    <textarea id="td_tags" rows="8" style="width:100%;font-family:monospace;font-size:small;">${(settings.tags || []).join('\n')}</textarea>
                </div>
                <div class="td_buttons">
                    <div class="menu_button" id="td_save_btn" title="保存白名单与开关">保存设置</div>
                    <div class="menu_button" id="td_runall_btn" title="立即处理当前聊天所有 AI 消息">立即处理全部消息</div>
                </div>
                <small class="td_hint">自动触发时机：MVU 变量更新结束后（装了 MVU 时）或消息接收后。手动命令：<code>/detag-all</code></small>
            </div>
        </div>
    `;
    container.appendChild(wrap);

    const $enabled = wrap.querySelector('#td_enabled');
    const $proc = wrap.querySelector('#td_process_reasoning');
    const $tags = wrap.querySelector('#td_tags');
    const $save = wrap.querySelector('#td_save_btn');
    const $runall = wrap.querySelector('#td_runall_btn');

    const persist = () => {
        const s = getSettings();
        s.enabled = !!$enabled.checked;
        s.processReasoning = !!$proc.checked;
        s.tags = $tags.value.split('\n').map(t => t.trim()).filter(Boolean);
        saveSettings();
    };

    $save.addEventListener('click', persist);
    $enabled.addEventListener('change', persist);
    $proc.addEventListener('change', persist);
    $runall.addEventListener('click', () => {
        persist();
        const n = processAllInChat();
        toastr?.success?.(`已处理 ${n} 条 AI 消息`) || alert(`已处理 ${n} 条 AI 消息`);
    });
}

// ---------- 斜杠命令 /detag-all ----------
function registerSlashCommand() {
    const ctx = getCtx();
    const register = ctx.registerSlashCommand || window.registerSlashCommand;
    if (!register) {
        console.warn(TAG, '未找到 registerSlashCommand，/detag-all 未注册（仍可用设置面板按钮）');
        return;
    }
    try {
        register('detag-all', () => {
            const n = processAllInChat();
            const msg = `已处理 ${n} 条 AI 消息`;
            if (typeof toastr !== 'undefined' && toastr.success) toastr.success(msg);
            return msg;
        }, [], '处理当前聊天所有 AI 消息的思考 tag', true, true);
        console.log(TAG, '已注册 /detag-all');
    } catch (e) {
        console.warn(TAG, '注册斜杠命令失败', e);
    }
}

// ---------- 入口 ----------
jQuery(async () => {
    // 确保设置对象存在
    const ctx = getCtx();
    if (!ctx.extensionSettings[SETTING_ID]) {
        ctx.extensionSettings[SETTING_ID] = getDefaultSettings();
    }

    renderSettingsPanel();
    registerSlashCommand();

    // 兜底：始终注册 MESSAGE_RECEIVED
    try {
        ctx.eventSource.on(ctx.event_types.MESSAGE_RECEIVED, onMessageReceived);
        console.log(TAG, '已注册 MESSAGE_RECEIVED');
    } catch (e) {
        console.error(TAG, '注册 MESSAGE_RECEIVED 失败', e);
    }

    // 异步等待 MVU，注册精确事件
    waitForMvu().then((mvu) => {
        if (!mvu) {
            console.log(TAG, '未检测到 MVU，仅使用 MESSAGE_RECEIVED 触发');
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
