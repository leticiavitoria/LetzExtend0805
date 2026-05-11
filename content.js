// ============================================
// DOTTI SENDER FULL - CONTENT SCRIPT v3.0.0
// Copyright (c) DottiFlow - Todos os direitos reservados
// EXECUTOR DE DOM (recebe comandos do background)
// ============================================

(function () {
    "use strict";

    const PANEL_ID = "dotti-sender-full-panel";
    const TOGGLE_BTN_ID = "dotti-sender-toggle-btn";

    let isPanelVisible = false;
    let panelIframe = null;
    let toggleBtn = null;

    // v2.0.0: Buffer de mensagens para quando o iframe nao esta disponivel
    let messageBuffer = [];
    const MAX_BUFFER_SIZE = 50;

    // v3.2.0: Cache de seletores do servidor para galeria e outros elementos DOM
    let _cachedServerSelectors = null;

    async function fetchServerSelectors() {
        if (_cachedServerSelectors) return _cachedServerSelectors;
        try {
            const response = await new Promise((resolve, reject) => {
                chrome.runtime.sendMessage({ action: "GET_SELECTORS" }, (resp) => {
                    if (chrome.runtime.lastError) {
                        reject(chrome.runtime.lastError);
                    } else {
                        resolve(resp);
                    }
                });
            });
            if (response?.success && response.selectors) {
                _cachedServerSelectors = response.selectors;
                console.log('[Dotti] Selectors do servidor carregados:', Object.keys(_cachedServerSelectors));
                return _cachedServerSelectors;
            }
        } catch (e) {
            console.log('[Dotti] Falha ao buscar selectors do servidor:', e.message || e);
        }
        return null;
    }

    // ============================================
    // FUNCOES DE EXECUCAO NO DOM
    // ============================================

    // Clicar automaticamente no botao "Novo projeto" / "New project" na pagina inicial do Flow
    async function autoClickNewProject() {
        // Esperar botoes carregarem
        for (let i = 0; i < 10; i++) {
            const btns = document.querySelectorAll("button, a");
            for (const btn of btns) {
                const txt = (btn.textContent || "").toLowerCase().trim();
                if (txt.includes("novo projeto") || txt.includes("new project") ||
                    txt.includes("criar projeto") || txt.includes("create project") ||
                    txt.includes("new flow") || txt.includes("novo flow")) {
                    console.log("[Dotti DOM] Botao novo projeto encontrado:", btn.textContent?.trim());
                    btn.click();
                    return true;
                }
            }
            // Tambem procurar por icone "add" com texto de projeto
            for (const btn of btns) {
                const icon = btn.querySelector("i");
                if (icon && icon.textContent?.trim() === "add") {
                    const txt = (btn.textContent || "").toLowerCase();
                    if (txt.includes("project") || txt.includes("projeto") || txt.includes("flow")) {
                        console.log("[Dotti DOM] Botao add projeto encontrado:", btn.textContent?.trim());
                        btn.click();
                        return true;
                    }
                }
            }
            await sleep(1000);
        }

        // v3.1.0: Fallback via findElementRobust (multi-idioma)
        const robustBtn = findElementRobust({
            materialIcon: 'add',
            ariaLabel: ['New project', 'Novo projeto', 'New flow'],
            translationKey: 'new project'
        });
        if (robustBtn) {
            console.log("[Dotti DOM] Botao novo projeto encontrado via findElementRobust");
            robustBtn.click();
            return true;
        }

        console.log("[Dotti DOM] Botao novo projeto nao encontrado");
        return false;
    }

    function sleep(ms) {
        return new Promise(resolve => setTimeout(resolve, ms));
    }

    async function waitFor(conditionFn, timeout = 5000, interval = 100) {
        const start = Date.now();
        while (Date.now() - start < timeout) {
            if (conditionFn()) return true;
            await sleep(interval);
        }
        return false;
    }

    // Helper: remover acentos Unicode para comparacao robusta (NFC vs NFD)
    // "vídeo" (precomposed) e "vı́deo" (decomposed) ambos viram "video"
    function stripAccents(str) {
        return str.normalize("NFD").replace(/[\u0300-\u036f]/g, "");
    }

    // v2.0.2: Helper para encontrar tabs do menu de criacao do Flow
    // O Flow agora usa role="tab" dentro de role="menu" em vez de dropdown
    // Layout: [Image|Video] [Frames|Ingredients] [Paisagem|Retrato] [x1|x2|x3|x4]
    function findFlowMenuTabs() {
        const menu = document.querySelector('[role="menu"]');
        if (menu) return Array.from(menu.querySelectorAll('[role="tab"]'));
        // Fallback: todos os tabs visiveis
        return Array.from(document.querySelectorAll('[role="tab"]')).filter(t => {
            const r = t.getBoundingClientRect();
            return r.width > 0 && r.height > 0;
        });
    }

    // v2.0.2: Encontrar e clicar um tab especifico por keyword
    function findMenuTab(keyword) {
        const tabs = findFlowMenuTabs();
        return tabs.find(t => {
            const txt = stripAccents((t.textContent || "").toLowerCase().trim());
            return txt.includes(keyword);
        }) || null;
    }

    function isTabSelected(tab) {
        if (!tab) return false;
        return tab.getAttribute("aria-selected") === "true";
    }

    async function clickMenuTab(tab) {
        if (!tab) return false;
        reactClick(tab);
        await sleep(600);
        return true;
    }

    // v2.0.2: Verificar se esta em modo de imagem (tab Image selecionado)
    function isDropdownInImageMode() {
        const imageTab = findMenuTab("image");
        return imageTab ? isTabSelected(imageTab) : false;
    }

    // v2.0.2: Garantir modo correto (Ingredients ou Frames) + quantidade x1 no primeiro prompt
    let _firstPromptOfSession = true;

    async function switchMode(needElements, duration) {
        // v3.4.0: Determinar targets baseado em _mediaType
        // Group 1 (mediaType): 'image' → tab image, 'video'/'frame' → tab videocam
        // Group 2 (subMode):   'image' → nenhum, 'video' → frames/ingredients, 'frame' → frames
        let mediaTypeTarget = null;
        let subMode = null;

        if (_mediaType === 'image') {
            mediaTypeTarget = 'image';
            // Modo imagem: nao precisa de sub-modo (Frames/Ingredients nao se aplicam)
        } else if (_mediaType === 'frame') {
            mediaTypeTarget = 'video'; // Frame gera video a partir de imagem
            subMode = 'frames';        // Sempre Frames para frame mode
        } else {
            // video (default)
            mediaTypeTarget = 'video';
            subMode = needElements ? 'ingredients' : 'frames';
        }

        console.log("[Dotti DOM] switchMode: _mediaType=" + _mediaType + " mediaTarget=" + mediaTypeTarget + " subMode=" + subMode + " needElements=" + needElements);

        // v3.5.0: Sempre usar slate-helper (popup) — caminho de "tabs visiveis"
        // nao consegue setar duracao (4s/6s/8s estao apenas dentro do popup do Veo 3).
        const tabs = [];
        if (tabs.length === 0) {
            // Tabs nao visiveis — usar MAIN world PointerEvent via slate-helper.js
            console.log("[Dotti DOM] Abrindo seletor via MAIN world (sempre, p/ permitir set de duracao)");

            const wantDuration = (duration === 4 || duration === 6 || duration === 8) ? duration : 8;
            const result = await requestSlateHelper(
                'dotti-switch-mode',
                { mediaType: mediaTypeTarget, mode: subMode, setX1: _firstPromptOfSession, duration: wantDuration },
                'dotti-switch-mode-result',
                12000
            );

            console.log("[Dotti DOM] Switch mode result:", JSON.stringify(result));

            if (result.result === 'OK' || result.result === 'ALREADY_ACTIVE') {
                if (_firstPromptOfSession) _firstPromptOfSession = false;
                console.log("[Dotti DOM] Modo trocado com sucesso: media=" + mediaTypeTarget + " sub=" + subMode);
                return true;
            }

            console.log("[Dotti DOM] AVISO: Falha ao mudar modo via MAIN world —", result.result);
            return true;
        }

        // Tabs visiveis — usar abordagem direta
        // Group 1: Image/Video
        if (mediaTypeTarget === 'image') {
            const imageTab = findMenuTab("image");
            if (imageTab && !isTabSelected(imageTab)) {
                await clickMenuTab(imageTab);
                console.log("[Dotti DOM] Tab Image selecionado");
            }
        } else if (mediaTypeTarget === 'video') {
            const videoTab = findMenuTab("video");
            if (videoTab && !isTabSelected(videoTab)) {
                await clickMenuTab(videoTab);
                console.log("[Dotti DOM] Tab Video selecionado");
            }
        }

        // Group 2: Frames/Ingredients (so para video/frame)
        if (subMode) {
            const targetKeyword = subMode === 'ingredients' ? "ingredient" : "frame";
            const targetTab = findMenuTab(targetKeyword);
            if (targetTab && !isTabSelected(targetTab)) {
                await clickMenuTab(targetTab);
                console.log("[Dotti DOM] Tab selecionado:", targetTab.textContent?.trim());
            }
        }

        // Garantir x1 no primeiro prompt da sessao
        if (_firstPromptOfSession) {
            const x1Tab = tabs.find(t => {
                const txt = (t.textContent || "").trim();
                return txt === "x1";
            });
            if (x1Tab && !isTabSelected(x1Tab)) {
                await clickMenuTab(x1Tab);
                console.log("[Dotti DOM] Quantidade x1 selecionada");
            }
            _firstPromptOfSession = false;
        }

        return true;
    }

    // v2.0.2: Mudar a sidebar esquerda do projeto Flow (View images / View videos)
    // Separado dos tabs de criacao — sao os botoes na barra lateral esquerda
    async function switchFlowProjectTab(targetType) {
        console.log("[Dotti DOM] Procurando aba sidebar do projeto Flow:", targetType);

        const videoKeywords = ["video", "videos"];
        const imageKeywords = ["image", "imagem", "images", "imagens"];
        const keywords = targetType === "image" ? imageKeywords : videoKeywords;

        // Estrategia 1: Botoes da sidebar com "View images" / "View videos"
        const allButtons = document.querySelectorAll("button");
        for (const btn of allButtons) {
            if (btn.offsetParent === null) continue;
            const txt = stripAccents((btn.textContent || "").toLowerCase().trim());
            if (txt.length > 40) continue;
            // Sidebar buttons: "imageView images", "videocamView videos", "dashboardView full dashboard"
            if (keywords.some(k => txt.includes(k))) {
                const r = btn.getBoundingClientRect();
                // Sidebar esta no lado esquerdo (x < 100) e sao botoes pequenos (~40x40)
                if (r.left < 100 && r.width < 60) {
                    reactClick(btn);
                    await sleep(800);
                    console.log("[Dotti DOM] Sidebar clicada:", btn.textContent?.trim());
                    return true;
                }
            }
        }

        // Estrategia 2: Tabs de criacao com role="tab" (Image/Video no menu)
        const tabs = findFlowMenuTabs();
        for (const tab of tabs) {
            const txt = stripAccents((tab.textContent || "").toLowerCase().trim());
            if (keywords.some(k => txt.includes(k))) {
                if (!isTabSelected(tab)) {
                    await clickMenuTab(tab);
                    console.log("[Dotti DOM] Tab criacao clicado:", tab.textContent?.trim());
                }
                return true;
            }
        }

        console.log("[Dotti DOM] Aba do projeto nao encontrada para:", targetType);
        return false;
    }

    // v3.4.0: Mudar para modo de imagem (clicar tab Image)
    async function switchToImageMode() {
        console.log("[Dotti DOM] Mudando para modo de imagem...");

        const imageTab = findMenuTab("image");
        if (imageTab) {
            if (isTabSelected(imageTab)) {
                console.log("[Dotti DOM] Ja esta em modo imagem");
                return true;
            }
            await clickMenuTab(imageTab);
            console.log("[Dotti DOM] Modo de imagem selecionado via tab direto");
            return true;
        }

        // Fallback: usar MAIN world para abrir seletor e clicar Image
        console.log("[Dotti DOM] Tab Image nao encontrado — usando MAIN world");
        const result = await requestSlateHelper(
            'dotti-switch-mode',
            { mediaType: 'image' },
            'dotti-switch-mode-result', 12000
        );
        return result.result === 'OK' || result.result === 'ALREADY_ACTIVE';
    }

    // v3.4.0: Voltar para modo de video (clicar tab Video)
    async function switchToVideoMode() {
        console.log("[Dotti DOM] Voltando para modo de video...");

        const videoTab = findMenuTab("video");
        if (videoTab) {
            if (isTabSelected(videoTab)) {
                console.log("[Dotti DOM] Ja esta em modo video");
                return true;
            }
            await clickMenuTab(videoTab);
            console.log("[Dotti DOM] Modo de video selecionado via tab direto");
            return true;
        }

        // Fallback: usar MAIN world para abrir seletor e clicar Video
        console.log("[Dotti DOM] Tab Video nao encontrado — usando MAIN world");
        const result = await requestSlateHelper(
            'dotti-switch-mode',
            { mediaType: 'video' },
            'dotti-switch-mode-result', 12000
        );
        return result.result === 'OK' || result.result === 'ALREADY_ACTIVE';
    }

    async function clearElements() {
        console.log("[Dotti DOM] Limpando elementos do prompt (area do textbox)...");

        // Encontrar a area do textbox para limitar a busca
        const textarea = document.querySelector("[role='textbox']");
        if (!textarea) {
            console.log("[Dotti DOM] Textbox nao encontrado, pulando limpeza");
            return;
        }

        // Encontrar o container do prompt (ancestral comum do textbox e dos thumbnails)
        // Subir ate encontrar um container com largura razoavel
        let promptArea = textarea.parentElement;
        for (let i = 0; i < 5 && promptArea; i++) {
            if (promptArea.offsetWidth > 300) break;
            promptArea = promptArea.parentElement;
        }
        if (!promptArea) promptArea = textarea.parentElement;

        const textareaRect = textarea.getBoundingClientRect();

        for (let pass = 0; pass < 3; pass++) {
            const closeButtons = [];

            // Buscar APENAS botoes DENTRO do promptArea (area de composicao do prompt)
            // NUNCA buscar no document inteiro para nao deletar imagens da galeria
            promptArea.querySelectorAll("button").forEach(btn => {
                if (btn.offsetParent === null) return;
                const icon = btn.querySelector("i");
                const iconText = icon?.textContent?.trim();
                if (iconText !== "close" && iconText !== "clear") return;

                // Verificar se o botao esta perto do textarea verticalmente
                const btnRect = btn.getBoundingClientRect();
                const verticalDistance = Math.abs(btnRect.top - textareaRect.top);
                if (verticalDistance > 150) return; // Fora da area de composicao

                // Verificar se tem thumbnail (img) como irmao - indica elemento anexado ao prompt
                const parent = btn.parentElement;
                if (parent && parent.querySelector("img")) {
                    closeButtons.push(btn);
                }
            });

            if (closeButtons.length === 0) break;

            console.log("[Dotti DOM] Encontrados", closeButtons.length, "elementos para limpar (passada", pass + 1, ")");

            for (const btn of closeButtons) {
                try {
                    const reactKey = Object.keys(btn).find(k => k.startsWith("__reactProps"));
                    if (reactKey && btn[reactKey]?.onClick) {
                        btn[reactKey].onClick();
                    } else {
                        btn.click();
                    }
                    await sleep(200);
                } catch (e) {
                    console.log("[Dotti DOM] Erro ao limpar elemento:", e);
                }
            }

            await sleep(400);
        }

        console.log("[Dotti DOM] Limpeza de elementos concluida");
    }

    // v3.2.0: Reescrito — todas operacoes de galeria via MAIN world (slate-helper.js)
    // O ISOLATED world nao dispara React handlers corretamente
    async function addElement(elementIndex, selectedOriginalIndices) {
        console.log("[Dotti DOM] Adicionando elemento indice", elementIndex);

        // 1. Abrir galeria via MAIN world (slate-helper.js)
        const openResult = await requestSlateHelper(
            'dotti-open-gallery', {},
            'dotti-open-gallery-result', 5000
        );
        console.log("[Dotti DOM] Gallery open result:", JSON.stringify(openResult));
        if (openResult.result !== 'OK') {
            console.log("[Dotti DOM] Botao add galeria NAO encontrado ou falhou");
            return false;
        }

        // 2. Esperar galeria abrir (dialog com imagens)
        const galleryReady = await waitFor(() => {
            return document.querySelectorAll('[role="dialog"] img').length > 0 ||
                   document.querySelectorAll('[data-state="open"] img').length > 0;
        }, 8000);

        if (!galleryReady) {
            // Debug via MAIN world para ver o que tem no DOM
            const debugInfo = await requestSlateHelper(
                'dotti-gallery-debug', {},
                'dotti-gallery-debug-result', 3000
            );
            console.log("[Dotti DOM] Galeria nao abriu. Debug:", JSON.stringify(debugInfo, null, 0));
            // Se tem popover com imagens, pode ser a galeria — tentar usar
            if (debugInfo.hasPopover && debugInfo.popoverImgs > 0) {
                console.log("[Dotti DOM] Encontrado popover com", debugInfo.popoverImgs, "imagens — tentando usar");
                // Continuar sem retornar false
            } else {
                return false;
            }
        }
        await sleep(500);

        // 3. Ordenar por "Mais antigo" via MAIN world
        const sortResult = await requestSlateHelper(
            'dotti-sort-gallery', {},
            'dotti-sort-gallery-result', 5000
        );
        console.log("[Dotti DOM] Gallery sort result:", sortResult.result);
        if (sortResult.result === 'OK') {
            await sleep(1500); // Esperar galeria reordenar
        }

        // 4. Calcular indice ajustado (imagens ja selecionadas saem da galeria)
        let adjustedIdx = elementIndex;
        if (selectedOriginalIndices && selectedOriginalIndices.length > 0) {
            for (const prevIdx of selectedOriginalIndices) {
                if (prevIdx < elementIndex) adjustedIdx--;
            }
        }
        console.log("[Dotti DOM] Element -> originalIdx:", elementIndex, "adjustedIdx:", adjustedIdx,
            "prevSelected:", selectedOriginalIndices || []);

        // 5. Selecionar thumbnail via MAIN world
        const selectResult = await requestSlateHelper(
            'dotti-select-gallery-item', { index: adjustedIdx },
            'dotti-select-gallery-item-result', 5000
        );
        console.log("[Dotti DOM] Gallery select result:", JSON.stringify(selectResult));
        if (selectResult.result !== 'OK') {
            console.log("[Dotti DOM] Falha ao selecionar thumbnail idx:", adjustedIdx,
                "imgs disponíveis:", selectResult.imgCount);
            return false;
        }
        await sleep(1500);

        // 6. Fechar dialog via MAIN world
        const closeResult = await requestSlateHelper(
            'dotti-close-gallery', {},
            'dotti-close-gallery-result', 3000
        );
        console.log("[Dotti DOM] Gallery close result:", closeResult.result);
        await sleep(500);

        console.log("[Dotti DOM] Elemento", elementIndex, "adicionado com sucesso");
        return true;
    }

    // v3.1.0: Comunicacao com slate-helper.js (MAIN world) via CustomEvents
    // Substitui execInMainWorld que era bloqueado por CSP do labs.google
    function requestSlateHelper(eventName, detail, resultEventName, timeoutMs) {
        return new Promise((resolve) => {
            const requestId = '_dotti_' + Date.now() + '_' + Math.random().toString(36).substr(2, 6);
            detail.requestId = requestId;

            const handler = (e) => {
                if (e.detail?.requestId === requestId) {
                    document.removeEventListener(resultEventName, handler);
                    clearTimeout(timer);
                    resolve(e.detail);
                }
            };
            document.addEventListener(resultEventName, handler);

            const timer = setTimeout(() => {
                document.removeEventListener(resultEventName, handler);
                resolve({ result: 'TIMEOUT' });
            }, timeoutMs || 10000);

            document.dispatchEvent(new CustomEvent(eventName, { detail: detail }));
        });
    }

    // Helper: verifica se o input de prompt esta vazio
    function isPromptInputEmpty() {
        const ta = document.querySelector("[role='textbox']");
        if (ta) {
            const text = (ta.textContent || '').replace(/\u200B/g, '').trim();
            if (text.length === 0) return true;
            if (text.includes('O que voc') || text.includes('What do you')) return true;
            return false;
        }
        const pinhole = document.querySelector("#PINHOLE_TEXT_AREA_ELEMENT_ID");
        if (pinhole) return !pinhole.value || pinhole.value.length === 0;
        return true;
    }

    async function fillTextarea(text) {
        console.log("[Dotti DOM] Preenchendo textarea...");

        // === NOVO FLOW: Slate.js via slate-helper.js (MAIN world) ===
        const textbox = document.querySelector("[role='textbox']");
        if (textbox) {
            console.log("[Dotti DOM] Textbox Slate encontrado, enviando para slate-helper.js...");

            // Strategy 1: Slate API via slate-helper.js (MAIN world, bypasses CSP)
            const slateResult = await requestSlateHelper(
                'dotti-fill-slate',
                { text: text },
                'dotti-fill-slate-result',
                8000
            );

            console.log("[Dotti DOM] Slate helper result:", slateResult?.result);

            if (slateResult?.result === 'OK') {
                await sleep(300);
                return true;
            }

            // Strategy 2: Selection API + execCommand fallback (ISOLATED world)
            console.log("[Dotti DOM] Slate falhou (" + (slateResult?.result || 'unknown') + "), tentando Selection API...");
            dispatchFullClick(textbox);
            await sleep(200);
            textbox.focus();
            await sleep(100);

            const range = document.createRange();
            range.selectNodeContents(textbox);
            const sel = window.getSelection();
            sel.removeAllRanges();
            sel.addRange(range);
            await sleep(50);

            document.execCommand("delete", false, null);
            await sleep(50);

            const execOk = document.execCommand("insertText", false, text);
            if (!execOk || !(textbox.textContent || '').replace(/\u200B/g, '').trim()) {
                textbox.textContent = text;
                textbox.dispatchEvent(new InputEvent("input", {
                    bubbles: true, cancelable: true,
                    inputType: "insertText", data: text
                }));
            }

            textbox.dispatchEvent(new Event("input", { bubbles: true }));
            textbox.dispatchEvent(new Event("change", { bubbles: true }));
            await sleep(300);

            const ceText = (textbox.textContent || '').replace(/\u200B/g, '').trim();
            if (ceText.length > 0) {
                console.log("[Dotti DOM] Selection API fallback OK:", ceText.substring(0, 40));
                return true;
            }

            console.log("[Dotti DOM] Falha ao preencher textbox");
            return false;
        }

        // === LEGACY: textarea #PINHOLE ===
        let textarea = document.querySelector("#PINHOLE_TEXT_AREA_ELEMENT_ID");
        if (!textarea) {
            const textareas = document.querySelectorAll('textarea');
            for (const ta of textareas) {
                if (ta.id && ta.id.includes('recaptcha')) continue;
                if (ta.offsetParent === null) continue;
                textarea = ta;
                break;
            }
        }

        if (!textarea) {
            console.log("[Dotti DOM] Nenhum input encontrado");
            return false;
        }

        textarea.click();
        await sleep(100);
        textarea.focus();
        await sleep(100);

        textarea.value = "";
        textarea.dispatchEvent(new Event("input", { bubbles: true }));
        await sleep(100);

        textarea.select();
        document.execCommand("selectAll", false, null);
        document.execCommand("insertText", false, text);

        textarea.dispatchEvent(new Event("input", { bubbles: true }));
        textarea.dispatchEvent(new Event("change", { bubbles: true }));
        textarea.dispatchEvent(new KeyboardEvent("keyup", { bubbles: true }));
        await sleep(300);

        if (textarea.value !== text) {
            console.log("[Dotti DOM] Texto nao corresponde, tentando metodo alternativo...");
            const nativeInputValueSetter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set;
            nativeInputValueSetter.call(textarea, text);
            textarea.dispatchEvent(new Event('input', { bubbles: true }));
            await sleep(300);
        }

        const success = textarea.value.length > 0;
        console.log("[Dotti DOM] Textarea preenchido:", success, "- Tamanho:", textarea.value.length);
        return success;
    }

    // v3.1.0: dispatchFullClick — sequencia de 7 eventos de mouse (identico DarkPlanner)
    // React escuta pointerdown/mousedown, nao apenas click
    function dispatchFullClick(el) {
        const events = ["pointerover", "mouseover", "pointerdown", "mousedown", "pointerup", "mouseup", "click"];
        for (const eventName of events) {
            const evt = new MouseEvent(eventName, {
                bubbles: true,
                cancelable: true,
                composed: true,
                view: window,
                detail: 1
            });
            el.dispatchEvent(evt);
        }
    }

    // v3.1.0: Encontrar botao submit do Flow
    function findSubmitButton() {
        const SUBMIT_ICONS = ["arrow_forward", "send", "arrow_upward"];
        const tb = document.querySelector("[role='textbox']");
        const tbRect = tb ? tb.getBoundingClientRect() : null;
        const buttons = Array.from(document.querySelectorAll("button")).filter(b => b.offsetParent !== null);

        // Estrategia 1: aria-label especifico
        const ariaLabels = ["Create", "Criar", "Send", "Enviar", "Generate", "Gerar", "Submit"];
        for (const lab of ariaLabels) {
            const b = buttons.find(b => {
                const al = b.getAttribute("aria-label") || "";
                return al === lab || al.toLowerCase().includes(lab.toLowerCase());
            });
            if (b) return b;
        }

        // Estrategia 2: icone arrow_forward/send/arrow_upward MAIS PROXIMO do textbox
        // (evita pegar arrow_forward do header ou de popups)
        if (tbRect) {
            let nearest = null;
            let nearestDist = Infinity;
            for (const b of buttons) {
                const ic = b.querySelector("i");
                const t = ic?.textContent?.trim();
                if (!SUBMIT_ICONS.includes(t)) continue;
                const r = b.getBoundingClientRect();
                // submit fica perto da borda direita/inferior do textbox
                const dx = r.left - tbRect.right;
                const dy = r.top - tbRect.bottom;
                if (dx < -100 || dx > 250 || dy < -100 || dy > 250) continue;
                const d = Math.abs(dx) + Math.abs(dy);
                if (d < nearestDist) { nearest = b; nearestDist = d; }
            }
            if (nearest) return nearest;
        }

        // Estrategia 3 (ultimo recurso): primeiro arrow_forward/send/arrow_upward visivel
        for (const b of buttons) {
            const ic = b.querySelector("i");
            const t = ic?.textContent?.trim();
            if (SUBMIT_ICONS.includes(t)) return b;
        }

        // Fallback: findElementRobust
        return findElementRobust({
            materialIcon: 'arrow_forward',
            ariaLabel: ['Create', 'Send', 'Generate', 'Criar', 'Enviar', 'Gerar'],
            translationKey: 'generate'
        });
    }

    async function clickCreateButton() {
        console.log("[Dotti DOM] Clicando no botao criar...");

        const createBtn = findSubmitButton();

        if (!createBtn) {
            console.log("[Dotti DOM] Botao criar nao encontrado");
            return false;
        }

        if (createBtn.disabled) {
            console.log("[Dotti DOM] Botao criar esta desabilitado, aguardando...");
            for (let i = 0; i < 6; i++) {
                await sleep(500);
                if (!createBtn.disabled) break;
            }
            if (createBtn.disabled) {
                console.log("[Dotti DOM] Botao criar continua desabilitado");
                return false;
            }
        }

        // Strategy 0: TRUSTED CLICK via chrome.debugger (bypassa antibot do Veo Flow)
        // Eventos sinteticos sao isTrusted=false e o Flow rejeita; CDP gera click real.
        try {
            // Garante o botao no viewport e calcula centro em coords CSS
            createBtn.scrollIntoView({ block: "center", inline: "center", behavior: "instant" });
            await sleep(200);
            const r = createBtn.getBoundingClientRect();
            const x = Math.round(r.left + r.width / 2);
            const y = Math.round(r.top + r.height / 2);
            console.log("[Dotti DOM] Tentando TRUSTED click via chrome.debugger em (" + x + "," + y + ")");
            const tres = await chrome.runtime.sendMessage({ action: "TRUSTED_CLICK", x, y });
            console.log("[Dotti DOM] TRUSTED click result:", JSON.stringify(tres));
            await sleep(1200);
            if (isPromptInputEmpty()) {
                console.log("[Dotti DOM] Botao criar clicado com sucesso (TRUSTED)");
                return true;
            }
            console.log("[Dotti DOM] TRUSTED click nao limpou, caindo p/ MAIN world...");
        } catch (e) {
            console.log("[Dotti DOM] TRUSTED click falhou:", e.message);
        }

        // Strategy 1: MAIN world click via slate-helper.js (React __reactProps onClick)
        console.log("[Dotti DOM] Tentando click via MAIN world (slate-helper)...");
        const clickResult = await requestSlateHelper(
            'dotti-click-submit',
            {},
            'dotti-click-submit-result',
            5000
        );
        console.log("[Dotti DOM] MAIN world click result:", clickResult?.result);

        await sleep(1000);

        if (isPromptInputEmpty()) {
            console.log("[Dotti DOM] Botao criar clicado com sucesso (MAIN world)");
            return true;
        }

        // Strategy 2: 7-event sequence from ISOLATED world
        console.log("[Dotti DOM] MAIN world nao limpou, tentando 7-event click...");
        dispatchFullClick(createBtn);
        await sleep(1000);

        if (isPromptInputEmpty()) {
            console.log("[Dotti DOM] Botao criar clicado com sucesso (7-event)");
            return true;
        }

        // Strategy 3: Native click
        console.log("[Dotti DOM] 7-event nao limpou, tentando click nativo...");
        createBtn.click();
        await sleep(500);

        if (isPromptInputEmpty()) {
            console.log("[Dotti DOM] Botao criar clicado com sucesso (nativo)");
            return true;
        }

        // Strategy 4: Enter key
        console.log("[Dotti DOM] Tentando Enter key...");
        const textbox = document.querySelector("[role='textbox']");
        if (textbox) {
            textbox.focus();
            textbox.dispatchEvent(new KeyboardEvent('keydown', {
                key: 'Enter', code: 'Enter', keyCode: 13, which: 13,
                bubbles: true, cancelable: true, composed: true
            }));
            await sleep(100);
            textbox.dispatchEvent(new KeyboardEvent('keyup', {
                key: 'Enter', code: 'Enter', keyCode: 13, which: 13,
                bubbles: true, cancelable: true, composed: true
            }));
            await sleep(500);
        }

        // Verificar honestamente se alguma strategy de fato submeteu
        if (isPromptInputEmpty()) {
            console.log("[Dotti DOM] Botao criar clicado com sucesso (Enter key)");
            return true;
        }
        console.log("[Dotti DOM] FALHA: nenhuma strategy conseguiu submeter o prompt");
        return false;
    }

    // ============================================
    // EXECUTE PROMPT (CALLED BY BACKGROUND)
    // ============================================

    async function executePrompt(prompt) {
        console.log("[Dotti DOM] ========================================");
        console.log("[Dotti DOM] Executando PROMPT", prompt.number);
        console.log("[Dotti DOM] Texto:", prompt.text.substring(0, 50) + "...");
        console.log("[Dotti DOM] Elementos:", prompt.elements);
        console.log("[Dotti DOM] MediaType:", _mediaType, "| imageDataUrl:", prompt.imageDataUrl ? "sim" : "nao");

        try {
            const hasElements = prompt.elements && prompt.elements.length > 0;

            console.log("[Dotti DOM] Passo 1: Limpando elementos residuais...");
            await clearElements();
            await sleep(800);

            console.log("[Dotti DOM] Passo 2: Verificando modo...");
            const modeOk = await switchMode(hasElements, prompt.duration);
            if (!modeOk) {
                console.log("[Dotti DOM] ERRO: Falha ao mudar modo");
                return { success: false, error: "mode_switch_failed" };
            }
            await sleep(500);

            // v3.4.0: Frame mode — upload imagem inicial via MAIN world
            if (_mediaType === 'frame' && prompt.imageDataUrl) {
                console.log("[Dotti DOM] Passo 2b: Upload de imagem frame...");
                const frameResult = await requestSlateHelper(
                    'dotti-frame-upload',
                    { dataUrl: prompt.imageDataUrl, imageName: prompt.imageName || 'frame.png' },
                    'dotti-frame-upload-result',
                    60000 // v3.6.0: 60s — upload pode levar 30s + dialog sort + selection
                );
                console.log("[Dotti DOM] Frame upload result:", JSON.stringify(frameResult));
                if (frameResult.result !== 'OK') {
                    console.log("[Dotti DOM] AVISO: Frame upload falhou —", frameResult.result);
                    // Nao bloquear — pode funcionar sem imagem
                }
                await sleep(1000);
            }

            if (hasElements) {
                console.log("[Dotti DOM] Passo 3: Adicionando", prompt.elements.length, "elementos...");
                const selectedOriginalIndices = []; // v3.2.0: indices ja selecionados (0-based)
                for (const elementNum of prompt.elements) {
                    const originalIdx = elementNum - 1; // 0-based
                    const added = await addElement(originalIdx, selectedOriginalIndices);
                    if (!added) {
                        console.log("[Dotti DOM] ERRO: Falha ao adicionar elemento", elementNum);
                        return { success: false, error: "element_failed" };
                    }
                    selectedOriginalIndices.push(originalIdx); // registrar indice selecionado
                    await sleep(500);
                }
            }

            console.log("[Dotti DOM] Passo 4: Preenchendo prompt...");
            const filled = await fillTextarea(prompt.text);
            if (!filled) {
                console.log("[Dotti DOM] ERRO: Falha ao preencher textarea");
                return { success: false, error: "fill_failed" };
            }

            await sleep(1000);

            console.log("[Dotti DOM] Passo 5: Enviando...");
            const clicked = await clickCreateButton();
            if (!clicked) {
                console.log("[Dotti DOM] ERRO: Falha ao clicar no botao criar");
                return { success: false, error: "click_failed" };
            }

            await sleep(2000);

            if (!isPromptInputEmpty()) {
                console.log("[Dotti DOM] AVISO: Input ainda tem conteudo, tentando enviar novamente...");
                await clickCreateButton();
                await sleep(1500);
            }

            console.log("[Dotti DOM] PROMPT", prompt.number, "executado com SUCESSO");
            console.log("[Dotti DOM] ========================================");
            return { success: true };

        } catch (error) {
            console.error("[Dotti DOM] ERRO CRITICO:", error);
            return { success: false, error: error.message };
        }
    }

    // ============================================
    // PANEL MANAGEMENT - v2.0.0 COM BUFFER
    // ============================================

    // v2.0.0: Encontrar iframe do painel de forma resiliente
    function findPanelIframe() {
        if (panelIframe?.contentWindow) return panelIframe;

        const panelContainer = document.getElementById(PANEL_ID);
        if (panelContainer) {
            const iframe = panelContainer.querySelector("iframe");
            if (iframe?.contentWindow) {
                panelIframe = iframe;
                return iframe;
            }
        }
        return null;
    }

    function notifyPanel(message) {
        const iframe = findPanelIframe();
        if (iframe?.contentWindow) {
            // v2.0.0: Enviar mensagens do buffer primeiro
            flushMessageBuffer();
            iframe.contentWindow.postMessage(message, "*");
            return;
        }

        // v2.0.0: Se iframe nao disponivel, armazenar no buffer
        if (messageBuffer.length < MAX_BUFFER_SIZE) {
            messageBuffer.push(message);
        }
    }

    // v2.0.0: Enviar mensagens pendentes do buffer
    function flushMessageBuffer() {
        if (messageBuffer.length === 0) return;
        const iframe = findPanelIframe();
        if (!iframe?.contentWindow) return;

        const buffered = [...messageBuffer];
        messageBuffer = [];
        for (const msg of buffered) {
            iframe.contentWindow.postMessage(msg, "*");
        }
    }

    function createPanel() {
        if (document.getElementById(PANEL_ID)) return;

        const container = document.createElement("div");
        container.id = PANEL_ID;
        container.className = "dotti-panel-container";

        const header = document.createElement("div");
        header.className = "dotti-panel-header";
        header.innerHTML = `
            <div class="dotti-panel-title">
                <span class="dotti-icon"><svg width="18" height="18" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg"><path d="M13 2L4 14H11L10 22L19 10H12L13 2Z" fill="#FFD700" stroke="#FFD700" stroke-width="1" stroke-linecap="round" stroke-linejoin="round"/></svg></span>
                <span>Lets Automate</span>
            </div>
            <div class="dotti-panel-actions">
                <button class="dotti-btn-minimize" title="Minimizar">&minus;</button>
                <button class="dotti-btn-close" title="Fechar">&times;</button>
            </div>
        `;

        panelIframe = document.createElement("iframe");
        panelIframe.src = chrome.runtime.getURL("panel.html");
        panelIframe.className = "dotti-panel-iframe";

        // v2.0.0: Quando iframe carregar, enviar mensagens do buffer
        // v2.0.3: Tambem verificar janela da extensao APOS iframe carregar (timing seguro)
        panelIframe.addEventListener("load", () => {
            setTimeout(() => {
                flushMessageBuffer();
                // content.js tem sender.tab (ao contrario do panel.html que e extension page)
                chrome.runtime.sendMessage({ action: "IS_EXTENSION_WINDOW" }, (resp) => {
                    notifyPanel({ type: "EXTENSION_WINDOW_STATUS", data: { isExtensionWindow: resp?.isExtensionWindow || false } });
                });
            }, 500);
        });

        container.appendChild(header);
        container.appendChild(panelIframe);
        document.body.appendChild(container);

        header.querySelector(".dotti-btn-close").addEventListener("click", togglePanel);
        header.querySelector(".dotti-btn-minimize").addEventListener("click", () => {
            container.classList.toggle("minimized");
        });
    }

    function togglePanel() {
        const panel = document.getElementById(PANEL_ID);
        if (!panel) {
            createPanel();
            isPanelVisible = true;
        } else {
            isPanelVisible = !isPanelVisible;
            if (isPanelVisible) {
                panel.style.display = "flex";
                panel.classList.remove("dotti-sidebar-hidden");
            } else {
                panel.classList.add("dotti-sidebar-hidden");
                setTimeout(() => { panel.style.display = "none"; }, 300);
            }
        }
        if (toggleBtn) {
            toggleBtn.classList.toggle("active", isPanelVisible);
            toggleBtn.classList.toggle("sidebar-closed", !isPanelVisible);
        }
        document.documentElement.classList.toggle("dotti-sidebar-open", isPanelVisible);
    }

    // ============================================
    // API INTERCEPTOR (MAIN WORLD)
    // ============================================

    function injectInterceptor() {
        if (document.querySelector('script[data-dotti-interceptor]')) return;
        const s = document.createElement('script');
        s.src = chrome.runtime.getURL('interceptor.js');
        s.dataset.dottiInterceptor = 'true';
        (document.head || document.documentElement).appendChild(s);
        console.log('[Dotti] Interceptor injected into MAIN WORLD');
    }

    // v3.1.0: Injeta slate-helper.js no MAIN world (bypass CSP)
    // Handles Slate.js text fill + submit button click via React internals
    function injectSlateHelper() {
        if (document.querySelector('script[data-dotti-slate-helper]')) return;
        const s = document.createElement('script');
        s.src = chrome.runtime.getURL('slate-helper.js');
        s.dataset.dottiSlateHelper = 'true';
        (document.head || document.documentElement).appendChild(s);
        console.log('[Dotti] SlateHelper injected into MAIN WORLD');
    }

    function setupApiInterceptorListeners() {
        // Video submitted -> popular _mediaTracker (identico DarkPlanner)
        document.addEventListener('dotti-video-submitted', (e) => {
            const { media, timestamp } = e.detail;
            console.log('[Dotti] API: video-submitted', media?.length, 'entries');

            if (media && Array.isArray(media)) {
                for (const entry of media) {
                    if (!entry.mediaId) continue;

                    let matchedPromptNumber = null;
                    const entryPrompt = (entry.prompt || '').toLowerCase().trim();

                    // Match por texto do prompt contra _promptList (identico DarkPlanner)
                    // Busca em duas passagens: primeiro 'generating', depois 'sending'/'pending'
                    // (API pode chegar ANTES do status ser atualizado)
                    if (entryPrompt.length > 10) {
                        for (const statusToMatch of ['generating', 'sending']) {
                            for (const p of _promptList) {
                                if (p.status !== statusToMatch) continue;
                                const tp = (p.text || '').toLowerCase().trim();

                                // includes bidirecional
                                if (tp.includes(entryPrompt) || entryPrompt.includes(tp)) {
                                    matchedPromptNumber = p.number;
                                    break;
                                }
                                // versao sem brackets
                                const tpClean = tp.replace(/\[[^\]]+\]/g, '').trim();
                                const epClean = entryPrompt.replace(/\[[^\]]+\]/g, '').trim();
                                if (tpClean.includes(epClean) || epClean.includes(tpClean)) {
                                    matchedPromptNumber = p.number;
                                    break;
                                }
                                // primeiros 50 chars
                                if (tp.length >= 30 && entryPrompt.length >= 30 &&
                                    tp.substring(0, 50) === entryPrompt.substring(0, 50)) {
                                    matchedPromptNumber = p.number;
                                    break;
                                }
                                // limpeza com sem numeros no inicio
                                const tpClean2 = tpClean.substring(0, 50);
                                const epClean2 = epClean.substring(0, 50);
                                if (tpClean2.length >= 30 && epClean2.length >= 30 && tpClean2 === epClean2) {
                                    matchedPromptNumber = p.number;
                                    break;
                                }
                            }
                            if (matchedPromptNumber) break;
                        }
                    }

                    // Fallback: lastSubmittedPromptNumber (dentro de 30s)
                    if (!matchedPromptNumber && _lastSubmittedPromptNumber &&
                        (Date.now() - _lastSubmittedTime) < 30000) {
                        matchedPromptNumber = _lastSubmittedPromptNumber;
                    }

                    const trackerEntry = {
                        prompt: entry.prompt || '',
                        promptNumber: matchedPromptNumber,
                        status: 'PENDING',
                        operationName: entry.operationName || ''
                    };

                    // Se a API nao retornou prompt mas temos match, copiar do prompt list
                    if (!trackerEntry.prompt && matchedPromptNumber) {
                        const matched = _promptList.find(p => p.number === matchedPromptNumber);
                        if (matched) trackerEntry.prompt = matched.text;
                    }

                    _mediaTracker.set(entry.mediaId, trackerEntry);

                    // Marcar prompt como 'generating'
                    if (matchedPromptNumber) {
                        const prompt = _promptList.find(p => p.number === matchedPromptNumber);
                        if (prompt && (prompt.status === 'sending' || prompt.status === 'waiting')) {
                            prompt.status = 'generating';
                            prompt.startedAt = Date.now();
                        }
                    }

                    console.log('[Dotti] mediaTracker.set:', entry.mediaId.substring(0, 12),
                        '-> prompt #' + (matchedPromptNumber || '?'));
                }
            }

            notifyPanel({ type: 'VIDEO_SUBMITTED', data: { media, timestamp } });
            chrome.runtime.sendMessage({ action: 'VIDEO_SUBMITTED', media }).catch(() => { });
            startVideoUrlScanner();
        });

        // Video status update (identico DarkPlanner)
        document.addEventListener('dotti-video-status', (e) => {
            const { updates, timestamp } = e.detail;
            console.log('[Dotti] API: video-status', updates?.length, 'updates');

            if (updates && Array.isArray(updates)) {
                for (const update of updates) {
                    if (!update.mediaId) continue;
                    const tracked = _mediaTracker.get(update.mediaId);

                    if (tracked) {
                        tracked.status = update.status;

                        if (update.status === 'COMPLETED' && tracked.promptNumber) {
                            const prompt = _promptList.find(p => p.number === tracked.promptNumber);
                            if (prompt) {
                                if (prompt.status === 'failed') {
                                    // Se o prompt estava marcado como 'failed' pelo DOM, reverter para 'generating'
                                    // para que o scanner encontre o video e baixe
                                    prompt.status = 'generating';
                                    console.log('[Dotti] Prompt #' + prompt.number + ' revertido para generating (API COMPLETED)');
                                } else if (prompt.status === 'generating') {
                                    // v3.1.0: Se nao usa auto-download, marcar como complete para liberar slot
                                    if (!_autoDownload) {
                                        prompt.status = 'complete';
                                        console.log('[Dotti] Prompt #' + prompt.number + ' marcado complete (API, sem auto-download)');
                                    }
                                    // Com auto-download, o scanner vai marcar 'complete' apos baixar
                                }
                            }
                        }

                        if (update.status === 'FAILED') {
                            // Tentar encontrar o prompt pelo promptNumber ou por texto
                            let failedPromptNumber = tracked.promptNumber;
                            if (!failedPromptNumber && tracked.prompt && tracked.prompt.length > 10) {
                                const entryPrompt = tracked.prompt.toLowerCase().trim();
                                const matchedP = _promptList.find(pr => {
                                    if (pr.status !== 'generating') return false;
                                    const tp = (pr.text || '').toLowerCase().trim();
                                    return tp.includes(entryPrompt) || entryPrompt.includes(tp) ||
                                        tp.substring(0, 50) === entryPrompt.substring(0, 50);
                                });
                                if (matchedP) {
                                    failedPromptNumber = matchedP.number;
                                    tracked.promptNumber = failedPromptNumber;
                                    console.log('[Dotti] FAILED media matched prompt #' + failedPromptNumber + ' por texto');
                                }
                            }

                            if (failedPromptNumber) {
                                const prompt = _promptList.find(p => p.number === failedPromptNumber && p.status === 'generating');
                                if (prompt) {
                                    // v3.1.0: Classificacao com retry + handleErrorByType para rewrite/recovery
                                    const classifyAndHandle = (attempt) => {
                                        const failType = classifyFailedTileByDOM(update.mediaId, prompt);

                                        // Se fallback generico e primeira tentativa, espera DOM carregar
                                        if (failType === 'POLICY' && attempt === 0) {
                                            setTimeout(() => classifyAndHandle(1), 2000);
                                            return;
                                        }

                                        console.log('[Dotti] API FAILED #' + prompt.number + ' tipo:', failType);
                                        // Delegar para handleErrorByType (libera slot, rewrite, retry)
                                        handleErrorByType(failType, prompt);
                                    };
                                    classifyAndHandle(0);
                                }
                            } else {
                                console.warn('[Dotti] FAILED media ' + update.mediaId.substring(0, 12) +
                                    ' sem prompt associado (prompt: "' + (tracked.prompt || '').substring(0, 40) + '")');
                            }
                        }

                        console.log('[Dotti] mediaTracker update:', update.mediaId.substring(0, 12),
                            '->', update.status);
                    } else {
                        // mediaId nao estava no tracker — criar entrada nova
                        _mediaTracker.set(update.mediaId, {
                            prompt: update.prompt || '',
                            promptNumber: null,
                            status: update.status
                        });
                    }
                }
            }

            notifyPanel({ type: 'VIDEO_STATUS_UPDATE', data: { updates, timestamp } });
            chrome.runtime.sendMessage({ action: 'VIDEO_STATUS_UPDATE', updates }).catch(() => { });
            startVideoUrlScanner();
        });

        // Image generated (batchGenerateImages)
        // v3.5.0: Match imagens a tasks e marcar como complete (libera slots)
        document.addEventListener('dotti-image-generated', (e) => {
            const { images } = e.detail;
            console.log('[Dotti] API: image-generated', images?.length, 'images');
            notifyPanel({ type: 'IMAGE_GENERATED', data: { images } });

            if (!images || !Array.isArray(images)) return;

            for (const img of images) {
                if (!img.imageUrl) continue;

                let matchedTask = null;

                // Match por mediaId via _mediaTracker (100% preciso)
                if (img.mediaId && _mediaTracker.has(img.mediaId)) {
                    const tracked = _mediaTracker.get(img.mediaId);
                    if (tracked.promptNumber) {
                        matchedTask = _promptList.find(t =>
                            t.number === tracked.promptNumber && t.status === 'generating'
                        );
                    }
                    if (!matchedTask && tracked.prompt) {
                        const apiPrompt = tracked.prompt.toLowerCase().trim();
                        matchedTask = _promptList.find(t => {
                            if (t.status !== 'generating') return false;
                            const tp = (t.text || '').toLowerCase().trim();
                            return tp.includes(apiPrompt) || apiPrompt.includes(tp) ||
                                (tp.length >= 30 && apiPrompt.length >= 30 &&
                                    tp.substring(0, 50) === apiPrompt.substring(0, 50));
                        });
                    }
                }

                // Match por texto do prompt (primeiros 50 chars)
                if (!matchedTask && img.prompt) {
                    const imgPrompt = img.prompt.substring(0, 50).toLowerCase().trim();
                    matchedTask = _promptList.find(t => {
                        if (t.status !== 'generating') return false;
                        const tp = (t.text || '').toLowerCase().trim();
                        return tp.substring(0, 50) === imgPrompt ||
                            tp.includes(imgPrompt) || imgPrompt.includes(tp.substring(0, 50));
                    });
                }

                // Fallback: sequencial (task gerando mais antiga)
                if (!matchedTask) {
                    const generating = _promptList
                        .filter(t => t.status === 'generating')
                        .sort((a, b) => (a.startedAt || 0) - (b.startedAt || 0));
                    if (generating.length > 0) {
                        matchedTask = generating[0];
                    }
                }

                if (matchedTask) {
                    matchedTask.foundVideos++;
                    matchedTask.downloaded = true;
                    matchedTask.status = 'complete';
                    matchedTask.imageUrl = img.imageUrl;
                    console.log('[Dotti] Image complete: #' + matchedTask.number + ' -> ' + (img.mediaId || '').substring(0, 12));
                    // Download é feito pelo panel.js via handleImageGenerated
                }
            }
        });

        // Image upscaled (upsampleImage)
        document.addEventListener('dotti-image-upscaled', (e) => {
            console.log('[Dotti] API: image-upscaled');
            notifyPanel({ type: 'IMAGE_UPSCALED', data: e.detail });
        });

        // Upload result (frame/reference image)
        document.addEventListener('dotti-upload-result', (e) => {
            console.log('[Dotti] API: upload-result', e.detail?.source);
            notifyPanel({ type: 'UPLOAD_RESULT', data: e.detail });
        });

        // Upload error
        document.addEventListener('dotti-upload-error', (e) => {
            console.log('[Dotti] API: upload-error', e.detail?.error);
            notifyPanel({ type: 'UPLOAD_ERROR', data: e.detail });
        });
    }

    // v3.1.0: setupNetworkErrorInterceptor — HTTP 400 recovery para video submit
    function setupNetworkErrorInterceptor() {
        document.addEventListener('dotti-video-submit-error', async (e) => {
            const { httpStatus, url } = e.detail || {};
            console.log('[Dotti] Network error interceptado: HTTP ' + httpStatus + ' url=' + (url || '').substring(0, 80));

            if (httpStatus === 400 && url && url.indexOf('batchAsyncGenerateVideoText') !== -1) {
                console.log('[Dotti] HTTP 400 em batchAsyncGenerateVideoText — iniciando recovery...');

                // Salvar estado para recovery
                const recoveryState = {
                    timestamp: Date.now(),
                    prompts: _promptList.map(t => ({
                        index: t.index,
                        number: t.number,
                        text: t.text,
                        prompt: t.prompt,
                        elements: t.elements,
                        status: t.status === 'generating' ? 'pending' : t.status,
                        retryCount: t.retryCount || 0,
                        isRetry: t.isRetry || false,
                        originalIndex: t.originalIndex,
                        foundVideos: t.foundVideos || 0,
                        downloaded: t.downloaded || false
                    })),
                    folder: _downloadFolder,
                    mediaType: _mediaType,
                    autoDownload: _autoDownload,
                    maxSimultaneous: _maxSimultaneous
                };

                await chrome.storage.local.set({ 'dotti_veo400_recovery_state': recoveryState });

                _stopRequested = true;
                _isRunning = false;

                notifyPanel({ type: 'VEO400_RECOVERY', data: { httpStatus } });

                // Navegar para pagina neutra e retornar
                window.location.href = 'https://dottiflow.com.br/?dotti_veo400_recovery=true';
            }
        });
    }

    // v3.1.0: checkVeo400RecoveryState — chamado no startup
    async function checkVeo400RecoveryState() {
        try {
            const stored = await chrome.storage.local.get('dotti_veo400_recovery_state');
            const state = stored.dotti_veo400_recovery_state;
            if (!state) return false;

            // Verificar se e recente (< 5 minutos)
            if (Date.now() - state.timestamp > 300000) {
                await chrome.storage.local.remove('dotti_veo400_recovery_state');
                return false;
            }

            console.log('[Dotti] VEO400 Recovery state encontrado, retomando...');
            await chrome.storage.local.remove('dotti_veo400_recovery_state');

            // Criar novo projeto
            await autoClickNewProject();
            await sleep(3000);

            // Reconstruir promptList
            const remainingPrompts = (state.prompts || []).filter(t =>
                t.status === 'pending' || t.status === 'generating'
            );

            if (remainingPrompts.length === 0) {
                console.log('[Dotti] VEO400 Recovery: nenhum prompt pendente');
                return false;
            }

            _maxSimultaneous = state.maxSimultaneous || 3;
            _downloadFolder = state.folder || 'LetzVideos';
            _mediaType = state.mediaType || 'video';
            _autoDownload = state.autoDownload !== false;

            resetVideoUrlScanner();

            _promptList = remainingPrompts.map((p, i) => ({
                ...p,
                index: i,
                status: 'pending',
                uuid: null,
                startedAt: null,
                lastSubmitTime: null
            }));

            _tasksByUUID.clear();
            _processedTaskUUIDs.clear();
            _sendLockByIndex.clear();
            _consecutiveErrorCount = 0;
            _notifiedPolicyErrors.clear();
            _pendingRewrites = 0;
            _stopRequested = false;
            _activeSlots = 0;

            console.log('[Dotti] VEO400 Recovery: retomando ' + _promptList.length + ' prompts');
            notifyPanel({ type: 'VEO400_RECOVERED', data: { count: _promptList.length } });

            processAllPromptsWithSlots();
            return true;
        } catch (e) {
            console.error('[Dotti] VEO400 Recovery erro:', e);
            return false;
        }
    }

    // ============================================
    // MEDIA TRACKER + DOM SCANNER + DOWNLOAD (identico DarkPlanner)
    // ============================================

    const _mediaTracker = new Map(); // mediaId -> { prompt, promptNumber, status, operationName }
    let _promptList = [];
    let _downloadFolder = 'LetzVideos';
    let _mediaType = 'video';
    let _autoDownload = true;
    const _downloadedVideoUrls = new Set();
    const _itemIndexToPrompt = new Map(); // data-item-index -> promptNumber
    let _lastSubmittedPromptNumber = null;
    let _lastSubmittedTime = 0;
    let _videoScannerInterval = null;
    let _scannerActive = false;
    let _scannerScrollPosition = 0;
    let _nextItemIndex = 0;
    const _processedFailedPrompts = new Set();
    const _processedFailedTileIds = new Set();

    // ============================================
    // SLOT SYSTEM (identico DarkPlanner v8)
    // Processamento simultaneo com N slots
    // ============================================
    let _maxSimultaneous = 3;              // Default, configuravel ate 20
    let _slots = [];                       // Array(N).fill(null) — UUID da task em cada slot
    const _tasksByUUID = new Map();        // UUID → task object
    const _processedTaskUUIDs = new Set(); // Evita reprocessamento
    const _sendLockByIndex = new Map();    // originalIndex → timestamp (60s lock)
    const _SEND_LOCK_DURATION_MS = 60000;  // 60 segundos de trava
    let _consecutiveErrorCount = 0;
    const _MAX_CONSECUTIVE_ERRORS = 5;     // Se 5 erros seguidos, para tudo
    const _notifiedPolicyErrors = new Set(); // UUID-based dedup
    let _pendingRewrites = 0;
    let _rewriteWaitStart = 0; // v3.1.0: timestamp de quando comecamos a esperar rewrites
    let _stopRequested = false;
    let _isRunning = false;
    let _activeSlots = 0;
    let _recentHighDemandError = false;
    let _lastSubmittedTaskIndex = -1;
    let _currentQueueSettings = {};
    let _currentQueueMediaType = 'video';
    const MAX_RETRIES = 3;

    // ============================================
    // XPATH HELPER + ERROR DETECTION (identico DarkPlanner)
    // ============================================

    function xpathEval(xpath) {
        try {
            return document.evaluate(xpath, document, null, XPathResult.FIRST_ORDERED_NODE_TYPE, null).singleNodeValue;
        } catch (e) { return null; }
    }

    // v3.1.0: TRANSLATIONS — centralizado multi-idioma (EN/PT/ES)
    const TRANSLATIONS = {
        'new project':      ['new project', 'novo projeto', 'nuevo proyecto', 'criar projeto', 'create project', 'new flow', 'novo flow'],
        'generate':         ['generate', 'gerar', 'generar', 'create', 'criar', 'crear'],
        'reuse prompt':     ['reuse prompt', 'reutilizar prompt', 'reutilizar', 'reuse', 'reusar prompt'],
        'add to prompt':    ['add to prompt', 'adicionar ao prompt', 'añadir al prompt', 'add prompt'],
        'text to video':    ['text to video', 'texto para video', 'texto para vídeo', 'text-to-video'],
        'frame to video':   ['frame to video', 'frame para video', 'frame para vídeo', 'image to video', 'imagem para video'],
        'create image':     ['create image', 'criar imagem', 'crear imagen', 'generate image', 'gerar imagem'],
        'failed generation':['failed generation', 'geração falhou', 'falha na geração', 'generación fallida', 'generation failed']
    };

    // v3.1.0: findElementRobust() — 5 estratégias em cascata (identico DarkPlanner)
    // opts: { xpath, materialIcon, selector, ariaLabel, translationKey, tag }
    function findElementRobust(opts) {
        if (!opts) return null;

        // Estrategia 1: XPath evaluation
        if (opts.xpath) {
            const el = xpathEval(opts.xpath);
            if (el) {
                console.log('[Dotti findElementRobust] Found via xpath');
                return el;
            }
        }

        // Estrategia 2: Material icon text → closest button
        if (opts.materialIcon) {
            const icons = document.querySelectorAll('i, span.material-icons, span.material-icons-outlined, span.material-symbols-outlined');
            for (const icon of icons) {
                if (icon.textContent?.trim() === opts.materialIcon) {
                    const btn = icon.closest('button') || icon.closest('a') || icon.parentElement;
                    if (btn) {
                        console.log('[Dotti findElementRobust] Found via materialIcon:', opts.materialIcon);
                        return btn;
                    }
                }
            }
        }

        // Estrategia 3: CSS selector
        if (opts.selector) {
            const el = document.querySelector(opts.selector);
            if (el) {
                console.log('[Dotti findElementRobust] Found via selector:', opts.selector);
                return el;
            }
        }

        // Estrategia 4: aria-label match
        if (opts.ariaLabel) {
            const labels = Array.isArray(opts.ariaLabel) ? opts.ariaLabel : [opts.ariaLabel];
            for (const label of labels) {
                const el = document.querySelector('[aria-label*="' + label + '"]');
                if (el) {
                    console.log('[Dotti findElementRobust] Found via aria-label:', label);
                    return el;
                }
            }
        }

        // Estrategia 5: Multi-language text via TRANSLATIONS
        if (opts.translationKey && TRANSLATIONS[opts.translationKey]) {
            const variants = TRANSLATIONS[opts.translationKey];
            const tag = opts.tag || 'button, a';
            const candidates = document.querySelectorAll(tag);
            for (const el of candidates) {
                const txt = stripAccents((el.textContent || '').toLowerCase().trim());
                for (const variant of variants) {
                    if (txt.includes(variant)) {
                        // Verificar que esta visivel
                        const rect = el.getBoundingClientRect();
                        if (rect.width > 0 && rect.height > 0) {
                            console.log('[Dotti findElementRobust] Found via translation:', variant);
                            return el;
                        }
                    }
                }
            }
        }

        return null;
    }

    const ERROR_SELECTORS = {
        TIMEOUT: "//li[@data-sonner-toast and .//*[contains(translate(., 'ABCDEFGHIJKLMNOPQRSTUVWXYZ', 'abcdefghijklmnopqrstuvwxyz'), 'taking longer')]]",
        HIGH_DEMAND: "//li[@data-sonner-toast and .//*[contains(translate(., 'ABCDEFGHIJKLMNOPQRSTUVWXYZ', 'abcdefghijklmnopqrstuvwxyz'), 'high demand') or contains(translate(., 'ABCDEFGHIJKLMNOPQRSTUVWXYZ', 'abcdefghijklmnopqrstuvwxyz'), 'experiencing high')]]",
        RATE_LIMIT: "//li[@data-sonner-toast and .//*[contains(translate(., 'ABCDEFGHIJKLMNOPQRSTUVWXYZ', 'abcdefghijklmnopqrstuvwxyz'), \"couldn't generate\") or contains(translate(., 'ABCDEFGHIJKLMNOPQRSTUVWXYZ', 'abcdefghijklmnopqrstuvwxyz'), 'try again later')]]",
        QUEUE_FULL: "//li[@data-sonner-toast and .//i[normalize-space(text())='error'] and .//*[contains(., '5')]]",
        ANY_ERROR: "//li[@data-sonner-toast and .//i[normalize-space(text())='error']]"
    };

    // detectErrorType — identico DarkPlanner
    function detectErrorType() {
        if (xpathEval(ERROR_SELECTORS.TIMEOUT)) return 'TIMEOUT';
        if (xpathEval(ERROR_SELECTORS.HIGH_DEMAND)) return 'HIGH_DEMAND';
        if (xpathEval(ERROR_SELECTORS.RATE_LIMIT)) return 'RATE_LIMIT';
        if (xpathEval(ERROR_SELECTORS.QUEUE_FULL)) return 'QUEUE_FULL';
        return null;
    }

    // closeErrorPopup — identico DarkPlanner
    async function closeErrorPopup() {
        const errorPopup = xpathEval(ERROR_SELECTORS.ANY_ERROR);
        if (!errorPopup) return;
        try {
            const closeBtn = errorPopup.querySelector('button[aria-label*="close"], button[aria-label*="dismiss"], button:last-child')
                || errorPopup.querySelector('button:not([data-feedback])');
            if (closeBtn && !closeBtn.textContent.toLowerCase().includes('feedback')) {
                closeBtn.click();
            } else {
                document.body.click();
            }
            await sleep(500);
        } catch (e) {
            console.warn('[Dotti] Nao foi possivel fechar popup de erro');
        }
    }

    // classifyFailedTileByDOM — identico DarkPlanner v8.5.2
    function classifyFailedTileByDOM(mediaId, prompt) {
        try {
            const imagePolicyKeywords = ['policies prohibit uploading', 'prohibit uploading', 'uploading images of'];
            const policyKeywords = ['prominent people', 'policy', 'policies', 'violat', 'safety', 'harmful', 'inappropriate', 'restricted', 'não permitido', 'restrito'];
            const technicalKeywords = ['audio generation failed', 'generation failed', "couldn't generate", 'try again later', 'unable to generate', 'internal error', 'server error'];

            const taskPromptStart = (prompt.text || '').substring(0, 40).toLowerCase();
            const allItems = document.querySelectorAll('[data-item-index]');

            for (const item of allItems) {
                const text = (item.textContent || '').toLowerCase();
                if (!text.includes('failed')) continue;
                if (taskPromptStart.length > 10 && !text.includes(taskPromptStart.substring(0, 20))) continue;

                for (const kw of imagePolicyKeywords) {
                    if (text.includes(kw)) {
                        console.log('[Dotti] Classificado POLICY_IMAGE:', kw);
                        return 'POLICY_IMAGE';
                    }
                }
                for (const kw of policyKeywords) {
                    if (text.includes(kw)) {
                        console.log('[Dotti] Classificado POLICY:', kw);
                        return 'POLICY';
                    }
                }
                for (const kw of technicalKeywords) {
                    if (text.includes(kw)) {
                        console.log('[Dotti] Classificado TECHNICAL:', kw);
                        return 'TECHNICAL';
                    }
                }
            }

            console.log('[Dotti] Sem keywords no DOM — assumindo POLICY (fallback)');
            return 'POLICY';
        } catch (e) {
            return 'POLICY';
        }
    }

    // detectFailedGenerations — identico DarkPlanner v8.3.1
    // Detecta "Failed" no grid via DOM (quando API nao esta ativa)
    function detectFailedGenerations() {
        const failedPrompts = [];
        try {
            const listItems = document.querySelectorAll('[data-item-index]');

            for (const item of listItems) {
                if (item.hasAttribute('data-dotti-error-processed')) continue;

                const itemText = item.textContent || '';
                if (!itemText.includes('Failed')) continue;

                // Confirmar com leaf text nodes (evita falso positivo)
                let hasFailedText = false;
                const walker = document.createTreeWalker(item, NodeFilter.SHOW_TEXT);
                let node;
                while (node = walker.nextNode()) {
                    const t = node.textContent.trim();
                    if (t === 'Failed' || t === 'Failed Generation') {
                        hasFailedText = true;
                        break;
                    }
                }
                if (!hasFailedText) continue;

                // Protecao: porcentagem = ainda gerando.
                // Video presente NAO descarta mais (Veo 3 mostra placeholder em tiles Failed).
                let hasPercentage = false;
                const pWalker = document.createTreeWalker(item, NodeFilter.SHOW_TEXT);
                let pNode;
                while (pNode = pWalker.nextNode()) {
                    if (/^\d+%$/.test(pNode.textContent.trim())) {
                        hasPercentage = true;
                        break;
                    }
                }
                if (hasPercentage) continue;

                // Protecao temporal: 45s desde ultimo envio
                const timeSinceLastSubmit = Date.now() - (_lastSubmittedTime || 0);
                if (timeSinceLastSubmit < 45000) continue;

                // Protecao: tasks generating recentes (<45s)
                const hasRecentGenerating = _promptList.some(t =>
                    t.status === 'generating' && (Date.now() - (t.startedAt || 0)) < 45000
                );
                if (hasRecentGenerating) continue;

                item.setAttribute('data-dotti-error-processed', 'true');

                const tileEl = item.querySelector('[data-tile-id]');
                const tileId = tileEl?.getAttribute('data-tile-id') || '';

                if (tileId && _processedFailedTileIds.has(tileId)) continue;

                // Extrair prompt do info panel (identico DarkPlanner)
                let promptText = '';
                const startEl = tileEl || item;
                let p = startEl;
                for (let i = 0; i < 15; i++) {
                    p = p?.parentElement;
                    if (!p) break;
                    if (p.children.length >= 2) {
                        let hasTileChild = false;
                        let candidateInfoPanel = null;
                        for (const child of p.children) {
                            if (child.contains(startEl)) hasTileChild = true;
                            else if (!child.querySelector('[data-tile-id]') && !child.querySelector('video')) candidateInfoPanel = child;
                        }
                        if (hasTileChild && candidateInfoPanel) {
                            const panelText = candidateInfoPanel.textContent || '';
                            if (panelText.length > 30) {
                                candidateInfoPanel.querySelectorAll('div').forEach(d => {
                                    let directText = '';
                                    for (const n of d.childNodes) {
                                        if (n.nodeType === 3) directText += n.textContent;
                                    }
                                    directText = directText.trim();
                                    if (directText.length > promptText.length && directText.length > 20 &&
                                        !directText.includes('Failed') && !directText.includes('violate') &&
                                        !directText.startsWith('Created') && !directText.startsWith('Edited') &&
                                        !directText.startsWith('Veo ') && !directText.startsWith('Imagen')) {
                                        promptText = directText;
                                    }
                                });
                                break;
                            }
                        }
                    }
                }

                const promptKey = (promptText || '__tile_' + tileId).substring(0, 100).toLowerCase();
                if (_processedFailedPrompts.has(promptKey)) continue;
                _processedFailedPrompts.add(promptKey);

                failedPrompts.push({
                    text: promptText,
                    tileId: tileId,
                    itemIndex: item.hasAttribute('data-item-index') ? parseInt(item.getAttribute('data-item-index'), 10) : -1,
                    failType: itemText.match(/policy|violat|safety|harmful|inappropriate/i) ? 'policy' : 'technical'
                });
            }
        } catch (e) {
            console.error('[Dotti] Erro ao detectar Failed Generation:', e);
        }

        if (failedPrompts.length > 1) return [failedPrompts[0]];
        return failedPrompts;
    }

    // scanExistingVideos — identico DarkPlanner
    // Pre-scan de videos ja existentes no DOM antes de iniciar
    function scanExistingVideos() {
        const urls = new Set();
        try {
            document.querySelectorAll('video').forEach(video => {
                const src = video.src;
                if (src && src.includes('getMediaUrlRedirect')) urls.add(getVideoId(src));
            });
        } catch (e) {}
        return urls;
    }

    // getVideoId — identico DarkPlanner
    function getVideoId(url) {
        if (!url) return '';
        const nameMatch = url.match(/[?&]name=([a-f0-9-]+)/i);
        if (nameMatch) return 'media_' + nameMatch[1];
        return url.split('?')[0];
    }

    function startVideoUrlScanner() {
        if (_scannerActive) return;
        _scannerActive = true;
        _scheduleNextScan();
        console.log('[Dotti] Scanner DOM iniciado (5s interval, non-overlapping)');
    }

    // setTimeout recursivo — garante que a proxima scan so comeca APOS a anterior terminar
    // setInterval com async causa scans sobrepostos que perdem videos
    function _scheduleNextScan() {
        if (!_scannerActive) return;
        _videoScannerInterval = setTimeout(async () => {
            if (!_scannerActive) return;
            try {
                await scanForVideos();
            } catch (e) {
                console.error('[Dotti Scanner] Erro:', e);
            }
            _scheduleNextScan(); // Agendar proxima APOS esta terminar
        }, 5000);
    }

    function stopVideoUrlScanner() {
        _scannerActive = false;
        if (_videoScannerInterval) {
            clearTimeout(_videoScannerInterval);
            _videoScannerInterval = null;
        }
    }

    function resetVideoUrlScanner() {
        stopVideoUrlScanner(); // Parar scanner ativo antes de resetar
        _downloadedVideoUrls.clear();
        _mediaTracker.clear();
        _itemIndexToPrompt.clear();
        _promptList = [];
        _scannerScrollPosition = 0;
        _lastSubmittedPromptNumber = null;
        _lastSubmittedTime = 0;
        _nextItemIndex = 0;
        _processedFailedPrompts.clear();
        _processedFailedTileIds.clear();
    }

    // setPromptList — com campos identicos ao taskList do DarkPlanner
    function setPromptList(prompts, folder, mediaType, autoDownload) {
        // Pre-scan de videos existentes no DOM (identico DarkPlanner scanExistingVideos)
        const existingUrls = scanExistingVideos();
        for (const url of existingUrls) {
            _downloadedVideoUrls.add(url);
        }
        _nextItemIndex = existingUrls.size; // Comecar contagem a partir dos itens existentes

        // Task objects com campos identicos ao DarkPlanner taskList
        _promptList = (prompts || []).map((p, i) => ({
            index: i,                        // posicao na taskList (0-based)
            number: p.number,                // numero do prompt (1-based)
            duration: p.duration || 8,       // duracao do video em segundos (4/6/8)
            text: p.text || '',
            elements: p.elements || [],
            prompt: p.text || '',            // alias para compatibilidade DarkPlanner
            status: 'pending',              // pending/generating/complete/failed
            uuid: null,                     // gerado ao submeter
            mediaId: null,                  // do API interceptor
            retryCount: 0,
            highDemandRetryCount: 0,
            techRetryCount: 0,
            isRetry: false,
            originalIndex: null,
            downloadIndex: null,
            startedAt: null,
            lastSubmitTime: null,
            foundVideos: 0,
            expectedVideos: 1,              // 1 video por prompt
            downloaded: false,
            failType: null,                 // TECHNICAL / POLICY / POLICY_IMAGE
            error: null,
            needsRetryAfterSystemError: false,
            isTimeoutRetry: false,
            timeoutRetryNumber: 0,
            hasImage: !!(p.elements?.length),
            image: null,
            imageDataUrl: p.imageDataUrl || null,  // v3.4.0: Frame image data URL
            imageName: p.imageName || null          // v3.4.0: Frame image filename
        }));
        _downloadFolder = folder || 'LetzVideos';
        _mediaType = mediaType || 'video';
        _autoDownload = autoDownload !== false;

        // Resetar slot system
        _tasksByUUID.clear();
        _processedTaskUUIDs.clear();
        _sendLockByIndex.clear();
        _consecutiveErrorCount = 0;
        _notifiedPolicyErrors.clear();
        _pendingRewrites = 0;
        _stopRequested = false;
        _activeSlots = 0;
        _recentHighDemandError = false;
        _lastSubmittedTaskIndex = -1;

        console.log('[Dotti] Prompt list:', _promptList.length, 'prompts, pasta:', _downloadFolder, 'pre-existentes:', existingUrls.size);
    }

    // ============================================
    // HELPERS DO SLOT SYSTEM (identico DarkPlanner)
    // ============================================

    function getRandomWaitTime() {
        // Delay aleatorio entre envios: 3-6s base + extra se high demand recente
        const base = 3000 + Math.random() * 3000;
        return _recentHighDemandError ? Math.max(15000, base) : base;
    }

    function formatPromptId(task) {
        const orig = task.originalIndex != null ? task.originalIndex : task.index;
        return `#${task.number || (orig + 1)}`;
    }

    function sendProgressUpdate() {
        const sent = _promptList.filter(t => t.status === 'generating' || t.status === 'complete').length;
        const completed = _promptList.filter(t => t.status === 'complete').length;
        const failed = _promptList.filter(t => t.status === 'failed').length;
        const total = _promptList.length;
        const generating = _promptList.filter(t => t.status === 'generating').length;
        notifyPanel({
            type: 'QUEUE_PROGRESS',
            data: { sent, completed, failed, total, generating }
        });
        // Atualizar overlay no background
        chrome.runtime.sendMessage({
            action: 'QUEUE_STATUS_UPDATE',
            sent, total, generating, completed, failed
        }).catch(() => {});
    }

    // ============================================
    // handleErrorByType — identico DarkPlanner v8 linhas 2008-2326
    // Trata erros por tipo com retry automatico
    // ============================================

    async function handleErrorByType(errorType, task) {
        if (!task) return;

        // Dedup: verifica se ja processamos este UUID
        if (task.uuid && _notifiedPolicyErrors.has(task.uuid)) {
            return;
        }

        // Marca como processado ANTES de fazer qualquer coisa
        if (task.uuid) _notifiedPolicyErrors.add(task.uuid);

        // v3.1.0: POLICY e POLICY_IMAGE sao erros de CONTEUDO (Google rejeita o prompt),
        // nao erros DOM consecutivos. Nao devem contar para loop detection.
        // Apenas TECHNICAL, TIMEOUT, HIGH_DEMAND, RATE_LIMIT contam.
        if (errorType !== 'POLICY' && errorType !== 'POLICY_IMAGE') {
            _consecutiveErrorCount++;

            // Loop detection: se muitos erros seguidos, para tudo
            if (_consecutiveErrorCount >= _MAX_CONSECUTIVE_ERRORS) {
                console.log('[Dotti] LOOP DETECTADO: ' + _MAX_CONSECUTIVE_ERRORS + ' erros consecutivos. Parando automacao...');
                _stopRequested = true;
                _isRunning = false;
                notifyPanel({ type: 'LOOP_DETECTED', data: { count: _consecutiveErrorCount } });
                return;
            }
        }

        switch (errorType) {

            case 'TIMEOUT': {
                // v3.1.0: Timeout retry mid-queue — cria NOVA task retry com prioridade
                console.log('[Dotti] [' + formatPromptId(task) + '] Timeout detectado - Geracao esta demorando');

                // Libera slot da task original
                _activeSlots--;
                const timeoutSlotToFree = _slots.findIndex(s => s === task.uuid);
                if (timeoutSlotToFree !== -1) {
                    _slots[timeoutSlotToFree] = null;
                }

                // Verificar se ja teve timeout retry (limite: 1 segunda chance)
                if (!task.timeoutRetryCount || task.timeoutRetryCount < 1) {
                    // Marcar task original como failed
                    task.status = 'failed';
                    task.error = 'Timeout - retry criado';

                    // Criar NOVA task retry
                    const retryIdx = _promptList.length;
                    const retryTask = {
                        index: retryIdx,
                        number: task.number,
                        text: task.text,
                        prompt: task.prompt || task.text,
                        elements: task.elements || [],
                        status: 'pending',
                        uuid: null,
                        mediaId: null,
                        retryCount: (task.retryCount || 0) + 1,
                        highDemandRetryCount: 0,
                        techRetryCount: 0,
                        isRetry: true,
                        isTimeoutRetry: true,
                        timeoutRetryCount: (task.timeoutRetryCount || 0) + 1,
                        originalIndex: task.originalIndex != null ? task.originalIndex : task.index,
                        downloadIndex: task.downloadIndex || task.index,
                        startedAt: null,
                        lastSubmitTime: null,
                        foundVideos: 0,
                        expectedVideos: task.expectedVideos || 1,
                        downloaded: false,
                        failType: null,
                        error: null,
                        needsRetryAfterSystemError: false,
                        hasImage: task.hasImage || false,
                        image: task.image || null
                    };

                    // Inserir com prioridade: antes do proximo pending nao-retry
                    let insertPos = _promptList.length;
                    for (let pi = 0; pi < _promptList.length; pi++) {
                        if (_promptList[pi].status === 'pending' && !_promptList[pi].isRetry) {
                            insertPos = pi;
                            break;
                        }
                    }
                    _promptList.splice(insertPos, 0, retryTask);

                    // Re-indexar tasks apos splice
                    for (let ri = insertPos; ri < _promptList.length; ri++) {
                        _promptList[ri].index = ri;
                    }

                    console.log('[Dotti] [' + formatPromptId(task) + '] Timeout retry criado na posicao ' + insertPos + ' (mid-queue)');
                    notifyPanel({ type: 'ERROR_RETRY', data: { number: task.number, errorType: 'TIMEOUT', retryCount: retryTask.retryCount, maxRetries: MAX_RETRIES } });

                    await sleep(3000);
                } else {
                    // Ja usou a segunda chance — falha definitiva
                    task.status = 'failed';
                    task.error = 'Timeout apos retry mid-queue';

                    console.log('[Dotti] [' + formatPromptId(task) + '] Falha definitiva: Timeout apos retry mid-queue');
                    notifyPanel({ type: 'PROMPT_FAILED', data: { number: task.number, failType: 'TIMEOUT', error: task.error } });
                }
                break;
            }

            case 'RATE_LIMIT': {
                // Erro sistemico — "Couldn't generate video"
                // HARD RESET: Para tudo, navega para pagina neutra, aguarda 45s, retoma
                console.log('[Dotti] [' + formatPromptId(task) + '] Falha na Geracao - "Couldn\'t generate video"');
                console.log('[Dotti] Este erro e sistemico - Iniciando Hard Reset...');

                // PARA TUDO IMEDIATAMENTE
                _stopRequested = true;
                _isRunning = false;

                // Marca todas as tasks em 'generating' como 'pending' para retomada
                for (const t of _promptList) {
                    if (t.status === 'generating') {
                        t.status = 'pending';
                        t.needsRetryAfterSystemError = true;
                    }
                }

                // Salvar estado para retomar
                const resumeIndex = task.index;

                await chrome.storage.local.set({
                    'dotti_hard_reset_state': {
                        resumeFromIndex: resumeIndex,
                        timestamp: Date.now(),
                        reason: 'SYSTEM_ERROR',
                        prompts: _promptList.map(t => ({
                            index: t.index,
                            number: t.number,
                            text: t.text,
                            prompt: t.prompt,
                            elements: t.elements,
                            status: t.status,
                            retryCount: t.retryCount,
                            isRetry: t.isRetry,
                            originalIndex: t.originalIndex,
                            foundVideos: t.foundVideos,
                            downloaded: t.downloaded
                        })),
                        folder: _downloadFolder,
                        mediaType: _mediaType,
                        autoDownload: _autoDownload,
                        maxSimultaneous: _maxSimultaneous
                    }
                });

                // Notificar panel sobre Hard Reset
                notifyPanel({
                    type: 'HARD_RESET_STARTED',
                    data: { resumeFromIndex: resumeIndex }
                });

                // Notificar background para iniciar cooldown
                chrome.runtime.sendMessage({
                    action: 'HARD_RESET_STARTED',
                    resumeFromIndex: resumeIndex
                }).catch(() => {});

                console.log('[Dotti] Navegando para pagina neutra (cooldown de 45s)...');

                // Navegar para pagina neutra
                window.location.href = 'https://dottiflow.com.br/?dotti_cooldown=true';
                break;
            }

            case 'HIGH_DEMAND': {
                // Erro de alta demanda — "Flow is experiencing high demand"
                // Usa botao "Reuse prompt" para reenviar (mantem ingredientes!)
                console.log('[Dotti] [' + formatPromptId(task) + '] Alta demanda detectada');

                _recentHighDemandError = true;

                if (!task.highDemandRetryCount) task.highDemandRetryCount = 0;
                task.highDemandRetryCount++;

                const MAX_HIGH_DEMAND_RETRIES = 3;

                if (task.highDemandRetryCount <= MAX_HIGH_DEMAND_RETRIES) {
                    console.log('[Dotti] [' + formatPromptId(task) + '] Clicando em "Reuse prompt" em 15s (tentativa ' + task.highDemandRetryCount + '/' + MAX_HIGH_DEMAND_RETRIES + ')...');

                    notifyPanel({ type: 'ERROR_RETRY', data: { number: task.number, errorType: 'HIGH_DEMAND', retryCount: task.highDemandRetryCount, maxRetries: MAX_HIGH_DEMAND_RETRIES } });

                    // Aguarda 15 segundos antes de clicar em Reuse
                    await sleep(15000);

                    // Tenta usar o botao "Reuse prompt"
                    const reuseSuccess = await clickReusePromptButton(task);

                    if (reuseSuccess) {
                        // Prompt reenviado com sucesso pelo botao Reuse
                        task.startedAt = Date.now();
                        console.log('[Dotti] [' + formatPromptId(task) + '] Prompt reenviado via "Reuse prompt"');
                    } else {
                        // Fallback: reenvio manual
                        task.status = 'pending';
                        _activeSlots--;

                        const hdSlotToFree = _slots.findIndex(s => s === task.uuid);
                        if (hdSlotToFree !== -1) {
                            _slots[hdSlotToFree] = null;
                        }
                        task.uuid = 'task_' + task.index + '_' + Date.now() + '_' + Math.random().toString(36).substr(2, 9);
                        _tasksByUUID.set(task.uuid, task);

                        console.log('[Dotti] [' + formatPromptId(task) + '] "Reuse prompt" nao encontrado - reenvio manual');
                    }
                } else {
                    // Maximo de retries atingido
                    task.status = 'failed';
                    task.error = 'Alta demanda apos 3 tentativas';
                    _activeSlots--;

                    const hdFailSlotToFree = _slots.findIndex(s => s === task.uuid);
                    if (hdFailSlotToFree !== -1) {
                        _slots[hdFailSlotToFree] = null;
                    }

                    console.log('[Dotti] [' + formatPromptId(task) + '] Falha apos ' + MAX_HIGH_DEMAND_RETRIES + ' tentativas de alta demanda');
                    notifyPanel({ type: 'PROMPT_FAILED', data: { number: task.number, failType: 'HIGH_DEMAND', error: task.error } });
                }
                break;
            }

            case 'GENERATION_FAILED': {
                // Erro tecnico do Veo ("Audio generation failed", etc.)
                // Retry com o MESMO prompt (sem reescrever) — conteudo nao e o problema
                console.log('[Dotti] [' + formatPromptId(task) + '] Falha tecnica na geracao — tentando novamente');

                if (!task.techRetryCount) task.techRetryCount = 0;
                task.techRetryCount++;

                const MAX_TECH_RETRIES = 2;

                if (task.techRetryCount <= MAX_TECH_RETRIES) {
                    task.status = 'pending';
                    _activeSlots--;

                    const techSlotToFree = _slots.findIndex(s => s === task.uuid);
                    if (techSlotToFree !== -1) {
                        _slots[techSlotToFree] = null;
                    }

                    task.uuid = 'task_' + task.index + '_' + Date.now() + '_' + Math.random().toString(36).substr(2, 9);
                    _tasksByUUID.set(task.uuid, task);

                    console.log('[Dotti] [' + formatPromptId(task) + '] Reenviando mesmo prompt (tentativa ' + task.techRetryCount + '/' + MAX_TECH_RETRIES + ')...');
                    notifyPanel({ type: 'ERROR_RETRY', data: { number: task.number, errorType: 'GENERATION_FAILED', retryCount: task.techRetryCount, maxRetries: MAX_TECH_RETRIES } });

                    await sleep(5000);
                } else {
                    // Maximo de retries tecnicos atingido — escalar para POLICY (tenta reescrever)
                    console.log('[Dotti] [' + formatPromptId(task) + '] ' + MAX_TECH_RETRIES + ' tentativas tecnicas falharam — tentando reescrever prompt');
                    task.techRetryCount = 0;
                    // Limpar UUID de dedup para permitir reprocessamento como POLICY
                    if (task.uuid) _notifiedPolicyErrors.delete(task.uuid);
                    await handleErrorByType('POLICY', task);
                    return;
                }
                break;
            }

            case 'QUEUE_FULL': {
                // v3.1.0: Fila cheia do Flow — reagendar sem contar contra MAX_RETRIES
                console.log('[Dotti] [' + formatPromptId(task) + '] QUEUE_FULL detectado — reagendando em 15s');

                _activeSlots--;
                const queueSlot = _slots.findIndex(s => s === task.uuid);
                if (queueSlot !== -1) _slots[queueSlot] = null;

                task.status = 'pending';
                task.uuid = 'task_' + task.index + '_' + Date.now() + '_' + Math.random().toString(36).substr(2, 9);
                _tasksByUUID.set(task.uuid, task);

                // NAO conta contra MAX_RETRIES
                _consecutiveErrorCount = Math.max(0, _consecutiveErrorCount - 1);

                await closeErrorPopup();
                notifyPanel({ type: 'ERROR_RETRY', data: { number: task.number, errorType: 'QUEUE_FULL', retryCount: task.retryCount, maxRetries: MAX_RETRIES } });

                await sleep(15000);
                break;
            }

            case 'POLICY_IMAGE': {
                // Erro de politica de IMAGEM (prominent people, etc)
                // NAO reescrever — o problema e a imagem, nao o prompt
                task.status = 'failed';
                task.error = 'Erro de politica de imagem (nao reescritivel)';
                _activeSlots--;

                const imgPolicySlot = _slots.findIndex(s => s === task.uuid);
                if (imgPolicySlot !== -1) {
                    _slots[imgPolicySlot] = null;
                }

                console.log('[Dotti] [' + formatPromptId(task) + '] Politica de IMAGEM — nao sera reescrito');
                notifyPanel({ type: 'PROMPT_FAILED', data: { number: task.number, failType: 'POLICY_IMAGE', error: task.error } });
                break;
            }

            case 'POLICY':
            default: {
                // Erro de politica de PROMPT — Precisa reescrever com IA
                task.status = 'failed';
                task.error = 'Erro de politica';
                _activeSlots--;

                const policySlotToFree = _slots.findIndex(s => s === task.uuid);
                if (policySlotToFree !== -1) {
                    _slots[policySlotToFree] = null;
                }

                console.log('[Dotti] [' + formatPromptId(task) + '] Erro de politica — prompt marcado como falho');

                // v3.1.0: NAO incrementar _pendingRewrites nem tentar rewrite com IA.
                // API de reescrita esta retornando HTML. Reenviar o mesmo prompt
                // tambem nao funciona (Google rejeita o mesmo conteudo).
                // O usuario pode usar o botao "Reenviar" para tentar manualmente.
                notifyPanel({ type: 'PROMPT_FAILED', data: { number: task.number, failType: 'POLICY', error: task.error } });
                break;
            }
        }

        sendProgressUpdate();
    }

    // ============================================
    // clickReusePromptButton — identico DarkPlanner v8 linhas 2339-2441
    // Multi-idioma: 'Reuse prompt', 'Reutilizar prompt', etc.
    // ============================================

    async function clickReusePromptButton(task) {
        try {
            const failedTexts = ['Failed Generation', 'Geração Falhou', 'Falha na Geração', 'Generación Fallida', 'failed generation'];
            const reuseTexts = ['Reuse prompt', 'Reutilizar prompt', 'Reutilizar', 'reuse prompt', 'reuse'];

            const matchesAny = (text, patterns) => patterns.some(p => text.toLowerCase().includes(p.toLowerCase()));

            // Busca containers com texto do prompt
            const allContainers = document.querySelectorAll('div');
            let targetCard = null;

            // Metodo 1: Busca por texto do prompt nos cards
            for (const card of allContainers) {
                const cardText = card.textContent || '';
                const promptStart = (task.prompt || task.text || '').substring(0, 40);
                if (promptStart && cardText.includes(promptStart)) {
                    if (matchesAny(cardText, failedTexts) || matchesAny(cardText, reuseTexts)) {
                        targetCard = card;
                        break;
                    }
                }
            }

            // Metodo 2: Busca botoes com icone wrap_text
            if (!targetCard) {
                const allButtons = document.querySelectorAll('button');
                for (const btn of allButtons) {
                    const icon = btn.querySelector('i, span.material-icons, span.material-icons-outlined');
                    const btnText = btn.textContent?.trim() || '';

                    if ((icon && icon.textContent?.includes('wrap_text')) ||
                        matchesAny(btnText, reuseTexts)) {
                        const parent = btn.closest('div[class*="card"], div[class*="result"], div[class*="grid"]');
                        if (parent) {
                            const parentText = parent.textContent || '';
                            const promptStart = (task.prompt || task.text || '').substring(0, 30);
                            if (promptStart && parentText.includes(promptStart)) {
                                targetCard = parent;
                                break;
                            }
                        }
                    }
                }
            }

            if (!targetCard) {
                // Fallback: Busca qualquer botao "Reuse prompt" visivel
                const reuseBtns = Array.from(document.querySelectorAll('button')).filter(btn => {
                    const text = (btn.textContent || '').toLowerCase();
                    const icon = btn.querySelector('i')?.textContent || '';
                    return matchesAny(text, reuseTexts) || icon.includes('wrap_text');
                });

                if (reuseBtns.length === 1) {
                    reuseBtns[0].click();
                    await sleep(2000);
                    return true;
                }

                // v3.1.0: Fallback via findElementRobust (multi-idioma)
                const robustReuse = findElementRobust({
                    materialIcon: 'wrap_text',
                    ariaLabel: ['Reuse prompt', 'Reutilizar prompt'],
                    translationKey: 'reuse prompt'
                });
                if (robustReuse) {
                    robustReuse.click();
                    await sleep(2000);
                    return true;
                }

                return false;
            }

            // Encontrar botao Reuse dentro do card
            const buttons = targetCard.querySelectorAll('button');
            for (const btn of buttons) {
                const icon = btn.querySelector('i');
                if (icon && icon.textContent?.includes('wrap_text')) {
                    btn.click();
                    await sleep(2000);
                    return true;
                }
            }

            // Busca por classe generica
            const reuseBtn = targetCard.querySelector('button[class*="sc-e8425ea6-0"], button[class*="sc-2b6ef9e5"]');
            if (reuseBtn) {
                reuseBtn.click();
                await sleep(2000);
                return true;
            }

            return false;

        } catch (error) {
            console.error('[Dotti] Erro ao clicar em Reuse prompt:', error);
            return false;
        }
    }

    // ============================================
    // processAllPromptsWithSlots — identico DarkPlanner v8 linhas 5612-5973
    // Loop principal com N slots simultaneos
    // ============================================

    async function processAllPromptsWithSlots() {
        _isRunning = true;
        _stopRequested = false;
        _slots = new Array(_maxSimultaneous).fill(null);
        _activeSlots = 0;
        _consecutiveErrorCount = 0;

        console.log('[Dotti] processAllPromptsWithSlots: ' + _promptList.length + ' prompts, ' + _maxSimultaneous + ' slots');

        // Iniciar scanner DOM em paralelo
        startVideoUrlScanner();

        // Enviar os primeiros prompts (ate MAX_SIMULTANEOUS)
        let initialSent = 0;
        for (let i = 0; i < _promptList.length && initialSent < _maxSimultaneous && _isRunning && !_stopRequested; i++) {
            const task = _promptList[i];
            if (task.status !== 'pending') continue;

            if (_stopRequested) break;

            await submitTask(i);
            initialSent++;

            // Delay entre submissoes
            if (initialSent < _maxSimultaneous) {
                const waitTime = getRandomWaitTime();
                await sleep(waitTime);
            }
        }

        const TASK_TIMEOUT_MS = 300000; // 5 minutos de timeout por task
        let _loopIteration = 0;

        // Main loop
        while (_isRunning && !_stopRequested) {
            _loopIteration++;
          try {
            await sleep(1000); // Check a cada 1s

            if (_stopRequested) {
                console.log('[Dotti] Main loop: _stopRequested=true, saindo');
                break;
            }

            // LIMPEZA DE SLOTS ORFAOS: tasks que ja completaram/falharam
            for (let slotIdx = 0; slotIdx < _slots.length; slotIdx++) {
                const uuid = _slots[slotIdx];
                if (uuid) {
                    const task = _tasksByUUID.get(uuid);
                    if (!task || task.status === 'complete' || task.status === 'failed' || task.status === 'timeout') {
                        _slots[slotIdx] = null;
                    }
                }
            }

            // Verifica timeout individual de cada task em geracao
            const now = Date.now();
            const generatingTasks = _promptList.filter(t => t.status === 'generating');

            for (const task of generatingTasks) {
                if (task.startedAt && (now - task.startedAt) > TASK_TIMEOUT_MS) {
                    // Antes de marcar timeout, faz scan extra
                    await scanForVideos();
                    // Se ainda nao encontrou videos, e timeout real
                    if (task.foundVideos === 0) {
                        await handleErrorByType('TIMEOUT', task);
                    }
                }
            }

            // v3.1.0: Log periodico de estado do loop (a cada 10s)
            if (_loopIteration % 10 === 0) {
                const pending = _promptList.filter(t => t.status === 'pending').length;
                const generating = _promptList.filter(t => t.status === 'generating').length;
                const failed = _promptList.filter(t => t.status === 'failed').length;
                const complete = _promptList.filter(t => t.status === 'complete').length;
                const slotsUsed = _slots.filter(s => s !== null).length;
                console.log('[Dotti] Loop #' + _loopIteration + ': pending=' + pending + ' gen=' + generating +
                    ' failed=' + failed + ' complete=' + complete + ' slots=' + slotsUsed + '/' + _slots.length +
                    ' errors=' + _consecutiveErrorCount + ' rewrites=' + _pendingRewrites);
            }

            // Verifica se ha slots disponiveis
            const availableSlot = _slots.findIndex(s => s === null);
            if (availableSlot !== -1) {
                // Procura task para enviar - prioridade identica DarkPlanner:
                // 1. Retries com prompt reescrito (isRetry=true, prompt reescrito)
                // 2. High demand e rate limit retries (com trava de 45s)
                // 3. Qualquer nova task pendente

                let taskToSend = null;
                let taskIndex = -1;

                // 1. Retries reescritos
                for (let i = 0; i < _promptList.length; i++) {
                    const t = _promptList[i];
                    if (t.status === 'pending' && t.isRetry && t.retryCount > 0) {
                        taskToSend = t;
                        taskIndex = i;
                        break;
                    }
                }

                // 2. High demand/rate limit retries (com trava 45s)
                if (!taskToSend) {
                    for (let i = 0; i < _promptList.length; i++) {
                        const t = _promptList[i];
                        if (t.status !== 'pending') continue;
                        if (!(t.highDemandRetryCount > 0 || t.rateLimitRetryCount > 0)) continue;
                        if ((Date.now() - (t.lastSubmitTime || 0)) > 45000) {
                            taskToSend = t;
                            taskIndex = i;
                            break;
                        }
                    }
                }

                // 3. Qualquer task pendente nova
                if (!taskToSend) {
                    for (let i = 0; i < _promptList.length; i++) {
                        const t = _promptList[i];
                        if (t.status === 'pending' && !t.isRetry && !t.highDemandRetryCount && !t.rateLimitRetryCount) {
                            taskToSend = t;
                            taskIndex = i;
                            break;
                        }
                    }
                }

                if (taskToSend && taskIndex !== -1) {
                    const isRetry = taskToSend.isRetry || taskToSend.highDemandRetryCount > 0 || taskToSend.rateLimitRetryCount > 0;
                    if (isRetry) {
                        console.log('[Dotti] [' + formatPromptId(taskToSend) + '] Reprocessando apos erro...');
                    }

                    await submitTask(taskIndex);

                    // Delay antes de enviar proximo (ligeiramente maior para retry)
                    const waitTime = isRetry ? Math.max(5000, getRandomWaitTime()) : getRandomWaitTime();
                    await sleep(waitTime);
                } else {
                    // Sem task para enviar, aguarda
                    await sleep(2000);
                }
            } else {
                // Todos os slots ocupados, aguarda
                await sleep(2000);
            }

            // Verifica se todas as tasks terminaram
            const allDone = _promptList.every(t =>
                t.status === 'complete' || t.status === 'failed'
            );
            const noPending = !_promptList.some(t => t.status === 'pending');
            const noGenerating = !_promptList.some(t => t.status === 'generating');

            if (allDone || (noPending && noGenerating)) {
                // v3.1.0: Safety timeout 30s para _pendingRewrites
                if (_pendingRewrites > 0) {
                    if (_rewriteWaitStart === 0) {
                        _rewriteWaitStart = Date.now();
                        console.log('[Dotti] Aguardando ' + _pendingRewrites + ' rewrite(s) pendente(s)...');
                    }
                    if (Date.now() - _rewriteWaitStart < 30000) {
                        // Ainda dentro do timeout de 30s — continuar esperando
                        continue;
                    }
                    // Timeout de 30s atingido — forçar reset
                    console.log('[Dotti] Safety timeout 30s: forcando _pendingRewrites=0 (era ' + _pendingRewrites + ')');
                    _pendingRewrites = 0;
                    _rewriteWaitStart = 0;
                }
                console.log('[Dotti] Main loop: saindo — allDone=' + allDone + ' noPending=' + noPending + ' noGenerating=' + noGenerating);
                break;
            }
          } catch (loopErr) {
            console.error('[Dotti] ERRO no main loop (continuando):', loopErr);
          }
        }

        // Aguarda videos restantes (maximo 5 minutos)
        if (_autoDownload) {
            const generating = _promptList.filter(t => t.status === 'generating');
            if (generating.length > 0) {
                const maxWait = 300000; // 5 minutos
                const start = Date.now();

                while (Date.now() - start < maxWait && !_stopRequested) {
                    await scanForVideos();
                    const stillGenerating = _promptList.filter(t => t.status === 'generating');
                    if (stillGenerating.length === 0) break;
                    console.log('[Dotti] Aguardando ' + stillGenerating.length + ' video(s) em geracao...');
                    await sleep(5000);
                }
            }
        }

        // Processa retries de timeout criados durante a espera final
        const pendingRetries = _promptList.filter(t => t.status === 'pending' && t.isTimeoutRetry);
        if (pendingRetries.length > 0 && !_stopRequested) {
            console.log('[Dotti] Processando ' + pendingRetries.length + ' retry(s) de timeout...');

            for (const retryTask of pendingRetries) {
                if (_stopRequested) break;
                const retryIndex = _promptList.indexOf(retryTask);
                if (retryIndex === -1) continue;
                const slotIdx = _slots.findIndex(s => s === null);
                if (slotIdx !== -1) {
                    await submitTask(retryIndex);
                    await sleep(getRandomWaitTime());
                }
            }

            // Espera os retries terminarem
            const retryMaxWait = 300000;
            const retryStart = Date.now();
            while (Date.now() - retryStart < retryMaxWait && !_stopRequested) {
                await scanForVideos();
                const stillActive = _promptList.filter(t => t.status === 'generating');
                if (stillActive.length === 0) break;
                await sleep(5000);
            }

            // Marca remanescentes como falha final
            const finalTimeout = _promptList.filter(t => t.status === 'generating');
            for (const task of finalTimeout) {
                const slotToFree = _slots.findIndex(s => s === task.uuid);
                if (slotToFree !== -1) _slots[slotToFree] = null;
                task.status = 'failed';
                task.error = 'Falha definitiva apos retry de timeout';
                console.log('[Dotti] [' + formatPromptId(task) + '] Falha definitiva apos retry de timeout');
                notifyPanel({ type: 'PROMPT_FAILED', data: { number: task.number, failType: 'TIMEOUT', error: task.error } });
            }
        }

        // Finalizar
        _isRunning = false;
        stopVideoUrlScanner();
        sendProgressUpdate();

        console.log('[Dotti] processAllPromptsWithSlots FINALIZADO');
        const completed = _promptList.filter(t => t.status === 'complete').length;
        const failed = _promptList.filter(t => t.status === 'failed').length;

        notifyPanel({ type: 'QUEUE_COMPLETE', data: { total: _promptList.length, completed, failed } });
        // Notificar background para maximizar janela + remover overlay
        chrome.runtime.sendMessage({
            action: 'QUEUE_COMPLETE_FROM_CONTENT',
            data: { total: _promptList.length, completed, failed }
        }).catch(() => {});
    }

    // ============================================
    // submitTask — identico DarkPlanner v8 linhas 5975-6200
    // Envia um prompt para o Flow via DOM
    // ============================================

    async function submitTask(index) {
        const task = _promptList[index];
        if (!task || task.status !== 'pending') return;

        // Gerar UUID unico para esta tentativa de envio
        if (!task.uuid) {
            task.uuid = 'task_' + task.index + '_' + Date.now() + '_' + Math.random().toString(36).substr(2, 9);
            _tasksByUUID.set(task.uuid, task);
        }

        // Verificar trava de envio por indice original (60s lock)
        // Retries com prompt reescrito (isRetry=true) podem ser enviados imediatamente
        const originalIdx = task.originalIndex != null ? task.originalIndex : task.index;
        const lastSendTime = _sendLockByIndex.get(originalIdx);
        const isRewrittenRetry = task.isRetry && task.retryCount > 0;

        if (lastSendTime && (Date.now() - lastSendTime) < _SEND_LOCK_DURATION_MS && !isRewrittenRetry) {
            console.log('[Dotti] [' + formatPromptId(task) + '] Trava de envio ativa, aguardando...');
            return;
        }

        // Verificar se ja foi processado (evita reprocessamento)
        if (_processedTaskUUIDs.has(task.uuid)) {
            return;
        }

        // Verificar se ha slot disponivel
        const availableSlotIndex = _slots.findIndex(s => s === null);
        if (availableSlotIndex === -1) {
            console.log('[Dotti] [' + formatPromptId(task) + '] Sem slot disponivel');
            return;
        }

        // Ocupar o slot com o UUID desta task
        _slots[availableSlotIndex] = task.uuid;

        // Notificar panel que prompt esta sendo enviado
        notifyPanel({ type: 'PROMPT_STARTING', data: { number: task.number } });

        // Trackear para lastSubmitted
        _lastSubmittedPromptNumber = task.number;
        _lastSubmittedTime = Date.now();
        _lastSubmittedTaskIndex = task.index;

        // PromptTracker: mapear itemIndex → promptNumber
        _itemIndexToPrompt.set(_nextItemIndex, task.number);
        _nextItemIndex++;

        // Tentar processar o prompt (com retries internos)
        let success = false;

        for (let retry = 0; retry <= MAX_RETRIES && !_stopRequested; retry++) {
            if (_stopRequested) break;

            if (retry > 0) {
                console.log('[Dotti] [' + formatPromptId(task) + '] Retry interno ' + retry + '/' + MAX_RETRIES);
                await sleep(5000);
            }

            // Limpar galeria antes de cada envio
            try {
                await clearElements();
                await sleep(800);
            } catch (e) { }

            // Executar prompt no DOM
            const result = await executePrompt({
                number: task.number,
                text: task.prompt || task.text,
                elements: task.elements || [],
                duration: task.duration || 8,
                imageDataUrl: task.imageDataUrl || null,  // v3.4.0: Frame image
                imageName: task.imageName || null
            });

            if (result && result.success) {
                task.status = 'generating';
                task.startedAt = Date.now();
                task.lastSubmitTime = Date.now();
                _activeSlots++;

                // Registrar trava de envio por indice original
                _sendLockByIndex.set(originalIdx, Date.now());

                // Resetar contador de erros consecutivos (sucesso)
                _consecutiveErrorCount = 0;

                console.log('[Dotti] [' + formatPromptId(task) + '] Enviado! Aguardando geracao...');
                sendProgressUpdate();

                // Notificar panel
                notifyPanel({ type: 'PROMPT_RESULT', data: { number: task.number, result: { success: true } } });
                success = true;
                break;
            }
        }

        if (!success && !_stopRequested) {
            // Falha total ao submeter — liberar slot
            _slots[availableSlotIndex] = null;
            task.status = 'failed';
            task.error = 'Falha ao enviar prompt apos ' + MAX_RETRIES + ' tentativas';
            console.log('[Dotti] [' + formatPromptId(task) + '] Falha ao enviar apos retries');
            notifyPanel({ type: 'PROMPT_FAILED', data: { number: task.number, failType: 'SUBMIT_ERROR', error: task.error } });

            // Incrementar contador de erros consecutivos
            _consecutiveErrorCount++;
            if (_consecutiveErrorCount >= _MAX_CONSECUTIVE_ERRORS) {
                console.log('[Dotti] LOOP DETECTADO: ' + _MAX_CONSECUTIVE_ERRORS + ' erros consecutivos. Parando automacao...');
                _stopRequested = true;
                _isRunning = false;
            }
        }
    }

    // ============================================
    // findAndGroupNewVideos — identico DarkPlanner
    // ============================================
    function findAndGroupNewVideos() {
        const groups = [];
        const seenVideoIds = new Set();
        const videos = document.querySelectorAll('video');

        for (const video of videos) {
            const src = video.src;
            if (!src || !src.includes('getMediaUrlRedirect')) continue;

            const cleanUrl = getVideoId(src);
            if (_downloadedVideoUrls.has(cleanUrl)) continue;
            if (seenVideoIds.has(cleanUrl)) continue;
            seenVideoIds.add(cleanUrl);

            // Skip videos cujo tile/item esta marcado como Failed (placeholder/preview de geracao falha)
            const itemEl = video.closest('[data-item-index]');
            if (itemEl) {
                let isFailed = false;
                const fWalker = document.createTreeWalker(itemEl, NodeFilter.SHOW_TEXT);
                let fNode;
                while (fNode = fWalker.nextNode()) {
                    const t = fNode.textContent.trim();
                    if (t === 'Failed' || t === 'Failed Generation') { isFailed = true; break; }
                }
                if (isFailed) {
                    console.log('[Dotti Scanner] Ignorando video de tile Failed:', cleanUrl.substring(0, 60));
                    continue;
                }
            }

            // Tile container
            const tileEl = video.closest('[data-tile-id]');
            const tileId = tileEl?.getAttribute('data-tile-id') || '';

            // Subir no DOM para encontrar ITEM ROW (tile area + info panel)
            let promptText = '';
            let itemRow = null;
            let infoPanel = null;

            let p = tileEl || video.parentElement;
            for (let i = 0; i < 15; i++) {
                p = p?.parentElement;
                if (!p) break;

                if (p.children.length >= 2) {
                    let hasTileChild = false;
                    let candidateInfoPanel = null;

                    for (const child of p.children) {
                        if (child.contains(video)) {
                            hasTileChild = true;
                        } else if (!child.querySelector('video')) {
                            candidateInfoPanel = child;
                        }
                    }

                    if (hasTileChild && candidateInfoPanel) {
                        const panelText = candidateInfoPanel.textContent || '';
                        if (panelText.length > 30) {
                            infoPanel = candidateInfoPanel;
                            itemRow = p;
                            break;
                        }
                    }
                }
            }

            // Extrair prompt text do info panel (identico DarkPlanner)
            if (infoPanel) {
                infoPanel.querySelectorAll('div').forEach(d => {
                    let directText = '';
                    for (const n of d.childNodes) {
                        if (n.nodeType === 3) directText += n.textContent;
                    }
                    directText = directText.trim();
                    if (directText.length > promptText.length && directText.length > 20 &&
                        !directText.startsWith('Created') && !directText.startsWith('Edited') &&
                        !directText.startsWith('Veo ') && !directText.startsWith('Imagen')) {
                        promptText = directText;
                    }
                });
            }

            // Extrair data-item-index (react-virtuoso)
            let itemIndex = -1;
            const itemIndexEl = (itemRow || video).closest?.('[data-item-index]');
            if (itemIndexEl) {
                itemIndex = parseInt(itemIndexEl.getAttribute('data-item-index'), 10);
            }

            // Extrair mediaId da URL
            let mediaId = '';
            const nameMatch = src.match(/[?&]name=([a-f0-9-]+)/i);
            if (nameMatch) mediaId = nameMatch[1];

            groups.push({
                prompt: promptText,
                videos: [src],
                container: itemRow || tileEl || video.parentElement,
                videoElements: [video],
                tileId: tileId,
                itemIndex: itemIndex,
                mediaId: mediaId
            });
        }

        return groups;
    }

    // ============================================
    // scrollToRevealMore — scroll agressivo para react-virtuoso (mini window)
    // Varre TODAS as posicoes do scroll para revelar itens virtualizados
    // Retorna ao final para que o proximo scan cubra do final para o inicio
    // ============================================
    function scrollToRevealMore() {
        let scrollEl = null;
        let maxRatio = 1;
        document.querySelectorAll('div').forEach(el => {
            if (el.clientHeight > 50 && el.scrollHeight > el.clientHeight * 1.3) {
                const ratio = el.scrollHeight / el.clientHeight;
                if (ratio > maxRatio) {
                    maxRatio = ratio;
                    scrollEl = el;
                }
            }
        });
        if (!scrollEl || scrollEl.scrollHeight <= scrollEl.clientHeight) return;

        // Scroll agressivo: avanca 2 paginas por scan para cobrir mais rapido
        const pageHeight = scrollEl.clientHeight;
        _scannerScrollPosition += pageHeight * 2;
        if (_scannerScrollPosition >= scrollEl.scrollHeight) {
            _scannerScrollPosition = 0; // Volta ao inicio para ciclo continuo
        }
        scrollEl.scrollTop = _scannerScrollPosition;
    }

    // v3.1.0: getPromptAnchors — extrai palavras >5 chars para matching (identico DarkPlanner)
    function getPromptAnchors(text) {
        if (!text) return [];
        return text.toLowerCase()
            .replace(/[^\w\s]/g, ' ')
            .split(/\s+/)
            .filter(w => w.length > 5)
            .slice(0, 10);
    }

    // ============================================
    // scanForVideos — identico DarkPlanner (6 prioridades + error detection)
    // ============================================
    async function scanForVideos() {
        // Scroll progressivo para revelar itens virtualizados (mini window)
        scrollToRevealMore();

        // === DETECAO DE FALHAS (identico DarkPlanner) ===
        // DOM-based failure detection APENAS quando API nao esta ativa
        // Quando _mediaTracker tem entries, a API intercepta FAILED/COMPLETED com precisao
        // O DOM e PERIGOSO nesse caso (tiles antigos re-detectados, retries marcados como failed)
        const apiTrackingActive = _mediaTracker && _mediaTracker.size > 0;
        const failedPrompts = apiTrackingActive ? [] : detectFailedGenerations();

        if (failedPrompts.length > 0) {
            for (const fp of failedPrompts) {
                if (fp.tileId && _processedFailedTileIds.has(fp.tileId)) continue;

                // Match por texto
                let matchedPrompt = null;
                if (fp.text && fp.text.length > 20) {
                    const search = fp.text.toLowerCase().trim().replace(/\s+/g, ' ').substring(0, 100);
                    matchedPrompt = _promptList.find(pr => {
                        if (pr.status !== 'generating') return false;
                        const timeSinceStart = Date.now() - (pr.startedAt || 0);
                        if (timeSinceStart < 10000 || timeSinceStart > 600000) return false;
                        const tp = (pr.text || '').toLowerCase().trim().replace(/\s+/g, ' ');
                        return tp.includes(search) || search.includes(tp.substring(0, search.length));
                    });
                }

                // Match por itemIndex via PromptTracker
                if (!matchedPrompt && fp.itemIndex >= 0 && _itemIndexToPrompt.has(fp.itemIndex)) {
                    const pNum = _itemIndexToPrompt.get(fp.itemIndex);
                    matchedPrompt = _promptList.find(pr => pr.number === pNum && pr.status === 'generating');
                }

                // Fallback: unica task generating (com protecao temporal)
                if (!matchedPrompt) {
                    const generating = _promptList.filter(pr => pr.status === 'generating');
                    if (generating.length === 1) {
                        const timeSinceStart = Date.now() - (generating[0].startedAt || 0);
                        if (timeSinceStart > 8000) matchedPrompt = generating[0];
                    } else if (generating.length > 1) {
                        // Fallback timeout: task mais antiga gerando ha mais de 120s
                        const sorted = generating.sort((a, b) => (a.startedAt || 0) - (b.startedAt || 0));
                        for (const task of sorted) {
                            const timeSinceStart = Date.now() - (task.startedAt || 0);
                            if (timeSinceStart > 120000) {
                                matchedPrompt = task;
                                break;
                            }
                        }
                    }
                }

                if (matchedPrompt) {
                    if (fp.tileId) _processedFailedTileIds.add(fp.tileId);

                    // Classificar tipo de erro via DOM (identico DarkPlanner classifyFailedTileByDOM)
                    const classification = classifyFailedTileByDOM(matchedPrompt.mediaId, matchedPrompt);
                    console.log('[Dotti Scanner] Failed detectado DOM: #' + matchedPrompt.number, classification);

                    await closeErrorPopup();

                    // Delegar ao handleErrorByType para retry automatico
                    if (classification === 'POLICY_IMAGE') {
                        await handleErrorByType('POLICY_IMAGE', matchedPrompt);
                    } else if (classification === 'POLICY') {
                        await handleErrorByType('POLICY', matchedPrompt);
                    } else {
                        // TECHNICAL → tenta como GENERATION_FAILED (retry mesmo prompt)
                        await handleErrorByType('GENERATION_FAILED', matchedPrompt);
                    }

                    return; // Processar um erro por vez (identico DarkPlanner)
                } else {
                    if (fp.tileId) _processedFailedTileIds.add(fp.tileId);
                }
            }
        }

        // === DETECAO DE POPUPS DE ERRO (identico DarkPlanner) ===
        // Verifica TIMEOUT, RATE_LIMIT, HIGH_DEMAND
        const errorType = detectErrorType();
        if (errorType) {
            await closeErrorPopup();

            const generating = _promptList
                .filter(pr => pr.status === 'generating')
                .sort((a, b) => (a.startedAt || 0) - (b.startedAt || 0));

            if (generating.length > 0) {
                let task = null;
                const timeSinceLastSubmit = Date.now() - (_lastSubmittedTime || 0);

                // RATE_LIMIT: associar ao ultimo prompt enviado (rapido apos envio)
                if (errorType === 'RATE_LIMIT' && timeSinceLastSubmit < 15000 && _lastSubmittedPromptNumber) {
                    task = generating.find(pr => pr.number === _lastSubmittedPromptNumber);
                }

                // TIMEOUT e HIGH_DEMAND: associar ao mais antigo gerando
                if (!task && (errorType === 'TIMEOUT' || errorType === 'HIGH_DEMAND')) {
                    task = generating[0];
                }

                if (task) {
                    console.log('[Dotti Scanner] Erro detectado:', errorType, '-> #' + task.number);
                    // Delegar ao handleErrorByType (retry automatico / hard reset / etc)
                    await handleErrorByType(errorType, task);
                    return;
                }
            }
        }

        // === SCAN DE VIDEOS (4 prioridades identicas DarkPlanner) ===

        const groups = findAndGroupNewVideos();
        if (groups.length === 0) return;

        console.log('[Dotti Scanner]', groups.length, 'novo(s) video(s) no DOM');

        const downloadsToQueue = [];

        for (const group of groups) {
            const videoUrl = group.videos[0];
            if (_downloadedVideoUrls.has(getVideoId(videoUrl))) continue;

            const tileText = (group.prompt || '').toLowerCase().trim();
            const itemIndex = group.itemIndex ?? -1;
            const mediaId = group.mediaId || '';

            let matchedPrompt = null;

            // === PRIORIDADE 0: Match por mediaId via API tracker (100% preciso) ===
            if (!matchedPrompt && mediaId && _mediaTracker.has(mediaId)) {
                const tracked = _mediaTracker.get(mediaId);

                // Primeiro: promptNumber direto
                if (tracked.promptNumber) {
                    const task = _promptList.find(t =>
                        t.number === tracked.promptNumber &&
                        t.status === 'generating' &&
                        t.foundVideos < t.expectedVideos
                    );
                    if (task) matchedPrompt = task;
                }

                // Segundo: match por texto do prompt do tracker
                if (!matchedPrompt && tracked.prompt) {
                    const apiPrompt = tracked.prompt.toLowerCase().trim();
                    const apiMatch = _promptList.find(t => {
                        if (t.status !== 'generating' || t.foundVideos >= t.expectedVideos) return false;
                        const tp = (t.text || '').toLowerCase().trim();
                        return tp.includes(apiPrompt) || apiPrompt.includes(tp) ||
                            (tp.length >= 30 && apiPrompt.length >= 30 &&
                                tp.substring(0, 50) === apiPrompt.substring(0, 50));
                    });
                    if (apiMatch) {
                        matchedPrompt = apiMatch;
                        tracked.promptNumber = apiMatch.number;
                    }
                }

                if (matchedPrompt) {
                    console.log('[Dotti Scanner] P0 mediaId:', mediaId.substring(0, 12), '-> #' + matchedPrompt.number);
                }
            }

            // === PRIORIDADE 1: Match por texto do prompt no DOM ===
            if (!matchedPrompt && tileText.length > 5) {
                const tileNorm = tileText.replace(/\s+/g, ' ').replace(/[.,;:!?]+$/, '');
                const textMatches = _promptList.filter(t => {
                    if (t.status !== 'generating' || t.foundVideos >= t.expectedVideos) return false;
                    const taskNorm = (t.text || '').toLowerCase().trim().replace(/\s+/g, ' ');

                    if (taskNorm.includes(tileNorm) || tileNorm.includes(taskNorm)) return true;

                    // Versao sem numeros no inicio
                    const tileNoNum = tileNorm.replace(/^\d{1,3}\s+/, '');
                    const taskNoNum = taskNorm.replace(/^\d{1,3}\s+/, '');
                    if (tileNoNum.length > 10 && taskNoNum.length > 10) {
                        if (taskNoNum.includes(tileNoNum) || tileNoNum.includes(taskNoNum)) return true;
                    }

                    // Primeiros 60 chars
                    const compareLen = Math.min(60, tileNorm.length, taskNorm.length);
                    if (compareLen >= 20 && tileNorm.substring(0, compareLen) === taskNorm.substring(0, compareLen)) return true;

                    return false;
                });

                if (textMatches.length > 0) {
                    // Ordenar por foundVideos (menor primeiro), depois startedAt (mais antigo primeiro)
                    matchedPrompt = textMatches.sort((a, b) => {
                        if (a.foundVideos !== b.foundVideos) return a.foundVideos - b.foundVideos;
                        return (a.startedAt || 0) - (b.startedAt || 0);
                    })[0];
                }

                if (matchedPrompt) {
                    console.log('[Dotti Scanner] P1 texto:', tileText.substring(0, 40), '-> #' + matchedPrompt.number);
                }
            }

            // === PRIORIDADE 1.5: Match por 90% char ratio (identico DarkPlanner) ===
            if (!matchedPrompt && tileText.length > 10) {
                const tileChars = tileText.replace(/\s+/g, ' ').substring(0, 100);
                const charMatches = _promptList.filter(t => {
                    if (t.status !== 'generating' || t.foundVideos >= t.expectedVideos) return false;
                    const taskChars = (t.text || '').toLowerCase().trim().replace(/\s+/g, ' ').substring(0, 100);
                    if (taskChars.length < 10) return false;
                    const compareLen = Math.min(tileChars.length, taskChars.length);
                    if (compareLen < 10) return false;
                    let same = 0;
                    for (let c = 0; c < compareLen; c++) {
                        if (tileChars[c] === taskChars[c]) same++;
                    }
                    return (same / compareLen) >= 0.9;
                });
                if (charMatches.length === 1) {
                    matchedPrompt = charMatches[0];
                    console.log('[Dotti Scanner] P1.5 charRatio -> #' + matchedPrompt.number);
                }
            }

            // === PRIORIDADE 1.6: Match por 95% anchor words (identico DarkPlanner) ===
            if (!matchedPrompt && tileText.length > 20) {
                const tileAnchors = getPromptAnchors(tileText);
                if (tileAnchors.length >= 3) {
                    const anchorMatches = _promptList.filter(t => {
                        if (t.status !== 'generating' || t.foundVideos >= t.expectedVideos) return false;
                        const taskAnchors = getPromptAnchors(t.text || '');
                        if (taskAnchors.length < 3) return false;
                        const common = tileAnchors.filter(w => taskAnchors.includes(w));
                        const ratio = common.length / Math.max(tileAnchors.length, taskAnchors.length);
                        return ratio >= 0.95;
                    });
                    if (anchorMatches.length === 1) {
                        matchedPrompt = anchorMatches[0];
                        console.log('[Dotti Scanner] P1.6 anchors -> #' + matchedPrompt.number);
                    }
                }
            }

            // === PRIORIDADE 2: Match por itemIndex via _itemIndexToPrompt ===
            if (!matchedPrompt && itemIndex >= 0 && _itemIndexToPrompt.has(itemIndex)) {
                const promptNumber = _itemIndexToPrompt.get(itemIndex);
                const task = _promptList.find(t =>
                    t.number === promptNumber &&
                    t.status === 'generating' &&
                    t.foundVideos < t.expectedVideos
                );
                if (task) {
                    matchedPrompt = task;
                    console.log('[Dotti Scanner] P2 itemIndex:', itemIndex, '-> #' + matchedPrompt.number);
                }
            }

            // === PRIORIDADE 3: Match por ordem de envio (ultimo recurso) ===
            if (!matchedPrompt) {
                const pendingGenTasks = _promptList
                    .filter(t => t.status === 'generating' && t.foundVideos < t.expectedVideos)
                    .sort((a, b) => (a.startedAt || 0) - (b.startedAt || 0));
                if (pendingGenTasks.length > 0) {
                    matchedPrompt = pendingGenTasks[0];
                    console.log('[Dotti Scanner] P3 sequencial -> #' + matchedPrompt.number);
                }
            }

            // === DOWNLOAD ===
            if (matchedPrompt) {
                const cleanUrl = getVideoId(videoUrl);
                _downloadedVideoUrls.add(cleanUrl);
                matchedPrompt.foundVideos++;

                if (_autoDownload) {
                    downloadsToQueue.push({ url: videoUrl, prompt: matchedPrompt, letterIndex: matchedPrompt.foundVideos });
                }

                // Marcar como downloaded se atingiu expectedVideos
                if (matchedPrompt.foundVideos >= matchedPrompt.expectedVideos) {
                    matchedPrompt.downloaded = true;
                    matchedPrompt.status = 'complete';
                }

                notifyPanel({
                    type: 'VIDEO_DOWNLOADED',
                    data: {
                        promptNumber: matchedPrompt.number,
                        mediaId: mediaId,
                        url: videoUrl,
                        downloadFolder: _downloadFolder
                    }
                });
            } else {
                // Nenhum match — avisar panel
                notifyPanel({
                    type: 'VIDEO_URLS_DISCOVERED',
                    data: {
                        videos: [{
                            url: videoUrl,
                            promptNumber: null,
                            mediaId: mediaId,
                            prompt: group.prompt
                        }]
                    }
                });
            }
        }

        if (downloadsToQueue.length > 0) {
            await _processDownloadQueue(downloadsToQueue);
        }
    }

    async function _processDownloadQueue(downloads) {
        for (const dl of downloads) {
            await downloadVideoDirect(dl.url, dl.prompt, dl.letterIndex);
            await sleep(300);
        }
    }

    // ============================================
    // downloadVideoDirect — download direto via background (Promise-based)
    // Filename: 001.a.prompt text.mp4
    // Retorna Promise para permitir await na fila de downloads
    // ============================================
    function downloadVideoDirect(url, prompt, letterIndex) {
        return new Promise((resolve) => {
            const promptNum = prompt.number || 0;
            const ext = _mediaType === 'image' ? 'png' : 'mp4';

            const promptText = (prompt.text || 'video').trim();
            const sanitizedPrompt = promptText
                .substring(0, 60)
                .replace(/[<>:"|?*\\\/]/g, '')
                .replace(/\s+/g, '_')
                .replace(/\.+$/, '')
                .trim();

            let letterSuffix = '';
            if (prompt.expectedVideos > 1 && letterIndex) {
                const letters = ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'i', 'j'];
                const idx = Math.max(0, letterIndex - 1);
                letterSuffix = letters[idx % letters.length] + '.';
            }

            const paddedNum = String(promptNum).padStart(3, '0');

            // v3.1.0: Version suffix para retries (001.v2.a.prompt.mp4)
            let versionSuffix = '';
            if (prompt.isRetry) {
                const version = prompt.retryCount || 1;
                versionSuffix = '.v' + (version + 1);
            }

            const connector = letterSuffix ? '.' + letterSuffix : '_';
            const filename = paddedNum + versionSuffix + connector + sanitizedPrompt + '.' + ext;

            console.log('[Dotti Download]', _downloadFolder + '/' + filename);

            chrome.runtime.sendMessage({
                action: 'DOWNLOAD_VIDEO',
                url: url,
                filename: filename,
                folder: _downloadFolder
            }, (response) => {
                if (chrome.runtime.lastError) {
                    const err = chrome.runtime.lastError.message || '';
                    if (!err.includes('Receiving end does not exist') &&
                        !err.includes('message port closed')) {
                        console.warn('[Dotti Download] Erro:', err);
                    }
                    resolve(false);
                    return;
                }
                if (response?.success) {
                    console.log('[Dotti Download] OK: #' + paddedNum);
                    resolve(true);
                } else if (response?.error) {
                    console.warn('[Dotti Download] Erro:', response.error);
                    // Permitir retry — reverter tracking para que o scanner reencontre o video
                    const cleanUrl = getVideoId(url);
                    _downloadedVideoUrls.delete(cleanUrl);
                    if (prompt) {
                        prompt.foundVideos = Math.max(0, prompt.foundVideos - 1);
                        prompt.downloaded = false;
                        prompt.status = 'generating';
                    }
                    resolve(false);
                } else {
                    resolve(false);
                }
            });
        });
    }

    // Helper: clicar em um elemento - React props OU click nativo, NUNCA ambos
    function reactClick(element) {
        const reactKey = Object.keys(element).find(k => k.startsWith("__reactProps"));
        if (reactKey && element[reactKey]?.onClick) {
            element[reactKey].onClick();
        } else {
            element.click();
        }
    }

    // ============================================
    // v2.1.0: SET OUTPUTS PER PROMPT
    // Encontra o controle de quantidade no Flow e define o valor desejado
    // Suporta: React custom components, dropdowns, segmented buttons, sliders
    // ============================================

    // Flag para o fetch intercept saber a quantidade desejada
    let _dottiDesiredOutputCount = 0;
    let _fetchInterceptRequested = false;

    async function setOutputsPerPrompt(targetCount) {
        targetCount = parseInt(targetCount) || 1;
        if (targetCount < 1 || targetCount > 4) targetCount = 1;
        console.log("[Dotti DOM] Definindo outputs per prompt =", targetCount);

        try {
            // === FASE 1: Tentar via combobox "Respostas por comando" no dialog aberto ===
            let success = await tryResponsesCombobox(targetCount);
            if (success) return true;

            // === FASE 2: Abrir settings e tentar o combobox ===
            const settingsBtn = findSettingsButton();
            if (settingsBtn) {
                console.log("[Dotti DOM] Abrindo settings...");
                reactClick(settingsBtn);
                await sleep(1500);

                success = await tryResponsesCombobox(targetCount);
                if (success) {
                    // Fechar dialog de settings
                    pressEscape();
                    await sleep(300);
                    return true;
                }

                // Fallback: tentar estrategias DOM genericas
                success = await trySetOutputsDOM(targetCount);
                if (success) {
                    pressEscape();
                    await sleep(300);
                    return true;
                }

                pressEscape();
                await sleep(300);
            }

            // === FASE 3: Fetch intercept como fallback definitivo ===
            console.log("[Dotti DOM] Estrategias DOM falharam. Ativando fetch intercept para count=" + targetCount);
            _dottiDesiredOutputCount = targetCount;
            requestFetchIntercept(targetCount);
            return true;

        } catch (e) {
            console.error("[Dotti DOM] Erro ao definir outputs:", e);
            return false;
        }
    }

    // Estrategia principal: encontrar combobox "Respostas por comando" / "Responses per prompt"
    // Estrutura do Flow: [role="dialog"] > div > button[role="combobox"] contendo span com label
    async function tryResponsesCombobox(targetCount) {
        // Labels conhecidos para o campo de quantidade (PT e EN)
        const labelPatterns = ["respostas por comando", "responses per prompt", "responses per command",
            "respuestas por comando", "outputs per prompt", "results per prompt"];

        // Procurar o combobox dentro de um dialog ou em qualquer lugar visivel
        const comboboxes = document.querySelectorAll('button[role="combobox"]');
        let targetCombobox = null;

        for (const cb of comboboxes) {
            if (cb.offsetParent === null) continue;
            const cbText = stripAccents((cb.textContent || "").toLowerCase().trim());
            if (labelPatterns.some(p => cbText.includes(p))) {
                targetCombobox = cb;
                break;
            }
        }

        // Fallback: procurar por span com label e subir ate o combobox
        if (!targetCombobox) {
            for (const span of document.querySelectorAll('span')) {
                if (span.offsetParent === null) continue;
                const spanText = stripAccents((span.textContent || "").toLowerCase().trim());
                if (labelPatterns.some(p => spanText.includes(p))) {
                    // Subir ate encontrar o combobox pai
                    const cb = span.closest('button[role="combobox"]') ||
                        span.closest('[role="combobox"]') ||
                        span.parentElement?.closest('button[role="combobox"]');
                    if (cb) {
                        targetCombobox = cb;
                        break;
                    }
                }
            }
        }

        if (!targetCombobox) {
            console.log("[Dotti DOM] Combobox 'Respostas por comando' nao encontrado");
            return false;
        }

        console.log("[Dotti DOM] Combobox encontrado:", targetCombobox.textContent?.trim()?.substring(0, 50));

        // Clicar no combobox para abrir o dropdown
        reactClick(targetCombobox);
        await sleep(800);

        // Procurar as opcoes que apareceram (role="option" ou role="listbox" > children)
        const options = document.querySelectorAll('[role="option"], [role="listbox"] [role="option"]');
        console.log("[Dotti DOM] Opcoes do dropdown:", options.length);

        if (options.length === 0) {
            // Tentar alternativa: procurar listbox e seus filhos diretos
            const listbox = document.querySelector('[role="listbox"]');
            if (listbox) {
                const listItems = listbox.children;
                for (const item of listItems) {
                    const itemText = (item.textContent || "").trim();
                    if (itemText === String(targetCount) || itemText.startsWith(String(targetCount))) {
                        console.log("[Dotti DOM] Item de listbox selecionado:", itemText);
                        reactClick(item);
                        await sleep(400);
                        return true;
                    }
                }
            }

            // Tentar procurar qualquer novo elemento visivel com o numero
            await sleep(400);
            const allVisible = document.querySelectorAll('*');
            for (const el of allVisible) {
                if (el.offsetParent === null || el.childElementCount > 0) continue;
                const text = (el.textContent || "").trim();
                if (text === String(targetCount)) {
                    const clickable = el.closest('[role="option"]') || el.closest('[role="menuitem"]') ||
                        el.closest('button') || el.closest('li') || el;
                    console.log("[Dotti DOM] Opcao encontrada por texto:", text, clickable.tagName);
                    reactClick(clickable);
                    await sleep(400);
                    return true;
                }
            }

            console.log("[Dotti DOM] Nenhuma opcao encontrada no dropdown");
            pressEscape();
            await sleep(300);
            return false;
        }

        // Clicar na opcao com o valor desejado
        for (const opt of options) {
            const optText = (opt.textContent || "").trim();
            if (optText === String(targetCount) || optText.startsWith(String(targetCount) + " ") ||
                optText.startsWith(String(targetCount) + "\t")) {
                console.log("[Dotti DOM] Opcao selecionada:", optText);
                reactClick(opt);
                await sleep(400);
                return true;
            }
        }

        console.log("[Dotti DOM] Opcao " + targetCount + " nao encontrada entre", options.length, "opcoes");
        pressEscape();
        await sleep(300);
        return false;
    }

    function pressEscape() {
        document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    }

    // Coletar todos os elementos visiveis cujo texto direto eh exatamente "1", "2", "3" ou "4"
    function collectVisibleNumbers() {
        const results = [];
        for (const el of document.querySelectorAll('button, div, span, a, label, [role], td, li')) {
            if (el.offsetParent === null) continue;
            // Texto direto (exclui texto de filhos)
            let directText = '';
            for (const child of el.childNodes) {
                if (child.nodeType === Node.TEXT_NODE) directText += child.textContent;
            }
            directText = directText.trim();
            if (directText.length === 0 || directText.length > 2) continue;
            const num = parseInt(directText);
            if (isNaN(num) || num < 1 || num > 4) continue;
            const rect = el.getBoundingClientRect();
            if (rect.width < 5 || rect.height < 5) continue;
            results.push({ el, num, cx: rect.left + rect.width / 2, cy: rect.top + rect.height / 2 });
        }
        return results;
    }

    // Encontrar cluster de elementos numerados proximos (segmented buttons, chips, etc)
    function findNumberCluster(candidates) {
        if (!candidates || candidates.length < 2) return null;
        let bestCluster = null;
        for (const seed of candidates) {
            const nearby = candidates.filter(c => Math.hypot(c.cx - seed.cx, c.cy - seed.cy) < 300);
            // Deduplicar por numero
            const byNum = new Map();
            nearby.forEach(c => { if (!byNum.has(c.num)) byNum.set(c.num, c); });
            const unique = [...byNum.values()];
            if (unique.length >= 2 && (!bestCluster || unique.length > bestCluster.length)) {
                bestCluster = unique;
            }
        }
        if (bestCluster) {
            console.log("[Dotti DOM] Cluster numerico: [" + bestCluster.map(c => c.num).join(', ') + "]");
        }
        return bestCluster;
    }

    // Estrategias DOM para definir outputs
    async function trySetOutputsDOM(targetCount) {
        // --- Estrategia 1: input[type=range] visivel ---
        for (const slider of document.querySelectorAll('input[type="range"]')) {
            if (slider.offsetParent === null) continue;
            const min = parseInt(slider.min) || 0;
            const max = parseInt(slider.max) || 100;
            if (min >= 0 && max >= 2 && max <= 8) {
                const setVal = String(Math.min(Math.max(targetCount, min), max));
                console.log("[Dotti DOM] Range input: min=" + min + " max=" + max + " -> " + setVal);
                const nativeSetter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
                nativeSetter.call(slider, setVal);
                slider.dispatchEvent(new Event('input', { bubbles: true }));
                slider.dispatchEvent(new Event('change', { bubbles: true }));
                triggerReact(slider, setVal);
                await sleep(200);
                return true;
            }
        }

        // --- Estrategia 2: [role=slider] visivel ---
        for (const slider of document.querySelectorAll('[role="slider"]')) {
            if (slider.offsetParent === null) continue;
            const min = parseInt(slider.getAttribute("aria-valuemin")) || 0;
            const max = parseInt(slider.getAttribute("aria-valuemax")) || 100;
            if (min >= 0 && max >= 2 && max <= 8) {
                const setVal = Math.min(Math.max(targetCount, min), max);
                console.log("[Dotti DOM] ARIA slider: min=" + min + " max=" + max + " -> " + setVal);
                const rect = slider.getBoundingClientRect();
                const ratio = max > min ? (setVal - min) / (max - min) : 0;
                const x = rect.left + rect.width * 0.05 + (rect.width * 0.9) * ratio;
                const y = rect.top + rect.height / 2;
                for (const evt of ["pointerdown", "pointermove", "pointerup"]) {
                    slider.dispatchEvent(new PointerEvent(evt, { clientX: x, clientY: y, bubbles: true, cancelable: true }));
                    await sleep(50);
                }
                slider.setAttribute("aria-valuenow", String(setVal));
                triggerReact(slider, setVal);
                await sleep(200);
                return true;
            }
        }

        // --- Estrategia 3: Cluster de elementos numerados (React divs/spans/buttons) ---
        // Encontra grupo de elementos visiveis com numeros 1-4 proximos entre si
        const visibleNums = collectVisibleNumbers();
        const cluster = findNumberCluster(visibleNums);
        if (cluster) {
            const target = cluster.find(c => c.num === targetCount);
            if (target) {
                console.log("[Dotti DOM] Clicando numero " + targetCount + " no cluster");
                // Tentar clicar no ancestral mais proximo que pareca interativo
                const clickTarget = target.el.closest('button') ||
                    target.el.closest('[role="radio"]') ||
                    target.el.closest('[role="option"]') ||
                    target.el.closest('[role="tab"]') ||
                    target.el.closest('[role="button"]') ||
                    target.el;
                reactClick(clickTarget);
                // Tambem clicar no proprio elemento se diferente
                if (clickTarget !== target.el) reactClick(target.el);
                await sleep(400);
                return true;
            }
        }

        // --- Estrategia 4: Stepper (botoes - / + com numero entre eles) ---
        const stepper = findStepper();
        if (stepper) {
            let attempts = 0;
            while (attempts < 10) {
                const currentVal = parseInt(stepper.valueEl.textContent?.trim());
                if (isNaN(currentVal) || currentVal === targetCount) break;
                if (currentVal > targetCount && stepper.minusBtn) reactClick(stepper.minusBtn);
                else if (currentVal < targetCount && stepper.plusBtn) reactClick(stepper.plusBtn);
                else break;
                await sleep(400);
                attempts++;
            }
            const finalVal = parseInt(stepper.valueEl.textContent?.trim());
            console.log("[Dotti DOM] Stepper: " + finalVal + " (target: " + targetCount + ")");
            if (finalVal === targetCount) return true;
        }

        // --- Estrategia 5: Select nativo ---
        for (const sel of document.querySelectorAll('select')) {
            if (sel.offsetParent === null) continue;
            const numOpts = [...sel.options].filter(o => {
                const v = parseInt(o.value);
                return !isNaN(v) && v >= 1 && v <= 8;
            });
            if (numOpts.length >= 2) {
                console.log("[Dotti DOM] Select nativo com " + numOpts.length + " opcoes");
                const nativeSetter = Object.getOwnPropertyDescriptor(window.HTMLSelectElement.prototype, 'value').set;
                nativeSetter.call(sel, String(targetCount));
                sel.dispatchEvent(new Event('change', { bubbles: true }));
                triggerReact(sel, targetCount);
                await sleep(200);
                return true;
            }
        }

        return false;
    }

    // Estrategia de dropdown: clicar em elemento com numero para abrir opcoes, depois selecionar
    async function tryDropdownPattern(targetCount) {
        console.log("[Dotti DOM] Tentando padrao dropdown...");

        // Coletar todos os elementos folha visiveis com numeros 1-4
        const numberEls = [];
        for (const el of document.querySelectorAll('*')) {
            if (el.offsetParent === null || el.childElementCount > 0) continue;
            const text = (el.textContent || '').trim();
            if (text.length > 2) continue;
            const num = parseInt(text);
            if (isNaN(num) || num < 1 || num > 4) continue;
            const rect = el.getBoundingClientRect();
            if (rect.width < 5 || rect.height < 5) continue;
            numberEls.push({ el, num });
        }

        if (numberEls.length === 0) {
            console.log("[Dotti DOM] Nenhum elemento numerico encontrado para dropdown");
            return false;
        }

        console.log("[Dotti DOM] " + numberEls.length + " elementos numericos, tentando dropdown...");

        // Para cada elemento numerico, tentar clicar para ver se abre dropdown
        for (const numEl of numberEls) {
            // Contar opcoes antes de clicar
            const beforeOptions = document.querySelectorAll('[role="option"], [role="menuitem"], [role="listbox"] > *').length;
            const beforeVisible = collectVisibleNumbers().length;

            // Clicar no elemento ou ancestral clicavel
            const clickTarget = numEl.el.closest('[role="button"]') ||
                numEl.el.closest('[role="combobox"]') ||
                numEl.el.closest('[aria-haspopup]') ||
                numEl.el.closest('button') ||
                numEl.el;
            reactClick(clickTarget);
            await sleep(800);

            // Verificar se apareceram novas opcoes (dropdown abriu)
            const afterOptions = document.querySelectorAll('[role="option"], [role="menuitem"]');
            if (afterOptions.length > beforeOptions) {
                // Dropdown abriu! Procurar opcao com o valor desejado
                for (const opt of afterOptions) {
                    const optText = (opt.textContent || '').trim();
                    if (optText === String(targetCount) || optText.startsWith(targetCount + ' ') || optText.startsWith(targetCount + '\t')) {
                        console.log("[Dotti DOM] Opcao de dropdown encontrada:", optText);
                        reactClick(opt);
                        await sleep(400);
                        return true;
                    }
                }
            }

            // Verificar se apareceram NOVOS elementos numericos (pode ser dropdown custom)
            const afterVisible = collectVisibleNumbers();
            if (afterVisible.length > beforeVisible) {
                const newNums = afterVisible.filter(a => !numberEls.some(b => b.el === a.el));
                const target = newNums.find(n => n.num === targetCount);
                if (target) {
                    console.log("[Dotti DOM] Novo elemento numerico no dropdown:", target.num);
                    const tgt = target.el.closest('[role]') || target.el.closest('button') || target.el;
                    reactClick(tgt);
                    if (tgt !== target.el) reactClick(target.el);
                    await sleep(400);
                    return true;
                }
            }

            // Fechar dropdown e tentar proximo
            pressEscape();
            await sleep(300);
        }

        return false;
    }

    // Encontrar botao de settings/config no prompt area
    function findSettingsButton() {
        const allBtns = document.querySelectorAll('button');
        // 1. Por icone material (settings, tune, sliders, more_vert)
        for (const btn of allBtns) {
            if (btn.offsetParent === null) continue;
            const icon = btn.querySelector('i, span.material-icons, span.material-symbols-outlined, [class*="icon"]');
            const iconText = (icon?.textContent || "").trim().toLowerCase();
            if (iconText === "settings" || iconText === "tune" || iconText === "sliders" ||
                iconText === "more_vert" || iconText === "more_horiz") {
                return btn;
            }
        }
        // 2. Por aria-label / title
        for (const btn of allBtns) {
            if (btn.offsetParent === null) continue;
            const ariaLabel = (btn.getAttribute("aria-label") || "").toLowerCase();
            const title = (btn.getAttribute("title") || "").toLowerCase();
            if (ariaLabel.includes("setting") || ariaLabel.includes("config") || ariaLabel.includes("option") ||
                title.includes("setting") || title.includes("config") || title.includes("option")) {
                return btn;
            }
        }
        return null;
    }

    // Encontrar stepper (- num +)
    function findStepper() {
        for (const btn of document.querySelectorAll('button')) {
            if (btn.offsetParent === null) continue;
            const icon = btn.querySelector('i, [class*="icon"]');
            const iconText = (icon?.textContent || "").trim().toLowerCase();
            if (iconText === 'remove' || iconText === 'remove_circle' || iconText === 'remove_circle_outline' ||
                btn.textContent?.trim() === '-' || btn.textContent?.trim() === '\u2212') {
                const parent = btn.parentElement;
                if (!parent) continue;
                for (const sib of parent.children) {
                    if (sib === btn) continue;
                    const val = parseInt(sib.textContent?.trim());
                    if (!isNaN(val) && val >= 1 && val <= 10) {
                        let plusBtn = null;
                        for (const sib2 of parent.children) {
                            if (sib2 === btn || sib2 === sib) continue;
                            const icon2 = sib2.querySelector?.('i, [class*="icon"]');
                            const iconText2 = (icon2?.textContent || "").trim().toLowerCase();
                            if (iconText2 === 'add' || iconText2 === 'add_circle' || iconText2 === 'add_circle_outline' ||
                                sib2.textContent?.trim() === '+') {
                                plusBtn = sib2;
                                break;
                            }
                        }
                        return { minusBtn: btn, plusBtn, valueEl: sib };
                    }
                }
            }
        }
        return null;
    }

    // Trigger React change handlers em um elemento
    function triggerReact(element, value) {
        const keys = Object.keys(element).filter(k => k.startsWith("__reactProps") || k.startsWith("__reactFiber"));
        for (const key of keys) {
            const props = element[key];
            if (props?.onChange) {
                try { props.onChange(typeof value === 'number' ? value : { target: { value: String(value), valueAsNumber: value } }); } catch (e) { }
            }
            if (props?.memoizedProps?.onChange) {
                try { props.memoizedProps.onChange(value); } catch (e) { }
            }
            if (props?.onValueChange) {
                try { props.onValueChange(value); } catch (e) { }
            }
        }
    }

    // Solicitar ao background.js que injete fetch interceptor via chrome.scripting.executeScript
    function requestFetchIntercept(count) {
        if (_fetchInterceptRequested) {
            // Ja instalado, apenas atualizar o count via custom event
            window.dispatchEvent(new CustomEvent('__dotti_set_output_count', { detail: { count } }));
            return;
        }
        _fetchInterceptRequested = true;
        try {
            chrome.runtime.sendMessage({
                action: "INJECT_FETCH_INTERCEPT",
                count: count
            });
        } catch (e) {
            console.log("[Dotti DOM] Erro ao solicitar fetch intercept:", e);
        }
    }

    // ============================================
    // CLIPBOARD HELPER
    // ============================================

    function copyToClipboard(text) {
        const textarea = document.createElement("textarea");
        textarea.value = text;
        textarea.style.cssText = "position:fixed;left:-9999px;top:-9999px;";
        document.body.appendChild(textarea);
        textarea.select();
        try {
            document.execCommand("copy");
            console.log("[Dotti] Copiado:", text);
        } catch (e) {
            console.error("[Dotti] Erro ao copiar:", e);
        }
        document.body.removeChild(textarea);
    }

    // ============================================
    // MESSAGE HANDLING (FROM BACKGROUND)
    // ============================================

    chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
        console.log("[Dotti DOM] Received:", message.action);

        switch (message.action) {
            case "TOGGLE_PANEL":
                togglePanel();
                sendResponse({ success: true });
                break;

            case "EXECUTE_PROMPT_DOM":
                executePrompt(message.data).then(result => {
                    sendResponse(result);
                });
                return true;

            case "PROMPT_STARTING":
                // Marcar prompt como 'sending' + trackear para lastSubmitted
                if (message.data?.number) {
                    _lastSubmittedPromptNumber = message.data.number;
                    _lastSubmittedTime = Date.now();
                    const p = _promptList.find(x => x.number === message.data.number);
                    if (p) p.status = 'sending';
                    // PromptTracker: mapear itemIndex → promptNumber (identico DarkPlanner)
                    _itemIndexToPrompt.set(_nextItemIndex, message.data.number);
                    _nextItemIndex++;
                }
                notifyPanel({ type: "PROMPT_STARTING", data: message.data });
                sendResponse({ success: true });
                break;

            case "PROMPT_RESULT":
                // Atualizar status do prompt no scanner
                if (message.data?.number && message.data?.result?.success) {
                    const p = _promptList.find(x => x.number === message.data.number);
                    if (p && p.status !== 'generating') {
                        p.status = 'generating';
                        p.startedAt = p.startedAt || Date.now();
                    }
                }
                notifyPanel({ type: "PROMPT_RESULT", data: message.data });
                sendResponse({ success: true });
                break;

            case "BATCH_PAUSE":
                notifyPanel({ type: "BATCH_PAUSE", data: message.data });
                sendResponse({ success: true });
                break;

            case "QUEUE_COMPLETE":
                notifyPanel({ type: "QUEUE_COMPLETE", data: message.data });
                sendResponse({ success: true });
                break;

            case "QUEUE_ERROR":
                notifyPanel({ type: "QUEUE_ERROR", data: message.data });
                sendResponse({ success: true });
                break;

            case "LICENSE_ERROR":
                notifyPanel({ type: "LICENSE_ERROR", data: message.data });
                sendResponse({ success: true });
                break;

            // v2.1.0: Preparar para proximo prompt - limpar galeria/elementos
            case "PREPARE_FOR_NEXT_PROMPT":
                (async () => {
                    try {
                        await clearElements();
                        console.log("[Dotti DOM] Galeria limpa para proximo prompt");
                        sendResponse({ success: true });
                    } catch (e) {
                        console.error("[Dotti DOM] Erro ao limpar galeria:", e);
                        sendResponse({ success: false });
                    }
                })();
                return true;

            // v2.2.1: Refresh de URL do video - re-ler src atual do elemento video
            case "REFRESH_VIDEO_URL":
                (async () => {
                    try {
                        const promptNum = message.promptNumber;
                        const oldUrl = message.oldUrl;
                        let freshUrl = null;

                        // Procurar video pelo prompt text no DOM
                        document.querySelectorAll("video").forEach(video => {
                            if (freshUrl) return;
                            const src = video.src || video.querySelector("source")?.src;
                            if (!src) return;
                            const isFlow = src.includes("storage.googleapis.com") || src.includes("labs.google") || src.includes("googleusercontent.com");
                            if (!isFlow) return;
                            // Verificar se este video pertence ao prompt (25 niveis)
                            let parent = video.parentElement;
                            for (let i = 0; i < 25 && parent; i++) {
                                const text = parent.innerText || "";
                                const match = text.match(/PROMPT\s*(\d+)/i);
                                if (match && parseInt(match[1]) === promptNum) {
                                    freshUrl = src;
                                    return;
                                }
                                parent = parent.parentElement;
                            }
                        });

                        // Fallback: se nao achou por prompt, usar o video com URL mais parecida
                        if (!freshUrl && oldUrl) {
                            const baseOld = oldUrl.split("?")[0];
                            document.querySelectorAll("video").forEach(video => {
                                const src = video.src || video.querySelector("source")?.src;
                                if (src && src.split("?")[0] === baseOld) {
                                    freshUrl = src;
                                }
                            });
                        }

                        sendResponse({ success: !!freshUrl, url: freshUrl || oldUrl });
                    } catch (e) {
                        sendResponse({ success: false, url: message.oldUrl });
                    }
                })();
                return true;

            // v3.0.0: START_AUTOMATION — inicia processamento simultaneo com slots
            case "START_AUTOMATION":
                (async () => {
                    try {
                        // v3.1.0: Guard contra re-entrada — se ja esta rodando, parar o loop anterior primeiro
                        if (_isRunning) {
                            console.log('[Dotti] START_AUTOMATION: parando automacao anterior antes de reiniciar...');
                            _stopRequested = true;
                            // Aguardar o loop anterior parar (max 5s)
                            for (let w = 0; w < 50 && _isRunning; w++) {
                                await sleep(100);
                            }
                            _isRunning = false;
                        }

                        // v3.5.0: SEMPRE resetar _stopRequested antes de iniciar
                        // Corrige race condition: STOP_AUTOMATION chega antes de START_AUTOMATION
                        // (background.js faz sleep(2000) antes de enviar START_AUTOMATION)
                        _stopRequested = false;

                        const { prompts, settings, mediaType, folder, autoDownload } = message;
                        _maxSimultaneous = settings?.maxSimultaneous || 3;
                        _currentQueueSettings = settings || {};
                        _currentQueueMediaType = mediaType || 'video';

                        // v3.1.0: Preservar URLs ja baixadas antes do reset
                        // react-virtuoso remove <video> do DOM quando fora da tela,
                        // entao scanExistingVideos() nao encontra todos os videos antigos
                        const previouslyDownloaded = new Set(_downloadedVideoUrls);

                        // Reset scanner
                        resetVideoUrlScanner();

                        // Configurar prompt list com task objects
                        setPromptList(prompts, folder, mediaType, autoDownload);

                        // Restaurar URLs previamente baixadas (que react-virtuoso removeu do DOM)
                        for (const url of previouslyDownloaded) {
                            _downloadedVideoUrls.add(url);
                        }

                        // Configurar output count se especificado
                        if (settings?.outputCount && settings.outputCount > 1) {
                            requestFetchIntercept(settings.outputCount);
                        }

                        console.log('[Dotti] START_AUTOMATION: ' + prompts.length + ' prompts, ' + _maxSimultaneous + ' slots simultaneos');

                        // Iniciar processamento (nao bloqueia — roda em paralelo)
                        processAllPromptsWithSlots();

                        sendResponse({ success: true });
                    } catch (e) {
                        console.error('[Dotti] Erro ao iniciar automacao:', e);
                        sendResponse({ success: false, error: e.message });
                    }
                })();
                return true;

            // v3.0.0: STOP_AUTOMATION — para processamento
            case "STOP_AUTOMATION":
                _stopRequested = true;
                _isRunning = false;
                console.log('[Dotti] STOP_AUTOMATION recebido');
                sendResponse({ success: true });
                break;

            // v3.0.0: ADD_RETRY_PROMPT — insere prompt reescrito na taskList
            case "ADD_RETRY_PROMPT":
                (async () => {
                    try {
                        const { prompt, originalIndex, isRetry, retryCount } = message.data || message;
                        console.log('[Dotti] ADD_RETRY_PROMPT: originalIndex=' + originalIndex + ', retryCount=' + retryCount);

                        // Encontrar task original para copiar campos
                        const originalTask = _promptList.find(t => t.index === originalIndex || t.number === originalIndex);

                        // Criar nova task com prompt reescrito
                        const newIndex = _promptList.length;
                        const newTask = {
                            index: newIndex,
                            number: originalTask ? originalTask.number : (originalIndex + 1),
                            text: prompt,
                            prompt: prompt,
                            elements: originalTask ? originalTask.elements : [],
                            status: 'pending',
                            uuid: null,
                            mediaId: null,
                            retryCount: retryCount || 1,
                            highDemandRetryCount: 0,
                            techRetryCount: 0,
                            isRetry: true,
                            originalIndex: originalIndex,
                            downloadIndex: originalTask ? (originalTask.downloadIndex || originalTask.index) : originalIndex,
                            startedAt: null,
                            lastSubmitTime: null,
                            foundVideos: 0,
                            expectedVideos: 1,
                            downloaded: false,
                            failType: null,
                            error: null,
                            needsRetryAfterSystemError: false,
                            isTimeoutRetry: false,
                            timeoutRetryNumber: 0,
                            hasImage: originalTask ? originalTask.hasImage : false,
                            image: originalTask ? originalTask.image : null
                        };

                        _promptList.push(newTask);
                        _pendingRewrites = Math.max(0, _pendingRewrites - 1);

                        console.log('[Dotti] Retry prompt adicionado: #' + newTask.number + ' (reescrito)');
                        notifyPanel({ type: 'RETRY_PROMPT_ADDED', data: { number: newTask.number, originalIndex } });

                        sendResponse({ success: true });
                    } catch (e) {
                        console.error('[Dotti] Erro ao adicionar retry prompt:', e);
                        sendResponse({ success: false, error: e.message });
                    }
                })();
                return true;

            // v3.0.0: RESUME_AFTER_HARD_RESET — retoma apos cooldown de 45s
            case "RESUME_AFTER_HARD_RESET":
                (async () => {
                    try {
                        console.log('[Dotti] RESUME_AFTER_HARD_RESET recebido');

                        // Ler estado salvo
                        const stored = await chrome.storage.local.get('dotti_hard_reset_state');
                        const state = stored.dotti_hard_reset_state;

                        if (!state) {
                            console.log('[Dotti] Estado de Hard Reset nao encontrado');
                            sendResponse({ success: false, error: 'no_state' });
                            return;
                        }

                        // Limpar estado salvo
                        await chrome.storage.local.remove('dotti_hard_reset_state');

                        // Reconstruir promptList a partir do estado salvo
                        const remainingPrompts = (state.prompts || []).filter(t =>
                            t.status === 'pending' || t.status === 'generating'
                        );

                        if (remainingPrompts.length === 0) {
                            console.log('[Dotti] Nenhum prompt pendente para retomar');
                            sendResponse({ success: false, error: 'no_pending' });
                            return;
                        }

                        _maxSimultaneous = state.maxSimultaneous || 3;
                        _downloadFolder = state.folder || 'LetzVideos';
                        _mediaType = state.mediaType || 'video';
                        _autoDownload = state.autoDownload !== false;

                        // Resetar scanner
                        resetVideoUrlScanner();

                        // Reconstruir task objects
                        _promptList = remainingPrompts.map((p, i) => ({
                            ...p,
                            index: i,
                            status: 'pending',
                            uuid: null,
                            startedAt: null,
                            lastSubmitTime: null,
                            needsRetryAfterSystemError: true
                        }));

                        // Resetar slot system
                        _tasksByUUID.clear();
                        _processedTaskUUIDs.clear();
                        _sendLockByIndex.clear();
                        _consecutiveErrorCount = 0;
                        _notifiedPolicyErrors.clear();
                        _pendingRewrites = 0;
                        _stopRequested = false;
                        _activeSlots = 0;

                        console.log('[Dotti] Retomando ' + _promptList.length + ' prompts apos Hard Reset');
                        notifyPanel({ type: 'HARD_RESET_RESUMED', data: { count: _promptList.length } });

                        // v3.1.0: Criar novo projeto antes de retomar (identico DarkPlanner)
                        await autoClickNewProject();
                        await sleep(3000);

                        // Iniciar processamento
                        processAllPromptsWithSlots();

                        sendResponse({ success: true });
                    } catch (e) {
                        console.error('[Dotti] Erro ao retomar apos Hard Reset:', e);
                        sendResponse({ success: false, error: e.message });
                    }
                })();
                return true;

            // v3.0.0: SET_MAX_SIMULTANEOUS — atualizar slots
            case "SET_MAX_SIMULTANEOUS":
                _maxSimultaneous = Math.min(20, Math.max(1, message.value || 3));
                // Redimensionar array de slots se necessario
                while (_slots.length < _maxSimultaneous) _slots.push(null);
                if (_slots.length > _maxSimultaneous) _slots.length = _maxSimultaneous;
                console.log('[Dotti] maxSimultaneous atualizado para ' + _maxSimultaneous);
                sendResponse({ success: true });
                break;

            // v2.0.0: Download interceptado pelo background - encaminhar ao painel
            case "DOWNLOAD_INTERCEPTED":
                notifyPanel({ type: "DOWNLOAD_INTERCEPTED", data: message.data });
                sendResponse({ success: true });
                break;

            // v2.1.0: Definir outputs per prompt (chamado pelo background no primeiro prompt)
            case "SET_OUTPUTS_PER_PROMPT":
                (async () => {
                    try {
                        const count = message.count || 1;
                        console.log("[Dotti DOM] SET_OUTPUTS_PER_PROMPT count=" + count);
                        const success = await setOutputsPerPrompt(count);
                        sendResponse({ success });
                    } catch (e) {
                        console.error("[Dotti DOM] SET_OUTPUTS_PER_PROMPT erro:", e);
                        sendResponse({ success: false, error: e.message });
                    }
                })();
                return true;

            // v2.0.2: Garantir modo correto antes de cada prompt (tab-based)
            case "ENSURE_IMAGE_MODE":
                (async () => {
                    try {
                        console.log("[Dotti ENSURE] === INICIO ENSURE_IMAGE_MODE ===");
                        const wasImage = isDropdownInImageMode();

                        // PASSO 1: Clicar tab Image no menu de criacao
                        const ok = await switchToImageMode();
                        console.log("[Dotti ENSURE] switchToImageMode:", ok);
                        await sleep(800);

                        // PASSO 2: Mudar sidebar para View images
                        await switchFlowProjectTab("image");
                        await sleep(500);

                        console.log("[Dotti ENSURE] === FIM ENSURE_IMAGE_MODE ===");
                        sendResponse({ success: true, switched: !wasImage });
                    } catch (e) {
                        console.error("[Dotti ENSURE] ERRO:", e);
                        sendResponse({ success: false, error: e.message });
                    }
                })();
                return true;

            case "ENSURE_VIDEO_MODE":
                (async () => {
                    try {
                        console.log("[Dotti ENSURE] === INICIO ENSURE_VIDEO_MODE ===");
                        const wasImage = isDropdownInImageMode();

                        // PASSO 1: Clicar tab Video no menu de criacao
                        const ok = await switchToVideoMode();
                        console.log("[Dotti ENSURE] switchToVideoMode:", ok);
                        await sleep(800);

                        // PASSO 2: Mudar sidebar para View videos
                        await switchFlowProjectTab("video");
                        await sleep(500);

                        console.log("[Dotti ENSURE] === FIM ENSURE_VIDEO_MODE ===");
                        sendResponse({ success: true, switched: wasImage });
                    } catch (e) {
                        console.error("[Dotti ENSURE] ERRO:", e);
                        sendResponse({ success: false, error: e.message });
                    }
                })();
                return true;

            // v2.0.3: Overlay de progresso gerenciado diretamente no content.js
            // Mais confiavel que chrome.scripting.executeScript do background
            case "INJECT_OVERLAY":
                (() => {
                    console.log("[Dotti DOM] INJECT_OVERLAY chamado");
                    document.getElementById("dotti-status-overlay")?.remove();
                    // Favicon e titulo
                    let link = document.querySelector("link[rel*='icon']");
                    if (!link) {
                        link = document.createElement("link");
                        link.rel = "icon";
                        document.head.appendChild(link);
                    }
                    link.href = message.iconUrl || "";
                    document.title = "Lets Automate";
                    // Esconder sidebar e toggle
                    const sidebar = document.getElementById(PANEL_ID);
                    if (sidebar) sidebar.style.display = "none";
                    const toggleBtn = document.getElementById(TOGGLE_BTN_ID);
                    if (toggleBtn) toggleBtn.style.display = "none";
                    document.documentElement.classList.remove("dotti-sidebar-open");
                    // Criar overlay
                    const o = document.createElement("div");
                    o.id = "dotti-status-overlay";
                    o.innerHTML = '<style>#dotti-status-overlay{position:fixed!important;top:0!important;left:0!important;right:0!important;bottom:0!important;width:100%!important;height:100%!important;margin:0!important;padding:20px!important;box-sizing:border-box!important;background:linear-gradient(135deg,#1a1a2e,#16213e)!important;z-index:2147483647!important;display:flex!important;flex-direction:column!important;align-items:center!important;justify-content:center!important;font-family:"Segoe UI",Arial,sans-serif!important;color:#fff!important;pointer-events:none!important;transform:none!important;contain:none!important}#dotti-status-overlay .logo{font-size:48px!important;margin-bottom:15px!important}#dotti-status-overlay .title{font-size:22px!important;font-weight:700!important;margin-bottom:8px!important;background:linear-gradient(90deg,#00d4ff,#7b2cbf)!important;-webkit-background-clip:text!important;-webkit-text-fill-color:transparent!important}#dotti-status-overlay .status{font-size:14px!important;color:#a0a0a0!important;margin-bottom:20px!important}#dotti-status-overlay .pbar{width:80%!important;height:6px!important;background:#2a2a4a!important;border-radius:3px!important;overflow:hidden!important;margin-bottom:15px!important}#dotti-status-overlay .pfill{height:100%!important;background:linear-gradient(90deg,#00d4ff,#7b2cbf)!important;border-radius:3px!important;transition:width .3s!important;width:0}#dotti-status-overlay .count{font-size:36px!important;font-weight:700!important;color:#00d4ff!important}#dotti-status-overlay .label{font-size:12px!important;color:#666!important;margin-top:5px!important}</style><div class="logo">&#9889;</div><div class="title">DOTTI SENDER FULL</div><div class="status" id="dso-status">Preparando...</div><div class="pbar"><div class="pfill" id="dso-progress"></div></div><div class="count" id="dso-count">0/0</div><div class="label">prompts enviados</div>';
                    document.documentElement.appendChild(o);
                    console.log("[Dotti DOM] Overlay criado com sucesso");
                })();
                sendResponse({ success: true });
                break;

            case "UPDATE_OVERLAY":
                (() => {
                    const st = document.getElementById("dso-status");
                    const pr = document.getElementById("dso-progress");
                    const ct = document.getElementById("dso-count");
                    if (st) st.textContent = message.status;
                    if (ct) ct.textContent = message.current + "/" + message.total;
                    if (pr) pr.style.width = (message.total > 0 ? (message.current / message.total) * 100 : 0) + "%";
                })();
                sendResponse({ success: true });
                break;

            case "REMOVE_OVERLAY":
                (() => {
                    console.log("[Dotti DOM] REMOVE_OVERLAY chamado");
                    document.getElementById("dotti-status-overlay")?.remove();
                    // Restaurar sidebar e toggle
                    const sidebar = document.getElementById(PANEL_ID);
                    if (sidebar) sidebar.style.display = "";
                    const toggleBtn = document.getElementById(TOGGLE_BTN_ID);
                    if (toggleBtn) toggleBtn.style.display = "";
                })();
                sendResponse({ success: true });
                break;

            // ===== v3.1.0 EXTEND =====
            case "EXTEND_RUN_BASE":
                runExtendBase(message.scene).then(r => sendResponse(r || { success: true }))
                    .catch(e => sendResponse({ success: false, error: e.message }));
                return true;

            case "EXTEND_RUN_EXT":
                runExtendExt(message.scene).then(r => sendResponse(r || { success: true }))
                    .catch(e => sendResponse({ success: false, error: e.message }));
                return true;

            case "EXTEND_DOWNLOAD":
                runExtendDownload(message.scene).then(r => sendResponse(r || { success: true }))
                    .catch(e => sendResponse({ success: false, error: e.message }));
                return true;

            case "SCENE_UPDATE_BRIDGE":
                notifyPanel({ type: "SCENE_UPDATE", data: message.data });
                sendResponse({ success: true });
                break;

            case "SCENE_QUEUE_COMPLETE_BRIDGE":
                notifyPanel({ type: "SCENE_QUEUE_COMPLETE" });
                sendResponse({ success: true });
                break;

            default:
                sendResponse({ success: false, error: "unknown_action" });
        }

        return true;
    });

    // ============================================
    // MESSAGE FROM PANEL (IFRAME)
    // ============================================

    window.addEventListener("message", async (event) => {
        let isFromPanel = false;
        const iframe = findPanelIframe();
        if (iframe && event.source === iframe.contentWindow) {
            isFromPanel = true;
        }
        if (!isFromPanel) return;

        const { type, data } = event.data;

        switch (type) {
            case "START_QUEUE":
                _firstPromptOfSession = true; // v2.0.2: resetar para garantir x1 no primeiro prompt
                // v3.1.0: Preservar URLs ja baixadas antes do reset (react-virtuoso)
                const _prevDownloaded = new Set(_downloadedVideoUrls);
                resetVideoUrlScanner();
                // Receber prompt list do panel para matching no scanner
                setPromptList(
                    data.prompts,
                    data.folder || 'LetzVideos',
                    data.mediaType || 'video',
                    data.autoDownload !== false
                );
                for (const _u of _prevDownloaded) _downloadedVideoUrls.add(_u);
                startVideoUrlScanner();
                chrome.runtime.sendMessage({
                    action: "START_QUEUE",
                    prompts: data.prompts,
                    settings: data.settings,
                    tabId: await getCurrentTabId(),
                    mediaType: data.mediaType
                });
                break;

            case "PAUSE_QUEUE":
                chrome.runtime.sendMessage({ action: "PAUSE_QUEUE" });
                break;

            case "RESUME_QUEUE":
                startVideoUrlScanner(); // Retomar scanner ao continuar
                chrome.runtime.sendMessage({ action: "RESUME_QUEUE" });
                break;

            case "CANCEL_QUEUE":
                stopVideoUrlScanner();
                chrome.runtime.sendMessage({ action: "CANCEL_QUEUE" });
                break;

            // v3.0.0: Controle do scanner de URLs
            case "START_SCANNER":
                // v3.1.0: Ordem corrigida — reset ANTES de setPromptList para preservar _downloadedVideoUrls
                resetVideoUrlScanner();
                if (data?.prompts) {
                    setPromptList(data.prompts, data.folder, data.mediaType, data.autoDownload);
                }
                startVideoUrlScanner();
                break;

            case "STOP_SCANNER":
                stopVideoUrlScanner();
                break;

            // v3.0.0: Atualizar prompt status
            case "UPDATE_PROMPT_STATUS":
                if (data?.number && data?.status) {
                    const prompt = _promptList.find(p => p.number === data.number);
                    if (prompt) {
                        // 'sent' do panel = 'generating' para o scanner
                        prompt.status = (data.status === 'sent') ? 'generating' : data.status;
                        if (data.status === 'sent' && !prompt.startedAt) {
                            prompt.startedAt = Date.now();
                        }
                    }
                }
                break;

            case "GET_QUEUE_STATUS":
                const status = await chrome.runtime.sendMessage({ action: "GET_QUEUE_STATUS" });
                notifyPanel({ type: "QUEUE_STATUS", data: status });
                break;

            // v3.0.0: ADD_RETRY_PROMPT via postMessage (do panel.js)
            case "ADD_RETRY_PROMPT": {
                const { prompt, originalIndex, isRetry, retryCount } = data || {};
                console.log('[Dotti] ADD_RETRY_PROMPT via postMessage: originalIndex=' + originalIndex);

                const origTask = _promptList.find(t => t.index === originalIndex || t.number === originalIndex);
                const newIdx = _promptList.length;
                const retryTask = {
                    index: newIdx,
                    number: origTask ? origTask.number : (originalIndex + 1),
                    text: prompt,
                    prompt: prompt,
                    elements: origTask ? origTask.elements : [],
                    status: 'pending',
                    uuid: null,
                    mediaId: null,
                    retryCount: retryCount || 1,
                    highDemandRetryCount: 0,
                    techRetryCount: 0,
                    isRetry: true,
                    originalIndex: originalIndex,
                    downloadIndex: origTask ? (origTask.downloadIndex || origTask.index) : originalIndex,
                    startedAt: null,
                    lastSubmitTime: null,
                    foundVideos: 0,
                    expectedVideos: 1,
                    downloaded: false,
                    failType: null,
                    error: null,
                    needsRetryAfterSystemError: false,
                    isTimeoutRetry: false,
                    timeoutRetryNumber: 0,
                    hasImage: origTask ? origTask.hasImage : false,
                    image: origTask ? origTask.image : null
                };
                _promptList.push(retryTask);
                _pendingRewrites = Math.max(0, _pendingRewrites - 1);
                console.log('[Dotti] Retry prompt adicionado via postMessage: #' + retryTask.number);
                break;
            }

            // v3.1.0: REWRITE_FAILED — auto-retry com prompt original quando rewrite falha
            case "REWRITE_FAILED": {
                _pendingRewrites = Math.max(0, _pendingRewrites - 1);
                const failedNumber = data?.number;
                console.log('[Dotti] REWRITE_FAILED: _pendingRewrites=' + _pendingRewrites + ' prompt=#' + failedNumber);
                // v3.1.0: NAO criar auto-retry. Erros de POLICY nao se resolvem
                // reenviando o mesmo prompt. O usuario pode usar "Reenviar" manualmente.
                break;
            }

            // v3.0.0: STOP_AUTOMATION via postMessage
            case "STOP_AUTOMATION":
                _stopRequested = true;
                _isRunning = false;
                console.log('[Dotti] STOP_AUTOMATION via postMessage');
                break;

            // v2.1.0: SWITCH_FLOW_TAB - Flow nao tem mais tabs/dropdown (UI unificada)
            case "SWITCH_FLOW_TAB":
                console.log("[Dotti DOM] SWITCH_FLOW_TAB ignorado - Flow UI unificada, sem tabs/dropdown");
                break;

            // v2.0.0: Mudar modo do Flow para imagem/video
            case "SWITCH_TO_IMAGE_MODE":
                switchToImageMode().then(success => {
                    notifyPanel({
                        type: "MODE_SWITCHED",
                        data: { mode: "image", success }
                    });
                });
                break;

            case "SWITCH_TO_VIDEO_MODE":
                switchToVideoMode().then(success => {
                    notifyPanel({
                        type: "MODE_SWITCHED",
                        data: { mode: "video", success }
                    });
                });
                break;

            // v2.1.0: Definir outputs per prompt
            case "SET_OUTPUTS_PER_PROMPT":
                setOutputsPerPrompt(data?.count || 1).then(success => {
                    notifyPanel({
                        type: "OUTPUTS_SET",
                        data: { success }
                    });
                });
                break;

            // v2.2.1: Refresh URL de video antes do download
            case "REFRESH_VIDEO_URL":
                (() => {
                    const promptNum = data?.promptNumber;
                    const oldUrl = data?.oldUrl;
                    let freshUrl = null;

                    document.querySelectorAll("video").forEach(video => {
                        if (freshUrl) return;
                        const src = video.src || video.querySelector("source")?.src;
                        if (!src) return;
                        const isFlow = src.includes("storage.googleapis.com") || src.includes("labs.google") || src.includes("googleusercontent.com");
                        if (!isFlow) return;
                        let parent = video.parentElement;
                        for (let i = 0; i < 25 && parent; i++) {
                            const text = parent.innerText || "";
                            const match = text.match(/PROMPT\s*(\d+)/i);
                            if (match && parseInt(match[1]) === promptNum) {
                                freshUrl = src;
                                return;
                            }
                            parent = parent.parentElement;
                        }
                    });

                    if (!freshUrl && oldUrl) {
                        const baseOld = oldUrl.split("?")[0];
                        document.querySelectorAll("video").forEach(video => {
                            const src = video.src || video.querySelector("source")?.src;
                            if (src && src.split("?")[0] === baseOld) freshUrl = src;
                        });
                    }

                    notifyPanel({
                        type: "REFRESH_VIDEO_URL_RESULT",
                        data: { url: freshUrl || oldUrl, promptNumber: promptNum }
                    });
                })();
                break;

            case "COPY_TEXT":
                copyToClipboard(data);
                break;
        }
    });

    async function getCurrentTabId() {
        return new Promise(resolve => {
            chrome.runtime.sendMessage({ action: "GET_ACTIVE_TAB" }, response => {
                resolve(response?.tabId);
            });
        });
    }

    // ============================================
    // INITIALIZATION
    // ============================================

    function init() {
        if (!window.location.href.includes("labs.google")) return;

        if (!document.getElementById(TOGGLE_BTN_ID)) {
            toggleBtn = document.createElement("div");
            toggleBtn.id = TOGGLE_BTN_ID;
            toggleBtn.innerHTML = '<svg width="24" height="24" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg"><path d="M13 2L4 14H11L10 22L19 10H12L13 2Z" fill="#FFD700" stroke="#FFD700" stroke-width="1" stroke-linecap="round" stroke-linejoin="round"/></svg>';
            toggleBtn.title = "Lets Automate";
            toggleBtn.addEventListener("click", togglePanel);
            document.body.appendChild(toggleBtn);
        }

        // v3.0.0: Inject API interceptor and setup listeners BEFORE panel
        injectInterceptor();
        // v3.1.0: Inject Slate helper for MAIN world text fill + submit
        injectSlateHelper();
        setupApiInterceptorListeners();
        setupNetworkErrorInterceptor();

        // Auto-abrir sidebar ao carregar a pagina
        if (!document.getElementById(PANEL_ID)) {
            createPanel();
            isPanelVisible = true;
            document.documentElement.classList.add("dotti-sidebar-open");
            if (toggleBtn) {
                toggleBtn.classList.add("active");
                toggleBtn.classList.remove("sidebar-closed");
            }
        }

        // Ao carregar o Flow: abrir novo projeto (se veio do icone)
        // Flow UI unificada - nao precisa mais trocar tabs/dropdown
        setTimeout(async () => {
            try {
                // v3.1.0: Verificar se ha recovery state de HTTP 400
                const recovered = await checkVeo400RecoveryState();
                if (recovered) return; // Recovery em andamento, nao fazer mais nada

                // Verificar se deve abrir novo projeto automaticamente
                const flags = await chrome.runtime.sendMessage({ action: "GET_AUTO_NEW_PROJECT" });
                if (flags?.autoNewProject) {
                    console.log("[Dotti DOM] Auto novo projeto...");
                    await autoClickNewProject();
                }
            } catch (e) {
                console.log("[Dotti DOM] Init setup erro:", e.message);
            }
        }, 3000);

        console.log("[Lets Automate] v3.1.0 ready");
    }

    if (document.readyState === "loading") {
        document.addEventListener("DOMContentLoaded", init);
    } else {
        init();
    }

    // ============================================================
    // EXTEND (SCENE) AUTOMATION — v3.1.0
    // BASE: envia prompt na home do projeto, captura mediaId via interceptor.
    // EXT: clica thumb -> botao Estender -> dropdown modelo -> textarea -> submit.
    // Download final via DOWNLOAD_VIDEO ja existente.
    // ============================================================
    let _extendPending = null; // {sceneNumber, kind: 'base'|'ext'}
    let _extendListenerInstalled = false;

    function _installExtendInterceptListener() {
        if (_extendListenerInstalled) return;
        _extendListenerInstalled = true;
        document.addEventListener('dotti-video-submitted', (e) => {
            try {
                if (!_extendPending) return;
                const media = e.detail?.media || [];
                if (!media.length || !media[0]?.mediaId) return;
                // Pega o mais recente
                const mediaId = media[media.length - 1].mediaId;
                const pending = _extendPending;
                _extendPending = null;
                const action = pending.kind === 'base' ? 'EXTEND_BASE_SUBMITTED' : 'EXTEND_EXT_SUBMITTED';
                console.log('[Extend] mediaId capturado (' + pending.kind + '):', mediaId.substring(0, 12));
                chrome.runtime.sendMessage({ action, sceneNumber: pending.sceneNumber, mediaId }).catch(() => {});
            } catch (err) {
                console.error('[Extend] interceptListener err:', err);
            }
        });
    }

    function _findByText(selector, textNeedle, opts) {
        const exact = opts?.exact || false;
        const needle = String(textNeedle).toLowerCase().trim();
        const nodes = Array.from(document.querySelectorAll(selector));
        for (const n of nodes) {
            if (n.offsetParent === null && !opts?.allowHidden) continue;
            const t = (n.textContent || '').toLowerCase().trim();
            if (exact ? t === needle : t.includes(needle)) return n;
        }
        return null;
    }

    async function _trustedClickEl(el) {
        if (!el) return false;
        try {
            el.scrollIntoView({ block: 'center', inline: 'center', behavior: 'instant' });
            await sleep(150);
            const r = el.getBoundingClientRect();
            const x = Math.round(r.left + r.width / 2);
            const y = Math.round(r.top + r.height / 2);
            const res = await chrome.runtime.sendMessage({ action: 'TRUSTED_CLICK', x, y });
            if (res?.success) return true;
        } catch (e) {
            console.log('[Extend] trustedClick err:', e.message);
        }
        // Fallback: dispatchFullClick
        try { dispatchFullClick(el); return true; } catch (e) { return false; }
    }

    async function _waitForElement(finder, timeoutMs, interval) {
        const t0 = Date.now();
        const step = interval || 250;
        while (Date.now() - t0 < (timeoutMs || 8000)) {
            const el = finder();
            if (el) return el;
            await sleep(step);
        }
        return null;
    }

    function _isVisible(el) {
        if (!el) return false;
        const r = el.getBoundingClientRect();
        if (r.width <= 1 || r.height <= 1) return false;
        const cs = getComputedStyle(el);
        if (cs.display === 'none' || cs.visibility === 'hidden') return false;
        if (parseFloat(cs.opacity || '1') === 0) return false;
        return true;
    }

    function _allText(el) {
        // Texto + aria-label + title, em minusculas, espacos colapsados
        const t = (el.innerText || el.textContent || '') + ' ' +
                  (el.getAttribute('aria-label') || '') + ' ' +
                  (el.getAttribute('title') || '');
        return t.toLowerCase().replace(/\s+/g, ' ').trim();
    }

    function _findEstenderButton() {
        // CRITICO: NAO usar offsetParent (retorna null para position:fixed,
        // que e o caso da barra inferior do detalhe do Flow).
        const candidates = Array.from(document.querySelectorAll('button, [role="button"]'));
        for (const b of candidates) {
            if (!_isVisible(b)) continue;
            const t = _allText(b);
            if (!t || t.length > 80) continue;
            if (/\bestender\b/.test(t) || /\bextend\b/.test(t)) return b;
        }
        return null;
    }

    function _findModelDropdownTrigger() {
        const tb = document.querySelector('[role="textbox"]');
        const tbRect = tb && _isVisible(tb) ? tb.getBoundingClientRect() : null;
        const candidates = Array.from(document.querySelectorAll('button, [role="button"], [role="combobox"]'));
        const matches = [];
        for (const b of candidates) {
            if (!_isVisible(b)) continue;
            const t = _allText(b);
            if (!t || t.length > 80) continue;
            if (/veo\s*3\.1\b/.test(t)) {
                let dist = 99999;
                if (tbRect) {
                    const r = b.getBoundingClientRect();
                    dist = Math.abs(r.top - tbRect.top) + Math.abs(r.left - tbRect.left);
                }
                matches.push({ el: b, dist, text: t });
            }
        }
        if (!matches.length) return null;
        matches.sort((a, b) => a.dist - b.dist);
        console.log('[Extend] modelDropdownTrigger candidates:', matches.map(m => m.text).slice(0, 3));
        return matches[0].el;
    }

    function _findLowerPriorityOption() {
        const sels = ['[role="menuitem"]', '[role="option"]', 'li', 'button', 'div[tabindex]', 'div[role]', 'a'];
        const seen = new Set();
        for (const sel of sels) {
            const nodes = Array.from(document.querySelectorAll(sel));
            for (const n of nodes) {
                if (seen.has(n)) continue;
                seen.add(n);
                if (!_isVisible(n)) continue;
                const t = _allText(n);
                if (!t || t.length > 120) continue;
                if (!/lower\s*priority/.test(t)) continue;
                if (!/lite/.test(t)) continue;
                if (/fast/.test(t)) continue;
                console.log('[Extend] lowerPriorityOption MATCH:', t);
                return n;
            }
        }
        return null;
    }

    function _isLowerPrioritySelected() {
        const trigger = _findModelDropdownTrigger();
        if (!trigger) return false;
        const t = _allText(trigger);
        return /lower\s*priority/.test(t) && /lite/.test(t) && !/fast/.test(t);
    }

    function _findTextareaForExtend() {
        const tbs = Array.from(document.querySelectorAll('[role="textbox"]'));
        for (const t of tbs) {
            if (!_isVisible(t)) continue;
            const ph = (t.getAttribute('aria-placeholder') || t.getAttribute('data-placeholder') || '').toLowerCase();
            if (ph.includes('proxima etapa') || ph.includes('próxima etapa') || ph.includes('next step')) return t;
        }
        for (const t of tbs) { if (_isVisible(t)) return t; }
        return null;
    }

    function _findThumbByMediaId(mediaId) {
        if (!mediaId) return null;
        const frag = mediaId.split('/').pop().split(':').pop();
        if (!frag) return null;
        const candidates = Array.from(document.querySelectorAll('video, img, source, [data-media-id], [data-id], [data-name]'));
        for (const c of candidates) {
            const src = c.src || c.getAttribute('src') || c.getAttribute('data-media-id') || c.getAttribute('data-id') || c.getAttribute('data-name') || '';
            if (src && src.includes(frag)) {
                const clickable = c.closest('button, a, [role="button"], [role="listitem"], [data-testid]') || c.parentElement || c;
                console.log('[Extend] thumb encontrado por mediaId frag=' + frag.substring(0, 10));
                return clickable;
            }
        }
        return null;
    }

    function _findMostRecentVideoThumb() {
        const videos = Array.from(document.querySelectorAll('video')).filter(v => _isVisible(v));
        if (videos.length) {
            const v = videos[videos.length - 1];
            const clickable = v.closest('button, a, [role="button"], [role="listitem"], [data-testid]') || v.parentElement || v;
            console.log('[Extend] fallback: ultimo thumb de video');
            return clickable;
        }
        const imgs = Array.from(document.querySelectorAll('img')).filter(i =>
            _isVisible(i) && i.naturalWidth > 100 && i.closest('[role="button"], button, a, [data-testid]'));
        if (imgs.length) {
            const im = imgs[imgs.length - 1];
            return im.closest('[role="button"], button, a, [data-testid]');
        }
        return null;
    }

    async function _openDetailForMediaId(mediaId) {
        if (_findEstenderButton()) { console.log('[Extend] detalhe ja aberto'); return true; }
        let target = _findThumbByMediaId(mediaId);
        if (!target) target = _findMostRecentVideoThumb();
        if (!target) {
            console.warn('[Extend] nenhum thumb encontrado para abrir detalhe');
            return false;
        }
        // Tenta clicar no proprio elemento (TRUSTED click usa centro do bounding rect).
        await _trustedClickEl(target);
        if (await _waitForElement(_findEstenderButton, 4000)) return true;
        // Fallback: subir para o card clicavel e tentar de novo
        const card = target.closest('[role="button"], button, a, [data-testid], [role="listitem"]');
        if (card && card !== target) {
            console.log('[Extend] retry clicando no card clicavel ancestral');
            await _trustedClickEl(card);
            if (await _waitForElement(_findEstenderButton, 4000)) return true;
        }
        // Ultimo recurso: dump de botoes visiveis para debug
        const btns = Array.from(document.querySelectorAll('button, [role="button"]'))
            .filter(b => _isVisible(b))
            .map(b => {
                const txt = ((b.innerText || b.textContent || '').trim()).replace(/\s+/g, ' ').substring(0, 50);
                const aria = (b.getAttribute('aria-label') || '').substring(0, 30);
                return txt + (aria ? ' [aria=' + aria + ']' : '');
            })
            .filter(t => t.replace(/\[aria=\]/, '').trim())
            .slice(0, 40);
        console.warn('[Extend] detail nao abriu. Botoes visiveis (' + btns.length + '):');
        btns.forEach((s, i) => console.warn('  [' + i + '] ' + s));
        return false;
    }

    async function _selectLowerPriorityModel(maxRetries) {
        if (_isLowerPrioritySelected()) {
            console.log('[Extend] Lower Priority ja selecionado');
            return true;
        }
        const tries = maxRetries || 2;
        for (let attempt = 1; attempt <= tries; attempt++) {
            const trigger = await _waitForElement(_findModelDropdownTrigger, 4000);
            if (!trigger) {
                console.warn('[Extend] dropdown trigger nao encontrado (tent ' + attempt + ')');
                await sleep(500);
                continue;
            }
            await _trustedClickEl(trigger);
            await sleep(500);
            const opt = await _waitForElement(_findLowerPriorityOption, 4000);
            if (!opt) {
                console.warn('[Extend] opcao Lower Priority nao encontrada (tent ' + attempt + ')');
                // Fechar dropdown com Esc
                document.body.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
                await sleep(300);
                continue;
            }
            await _trustedClickEl(opt);
            await sleep(600);
            if (_isLowerPrioritySelected()) {
                console.log('[Extend] Lower Priority selecionado com sucesso');
                return true;
            }
            console.warn('[Extend] selecao nao confirmada (tent ' + attempt + ')');
        }
        return false;
    }

    // Submete e usa o evento dotti-video-submitted (via _extendPending) como prova.
    // clickCreateButton tem verificacao visual (textarea limpa) que NAO funciona em
    // extend mode — Flow mantem o texto/state diferente. A API e a fonte de verdade.
    async function _submitAndAwaitApi(sceneNumber, kind, timeoutMs) {
        _extendPending = { sceneNumber, kind };
        // Dispara o submit. Ignoramos o retorno: a verificacao real e pelo evento da API.
        try { await clickCreateButton(); } catch (_) {}
        const deadline = Date.now() + (timeoutMs || 10000);
        while (Date.now() < deadline) {
            if (_extendPending === null) return true; // API listener consumiu = submit OK
            await sleep(150);
        }
        _extendPending = null;
        return false;
    }

    async function runExtendBase(scene) {
        console.log('[Extend] runExtendBase SCENE', scene.number);
        _installExtendInterceptListener();
        try {
            // Garantir que estamos na home do projeto antes de submeter BASE.
            // CRITICO: se ainda estivermos no detalhe, BASE seria tratada como extensao.
            const onHome = await _ensureProjectHome();
            if (!onHome) throw new Error('cannot_return_to_project_home');

            // Lidar com elementos (refs de imagem) caso existam
            if (Array.isArray(scene.elements) && scene.elements.length) {
                console.log('[Extend] aviso: BASE com [refs] (' + scene.elements.join(',') + ') — selecionar manualmente nao implementado');
            }

            // Preencher textarea principal
            const filled = await fillTextarea(scene.text);
            if (!filled) throw new Error('fill_textarea_failed');

            // Submit + aguarda confirmacao da API (em vez de checagem visual frageil)
            const ok = await _submitAndAwaitApi(scene.number, 'base', 12000);
            if (!ok) {
                chrome.runtime.sendMessage({ action: 'EXTEND_STEP_FAILED', sceneNumber: scene.number, reason: 'submit_failed_no_api' }).catch(() => {});
                return { success: false };
            }
            return { success: true };
        } catch (e) {
            console.error('[Extend] runExtendBase erro:', e.message);
            _extendPending = null;
            chrome.runtime.sendMessage({ action: 'EXTEND_STEP_FAILED', sceneNumber: scene.number, reason: e.message }).catch(() => {});
            return { success: false, error: e.message };
        }
    }

    async function _ensureProjectHome() {
        // Se ja estamos na home (sem botao "Estender" visivel), nada a fazer.
        if (!_findEstenderButton()) {
            console.log('[Extend] ja estamos na home do projeto');
            return true;
        }
        console.log('[Extend] tentando voltar para home do projeto...');

        // Estrategia 1: aria-label "Voltar"/"Back"
        let back = document.querySelector(
            'button[aria-label*="Voltar" i], button[aria-label*="Back" i], ' +
            'a[aria-label*="Voltar" i], a[aria-label*="Back" i], ' +
            '[role="button"][aria-label*="Voltar" i], [role="button"][aria-label*="Back" i]'
        );

        // Estrategia 2: botao com icone material "arrow_back"
        if (!back || !_isVisible(back)) {
            const icons = Array.from(document.querySelectorAll('i, span'))
                .filter(i => _isVisible(i) && /arrow_back\b/i.test(i.textContent || ''));
            for (const ic of icons) {
                const parent = ic.closest('button, a, [role="button"]');
                if (parent && _isVisible(parent)) { back = parent; break; }
            }
        }

        // Estrategia 3: primeiro botao no canto superior esquerdo (top<100, left<100)
        if (!back || !_isVisible(back)) {
            const cands = Array.from(document.querySelectorAll('button, a, [role="button"]'))
                .filter(b => _isVisible(b));
            for (const c of cands) {
                const r = c.getBoundingClientRect();
                if (r.top < 80 && r.left < 80 && r.width < 80 && r.height < 80) {
                    back = c; break;
                }
            }
        }

        if (!back) {
            // Tentar tecla Escape como ultimo recurso
            console.warn('[Extend] back nao encontrado — tentando Esc');
            document.body.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', keyCode: 27, which: 27, bubbles: true }));
            await sleep(800);
        } else {
            await _trustedClickEl(back);
            await sleep(900);
        }

        // Verificar que saiu do detalhe (Estender nao esta mais visivel)
        for (let i = 0; i < 8; i++) {
            if (!_findEstenderButton()) {
                console.log('[Extend] de volta na home');
                return true;
            }
            await sleep(300);
        }
        console.warn('[Extend] FALHA ao voltar para home — Estender ainda visivel');
        return false;
    }

    async function runExtendExt(scene) {
        console.log('[Extend] runExtendExt SCENE', scene.number, 'idx', scene.extIdx, 'isFirstExt=' + scene.isFirstExt);
        _installExtendInterceptListener();
        try {
            // 1) Abrir detalhe do video alvo (multiplas estrategias)
            const opened = await _openDetailForMediaId(scene.baseMediaId);
            if (!opened) throw new Error('detail_view_not_opened');
            await sleep(800); // DOM acomodar

            // 2) PRIMEIRO: trocar modelo para Lower Priority (antes de qualquer outra acao).
            // Se falhar, abortamos para nao gastar creditos.
            if (scene.useLite) {
                const ok = await _selectLowerPriorityModel(2);
                if (!ok) {
                    console.warn('[Extend] FALHA ao selecionar Lower Priority — abortando para nao gastar creditos');
                    throw new Error('lower_priority_not_selected');
                }
            }

            // 3) Clicar no botao "Estender" para entrar em modo extensao
            const estenderBtn = await _waitForElement(_findEstenderButton, 6000);
            if (!estenderBtn) throw new Error('estender_btn_not_found');
            await _trustedClickEl(estenderBtn);
            await sleep(700);

            // 4) Re-verificar modelo (alguns dropdowns resetam ao entrar em modo extend)
            if (scene.useLite && !_isLowerPrioritySelected()) {
                console.log('[Extend] modelo resetou apos Estender — re-selecionando');
                const ok2 = await _selectLowerPriorityModel(2);
                if (!ok2) throw new Error('lower_priority_lost_after_estender');
            }

            // 5) Preencher textarea de extensao
            const ta = await _waitForElement(_findTextareaForExtend, 4000);
            if (!ta) throw new Error('textarea_not_found');
            const filled = await fillTextarea(scene.text);
            if (!filled) throw new Error('fill_textarea_failed');
            await sleep(300);

            // 6) Submit + aguarda confirmacao da API (fonte de verdade)
            const ok = await _submitAndAwaitApi(scene.number, 'ext', 12000);
            if (!ok) throw new Error('submit_failed_no_api');
            return { success: true };
        } catch (e) {
            console.error('[Extend] runExtendExt erro:', e.message);
            _extendPending = null;
            chrome.runtime.sendMessage({ action: 'EXTEND_STEP_FAILED', sceneNumber: scene.number, reason: e.message }).catch(() => {});
            return { success: false, error: e.message };
        }
    }

    async function runExtendDownload(scene) {
        console.log('[Extend] runExtendDownload SCENE', scene.number, 'mediaId=' + (scene.mediaId || '?').substring(0, 12));
        try {
            // Tenta achar a URL do video com base no mediaId
            const frag = (scene.mediaId || '').split('/').pop().split(':').pop();
            let videoUrl = null;
            const videos = Array.from(document.querySelectorAll('video'));
            for (const v of videos) {
                const src = v.src || v.querySelector('source')?.src || '';
                if (src && (!frag || src.includes(frag))) { videoUrl = src; break; }
            }
            if (!videoUrl && videos.length) videoUrl = videos[videos.length - 1].src;
            if (!videoUrl) throw new Error('video_url_not_found');

            const filename = 'SCENE_' + String(scene.number).padStart(3, '0') + '_' + scene.totalSeconds + 's.mp4';
            await chrome.runtime.sendMessage({
                action: 'DOWNLOAD_VIDEO',
                url: videoUrl,
                filename,
                folder: scene.folder
            });
            // Volta para a home do projeto para a proxima cena comecar limpa
            await sleep(800);
            await _ensureProjectHome();
            return { success: true };
        } catch (e) {
            console.error('[Extend] download erro:', e.message);
            return { success: false, error: e.message };
        }
    }
})();
