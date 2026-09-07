// ============================================
// DIAGNOSTICO — Lets Automate x Google Flow
// ============================================
// COMO USAR:
//   1. Abra o Flow numa ABA NORMAL do Chrome (nao na janela da extensao,
//      que e popup e nao tem F12 nem barra de endereco).
//   2. Aperte F12 -> aba "Console".
//   3. Cole TODO este arquivo e aperte Enter.
//   4. Espere 5 segundos. O relatorio e impresso e ja vai copiado
//      pra area de transferencia. Cole na conversa.
// ============================================

(function () {
    "use strict";

    const out = [];
    const log = (s) => out.push(s);
    const hr = () => log("-".repeat(60));

    // Descreve um elemento de forma compacta mas util p/ escrever seletor novo
    function desc(el) {
        if (!el) return "(null)";
        const parts = [el.tagName.toLowerCase()];
        if (el.id) parts.push("#" + el.id);
        const cls = (el.getAttribute("class") || "").trim();
        if (cls) parts.push("." + cls.split(/\s+/).slice(0, 4).join("."));
        for (const a of el.attributes || []) {
            if (a.name.startsWith("data-") || a.name === "role" ||
                a.name === "aria-label" || a.name === "aria-placeholder" ||
                a.name === "data-placeholder" || a.name === "type" ||
                a.name === "contenteditable") {
                let v = a.value || "";
                if (v.length > 60) v = v.slice(0, 60) + "...";
                parts.push(`[${a.name}="${v}"]`);
            }
        }
        let txt = (el.innerText || el.textContent || "").trim().replace(/\s+/g, " ");
        if (txt.length > 70) txt = txt.slice(0, 70) + "...";
        if (txt) parts.push(`  txt="${txt}"`);
        return parts.join("");
    }

    function dump(label, selector, limit = 8) {
        let nodes = [];
        try { nodes = Array.from(document.querySelectorAll(selector)); }
        catch (e) { log(`${label} [${selector}] -> SELETOR INVALIDO: ${e.message}`); return; }
        log(`${label} [${selector}] -> ${nodes.length} encontrado(s)`);
        nodes.slice(0, limit).forEach((n, i) => log(`   ${i}. ` + desc(n)));
        if (nodes.length > limit) log(`   ... +${nodes.length - limit} outros`);
    }

    // Visibilidade real — separa "nao injetou" de "injetou invisivel"
    function visInfo(el, name) {
        if (!el) { log(`${name}: AUSENTE do DOM`); return; }
        const cs = getComputedStyle(el);
        const r = el.getBoundingClientRect();
        log(`${name}: PRESENTE`);
        log(`   ` + desc(el));
        log(`   display=${cs.display} visibility=${cs.visibility} opacity=${cs.opacity}`);
        log(`   position=${cs.position} zIndex=${cs.zIndex}`);
        log(`   rect: x=${Math.round(r.x)} y=${Math.round(r.y)} w=${Math.round(r.width)} h=${Math.round(r.height)}`);
        const visivel = r.width > 0 && r.height > 0 && cs.display !== "none" &&
            cs.visibility !== "hidden" && parseFloat(cs.opacity) > 0.01;
        log(`   => ${visivel ? "VISIVEL na tela" : "*** INVISIVEL ***"}`);
    }

    // ---------- 1. URL / ambiente ----------
    hr();
    log("1) URL E AMBIENTE");
    hr();
    log("href     : " + location.href);
    log("origin   : " + location.origin);
    log("pathname : " + location.pathname);
    log("title    : " + document.title);
    log("userAgent: " + navigator.userAgent);
    log("");
    log("Casa com o manifest atual (https://labs.google/*)? " +
        (location.origin === "https://labs.google" ? "SIM" : "*** NAO — ESSA E A CAUSA ***"));
    log("Passa no gate do painel (panel.js)? " +
        ((location.href.includes("labs.google/flow") || location.href.includes("labs.google/fx"))
            ? "SIM" : "*** NAO — painel ficaria desabilitado ***"));

    // ---------- 2. A extensao injetou? ----------
    hr();
    log("2) A EXTENSAO INJETOU?");
    hr();
    const btn = document.getElementById("dotti-sender-toggle-btn");
    const panel = document.getElementById("dotti-sender-full-panel");
    visInfo(btn, "Botao-raio (#dotti-sender-toggle-btn)");
    log("");
    visInfo(panel, "Sidebar (#dotti-sender-full-panel)");
    log("");
    log("classe dotti-sidebar-open no <html>? " +
        (document.documentElement.classList.contains("dotti-sidebar-open") ? "SIM" : "NAO"));
    log("script interceptor injetado? " +
        (document.querySelector("script[data-dotti-interceptor]") ? "SIM" : "NAO"));
    log("script slate-helper injetado? " +
        (document.querySelector("script[data-dotti-slate-helper]") ? "SIM" : "NAO"));
    if (panel) {
        const ifr = panel.querySelector("iframe");
        log("iframe do painel: " + (ifr ? ifr.src : "(nenhum — possivel bloqueio de CSP)"));
    }

    // ---------- 3. Raiz do app (acoplamento do content.css) ----------
    hr();
    log("3) RAIZ DO APP (content.css depende disso)");
    hr();
    log("#__next existe? " + (document.getElementById("__next") ? "SIM" : "*** NAO ***"));
    log("[data-nextjs-scroll-focus-boundary] existe? " +
        (document.querySelector("[data-nextjs-scroll-focus-boundary]") ? "SIM" : "NAO"));
    log("Filhos diretos do <body>:");
    Array.from(document.body.children).slice(0, 12).forEach((c, i) => {
        log(`   ${i}. ` + desc(c));
    });

    // ---------- 4. Seletores da automacao ----------
    hr();
    log("4) SELETORES QUE A AUTOMACAO USA");
    hr();
    dump("PROMPT (o mais critico)", '[role="textbox"]');
    log("");
    dump("Textarea legado", "#PINHOLE_TEXT_AREA_ELEMENT_ID");
    dump("Textareas", "textarea");
    log("");
    dump("Comboboxes / modelo", 'button[role="combobox"], [role="combobox"]');
    log("");
    log("MODELO — botoes cujo texto casa /Veo\\s*3\\.\\d/ :");
    {
        const encontrados = Array.from(document.querySelectorAll('button, [role="button"], [role="combobox"]'))
            .filter(b => {
                const t = (b.innerText || "").trim();
                return t.length < 80 && /Veo\s*\d+(\.\d+)?/i.test(t);
            });
        if (!encontrados.length) log("   NENHUM — o pin /Veo 3.1/ do content.js nao acha nada");
        encontrados.slice(0, 6).forEach((b, i) => log(`   ${i}. ` + desc(b)));
    }
    log("");
    log("BOTOES com icone material (gerar / enviar / voltar):");
    {
        const icones = Array.from(document.querySelectorAll("i, span.material-icons, span.material-symbols-outlined"))
            .filter(i => ["arrow_forward", "send", "arrow_upward", "arrow_back", "add", "settings", "tune"]
                .includes((i.textContent || "").trim()));
        if (!icones.length) log("   NENHUM icone material conhecido encontrado");
        icones.slice(0, 12).forEach((i, n) =>
            log(`   ${n}. icone="${(i.textContent || "").trim()}" -> botao: ` + desc(i.closest("button, [role=button], a") || i)));
    }
    log("");
    dump("Grid de resultados", "[data-item-index]", 4);
    dump("Tiles", "[data-tile-id]", 4);
    dump("Dialogs abertos", '[role="dialog"]', 3);
    log("");
    log("VIDEOS na pagina:");
    {
        const vids = Array.from(document.querySelectorAll("video"));
        log(`   ${vids.length} <video> encontrado(s)`);
        vids.slice(0, 5).forEach((v, i) => {
            const src = v.src || (v.querySelector("source") || {}).src || "(sem src)";
            log(`   ${i}. src=${src.slice(0, 130)}`);
            log(`      tem getMediaUrlRedirect? ` + (src.includes("getMediaUrlRedirect") ? "SIM" : "NAO"));
        });
    }
    log("");
    log("BOTOES de projeto (texto 'novo projeto'/'new project'):");
    {
        const b = Array.from(document.querySelectorAll("button, a, [role=button]"))
            .filter(x => /novo projeto|new project|criar projeto|create project|new flow|novo flow/i
                .test((x.innerText || "")));
        if (!b.length) log("   NENHUM");
        b.slice(0, 5).forEach((x, i) => log(`   ${i}. ` + desc(x)));
    }

    // ---------- 5. Body trocado? (checagem tardia) ----------
    const bodyMarcado = document.body;
    bodyMarcado.__dottiDiagMark = true;
    const btnAntes = !!btn, panelAntes = !!panel;

    log("");
    hr();
    log("Aguardando 5s para checar se o SPA troca o DOM...");
    hr();
    console.log(out.join("\n"));

    setTimeout(() => {
        const out2 = [];
        const log2 = (s) => out2.push(s);
        log2("");
        log2("=".repeat(60));
        log2("5) DEPOIS DE 5 SEGUNDOS");
        log2("=".repeat(60));
        log2("<body> foi substituido? " +
            (document.body.__dottiDiagMark ? "NAO (mesmo nó)" : "*** SIM — o SPA trocou o body ***"));
        const btn2 = document.getElementById("dotti-sender-toggle-btn");
        const panel2 = document.getElementById("dotti-sender-full-panel");
        log2(`Botao-raio: antes=${btnAntes ? "presente" : "ausente"} agora=${btn2 ? "presente" : "ausente"}` +
            (btnAntes && !btn2 ? "  *** FOI REMOVIDO PELO SPA ***" : ""));
        log2(`Sidebar   : antes=${panelAntes ? "presente" : "ausente"} agora=${panel2 ? "presente" : "ausente"}` +
            (panelAntes && !panel2 ? "  *** FOI REMOVIDA PELO SPA ***" : ""));
        log2("");
        log2("FIM DO RELATORIO");

        const full = out.join("\n") + "\n" + out2.join("\n");
        console.log(out2.join("\n"));
        window.__dottiDiag = full;
        try {
            copy(full);
            console.log("\n>>> Relatorio COPIADO pra area de transferencia. So colar na conversa. <<<");
        } catch (e) {
            console.log("\n>>> Nao consegui copiar sozinho. Rode:  copy(window.__dottiDiag)  <<<");
        }
    }, 5000);
})();
