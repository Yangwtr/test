# 古今同頻：Gemini 多模態詩詞對話＋AI 反向出題闖關

這個版本保留原本的：
- Excel 問答規則引擎
- Gemini 補答與語音對話
- 臉部辨識 / 圖片辨識 / 音量＋語速分析
- 內建詩詞 Excel 與內建規則 Excel

另外新增了 **AI 反向出題闖關模式**，讓系統不只是「學生問、AI 答」，也能變成「AI 出題、學生選答案」。

## 新增的五種闖關模式
1. **詩詞接龍大挑戰**：AI 先出上半句，學生從四個選項找下一句。
2. **AI 抓漏糾察隊**：AI 故意念錯一個字，學生找出正確字。
3. **AI 點餐你上菜**：AI 出詩名或畫面，學生選最符合的意象物品。
4. **心情安慰推薦**：AI 說自己現在的情緒，學生選最適合的詩。
5. **白話文反推**：AI 先給白話提示，學生猜是哪首詩。

## 互動特色
- 每題都是 **四選一**，降低回答難度。
- 可按 **朗讀題目**，讓 AI 唸題目給學生聽。
- 作答後會直接顯示 **答對 / 答錯、正確答案、簡短解釋**。
- 答題後會同步把該題對應的詩顯示到「相關詩詞」區塊。

## 檔案結構
- `public/index.html`：前端頁面
- `public/data/poems_db.xlsx`：內建詩詞資料庫
- `public/data/qa_rules.xlsx`：內建問答規則
- `server.js`：Gemini 後端代理
- `package.json`：Node 啟動設定
- `.env.example`：環境變數範本

## 本機啟動
1. 安裝 Node.js 18 以上
2. 在專案根目錄執行：
   ```bash
   npm install
   npm start
   ```
3. 開啟瀏覽器：
   ```
   http://localhost:3000
   ```

## .env 設定
把 `.env.example` 複製成 `.env`，再填入：

```env
GEMINI_API_KEY=你的_Gemini_API_Key
GEMINI_MODEL=gemini-3-flash-preview
PORT=3000
```

## Render 建議設定
- Root Directory：留空（如果 GitHub repo 根目錄直接就是這個專案）
- Build Command：
  ```bash
  npm install
  ```
- Start Command：
  ```bash
  npm start
  ```
- Environment Variables：
  - `GEMINI_API_KEY`
  - `GEMINI_MODEL`
  - `NODE_VERSION=20`

## 提醒
- 臉部、麥克風、語音辨識功能要在 **HTTPS 或 localhost** 才能正常使用。
- 若要實機測試語音與鏡頭，請用 Chrome 開啟。
