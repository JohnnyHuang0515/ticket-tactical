// 票區/座位篩選邏輯（對應規格 FR-13 關鍵字篩選 / FR-14 黑名單與隱藏售完）。
// 借鏡「搶票柴柴」已驗證的做法：關鍵字包含、黑名單排除、AND/OR 語法、數字正規化。
// 由 content script 載入；以 globalThis.TTFilter 命名空間共用。
//
// 純模組：不碰 chrome.* / 不發網路請求；只允許操作傳入 Element 的 classList。
(function (g) {
  "use strict";

  // 全形數字 → 半形（ASCII）對照。
  var FULLWIDTH_DIGITS = { "０": "0", "１": "1", "２": "2", "３": "3", "４": "4", "５": "5", "６": "6", "７": "7", "８": "8", "９": "9" };

  // 中文數字 → 阿拉伯。盡量簡單穩健，不過度設計：
  // 只處理常見的零~十、以及「十X / X十 / X十Y」這類兩位數寫法（如「十二」=12、「二十」=20、「二十五」=25）。
  // 更複雜的（百/千/萬、序數等）不在此處理，原樣保留。
  var CN_DIGITS = { "零": 0, "一": 1, "二": 2, "三": 3, "四": 4, "五": 5, "六": 6, "七": 7, "八": 8, "九": 9 };

  // 將整段字串中的中文數字片段轉成阿拉伯數字。
  // 採「逐段掃描連續中文數字字元」的做法，避免破壞夾雜的非數字文字。
  function convertChineseNumerals(s) {
    // 連續的中文數字字元（含「十」）視為一個片段一起轉換。
    return s.replace(/[零一二三四五六七八九十]+/g, function (seg) {
      return chineseSegToArabic(seg);
    });
  }

  // 把一段純中文數字（如「十」「十二」「二十」「二十五」「三」）轉成阿拉伯字串。
  // 無法乾淨對應的就原樣回傳，保持穩健。
  function chineseSegToArabic(seg) {
    var idx = seg.indexOf("十");
    if (idx === -1) {
      // 沒有「十」：逐字拼接（如「二五」→「25」、「三」→「3」、「零」→「0」）。
      var out = "";
      for (var i = 0; i < seg.length; i++) {
        var d = CN_DIGITS[seg[i]];
        if (d === undefined) return seg; // 不可解析，原樣返回
        out += String(d);
      }
      return out;
    }
    // 含「十」：拆成十位／個位（如「十二」=12、「二十」=20、「二十五」=25、「十」=10）。
    var before = seg.slice(0, idx);
    var after = seg.slice(idx + 1);
    var tens = before === "" ? 1 : CN_DIGITS[before];
    if (tens === undefined) return seg;
    if (after === "") return String(tens * 10);
    var ones = CN_DIGITS[after];
    if (after.length !== 1 || ones === undefined) return seg; // 個位超過一字無法簡單解析
    return String(tens * 10 + ones);
  }

  // 數字正規化：轉小寫、去逗號/空白/全形空白、全形數字→ASCII、中文數字→阿拉伯，
  // 非數字文字原樣保留。讓「NT$ 2,800」內含「2800」、讓「2,800」能對上「2800」。
  // 例：normalizeNumber("NT$ 2,800") → "nt$2800"
  function normalizeNumber(s) {
    var str = String(s == null ? "" : s);
    // 1) 去除逗號、半形空白、全形空白（　）等。
    str = str.replace(/[,\s　]/g, "");
    // 2) 全形數字 → 半形。
    str = str.replace(/[０-９]/g, function (ch) { return FULLWIDTH_DIGITS[ch]; });
    // 3) 中文數字 → 阿拉伯（盡量）。
    str = convertChineseNumerals(str);
    // 4) 轉小寫。
    return str.toLowerCase();
  }

  // 解析篩選輸入為「OR 群組 × AND 詞」。
  // 以 + 分隔 OR、各段再以 , 分隔 AND；每個詞 trim、去空、套用 normalizeNumber。
  // 空字串／純空白 → []（代表「無限制」）。
  // 例：parse("4500,搖滾+3200") → [["4500","搖滾"],["3200"]]
  // 例：parse("2,800")          → [["2800"]]
  // 例：parse("   ")            → []
  function parse(input) {
    var raw = String(input == null ? "" : input);
    if (raw.trim() === "") return [];
    // 先把「數字間的逗號」（千分位，如 2,800）去掉，避免被當成 AND 分隔符而拆成兩個詞；
    // 其餘逗號維持 AND 語意（如「4500,搖滾」）。
    raw = raw.replace(/(\d)\s*,\s*(\d)/g, "$1$2");
    var groups = [];
    var orChunks = raw.split("+");
    for (var i = 0; i < orChunks.length; i++) {
      var andTerms = orChunks[i].split(",");
      var group = [];
      for (var j = 0; j < andTerms.length; j++) {
        var term = andTerms[j].trim();
        if (term === "") continue;
        group.push(normalizeNumber(term));
      }
      if (group.length) groups.push(group);
    }
    return groups;
  }

  // 比對：text 應為「已正規化」的字串。
  // groups 為空 → 視為通過（無限制）；否則任一群組的「每個詞」都是 text 的子字串即通過。
  function matches(text, groups) {
    if (!groups || groups.length === 0) return true;
    var t = String(text == null ? "" : text);
    for (var i = 0; i < groups.length; i++) {
      var group = groups[i];
      var all = true;
      for (var j = 0; j < group.length; j++) {
        if (t.indexOf(group[j]) === -1) { all = false; break; }
      }
      if (all) return true; // OR：任一群組全中即通過
    }
    return false;
  }

  // 對一批項目套用篩選，直接增刪其 CSS class（tt-filtered-out）以隱藏/顯示。
  // 參數：
  //   items       Element 陣列（如票區 <li>/<a>）
  //   includeStr  關鍵字（包含）字串，餵給 parse
  //   excludeStr  黑名單（排除）字串，餵給 parse
  //   hideSoldOut 是否隱藏售完
  //   isSoldOut   選用 (item)=>boolean，判斷某項目是否售完
  // 隱藏條件（任一成立即隱藏）：
  //   1) include 非空 且 不符合 include
  //   2) exclude 非空 且 符合 exclude
  //   3) hideSoldOut 且 isSoldOut(item)
  // 否則移除 tt-filtered-out（恢復顯示）。
  // 回傳 { shown, hidden } 計數。
  var HIDDEN_CLASS = "tt-filtered-out";

  function apply(opts) {
    opts = opts || {};
    var items = opts.items || [];
    var include = parse(opts.includeStr);
    var exclude = parse(opts.excludeStr);
    var hideSoldOut = !!opts.hideSoldOut;
    var isSoldOut = typeof opts.isSoldOut === "function" ? opts.isSoldOut : null;

    var shown = 0;
    var hidden = 0;

    for (var i = 0; i < items.length; i++) {
      var item = items[i];
      if (!item) continue;
      var text = normalizeNumber(item.textContent || "");

      var hide =
        (include.length > 0 && !matches(text, include)) ||
        (exclude.length > 0 && matches(text, exclude)) ||
        (hideSoldOut && isSoldOut !== null && isSoldOut(item));

      if (item.classList) {
        if (hide) item.classList.add(HIDDEN_CLASS);
        else item.classList.remove(HIDDEN_CLASS);
      }

      if (hide) hidden++;
      else shown++;
    }

    return { shown: shown, hidden: hidden };
  }

  g.TTFilter = {
    normalizeNumber: normalizeNumber,
    parse: parse,
    matches: matches,
    apply: apply,
    HIDDEN_CLASS: HIDDEN_CLASS
  };
})(typeof self !== "undefined" ? self : this);
