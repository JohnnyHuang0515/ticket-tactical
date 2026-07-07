// 共享契約：訊息型別、storage key、預設設定、個資欄位。
// 載入於 content script / service worker(importScripts) / popup / options 四個情境，
// 全部以 globalThis.TT 命名空間共用，確保各模組對齊。對應規格 §6.2 訊息目錄。
(function (g) {
  g.TT = g.TT || {};

  // 訊息型別（popup/options/content → background，或 background 廣播）
  g.TT.MSG = {
    SET_MASTER_PASSWORD: "SET_MASTER_PASSWORD",
    UNLOCK_VAULT: "UNLOCK_VAULT",
    LOCK_VAULT: "LOCK_VAULT",
    RESET_VAULT: "RESET_VAULT",
    GET_LOCK_STATE: "GET_LOCK_STATE",
    LOCK_STATE_CHANGED: "LOCK_STATE_CHANGED", // background → 廣播
    LIST_PROFILES: "LIST_PROFILES",
    GET_PROFILE_FIELDS: "GET_PROFILE_FIELDS", // 取某筆解密後欄位（給 content 填入）
    SAVE_PROFILE: "SAVE_PROFILE",
    DELETE_PROFILE: "DELETE_PROFILE",
    GET_SETTINGS: "GET_SETTINGS",
    UPDATE_SETTINGS: "UPDATE_SETTINGS",
    GET_FILTERS: "GET_FILTERS",
    SAVE_FILTERS: "SAVE_FILTERS",
    GET_MONITOR: "GET_MONITOR",
    START_MONITOR: "START_MONITOR",
    STOP_MONITOR: "STOP_MONITOR",
    TICKETS_AVAILABLE: "TICKETS_AVAILABLE" // content → background（發通知）
  };

  // 鎖定狀態（對應 §3.3 Vault 狀態機）
  g.TT.LOCK = { UNINITIALIZED: "未設定", LOCKED: "已鎖", UNLOCKED: "已解鎖" };

  // chrome.storage.local key
  g.TT.KEYS = {
    SETTINGS: "tt_settings",
    VAULT_META: "tt_vault_meta", // { saltB64, iterations, verifier:{iv,data} } — 無明文、不可逆
    VAULT_BLOB: "tt_vault_blob", // IdentityProfile[] 的 AES-GCM 密文 { iv, data }
    FILTERS: "tt_filters", // { includeStr, excludeStr, hideSoldOut }
    MONITOR: "tt_monitor", // { active, siteKey, targetUrl, eventLabel, mode, status }
    SITE_OFF: "tt_site_off" // { [siteKey]: true } — 使用者在該站台「停用」外掛（blocklist；不在表內＝啟用）
  };

  g.TT.DEFAULTS = {
    declutterEnabled: true,
    enlargeButtonsEnabled: true,
    filterEnabled: false,
    autoRefreshEnabled: false,
    monitorEnabled: false,
    countdownEnabled: true,
    notifySound: true,
    notifyDesktop: true,
    refreshIntervalMs: 800,
    lockBehavior: "tab-close" // 關閉所有售票分頁/瀏覽器才鎖（NFR-5 / D-0003）
  };

  // 實名個資欄位（多筆 IdentityProfile；整筆加密 §3.2 / BR-2）
  g.TT.PROFILE_FIELDS = [
    { key: "label", label: "暱稱", required: true },
    { key: "nameZh", label: "中文姓名", max: 7 }, // tixCraft 限 7 字（BR-6）
    { key: "nameEn", label: "英文姓名", max: 25 },
    { key: "idType", label: "證件類型" },
    { key: "idNumber", label: "證件號", sensitive: true },
    { key: "phone", label: "手機" },
    { key: "email", label: "Email" },
    { key: "birthday", label: "生日" },
    { key: "address", label: "地址" }
  ];
})(typeof self !== "undefined" ? self : this);
