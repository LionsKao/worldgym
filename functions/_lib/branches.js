// 分店查找表：注入課表（ssrBranch.js）與有課表的分店清單（scheduleBranches.js）共用，不各建一份。
import BRANCHES from "../../worker/src/branches-seed.js";
import { SSR_BRANCH_SLUGS } from "./ssrConfig.js";

// branch 網址短代碼 = branches-seed.js 陣列的位置（跟 script.js 的 BRANCH_SLUG_ORDER 同一個順序，
// 這份順序只能往後附加，不能插入或調換，不然舊的分享網址會指到別間分店；npm run check:branches 會檢查）。
// slug → { slug, name, region, code }，code 是數字（要排序時直接比大小，要放進網址時 branchPageUrl 會轉字串）。
export const BRANCH_BY_SLUG = new Map(BRANCHES.map((b, i) => [b.slug, { ...b, code: i }]));
// 短代碼字串 → slug（解析舊的短代碼網址用）
export const SLUG_BY_CODE = new Map(BRANCHES.map((b, i) => [String(i), b.slug]));
// 有開放注入／列進 sitemap 與 llms.txt 的分店（見 ssrConfig.js 的 SSR_BRANCH_SLUGS）
export const SSR_SLUGS = new Set(SSR_BRANCH_SLUGS);
