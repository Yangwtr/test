import express from 'express';
import path from 'path';
import { fileURLToPath } from 'url';
import { GoogleGenAI } from '@google/genai';
import dotenv from 'dotenv';

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const app = express();
const PORT = process.env.PORT || 3000;
const MODEL = process.env.GEMINI_MODEL || 'gemini-3-flash-preview';
const TTS_MODEL = process.env.GEMINI_TTS_MODEL || 'gemini-2.5-flash-preview-tts';
const TTS_VOICE = process.env.GEMINI_TTS_VOICE || 'Leda';
const TTS_STYLE = process.env.GEMINI_TTS_STYLE || '請用溫柔、清楚、像小朋友好朋友一樣自然親切的語氣朗讀。';
const API_KEY = process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY || '';
const ai = API_KEY ? new GoogleGenAI({ apiKey: API_KEY }) : null;

const SYSTEM_INSTRUCTION = `你是「古今同頻」詩詞學習系統的 Gemini 後端助教。
請用繁體中文回答，對象是國小學生與老師。
請遵守以下規則：
1. 優先使用我提供的作品上下文、已選詩詞、辨識意圖與預測標籤。
2. 若上下文不足，可以根據一般詩詞知識回答，但不要假裝看過不存在的資料表。
3. 若問題仍不明確，直接提出一個最短追問。
4. 回答要可教學、可直接顯示在前端；避免冗長。
5. 若是翻譯、字詞解釋、背景故事、押韻、對仗，可直接給教學式回答。
6. 不要輸出 Markdown code fence。
7. 如果無法確定，清楚說「我目前無法確定」。`;

app.use(express.json({ limit: '1mb' }));
app.use(express.static(path.join(__dirname, 'public')));

app.get('/api/health', (_req, res) => {
  res.json({
    ok: true,
    hasKey: Boolean(API_KEY),
    model: MODEL,
  });
});


function buildChatPrompt(contextPayload, { concise = false, voiceChat = false } = {}) {
  const extraRules = [];
  if (concise || voiceChat) {
    extraRules.push('請把主要回答控制在 2 到 4 句內，句子短一點，適合直接唸給國小學生聽。');
  }
  if (voiceChat) {
    extraRules.push('這次是即時語音對話，優先給自然口語回答，不要列太多點。');
  }
  return [
    '以下是前端傳來的上下文 JSON，請根據這些資料回答。',
    '若有 currentPoem，優先用它回答。',
    '若沒有 currentPoem，但問題本身明確，仍可用一般古詩詞知識回答。',
    '回答格式請輸出 JSON 物件，欄位為 answer, needsClarification, suggestedFollowUp。',
    ...extraRules,
    JSON.stringify(contextPayload, null, 2),
  ].join('\n\n');
}

async function generateChatResponse(contextPayload, { concise = false, voiceChat = false } = {}) {
  const prompt = buildChatPrompt(contextPayload, { concise, voiceChat });
  const response = await ai.models.generateContent({
    model: MODEL,
    contents: prompt,
    config: {
      systemInstruction: SYSTEM_INSTRUCTION,
      temperature: 0.2,
      maxOutputTokens: concise || voiceChat ? 280 : 700,
      responseMimeType: 'application/json',
      responseSchema: {
        type: 'object',
        properties: {
          answer: { type: 'string' },
          needsClarification: { type: 'boolean' },
          suggestedFollowUp: { type: 'string' },
        },
        required: ['answer'],
      },
    },
  });

  let parsed;
  try {
    parsed = JSON.parse(response.text);
  } catch {
    parsed = { answer: response.text || '模型沒有回傳內容。' };
  }
  return {
    model: MODEL,
    answer: parsed.answer || '模型沒有回傳內容。',
    needsClarification: Boolean(parsed.needsClarification),
    suggestedFollowUp: parsed.suggestedFollowUp || '',
  };
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

function normaliseTtsText(text = '') {
  return String(text || '')
    .replace(/【[^\n]*】/g, '')
    .replace(/追問建議：[^\n]+/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

async function generateTtsPayload(text, { voiceName, stylePrompt } = {}) {
  const cleanText = normaliseTtsText(text);
  if (!cleanText) return { audioBase64: '', mimeType: 'audio/wav', voiceName: voiceName || TTS_VOICE };

  const response = await ai.models.generateContent({
    model: TTS_MODEL,
    contents: [{
      parts: [{
        text: `${stylePrompt || TTS_STYLE}\n\n請直接朗讀下面內容，不要加開場白：\n${cleanText}`,
      }],
    }],
    config: {
      responseModalities: ['AUDIO'],
      speechConfig: {
        voiceConfig: {
          prebuiltVoiceConfig: {
            voiceName: voiceName || TTS_VOICE,
          },
        },
      },
    },
  });

  const pcmBase64 = response.candidates?.[0]?.content?.parts?.[0]?.inlineData?.data;
  if (!pcmBase64) {
    throw new Error('Gemini TTS 沒有回傳音訊資料。');
  }
  const pcmBuffer = Buffer.from(pcmBase64, 'base64');
  const wavBuffer = buildWavBufferFromPcm(pcmBuffer);
  return {
    audioBase64: wavBuffer.toString('base64'),
    mimeType: 'audio/wav',
    voiceName: voiceName || TTS_VOICE,
    ttsModel: TTS_MODEL,
  };
}

app.post('/api/gemini/chat', async (req, res) => {
  try {
    if (!ai) {
      return res.status(500).json({ error: '伺服器尚未設定 GEMINI_API_KEY。' });
    }

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

    const contextPayload = {
      question,
      mode,
      reason,
      source,
      workbookLoaded,
      poemsLoaded,
      currentIntent,
      alternateIntent,
      predictions,
      currentPoem,
    };

    const data = await generateChatResponse(contextPayload, { concise: !!concise, voiceChat: !!voiceChat });
    res.json(data);
  } catch (error) {
    console.error(error);
    const status = Number(error?.status) || 500;
    res.status(status).json({
      error: error?.message || 'Gemini 呼叫失敗。',
    });
  }
});

app.post('/api/gemini/tts', async (req, res) => {
  try {
    if (!ai) {
      return res.status(500).json({ error: '伺服器尚未設定 GEMINI_API_KEY。' });
    }
    const {
      text,
      voiceName = TTS_VOICE,
      stylePrompt = TTS_STYLE,
    } = req.body || {};
    if (!text || typeof text !== 'string') {
      return res.status(400).json({ error: 'text 為必填字串。' });
    }
    const ttsPayload = await generateTtsPayload(text, { voiceName, stylePrompt });
    res.json(ttsPayload);
  } catch (error) {
    console.error(error);
    const status = Number(error?.status) || 500;
    res.status(status).json({
      error: error?.message || 'Gemini TTS 呼叫失敗。',
    });
  }
});

app.post('/api/gemini/chat-tts', async (req, res) => {
  try {
    if (!ai) {
      return res.status(500).json({ error: '伺服器尚未設定 GEMINI_API_KEY。' });
    }

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

    const contextPayload = {
      question,
      mode,
      reason,
      source,
      workbookLoaded,
      poemsLoaded,
      currentIntent,
      alternateIntent,
      predictions,
      currentPoem,
    };

    const data = await generateChatResponse(contextPayload, { concise: !!concise, voiceChat: !!voiceChat });
    const ttsPayload = await generateTtsPayload(data.answer, { voiceName, stylePrompt });
    res.json({ ...data, ...ttsPayload });
  } catch (error) {
    console.error(error);
    const status = Number(error?.status) || 500;
    res.status(status).json({
      error: error?.message || 'Gemini 語音回答呼叫失敗。',
    });
  }
});

app.get('/{*splat}', (_req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.listen(PORT, () => {
  console.log(`Server running on http://localhost:${PORT}`);
});
