// ============================================
// LETZ SENDER - PANEL v3.0.0
// TABS: Video / Frame / Imagem com estado independente
// API interception (sem DOM scanning / webRequest)
// ============================================

let activeTab = "video";
let autoDownload = true, backgroundMode = true, currentTabId = null;
let views = {};

// v2.0.1 FIX: Set de URLs ja baixadas - previne download duplicado do mesmo arquivo
const _downloadedVideoUrls = new Set();

const tabState = {
    video: {
        prompts: [], isRunning: false, timerInterval: null, countdownEndTime: null,
        statePollingTimer: null, detectedMedia: {}, folder: "LetzVideos",
        mediaIdMap: {}, outputCount: 1
    },
    frame: {
        prompts: [], isRunning: false, timerInterval: null, countdownEndTime: null,
        statePollingTimer: null, detectedMedia: {}, folder: "LetzFrameVideos",
        mediaIdMap: {}, frameImages: [] // Array of { dataUrl, name, file } for each selected image
    },
    image: {
        prompts: [], isRunning: false, timerInterval: null, countdownEndTime: null,
        statePollingTimer: null, detectedMedia: {}, folder: "LetzImagens",
        mediaIdMap: {}, outputCount: 1
    }
};

const tabIds = {
    video: {
        promptsInput: "videoPromptsInput", settingsCard: "videoSettingsCard", inputSection: "videoInputSection",
        promptListCard: "videoPromptListCard", promptItems: "videoPromptItems", promptCount: "videoPromptCount",
        progressContainer: "videoProgressContainer", progressFill: "videoProgressFill", progressText: "videoProgressText",
        timer: "videoTimer", processBtn: "videoProcessBtn", startBtn: "videoStartBtn", stopBtn: "videoStopBtn",
        emergencyStopBtn: "videoEmergencyStopBtn", cancelAllBtn: "videoCancelAllBtn", resendBtn: "videoResendBtn",
        copyFailedBtn: "videoCopyFailedBtn", formatInfo: "videoFormatInfo", statusCard: "videoStatusCard",
        statSent: "videosSent", statGenerated: "videosGenerated", statFailed: "videosFailed", statDownloaded: "videosDownloaded",
        folder: "videoFolder", outputCount: "videoOutputCount",
        FolderReminder: "videoFolderReminder", blocked: "videoBlockedOverlay"
    },
    frame: {
        input: "framePromptsInput",
        process: "frameProcessBtn",
        start: "frameStartBtn",
        stop: "frameStopBtn",
        emergency: "frameEmergencyStopBtn",
        resend: "frameResendBtn",
        copyFailed: "frameCopyFailedBtn",
        cancelAll: "frameCancelAllBtn",
        promptList: "framePromptListCard",
        promptItems: "framePromptItems",
        promptCount: "framePromptCount",
        progress: "frameProgressContainer",
        progressFill: "frameProgressFill",
        progressText: "frameProgressText",
        timer: "frameTimer",
        folder: "frameFolder",
        folderReminder: "frameFolderReminder",
        status: "frameStatusCard",
        sent: "framesSent",
        generated: "framesGenerated",
        failed: "framesFailed",
        downloaded: "framesDownloaded",
        settings: "frameSettingsCard",
        blocked: "frameBlockedOverlay",
        // Aliases for compatibility with el() calls that use same keys as video/image
        promptsInput: "framePromptsInput",
        settingsCard: "frameSettingsCard",
        inputSection: "frameInputSection",
        promptListCard: "framePromptListCard",
        progressContainer: "frameProgressContainer",
        processBtn: "frameProcessBtn",
        startBtn: "frameStartBtn",
        stopBtn: "frameStopBtn",
        emergencyStopBtn: "frameEmergencyStopBtn",
        cancelAllBtn: "frameCancelAllBtn",
        resendBtn: "frameResendBtn",
        copyFailedBtn: "frameCopyFailedBtn",
        formatInfo: "frameFormatInfo",
        statusCard: "frameStatusCard",
        statSent: "framesSent",
        statGenerated: "framesGenerated",
        statFailed: "framesFailed",
        statDownloaded: "framesDownloaded",
        FolderReminder: "frameFolderReminder",
        outputCount: "frameOutputCount"
    },
    image: {
        promptsInput: "imagePromptsInput", settingsCard: "imageSettingsCard", inputSection: "imageInputSection",
        promptListCard: "imagePromptListCard", promptItems: "imagePromptItems", promptCount: "imagePromptCount",
        progressContainer: "imageProgressContainer", progressFill: "imageProgressFill", progressText: "imageProgressText",
        timer: "imageTimer", processBtn: "imageProcessBtn", startBtn: "imageStartBtn", stopBtn: "imageStopBtn",
        emergencyStopBtn: "imageEmergencyStopBtn", cancelAllBtn: "imageCancelAllBtn", resendBtn: "imageResendBtn",
        copyFailedBtn: "imageCopyFailedBtn", formatInfo: "imageFormatInfo", statusCard: "imageStatusCard",
        statSent: "imagesSent", statGenerated: "imagesGenerated", statFailed: "imagesFailed", statDownloaded: "imagesDownloaded",
        folder: "imageFolder", outputCount: "imageOutputCount",
        FolderReminder: "imageFolderReminder", blocked: "imageBlockedOverlay"
    }
};

function el(tab, key) { return document.getElementById(tabIds[tab][key]); }
function getFolder(tab) {
    if (tab === "frame") return tabState.frame.folder || "LetzFrameVideos";
    return tabState[tab].folder || (tab === "video" ? "LetzVideos" : "LetzImagens");
}

// v2.1.0: Atualizar log persistente quando media e detectada/baixada
function updateLog(promptNumber, mediaType, mediaStatus) {
    try {
        chrome.runtime.sendMessage({
            action: "UPDATE_PROMPT_LOG",
            promptNumber, mediaType, mediaStatus
        });
    } catch (e) { }
}

function buildLocalFilename(tab, prompt) {
    const promptNum = prompt.number || 0;
    const ext = tab === "image" ? "png" : "mp4";
    let slug = (prompt.text || "").substring(0, 50)
        .replace(/[<>:"/\\|?*\x00-\x1f]/g, "")
        .replace(/\s+/g, "_")
        .trim();
    if (!slug) slug = "prompt";
    return String(promptNum).padStart(3, "0") + "_" + slug + "." + ext;
}

// ============================================
// INIT
// ============================================
function initViews() {
    views = {
        app: document.getElementById("appView")
    };

    // v3.0.0: Range slider for simultaneous prompts
    const rangeInput = document.getElementById("simultaneousCount");
    const rangeValue = document.getElementById("simultaneousValue");
    if (rangeInput && rangeValue) {
        rangeInput.addEventListener("input", () => {
            rangeValue.textContent = rangeInput.value;
        });
    }
}

async function init() {
    try {
        initViews();
        setupMessageListener();
        showView("app");
        initApp();
    } catch (e) {
        console.error("[Panel] Init error:", e);
        document.body.innerHTML = '<div style="padding:20px;color:#fff;background:#111;font-family:sans-serif;">' +
            '<h3 style="color:#FF571C;">Lets Automate v3.0.0</h3>' +
            '<p style="color:#888;">Erro ao inicializar. Recarregue a pagina.</p>' +
            '<p style="color:#666;font-size:12px;">' + (e.message || 'Erro desconhecido') + '</p></div>';
    }
}

if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
} else {
    init();
}

// ============================================
// TAB SWITCHING
// ============================================
function switchTab(tabName) {
    activeTab = tabName;
    document.querySelectorAll(".tab-btn").forEach(b => b.classList.toggle("active", b.dataset.tab === tabName));
    document.querySelectorAll(".tab-content").forEach(c => c.classList.toggle("active", c.id === "tabContent" + tabName.charAt(0).toUpperCase() + tabName.slice(1)));
    // Intervalo entre lotes: 180s pra video/frame, 90s pra imagem
    document.getElementById("batchInterval").value = tabName === "image" ? 90 : 180;
    updateBlockedOverlay();
}

function updateBlockedOverlay() {
    const running = getRunningTab();
    for (const tab of ["video", "frame", "image"]) {
        const overlay = document.getElementById(tabIds[tab]?.blocked);
        if (overlay) {
            overlay.classList.toggle("hidden", !running || running === tab);
        }
    }
}

// ============================================
// MESSAGE LISTENER
// ============================================
function setupMessageListener() {
    window.addEventListener("message", (e) => {
        const msg = e.data || {};
        const { type, data } = msg;
        if (!type) return;
        switch (type) {
            case "PROMPT_STARTING": handlePromptStarting(data); break;
            case "PROMPT_RESULT": handlePromptResult(data); break;
            case "BATCH_PAUSE": handleBatchPause(data); break;
            case "QUEUE_COMPLETE": handleQueueComplete(); break;
            case "LICENSE_ERROR": break;
            case "QUEUE_ERROR": handleQueueError(data); break;
            case "DOWNLOAD_INTERCEPTED": handleDownloadIntercepted(data); break;

            // v3.0.0: API interception events
            case "VIDEO_SUBMITTED":
                handleVideoSubmitted(data);
                break;
            case "VIDEO_STATUS_UPDATE":
                handleVideoStatusUpdate(data);
                break;
            case "IMAGE_GENERATED":
                handleImageGenerated(data);
                break;
            case "IMAGE_UPSCALED":
                // Could be used to update image URL if needed
                break;
            case "UPLOAD_RESULT":
                handleUploadResult(data);
                break;
            case "UPLOAD_ERROR":
                handleUploadError(data);
                break;
            case "REFRESH_VIDEO_URL_RESULT":
                (() => {
                    const { url, promptNumber } = msg.data || {};
                    if (!url) return;
                    for (const tab of ["video", "frame"]) {
                        const state = tabState[tab];
                        const prompt = state.prompts.find(p => p.number === promptNumber);
                        if (prompt && !prompt.detectedUrl) {
                            prompt.detectedUrl = url;
                            prompt.videoUrl = url;
                            console.log("[Dotti Panel] Video URL refreshed for prompt #" + promptNumber);
                            displayPrompts(tab);
                            // v3.1.0: NAO auto-download aqui — scanner em content.js e o unico responsavel
                        }
                    }
                })();
                break;

            // v3.0.0: Content.js baixou video direto (estilo DarkPlanner)
            case "VIDEO_DOWNLOADED":
                handleVideoDownloaded(data);
                break;

            // v3.0.0: Periodic DOM scanner discovered video URLs (sem auto-download)
            case "VIDEO_URLS_DISCOVERED":
                handleVideoUrlsDiscovered(data);
                break;

            // v3.0.0: Periodic DOM scanner discovered image URLs
            case "IMAGE_URLS_DISCOVERED":
                handleImageUrlsDiscovered(data);
                break;

            // v3.0.0: Content.js detectou prompt falhado (via API ou DOM)
            case "PROMPT_FAILED":
                handlePromptFailed(data);
                break;

            // v3.0.0: Content.js detectou erro (TIMEOUT/RATE_LIMIT/HIGH_DEMAND)
            case "ERROR_DETECTED":
                handleErrorDetected(data);
                break;

            // v3.0.0: Content.js detectou erro de politica — reescrever com IA
            case "POLICY_ERROR":
                handlePolicyRewrite(data);
                break;

            // v3.0.0: Content.js iniciou Hard Reset
            case "HARD_RESET_STARTED":
                startHardResetCountdown(data?.resumeFromIndex);
                break;

            // v3.0.0: Hard Reset resumido
            case "HARD_RESET_RESUMED":
                handleHardResetResumed(data);
                break;

            // v3.0.0: Retry automatico em andamento
            case "ERROR_RETRY":
                handleErrorRetry(data);
                break;

            // v3.0.0: Retry prompt adicionado (apos reescrita IA)
            case "RETRY_PROMPT_ADDED":
                handleRetryPromptAdded(data);
                break;

            // v3.0.0: Progresso da fila (do content.js processAllPromptsWithSlots)
            case "QUEUE_PROGRESS":
                handleQueueProgress(data);
                break;

            // v3.0.0: Loop de erros detectado
            case "LOOP_DETECTED":
                handleLoopDetected(data);
                break;
        }
    });
}

// ============================================
// API EVENT HANDLERS (v3.0.0)
// ============================================
function handleVideoSubmitted(data) {
    const { media } = data || {};
    if (!media || !Array.isArray(media)) return;

    // Determine active tab (video or frame)
    const runningTab = getRunningTab();
    const targetTab = runningTab || activeTab;
    if (targetTab !== "video" && targetTab !== "frame") return;

    const state = tabState[targetTab];

    for (const entry of media) {
        if (!entry.mediaId) continue;

        // Try text match first
        let matched = false;
        for (let j = 0; j < state.prompts.length; j++) {
            const p = state.prompts[j];
            if ((p.status === "sending" || p.status === "sent") && !p.mediaId) {
                if (entry.prompt && p.text &&
                    entry.prompt.substring(0, 50) === p.text.substring(0, 50)) {
                    p.mediaId = entry.mediaId;
                    if (p.status === "sending") p.status = "sent";
                    matched = true;
                    console.log("[Dotti Panel] VIDEO_SUBMITTED matched by text:", entry.mediaId.substring(0, 12), "-> prompt #" + p.number);
                    break;
                }
            }
        }

        // Fallback: sequential match
        if (!matched) {
            for (let j = 0; j < state.prompts.length; j++) {
                const p = state.prompts[j];
                if ((p.status === "sending" || p.status === "sent") && !p.mediaId) {
                    p.mediaId = entry.mediaId;
                    if (p.status === "sending") p.status = "sent";
                    console.log("[Dotti Panel] VIDEO_SUBMITTED sequential match:", entry.mediaId.substring(0, 12), "-> prompt #" + p.number);
                    break;
                }
            }
        }
    }
    displayPrompts(targetTab);
}

function handleVideoStatusUpdate(data) {
    const { updates } = data || {};
    if (!updates || !Array.isArray(updates)) return;

    // Check both video and frame tabs
    for (const tab of ["video", "frame"]) {
        const state = tabState[tab];

        for (const update of updates) {
            if (!update.mediaId) continue;

            const prompt = state.prompts.find(p => p.mediaId === update.mediaId);
            if (!prompt) continue;

            const idx = state.prompts.indexOf(prompt);

            if (update.status === "COMPLETED") {
                prompt.status = "generated";
                prompt.generated = true;
                prompt.mediaStatus = "generated";
                console.log("[Dotti Panel] Video COMPLETED:", update.mediaId.substring(0, 12), "prompt #" + prompt.number);

                // Request a one-shot DOM scan for this video's URL
                window.parent.postMessage({ type: "REFRESH_VIDEO_URL", data: { promptNumber: prompt.number, oldUrl: prompt.detectedUrl || "" } }, "*");

                updateLog(prompt.number, "video", "generated");

                // v3.1.0: NAO auto-download aqui — o scanner em content.js e o unico responsavel
                // por downloads para evitar duplicacoes. O panel so mostra status.
                // O scanner encontra o video no DOM e baixa via DOWNLOAD_VIDEO.
            } else if (update.status === "FAILED") {
                prompt.status = "error";
                prompt.failed = true;
                prompt.mediaStatus = "failed";
                console.log("[Dotti Panel] Video FAILED:", update.mediaId.substring(0, 12), "prompt #" + prompt.number);
                updateLog(prompt.number, "video", "failed");
            }

            displayPrompts(tab);
            updateStatsDisplay(tab);
        }
    }
}

function handleImageGenerated(data) {
    const { images } = data || {};
    if (!images || !Array.isArray(images)) return;

    const state = tabState.image;

    for (const img of images) {
        if (!img.imageUrl) continue;

        // Try text match
        let matched = false;
        for (let j = 0; j < state.prompts.length; j++) {
            const p = state.prompts[j];
            if ((p.status === "sent" || p.status === "sending") && !p.generated) {
                if (img.prompt && p.text &&
                    img.prompt.substring(0, 50) === p.text.substring(0, 50)) {
                    p.generated = true;
                    p.status = "generated";
                    p.mediaStatus = "generated";
                    p.detectedUrl = img.imageUrl;
                    p.mediaId = img.mediaId;
                    matched = true;
                    console.log("[Dotti Panel] IMAGE_GENERATED text match:", img.mediaId?.substring(0, 12), "-> prompt #" + p.number);

                    updateLog(p.number, "image", "generated");
                    if (autoDownload) downloadMedia("image", j);
                    break;
                }
            }
        }

        // Fallback: sequential
        if (!matched) {
            for (let j = 0; j < state.prompts.length; j++) {
                const p = state.prompts[j];
                if ((p.status === "sent" || p.status === "sending") && !p.generated) {
                    p.generated = true;
                    p.status = "generated";
                    p.mediaStatus = "generated";
                    p.detectedUrl = img.imageUrl;
                    p.mediaId = img.mediaId;
                    console.log("[Dotti Panel] IMAGE_GENERATED sequential:", img.mediaId?.substring(0, 12), "-> prompt #" + p.number);

                    updateLog(p.number, "image", "generated");
                    if (autoDownload) downloadMedia("image", j);
                    break;
                }
            }
        }
    }
    displayPrompts("image");
    updateStatsDisplay("image");
}

// ============================================
// VIDEO DOWNLOADED (content.js baixou direto, estilo DarkPlanner)
// Content.js fez o scan DOM -> match -> download -> avisa o panel
// ============================================
function handleVideoDownloaded(data) {
    const { promptNumber, mediaId, url } = data || {};
    if (!promptNumber) return;

    // Atualizar em video e frame tabs
    for (const tab of ["video", "frame"]) {
        const state = tabState[tab];
        const prompt = state.prompts.find(p => p.number === promptNumber);
        if (!prompt) continue;

        prompt.detectedUrl = url;
        prompt.videoUrl = url;
        prompt.downloaded = true;
        prompt.downloadStatus = "complete";
        prompt.mediaStatus = "downloaded";
        if (mediaId) prompt.mediaId = mediaId;
        if (!prompt.generated) {
            prompt.generated = true;
            prompt.status = "generated";
        }

        _downloadedVideoUrls.add(url);
        updateLog(promptNumber, tab === "frame" ? "video" : "video", "downloaded");
        console.log("[Dotti Panel] VIDEO_DOWNLOADED: prompt #" + promptNumber + " via content.js scanner");

        displayPrompts(tab);
        updateStatsDisplay(tab);
        break; // So atualizar em uma aba
    }
}

// ============================================
// PROMPT FAILED (v3.0.0 — detecção de falhas via API/DOM no content.js)
// ============================================
function handlePromptFailed(data) {
    const { number, failType, mediaId, errorType, text } = data || {};
    if (!number) return;

    // Atualizar em video e frame tabs
    for (const tab of ["video", "frame"]) {
        const state = tabState[tab];
        const prompt = state.prompts.find(p => p.number === number);
        if (!prompt) continue;

        prompt.status = "error";
        prompt.generated = false;
        prompt.failed = true;
        prompt.failType = failType || "UNKNOWN";
        if (mediaId) prompt.mediaId = mediaId;

        const reason = failType === "TECHNICAL" ? "Erro tecnico" :
            failType === "POLICY" ? "Erro de politica" :
                failType === "POLICY_IMAGE" ? "Erro na imagem" :
                    errorType === "TIMEOUT" ? "Timeout" : "Falhou";

        updateLog(number, "video", "failed: " + reason);
        console.log("[Dotti Panel] PROMPT_FAILED: #" + number + " tipo: " + failType);

        displayPrompts(tab);
        updateStatsDisplay(tab);
        break;
    }
}

// ============================================
// ERROR DETECTED (v3.0.0 — popups de erro detectados pelo content.js)
// ============================================
function handleErrorDetected(data) {
    const { errorType, promptNumber } = data || {};
    console.log("[Dotti Panel] ERROR_DETECTED:", errorType, "prompt:", promptNumber);

    const messages = {
        "RATE_LIMIT": "Limite de requisicoes — iniciando Hard Reset automatico...",
        "HIGH_DEMAND": "Flow com alta demanda — retry automatico em andamento...",
        "TIMEOUT": "Geracao demorou muito — retry automatico em andamento..."
    };

    const msg = messages[errorType] || "Erro detectado: " + errorType;
    updateLog(promptNumber || 0, "system", msg);
    // v3.0.0: Erros sao tratados automaticamente pelo handleErrorByType no content.js
    // Nao precisamos mais pausar a fila manualmente
}

// ============================================
// v3.0.0: POLICY ERROR REWRITE — reescrever prompt com IA
// ============================================
async function handlePolicyRewrite(data) {
    const { taskIndex, originalIndex, prompt, errorType, number } = data || {};
    console.log("[Dotti Panel] POLICY_ERROR: #" + number + " tipo:" + errorType);

    // POLICY_IMAGE → nao reescrever
    if (errorType === 'image' || errorType === 'POLICY_IMAGE') {
        updateLog(number || 0, "system", "Erro de politica de imagem — nao sera reescrito");
        return;
    }

    updateLog(number || 0, "system", "Erro de politica detectado — reescrevendo com IA...");

    // Preservar [brackets] de ingredientes
    let promptToRewrite = prompt || '';
    const hasBrackets = /\[[^\]]+\]/.test(promptToRewrite);
    if (hasBrackets) {
        const names = [...promptToRewrite.matchAll(/\[([^\]]+)\]/g)].map(m => m[1]);
        promptToRewrite = 'IMPORTANT: Keep all character names in [brackets] exactly as they are (' + names.map(n => '[' + n + ']').join(', ') + '). Only rewrite the scene description to avoid policy violations.\n\n' + promptToRewrite;
    }

    // Chamar background.js para reescrever via API
    try {
        const result = await chrome.runtime.sendMessage({
            action: 'POLICY_ERROR_REWRITE',
            prompt: promptToRewrite,
            originalIndex: originalIndex,
            taskIndex: taskIndex
        });

        if (result?.success && result.rewrittenPrompt) {
            let rewritten = result.rewrittenPrompt;

            // v3.1.0: Limpar prefixo "IMPORTANT:" que pode ter vazado da instrução
            rewritten = rewritten.replace(/^IMPORTANT:\s*/i, '').trim();

            // v3.1.0: Validação de brackets pós-rewrite
            // Para cada [nome] do prompt original: verificar se sobreviveu no reescrito
            const originalPrompt = prompt || '';
            const originalBrackets = [...originalPrompt.matchAll(/\[([^\]]+)\]/g)].map(m => m[1]);
            if (originalBrackets.length > 0) {
                for (const name of originalBrackets) {
                    const bracketForm = '[' + name + ']';
                    if (rewritten.includes(bracketForm)) {
                        // OK — bracket survived
                        continue;
                    }
                    // Nome existe sem brackets? Re-injetar brackets via regex
                    const nameRegex = new RegExp('(?<!\\[)\\b' + name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\b(?!\\])', 'gi');
                    if (nameRegex.test(rewritten)) {
                        rewritten = rewritten.replace(nameRegex, bracketForm);
                        console.log('[Dotti Panel] Bracket re-injetado para:', name);
                    } else {
                        // Nome desapareceu completamente → prepend no início
                        rewritten = bracketForm + ' ' + rewritten;
                        console.log('[Dotti Panel] Bracket prepended para:', name);
                    }
                }
            }

            updateLog(number || 0, "system", "Prompt reescrito com sucesso! Reenviando...");

            // Enviar prompt reescrito de volta ao content.js
            window.parent.postMessage({
                type: 'ADD_RETRY_PROMPT',
                data: {
                    prompt: rewritten,
                    originalIndex: originalIndex != null ? originalIndex : taskIndex,
                    isRetry: true,
                    retryCount: 1
                }
            }, '*');
        } else {
            updateLog(number || 0, "system", "Falha ao reescrever prompt: " + (result?.error || 'erro desconhecido'));

            // v3.1.0: Notificar content.js que rewrite falhou (para decrementar _pendingRewrites)
            window.parent.postMessage({
                type: 'REWRITE_FAILED',
                data: { originalIndex: originalIndex != null ? originalIndex : taskIndex, number: number }
            }, '*');
        }
    } catch (e) {
        console.error("[Dotti Panel] Erro ao reescrever prompt:", e);
        updateLog(number || 0, "system", "Erro ao chamar API de reescrita: " + e.message);

        // v3.1.0: Notificar content.js que rewrite falhou
        window.parent.postMessage({
            type: 'REWRITE_FAILED',
            data: { originalIndex: originalIndex != null ? originalIndex : taskIndex, number: number }
        }, '*');
    }
}

// ============================================
// v3.0.0: HARD RESET COUNTDOWN
// ============================================
function startHardResetCountdown(resumeFromIndex) {
    console.log("[Dotti Panel] Hard Reset iniciado, countdown 45s, resumeFromIndex=" + resumeFromIndex);
    updateLog(0, "system", "Hard Reset iniciado — cooldown de 45s antes de retomar...");

    let countdown = 45;
    const runningTab = getRunningTab() || activeTab;

    // Mostrar countdown no progress bar
    const progressContainer = document.getElementById(tabIds[runningTab]?.progressContainer);
    const progressText = document.getElementById(tabIds[runningTab]?.progressText);
    const timerEl = document.getElementById(tabIds[runningTab]?.timer);

    if (progressContainer) progressContainer.classList.remove("hidden");
    if (timerEl) {
        timerEl.classList.remove("hidden");
        timerEl.textContent = "Hard Reset: " + countdown + "s";
    }

    const interval = setInterval(() => {
        countdown--;
        if (timerEl) timerEl.textContent = "Hard Reset: " + countdown + "s";
        if (progressText) progressText.textContent = "Cooldown: " + countdown + "s";

        if (countdown <= 0) {
            clearInterval(interval);
            if (timerEl) timerEl.textContent = "Retomando...";
            updateLog(0, "system", "Cooldown completo! Retomando processamento...");
        }
    }, 1000);
}

function handleHardResetResumed(data) {
    const { count } = data || {};
    updateLog(0, "system", "Hard Reset recuperado! Retomando " + (count || 0) + " prompts...");
}

// ============================================
// v3.0.0: ERROR RETRY — notificar usuario sobre retry automatico
// ============================================
function handleErrorRetry(data) {
    const { number, errorType, retryCount, maxRetries } = data || {};
    if (!number) return;

    const messages = {
        "TIMEOUT": "Timeout - retry " + retryCount + "/" + maxRetries,
        "HIGH_DEMAND": "Alta demanda - retry " + retryCount + "/" + maxRetries,
        "GENERATION_FAILED": "Falha tecnica - retry " + retryCount + "/" + maxRetries
    };

    const msg = messages[errorType] || errorType + " - retry " + retryCount + "/" + maxRetries;
    updateLog(number, "system", msg);

    // Atualizar status visual do prompt
    for (const tab of ["video", "frame"]) {
        const state = tabState[tab];
        const prompt = state.prompts.find(p => p.number === number);
        if (prompt) {
            prompt.status = "retrying";
            prompt.retryInfo = msg;
            displayPrompts(tab);
            break;
        }
    }
}

function handleRetryPromptAdded(data) {
    const { number, originalIndex } = data || {};
    updateLog(number || 0, "system", "Prompt reescrito adicionado a fila (retry #" + (originalIndex || 0) + ")");
}

function handleQueueProgress(data) {
    const { sent, completed, failed, total, generating } = data || {};
    const runningTab = getRunningTab() || activeTab;
    const state = tabState[runningTab];
    if (!state) return;

    // Atualizar stats display
    updateStatsDisplay(runningTab);

    // Atualizar progress bar
    const progressFill = document.getElementById(tabIds[runningTab]?.progressFill);
    const progressText = document.getElementById(tabIds[runningTab]?.progressText);
    if (progressFill && total > 0) {
        const pct = Math.round(((completed + failed) / total) * 100);
        progressFill.style.width = pct + "%";
        if (progressText) progressText.textContent = pct + "% (" + (completed + failed) + "/" + total + ")";
    }
}

function handleLoopDetected(data) {
    const { count } = data || {};
    updateLog(0, "system", "LOOP DE ERROS DETECTADO (" + (count || 0) + " erros seguidos)! Automacao parada automaticamente.");

    // Parar UI
    const runningTab = getRunningTab();
    if (runningTab) {
        tabState[runningTab].isRunning = false;
    }
    showButtons(runningTab || activeTab, "idle");
}

// ============================================
// VIDEO/IMAGE URL DISCOVERY (from DOM scanner in content.js)
// Quando auto-download esta desligado, ou nenhum match foi feito
// ============================================
function handleVideoUrlsDiscovered(data) {
    const { videos } = data || {};
    if (!videos || !Array.isArray(videos)) return;

    for (const found of videos) {
        if (!found.url) continue;

        // Try both video and frame tabs
        for (const tab of ["video", "frame"]) {
            const state = tabState[tab];
            if (state.prompts.length === 0) continue;

            let matched = false;

            // Priority 1: Match by prompt number from DOM context
            if (found.promptNumber) {
                const prompt = state.prompts.find(p => p.number === found.promptNumber && !p.detectedUrl);
                if (prompt) {
                    prompt.detectedUrl = found.url;
                    prompt.videoUrl = found.url;
                    console.log("[Dotti Panel] Scanner matched video URL to prompt #" + prompt.number + " (by number)");
                    matched = true;
                    const idx = state.prompts.indexOf(prompt);
                    displayPrompts(tab);
                    updateStatsDisplay(tab);
                    if (autoDownload && prompt.generated && !prompt.downloaded && !prompt._downloading) {
                        downloadMedia(tab, idx);
                    }
                }
            }

            // Priority 2: Sequential match — first "generated" prompt without URL
            if (!matched) {
                const prompt = state.prompts.find(p =>
                    (p.status === "generated" || (p.status === "sent" && p.generated)) &&
                    !p.detectedUrl && !p.videoUrl
                );
                if (prompt) {
                    prompt.detectedUrl = found.url;
                    prompt.videoUrl = found.url;
                    console.log("[Dotti Panel] Scanner matched video URL to prompt #" + prompt.number + " (sequential)");
                    matched = true;
                    const idx = state.prompts.indexOf(prompt);
                    displayPrompts(tab);
                    updateStatsDisplay(tab);
                    if (autoDownload && prompt.generated && !prompt.downloaded && !prompt._downloading) {
                        downloadMedia(tab, idx);
                    }
                }
            }

            // Priority 3: Any "sent" prompt without URL (video might appear before API status)
            if (!matched) {
                const prompt = state.prompts.find(p =>
                    p.status === "sent" && !p.detectedUrl && !p.videoUrl
                );
                if (prompt) {
                    prompt.detectedUrl = found.url;
                    prompt.videoUrl = found.url;
                    // Mark as generated since the video is already in the DOM
                    prompt.generated = true;
                    prompt.status = "generated";
                    prompt.mediaStatus = "generated";
                    console.log("[Dotti Panel] Scanner: video found in DOM before API status — prompt #" + prompt.number);
                    matched = true;
                    const idx = state.prompts.indexOf(prompt);
                    displayPrompts(tab);
                    updateStatsDisplay(tab);
                    if (autoDownload && !prompt.downloaded && !prompt._downloading) {
                        downloadMedia(tab, idx);
                    }
                }
            }

            if (matched) break; // Don't match same URL to both tabs
        }
    }
}

function handleImageUrlsDiscovered(data) {
    const { images } = data || {};
    if (!images || !Array.isArray(images)) return;

    const state = tabState.image;
    if (state.prompts.length === 0) return;

    for (const found of images) {
        if (!found.url) continue;

        // Priority 1: Match by prompt number
        if (found.promptNumber) {
            const prompt = state.prompts.find(p => p.number === found.promptNumber && !p.detectedUrl);
            if (prompt) {
                prompt.detectedUrl = found.url;
                if (!prompt.generated) {
                    prompt.generated = true;
                    prompt.status = "generated";
                    prompt.mediaStatus = "generated";
                }
                console.log("[Dotti Panel] Scanner matched image URL to prompt #" + prompt.number);
                const idx = state.prompts.indexOf(prompt);
                displayPrompts("image");
                updateStatsDisplay("image");
                if (autoDownload && !prompt.downloaded && !prompt._downloading) {
                    downloadMedia("image", idx);
                }
                continue;
            }
        }

        // Priority 2: Sequential match
        const prompt = state.prompts.find(p =>
            (p.status === "sent" || p.status === "generated") && !p.detectedUrl
        );
        if (prompt) {
            prompt.detectedUrl = found.url;
            if (!prompt.generated) {
                prompt.generated = true;
                prompt.status = "generated";
                prompt.mediaStatus = "generated";
            }
            console.log("[Dotti Panel] Scanner matched image URL to prompt #" + prompt.number + " (sequential)");
            const idx = state.prompts.indexOf(prompt);
            displayPrompts("image");
            updateStatsDisplay("image");
            if (autoDownload && !prompt.downloaded && !prompt._downloading) {
                downloadMedia("image", idx);
            }
        }
    }
}

function handleUploadResult(data) {
    console.log("[Dotti Panel] Upload result:", data?.source, "imageId:", data?.imageId?.substring(0, 12));
    // Frame tab: track upload completion for frame images
    if (activeTab === "frame") {
        // The upload was successful, continue with video generation
    }
}

function handleUploadError(data) {
    console.log("[Dotti Panel] Upload error:", data?.error, data?.reason);
    updateStatus("error", "Erro no upload: " + (data?.message || data?.error || "desconhecido"));
}

// ============================================
// HELPERS - FIND TAB
// ============================================
function findTabForPrompt(number) {
    for (const tab of ["video", "frame", "image"]) {
        if (tabState[tab].isRunning && tabState[tab].prompts.some(p => p.number === number)) return tab;
    }
    for (const tab of ["video", "frame", "image"]) {
        if (tabState[tab].prompts.some(p => p.number === number)) return tab;
    }
    return null;
}

function getRunningTab() {
    if (tabState.video.isRunning) return "video";
    if (tabState.frame.isRunning) return "frame";
    if (tabState.image.isRunning) return "image";
    return null;
}

// ============================================
// PROMPT HANDLERS
// ============================================
function handlePromptStarting(prompt) {
    const tab = findTabForPrompt(prompt.number);
    if (!tab) return;
    const idx = tabState[tab].prompts.findIndex(p => p.number === prompt.number);
    if (idx !== -1) {
        tabState[tab].prompts[idx].status = "sending";
        displayPrompts(tab);
        const label = tab === "image" ? "Gerando imagem" : "Enviando";
        const bp = getBatchProgress(tab);
        updateStatus("running", label + " PROMPT " + prompt.number + " (" + (bp.batchDone + 1) + "/" + bp.batchSize + ")...");
    }
}

// v3.1.0: Helper para calcular progresso relativo ao batch atual (funciona para 1o envio E reenvio)
function getBatchProgress(tab) {
    const st = tabState[tab];
    const totalDone = st.prompts.filter(p => p.status === "sent" || p.status === "error" || p.status === "failed" || p.status === "generated").length;
    const batchDone = totalDone - (st._preBatchDone || 0);
    const batchSize = st._currentBatchSize || st.prompts.length;
    return { batchDone: Math.max(0, batchDone), batchSize, percent: Math.round((Math.max(0, batchDone) / batchSize) * 100) };
}

function handlePromptResult(data) {
    const tab = findTabForPrompt(data.number);
    if (!tab) return;
    const st = tabState[tab];
    const idx = st.prompts.findIndex(p => p.number === data.number);
    if (idx !== -1) {
        const newStatus = data.result.success ? "sent" : "error";
        st.prompts[idx].status = newStatus;
        if (!data.result.success) st.prompts[idx].errorReason = data.result.error;

        // Notificar content.js do status para o scanner saber quem ja foi enviado
        window.parent.postMessage({
            type: "UPDATE_PROMPT_STATUS",
            data: { number: data.number, status: newStatus }
        }, "*");

        displayPrompts(tab);
        updateStatsDisplay(tab);
        const bp = getBatchProgress(tab);
        updateProgress(bp.percent, "Enviado " + bp.batchDone + "/" + bp.batchSize, tab);
    }
}

function handleBatchPause(data) {
    const tab = getRunningTab();
    if (!tab) return;
    stopAllTimers(tab);
    updateStatus("warning", "Aguardando proximo lote...");
    tabState[tab].countdownEndTime = Date.now() + data.interval;
    showCountdownTimer(tab);
}

function handleQueueError(data) {
    const tab = getRunningTab() || activeTab;
    tabState[tab].isRunning = false;
    stopStatePolling(tab);
    updateBlockedOverlay();
    updateStatus("error", data?.message || "Erro na fila");
    el(tab, "stopBtn").classList.add("hidden");
    el(tab, "emergencyStopBtn").classList.add("hidden");
    el(tab, "startBtn").classList.remove("hidden");
    el(tab, "startBtn").textContent = "Continuar";
    el(tab, "startBtn").onclick = () => continueSending(tab);
    el(tab, "cancelAllBtn").classList.remove("hidden");
}

// ============================================
// TIMERS
// ============================================
function stopAllTimers(tab) {
    const st = tabState[tab];
    if (st.timerInterval) { clearTimeout(st.timerInterval); st.timerInterval = null; }
    st.countdownEndTime = null;
}

function showCountdownTimer(tab) {
    const st = tabState[tab];
    // Limpar APENAS o timer interval, sem resetar o countdownEndTime
    if (st.timerInterval) { clearTimeout(st.timerInterval); st.timerInterval = null; }
    const timer = el(tab, "timer");
    timer.classList.remove("hidden");
    if (!st.countdownEndTime) st.countdownEndTime = Date.now() + 90000;

    function update() {
        if (!st.isRunning || !st.countdownEndTime) { timer.classList.add("hidden"); return; }
        const remaining = Math.max(0, Math.ceil((st.countdownEndTime - Date.now()) / 1000));
        if (remaining <= 0) { timer.classList.add("hidden"); st.countdownEndTime = null; return; }
        timer.textContent = String(Math.floor(remaining / 60)).padStart(2, "0") + ":" + String(remaining % 60).padStart(2, "0");
        st.timerInterval = setTimeout(update, 1000);
    }
    update();
}

// ============================================
// QUEUE COMPLETE
// ============================================
async function handleQueueComplete() {
    const tab = getRunningTab() || activeTab;
    const st = tabState[tab];
    st.isRunning = false;
    const sentCount = st.prompts.filter(p => p.status === "sent").length;
    // v3.1.0: Contar apenas prompts que precisam de download (para timer correto no reenvio)
    const pendingDownloadCount = st.prompts.filter(p =>
        (p.status === "sent" || p.status === "generated") && p.mediaStatus !== "downloaded"
    ).length;

    stopAllTimers(tab);
    stopStatePolling(tab);
    updateBlockedOverlay();

    el(tab, "stopBtn").classList.add("hidden");
    el(tab, "emergencyStopBtn").classList.add("hidden");
    el(tab, "startBtn").classList.add("hidden");
    el(tab, "resendBtn").classList.add("hidden");
    el(tab, "copyFailedBtn").classList.add("hidden");
    el(tab, "cancelAllBtn").classList.remove("hidden");

    // Timer dinamico baseado no numero de prompts pendentes de download
    const baseWait = (tab === "video" || tab === "frame") ? Math.max(120, Math.min(600, pendingDownloadCount * 8)) : 60;
    const mediaLabel = tab === "image" ? "das imagens" : "dos videos";
    updateStatus("success", "Envio concluido! " + pendingDownloadCount + " aguardando geracao");

    await showWaitingCounter(baseWait, "Aguardando geracao " + mediaLabel + "...", tab);

    // Bonus rounds - continuar polling ate capturar toda midia
    const maxRounds = tab === "image" ? 10 : 20;
    const roundInterval = tab === "image" ? 20 : 30;
    const mediaName = tab === "image" ? "imagens" : "videos";
    for (let round = 1; round <= maxRounds; round++) {
        const pending = st.prompts.filter(p => p.status === "sent" && p.mediaStatus === "pending" && !p._downloading).length;
        if (pending === 0) break;
        console.log("[Panel] Bonus round", round, "/" + maxRounds + " - faltam", pending, " " + mediaName);
        await showWaitingCounter(roundInterval, "Aguardando " + pending + " " + mediaName + " restantes (tentativa " + round + "/" + maxRounds + ")...", tab);
    }

    // Se aba de imagem, voltar para modo de video
    if (tab === "image") {
        window.parent.postMessage({ type: "SWITCH_TO_VIDEO_MODE" }, "*");
    }

    finishSending(tab);
}

// ============================================
// DOWNLOAD INTERCEPTED
// ============================================
function handleDownloadIntercepted(data) {
    const tab = data.type === "image" ? "image" : "video";
    const st = tabState[tab];
    const idx = st.prompts.findIndex(p => p.number === data.promptNumber);
    if (idx === -1) return;
    // So atualizar se ainda nao esta downloaded
    if (st.prompts[idx].mediaStatus === "downloaded") return;
    st.prompts[idx].mediaStatus = "downloaded";
    st.prompts[idx]._downloading = false;
    displayPrompts(tab);
    updateStatsDisplay(tab);
    updateLog(data.promptNumber, tab, "downloaded");
}

// ============================================
// DOWNLOAD MEDIA (unified for video/frame/image)
// ============================================
async function downloadMedia(tab, idx) {
    const state = tabState[tab];
    const prompt = state.prompts[idx];
    if (!prompt) return;

    const url = prompt.detectedUrl || prompt.videoUrl || prompt.mediaUrl;
    if (!url) {
        console.log("[Dotti Panel] No URL for download, prompt #" + (idx + 1));
        return;
    }

    // Prevent duplicate downloads
    if (prompt._downloading) return;
    if (_downloadedVideoUrls.has(url)) return;
    prompt._downloading = true;

    const folder = getFolder(tab);
    const promptNum = prompt.number || (idx + 1);
    const filename = buildLocalFilename(tab, prompt);
    const action = tab === "image" ? "DOWNLOAD_IMAGE" : "DOWNLOAD_VIDEO";

    try {
        const resp = await chrome.runtime.sendMessage({
            action: action,
            url: url,
            filename: filename,
            folder: folder
        });
        if (resp?.success) {
            prompt.downloaded = true;
            prompt.downloadStatus = "complete";
            prompt.mediaStatus = "downloaded";
            _downloadedVideoUrls.add(url);
            updateLog(promptNum, tab === "image" ? "image" : "video", "downloaded");
            console.log("[Dotti Panel] Downloaded:", folder + "/" + filename);
        } else {
            console.error("[Dotti Panel] Download failed:", resp?.error);
            prompt.downloadStatus = "error";
            _downloadedVideoUrls.delete(url); // permitir retry
        }
    } catch (e) {
        console.error("[Dotti Panel] Download error:", e);
        prompt.downloadStatus = "error";
        _downloadedVideoUrls.delete(url); // permitir retry
    }
    prompt._downloading = false;
    displayPrompts(tab);
    updateStatsDisplay(tab);
}

function showView(name) {
    Object.values(views).forEach(v => v.classList.add("hidden"));
    if (views[name]) views[name].classList.remove("hidden");
}

// ============================================
// APP INIT
// ============================================
async function initApp() {

    const tabInfo = await chrome.runtime.sendMessage({ action: "GET_ACTIVE_TAB" });
    currentTabId = tabInfo.tabId;

    if (!tabInfo.url || (!tabInfo.url.includes("labs.google/flow") && !tabInfo.url.includes("labs.google/fx"))) {
        updateStatus("error", "Abra o Veo 3 Flow primeiro!");
        el("video", "processBtn").disabled = true;
        el("image", "processBtn").disabled = true;
        const frameProcessBtn = el("frame", "processBtn");
        if (frameProcessBtn) frameProcessBtn.disabled = true;
        return;
    }

    updateStatus("success", "Veo 3 Flow detectado!");

    chrome.runtime.sendMessage({ action: "GET_SETTINGS" }, (s) => {
        if (s) {
            document.getElementById("batchSize").value = s.batchSize;
            document.getElementById("batchInterval").value = activeTab === "image" ? 90 : 180;
            document.getElementById("promptDelay").value = s.promptDelay;
            document.getElementById("autoDownload").checked = s.autoDownload;
            // Segundo plano
            backgroundMode = s.backgroundMode !== false;
            const bgCheckbox = document.getElementById("backgroundMode");
            if (bgCheckbox) bgCheckbox.checked = backgroundMode;

            el("video", "folder").value = s.videoFolder || "LetzVideos";
            el("image", "folder").value = s.imageFolder || "LetzImagens";
            const frameFolder = el("frame", "folder");
            if (frameFolder) frameFolder.value = s.frameFolder || "LetzFrameVideos";
            autoDownload = s.autoDownload;
            tabState.video.folder = s.videoFolder || "LetzVideos";
            tabState.image.folder = s.imageFolder || "LetzImagens";
            tabState.frame.folder = s.frameFolder || "LetzFrameVideos";
        }
    });

    // Segundo plano: sempre habilitado — usuario pode ativar/desativar livremente
    // Quando ativado: janela minimiza + overlay durante processamento
    // Quando desativado: janela fica maximizada (todos os videos visiveis)

    // Tab buttons
    document.querySelectorAll(".tab-btn").forEach(btn => {
        btn.addEventListener("click", () => switchTab(btn.dataset.tab));
    });

    // Per-tab event listeners
    for (const tab of ["video", "frame", "image"]) {
        const processBtn = el(tab, "processBtn");
        const startBtn = el(tab, "startBtn");
        const stopBtn = el(tab, "stopBtn");
        const emergencyBtn = el(tab, "emergencyStopBtn");
        const cancelBtn = el(tab, "cancelAllBtn");
        const resendBtn = el(tab, "resendBtn");
        const copyFailedBtn = el(tab, "copyFailedBtn");
        const folderInput = el(tab, "folder");

        if (processBtn) processBtn.addEventListener("click", () => processPrompts(tab));
        if (startBtn) startBtn.addEventListener("click", () => startSending(tab));
        if (stopBtn) stopBtn.addEventListener("click", () => stopSending(tab));
        if (emergencyBtn) emergencyBtn.addEventListener("click", () => emergencyStop(tab));
        if (cancelBtn) cancelBtn.addEventListener("click", () => cancelAll(tab));
        if (resendBtn) resendBtn.addEventListener("click", () => resendFailed(tab));
        if (copyFailedBtn) copyFailedBtn.addEventListener("click", () => copyFailedNumbers(tab));
        if (folderInput) {
            folderInput.addEventListener("change", (e) => {
                const defaultFolder = tab === "video" ? "LetzVideos" : (tab === "frame" ? "LetzFrameVideos" : "LetzImagens");
                tabState[tab].folder = e.target.value.trim() || defaultFolder;
                saveSettings();
            });
        }
    }

    // Shared listeners
    document.getElementById("autoDownload").addEventListener("change", (e) => {
        autoDownload = e.target.checked;
        saveSettings();
    });
    const bgCheckbox = document.getElementById("backgroundMode");
    if (bgCheckbox) {
        bgCheckbox.addEventListener("change", (e) => {
            backgroundMode = e.target.checked;
            saveSettings();
        });
    }
    ["batchSize", "batchInterval", "promptDelay"].forEach(id => {
        document.getElementById(id).addEventListener("change", saveSettings);
    });
    // Frame tab: image selection
    const frameFileInput = document.getElementById("frameFileInput");
    const frameAddImagesBtn = document.getElementById("frameAddImagesBtn");
    if (frameAddImagesBtn && frameFileInput) {
        frameAddImagesBtn.addEventListener("click", () => frameFileInput.click());
        frameFileInput.addEventListener("change", (e) => {
            const files = Array.from(e.target.files);
            if (!files.length) return;

            const state = tabState.frame;
            for (const file of files) {
                const reader = new FileReader();
                reader.onload = (ev) => {
                    state.frameImages.push({
                        dataUrl: ev.target.result,
                        name: file.name,
                        file: file
                    });
                    renderFrameImages();
                };
                reader.readAsDataURL(file);
            }
            frameFileInput.value = ""; // Reset for re-selection
        });
    }

    await recoverBackgroundState();
}

function renderFrameImages() {
    const container = document.getElementById("frameImagesList");
    if (!container) return;
    container.innerHTML = "";

    tabState.frame.frameImages.forEach((img, i) => {
        const item = document.createElement("div");
        item.className = "frame-image-item";
        item.innerHTML = '<img src="' + img.dataUrl + '" alt="Frame ' + (i + 1) + '">' +
            '<span class="frame-image-number">' + (i + 1) + '</span>' +
            '<button class="frame-image-remove" data-idx="' + i + '">x</button>';
        container.appendChild(item);
    });

    // Remove button handlers
    container.querySelectorAll(".frame-image-remove").forEach(btn => {
        btn.addEventListener("click", (e) => {
            const idx = parseInt(e.target.dataset.idx);
            tabState.frame.frameImages.splice(idx, 1);
            renderFrameImages();
        });
    });
}

// ============================================
// STATE RECOVERY
// ============================================
async function recoverBackgroundState() {
    try {
        const state = await chrome.runtime.sendMessage({ action: "GET_FULL_STATE" });
        if (!state) return;

        const tab = state.mediaType || "video";

        if (state.isProcessing || state.isPaused) {
            const allPrompts = [...(state.processedPrompts || []), ...(state.promptQueue || [])];
            if (allPrompts.length > 0) {
                tabState[tab].prompts = allPrompts.map(p => ({
                    number: p.number, elements: p.elements || [], duration: p.duration || 8, text: p.text,
                    status: p.status || "waiting",
                    mediaStatus: p.mediaStatus || p.videoStatus || "pending",
                    mediaUrl: p.mediaUrl || p.videoUrl || null,
                    detectedUrl: p.detectedUrl || p.mediaUrl || p.videoUrl || null,
                    mediaId: p.mediaId || null,
                    errorReason: p.errorReason || null
                })).sort((a, b) => a.number - b.number);

                switchTab(tab);
                el(tab, "inputSection").classList.add("hidden");
                el(tab, "settingsCard").classList.add("hidden");
                const formatInfo = el(tab, "formatInfo");
                if (formatInfo) formatInfo.classList.add("hidden");
                el(tab, "promptListCard").classList.remove("hidden");
                el(tab, "processBtn").classList.add("hidden");
                el(tab, "progressContainer").classList.remove("hidden");
                el(tab, "statusCard").classList.remove("hidden");
                document.getElementById("sharedSettingsCard").classList.add("hidden");
            
                displayPrompts(tab);
                updateStatsDisplay(tab);

                const bp = getBatchProgress(tab);
                updateProgress(bp.percent, "Enviado " + bp.batchDone + "/" + bp.batchSize, tab);

                if (state.isProcessing) {
                    tabState[tab].isRunning = true;
                    updateBlockedOverlay();
                    el(tab, "startBtn").classList.add("hidden");
                    el(tab, "stopBtn").classList.remove("hidden");
                    el(tab, "emergencyStopBtn").classList.remove("hidden");
                    el(tab, "cancelAllBtn").classList.remove("hidden");
                    updateStatus("running", "Enviando em segundo plano... (" + bp.batchDone + "/" + bp.batchSize + ")");
                    startStatePolling(tab);
                } else if (state.isPaused) {
                    el(tab, "startBtn").classList.remove("hidden");
                    el(tab, "startBtn").textContent = "Continuar";
                    el(tab, "startBtn").onclick = () => continueSending(tab);
                    el(tab, "stopBtn").classList.add("hidden");
                    el(tab, "emergencyStopBtn").classList.add("hidden");
                    el(tab, "cancelAllBtn").classList.remove("hidden");
                    updateStatus("warning", "Pausado - " + (state.promptQueue?.length || 0) + " restantes");
                }
            }
        } else if (state.processedPrompts?.length > 0 && state.promptQueue?.length === 0) {
            tabState[tab].prompts = state.processedPrompts.map(p => ({
                number: p.number, elements: p.elements || [], duration: p.duration || 8, text: p.text,
                status: p.status || "sent",
                mediaStatus: p.mediaStatus || p.videoStatus || "pending",
                mediaUrl: p.mediaUrl || p.videoUrl || null,
                detectedUrl: p.detectedUrl || p.mediaUrl || p.videoUrl || null,
                mediaId: p.mediaId || null,
                errorReason: p.errorReason || null
            })).sort((a, b) => a.number - b.number);

            switchTab(tab);
            el(tab, "inputSection").classList.add("hidden");
            el(tab, "settingsCard").classList.add("hidden");
            const formatInfo = el(tab, "formatInfo");
            if (formatInfo) formatInfo.classList.add("hidden");
            el(tab, "promptListCard").classList.remove("hidden");
            el(tab, "processBtn").classList.add("hidden");
            el(tab, "progressContainer").classList.remove("hidden");
            el(tab, "statusCard").classList.remove("hidden");
            displayPrompts(tab);
            updateStatsDisplay(tab);
            finishSending(tab);
        }
    } catch (e) {
        console.error("[Panel] Error recovering state:", e);
    }
}

// ============================================
// STATE POLLING (simplified - no webRequest polling)
// ============================================
function startStatePolling(tab) {
    stopStatePolling(tab);
    const st = tabState[tab];
    st.statePollingTimer = setInterval(async () => {
        try {
            const state = await chrome.runtime.sendMessage({ action: "GET_FULL_STATE" });
            if (!state) return;

            if (state.processedPrompts) {
                for (const pp of state.processedPrompts) {
                    const idx = st.prompts.findIndex(p => p.number === pp.number);
                    if (idx !== -1 && st.prompts[idx].status === "waiting") {
                        st.prompts[idx].status = pp.status;
                        if (pp.error) st.prompts[idx].errorReason = pp.error;
                        displayPrompts(tab);
                        updateStatsDisplay(tab);
                    }
                }
            }

            const bp2 = getBatchProgress(tab);
            updateProgress(bp2.percent, "Enviado " + bp2.batchDone + "/" + bp2.batchSize, tab);

            if (!state.isProcessing && !state.isPaused && st.isRunning) {
                st.isRunning = false;
                stopStatePolling(tab);
                updateBlockedOverlay();
            }

            if (!state.isProcessing && state.isPaused && st.isRunning) {
                st.isRunning = false;
                updateBlockedOverlay();
                updateStatus("warning", "Pausado pelo sistema");
                el(tab, "stopBtn").classList.add("hidden");
                el(tab, "emergencyStopBtn").classList.add("hidden");
                el(tab, "startBtn").classList.remove("hidden");
                el(tab, "startBtn").textContent = "Continuar";
                el(tab, "startBtn").onclick = () => continueSending(tab);
                el(tab, "cancelAllBtn").classList.remove("hidden");
            }
        } catch (e) { }
    }, 5000);
}

function stopStatePolling(tab) {
    const st = tabState[tab];
    if (st.statePollingTimer) { clearInterval(st.statePollingTimer); st.statePollingTimer = null; }
}

// ============================================
// SETTINGS
// ============================================
function saveSettings() {
    chrome.runtime.sendMessage({
        action: "SAVE_SETTINGS",
        settings: {
            batchSize: parseInt(document.getElementById("batchSize").value),
            batchInterval: parseInt(document.getElementById("batchInterval").value),
            promptDelay: parseInt(document.getElementById("promptDelay").value),
            autoDownload: document.getElementById("autoDownload").checked,
            backgroundMode: backgroundMode,
            videoFolder: tabState.video.folder,
            imageFolder: tabState.image.folder,
            frameFolder: tabState.frame.folder
        }
    });
}

// ============================================
// UI UPDATES
// ============================================
function updateStatus(type, text) {
    document.getElementById("statusBar").className = "status-bar " + type;
    document.getElementById("statusText").textContent = text;
}

function updateProgress(percent, text, tab) {
    el(tab, "progressContainer").classList.remove("hidden");
    el(tab, "progressFill").style.width = percent + "%";
    el(tab, "progressText").textContent = text;
}

// ============================================
// PROCESS PROMPTS
// ============================================
function processPrompts(tab) {
    try {
        const st = tabState[tab];

        // v3.1.0: Nao re-processar se ja esta rodando (previne duplicacao)
        if (st.isRunning) {
            console.log("[Panel] processPrompts ignorado — envio ja em andamento para tab=" + tab);
            updateStatus("warning", "Envio ja em andamento!");
            return;
        }

        const inputEl = el(tab, "promptsInput");
        if (!inputEl) { console.error("[Panel] promptsInput nao encontrado para tab:", tab); return; }
        const input = inputEl.value.trim();
        if (!input) { updateStatus("error", "Cole seus prompts primeiro!"); return; }

        // v3.1.0: Regex tolerante a typos comuns (promt, promtp, prompt)
        const promptRegex = /(?=PROMP?T\s*\d+)/i;
        const parts = input.split(promptRegex).filter(p => p.trim());
        st.prompts = [];
        st.detectedMedia = {};

        for (const part of parts) {
            const trimmed = part.trim();
            if (!trimmed) continue;
            const numMatch = trimmed.match(/PROMP?T\s*(\d+)/i);
            if (!numMatch) continue;
            const num = parseInt(numMatch[1]);
            const elemMatch = trimmed.match(/\[([0-9,\s]+)\]/);
            let elements = elemMatch ? elemMatch[1].split(",").map(e => parseInt(e.trim())).filter(e => !isNaN(e)) : [];
            const durMatch = trimmed.match(/\{(4|6|8)s\}/i);
            const duration = durMatch ? parseInt(durMatch[1]) : 8;
            let text = trimmed
                .replace(/PROMP?T\s*\d+\s*/i, "")
                .replace(/\[[0-9,\s]+\]\s*/g, "")
                .replace(/\{(4|6|8)s\}\s*/gi, "")
                .replace(/\|\s*[\d:]+\s*-\s*[\d:]+\s*/g, "")
                .replace(/^:\s*/, "")
                .trim();
            if (text) {
                st.prompts.push({
                    number: num, elements, duration, text: "PROMPT " + num + ": " + text,
                    status: "waiting", mediaStatus: "pending", mediaUrl: null,
                    detectedUrl: null, mediaId: null
                });
            }
        }

        st.prompts.sort((a, b) => a.number - b.number);
        if (st.prompts.length === 0) { updateStatus("error", "Nenhum prompt encontrado!"); return; }

        saveSettings();
        displayPrompts(tab);

        el(tab, "inputSection").classList.add("hidden");
        el(tab, "settingsCard").classList.add("hidden");
        const formatInfo = el(tab, "formatInfo");
        if (formatInfo) formatInfo.classList.add("hidden");
        el(tab, "promptListCard").classList.remove("hidden");
        el(tab, "processBtn").classList.add("hidden");
        el(tab, "startBtn").classList.remove("hidden");
        el(tab, "startBtn").textContent = "Iniciar Envio";
        el(tab, "startBtn").onclick = () => startSending(tab);
        document.getElementById("sharedSettingsCard").classList.add("hidden");

        const batchSize = parseInt(document.getElementById("batchSize").value);
        const batchCount = Math.ceil(st.prompts.length / batchSize);
        const elemCount = st.prompts.filter(p => p.elements.length > 0).length;
        updateStatus("success", st.prompts.length + " prompts (" + elemCount + " com elementos) | " + batchCount + " lotes");
        console.log("[Panel] processPrompts OK tab=" + tab + " prompts=" + st.prompts.length);
    } catch (err) {
        console.error("[Panel] processPrompts ERRO tab=" + tab, err);
        updateStatus("error", "Erro ao processar: " + err.message);
    }
}

// ============================================
// DISPLAY PROMPTS
// ============================================
function displayPrompts(tab) {
    const container = el(tab, "promptItems");
    const counter = el(tab, "promptCount");
    const st = tabState[tab];
    if (!container || !counter) return;

    const doneCount = st.prompts.filter(p => p.status === "sent" || p.status === "generated" || p.status === "error" || p.status === "failed").length;
    // v3.1.0: Mostrar progresso do batch atual (ex: "2/4" no reenvio, nao "7/9")
    if (st.isRunning && st._currentBatchSize) {
        const batchDone = Math.max(0, doneCount - (st._preBatchDone || 0));
        counter.textContent = batchDone + "/" + st._currentBatchSize;
    } else {
        counter.textContent = doneCount + "/" + st.prompts.length;
    }

    container.innerHTML = st.prompts.map((p) => {
        const elemStr = p.elements.length > 0 ? "[" + p.elements.join(",") + "]" : "";
        let icon = "&#9203;";
        if (p.status === "sending") icon = "&#128260;";
        else if (p.status === "sent" || p.status === "generated") {
            if (p.mediaStatus === "downloaded") icon = "&#128190;";
            else if (p.mediaStatus === "generated") icon = "&#9989;";
            else icon = "&#9203;";
        } else if (p.status === "error" || p.status === "failed") icon = "&#10060;";

        let statusClass = p.status;
        if (p.mediaStatus === "downloaded") statusClass += " downloaded";
        else if (p.mediaStatus === "generated") statusClass += " generated";

        return '<div class="prompt-item ' + statusClass + '">' +
            '<span class="number">' + p.number + '</span>' +
            (elemStr ? '<span class="elements">' + elemStr + '</span>' : '') +
            '<span class="text" title="' + p.text.replace(/"/g, '&quot;') + '">' + p.text.substring(0, 32) + '...</span>' +
            '<span class="status-icon">' + icon + '</span>' +
            '</div>';
    }).join("");
}

// ============================================
// STATS DISPLAY
// ============================================
function updateStatsDisplay(tab) {
    const st = tabState[tab];
    const sentCount = st.prompts.filter(p => p.status === "sent" || p.status === "generated").length;
    const generatedCount = st.prompts.filter(p =>
        p.mediaStatus === "generated" || p.mediaStatus === "downloaded"
    ).length;
    const downloadedCount = st.prompts.filter(p => p.mediaStatus === "downloaded").length;
    const errorCount = st.prompts.filter(p => p.status === "error" || p.status === "failed").length;
    const notGeneratedCount = errorCount + st.prompts.filter(p =>
        (p.status === "sent" || p.status === "generated") && p.mediaStatus === "pending" && !p._downloading
    ).length;

    el(tab, "statSent").textContent = sentCount;
    el(tab, "statGenerated").textContent = generatedCount;
    el(tab, "statFailed").textContent = notGeneratedCount;
    el(tab, "statDownloaded").textContent = downloadedCount;

    // Atualizar botao de reenvio dinamicamente (quando nao esta rodando)
    if (!st.isRunning && st.prompts.length > 0) {
        const totalProblems = errorCount + Math.max(0, sentCount - generatedCount);
        if (totalProblems > 0) {
            el(tab, "resendBtn").classList.remove("hidden");
            el(tab, "resendBtn").textContent = "Reenviar Nao Gerados (" + totalProblems + ")";
            el(tab, "copyFailedBtn").classList.remove("hidden");
        } else {
            el(tab, "resendBtn").classList.add("hidden");
            el(tab, "copyFailedBtn").classList.add("hidden");
            // Atualizar status se todos foram gerados
            const mediaLabel = (tab === "video" || tab === "frame") ? "videos" : "imagens";
            if (downloadedCount === sentCount && sentCount > 0) {
                updateStatus("success", "Perfeito! Todos os " + sentCount + " " + mediaLabel + " foram baixados!");
            } else if (generatedCount === sentCount && sentCount > 0) {
                updateStatus("success", "Perfeito! Todos os " + sentCount + " " + mediaLabel + " foram gerados!");
            }
        }
    }
}

// ============================================
// SENDING
// ============================================
async function startSending(tab) {
    console.log("[Panel] startSending called for tab=" + tab);
    const st = tabState[tab];

    // Mutex: no other tab can be running
    const running = getRunningTab();
    if (running && running !== tab) {
        console.log("[Panel] startSending BLOCKED: another tab running (" + running + ")");
        updateStatus("error", "Aguarde o processamento da outra aba terminar!");
        return;
    }

    try {
        const tabInfo = await chrome.runtime.sendMessage({ action: "GET_ACTIVE_TAB" });
        currentTabId = tabInfo?.tabId;
    } catch (e) { console.log("[Panel] startSending: GET_ACTIVE_TAB error", e.message); }

    if (!currentTabId) { console.log("[Panel] startSending BLOCKED: no tabId"); updateStatus("error", "Tab nao encontrada!"); return; }
    if (st.isRunning) { console.log("[Panel] startSending BLOCKED: already running"); return; }
    st.isRunning = true;
    console.log("[Panel] startSending: session OK, tabId=" + currentTabId + ", starting...");
    updateBlockedOverlay();

    const waitingPrompts = st.prompts.filter(p => p.status === "waiting");
    if (waitingPrompts.length === 0) {
        updateStatus("success", "Todos enviados!");
        st.isRunning = false;
        updateBlockedOverlay();
        return;
    }

    // v3.1.0: Track batch size for correct progress during resend
    st._currentBatchSize = waitingPrompts.length;
    st._preBatchDone = st.prompts.filter(p => p.status !== "waiting").length;

    if (tab === "frame" && st.frameImages && st.frameImages.length > 0) {
        waitingPrompts.forEach(p => {
            const imgIdx = p.number - 1;
            if (st.frameImages[imgIdx]) {
                p.imageDataUrl = st.frameImages[imgIdx].dataUrl;
                p.imageName = st.frameImages[imgIdx].name || ('frame_' + Date.now() + '.png');
            }
        });
    }

    updateStatus("running", "Preparando envio...");

    el(tab, "startBtn").classList.add("hidden");
    el(tab, "stopBtn").classList.remove("hidden");
    el(tab, "emergencyStopBtn").classList.remove("hidden");
    el(tab, "cancelAllBtn").classList.remove("hidden");
    el(tab, "resendBtn").classList.add("hidden");
    el(tab, "copyFailedBtn").classList.add("hidden");
    el(tab, "progressContainer").classList.remove("hidden");
    el(tab, "statusCard").classList.remove("hidden");
    // Mostrar lembrete da pasta de downloads
    const frDiv = el(tab, "FolderReminder");
    if (frDiv) {
        frDiv.innerHTML = "Pasta de downloads: <span>" + getFolder(tab) + "</span>";
        frDiv.classList.remove("hidden");
    }

    const settings = {
        batchSize: parseInt(document.getElementById("batchSize").value),
        batchInterval: parseInt(document.getElementById("batchInterval").value),
        promptDelay: parseInt(document.getElementById("promptDelay").value),
        outputCount: tabState[tab].outputCount || 1,
        maxSimultaneous: parseInt(document.getElementById("simultaneousCount")?.value || "3"),
        folder: getFolder(tab)
    };

    updateStatus("running", "Iniciando envio de " + waitingPrompts.length + " prompts...");
    startStatePolling(tab);

    // v3.1.0: NAO enviar START_SCANNER aqui — START_AUTOMATION (via background.js) ja configura
    // o scanner corretamente com resetVideoUrlScanner() ANTES de setPromptList().
    // Enviar START_SCANNER causava race condition: scanner rodava com promptList errada
    // (todos os prompts como 'pending') antes de START_AUTOMATION sobrescrever.

    console.log("[Panel] startSending: sending START_QUEUE with " + waitingPrompts.length + " prompts, mediaType=" + tab +
        ", images=" + waitingPrompts.filter(p => p.imageDataUrl).length);
    try {
        const result = await chrome.runtime.sendMessage({
            action: "START_QUEUE",
            prompts: waitingPrompts,
            settings: settings,
            tabId: currentTabId,
            mediaType: tab,
            backgroundMode: backgroundMode
        });
        console.log("[Panel] startSending: START_QUEUE result", JSON.stringify(result));
        if (result && !result.success) {
            st.isRunning = false;
            updateBlockedOverlay();
            stopStatePolling(tab);
            el(tab, "stopBtn").classList.add("hidden");
            el(tab, "startBtn").classList.remove("hidden");
            updateStatus("error", result.message || result.error || "Erro ao iniciar envio");
            return;
        }
    } catch (e) {
        console.log("[Panel] startSending: START_QUEUE error, fallback postMessage", e.message);
        window.parent.postMessage({
            type: "START_QUEUE",
            data: {
                prompts: waitingPrompts,
                settings: settings,
                folder: getFolder(tab),
                mediaType: tab,
                autoDownload: autoDownload
            }
        }, "*");
    }
}

async function continueSending(tab) {
    const st = tabState[tab];
    st.isRunning = true;
    updateBlockedOverlay();
    el(tab, "startBtn").classList.add("hidden");
    el(tab, "stopBtn").classList.remove("hidden");
    el(tab, "emergencyStopBtn").classList.remove("hidden");
    el(tab, "cancelAllBtn").classList.remove("hidden");
    updateStatus("running", "Retomando envio...");
    startStatePolling(tab);

    try { await chrome.runtime.sendMessage({ action: "RESUME_QUEUE", backgroundMode: backgroundMode }); }
    catch (e) { window.parent.postMessage({ type: "RESUME_QUEUE" }, "*"); }
}

async function stopSending(tab) {
    const st = tabState[tab];
    st.isRunning = false;
    stopAllTimers(tab);
    stopStatePolling(tab);
    updateBlockedOverlay();

    try { await chrome.runtime.sendMessage({ action: "PAUSE_QUEUE" }); }
    catch (e) { window.parent.postMessage({ type: "PAUSE_QUEUE" }, "*"); }

    updateStatus("warning", "Parado pelo usuario");
    el(tab, "stopBtn").classList.add("hidden");
    el(tab, "emergencyStopBtn").classList.add("hidden");
    el(tab, "startBtn").classList.remove("hidden");
    el(tab, "startBtn").textContent = "Continuar";
    el(tab, "startBtn").onclick = () => continueSending(tab);
    el(tab, "cancelAllBtn").classList.remove("hidden");
    el(tab, "timer").classList.add("hidden");
}

async function emergencyStop(tab) {
    console.log("[Panel] EMERGENCY STOP -", tab);
    const st = tabState[tab];
    st.isRunning = false;
    st._currentBatchSize = 0;
    st._preBatchDone = 0;
    stopAllTimers(tab);
    stopStatePolling(tab);
    updateBlockedOverlay();

    try { await chrome.runtime.sendMessage({ action: "CANCEL_QUEUE" }); } catch (e) { }
    try { window.parent.postMessage({ type: "CANCEL_QUEUE" }, "*"); } catch (e) { }

    updateStatus("warning", "PARADO - Fila cancelada");
    el(tab, "stopBtn").classList.add("hidden");
    el(tab, "emergencyStopBtn").classList.add("hidden");
    el(tab, "timer").classList.add("hidden");

    if (st.prompts.length > 0) {
        const failedPrompts = st.prompts.filter(p => p.status === "error" || p.status === "failed" || p.status === "waiting" || p.status === "sending");
        if (failedPrompts.length > 0) {
            el(tab, "resendBtn").classList.remove("hidden");
            el(tab, "resendBtn").textContent = "Reenviar Faltantes (" + failedPrompts.length + ")";
        }
        el(tab, "copyFailedBtn").classList.remove("hidden");
        el(tab, "startBtn").classList.remove("hidden");
        el(tab, "startBtn").textContent = "Novo Envio";
        el(tab, "startBtn").onclick = () => resetAll(tab);
    } else {
        el(tab, "startBtn").classList.remove("hidden");
        el(tab, "startBtn").textContent = "Novo Envio";
        el(tab, "startBtn").onclick = () => resetAll(tab);
    }

    // Se aba de imagem, voltar para modo de video
    if (tab === "image") {
        window.parent.postMessage({ type: "SWITCH_TO_VIDEO_MODE" }, "*");
    }
}

// ============================================
// FINISH SENDING
// ============================================
function finishSending(tab) {
    const st = tabState[tab];
    st.isRunning = false;
    // v3.1.0: Reset batch tracking so displayPrompts shows total count again
    st._currentBatchSize = 0;
    st._preBatchDone = 0;
    stopStatePolling(tab);
    updateBlockedOverlay();

    el(tab, "stopBtn").classList.add("hidden");
    el(tab, "emergencyStopBtn").classList.add("hidden");
    el(tab, "timer").classList.add("hidden");

    updateStatsDisplay(tab);

    const sentCount = st.prompts.filter(p => p.status === "sent" || p.status === "generated").length;
    const generatedCount = st.prompts.filter(p =>
        p.mediaStatus === "generated" || p.mediaStatus === "downloaded"
    ).length;
    const downloadedCount = st.prompts.filter(p => p.mediaStatus === "downloaded").length;
    const errorCount = st.prompts.filter(p => p.status === "error" || p.status === "failed").length;
    const notGeneratedYet = st.prompts.filter(p =>
        (p.status === "sent" || p.status === "generated") && p.mediaStatus === "pending" && !p._downloading
    ).length;
    const totalProblems = errorCount + notGeneratedYet;

    if (totalProblems > 0) {
        el(tab, "resendBtn").classList.remove("hidden");
        el(tab, "resendBtn").textContent = "Reenviar Nao Gerados (" + totalProblems + ")";
        el(tab, "copyFailedBtn").classList.remove("hidden");
    } else {
        el(tab, "resendBtn").classList.add("hidden");
        el(tab, "copyFailedBtn").classList.add("hidden");
    }

    el(tab, "startBtn").classList.remove("hidden");
    el(tab, "startBtn").textContent = "Novo Envio";
    el(tab, "startBtn").onclick = () => resetAll(tab);
    el(tab, "cancelAllBtn").classList.remove("hidden");

    const mediaLabel = (tab === "video" || tab === "frame") ? "videos" : "imagens";
    if (totalProblems === 0) {
        updateStatus("success", "Perfeito! Todos os " + sentCount + " " + mediaLabel + " foram gerados!");
    } else if (downloadedCount > 0) {
        updateStatus("success", "Concluido! " + downloadedCount + " " + mediaLabel + " baixados!");
    } else {
        updateStatus("warning", totalProblems + " prompt(s) precisam de atencao");
    }
}

// ============================================
// RESET / CANCEL
// ============================================
function resetAll(tab) {
    const st = tabState[tab];
    st.prompts = [];
    st.detectedMedia = {};
    stopStatePolling(tab);

    try { chrome.runtime.sendMessage({ action: "CANCEL_QUEUE" }); } catch (e) { }

    el(tab, "inputSection").classList.remove("hidden");
    el(tab, "settingsCard").classList.remove("hidden");
    const formatInfo = el(tab, "formatInfo");
    if (formatInfo) formatInfo.classList.remove("hidden");
    el(tab, "promptListCard").classList.add("hidden");
    el(tab, "progressContainer").classList.add("hidden");
    el(tab, "statusCard").classList.add("hidden");
    const frDiv = el(tab, "FolderReminder");
    if (frDiv) frDiv.classList.add("hidden");
    el(tab, "processBtn").classList.remove("hidden");
    el(tab, "startBtn").classList.add("hidden");
    el(tab, "stopBtn").classList.add("hidden");
    el(tab, "emergencyStopBtn").classList.add("hidden");
    el(tab, "resendBtn").classList.add("hidden");
    el(tab, "copyFailedBtn").classList.add("hidden");
    el(tab, "cancelAllBtn").classList.add("hidden");
    el(tab, "timer").classList.add("hidden");
    el(tab, "promptsInput").value = "";
    el(tab, "progressFill").style.width = "0%";
    el(tab, "progressText").textContent = "0%";
    document.getElementById("sharedSettingsCard").classList.remove("hidden");

    updateStatsDisplay(tab);
    updateStatus("success", "Pronto! Cole seus prompts para um novo envio");
}

async function cancelAll(tab) {
    if (!confirm("Cancelar tudo e resetar cache/log?")) return;
    const st = tabState[tab];
    st.isRunning = false;
    stopAllTimers(tab);
    stopStatePolling(tab);
    updateBlockedOverlay();

    // Reset completo: cancela fila E limpa todo cache/log do background
    try { await chrome.runtime.sendMessage({ action: "FULL_RESET" }); }
    catch (e) {
        try { await chrome.runtime.sendMessage({ action: "CANCEL_QUEUE" }); } catch (e2) { }
        window.parent.postMessage({ type: "CANCEL_QUEUE" }, "*");
    }

    st.prompts = [];
    st.detectedMedia = {};

    el(tab, "inputSection").classList.remove("hidden");
    el(tab, "settingsCard").classList.remove("hidden");
    const formatInfo = el(tab, "formatInfo");
    if (formatInfo) formatInfo.classList.remove("hidden");
    el(tab, "promptListCard").classList.add("hidden");
    el(tab, "progressContainer").classList.add("hidden");
    el(tab, "statusCard").classList.add("hidden");
    el(tab, "processBtn").classList.remove("hidden");
    el(tab, "startBtn").classList.add("hidden");
    el(tab, "stopBtn").classList.add("hidden");
    el(tab, "emergencyStopBtn").classList.add("hidden");
    el(tab, "cancelAllBtn").classList.add("hidden");
    el(tab, "resendBtn").classList.add("hidden");
    el(tab, "copyFailedBtn").classList.add("hidden");
    el(tab, "progressFill").style.width = "0%";
    el(tab, "progressText").textContent = "0%";
    el(tab, "timer").classList.add("hidden");
    el(tab, "promptsInput").value = "";
    document.getElementById("sharedSettingsCard").classList.remove("hidden");

    if (tab === "image") {
        window.parent.postMessage({ type: "SWITCH_TO_VIDEO_MODE" }, "*");
    }

    updateStatus("success", "Pronto! Cole seus prompts");
}

// ============================================
// RESEND / COPY FAILED
// ============================================
async function resendFailed(tab) {
    const st = tabState[tab];

    // Consultar log persistente para precisao extra
    try {
        const logData = await chrome.runtime.sendMessage({ action: "GET_PROMPT_LOG" });
        if (logData?.log?.length > 0) {
            for (const prompt of st.prompts) {
                // Procurar no log o registro mais recente deste prompt
                for (let i = logData.log.length - 1; i >= 0; i--) {
                    const entry = logData.log[i];
                    if (entry.number === prompt.number && entry.mediaType === tab) {
                        // Se o log diz que foi gerado/baixado mas o panel nao sabe, atualizar
                        if (entry.mediaStatus === "generated" && prompt.mediaStatus === "pending") {
                            prompt.mediaStatus = "generated";
                        } else if (entry.mediaStatus === "downloaded" && prompt.mediaStatus !== "downloaded") {
                            prompt.mediaStatus = "downloaded";
                        }
                        break;
                    }
                }
            }
        }
    } catch (e) { }

    // SO reenviar prompts que realmente falharam (com dados do log ja aplicados)
    const failedPrompts = st.prompts.filter(p =>
        p.status === "error" || p.status === "failed" ||
        (p.status === "sent" && p.mediaStatus === "pending" && !p._downloading)
    );

    if (failedPrompts.length === 0) {
        updateStatus("success", "Todos foram gerados!");
        el(tab, "resendBtn").classList.add("hidden");
        return;
    }

    failedPrompts.forEach(p => {
        p.status = "waiting";
        p.mediaStatus = "pending";
        p.mediaUrl = null;
        p.detectedUrl = null;
        p.mediaId = null;
        p._downloading = false;
        p.errorReason = null;
    });

    displayPrompts(tab);
    updateStatsDisplay(tab);
    updateStatus("warning", "Reenviando " + failedPrompts.length + " prompts...");
    el(tab, "resendBtn").classList.add("hidden");
    el(tab, "copyFailedBtn").classList.add("hidden");

    await startSending(tab);
}

function copyFailedNumbers(tab) {
    const st = tabState[tab];
    const failedPrompts = st.prompts.filter(p =>
        p.status === "error" || p.status === "failed" ||
        (p.status === "sent" && p.mediaStatus === "pending" && !p._downloading)
    );

    if (failedPrompts.length === 0) { updateStatus("success", "Nenhum faltante!"); return; }

    const numbers = failedPrompts.map(p => p.number).join(", ");
    window.parent.postMessage({ type: "COPY_TEXT", data: numbers }, "*");

    const textarea = document.createElement("textarea");
    textarea.value = numbers;
    textarea.style.cssText = "position:fixed;left:0;top:0;width:2px;height:2px;padding:0;border:none;outline:none;box-shadow:none;background:transparent;";
    document.body.appendChild(textarea);
    textarea.focus();
    textarea.select();

    let copied = false;
    try { copied = document.execCommand("copy"); } catch (e) { }
    document.body.removeChild(textarea);

    if (copied) updateStatus("success", "Copiado: " + numbers);
    else { updateStatus("warning", "Numeros: " + numbers); window.prompt("Copie manualmente:", numbers); }
}

// ============================================
// UTILITIES
// ============================================
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function showWaitingCounter(seconds, statusText, tab) {
    stopAllTimers(tab);
    const timer = el(tab, "timer");
    timer.classList.remove("hidden");
    updateStatus("warning", statusText);

    const st = tabState[tab];
    // v3.1.0: Contar apenas prompts que PRECISAM de download (excluir ja baixados)
    const totalPrompts = st.prompts.filter(p =>
        (p.status === "sent" || p.status === "generated") && p.mediaStatus !== "downloaded"
    ).length;
    // Total incluindo ja baixados (para early exit)
    const totalSent = st.prompts.filter(p => p.status === "sent" || p.status === "generated").length;

    for (let remaining = seconds; remaining >= 0; remaining--) {
        const mins = Math.floor(remaining / 60);
        const secs = remaining % 60;
        timer.textContent = String(mins).padStart(2, "0") + ":" + String(secs).padStart(2, "0");

        if (remaining % 2 === 0) {
            updateStatsDisplay(tab);
        }

        // Early exit: se todos os prompts ja foram baixados, nao precisa esperar
        const downloadedCount = st.prompts.filter(p => p.mediaStatus === "downloaded").length;
        if (downloadedCount >= totalSent) {
            console.log("[Panel] Todos", totalSent, "baixados - encerrando espera");
            break;
        }

        if (remaining > 0) await sleep(1000);
    }

    timer.classList.add("hidden");
}
