
(function(){
  const $ = id => document.getElementById(id);
  const replyBox = $('qaReply');
  if(replyBox){
    replyBox.style.maxHeight = 'none';
    replyBox.style.overflow = 'visible';
    replyBox.style.overflowWrap = 'anywhere';
    replyBox.style.wordBreak = 'break-word';
  }

  function cleanGeminiText(text=''){
    return String(text || '')
      .replace(/```(?:json)?/gi, '')
      .replace(/```/g, '')
      .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '')
      .replace(/[\u200B-\u200D\uFEFF]/g, '')
      .replace(/�/g, '')
      .replace(/\*\*/g, '')
      .replace(/`/g, '')
      .replace(/\n{3,}/g, '\n\n')
      .trim();
  }
  window.cleanGeminiText = cleanGeminiText;

  function setVoiceChatStatus(text, color='var(--ink-gray)'){
    const el = $('voiceChatStatus');
    if(!el) return;
    el.textContent = text;
    el.style.color = color;
  }

  function getRecognizerCtor(){
    return window.SpeechRecognition || window.webkitSpeechRecognition || null;
  }

  let analysisRec = null;
  let analysisRecRunning = false;
  let qaRecRunning = false;
  let voiceChatRec = null;
  let voiceChatActive = false;
  let voiceChatBusy = false;
  let voiceChatAwaiting = false;
  let voiceChatListening = false;
  let ttsSpeaking = false;
  let faceStableSinceMs = null;
  let frontConversationLog = [];

  function createRecognizer(){
    const SR = getRecognizerCtor();
    if(!SR) return null;
    const rec = new SR();
    rec.lang = $('sttLang')?.value || 'zh-TW';
    rec.continuous = true;
    rec.interimResults = true;
    return rec;
  }

  function stopSpeaking(){
    try { window.speechSynthesis.cancel(); } catch(_){}
    try { if(window.parent && window.parent !== window && typeof window.parent.stopGeminiNativeSpeech === 'function') window.parent.stopGeminiNativeSpeech(); } catch(_){}
    ttsSpeaking = false;
    updateVoiceButtons();
  }

  function shortSpeakText(text=''){
    const clean = cleanGeminiText(text);
    const pieces = clean.split(/(?<=[。！？!?])/).map(s => s.trim()).filter(Boolean);
    let out = '';
    for(const p of pieces){
      if((out + p).length > 90) break;
      out += p;
      if((out.match(/[。！？!?]/g) || []).length >= 3) break;
    }
    return (out || clean).slice(0, 100).trim();
  }

  async function speakGeminiAnswer(payloadOrText){
    const rawText = typeof payloadOrText === 'object'
      ? (payloadOrText?.answer || payloadOrText?.text || '')
      : String(payloadOrText || '');
    const speakText = shortSpeakText(rawText);
    if(!speakText) {
      if(voiceChatActive && !voiceChatAwaiting){
        setTimeout(() => { try { voiceChatRec && voiceChatRec.start(); } catch(_){} }, 250);
      }
      return false;
    }
    stopSpeaking();
    setVoiceChatStatus('Gemini 朗讀中…', 'var(--gold-light)');
    updateVoiceButtons();
    try{
      let played = false;
      if(window.parent && window.parent !== window && typeof window.parent.playGeminiNativeSpeechPayload === 'function'){
        played = await window.parent.playGeminiNativeSpeechPayload({
          answer: speakText,
          audioBase64: payloadOrText?.audioBase64 || '',
          mimeType: payloadOrText?.mimeType || 'audio/wav',
          voiceName: payloadOrText?.voiceName || 'Leda'
        }, { bubbleText: '我來回答你。', voiceName: payloadOrText?.voiceName || 'Leda' });
      }
      if(played){
        if(voiceChatActive && !voiceChatAwaiting){
          setVoiceChatStatus('等待下一句語音…', 'var(--gold-light)');
          setTimeout(() => { try { voiceChatRec && voiceChatRec.start(); } catch(_){} }, 220);
        }
        return true;
      }
    }catch(err){
      console.warn('Parent Gemini TTS playback failed:', err);
    }
    const utter = new SpeechSynthesisUtterance(speakText);
    utter.lang = 'zh-TW';
    utter.rate = 1.02;
    utter.pitch = 1.06;
    const voices = window.speechSynthesis.getVoices().filter(v => (v.lang || '').toLowerCase().startsWith('zh'));
    if(voices.length) utter.voice = voices[0];
    utter.onstart = () => {
      ttsSpeaking = true;
      setVoiceChatStatus('Gemini 朗讀中…', 'var(--gold-light)');
      updateVoiceButtons();
    };
    utter.onend = () => {
      ttsSpeaking = false;
      updateVoiceButtons();
      if(voiceChatActive && !voiceChatAwaiting){
        setVoiceChatStatus('等待下一句語音…', 'var(--gold-light)');
        setTimeout(() => { try { voiceChatRec && voiceChatRec.start(); } catch(_){} }, 250);
      }
    };
    utter.onerror = () => {
      ttsSpeaking = false;
      updateVoiceButtons();
      if(voiceChatActive && !voiceChatAwaiting){
        setTimeout(() => { try { voiceChatRec && voiceChatRec.start(); } catch(_){} }, 250);
      }
    };
    ttsSpeaking = true;
    window.speechSynthesis.speak(utter);
    return true;
  }

  window.formatGeminiReply = function(prefixText, data){
    const lines = [];
    const answer = cleanGeminiText(data?.answer || '');
    const follow = cleanGeminiText(data?.suggestedFollowUp || '');
    if(prefixText) lines.push(prefixText);
    lines.push(`【Gemini補答】${data?.model ? `（${data.model}）` : ''}`);
    if(answer) lines.push(answer);
    if(follow) lines.push(`追問建議：${follow}`);
    return lines.join('\n');
  };

  window.requestGemini = async function(question, extra={}){
    const endpoint = extra.withAudio ? '/api/gemini/chat-tts' : '/api/gemini/chat';
    const res = await fetch(endpoint, {
      method:'POST',
      headers:{'Content-Type':'application/json'},
      body: JSON.stringify({
        question,
        mode: extra.mode || 'manual',
        reason: extra.reason || '',
        concise: !!extra.concise,
        voiceChat: !!extra.voiceChat,
        voiceName: extra.voiceName || 'Leda',
        stylePrompt: extra.stylePrompt || '請用溫柔、清楚、像小朋友好朋友一樣自然親切的語氣朗讀。',
        currentPoem,
        predictions: typeof getPredictionSnapshot === 'function' ? getPredictionSnapshot() : [],
        currentIntent: lastIntentResult?.top || null,
        alternateIntent: lastIntentResult?.second || null,
        source: $('resultSource')?.textContent || '',
        workbookLoaded: qaWorkbookConfig?.loaded,
        poemsLoaded
      })
    });
    const data = await res.json().catch(() => ({}));
    if(!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
    data.answer = cleanGeminiText(data.answer || '');
    data.suggestedFollowUp = cleanGeminiText(data.suggestedFollowUp || '');
    return data;
  };

  window.maybeAskGemini = async function(question, extra={}){
    if(!$('chkGeminiFallback')?.checked) return false;
    if(!geminiAvailable){
      if(extra.failText) setReply(extra.failText);
      return false;
    }
    setReply((extra.prefixText ? extra.prefixText + '\n' : '') + '（規則資料不足，改由 Gemini 補答中…）');
    try{
      const data = await requestGemini(question, extra);
      setReply(formatGeminiReply(extra.prefixText, data));
      return true;
    }catch(err){
      const msg = err?.message || String(err);
      if(extra.failText) setReply(extra.failText + '\nGemini 補答失敗：' + msg);
      else setReply('Gemini 補答失敗：' + msg);
      return false;
    }
  };

  window.askGeminiFromInput = async function(){
    const input = $('txtGemini');
    const question = (input?.value || '').trim();
    if(!question){ setReply('請先輸入問題。'); return; }
    pushFrontConversationLog('user', question);
    if(!geminiAvailable){
      const msg = 'Gemini 後端尚未就緒。請先在伺服器設定 GEMINI_API_KEY，再按「檢查 Gemini 後端」。';
      setReply(msg);
      pushFrontConversationLog('assistant', msg);
      return;
    }
    setReply('Gemini 分析中…');
    try{
      const shouldSpeak = !!($('chkSpeakReply')?.checked);
      const data = await requestGemini(question, {mode:'manual', reason:'direct_input', withAudio: shouldSpeak, voiceName:'Leda'});
      const replyText = formatGeminiReply('', data);
      setReply(replyText);
      pushFrontConversationLog('assistant', replyText);
      if(shouldSpeak) await speakGeminiAnswer(data);
    }catch(err){
      const msg = 'Gemini 呼叫失敗：' + (err?.message || err);
      setReply(msg);
      pushFrontConversationLog('assistant', msg);
    }
  };

  function stopAnalysisRecognizer(){
    if(analysisRec){ try{ analysisRec.onend = ()=>{}; analysisRec.stop(); }catch(_){} }
    analysisRecRunning = false;
  }

  function stopQaStt(){
    if(stt && qaRecRunning){ try{ stt.stop(); }catch(_){} }
    qaRecRunning = false;
    sttRunning = false;
    updateVoiceButtons();
  }

  function createAnalysisRecognizer(){
    const rec = createRecognizer();
    if(!rec) return null;
    let lastFinalMs = Date.now();
    rec.onstart = () => {
      analysisRecRunning = true;
      updateVoiceButtons();
      setStatus('音量＋語速分析中…','ok');
    };
    rec.onend = () => {
      analysisRecRunning = false;
      updateVoiceButtons();
    };
    rec.onerror = (e) => {
      const msg = e?.error || 'unknown';
      setAudioAdvice([`語速辨識發生錯誤：${msg}`, '瀏覽器若不支援語音辨識，仍可保留音量分析功能。'], '#e8b954');
    };
    rec.onresult = (ev) => {
      let fin = '';
      for(let i = ev.resultIndex; i < ev.results.length; i++){
        const t = ev.results[i][0].transcript;
        if(ev.results[i].isFinal) fin += t;
      }
      if(fin.trim()){
        const now = Date.now();
        const dur = Math.max(0.6, (now - lastFinalMs) / 1000);
        lastFinalMs = now;
        updateRate(fin.trim(), dur);
        if(voiceSession) voiceSession.transcripts.push(fin.trim());
      }
    };
    return rec;
  }

  window.startVoiceAnalysis = async function(){
    stopQaStt();
    stopVoiceChat(false);
    resetVoiceSession();
    const ok = await startVolumeCore();
    analysisRec = createAnalysisRecognizer();
    if(analysisRec){ try{ analysisRec.start(); }catch(_){} }
    updateVoiceButtons();
    if(ok){ setAudioAdvice(['正在同步偵測音量與語速。', '若 3 秒沒有聲音，系統會自動停止。'], 'var(--paper)'); }
    else { setAudioAdvice(['已開啟語速辨識，但麥克風音量分析未成功。'], '#e8b954'); }
  };

  window.stopVoiceAnalysis = function(reason='manual'){
    const had = volActive || analysisRecRunning;
    stopAnalysisRecognizer();
    stopVolumeCore();
    updateVoiceButtons();
    if(had) summarizeVoiceSession(reason);
  };

  window.updateVoiceButtons = function(){
    const analysisActive = !!(volActive || analysisRecRunning);
    if($('btnVolume')){
      $('btnVolume').textContent = analysisActive ? '停止音量＋語速分析' : '開始音量＋語速分析';
      $('btnVolume').style.background = analysisActive ? '#b91c1c' : 'var(--vermillion)';
    }
    const qaActive = !!qaRecRunning;
    if($('btnStt')){
      $('btnStt').textContent = qaActive ? '停止語音轉文字問答' : '開始語音轉文字問答';
      $('btnStt').style.background = qaActive ? '#b91c1c' : 'var(--vermillion)';
    }
    if($('btnVoiceChat')){
      $('btnVoiceChat').textContent = voiceChatActive ? (voiceChatBusy ? 'Gemini 回答中…' : '停止 Gemini 語音對話') : '開始 Gemini 語音對話';
      $('btnVoiceChat').style.background = voiceChatActive ? '#b91c1c' : 'var(--vermillion)';
      $('btnVoiceChat').disabled = voiceChatBusy;
      $('btnVoiceChat').style.opacity = voiceChatBusy ? '0.8' : '1';
    }
  };

  window.initStt = function(){
    const rec = createRecognizer();
    if(!rec){
      $('sttStatus').textContent = '此瀏覽器不支援語音辨識';
      $('btnStt').disabled = true;
      $('btnStt').style.opacity = '0.5';
      return null;
    }
    rec.onstart = () => {
      qaRecRunning = true;
      sttRunning = true;
      updateVoiceButtons();
      $('sttStatus').textContent = '語音問答監聽中…';
    };
    rec.onend = () => {
      qaRecRunning = false;
      sttRunning = false;
      updateVoiceButtons();
      $('sttInterim').textContent = '';
      if(!voiceChatActive) $('sttStatus').textContent = '已停止';
    };
    rec.onerror = e => $('sttStatus').textContent = '錯誤：' + e.error;
    rec.onresult = ev => {
      let interim = '', fin = '';
      for(let i = ev.resultIndex; i < ev.results.length; i++){
        const t = ev.results[i][0].transcript;
        ev.results[i].isFinal ? fin += t : interim += t;
      }
      $('sttInterim').textContent = interim.trim();
      if(fin.trim()){
        const parts = fin.split(/(?<=[。！？!?])/).map(x => x.trim()).filter(Boolean);
        const list = parts.length ? parts : [fin.trim()];
        for(const s of list){
          const li = document.createElement('li');
          li.style.cssText='border:1px solid rgba(201,151,62,0.2);background:rgba(12,9,5,0.5);border-radius:2px;padding:5px 8px;font-size:0.82rem';
          li.textContent = s;
          $('sttSentences').appendChild(li);
          handleSentence(s);
        }
        $('sttInterim').textContent = '';
        $('sttStatus').textContent = '收到一句，等待下一句…';
      }
    };
    return rec;
  };

  function startQaStt(){
    if(volActive || analysisRecRunning) stopVoiceAnalysis('manual');
    stopVoiceChat(false);
    if(!stt) stt = initStt();
    if(!stt) return;
    try{ stt.lang = $('sttLang')?.value || 'zh-TW'; stt.start(); }catch(_){ }
  }

  function createVoiceChatRecognizer(){
    const rec = createRecognizer();
    if(!rec) return null;
    rec.onstart = () => {
      voiceChatListening = true;
      setVoiceChatStatus('正在收音…', 'var(--gold-light)');
      $('sttStatus').textContent = 'Gemini 語音對話監聽中…';
      updateVoiceButtons();
    };
    rec.onend = () => {
      voiceChatListening = false;
      updateVoiceButtons();
      $('sttInterim').textContent = '';
      if(voiceChatActive && !voiceChatAwaiting && !ttsSpeaking){
        setVoiceChatStatus('等待下一句語音…', 'var(--gold-light)');
        setTimeout(() => { try { rec.start(); } catch(_){} }, 220);
      } else if(!voiceChatActive) {
        setVoiceChatStatus('語音對話待命');
      }
    };
    rec.onerror = e => {
      setVoiceChatStatus('錯誤：' + (e?.error || 'unknown'), '#e05050');
    };
    rec.onresult = async ev => {
      let interim = '', fin = '';
      for(let i = ev.resultIndex; i < ev.results.length; i++){
        const t = ev.results[i][0].transcript;
        ev.results[i].isFinal ? fin += t : interim += t;
      }
      $('sttInterim').textContent = interim.trim();
      if(fin.trim() && !voiceChatBusy){
        const question = fin.trim();
        pushFrontConversationLog('user', question);
        const li = document.createElement('li');
        li.style.cssText='border:1px solid rgba(201,151,62,0.2);background:rgba(12,9,5,0.5);border-radius:2px;padding:5px 8px;font-size:0.82rem';
        li.textContent = '🎤 ' + question;
        $('sttSentences').appendChild(li);
        voiceChatBusy = true;
        voiceChatAwaiting = true;
        updateVoiceButtons();
        try{ rec.stop(); }catch(_){ }
        setReply('Gemini 回答中…');
        setVoiceChatStatus('Gemini 回答中…', 'var(--gold-light)');
        try{
          const autoSpeak = !!($('chkSpeakReply')?.checked);
          const data = await requestGemini(question, {mode:'voice_chat', reason:'voice_chat_turn', concise:true, voiceChat:true, withAudio:autoSpeak, voiceName:'Leda'});
          const replyText = formatGeminiReply(`【語音提問】${question}`, data);
          setReply(replyText);
          pushFrontConversationLog('assistant', replyText);
          voiceChatAwaiting = false;
          if(autoSpeak) await speakGeminiAnswer(data);
          else if(voiceChatActive){
            setVoiceChatStatus('等待下一句語音…', 'var(--gold-light)');
            setTimeout(() => { try { rec.start(); } catch(_){} }, 250);
          }
        }catch(err){
          voiceChatAwaiting = false;
          const msg = 'Gemini 語音對話失敗：' + (err?.message || err);
          setReply(msg);
          pushFrontConversationLog('assistant', msg);
          setVoiceChatStatus('Gemini 對話失敗', '#e05050');
          if(voiceChatActive){ setTimeout(() => { try { rec.start(); } catch(_){} }, 320); }
        } finally {
          voiceChatBusy = false;
          updateVoiceButtons();
        }
      }
    };
    return rec;
  }

  function stopVoiceChat(stopSpeechToo=true){
    voiceChatActive = false;
    voiceChatBusy = false;
    voiceChatAwaiting = false;
    if(stopSpeechToo) stopSpeaking();
    if(voiceChatRec){ try{ voiceChatRec.onend = ()=>{ voiceChatListening = false; updateVoiceButtons(); }; voiceChatRec.stop(); }catch(_){} }
    voiceChatListening = false;
    setVoiceChatStatus('語音對話待命');
    updateVoiceButtons();
  }
  window.stopVoiceChat = stopVoiceChat;

  function startVoiceChat(){
    if(!geminiAvailable){ setReply('Gemini 後端尚未就緒，請先檢查 Gemini 後端。'); return; }
    if(volActive || analysisRecRunning) stopVoiceAnalysis('manual');
    stopQaStt();
    stopSpeaking();
    if(!voiceChatRec) voiceChatRec = createVoiceChatRecognizer();
    if(!voiceChatRec){ setVoiceChatStatus('此瀏覽器不支援語音辨識', '#e05050'); return; }
    voiceChatActive = true;
    voiceChatAwaiting = false;
    setVoiceChatStatus('正在啟動語音對話…', 'var(--gold-light)');
    updateVoiceButtons();
    try{ voiceChatRec.lang = $('sttLang')?.value || 'zh-TW'; voiceChatRec.start(); }catch(_){ }
  }

  // face-api 穩定 1 秒後停止，並截圖保留表情
  window.startFace = async function(){
    if(!faceApiReady){ setStatus('face-api.js 模型尚未就緒','err'); return; }
    if(!navigator.mediaDevices?.getUserMedia){ setStatus('❌ 需要 HTTPS 或 localhost','err'); return; }
    try{
      setStatus('請求鏡頭…','work');
      faceStableLabel = null;
      faceStableCount = 0;
      faceStableSinceMs = null;
      faceSnapshotDataUrl = '';
      emotionMatchedPoems = [];
      faceStream = await navigator.mediaDevices.getUserMedia({video:true});
      const v = $('faceVideo');
      v.srcObject = faceStream;
      await v.play();
      v.classList.remove('hidden');
      $('faceHint').classList.add('hidden');
      $('btnFace').textContent = '停止臉部辨識';
      $('btnFace').style.background = '#b91c1c';
      $('faceEmoRow').innerHTML = '<span class="text-xs" style="color:var(--ink-gray)">辨識中，穩定 1 秒後會自動確認並截圖…</span>';
      faceActive = true;
      setSource('臉部');
      setStatus('臉部辨識中…','ok');
      faceLoop();
    }catch(e){
      setStatus('無法使用鏡頭：' + (e.message || e),'err');
    }
  };

  window.faceLoop = async function(){
    if(!faceActive) return;
    const now = Date.now();
    if(now - lastFaceMs > 120){
      lastFaceMs = now;
      try{
        const det = await faceapi.detectSingleFace($('faceVideo'), new faceapi.TinyFaceDetectorOptions()).withFaceExpressions();
        if(det){
          const emos = mapExpr(det.expressions);
          const top = emos[0];
          const ec = {喜:'#e8b954',樂:'#5cb85c',怒:'#e05050',哀:'#7090b0',靜:'#9a8a70'};
          if(top.confidence >= 0.55){
            if(faceStableLabel === top.label){
              if(!faceStableSinceMs) faceStableSinceMs = now;
            } else {
              faceStableLabel = top.label;
              faceStableSinceMs = now;
            }
          } else {
            faceStableLabel = null;
            faceStableSinceMs = null;
          }
          const stableSec = faceStableSinceMs ? Math.min(1, (now - faceStableSinceMs) / 1000) : 0;
          $('faceEmoRow').innerHTML = `<span class="calligraphy font-semibold" style="font-size:1.4rem;color:${ec[top.label]||'var(--gold)'}">${top.label}</span><span class="text-xs" style="color:var(--ink-gray)">${(top.confidence*100).toFixed(0)}%・穩定 ${stableSec.toFixed(1)}/1 秒</span>`;
          if(faceStableLabel === top.label && faceStableSinceMs && (now - faceStableSinceMs >= 1000)){
            setSource('臉部');
            renderPredictions(emos);
            let found = findByEmotion(top.label);
            if(!found.length) found = findByItem(top.label);
            emotionMatchedPoems = found.slice(0, 8);
            if(found.length) renderPoems(found);
            faceSnapshotDataUrl = captureVideoFrame($('faceVideo'));
            stopFace({
              statusText:'臉部辨識已確認',
              finalHtml:`<span class="calligraphy font-semibold" style="font-size:1.4rem;color:${ec[top.label]||'var(--gold)'}">${top.label}</span><span class="text-xs" style="color:var(--ink-gray)">${(top.confidence*100).toFixed(0)}%・已確認並截圖</span>`
            });
            return;
          }
        } else {
          faceStableLabel = null;
          faceStableSinceMs = null;
          $('faceEmoRow').innerHTML = '<span class="text-xs" style="color:var(--ink-gray)">未偵測到人臉</span>';
        }
      }catch(e){ console.error(e); }
    }
    faceRAF = requestAnimationFrame(faceLoop);
  };

function buildCatMapLegend(){
  const leg = $('catMapLegend');
  if(!leg) return;
  const backendText = imgModelBackend ? `載入方式：${imgModelBackend}` : '載入方式：tmImage';
  leg.innerHTML = `內置模型 ID：<span style="color:var(--gold-light)">${TM_IMAGE_MODEL_ID}</span><br>模型網址：<br>${normalizeTMUrl(TM_IMAGE_MODEL_URL)}<br><span style="color:var(--gold-light)">${backendText}</span>`;
}
window.buildCatMapLegend = buildCatMapLegend;

function normalizeLabelCandidates(label=''){
  return String(label || '')
    .split(/[|,，/]/)
    .map(s => s.trim())
    .filter(Boolean);
}

// =====================
// AI Quiz / Reverse Challenge
// =====================
const QUIZ_MODE_META = {
  random: 'AI 會隨機從五種闖關模式出題，孩子可直接點選答案。',
  recite_next: 'AI 先念上半句，學生從四個選項中找出下一句。',
  error_spot: 'AI 故意念錯一個字，學生要抓到正確字。',
  image_match: 'AI 給詩名或情境，學生選出最符合的物品意象。',
  mood_recommend: 'AI 說出自己的心情，學生選出最適合安慰它的詩。',
  paraphrase_guess: 'AI 先講白話提示，學生猜是哪一首詩。'
};
let quizState = {
  score: 0,
  total: 0,
  current: null,
  answered: false
};
function escapeHtml(str=''){
  return String(str || '')
    .replace(/&/g,'&amp;')
    .replace(/</g,'&lt;')
    .replace(/>/g,'&gt;')
    .replace(/"/g,'&quot;')
    .replace(/'/g,'&#39;');
}
function shuffle(arr){
  const a = [...arr];
  for(let i=a.length-1;i>0;i--){
    const j = Math.floor(Math.random()*(i+1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}
function pickRandom(arr){ return arr[Math.floor(Math.random()*arr.length)]; }
function splitPoemClauses(content=''){
  return String(content || '')
    .split(/[，。！？；;\n\r]/)
    .map(s => s.trim())
    .filter(s => s && s.length >= 2);
}
function uniqueTextOptions(list){
  const seen = new Set();
  return list.filter(x => {
    const k = normalize(x);
    if(!k || seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}
function getRandomPoem(filterFn = () => true){
  const list = poemsDB.filter(p => p?.name && p?.content && filterFn(p));
  return list.length ? pickRandom(list) : null;
}
function getRandomDifferentPoems(excludePoem, count=3, filterFn=() => true){
  const list = shuffle(poemsDB.filter(p => p?.name && p?.content && p.name !== excludePoem?.name && filterFn(p)));
  return list.slice(0, count);
}
function getAllItems(excludeItems=[]){
  const excluded = new Set(excludeItems.map(normalize));
  const out = [];
  poemsDB.forEach(p => (p.items || []).forEach(it => {
    const n = normalize(it);
    if(n && !excluded.has(n)) out.push(it.trim());
  }));
  return uniqueTextOptions(out);
}
function emotionToScene(emotion=''){
  const map = {
    '喜':'很開心想分享', '樂':'很快樂想唱歌', '怒':'有點生氣想找人理解', '哀':'覺得難過想被安慰',
    '靜':'想安靜一下', '思':'想家想朋友', '孤獨':'覺得很孤單', '思鄉':'想家', '悲傷':'心情低落',
    '開心':'很開心', '平靜':'想靜一靜', '寂寞':'覺得寂寞'
  };
  return map[emotion] || `現在感覺${emotion}`;
}
function summarizePoemForKids(poem){
  const items = poem?.items || [];
  const emos = poem?.emotions || [];
  const has = k => items.some(x => normalize(x).includes(normalize(k)));
  const emo = emos[0] || '';
  if(has('月') && (normalize(emo).includes('思') || normalize(emo).includes('哀') || normalize(emo).includes('鄉'))){
    return '有人在安靜的夜裡看著月亮，忽然想到遠方的家。';
  }
  if(has('鵝')) return '有一隻白白的鵝，脖子彎彎，朝著天空快樂地叫。';
  if(has('雪')) return '天氣很冷，四周很安靜，只看到白雪和一位安靜的人。';
  if(has('雨')) return '路上正下著雨，人的心情也跟著有點濕濕的。';
  if(has('花') && has('鳥')) return '春天到了，花開了，也聽得到鳥兒在叫。';
  if(has('山') && has('小路')) return '山上的路彎彎的，走著走著會看見美麗的風景。';
  if(has('船')) return '有人坐著小船，在水上看風景，也想著遠方。';
  const parts = [];
  if(items.length) parts.push(`提到${items.slice(0,2).join('和')}`);
  if(emo) parts.push(`感覺${emo}`);
  return parts.length ? `這首詩${parts.join('，')}。請猜猜它是哪一首？` : `請根據提示猜一首詩。`;
}
function speakShortText(text){
  if(!text) return;
  try{ window.speechSynthesis.cancel(); }catch(_){ }
  const utter = new SpeechSynthesisUtterance(String(text));
  utter.lang = 'zh-TW';
  utter.rate = 0.95;
  utter.pitch = 1.0;
  const voices = window.speechSynthesis.getVoices().filter(v => (v.lang || '').startsWith('zh'));
  if(voices.length) utter.voice = voices[0];
  window.speechSynthesis.speak(utter);
}
function buildReciteQuestion(){
  const poem = getRandomPoem(p => splitPoemClauses(p.content).length >= 2);
  if(!poem) return null;
  const clauses = splitPoemClauses(poem.content);
  const idx = Math.floor(Math.random() * (clauses.length - 1));
  const first = clauses[idx];
  const answer = clauses[idx+1];
  const distractors = [];
  shuffle(poemsDB).forEach(p => {
    splitPoemClauses(p.content).forEach(line => {
      if(normalize(line) !== normalize(answer) && normalize(line) !== normalize(first)) distractors.push(line);
    });
  });
  const options = uniqueTextOptions([answer, ...shuffle(distractors).slice(0, 3)]).slice(0,4);
  if(options.length < 4) return null;
  return {
    modeKey:'recite_next', modeName:'詩詞接龍大挑戰', poem,
    prompt:`AI 出題：請接下一句。
「${first}」的下一句是什麼？`,
    options: shuffle(options),
    answer,
    explanation:`這一題出自《${poem.name}》，正確接句是「${answer}」。`
  };
}
function buildErrorSpotQuestion(){
  const poem = getRandomPoem(p => splitPoemClauses(p.content).some(line => [...line].filter(ch => /[一-鿿]/.test(ch)).length >= 3));
  if(!poem) return null;
  const clauses = splitPoemClauses(poem.content).filter(line => [...line].filter(ch => /[一-鿿]/.test(ch)).length >= 3);
  const line = pickRandom(clauses);
  if(!line) return null;
  const chars = [...line].map((ch, idx) => ({ch, idx})).filter(x => /[一-鿿]/.test(x.ch));
  const target = pickRandom(chars);
  const charPool = uniqueTextOptions(shuffle(poemsDB.map(p => p.content).join('').split('')).filter(ch => /[一-鿿]/.test(ch) && ch !== target.ch));
  const wrongChar = charPool[0] || '花';
  const wrongLine = [...line].map((ch, idx) => idx === target.idx ? wrongChar : ch).join('');
  const options = shuffle(uniqueTextOptions([target.ch, ...charPool.slice(1,4)])).slice(0,4);
  if(options.length < 4) return null;
  return {
    modeKey:'error_spot', modeName:'AI 抓漏糾察隊', poem,
    prompt:`AI 故意念錯了這一句：
「${wrongLine}」
應該把哪一個字改回來？`,
    options,
    answer: target.ch,
    explanation:`正確字是「${target.ch}」，原句是「${line}」。這一題出自《${poem.name}》。`
  };
}
function buildImageMatchQuestion(){
  const poem = getRandomPoem(p => (p.items || []).length >= 1);
  if(!poem) return null;
  const answer = pickRandom(poem.items);
  const distractors = shuffle(getAllItems([answer, ...(poem.items || [])])).slice(0,3);
  const options = shuffle(uniqueTextOptions([answer, ...distractors])).slice(0,4);
  if(options.length < 4) return null;
  return {
    modeKey:'image_match', modeName:'AI 點餐你上菜', poem,
    prompt:`AI 出題：如果想表現《${poem.name}》的畫面，下面哪一個物品最符合？`,
    options,
    answer,
    explanation:`《${poem.name}》常會讓人聯想到「${answer}」。你也可以再找找它的其他包含物：${(poem.items || []).join('、')}。`
  };
}
function buildMoodRecommendQuestion(){
  const poem = getRandomPoem(p => (p.emotions || []).length >= 1);
  if(!poem) return null;
  const emotion = pickRandom(poem.emotions);
  const answer = poem.name;
  const distractors = getRandomDifferentPoems(poem, 3).map(p => p.name);
  const options = shuffle(uniqueTextOptions([answer, ...distractors])).slice(0,4);
  if(options.length < 4) return null;
  return {
    modeKey:'mood_recommend', modeName:'心情安慰推薦', poem,
    prompt:`AI 說：我現在${emotionToScene(emotion)}，你會推薦我哪一首詩？`,
    options,
    answer,
    explanation:`《${poem.name}》的情緒標籤包含「${(poem.emotions || []).join('、') || emotion}」，比較符合這種心情。`
  };
}
function buildParaphraseGuessQuestion(){
  const poem = getRandomPoem();
  if(!poem) return null;
  const answer = poem.name;
  const distractors = getRandomDifferentPoems(poem, 3).map(p => p.name);
  const options = shuffle(uniqueTextOptions([answer, ...distractors])).slice(0,4);
  if(options.length < 4) return null;
  return {
    modeKey:'paraphrase_guess', modeName:'白話文反推', poem,
    prompt:`AI 提示：${summarizePoemForKids(poem)}
請猜猜是哪一首詩？`,
    options,
    answer,
    explanation:`這一題的答案是《${poem.name}》。你可以再對照包含物：${(poem.items || []).join('、') || '未標註'}；情緒：${(poem.emotions || []).join('、') || '未標註'}。`
  };
}
function buildQuizQuestion(mode){
  const builders = {
    recite_next: buildReciteQuestion,
    error_spot: buildErrorSpotQuestion,
    image_match: buildImageMatchQuestion,
    mood_recommend: buildMoodRecommendQuestion,
    paraphrase_guess: buildParaphraseGuessQuestion
  };
  const keys = Object.keys(builders);
  const order = mode === 'random' ? shuffle(keys) : [mode, ...shuffle(keys.filter(k => k !== mode))];
  for(const key of order){
    const q = builders[key]?.();
    if(q) return q;
  }
  return null;
}
function updateQuizInfo(){
  if($('quizScore')) $('quizScore').textContent = `${quizState.score} / ${quizState.total}`;
  if($('quizCurrentMode')) $('quizCurrentMode').textContent = quizState.current ? quizState.current.modeName : '尚未開始';
  if($('quizModeDesc')) $('quizModeDesc').textContent = QUIZ_MODE_META[$('quizMode')?.value || 'random'] || QUIZ_MODE_META.random;
}
function renderQuizOptions(question){
  const box = $('quizOptions');
  box.innerHTML = '';
  question.options.forEach((opt, idx) => {
    const btn = document.createElement('button');
    btn.className = 'ink-card p-4 text-left';
    btn.style.cursor = 'pointer';
    btn.innerHTML = `<div class="calligraphy text-sm" style="color:var(--gold)">${String.fromCharCode(65 + idx)}</div><div class="mt-2 text-base leading-relaxed" style="color:var(--paper)">${escapeHtml(opt)}</div>`;
    btn.onclick = () => answerQuiz(opt, btn);
    box.appendChild(btn);
  });
}
function startQuiz(){
  if(!poemsLoaded || !poemsDB.length){
    $('quizQuestion').textContent = '請先載入詩詞資料，才能開始闖關。';
    $('quizFeedback').textContent = '目前還沒有可出題的詩詞資料。';
    $('quizOptions').innerHTML = '';
    return;
  }
  const mode = $('quizMode')?.value || 'random';
  const q = buildQuizQuestion(mode);
  if(!q){
    $('quizQuestion').textContent = '目前資料不足，還無法產生這個模式的題目。';
    $('quizFeedback').textContent = '請確認詩詞資料至少有詩名、內容，並盡量補上包含物與情緒。';
    $('quizOptions').innerHTML = '';
    return;
  }
  quizState.current = q;
  quizState.answered = false;
  $('quizQuestion').textContent = q.prompt;
  $('quizFeedback').textContent = '請直接點一個選項作答。';
  renderQuizOptions(q);
  updateQuizInfo();
  setStatus('AI 闖關題目已生成','ok');
}
function answerQuiz(selected, clickedBtn){
  if(!quizState.current || quizState.answered) return;
  quizState.answered = true;
  quizState.total += 1;
  const correct = normalize(selected) === normalize(quizState.current.answer);
  if(correct) quizState.score += 1;
  updateQuizInfo();
  [...$('quizOptions').children].forEach(card => {
    const raw = normalize(card.textContent.replace(/^[A-D]\s*/, ''));
    const isCorrect = raw.includes(normalize(quizState.current.answer));
    card.style.borderColor = isCorrect ? 'rgba(92,184,92,0.75)' : 'rgba(201,151,62,0.15)';
    if(card === clickedBtn && !correct) card.style.borderColor = 'rgba(224,80,80,0.8)';
    card.style.background = isCorrect ? 'rgba(74,103,64,0.22)' : (card === clickedBtn && !correct ? 'rgba(192,57,43,0.12)' : 'rgba(22,13,6,0.75)');
    card.style.cursor = 'default';
  });
  const poem = quizState.current.poem;
  if(poem) renderPoems([poem]);
  setCurrentPoem(poem || null);
  if(correct){
    $('quizFeedback').innerHTML = `<span style="color:#8ed18e">答對了！</span> ${escapeHtml(quizState.current.explanation)}<br><br>小提醒：你可以按「下一題」再挑戰。`;
    setReply(`AI 闖關答對：${quizState.current.modeName}
答案：${quizState.current.answer}`);
    speakShortText(`答對了！${quizState.current.answer}`);
  } else {
    $('quizFeedback').innerHTML = `<span style="color:#f19a8f">這題還差一點。</span> 正確答案是「${escapeHtml(quizState.current.answer)}」。<br>${escapeHtml(quizState.current.explanation)}`;
    setReply(`AI 闖關訂正
正確答案：${quizState.current.answer}`);
    speakShortText(`這題的正確答案是 ${quizState.current.answer}`);
  }
}
function readQuizQuestion(){
  if(!quizState.current){
    speakShortText('請先按開始闖關。');
    return;
  }
  speakShortText(quizState.current.prompt);
}



  function bridgePlainText(id, fallback=''){
    const el = $(id);
    return el ? ((el.innerText || el.textContent || '').trim()) : fallback;
  }

  function bridgePlainHtml(id, fallback=''){
    const el = $(id);
    return el ? ((el.innerHTML || '').trim()) : fallback;
  }

  function bridgeArray(v){
    if(Array.isArray(v)) return v.filter(Boolean);
    if(v == null || v === '') return [];
    return String(v).split(/[、,，;；｜|]/).map(s => s.trim()).filter(Boolean);
  }

  function bridgePoem(poem){
    if(!poem) return null;
    return {
      name: poem.name || '',
      author: poem.author || '',
      dynasty: poem.dynasty || '',
      genre: poem.genre || '',
      content: poem.content || '',
      appreciation: poem.appreciation || '',
      items: bridgeArray(poem.items),
      emotions: bridgeArray(poem.emotions)
    };
  }

  function getFrontBridgeState(){
    const quizButtons = $('quizOptions') ? [...$('quizOptions').querySelectorAll('button')] : [];
    return {
      currentPoem: bridgePoem(currentPoem),
      imageMatchedPoems: imageMatchedPoems.map(bridgePoem).filter(Boolean),
      emotionMatchedPoems: emotionMatchedPoems.map(bridgePoem).filter(Boolean),
      faceSnapshotDataUrl: faceSnapshotDataUrl || '',
      currentPoemText: bridgePlainText('currentPoem', '未選取'),
      qaReply: bridgePlainText('qaReply', ''),
      conversationLog: frontConversationLog.map(item => ({ role: item.role, text: item.text })),
      sttStatus: bridgePlainText('sttStatus', ''),
      voiceChatStatus: bridgePlainText('voiceChatStatus', ''),
      quizQuestion: bridgePlainText('quizQuestion', ''),
      quizFeedback: bridgePlainText('quizFeedback', ''),
      quizScore: bridgePlainText('quizScore', ''),
      quizMode: $('quizMode')?.value || 'random',
      quizOptions: quizButtons.map(btn => ({
        text: (btn.innerText || btn.textContent || '').trim(),
        disabled: !!btn.disabled,
        background: btn.style.background || '',
        borderColor: btn.style.borderColor || ''
      })),
      imgRawResultText: bridgePlainText('imgRawResult', ''),
      imgCatResultText: bridgePlainText('imgCatResult', ''),
      imgRawResultHtml: bridgePlainHtml('imgRawResult', ''),
      imgCatResultHtml: bridgePlainHtml('imgCatResult', ''),
      readingVolumeLabel: bridgePlainText('volLabel', ''),
      readingSpeedLabel: bridgePlainText('rateLabel', ''),
      readingResultText: bridgePlainText('audioResultText', ''),
      readingAdviceText: bridgePlainText('audioAdvice', ''),
      emotionText: bridgePlainText('faceEmoRow', ''),
      statusText: bridgePlainText('statusText', ''),
      faceActive: !!faceActive,
      qaRecRunning: !!qaRecRunning,
      voiceChatActive: !!voiceChatActive,
      voiceChatBusy: !!voiceChatBusy,
      voiceChatListening: !!voiceChatListening,
      analysisRecRunning: !!analysisRecRunning,
      volActive: !!volActive,
      sttRunning: !!sttRunning,
      imagePreviewVisible: !!($('imgPreview') && !$('imgPreview').classList.contains('hidden') && $('imgPreview').src),
      hasFaceStream: !!($('faceVideo')?.srcObject),
      imgModelReady: !!imgModelReady,
      imgModelBackend: imgModelBackend || ''
    };
  }

  function clearAskSession(){
    try{ stopQaStt(); }catch(_){ }
    try{ stopVoiceChat(true); }catch(_){ }
    if($('txtGemini')) $('txtGemini').value = '';
    if($('qaReply')) $('qaReply').textContent = '';
    if($('sttSentences')) $('sttSentences').innerHTML = '';
    if($('sttInterim')) $('sttInterim').textContent = '';
    if($('sttStatus')) $('sttStatus').textContent = '語音問答待命';
    if($('voiceChatStatus')) $('voiceChatStatus').textContent = '語音對話待命';
    clearFrontConversationLog();
    setCurrentPoem(null);
    updateVoiceButtons();
  }

  function clearImageSession(){
    if($('imgFile')) $('imgFile').value = '';
    if($('imgPreview')){ $('imgPreview').src = ''; $('imgPreview').classList.add('hidden'); }
    if($('imgHint')) $('imgHint').classList.remove('hidden');
    if($('imgRawResult')) $('imgRawResult').innerHTML = '<div class="text-xs text-center py-4" style="color:var(--ink-gray)">等待辨識</div>';
    if($('imgCatResult')) $('imgCatResult').innerHTML = '<div class="text-xs text-center" style="color:var(--ink-gray)">對應結果會顯示於此</div>';
    imageMatchedPoems = [];
    setCurrentPoem(null);
  }

  function clearReadingSession(){
    try{ stopVoiceAnalysis('manual'); }catch(_){ }
    if($('volLabel')) $('volLabel').textContent = '—';
    if($('rateLabel')) $('rateLabel').textContent = '—';
    if($('audioResultText')) $('audioResultText').textContent = '等待分析';
    if($('audioAdvice')) $('audioAdvice').textContent = '';
  }

  function clearEmotionSession(){
    try{ stopFace({clearResult:true, statusText:'已停止臉部辨識'}); }catch(_){ }
    if($('faceEmoRow')) $('faceEmoRow').innerHTML = '<span class="text-xs" style="color:var(--ink-gray)">尚未偵測</span>';
    emotionMatchedPoems = [];
    faceSnapshotDataUrl = '';
    setCurrentPoem(null);
  }

  window.getFrontBridgeState = getFrontBridgeState;
  window.clearAskSession = clearAskSession;
  window.clearImageSession = clearImageSession;
  window.clearReadingSession = clearReadingSession;
  window.clearEmotionSession = clearEmotionSession;
  window.startQaStt = startQaStt;
  window.stopQaStt = stopQaStt;
  window.startVoiceChat = startVoiceChat;
  window.startQuiz = startQuiz;
  window.readQuizQuestion = readQuizQuestion;
  window.stopFace = stopFace;
  ['currentPoem','faceActive','qaRecRunning','voiceChatActive','analysisRecRunning','volActive','sttRunning'].forEach(name => {
    if(!Object.getOwnPropertyDescriptor(window, name)){
      Object.defineProperty(window, name, {
        configurable: true,
        enumerable: false,
        get(){
          if(name === 'currentPoem') return bridgePoem(currentPoem);
          if(name === 'faceActive') return !!faceActive;
          if(name === 'qaRecRunning') return !!qaRecRunning;
          if(name === 'voiceChatActive') return !!voiceChatActive;
          if(name === 'analysisRecRunning') return !!analysisRecRunning;
          if(name === 'volActive') return !!volActive;
          if(name === 'sttRunning') return !!sttRunning;
          return undefined;
        }
      });
    }
  });

  // Rewire button events so audio analysis and QA are separated
  try{ if(stt && sttRunning) stt.stop(); }catch(_){}
  stt = initStt();
  updateVoiceButtons();
  if($('btnVolume')) $('btnVolume').onclick = () => (volActive || analysisRecRunning) ? stopVoiceAnalysis('manual') : startVoiceAnalysis();
  if($('btnStt')) $('btnStt').onclick = () => qaRecRunning ? stopQaStt() : startQaStt();
  if($('btnGeminiHealth')) $('btnGeminiHealth').onclick = pingGeminiHealth;
  if($('btnAskGemini')) $('btnAskGemini').onclick = askGeminiFromInput;
  if($('btnStopSpeak')) $('btnStopSpeak').onclick = stopSpeaking;
  if($('btnVoiceChat')) $('btnVoiceChat').onclick = () => voiceChatActive ? stopVoiceChat(true) : startVoiceChat();
  if($('btnQuizStart')) $('btnQuizStart').onclick = startQuiz;
  if($('btnQuizNext')) $('btnQuizNext').onclick = startQuiz;
  if($('btnQuizRead')) $('btnQuizRead').onclick = readQuizQuestion;
  if($('quizMode')) $('quizMode').addEventListener('change', updateQuizInfo);
  updateQuizInfo();
  if($('sttLang')) $('sttLang').addEventListener('change', ()=>{
    if(stt && qaRecRunning) { try{ stt.stop(); }catch(_){} }
    stt = initStt();
    if(voiceChatRec && voiceChatListening){ try{ voiceChatRec.stop(); }catch(_){}; voiceChatRec = createVoiceChatRecognizer(); if(voiceChatActive){ setTimeout(()=>{ try{ voiceChatRec.start(); }catch(_){} }, 300); } }
    $('sttStatus').textContent='語言已切換，待命';
  });

  buildCatMapLegend();
})();
