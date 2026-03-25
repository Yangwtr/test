import express from 'express';
import path from 'path';
import fsp from 'fs/promises';
import crypto from 'crypto';
import { fileURLToPath } from 'url';
import dotenv from 'dotenv';

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const app = express();
const PORT = process.env.PORT || 3000;
const MODEL = process.env.GEMINI_MODEL || 'gemini-2.5-flash';
const TTS_MODEL = process.env.GEMINI_TTS_MODEL || 'gemini-2.5-flash-preview-tts';
const STT_MODEL = process.env.GEMINI_STT_MODEL || MODEL;
const TTS_VOICE = process.env.GEMINI_TTS_VOICE || 'Leda';
const TTS_STYLE = process.env.GEMINI_TTS_STYLE || '請用溫柔、清楚、像小朋友好朋友一樣自然親切的語氣朗讀。';
const API_KEY = process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY || '';
const API_BASE = process.env.GEMINI_API_BASE || 'https://generativelanguage.googleapis.com/v1beta';
const TTS_CACHE_DIR = path.join(__dirname, '.tts-cache');
const TTS_CACHE_READY = fsp.mkdir(TTS_CACHE_DIR, { recursive: true }).catch(() => {});
const inflightTtsRequests = new Map();

const SYSTEM_INSTRUCTION = `你是「古今同頻」詩詞學習系統的 Gemini 後端助教。
請用繁體中文回答，對象是國小學生與老師。
請遵守以下規則：
1. 優先使用我提供的作品上下文、已選詩詞、辨識意圖與預測標籤。
2. 若上下文不足，可以根據一般詩詞知識回答，但不要假裝看過不存在的資料表。
3. 若問題仍不明確，直接提出一個最短追問。
4. 回答要可教學、可直接顯示在前端；避免冗長。
5. 若是翻譯、字詞解釋、背景故事、押韻、對仗，可直接給教學式回答。
6. 不要輸出 Markdown code fence。
7. 如果無法確定，清楚說「我目前無法確定」。
8. 只能使用繁體中文，不要夾帶英文鍵名、模型名稱、JSON 標籤或多餘特殊符號。
9. 回答要先直接說答案，再補一小句說明即可。`;

app.use(express.json({ limit: '25mb' }));
app.use(express.static(path.join(__dirname, 'public')));

app.get('/api/health', (_req, res) => {
  res.json({ ok: true, hasKey: Boolean(API_KEY), model: MODEL, ttsModel: TTS_MODEL, sttModel: STT_MODEL });
});

function buildChatPrompt(contextPayload, { concise = false, voiceChat = false } = {}) {
  const extraRules = [];
  if (concise || voiceChat) {
    extraRules.push('請把主要回答控制在 2 到 4 句內，句子短一點，適合直接唸給國小學生聽。');
  }
  if (voiceChat) {
    extraRules.push('這次是即時語音對話，優先給自然口語回答，不要列太多點。');
    extraRules.push('輸出只要自然的繁體中文句子，不要英文字、不要 JSON 鍵名、不要特殊裝飾。');
  }
  return [
    SYSTEM_INSTRUCTION,
    '以下是前端傳來的上下文 JSON，請根據這些資料回答。',
    '若有 currentPoem，優先用它回答。',
    '若沒有 currentPoem，但問題本身明確，仍可用一般古詩詞知識回答。',
    '請只輸出一個 JSON 物件，欄位為 answer, needsClarification, suggestedFollowUp。',
    'answer 與 suggestedFollowUp 內容都只能用自然、完整、口語化的繁體中文。',
    ...extraRules,
    JSON.stringify(contextPayload, null, 2),
  ].join('\n\n');
}

function extractTextParts(responseJson) {
  const candidates = responseJson?.candidates || [];
  const texts = [];
  for (const candidate of candidates) {
    const parts = candidate?.content?.parts || [];
    for (const part of parts) {
      if (typeof part?.text === 'string') texts.push(part.text);
    }
  }
  return texts.join('\n').trim();
}

function extractInlineAudioPart(responseJson) {
  const candidates = responseJson?.candidates || [];
  for (const candidate of candidates) {
    const parts = candidate?.content?.parts || [];
    for (const part of parts) {
      if (part?.inlineData?.data) return part.inlineData;
      if (part?.inline_data?.data) return part.inline_data;
    }
  }
  return null;
}

function extractJsonObject(text = '') {
  const raw = String(text || '').trim();
  if (!raw) return '';
  const match = raw.match(/\{[\s\S]*\}/);
  return match ? match[0] : raw;
}

function parseModelJsonResponse(text = '') {
  const raw = String(text || '').trim();
  if (!raw) return null;
  const candidates = [raw, extractJsonObject(raw)];
  for (const candidate of candidates) {
    try { return JSON.parse(candidate); } catch (_) {}
  }
  return null;
}

function sanitiseDisplayText(text = '', { stripEnglish = false } = {}) {
  let out = String(text || '')
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/[\u0000-\u001F\u007F]/g, ' ')
    .replace(/[\u200B-\u200D\uFEFF]/g, '')
    .replace(/(^|\n)\s*(answer|suggestedFollowUp|needsClarification|model)\s*[:：]/gi, '$1')
    .replace(/[{}\[\]"`]/g, '')
    .replace(/[•▪◦◆◇★☆※]/g, '')
    .replace(/【[^】]*(?:Gemini|模型|辨識意圖|語音提問)[^】]*】/gi, '')
    .replace(/(?:^|\n)\s*追問建議\s*[:：]/g, '\n你還可以問我：')
    .replace(/Here is the JSON requested:?\s*json/gi, '')
    .replace(/\b(?:json|markdown|model|answer|suggestedFollowUp|needsClarification)\b\s*[:：]?/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (stripEnglish) {
    out = out.replace(/\b(?:json|markdown|model|answer|suggestedFollowUp|needsClarification|gemini|flash|preview|tts)\b/gi, '');
  }
  return out.replace(/\s{2,}/g, ' ').replace(/\n{3,}/g, '\n\n').trim();
}

function normaliseTtsText(text = '') {
  return String(text || '')
    .replace(/【[^\n]*】/g, '')
    .replace(/追問建議：[^\n]+/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function buildWavBufferFromPcm(pcmBuffer, sampleRate = 24000, channels = 1, bitDepth = 16) {
  const headerSize = 44;
  const byteRate = sampleRate * channels * bitDepth / 8;
  const blockAlign = channels * bitDepth / 8;
  const wavBuffer = Buffer.alloc(headerSize + pcmBuffer.length);
  wavBuffer.write('RIFF', 0);
  wavBuffer.writeUInt32LE(36 + pcmBuffer.length, 4);
  wavBuffer.write('WAVE', 8);
  wavBuffer.write('fmt ', 12);
  wavBuffer.writeUInt32LE(16, 16);
  wavBuffer.writeUInt16LE(1, 20);
  wavBuffer.writeUInt16LE(channels, 22);
  wavBuffer.writeUInt32LE(sampleRate, 24);
  wavBuffer.writeUInt32LE(byteRate, 28);
  wavBuffer.writeUInt16LE(blockAlign, 32);
  wavBuffer.writeUInt16LE(bitDepth, 34);
  wavBuffer.write('data', 36);
  wavBuffer.writeUInt32LE(pcmBuffer.length, 40);
  pcmBuffer.copy(wavBuffer, headerSize);
  return wavBuffer;
}

function makeEmptyTtsPayload({ voiceName } = {}) {
  return { audioBase64: '', mimeType: 'audio/wav', voiceName: voiceName || TTS_VOICE, ttsModel: TTS_MODEL, cached: false, ttsFallback: true };
}

function makeTtsCacheKey(text, { voiceName, stylePrompt } = {}) {
  return crypto.createHash('sha1').update(JSON.stringify({
    model: TTS_MODEL,
    voiceName: voiceName || TTS_VOICE,
    stylePrompt: stylePrompt || TTS_STYLE,
    text: normaliseTtsText(text || ''),
  })).digest('hex');
}

async function readCachedTtsPayload(cacheKey) {
  await TTS_CACHE_READY;
  const cacheFile = path.join(TTS_CACHE_DIR, `${cacheKey}.json`);
  try {
    const raw = await fsp.readFile(cacheFile, 'utf8');
    return JSON.parse(raw);
  } catch (_) {
    return null;
  }
}

async function writeCachedTtsPayload(cacheKey, payload) {
  await TTS_CACHE_READY;
  const cacheFile = path.join(TTS_CACHE_DIR, `${cacheKey}.json`);
  try { await fsp.writeFile(cacheFile, JSON.stringify(payload), 'utf8'); } catch (_) {}
}

function isQuotaError(error) {
  const msg = String(error?.message || '');
  const status = Number(error?.status) || 0;
  return status === 429 || /quota|resource_exhausted|rate limit/i.test(msg);
}

function friendlyTtsErrorMessage(error) {
  if (isQuotaError(error)) return 'Gemini 聲音配額已達上限，這次先改用文字回答。';
  return 'Gemini 語音暫時還沒準備好，這次先顯示文字回答。';
}

function makeApiErrorPayload(error, fallbackMessage) {
  const message = String(error?.message || fallbackMessage || 'Gemini 呼叫失敗。');
  if (isQuotaError(error)) {
    return {
      status: 429,
      body: {
        error: 'Gemini 聲音配額已達上限，新的語音暫時無法即時產生。系統會優先重用已快取的 Gemini 聲音，並在必要時改用備援語音。',
        quotaExceeded: true,
        details: message,
      },
    };
  }
  return { status: Number(error?.status) || 500, body: { error: message } };
}

async function callGeminiGenerateContent(model, body) {
  if (!API_KEY) {
    const err = new Error('伺服器尚未設定 GEMINI_API_KEY。');
    err.status = 500;
    throw err;
  }
  const resp = await fetch(`${API_BASE}/models/${encodeURIComponent(model)}:generateContent?key=${encodeURIComponent(API_KEY)}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const json = await resp.json().catch(() => ({}));
  if (!resp.ok) {
    const err = new Error(json?.error?.message || `Gemini API 失敗（${resp.status}）`);
    err.status = resp.status;
    err.raw = json;
    throw err;
  }
  return json;
}



async function generateTranscriptFromInlineAudio(audioBase64, mimeType = 'audio/webm', { language = '繁體中文' } = {}) {
  const cleanAudio = String(audioBase64 || '').trim();
  if (!cleanAudio) {
    const err = new Error('沒有收到音訊資料。');
    err.status = 400;
    throw err;
  }
  const prompt = `請把這段語音轉成${language}文字。只輸出辨識到的句子本身，不要加引號、不要解釋、不要 JSON、不要標題。若幾乎沒有語音內容，請只回傳空字串。`;
  const responseJson = await callGeminiGenerateContent(STT_MODEL, {
    contents: [{
      parts: [
        { text: prompt },
        { inline_data: { mime_type: mimeType || 'audio/webm', data: cleanAudio } }
      ]
    }],
    generationConfig: {
      temperature: 0.1,
      maxOutputTokens: 120,
    },
  });
  return sanitiseDisplayText(extractTextParts(responseJson) || '', { stripEnglish: true });
}

async function generateChatResponse(contextPayload, { concise = false, voiceChat = false } = {}) {
  const prompt = buildChatPrompt(contextPayload, { concise, voiceChat });
  const responseJson = await callGeminiGenerateContent(MODEL, {
    contents: [{ parts: [{ text: prompt }] }],
    generationConfig: {
      temperature: 0.2,
      maxOutputTokens: concise || voiceChat ? 280 : 700,
      responseMimeType: 'application/json',
    },
  });

  const text = extractTextParts(responseJson) || '模型沒有回傳內容。';
  const parsed = parseModelJsonResponse(text) || { answer: text };
  return {
    model: MODEL,
    answer: sanitiseDisplayText(parsed.answer || '模型沒有回傳內容。'),
    needsClarification: Boolean(parsed.needsClarification),
    suggestedFollowUp: sanitiseDisplayText(parsed.suggestedFollowUp || '', { stripEnglish: true }),
  };
}

async function generateTtsPayload(text, { voiceName, stylePrompt } = {}) {
  const cleanText = normaliseTtsText(text);
  const finalVoice = voiceName || TTS_VOICE;
  const finalStyle = stylePrompt || TTS_STYLE;
  if (!cleanText) return { audioBase64: '', mimeType: 'audio/wav', voiceName: finalVoice, ttsModel: TTS_MODEL };

  const cacheKey = makeTtsCacheKey(cleanText, { voiceName: finalVoice, stylePrompt: finalStyle });
  const cached = await readCachedTtsPayload(cacheKey);
  if (cached?.audioBase64) return { ...cached, cached: true };
  if (inflightTtsRequests.has(cacheKey)) return inflightTtsRequests.get(cacheKey);

  const work = (async () => {
    let responseJson = await callGeminiGenerateContent(TTS_MODEL, {
      contents: [{ parts: [{ text: `${finalStyle}\n\n請直接朗讀下面內容，不要加開場白：\n${cleanText}` }] }],
      generationConfig: {
        responseModalities: ['AUDIO'],
        speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: finalVoice } } },
      },
    });

    let inlineAudio = extractInlineAudioPart(responseJson);
    if (!inlineAudio?.data) {
      const shortened = cleanText.slice(0, 120);
      if (shortened && shortened !== cleanText) {
        responseJson = await callGeminiGenerateContent(TTS_MODEL, {
          contents: [{ parts: [{ text: `${finalStyle}\n\n請直接朗讀下面內容，不要加開場白：\n${shortened}` }] }],
          generationConfig: {
            responseModalities: ['AUDIO'],
            speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: finalVoice } } },
          },
        });
        inlineAudio = extractInlineAudioPart(responseJson);
      }
    }
    if (!inlineAudio?.data) {
      return { ...makeEmptyTtsPayload({ voiceName: finalVoice }), error: 'Gemini TTS 暫時沒有回傳音訊資料。' };
    }
    const pcmBuffer = Buffer.from(inlineAudio.data, 'base64');
    const wavBuffer = buildWavBufferFromPcm(pcmBuffer);
    const payload = {
      audioBase64: wavBuffer.toString('base64'),
      mimeType: 'audio/wav',
      voiceName: finalVoice,
      ttsModel: TTS_MODEL,
      cached: false,
    };
    await writeCachedTtsPayload(cacheKey, payload);
    return payload;
  })();

  inflightTtsRequests.set(cacheKey, work);
  try { return await work; } finally { inflightTtsRequests.delete(cacheKey); }
}



app.post('/api/gemini/transcribe', async (req, res) => {
  try {
    const { audioBase64 = '', mimeType = 'audio/webm', language = '繁體中文' } = req.body || {};
    if (!String(audioBase64).trim()) {
      return res.status(400).json({ error: '沒有收到音訊資料。' });
    }
    const text = await generateTranscriptFromInlineAudio(audioBase64, mimeType, { language });
    res.json({ text, model: STT_MODEL });
  } catch (error) {
    const payload = makeApiErrorPayload(error, 'Gemini 語音轉文字失敗。');
    res.status(payload.status).json(payload.body);
  }
});

app.post('/api/gemini/chat', async (req, res) => {
  try {
    const {
      question,
      mode = 'manual',
      reason = '',
      currentPoem = null,
      predictions = [],
      currentIntent = null,
      alternateIntent = null,
      source = '',
      workbookLoaded = false,
      poemsLoaded = false,
      concise = false,
      voiceChat = false,
    } = req.body || {};

    if (!question || typeof question !== 'string') {
      return res.status(400).json({ error: 'question 為必填字串。' });
    }

    const data = await generateChatResponse({ question, mode, reason, source, workbookLoaded, poemsLoaded, currentIntent, alternateIntent, predictions, currentPoem }, { concise: !!concise, voiceChat: !!voiceChat });
    res.json(data);
  } catch (error) {
    console.error(error);
    res.status(Number(error?.status) || 500).json({ error: error?.message || 'Gemini 呼叫失敗。' });
  }
});

app.post('/api/gemini/tts', async (req, res) => {
  try {
    const { text, voiceName = TTS_VOICE, stylePrompt = TTS_STYLE } = req.body || {};
    if (!text || typeof text !== 'string') {
      return res.status(400).json({ error: 'text 為必填字串。' });
    }
    const ttsPayload = await generateTtsPayload(text, { voiceName, stylePrompt });
    res.json(ttsPayload);
  } catch (error) {
    console.error(error);
    const apiErr = makeApiErrorPayload(error, 'Gemini TTS 呼叫失敗。');
    res.json({ ...makeEmptyTtsPayload(), error: friendlyTtsErrorMessage(error), quotaExceeded: !!apiErr.body?.quotaExceeded, details: apiErr.body?.details || apiErr.body?.error || '' });
  }
});

app.post('/api/gemini/chat-tts', async (req, res) => {
  try {
    const {
      question,
      mode = 'manual',
      reason = '',
      currentPoem = null,
      predictions = [],
      currentIntent = null,
      alternateIntent = null,
      source = '',
      workbookLoaded = false,
      poemsLoaded = false,
      concise = false,
      voiceChat = false,
      voiceName = TTS_VOICE,
      stylePrompt = TTS_STYLE,
    } = req.body || {};

    if (!question || typeof question !== 'string') {
      return res.status(400).json({ error: 'question 為必填字串。' });
    }

    const data = await generateChatResponse({ question, mode, reason, source, workbookLoaded, poemsLoaded, currentIntent, alternateIntent, predictions, currentPoem }, { concise: !!concise, voiceChat: !!voiceChat });
    try {
      const ttsPayload = await generateTtsPayload(data.answer, { voiceName, stylePrompt });
      res.json({ ...data, ...ttsPayload, ttsFallback: !!ttsPayload.ttsFallback, quotaExceeded: !!ttsPayload.quotaExceeded, ttsError: ttsPayload.error || '' });
    } catch (ttsError) {
      console.error(ttsError);
      res.json({ ...data, ...makeEmptyTtsPayload({ voiceName }), quotaExceeded: isQuotaError(ttsError), ttsError: friendlyTtsErrorMessage(ttsError) });
    }
  } catch (error) {
    console.error(error);
    const apiErr = makeApiErrorPayload(error, 'Gemini 語音回答呼叫失敗。');
    res.status(apiErr.status).json(apiErr.body);
  }
});

app.get('/{*splat}', (_req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.listen(PORT, () => {
  console.log(`Server running on http://localhost:${PORT}`);
});
