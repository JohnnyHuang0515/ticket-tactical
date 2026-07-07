// 工具列 popup 控制器。
// 所有 vault / 設定 / 監控操作一律經 background service worker：
//   chrome.runtime.sendMessage({ type: TT.MSG.X, ... }, cb)
// 個資明文絕不在此停留；只透過 content script 的 AUTOFILL_NOW 觸發填入（host_permissions）。
// 對應規格 §6.2 訊息目錄；TT 命名空間由 ../lib/messages.js 提供。

(function () {
  "use strict";

  const MSG = TT.MSG;
  const LOCK = TT.LOCK;

  // 頁面增強的六個開關（讀 GET_SETTINGS、寫 UPDATE_SETTINGS）。
  // 票券篩選已獨立為 FILTER 區（柴柴式 tag 輸入），故不在此列。
  const ENHANCE_FIELDS = [
    { key: "declutterEnabled", label: "清版面" },
    { key: "enlargeButtonsEnabled", label: "放大關鍵按鈕" },
    { key: "autoRefreshEnabled", label: "自動刷新" },
    { key: "monitorEnabled", label: "釋票監控" },
    { key: "countdownEnabled", label: "倒數計時" }
  ];

  // ── DOM 參照 ─────────────────────────────────────────────────
  const el = {
    openOptions: document.getElementById("openOptions"),
    lockBadge: document.getElementById("lockBadge"),
    monitorBadge: document.getElementById("monitorBadge"),
    // 每站開關
    siteBar: document.getElementById("siteBar"),
    siteLab: document.getElementById("siteLab"),
    siteHost: document.getElementById("siteHost"),
    siteToggle: document.getElementById("siteToggle"),
    // vault
    unlockBlock: document.getElementById("unlockBlock"),
    pwInput: document.getElementById("pwInput"),
    unlockBtn: document.getElementById("unlockBtn"),
    unlockErr: document.getElementById("unlockErr"),
    setupBlock: document.getElementById("setupBlock"),
    setupBtn: document.getElementById("setupBtn"),
    unlockedBlock: document.getElementById("unlockedBlock"),
    unlockedInfo: document.getElementById("unlockedInfo"),
    lockBtn: document.getElementById("lockBtn"),
    // enhance
    enhanceRows: document.getElementById("enhanceRows"),
    // filter（票券篩選）
    includeInput: document.getElementById("includeInput"),
    includeAdd: document.getElementById("includeAdd"),
    includeChips: document.getElementById("includeChips"),
    excludeInput: document.getElementById("excludeInput"),
    excludeAdd: document.getElementById("excludeAdd"),
    excludeChips: document.getElementById("excludeChips"),
    hideSoldOut: document.getElementById("hideSoldOut"),
    filterReset: document.getElementById("filterReset"),
    // autofill
    autofillLocked: document.getElementById("autofillLocked"),
    autofillReady: document.getElementById("autofillReady"),
    autofillEmpty: document.getElementById("autofillEmpty"),
    profileSelect: document.getElementById("profileSelect"),
    autofillBtn: document.getElementById("autofillBtn"),
    // monitor
    monitorState: document.getElementById("monitorState"),
    monitorBtn: document.getElementById("monitorBtn"),
    // toast
    toast: document.getElementById("toast")
  };

  // 目前的記憶體狀態。
  let lockState = null;
  let settings = Object.assign({}, TT.DEFAULTS);
  let monitorActive = false;
  // 票券篩選（柴柴式）：想要 / 黑名單各為一組 OR-tag；hideSoldOut 為隱藏售完。
  let includeChips = [];
  let excludeChips = [];
  let hideSoldOut = false;

  // ── 工具 ─────────────────────────────────────────────────────

  // 包裝 sendMessage：統一處理 chrome.runtime.lastError，永不讓回呼丟例外。
  function send(type, extra, cb) {
    const payload = Object.assign({ type: type }, extra || {});
    try {
      chrome.runtime.sendMessage(payload, function (res) {
        if (chrome.runtime.lastError) {
          if (typeof cb === "function") cb(null, chrome.runtime.lastError);
          return;
        }
        if (typeof cb === "function") cb(res, null);
      });
    } catch (e) {
      if (typeof cb === "function") cb(null, e);
    }
  }

  let toastTimer = null;
  function toast(text, isErr) {
    el.toast.textContent = text;
    el.toast.classList.toggle("toast-err", !!isErr);
    el.toast.hidden = false;
    if (toastTimer) clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { el.toast.hidden = true; }, 2600);
  }

  function show(node, on) { if (node) node.hidden = !on; }

  // ── 每站總開關（此分頁站台是否啟用外掛）────────────────────────
  // 與 content.js 共用 tt_site_off（{ [siteKey]: true }＝停用清單）與同一套 host→adapter 比對。
  const KEYS = TT.KEYS;
  let currentSiteKey = null; // 目前分頁對應的 adapter.siteKey；null＝不支援站台
  let currentHost = "";
  let siteEnabled = true;

  // 與 content.js findAdapter 相同邏輯（adapters.js 已注入 window.__TT_ADAPTERS）。
  function findAdapterForHost(host) {
    const list = (typeof window !== "undefined" && window.__TT_ADAPTERS) || [];
    for (let i = 0; i < list.length; i++) {
      const a = list[i];
      if (a.hostPatterns && a.hostPatterns.some(function (p) { return host.indexOf(p) !== -1; })) return a;
    }
    return null;
  }

  function siteOffGet(cb) {
    try {
      chrome.storage.local.get(KEYS.SITE_OFF, function (res) {
        if (chrome.runtime.lastError) { cb({}); return; }
        cb((res && res[KEYS.SITE_OFF]) || {});
      });
    } catch (e) { cb({}); }
  }
  function siteOffSet(map, cb) {
    try {
      const o = {}; o[KEYS.SITE_OFF] = map;
      chrome.storage.local.set(o, function () { if (cb) cb(); });
    } catch (e) { if (cb) cb(); }
  }

  function renderSiteBar() {
    if (!el.siteToggle) return;
    const supported = !!currentSiteKey;
    el.siteHost.textContent = currentHost || "（無法讀取網址）";
    el.siteLab.textContent = supported ? "在此站啟用" : "非支援售票站";
    el.siteToggle.disabled = !supported;
    const on = supported && siteEnabled;
    el.siteToggle.classList.toggle("on", on);
    el.siteToggle.setAttribute("aria-checked", on ? "true" : "false");
    el.siteBar.classList.toggle("is-off", !on);
  }

  function loadSiteBar() {
    try {
      chrome.tabs.query({ active: true, currentWindow: true }, function (tabs) {
        const url = (tabs && tabs[0] && tabs[0].url) || ""; // host_permission 內的分頁才讀得到 url
        try { currentHost = url ? new URL(url).hostname : ""; } catch (e) { currentHost = ""; }
        const ad = currentHost ? findAdapterForHost(currentHost) : null;
        currentSiteKey = ad ? ad.siteKey : null;
        if (!currentSiteKey) { renderSiteBar(); return; }
        siteOffGet(function (map) {
          siteEnabled = !map[currentSiteKey];
          renderSiteBar();
        });
      });
    } catch (e) { currentSiteKey = null; renderSiteBar(); }
  }

  function toggleSite() {
    if (!currentSiteKey) return;
    const next = !siteEnabled;
    siteEnabled = next; // 樂觀更新
    renderSiteBar();
    siteOffGet(function (map) {
      if (next) delete map[currentSiteKey]; // 啟用＝移出停用清單
      else map[currentSiteKey] = true;       // 停用＝加入停用清單
      siteOffSet(map, function () { toast(next ? "已在此站啟用" : "已在此站停用"); });
    });
  }

  // ── 狀態徽章 ─────────────────────────────────────────────────

  function renderLockBadge() {
    const b = el.lockBadge;
    b.className = "badge";
    if (lockState === LOCK.LOCKED) {
      b.textContent = "已鎖";
      b.classList.add("badge-locked");
    } else if (lockState === LOCK.UNLOCKED) {
      b.textContent = "已解鎖";
      b.classList.add("badge-unlocked");
    } else {
      b.textContent = "未設定";
      b.classList.add("badge-uninit");
    }
  }

  function renderMonitorBadge() {
    const b = el.monitorBadge;
    b.className = "badge";
    if (monitorActive) {
      b.textContent = "監控中";
      b.classList.add("badge-monitoring");
    } else {
      b.textContent = "待命";
      b.classList.add("badge-idle");
    }
  }

  // ── VAULT 區塊：依鎖定狀態切換 ───────────────────────────────

  function renderVault() {
    show(el.unlockBlock, lockState === LOCK.LOCKED);
    show(el.setupBlock, lockState === LOCK.UNINITIALIZED);
    show(el.unlockedBlock, lockState === LOCK.UNLOCKED);
    if (lockState !== LOCK.LOCKED) {
      el.pwInput.value = "";
      el.unlockErr.hidden = true;
    }
  }

  function doUnlock() {
    const password = el.pwInput.value || "";
    el.unlockErr.hidden = true;
    if (!password) {
      el.unlockErr.textContent = "請輸入主密碼。";
      el.unlockErr.hidden = false;
      return;
    }
    el.unlockBtn.disabled = true;
    send(MSG.UNLOCK_VAULT, { password: password }, function (res, err) {
      el.unlockBtn.disabled = false;
      if (err || !res) {
        toast("背景服務無回應，請重試。", true);
        return;
      }
      if (res.ok) {
        lockState = res.lockState || LOCK.UNLOCKED;
        el.pwInput.value = "";
        afterStateChange();
        toast("已解鎖");
      } else if (res.code === "MASTER_PASSWORD_WRONG") {
        el.unlockErr.textContent = "主密碼錯誤，請再試一次。";
        el.unlockErr.hidden = false;
      } else if (res.code === "VAULT_UNINITIALIZED") {
        lockState = LOCK.UNINITIALIZED;
        renderVault();
      } else {
        el.unlockErr.textContent = "解鎖失敗（" + (res.code || "未知") + "）。";
        el.unlockErr.hidden = false;
      }
    });
  }

  function doLock() {
    el.lockBtn.disabled = true;
    send(MSG.LOCK_VAULT, {}, function (res, err) {
      el.lockBtn.disabled = false;
      if (err || !res || !res.ok) {
        toast("鎖定失敗，請重試。", true);
        return;
      }
      lockState = res.lockState || LOCK.LOCKED;
      afterStateChange();
      toast("已鎖定");
    });
  }

  function openOptions() {
    if (chrome.runtime.openOptionsPage) chrome.runtime.openOptionsPage();
  }

  // ── 頁面增強開關 ─────────────────────────────────────────────

  function renderEnhance() {
    el.enhanceRows.innerHTML = "";
    ENHANCE_FIELDS.forEach(function (f) {
      const row = document.createElement("div");
      row.className = "row";

      const lab = document.createElement("span");
      lab.className = "lab";
      lab.textContent = f.label;

      const tgl = document.createElement("button");
      tgl.type = "button";
      tgl.className = "tgl" + (settings[f.key] ? " on" : "");
      tgl.setAttribute("role", "switch");
      tgl.setAttribute("aria-checked", settings[f.key] ? "true" : "false");
      tgl.setAttribute("aria-label", f.label);
      const knob = document.createElement("span");
      knob.className = "knob";
      tgl.appendChild(knob);

      tgl.addEventListener("click", function () {
        const next = !settings[f.key];
        // 先樂觀更新 UI，再寫回背景；失敗則回滾。
        settings[f.key] = next;
        tgl.classList.toggle("on", next);
        tgl.setAttribute("aria-checked", next ? "true" : "false");
        const patch = {};
        patch[f.key] = next;
        send(MSG.UPDATE_SETTINGS, { patch: patch }, function (res, err) {
          if (err || !res || !res.ok) {
            settings[f.key] = !next;
            tgl.classList.toggle("on", !next);
            tgl.setAttribute("aria-checked", !next ? "true" : "false");
            toast("設定儲存失敗。", true);
            return;
          }
          settings = res.settings || settings;
          // monitorEnabled 與監控按鈕狀態連動。
          if (f.key === "monitorEnabled") renderMonitorControls();
        });
      });

      row.appendChild(lab);
      row.appendChild(tgl);
      el.enhanceRows.appendChild(row);
    });
  }

  function loadSettings(cb) {
    send(MSG.GET_SETTINGS, {}, function (res, err) {
      if (!err && res && res.ok && res.settings) {
        settings = Object.assign({}, TT.DEFAULTS, res.settings);
      }
      renderEnhance();
      if (typeof cb === "function") cb();
    });
  }

  // ── 票券篩選（柴柴式 tag，即時套用）──────────────────────────
  // 對應 TTFilter 語意：每個 chip = 一個 OR 條件（chip 內可含逗號＝AND）；
  // 存檔時 includeStr = include chips 以 "+" 串接，excludeStr 同理。

  function chipsToStr(arr) { return arr.join("+"); }
  function strToChips(s) {
    return String(s || "").split("+").map(function (t) { return t.trim(); }).filter(Boolean);
  }

  function renderChips() {
    [[el.includeChips, includeChips, "include"], [el.excludeChips, excludeChips, "exclude"]].forEach(function (g) {
      var box = g[0], arr = g[1], which = g[2];
      if (!box) return;
      box.innerHTML = "";
      arr.forEach(function (text, idx) {
        var chip = document.createElement("span");
        chip.className = "chip";
        var label = document.createElement("span");
        label.className = "chip-text";
        label.textContent = text;
        var x = document.createElement("button");
        x.type = "button";
        x.className = "chip-x";
        x.setAttribute("aria-label", "移除 " + text);
        x.textContent = "×";
        x.addEventListener("click", function () { removeChip(which, idx); });
        chip.appendChild(label);
        chip.appendChild(x);
        box.appendChild(chip);
      });
    });
  }

  function renderSoldOut() {
    if (!el.hideSoldOut) return;
    el.hideSoldOut.classList.toggle("on", hideSoldOut);
    el.hideSoldOut.setAttribute("aria-checked", hideSoldOut ? "true" : "false");
  }

  // 加入條件：以 "+" 切成多個 OR-tag（tag 內保留逗號＝AND）；去重。
  function addChip(which, raw) {
    var parts = String(raw || "").split("+").map(function (t) { return t.trim(); }).filter(Boolean);
    if (!parts.length) return;
    var arr = which === "include" ? includeChips : excludeChips;
    parts.forEach(function (p) { if (arr.indexOf(p) === -1) arr.push(p); });
    renderChips();
    saveFilters();
  }

  function removeChip(which, idx) {
    var arr = which === "include" ? includeChips : excludeChips;
    arr.splice(idx, 1);
    renderChips();
    saveFilters();
  }

  function saveFilters() {
    var filters = {
      includeStr: chipsToStr(includeChips),
      excludeStr: chipsToStr(excludeChips),
      hideSoldOut: hideSoldOut
    };
    send(MSG.SAVE_FILTERS, { filters: filters }, function () { /* 無回應亦無妨 */ });
    // 有任一條件即自動開啟篩選；全空則關閉（與 content.js 即時連動）。
    var hasAny = !!(filters.includeStr || filters.excludeStr || filters.hideSoldOut);
    send(MSG.UPDATE_SETTINGS, { patch: { filterEnabled: hasAny } }, function (res) {
      if (res && res.ok && res.settings) settings = res.settings;
      else settings.filterEnabled = hasAny;
    });
  }

  function resetFilters() {
    includeChips = [];
    excludeChips = [];
    hideSoldOut = false;
    if (el.includeInput) el.includeInput.value = "";
    if (el.excludeInput) el.excludeInput.value = "";
    renderChips();
    renderSoldOut();
    saveFilters();
  }

  function loadFilters() {
    send(MSG.GET_FILTERS, {}, function (res, err) {
      var f = (!err && res && res.filters) ? res.filters : {};
      includeChips = strToChips(f.includeStr);
      excludeChips = strToChips(f.excludeStr);
      hideSoldOut = !!f.hideSoldOut;
      renderChips();
      renderSoldOut();
    });
  }

  // ── 一鍵填入 ─────────────────────────────────────────────────

  function loadProfiles() {
    send(MSG.LIST_PROFILES, {}, function (res, err) {
      if (err || !res) {
        show(el.autofillLocked, true);
        show(el.autofillReady, false);
        show(el.autofillEmpty, false);
        return;
      }
      if (res.ok === false && res.code === "VAULT_LOCKED") {
        show(el.autofillLocked, true);
        show(el.autofillReady, false);
        show(el.autofillEmpty, false);
        return;
      }
      const profiles = (res && res.profiles) || [];
      show(el.autofillLocked, false);
      if (profiles.length === 0) {
        show(el.autofillReady, false);
        show(el.autofillEmpty, true);
        return;
      }
      show(el.autofillEmpty, false);
      show(el.autofillReady, true);
      el.profileSelect.innerHTML = "";
      profiles.forEach(function (p) {
        const opt = document.createElement("option");
        opt.value = p.id;
        opt.textContent = p.label + (p.isDefault ? "（預設）" : "");
        if (p.isDefault) opt.selected = true;
        el.profileSelect.appendChild(opt);
      });
    });
  }

  function doAutofill() {
    const profileId = el.profileSelect.value;
    if (!profileId) {
      toast("請先選擇個資。", true);
      return;
    }
    el.autofillBtn.disabled = true;
    try {
      chrome.tabs.query({ active: true, currentWindow: true }, function (tabs) {
        if (chrome.runtime.lastError || !tabs || !tabs[0]) {
          el.autofillBtn.disabled = false;
          toast("找不到目前分頁。", true);
          return;
        }
        const tabId = tabs[0].id;
        try {
          chrome.tabs.sendMessage(
            tabId,
            { type: "AUTOFILL_NOW", profileId: profileId },
            function (resp) {
              el.autofillBtn.disabled = false;
              if (chrome.runtime.lastError) {
                // 該分頁沒有 content script（非售票頁）。
                toast("此分頁不支援填入，請於支援的購票頁使用（或確認此站開關為開）。", true);
                return;
              }
              if (resp && resp.ok === false) {
                toast("填入失敗" + (resp.code ? "（" + resp.code + "）" : "") + "。", true);
              } else {
                toast("已送出填入指令");
              }
            }
          );
        } catch (e) {
          el.autofillBtn.disabled = false;
          toast("此分頁不支援填入。", true);
        }
      });
    } catch (e) {
      el.autofillBtn.disabled = false;
      toast("無法存取分頁。", true);
    }
  }

  // ── 釋票監控 ─────────────────────────────────────────────────

  function renderMonitorControls() {
    if (monitorActive) {
      el.monitorState.textContent = "監控中";
      el.monitorState.classList.add("hint-live");
      el.monitorBtn.textContent = "停止";
      el.monitorBtn.classList.add("btn-active");
    } else {
      el.monitorState.textContent = "待命";
      el.monitorState.classList.remove("hint-live");
      el.monitorBtn.textContent = "啟動監控";
      el.monitorBtn.classList.remove("btn-active");
    }
  }

  function loadMonitor(cb) {
    send(MSG.GET_MONITOR, {}, function (res, err) {
      if (!err && res && res.monitor) {
        monitorActive = !!res.monitor.active;
      }
      renderMonitorBadge();
      renderMonitorControls();
      if (typeof cb === "function") cb();
    });
  }

  function toggleMonitor() {
    const turningOn = !monitorActive;
    const type = turningOn ? MSG.START_MONITOR : MSG.STOP_MONITOR;
    el.monitorBtn.disabled = true;
    send(type, turningOn ? { task: {} } : {}, function (res, err) {
      el.monitorBtn.disabled = false;
      if (err || !res || !res.ok) {
        toast("監控操作失敗，請重試。", true);
        return;
      }
      monitorActive = res.monitor ? !!res.monitor.active : turningOn;
      // 同步 monitorEnabled 設定，並更新增強區的對應開關。
      const patch = { monitorEnabled: monitorActive };
      send(MSG.UPDATE_SETTINGS, { patch: patch }, function (sres, serr) {
        if (!serr && sres && sres.ok && sres.settings) {
          settings = sres.settings;
        } else {
          settings.monitorEnabled = monitorActive;
        }
        renderEnhance();
      });
      renderMonitorBadge();
      renderMonitorControls();
      toast(monitorActive ? "已啟動監控" : "已停止監控");
    });
  }

  // ── 鎖定狀態變更後的連動更新 ─────────────────────────────────

  function afterStateChange() {
    renderLockBadge();
    renderVault();
    loadProfiles(); // 解鎖/上鎖會改變個資是否可列出
  }

  // ── 初始化 ───────────────────────────────────────────────────

  function init() {
    // 表頭齒輪。
    el.openOptions.addEventListener("click", openOptions);

    // 每站總開關。
    if (el.siteToggle) el.siteToggle.addEventListener("click", toggleSite);
    loadSiteBar();

    // vault 操作。
    el.unlockBtn.addEventListener("click", doUnlock);
    el.pwInput.addEventListener("keydown", function (e) {
      if (e.key === "Enter") doUnlock();
    });
    el.setupBtn.addEventListener("click", openOptions);
    el.lockBtn.addEventListener("click", doLock);

    // autofill / monitor。
    el.autofillBtn.addEventListener("click", doAutofill);
    el.monitorBtn.addEventListener("click", toggleMonitor);

    // 票券篩選（柴柴式）：Enter 或 ＋ 加 tag；隱藏售完切換；reset 顯示全部。
    el.includeAdd.addEventListener("click", function () {
      addChip("include", el.includeInput.value); el.includeInput.value = ""; el.includeInput.focus();
    });
    el.includeInput.addEventListener("keydown", function (e) {
      if (e.key === "Enter") { addChip("include", el.includeInput.value); el.includeInput.value = ""; }
    });
    el.excludeAdd.addEventListener("click", function () {
      addChip("exclude", el.excludeInput.value); el.excludeInput.value = ""; el.excludeInput.focus();
    });
    el.excludeInput.addEventListener("keydown", function (e) {
      if (e.key === "Enter") { addChip("exclude", el.excludeInput.value); el.excludeInput.value = ""; }
    });
    el.hideSoldOut.addEventListener("click", function () {
      hideSoldOut = !hideSoldOut; renderSoldOut(); saveFilters();
    });
    el.filterReset.addEventListener("click", resetFilters);

    // 開啟即拉取狀態。
    send(MSG.GET_LOCK_STATE, {}, function (res, err) {
      lockState = (!err && res && res.lockState) ? res.lockState : LOCK.UNINITIALIZED;
      renderLockBadge();
      renderVault();
      loadProfiles();
    });
    loadMonitor();
    loadSettings();
    loadFilters();

    // 即時刷新：背景廣播鎖定狀態變更（解鎖/上鎖/重設/關閉分頁自動鎖）。
    chrome.runtime.onMessage.addListener(function (msg) {
      if (msg && msg.type === MSG.LOCK_STATE_CHANGED) {
        lockState = msg.lockState || lockState;
        afterStateChange();
      }
    });
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
})();
