/**
 * Dotti Slate Helper v3.0.0 - Runs in MAIN WORLD
 * Handles Slate.js text insertion, submit button click, mode switching, and gallery operations
 * Communicates with content.js (ISOLATED world) via CustomEvents
 *
 * Injected via chrome.runtime.getURL() to bypass CSP
 */
(function() {
  if (window._dottiSlateHelperActive) return;
  window._dottiSlateHelperActive = true;

  // v3.3.0: PointerEvent click helper — required for Radix UI components
  // Simple .click() does NOT work on crop_16_9, mode tabs, etc.
  function _pointerClick(el) {
    var rect = el.getBoundingClientRect();
    var cx = rect.left + rect.width / 2;
    var cy = rect.top + rect.height / 2;
    var opts = { bubbles: true, cancelable: true, view: window, clientX: cx, clientY: cy, button: 0, detail: 1 };
    el.dispatchEvent(new PointerEvent('pointerdown', opts));
    el.dispatchEvent(new MouseEvent('mousedown', opts));
    el.dispatchEvent(new PointerEvent('pointerup', opts));
    el.dispatchEvent(new MouseEvent('mouseup', opts));
    el.dispatchEvent(new MouseEvent('click', opts));
  }

  // ====== SLATE FILL ======
  document.addEventListener('dotti-fill-slate', function(e) {
    var text = (e.detail && e.detail.text) || '';
    var requestId = (e.detail && e.detail.requestId) || '';

    if (!text) {
      _dispatch('dotti-fill-slate-result', { requestId: requestId, result: 'NO_TEXT' });
      return;
    }

    var ta = (document.querySelector('div.ProseMirror[contenteditable="true"]') || document.querySelector("[role='textbox']"));
    if (!ta) {
      _dispatch('dotti-fill-slate-result', { requestId: requestId, result: 'NO_TEXTBOX' });
      return;
    }

    // Find Slate editor via React Fiber
    var fk = Object.keys(ta).find(function(k) { return k.startsWith('__reactFiber$'); });
    if (!fk) {
      _dispatch('dotti-fill-slate-result', { requestId: requestId, result: 'NO_FIBER' });
      return;
    }

    var fiber = ta[fk], editor = null;
    for (var i = 0; i < 50 && fiber; i++) {
      if (fiber.memoizedProps) {
        if (fiber.memoizedProps.editor && fiber.memoizedProps.editor.insertText) {
          editor = fiber.memoizedProps.editor;
          break;
        }
        if (fiber.memoizedProps.value && fiber.memoizedProps.value.insertText) {
          editor = fiber.memoizedProps.value;
          break;
        }
      }
      fiber = fiber.return;
    }

    if (!editor) {
      _dispatch('dotti-fill-slate-result', { requestId: requestId, result: 'NO_EDITOR' });
      return;
    }

    // Use Slate API to clear and insert text
    try {
      editor.withoutNormalizing(function() {
        try {
          editor.select({ anchor: editor.start([]), focus: editor.end([]) });
          editor.deleteFragment();
        } catch(ex) {
          // Editor may be empty, ignore select/delete errors
        }
        editor.insertText(text);
      });
    } catch(e) {
      _dispatch('dotti-fill-slate-result', { requestId: requestId, result: 'SLATE_ERROR:' + e.message });
      return;
    }

    // Verify insertion
    var inserted = '';
    try { inserted = editor.children[0].children[0].text || ''; } catch(e) {}
    var success = inserted.length > 0;

    _dispatch('dotti-fill-slate-result', {
      requestId: requestId,
      result: success ? 'OK' : 'EMPTY_AFTER_INSERT'
    });
  });

  // ====== SUBMIT CLICK (MAIN WORLD) ======
  document.addEventListener('dotti-click-submit', function(e) {
    var requestId = (e.detail && e.detail.requestId) || '';

    // Find submit button — preferir aria-label, depois icone MAIS PROXIMO do textbox
    var SUBMIT_ICONS = ['arrow_forward', 'send', 'arrow_upward'];
    var ARIA_LABELS = ['Create', 'Criar', 'Send', 'Enviar', 'Generate', 'Gerar', 'Submit'];
    var tb = (document.querySelector('div.ProseMirror[contenteditable="true"]') || document.querySelector("[role='textbox']"));
    var tbRect = tb ? tb.getBoundingClientRect() : null;
    // v3.6.0: Inclui [role="button"] (Flow pode ter trocado <button> por div role=button)
    var allBtns = Array.from(document.querySelectorAll('button, [role="button"]')).filter(function(b) { return b.offsetParent !== null; });
    var btn = null;
    var pickReason = null;

    // Diagnostico: lista candidatos com icone de submit
    var submitCandidates = [];
    for (var di = 0; di < allBtns.length; di++) {
      var dic = allBtns[di].querySelector('mat-icon, i, span.material-icons, span.material-symbols-outlined');
      var dt = dic ? (dic.textContent || '').trim() : '';
      var dal = allBtns[di].getAttribute('aria-label') || '';
      if (SUBMIT_ICONS.indexOf(dt) >= 0 || dal) {
        var dr = allBtns[di].getBoundingClientRect();
        var dxRel = tbRect ? Math.round(dr.left - tbRect.right) : null;
        var dyRel = tbRect ? Math.round(dr.top - tbRect.bottom) : null;
        if (SUBMIT_ICONS.indexOf(dt) >= 0) {
          submitCandidates.push({ icon: dt, aria: dal, dx: dxRel, dy: dyRel, disabled: !!allBtns[di].disabled });
        }
      }
    }
    console.log('[DottiSlateHelper] Submit candidates:', JSON.stringify(submitCandidates));

    // Estrategia 0 (v3.3.0): classe do Flow Angular. Nao muda com o idioma,
    // ao contrario de aria-label, que vem traduzido ("Iniciar geracao").
    var byClass = document.querySelector('button.generate-icon-button');
    if (byClass && byClass.offsetParent !== null) { btn = byClass; pickReason = 'class=generate-icon-button'; }

    // Estrategia 1: aria-label
    for (var ai = 0; ai < ARIA_LABELS.length && !btn; ai++) {
      for (var aj = 0; aj < allBtns.length; aj++) {
        var al = (allBtns[aj].getAttribute('aria-label') || '').toLowerCase();
        if (al && (al === ARIA_LABELS[ai].toLowerCase() || al.indexOf(ARIA_LABELS[ai].toLowerCase()) >= 0)) {
          btn = allBtns[aj];
          pickReason = 'aria-label=' + al;
          break;
        }
      }
    }

    // Estrategia 2: icone arrow_forward/send/arrow_upward mais proximo do textbox
    if (!btn && tbRect) {
      var nearest = null;
      var nearestDist = Infinity;
      for (var ni = 0; ni < allBtns.length; ni++) {
        var nic = allBtns[ni].querySelector('mat-icon, i, span.material-icons, span.material-symbols-outlined');
        var nt = nic ? (nic.textContent || '').trim() : '';
        if (SUBMIT_ICONS.indexOf(nt) < 0) continue;
        var nr = allBtns[ni].getBoundingClientRect();
        var ndx = nr.left - tbRect.right;
        var ndy = nr.top - tbRect.bottom;
        if (ndx < -100 || ndx > 250 || ndy < -100 || ndy > 250) continue;
        var nd = Math.abs(ndx) + Math.abs(ndy);
        if (nd < nearestDist) { nearest = allBtns[ni]; nearestDist = nd; }
      }
      if (nearest) { btn = nearest; pickReason = 'nearest-to-textbox'; }
    }

    // Estrategia 3: primeiro icone submit visivel (ultimo recurso)
    if (!btn) {
      for (var fi = 0; fi < allBtns.length; fi++) {
        var fic = allBtns[fi].querySelector('mat-icon, i, span.material-icons, span.material-symbols-outlined');
        var ft = fic ? (fic.textContent || '').trim() : '';
        if (SUBMIT_ICONS.indexOf(ft) >= 0) { btn = allBtns[fi]; pickReason = 'fallback-first-icon'; break; }
      }
    }

    if (!btn) {
      console.log('[DottiSlateHelper] Submit: NO_BUTTON encontrado');
      _dispatch('dotti-click-submit-result', { requestId: requestId, result: 'NO_BUTTON' });
      return;
    }

    var pickedIcon = (btn.querySelector('mat-icon, i, span.material-icons, span.material-symbols-outlined')?.textContent || '').trim();
    var pickedAria = btn.getAttribute('aria-label') || '';
    var pickedRect = btn.getBoundingClientRect();
    var pickedDx = tbRect ? Math.round(pickedRect.left - tbRect.right) : null;
    var pickedDy = tbRect ? Math.round(pickedRect.top - tbRect.bottom) : null;
    console.log('[DottiSlateHelper] Submit pick:', pickReason, 'icon=' + pickedIcon, 'aria=' + pickedAria, 'dx=' + pickedDx, 'dy=' + pickedDy, 'disabled=' + !!btn.disabled);

    if (btn.disabled) {
      _dispatch('dotti-click-submit-result', { requestId: requestId, result: 'DISABLED' });
      return;
    }

    // Strategy 1: React onClick directly from MAIN world (most reliable)
    var clicked = false;
    var hadReactProps = false;
    var reactPropsKey = Object.keys(btn).find(function(k) { return k.startsWith('__reactProps$'); });
    if (reactPropsKey && btn[reactPropsKey] && typeof btn[reactPropsKey].onClick === 'function') {
      hadReactProps = true;
      try {
        btn[reactPropsKey].onClick({
          preventDefault: function(){},
          stopPropagation: function(){},
          nativeEvent: new MouseEvent('click', { bubbles: true }),
          type: 'click',
          target: btn,
          currentTarget: btn
        });
        clicked = true;
      } catch(err) {
        console.log('[DottiSlateHelper] React onClick threw:', err && err.message);
      }
    }

    // Strategy 2: Full 7-event mouse sequence from MAIN world
    if (!clicked) {
      var events = ['pointerover', 'mouseover', 'pointerdown', 'mousedown', 'pointerup', 'mouseup', 'click'];
      for (var j = 0; j < events.length; j++) {
        btn.dispatchEvent(new MouseEvent(events[j], {
          bubbles: true, cancelable: true, composed: true, view: window, detail: 1
        }));
      }
      clicked = true;
    }

    console.log('[DottiSlateHelper] Submit click done. hadReactProps=' + hadReactProps + ' via=' + (hadReactProps ? 'react' : '7-event'));
    _dispatch('dotti-click-submit-result', { requestId: requestId, result: clicked ? 'OK' : 'CLICK_FAILED' });
  });

  // ====== CHECK SLATE STATE ======
  document.addEventListener('dotti-check-slate', function(e) {
    var requestId = (e.detail && e.detail.requestId) || '';
    var ta = (document.querySelector('div.ProseMirror[contenteditable="true"]') || document.querySelector("[role='textbox']"));
    if (!ta) {
      _dispatch('dotti-check-slate-result', { requestId: requestId, isEmpty: true, hasEditor: false });
      return;
    }

    var fk = Object.keys(ta).find(function(k) { return k.startsWith('__reactFiber$'); });
    if (!fk) {
      _dispatch('dotti-check-slate-result', { requestId: requestId, isEmpty: true, hasEditor: false });
      return;
    }

    var fiber = ta[fk], editor = null;
    for (var i = 0; i < 50 && fiber; i++) {
      if (fiber.memoizedProps) {
        if (fiber.memoizedProps.editor && fiber.memoizedProps.editor.insertText) {
          editor = fiber.memoizedProps.editor;
          break;
        }
        if (fiber.memoizedProps.value && fiber.memoizedProps.value.insertText) {
          editor = fiber.memoizedProps.value;
          break;
        }
      }
      fiber = fiber.return;
    }

    if (!editor) {
      _dispatch('dotti-check-slate-result', { requestId: requestId, isEmpty: true, hasEditor: false });
      return;
    }

    var text = '';
    try { text = editor.children[0].children[0].text || ''; } catch(e) {}

    _dispatch('dotti-check-slate-result', {
      requestId: requestId,
      isEmpty: !text.trim(),
      hasEditor: true,
      textLength: text.length
    });
  });

  // ====== GALLERY: OPEN (MAIN WORLD) ======
  // v3.2.0: Clicar no botao add_2/add para abrir galeria de elementos
  document.addEventListener('dotti-open-gallery', function(e) {
    var requestId = (e.detail && e.detail.requestId) || '';

    var allBtns = Array.from(document.querySelectorAll('button')).filter(function(b) { return b.offsetParent !== null; });
    var tb = (document.querySelector('div.ProseMirror[contenteditable="true"]') || document.querySelector("[role='textbox']"));
    var tbRect = tb ? tb.getBoundingClientRect() : null;
    var tbY = tbRect ? tbRect.top : 0;

    // DEBUG: Listar todos os botoes visiveis com icones perto do textbox
    var btnDebug = [];
    for (var d = 0; d < allBtns.length; d++) {
      var dbIcon = allBtns[d].querySelector('mat-icon, i, span.material-icons, span.material-symbols-outlined');
      if (!dbIcon) continue;
      var dbText = dbIcon.textContent.trim();
      var dbRect = allBtns[d].getBoundingClientRect();
      var distY = Math.abs(dbRect.top - tbY);
      if (distY < 400) {
        btnDebug.push(dbText + '(y:' + Math.round(distY) + ',x:' + Math.round(dbRect.left) + ')');
      }
    }
    console.log('[DottiSlateHelper] Botoes perto do textbox:', btnDebug.join(', '));

    var addBtn = null;

    // Prioridade 1: icone "add_2" (botao especifico da galeria na v2.0.3)
    for (var i = 0; i < allBtns.length; i++) {
      var icon = allBtns[i].querySelector('mat-icon, i, span.material-icons, span.material-symbols-outlined');
      if (icon && icon.textContent.trim() === 'add_2') {
        addBtn = allBtns[i];
        console.log('[DottiSlateHelper] Encontrado add_2');
        break;
      }
    }

    // Prioridade 2: botoes de galeria com icones comuns perto do textbox
    if (!addBtn) {
      var galleryIcons = ['add_2', 'add_photo_alternate', 'add_circle', 'person_add', 'library_add',
                          'collections', 'photo_library', 'image', 'add_a_photo', 'add'];
      for (var gi = 0; gi < galleryIcons.length; gi++) {
        if (addBtn) break;
        for (var j = 0; j < allBtns.length; j++) {
          var ic = allBtns[j].querySelector('mat-icon, i, span.material-icons, span.material-symbols-outlined');
          if (!ic) continue;
          var t = ic.textContent.trim();
          if (t !== galleryIcons[gi]) continue;
          if (Math.abs(allBtns[j].getBoundingClientRect().top - tbY) < 200) {
            addBtn = allBtns[j];
            console.log('[DottiSlateHelper] Encontrado', t, 'perto do textbox');
            break;
          }
        }
      }
    }

    // Prioridade 3: Qualquer botao com aria-label contendo "add", "element", "ingredient", "character"
    if (!addBtn) {
      for (var a = 0; a < allBtns.length; a++) {
        var label = (allBtns[a].getAttribute('aria-label') || '').toLowerCase();
        if (label && (label.indexOf('add') >= 0 || label.indexOf('element') >= 0 ||
            label.indexOf('ingredient') >= 0 || label.indexOf('character') >= 0 ||
            label.indexOf('person') >= 0 || label.indexOf('reference') >= 0)) {
          if (Math.abs(allBtns[a].getBoundingClientRect().top - tbY) < 300) {
            addBtn = allBtns[a];
            console.log('[DottiSlateHelper] Encontrado via aria-label:', label);
            break;
          }
        }
      }
    }

    if (!addBtn) {
      _dispatch('dotti-open-gallery-result', { requestId: requestId, result: 'NO_BUTTON', buttons: btnDebug });
      return;
    }

    var iconText = '';
    var btnIcon = addBtn.querySelector('mat-icon, i, span.material-icons, span.material-symbols-outlined');
    if (btnIcon) iconText = btnIcon.textContent.trim();
    console.log('[DottiSlateHelper] Clicando botao galeria:', iconText);

    // v3.3.0: Usar _pointerClick para compatibilidade com Radix UI
    _pointerClick(addBtn);
    _dispatch('dotti-open-gallery-result', { requestId: requestId, result: 'OK', method: 'pointerClick', icon: iconText });
  });

  // ====== GALLERY: SORT BY OLDEST (MAIN WORLD) ======
  // v3.3.0: Ordenar galeria por "Mais antigo" / "Oldest" — Radix UI dropdown
  // IMPORTANTE: A galeria tem 2 dropdowns arrow_drop_down:
  //   BTN[0] = filtro de DATA (ex: "Mar 03 - 01:19") — NAO E ESTE
  //   BTN[2] = ORDENACAO (ex: "Recently Used") — ESTE E O CORRETO
  document.addEventListener('dotti-sort-gallery', function(e) {
    var requestId = (e.detail && e.detail.requestId) || '';

    var dialog = document.querySelector('[role="dialog"]');
    if (!dialog) {
      _dispatch('dotti-sort-gallery-result', { requestId: requestId, result: 'NO_DIALOG' });
      return;
    }

    // Achar botao de ORDENACAO (nao o de data!)
    // O de ordenacao contem texto como "Recently Used", "Oldest", "Newest", "Mais recente", "Mais antigo"
    var sortBtn = null;
    var sortKeywords = ['recent', 'oldest', 'newest', 'antigo', 'recente', 'novo'];
    var dlgButtons = dialog.querySelectorAll('button');
    for (var i = 0; i < dlgButtons.length; i++) {
      if (dlgButtons[i].textContent.indexOf('arrow_drop_down') < 0) continue;
      var btnTxt = dlgButtons[i].textContent.toLowerCase();
      for (var s = 0; s < sortKeywords.length; s++) {
        if (btnTxt.indexOf(sortKeywords[s]) >= 0) {
          sortBtn = dlgButtons[i];
          break;
        }
      }
      if (sortBtn) break;
    }

    // Fallback: pegar o ULTIMO arrow_drop_down (ordenacao fica depois do filtro de data)
    if (!sortBtn) {
      for (var f = dlgButtons.length - 1; f >= 0; f--) {
        if (dlgButtons[f].textContent.indexOf('arrow_drop_down') >= 0) {
          sortBtn = dlgButtons[f];
          break;
        }
      }
    }

    if (!sortBtn) {
      _dispatch('dotti-sort-gallery-result', { requestId: requestId, result: 'NO_SORT_BTN' });
      return;
    }

    console.log('[DottiSlateHelper] Sort button encontrado:', sortBtn.textContent.trim().substring(0, 50));

    // Se ja esta em "Oldest"/"Mais antigo", pular
    var sortText = sortBtn.textContent.toLowerCase();
    if (sortText.indexOf('antigo') >= 0 || sortText.indexOf('oldest') >= 0) {
      console.log('[DottiSlateHelper] Galeria ja em Mais antigo');
      _dispatch('dotti-sort-gallery-result', { requestId: requestId, result: 'ALREADY_OLDEST' });
      return;
    }

    // Abrir dropdown com _pointerClick
    console.log('[DottiSlateHelper] Abrindo sort dropdown...');
    _pointerClick(sortBtn);

    // Aguardar dropdown abrir e clicar em "Mais antigo"/"Oldest"
    setTimeout(function() {
      var items = document.querySelectorAll('[role="menuitem"], [role="option"], [role="menuitemradio"], [data-radix-collection-item]');
      console.log('[DottiSlateHelper] Sort options encontradas:', items.length);
      var found = false;
      for (var j = 0; j < items.length; j++) {
        var txt = items[j].textContent.trim();
        console.log('[DottiSlateHelper]   option:', txt);
        if (txt.indexOf('antigo') >= 0 || txt.indexOf('ldest') >= 0 || txt === 'Oldest') {
          console.log('[DottiSlateHelper] Selecionando:', txt);
          _pointerClick(items[j]);
          found = true;
          break;
        }
      }

      // Fallback: qualquer elemento visivel com texto "antigo"/"Oldest"
      if (!found) {
        var allEls = document.querySelectorAll('div, span, button, li, a');
        for (var k = 0; k < allEls.length; k++) {
          if (found) break;
          var el = allEls[k];
          var t = el.textContent.trim();
          var r = el.getBoundingClientRect();
          if (r.width > 0 && r.height > 10 && r.width < 300 && t.length < 30) {
            if ((t.indexOf('antigo') >= 0 || t === 'Oldest') && el.children.length === 0) {
              console.log('[DottiSlateHelper] Selecionando (fallback):', t);
              _pointerClick(el);
              found = true;
            }
          }
        }
      }

      _dispatch('dotti-sort-gallery-result', { requestId: requestId, result: found ? 'OK' : 'OPTION_NOT_FOUND' });
    }, 1000);
  });

  // ====== GALLERY: SELECT ITEM (MAIN WORLD) ======
  // v3.2.0: Selecionar thumbnail na galeria por indice
  document.addEventListener('dotti-select-gallery-item', function(e) {
    var requestId = (e.detail && e.detail.requestId) || '';
    var idx = (e.detail && typeof e.detail.index === 'number') ? e.detail.index : -1;

    // Procurar container da galeria em varias localizacoes
    var container = document.querySelector('[role="dialog"]');
    var source = 'dialog';

    // Fallback: popover Radix
    if (!container || container.querySelectorAll('img').length === 0) {
      var popover = document.querySelector('[data-radix-popper-content-wrapper]') ||
                    document.querySelector('[data-side]');
      if (popover && popover.querySelectorAll('img').length > 0) {
        container = popover;
        source = 'popover';
      }
    }

    // Fallback: data-state="open" com imagens
    if (!container || container.querySelectorAll('img').length === 0) {
      var allOpen = document.querySelectorAll('[data-state="open"]');
      for (var i = 0; i < allOpen.length; i++) {
        if (allOpen[i].querySelectorAll('img').length > 0) {
          container = allOpen[i];
          source = 'data-state-open';
          break;
        }
      }
    }

    // Fallback: qualquer container com grid de imagens
    if (!container || container.querySelectorAll('img').length === 0) {
      container = null;
      source = 'none';
    }

    if (!container) {
      _dispatch('dotti-select-gallery-item-result', { requestId: requestId, result: 'NO_CONTAINER', totalPageImgs: document.querySelectorAll('img').length });
      return;
    }

    var imgs = container.querySelectorAll('img');
    console.log('[DottiSlateHelper] Gallery imgs:', imgs.length, 'selecting idx:', idx, 'source:', source);

    if (idx < 0 || idx >= imgs.length) {
      _dispatch('dotti-select-gallery-item-result', { requestId: requestId, result: 'OUT_OF_RANGE', imgCount: imgs.length, requestedIdx: idx, source: source });
      return;
    }

    imgs[idx].click();
    _dispatch('dotti-select-gallery-item-result', { requestId: requestId, result: 'OK', imgCount: imgs.length, source: source });
  });

  // ====== GALLERY: CLOSE DIALOG (MAIN WORLD) ======
  document.addEventListener('dotti-close-gallery', function(e) {
    var requestId = (e.detail && e.detail.requestId) || '';

    var dialog = document.querySelector('[role="dialog"]');
    if (!dialog) {
      _dispatch('dotti-close-gallery-result', { requestId: requestId, result: 'NO_DIALOG' });
      return;
    }

    var btns = dialog.querySelectorAll('button');
    for (var i = 0; i < btns.length; i++) {
      var icon = btns[i].querySelector('mat-icon, i, span.material-icons, span.material-symbols-outlined');
      var t = icon ? icon.textContent.trim() : '';
      if (t === 'close' || t === 'done' || t === 'check') {
        btns[i].click();
        _dispatch('dotti-close-gallery-result', { requestId: requestId, result: 'OK', method: t });
        return;
      }
    }

    // Fallback: clicar fora do dialog
    var overlay = dialog.parentElement;
    if (overlay && overlay !== document.body) {
      overlay.click();
      _dispatch('dotti-close-gallery-result', { requestId: requestId, result: 'OK', method: 'overlay' });
      return;
    }

    _dispatch('dotti-close-gallery-result', { requestId: requestId, result: 'NO_CLOSE_BTN' });
  });

  // ====== GALLERY: DEBUG INFO (MAIN WORLD) ======
  document.addEventListener('dotti-gallery-debug', function(e) {
    var requestId = (e.detail && e.detail.requestId) || '';
    var dialog = document.querySelector('[role="dialog"]');
    var dataOpen = document.querySelector('[data-state="open"]');

    // Listar TODOS os data-state="open" elementos para debug
    var allDataOpen = document.querySelectorAll('[data-state="open"]');
    var dataOpenList = [];
    for (var i = 0; i < allDataOpen.length; i++) {
      var el = allDataOpen[i];
      var r = el.getBoundingClientRect();
      dataOpenList.push({
        tag: el.tagName,
        w: Math.round(r.width),
        h: Math.round(r.height),
        imgs: el.querySelectorAll('img').length,
        html: el.innerHTML.substring(0, 200)
      });
    }

    // Listar todos os overlays/popover que podem ser a galeria
    var popover = document.querySelector('[data-radix-popper-content-wrapper]') ||
                  document.querySelector('[data-side]') ||
                  document.querySelector('[role="listbox"]');

    var info = {
      requestId: requestId,
      hasDialog: !!dialog,
      hasDataOpen: !!dataOpen,
      dataOpenCount: allDataOpen.length,
      dataOpenList: dataOpenList,
      dialogImgCount: dialog ? dialog.querySelectorAll('img').length : 0,
      dataOpenImgCount: dataOpen ? dataOpen.querySelectorAll('img').length : 0,
      dialogBtnCount: dialog ? dialog.querySelectorAll('button').length : 0,
      dialogHTML: dialog ? dialog.innerHTML.substring(0, 1000) : '',
      hasPopover: !!popover,
      popoverTag: popover ? popover.tagName : '',
      popoverImgs: popover ? popover.querySelectorAll('img').length : 0,
      popoverHTML: popover ? popover.innerHTML.substring(0, 500) : '',
      totalImgsOnPage: document.querySelectorAll('img').length
    };
    _dispatch('dotti-gallery-debug-result', info);
  });

  // ====== MODE SWITCH: IMAGE/VIDEO + INGREDIENTS/FRAMES (MAIN WORLD) ======
  // v3.4.0: Suporta DOIS grupos de tabs no seletor de modo:
  //   Group 1 (mediaType): image(icon:image) | video(icon:videocam)
  //   Group 2 (mode):      frames(icon:crop_free) | ingredients(icon:chrome_extension)
  // Ambos sao opcionais — passa so o que precisar
  document.addEventListener('dotti-switch-mode', function(e) {
    var requestId = (e.detail && e.detail.requestId) || '';
    var mediaType = (e.detail && e.detail.mediaType) || null; // 'image' or 'video'
    var subMode = (e.detail && e.detail.mode) || null;        // 'ingredients' or 'frames'
    var setX1 = !!(e.detail && e.detail.setX1);
    var duration = (e.detail && e.detail.duration) || null;   // 4 | 6 | 8

    // Build list of icons to click. Cada entrada eh uma lista de alternativas
    // (Flow renomeou videocam -> play_circle em maio/2026).
    var targets = [];
    if (mediaType === 'image') targets.push(['image']);
    else if (mediaType === 'video') targets.push(['videocam', 'play_circle']);
    if (subMode === 'ingredients') targets.push(['chrome_extension']);
    else if (subMode === 'frames') targets.push(['crop_free']);

    if (targets.length === 0 && !setX1) {
      _dispatch('dotti-switch-mode-result', { requestId: requestId, result: 'NO_TARGETS' });
      return;
    }

    console.log('[DottiSlateHelper] switchMode: mediaType=' + mediaType + ' subMode=' + subMode + ' targets=' + targets.join(','));

    // Find crop_16_9 button (mode selector trigger at bottom of creation area)
    var allBtns = Array.from(document.querySelectorAll('button')).filter(function(b) { return b.offsetParent !== null; });
    var cropBtn = null;
    for (var i = 0; i < allBtns.length; i++) {
      // v3.3.0: no Flow Angular os icones sao <mat-icon>, nao <i>. O crop_16_9
      // existia na pagina o tempo todo — a busca e que olhava a tag errada.
      var icon = allBtns[i].querySelector('mat-icon, i, span.material-icons, span.material-symbols-outlined');
      if (icon && (icon.textContent.trim() === 'crop_16_9' || icon.textContent.trim() === 'crop_9_16')) {
        cropBtn = allBtns[i];
        break;
      }
    }

    if (!cropBtn) {
      console.log('[DottiSlateHelper] crop_16_9/crop_9_16 not found for mode switch');
      _dispatch('dotti-switch-mode-result', { requestId: requestId, result: 'NO_CROP_BTN' });
      return;
    }

    // Open mode selector
    console.log('[DottiSlateHelper] Opening mode selector...');
    _pointerClick(cropBtn);

    // Wait for tabs to appear
    setTimeout(function() {
      var refreshedBtns = Array.from(document.querySelectorAll('button')).filter(function(b) { return b.offsetParent !== null; });

      // Debug: list visible buttons
      var btnList = [];
      for (var d = 0; d < refreshedBtns.length; d++) {
        var di = refreshedBtns[d].querySelector('mat-icon, i, span.material-icons, span.material-symbols-outlined');
        if (di) btnList.push(di.textContent.trim() + '(' + (refreshedBtns[d].getAttribute('data-state') || '') + ')');
      }
      console.log('[DottiSlateHelper] Buttons after open:', btnList.join(', '));

      // Click each target tab sequentially
      var clickResults = [];
      var allAlreadyActive = true;

      for (var t = 0; t < targets.length; t++) {
        var targetAlts = targets[t]; // array de alternativas (ex: ['videocam','play_circle'])
        var targetIcon = targetAlts[0];
        var targetBtn = null;
        var fallbackBtn = null;
        var matchedIcon = null;
        // Preferir botoes do popup (data-state active/inactive). Outros videocam/image
        // que aparecem em sidebar/galeria usam outros estados (closed) e devem ser ignorados.
        for (var j = 0; j < refreshedBtns.length; j++) {
          var ic = refreshedBtns[j].querySelector('mat-icon, i, span.material-icons, span.material-symbols-outlined');
          if (!ic) continue;
          var icText = ic.textContent.trim();
          if (targetAlts.indexOf(icText) < 0) continue;
          var st = refreshedBtns[j].getAttribute('data-state');
          if (st === 'active' || st === 'inactive') { targetBtn = refreshedBtns[j]; matchedIcon = icText; break; }
          if (!fallbackBtn) { fallbackBtn = refreshedBtns[j]; matchedIcon = icText; }
        }
        if (!targetBtn) targetBtn = fallbackBtn;
        if (matchedIcon) targetIcon = matchedIcon;

        if (!targetBtn) {
          clickResults.push({ icon: targetAlts.join('|'), action: 'not_found' });
          allAlreadyActive = false;
          continue;
        }

        var state = targetBtn.getAttribute('data-state');
        if (state === 'active') {
          clickResults.push({ icon: targetIcon, action: 'already_active' });
        } else {
          console.log('[DottiSlateHelper] Clicking', targetIcon, '(was ' + state + ')');
          _pointerClick(targetBtn);
          clickResults.push({ icon: targetIcon, action: 'clicked', was: state });
          allAlreadyActive = false;
        }
      }

      // Set x1 if requested
      setTimeout(function() {
        if (setX1) {
          var btns2 = Array.from(document.querySelectorAll('button')).filter(function(b) { return b.offsetParent !== null; });
          for (var k = 0; k < btns2.length; k++) {
            var txt = btns2[k].textContent.trim();
            if (txt === 'x1' && btns2[k].getAttribute('data-state') === 'inactive') {
              console.log('[DottiSlateHelper] Setting x1');
              _pointerClick(btns2[k]);
              break;
            }
          }
        }

        // Set video duration (4s / 6s / 8s) — Veo 3 popup
        if (duration === 4 || duration === 6 || duration === 8) {
          var wanted = duration + 's';
          var btns3 = Array.from(document.querySelectorAll('button, [role="button"], [role="radio"], [role="option"], [role="tab"]')).filter(function(b) { return b.offsetParent !== null; });
          var visible = [];
          var durTarget = null;
          for (var d = 0; d < btns3.length; d++) {
            var dtxt = (btns3[d].textContent || '').replace(/\s+/g, '').toLowerCase();
            if (dtxt === '4s' || dtxt === '6s' || dtxt === '8s') {
              visible.push(dtxt);
              if (dtxt === wanted) durTarget = btns3[d];
            }
          }
          if (durTarget) {
            var dstate = durTarget.getAttribute('data-state');
            if (dstate === 'active') {
              console.log('[DottiSlateHelper] Duration ' + wanted + ' already active');
            } else {
              console.log('[DottiSlateHelper] Setting duration ' + wanted + ' (was ' + dstate + ')');
              _pointerClick(durTarget);
            }
          } else {
            console.log('[DottiSlateHelper] Duration button ' + wanted + ' not found, visible=' + visible.join(','));
          }
        }

        // Close mode selector
        setTimeout(function() {
          console.log('[DottiSlateHelper] Closing mode selector');
          _pointerClick(cropBtn);

          setTimeout(function() {
            _dispatch('dotti-switch-mode-result', {
              requestId: requestId,
              result: 'OK',
              mediaType: mediaType,
              mode: subMode,
              clicks: clickResults,
              x1Set: setX1
            });
          }, 1000);
        }, 500);
      }, 600);
    }, 1500);
  });

  // ====== FRAME UPLOAD: INITIAL IMAGE (MAIN WORLD) ======
  // v3.6.0: Upload frame image and select it as "Inicial" frame
  // FIXED: Wait for upload completion via dotti-upload-result event from interceptor
  // FIXED: Always sort by "Newest" so first image = just uploaded = correct one
  // Flow: upload via hidden input → WAIT for upload done → click "Inicial" → sort newest → select first
  document.addEventListener('dotti-frame-upload', function(e) {
    var requestId = (e.detail && e.detail.requestId) || '';
    var dataUrl = (e.detail && e.detail.dataUrl) || '';
    var imageName = (e.detail && e.detail.imageName) || ('frame_' + Date.now() + '.png');

    if (!dataUrl) {
      _dispatch('dotti-frame-upload-result', { requestId: requestId, result: 'NO_DATA' });
      return;
    }

    console.log('[DottiSlateHelper] Frame upload v3.6.0: ' + imageName);

    // Listen for upload completion from interceptor (both run in MAIN world)
    var uploadDone = false;
    var uploadImageId = null;

    function onUploadResult(ev) {
      var d = ev.detail || {};
      if (d.source === 'uploadImage' || d.source === 'uploadUserImage') {
        uploadDone = true;
        uploadImageId = d.imageId || null;
        console.log('[DottiSlateHelper] Upload confirmed via interceptor. imageId:', uploadImageId);
      }
    }
    function onUploadError(ev) {
      console.log('[DottiSlateHelper] Upload error event:', JSON.stringify(ev.detail));
      uploadDone = true; // proceed anyway
    }
    document.addEventListener('dotti-upload-result', onUploadResult);
    document.addEventListener('dotti-upload-error', onUploadError);

    function cleanupListeners() {
      document.removeEventListener('dotti-upload-result', onUploadResult);
      document.removeEventListener('dotti-upload-error', onUploadError);
    }

    fetch(dataUrl).then(function(resp) {
      return resp.blob();
    }).then(function(blob) {
      var file = new File([blob], imageName, { type: 'image/png' });

      // Step 1: Upload file via hidden input
      var fileInput = document.querySelector('input[type="file"][accept*="image"]') || document.querySelector('input[type="file"]');
      if (!fileInput) {
        console.log('[DottiSlateHelper] No file input found');
        cleanupListeners();
        _dispatch('dotti-frame-upload-result', { requestId: requestId, result: 'NO_FILE_INPUT' });
        return;
      }

      fileInput.value = '';
      var dt = new DataTransfer();
      dt.items.add(file);
      fileInput.files = dt.files;
      fileInput.dispatchEvent(new Event('change', { bubbles: true }));
      console.log('[DottiSlateHelper] File dispatched to input. Waiting for upload to complete...');

      // Step 2: Poll until upload confirmed (max 30s)
      var elapsed = 0;
      var maxUploadWait = 30000;

      function waitForUpload() {
        if (uploadDone) {
          console.log('[DottiSlateHelper] Upload done after ' + elapsed + 'ms. Proceeding to select image.');
          cleanupListeners();
          setTimeout(openInicialAndSelect, 1000);
          return;
        }
        elapsed += 1000;
        if (elapsed >= maxUploadWait) {
          console.log('[DottiSlateHelper] Upload wait timeout (' + maxUploadWait + 'ms), proceeding anyway');
          cleanupListeners();
          openInicialAndSelect();
          return;
        }
        setTimeout(waitForUpload, 1000);
      }

      setTimeout(waitForUpload, 2000); // first check after 2s

      // Step 3: Click "Inicial" slot to open gallery dialog
      function openInicialAndSelect() {
        var startBtn = null;
        var frameKeywords = ['start', 'início', 'inicio', 'inicial'];
        var divBtns = document.querySelectorAll('div[type="button"]');

        for (var s = 0; s < divBtns.length; s++) {
          if (divBtns[s].offsetParent === null) continue;
          var txt = (divBtns[s].textContent || '').trim().toLowerCase();
          for (var k = 0; k < frameKeywords.length; k++) {
            if (txt === frameKeywords[k]) { startBtn = divBtns[s]; break; }
          }
          if (startBtn) break;
        }

        // Fallback: any clickable element with start/inicial text
        if (!startBtn) {
          var allClickable = document.querySelectorAll('button, div[role="button"], [aria-haspopup="dialog"]');
          for (var b = 0; b < allClickable.length; b++) {
            if (allClickable[b].offsetParent === null) continue;
            var bt = (allClickable[b].textContent || '').trim().toLowerCase();
            for (var kk = 0; kk < frameKeywords.length; kk++) {
              if (bt === frameKeywords[kk]) { startBtn = allClickable[b]; break; }
            }
            if (startBtn) break;
          }
        }

        if (!startBtn) {
          console.log('[DottiSlateHelper] Inicial/Start slot not found');
          _dispatch('dotti-frame-upload-result', { requestId: requestId, result: 'NO_START_BTN' });
          return;
        }

        console.log('[DottiSlateHelper] Clicking Inicial slot: "' + startBtn.textContent.trim() + '"');
        _pointerClick(startBtn);

        // Step 4: Wait for dialog to open, then sort by Newest
        setTimeout(function() {
          var dialog = document.querySelector('[role="dialog"][data-state="open"]') || document.querySelector('[role="dialog"]');
          if (!dialog) {
            console.log('[DottiSlateHelper] No dialog opened after clicking Inicial');
            _dispatch('dotti-frame-upload-result', { requestId: requestId, result: 'NO_DIALOG' });
            return;
          }
          console.log('[DottiSlateHelper] Dialog opened. Sorting by newest...');

          // Step 5: Sort by Newest — find the sort dropdown and ensure "Newest" is selected
          sortByNewest(dialog, function() {
            // Step 6: After sort settles, select first image (= newest = just uploaded)
            setTimeout(function() {
              selectFirstImage();
            }, 1500);
          });
        }, 1500);
      }

      // Sort helper: always ensure gallery is sorted by "Newest"
      function sortByNewest(dialog, callback) {
        var dlgBtns = dialog.querySelectorAll('button');
        var sortBtn = null;
        var sortKeywords = ['recent', 'oldest', 'newest', 'antigo', 'recente', 'novo'];

        // Find sort dropdown button (contains arrow_drop_down + a sort keyword)
        for (var sb = 0; sb < dlgBtns.length; sb++) {
          if (dlgBtns[sb].offsetParent === null) continue;
          var btnText = (dlgBtns[sb].textContent || '').toLowerCase();
          if (btnText.indexOf('arrow_drop_down') < 0) continue;
          for (var sk = 0; sk < sortKeywords.length; sk++) {
            if (btnText.indexOf(sortKeywords[sk]) >= 0) {
              sortBtn = dlgBtns[sb];
              break;
            }
          }
          if (sortBtn) break;
        }

        // Fallback: last arrow_drop_down button in dialog (sort is typically after date filter)
        if (!sortBtn) {
          for (var fb = dlgBtns.length - 1; fb >= 0; fb--) {
            if (dlgBtns[fb].offsetParent === null) continue;
            if ((dlgBtns[fb].textContent || '').indexOf('arrow_drop_down') >= 0) {
              sortBtn = dlgBtns[fb];
              break;
            }
          }
        }

        if (!sortBtn) {
          console.log('[DottiSlateHelper] No sort button found in dialog');
          callback();
          return;
        }

        var sortText = (sortBtn.textContent || '').toLowerCase();
        console.log('[DottiSlateHelper] Sort button: "' + sortBtn.textContent.trim().substring(0, 60) + '"');

        // If already "Newest" — skip
        if (sortText.indexOf('newest') >= 0 || sortText.indexOf('mais novo') >= 0) {
          console.log('[DottiSlateHelper] Already sorted by Newest');
          callback();
          return;
        }

        // Open dropdown and select "Newest"
        console.log('[DottiSlateHelper] Opening sort dropdown to select Newest...');
        _pointerClick(sortBtn);

        setTimeout(function() {
          var items = document.querySelectorAll('[role="menuitem"], [role="option"], [role="menuitemradio"], [data-radix-collection-item]');
          console.log('[DottiSlateHelper] Sort menu items: ' + items.length);

          var found = false;
          for (var mi = 0; mi < items.length; mi++) {
            var itemTxt = (items[mi].textContent || '').trim();
            console.log('[DottiSlateHelper]   option: "' + itemTxt + '"');
            var itemLow = itemTxt.toLowerCase();
            // Match "Newest" / "Mais novo" / "Mais recente" but NOT "Recently Used"
            if (itemLow === 'newest' || itemLow === 'mais novo' || itemLow === 'mais recente') {
              console.log('[DottiSlateHelper] Selecting: ' + itemTxt);
              _pointerClick(items[mi]);
              found = true;
              break;
            }
          }

          // Fallback: any item containing "newest" or "novo"
          if (!found) {
            for (var fi = 0; fi < items.length; fi++) {
              var fTxt = (items[fi].textContent || '').trim().toLowerCase();
              if (fTxt.indexOf('newest') >= 0 || fTxt.indexOf('novo') >= 0) {
                console.log('[DottiSlateHelper] Selecting (fallback): ' + items[fi].textContent.trim());
                _pointerClick(items[fi]);
                found = true;
                break;
              }
            }
          }

          // Second fallback: scan all visible small text elements
          if (!found) {
            var allEls = document.querySelectorAll('div, span, button, li, a');
            for (var ae = 0; ae < allEls.length; ae++) {
              var el = allEls[ae];
              var t = (el.textContent || '').trim();
              var r = el.getBoundingClientRect();
              if (r.width > 0 && r.height > 10 && r.width < 300 && t.length < 30 && el.children.length === 0) {
                var tl = t.toLowerCase();
                if (tl === 'newest' || tl === 'mais novo' || tl === 'mais recente') {
                  console.log('[DottiSlateHelper] Selecting (scan fallback): ' + t);
                  _pointerClick(el);
                  found = true;
                  break;
                }
              }
            }
          }

          if (!found) {
            console.log('[DottiSlateHelper] "Newest" option not found — closing dropdown');
            document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
          }

          // Wait for sort to take effect
          setTimeout(callback, 1000);
        }, 800);
      }

      // Select the first image in dialog (after sort by newest = just uploaded)
      function selectFirstImage() {
        var retryBudget = 12000;

        function trySelect() {
          if (retryBudget <= 0) {
            console.log('[DottiSlateHelper] Timeout waiting for image in dialog');
            document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
            _dispatch('dotti-frame-upload-result', { requestId: requestId, result: 'TIMEOUT_NO_IMAGE' });
            return;
          }

          var currentDialog = document.querySelector('[role="dialog"]');
          if (!currentDialog) {
            console.log('[DottiSlateHelper] Dialog closed automatically — success');
            _dispatch('dotti-frame-upload-result', { requestId: requestId, result: 'OK', method: 'auto' });
            return;
          }

          // Find asset items in dialog
          var assetItems = currentDialog.querySelectorAll('[class*="sc-5bf79b14"]');
          var assetImgs = currentDialog.querySelectorAll('img[src*="getMediaUrlRedirect"]');

          if (assetItems.length > 0 || assetImgs.length > 0) {
            // Click the FIRST asset (sorted by newest = just uploaded image)
            var clickTarget = assetItems.length > 0 ? assetItems[0] :
                (assetImgs[0].closest('[class*="sc-5bf79b14"]') || assetImgs[0].parentElement || assetImgs[0]);
            console.log('[DottiSlateHelper] Clicking FIRST asset (newest) (' + assetImgs.length + ' imgs total)');
            _pointerClick(clickTarget);

            setTimeout(function() {
              if (!document.querySelector('[role="dialog"]')) {
                _dispatch('dotti-frame-upload-result', { requestId: requestId, result: 'OK', method: 'clicked_newest' });
                return;
              }
              // Dialog still open — try clicking img directly
              if (assetImgs.length > 0) {
                _pointerClick(assetImgs[0]);
                setTimeout(function() {
                  if (!document.querySelector('[role="dialog"]')) {
                    _dispatch('dotti-frame-upload-result', { requestId: requestId, result: 'OK', method: 'img_direct' });
                  } else {
                    retryBudget -= 2000;
                    setTimeout(trySelect, 500);
                  }
                }, 1000);
              } else {
                retryBudget -= 1500;
                setTimeout(trySelect, 500);
              }
            }, 1000);
          } else {
            retryBudget -= 500;
            setTimeout(trySelect, 500);
          }
        }

        trySelect();
      }
    }).catch(function(err) {
      console.log('[DottiSlateHelper] Frame upload error:', err.message);
      cleanupListeners();
      _dispatch('dotti-frame-upload-result', { requestId: requestId, result: 'FETCH_ERROR', error: err.message });
    });
  });

  // ====== GALERIA v4.4.0 — janela "Pesquisar recursos" (Angular) ======
  // A janela nova nao inclui a imagem ao clicar na miniatura: ela so seleciona
  // e mostra a pre-visualizacao. Quem inclui e o botao "Incluir no comando".
  // Alem disso a lista se reordena pelo USO, entao posicao nao e identidade —
  // amarramos cada [N] ao TITULO do item (ver ADENDO 24).

  function _gTxt(el) {
    return ((el && el.textContent) || '').replace(/\s+/g, ' ').trim();
  }

  function _gNorm(s) {
    return (s || '').toString().toLowerCase()
      .normalize('NFD').replace(/[̀-ͯ]/g, '')
      .replace(/\s+/g, ' ').trim();
  }

  // Texto de uma linha: junta os pedacos com espaco. textContent cru cola
  // "Old sailor portrait" com "Imagem" e deixa o log ilegivel.
  function _gTextoDeLinha(el) {
    var partes = [];
    (function anda(n) {
      for (var i = 0; i < n.childNodes.length; i++) {
        var c = n.childNodes[i];
        if (c.nodeType === 3) {
          var t = (c.nodeValue || '').replace(/\s+/g, ' ').trim();
          if (t) partes.push(t);
        } else if (c.nodeType === 1) {
          var tag = c.tagName.toLowerCase();
          var cls = (c.className || '').toString();
          if (tag === 'mat-icon' || tag === 'i' ||
              cls.indexOf('material-icons') >= 0 || cls.indexOf('material-symbols') >= 0) continue;
          anda(c);
        }
      }
    })(el);
    return partes.join(' ');
  }

  function _gVisivel(el) {
    if (!el || !el.getBoundingClientRect) return false;
    var r = el.getBoundingClientRect();
    return r.width > 0 && r.height > 0;
  }

  // O dialogo e o maior overlay visivel. Nao exigimos <img>: a aba
  // "Personagens" pode estar vazia e ainda assim ser o dialogo certo.
  function _gDialogo() {
    var cands = document.querySelectorAll(
      '[role="dialog"], mat-dialog-container, .mat-mdc-dialog-container, .cdk-overlay-pane');
    var melhor = null, melhorArea = 0;
    for (var i = 0; i < cands.length; i++) {
      if (!_gVisivel(cands[i])) continue;
      var r = cands[i].getBoundingClientRect();
      var area = r.width * r.height;
      if (area > melhorArea) { melhor = cands[i]; melhorArea = area; }
    }
    return melhor;
  }

  // A lista e o container cujos FILHOS DIRETOS carregam mais imagens. O painel
  // de pre-visualizacao tem uma <img> sozinha, entao perde por construcao — foi
  // essa contaminacao que quebrou a contagem por querySelectorAll('img').
  function _gContainerDaLista(dlg) {
    var imgs = [];
    var todas = dlg.querySelectorAll('img');
    for (var i = 0; i < todas.length; i++) if (_gVisivel(todas[i])) imgs.push(todas[i]);

    var pais = [], conjuntos = [];
    for (var j = 0; j < imgs.length; j++) {
      var el = imgs[j];
      for (var d = 0; d < 8 && el && el !== dlg; d++) {
        var pai = el.parentElement;
        if (!pai) break;
        var k = pais.indexOf(pai);
        if (k < 0) { pais.push(pai); conjuntos.push([el]); }
        else if (conjuntos[k].indexOf(el) < 0) conjuntos[k].push(el);
        el = pai;
      }
    }

    var melhor = null, n = 0;
    for (var p = 0; p < pais.length; p++) {
      if (conjuntos[p].length > n) { n = conjuntos[p].length; melhor = pais[p]; }
    }
    return n >= 2 ? melhor : null;
  }

  function _gLinhas(dlg) {
    var cont = _gContainerDaLista(dlg);
    if (!cont) return [];
    var out = [];
    for (var i = 0; i < cont.children.length; i++) {
      var c = cont.children[i];
      if (!c.querySelector('img')) continue;
      if (!_gVisivel(c)) continue;
      out.push(c);
    }
    return out;
  }

  // O container rolavel que contem a lista (a janela pode ter dezenas de itens).
  function _gRolavel(el) {
    var cur = el;
    for (var i = 0; i < 8 && cur; i++) {
      if (cur.scrollHeight > cur.clientHeight + 20 && cur.clientHeight > 80) return cur;
      cur = cur.parentElement;
    }
    return null;
  }

  // Percorre a lista inteira rolando, devolvendo [{titulo, el}] sem repetir.
  function _gEnumerar(dlg, limite) {
    var vistos = [], itens = [];
    var cont = _gContainerDaLista(dlg);
    var rol = cont ? _gRolavel(cont) : null;

    function colher() {
      var linhas = _gLinhas(dlg);
      for (var i = 0; i < linhas.length; i++) {
        var t = _gTextoDeLinha(linhas[i]);
        if (!t) continue;
        if (vistos.indexOf(t) >= 0) continue;
        vistos.push(t);
        itens.push({ titulo: t, el: linhas[i] });
      }
    }

    colher();
    if (!rol) return itens;

    var antes = -1, passos = 0;
    while (passos < 40 && itens.length < (limite || 300) && rol.scrollTop !== antes) {
      antes = rol.scrollTop;
      rol.scrollTop = rol.scrollTop + Math.max(120, rol.clientHeight - 60);
      colher();
      passos++;
      if (rol.scrollTop === antes) break;
    }
    rol.scrollTop = 0;
    colher();
    return itens;
  }

  // Botao que de fato inclui o item no comando. NUNCA o close/done/check:
  // era ele que a extensao apertava, cancelando a selecao (ADENDO 24).
  var _G_CONFIRMA_EXATO = ['incluir no comando', 'include in prompt',
                           'adicionar ao comando', 'add to prompt', 'inserir no comando'];

  function _gBotaoConfirmar(dlg) {
    var btns = dlg.querySelectorAll('button, [role="button"]');
    var candidato = null;
    for (var i = 0; i < btns.length; i++) {
      if (!_gVisivel(btns[i])) continue;
      var t = _gNorm(_gTxt(btns[i]));
      if (!t) continue;
      if (_G_CONFIRMA_EXATO.indexOf(t) >= 0) return btns[i];
      var temAlvo = (t.indexOf('comando') >= 0 || t.indexOf('prompt') >= 0);
      var temVerbo = (t.indexOf('inclu') >= 0 || t.indexOf('adicion') >= 0 ||
                      t.indexOf('include') >= 0 || t.indexOf('add') >= 0 || t.indexOf('inser') >= 0);
      if (temAlvo && temVerbo && t.length < 40 && !candidato) candidato = btns[i];
    }
    return candidato;
  }

  function _gDesabilitado(btn) {
    if (!btn) return true;
    if (btn.disabled) return true;
    var a = btn.getAttribute('aria-disabled');
    return a === 'true';
  }

  // Clica numa aba do menu lateral (Tudo / Imagens / Personagens / ...)
  function _gClicarAba(dlg, nomes) {
    var alvos = [];
    for (var n = 0; n < nomes.length; n++) alvos.push(_gNorm(nomes[n]));
    var els = dlg.querySelectorAll('button, [role="tab"], [role="button"], [role="option"], li, a, div, span');
    var melhor = null, melhorArea = Infinity;
    for (var i = 0; i < els.length; i++) {
      var el = els[i];
      if (!_gVisivel(el)) continue;
      var t = _gNorm(_gTxt(el));
      if (alvos.indexOf(t) < 0) continue;
      var r = el.getBoundingClientRect();
      var area = r.width * r.height;
      if (area > 0 && area < melhorArea) { melhor = el; melhorArea = area; }
    }
    if (!melhor) return null;
    // Subir ate algo clicavel, sem sair do rotulo
    var clicavel = melhor;
    for (var d = 0; d < 3 && clicavel.parentElement; d++) {
      var tag = clicavel.tagName.toLowerCase();
      if (tag === 'button' || tag === 'a' || tag === 'li' ||
          clicavel.getAttribute('role') === 'tab' || clicavel.getAttribute('role') === 'button') break;
      clicavel = clicavel.parentElement;
    }
    _pointerClick(clicavel);
    return _gTxt(melhor);
  }

  function _gDump(dlg) {
    if (!dlg) return { dialogo: false };
    var linhas = _gLinhas(dlg).map(function(l) { return _gTextoDeLinha(l).substring(0, 60); });
    var btns = [];
    var todos = dlg.querySelectorAll('button, [role="button"]');
    for (var i = 0; i < todos.length && btns.length < 40; i++) {
      if (!_gVisivel(todos[i])) continue;
      var ic = todos[i].querySelector('mat-icon, i, span.material-icons, span.material-symbols-outlined');
      btns.push({ texto: _gTxt(todos[i]).substring(0, 40), icone: ic ? _gTxt(ic) : '',
                  desabilitado: _gDesabilitado(todos[i]) });
    }
    var cont = _gContainerDaLista(dlg);
    return {
      dialogo: true,
      tag: dlg.tagName.toLowerCase(),
      imgsNoDialogo: dlg.querySelectorAll('img').length,
      containerDaLista: cont ? (cont.tagName.toLowerCase() + '.' + (cont.className || '').toString().split(' ')[0]) : null,
      linhas: linhas,
      botoes: btns,
      temConfirmar: !!_gBotaoConfirmar(dlg)
    };
  }

  // ------ dotti-gallery-tab ------
  document.addEventListener('dotti-gallery-tab', function(e) {
    var requestId = (e.detail && e.detail.requestId) || '';
    var nomes = (e.detail && e.detail.nomes) || [];
    var dlg = _gDialogo();
    if (!dlg) { _dispatch('dotti-gallery-tab-result', { requestId: requestId, result: 'SEM_DIALOGO' }); return; }
    var clicada = _gClicarAba(dlg, nomes);
    if (!clicada) {
      console.log('[DottiSlateHelper] aba nao encontrada:', nomes.join('/'));
      _dispatch('dotti-gallery-tab-result', { requestId: requestId, result: 'ABA_NAO_ENCONTRADA', dump: _gDump(dlg) });
      return;
    }
    console.log('[DottiSlateHelper] aba clicada:', clicada);
    _dispatch('dotti-gallery-tab-result', { requestId: requestId, result: 'OK', aba: clicada });
  });

  // ------ dotti-gallery-sort (ordenar por mais antigo) ------
  document.addEventListener('dotti-gallery-sort', function(e) {
    var requestId = (e.detail && e.detail.requestId) || '';
    var dlg = _gDialogo();
    if (!dlg) { _dispatch('dotti-gallery-sort-result', { requestId: requestId, result: 'SEM_DIALOGO' }); return; }

    var chaves = ['recente', 'antigo', 'recent', 'oldest', 'newest', 'novo', 'ordenar', 'sort'];
    var btn = null;
    var btns = dlg.querySelectorAll('button, [role="button"], mat-select, [role="combobox"]');
    for (var i = 0; i < btns.length; i++) {
      if (!_gVisivel(btns[i])) continue;
      var t = _gNorm(_gTxt(btns[i]));
      if (!t || t.length > 40) continue;
      for (var k = 0; k < chaves.length; k++) {
        if (t.indexOf(chaves[k]) >= 0) { btn = btns[i]; break; }
      }
      if (btn) break;
    }

    if (!btn) {
      console.log('[DottiSlateHelper] dropdown de ordenacao nao encontrado');
      _dispatch('dotti-gallery-sort-result', { requestId: requestId, result: 'SEM_DROPDOWN', dump: _gDump(dlg) });
      return;
    }

    var atual = _gNorm(_gTxt(btn));
    if (atual.indexOf('antigo') >= 0 || atual.indexOf('oldest') >= 0) {
      console.log('[DottiSlateHelper] ja ordenado por mais antigo');
      _dispatch('dotti-gallery-sort-result', { requestId: requestId, result: 'JA_ANTIGO' });
      return;
    }

    console.log('[DottiSlateHelper] abrindo ordenacao:', _gTxt(btn));
    _pointerClick(btn);

    setTimeout(function() {
      var ops = document.querySelectorAll(
        '[role="menuitem"], [role="option"], [role="menuitemradio"], mat-option, button.mat-mdc-menu-item');
      var listadas = [], escolhida = null;
      for (var j = 0; j < ops.length; j++) {
        if (!_gVisivel(ops[j])) continue;
        var t = _gTxt(ops[j]);
        listadas.push(t);
        var n = _gNorm(t);
        if (!escolhida && (n.indexOf('antig') >= 0 || n.indexOf('oldest') >= 0)) escolhida = ops[j];
      }
      console.log('[DottiSlateHelper] opcoes de ordenacao:', listadas.join(' | '));

      if (!escolhida) {
        // Fecha o menu para nao deixar overlay aberto por cima da janela
        try { document.body.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); } catch (err) {}
        _dispatch('dotti-gallery-sort-result',
          { requestId: requestId, result: 'SEM_OPCAO_ANTIGO', opcoes: listadas });
        return;
      }

      console.log('[DottiSlateHelper] ordenando por:', _gTxt(escolhida));
      _pointerClick(escolhida);
      _dispatch('dotti-gallery-sort-result',
        { requestId: requestId, result: 'OK', opcoes: listadas, escolhida: _gTxt(escolhida) });
    }, 900);
  });

  // ------ dotti-gallery-list (snapshot dos titulos) ------
  document.addEventListener('dotti-gallery-list', function(e) {
    var requestId = (e.detail && e.detail.requestId) || '';
    var limite = (e.detail && e.detail.limite) || 300;
    var dlg = _gDialogo();
    if (!dlg) { _dispatch('dotti-gallery-list-result', { requestId: requestId, result: 'SEM_DIALOGO' }); return; }
    var itens = _gEnumerar(dlg, limite);
    var titulos = itens.map(function(i) { return i.titulo; });
    console.log('[DottiSlateHelper] itens na lista:', titulos.length);
    _dispatch('dotti-gallery-list-result',
      { requestId: requestId, result: titulos.length ? 'OK' : 'LISTA_VAZIA', titulos: titulos });
  });

  // ------ dotti-gallery-pick (achar por titulo, selecionar e INCLUIR) ------
  document.addEventListener('dotti-gallery-pick', function(e) {
    var requestId = (e.detail && e.detail.requestId) || '';
    var titulo = (e.detail && e.detail.titulo) || '';
    var alvo = _gNorm(titulo);

    var dlg = _gDialogo();
    if (!dlg) { _dispatch('dotti-gallery-pick-result', { requestId: requestId, result: 'SEM_DIALOGO' }); return; }
    if (!alvo) { _dispatch('dotti-gallery-pick-result', { requestId: requestId, result: 'SEM_TITULO' }); return; }

    var itens = _gEnumerar(dlg, 300);
    var linha = null;
    for (var i = 0; i < itens.length; i++) {
      if (_gNorm(itens[i].titulo) === alvo) { linha = itens[i]; break; }
    }
    // Titulo truncado com reticencias: casa por prefixo, nunca por semelhanca.
    if (!linha) {
      var base = alvo.replace(/[.…]+$/, '');
      if (base.length >= 8) {
        for (var p = 0; p < itens.length; p++) {
          var cand = _gNorm(itens[p].titulo).replace(/[.…]+$/, '');
          if (cand.indexOf(base) === 0 || base.indexOf(cand) === 0) { linha = itens[p]; break; }
        }
      }
    }

    if (!linha) {
      console.log('[DottiSlateHelper] titulo nao encontrado na lista:', titulo);
      _dispatch('dotti-gallery-pick-result', {
        requestId: requestId, result: 'TITULO_NAO_ENCONTRADO',
        titulos: itens.map(function(i) { return i.titulo; })
      });
      return;
    }

    _pointerClick(linha.el);

    // Esperar o botao de incluir ficar disponivel (ele so habilita com item selecionado)
    var orcamento = 4000;
    (function esperar() {
      var btn = _gBotaoConfirmar(dlg);
      if (btn && !_gDesabilitado(btn)) {
        console.log('[DottiSlateHelper] incluindo no comando:', linha.titulo.substring(0, 50));
        _pointerClick(btn);
        _dispatch('dotti-gallery-pick-result',
          { requestId: requestId, result: 'OK', titulo: linha.titulo, botao: _gTxt(btn) });
        return;
      }
      orcamento -= 250;
      if (orcamento <= 0) {
        console.log('[DottiSlateHelper] botao de incluir indisponivel');
        _dispatch('dotti-gallery-pick-result', {
          requestId: requestId,
          result: btn ? 'BOTAO_DESABILITADO' : 'SEM_BOTAO_INCLUIR',
          titulo: linha.titulo, dump: _gDump(dlg)
        });
        return;
      }
      setTimeout(esperar, 250);
    })();
  });

  // ------ dotti-gallery-dump (diagnostico; sai sozinho em qualquer falha) ------
  document.addEventListener('dotti-gallery-dump', function(e) {
    var requestId = (e.detail && e.detail.requestId) || '';
    var info = _gDump(_gDialogo());
    info.requestId = requestId;
    console.log('[DottiSlateHelper] DUMP da janela de recursos:', JSON.stringify(info));
    _dispatch('dotti-gallery-dump-result', info);
  });

  // ------ dotti-gallery-cancel (fechar sem incluir) ------
  document.addEventListener('dotti-gallery-cancel', function(e) {
    var requestId = (e.detail && e.detail.requestId) || '';
    var dlg = _gDialogo();
    if (!dlg) { _dispatch('dotti-gallery-cancel-result', { requestId: requestId, result: 'SEM_DIALOGO' }); return; }
    var btns = dlg.querySelectorAll('button');
    for (var i = 0; i < btns.length; i++) {
      var ic = btns[i].querySelector('mat-icon, i, span.material-icons, span.material-symbols-outlined');
      var t = ic ? _gTxt(ic) : '';
      if (t === 'close' || t === 'clear') {
        _pointerClick(btns[i]);
        _dispatch('dotti-gallery-cancel-result', { requestId: requestId, result: 'OK', via: t });
        return;
      }
    }
    try { document.body.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); } catch (err) {}
    _dispatch('dotti-gallery-cancel-result', { requestId: requestId, result: 'OK', via: 'escape' });
  });

  function _dispatch(eventName, detail) {
    document.dispatchEvent(new CustomEvent(eventName, { detail: detail }));
  }

  console.log('[DottiSlateHelper] v4.4.0 ativo (galeria por titulo)');
})();
