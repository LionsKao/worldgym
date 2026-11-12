// 語音搜尋比對的測試案例（給 scripts/test-voice.mjs 用）。每個案例是「講了一句話 → 預期選到什麼」。
//
// 欄位：
//   say         使用者講的（或語音辨識轉出來的）一句話，必填
//   result      預期回傳："submitted"（預設）／"insufficient"（聽懂一些但沒有分店或老師）／"no-match"
//   day         預期星期："today"／"tomorrow"／"1"~"7"
//   time        預期時段："0600"（06-11）／"1200"（12-17）／"1800"（18-23）
//   room        預期教室；沒寫就是預設的 ["團體教室"]（或 roomBefore）
//   branch      預期分店，寫畫面上的名稱，或整組簡寫 @city:高雄、@zone:台南區、@prefix:板橋（見 test-voice.mjs）
//   course／teacher  預期課程、老師（跟 checkbox 的 value 一樣；來自 voice-fixtures.json）
//   named       常用排序要加次數的項目（明確講到的單一分店／課程／老師，不含整組詞）；有寫才檢查，沒列的類別視為空
//   hit         結果頁標紅的片段（原句裡聽懂的字，相鄰的會合併成一段）；有寫才檢查
//   roomBefore  講話前使用者已勾選的教室，預設 ["團體教室"]
//   noPinyin    設 true 會暫時關掉拼音比對（模擬 pinyin-pro 還沒載入完的情況）
//   note        失敗時一起印出來的說明
//   todo        已知問題：其他欄位寫「應該有的行為」，這句是目前沒做到的原因。仍不通過時只提醒、不算失敗；
//               哪天修好了會通過，這時反而算失敗，提醒你把 todo 拿掉
//
// **除了 result 與 no-match 以外，沒寫的欄位一律當作「預期為空」**（例如沒寫 teacher 就是不該選到任何老師），
// 所以多選到東西也會被抓到。改了比對規則、別名表或分店之後，有案例失敗先判斷是「該改程式」還是「該改案例」，
// 規則是故意改的就更新案例（案例就是規則的文件），不是故意的就是抓到 bug 了。

const BOTH_ROOMS = ["團體教室", "飛輪教室"];

export const CASES = [
  // ===== 星期、時段、教室（用一間分店湊成可送出的查詢）=====
  { say: "今天大安的課", day: ["today"], branch: ["大安"] },
  { say: "明天晚上公館", day: ["tomorrow"], time: ["1800"], branch: ["公館"] },
  { say: "星期三下午長春", day: ["3"], time: ["1200"], branch: ["長春"] },
  { say: "禮拜天傍晚西門", day: ["7"], time: ["1800"], branch: ["西門"], note: "傍晚算 18-23" },
  { say: "週末早上大直", day: ["6", "7"], time: ["0600"], branch: ["大直"] },
  { say: "今日中午民生", day: ["today"], time: ["1200"], branch: ["民生"], note: "民生圓環比較長但句子裡沒講圓環" },
  { say: "我想找明天晚上板橋的團課", day: ["tomorrow"], time: ["1800"], branch: ["@prefix:板橋"], room: ["團體教室"] },
  { say: "一下大安", branch: ["大安"], note: "裸數字「一」不能變成星期一" },
  { say: "今天，大安。", day: ["today"], branch: ["大安"], note: "標點符號不影響比對" },

  // ===== 教室規則 =====
  { say: "飛輪教室大安", branch: ["大安"], room: ["飛輪教室"] },
  { say: "飛輪課大安", branch: ["大安"], room: ["飛輪教室"] },
  { say: "團課大安", branch: ["大安"], room: ["團體教室"] },
  { say: "大安", roomBefore: ["飛輪教室"], branch: ["大安"], room: ["飛輪教室"], note: "只講分店：維持使用者目前勾選的教室" },
  { say: "大安", roomBefore: BOTH_ROOMS, branch: ["大安"], room: BOTH_ROOMS },
  { say: "大安的康貝", branch: ["大安"], course: ["BODYCOMBAT"], room: BOTH_ROOMS, note: "講了課程沒講教室：兩種教室都選" },
  { say: "小金的課", teacher: ["小金"], room: BOTH_ROOMS, note: "講了老師沒講教室：兩種教室都選" },
  { say: "飛輪教室小金", teacher: ["小金"], room: ["飛輪教室"] },

  // ===== 分店消歧：長的詞先佔走字，短的詞不能再用 =====
  { say: "西門的課", branch: ["西門"], note: "台北西門，不是台南西門" },
  { say: "台南西門的課", branch: ["台南西門"], named: { branch: ["台南西門"] } },
  { say: "台北西門的課", branch: ["西門"] },
  { say: "永和的課", branch: ["永和"], note: "不能連永和民權一起選" },
  { say: "永和民權的課", branch: ["永和民權"] },
  { say: "土城的課", branch: ["土城"] },
  { say: "土城海山的課", branch: ["土城海山"] },
  { say: "新莊的課", branch: ["新莊"], note: "不能連北新莊一起選" },
  { say: "北新莊的課", branch: ["北新莊"] },
  { say: "民生圓環的課", branch: ["民生圓環"] },

  // ===== 整組詞：按鈕詞、縣市、同前綴 =====
  { say: "台北的課", branch: ["@city:台北"], named: {}, note: "整組詞不算 named" },
  { say: "新北的課", branch: ["@city:新北"] },
  { say: "台中的課", branch: ["@zone:台中區"], note: "台中是整個分區（含彰化南投雲林）" },
  { say: "台南的課", branch: ["@zone:台南區"], note: "台南是整個分區（含嘉義）" },
  { say: "高屏的課", branch: ["@zone:高屏區"] },
  { say: "高雄的課", branch: ["@city:高雄"], note: "只有高雄，不含屏東" },
  { say: "屏東的課", branch: ["@city:屏東"] },
  { say: "桃園的課", branch: ["@city:桃園"] },
  { say: "嘉義的課", branch: ["@city:嘉義"], note: "沒有嘉義按鈕，用縣市；範圍只有嘉義，不是整個台南區" },
  { say: "彰化的課", branch: ["@city:彰化"] },
  { say: "板橋的課", branch: ["@prefix:板橋"], teacher: [], named: {}, note: "同前綴整組；板橋的拼音不能對到老師安起" },
  { say: "鳳山的課", branch: ["@prefix:鳳山"] },
  { say: "今天高雄的課", day: ["today"], branch: ["@city:高雄"] },
  { say: "今天台南的課", day: ["today"], branch: ["@zone:台南區"] },
  // 整組詞只有「這句沒講到該組任何單一分店」才生效
  { say: "台北大安分店", branch: ["大安"], named: { branch: ["大安"] }, note: "台北只是修飾" },
  { say: "台北的大安", branch: ["大安"] },
  { say: "高雄的鳳山五甲", branch: ["鳳山五甲"], note: "高雄、鳳山都讓位給單一分店" },
  { say: "板橋中山的課", branch: ["板橋中山"], named: { branch: ["板橋中山"] }, note: "同前綴讓位給單一分店" },
  { say: "台北和新北三重", branch: ["@city:台北", "三重"], note: "台北整組，新北因為講了三重而讓位" },
  { say: "台南西門", branch: ["台南西門"], note: "不是整個台南區" },
  { say: "今天台南西門的課", day: ["today"], branch: ["台南西門"], hit: ["今天台南西門"], note: "相鄰的關鍵字合併成一段標紅" },

  // ===== 課程別名 =====
  { say: "今天大安的康貝", day: ["today"], branch: ["大安"], course: ["BODYCOMBAT"], room: BOTH_ROOMS, named: { branch: ["大安"], course: ["BODYCOMBAT"] } },
  { say: "大安戰鬥有氧", branch: ["大安"], course: ["BODYCOMBAT"], room: BOTH_ROOMS },
  { say: "大安pump", branch: ["大安"], course: ["BODYPUMP"], room: BOTH_ROOMS, note: "英文別名不分大小寫" },
  { say: "大安彼拉提斯", branch: ["大安"], course: ["皮拉提斯"], room: BOTH_ROOMS },
  { say: "大安瑜珈", branch: ["大安"], course: ["BODYBALANCE", "CENTERGY"], room: BOTH_ROOMS, named: { branch: ["大安"], course: ["BODYBALANCE", "CENTERGY"] }, note: "泛稱瑜伽 = 兩門課" },
  { say: "大安瑜伽", branch: ["大安"], course: ["BODYBALANCE", "CENTERGY"], room: BOTH_ROOMS, note: "兩種寫法都收" },
  { say: "大安瑜伽基礎", branch: ["大安"], course: ["瑜伽基礎"], room: BOTH_ROOMS, note: "有自己名稱的課，較長先比對" },
  { say: "大安陰瑜伽", branch: ["大安"], course: ["陰瑜伽"], room: BOTH_ROOMS },
  { say: "大安EOXi", branch: ["大安"], course: ["EOXi"], room: BOTH_ROOMS },

  // ===== 老師與別名 =====
  { say: "小金的課", teacher: ["小金"], room: BOTH_ROOMS, named: { teacher: ["小金"] } },
  { say: "小威的課", teacher: ["小威"], room: BOTH_ROOMS },
  { say: "破音的課", teacher: ["黑黑", "Shawn"], room: BOTH_ROOMS, named: { teacher: ["黑黑", "Shawn"] }, note: "綽號對應兩位老師" },
  { say: "鐵板燒", teacher: ["Zac Wu"], room: BOTH_ROOMS },
  { say: "瘋子豪的課", result: "no-match", note: "別名已由使用者刪除，不要補回" },

  // ===== 同音字容錯（拼音）=====
  { say: "今天戰前的課", day: ["today"], branch: ["站前"], hit: ["今天戰前"], note: "戰前 → 站前（要有拼音）" },
  { say: "戰前的課", noPinyin: true, result: "no-match", note: "拼音還沒載入時退回純精確比對，不報錯" },
  { say: "站前的課", noPinyin: true, branch: ["站前"], note: "精確比對不靠拼音" },
  { say: "安琪的課", teacher: ["安起"], room: BOTH_ROOMS, note: "安琪 → 安起（同音）" },
  { say: "雄大的課", teacher: ["熊大"], room: BOTH_ROOMS, note: "雄大 → 熊大（同音）" },
  { say: "好豪的課", teacher: ["好豪"], room: BOTH_ROOMS, note: "清單裡有四位同音（好豪／浩浩／皓皓／豪豪）時，講中文名字要選到本人" },

  // ===== 沒聽懂與資訊不足 =====
  { say: "你好嗎", result: "no-match" },
  { say: "我想上課", result: "no-match" },
  { say: "我想問一下課表", result: "no-match", note: "「一下」不是星期一" },
  {
    say: "請幫我找一下課表", result: "no-match",
    todo: "拼音把「幫」(bang) 對到英文名字的老師 Bang；「幫我…」是很自然的開頭，會莫名其妙查某位老師",
  },
  {
    say: "幫我找大安的課", branch: ["大安"],
    todo: "同上：「幫」被當成老師 Bang，結果變成大安加老師 Bang",
  },
  { say: "今天晚上", result: "insufficient", day: ["today"], time: ["1800"], note: "沒有分店或老師：套用但不送出" },
  { say: "明天", result: "insufficient", day: ["tomorrow"] },
  { say: "飛輪教室", result: "insufficient", room: ["飛輪教室"] },
  { say: "週末的康貝", course: ["BODYCOMBAT"], day: ["6", "7"], room: BOTH_ROOMS, result: "insufficient", note: "只有課程沒有分店老師：不送出" },
];
