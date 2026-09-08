/**
 * Dotti Interceptor v3.0.0 - Runs in MAIN WORLD
 * Intercepts Flow APIs to capture video/image generation data:
 * 1. uploadUserImage (legacy) -> imageId
 * 2. uploadImage (new) -> media.name (mediaId)
 * 3. batchAsyncGenerateVideoText -> mediaId + prompt text + operationId
 * 4. batchCheckAsyncVideoGenerationStatus -> generation status (SUCCESSFUL/FAILED)
 * 5. batchGenerateImages -> image URLs + prompt
 * 6. upsampleImage -> upscaled image URL
 */
(function() {
  var _DOTTI_DEBUG = false;
  if (window._dottiInterceptorActive) return;
  window._dottiInterceptorActive = true;

  function extractImageId(b64) {
    try {
      while (b64.length % 4 !== 0) b64 += '=';
      var binary = atob(b64);
      var uuids = binary.match(/[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}/gi);
      if (uuids && uuids.length >= 2) return uuids[1];
      if (uuids && uuids.length === 1) return uuids[0];
      return null;
    } catch(e) { return null; }
  }

  // Legacy: uploadUserImage
  function processUploadResponse(responseText) {
    try {
      var data = JSON.parse(responseText);
      if (data && data.mediaGenerationId && data.mediaGenerationId.mediaGenerationId) {
        var imageId = extractImageId(data.mediaGenerationId.mediaGenerationId);
        if (imageId) {
          document.dispatchEvent(new CustomEvent('dotti-upload-result', {
            detail: { imageId: imageId, mediaGenerationId: data.mediaGenerationId.mediaGenerationId, source: 'uploadUserImage' }
          }));
        }
      }
    } catch(e) {}
  }

  // New: uploadImage -> response.media.name = UUID
  function processUploadImageResponse(responseText, httpStatus) {
    try {
      var data = JSON.parse(responseText);

      // Detecta erro de upload (400 Bad Request)
      if (data && data.error) {
        var reason = '';
        try {
          var details = data.error.details || [];
          for (var i = 0; i < details.length; i++) {
            if (details[i].reason) {
              reason = details[i].reason;
              break;
            }
          }
        } catch(e) {}

        // PROMINENT_PEOPLE_UPLOAD = imagem com pessoa famosa
        if (reason.indexOf('PROMINENT_PEOPLE') !== -1 ||
            (data.error.message || '').indexOf('prominent') !== -1) {
          document.dispatchEvent(new CustomEvent('dotti-upload-error', {
            detail: { error: 'PROMINENT_PEOPLE', reason: reason, message: data.error.message, source: 'uploadImage' }
          }));
          _DOTTI_DEBUG && console.log('[DottiInterceptor] uploadImage PROMINENT_PEOPLE error');
          return;
        }

        // Outros erros de upload
        document.dispatchEvent(new CustomEvent('dotti-upload-error', {
          detail: { error: 'UPLOAD_FAILED', reason: reason, message: data.error.message || data.error.status, source: 'uploadImage' }
        }));
        _DOTTI_DEBUG && console.log('[DottiInterceptor] uploadImage error:', reason || data.error.message);
        return;
      }

      if (data && data.media && data.media.name) {
        var mediaId = data.media.name;
        var fileName = '';
        try { fileName = data.workflow.metadata.displayName || ''; } catch(e) {}
        document.dispatchEvent(new CustomEvent('dotti-upload-result', {
          detail: { imageId: mediaId, fileName: fileName, source: 'uploadImage' }
        }));
        _DOTTI_DEBUG && console.log('[DottiInterceptor] uploadImage mediaId:', mediaId, 'file:', fileName);
      }
    } catch(e) {
      console.error('[DottiInterceptor] uploadImage parse error:', e);
    }
  }

  // v3.9.0: o titulo curto que o Flow gera para a midia. O tile do grid usa
  // exatamente esse texto no aria-label, entao ele e a CHAVE DE JUNCAO exata
  // entre o DOM e o mediaId — nao e mais preciso adivinhar por sobreposicao
  // de palavras (o titulo e uma parafrase do prompt, nunca casou direito).
  function _dottiTitulo(m) {
    var t = '';
    try { t = m.mediaMetadata.mediaTitle || ''; } catch(e) {}
    if (!t) try { t = m.mediaTitle || m.title || ''; } catch(e) {}
    if (!t) try { t = m.mediaMetadata.title || ''; } catch(e) {}
    if (!t) try { t = m.video.generatedVideo.title || ''; } catch(e) {}
    return String(t || '').trim();
  }

  // Segunda chave exata: a URL da miniatura. O tile tem <img class="thumbnail">
  // e, se a API devolver a mesma URL, o casamento e por igualdade de string.
  function _dottiThumb(m) {
    var u = '';
    try { u = m.mediaMetadata.thumbnailUrl || ''; } catch(e) {}
    if (!u) try { u = m.thumbnailUrl || m.fifeUrl || ''; } catch(e) {}
    if (!u) try { u = m.video.thumbnailUrl || m.video.fifeUrl || ''; } catch(e) {}
    if (!u) try { u = m.image.fifeUrl || ''; } catch(e) {}
    return String(u || '').trim();
  }

  function processVideoSubmitResponse(responseText) {
    try {
      var data = JSON.parse(responseText);
      if (!data) return;

      var entries = [];

      // Standard format: data.media array
      var mediaList = data.media || data.medias || [];
      if (!Array.isArray(mediaList)) mediaList = [];

      for (var i = 0; i < mediaList.length; i++) {
        var m = mediaList[i];
        if (!m) continue;

        // MediaId: try multiple paths
        var mediaId = m.name || m.mediaId || m.id || '';
        if (!mediaId && m.media) mediaId = m.media.name || m.media.mediaId || '';

        if (!mediaId) continue; // Skip if no mediaId found

        // Validate: must look like a UUID (avoid false positives)
        if (mediaId.length < 8 || mediaId.indexOf('-') === -1) continue;

        // Check if this is actually a video generation (not just an image upload)
        var hasVideoData = false;
        try { hasVideoData = !!m.video || !!m.mediaMetadata?.requestData?.videoGenerationRequestData; } catch(e) {}
        // Also accept if operations array exists (batch format)
        if (!hasVideoData && data.operations && data.operations.length > 0) hasVideoData = true;
        // Also accept if mediaStatus is PENDING (new generation)
        try { if (m.mediaMetadata?.mediaStatus?.mediaGenerationStatus === 'MEDIA_GENERATION_STATUS_PENDING') hasVideoData = true; } catch(e) {}

        if (!hasVideoData) continue; // Skip non-video media

        // Prompt: try multiple paths
        var prompt = '';
        try { prompt = m.mediaMetadata.requestData.promptInputs[0].structuredPrompt.parts[0].text || ''; } catch(e) {}
        if (!prompt) try { prompt = m.mediaMetadata.requestData.prompt || ''; } catch(e) {}
        if (!prompt) try { prompt = m.video?.generatedVideo?.prompt || ''; } catch(e) {}
        if (!prompt) try { prompt = m.prompt || m.text || ''; } catch(e) {}
        if (!prompt) try { prompt = m.mediaMetadata?.mediaTitle || ''; } catch(e) {}

        // OperationName: try multiple paths
        var opName = '';
        try { opName = m.video.operation.name || ''; } catch(e) {}
        if (!opName) try { opName = m.operation?.name || m.operationName || ''; } catch(e) {}
        if (!opName && data.operations) {
          for (var j = 0; j < data.operations.length; j++) {
            var op = data.operations[j];
            if (op && op.operation && op.operation.name === mediaId) {
              opName = mediaId;
              break;
            }
          }
        }

        entries.push({ mediaId: mediaId, prompt: prompt, operationName: opName,
                       title: _dottiTitulo(m), thumbUrl: _dottiThumb(m) });
        _DOTTI_DEBUG && console.log('[DottiInterceptor] VideoSubmit mediaId:', mediaId, 'prompt:', prompt.substring(0, 50));
      }

      // Fallback: single media at root level
      if (entries.length === 0 && data.name) {
        var rootPrompt = '';
        try { rootPrompt = data.mediaMetadata.requestData.promptInputs[0].structuredPrompt.parts[0].text || ''; } catch(e) {}
        if (!rootPrompt) try { rootPrompt = data.mediaMetadata?.mediaTitle || ''; } catch(e) {}

        // Validate it's a video generation
        var isVideo = false;
        try { isVideo = !!data.video || !!data.mediaMetadata?.requestData?.videoGenerationRequestData; } catch(e) {}
        if (!isVideo && data.operations) isVideo = true;
        try { if (data.mediaMetadata?.mediaStatus?.mediaGenerationStatus === 'MEDIA_GENERATION_STATUS_PENDING') isVideo = true; } catch(e) {}

        if (isVideo) {
          entries.push({ mediaId: data.name, prompt: rootPrompt, operationName: '',
                         title: _dottiTitulo(data), thumbUrl: _dottiThumb(data) });
          _DOTTI_DEBUG && console.log('[DottiInterceptor] VideoSubmit (root) mediaId:', data.name);
        }
      }

      if (entries.length > 0) {
        document.dispatchEvent(new CustomEvent('dotti-video-submitted', {
          detail: { media: entries, timestamp: Date.now() }
        }));
        _DOTTI_DEBUG && console.log('[DottiInterceptor] VideoSubmit dispatched:', entries.length, 'entries');
      }
    } catch(e) {
      console.error('[DottiInterceptor] VideoSubmit error:', e);
    }
  }

  function processVideoStatusResponse(responseText) {
    try {
      var data = JSON.parse(responseText);
      if (!data) return;

      var mediaList = data.media || data.medias || [];
      if (!Array.isArray(mediaList)) mediaList = [];

      var updates = [];
      for (var i = 0; i < mediaList.length; i++) {
        var m = mediaList[i];
        if (!m) continue;

        var mediaId = m.name || m.mediaId || m.id || '';
        if (!mediaId && m.media) mediaId = m.media.name || '';
        if (!mediaId) continue;

        var status = '';
        try { status = m.mediaMetadata.mediaStatus.mediaGenerationStatus || ''; } catch(e) {}
        if (!status) try { status = m.status || m.generationStatus || ''; } catch(e) {}

        if (status === 'MEDIA_GENERATION_STATUS_SUCCESSFUL' || status === 'COMPLETED' || status === 'SUCCESSFUL') {
          var prompt = '';
          try { prompt = m.mediaMetadata.requestData.promptInputs[0].structuredPrompt.parts[0].text || ''; } catch(e) {}
          updates.push({ mediaId: mediaId, status: 'COMPLETED', prompt: prompt,
                         title: _dottiTitulo(m), thumbUrl: _dottiThumb(m) });
        } else if (status === 'MEDIA_GENERATION_STATUS_FAILED' || status === 'FAILED') {
          var prompt2 = '';
          try { prompt2 = m.mediaMetadata.requestData.promptInputs[0].structuredPrompt.parts[0].text || ''; } catch(e) {}
          updates.push({ mediaId: mediaId, status: 'FAILED', prompt: prompt2,
                         title: _dottiTitulo(m), thumbUrl: _dottiThumb(m) });
        }
      }

      if (updates.length > 0) {
        document.dispatchEvent(new CustomEvent('dotti-video-status', {
          detail: { updates: updates, timestamp: Date.now() }
        }));
      }
    } catch(e) {}
  }

  // Process batchGenerateImages response (text-to-image)
  function processImageGenerateResponse(responseText) {
    try {
      var data = JSON.parse(responseText);
      if (!data || !data.media) return;

      var results = [];
      for (var i = 0; i < data.media.length; i++) {
        var m = data.media[i];
        if (m && m.image && m.image.generatedImage) {
          var gen = m.image.generatedImage;
          var prompt = '';
          if (gen.requestData && gen.requestData.promptInputs && gen.requestData.promptInputs[0]) {
            prompt = gen.requestData.promptInputs[0].textInput || '';
          }
          if (!prompt) prompt = gen.prompt || '';

          results.push({
            mediaId: m.name,
            prompt: prompt,
            imageUrl: gen.fifeUrl || '',
            seed: gen.seed,
            model: gen.modelNameType || '',
            width: m.image.dimensions ? m.image.dimensions.width : 0,
            height: m.image.dimensions ? m.image.dimensions.height : 0
          });
        }
      }

      if (results.length > 0) {
        _DOTTI_DEBUG && console.log('[DottiInterceptor] batchGenerateImages:', results.length, 'imagens');
        document.dispatchEvent(new CustomEvent('dotti-image-generated', {
          detail: { images: results }
        }));
      }
    } catch (e) {
      console.error('[DottiInterceptor] Erro ao processar batchGenerateImages:', e);
    }
  }

  // Process upsampleImage response (upscale)
  function processImageUpscaleResponse(responseText) {
    try {
      var data = JSON.parse(responseText);
      if (data && data.image && data.image.fifeUrl) {
        _DOTTI_DEBUG && console.log('[DottiInterceptor] upsampleImage:', data.image.fifeUrl.substring(0, 80));
        document.dispatchEvent(new CustomEvent('dotti-image-upscaled', {
          detail: {
            imageUrl: data.image.fifeUrl,
            width: data.image.dimensions ? data.image.dimensions.width : 0,
            height: data.image.dimensions ? data.image.dimensions.height : 0
          }
        }));
      }
    } catch (e) {
      console.error('[DottiInterceptor] Erro ao processar upsampleImage:', e);
    }
  }

  function shouldIntercept(url) {
    var isVideoSubmit =
      url.indexOf('batchAsyncGenerateVideoText') !== -1 ||
      url.indexOf('batchAsyncGenerateVideoStartImage') !== -1 ||
      url.indexOf('batchAsyncGenerateVideoReferenceImages') !== -1 ||
      url.indexOf('batchAsyncGenerateVideo') !== -1 ||
      url.indexOf('asyncGenerateVideo') !== -1 ||
      url.indexOf('generateVideo') !== -1 ||
      url.indexOf('createWorkflow') !== -1 ||
      url.indexOf('media.generate') !== -1;

    // Exclui status check e upload do videoSubmit
    if (url.indexOf('batchCheckAsync') !== -1) isVideoSubmit = false;
    if (url.indexOf('uploadImage') !== -1) isVideoSubmit = false;
    if (url.indexOf('getMediaUrl') !== -1) isVideoSubmit = false;

    var isVideoStatus =
      url.indexOf('batchCheckAsyncVideoGenerationStatus') !== -1 ||
      url.indexOf('checkAsyncVideoGeneration') !== -1 ||
      url.indexOf('batchCheckAsync') !== -1;

    return {
      uploadUserImage: url.indexOf('uploadUserImage') !== -1,
      uploadImage: url.indexOf('/uploadImage') !== -1 && url.indexOf('uploadUserImage') === -1,
      videoSubmit: isVideoSubmit,
      videoStatus: isVideoStatus,
      // v3.9.3: o Flow passou a enviar por batchexecute (RPC do Angular). Os
      // endpoints REST antigos nao existem mais, entao o _mediaTracker ficava
      // VAZIO e todo media-fetch caia em "id sem prompt conhecido". A resposta
      // do batchexecute carrega o uuid da midia recem-criada.
      rpc: url.indexOf('batchexecute') !== -1,
      imageGenerate: url.indexOf('batchGenerateImages') !== -1,
      imageUpscale: url.indexOf('upsampleImage') !== -1,
      // v3.8.0: quando a pagina busca a midia PELO ID (ao montar o blob do
      // download), a URL carrega ?name=<mediaId>. E a identidade exata do
      // video que esta prestes a ser baixado.
      // v3.9.0: alargado. Antes exigia 'getMediaUrl' e o evento NUNCA disparou
      // (zero linhas 'media-fetch' no log dela) — a pagina monta o blob por
      // outra rota. Agora emite para qualquer URL que carregue um id de midia;
      // quem filtra e o content.js, contra o _mediaTracker.
      mediaFetch: _DOTTI_RE_ID.test(url) || _DOTTI_RE_UUID_PATH.test(url)
    };
  }

  // ============================================================
  // v4.0.0 — batchexecute: a API de verdade do Flow novo
  // ============================================================
  // Capturado por ela no trafego real. Tres RPCs importam:
  //   YhhmEf  envio   REQ: nosso texto ("PROMPT NNN")  RES: uuids da midia
  //   jwpduf  status  REQ: mediaId                     RES: [2] gerando / [3] pronto
  //   as29s   URL     REQ: mediaId                     RES: URL assinada do MP4
  // Nada disso passava pelo interceptor porque ele procurava endpoints REST que
  // nao existem mais — por isso "[Dotti] API: video-submitted" nunca aparecia.

  var _DOTTI_RE_UUID_TODOS = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi;
  var _DOTTI_RE_PROMPT_NUM = /PROMPT\s*0*(\d+)/i;

  // Token de sessao das requisicoes (at=...). Guardado para podermos chamar o
  // as29s por conta propria, sem depender de a pagina pedir a URL.
  var _dottiAtToken = null;
  function _dottiGuardarAt(corpo) {
    try {
      var m = String(corpo || '').match(/(?:^|&)at=([^&]+)/);
      if (m) _dottiAtToken = decodeURIComponent(m[1]);
    } catch (e) {}
  }

  // O corpo de saida pode ser string, URLSearchParams ou FormData.
  function _dottiCorpoComoTexto(body) {
    try {
      if (!body) return '';
      if (typeof body === 'string') return body;
      if (typeof URLSearchParams !== 'undefined' && body instanceof URLSearchParams) return body.toString();
      if (typeof FormData !== 'undefined' && body instanceof FormData) {
        var partes = [];
        body.forEach(function (v, k) { partes.push(encodeURIComponent(k) + '=' + encodeURIComponent(String(v))); });
        return partes.join('&');
      }
      return String(body);
    } catch (e) { return ''; }
  }

  // v4.1.0 — ARGUMENTOS POR RPC.
  // O batchexecute empacota VARIOS RPCs numa requisicao so:
  //   f.req = [[[rpc1, "<args1>", null, "generic"], [rpc2, "<args2>", ...]]]
  // e a query lista todos em rpcids=a,b,c. A v4.0.0 lia os uuid do CORPO
  // INTEIRO, entao pegava os argumentos de qualquer RPC que viajasse junto —
  // inclusive a listagem do projeto. Era dai que saiam os "8 novos ao mesmo
  // tempo" e os conflitos falsos recarimbando os mesmos mediaId.
  function _dottiArgsDoRpc(corpoReq, rpcid) {
    try {
      var txt = String(corpoReq || '');
      var m = txt.match(/(?:^|&)f\.req=([^&]*)/);
      if (!m) return null;
      var freq = JSON.parse(decodeURIComponent(m[1].replace(/\+/g, ' ')));
      var achado = null;
      (function visitar(no) {
        if (achado !== null || !Array.isArray(no)) return;
        if (no[0] === rpcid && typeof no[1] === 'string') { achado = no[1]; return; }
        for (var i = 0; i < no.length; i++) visitar(no[i]);
      })(freq);
      return achado;
    } catch (e) { return null; }
  }

  function _dottiRpcIds(url) {
    try {
      var m = String(url || '').match(/[?&]rpcids=([^&]+)/);
      return m ? decodeURIComponent(m[1]).split(',') : [];
    } catch (e) { return []; }
  }

  // A resposta vem com o prefixo )]}' e em blocos precedidos pela contagem de
  // bytes. Em vez de fatiar por tamanho (fragil), varremos linha a linha e
  // parseamos o que for JSON valido.
  function _dottiBlocosDaResposta(texto) {
    var out = [];
    var t = String(texto || '').replace(/^\)\]\}'\s*/, '');
    var linhas = t.split('\n');
    for (var i = 0; i < linhas.length; i++) {
      var l = linhas[i].trim();
      if (!l || /^\d+$/.test(l)) continue;   // linha de contagem de bytes
      try { out.push(JSON.parse(l)); } catch (e) { }
    }
    return out;
  }

  // O payload util de cada envelope ["wrb.fr", rpcid, "<json>"] e uma STRING
  // JSON que precisa ser parseada de novo. Devolve o texto cru concatenado
  // (para regex) e os objetos parseados.
  function _dottiPayloadsDoRpc(blocos, rpcid) {
    var textos = [];
    function visitar(no) {
      if (!no) return;
      if (Array.isArray(no)) {
        if (no[0] === 'wrb.fr' && no[1] === rpcid && typeof no[2] === 'string') {
          textos.push(no[2]);
        }
        for (var i = 0; i < no.length; i++) visitar(no[i]);
      }
    }
    for (var b = 0; b < blocos.length; b++) visitar(blocos[b]);
    return textos;
  }

  function _dottiUuidsDe(texto) {
    var achados = String(texto || '').match(_DOTTI_RE_UUID_TODOS) || [];
    var unicos = [];
    for (var i = 0; i < achados.length; i++) {
      var u = achados[i].toLowerCase();
      if (unicos.indexOf(u) === -1) unicos.push(u);
    }
    return unicos;
  }

  // Estado do jwpduf. NAO indexamos por posicao: procuramos o numero que
  // acompanha o mediaId dentro da estrutura ja parseada.
  function _dottiEstadoDoStatus(payloadTexto) {
    try {
      var dados = JSON.parse(payloadTexto);
      var encontrado = null;
      (function visitar(no) {
        if (encontrado !== null || !Array.isArray(no)) return;
        // padrao observado: [..., <estado>, ...] com estado numerico pequeno
        for (var i = 0; i < no.length; i++) {
          var v = no[i];
          if (typeof v === 'number' && v >= 1 && v <= 9) {
            if (encontrado === null) encontrado = v;
          } else if (Array.isArray(v)) visitar(v);
        }
      })(dados);
      return encontrado;
    } catch (e) { return null; }
  }

  // v4.1.0: jwpduf desligado para amarracao E para status. No log dela ele
  // produzia "status desconhecido: 1" para toda midia e conflitos falsos,
  // porque o estado era o primeiro numero 1-9 encontrado em qualquer lugar do
  // payload e o PROMPT NNN vinha do payload inteiro (uma listagem traz o texto
  // de TODOS os prompts). Nao se interpreta campo numerico sem saber de qual
  // RPC veio e onde ele fica.
  var _DOTTI_USAR_JWPDUF = false;

  function _dottiProcessarRpc(url, corpoReq, textoResp) {
    var ids = _dottiRpcIds(url);
    if (!ids.length) return;
    _dottiGuardarAt(corpoReq);

    var blocos = _dottiBlocosDaResposta(textoResp);

    // ---- URL ASSINADA (as29s) — fonte unica de identidade e de "pronto" ----
    // No log dela acerta 100%: mediaId no argumento, o MESMO mediaId no caminho
    // da URL da resposta. Nao ha como errar.
    if (ids.indexOf('as29s') !== -1) {
      var argsUrl = _dottiArgsDoRpc(corpoReq, 'as29s');
      var idsUrl = _dottiUuidsDe(argsUrl || '');
      var plUrl = _dottiPayloadsDoRpc(blocos, 'as29s').join(' ');
      var mVideo = plUrl.match(/https:\/\/flow-content\.google\/video\/[^"'\\\s]+/);
      var mNumUrl = plUrl.match(_DOTTI_RE_PROMPT_NUM);
      console.log('[Dotti] rpc=as29s midias=' + idsUrl.length +
        (mNumUrl ? ' prompt=#' + mNumUrl[1] : ' prompt=?') +
        (mVideo ? ' url=sim' : ' url=nao'));
      if (mVideo) {
        document.dispatchEvent(new CustomEvent('dotti-flow-url', {
          detail: {
            mediaId: idsUrl[0] || null,
            url: mVideo[0],
            promptNumber: mNumUrl ? Number(mNumUrl[1]) : null
          }
        }));
      }
    }

    // ---- ENVIO (YhhmEf) — apenas OBSERVACAO por enquanto ----
    // Com a extracao por RPC corrigida ele deve devolver UMA midia por envio.
    // Enquanto o proximo log nao confirmar isso, ele nao amarra nada: voltar a
    // confiar antes da confirmacao seria repetir o erro deste adendo.
    if (ids.indexOf('YhhmEf') !== -1) {
      var argsEnvio = _dottiArgsDoRpc(corpoReq, 'YhhmEf') || '';
      var mNum = argsEnvio.match(_DOTTI_RE_PROMPT_NUM);
      var uuidsEnvio = _dottiUuidsDe(_dottiPayloadsDoRpc(blocos, 'YhhmEf').join(' '));
      console.log('[Dotti] rpc=YhhmEf midias=' + uuidsEnvio.length +
        (mNum ? ' prompt=#' + mNum[1] : ' prompt=?') + ' (observacao)');
      document.dispatchEvent(new CustomEvent('dotti-flow-envio', {
        detail: {
          promptNumber: mNum ? Number(mNum[1]) : null,
          uuids: uuidsEnvio,
          observacao: true
        }
      }));
    }

    // ---- STATUS (jwpduf) — desligado ----
    if (_DOTTI_USAR_JWPDUF && ids.indexOf('jwpduf') !== -1) {
      var argsSt = _dottiArgsDoRpc(corpoReq, 'jwpduf');
      var idsReq = _dottiUuidsDe(argsSt || '');
      var pl = _dottiPayloadsDoRpc(blocos, 'jwpduf');
      console.log('[Dotti] rpc=jwpduf midias=' + idsReq.length);
      for (var i = 0; i < idsReq.length; i++) {
        document.dispatchEvent(new CustomEvent('dotti-flow-status', {
          detail: { mediaId: idsReq[i], estado: _dottiEstadoDoStatus(pl[0] || 'null') }
        }));
      }
    }
  }

  // Pedir a URL assinada por conta propria (Ajuste dela: da PAGINA, nao do
  // service worker — aqui a chamada sai identica as que o Flow ja faz, com
  // sessao, cookies e headers no lugar).
  document.addEventListener('dotti-pedir-url', function (ev) {
    var mediaId = ev && ev.detail && ev.detail.mediaId;
    if (!mediaId) return;
    try {
      var base = location.origin +
        '/_/AiSandboxAngularFrontend/data/batchexecute?rpcids=as29s&source-path=' +
        encodeURIComponent(location.pathname);
      var freq = JSON.stringify([[['as29s', JSON.stringify([mediaId]), null, 'generic']]]);
      var corpo = 'f.req=' + encodeURIComponent(freq) +
        (_dottiAtToken ? '&at=' + encodeURIComponent(_dottiAtToken) : '');
      origFetch(base, {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded;charset=UTF-8' },
        body: corpo
      }).then(function (r) { return r.text(); }).then(function (txt) {
        _dottiProcessarRpc(base, corpo, txt);
      }).catch(function (e) {
        console.warn('[DottiInterceptor] as29s falhou:', e && e.message);
        document.dispatchEvent(new CustomEvent('dotti-flow-url', {
          detail: { mediaId: mediaId, url: null, erro: String(e && e.message || e) }
        }));
      });
    } catch (e) {
      console.warn('[DottiInterceptor] as29s erro ao montar:', e && e.message);
    }
  });

  // Qualquer parametro que carregue um id de midia. Deliberadamente amplo:
  // e o content.js que decide se o id e conhecido.
  var _DOTTI_RE_ID = /[?&](?:name|mediaKey|mediaId|id)=[A-Za-z0-9_.:-]{8,}/;

  // v3.9.2: o id da midia tambem vem no CAMINHO, nao so na query. Foi por isso
  // que o dotti-media-fetch nunca disparou: o regex acima exigia ?name=... e a
  // URL real do download e
  //     https://flow-content.google/video/<uuid>?Expires=...
  // Conferido em quatro pares do log dela: o uuid que aparece logo depois do
  // envio de um prompt e exatamente o uuid que a pagina busca ao baixar aquele
  // video. E a identidade exata que faltava.
  var _DOTTI_RE_UUID_PATH = /\/(?:video|media|image)\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/i;

  // Janela de diagnostico: enquanto ativa, loga as URLs vistas. O content.js
  // liga isso em volta do clique de download, para o proximo log dizer de vez
  // qual e a rota que monta o blob (em vez de eu chutar de novo).
  var _dottiLogAte = 0;
  document.addEventListener('dotti-log-urls', function (e) {
    var ms = (e && e.detail && e.detail.ms) || 8000;
    _dottiLogAte = Date.now() + ms;
  });
  function _dottiTalvezLogar(url) {
    if (Date.now() > _dottiLogAte) return;
    console.log('[DottiInterceptor][URL]', String(url || '').substring(0, 160));
  }

  // v3.9.3: despeja os uuid encontrados numa resposta de RPC. Quem decide o que
  // fazer com eles e o content.js, que sabe qual prompt acabou de ser enviado.
  var _DOTTI_RE_UUID_G = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi;
  // v4.1.0: resquicio da correlacao temporal do ADENDO 17. Desligado — era a
  // origem das linhas "N novos ao mesmo tempo", que despejavam os uuid de
  // QUALQUER resposta de batchexecute (listagem do projeto inclusive).
  var _DOTTI_EMITIR_UUIDS_LEGADO = false;

  function _dottiEmitUuids(texto) {
    if (!_DOTTI_EMITIR_UUIDS_LEGADO) return;
    try {
      var achados = String(texto || '').match(_DOTTI_RE_UUID_G);
      if (!achados || !achados.length) return;
      var unicos = [];
      for (var i = 0; i < achados.length; i++) {
        var u = achados[i].toLowerCase();
        if (unicos.indexOf(u) === -1) unicos.push(u);
      }
      document.dispatchEvent(new CustomEvent('dotti-uuids', {
        detail: { uuids: unicos, timestamp: Date.now() }
      }));
    } catch (e) {}
  }

  // Segunda fonte, de graca: o Angular estoura "pe`<uuid>" logo apos o envio.
  window.addEventListener('unhandledrejection', function (ev) {
    try {
      var msg = (ev && ev.reason && (ev.reason.message || String(ev.reason))) || '';
      var m = String(msg).match(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i);
      if (m) document.dispatchEvent(new CustomEvent('dotti-uuids', {
        detail: { uuids: [m[0].toLowerCase()], timestamp: Date.now(), fonte: 'erro' }
      }));
    } catch (e) {}
  });

  // v3.8.0: emite o mediaId da midia que a pagina esta buscando. Disparado
  // ANTES da resposta chegar, de proposito: o download em blob nasce depois
  // desse fetch, entao o content.js tem tempo de registrar o nome exato.
  function _dottiEmitMediaFetch(url) {
    try {
      var u = String(url || '');
      var m = u.match(/[?&](?:name|mediaKey|mediaId|id)=([^&]+)/) || u.match(_DOTTI_RE_UUID_PATH);
      if (!m) return;
      var mediaId = decodeURIComponent(m[1]);
      document.dispatchEvent(new CustomEvent('dotti-media-fetch', {
        detail: { mediaId: mediaId, url: String(url).substring(0, 200), timestamp: Date.now() }
      }));
      _DOTTI_DEBUG && console.log('[DottiInterceptor] media-fetch mediaId:', mediaId.substring(0, 12));
    } catch (e) {}
  }

  // Intercept XMLHttpRequest
  var origOpen = XMLHttpRequest.prototype.open;
  var origSend = XMLHttpRequest.prototype.send;
  XMLHttpRequest.prototype.open = function(method, url) { this._dottiUrl = url; return origOpen.apply(this, arguments); };
  XMLHttpRequest.prototype.send = function(body) {
    var url = this._dottiUrl || '';
    var checks = shouldIntercept(url);
    _dottiTalvezLogar(url);
    if (checks.mediaFetch) _dottiEmitMediaFetch(url);
    if (checks.uploadUserImage) this.addEventListener('load', function() { processUploadResponse(this.responseText); });
    if (checks.uploadImage) this.addEventListener('load', function() {
      _DOTTI_DEBUG && console.log('[DottiInterceptor][XHR] uploadImage response, status:', this.status, 'url:', (this._dottiUrl||'').substring(0, 80));
      processUploadImageResponse(this.responseText);
    });
    if (checks.uploadImage) this.addEventListener('error', function() {
      _DOTTI_DEBUG && console.log('[DottiInterceptor][XHR] uploadImage ERROR event, status:', this.status);
      document.dispatchEvent(new CustomEvent('dotti-upload-error', {
        detail: { error: 'UPLOAD_FAILED', reason: 'XHR error', message: 'Request failed', source: 'uploadImage' }
      }));
    });
    if (checks.videoSubmit) this.addEventListener('load', function() {
      // v3.1.0: HTTP 400 dispatch para recovery
      if (this.status === 400 && url.indexOf('batchAsyncGenerateVideoText') !== -1) {
        document.dispatchEvent(new CustomEvent('dotti-video-submit-error', {
          detail: { httpStatus: this.status, url: url }
        }));
      }
      processVideoSubmitResponse(this.responseText);
    });
    if (checks.videoStatus) this.addEventListener('load', function() { processVideoStatusResponse(this.responseText); });
    if (checks.rpc) {
        // v4.0.0: o ENVIO e XHR (nao fetch). Guardamos o corpo da requisicao
        // porque e nele que esta o nosso "PROMPT NNN".
        var _corpoReq = _dottiCorpoComoTexto(body);
        var _urlReq = url;
        this.addEventListener('load', function () {
            try { _dottiProcessarRpc(_urlReq, _corpoReq, this.responseText); }
            catch (e) { console.warn('[DottiInterceptor] rpc XHR erro:', e && e.message); }
            _dottiEmitUuids(this.responseText);   // legado, atras da flag do content
        });
    }
    if (checks.imageGenerate) this.addEventListener('load', function() {
      if (this.status >= 200 && this.status < 300) processImageGenerateResponse(this.responseText);
      else _DOTTI_DEBUG && console.log('[DottiInterceptor] batchGenerateImages HTTP', this.status);
    });
    if (checks.imageUpscale) this.addEventListener('load', function() { processImageUpscaleResponse(this.responseText); });
    if (_DOTTI_DEBUG && (url.indexOf('video') !== -1 || url.indexOf('Video') !== -1 || url.indexOf('generate') !== -1 || url.indexOf('Generate') !== -1 || url.indexOf('workflow') !== -1)) {
      var self = this;
      this.addEventListener('load', function() {
        console.log('[DottiInterceptor][XHR-DEBUG] URL:', url.substring(0, 120), 'matched:', JSON.stringify(checks));
      });
    }
    return origSend.apply(this, arguments);
  };

  // Intercept fetch
  var origFetch = window.fetch;
  window.fetch = function() {
    var url = typeof arguments[0] === 'string' ? arguments[0] : (arguments[0] && arguments[0].url || '');
    var p = origFetch.apply(this, arguments);
    var checks = shouldIntercept(url);
    _dottiTalvezLogar(url);
    if (checks.mediaFetch) _dottiEmitMediaFetch(url);
    if (checks.uploadUserImage) p.then(function(r) { r.clone().text().then(processUploadResponse).catch(function(){}); }).catch(function(){});
    if (checks.uploadImage) p.then(function(r) {
      _DOTTI_DEBUG && console.log('[DottiInterceptor][FETCH] uploadImage response, status:', r.status, 'url:', url.substring(0, 80));
      r.clone().text().then(function(text) {
        processUploadImageResponse(text);
      }).catch(function(e) { console.error('[DottiInterceptor][FETCH] uploadImage text error:', e); });
    }).catch(function(e) {
      console.error('[DottiInterceptor][FETCH] uploadImage fetch error:', e);
      document.dispatchEvent(new CustomEvent('dotti-upload-error', {
        detail: { error: 'UPLOAD_FAILED', reason: 'fetch error', message: String(e), source: 'uploadImage' }
      }));
    });
    if (checks.videoSubmit) p.then(function(r) {
      // v3.1.0: HTTP 400 dispatch para recovery
      if (r.status === 400 && url.indexOf('batchAsyncGenerateVideoText') !== -1) {
        document.dispatchEvent(new CustomEvent('dotti-video-submit-error', {
          detail: { httpStatus: r.status, url: url }
        }));
      }
      r.clone().text().then(processVideoSubmitResponse).catch(function(){});
    }).catch(function(){});
    if (checks.videoStatus) p.then(function(r) { r.clone().text().then(processVideoStatusResponse).catch(function(){}); }).catch(function(){});
    if (checks.rpc) {
        var _corpoF = _dottiCorpoComoTexto(arguments[1] && arguments[1].body);
        var _urlF = url;
        p.then(function (r) {
            r.clone().text().then(function (txt) {
                try { _dottiProcessarRpc(_urlF, _corpoF, txt); }
                catch (e) { console.warn('[DottiInterceptor] rpc fetch erro:', e && e.message); }
                _dottiEmitUuids(txt);
            }).catch(function () { });
        }).catch(function () { });
    }
    if (checks.imageGenerate) p.then(function(r) {
      if (r.ok) r.clone().text().then(processImageGenerateResponse).catch(function(){});
      else _DOTTI_DEBUG && console.log('[DottiInterceptor] batchGenerateImages HTTP', r.status);
    }).catch(function(){});
    if (checks.imageUpscale) p.then(function(r) { r.clone().text().then(processImageUpscaleResponse).catch(function(){}); }).catch(function(){});
    if (_DOTTI_DEBUG && (url.indexOf('video') !== -1 || url.indexOf('Video') !== -1 || url.indexOf('generate') !== -1 || url.indexOf('Generate') !== -1 || url.indexOf('workflow') !== -1)) {
      console.log('[DottiInterceptor][FETCH-DEBUG] URL:', url.substring(0, 120), 'matched:', JSON.stringify(checks));
    }
    return p;
  };

  console.log('[DottiInterceptor] v4.1.0 ativo (as29s como fonte)');
})();
