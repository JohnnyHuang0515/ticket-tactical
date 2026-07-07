// 站台適配設定（POC）。對應規格 §3.2 SiteAdapter / §6.4 選擇器契約。
// ⚠️ 下方選擇器為合理猜測，需對照「實際售票頁 DOM」微調（見 extension/README.md 與規格 §9 Runbook R-1）。
// 設成 content script 共享的全域，供 content.js 讀取。
window.__TT_ADAPTERS = [
  {
    siteKey: "tixcraft",
    siteName: "拓元 tixCraft",
    hostPatterns: ["tixcraft.com"],
    // ✅ 取自實際區域頁 DOM（/ticket/area/...）。清版面：隱藏全站框架與廣告，保留 .main-wrapper 內票區清單。
    declutterSelectors: [
      "#header",              // 頁首 logo bar（含 #bs-navbar 導覽）
      "#bs-navbar2",          // 側邊導覽 sidenav
      "footer.footer",        // 頁尾連結區
      "#ad-footer",           // 頁尾廣告
      "[id^='div-gpt-ad']",   // Google 廣告版位（GPT）
      ".back-to-top",         // 回到頂端浮鈕
      "#onetrust-consent-sdk" // Cookie 同意橫幅
    ],
    // 區域頁的動作＝點「票區連結」(areaItemSelector)；全部高亮太雜，故 enlarge 主要針對後續「確認張數 / 下一步」頁的按鈕。
    // ✅ 放大關鍵按鈕：張數/結帳頁的確認鈕、同意條款、張數下拉（取自開源 tixcraft_bot 實際 id）。
    keyButtonSelectors: [
      "#submitButton",        // 確認張數 / 送出
      "#TicketForm_agree",    // 同意條款 checkbox
      ".mobile-select",       // 張數下拉
      ".btn-primary"          // 一般主要鈕（後援）
    ],
    // ✅ 票區清單容器與項目（供篩選 FR-13/14）。開源 bot 用 .zone > a；我們用實際頁面的 ul.area-list li a。
    ticketListSelector: ".zone.area-list, ul.area-list",
    // ✅ 選「整列 li」而非 li a —— 售完區是純 <li>（沒有 <a>），選 a 會漏掉售完區、導致藏不掉。
    areaItemSelector: "ul.area-list li",
    // ✅ 自動刷新暫停判定（EC-7）：出現任一即代表已進「張數/驗證/結帳」頁（取自開源 bot 的驗證碼/同意/送出元素）。
    verifySelectors: [
      "#TicketForm_verifyCode", // 驗證碼欄位
      "#checkCode",             // 舊版驗證碼欄位
      ".zone-verify",           // 驗證區塊
      "#TicketForm_agree",      // 同意條款
      "#submitButton"           // 送出鈕
    ],
    // ✅ 售完訊號（取自真實 DOM）：售完區為灰字 <font color="#AAAAAA">…已售完</font>、且整列無 <a>；
    //   可買區為紅字 <font color="#FF0000">剩餘 N</font> 且有 <a>。content.js 另以文字「已售完」雙重判定。
    soldOutSelector: 'font[color="#AAAAAA" i]'
  },
  {
    siteKey: "weverse",
    siteName: "Weverse",
    hostPatterns: ["weverse.io"],
    declutterSelectors: [".banner", "[class*='promotion']"],
    keyButtonSelectors: [
      "button[type='submit']",
      "[class*='Buy']",
      "[class*='ticket']"
    ],
    ticketListSelector: "[class*='seat'], [class*='ticket-list']",
    soldOutSelector: "[disabled], [class*='soldout']"
  },
  {
    siteKey: "yes24",
    siteName: "Yes24 (韓)",
    hostPatterns: ["ticket.yes24.com"],
    // ✅ 票務頁網址取自開源外掛 manifest：售票/選位頁 = /Sale/FnPerfSaleProcess.aspx；演出詳情頁 = /Perf/FnPerfDeail.aspx。
    //    用 FnPerf 同時涵蓋兩者（含英/韓頁），避開站台其餘頁面。
    activateOnUrl: /FnPerf|\/Sale\//i,
    // 部分選擇器取自開源外掛 BastienBoymond/korea-concert-ticket-bot 的 scripts/yes24/seat.js（全球版 ticket.yes24.com）。
    //    售完字「매진/품절/Sold Out」→ content.js 文字偵測已支援。
    //    ⚠️ 選位圖在 <iframe> 內：本外掛 content_scripts 未開 all_frames，預設不會注入 iframe → 選位頁的篩選/放大需另開 all_frames 才生效（待決）。
    //    ✅ 實證：選位是真 DOM（非 canvas，可篩）；售完座位 class=`s13`、容器 #divSeatArray、座位圖 name=maphall、確認鈕 #btnSeatSelect。
    declutterSelectors: ["#header", "#footer", ".gnb", "[class*='banner']", "[class*='ad']"],
    keyButtonSelectors: ["#btnSeatSelect", "[class*='btnBuy']", "[class*='reserve']", "a[href*='Order']", "button[type='submit']"],
    ticketListSelector: "#divSeatArray, [name='maphall'], [class*='seat'], [class*='grade'], [class*='price'], table",
    areaItemSelector: "#divSeatArray li, [class*='grade'] li, table tbody tr",
    soldOutSelector: ".s13, [class*='soldout'], [disabled]",
    verifySelectors: ["[class*='captcha']", "input[name*='captcha']", "#captcha"]
  },
  {
    siteKey: "nol",
    siteName: "NOL World (Interpark 全球)",
    // world.nol.com = Interpark Ticket 改名後的全球站；選位/排隊可能在子網域或 popup，故含 *.nol.com。
    hostPatterns: ["world.nol.com", "nol.com"],
    // ⚠️ world.nol.com 是綜合站（票務＋旅遊＋美食），首頁/分類頁為 React 不斷重繪 → 只在「實際購票頁」介入，
    //    否則清版面會與 React 打架造成整頁閃爍。比對：產品頁 /products/{id} 及 booking/seat/order/payment/queue 流程。
    activateOnUrl: /products\/\d|\/booking|\/order|\/seat|\/payment|queue|reserve/i,
    // ⚠️ [待驗證] 全英文站、Next.js + Panda CSS（class 多為雜湊、build 一變就改）→ 嚴禁用 class 當選擇器；
    //    優先靠 aria-*/role/data-*/穩定 id/按鈕文字（예매·Booking / 매진·Sold Out）。以下 class 選擇器僅為後援猜測，待真 DOM 校準。
    //    產品頁網址：/en/ticket/places/{placeId}/products/{productId}（已實測）；圖片走 ticketimage.interpark.com。
    //    ⚠️ booking/選位/queue 皆 client-side render（初始 HTML 看不到）→ content script 必須等 hydration，不能讀 SSR HTML。
    //    ⚠️ 開源現況（2026-06 研究）：新版 NOL World（全球站 2025-12 改名、國內站 2025-04）無任何開源實作可抄；
    //       舊 Interpark repo（crypt0nX/Interpark-Bot 等）打的是舊 ASP 站、選擇器全過時。唯一可沿用觀念＝reCAPTCHA iframe 判排隊/驗證。
    //    ⚠️ 站方自家行為：選位頁全樓層同屏 + 座位被搶走「1~2 秒自動刷新」、所有人共用單一 queue、選位後保留 7 分鐘。
    //       → 偵測到排隊/選位頁時應「停掉我們自己的自動刷新」交給站方，避免雙重刷新被判 bot（EC-7）。
    // ✅ 校準自實際產品頁 DOM（/zh-CN/.../products/...，Next.js + Panda CSS）：
    //    全站框架（頂部 sticky bar / nav / 全域 header / footer）都是 <body> 直接子層；商品內容在 <main> 內。
    //    ⚠️ NOL 也用 <header> 當「內容區段標題」（<main> 內有 2 個）→ 一定要用 body> 子選擇器，
    //    只藏 body 直屬框架、不碰 <main> 內標題；否則會誤藏商品標題並造成 React 重繪閃爍（前一版的 bug）。
    declutterSelectors: [
      "body > nav",
      "body > header",
      "body > footer",
      "body > div.z_fixedLayout"  // 頂部 sticky 列（Panda 原子 class，穩定）
    ],
    // ✅ 立即购买 / Booking 鈕＝NOL 設計系統（nds）的 primary filled 按鈕（校準自實際 DOM）。
    keyButtonSelectors: [
      ".nds-e-rectangle-button--variant_filled_primary",
      "[class*='filled_primary']",
      "button[type='submit']"
    ],
    // 票種/等級清單（非座位圖那層）— 供篩選 VIP/R/S/A。
    ticketListSelector: "[class*='grade'], [class*='Grade'], [class*='seatGrade'], [class*='price'], [class*='Price'], table",
    areaItemSelector: "[class*='grade'] li, [class*='Grade'] li, [class*='price'] li, table tbody tr",
    // 售完主訊號靠 content.js 文字偵測（매진/품절/Sold Out，耐改版）；此處留耐用語意屬性 + class 後援（猜測）。
    soldOutSelector: "[aria-disabled='true'], [class*='soldout' i], [class*='soldOut'], [disabled]",
    // 排隊（queue/waiting）+ 驗證頁 → 暫停我們的自動刷新（EC-7）。reCAPTCHA iframe 為跨 repo 共識判定點。
    verifySelectors: [
      "iframe[title*='recaptcha' i]", "iframe[src*='recaptcha']",
      "[class*='queue']", "[class*='Queue']",
      "[class*='waiting']", "[class*='Waiting']",
      "[class*='captcha']", "input[name*='captcha']"
    ]
  },
  {
    siteKey: "melon",
    siteName: "Melon Ticket (全球)",
    hostPatterns: ["tkglobal.melon.com"],
    // ✅ 票務頁網址取自開源外掛 manifest：演出頁 = /performance/index.htm；選位購票 popup = /reservation/popup/onestop.htm。
    //    精準比對這兩條，避開 Melon 全球站首頁/列表頁（不在票務頁就不介入）。
    activateOnUrl: /\/performance\/index\.htm|\/reservation\/popup\/onestop/i,
    // ✅ 選擇器取自開源外掛 BastienBoymond/korea-concert-ticket-bot 的 scripts/melonticket/{concert,seat}.js（全球版 tkglobal.melon.com）。
    //    售完字「매진/품절/Sold Out」→ content.js 文字偵測已支援。
    //    ⚠️ 選位在 iframe #oneStopFrame 內：content_scripts 未開 all_frames，預設不注入 iframe → 選位頁增強需另開 all_frames（待決）。
    //    ⚠️ 座位圖是 canvas #ez_canvas（SVG rect，灰色 #DDDDDD/none=不可選）→ 個別座位無法 DOM 篩選；篩選最多套用在區域 .area_tit 那層。
    declutterSelectors: ["#header", "#footer", "[class*='gnb']", "[class*='banner']", "[class*='header']", "[class*='footer']"],
    // .reservationBtn＝演出頁預約鈕（concert.js）；#nextTicketSelection＝選位頁下一步（seat.js）。
    keyButtonSelectors: [".reservationBtn", "#nextTicketSelection", "button[type='submit']"],
    // #list_date / #list_time＝日期場次清單；.area_tit / .seat_name＝區域/座位等級（篩選套這層）。
    ticketListSelector: "#list_date, #list_time, [class*='area_tit'], [class*='seat_name'], [class*='grade'], table",
    areaItemSelector: "#list_date li, #list_time li, [class*='area_tit']",
    soldOutSelector: "[class*='soldout'], [disabled]",
    // 暫停自動刷新：驗證碼 #certification、購票 iframe #oneStopFrame、座位 canvas #ez_canvas（出現即在選位/驗證流程）。
    verifySelectors: ["#certification", "#oneStopFrame", "#ez_canvas", "[class*='captcha']", "[class*='queue']", "[class*='waiting']"]
  }
];
