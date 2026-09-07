// ============================================
// DIAGNOSTICO v2 — Lets Automate x Google Flow
// ============================================
// Objetivo: confirmar se o Flow migrou de React/Next.js para Angular
// e quais seletores realmente batem NESTE navegador, antes de reescrever
// a camada de automacao.
//
// COMO USAR:
//   1. Abra o Flow numa ABA NORMAL do Chrome (nao na janela da extensao,
//      que e popup e nao tem F12 nem barra de endereco).
//   2. Entre num PROJETO (nao fique so na home) — e la que ficam o campo
//      de prompt, o botao de gerar e a grade de resultados.
//   3. F12 -> aba "Console". Cole TODO este arquivo e Enter.
//   4. Espere 5s. O relatorio ja vai copiado pra area de transferencia.
// ============================================

(function () {
    "use strict";

    const out = [];
    const log = (s) => out.push(s);
    const hr = () => log("-".repeat(64));

    function desc(el) {
        if (!el) return "(null)";
        const parts = [el.tagName.toLowerCase()];
        if (el.id) parts.push("#" + el.id);
        const cls = (el.getAttribute("class") || "").trim();
        if (cls) parts.push("." + cls.split(/\s+/).slice(0, 4).join("."));
        for (const a of el.attributes || []) {
            if (a.name.startsWith("data-") || a.name === "role" ||
                a.name === "aria-label" || a.name === "contenteditable" ||
                a.name.startsWith("ng-") || a.name.startsWith("_ng")) {
                let v = a.value || "";
                if (v.length > 50) v = v.slice(0, 50) + "...";
                parts.push(`[${a.name}="${v}"]`);
            }
        }
        let txt = (el.innerText || el.textContent || "").trim().replace(/\s+/g, " ");
        if (txt.length > 60) txt = txt.slice(0, 60) + "...";
        if (txt) parts.push(`  txt="${txt}"`);
        return parts.join("");
    }

    // Conta quantos casam, sem explodir em seletor invalido
    function count(sel) {
        try { return document.querySelectorAll(sel).length; }
        catch (e) { return -1; }
    }

    function check(rotulo, sel) {
        const n = count(sel);
        const marca = n < 0 ? "SELETOR INVALIDO" : (n > 0 ? "OK   " : "ZERO ");
        log(`  [${marca}] ${String(n < 0 ? "-" : n).padStart(3)}  ${rotulo}`);
        log(`             ${sel}`);
        return n;
    }

    // ---------- 1. URL / ambiente ----------
    hr();
    log("1) URL E AMBIENTE");
    hr();
    log("href     : " + location.href);
    log("origin   : " + location.origin);
    log("pathname : " + location.pathname);
    log("title    : " + document.title);
    log("");
    log("Casa com o manifest (https://labs.google/*)? " +
        (location.origin === "https://labs.google" ? "SIM" : "*** NAO ***"));
    log("Estamos DENTRO de um projeto? " +
        (/\/project\/|\/edit\//.test(location.pathname) ? "SIM" : "provavelmente NAO (va pra dentro de um projeto)"));

    // ---------- 2. QUAL FRAMEWORK? (a pergunta decisiva) ----------
    hr();
    log("2) FRAMEWORK — ANGULAR OU REACT?");
    hr();
    const ngEl = document.querySelector("[ng-version]");
    const ngVersion = ngEl ? ngEl.getAttribute("ng-version") : null;
    const temNext = !!document.getElementById("__next");
    const nMat = count("mat-icon, mat-button-toggle, [class*='mat-mdc']");
    const nCdk = count("cdk-virtual-scroll-viewport, [class*='cdk-']");
    const nFlowEl = count("flow-menu-item, flow-grid-tile-container, [class^='flow-']");
    const temProseMirror = count(".ProseMirror") > 0;
    const temSlate = count("[data-slate-editor]") > 0;

    log("[ng-version] presente?      " + (ngVersion ? "SIM -> Angular " + ngVersion : "nao"));
    log("#__next presente?           " + (temNext ? "SIM -> Next.js/React" : "nao"));
    log("elementos mat-* (Angular):  " + nMat);
    log("elementos cdk-* (Angular):  " + nCdk);
    log("custom elements flow-*:     " + nFlowEl);
    log("editor ProseMirror?         " + (temProseMirror ? "SIM" : "nao"));
    log("editor Slate.js?            " + (temSlate ? "SIM" : "nao"));
    // React deixa chaves __reactFiber$ nos nos do DOM
    let temReactFiber = false;
    try {
        const amostra = document.querySelectorAll("div");
        for (let i = 0; i < Math.min(amostra.length, 300); i++) {
            if (Object.keys(amostra[i]).some(k => k.startsWith("__reactFiber$") || k.startsWith("__reactProps$"))) {
                temReactFiber = true; break;
            }
        }
    } catch (e) { }
    log("chaves __reactFiber no DOM? " + (temReactFiber ? "SIM -> React ativo" : "nao"));
    log("");
    const angular = !!ngVersion || (nMat + nCdk + nFlowEl) > 3;
    log(">>> VEREDITO: " + (angular
        ? "ANGULAR — nossa extensao esta com os seletores errados"
        : (temNext || temReactFiber ? "REACT/NEXT.JS — o DOM velho ainda vale" : "INDETERMINADO — me manda o relatorio mesmo assim")));

    // ---------- 3. Seletores NOVOS (Angular) ----------
    hr();
    log("3) SELETORES NOVOS (Angular) — subconjunto CSS-valido");
    hr();
    log("  Formato: [status] qtd  nome");
    log("");
    check("promptTextarea (o mais critico)", 'div.ProseMirror[contenteditable="true"]');
    check("submitButton", "button.generate-icon-button");
    check("createProjectButton", "button.new-project-button");
    check("modelSelectButton", 'button[aria-label="Select model family"]');
    check("configButton", "button.settings-trigger-button");
    check("addImageButton / addFrameButton", "button.add-menu-trigger");
    check("virtuosoItemList (grade)", "cdk-virtual-scroll-viewport");
    check("outputItems (tiles)", "flow-grid-tile-container");
    check("modelTemplate (itens de menu)", 'flow-menu-item button[role="menuitem"]');
    check("modos / proporcao / duracao", "mat-button-toggle");
    check("menus abertos", "div.mat-mdc-menu-content");
    check("fileInput", 'input[type="file"]');
    check("tiles por id (fallback)", "div[data-tile-id]");

    // ---------- 4. Seletores VELHOS (os que nosso codigo usa hoje) ----------
    hr();
    log("4) SELETORES VELHOS — o que content.js usa HOJE");
    hr();
    log("  Se estes derem ZERO, a automacao esta morta.");
    log("");
    check("prompt (Slate) — content.js:348 etc", '[role="textbox"]');
    check("textarea legado", "#PINHOLE_TEXT_AREA_ELEMENT_ID");
    check("raiz Next.js — content.css depende", "#__next");
    check("grade react-virtuoso", "[data-item-index]");
    check("toasts (Sonner)", "[data-sonner-toast]");
    check("popovers (Radix UI)", "[data-radix-popper-content-wrapper]");

    // ---------- 5. A extensao injetou? ----------
    hr();
    log("5) NOSSA EXTENSAO INJETOU?");
    hr();
    const btn = document.getElementById("dotti-sender-toggle-btn");
    const panel = document.getElementById("dotti-sender-full-panel");
    for (const [nome, el] of [["Botao-raio", btn], ["Sidebar", panel]]) {
        if (!el) { log(`${nome}: AUSENTE do DOM`); continue; }
        const cs = getComputedStyle(el);
        const r = el.getBoundingClientRect();
        const visivel = r.width > 0 && r.height > 0 && cs.display !== "none" &&
            cs.visibility !== "hidden" && parseFloat(cs.opacity) > 0.01;
        log(`${nome}: PRESENTE — ${visivel ? "VISIVEL" : "*** INVISIVEL ***"}` +
            ` (display=${cs.display} opacity=${cs.opacity} w=${Math.round(r.width)} h=${Math.round(r.height)})`);
    }
    log("classe dotti-sidebar-open no <html>? " +
        (document.documentElement.classList.contains("dotti-sidebar-open") ? "SIM" : "NAO"));

    // ---------- 6. Amostra do DOM real (pra eu escrever seletor novo) ----------
    hr();
    log("6) AMOSTRA DO DOM REAL");
    hr();
    log("Filhos diretos do <body>:");
    Array.from(document.body.children).slice(0, 10).forEach((c, i) => log(`   ${i}. ` + desc(c)));
    log("");
    log("Campo(s) contenteditable (onde se digita o prompt):");
    {
        const eds = document.querySelectorAll('[contenteditable="true"]');
        if (!eds.length) log("   NENHUM — voce esta dentro de um projeto?");
        Array.from(eds).slice(0, 4).forEach((e, i) => log(`   ${i}. ` + desc(e)));
    }
    log("");
    log("Botoes com aria-label (ate 15):");
    {
        const bs = document.querySelectorAll("button[aria-label]");
        Array.from(bs).slice(0, 15).forEach((b, i) =>
            log(`   ${i}. aria-label="${b.getAttribute("aria-label")}"  class="${(b.getAttribute("class") || "").slice(0, 50)}"`));
        if (!bs.length) log("   NENHUM");
    }
    log("");
    log("VIDEOS na pagina:");
    {
        const vids = document.querySelectorAll("video");
        log(`   ${vids.length} <video>`);
        Array.from(vids).slice(0, 3).forEach((v, i) => {
            const src = v.src || (v.querySelector("source") || {}).src || "(sem src)";
            log(`   ${i}. ${src.slice(0, 120)}`);
            log(`      getMediaUrlRedirect? ` + (src.includes("getMediaUrlRedirect") ? "SIM" : "NAO"));
        });
    }

    // ---------- 7. Checagem tardia ----------
    document.body.__dottiMark = true;
    const btnAntes = !!btn;

    log("");
    hr();
    log("Aguardando 5s...");
    hr();
    console.log(out.join("\n"));

    setTimeout(() => {
        const o2 = [];
        o2.push("");
        o2.push("=".repeat(64));
        o2.push("7) DEPOIS DE 5 SEGUNDOS");
        o2.push("=".repeat(64));
        o2.push("<body> foi substituido? " +
            (document.body.__dottiMark ? "NAO (mesmo no)" : "*** SIM — o SPA trocou o body ***"));
        const btn2 = document.getElementById("dotti-sender-toggle-btn");
        o2.push(`Botao-raio: antes=${btnAntes ? "presente" : "ausente"} agora=${btn2 ? "presente" : "ausente"}` +
            (btnAntes && !btn2 ? "  *** REMOVIDO PELO SPA ***" : ""));
        o2.push("");
        o2.push("FIM DO RELATORIO");

        const full = out.join("\n") + "\n" + o2.join("\n");
        console.log(o2.join("\n"));
        window.__dottiDiag = full;
        try {
            copy(full);
            console.log("\n>>> Relatorio COPIADO. So colar na conversa. <<<");
        } catch (e) {
            console.log("\n>>> Rode:  copy(window.__dottiDiag)  <<<");
        }
    }, 5000);
})();
