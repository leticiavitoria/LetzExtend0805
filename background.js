// ============================================
// LETZ SENDER - BACKGROUND v3.0.0
// ============================================

const CONFIG = {
    productSlug: "letz-sender",
    apiUrl: "https://dottiflow.com.br/api/v1",
    debug: false
};

const WINDOW_SIZES = {
    mini: { width: 420, height: 320 },
    normal: { width: 1200, height: 800 }
};

let isInitialized = false;
let veoWindowId = null;
let isWindowMini = false;
let _backgroundModeActive = true; // Segundo plano: true=mini window+overlay, false=maximizado

// ============================================
// CONFIG (licenca removida - uso pessoal)
// ============================================
let _serverConfig = {};

async function _ensureConfig() {
    return _serverConfig;
}

// ============================================
// SISTEMA DE FILA - v3.0.0 COM ESTADO COMPLETO
// ============================================
let promptQueue = [];
let processedPrompts = [];
let queueSettings = { promptDelay: 3000, batchSize: 20, batchInterval: 90000 };
let currentBatchCount = 0;
let queuePaused = false;
let isProcessingQueue = false;
let targetTabId = null;
let totalProcessed = 0;
let lastActivityTime = 0;
let queueMediaType = "video";
let firstPromptOfBatch = true;

// v3.0.0: API interception tracking
let _mediaIdToPrompt = {};

// ============================================
// INITIALIZATION
// ============================================
async function initApp() {
    isInitialized = true;
    setBadgeStatus("active");
    return true;
}

function setBadgeStatus(status) {
    if (status === "active") {
        chrome.action.setBadgeText({ text: "" });
        chrome.action.setBadgeBackgroundColor({ color: "#10b981" });
    } else if (status === "processing") {
        chrome.action.setBadgeText({ text: "\u25b6" });
        chrome.action.setBadgeBackgroundColor({ color: "#3b82f6" });
    } else {
        chrome.action.setBadgeText({ text: "!" });
        chrome.action.setBadgeBackgroundColor({ color: "#ef4444" });
    }
}

// ============================================
// WINDOW MANAGEMENT (restaurado do v2.0.0)
// ============================================
async function openVeoWindow(mini = true) {
    let win;
    if (mini) {
        const size = WINDOW_SIZES.mini;
        const displays = await chrome.system.display.getInfo();
        const pd = displays[0];
        win = await chrome.windows.create({
            url: "https://labs.google/fx/tools/flow",
            type: "popup",
            width: size.width,
            height: size.height,
            left: pd.workArea.width - size.width - 20,
            top: pd.workArea.height - size.height - 20,
            focused: true
        });
        isWindowMini = true;
    } else {
        win = await chrome.windows.create({
            url: "https://labs.google/fx/tools/flow",
            type: "popup",
            state: "maximized",
            focused: true
        });
        isWindowMini = false;
    }
    veoWindowId = win.id;
    if (win.tabs?.[0]) {
        targetTabId = win.tabs[0].id;
        await chrome.storage.local.set({ veoWindowId, veoTabId: targetTabId, isWindowMini });
    }
    return win;
}

async function toggleWindowSize() {
    if (!veoWindowId) return { success: false, error: "no_window" };
    try {
        isWindowMini = !isWindowMini;
        if (isWindowMini) {
            const size = WINDOW_SIZES.mini;
            const displays = await chrome.system.display.getInfo();
            const pd = displays[0];
            await chrome.windows.update(veoWindowId, {
                state: "normal",
                width: size.width,
                height: size.height,
                left: pd.workArea.width - size.width - 20,
                top: pd.workArea.height - size.height - 20
            });
            if (isProcessingQueue) {
                await injectStatusOverlay();
                await updateStatusOverlay("Processando...", totalProcessed, totalProcessed + promptQueue.length);
            }
        } else {
            await chrome.windows.update(veoWindowId, {
                state: "maximized"
            });
            await removeStatusOverlay();
        }
        await chrome.storage.local.set({ isWindowMini });
        return { success: true, isMini: isWindowMini };
    } catch (e) {
        return { success: false, error: e.message };
    }
}

async function focusVeoWindow() {
    if (!veoWindowId) return;
    try {
        if (isWindowMini && isProcessingQueue) {
            await chrome.windows.update(veoWindowId, { drawAttention: false });
        } else {
            await chrome.windows.update(veoWindowId, { focused: true });
        }
    } catch (e) {
        veoWindowId = null;
    }
}

chrome.windows.onRemoved.addListener((id) => {
    if (id === veoWindowId) {
        veoWindowId = null;
        targetTabId = null;
        chrome.storage.local.remove(['veoWindowId', 'veoTabId']);
    }
});

// ============================================
// STATUS OVERLAY (restaurado do v2.0.0)
// ============================================
async function injectStatusOverlay() {
    if (!targetTabId) return;
    try {
        await chrome.scripting.executeScript({
            target: { tabId: targetTabId },
            world: "MAIN",
            func: (iconUrl) => {
                document.getElementById("dotti-status-overlay")?.remove();
                let link = document.querySelector("link[rel*='icon']");
                if (!link) {
                    link = document.createElement('link');
                    link.rel = 'icon';
                    document.head.appendChild(link);
                }
                link.href = iconUrl;
                document.title = "Lets Automate";
                const o = document.createElement("div");
                o.id = "dotti-status-overlay";
                o.innerHTML = '<style>#dotti-status-overlay{position:fixed!important;top:0!important;left:0!important;right:0!important;bottom:0!important;width:100%!important;height:100%!important;margin:0!important;padding:20px!important;box-sizing:border-box!important;background:linear-gradient(135deg,#1a1a2e,#16213e)!important;z-index:999999!important;display:flex!important;flex-direction:column!important;align-items:center!important;justify-content:center!important;font-family:Segoe UI,Arial,sans-serif!important;color:#fff!important;pointer-events:none!important;transform:none!important;contain:none!important}#dotti-status-overlay .logo{font-size:64px!important;margin-bottom:20px!important}#dotti-status-overlay .title{font-size:28px!important;font-weight:700!important;margin-bottom:12px!important;background:linear-gradient(90deg,#00d4ff,#7b2cbf)!important;-webkit-background-clip:text!important;-webkit-text-fill-color:transparent!important}#dotti-status-overlay .status{font-size:16px!important;color:#a0a0a0!important;margin-bottom:24px!important}#dotti-status-overlay .pbar{width:80%!important;max-width:400px!important;height:8px!important;background:#2a2a4a!important;border-radius:4px!important;overflow:hidden!important;margin-bottom:20px!important}#dotti-status-overlay .pfill{height:100%!important;background:linear-gradient(90deg,#00d4ff,#7b2cbf)!important;border-radius:4px!important;transition:width .3s!important;width:0}#dotti-status-overlay .count{font-size:36px!important;font-weight:700!important;color:#00d4ff!important}#dotti-status-overlay .label{font-size:14px!important;color:#666!important;margin-top:8px!important}</style><div class="logo">&#9889;</div><div class="title">LETS AUTOMATE</div><div class="status" id="dso-status">Preparando...</div><div class="pbar"><div class="pfill" id="dso-progress"></div></div><div class="count" id="dso-count">0/0</div><div class="label">prompts enviados</div>';
                document.body.appendChild(o);
            },
            args: [chrome.runtime.getURL("icons/icon128.png")]
        });
    } catch (e) { }
}

async function updateStatusOverlay(status, current, total) {
    if (!targetTabId || !isWindowMini) return;
    try {
        await chrome.scripting.executeScript({
            target: { tabId: targetTabId },
            world: "MAIN",
            func: (s, c, t) => {
                const st = document.getElementById("dso-status");
                const pr = document.getElementById("dso-progress");
                const ct = document.getElementById("dso-count");
                if (st) st.textContent = s;
                if (ct) ct.textContent = c + "/" + t;
                if (pr) pr.style.width = (t > 0 ? (c / t) * 100 : 0) + "%";
            },
            args: [status, current, total]
        });
    } catch (e) { }
}

async function removeStatusOverlay() {
    if (!targetTabId) return;
    try {
        await chrome.scripting.executeScript({
            target: { tabId: targetTabId },
            world: "MAIN",
            func: () => document.getElementById("dotti-status-overlay")?.remove()
        });
    } catch (e) { }
}

// ============================================
// QUEUE PERSISTENCE - v3.0.0 ESTADO COMPLETO
// ============================================
async function saveQueueState() {
    // v3.5.0: Strip imageDataUrl from prompts before saving to avoid QUOTA_BYTES exceeded
    // Frame images as base64 can be several MB each, easily exceeding chrome.storage.local limits
    var queueToSave = promptQueue.map(function(p) {
        if (p.imageDataUrl) {
            var copy = Object.assign({}, p);
            delete copy.imageDataUrl;
            copy._hadImage = true; // Flag to know image was stripped
            return copy;
        }
        return p;
    });
    await chrome.storage.local.set({
        dottiQueue: queueToSave,
        dottiProcessedPrompts: processedPrompts,
        dottiSettings: queueSettings,
        dottiBatchCount: currentBatchCount,
        dottiPaused: queuePaused,
        dottiTabId: targetTabId,
        dottiProcessing: isProcessingQueue,
        dottiTotalProcessed: totalProcessed,
        dottiLastActivity: lastActivityTime,
        dottiMediaType: queueMediaType
    });
}

async function loadQueueState() {
    const data = await chrome.storage.local.get([
        'dottiQueue', 'dottiProcessedPrompts', 'dottiSettings', 'dottiBatchCount',
        'dottiPaused', 'dottiTabId', 'dottiProcessing', 'dottiTotalProcessed',
        'dottiLastActivity', 'dottiMediaType', 'veoTabId', 'veoWindowId', 'isWindowMini'
    ]);
    if (data.veoWindowId) {
        veoWindowId = data.veoWindowId;
    }
    isWindowMini = data.isWindowMini !== false;
    if (data.veoTabId) {
        targetTabId = data.veoTabId;
    }
    if (data.dottiQueue?.length > 0) {
        promptQueue = data.dottiQueue;
        processedPrompts = data.dottiProcessedPrompts || [];
        queueSettings = data.dottiSettings || queueSettings;
        currentBatchCount = data.dottiBatchCount || 0;
        queuePaused = data.dottiPaused || false;
        totalProcessed = data.dottiTotalProcessed || 0;
        lastActivityTime = data.dottiLastActivity || 0;
        queueMediaType = data.dottiMediaType || "video";
        isProcessingQueue = data.dottiProcessing || false;
        return true;
    }
    // Restaurar processedPrompts mesmo sem fila ativa
    if (data.dottiProcessedPrompts?.length > 0) {
        processedPrompts = data.dottiProcessedPrompts;
        totalProcessed = data.dottiTotalProcessed || 0;
    }
    return false;
}

async function clearQueueState() {
    promptQueue = [];
    processedPrompts = [];
    currentBatchCount = 0;
    isProcessingQueue = false;
    queuePaused = false;
    totalProcessed = 0;
    lastActivityTime = 0;
    queueMediaType = "video";
    await chrome.storage.local.remove([
        'dottiQueue', 'dottiProcessedPrompts', 'dottiSettings', 'dottiBatchCount',
        'dottiPaused', 'dottiTabId', 'dottiProcessing', 'dottiTotalProcessed',
        'dottiLastActivity', 'dottiMediaType'
    ]);
}

async function notifyTab(message) {
    if (!targetTabId) return;
    try {
        await chrome.tabs.sendMessage(targetTabId, message);
    } catch (e) {
        // Tab pode ter sido fechada - nao e critico
    }
}

// ============================================
// HELPERS
// ============================================
function sleep(ms) {
    return new Promise(r => setTimeout(r, ms));
}

// ============================================
// CHROME DEBUGGER — clicks com isTrusted=true (bypass antibot)
// ============================================
const _attachedDebuggerTabs = new Set();

async function attachDebugger(tabId) {
    if (_attachedDebuggerTabs.has(tabId)) return true;
    try {
        await new Promise((resolve, reject) => {
            chrome.debugger.attach({ tabId }, "1.3", () => {
                if (chrome.runtime.lastError) reject(new Error(chrome.runtime.lastError.message));
                else resolve();
            });
        });
        _attachedDebuggerTabs.add(tabId);
        console.log("[Dotti Debugger] attached to tab " + tabId);
        return true;
    } catch (e) {
        console.log("[Dotti Debugger] attach falhou:", e.message);
        return false;
    }
}

async function detachDebugger(tabId) {
    if (!_attachedDebuggerTabs.has(tabId)) return;
    try {
        await new Promise((resolve) => {
            chrome.debugger.detach({ tabId }, () => resolve());
        });
        _attachedDebuggerTabs.delete(tabId);
        console.log("[Dotti Debugger] detached from tab " + tabId);
    } catch (e) {
        _attachedDebuggerTabs.delete(tabId);
    }
}

function _sendDebuggerCmd(tabId, method, params) {
    return new Promise((resolve, reject) => {
        chrome.debugger.sendCommand({ tabId }, method, params, (result) => {
            if (chrome.runtime.lastError) reject(new Error(chrome.runtime.lastError.message));
            else resolve(result);
        });
    });
}

// Click trusted no centro de (x,y) em coordenadas CSS do viewport
async function trustedClickAt(tabId, x, y) {
    const ok = await attachDebugger(tabId);
    if (!ok) return { success: false, error: "attach_failed" };
    try {
        // Move mouse, mousePressed, mouseReleased — sequencia minima necessaria
        await _sendDebuggerCmd(tabId, "Input.dispatchMouseEvent", {
            type: "mouseMoved", x, y, button: "none", clickCount: 0
        });
        await sleep(20);
        await _sendDebuggerCmd(tabId, "Input.dispatchMouseEvent", {
            type: "mousePressed", x, y, button: "left", buttons: 1, clickCount: 1
        });
        await sleep(30);
        await _sendDebuggerCmd(tabId, "Input.dispatchMouseEvent", {
            type: "mouseReleased", x, y, button: "left", buttons: 0, clickCount: 1
        });
        return { success: true };
    } catch (e) {
        console.log("[Dotti Debugger] trustedClickAt erro:", e.message);
        return { success: false, error: e.message };
    }
}

// Limpa attach quando a aba fecha
chrome.tabs.onRemoved.addListener((tabId) => {
    if (_attachedDebuggerTabs.has(tabId)) {
        _attachedDebuggerTabs.delete(tabId);
    }
});

// Se o usuario fechar manualmente a barra "DevTools is debugging this tab"
chrome.debugger.onDetach.addListener((source, reason) => {
    if (source.tabId) {
        _attachedDebuggerTabs.delete(source.tabId);
        console.log("[Dotti Debugger] auto-detach tab " + source.tabId + " reason=" + reason);
    }
});

async function waitForCondition(tabId, conditionFn, args, timeout = 10000, interval = 300) {
    const startTime = Date.now();
    while (Date.now() - startTime < timeout) {
        try {
            const result = await chrome.scripting.executeScript({
                target: { tabId },
                world: "MAIN",
                func: conditionFn,
                args: args || []
            });
            if (result?.[0]?.result) return true;
        } catch (e) {
            // Tab pode nao estar pronta ainda
        }
        await sleep(interval);
    }
    return false;
}

// ============================================
// EXECUTE PROMPT - v3.0.0
// ============================================
async function executePromptInTab(prompt, mediaType) {
    console.log("[Dotti] Executing prompt", prompt.number);
    lastActivityTime = Date.now();

    // v3.0.0: Esperar pagina estar pronta (contenteditable textbox visivel)
    const pageReady = await waitForCondition(targetTabId, function () {
        const ta = document.querySelector("[role='textbox']");
        return ta && ta.offsetParent !== null;
    }, [], 15000, 500);

    if (!pageReady) {
        console.log("[Dotti] Page not ready after 15s");
        return { success: false, error: "page_not_ready" };
    }

    await sleep(200);

    const hasElements = prompt.elements?.length > 0;

    // Setup de output count so no PRIMEIRO prompt do lote
    if (firstPromptOfBatch) {
        console.log("[Dotti] Primeiro prompt - setup output count");

        const outCount = queueSettings.outputCount || 1;
        if (outCount > 1) {
            console.log("[Dotti] Definindo outputs per prompt =", outCount);
            try {
                const setResult = await Promise.race([
                    chrome.tabs.sendMessage(targetTabId, {
                        action: "SET_OUTPUTS_PER_PROMPT",
                        count: outCount
                    }),
                    sleep(10000).then(() => ({ timeout: true }))
                ]);
                console.log("[Dotti] SET_OUTPUTS_PER_PROMPT result:", JSON.stringify(setResult));
                await sleep(1000);
            } catch (e) {
                console.log("[Dotti] SET_OUTPUTS_PER_PROMPT failed:", e.message);
            }
        }

        firstPromptOfBatch = false;
        console.log("[Dotti] Setup completo - prosseguindo com prompt");
    }

    // Delay de seguranca antes dos steps
    await sleep(800);

    console.log("[Dotti] Iniciando steps 1-5 (mode=" + mediaType + ", hasElements=" + hasElements + ")");

    try {
        // 1. Trocar modo Video/Imagem
        console.log("[Dotti] Step 1: selecionando modo", mediaType);

        const simulateClickScript = `
            window.__dottiClick = function(el) {
                const rect = el.getBoundingClientRect();
                const x = rect.left + rect.width / 2;
                const y = rect.top + rect.height / 2;
                const opts = { bubbles: true, cancelable: true, view: window, clientX: x, clientY: y, screenX: x, screenY: y, button: 0, detail: 1 };
                el.dispatchEvent(new PointerEvent("pointerover", { ...opts, pointerId: 1, pointerType: "mouse" }));
                el.dispatchEvent(new PointerEvent("pointerenter", { ...opts, pointerId: 1, pointerType: "mouse" }));
                el.dispatchEvent(new MouseEvent("mouseover", opts));
                el.dispatchEvent(new MouseEvent("mouseenter", opts));
                el.dispatchEvent(new PointerEvent("pointerdown", { ...opts, pointerId: 1, pointerType: "mouse" }));
                el.dispatchEvent(new MouseEvent("mousedown", opts));
                el.focus && el.focus();
                el.dispatchEvent(new PointerEvent("pointerup", { ...opts, pointerId: 1, pointerType: "mouse" }));
                el.dispatchEvent(new MouseEvent("mouseup", opts));
                el.dispatchEvent(new MouseEvent("click", opts));
            };
        `;
        await chrome.scripting.executeScript({
            target: { tabId: targetTabId },
            world: "MAIN",
            func: (script) => { eval(script); },
            args: [simulateClickScript]
        });

        // Step 1a: Abrir seletor de modo
        const openResult = await chrome.scripting.executeScript({
            target: { tabId: targetTabId },
            world: "MAIN",
            func: () => {
                const tb = document.querySelector("[role='textbox']");
                if (!tb) return { found: false, reason: "no_textbox" };
                const tbY = tb.getBoundingClientRect().top;
                let modeBtn = null;
                let modeBtnText = "";
                document.querySelectorAll("button").forEach(b => {
                    if (b.offsetParent === null) return;
                    const r = b.getBoundingClientRect();
                    if (Math.abs(r.top - tbY) < 100 && r.width > 60 && r.width < 200) {
                        const t = b.textContent.toLowerCase();
                        if (t.indexOf("crop") >= 0 || t.indexOf("videocam") >= 0 || t.indexOf("movie") >= 0 || t.indexOf("image") >= 0 || t.indexOf("video") >= 0) {
                            modeBtn = b;
                            modeBtnText = t;
                        }
                    }
                });
                if (!modeBtn) return { found: false, reason: "no_mode_btn" };
                window.__dottiClick(modeBtn);
                return { found: true, text: modeBtnText };
            }
        });
        const or = openResult?.[0]?.result;
        console.log("[Dotti] Step 1a open selector:", JSON.stringify(or));
        await sleep(1200);

        // Step 1b: Clicar na tab do modo correto
        const modeResult = await chrome.scripting.executeScript({
            target: { tabId: targetTabId },
            world: "MAIN",
            func: (targetMode) => {
                const tabs = document.querySelectorAll('button[role="tab"]');
                const allTabTexts = Array.from(tabs).map(t => ({
                    text: t.textContent.trim().toLowerCase(),
                    visible: t.offsetParent !== null,
                    selected: t.getAttribute("aria-selected")
                }));
                let targetTab = null;
                for (const tab of tabs) {
                    if (tab.offsetParent === null) continue;
                    const t = tab.textContent.trim().toLowerCase();
                    if (targetMode === "image" && t === "imageimage") { targetTab = tab; break; }
                    if (targetMode === "video" && t === "videocamvideo") { targetTab = tab; break; }
                }
                if (!targetTab) {
                    for (const tab of tabs) {
                        if (tab.offsetParent === null) continue;
                        const t = tab.textContent.trim().toLowerCase();
                        if (targetMode === "image" && t.indexOf("image") >= 0 && t.indexOf("view") < 0) { targetTab = tab; break; }
                        if (targetMode === "video" && t.indexOf("video") >= 0 && t.indexOf("view") < 0) { targetTab = tab; break; }
                    }
                }
                if (!targetTab) {
                    return { clicked: false, tabs: allTabTexts };
                }
                const wasSel = targetTab.getAttribute("aria-selected");
                window.__dottiClick(targetTab);
                const nowSel = targetTab.getAttribute("aria-selected");
                return { clicked: true, tab: targetTab.textContent.trim(), before: wasSel, after: nowSel, allTabs: allTabTexts };
            },
            args: [mediaType]
        });
        const mr = modeResult?.[0]?.result;
        console.log("[Dotti] Step 1b tab click:", JSON.stringify(mr));
        await sleep(1000);

        // Step 1c: selecionar duracao do video (4s/6s/8s) — apenas para video/frame
        if (mediaType === "video" || mediaType === "frame") {
            const targetDuration = (prompt.duration === 4 || prompt.duration === 6 || prompt.duration === 8) ? prompt.duration : 8;

            // Garante que o popup do Veo esteja aberto (Step 1a pode ter fechado apos Step 1b)
            const popupCheck = await chrome.scripting.executeScript({
                target: { tabId: targetTabId },
                world: "MAIN",
                func: () => {
                    const all = document.querySelectorAll('button, [role="button"], [role="radio"], [role="option"], [role="tab"]');
                    for (const el of all) {
                        if (el.offsetParent === null) continue;
                        const txt = (el.textContent || "").replace(/\s+/g, "").toLowerCase();
                        if (txt === "4s" || txt === "6s" || txt === "8s") return true;
                    }
                    return false;
                }
            });
            const popupOpen = !!popupCheck?.[0]?.result;
            if (!popupOpen) {
                console.log("[Dotti] Step 1c: popup fechado, reabrindo...");
                await chrome.scripting.executeScript({
                    target: { tabId: targetTabId },
                    world: "MAIN",
                    func: () => {
                        const tb = document.querySelector("[role='textbox']");
                        if (!tb) return false;
                        const tbY = tb.getBoundingClientRect().top;
                        let modeBtn = null;
                        document.querySelectorAll("button").forEach(b => {
                            if (b.offsetParent === null) return;
                            const r = b.getBoundingClientRect();
                            if (Math.abs(r.top - tbY) < 100 && r.width > 60 && r.width < 200) {
                                const t = b.textContent.toLowerCase();
                                if (t.indexOf("crop") >= 0 || t.indexOf("videocam") >= 0 || t.indexOf("movie") >= 0 || t.indexOf("image") >= 0 || t.indexOf("video") >= 0) {
                                    modeBtn = b;
                                }
                            }
                        });
                        if (modeBtn) window.__dottiClick(modeBtn);
                        return !!modeBtn;
                    }
                });
                await sleep(900);
            }

            const durResult = await chrome.scripting.executeScript({
                target: { tabId: targetTabId },
                world: "MAIN",
                func: (durSec) => {
                    const wanted = durSec + "s";
                    const candidates = document.querySelectorAll('button, [role="button"], [role="tab"], [role="option"], [role="radio"]');
                    const visible = [];
                    let target = null;
                    for (const el of candidates) {
                        if (el.offsetParent === null) continue;
                        const txt = (el.textContent || "").replace(/\s+/g, "").toLowerCase();
                        if (txt === "4s" || txt === "6s" || txt === "8s") {
                            visible.push(txt);
                            if (txt === wanted) target = el;
                        }
                    }
                    if (!target) return { clicked: false, wanted: wanted, visible: visible };
                    window.__dottiClick(target);
                    return { clicked: true, wanted: wanted, visible: visible };
                },
                args: [targetDuration]
            });
            console.log("[Dotti] Step 1c duration:", JSON.stringify(durResult?.[0]?.result));
            await sleep(600);
        }

        // Fechar seletor clicando no textbox
        await chrome.scripting.executeScript({
            target: { tabId: targetTabId },
            world: "MAIN",
            func: () => {
                const tb = document.querySelector("[role='textbox']");
                if (tb) window.__dottiClick(tb);
            }
        });
        await sleep(500);
        console.log("[Dotti] Step 1 modo selecionado:", mediaType);

        // 2. Clear elements anexados ao prompt (APENAS perto do textbox, NAO na galeria)
        try {
            await chrome.scripting.executeScript({
                target: { tabId: targetTabId },
                world: "MAIN",
                func: () => {
                    const ta = document.querySelector("[role='textbox']");
                    if (!ta) return;
                    const taRect = ta.getBoundingClientRect();

                    document.querySelectorAll("button").forEach(btn => {
                        if (btn.offsetParent === null) return;
                        const icon = btn.querySelector("i");
                        if (!icon) return;
                        const iconText = icon.textContent?.trim();
                        if (iconText !== "close" && iconText !== "clear") return;

                        const btnRect = btn.getBoundingClientRect();
                        if (Math.abs(btnRect.top - taRect.top) > 200) return;

                        const parent = btn.parentElement;
                        if (!parent || !parent.querySelector("img")) return;

                        console.log("[Dotti DOM] Removendo elemento anexado ao prompt");
                        btn.click();
                    });
                }
            });
        } catch (e) {
            console.log("[Dotti] Step 2 clear error (non-fatal):", e.message);
        }
        await sleep(600);

        // 3. Add elements (referencias da galeria) ou Frame upload
        if (mediaType === "frame" && prompt.imageDataUrl) {
            console.log("[Dotti] Step 3: Frame Upload (image to video)");

            const uploadResult = await chrome.scripting.executeScript({
                target: { tabId: targetTabId },
                world: "MAIN",
                func: async (dataUrl, imageName) => {
                    const wait = ms => new Promise(r => setTimeout(r, ms));
                    const click = async (el) => {
                        if (!el) return;
                        el.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }));
                        el.dispatchEvent(new PointerEvent('pointerup', { bubbles: true }));
                        el.dispatchEvent(new MouseEvent('click', { bubbles: true }));
                    };

                    try {
                        const fetchResp = await fetch(dataUrl);
                        const blob = await fetchResp.blob();
                        const file = new File([blob], imageName, { type: 'image/png' });

                        const fileInput = document.querySelector('input[type="file"][accept*="image"]') || document.querySelector('input[type="file"]');
                        if (!fileInput) return { success: false, step: "no_input" };

                        fileInput.value = '';
                        const dt = new DataTransfer();
                        dt.items.add(file);
                        fileInput.files = dt.files;
                        fileInput.dispatchEvent(new Event('change', { bubbles: true }));

                        await wait(2500);

                        let startBtn = null;
                        const emptySlots = document.querySelectorAll('div[class*="sc-8f31d1ba-1"], div[type="button"][aria-haspopup="dialog"]');
                        for (const slot of emptySlots) {
                            const text = (slot.textContent || '').trim().toLowerCase();
                            if (text === 'start' || text === 'início' || text === 'inicio') { startBtn = slot; break; }
                        }
                        if (!startBtn) {
                            const divBtns = document.querySelectorAll('div[type="button"]');
                            for (const div of divBtns) {
                                const text = (div.textContent || '').trim().toLowerCase();
                                if (text === 'start' || text === 'início' || text === 'inicio') { startBtn = div; break; }
                            }
                        }
                        if (!startBtn) return { success: false, step: "no_start_btn" };
                        await click(startBtn);
                        await wait(1500);

                        const dialog = document.querySelector('[role="dialog"][data-state="open"]') || document.querySelector('[role="dialog"]');
                        if (!dialog) return { success: false, step: "no_dialog" };

                        const sortBtns = dialog.querySelectorAll('button');
                        for (const btn of sortBtns) {
                            const text = (btn.textContent || '').trim().toLowerCase();
                            if (text.includes('recently') || text.includes('newest') || text.includes('oldest') || text.includes('most used') || text.includes('recente') || text.includes('antigo')) {
                                if (!text.includes('newest') && !text.includes('recente')) {
                                    await click(btn);
                                    await wait(800);
                                    const menuItems = document.querySelectorAll('[role="menuitem"], [role="option"], [data-radix-collection-item]');
                                    for (const item of menuItems) {
                                        if ((item.textContent || '').trim().toLowerCase().includes('newest') || (item.textContent || '').trim().toLowerCase().includes('recente')) {
                                            await click(item);
                                            await wait(800);
                                            break;
                                        }
                                    }
                                }
                                break;
                            }
                        }

                        const searchInput = dialog.querySelector('input[type="text"]') || dialog.querySelector('input[placeholder*="Search"]') || dialog.querySelector('input');
                        if (searchInput) {
                            searchInput.focus();
                            searchInput.value = '';
                            searchInput.dispatchEvent(new Event('input', { bubbles: true }));
                            await wait(300);
                            searchInput.value = imageName;
                            searchInput.dispatchEvent(new Event('input', { bubbles: true }));
                            searchInput.dispatchEvent(new Event('change', { bubbles: true }));
                            await wait(1500);
                        }

                        let assetSelected = false;
                        let searchWait = 10000;
                        while (searchWait > 0 && !assetSelected) {
                            const currentDialog = document.querySelector('[role="dialog"]');
                            if (!currentDialog) { assetSelected = true; break; }

                            const assetItems = currentDialog.querySelectorAll('[class*="sc-5bf79b14"]');
                            const assetImgs = currentDialog.querySelectorAll('img[src*="getMediaUrlRedirect"]');

                            if (assetItems.length > 0 || assetImgs.length > 0) {
                                let clickTarget = assetItems.length > 0 ? assetItems[0] : (assetImgs[0].closest('[class*="sc-5bf79b14"]') || assetImgs[0]);
                                await click(clickTarget);
                                await wait(1000);
                                if (!document.querySelector('[role="dialog"]')) { assetSelected = true; break; }

                                if (assetImgs.length > 0) {
                                    await click(assetImgs[0]);
                                    await wait(1000);
                                    if (!document.querySelector('[role="dialog"]')) { assetSelected = true; break; }
                                }
                            }
                            await wait(500);
                            searchWait -= 500;
                        }
                        if (!assetSelected) {
                            document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
                            return { success: false, step: "no_asset_selected" };
                        }
                        return { success: true };
                    } catch (e) {
                        return { success: false, step: e.message };
                    }
                },
                args: [prompt.imageDataUrl, prompt.imageName]
            });
            const upRes = uploadResult?.[0]?.result;
            if (!upRes || !upRes.success) {
                console.log("[Dotti] Frame upload failed at step:", upRes?.step);
                return { success: false, error: "frame_upload_failed" };
            }
            await sleep(1500);

        } else if (hasElements) {
            const selectedOriginalIndices = [];
            for (const elementNum of prompt.elements) {
                const openResult = await chrome.scripting.executeScript({
                    target: { tabId: targetTabId },
                    world: "MAIN",
                    func: () => {
                        const allBtns = [...document.querySelectorAll("button")].filter(b => b.offsetParent !== null);
                        let addBtn = allBtns.find(b => {
                            const icon = b.querySelector("i");
                            return icon && icon.textContent.trim() === "add_2";
                        });
                        if (!addBtn) {
                            const tb = document.querySelector("[role='textbox']");
                            const tbY = tb ? tb.getBoundingClientRect().top : 0;
                            addBtn = allBtns.find(b => {
                                const icon = b.querySelector("i");
                                if (!icon) return false;
                                const t = icon.textContent.trim().toLowerCase();
                                if (t !== "add" && t !== "add_circle" && t !== "add_photo_alternate") return false;
                                return Math.abs(b.getBoundingClientRect().top - tbY) < 200;
                            });
                        }
                        if (!addBtn) { console.log("[Dotti DOM] Botao add galeria NAO encontrado"); return false; }
                        console.log("[Dotti DOM] Clicando add_2 via .click()");
                        addBtn.click();
                        return true;
                    }
                });
                if (!openResult?.[0]?.result) {
                    console.log("[Dotti] gallery_failed for element", elementNum);
                    return { success: false, error: "gallery_failed" };
                }

                await waitForCondition(targetTabId, function () {
                    return document.querySelectorAll('[role="dialog"] img').length > 0 ||
                        document.querySelectorAll('[data-state="open"] img').length > 0;
                }, [], 8000, 300);
                await sleep(500);

                // Ordenar por "Mais antigo" (Oldest)
                await chrome.scripting.executeScript({
                    target: { tabId: targetTabId },
                    world: "MAIN",
                    func: () => {
                        const dialog = document.querySelector('[role="dialog"]');
                        if (!dialog) return;
                        let sortBtn = null;
                        dialog.querySelectorAll("button").forEach(b => {
                            if (b.textContent.indexOf("arrow_drop_down") >= 0) sortBtn = b;
                        });
                        if (!sortBtn) { console.log("[Dotti DOM] Sort btn nao encontrado"); return; }
                        if (sortBtn.textContent.indexOf("antigo") >= 0 || sortBtn.textContent.indexOf("ldest") >= 0) {
                            console.log("[Dotti DOM] Ja esta em Mais antigo");
                            return;
                        }
                        console.log("[Dotti DOM] Abrindo sort dropdown...");
                        sortBtn.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true }));
                        sortBtn.dispatchEvent(new PointerEvent("pointerup", { bubbles: true }));
                        sortBtn.dispatchEvent(new MouseEvent("click", { bubbles: true }));
                    }
                });
                await sleep(1000);

                // Clicar em "Mais antigo" / "Oldest"
                await chrome.scripting.executeScript({
                    target: { tabId: targetTabId },
                    world: "MAIN",
                    func: () => {
                        const items = document.querySelectorAll('[role="menuitem"], [data-radix-collection-item]');
                        for (const item of items) {
                            const t = item.textContent.trim();
                            if (t.indexOf("antigo") >= 0 || t.indexOf("ldest") >= 0) {
                                console.log("[Dotti DOM] Selecionando:", t);
                                item.click();
                                return;
                            }
                        }
                        document.querySelectorAll("div, span, button, li, a").forEach(el => {
                            const t = el.textContent.trim();
                            const r = el.getBoundingClientRect();
                            if (r.width > 0 && r.height > 10 && r.width < 300 && t.length < 30) {
                                if ((t.indexOf("antigo") >= 0 || t === "Oldest") && el.children.length === 0) {
                                    console.log("[Dotti DOM] Selecionando (fallback):", t);
                                    el.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true }));
                                    el.dispatchEvent(new PointerEvent("pointerup", { bubbles: true }));
                                    el.dispatchEvent(new MouseEvent("click", { bubbles: true }));
                                }
                            }
                        });
                    }
                });
                await sleep(1500);

                const originalIdx = elementNum - 1;
                let adjustedIdx = originalIdx;
                for (const prevIdx of selectedOriginalIndices) {
                    if (prevIdx < originalIdx) adjustedIdx--;
                }
                console.log("[Dotti] Element", elementNum, "-> originalIdx:", originalIdx, "adjustedIdx:", adjustedIdx, "prevSelected:", selectedOriginalIndices);

                const selectResult = await chrome.scripting.executeScript({
                    target: { tabId: targetTabId },
                    world: "MAIN",
                    func: (idx) => {
                        const dialog = document.querySelector('[role="dialog"]') || document.querySelector('[data-state="open"]');
                        if (!dialog) { console.log("[Dotti DOM] Dialog nao encontrado"); return false; }
                        const imgs = dialog.querySelectorAll("img");
                        console.log("[Dotti DOM] Gallery imgs:", imgs.length, "selecting idx:", idx);
                        if (idx < imgs.length) {
                            imgs[idx].click();
                            return true;
                        }
                        console.log("[Dotti DOM] Indice", idx, "fora do range (max:", imgs.length - 1, ")");
                        return false;
                    },
                    args: [adjustedIdx]
                });
                if (!selectResult?.[0]?.result) return { success: false, error: "element_select_failed" };
                selectedOriginalIndices.push(originalIdx);
                await sleep(1500);

                // Fechar dialog se ainda estiver aberto
                await chrome.scripting.executeScript({
                    target: { tabId: targetTabId },
                    world: "MAIN",
                    func: () => {
                        const dialog = document.querySelector('[role="dialog"]');
                        if (!dialog) return;
                        const btns = dialog.querySelectorAll("button");
                        for (const btn of btns) {
                            const icon = btn.querySelector("i");
                            const t = icon ? icon.textContent.trim() : "";
                            if (t === "close" || t === "done" || t === "check") {
                                btn.click();
                                return;
                            }
                        }
                        const overlay = dialog.parentElement;
                        if (overlay && overlay !== document.body) {
                            overlay.click();
                        }
                    }
                });
                await sleep(800);
            }
        }

        // 4. Fill textbox via Slate API
        console.log("[Dotti] Step 4: fill textbox via Slate API");
        const fillResult = await chrome.scripting.executeScript({
            target: { tabId: targetTabId },
            world: "MAIN",
            func: (text) => {
                const ta = document.querySelector("[role='textbox']");
                if (!ta) { console.log("[Dotti DOM] textbox NOT FOUND"); return false; }
                const fk = Object.keys(ta).find(k => k.startsWith("__reactFiber$"));
                if (!fk) { console.log("[Dotti DOM] React fiber NOT FOUND"); return false; }
                let fiber = ta[fk], editor = null;
                for (let i = 0; i < 50 && fiber; i++) {
                    if (fiber.memoizedProps?.editor?.insertText) { editor = fiber.memoizedProps.editor; break; }
                    if (fiber.memoizedProps?.value?.insertText) { editor = fiber.memoizedProps.value; break; }
                    fiber = fiber.return;
                }
                if (!editor) { console.log("[Dotti DOM] Slate editor NOT FOUND"); return false; }
                editor.withoutNormalizing(() => {
                    try {
                        editor.select({ anchor: editor.start([]), focus: editor.end([]) });
                        editor.deleteFragment();
                    } catch (e) { }
                    editor.insertText(text);
                });
                console.log("[Dotti DOM] Slate filled:", editor.children[0]?.children[0]?.text?.substring(0, 50));
                return true;
            },
            args: [prompt.text]
        });
        if (!fillResult?.[0]?.result) return { success: false, error: "fill_failed" };

        await waitForCondition(targetTabId, function () {
            const ta = document.querySelector("[role='textbox']");
            if (!ta) return false;
            const text = ta.textContent || "";
            return text.length > 30 || (text.length > 0 && !text.includes("O que voc"));
        }, [], 5000, 300);
        await sleep(500);

        // 5. Click submit
        console.log("[Dotti] Step 5: submit");
        const clickResult = await chrome.scripting.executeScript({
            target: { tabId: targetTabId },
            world: "MAIN",
            func: () => {
                for (const btn of document.querySelectorAll("button")) {
                    if (btn.offsetParent === null) continue;
                    const icon = btn.querySelector("i");
                    if (icon?.textContent?.trim() === "arrow_forward") {
                        console.log("[Dotti DOM] Submit btn found");
                        btn.click();
                        return true;
                    }
                }
                console.log("[Dotti DOM] Submit button NOT FOUND");
                return false;
            }
        });
        if (!clickResult?.[0]?.result) return { success: false, error: "submit_failed" };

        const submitted = await waitForCondition(targetTabId, function () {
            const ta = document.querySelector("[role='textbox']");
            if (!ta) return true;
            const text = ta.textContent || "";
            if (text.includes("O que voc") && text.length < 40) return true;
            if (text.trim().length === 0) return true;
            for (const btn of document.querySelectorAll("button")) {
                const icon = btn.querySelector("i");
                if (icon?.textContent?.trim() === "arrow_forward" && btn.disabled) return true;
            }
            return false;
        }, [], 10000, 500);

        if (!submitted) {
            console.log("[Dotti] Submit not confirmed, retrying...");
            await chrome.scripting.executeScript({
                target: { tabId: targetTabId },
                world: "MAIN",
                func: () => {
                    for (const btn of document.querySelectorAll("button")) {
                        if (btn.offsetParent === null) continue;
                        if (btn.querySelector("i")?.textContent?.trim() === "arrow_forward") {
                            btn.click();
                            return true;
                        }
                    }
                }
            });
            await sleep(2000);
        }

        console.log("[Dotti] Prompt", prompt.number, "OK");
        return { success: true };
    } catch (e) {
        console.error("[Dotti] Execute error:", e.message);
        return { success: false, error: e.message };
    }
}

// ============================================
// QUEUE PROCESSING - v3.0.0
// ============================================
async function processNextPrompt() {
    console.log("[Dotti] processNextPrompt called, queue:", promptQueue.length, "paused:", queuePaused, "processing:", isProcessingQueue);
    if (promptQueue.length === 0 || queuePaused) {
        if (promptQueue.length === 0 && isProcessingQueue && totalProcessed > 0) {
            isProcessingQueue = false;
            setBadgeStatus("active");
            try { await saveQueueState(); } catch (_sqe) { }
            await sleep(3000);
            await removeStatusOverlay();
            if (veoWindowId) {
                try {
                    await chrome.windows.update(veoWindowId, {
                        state: "maximized",
                        focused: true
                    });
                    isWindowMini = false;
                } catch (e) { }
            }
            notifyTab({ action: "QUEUE_COMPLETE", data: { total: totalProcessed } });
            // Detach debugger ao terminar a fila (remove a barra amarela)
            if (targetTabId) detachDebugger(targetTabId).catch(() => {});
        }
        return;
    }

    isProcessingQueue = true;
    setBadgeStatus("processing");
    lastActivityTime = Date.now();

    const prompt = promptQueue[0];
    const totalInQueue = totalProcessed + promptQueue.length;

    await updateStatusOverlay("Enviando PROMPT " + prompt.number + "...", totalProcessed, totalInQueue);

    // v3.0.0: Limpar galeria/elementos antes de cada prompt
    try {
        await chrome.tabs.sendMessage(targetTabId, { action: "PREPARE_FOR_NEXT_PROMPT" });
        await sleep(800);
    } catch (e) { }

    notifyTab({ action: "PROMPT_STARTING", data: prompt });

    const result = await executePromptInTab(prompt, queueMediaType);
    console.log("[Dotti] Prompt", prompt.number, "result:", JSON.stringify(result));

    // Se janela/tab fechada, parar fila inteira
    if (!result.success && result.error === "window_closed") {
        isProcessingQueue = false;
        queuePaused = true;
        setBadgeStatus("active");
        notifyTab({ action: "QUEUE_ERROR", data: { message: "Janela do Veo foi fechada" } });
        try { await saveQueueState(); } catch (_sqe) { }
        return;
    }

    // Retry melhorado - maximo 3 tentativas com delay extra
    if (!result.success && (prompt.retryCount || 0) < 3) {
        prompt.retryCount = (prompt.retryCount || 0) + 1;
        console.log("[Dotti] Retry", prompt.retryCount, "for prompt", prompt.number, "error:", result.error);
        try { await saveQueueState(); } catch (_sqe) { }
        await sleep(3000);
        await processNextPrompt();
        return;
    }

    // Registrar resultado
    prompt.status = result.success ? "sent" : "error";
    if (!result.success) prompt.error = result.error;
    await updateStatusOverlay("PROMPT " + prompt.number + " enviado!", totalProcessed, totalInQueue);
    notifyTab({ action: "PROMPT_RESULT", data: { ...prompt, result } });

    // Log persistente de resultados
    logPromptResult(prompt, queueMediaType);

    // Mover para processedPrompts
    promptQueue.shift();
    processedPrompts.push({ ...prompt });
    currentBatchCount++;
    totalProcessed++;
    lastActivityTime = Date.now();

    try { await saveQueueState(); } catch (_sqe) { }

    if (promptQueue.length > 0 && !queuePaused) {
        let delay = queueSettings.promptDelay;
        if (currentBatchCount >= queueSettings.batchSize) {
            const batchDelay = queueMediaType === "video"
                ? Math.max(queueSettings.batchInterval, 180000)
                : Math.max(queueSettings.batchInterval, 90000);
            await updateStatusOverlay("Aguardando proximo lote...", totalProcessed, totalProcessed + promptQueue.length);
            notifyTab({
                action: "BATCH_PAUSE",
                data: { remaining: promptQueue.length, interval: batchDelay }
            });
            delay = batchDelay;
            currentBatchCount = 0;
        }
        chrome.alarms.create("dottiNextPrompt", { when: Date.now() + delay });
    } else if (promptQueue.length === 0 && totalProcessed > 0) {
        isProcessingQueue = false;
        setBadgeStatus("active");
        try { await saveQueueState(); } catch (_sqe) { }
        await sleep(3000);
        await removeStatusOverlay();
        // Maximizar janela SOMENTE se estava minimizada (segundo plano ativo)
        if (veoWindowId && isWindowMini) {
            try {
                await chrome.windows.update(veoWindowId, {
                    state: "maximized",
                    focused: true
                });
                isWindowMini = false;
            } catch (e) { }
        }
        notifyTab({ action: "QUEUE_COMPLETE", data: { total: totalProcessed } });
    }
}

async function startQueue(prompts, settings, tabId, mediaType, bgMode) {
    if (!tabId && targetTabId) tabId = targetTabId;
    if (!tabId) return { success: false, error: "no_tab" };

    // v3.1.0: Se ja esta processando, logar aviso (content.js tratará a re-entrada)
    if (isProcessingQueue) {
        console.log("[Dotti] startQueue: sobrescrevendo fila anterior (isProcessingQueue era true)");
    }

    promptQueue = [...prompts];
    processedPrompts = [];
    queueSettings = {
        promptDelay: (settings.promptDelay || 3) * 1000,
        batchSize: settings.batchSize || 20,
        batchInterval: (settings.batchInterval || 90) * 1000,
        outputCount: settings.outputCount || 1
    };
    currentBatchCount = 0;
    queuePaused = false;
    targetTabId = tabId;
    totalProcessed = 0;
    firstPromptOfBatch = true;
    isProcessingQueue = true;
    lastActivityTime = Date.now();
    queueMediaType = mediaType || "video";
    // Salvar flag de segundo plano para uso no resume/complete
    _backgroundModeActive = bgMode !== false;

    setBadgeStatus("processing");

    // Persist veoTabId
    await chrome.storage.local.set({ veoTabId: targetTabId });
    try { await saveQueueState(); } catch (_sqe) { console.log("[Dotti] saveQueueState falhou (nao-critico):", _sqe.message); }

    // Minimizar janela + overlay SOMENTE se segundo plano ativado
    let winId = null;
    try {
        const tab = await chrome.tabs.get(targetTabId);
        winId = tab.windowId;
        veoWindowId = winId;
    } catch (e) {
        winId = veoWindowId;
    }
    if (winId && _backgroundModeActive) {
        try {
            const wi = await chrome.windows.get(winId);
            if (wi.state === "maximized" || wi.state === "fullscreen") {
                await chrome.windows.update(winId, { state: "normal" });
            }
            const size = WINDOW_SIZES.mini;
            const displays = await chrome.system.display.getInfo();
            const pd = displays[0];
            await chrome.windows.update(winId, {
                width: size.width,
                height: size.height,
                left: pd.workArea.width - size.width - 20,
                top: pd.workArea.height - size.height - 20
            });
            isWindowMini = true;
            await chrome.storage.local.set({ isWindowMini: true, veoWindowId: winId });
        } catch (e) { }
        await injectStatusOverlay();
        await updateStatusOverlay("Iniciando...", 0, promptQueue.length);
    } else if (winId) {
        // Segundo plano desativado: manter janela maximizada
        try {
            await chrome.windows.update(winId, { state: "maximized" });
            isWindowMini = false;
            await chrome.storage.local.set({ isWindowMini: false, veoWindowId: winId });
        } catch (e) { }
    }
    await sleep(2000);

    // v3.0.0: Enviar START_AUTOMATION ao content.js para processamento simultaneo
    const maxSim = settings.maxSimultaneous || 3;
    console.log("[Dotti] startQueue: enviando START_AUTOMATION ao content.js, " + prompts.length + " prompts, " + maxSim + " slots");
    try {
        await chrome.tabs.sendMessage(targetTabId, {
            action: 'START_AUTOMATION',
            prompts: prompts,
            settings: {
                promptDelay: settings.promptDelay || 3,
                batchSize: settings.batchSize || 20,
                batchInterval: settings.batchInterval || 90,
                outputCount: settings.outputCount || 1,
                maxSimultaneous: maxSim
            },
            mediaType: mediaType,
            folder: settings.folder || 'LetzVideos',
            autoDownload: true
        });
    } catch (e) {
        console.error("[Dotti] Erro ao enviar START_AUTOMATION:", e);
        return { success: false, error: e.message };
    }
    return { success: true };
}

async function pauseQueue() {
    queuePaused = true;
    isProcessingQueue = false;
    chrome.alarms.clear("dottiNextPrompt");
    try { await saveQueueState(); } catch (_sqe) { }
    await updateStatusOverlay("Pausado", totalProcessed, totalProcessed + promptQueue.length);
    setBadgeStatus("active");
}

async function resumeQueue(bgMode) {
    queuePaused = false;
    isProcessingQueue = true;
    lastActivityTime = Date.now();
    firstPromptOfBatch = true;
    // Atualizar flag se fornecido
    if (bgMode !== undefined) _backgroundModeActive = bgMode !== false;
    try { await saveQueueState(); } catch (_sqe) { }

    // Re-minimizar janela + overlay SOMENTE se segundo plano ativado
    let winId = null;
    try {
        const tab = await chrome.tabs.get(targetTabId);
        winId = tab.windowId;
        veoWindowId = winId;
    } catch (e) {
        winId = veoWindowId;
    }
    if (winId && _backgroundModeActive) {
        try {
            const wi = await chrome.windows.get(winId);
            if (wi.state === "maximized" || wi.state === "fullscreen") {
                await chrome.windows.update(winId, { state: "normal" });
            }
            const size = WINDOW_SIZES.mini;
            const displays = await chrome.system.display.getInfo();
            const pd = displays[0];
            await chrome.windows.update(winId, {
                width: size.width,
                height: size.height,
                left: pd.workArea.width - size.width - 20,
                top: pd.workArea.height - size.height - 20
            });
            isWindowMini = true;
        } catch (e) { }
        await injectStatusOverlay();
        await updateStatusOverlay("Retomando...", totalProcessed, totalProcessed + promptQueue.length);
    }
    await sleep(1000);
    processNextPrompt();
    return { success: true };
}

async function cancelQueue() {
    queuePaused = true;
    isProcessingQueue = false;
    chrome.alarms.clear("dottiNextPrompt");
    await clearQueueState();
    await removeStatusOverlay();
    setBadgeStatus("active");
}

// v3.0.0: Reset completo - limpa fila e tracking
async function fullReset() {
    await cancelQueue();
    _mediaIdToPrompt = {};
    await chrome.storage.local.remove([
        'dottiPromptLog'
    ]);
    console.log("[Dotti] Full reset completo - cache e log limpos");
}

// Log persistente de prompts para reenvio preciso
async function logPromptResult(prompt, mediaType) {
    try {
        const data = await chrome.storage.local.get('dottiPromptLog');
        const log = data.dottiPromptLog || [];
        log.push({
            number: prompt.number,
            text: (prompt.text || "").substring(0, 100),
            elements: prompt.elements || [],
            status: prompt.status,
            error: prompt.error || null,
            mediaType: mediaType,
            timestamp: Date.now()
        });
        if (log.length > 500) log.splice(0, log.length - 500);
        await chrome.storage.local.set({ dottiPromptLog: log });
    } catch (e) {
        console.log("[Dotti] Erro ao salvar log:", e.message);
    }
}

async function updatePromptLog(promptNumber, mediaType, mediaStatus) {
    try {
        const data = await chrome.storage.local.get('dottiPromptLog');
        const log = data.dottiPromptLog || [];
        for (let i = log.length - 1; i >= 0; i--) {
            if (log[i].number === promptNumber && log[i].mediaType === mediaType) {
                log[i].mediaStatus = mediaStatus;
                log[i].lastUpdate = Date.now();
                break;
            }
        }
        await chrome.storage.local.set({ dottiPromptLog: log });
    } catch (e) { }
}

// ============================================
// ALARMS - v3.0.0 COM BOOT GATE + WATCHDOG
// ============================================
chrome.alarms.onAlarm.addListener(async (alarm) => {
    await _bootPromise;

    if (alarm.name === "dottiKeepAlive") {
        if (isProcessingQueue && !queuePaused && promptQueue.length > 0) {
            lastActivityTime = Date.now();
        }
    } else if (alarm.name === "dottiNextPrompt") {
        processNextPrompt();
    } else if (alarm.name === "dottiWatchdog") {
        if (isProcessingQueue && !queuePaused && promptQueue.length > 0) {
            const timeSinceLastActivity = Date.now() - lastActivityTime;
            if (timeSinceLastActivity > 3 * 60 * 1000) {
                console.log("[Dotti] Watchdog: Queue stuck for", Math.round(timeSinceLastActivity / 1000), "s. Retrying...");
                firstPromptOfBatch = true;
                lastActivityTime = Date.now();
                processNextPrompt().catch(e => console.error("[Dotti] Watchdog stuck retry error:", e));
            }
        }
        if (!isProcessingQueue && !queuePaused && promptQueue.length > 0 && totalProcessed > 0) {
            console.log("[Dotti] Watchdog: Queue has", promptQueue.length, "pending but not processing. Resuming...");
            isProcessingQueue = true;
            firstPromptOfBatch = true;
            setBadgeStatus("processing");
            lastActivityTime = Date.now();
            processNextPrompt().catch(e => console.error("[Dotti] Watchdog resume error:", e));
        }
    }
});

chrome.alarms.create("dottiKeepAlive", { periodInMinutes: 0.3 });
chrome.alarms.create("dottiWatchdog", { periodInMinutes: 0.33 });

// ============================================
// MESSAGE HANDLER - v3.0.0
// ============================================
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    (async () => {
        try {
            await _bootPromise;
            if (!isInitialized) await initApp();
            switch (message.action) {
                case "GET_STATUS":
                    sendResponse({
                        isInitialized: true,
                        hasLicense: true,
                        licenseInfo: null,
                        hasServerConfig: true,
                        queueLength: promptQueue.length,
                        isProcessing: isProcessingQueue,
                        isPaused: queuePaused
                    });
                    break;

                case "GET_FULL_STATE":
                    sendResponse({
                        isProcessing: isProcessingQueue,
                        isPaused: queuePaused,
                        promptQueue: promptQueue,
                        processedPrompts: processedPrompts,
                        totalProcessed: totalProcessed,
                        queueSettings: queueSettings,
                        lastActivity: lastActivityTime,
                        mediaType: queueMediaType,
                        mediaIdMapCount: Object.keys(_mediaIdToPrompt).length,
                        hasVeoWindow: !!veoWindowId,
                        isWindowMini: isWindowMini,
                        veoTabId: targetTabId
                    });
                    break;

                case "ACTIVATE_LICENSE":
                    sendResponse({ success: true });
                    break;

                case "DEACTIVATE_LICENSE":
                    sendResponse({ success: true });
                    break;

                case "VERIFY_SESSION_FOR_SENDING":
                    sendResponse({ valid: true, hasConfig: true });
                    break;

                case "START_QUEUE":
                    sendResponse(await startQueue(message.prompts, message.settings, message.tabId || targetTabId, message.mediaType, message.backgroundMode));
                    break;

                case "TRUSTED_CLICK": {
                    const tid = sender?.tab?.id || targetTabId;
                    const r = await trustedClickAt(tid, message.x, message.y);
                    sendResponse(r);
                    break;
                }

                case "DETACH_DEBUGGER": {
                    const tid = sender?.tab?.id || targetTabId;
                    await detachDebugger(tid);
                    sendResponse({ success: true });
                    break;
                }

                case "PAUSE_QUEUE":
                    await pauseQueue();
                    sendResponse({ success: true });
                    break;

                case "RESUME_QUEUE":
                    sendResponse(await resumeQueue(message.backgroundMode));
                    break;

                case "CANCEL_QUEUE":
                    await cancelQueue();
                    // Tambem parar automacao no content.js
                    if (targetTabId) {
                        try { await chrome.tabs.sendMessage(targetTabId, { action: 'STOP_AUTOMATION' }); } catch (e) {}
                    }
                    sendResponse({ success: true });
                    break;

                // v3.0.0: POLICY_ERROR_REWRITE — reescrever prompt via API do servidor
                case "POLICY_ERROR_REWRITE":
                    (async () => {
                        try {
                            const response = await fetch(CONFIG.apiUrl + '/ai/rewrite-prompt', {
                                method: 'POST',
                                headers: {
                                    'Content-Type': 'application/json',
                                    'X-Product-Slug': CONFIG.productSlug
                                },
                                body: JSON.stringify({
                                    prompt: message.prompt,
                                    provider: 'gemini'
                                })
                            });
                            const data = await response.json();
                            if (data.rewritten) {
                                console.log('[Dotti] Prompt reescrito com sucesso');
                                sendResponse({ success: true, rewrittenPrompt: data.rewritten });
                            } else {
                                sendResponse({ success: false, error: data.error || 'No rewritten prompt' });
                            }
                        } catch (e) {
                            console.error('[Dotti] Erro ao reescrever prompt:', e);
                            sendResponse({ success: false, error: e.message });
                        }
                    })();
                    return true; // async sendResponse

                // v3.0.0: HARD_RESET_STARTED — content.js iniciou hard reset
                case "HARD_RESET_STARTED":
                    (async () => {
                        try {
                            const resumeIdx = message.resumeFromIndex;
                            console.log('[Dotti] Hard Reset iniciado, resumeFromIndex=' + resumeIdx);
                            isProcessingQueue = false;
                            queuePaused = true;

                            // Iniciar cooldown de 45s
                            let countdown = 45;
                            const cooldownInterval = setInterval(async () => {
                                countdown--;
                                if (countdown % 10 === 0 && countdown > 0) {
                                    console.log('[Dotti] Hard Reset cooldown: ' + countdown + 's restantes...');
                                    await updateStatusOverlay('Hard Reset: ' + countdown + 's...', 0, 0);
                                }
                                if (countdown <= 0) {
                                    clearInterval(cooldownInterval);
                                    console.log('[Dotti] Hard Reset cooldown completo! Navegando de volta ao Flow...');

                                    // Encontrar tab do cooldown e navegar de volta
                                    try {
                                        const tabs = await chrome.tabs.query({ url: ['*://dottiflow.com.br/*'] });
                                        if (tabs.length > 0) {
                                            await chrome.tabs.update(tabs[0].id, { url: 'https://labs.google/fx/tools/flow' });
                                            targetTabId = tabs[0].id;

                                            // Esperar pagina carregar (5s) e enviar RESUME
                                            setTimeout(async () => {
                                                try {
                                                    await chrome.tabs.sendMessage(targetTabId, {
                                                        action: 'RESUME_AFTER_HARD_RESET',
                                                        resumeFromIndex: resumeIdx
                                                    });
                                                    console.log('[Dotti] RESUME_AFTER_HARD_RESET enviado');
                                                    isProcessingQueue = true;
                                                    queuePaused = false;
                                                    setBadgeStatus("processing");
                                                } catch (e) {
                                                    console.error('[Dotti] Erro ao retomar apos Hard Reset:', e);
                                                }
                                            }, 8000);
                                        } else {
                                            // Tab nao encontrada — tentar abrir nova
                                            console.error('[Dotti] Tab de cooldown nao encontrada');
                                        }
                                    } catch (e) {
                                        console.error('[Dotti] Erro ao navegar de volta:', e);
                                    }
                                }
                            }, 1000);

                            sendResponse({ success: true });
                        } catch (e) {
                            sendResponse({ success: false, error: e.message });
                        }
                    })();
                    return true;

                // v3.0.0: QUEUE_STATUS_UPDATE — content.js reporta progresso
                case "QUEUE_STATUS_UPDATE":
                    (async () => {
                        try {
                            const { sent, total, generating, completed, failed } = message;
                            totalProcessed = completed || 0;
                            lastActivityTime = Date.now();
                            if (_backgroundModeActive) {
                                await updateStatusOverlay(
                                    'Enviados: ' + (sent || 0) + '/' + (total || 0) + ' | Gerados: ' + (completed || 0),
                                    completed || 0,
                                    total || 0
                                );
                            }
                            if (generating > 0) setBadgeStatus("processing");
                        } catch (e) {}
                        sendResponse({ success: true });
                    })();
                    return true;

                // v3.0.0: QUEUE_COMPLETE do content.js (processamento simultaneo terminou)
                // Este handler complementa o existente — content.js notifica quando processAllPromptsWithSlots() termina
                case "QUEUE_COMPLETE_FROM_CONTENT":
                    (async () => {
                        try {
                            isProcessingQueue = false;
                            // v3.1.0: Limpar fila para evitar que o watchdog re-envie os prompts
                            promptQueue = [];
                            queuePaused = false;
                            try { await saveQueueState(); } catch (_sqe) { }
                            setBadgeStatus("active");
                            await removeStatusOverlay();
                            if (veoWindowId && isWindowMini) {
                                try {
                                    await chrome.windows.update(veoWindowId, { state: "maximized", focused: true });
                                    isWindowMini = false;
                                } catch (e) {}
                            }
                        } catch (e) {}
                        sendResponse({ success: true });
                    })();
                    return true;

                // v3.0.0: POLICY_ERROR relay do content.js para panel
                case "POLICY_ERROR":
                    // Relay para o panel via notifyTab (que envia postMessage ao iframe)
                    notifyTab({ action: "POLICY_ERROR", data: message });
                    sendResponse({ success: true });
                    break;

                case "FULL_RESET":
                    await fullReset();
                    sendResponse({ success: true });
                    break;

                case "INJECT_FETCH_INTERCEPT":
                    (async () => {
                        try {
                            const tabId = sender.tab?.id;
                            if (!tabId) { sendResponse({ success: false }); return; }
                            const count = message.count || 1;
                            await chrome.scripting.executeScript({
                                target: { tabId },
                                world: "MAIN",
                                func: (desiredCount) => {
                                    if (window.__dottiFetchInterceptInstalled) {
                                        window.__dottiOutputCount = desiredCount;
                                        console.log("[Dotti Inject] Output count atualizado para", desiredCount);
                                        return;
                                    }
                                    window.__dottiOutputCount = desiredCount;
                                    window.__dottiFetchInterceptInstalled = true;

                                    window.addEventListener('__dotti_set_output_count', (e) => {
                                        window.__dottiOutputCount = parseInt(e.detail?.count) || 1;
                                        console.log("[Dotti Inject] Output count via event:", window.__dottiOutputCount);
                                    });

                                    const origFetch = window.fetch;
                                    window.fetch = async function (...args) {
                                        let [url, options] = args;
                                        const cnt = window.__dottiOutputCount;
                                        if (cnt > 1 && options?.body && typeof url === 'string' &&
                                            (url.includes('aisandbox-pa.googleapis.com') || url.includes('generativelanguage') || url.includes('labs.google'))) {
                                            try {
                                                const bodyStr = typeof options.body === 'string' ? options.body : null;
                                                if (bodyStr && bodyStr.startsWith('{')) {
                                                    const body = JSON.parse(bodyStr);
                                                    let modified = false;

                                                    function deepModify(obj) {
                                                        if (typeof obj !== 'object' || obj === null) return false;
                                                        let found = false;
                                                        for (const key of Object.keys(obj)) {
                                                            const kl = key.toLowerCase();
                                                            if (kl === 'samplecount' || kl === 'sample_count' ||
                                                                kl === 'candidatecount' || kl === 'candidate_count' ||
                                                                kl === 'numoutputs' || kl === 'num_outputs' ||
                                                                (kl === 'count' && typeof obj[key] === 'number')) {
                                                                obj[key] = cnt;
                                                                found = true;
                                                            }
                                                            if (typeof obj[key] === 'object') {
                                                                if (deepModify(obj[key])) found = true;
                                                            }
                                                        }
                                                        return found;
                                                    }

                                                    modified = deepModify(body);

                                                    if (!modified && body.parameters) {
                                                        body.parameters.sampleCount = cnt;
                                                        modified = true;
                                                    }
                                                    if (!modified) {
                                                        body.sampleCount = cnt;
                                                        modified = true;
                                                    }

                                                    if (modified) {
                                                        options = Object.assign({}, options, { body: JSON.stringify(body) });
                                                        console.log("[Dotti Inject] Request modificado: sampleCount=" + cnt);
                                                    }
                                                }
                                            } catch (e) {
                                                // Body nao eh JSON, ignorar
                                            }
                                        }
                                        return origFetch.apply(this, [url, options]);
                                    };

                                    const origXHRSend = XMLHttpRequest.prototype.send;
                                    XMLHttpRequest.prototype.send = function (body) {
                                        const cnt = window.__dottiOutputCount;
                                        if (cnt > 1 && body && typeof body === 'string' && body.startsWith('{')) {
                                            const url = this._dottiUrl || '';
                                            if (url.includes('aisandbox-pa.googleapis.com') || url.includes('generativelanguage') || url.includes('labs.google')) {
                                                try {
                                                    const parsed = JSON.parse(body);
                                                    let modified = false;
                                                    function deepModify(obj) {
                                                        if (typeof obj !== 'object' || obj === null) return false;
                                                        let found = false;
                                                        for (const key of Object.keys(obj)) {
                                                            const kl = key.toLowerCase();
                                                            if (kl === 'samplecount' || kl === 'sample_count' ||
                                                                kl === 'candidatecount' || kl === 'candidate_count' ||
                                                                (kl === 'count' && typeof obj[key] === 'number')) {
                                                                obj[key] = cnt;
                                                                found = true;
                                                            }
                                                            if (typeof obj[key] === 'object') {
                                                                if (deepModify(obj[key])) found = true;
                                                            }
                                                        }
                                                        return found;
                                                    }
                                                    modified = deepModify(parsed);
                                                    if (!modified) { parsed.sampleCount = cnt; }
                                                    body = JSON.stringify(parsed);
                                                    console.log("[Dotti Inject XHR] Request modificado: sampleCount=" + cnt);
                                                } catch (e) { }
                                            }
                                        }
                                        return origXHRSend.call(this, body);
                                    };

                                    const origXHROpen = XMLHttpRequest.prototype.open;
                                    XMLHttpRequest.prototype.open = function (method, url, ...rest) {
                                        this._dottiUrl = url;
                                        return origXHROpen.call(this, method, url, ...rest);
                                    };

                                    console.log("[Dotti Inject] Fetch/XHR intercept instalado, count=" + desiredCount);
                                },
                                args: [count]
                            });
                            sendResponse({ success: true });
                        } catch (e) {
                            console.log("[Dotti] Inject fetch intercept error:", e.message);
                            sendResponse({ success: false, error: e.message });
                        }
                    })();
                    return true;

                case "GET_PROMPT_LOG":
                    chrome.storage.local.get('dottiPromptLog', (data) => {
                        sendResponse({ log: data.dottiPromptLog || [] });
                    });
                    return true;

                case "UPDATE_PROMPT_LOG":
                    updatePromptLog(message.promptNumber, message.mediaType, message.mediaStatus);
                    sendResponse({ success: true });
                    break;

                case "GET_QUEUE_STATUS":
                    sendResponse({
                        queueLength: promptQueue.length,
                        isProcessing: isProcessingQueue,
                        isPaused: queuePaused,
                        currentBatch: currentBatchCount,
                        settings: queueSettings,
                        totalProcessed: totalProcessed
                    });
                    break;

                case "VIDEO_SUBMITTED": {
                    const { media } = message;
                    if (media && Array.isArray(media)) {
                        for (const entry of media) {
                            if (entry.mediaId) {
                                _mediaIdToPrompt[entry.mediaId] = {
                                    prompt: entry.prompt || "",
                                    timestamp: Date.now()
                                };
                            }
                        }
                    }
                    sendResponse({ success: true });
                    break;
                }

                case "VIDEO_STATUS_UPDATE": {
                    const { updates } = message;
                    // v3.1.0 EXTEND: encaminhar updates p/ scene queue
                    try { extendOnVideoStatus(updates); } catch (e) { console.log("[Extend] status hook err:", e.message); }
                    sendResponse({ success: true });
                    break;
                }

                case "DOWNLOAD_VIDEO": {
                    const { url, filename, folder } = message;
                    if (!url) { sendResponse({ success: false, error: "no_url" }); break; }
                    const fullPath = folder ? folder + "/" + filename : filename;
                    try {
                        const downloadId = await chrome.downloads.download({
                            url: url,
                            filename: fullPath,
                            conflictAction: "uniquify",
                            saveAs: false
                        });
                        console.log("[Dotti] Download video started:", downloadId, fullPath);
                        sendResponse({ success: true, downloadId });
                    } catch (e) {
                        console.error("[Dotti] Download video error:", e);
                        sendResponse({ success: false, error: e.message });
                    }
                    break;
                }

                case "DOWNLOAD_IMAGE": {
                    const { url, filename, folder } = message;
                    if (!url) { sendResponse({ success: false, error: "no_url" }); break; }
                    const fullPath = folder ? folder + "/" + filename : filename;
                    try {
                        const downloadId = await chrome.downloads.download({
                            url: url,
                            filename: fullPath,
                            conflictAction: "uniquify",
                            saveAs: false
                        });
                        console.log("[Dotti] Download image started:", downloadId, fullPath);
                        sendResponse({ success: true, downloadId });
                    } catch (e) {
                        console.error("[Dotti] Download image error:", e);
                        sendResponse({ success: false, error: e.message });
                    }
                    break;
                }

                case "GET_SETTINGS":
                    chrome.storage.local.get([
                        "autoDownload", "backgroundMode", "batchSize", "batchInterval", "promptDelay",
                        "videoFolder", "imageFolder", "frameFolder", "videoResolution", "imageResolution",
                        "videoOutputCount", "imageOutputCount"
                    ], (s) => {
                        sendResponse({
                            autoDownload: s.autoDownload !== false,
                            backgroundMode: s.backgroundMode !== false,
                            batchSize: s.batchSize || 20,
                            batchInterval: s.batchInterval || 90,
                            promptDelay: s.promptDelay || 3,
                            videoFolder: s.videoFolder || "LetzVideos",
                            imageFolder: s.imageFolder || "LetzImagens",
                            frameFolder: s.frameFolder || "LetzFrameVideos",
                            videoResolution: s.videoResolution || "720",
                            imageResolution: s.imageResolution || "1024",
                            videoOutputCount: s.videoOutputCount || 1,
                            imageOutputCount: s.imageOutputCount || 1
                        });
                    });
                    return true;

                case "SAVE_SETTINGS":
                    chrome.storage.local.set(message.settings, () => sendResponse({ success: true }));
                    return true;

                case "GET_ACTIVE_TAB":
                    if (targetTabId) {
                        sendResponse({ tabId: targetTabId, url: "https://labs.google/fx/tools/flow" });
                    } else {
                        const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
                        sendResponse({ tabId: tab?.id, url: tab?.url });
                    }
                    break;

                case "KEEP_ALIVE":
                    sendResponse({ alive: true });
                    break;

                case "GET_AUTO_NEW_PROJECT":
                    const autoData = await chrome.storage.local.get("dottiAutoNewProject");
                    if (autoData.dottiAutoNewProject) {
                        await chrome.storage.local.remove("dottiAutoNewProject");
                        sendResponse({ autoNewProject: true });
                    } else {
                        sendResponse({ autoNewProject: false });
                    }
                    break;

                case "CHECK_FEATURE":
                    sendResponse({ allowed: true });
                    break;

                case "GET_FEATURE_LIMIT":
                    sendResponse({ limit: 99999 });
                    break;

                case "GET_SESSION_STATUS":
                    sendResponse({
                        active: true,
                        info: null,
                        hasConfig: true,
                        sessionToken: false
                    });
                    break;

                case "OPEN_VEO_WINDOW":
                    const win = await openVeoWindow(message.mini !== false);
                    sendResponse({ success: true, windowId: win.id, tabId: targetTabId });
                    break;

                case "TOGGLE_WINDOW_SIZE":
                    sendResponse(await toggleWindowSize());
                    break;

                case "FOCUS_VEO_WINDOW":
                    await focusVeoWindow();
                    sendResponse({ success: true });
                    break;

                case "MINIMIZE_WINDOW":
                    try {
                        const fw = await chrome.windows.getLastFocused();
                        if (fw.state === "maximized" || fw.state === "fullscreen") {
                            await chrome.windows.update(fw.id, { state: "normal" });
                        }
                        const size = WINDOW_SIZES.mini;
                        const displays = await chrome.system.display.getInfo();
                        const pd = displays[0];
                        await chrome.windows.update(fw.id, {
                            width: size.width,
                            height: size.height,
                            left: pd.workArea.width - size.width - 20,
                            top: pd.workArea.height - size.height - 20
                        });
                        isWindowMini = true;
                        veoWindowId = fw.id;
                        sendResponse({ success: true });
                    } catch (e) {
                        sendResponse({ success: false, error: e.message });
                    }
                    break;

                case "GET_SELECTORS":
                    sendResponse({ success: true, selectors: {} });
                    break;

                // v3.1.0 EXTEND: enfileirar cenas
                case "EXTEND_START_QUEUE":
                    sendResponse(await extendStartQueue(message.scenes, message.folder, message.useLite));
                    break;

                case "EXTEND_STOP_QUEUE":
                    extendStopQueue();
                    sendResponse({ success: true });
                    break;

                // v3.1.0 EXTEND: handlers vindos do content.js
                case "EXTEND_BASE_SUBMITTED":
                    extendOnBaseSubmitted(message.sceneNumber, message.mediaId);
                    sendResponse({ success: true });
                    break;

                case "EXTEND_EXT_SUBMITTED":
                    extendOnExtSubmitted(message.sceneNumber, message.mediaId);
                    sendResponse({ success: true });
                    break;

                case "EXTEND_STEP_FAILED":
                    extendOnStepFailed(message.sceneNumber, message.reason);
                    sendResponse({ success: true });
                    break;

                default:
                    sendResponse({ error: "Unknown action" });
            }
        } catch (e) {
            sendResponse({ error: e.message });
        }
    })();
    return true;
});

// ============================================
// ACTION & STARTUP
// ============================================
chrome.action.onClicked.addListener(async () => {
    await _bootPromise;

    if (veoWindowId) {
        await focusVeoWindow();
        if (targetTabId) {
            try {
                await chrome.tabs.sendMessage(targetTabId, { action: "TOGGLE_PANEL" });
            } catch (e) { }
        }
    } else {
        await openVeoWindow(false);
    }
});

chrome.runtime.onInstalled.addListener(async () => {
    await _bootPromise;

    try {
        await chrome.contentSettings.automaticDownloads.set({
            primaryPattern: 'https://labs.google/*',
            setting: 'allow'
        });
        console.log("[Dotti] Downloads automaticos permitidos para labs.google");
    } catch (e) {
        console.log("[Dotti] Nao foi possivel configurar downloads automaticos:", e.message);
    }
});

chrome.runtime.onStartup.addListener(async () => {
    await _bootPromise;
    if (!queuePaused && promptQueue.length > 0) {
        isProcessingQueue = true;
        setBadgeStatus("processing");
        setTimeout(processNextPrompt, 3000);
    }
});

// ============================================
// BOOT PROMISE - v3.0.0
// ============================================
const _bootPromise = (async () => {
    await initApp();
    await loadQueueState();
    console.log("[Dotti] Boot complete. Queue:", promptQueue.length, "Processing:", isProcessingQueue);
})();

// ============================================================
// EXTEND (SCENE) QUEUE — v3.1.0
// Orquestra: BASE -> aguarda COMPLETED -> EXT*N (cada um aguarda COMPLETED) -> download final.
// ============================================================
let _extendQueue = null; // { scenes:[...], folder, useLite, currentIdx, stopped }
let _extendActiveTimeout = null;

function _notifyPanelExtend(message) {
    if (!targetTabId) return;
    try { chrome.tabs.sendMessage(targetTabId, message).catch(() => {}); } catch (e) {}
}

function _sceneUpdate(scene, patch) {
    Object.assign(scene, patch);
    _notifyPanelExtend({ action: "SCENE_UPDATE_BRIDGE", data: { number: scene.number, ...patch } });
}

async function extendStartQueue(scenes, folder, useLite) {
    if (_extendQueue && !_extendQueue.stopped) {
        return { success: false, error: "queue_active" };
    }
    if (!Array.isArray(scenes) || scenes.length === 0) {
        return { success: false, error: "no_scenes" };
    }
    _extendQueue = {
        scenes: scenes.map(s => ({
            number: s.number,
            elements: s.elements || [],
            base: s.base,
            extensions: s.extensions || [],
            status: "waiting",
            currentExtIdx: -1,
            currentMediaId: null,
            finalMediaId: null
        })),
        folder: folder || "LetzScenes",
        useLite: useLite !== false,
        currentIdx: -1,
        stopped: false
    };
    console.log("[Extend] startQueue:", _extendQueue.scenes.length, "cenas | folder=" + _extendQueue.folder + " | lite=" + _extendQueue.useLite);
    setTimeout(() => extendNextScene(), 100);
    return { success: true };
}

function extendStopQueue() {
    if (!_extendQueue) return;
    _extendQueue.stopped = true;
    if (_extendActiveTimeout) { clearTimeout(_extendActiveTimeout); _extendActiveTimeout = null; }
    _notifyPanelExtend({ action: "SCENE_QUEUE_COMPLETE_BRIDGE" });
    console.log("[Extend] queue parada");
}

async function extendNextScene() {
    if (!_extendQueue || _extendQueue.stopped) return;
    _extendQueue.currentIdx++;
    if (_extendQueue.currentIdx >= _extendQueue.scenes.length) {
        console.log("[Extend] todas as cenas concluidas");
        _notifyPanelExtend({ action: "SCENE_QUEUE_COMPLETE_BRIDGE" });
        _extendQueue = null;
        return;
    }
    const scene = _extendQueue.scenes[_extendQueue.currentIdx];
    console.log("[Extend] iniciando SCENE", scene.number);
    _sceneUpdate(scene, { status: "base_sent" });

    // Pedir ao content.js para enviar o BASE
    try {
        await chrome.tabs.sendMessage(targetTabId, {
            action: "EXTEND_RUN_BASE",
            scene: { number: scene.number, elements: scene.elements, text: scene.base }
        });
    } catch (e) {
        console.error("[Extend] EXTEND_RUN_BASE erro:", e.message);
        _sceneUpdate(scene, { status: "failed", errorReason: "base_dispatch_error" });
        setTimeout(() => extendNextScene(), 1000);
        return;
    }

    // Timeout de seguranca: 6min para BASE chegar a COMPLETED
    _extendActiveTimeout = setTimeout(() => {
        if (scene.status === "base_sent") {
            console.warn("[Extend] BASE timeout SCENE", scene.number);
            _sceneUpdate(scene, { status: "failed", errorReason: "base_timeout" });
            setTimeout(() => extendNextScene(), 1000);
        }
    }, 6 * 60 * 1000);
}

function extendOnBaseSubmitted(sceneNumber, mediaId) {
    if (!_extendQueue) return;
    const scene = _extendQueue.scenes.find(s => s.number === sceneNumber);
    if (!scene) return;
    console.log("[Extend] BASE submitted SCENE", sceneNumber, "mediaId=" + (mediaId || "?").substring(0, 12));
    _sceneUpdate(scene, { currentMediaId: mediaId || null });
}

function extendOnExtSubmitted(sceneNumber, mediaId) {
    if (!_extendQueue) return;
    const scene = _extendQueue.scenes.find(s => s.number === sceneNumber);
    if (!scene) return;
    console.log("[Extend] EXT submitted SCENE", sceneNumber, "idx=" + scene.currentExtIdx, "mediaId=" + (mediaId || "?").substring(0, 12));
    _sceneUpdate(scene, { currentMediaId: mediaId || null });
}

function extendOnStepFailed(sceneNumber, reason) {
    if (!_extendQueue) return;
    const scene = _extendQueue.scenes.find(s => s.number === sceneNumber);
    if (!scene) return;
    console.warn("[Extend] step failed SCENE", sceneNumber, "reason=" + reason);
    _sceneUpdate(scene, { status: "failed", errorReason: reason || "unknown" });
    if (_extendActiveTimeout) { clearTimeout(_extendActiveTimeout); _extendActiveTimeout = null; }
    setTimeout(() => extendNextScene(), 1000);
}

// Recebe updates do interceptor (via VIDEO_STATUS_UPDATE) e avanca a maquina de estados
function extendOnVideoStatus(updates) {
    if (!_extendQueue || _extendQueue.stopped) return;
    if (!Array.isArray(updates)) return;
    const scene = _extendQueue.scenes[_extendQueue.currentIdx];
    if (!scene || !scene.currentMediaId) return;

    for (const u of updates) {
        if (!u || !u.mediaId) continue;
        if (u.mediaId !== scene.currentMediaId) continue;

        if (u.status === "COMPLETED") {
            if (_extendActiveTimeout) { clearTimeout(_extendActiveTimeout); _extendActiveTimeout = null; }
            if (scene.status === "base_sent") {
                _sceneUpdate(scene, { status: "base_generated" });
                _advanceExtension(scene);
            } else if (scene.status === "extending") {
                // EXT atual concluida
                if (scene.currentExtIdx + 1 >= scene.extensions.length) {
                    // ultima extensao -> finalizar
                    _finalizeScene(scene);
                } else {
                    _advanceExtension(scene);
                }
            }
        } else if (u.status === "FAILED") {
            if (_extendActiveTimeout) { clearTimeout(_extendActiveTimeout); _extendActiveTimeout = null; }
            _sceneUpdate(scene, { status: "failed", errorReason: "media_failed" });
            setTimeout(() => extendNextScene(), 1000);
        }
    }
}

async function _advanceExtension(scene) {
    if (!_extendQueue || _extendQueue.stopped) return;
    if (!scene.extensions.length) {
        // Sem extensoes -> finalizar com a base
        _finalizeScene(scene);
        return;
    }
    scene.currentExtIdx++;
    const extText = scene.extensions[scene.currentExtIdx];
    _sceneUpdate(scene, { status: "extending", currentExtIdx: scene.currentExtIdx });
    // Delay para Flow renderizar o thumb recem gerado / detalhe ficar acessivel
    await new Promise(r => setTimeout(r, scene.currentExtIdx === 0 ? 3500 : 1500));
    try {
        await chrome.tabs.sendMessage(targetTabId, {
            action: "EXTEND_RUN_EXT",
            scene: {
                number: scene.number,
                extIdx: scene.currentExtIdx,
                text: extText,
                useLite: _extendQueue.useLite,
                isFirstExt: scene.currentExtIdx === 0,
                baseMediaId: scene.currentMediaId
            }
        });
    } catch (e) {
        console.error("[Extend] EXTEND_RUN_EXT erro:", e.message);
        _sceneUpdate(scene, { status: "failed", errorReason: "ext_dispatch_error" });
        setTimeout(() => extendNextScene(), 1000);
        return;
    }
    _extendActiveTimeout = setTimeout(() => {
        if (scene.status === "extending") {
            console.warn("[Extend] EXT timeout SCENE", scene.number);
            _sceneUpdate(scene, { status: "failed", errorReason: "ext_timeout" });
            setTimeout(() => extendNextScene(), 1000);
        }
    }, 6 * 60 * 1000);
}

async function _finalizeScene(scene) {
    _sceneUpdate(scene, { status: "done", finalMediaId: scene.currentMediaId });
    // Pedir ao content.js para baixar o final
    try {
        await chrome.tabs.sendMessage(targetTabId, {
            action: "EXTEND_DOWNLOAD",
            scene: {
                number: scene.number,
                mediaId: scene.currentMediaId,
                folder: _extendQueue.folder,
                totalSeconds: 8 + 7 * scene.extensions.length
            }
        });
    } catch (e) {
        console.error("[Extend] EXTEND_DOWNLOAD erro:", e.message);
    }
    setTimeout(() => extendNextScene(), 2000);
}
