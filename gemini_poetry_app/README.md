# Gemini 部署版：古今同頻詩詞問答

這個版本已經把前端頁面改成可部署的 Gemini API 版：
- 保留原本的 Excel 規則引擎
- 低信心時自動改由 Gemini 補答
- 新增「Gemini 補答」文字輸入框
- API Key 放在伺服器 `.env`，不暴露在前端

## 檔案結構
- `public/index.html`：前端頁面
- `server.js`：Node/Express 後端，提供 `/api/health`、`/api/gemini/chat`
- `public/data/qa_rules.xlsx`：已內建的問答規則 Excel
- `public/data/poems_db.xlsx`：已內建的詩詞資料庫 Excel
- `QA_Rules_Training_Config.xlsx`：原始問答規則 Excel 備份
- `.env.example`：環境變數範本

## 本機啟動
1. 安裝 Node.js 18 以上
2. 安裝套件
   ```bash
   npm install
   ```
3. 建立 `.env`
   ```bash
   cp .env.example .env
   ```
4. 把 `.env` 裡的 `GEMINI_API_KEY` 換成你自己的金鑰
5. 啟動
   ```bash
   npm start
   ```
6. 開啟瀏覽器 `http://localhost:3000`

## Gemini API Key
1. 到 Google AI Studio 建立 API Key
2. 把金鑰填到 `.env` 的 `GEMINI_API_KEY`
3. 重新啟動伺服器
4. 前端按「檢查 Gemini 後端」確認是否成功

## 建議部署方式
### Render / Railway
- 建立新的 Web Service
- 上傳整個專案資料夾
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
  - `GEMINI_MODEL`（可選，預設 `gemini-3-flash-preview`）

## 目前 Gemini 會接手的情況
- 規則引擎低信心
- 翻譯、字詞解釋、背景故事等本地資料表尚未補齊
- 使用者直接在輸入框提問

## 上線前建議
- 另外補一份詩詞資料 Excel（作品、作者、內容、景物、情緒）
- 再補 `translation / word_glossary / background_story` 欄位或工作表
- 先用 50～100 句測試句做誤判統計


## 內建資料
這個部署版已直接包入兩份 Excel：
- 問答規則：`public/data/qa_rules.xlsx`
- 詩詞資料庫：`public/data/poems_db.xlsx`

前端在開啟頁面後會自動嘗試載入這兩份資料，所以不必每次重新手動上傳。
如果你之後想替換內容，只要把這兩個檔名維持不變並覆蓋即可。

## 你的這份詩詞資料庫目前會優先抓的工作表
- `詩詞資料庫`
- 若不存在，退回 `詩詞分類表`

支援主要欄位：
- 詩名
- 作者
- 本文 / 詩詞內容
- 物品 / 意象
- 情緒
- 賞析（可作 Gemini 補答上下文）
- 詩詞體裁


## 這次整合進去的新功能
- 臉部表情辨識維持 `face-api.js`，但改成「穩定確認後自動停止」，避免畫面一直跳動
- 圖片辨識改回 `Teachable Machine`，內建模型網址：`https://teachablemachine.withgoogle.com/models/89PqqqYf8/`
- 聲音分析改為一鍵同時啟動「音量＋語速」，並在 3 秒無聲音後自動結束
- 音量與語速都會顯示分析結果，並提供修正建議
- 相關詩詞清單只顯示：詩名、包含物、情緒
- 保留原本的 Gemini 後端代理與多工作表 Excel 規則引擎
- 頁面開啟後會自動載入內建 Excel，也可按「載入內建 Excel」重新載入
