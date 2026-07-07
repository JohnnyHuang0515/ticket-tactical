// Vault 加密模組：以主密碼派生 AES-GCM 金鑰，加解密實名個資/設定。
// 載入於 background service worker（importScripts），純函式模組——不呼叫 chrome.* 也不碰 DOM。
// 使用 SW 內建的 WebCrypto（crypto.subtle）。對應規格 D-0002（AES-GCM + PBKDF2）、
// BR-2（個資整筆加密）、BR-8（不持久化明文金鑰；verifier 不可逆）。
// 全部以 globalThis.TTCrypto 命名空間共用，base64 等輔助函式僅限模組內部，不外洩成全域。
(function (g) {
  "use strict";

  // ── base64 ↔ 二進位 輔助（僅模組內部使用）────────────────────────────

  // 將 ArrayBuffer / Uint8Array 轉成 base64 字串。
  function bytesToB64(buf) {
    const bytes = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
    let binary = "";
    // 分批拼字串，避免極大陣列觸發 String.fromCharCode 參數上限。
    const CHUNK = 0x8000;
    for (let i = 0; i < bytes.length; i += CHUNK) {
      binary += String.fromCharCode.apply(null, bytes.subarray(i, i + CHUNK));
    }
    return btoa(binary);
  }

  // 將 base64 字串還原成 Uint8Array。
  function b64ToBytes(b64) {
    const binary = atob(b64);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) {
      bytes[i] = binary.charCodeAt(i);
    }
    return bytes;
  }

  // UTF-8 字串 → Uint8Array（密碼與明文用）。
  function strToBytes(str) {
    return new TextEncoder().encode(str);
  }

  // Uint8Array → UTF-8 字串（解密後還原 JSON 文字用）。
  function bytesToStr(bytes) {
    return new TextDecoder().decode(bytes);
  }

  // ── 公開 API ────────────────────────────────────────────────────────

  const TTCrypto = {
    // 產生 16 bytes 隨機鹽，回傳 base64 字串（每位使用者一次性產生並存於 vault_meta）。
    randomSaltB64() {
      const salt = new Uint8Array(16);
      crypto.getRandomValues(salt);
      return bytesToB64(salt);
    },

    // 以 PBKDF2-SHA256 從「UTF-8 主密碼 + 鹽」派生 AES-GCM 256-bit 金鑰。
    // iterations 預設 250000；金鑰用途限 encrypt/decrypt，且不可匯出（不落地明文）。
    async deriveKey(password, saltB64, iterations = 250000) {
      const baseKey = await crypto.subtle.importKey(
        "raw",
        strToBytes(password),
        { name: "PBKDF2" },
        false, // 不可匯出
        ["deriveKey"]
      );
      return crypto.subtle.deriveKey(
        {
          name: "PBKDF2",
          salt: b64ToBytes(saltB64),
          iterations,
          hash: "SHA-256"
        },
        baseKey,
        { name: "AES-GCM", length: 256 },
        false, // 派生出的金鑰不可匯出
        ["encrypt", "decrypt"]
      );
    },

    // 將物件 JSON 序列化後以 AES-GCM 加密，使用全新的 12-byte 隨機 IV。
    // 回傳 { iv, data }（皆為 base64）；IV 不需保密但每次必須不同。
    async encryptJSON(key, obj) {
      const iv = new Uint8Array(12);
      crypto.getRandomValues(iv);
      const plaintext = strToBytes(JSON.stringify(obj));
      const cipher = await crypto.subtle.encrypt(
        { name: "AES-GCM", iv },
        key,
        plaintext
      );
      return { iv: bytesToB64(iv), data: bytesToB64(cipher) };
    },

    // 逆向：以 AES-GCM 解密並 JSON 反序列化回物件。
    // 金鑰錯誤或密文遭竄改時，subtle.decrypt 會拋例外（GCM 驗證失敗），由呼叫端處理。
    async decryptJSON(key, { iv, data }) {
      const plaintext = await crypto.subtle.decrypt(
        { name: "AES-GCM", iv: b64ToBytes(iv) },
        key,
        b64ToBytes(data)
      );
      return JSON.parse(bytesToStr(plaintext));
    },

    // 產生驗證票（verifier）：加密固定標記，存於 vault_meta。
    // 內容不可逆推主密碼（BR-8），僅用於日後驗證解鎖密碼是否正確。
    async makeVerifier(key) {
      return TTCrypto.encryptJSON(key, { v: "TT_OK" });
    },

    // 驗證金鑰是否正確：嘗試解密 verifier，僅當 .v === "TT_OK" 才回傳 true。
    // 任何錯誤（密碼錯/竄改/格式異常）都吞下並回傳 false——此函式永不拋例外。
    async checkVerifier(key, verifier) {
      try {
        const obj = await TTCrypto.decryptJSON(key, verifier);
        return obj && obj.v === "TT_OK";
      } catch (e) {
        return false;
      }
    }
  };

  g.TTCrypto = TTCrypto;
})(typeof self !== "undefined" ? self : this);
