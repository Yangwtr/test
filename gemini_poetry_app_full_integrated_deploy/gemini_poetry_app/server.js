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

    const prompt = [
      '以下是前端傳來的上下文 JSON，請根據這些資料回答。',
      '若有 currentPoem，優先用它回答。',
      '若沒有 currentPoem，但問題本身明確，仍可用一般古詩詞知識回答。',
      '回答格式請輸出 JSON 物件，欄位為 answer, needsClarification, suggestedFollowUp。',
      JSON.stringify(contextPayload, null, 2),
    ].join('\n\n');

    const response = await ai.models.generateContent({
      model: MODEL,
      contents: prompt,
      config: {
        systemInstruction: SYSTEM_INSTRUCTION,
        temperature: 0.2,
        maxOutputTokens: 700,
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

    res.json({
      model: MODEL,
      answer: parsed.answer || '模型沒有回傳內容。',
      needsClarification: Boolean(parsed.needsClarification),
      suggestedFollowUp: parsed.suggestedFollowUp || '',
    });
  } catch (error) {
    console.error(error);
    const status = Number(error?.status) || 500;
    res.status(status).json({
      error: error?.message || 'Gemini 呼叫失敗。',
    });
  }
});

app.get('*', (_req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.listen(PORT, () => {
  console.log(`Server running on http://localhost:${PORT}`);
});
