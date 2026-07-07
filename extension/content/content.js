// content script：注入售票頁，套用「清版面 / 放大關鍵按鈕 / 票券篩選 / 倒數校時 /
// 自動刷新 / 到票監控 / 一鍵填入」並注入戰術風浮動工具列。
//
// 嚴守界線（規格 §2 商業規則）：
//   BR-3：本檔絕不含「送出 / 購買 / 確認付款 / 自動點擊票區」的點擊路徑（連 autofill 也不按送出）。
//   BR-4：唯一允許的網路請求＝對「售票站本站」做 HEAD 校時（讀其 Date 標頭），不外傳任何資料、不打第三方。
//   BR-6：填入時強制中文姓名 ≤ 7 字。
//   BR-7 / NFR-8：任何例外都不可破壞或阻擋原生購票流程 → 全程 try/catch，失敗 console.warn 後繼續。
//
// 載入順序（manifest 已設）：lib/messages.js → lib/filter.js → content/adapters.js → content/content.js
//   故全域 TT（訊息/key/預設）與 TTFilter（篩選）此時皆已就緒。
(function () {
  "use strict";

  // ── 全域守衛：避免重複注入（SPA 重新執行 content script 時）──
  if (window.__TT_CONTENT_BOOTED__) return;
  window.__TT_CONTENT_BOOTED__ = true;

  // TT / TTFilter 預期由前序檔提供；若缺失則退場（不應發生，純防呆）。
  var TT = window.TT;
  var TTFilter = window.TTFilter;
  if (!TT || !TT.MSG) {
    console.warn("[搶票助手] 缺少 TT 契約，content script 退場。");
    return;
  }

  // 小工具：所有 console 輸出統一前綴，便於辨識。
  function warn() {
    try {
      var args = Array.prototype.slice.call(arguments);
      args.unshift("[搶票助手]");
      console.warn.apply(console, args);
    } catch (e) {
      /* 忽略 */
    }
  }

  // 包一層：任何回呼都先 try/catch（守住 BR-7）。
  function guard(label, fn) {
    return function () {
      try {
        return fn.apply(this, arguments);
      } catch (e) {
        warn(label + " 發生例外，已略過：", e);
      }
    };
  }

  // ── 站台適配偵測（FR-1）──
  function findAdapter() {
    var host = location.hostname;
    var list = window.__TT_ADAPTERS || [];
    for (var i = 0; i < list.length; i++) {
      var a = list[i];
      if (a.hostPatterns && a.hostPatterns.some(function (p) { return host.indexOf(p) !== -1; })) {
        return a;
      }
    }
    return null;
  }

  var adapter = findAdapter();
  if (!adapter) return; // 非支援站台 → 完全不介入（no-op）

  // ── 安全查詢（無效選擇器不丟例外）──
  function $all(sel) {
    if (!sel) return [];
    try {
      return Array.prototype.slice.call(document.querySelectorAll(sel));
    } catch (e) {
      return [];
    }
  }
  function matchesSel(el, sel) {
    if (!el || !sel) return false;
    try {
      return el.matches ? el.matches(sel) : false;
    } catch (e) {
      return false;
    }
  }

  // ── 與 background 溝通：永不丟例外的 sendMessage（無 handler 時 resolve null）──
  // 背景若尚未實作對應 handler，sendResponse 不會被呼叫 → 會有 lastError；視為 null。
  function send(msg) {
    return new Promise(function (resolve) {
      try {
        chrome.runtime.sendMessage(msg, function (resp) {
          // 讀取 lastError 以抑制 Unchecked runtime.lastError 警告。
          var err = chrome.runtime && chrome.runtime.lastError;
          if (err) {
            resolve(null);
            return;
          }
          resolve(resp == null ? null : resp);
        });
      } catch (e) {
        resolve(null);
      }
    });
  }

  // 直接讀 storage（背景未實作 GET_* 時的後援）。
  function storageGet(key) {
    return new Promise(function (resolve) {
      try {
        chrome.storage.local.get(key, function (res) {
          var err = chrome.runtime && chrome.runtime.lastError;
          if (err) { resolve(null); return; }
          resolve(res ? res[key] : null);
        });
      } catch (e) {
        resolve(null);
      }
    });
  }

  // ── 全域狀態 ──
  var state = {
    settings: Object.assign({}, TT.DEFAULTS),
    filters: { includeStr: "", excludeStr: "", hideSoldOut: false },
    monitor: null,        // { active, targetUrl, eventLabel, targetTime?, ... }
    siteEnabled: true,    // 使用者「每站開關」：此站台是否啟用外掛（讀自 tt_site_off）
    timeOffsetMs: 0,      // 校時偏移（serverMs - Date.now()）
    timeSynced: false,    // 是否已校時成功
    soundOn: true,        // 工具列音效開關（預設依 settings.notifySound）
    monitorWasAvailable: false,
    refreshTimer: null,
    monitorTimer: null,
    clockTimer: null,
    audioCtx: null,
    // 各功能「實際結果」統計，供 STATUS 總覽顯示是否真的生效。
    status: {
      declutterHidden: 0,
      enlargeMarked: 0,
      filterShown: 0,
      filterHidden: 0,
      monitorChecks: 0,
      monitorAvail: false,
      lockState: null,   // 由 GET_LOCK_STATE / LOCK_STATE_CHANGED 更新
      profileCount: 0
    }
  };

  // ─────────────────────────────────────────────────────────────
  // 1) 長連線 port：驅動「關閉分頁自動上鎖」（NFR-5 / lockBehavior:"tab-close"）。
  //    分頁關閉 → port 斷線 → background 可據此判斷是否所有售票分頁皆已關閉並上鎖。
  // ─────────────────────────────────────────────────────────────
  var port = null;
  function openPort() {
    try {
      port = chrome.runtime.connect({ name: "tt-page" });
      // 斷線（背景重啟）時不報錯；自動上鎖由 background 端依連線數決定。
      port.onDisconnect.addListener(function () {
        var err = chrome.runtime && chrome.runtime.lastError; // 抑制警告
        void err;
        port = null;
      });
    } catch (e) {
      warn("建立長連線 port 失敗（不影響其他功能）：", e);
    }
  }

  // ─────────────────────────────────────────────────────────────
  // 2) 讀取設定 / 篩選 / 監控（優先走 background 訊息；無回應則退回 storage + 預設）
  // ─────────────────────────────────────────────────────────────
  function loadSettings() {
    return send({ type: TT.MSG.GET_SETTINGS }).then(function (resp) {
      var data = unwrap(resp) || null;
      if (!data) return storageGet(TT.KEYS.SETTINGS);
      return data;
    }).then(function (s) {
      state.settings = Object.assign({}, TT.DEFAULTS, s || {});
      // 音效預設跟隨 notifySound。
      state.soundOn = state.settings.notifySound !== false;
    });
  }
  function loadFilters() {
    return send({ type: TT.MSG.GET_FILTERS }).then(function (resp) {
      var data = unwrap(resp);
      if (!data) return storageGet(TT.KEYS.FILTERS);
      return data;
    }).then(function (f) {
      state.filters = Object.assign({ includeStr: "", excludeStr: "", hideSoldOut: false }, f || {});
    });
  }
  function loadMonitor() {
    return send({ type: TT.MSG.GET_MONITOR }).then(function (resp) {
      var data = unwrap(resp);
      if (!data) return storageGet(TT.KEYS.MONITOR);
      return data;
    }).then(function (m) {
      state.monitor = m || null;
    });
  }
  // 每站開關：tt_site_off 是「停用清單」（{ [siteKey]: true }）；不在表內＝啟用。讀取失敗一律視為啟用。
  function loadSiteEnabled() {
    return storageGet(TT.KEYS.SITE_OFF).then(function (map) {
      state.siteEnabled = !(map && map[adapter.siteKey]);
    }).catch(function () { state.siteEnabled = true; });
  }

  // background 回應外型未定（可能 {ok,data} 或直接物件）→ 寬鬆解包。
  function unwrap(resp) {
    if (!resp) return null;
    if (resp.data !== undefined) return resp.data;
    if (resp.settings !== undefined) return resp.settings;
    if (resp.filters !== undefined) return resp.filters;
    if (resp.monitor !== undefined) return resp.monitor;
    if (resp.ok === false) return null;
    return resp;
  }

  // ─────────────────────────────────────────────────────────────
  // 4) 清版面（declutter）
  // ─────────────────────────────────────────────────────────────
  // 清版面採「注入 <style> 規則」而非逐元素加 class：CSS 規則對「之後才出現/被 React 重繪的元素」
  // 立即生效，不需 MutationObserver 慢半拍補加 → 從機制上根除「顯示↔隱藏」閃爍。
  var declutterStyleEl = null;
  function ensureDeclutterStyle() {
    try {
      if (declutterStyleEl && declutterStyleEl.isConnected) return declutterStyleEl;
      var head = document.head || document.documentElement;
      declutterStyleEl = document.createElement("style");
      declutterStyleEl.setAttribute("data-tt", "declutter");
      head.appendChild(declutterStyleEl);
      return declutterStyleEl;
    } catch (e) { return null; }
  }
  function clearDeclutter() {
    if (declutterStyleEl) { try { declutterStyleEl.textContent = ""; } catch (e) { /* 忽略 */ } }
    // 清掉舊式 class 殘留（保險）。
    $all(".tt-hidden").forEach(function (el) { el.classList.remove("tt-hidden"); });
  }
  function applyDeclutter() {
    var sel = (adapter.declutterSelectors || []).join(", ");
    if (!state.settings.declutterEnabled || !sel) { clearDeclutter(); state.status.declutterHidden = 0; return; }
    var styleEl = ensureDeclutterStyle();
    if (styleEl) styleEl.textContent = sel + "{display:none !important;}";
    // 僅供 STATUS 顯示的統計（不影響套用）。
    try { state.status.declutterHidden = $all(sel).length; } catch (e) { state.status.declutterHidden = 0; }
  }

  // ─────────────────────────────────────────────────────────────
  // 5) 放大關鍵按鈕（enlarge）
  // ─────────────────────────────────────────────────────────────
  function clearEnlarge() {
    $all(".tt-enlarge").forEach(function (el) { el.classList.remove("tt-enlarge"); });
  }
  function applyEnlarge() {
    if (!state.settings.enlargeButtonsEnabled) { clearEnlarge(); state.status.enlargeMarked = 0; return; }
    var n = 0;
    (adapter.keyButtonSelectors || []).forEach(function (sel) {
      $all(sel).forEach(function (el) {
        if (el.classList && !el.classList.contains("tt-enlarge")) el.classList.add("tt-enlarge");
        n++;
      });
    });
    state.status.enlargeMarked = n;
  }

  // ─────────────────────────────────────────────────────────────
  // 6) 票券篩選（filter）— 委派 TTFilter；售完判定用 adapter.soldOutSelector。
  // ─────────────────────────────────────────────────────────────
  function isSoldOut(item) {
    if (!item) return false;
    // (1) 文字判定（主）：tixCraft 等站無乾淨售完 class（開源 bot 證實）→ 以文字「售完/完售/sold out」為準。
    try {
      var txt = (item.textContent || "").toLowerCase();
      if (/售完|完售|額滿|sold\s*out|매진|품절/.test(txt)) return true;
    } catch (e) { /* 忽略 */ }
    // (2) class 後援：adapter 有設 soldOutSelector 時，本身或後代命中亦算售完。
    if (adapter.soldOutSelector) {
      if (matchesSel(item, adapter.soldOutSelector)) return true;
      try {
        if (item.querySelector && item.querySelector(adapter.soldOutSelector)) return true;
      } catch (e) { /* 忽略 */ }
    }
    return false;
  }
  function applyFilter() {
    var items = $all(adapter.areaItemSelector);
    if (!state.settings.filterEnabled) {
      // 關閉時清除既有隱藏標記，恢復顯示。
      items.forEach(function (el) {
        if (el.classList) el.classList.remove(TTFilter.HIDDEN_CLASS);
      });
      return { shown: items.length, hidden: 0 };
    }
    if (!TTFilter || !TTFilter.apply) return { shown: 0, hidden: 0 };
    return TTFilter.apply({
      items: items,
      includeStr: state.filters.includeStr,
      excludeStr: state.filters.excludeStr,
      hideSoldOut: state.filters.hideSoldOut,
      isSoldOut: isSoldOut
    });
  }

  // 三合一重套（供初始化 / storage 變更 / DOM 變動共用）。
  var applyEnhancements = guard("套用頁面增強", function () {
    var on = shouldEnhance();
    if (ui.bar) ui.bar.style.display = on ? "" : "none"; // 站台停用 / 非票務頁 → 收起工具列
    if (!on) { clearDeclutter(); clearEnlarge(); return; } // 不介入 → 還原版面
    applyDeclutter();
    applyEnlarge();
    var r = applyFilter();
    updateFilterCount(r);
    if (r) {
      state.status.filterShown = r.shown;
      state.status.filterHidden = r.hidden;
    }
    updateStatusUI();
  });

  // ─────────────────────────────────────────────────────────────
  // 7) 戰術風浮動工具列
  // ─────────────────────────────────────────────────────────────
  var ui = {}; // 快取 DOM 節點

  function buildToolbar() {
    if (document.getElementById("tt-toolbar")) return;
    if (!document.body) return;

    var bar = document.createElement("div");
    bar.id = "tt-toolbar";
    bar.className = "tt-toolbar";

    // 頭部：品牌 + 即時點 + 收合鍵
    var head = document.createElement("div");
    head.className = "tt-head";
    head.innerHTML =
      '<span class="tt-brand"><span class="tt-dot" id="tt-live-dot"></span>搶票助手</span>' +
      '<div class="tt-head-right">' +
      '<span class="tt-cap-clock tt-mono" id="tt-cap-clock">--:--:--</span>' +
      '<button class="tt-iconbtn tt-collapse" type="button" title="收合 / 展開">—</button>' +
      "</div>";
    bar.appendChild(head);

    // 主體
    var body = document.createElement("div");
    body.className = "tt-body";

    // 7a) 倒數 / 校時時鐘（毫秒鐘為主角；label 兼顯「校時」狀態）
    var clockBlock = document.createElement("div");
    clockBlock.className = "tt-block tt-clock-block";
    clockBlock.innerHTML =
      '<div class="tt-label" id="tt-clock-label">CLOCK · 未校時（本機時間）</div>' +
      '<div class="tt-clock tt-mono" id="tt-clock">--:--:--.---</div>' +
      '<div class="tt-sub tt-mono" id="tt-countdown"></div>';
    body.appendChild(clockBlock);

    // 7b) 動作列：一鍵填入 + 保險箱鎖定小燈（看不見的「保險箱」狀態）
    var actions = document.createElement("div");
    actions.className = "tt-actions";
    actions.innerHTML =
      '<button class="tt-btn tt-btn-primary" id="tt-autofill" type="button">一鍵填入</button>' +
      '<span class="tt-lock-glyph tt-off" id="tt-lock-glyph" title="保險箱">○</span>';
    body.appendChild(actions);

    // 7c) 防呆說明
    var note = document.createElement("div");
    note.className = "tt-note";
    note.textContent = "送出一律由你手動點擊 · 純本機不外傳";
    body.appendChild(note);

    bar.appendChild(body);
    document.body.appendChild(bar);

    // 快取
    ui.bar = bar;
    ui.body = body;
    ui.liveDot = bar.querySelector("#tt-live-dot");
    ui.capClock = bar.querySelector("#tt-cap-clock");
    ui.clock = bar.querySelector("#tt-clock");
    ui.clockLabel = bar.querySelector("#tt-clock-label");
    ui.countdown = bar.querySelector("#tt-countdown");
    ui.clockBlock = clockBlock;
    ui.lockGlyph = bar.querySelector("#tt-lock-glyph");

    // ── 拖曳：抓標題列移動工具列，避免擋住頁面；夾在視窗內，放開記住位置 ──
    (function enableDrag() {
      head.style.cursor = "move";
      var dragging = false, sx = 0, sy = 0, ox = 0, oy = 0;

      function clamp(nx, ny) {
        var w = bar.offsetWidth, h = bar.offsetHeight;
        return [
          Math.max(0, Math.min(nx, window.innerWidth - w)),
          Math.max(0, Math.min(ny, window.innerHeight - h))
        ];
      }

      head.addEventListener("pointerdown", guard("拖曳開始", function (e) {
        // 在按鈕（收合/音效等）上不啟動拖曳
        if (e.target && e.target.closest && e.target.closest("button")) return;
        dragging = true;
        var rect = bar.getBoundingClientRect();
        ox = rect.left; oy = rect.top;
        sx = e.clientX; sy = e.clientY;
        bar.style.left = ox + "px";
        bar.style.top = oy + "px";
        bar.style.right = "auto";
        try { head.setPointerCapture(e.pointerId); } catch (_e) {}
        e.preventDefault();
      }));

      head.addEventListener("pointermove", guard("拖曳中", function (e) {
        if (!dragging) return;
        var c = clamp(ox + (e.clientX - sx), oy + (e.clientY - sy));
        bar.style.left = c[0] + "px";
        bar.style.top = c[1] + "px";
      }));

      function endDrag(e) {
        if (!dragging) return;
        dragging = false;
        try { head.releasePointerCapture(e.pointerId); } catch (_e) {}
        try {
          chrome.storage.local.set({
            tt_toolbar_pos: { left: parseInt(bar.style.left, 10), top: parseInt(bar.style.top, 10) }
          });
        } catch (_e) {}
      }
      head.addEventListener("pointerup", guard("拖曳結束", endDrag));
      head.addEventListener("pointercancel", guard("拖曳取消", endDrag));

      // 還原上次拖到的位置
      try {
        chrome.storage.local.get("tt_toolbar_pos", function (res) {
          var err = chrome.runtime && chrome.runtime.lastError;
          if (err) return;
          var p = res && res.tt_toolbar_pos;
          if (p && typeof p.left === "number" && typeof p.top === "number") {
            var c = clamp(p.left, p.top);
            bar.style.left = c[0] + "px";
            bar.style.top = c[1] + "px";
            bar.style.right = "auto";
          }
        });
      } catch (_e) {}
    })();

    // 收合 ↔ 展開：收合態＝精簡膠囊（只剩 即時點 + 等寬倒數 + 展開鍵）
    bar.querySelector(".tt-collapse").addEventListener("click", guard("切換收合", function () {
      bar.classList.toggle("tt-collapsed");
    }));

    // 一鍵填入
    bar.querySelector("#tt-autofill").addEventListener("click", guard("一鍵填入", function () {
      runAutofill(null);
    }));

    // 顯示倒數區塊與否
    clockBlock.style.display = state.settings.countdownEnabled === false ? "none" : "";

    // 首次渲染狀態總覽
    updateStatusUI();
  }

  function syncSoundBtn() {
    if (!ui.soundBtn) return;
    ui.soundBtn.textContent = state.soundOn ? "🔔" : "🔕";
    ui.soundBtn.classList.toggle("tt-off", !state.soundOn);
    ui.soundBtn.title = state.soundOn ? "聲音提示：開" : "聲音提示：關";
  }

  function updateFilterCount(r) {
    if (!ui.fcount) return;
    if (!state.settings.filterEnabled || !r) {
      ui.fcount.style.display = "none";
      return;
    }
    ui.fcount.style.display = "";
    ui.fcount.textContent = "顯示 " + r.shown + " / 隱藏 " + r.hidden;
  }

  // ── 精簡 HUD：只更新三個「看不見」的訊號 ──
  //   監控燈（header 即時點）／ 校時 label（clock 標題）／ 保險箱鎖定小燈（一鍵填入旁）。
  //   可見功能（清版面 / 放大 / 篩選）效果直接呈現在頁面上，不在 HUD 重複列出。
  function updateStatusUI() {
    if (!ui.bar) return;
    var s = state.status;
    var set = state.settings;

    // 1) 監控燈：灰＝待命/關、藍＝監控中、綠＝偵測到可購票
    if (ui.liveDot) {
      var hit = !!(set.monitorEnabled && s.monitorAvail);
      var mon = !!(set.monitorEnabled && !s.monitorAvail);
      ui.liveDot.classList.toggle("tt-live-hit", hit);
      ui.liveDot.classList.toggle("tt-monitoring", mon);
      ui.liveDot.title = hit
        ? "偵測到可購票！"
        : (mon ? ("監控中 · 已檢查 " + s.monitorChecks) : "監控：待命");
    }

    // 2) 校時 label：關閉 / 已校時 / 未校時（本機）
    if (ui.clockLabel) {
      ui.clockLabel.textContent = set.countdownEnabled === false
        ? "CLOCK · 校時關閉"
        : (state.timeSynced ? "CLOCK · 已校時" : "CLOCK · 未校時（本機時間）");
    }

    // 3) 保險箱鎖定小燈：🔓 已解鎖 / 🔒 已鎖 / ○ 未設定 / 查詢中
    if (ui.lockGlyph) {
      var g = "○", cls = "tt-off", title = "保險箱：查詢中";
      if (s.lockState === TT.LOCK.UNLOCKED) {
        g = "🔓"; cls = "tt-ok"; title = "保險箱：已解鎖 · " + (s.profileCount || 0) + " 筆";
      } else if (s.lockState === TT.LOCK.LOCKED) {
        g = "🔒"; cls = "tt-alert"; title = "保險箱：已鎖（請從工具列彈窗解鎖）";
      } else if (s.lockState === TT.LOCK.UNINITIALIZED) {
        g = "○"; cls = "tt-off"; title = "保險箱：未設定";
      }
      ui.lockGlyph.textContent = g;
      ui.lockGlyph.className = "tt-lock-glyph " + cls;
      ui.lockGlyph.title = title;
    }
  }

  // 查詢保險箱鎖定狀態（GET_LOCK_STATE）→ 更新狀態總覽。
  function refreshLockStatus() {
    send({ type: TT.MSG.GET_LOCK_STATE }).then(function (resp) {
      if (resp) {
        var ls = resp.lockState || (resp.data && resp.data.lockState) || null;
        state.status.lockState = ls;
        if (typeof resp.profileCount === "number") state.status.profileCount = resp.profileCount;
      } else {
        state.status.lockState = null;
      }
      updateStatusUI();
    });
  }

  // ── 校時 + 時鐘（BR-4：只對本站 HEAD，讀 Date 標頭）──
  function pad(n, w) {
    var s = String(Math.abs(n));
    w = w || 2;
    while (s.length < w) s = "0" + s;
    return s;
  }
  function correctedNow() {
    return Date.now() + state.timeOffsetMs;
  }
  function syncServerTime() {
    // 僅對「售票站本站 origin」發 HEAD；無 body、不帶自訂資料、無第三方 host。
    try {
      fetch(location.origin, { method: "HEAD", cache: "no-store", credentials: "omit" })
        .then(function (resp) {
          var dateHdr = resp && resp.headers ? resp.headers.get("Date") : null;
          if (!dateHdr) throw new Error("無 Date 標頭");
          var serverMs = new Date(dateHdr).getTime();
          if (!serverMs || isNaN(serverMs)) throw new Error("Date 解析失敗");
          state.timeOffsetMs = serverMs - Date.now();
          state.timeSynced = true;
          if (ui.clockLabel) ui.clockLabel.textContent = "CLOCK · 已校時";
          updateStatusUI();
        })
        .catch(function (e) {
          state.timeSynced = false;
          if (ui.clockLabel) ui.clockLabel.textContent = "CLOCK · 未校時（本機時間）";
          warn("校時失敗，改用本機時間：", e && e.message ? e.message : e);
          updateStatusUI();
        });
    } catch (e) {
      state.timeSynced = false;
    }
  }

  // 解析 monitor 的開賣目標時間（容忍多種欄位名 / 格式）。回傳 ms 或 null。
  function getTargetTimeMs() {
    var m = state.monitor;
    if (!m) return null;
    var raw = m.targetTime || m.onsaleAt || m.onSaleTime || m.startTime || null;
    if (!raw) return null;
    if (typeof raw === "number") return raw;
    var t = new Date(raw).getTime();
    return (t && !isNaN(t)) ? t : null;
  }

  function tickClock() {
    if (!ui.clock) return;
    var now = correctedNow();
    var d = new Date(now);
    var hh = pad(d.getHours());
    var mm = pad(d.getMinutes());
    var ss = pad(d.getSeconds());
    var ms = pad(d.getMilliseconds(), 3);
    var clockStr = hh + ":" + mm + ":" + ss + "." + ms;
    ui.clock.textContent = clockStr;
    if (ui.capClock) ui.capClock.textContent = hh + ":" + mm + ":" + ss;

    // 倒數至開賣
    var target = getTargetTimeMs();
    if (target && ui.countdown) {
      var diff = target - now;
      if (diff > 0) {
        var totalSec = Math.floor(diff / 1000);
        var ch = Math.floor(totalSec / 3600);
        var cm = Math.floor((totalSec % 3600) / 60);
        var cs = totalSec % 60;
        var cms = pad(diff % 1000, 3);
        ui.countdown.textContent = "T-" + pad(ch) + ":" + pad(cm) + ":" + pad(cs) + "." + cms;
        ui.countdown.classList.remove("tt-go");
      } else {
        ui.countdown.textContent = "T-00:00:00.000 · 開賣";
        ui.countdown.classList.add("tt-go");
      }
    } else if (ui.countdown) {
      ui.countdown.textContent = "";
    }
  }

  function startClock() {
    if (state.clockTimer) return;
    // 用 ~60fps 內節流到 100ms：足夠平滑且省資源。
    state.clockTimer = setInterval(guard("時鐘", tickClock), 100);
    tickClock();
  }

  // ─────────────────────────────────────────────────────────────
  // 8) 自動刷新（含兩道閘門：排隊/驗證/結帳頁、使用者輸入中 → 一律跳過）
  // ─────────────────────────────────────────────────────────────
  function isQueueOrVerifyPage() {
    // (a-1) URL 樣態
    if (/verify|checkout|order|queue|waiting|booking|seat|payment/i.test(location.href)) return true;
    // (a-2) 驗證碼元素存在（通用）
    try {
      if (document.querySelector("img[src*=captcha], [class*=captcha], canvas")) return true;
    } catch (e) { /* 忽略 */ }
    // (a-3) adapter 指定的驗證/結帳頁元素（tixCraft：#TicketForm_verifyCode / .zone-verify / #submitButton 等）
    try {
      var vs = adapter.verifySelectors;
      if (vs && vs.length && document.querySelector(vs.join(","))) return true;
    } catch (e) { /* 忽略 */ }
    return false;
  }
  function isUserTyping() {
    var el = document.activeElement;
    if (!el) return false;
    var tag = (el.tagName || "").toUpperCase();
    if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return true;
    if (el.isContentEditable) return true;
    return false;
  }
  function startAutoRefresh() {
    stopAutoRefresh();
    if (!state.settings.autoRefreshEnabled) return;
    var interval = Math.max(300, Number(state.settings.refreshIntervalMs) || TT.DEFAULTS.refreshIntervalMs);
    state.refreshTimer = setInterval(guard("自動刷新", function () {
      // EC-7 / EC-2 / BR-5：任一閘門成立即跳過本次刷新。
      if (!shouldEnhance()) return; // 站台停用 / 非票務頁
      if (isQueueOrVerifyPage()) return;
      if (isUserTyping()) return;
      location.reload();
    }), interval);
  }
  function stopAutoRefresh() {
    if (state.refreshTimer) { clearInterval(state.refreshTimer); state.refreshTimer = null; }
  }

  // ─────────────────────────────────────────────────────────────
  // 9) 到票監控（poll；不自動點擊 BR-3）
  // ─────────────────────────────────────────────────────────────
  function isTicketsAvailable() {
    var items = $all(adapter.areaItemSelector);
    if (!items.length) return false;
    for (var i = 0; i < items.length; i++) {
      if (!isSoldOut(items[i])) return true; // 至少一個未售完 → 視為有票
    }
    return false;
  }
  function beep() {
    if (!state.soundOn) return;
    try {
      var Ctx = window.AudioContext || window.webkitAudioContext;
      if (!Ctx) return;
      if (!state.audioCtx) state.audioCtx = new Ctx();
      var ctx = state.audioCtx;
      if (ctx.state === "suspended" && ctx.resume) ctx.resume();
      var t0 = ctx.currentTime;
      // 兩聲短促 beep（880Hz）。
      [0, 0.18].forEach(function (offset) {
        var osc = ctx.createOscillator();
        var gain = ctx.createGain();
        osc.type = "sine";
        osc.frequency.value = 880;
        gain.gain.setValueAtTime(0.0001, t0 + offset);
        gain.gain.exponentialRampToValueAtTime(0.2, t0 + offset + 0.02);
        gain.gain.exponentialRampToValueAtTime(0.0001, t0 + offset + 0.14);
        osc.connect(gain);
        gain.connect(ctx.destination);
        osc.start(t0 + offset);
        osc.stop(t0 + offset + 0.16);
      });
    } catch (e) {
      warn("音效播放失敗（不影響監控）：", e);
    }
  }
  function showBanner() {
    try {
      var existing = document.getElementById("tt-banner");
      if (existing) return;
      var b = document.createElement("div");
      b.id = "tt-banner";
      b.className = "tt-banner";
      b.innerHTML =
        '<span class="tt-banner-dot"></span>' +
        '<span class="tt-banner-text">偵測到可購買票區！請手動確認並點選</span>' +
        '<button class="tt-banner-x" type="button" title="關閉">×</button>';
      document.body.appendChild(b);
      b.querySelector(".tt-banner-x").addEventListener("click", function () {
        if (b.parentNode) b.parentNode.removeChild(b);
      });
    } catch (e) {
      warn("顯示橫幅失敗：", e);
    }
  }
  function onBecameAvailable() {
    beep();
    showBanner();
    // 通知 background 發桌面通知（content 不自行發 desktop notification）。
    send({
      type: TT.MSG.TICKETS_AVAILABLE,
      siteKey: adapter.siteKey,
      targetUrl: location.href,
      eventLabel: document.title
    });
  }
  function pollMonitor() {
    if (!shouldEnhance()) return; // 站台停用 / 非票務頁 → 暫停監控
    state.status.monitorChecks++;
    var avail = isTicketsAvailable();
    if (avail && !state.monitorWasAvailable) {
      onBecameAvailable();
    }
    state.monitorWasAvailable = avail;
    state.status.monitorAvail = avail;
    if (ui.liveDot) ui.liveDot.classList.toggle("tt-live-hit", avail);
    updateStatusUI();
  }
  function startMonitor() {
    stopMonitor();
    if (!state.settings.monitorEnabled) {
      state.status.monitorAvail = false;
      updateStatusUI();
      return;
    }
    var interval = Math.max(300, Number(state.settings.refreshIntervalMs) || TT.DEFAULTS.refreshIntervalMs);
    state.monitorWasAvailable = isTicketsAvailable(); // 以當前狀態為基準，避免一進場就誤報
    state.status.monitorAvail = state.monitorWasAvailable;
    state.status.monitorChecks = 0;
    state.monitorTimer = setInterval(guard("到票監控", pollMonitor), interval);
    updateStatusUI();
  }
  function stopMonitor() {
    if (state.monitorTimer) { clearInterval(state.monitorTimer); state.monitorTimer = null; }
  }

  // ─────────────────────────────────────────────────────────────
  // 10) 一鍵填入（autofill）— 絕不點擊送出（BR-3）
  // ─────────────────────────────────────────────────────────────

  // 各欄位的關鍵字（用於 name/id/placeholder/autocomplete/鄰近 label 比對）。
  var FIELD_KEYWORDS = {
    label: [],
    nameZh: ["姓名", "中文姓名", "name", "真實姓名", "持票人"],
    nameEn: ["英文姓名", "english", "name-en", "romanized", "拼音"],
    name: ["姓名", "name", "持票人"],
    idType: ["證件類型", "證件別", "idtype", "id-type"],
    idNumber: ["身分證", "身份證", "證件", "證件號", "id", "identity", "national"],
    phone: ["手機", "電話", "phone", "mobile", "tel", "聯絡電話"],
    email: ["email", "電子郵件", "信箱", "mail", "e-mail"],
    birthday: ["生日", "出生", "birth", "birthday", "dob"],
    address: ["地址", "address", "住址", "通訊地址"]
  };

  function norm(s) {
    return String(s == null ? "" : s).toLowerCase().replace(/\s+/g, "");
  }

  // 找出某欄位對應的輸入元素：優先 adapter.formFieldMap，否則啟發式比對。
  function findInputForField(fieldKey) {
    // 1) adapter.formFieldMap（若存在）。⚠️ adapters.js 目前未定義此欄，預設走啟發式。
    var map = adapter.formFieldMap || {};
    if (map[fieldKey]) {
      var bySel = $all(map[fieldKey]).filter(isFillableInput);
      if (bySel.length) return bySel[0];
    }
    // 2) 啟發式：掃描所有可填欄位，依關鍵字命中。
    var keywords = FIELD_KEYWORDS[fieldKey] || [fieldKey];
    var inputs = $all("input, textarea, select").filter(isFillableInput);
    var best = null;
    for (var i = 0; i < inputs.length; i++) {
      var el = inputs[i];
      var hay = norm(
        (el.getAttribute("name") || "") + "|" +
        (el.id || "") + "|" +
        (el.getAttribute("placeholder") || "") + "|" +
        (el.getAttribute("autocomplete") || "") + "|" +
        (el.getAttribute("aria-label") || "") + "|" +
        nearbyLabelText(el)
      );
      for (var k = 0; k < keywords.length; k++) {
        if (hay.indexOf(norm(keywords[k])) !== -1) { best = el; break; }
      }
      if (best) break;
    }
    return best;
  }

  function isFillableInput(el) {
    if (!el) return false;
    var tag = (el.tagName || "").toUpperCase();
    if (tag === "INPUT") {
      var type = (el.type || "text").toLowerCase();
      if (["hidden", "submit", "button", "image", "reset", "file", "checkbox", "radio", "password"].indexOf(type) !== -1) {
        return false;
      }
    } else if (tag !== "TEXTAREA" && tag !== "SELECT") {
      return false;
    }
    if (el.disabled || el.readOnly) return false;
    // 不可見的（display:none 等）略過。
    try {
      var rect = el.getBoundingClientRect();
      if (rect.width === 0 && rect.height === 0 && el.offsetParent === null) return false;
    } catch (e) { /* 忽略 */ }
    return true;
  }

  function nearbyLabelText(el) {
    try {
      // <label for=id>
      if (el.id) {
        var lbl = document.querySelector('label[for="' + cssEscape(el.id) + '"]');
        if (lbl) return lbl.textContent || "";
      }
      // 包覆型 <label><input></label>
      var p = el.closest ? el.closest("label") : null;
      if (p) return p.textContent || "";
      // 前一個兄弟節點的文字（粗略）
      var prev = el.previousElementSibling;
      if (prev && prev.textContent) return prev.textContent;
    } catch (e) { /* 忽略 */ }
    return "";
  }
  function cssEscape(s) {
    if (window.CSS && CSS.escape) return CSS.escape(s);
    return String(s).replace(/["\\\]\[\.\#\:]/g, "\\$&");
  }

  // 設值 + 派發 input/change（涵蓋 React/Vue 受控元件常見需求）。
  function setInputValue(el, value) {
    try {
      var tag = (el.tagName || "").toUpperCase();
      if (tag === "SELECT") {
        // 嘗試以文字或 value 對應 option。
        var opts = Array.prototype.slice.call(el.options || []);
        var hit = opts.filter(function (o) {
          return o.value === value || (o.textContent || "").trim() === String(value).trim();
        })[0];
        if (!hit) return false;
        el.value = hit.value;
      } else {
        // React 受控元件：用原生 setter 寫值再派發事件。
        var proto = tag === "TEXTAREA" ? window.HTMLTextAreaElement.prototype : window.HTMLInputElement.prototype;
        var setter = Object.getOwnPropertyDescriptor(proto, "value");
        if (setter && setter.set) setter.set.call(el, value);
        else el.value = value;
      }
      el.dispatchEvent(new Event("input", { bubbles: true }));
      el.dispatchEvent(new Event("change", { bubbles: true }));
      return true;
    } catch (e) {
      warn("設值失敗：", e);
      return false;
    }
  }

  // 取得 profile 清單；回傳 { locked:bool, profiles:[{id,label}] } 或 null。
  function listProfiles() {
    return send({ type: TT.MSG.LIST_PROFILES }).then(function (resp) {
      if (!resp) return { locked: true, profiles: [] }; // 背景未實作/未解鎖 → 視為鎖定
      if (resp.locked || resp.lockState === TT.LOCK.LOCKED || resp.error === "VAULT_LOCKED" || resp.code === "VAULT_LOCKED") {
        return { locked: true, profiles: [] };
      }
      var profiles = resp.profiles || resp.data || resp.list || [];
      return { locked: false, profiles: Array.isArray(profiles) ? profiles : [] };
    });
  }
  function getProfileFields(id) {
    return send({ type: TT.MSG.GET_PROFILE_FIELDS, id: id }).then(function (resp) {
      if (!resp) return null;
      if (resp.locked || resp.error === "VAULT_LOCKED") return null;
      return resp.fields || resp.data || resp;
    });
  }

  // 主流程：profileId 指定則直接填；否則視 profile 數量決定（多筆 → 彈出選擇器）。
  function runAutofill(profileId) {
    listProfiles().then(function (res) {
      if (res.locked) {
        toast("請先解鎖（從工具列彈窗）");
        return;
      }
      var profiles = res.profiles;
      if (!profiles.length) {
        toast("尚無個資資料，請先於彈窗新增");
        return;
      }
      if (profileId) {
        fillWithProfile(profileId);
        return;
      }
      if (profiles.length === 1) {
        fillWithProfile(profiles[0].id);
        return;
      }
      // 多筆且未指定 → 小型選擇器
      showProfileChooser(profiles);
    });
  }

  function fillWithProfile(id) {
    getProfileFields(id).then(function (fields) {
      if (!fields) {
        toast("取得資料失敗，請確認已解鎖");
        return;
      }
      var total = 0;
      var filled = 0;
      Object.keys(fields).forEach(function (fieldKey) {
        if (fieldKey === "label" || fieldKey === "id") return; // label 非表單欄位
        var value = fields[fieldKey];
        if (value == null || value === "") return;
        total++;

        // BR-6：中文姓名 ≤ 7 字（超過則截斷並標記）。
        var flagged = false;
        if (fieldKey === "nameZh" && String(value).length > 7) {
          value = String(value).slice(0, 7);
          flagged = true;
        }

        var input = findInputForField(fieldKey);
        if (!input) {
          // 無對應輸入 → 跳過並標記（不視為已填）。
          return;
        }
        var ok = setInputValue(input, value);
        if (ok) {
          filled++;
          markField(input, flagged ? "tt-fill-flag" : "tt-fill-ok");
        } else {
          markField(input, "tt-fill-flag");
        }
      });
      toast("已填 " + filled + " / " + total);
    });
  }

  function markField(el, cls) {
    try {
      el.classList.add(cls);
      setTimeout(function () { el.classList.remove(cls); }, 2500);
    } catch (e) { /* 忽略 */ }
  }

  // ── 小型 profile 選擇器（注入工具列內）──
  function showProfileChooser(profiles) {
    try {
      var old = document.getElementById("tt-chooser");
      if (old && old.parentNode) old.parentNode.removeChild(old);

      var box = document.createElement("div");
      box.id = "tt-chooser";
      box.className = "tt-chooser";
      var html = '<div class="tt-chooser-title">選擇要填入的個資</div>';
      profiles.forEach(function (p) {
        html += '<button class="tt-chooser-item" type="button" data-id="' +
          String(p.id).replace(/"/g, "&quot;") + '">' +
          (p.label || p.nameZh || p.id) + "</button>";
      });
      html += '<button class="tt-chooser-cancel" type="button">取消</button>';
      box.innerHTML = html;
      (ui.body || document.body).appendChild(box);

      box.addEventListener("click", guard("選擇個資", function (e) {
        var btn = e.target.closest ? e.target.closest("button") : null;
        if (!btn) return;
        if (btn.classList.contains("tt-chooser-cancel")) {
          if (box.parentNode) box.parentNode.removeChild(box);
          return;
        }
        var id = btn.getAttribute("data-id");
        if (id) {
          if (box.parentNode) box.parentNode.removeChild(box);
          fillWithProfile(id);
        }
      }));
    } catch (e) {
      warn("顯示個資選擇器失敗：", e);
    }
  }

  // ── 快速篩選輸入（極簡 prompt 介面）──
  function promptFilter() {
    try {
      // 切換 filterEnabled 並要求輸入 include 字串（保留既有 exclude/hideSoldOut）。
      var nextEnabled = !state.settings.filterEnabled;
      if (nextEnabled) {
        var input = window.prompt(
          "輸入篩選關鍵字（含；用 , 表 AND、+ 表 OR）。\n例：4500,搖滾+3200",
          state.filters.includeStr || ""
        );
        if (input === null) return; // 取消
        state.filters.includeStr = input;
      }
      state.settings.filterEnabled = nextEnabled;
      // 寫回 storage（讓設定持久；background 若有 SAVE_FILTERS 也送一份）。
      persistFilters();
      var r = applyFilter();
      updateFilterCount(r);
      toast(nextEnabled ? "篩選已開啟" : "篩選已關閉");
    } catch (e) {
      warn("篩選輸入失敗：", e);
    }
  }
  function persistFilters() {
    try {
      var payload = {
        includeStr: state.filters.includeStr,
        excludeStr: state.filters.excludeStr,
        hideSoldOut: state.filters.hideSoldOut
      };
      var s = {};
      s[TT.KEYS.FILTERS] = payload;
      chrome.storage.local.set(s);
      send({ type: TT.MSG.SAVE_FILTERS, filters: payload });
      // 同步 filterEnabled 至 settings。
      var ss = {};
      ss[TT.KEYS.SETTINGS] = state.settings;
      chrome.storage.local.set(ss);
    } catch (e) { /* 忽略 */ }
  }

  // ── Toast（短暫提示）──
  var toastTimer = null;
  function toast(msg) {
    try {
      var t = document.getElementById("tt-toast");
      if (!t) {
        t = document.createElement("div");
        t.id = "tt-toast";
        t.className = "tt-toast";
        document.body.appendChild(t);
      }
      t.textContent = msg;
      t.classList.add("tt-toast-show");
      if (toastTimer) clearTimeout(toastTimer);
      toastTimer = setTimeout(function () {
        t.classList.remove("tt-toast-show");
      }, 2600);
    } catch (e) {
      warn("toast 失敗：", e);
    }
  }

  // ─────────────────────────────────────────────────────────────
  // 11) 重套：storage 變更 + DOM 變動（debounce）以撐住 SPA 重繪
  // ─────────────────────────────────────────────────────────────
  function watchStorage() {
    try {
      chrome.storage.onChanged.addListener(guard("storage 變更", function (changes, area) {
        if (area !== "local") return;
        var touched = false;
        if (changes[TT.KEYS.SETTINGS]) {
          state.settings = Object.assign({}, TT.DEFAULTS, changes[TT.KEYS.SETTINGS].newValue || {});
          state.soundOn = state.settings.notifySound !== false;
          syncSoundBtn();
          // 開關可能影響刷新/監控/倒數 → 重啟相關計時器。
          startAutoRefresh();
          startMonitor();
          if (ui.clockBlock) ui.clockBlock.style.display = state.settings.countdownEnabled === false ? "none" : "";
          touched = true;
        }
        if (changes[TT.KEYS.FILTERS]) {
          state.filters = Object.assign(
            { includeStr: "", excludeStr: "", hideSoldOut: false },
            changes[TT.KEYS.FILTERS].newValue || {}
          );
          touched = true;
        }
        if (changes[TT.KEYS.MONITOR]) {
          state.monitor = changes[TT.KEYS.MONITOR].newValue || null;
        }
        // 注意：每站開關 SITE_OFF 由 watchSiteToggle() 獨立常駐處理（在 activate 之前就需生效），不在此處理。
        if (touched) applyEnhancements();
      }));
    } catch (e) {
      warn("註冊 storage 監聽失敗：", e);
    }
  }

  var moTimer = null;
  function watchDom() {
    try {
      var mo = new MutationObserver(function () {
        if (moTimer) clearTimeout(moTimer);
        moTimer = setTimeout(guard("DOM 重套", function () {
          applyEnhancements();
        }), 250);
      });
      mo.observe(document.documentElement || document.body, {
        childList: true,
        subtree: true
      });
    } catch (e) {
      warn("註冊 MutationObserver 失敗：", e);
    }
  }

  // ── 監聽 popup 來的 AUTOFILL_NOW ──
  function watchRuntimeMessages() {
    try {
      chrome.runtime.onMessage.addListener(guard("runtime 訊息", function (msg, sender, sendResponse) {
        if (msg && msg.type === "AUTOFILL_NOW") {
          runAutofill(msg.profileId || null);
          if (sendResponse) sendResponse({ ok: true });
        }
        // 保險箱鎖定狀態改變（背景廣播）→ 重新查詢並更新狀態總覽。
        if (msg && msg.type === TT.MSG.LOCK_STATE_CHANGED) {
          if (msg.lockState) state.status.lockState = msg.lockState;
          refreshLockStatus();
        }
        return false;
      }));
    } catch (e) {
      warn("註冊 runtime 訊息監聽失敗：", e);
    }
  }

  // ─────────────────────────────────────────────────────────────
  // 啟動序列
  // ─────────────────────────────────────────────────────────────
  // 此頁是否就在這個 frame 的最上層（非被嵌入的 iframe）。
  var IS_TOP = (function () {
    try { return window.top === window.self; } catch (e) { return false; }
  })();

  // 此頁是否該介入：adapter 未設 activateOnUrl → 一律介入（維持 tixCraft/Weverse 既有行為）；
  // 有設（如 NOL：只在 /products/ 與購票流程頁）→ 僅符合時介入，避免在綜合站首頁清版面、與 React 重繪打架閃爍。
  function isActivePage() {
    try {
      if (!adapter.activateOnUrl) return true;
      return adapter.activateOnUrl.test(location.href);
    } catch (e) { return true; }
  }

  // 綜合閘門：每站開關啟用（state.siteEnabled） ∧ 此頁為票務頁（isActivePage）。
  function shouldEnhance() { return state.siteEnabled !== false && isActivePage(); }

  var activated = false;
  // 最上層完整啟動（工具列 / 校時 / 監控 / 自動刷新 / 一鍵填入 / 觀察器）。
  function activate() {
    if (activated) return;
    activated = true;
    openPort(); // (2)
    // (3) 讀設定 / 篩選 / 監控 → 然後套用與啟動。
    Promise.all([loadSettings(), loadFilters(), loadMonitor()])
      .then(guard("啟動", function () {
        buildToolbar();        // (7)
        applyEnhancements();   // (4)(5)(6)
        refreshLockStatus();   // 查保險箱鎖定狀態 → 狀態總覽
        if (state.settings.countdownEnabled !== false) {
          syncServerTime();    // (7a 校時)
        }
        startClock();          // 時鐘恆開（倒數區塊顯示與否由 settings 決定）
        startAutoRefresh();    // (8)
        startMonitor();        // (9)
        watchStorage();        // (11)
        watchDom();            // (11)
        watchRuntimeMessages();// (10 來自 popup)
      }))
      .catch(function (e) {
        warn("啟動流程例外，已略過：", e);
      });
  }

  // 每站開關常駐監聽（最上層）：popup 寫入 tt_site_off 後即時生效，且在 activate 之前就需運作
  //（站台一開始停用時，watchStorage 尚未註冊，仍要聽得到「使用者開啟」）。
  function watchSiteToggle() {
    try {
      chrome.storage.onChanged.addListener(guard("站台開關變更", function (changes, area) {
        if (area !== "local" || !changes[TT.KEYS.SITE_OFF]) return;
        var map = changes[TT.KEYS.SITE_OFF].newValue || {};
        state.siteEnabled = !map[adapter.siteKey];
        if (!state.siteEnabled) {
          applyEnhancements();  // 收起工具列 + 還原版面
          stopAutoRefresh();
          stopMonitor();
        } else if (!activated) {
          // 此站之前停用、從未掛載：僅在票務頁才掛載；非票務頁（如首頁）交給 watchForActivation 等待，
          // 避免在 NOL 首頁等非票務頁啟動工具列又造成閃爍。
          if (isActivePage()) activate();
        } else {
          applyEnhancements();  // 已掛載 → 重新顯示並套用（applyEnhancements 內部仍以 shouldEnhance 把關）
          startAutoRefresh();
          startMonitor();
        }
      }));
    } catch (e) {
      warn("註冊站台開關監聽失敗：", e);
    }
  }

  // 首頁/停用站台等：先不介入，輪詢等「站台啟用 ∧ 導航到票務頁」再啟動（NOL 是單頁式 App）。
  function watchForActivation() {
    var timer = setInterval(guard("等待票務頁", function () {
      if (shouldEnhance()) {
        clearInterval(timer);
        activate();
      }
    }), 800);
  }

  // 子 frame（如選位 iframe）：只做對自身 DOM 有意義的「清版面/放大/篩選」，
  // 不建工具列、不開 port、不校時、不自動刷新、不監控（避免重複注入與刷掉選位狀態）。
  function bootFrame() {
    loadSiteEnabled().then(function () {
      if (!shouldEnhance()) return; // 站台停用 / 子框 URL 非票務流程（如廣告 iframe）→ 不介入
      return Promise.all([loadSettings(), loadFilters()])
        .then(guard("子框啟動", function () {
          applyEnhancements();    // 清版面 / 放大 / 篩選（updateStatusUI 因無工具列自動 no-op）
          watchDom();             // iframe 內容動態 → 重套
          watchRuntimeMessages(); // 允許 popup 的一鍵填入填進 iframe 內表單
        }));
    }).catch(function (e) { warn("子框啟動例外，已略過：", e); });
  }

  function boot() {
    if (!IS_TOP) { bootFrame(); return; } // 子 frame 走精簡流程
    watchSiteToggle(); // 常駐：popup 切換每站開關即時生效（不論目前是否已掛載）
    loadSiteEnabled().then(function () {
      if (shouldEnhance()) activate();
      else watchForActivation(); // 站台停用或非票務頁 → 等條件成立再掛載
    });
  }

  // body 可能尚未就緒（run_at document_idle 通常已就緒，仍防呆）。
  if (document.body) {
    boot();
  } else {
    document.addEventListener("DOMContentLoaded", guard("DOMContentLoaded", boot), { once: true });
  }
})();
