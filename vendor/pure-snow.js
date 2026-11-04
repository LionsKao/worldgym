// 下雪特效：來自 jptip approval2 專案的 pure-snow.js，本站改過幾處：
//   1. 不在 window.onload 自動執行：由 script.js 的 startSnow() 在活動期間才載入，載入完呼叫 window.createSnow()。
//   2. 拿掉 resize 重建：雪花位置與速度都用 vw／vh，視窗大小改變會自己跟著縮放，不需要重建（手機網址列伸縮
//      會一直觸發 resize，每次重建都會讓 200 條 CSS 動畫整個重來）。
//   3. 雪花不要太淡太小：opacity 0.4～1、scale 0.4～1（原本 0～1，數量少時很多片幾乎看不見）。
//   4. 拿掉用不到的 showSnow、全域 SNOWFLAKES_COUNT／BASE_CSS 與 CommonJS 匯出。
// 數量由 <div id="snow" data-count="..."> 控制（script.js 依螢幕寬度決定），沒設時預設 200。
const PAGE_HEIGHT_VH = 100;
let snowflakesCount = 200;

// 讀 #snow 上的 data-count
function getSnowAttributes() {
  const snowWrapper = document.getElementById('snow');
  snowflakesCount = Number(snowWrapper?.dataset?.count || snowflakesCount);
}

// 產生雪花元素（數量是 snowDensity - 1，跟 generateSnowCSS 的規則數一致）
function generateSnow(snowDensity = 200) {
  const snowWrapper = document.getElementById('snow');
  if (!snowWrapper) return;

  snowWrapper.replaceChildren();

  // 用 DocumentFragment 一次加進 DOM，減少重繪
  const fragment = document.createDocumentFragment();
  for (let i = 1; i < snowDensity; i++) {
    const flake = document.createElement('div');
    flake.className = 'snowflake';
    fragment.appendChild(flake);
  }
  snowWrapper.appendChild(fragment);
}

function getOrCreateCSSElement() {
  let cssElement = document.getElementById('psjs-css');
  if (cssElement) return cssElement;

  cssElement = document.createElement('style');
  cssElement.id = 'psjs-css';
  document.head.appendChild(cssElement);
  return cssElement;
}

// 把每片雪花的動畫規則整包寫進 <style>（CSP 的 style-src 有 'unsafe-inline'）
function addCSS(rule) {
  getOrCreateCSSElement().textContent = rule;
}

function randomInt(value = 100) {
  return Math.floor(Math.random() * value) + 1;
}

function randomIntRange(min, max) {
  min = Math.ceil(min);
  max = Math.floor(max);
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

function getRandomArbitrary(min, max) {
  return Math.random() * (max - min) + min;
}

// 每片雪花各自的位置、大小、速度與動畫
function generateSnowCSS(snowDensity = 200) {
  let rule = '';

  for (let i = 1; i < snowDensity; i++) {
    const randomX = Math.random() * 100; // vw
    const randomOffset = Math.random() * 10; // vw
    const randomXEnd = randomX + randomOffset;
    const randomXEndYoyo = randomX + (randomOffset / 2);
    const randomYoyoTime = getRandomArbitrary(0.3, 0.8);
    const randomYoyoY = randomYoyoTime * PAGE_HEIGHT_VH; // vh
    const randomScale = getRandomArbitrary(0.4, 1);
    const fallDuration = randomIntRange(10, PAGE_HEIGHT_VH / 10 * 3); // s
    const fallDelay = randomInt(PAGE_HEIGHT_VH / 10 * 3) * -1; // s
    const opacity = getRandomArbitrary(0.4, 1);

    rule += `
      .snowflake:nth-child(${i}) {
        opacity: ${opacity};
        transform: translate(${randomX}vw, -10px) scale(${randomScale});
        animation: fall-${i} ${fallDuration}s ${fallDelay}s linear infinite;
      }
      @keyframes fall-${i} {
        ${randomYoyoTime * 100}% {
          transform: translate(${randomXEnd}vw, ${randomYoyoY}vh) scale(${randomScale});
        }
        to {
          transform: translate(${randomXEndYoyo}vw, ${PAGE_HEIGHT_VH}vh) scale(${randomScale});
        }
      }
    `;
  }
  addCSS(rule);
}

function createSnow() {
  getSnowAttributes();
  generateSnowCSS(snowflakesCount);
  generateSnow(snowflakesCount);
}

window.createSnow = createSnow;
