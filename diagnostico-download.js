// ============================================
// DIAGNOSTICO DOWNLOAD — Lets Automate x Google Flow
// ============================================
// Objetivo: mapear o menu de download e a estrutura dos tiles no DOM
// Angular novo, pra portar a automacao de download.
//
// COMO USAR — a ordem importa:
//   1. Abra um projeto em flow.google.com que JA TENHA VIDEOS PRONTOS.
//   2. F12 -> aba "Console".
//   3. Cole este arquivo e Enter. Ele tenta abrir o menu do primeiro video
//      sozinho e despeja o conteudo.
//   4. Espere ~2s. O relatorio ja vai copiado pra area de transferencia.
//
// Se a secao 5 disser que nao conseguiu abrir o menu: abra na mao (passe o
// mouse no video, clique nos 3 pontinhos) e rode o script de novo com o
// menu aberto — a secao 3 pega o que estiver aberto no momento.
// ============================================

(function () {
    "use strict";

    const rel = [];
    const log = (s) => rel.push(s);
    const hr = () => log("-".repeat(64));

    function desc(el, max) {
        if (!el) return "(null)";
        max = max || 60;
        const parts = [el.tagName.toLowerCase()];
        if (el.id) parts.push("#" + el.id);
        const cls = (el.getAttribute("class") || "").trim();
        if (cls) parts.push("." + cls.split(/\s+/).slice(0, 5).join("."));
        for (const a of el.attributes || []) {
            if (a.name.startsWith("data-") || a.name === "role" ||
                a.name === "aria-label" || a.name === "href" ||
                a.name === "aria-haspopup" || a.name === "disabled") {
                let v = a.value || "";
                if (v.length > 60) v = v.slice(0, 60) + "...";
                parts.push(`[${a.name}="${v}"]`);
            }
        }
        let txt = (el.innerText || el.textContent || "").trim().replace(/\s+/g, " ");
        if (txt.length > max) txt = txt.slice(0, max) + "...";
        if (txt) parts.push(`  txt="${txt}"`);
        return parts.join("");
    }

    function count(sel) {
        try { return document.querySelectorAll(sel).length; } catch (e) { return -1; }
    }

    // Despeja todo menu/overlay aberto. Escreve direto no relatorio.
    function dumpMenus(prefixo) {
        const menus = Array.from(document.querySelectorAll(
            "div.mat-mdc-menu-content, [role='menu'], .mat-mdc-menu-panel, .cdk-overlay-pane"));
        log(`${prefixo}: ${menus.length} container(es)`);
        menus.forEach((m, i) => {
            log(`   --- menu ${i} --- ` + desc(m, 40));
            const itens = m.querySelectorAll("[role='menuitem'], button, a");
            if (!itens.length) log("      (vazio)");
            Array.from(itens).forEach((it, j) => {
                const ic = it.querySelector("mat-icon");
                log(`      ${j}. TEXTO="${(it.innerText || "").trim().replace(/\s+/g, " ").slice(0, 60)}"`);
                log(`         icone="${ic ? ic.textContent.trim() : "-"}" ` +
                    `role="${it.getAttribute("role") || "-"}" ` +
                    `haspopup="${it.getAttribute("aria-haspopup") || "-"}"`);
                log(`         class="${(it.getAttribute("class") || "").slice(0, 100)}"`);
            });
        });
        return menus.length;
    }

    function clicar(el) {
        const r = el.getBoundingClientRect();
        const o = {
            bubbles: true, cancelable: true, view: window,
            clientX: r.left + r.width / 2, clientY: r.top + r.height / 2, button: 0, detail: 1
        };
        el.dispatchEvent(new PointerEvent("pointerdown", o));
        el.dispatchEvent(new MouseEvent("mousedown", o));
        el.dispatchEvent(new PointerEvent("pointerup", o));
        el.dispatchEvent(new MouseEvent("mouseup", o));
        el.dispatchEvent(new MouseEvent("click", o));
    }

    function entregar() {
        const full = rel.join("\n") + "\n\nFIM DO RELATORIO";
        console.log(full);
        window.__dottiDl = full;
        try {
            copy(full);
            console.log("\n>>> Relatorio COPIADO. So colar na conversa. <<<");
        } catch (e) {
            console.log("\n>>> Rode:  copy(window.__dottiDl)  <<<");
        }
    }

    // ---------- 1. Ambiente ----------
    hr();
    log("1) AMBIENTE");
    hr();
    log("href    : " + location.href);
    log("projeto?: " + (/\/project\//.test(location.pathname) ? "SIM" : "NAO — abra um projeto"));

    // ---------- 2. Tiles ----------
    hr();
    log("2) TILES DE VIDEO");
    hr();
    const tiles = Array.from(document.querySelectorAll("flow-grid-tile-container"));
    log("flow-grid-tile-container            : " + tiles.length);
    log("div.tile-row.virtual-item-container : " + count("div.tile-row.virtual-item-container"));
    log("<video> na pagina                   : " + count("video"));
    log("<img> dentro de tile                : " + count("flow-grid-tile-container img"));

    if (!tiles.length) {
        log("");
        log("*** NENHUM TILE. Voce esta num projeto com videos ja gerados? ***");
    } else {
        log("");
        log("=== PRIMEIRO TILE ===");
        const t = tiles[0];
        log("tile: " + desc(t, 120));
        log("");
        log("Atributos do tile (o id da midia costuma estar aqui):");
        Array.from(t.attributes).forEach(a =>
            log(`   ${a.name} = "${(a.value || "").slice(0, 90)}"`));
        log("");
        log("Botoes dentro do tile:");
        Array.from(t.querySelectorAll("button")).forEach((b, i) => {
            const ic = b.querySelector("mat-icon");
            log(`   ${i}. icone="${ic ? ic.textContent.trim() : "-"}" ` +
                `aria="${b.getAttribute("aria-label") || "-"}" ` +
                `haspopup="${b.getAttribute("aria-haspopup") || "-"}"`);
            log(`      class="${(b.getAttribute("class") || "").slice(0, 110)}"`);
        });
        log("");
        log("Links dentro do tile:");
        const as = t.querySelectorAll("a[href]");
        if (!as.length) log("   NENHUM");
        Array.from(as).forEach((a, i) => log(`   ${i}. href="${a.getAttribute("href")}"`));
        log("");
        log("img/video dentro do tile (checa se a rota de URL direta ainda existe):");
        const media = t.querySelectorAll("img, video, source");
        if (!media.length) log("   NENHUM");
        Array.from(media).forEach((m, i) =>
            log(`   ${i}. <${m.tagName.toLowerCase()}> src="${(m.src || m.getAttribute("src") || "").slice(0, 140)}"`));
        log("");
        log("HTML do tile (1200 chars):");
        log("   " + (t.outerHTML || "").slice(0, 1200).replace(/\s+/g, " "));
    }

    // ---------- 3. Menu ja aberto ----------
    hr();
    log("3) MENU JA ABERTO (se voce abriu na mao antes de colar)");
    hr();
    const jaAberto = dumpMenus("Abertos agora");

    // ---------- 4. Ancoras ----------
    hr();
    log("4) ANCORAS");
    hr();
    log("Gatilhos de menu (.mat-mdc-menu-trigger): " + count(".mat-mdc-menu-trigger"));
    {
        const ic = new Set();
        document.querySelectorAll("mat-icon").forEach(i => {
            const t = (i.textContent || "").trim();
            if (t) ic.add(t);
        });
        log("Icones presentes: " + Array.from(ic).sort().join(", "));
    }
    log("");
    log("Elementos com texto de download (PT e EN):");
    {
        const achados = Array.from(document.querySelectorAll("button, [role='menuitem'], a"))
            .filter(el => /download|baixar|salvar|save|completo|complete/i.test(
                (el.innerText || "") + " " + (el.getAttribute("aria-label") || "")));
        if (!achados.length) log("   NENHUM (menu fechado)");
        achados.slice(0, 12).forEach((e, i) => log(`   ${i}. ` + desc(e, 70)));
    }

    // ---------- 5. Abrir o menu sozinho ----------
    hr();
    log("5) ABRINDO O MENU AUTOMATICAMENTE");
    hr();

    const moreVert = tiles.length
        ? (Array.from(tiles[0].querySelectorAll("button")).find(b => {
            const ic = b.querySelector("mat-icon");
            return ic && ic.textContent.trim() === "more_vert";
        }) || Array.from(tiles[0].querySelectorAll("button"))
            .find(b => b.getAttribute("aria-haspopup") === "menu"))
        : null;

    if (!moreVert) {
        log("more_vert NAO encontrado no primeiro tile.");
        log("Abra o menu na mao e rode o script de novo — a secao 3 pega.");
        entregar();
        return;
    }

    log("more_vert encontrado: " + desc(moreVert, 40));
    log("Clicando e esperando 1s...");
    clicar(moreVert);

    setTimeout(() => {
        log("");
        const n = dumpMenus("Menus DEPOIS do clique");
        if (!n) {
            log("");
            log("Nenhum menu abriu. O clique sintetico pode nao bastar aqui —");
            log("abra o menu na mao e rode o script de novo.");
        } else {
            // Se ha submenu (ex.: 'Video completo' -> resolucoes), tenta abrir
            log("");
            log("Procurando item que abre SUBMENU (resolucoes)...");
            const subTrigger = Array.from(document.querySelectorAll(
                "div.mat-mdc-menu-content [role='menuitem'], .mat-mdc-menu-panel [role='menuitem']"))
                .find(it => it.getAttribute("aria-haspopup") === "menu" ||
                    /completo|complete|download|baixar/i.test(it.innerText || ""));
            if (!subTrigger) {
                log("   Nenhum item com submenu — o download deve ser direto.");
                entregar();
                return;
            }
            log("   Item: " + desc(subTrigger, 50));
            log("   Clicando pra abrir o submenu...");
            clicar(subTrigger);
            setTimeout(() => {
                log("");
                dumpMenus("SUBMENU (aqui devem estar as resolucoes)");
                entregar();
            }, 1000);
            return;
        }
        entregar();
    }, 1000);
})();
