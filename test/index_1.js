
    const uiText = {
      taskTitleDefault: '今天的詩詞任務',
      taskDescDefault: '跟著小書僮一起完成挑戰吧！',
      mascotBubbleDefault: '你好呀！今天想先問我，還是讓我考考你呢？',
      bubbles: {
        ask: '你可以問我作者、意思、情緒，也可以直接說給我聽。',
        quiz: '換我來出題囉！選出你覺得最正確的答案吧！',
        image: '把圖片拿給我看，我來幫你配一首詩。',
        reading: '請朗讀一首詩，我會幫你看看音量和語速。',
        emotion: '讓我看看你的表情，我來幫你配一首適合心情的詩。',
        listening: '我正在聽你說喔。',
        thinking: '我想一想……',
        encouraging: '你做得很好，我們一起繼續！',
        hinting: '別急，我給你一個小提示。',
        comforting: '沒關係，我陪你慢慢來。'
      },
      mascotStates: {
        idle: '待機中',
        listening: '正在聆聽',
        thinking: '正在思考',
        speaking: '正在回答',
        questioning: '正在出題',
        encouraging: '正在鼓勵你',
        hinting: '正在提醒你',
        comforting: '正在陪伴你'
      }
    };

    const TM_IMAGE_EMBEDDED_MODEL_ID = '89PqqqYf8';

    const state = {
      mode: 'ask',
      engineReady: false,
      selectedImageFile: null,
      lastAnswerText: '',
      lastQuizQuestion: '',
      lastImageText: '',
      lastEmotionText: '',
      activePoem: null,
      activePoemByMode: { ask: null, quiz: null, image: null, emotion: null },
      readingPoemOptions: [],
      readingSelectedKey: '',
      conversationLog: [],
      audioUnlocked: false,
      ttsCache: new Map(),
      ttsQuotaExceeded: false,
      ttsDisabledReason: ''
    };

    const $ = id => document.getElementById(id);
    const modePanels = {
      ask: $('panel-mode-ask'),
      quiz: $('panel-mode-quiz'),
      image: $('panel-mode-image'),
      reading: $('panel-mode-reading'),
      emotion: $('panel-mode-emotion')
    };
    const engineFrame = $('engineFrame');
    let engineWin = null;
    let engineDoc = null;

    function escapeHtml(str='') {
      return str.replace(/[&<>"]/g, s => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[s]));
    }

    function getEngine() {
      if (!engineFrame.contentWindow) return null;
      engineWin = engineFrame.contentWindow;
      try { engineDoc = engineWin.document; } catch (_) { engineDoc = null; }
      return engineWin;
    }

    async function withEngine(cb, { rethrow = false } = {}) {
      const eng = getEngine();
      if (!eng || !engineDoc) {
        if (rethrow) throw new Error('多模態引擎尚未就緒');
        return null;
      }
      try {
        return await cb(eng, engineDoc);
      } catch (err) {
        console.error(err);
        if (rethrow) throw err;
        return null;
      }
    }

    async function withEngineStrict(cb) {
      return await withEngine(cb, { rethrow: true });
    }

    async function getBridgeState() {
      return await withEngine((eng) => typeof eng.getFrontBridgeState === 'function' ? eng.getFrontBridgeState() : null);
    }

    function setMascotState(key='idle', bubble='') {
      $('status-mascot-state').textContent = uiText.mascotStates[key] || uiText.mascotStates.idle;
      $('text-mascot-bubble').textContent = bubble || uiText.bubbles[state.mode] || uiText.mascotBubbleDefault;
    }

    function setMode(mode) {
      state.mode = mode;
      const modeNameMap = { ask:'問問公仔', quiz:'AI考考我', image:'看圖猜詩', reading:'朗讀練習', emotion:'心情配詩' };
      $('text-current-mode').textContent = `目前模式：${modeNameMap[mode]}`;
      Object.entries(modePanels).forEach(([key, el]) => el.classList.toggle('hidden', key !== mode));
      [...document.querySelectorAll('.mode-tab')].forEach(btn => btn.classList.remove('active'));
      $(`tab-mode-${mode}`).classList.add('active');
      setMascotState('idle', uiText.bubbles[mode]);
      if (mode === 'image') syncImage();
      if (mode === 'emotion') syncEmotion();
      if (mode === 'reading') syncReading();
      if (mode === 'quiz') syncQuiz();
      if (mode === 'ask') syncAsk();
    }

    function renderPoemMeta(prefix, poem) {
      $(`text-${prefix}-poem-title`).textContent = poem?.name || '—';
      $(`text-${prefix}-poem-objects`).textContent = Array.isArray(poem?.items) && poem.items.length ? poem.items.join('、') : '—';
      $(`text-${prefix}-poem-emotion`).textContent = Array.isArray(poem?.emotions) && poem.emotions.length ? poem.emotions.join('、') : '—';
    }

    function renderReadingPoemDetail(poem) {
      if (!poem) return '請先在看圖猜詩或心情配詩取得推薦詩詞。';
      const title = escapeHtml(poem.name || '未命名');
      const author = escapeHtml(poem.author || '未提供');
      const genre = escapeHtml(poem.genre || '未提供');
      const content = escapeHtml(poem.content || '目前詩詞資料裡沒有完整詩句內容。').replace(/\n/g, '<br>');
      const appreciation = escapeHtml(poem.appreciation || '目前詩詞資料裡沒有賞析內容。').replace(/\n/g, '<br>');
      return `
        <div style="display:grid;gap:12px;">
          <div><strong>詩名：</strong>${title}</div>
          <div><strong>作者：</strong>${author}</div>
          <div><strong>詩詞體裁：</strong>${genre}</div>
          <div>
            <strong>本文：</strong>
            <div style="margin-top:6px;white-space:pre-line;line-height:1.9;">${content}</div>
          </div>
          <div>
            <strong>賞析：</strong>
            <div style="margin-top:6px;white-space:pre-line;line-height:1.9;">${appreciation}</div>
          </div>
        </div>
      `;
    }

    function poemKey(poem) {
      return poem ? `${poem.name || ''}__${poem.author || ''}` : '';
    }

    function appendConversationLog(role='assistant', text='') {
      const clean = stripSpeechDecorations(text || '').trim();
      if (!clean) return;
      const key = `${role}::${clean}`;
      const last = state.conversationLog[state.conversationLog.length - 1];
      if (last && last.key === key) return;
      state.conversationLog.push({ role, text: clean, key });
      if (state.conversationLog.length > 18) state.conversationLog = state.conversationLog.slice(-18);
      renderConversationLog();
    }

    function renderConversationLog() {
      const box = $('text-mascot-log');
      if (!box) return;
      if (!state.conversationLog.length) {
        box.innerHTML = '<div class="helper-text">你說的話和公仔的回應，會記錄在這裡。</div>';
        return;
      }
      box.innerHTML = state.conversationLog.map(item => {
        const label = item.role === 'user' ? '你' : '公仔';
        const bg = item.role === 'user' ? 'var(--primary-weak)' : 'var(--soft-yellow)';
        const color = item.role === 'user' ? 'var(--primary)' : 'var(--text)';
        return `<div style="padding:10px 12px;border-radius:14px;background:${bg};border:1px solid var(--line);">
          <div style="font-size:0.82rem;font-weight:700;color:${color};margin-bottom:4px;">${label}</div>
          <div style="white-space:pre-wrap;line-height:1.7;">${escapeHtml(item.text)}</div>
        </div>`;
      }).join('');
      box.scrollTop = box.scrollHeight;
    }

    function uniquePoems(list=[]) {
      const out = [];
      const seen = new Set();
      list.forEach(poem => {
        if (!poem || !poem.name) return;
        const key = poemKey(poem);
        if (seen.has(key)) return;
        seen.add(key);
        out.push(poem);
      });
      return out;
    }

    function renderReadingPoemOptions(bridge=null) {
      const imagePoems = Array.isArray(bridge?.imageMatchedPoems) ? bridge.imageMatchedPoems : [];
      const emotionPoems = Array.isArray(bridge?.emotionMatchedPoems) ? bridge.emotionMatchedPoems : [];
      const candidates = uniquePoems([
        ...imagePoems,
        ...emotionPoems,
        state.activePoemByMode.image,
        state.activePoemByMode.emotion,
        state.activePoem,
        state.activePoemByMode.ask,
        state.activePoemByMode.quiz
      ].filter(Boolean));
      state.readingPoemOptions = candidates;
      const select = $('select-reading-poem');
      select.innerHTML = '';
      if (!candidates.length) {
        const opt = document.createElement('option');
        opt.value = '';
        opt.textContent = '目前尚未有推薦詩詞';
        select.appendChild(opt);
        select.disabled = true;
        $('text-reading-poem-source').textContent = '目前尚未收到推薦詩詞。';
        $('text-reading-poem-full').innerHTML = '請先在看圖猜詩或心情配詩取得推薦詩詞。';
        state.readingSelectedKey = '';
        return;
      }
      select.disabled = false;
      candidates.forEach(poem => {
        const opt = document.createElement('option');
        const key = poemKey(poem);
        opt.value = key;
        const fromImage = imagePoems.some(p => poemKey(p) === key);
        const fromEmotion = emotionPoems.some(p => poemKey(p) === key);
        const tags = [];
        if (fromImage) tags.push('看圖猜詩');
        if (fromEmotion) tags.push('心情配詩');
        opt.textContent = `${poem.name}${tags.length ? `｜${tags.join('＋')}` : ''}`;
        select.appendChild(opt);
      });
      const preferred = state.readingSelectedKey && candidates.some(p => poemKey(p) === state.readingSelectedKey)
        ? state.readingSelectedKey
        : poemKey(candidates[0]);
      select.value = preferred;
      renderSelectedReadingPoem(bridge, preferred);
    }

    function renderSelectedReadingPoem(bridge=null, selectedKey='') {
      const select = $('select-reading-poem');
      const key = selectedKey || select.value || '';
      state.readingSelectedKey = key;
      const poem = state.readingPoemOptions.find(p => poemKey(p) === key) || null;
      if (!poem) {
        $('text-reading-poem-source').textContent = '目前尚未收到推薦詩詞。';
        $('text-reading-poem-full').innerHTML = '請先在看圖猜詩或心情配詩取得推薦詩詞。';
        return;
      }
      state.activePoem = poem;
      syncActivePoemToEngine(poem);
      const imagePoems = Array.isArray(bridge?.imageMatchedPoems) ? bridge.imageMatchedPoems : [];
      const emotionPoems = Array.isArray(bridge?.emotionMatchedPoems) ? bridge.emotionMatchedPoems : [];
      const from = [];
      if (imagePoems.some(p => poemKey(p) === key)) from.push('看圖猜詩');
      if (emotionPoems.some(p => poemKey(p) === key)) from.push('心情配詩');
      $('text-reading-poem-source').textContent = `目前選擇：${poem.name}${from.length ? `（來自：${from.join('、')}）` : ''}`;
      $('text-reading-poem-full').innerHTML = renderReadingPoemDetail(poem);
    }

    function playMascotClip(type='idle', { restoreToIdle=false } = {}) {
      const video = $('video-mascot');
      if (!video) return;
      const idleSrc = video.dataset.idleSrc || 'assets/mascot-idle.mp4';
      const waveSrc = video.dataset.waveSrc || idleSrc;
      const targetSrc = type === 'wave' ? waveSrc : idleSrc;
      const current = video.querySelector('source')?.getAttribute('src') || '';
      if (current !== targetSrc) {
        const source = video.querySelector('source');
        if (source) source.setAttribute('src', targetSrc);
        else video.src = targetSrc;
        video.load();
      }
      video.loop = type !== 'wave';
      const playPromise = video.play?.();
      if (playPromise && typeof playPromise.catch === 'function') playPromise.catch(() => {});
      if (type === 'wave' && restoreToIdle) {
        const resetToIdle = () => {
          video.removeEventListener('ended', resetToIdle);
          playMascotClip('idle');
        };
        video.addEventListener('ended', resetToIdle, { once: true });
      }
    }

    function renderImageSummary(bridge) {
      const raw = (bridge?.imgRawResultText || '').trim();
      const cat = (bridge?.imgCatResultText || '').trim();
      const rawHtml = (bridge?.imgRawResultHtml || '').trim();
      const catHtml = (bridge?.imgCatResultHtml || '').trim();
      if (!raw && !cat && !rawHtml && !catHtml) {
        $('text-image-result').textContent = '辨識完成後，我會在這裡告訴你我看到了什麼。';
        return;
      }
      const parts = [];
      if (rawHtml || raw) parts.push(`<div><strong>辨識結果</strong><br>${rawHtml || escapeHtml(raw).replace(/\n/g, '<br>')}</div>`);
      if (catHtml || cat) parts.push(`<div><strong>相關詩詞</strong><br>${catHtml || escapeHtml(cat).replace(/\n/g, '<br>')}</div>`);
      $('text-image-result').innerHTML = parts.join('<hr style="border:none;border-top:1px solid var(--line);margin:12px 0;">');
    }

    async function syncActivePoemToEngine(poem) {
      if (!poem?.name) return;
      try {
        await withEngine((eng) => eng.setCurrentPoemFromBridge && eng.setCurrentPoemFromBridge(poem));
      } catch (_) { }
    }

    function applyActivePoem(poem, targetMode='ask') {
      if (!poem) return;
      state.activePoem = poem;
      state.activePoemByMode[targetMode] = poem;
      if (targetMode === 'ask') renderPoemMeta('ask', poem);
      if (targetMode === 'quiz') renderPoemMeta('quiz', poem);
      if (targetMode === 'image') renderPoemMeta('image', poem);
      if (targetMode === 'emotion') renderPoemMeta('emotion', poem);
      syncActivePoemToEngine(poem);
    }

    function stripSpeechDecorations(text='') {
      return String(text || '')
        .replace(/【[^\n]*】/g, '')
        .replace(/追問建議：[^\n]+/g, '')
        .replace(/\s+/g, ' ')
        .trim();
    }

    function makeSpeechCacheKey(text='', options={}) {
      return [
        options.voiceName || 'Leda',
        options.stylePrompt || '請用溫柔、清楚、像小朋友好朋友一樣自然親切的語氣朗讀。',
        stripSpeechDecorations(text || '')
      ].join('||');
    }

    function pickBestBrowserVoice() {
      const voices = window.speechSynthesis?.getVoices?.() || [];
      const score = (voice) => {
        const lang = String(voice.lang || '').toLowerCase();
        const name = String(voice.name || '').toLowerCase();
        let s = 0;
        if (lang.startsWith('zh-tw')) s += 10;
        else if (lang.startsWith('zh-hk')) s += 8;
        else if (lang.startsWith('zh')) s += 6;
        if (/female|girl|child|youth|xiao|huihui|hanhan|xiaoyi|meijia|yunxi/.test(name)) s += 2;
        return s;
      };
      return voices.slice().sort((a, b) => score(b) - score(a))[0] || null;
    }

    function speakWithBrowserFallback(text='') {
      const content = stripSpeechDecorations(text || '');
      if (!content) return false;
      const utter = new SpeechSynthesisUtterance(content);
      utter.lang = 'zh-TW';
      utter.rate = 1.08;
      utter.pitch = 1.08;
      const voice = pickBestBrowserVoice();
      if (voice) utter.voice = voice;
      window.speechSynthesis.cancel();
      window.speechSynthesis.speak(utter);
      return true;
    }


    async function unlockAudioPlayback() {
      const player = $('audio-native-tts');
      if (!player) return false;
      if (state.audioUnlocked) return true;
      try {
        player.muted = true;
        player.volume = 1;
        player.src = 'data:audio/wav;base64,UklGRiQAAABXQVZFZm10IBAAAAABAAEAQB8AAEAfAAABAAgAZGF0YQAAAAA=';
        await player.play();
        player.pause();
        player.currentTime = 0;
        player.removeAttribute('src');
        player.load();
        player.muted = false;
        state.audioUnlocked = true;
        return true;
      } catch (err) {
        console.warn('Audio unlock failed:', err);
        try { player.muted = false; } catch(_) {}
        return false;
      }
    }

    function stopGeminiNativeSpeech() {
      const player = $('audio-native-tts');
      if (player) {
        try { player.pause(); } catch(_){ }
        try { player.currentTime = 0; } catch(_){ }
        if (player.dataset.objectUrl) {
          URL.revokeObjectURL(player.dataset.objectUrl);
          player.dataset.objectUrl = '';
        }
        player.removeAttribute('src');
      }
      try { window.speechSynthesis.cancel(); } catch(_){ }
    }

    async function playAudioBase64(audioBase64, mimeType='audio/wav') {
      const player = $('audio-native-tts');
      if (!player || !audioBase64) return Promise.resolve(false);
      stopGeminiNativeSpeech();
      await unlockAudioPlayback();
      const binary = atob(audioBase64);
      const bytes = new Uint8Array(binary.length);
      for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
      const blob = new Blob([bytes], { type: mimeType || 'audio/wav' });
      const url = URL.createObjectURL(blob);
      player.muted = false;
      player.volume = 1;
      player.src = url;
      player.dataset.objectUrl = url;
      try { player.load(); } catch(_) { }
      return new Promise((resolve, reject) => {
        const cleanup = () => {
          player.onended = null;
          player.onerror = null;
        };
        player.onended = () => { cleanup(); resolve(true); };
        player.onerror = (err) => { cleanup(); reject(err || new Error('音訊播放失敗')); };
        player.play().catch(reject);
      });
    }

    async function requestGeminiNativeTts(text, options={}) {
      const content = stripSpeechDecorations(text);
      if (!content) return null;
      const cacheKey = makeSpeechCacheKey(content, options);
      if (state.ttsCache.has(cacheKey)) return state.ttsCache.get(cacheKey);
      if (state.ttsQuotaExceeded) throw Object.assign(new Error(state.ttsDisabledReason || 'Gemini 聲音配額已滿'), { quotaExceeded: true });
      const res = await fetch('/api/gemini/tts', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          text: content,
          voiceName: options.voiceName || 'Leda',
          stylePrompt: options.stylePrompt || '請用溫柔、清楚、像小朋友好朋友一樣自然親切的語氣朗讀。'
        })
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        const message = data.error || `HTTP ${res.status}`;
        if (data.quotaExceeded || /quota|resource_exhausted/i.test(String(message))) {
          state.ttsQuotaExceeded = true;
          state.ttsDisabledReason = 'Gemini 聲音額度已滿，新的語音暫時改用備援聲音。';
        }
        throw Object.assign(new Error(message), { quotaExceeded: !!data.quotaExceeded });
      }
      state.ttsCache.set(cacheKey, data);
      return data;
    }

    async function playGeminiNativeSpeechPayload(payload, options={}) {
      const text = stripSpeechDecorations(payload?.answer || payload?.text || payload?.speakText || '');
      if (!text && !payload?.audioBase64) return false;
      setMascotState('speaking', options.bubbleText || uiText.bubbles.speaking);
      try {
        if (payload?.audioBase64) {
          await playAudioBase64(payload.audioBase64, payload.mimeType || 'audio/wav');
          return true;
        }
        if (!payload?.ttsFallback) {
          const tts = await requestGeminiNativeTts(text, options);
          if (tts?.audioBase64) {
            await playAudioBase64(tts.audioBase64, tts.mimeType || 'audio/wav');
            return true;
          }
        }
      } catch (err) {
        console.warn('Gemini Native Speech failed, fallback to browser TTS.', err);
      }
      if (payload?.quotaExceeded) {
        state.ttsQuotaExceeded = true;
        state.ttsDisabledReason = payload?.ttsError || 'Gemini 聲音額度已滿，已切到備援聲音。';
      }
      if (state.ttsQuotaExceeded) {
        $('text-ask-voice-status').textContent = state.ttsDisabledReason || 'Gemini 聲音額度已滿，已切到備援聲音。';
      }
      speakWithBrowserFallback(text);
      return true;
    }

    async function playGeminiNativeSpeech(text, options={}) {
      return playGeminiNativeSpeechPayload({ text }, options);
    }

    window.playGeminiNativeSpeech = playGeminiNativeSpeech;
    window.playGeminiNativeSpeechPayload = playGeminiNativeSpeechPayload;
    window.stopGeminiNativeSpeech = stopGeminiNativeSpeech;

    function readCurrentAnswer() {
      const txt = state.lastAnswerText || $('text-ask-answer').textContent || '';
      if (!txt.trim()) return;
      playGeminiNativeSpeech(txt, { bubbleText: '我唸給你聽。' });
    }

    function clearVisibleFields() {
      $('input-ask-question').value = '';
      $('text-ask-answer').textContent = '你的問題送出後，我會在這裡回答你。';
      $('text-ask-voice-status').textContent = '語音問答待命';
      $('text-image-result').textContent = '辨識完成後，我會在這裡告訴你我看到了什麼。';
      $('text-reading-volume-result').textContent = '—';
      $('text-reading-speed-result').textContent = '—';
      $('text-reading-feedback').textContent = '分析完成後，我會告訴你可以怎麼調整。';
      $('text-emotion-result').textContent = '我感受到你的心情是……';
      $('text-quiz-result').textContent = '作答後，這裡會顯示是否答對、原因與修正提醒。';
      $('text-quiz-question').textContent = '載入詩詞資料後，按「開始闖關」就能由 AI 主動出題。';
      $('quiz-options-front').innerHTML = '';
      ['ask','quiz','image','emotion'].forEach(prefix => renderPoemMeta(prefix, null));
      state.activePoem = null;
      state.readingPoemOptions = [];
      state.readingSelectedKey = '';
      $('select-reading-poem').innerHTML = '<option value=>目前尚未有推薦詩詞</option>';
      $('select-reading-poem').disabled = true;
      $('text-reading-poem-source').textContent = '目前尚未收到推薦詩詞。';
      $('text-reading-poem-full').innerHTML = '請先在看圖猜詩或心情配詩取得推薦詩詞。';
      state.conversationLog = [];
      renderConversationLog();
    }

    async function syncAsk() {
      const bridge = await getBridgeState();
      if (!bridge) return;
      const reply = bridge.qaReply || '你的問題送出後，我會在這裡回答你。';
      state.lastAnswerText = reply;
      $('text-ask-answer').textContent = reply;
      $('text-ask-voice-status').textContent = bridge.voiceChatStatus || bridge.sttStatus || '語音問答待命';
      const bridgeLog = Array.isArray(bridge.conversationLog) ? bridge.conversationLog.map(item => ({
        role: item.role === 'user' ? 'user' : 'assistant',
        text: stripSpeechDecorations(item.text || ''),
        key: `${item.role === 'user' ? 'user' : 'assistant'}::${stripSpeechDecorations(item.text || '')}`
      })).filter(item => item.text) : [];
      if (bridgeLog.length) state.conversationLog = bridgeLog;
      renderConversationLog();
      if (bridge.currentPoem) applyActivePoem(bridge.currentPoem, 'ask');
      else $('text-ask-poem-title').textContent = bridge.currentPoemText === '未選取' ? '—' : bridge.currentPoemText;
    }

    async function syncQuiz() {
      const bridge = await getBridgeState();
      if (!bridge) return;
      $('text-quiz-question').textContent = bridge.quizQuestion || '載入詩詞資料後，按「開始闖關」就能由 AI 主動出題。';
      $('text-quiz-result').textContent = bridge.quizFeedback || '作答後，這裡會顯示是否答對、原因與修正提醒。';
      $('text-quiz-score').textContent = '目前得分：' + (bridge.quizScore || '0 / 0');
      if (bridge.quizMode && $('select-quiz-mode').value !== bridge.quizMode) $('select-quiz-mode').value = bridge.quizMode;
      const out = $('quiz-options-front');
      out.innerHTML = '';
      (bridge.quizOptions || []).forEach((btn, idx) => {
        const vBtn = document.createElement('button');
        vBtn.className = 'option-btn';
        vBtn.id = `btn-quiz-option-${idx}`;
        vBtn.textContent = btn.text;
        if (btn.disabled) vBtn.disabled = true;
        if ((btn.background || '').includes('92, 184, 92') || btn.text.includes('✅')) vBtn.classList.add('correct');
        if ((btn.background || '').includes('224, 80, 80') || btn.text.includes('❌')) vBtn.classList.add('wrong');
        vBtn.onclick = () => withEngine((eng, doc) => doc.querySelectorAll('#quizOptions button')?.[idx]?.click());
        out.appendChild(vBtn);
      });
      if (bridge.currentPoem) applyActivePoem(bridge.currentPoem, 'quiz');
    }

    async function syncImage() {
      const bridge = await getBridgeState();
      if (!bridge) return;
      renderImageSummary(bridge);
      await withEngine((eng, doc) => {
        const hiddenPreview = doc.getElementById('imgPreview');
        const box = $('media-image-preview');
        if (hiddenPreview?.src && !hiddenPreview.classList.contains('hidden')) {
          box.innerHTML = `<img src="${hiddenPreview.src}" alt="圖片預覽">`;
        } else if (!state.selectedImageFile) {
          box.textContent = '請先上傳圖片';
        }
      });
      if (bridge.currentPoem) applyActivePoem(bridge.currentPoem, 'image');
      else renderPoemMeta('image', null);
      renderReadingPoemOptions(bridge);
    }

    async function syncReading() {
      const bridge = await getBridgeState();
      if (!bridge) return;
      $('text-reading-volume-result').textContent = bridge.readingVolumeLabel || '—';
      $('text-reading-speed-result').textContent = bridge.readingSpeedLabel || '—';
      const resultText = bridge.readingResultText || '分析完成後，我會告訴你可以怎麼調整。';
      const adviceText = bridge.readingAdviceText || '';
      $('text-reading-feedback').textContent = [resultText, adviceText].filter(Boolean).join('\n\n');
    }

    async function syncEmotion() {
      const bridge = await getBridgeState();
      if (!bridge) return;
      $('text-emotion-result').textContent = bridge.emotionText || '我感受到你的心情是……';
      const box = $('media-emotion-preview');
      if (bridge.faceSnapshotDataUrl) {
        box.innerHTML = `<div><img src="${bridge.faceSnapshotDataUrl}" alt="表情截圖"><div class="helper-text" style="margin-top:8px;">已保留 1 秒辨識完成時的表情截圖，方便和偵測結果比對。</div></div>`;
      } else {
        await withEngine((eng, doc) => {
          const hiddenVideo = doc.getElementById('faceVideo');
          if (hiddenVideo?.srcObject && !hiddenVideo.classList.contains('hidden')) {
            const clone = box.querySelector('video');
            if (!clone) box.innerHTML = '<video autoplay muted playsinline></video>';
            const target = box.querySelector('video');
            if (target && target.srcObject !== hiddenVideo.srcObject) target.srcObject = hiddenVideo.srcObject;
          } else {
            box.textContent = '啟動表情辨識後，這裡會顯示鏡頭畫面。';
          }
        });
      }
      if (bridge.currentPoem) applyActivePoem(bridge.currentPoem, 'emotion');
      renderReadingPoemOptions(bridge);
    }

    async function syncStatuses() {
      const bridge = await getBridgeState();
      if (!bridge) return;
      const micActive = !!(bridge.qaRecRunning || bridge.voiceChatActive || bridge.analysisRecRunning || bridge.volActive);
      const camActive = !!bridge.faceActive;
      $('status-mic').textContent = micActive ? '麥克風已開啟' : '麥克風未開啟';
      $('status-camera').textContent = camActive ? '鏡頭已開啟' : '鏡頭未開啟';
      $('status-mic').classList.toggle('on', micActive);
      $('status-camera').classList.toggle('on', camActive);
      if (bridge.voiceChatActive) setMascotState('listening', bridge.voiceChatStatus || uiText.bubbles.listening);
      else if (bridge.qaRecRunning) setMascotState('listening', bridge.sttStatus || uiText.bubbles.listening);
      else if (bridge.faceActive) setMascotState('thinking', '我正在觀察你的表情。');
      else if (bridge.analysisRecRunning || bridge.volActive) setMascotState('listening', '我正在聽你的朗讀。');
      else if ((state.lastAnswerText || '').trim()) setMascotState('speaking', uiText.bubbles.speaking);
      else setMascotState('idle', uiText.bubbles[state.mode]);
    }

    async function updateAll() {
      if (!state.engineReady) return;
      await syncStatuses();
      await Promise.all([syncAsk(), syncQuiz(), syncImage(), syncReading(), syncEmotion()]);
    }

    function openTeacherPage() {
      window.open('multimodal.html', '_blank', 'noopener');
    }

    async function sendAskQuestion(extraPrompt='') {
      const question = $('input-ask-question').value.trim();
      if (!question && !extraPrompt) return;
      const fullQuestion = extraPrompt ? `${question}\n${extraPrompt}`.trim() : question;
      appendConversationLog('user', question || fullQuestion);
      await unlockAudioPlayback();
      setMascotState('thinking', uiText.bubbles.thinking);
      await withEngine(async (eng, doc) => {
        const input = doc.getElementById('txtGemini');
        if (input) input.value = fullQuestion;
        if (typeof eng.askGeminiFromInput === 'function') await eng.askGeminiFromInput();
      });
      await syncAsk();
      appendConversationLog('assistant', state.lastAnswerText || $('text-ask-answer').textContent || '');
      setMascotState('speaking', '我找到答案了！');
      await playGeminiNativeSpeech(state.lastAnswerText || $('text-ask-answer').textContent || '', { bubbleText: '我來回答你。' });
    }

    function resetEngineUi() {
      withEngine((eng) => {
        try { eng.clearAskSession && eng.clearAskSession(); } catch(_){ }
        try { eng.clearImageSession && eng.clearImageSession(); } catch(_){ }
        try { eng.clearReadingSession && eng.clearReadingSession(); } catch(_){ }
        try { eng.clearEmotionSession && eng.clearEmotionSession(); } catch(_){ }
      });
      clearVisibleFields();
      setMascotState('idle', uiText.bubbles[state.mode]);
    }

    function speakText(text='') {
      const content = stripSpeechDecorations(text || '');
      if (!content) return;
      playGeminiNativeSpeech(content, { bubbleText: '我說給你聽。' });
    }

    function initEvents() {
      $('btn-teacher-mode').onclick = openTeacherPage;
      $('select-reading-poem').onchange = async () => { const bridge = await getBridgeState(); renderSelectedReadingPoem(bridge, $('select-reading-poem').value); };
      $('btn-action-open-multimodal').onclick = openTeacherPage;
      $('btn-global-home').onclick = () => { stopGeminiNativeSpeech(); setMode('ask'); playMascotClip('wave', { restoreToIdle: true }); };
      $('btn-global-reset').onclick = () => { stopGeminiNativeSpeech(); resetEngineUi(); playMascotClip('wave', { restoreToIdle: true }); };
      $('btn-global-replay').onclick = () => {
        if (state.mode === 'quiz') $('btn-quiz-start').click();
        else if (state.mode === 'image') $('btn-image-again').click();
        else if (state.mode === 'reading') $('btn-reading-retry').click();
        else if (state.mode === 'emotion') $('btn-emotion-again').click();
        else $('btn-ask-reset').click();
      };
      $('btn-action-random').onclick = () => withEngine((eng, doc) => doc.getElementById('btnRandom')?.click());
      $('btn-global-read-aloud').onclick = async () => { await unlockAudioPlayback(); readCurrentAnswer(); };
      $('btn-global-show-related').onclick = () => {
        const poem = state.activePoem || state.activePoemByMode[state.mode];
        if (poem?.name) {
          setMascotState('speaking', `這首是《${poem.name}》，要不要再問我更多？`);
          speakText(`這首是${poem.name}。包含物有${(poem.items||[]).join('、') || '沒有標註'}。情緒是${(poem.emotions||[]).join('、') || '沒有標註'}。`);
        }
      };

      ['ask','quiz','image','reading','emotion'].forEach(mode => {
        $(`tab-mode-${mode}`).onclick = () => setMode(mode);
      });

      $('btn-ask-submit').onclick = () => sendAskQuestion();
      $('btn-ask-more').onclick = () => sendAskQuestion('請再多說一點，但保持簡短、適合國小學生。');
      $('btn-ask-reset').onclick = () => {
        $('input-ask-question').value = '';
        $('text-ask-answer').textContent = '你的問題送出後，我會在這裡回答你。';
        renderPoemMeta('ask', null);
        state.conversationLog = [];
        renderConversationLog();
        withEngine((eng) => {
          eng.clearAskSession && eng.clearAskSession();
          eng.clearCurrentPoemFromBridge && eng.clearCurrentPoemFromBridge();
        });
      };
      $('btn-ask-read-aloud').onclick = async () => { await unlockAudioPlayback(); readCurrentAnswer(); };
      $('input-ask-question').addEventListener('keydown', e => {
        if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') sendAskQuestion();
      });
      $('btn-ask-voice-start').onclick = async () => { await unlockAudioPlayback(); return withEngine((eng) => { eng.startQaStt && eng.startQaStt(); setMode('ask'); }); };
      $('btn-ask-voice-stop').onclick = () => withEngine((eng) => eng.stopQaStt && eng.stopQaStt());
      $('btn-ask-voice-chat').onclick = async () => {
        await unlockAudioPlayback();
        stopGeminiNativeSpeech();
        const bridge = await getBridgeState();
        if (bridge?.voiceChatActive) await withEngine((eng) => eng.stopVoiceChat && eng.stopVoiceChat(true));
        else await withEngine((eng) => eng.startVoiceChat && eng.startVoiceChat());
      };

      $('select-quiz-mode').onchange = () => withEngine((eng, doc) => {
        const sel = doc.getElementById('quizMode');
        if (sel) { sel.value = $('select-quiz-mode').value; sel.dispatchEvent(new Event('change')); }
      });
      $('btn-quiz-start').onclick = async () => {
        await withEngine((eng, doc) => {
          const sel = doc.getElementById('quizMode');
          if (sel) sel.value = $('select-quiz-mode').value;
          eng.startQuiz && eng.startQuiz();
        });
        await syncQuiz();
        setMascotState('questioning', '換我來出題囉！');
      };
      $('btn-quiz-next').onclick = async () => { await withEngine((eng, doc) => doc.getElementById('btnQuizNext')?.click()); await syncQuiz(); };
      $('btn-quiz-read-question').onclick = async () => { await unlockAudioPlayback(); speakText($('text-quiz-question').textContent); };

      $('btn-image-upload').onclick = () => $('input-image-upload').click();
      $('btn-image-change').onclick = () => $('input-image-upload').click();
      $('input-image-upload').onchange = e => {
        const file = e.target.files?.[0];
        state.selectedImageFile = file || null;
        const box = $('media-image-preview');
        if (!file) { box.textContent = '請先上傳圖片'; return; }
        const url = URL.createObjectURL(file);
        box.innerHTML = `<img src="${url}" alt="圖片預覽">`;
        $('text-image-result').textContent = `已選擇圖片，將使用內置 TM 模型 ${TM_IMAGE_EMBEDDED_MODEL_ID} 自動開始辨識。`;
        setTimeout(() => $('btn-image-start').click(), 60);
      };
      $('btn-image-start').onclick = async () => {
        if (!state.selectedImageFile) return;
        const startBtn = $('btn-image-start');
        startBtn.disabled = true;
        $('text-image-result').innerHTML = '<strong>辨識中…</strong><br>正在等待多模態模型回傳結果。';
        setMascotState('thinking', '我來看看這張圖片。');
        try {
          await withEngineStrict(async (eng) => {
            if (typeof eng.classifyImage !== 'function') throw new Error('多模態頁面沒有 classifyImage()');
            const task = eng.classifyImage(state.selectedImageFile);
            await new Promise(resolve => setTimeout(resolve, 120));
            await syncImage();
            return await task;
          });
          await syncImage();
          setMascotState('speaking', '我看到了！');
        } catch (err) {
          await syncImage();
          $('text-image-result').textContent = `辨識失敗：${err?.message || err}`;
          setMascotState('idle', '這張圖片我還沒看清楚，換一張再試試。');
        } finally {
          startBtn.disabled = false;
        }
      };
      $('btn-image-stop').onclick = () => {
        state.selectedImageFile = null;
        $('input-image-upload').value='';
        $('media-image-preview').textContent='請先上傳圖片';
        $('text-image-result').textContent='辨識完成後，我會在這裡告訴你我看到了什麼。';
        renderPoemMeta('image', null);
        withEngine((eng) => eng.clearImageSession && eng.clearImageSession());
        setMascotState('idle', uiText.bubbles.image);
      };
      $('btn-image-clear').onclick = () => {
        state.selectedImageFile = null; $('input-image-upload').value=''; $('media-image-preview').textContent='請先上傳圖片';
        $('text-image-result').textContent = '辨識完成後，我會在這裡告訴你我看到了什麼。'; renderPoemMeta('image', null);
        withEngine((eng) => eng.clearImageSession && eng.clearImageSession());
      };
      $('btn-image-again').onclick = () => $('btn-image-start').click();
      $('btn-image-read-result').onclick = () => speakText($('text-image-result').textContent);

      $('btn-reading-start').onclick = () => withEngine((eng) => { eng.startVoiceAnalysis && eng.startVoiceAnalysis(); setMascotState('listening', '請開始朗讀，我正在聽。'); });
      $('btn-reading-stop').onclick = async () => { await withEngine((eng) => eng.stopVoiceAnalysis && eng.stopVoiceAnalysis('manual')); await syncReading(); };
      $('btn-reading-retry').onclick = () => withEngine((eng) => { eng.stopVoiceAnalysis && eng.stopVoiceAnalysis('manual'); setTimeout(() => eng.startVoiceAnalysis && eng.startVoiceAnalysis(), 300); });
      $('btn-reading-demo').onclick = async () => {
        await unlockAudioPlayback();
        const poem = state.readingPoemOptions.find(p => poemKey(p) === state.readingSelectedKey) || state.activePoem || state.activePoemByMode.ask || state.activePoemByMode.image || state.activePoemByMode.emotion;
        if (poem?.content) speakText(poem.content);
        else speakText('床前明月光，疑是地上霜。舉頭望明月，低頭思故鄉。');
      };

      $('btn-emotion-start').onclick = () => withEngine((eng) => { eng.startFace && eng.startFace(); setMascotState('thinking', '我正在看你的表情。'); });
      $('btn-emotion-stop').onclick = async () => { await withEngine((eng) => eng.stopFace && eng.stopFace({clearResult:false})); await syncEmotion(); };
      $('btn-emotion-again').onclick = () => withEngine((eng) => { eng.stopFace && eng.stopFace({clearResult:false}); setTimeout(() => eng.startFace && eng.startFace(), 300); });
      $('btn-emotion-comfort').onclick = () => {
        const poem = state.activePoemByMode.emotion;
        if (poem?.name) speakText(`我想推薦你《${poem.name}》。希望這首詩能陪陪你。`);
        else speakText('沒關係，我陪你慢慢來。');
        setMascotState('comforting', uiText.bubbles.comforting);
      };
      $('btn-emotion-read-reason').onclick = () => speakText($('text-emotion-result').textContent);
    }

    function onEngineLoaded() {
      const eng = getEngine();
      if (!eng || !engineDoc) return;
      state.engineReady = true;
      const video = $('video-mascot');
      $('img-mascot-poster').classList.add('hidden');
      video.classList.remove('hidden');
      video.onerror = () => { video.classList.add('hidden'); $('img-mascot-poster').classList.remove('hidden'); };
      initEvents();
      renderConversationLog();
      setMode('ask');
      clearVisibleFields();
      playMascotClip('wave', { restoreToIdle: true });
      setInterval(() => { updateAll(); }, 800);
    }

    engineFrame.addEventListener('load', () => {
      // Give the engine page a moment to register globals and auto-load bundled data.
      setTimeout(onEngineLoaded, 1200);
    });
  