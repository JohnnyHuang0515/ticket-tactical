// background service worker（Chrome MV3，classic worker）。
// 整套擴充的中樞：持有「解鎖後的記憶體金鑰」、處理所有 runtime 訊息、
// 管理監控狀態、發桌面通知，以及用 port 連線實作「關閉分頁即上鎖」。
//
// 邊界（嚴格遵守）：
//   - BR-3：本檔「絕無」任何送出/購票/點擊購買的邏輯，偵測到票只發通知，永不自動下單。
//   - BR-4：本檔「絕無」任何網路請求 / 遙測 / 上傳；所有資料僅存於 chrome.storage.local。
//   - BR-2 / BR-8：解鎖金鑰只存在於 module-scope 變數 vaultKey，永不寫入 storage、
//                  永不持久化主密碼；重啟 SW 後即回到「已鎖」。
//   - BR-1：對外（popup/options）只回傳標籤等非敏感資訊；明文僅在 GET_PROFILE_FIELDS
//           被明確索取時回傳（供 content 自動填入）。
self.importScripts("../lib/messages.js", "../lib/crypto.js");

// ── module-scope 狀態 ───────────────────────────────────────────────
// 解鎖後的 AES-GCM 金鑰（CryptoKey）。僅存記憶體；SW 休眠/重啟即消失（=自動上鎖）。
let vaultKey = null;

// 目前連線中的「tt-page」port 集合（內容腳本在售票分頁建立）。
// 用於 D-0003：當全部售票分頁關閉（集合清空）且設定為 tab-close 時自動上鎖。
const pagePorts = new Set();

// ── 小工具 ─────────────────────────────────────────────────────────

// 讀取單一 storage key（Promise 化）。
function storageGet(key) {
  return new Promise((resolve) => {
    chrome.storage.local.get(key, (res) => resolve(res[key]));
  });
}

// 寫入多個 storage 項目（Promise 化）。
function storageSet(obj) {
  return new Promise((resolve) => {
    chrome.storage.local.set(obj, () => resolve());
  });
}

// 移除多個 storage key（Promise 化）。
function storageRemove(keys) {
  return new Promise((resolve) => {
    chrome.storage.local.remove(keys, () => resolve());
  });
}

// 依目前狀態推導鎖定狀態（§3.3 狀態機）：
//   無 VAULT_META → 未設定；META 存在且金鑰為 null → 已鎖；金鑰存在 → 已解鎖。
async function computeLockState() {
  const meta = await storageGet(TT.KEYS.VAULT_META);
  if (!meta) return TT.LOCK.UNINITIALIZED;
  return vaultKey ? TT.LOCK.UNLOCKED : TT.LOCK.LOCKED;
}

// 廣播鎖定狀態變更給所有監聽者（popup/options/content）。
// 無接收端時 sendMessage 會 reject，屬正常情況，故以 try/catch 吞掉。
async function broadcastLockState() {
  const lockState = await computeLockState();
  try {
    chrome.runtime.sendMessage(
      { type: TT.MSG.LOCK_STATE_CHANGED, lockState },
      () => void chrome.runtime.lastError // 讀取以清除「無接收端」警告
    );
  } catch (_e) {
    // 無接收端，忽略。
  }
}

// 合併使用者設定到預設值上（淺層合併即可，設定皆為扁平欄位）。
async function readSettings() {
  const stored = (await storageGet(TT.KEYS.SETTINGS)) || {};
  return Object.assign({}, TT.DEFAULTS, stored);
}

// 解密整個 vault blob，回傳 IdentityProfile 陣列；尚無 blob 時回傳空陣列。
// 呼叫前須確認 vaultKey 非 null（即已解鎖）。
async function readProfiles() {
  const blob = await storageGet(TT.KEYS.VAULT_BLOB);
  if (!blob) return [];
  return TTCrypto.decryptJSON(vaultKey, blob);
}

// 將 IdentityProfile 陣列加密後寫回 VAULT_BLOB。
async function writeProfiles(profiles) {
  const blob = await TTCrypto.encryptJSON(vaultKey, profiles);
  await storageSet({ [TT.KEYS.VAULT_BLOB]: blob });
}

// 只保留單一預設個資：若傳入筆被設為預設，其餘一律取消。
function enforceSingleDefault(profiles, defaultId) {
  for (const p of profiles) {
    p.isDefault = p.id === defaultId;
  }
}

// ── 訊息處理（async；統一在 handleMessage 內 switch）─────────────────

async function handleMessage(msg, _sender) {
  switch (msg && msg.type) {
    // 設定主密碼（首次建立 vault）。
    case TT.MSG.SET_MASTER_PASSWORD: {
      const password = msg.password || "";
      // 弱密碼檢查：最少 8 碼。
      if (password.length < 8) {
        return { ok: false, code: "WEAK_PASSWORD" };
      }
      const saltB64 = TTCrypto.randomSaltB64();
      const iterations = 250000;
      const key = await TTCrypto.deriveKey(password, saltB64, iterations);
      const verifier = await TTCrypto.makeVerifier(key);
      // 先寫 META 與空的加密 blob，再設定記憶體金鑰。
      await storageSet({
        [TT.KEYS.VAULT_META]: { saltB64, iterations, verifier }
      });
      vaultKey = key;
      await writeProfiles([]); // 初始化空清單（需要 vaultKey，故置於設定後）
      await broadcastLockState();
      return { ok: true, lockState: TT.LOCK.UNLOCKED };
    }

    // 以主密碼解鎖。
    case TT.MSG.UNLOCK_VAULT: {
      const meta = await storageGet(TT.KEYS.VAULT_META);
      if (!meta) return { ok: false, code: "VAULT_UNINITIALIZED" };
      const key = await TTCrypto.deriveKey(
        msg.password || "",
        meta.saltB64,
        meta.iterations
      );
      const valid = await TTCrypto.checkVerifier(key, meta.verifier);
      if (!valid) {
        // 密碼錯誤：不設定金鑰，維持已鎖。
        return { ok: false, code: "MASTER_PASSWORD_WRONG" };
      }
      vaultKey = key;
      await broadcastLockState();
      return { ok: true, lockState: TT.LOCK.UNLOCKED };
    }

    // 手動上鎖：清掉記憶體金鑰。
    case TT.MSG.LOCK_VAULT: {
      vaultKey = null;
      await broadcastLockState();
      return { ok: true, lockState: TT.LOCK.LOCKED };
    }

    // 重設 vault：移除 META 與 blob，回到「未設定」。需呼叫端帶 confirm。
    case TT.MSG.RESET_VAULT: {
      if (!msg.confirm) return { ok: false, code: "CONFIRM_REQUIRED" };
      await storageRemove([TT.KEYS.VAULT_META, TT.KEYS.VAULT_BLOB]);
      vaultKey = null;
      await broadcastLockState();
      return { ok: true, lockState: TT.LOCK.UNINITIALIZED };
    }

    // 查詢目前鎖定狀態（解鎖時附帶個資筆數）。
    case TT.MSG.GET_LOCK_STATE: {
      const lockState = await computeLockState();
      const res = { lockState };
      if (lockState === TT.LOCK.UNLOCKED) {
        const profiles = await readProfiles();
        res.profileCount = profiles.length;
      }
      return res;
    }

    // 列出個資清單：只回標籤等非敏感欄位（BR-1）。
    case TT.MSG.LIST_PROFILES: {
      if (!vaultKey) return { ok: false, code: "VAULT_LOCKED" };
      const profiles = await readProfiles();
      return {
        ok: true,
        profiles: profiles.map((p) => ({
          id: p.id,
          label: p.label,
          isDefault: !!p.isDefault
        }))
      };
    }

    // 取某筆「完整解密欄位」：唯一回傳明文的路徑，且僅在明確索取時（供 content 填入）。
    case TT.MSG.GET_PROFILE_FIELDS: {
      if (!vaultKey) return { ok: false, code: "VAULT_LOCKED" };
      const profiles = await readProfiles();
      const found = profiles.find((p) => p.id === msg.id);
      if (!found) return { ok: false, code: "PROFILE_NOT_FOUND" };
      return { ok: true, fields: found };
    }

    // 新增/更新個資（依 id upsert；無 id 則產生）。
    case TT.MSG.SAVE_PROFILE: {
      if (!vaultKey) return { ok: false, code: "VAULT_LOCKED" };
      const incoming = Object.assign({}, msg.profile);
      if (!incoming.id) incoming.id = crypto.randomUUID();
      const profiles = await readProfiles();
      const idx = profiles.findIndex((p) => p.id === incoming.id);
      if (idx >= 0) profiles[idx] = incoming;
      else profiles.push(incoming);
      // 若這筆被設為預設，確保全清單僅一筆預設。
      if (incoming.isDefault) enforceSingleDefault(profiles, incoming.id);
      await writeProfiles(profiles);
      return { ok: true, id: incoming.id };
    }

    // 刪除個資。需呼叫端帶 confirm。
    case TT.MSG.DELETE_PROFILE: {
      if (!vaultKey) return { ok: false, code: "VAULT_LOCKED" };
      if (!msg.confirm) return { ok: false, code: "CONFIRM_REQUIRED" };
      const profiles = await readProfiles();
      const next = profiles.filter((p) => p.id !== msg.id);
      await writeProfiles(next);
      return { ok: true };
    }

    // 讀取設定（合併預設）。
    case TT.MSG.GET_SETTINGS: {
      const settings = await readSettings();
      return { ok: true, settings };
    }

    // 局部更新設定（patch 合併後寫回）。
    case TT.MSG.UPDATE_SETTINGS: {
      const current = await readSettings();
      const settings = Object.assign({}, current, msg.patch || {});
      await storageSet({ [TT.KEYS.SETTINGS]: settings });
      return { ok: true, settings };
    }

    // 讀取關鍵字過濾條件。
    case TT.MSG.GET_FILTERS: {
      const filters = (await storageGet(TT.KEYS.FILTERS)) || {};
      return { ok: true, filters };
    }

    // 儲存關鍵字過濾條件。
    case TT.MSG.SAVE_FILTERS: {
      await storageSet({ [TT.KEYS.FILTERS]: msg.filters || {} });
      return { ok: true };
    }

    // 讀取監控狀態。
    case TT.MSG.GET_MONITOR: {
      const monitor = (await storageGet(TT.KEYS.MONITOR)) || { active: false };
      return { ok: true, monitor };
    }

    // 啟動監控：僅記錄狀態（實際偵測在 content；本檔不發網路請求）。
    case TT.MSG.START_MONITOR: {
      const monitor = Object.assign(
        { active: true, status: "monitoring" },
        msg.task || {}
      );
      monitor.active = true;
      await storageSet({ [TT.KEYS.MONITOR]: monitor });
      return { ok: true, monitor };
    }

    // 停止監控。
    case TT.MSG.STOP_MONITOR: {
      const prev = (await storageGet(TT.KEYS.MONITOR)) || {};
      const monitor = Object.assign({}, prev, {
        active: false,
        status: "stopped"
      });
      await storageSet({ [TT.KEYS.MONITOR]: monitor });
      return { ok: true, monitor };
    }

    // 偵測到可購票：只發桌面通知，「絕不」自動購買（BR-3）。
    case TT.MSG.TICKETS_AVAILABLE: {
      const settings = await readSettings();
      if (settings.notifyDesktop) {
        const label = msg.eventLabel || "活動";
        try {
          chrome.notifications.create({
            type: "basic",
            iconUrl: chrome.runtime.getURL("icons/icon128.png"),
            title: "偵測到可購票！",
            message: `「${label}」目前可能有票，請手動前往確認並購買。`,
            priority: 2
          });
        } catch (_e) {
          // 通知建立失敗不影響主流程。
        }
      }
      return { ok: true };
    }

    default:
      return { ok: false, code: "UNKNOWN_MESSAGE" };
  }
}

// runtime 訊息進入點：一律走非同步處理，回傳 true 以保留 sendResponse。
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  handleMessage(msg, sender)
    .then((res) => sendResponse(res))
    .catch((err) => {
      // 任何例外都回成統一錯誤結構，避免呼叫端卡住。
      sendResponse({ ok: false, code: "INTERNAL_ERROR", message: String(err) });
    });
  return true; // 非同步回應。
});

// ── 關閉分頁即上鎖（NFR-5 / D-0003，免用 "tabs" 權限）──────────────
// content script 會在每個售票分頁 connect 一條名為 "tt-page" 的 port。
// 我們追蹤這些 port；當某分頁關閉/導離，port 觸發 onDisconnect。
// 一旦集合清空（代表已無任何售票分頁）且設定為 tab-close，即清除金鑰上鎖。
chrome.runtime.onConnect.addListener((port) => {
  if (port.name !== "tt-page") return;
  pagePorts.add(port);
  port.onDisconnect.addListener(async () => {
    pagePorts.delete(port);
    if (pagePorts.size === 0) {
      const settings = await readSettings();
      if (settings.lockBehavior === "tab-close") {
        vaultKey = null; // 清除記憶體金鑰
        await broadcastLockState(); // 通知 UI 更新為「已鎖」
      }
    }
  });
});

// ── 安裝事件：初始化預設設定 ───────────────────────────────────────
chrome.runtime.onInstalled.addListener(() => {
  chrome.storage.local.get(TT.KEYS.SETTINGS, (res) => {
    if (!res[TT.KEYS.SETTINGS]) {
      chrome.storage.local.set({ [TT.KEYS.SETTINGS]: TT.DEFAULTS });
    }
  });
});
