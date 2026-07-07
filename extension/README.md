# 搶票助手 (Ticket Tactical) — Chrome 外掛

個人用的**合法**搶票輔助瀏覽器外掛（Chrome / Edge，Manifest V3）。完整實作版。總覽與安裝說明見 [根目錄 README](../README.md)。

## 界線（不可違反）

- **不自動送單**：外掛從不點擊「送出 / 購買 / 確認付款」，送出一律由你本人手動點（BR-3 / D-0004）。
- **不破解驗證碼、不多帳號掃票、不掛機**。
- **純本機**：除了對「售票站本站」做校時用的 HEAD 請求（讀其 `Date` 標頭、不帶個資）外，**不連任何後端、不蒐集遙測、不外傳資料**（BR-4 / NFR-6）。
- 個資 **AES-GCM 加密 + 主密碼鎖**，金鑰只存在記憶體（BR-2 / BR-8）；adapter 失效只停用增強、**絕不阻擋原生購票流程**（BR-7）。

## 如何載入

1. Chrome / Edge 開 `chrome://extensions`
2. 右上開「**開發人員模式**」
3. 「**載入未封裝項目**」→ 選 `extension/` 資料夾
4. 釘到工具列；開 tixCraft 或 Weverse 頁面即生效

## 功能（已實作）

- **站點偵測 + 清版面 + 放大關鍵按鈕**（tixCraft 選擇器已對照實際 DOM）
- **票券篩選**：關鍵字 / 黑名單 / 隱藏售完，支援 `逗號=AND`、`加號=OR`、數字 `2800↔2,800` 正規化
- **個資保險箱**：多筆實名個資，AES-GCM 加密、PBKDF2 主密碼派生金鑰、主密碼解鎖；關閉所有售票分頁自動上鎖
- **一鍵填入**：解鎖後把個資帶入購票表單（heuristic 欄位對應 + 中文名 ≤7 字驗證），**填完不送出**
- **釋票監控**：輪詢偵測可購票 → WebAudio 嗶聲 + 桌面通知（不自動操作）
- **倒數校時**：對售票站校時、毫秒倒數浮動工具列（可收合成精簡膠囊）
- **自動刷新**：到點重整，但**排隊/驗證/購票流程頁、或你正在打字時自動暫停**（不刷出隊伍）
- **Popup**：狀態、解鎖、6 個功能開關、一鍵填入、監控啟停
- **Options**：實名個資 CRUD、功能開關、目標站台、篩選規則、主密碼管理（設定/解鎖/重設）

## ⚠️ 需對照實際頁面微調（我無法在此環境開 Chrome 驗證）

1. **`content/adapters.js` 的 `keyButtonSelectors`**：張數/結帳頁的按鈕是跨頁猜測，需在那些頁再抓 DOM 校準。
2. **`soldOutSelector`**：售完票區的 class 待確認（影響「隱藏售完」與監控判定）。
3. **`formFieldMap`**：購票表單欄位對應未定，一鍵填入目前靠關鍵字 heuristic（姓名/手機/email/證件/地址/生日），命中率需用實際結帳表單驗證。
4. **校時**：依售票站是否回 `Date` 標頭；取不到則退回本機時間並標「未校時」。
5. **自動刷新 / 監控預設為關**，需在 popup 開啟才會運作。

## 檔案結構

```
extension/
├─ manifest.json            MV3（host 限 tixCraft/Weverse；storage + notifications）
├─ lib/
│  ├─ messages.js           共享契約：訊息型別 / storage key / 預設 / 欄位
│  ├─ crypto.js             Vault 加解密（AES-GCM + PBKDF2）
│  └─ filter.js             票券篩選邏輯（AND/OR + 數字正規化）
│  └─ theme.css             戰術設計 token（popup/options 共用）
├─ content/
│  ├─ adapters.js           站台選擇器契約（tixCraft 已調）
│  ├─ content.js            注入：清版面/放大/篩選/工具列/校時/監控/自動刷新/一鍵填入
│  └─ content.css           注入樣式（tt- 前綴，戰術風）
├─ background/service-worker.js  Vault 金鑰(記憶體) + 訊息路由 + 通知 + 關閉分頁上鎖
├─ popup/                   工具列彈窗（完整控制）
├─ options/                 設定頁（個資/開關/站台/篩選/主密碼）
└─ icons/                   icon16/48/128（戰術瞄準鏡：墨黑底+電光藍環+綠心）
```
