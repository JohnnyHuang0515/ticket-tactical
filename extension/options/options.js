// 設定頁邏輯（options）— 單欄精簡版：只管「主密碼」與「實名個資」。
// 功能開關與票券篩選改在 popup。所有 vault 操作經由背景 service worker（chrome.runtime.sendMessage）。
// 對應 lib/messages.js 的 TT.MSG / TT.LOCK / TT.PROFILE_FIELDS。
(function () {
  "use strict";

  const MSG = TT.MSG;
  const LOCK = TT.LOCK;
  const FIELDS = TT.PROFILE_FIELDS;

  const $ = (sel, root) => (root || document).querySelector(sel);
  const $$ = (sel, root) => Array.from((root || document).querySelectorAll(sel));

  const state = { lockState: null, profiles: [] };

  // ── 通訊：Promise 化 sendMessage，統一處理 lastError ─────────────
  function send(message) {
    return new Promise((resolve) => {
      try {
        chrome.runtime.sendMessage(message, (res) => {
          const err = chrome.runtime.lastError;
          if (err) { resolve({ ok: false, code: "NO_BACKGROUND", message: err.message }); return; }
          resolve(res || { ok: false, code: "NO_RESPONSE" });
        });
      } catch (e) {
        resolve({ ok: false, code: "SEND_FAILED", message: String(e) });
      }
    });
  }

  // VAULT_LOCKED：導回上方主密碼區解鎖。回傳 true 代表已攔截處理。
  function handleLocked(res) {
    if (res && res.code === "VAULT_LOCKED") {
      toast("個資庫已鎖定，請先於上方解鎖", true);
      refreshLockState().then(renderAll);
      return true;
    }
    return false;
  }

  // ── toast ─────────────────────────────────────────────────────
  let toastTimer = null;
  function toast(text, isError) {
    const el = $("#toast");
    el.textContent = text;
    el.classList.toggle("is-error", !!isError);
    el.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => (el.hidden = true), 2600);
  }

  // ── 鎖定狀態 ───────────────────────────────────────────────────
  async function refreshLockState() {
    const res = await send({ type: MSG.GET_LOCK_STATE });
    state.lockState = (res && res.lockState) || LOCK.UNINITIALIZED;
    reflectLockState();
    return state.lockState;
  }

  function reflectLockState() {
    const ls = state.lockState;
    const badge = $("[data-lockstate-badge]");
    let text = ls || "—";
    let tone = "caution";
    if (ls === LOCK.UNLOCKED) tone = "live";
    else if (ls === LOCK.LOCKED) tone = "alert";
    else text = "未設定";
    if (badge) { badge.textContent = text; badge.dataset.tone = tone; }
  }

  function renderAll() {
    renderMaster();
    renderIdentity();
  }

  // ════════════════════════════════════════════════════════════════
  // 主密碼 / VAULT
  // ════════════════════════════════════════════════════════════════
  function renderMaster() {
    const setForm = $("#masterSetForm");
    const unlockForm = $("#masterUnlockForm");
    const unlockedView = $("#masterUnlockedView");

    setForm.hidden = state.lockState !== LOCK.UNINITIALIZED;
    unlockForm.hidden = state.lockState !== LOCK.LOCKED;
    unlockedView.hidden = state.lockState !== LOCK.UNLOCKED;

    if (!setForm.hidden) { $("#setPwd1").value = ""; $("#setPwd2").value = ""; $("#setErr").hidden = true; }
    if (!unlockForm.hidden) { $("#unlockPwd").value = ""; $("#unlockErr").hidden = true; }
  }

  async function submitSetMaster(e) {
    e.preventDefault();
    const p1 = $("#setPwd1").value;
    const p2 = $("#setPwd2").value;
    const errEl = $("#setErr");
    errEl.hidden = true;

    if (p1.length < 8) { errEl.textContent = "主密碼至少需 8 碼。"; errEl.hidden = false; $("#setPwd1").focus(); return; }
    if (p1 !== p2) { errEl.textContent = "兩次輸入不一致。"; errEl.hidden = false; $("#setPwd2").focus(); return; }

    const res = await send({ type: MSG.SET_MASTER_PASSWORD, password: p1 });
    if (!res.ok) {
      errEl.textContent = res.code === "WEAK_PASSWORD" ? "主密碼至少需 8 碼。" : "建立失敗，請重試。";
      errEl.hidden = false;
      return;
    }
    state.lockState = res.lockState || LOCK.UNLOCKED;
    reflectLockState();
    toast("主密碼已建立並解鎖");
    renderAll();
  }

  async function submitUnlock(e, pwdSel, errSel) {
    e.preventDefault();
    const input = $(pwdSel);
    const errEl = $(errSel);
    errEl.hidden = true;
    const password = input.value;
    if (!password) { errEl.textContent = "請輸入主密碼。"; errEl.hidden = false; return; }

    const res = await send({ type: MSG.UNLOCK_VAULT, password });
    if (!res.ok) {
      if (res.code === "VAULT_UNINITIALIZED") { toast("尚未設定主密碼", true); await refreshLockState(); renderAll(); return; }
      errEl.textContent = res.code === "MASTER_PASSWORD_WRONG" ? "主密碼錯誤。" : "解鎖失敗，請重試。";
      errEl.hidden = false;
      input.select();
      return;
    }
    input.value = "";
    state.lockState = res.lockState || LOCK.UNLOCKED;
    reflectLockState();
    toast("已解鎖");
    renderAll();
  }

  async function lockNow() {
    const res = await send({ type: MSG.LOCK_VAULT });
    state.lockState = (res && res.lockState) || LOCK.LOCKED;
    reflectLockState();
    toast("已上鎖");
    renderAll();
  }

  function confirmResetVault() {
    openConfirm({
      kicker: "RESET VAULT",
      title: "重設主密碼",
      text: "這會清空所有已儲存的實名個資，且無法復原。請輸入「重設」以確認。",
      okText: "清空並重設",
      typeToConfirm: { label: "輸入「重設」", value: "重設" },
      onOk: async () => {
        const res = await send({ type: MSG.RESET_VAULT, confirm: true });
        if (!res.ok) { toast("重設失敗", true); return; }
        state.lockState = res.lockState || LOCK.UNINITIALIZED;
        state.profiles = [];
        reflectLockState();
        toast("已重設，所有個資已清空");
        renderAll();
      }
    });
  }

  // ════════════════════════════════════════════════════════════════
  // 實名個資 / IDENTITY
  // ════════════════════════════════════════════════════════════════
  function renderIdentity() {
    const gateNote = $("#identityGateNote");
    const unlocked = $("#identityUnlocked");
    const addBtn = $("#addProfileBtn");

    if (state.lockState === LOCK.UNLOCKED) {
      gateNote.hidden = true;
      unlocked.hidden = false;
      addBtn.hidden = false;
      loadProfiles();
    } else {
      gateNote.hidden = false;
      unlocked.hidden = true;
      addBtn.hidden = true;
    }
  }

  async function loadProfiles() {
    const res = await send({ type: MSG.LIST_PROFILES });
    if (!res.ok) {
      if (handleLocked(res)) return;
      toast("讀取個資失敗", true);
      return;
    }
    state.profiles = res.profiles || [];
    renderProfileRows();
  }

  function renderProfileRows() {
    const wrap = $("#profileRows");
    const empty = $("#profileEmpty");
    wrap.innerHTML = "";

    if (!state.profiles.length) { empty.hidden = false; return; }
    empty.hidden = true;

    state.profiles.forEach((p) => {
      const row = document.createElement("div");
      row.className = "profile-row";

      const avatar = document.createElement("div");
      avatar.className = "avatar";
      avatar.textContent = (p.label || "?").trim().charAt(0).toUpperCase() || "?";

      const info = document.createElement("div");
      info.className = "profile-info";

      const labelLine = document.createElement("div");
      labelLine.className = "profile-label";
      const labelText = document.createElement("span");
      labelText.textContent = p.label || "(未命名)";
      labelLine.appendChild(labelText);
      if (p.isDefault) {
        const tag = document.createElement("span");
        tag.className = "tag-default";
        tag.textContent = "預設";
        labelLine.appendChild(tag);
      }

      const hint = document.createElement("div");
      hint.className = "profile-hint";
      hint.textContent = "證件 / 手機等敏感欄位已加密 · 點編輯檢視";

      info.appendChild(labelLine);
      info.appendChild(hint);

      const actions = document.createElement("div");
      actions.className = "profile-actions";

      const editBtn = document.createElement("button");
      editBtn.type = "button";
      editBtn.className = "btn btn-sm btn-ghost";
      editBtn.textContent = "編輯";
      editBtn.addEventListener("click", () => openProfileModal(p.id));

      const delBtn = document.createElement("button");
      delBtn.type = "button";
      delBtn.className = "btn btn-sm btn-ghost is-danger";
      delBtn.textContent = "刪除";
      delBtn.addEventListener("click", () => confirmDeleteProfile(p));

      actions.appendChild(editBtn);
      actions.appendChild(delBtn);

      row.appendChild(avatar);
      row.appendChild(info);
      row.appendChild(actions);
      wrap.appendChild(row);
    });
  }

  // ── 個資 modal（依 TT.PROFILE_FIELDS 動態生成）──────────────────
  let editingId = null;

  function buildProfileFields() {
    const grid = $("#profileFields");
    grid.innerHTML = "";
    FIELDS.forEach((f) => {
      const field = document.createElement("div");
      field.className = "field";
      if (f.key === "label" || f.key === "address") field.classList.add("full");

      const label = document.createElement("label");
      label.className = "field-label tt-mono";
      label.setAttribute("for", "pf-" + f.key);
      label.textContent = f.label;
      if (f.required) {
        const req = document.createElement("span");
        req.className = "field-req";
        req.textContent = "*";
        label.appendChild(req);
      }
      if (f.sensitive) {
        const s = document.createElement("span");
        s.className = "field-sensitive";
        s.textContent = "敏感";
        label.appendChild(s);
      }

      const input = document.createElement("input");
      input.className = "input";
      input.id = "pf-" + f.key;
      input.type = f.key === "email" ? "email" : "text";
      input.dataset.key = f.key;
      input.autocomplete = "off";
      if (typeof f.max === "number") {
        input.maxLength = f.max;
        input.placeholder = "最多 " + f.max + " 字";
      }

      const hint = document.createElement("div");
      hint.className = "field-hint";
      if (typeof f.max === "number") hint.textContent = "上限 " + f.max + " 字";
      else if (f.sensitive) hint.textContent = "加密保存，僅自動填入時於本機解密";

      field.appendChild(label);
      field.appendChild(input);
      if (hint.textContent) field.appendChild(hint);
      grid.appendChild(field);
    });
  }

  async function openProfileModal(id) {
    editingId = id || null;
    buildProfileFields();
    $("#profileErr").hidden = true;
    setToggle($("#profileDefault"), false);
    $("#profileModalTitle").textContent = id ? "編輯個資" : "新增個資";

    if (id) {
      const res = await send({ type: MSG.GET_PROFILE_FIELDS, id });
      if (!res.ok) {
        if (handleLocked(res)) return;
        toast("讀取此筆個資失敗", true);
        return;
      }
      const f = res.fields || {};
      FIELDS.forEach((def) => {
        const input = $('#pf-' + def.key);
        if (input && f[def.key] != null) input.value = f[def.key];
      });
      setToggle($("#profileDefault"), !!f.isDefault);
    }

    openModal("#profileModal");
    const first = $("#pf-label");
    if (first) first.focus();
  }

  async function submitProfile(e) {
    e.preventDefault();
    const errEl = $("#profileErr");
    errEl.hidden = true;

    const profile = {};
    let invalid = null;
    FIELDS.forEach((def) => {
      const input = $('#pf-' + def.key);
      if (!input) return;
      input.classList.remove("is-invalid");
      const val = input.value.trim();
      if (def.required && !val) { if (!invalid) invalid = { input, msg: def.label + "為必填" }; }
      if (typeof def.max === "number" && val.length > def.max) {
        if (!invalid) invalid = { input, msg: def.label + "最多 " + def.max + " 字" };
      }
      if (val) profile[def.key] = val;
    });

    if (invalid) {
      invalid.input.classList.add("is-invalid");
      errEl.textContent = invalid.msg;
      errEl.hidden = false;
      invalid.input.focus();
      return;
    }

    profile.isDefault = getToggle($("#profileDefault"));
    if (editingId) profile.id = editingId;

    const res = await send({ type: MSG.SAVE_PROFILE, profile });
    if (!res.ok) {
      if (handleLocked(res)) { closeModal("#profileModal"); return; }
      errEl.textContent = "儲存失敗（" + (res.code || "未知") + "）";
      errEl.hidden = false;
      return;
    }
    closeModal("#profileModal");
    toast(editingId ? "個資已更新" : "個資已新增");
    editingId = null;
    await loadProfiles();
  }

  function confirmDeleteProfile(p) {
    openConfirm({
      kicker: "DELETE PROFILE",
      title: "刪除個資",
      text: '確定刪除「' + (p.label || "此筆") + '」？此操作無法復原。',
      okText: "刪除",
      onOk: async () => {
        const res = await send({ type: MSG.DELETE_PROFILE, id: p.id, confirm: true });
        if (!res.ok) {
          if (handleLocked(res)) return;
          toast("刪除失敗", true);
          return;
        }
        toast("已刪除");
        await loadProfiles();
      }
    });
  }

  // ════════════════════════════════════════════════════════════════
  // 共用：toggle / modal / confirm
  // ════════════════════════════════════════════════════════════════
  function setToggle(tgl, on) {
    if (!tgl) return;
    tgl.classList.toggle("on", !!on);
    tgl.setAttribute("aria-checked", on ? "true" : "false");
  }
  function getToggle(tgl) { return !!(tgl && tgl.classList.contains("on")); }

  function bindStaticToggle(sel) {
    const tgl = $(sel);
    if (!tgl) return;
    const flip = () => setToggle(tgl, !tgl.classList.contains("on"));
    tgl.addEventListener("click", flip);
    tgl.addEventListener("keydown", (e) => {
      if (e.key === " " || e.key === "Enter") { e.preventDefault(); flip(); }
    });
  }

  function openModal(sel) { $(sel).hidden = false; }
  function closeModal(sel) { $(sel).hidden = true; }

  let confirmCb = null;
  function openConfirm(opts) {
    confirmCb = opts.onOk || null;
    $("#confirmKicker").textContent = opts.kicker || "CONFIRM";
    $("#confirmTitle").textContent = opts.title || "確認";
    $("#confirmText").textContent = opts.text || "";
    $("#confirmOkBtn").textContent = opts.okText || "確認";

    const wrap = $("#confirmTypeWrap");
    const input = $("#confirmTypeInput");
    const okBtn = $("#confirmOkBtn");
    input.value = "";

    if (opts.typeToConfirm) {
      wrap.hidden = false;
      $("#confirmTypeLabel").textContent = opts.typeToConfirm.label;
      okBtn.disabled = true;
      input.oninput = () => { okBtn.disabled = input.value.trim() !== opts.typeToConfirm.value; };
    } else {
      wrap.hidden = true;
      okBtn.disabled = false;
      input.oninput = null;
    }
    openModal("#confirmModal");
  }
  function closeConfirm() { confirmCb = null; closeModal("#confirmModal"); }

  // ── LOCK_STATE_CHANGED 廣播：背景自動上鎖時即時更新 UI ────────────
  chrome.runtime.onMessage.addListener((msg) => {
    if (msg && msg.type === MSG.LOCK_STATE_CHANGED) {
      state.lockState = msg.lockState;
      reflectLockState();
      renderAll();
    }
  });

  // ── 綁定事件 ──────────────────────────────────────────────────
  function bindEvents() {
    // 個資
    $("#addProfileBtn").addEventListener("click", () => openProfileModal(null));
    $("#profileForm").addEventListener("submit", submitProfile);
    bindStaticToggle("#profileDefault");

    // 主密碼
    $("#masterSetForm").addEventListener("submit", submitSetMaster);
    $("#masterUnlockForm").addEventListener("submit", (e) => submitUnlock(e, "#unlockPwd", "#unlockErr"));
    $("#lockNowBtn").addEventListener("click", lockNow);
    $("#resetVaultBtn").addEventListener("click", confirmResetVault);

    // modal 關閉
    $$("[data-close-modal]").forEach((b) => b.addEventListener("click", () => closeModal("#profileModal")));
    $$("[data-close-confirm]").forEach((b) => b.addEventListener("click", closeConfirm));
    $("#confirmOkBtn").addEventListener("click", () => {
      const cb = confirmCb;
      closeConfirm();
      if (cb) cb();
    });

    // Esc 關閉 modal
    document.addEventListener("keydown", (e) => {
      if (e.key === "Escape") {
        if (!$("#profileModal").hidden) closeModal("#profileModal");
        if (!$("#confirmModal").hidden) closeConfirm();
      }
    });
  }

  // ── 啟動 ──────────────────────────────────────────────────────
  async function init() {
    bindEvents();
    await refreshLockState();
    renderAll();
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
})();
