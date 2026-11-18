// 跨年煙火彩蛋（使用者 2026-11-19 決定，見 CLAUDE.md「彩蛋：跨年煙火」）。
// 只在期間內才由 script.js 的 startNewYearFireworks() 動態載入，平常不下載。
// 造型以使用者提供的一段手機遊戲螢幕錄影（0.13 秒一張，共 72 張）為底：圓點、金／橘／紫／銀藍四色、
// 「啪」一下冒出一小團再散成一圈、夾幾顆較亮壽命較長的奶白亮點、各點在 1 秒多內陸續消失。
// 使用者說影片只是參考、可以用更好的呈現，所以再加上三件事讓它更像「跨年煙火」：
//   1. 火箭：先有一顆帶漸細尾巴的亮點從畫面下方衝上去，到定點才爆開（影片裡是原地直接冒出來）；
//   2. 三種爆法：圓環（影片那種，最常見）、牡丹（填滿的球，帶短拖尾）、柳枝（金色、往下垂的長拖尾）；
//   3. 最後連放一串收尾。
// 全螢幕透明 canvas、點擊穿透；放完一輪（發射 4 秒＋收尾，整段約 7～8 秒）就把 canvas 拿掉、停掉動畫、呼叫 options.onDone，不會一直耗電。
// 不用任何函式庫，也不用發光濾鏡或加法混色。
// 顏色只為深色底設計（奶白亮點、銀藍在米色底會看不見）：淺色模式的使用者，script.js 會先把整個畫面
// 暫時漸變成深色再呼叫 start()，放完再漸變回來（見 script.js 的 newYearFadeTheme）。
(function(){
  "use strict";
  const SHOW_SECONDS = 4; // 持續發射的時間（使用者 2026-11-19 嫌 9 秒太久改成 4 秒）；收尾那一串之後還要等火箭與粒子結束才會收掉
  const FINALE_COUNT = 5; // 收尾連放幾發
  const FINALE_GAP = 0.13; // 收尾每發之間隔幾秒
  const COLORS = ["#ffc61a", "#ff8a1f", "#c64dff", "#aab6d8"]; // 影片裡的四種顏色：金、橘、紫、銀藍
  const GOLD = "#ffc61a"; // 柳枝專用
  const ACCENT_COLOR = "#fff4cf"; // 亮點：影片裡是奶白色
  const BASE_SPEED = 250; // 圓環外圈的擴散速度（px/秒，以 393px 寬的手機為準；影片量到約 250）
  let running = false;

  const rand = (a, b) => a + Math.random() * (b - a);
  const pick = (list) => list[Math.floor(Math.random() * list.length)];

  function start(options){
    if (running) return;
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return; // 呼叫端也會擋，這裡再保險一次
    running = true;
    const small = !!(options && options.small); // 手機：粒子少一點
    const onDone = options && options.onDone; // 整輪放完、畫面層拿掉之後呼叫
    const palette = COLORS;
    const accentColor = ACCENT_COLOR;

    const canvas = document.createElement("canvas");
    canvas.setAttribute("aria-hidden", "true");
    // z-index 900：跟下雪一樣，在內容與按鈕上面、在彈出視窗（1000 以上）下面；點擊穿透。
    canvas.style.cssText = "position:fixed;left:0;top:0;width:100%;height:100%;pointer-events:none;z-index:900";
    document.body.appendChild(canvas);
    const ctx = canvas.getContext("2d");
    let width = 0, height = 0, unit = 1;
    function resize(){
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      width = window.innerWidth;
      height = window.innerHeight;
      unit = Math.min(Math.max(width / 393, 1), 1.8); // 桌機畫面大，煙火跟著放大一些，但不要無限放大
      canvas.width = Math.round(width * dpr);
      canvas.height = Math.round(height * dpr);
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    }
    resize();
    window.addEventListener("resize", resize);

    const sparks = [];
    const rockets = [];
    const pending = []; // 排好時間、還沒發射的 { at, x }

    function schedule(at, x){
      pending.push({ at, x: x ?? rand(width * 0.1, width * 0.9) });
    }

    function launch(x){
      rockets.push({
        x0: x + rand(-25, 25), x1: x,
        y0: height + 10, y1: rand(height * 0.1, height * 0.38),
        t: 0, duration: rand(0.55, 0.8),
        color: pick(palette), trail: [],
      });
    }

    function addSpark(x, y, angle, speed, color, radius, life, gravity, extra){
      sparks.push(Object.assign({
        x, y, vx: Math.cos(angle) * speed, vy: Math.sin(angle) * speed,
        color, radius, life, age: 0, gravity, accent: false, streak: false,
      }, extra));
    }

    function addAccents(x, y, speed){
      for (let i = 0; i < 4; i++){
        addSpark(x, y, rand(0, Math.PI * 2), speed * rand(0.3, 0.95), accentColor, rand(2.6, 3.6), rand(1.3, 1.9), 20, { accent: true });
      }
    }

    // 到定點爆開：圓環（影片那種）、牡丹、柳枝三選一。
    function explode(x, y, color){
      const speed = BASE_SPEED * unit * rand(0.85, 1.15);
      const kind = Math.random();
      if (kind < 0.45){
        // 圓環：主色圓點散成一圈，速度集中在外圈、少數留在內側
        const count = small ? 26 : 30;
        for (let i = 0; i < count; i++){
          const angle = (i / count) * Math.PI * 2 + rand(-0.12, 0.12);
          addSpark(x, y, angle, speed * rand(0.72, 1), color, rand(2, 3.4), rand(0.9, 1.4), 45);
        }
        addAccents(x, y, speed);
      } else if (kind < 0.8){
        // 牡丹：填滿的球，速度從慢到快都有，帶短拖尾；四成機率內圈換另一個顏色
        const inner = Math.random() < 0.4 ? pick(palette) : color;
        const count = small ? 36 : 44;
        for (let i = 0; i < count; i++){
          const v = speed * rand(0.2, 1);
          addSpark(x, y, rand(0, Math.PI * 2), v, v < speed * 0.5 ? inner : color, rand(1.8, 3), rand(1, 1.5), 55, { streak: true });
        }
        addAccents(x, y, speed);
      } else {
        // 柳枝：金色、慢、壽命長、重力大，長拖尾往下垂
        const count = small ? 30 : 38;
        for (let i = 0; i < count; i++){
          addSpark(x, y, rand(0, Math.PI * 2), speed * rand(0.3, 0.85), GOLD, rand(1.6, 2.6), rand(1.8, 2.6), 110, { streak: true, long: true });
        }
      }
    }

    let last = performance.now();
    let elapsed = 0;
    let nextLaunch = 0.2;
    let finaleScheduled = false;
    let frameId = 0;

    function finish(){
      cancelAnimationFrame(frameId);
      window.removeEventListener("resize", resize);
      canvas.remove();
      running = false;
      if (onDone) onDone();
    }

    function frame(now){
      // dt 設上限：分頁切到背景再回來時 rAF 會隔很久才有下一格，不設上限會一次補放一大堆。
      const dt = Math.min(Math.max((now - last) / 1000, 0), 0.05);
      last = now;
      elapsed += dt;

      if (elapsed < SHOW_SECONDS){
        nextLaunch -= dt;
        if (nextLaunch <= 0){
          schedule(elapsed);
          if (Math.random() < 0.2) schedule(elapsed + rand(0.05, 0.25)); // 偶爾幾乎同時兩發
          nextLaunch = rand(0.45, 1.0);
        }
      } else if (!finaleScheduled){
        finaleScheduled = true;
        for (let i = 0; i < FINALE_COUNT; i++){
          schedule(elapsed + i * FINALE_GAP, width * (0.12 + 0.76 * (i + 0.5) / FINALE_COUNT) + rand(-20, 20));
        }
      }
      for (let i = pending.length - 1; i >= 0; i--){
        if (pending[i].at <= elapsed){
          launch(pending[i].x);
          pending.splice(i, 1);
        }
      }

      ctx.clearRect(0, 0, width, height);

      // 火箭：帶漸細尾巴的亮點，先快後慢衝到定點就爆開
      for (let i = rockets.length - 1; i >= 0; i--){
        const r = rockets[i];
        r.t += dt;
        const p = Math.min(r.t / r.duration, 1);
        const e = 1 - (1 - p) * (1 - p);
        const x = r.x0 + (r.x1 - r.x0) * e;
        const y = r.y0 + (r.y1 - r.y0) * e;
        r.trail.push([x, y]);
        if (r.trail.length > 7) r.trail.shift();
        ctx.fillStyle = r.color;
        for (let k = 0; k < r.trail.length; k++){
          const f = (k + 1) / r.trail.length; // 越新的越大越不透明
          ctx.globalAlpha = 0.15 + 0.75 * f;
          ctx.beginPath();
          ctx.arc(r.trail[k][0], r.trail[k][1], 0.8 + 1.9 * f, 0, Math.PI * 2);
          ctx.fill();
        }
        if (p >= 1){
          explode(x, y, r.color);
          rockets.splice(i, 1);
        }
      }

      const drag = Math.exp(-0.5 * dt);
      ctx.lineCap = "round";
      for (let i = sparks.length - 1; i >= 0; i--){
        const s = sparks[i];
        s.age += dt;
        if (s.age >= s.life){ sparks.splice(i, 1); continue; }
        s.vx *= drag;
        s.vy = s.vy * drag + s.gravity * dt;
        s.x += s.vx * dt;
        s.y += s.vy * dt;
        const a = s.age / s.life;
        ctx.globalAlpha = a < 0.7 ? 1 : 1 - (a - 0.7) / 0.3; // 最後 30% 壽命淡出
        if (s.streak){
          const tail = s.long ? 0.12 : 0.05; // 拖尾長度（秒）
          ctx.strokeStyle = s.color;
          ctx.lineWidth = s.radius * 1.6;
          ctx.beginPath();
          ctx.moveTo(s.x - s.vx * tail, s.y - s.vy * tail);
          ctx.lineTo(s.x, s.y);
          ctx.stroke();
        } else {
          ctx.fillStyle = s.color;
          ctx.beginPath();
          ctx.arc(s.x, s.y, s.radius, 0, Math.PI * 2);
          ctx.fill();
        }
      }

      if (elapsed >= SHOW_SECONDS && finaleScheduled && !pending.length && !rockets.length && !sparks.length){
        finish();
        return;
      }
      frameId = requestAnimationFrame(frame);
    }
    frameId = requestAnimationFrame(frame);
  }

  window.WGFireworks = { start };
})();
