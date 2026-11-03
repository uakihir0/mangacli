// Generates simple sample artwork (characters/backgrounds) for docs/examples. CC0.
import { createCanvas } from "@napi-rs/canvas";
import { mkdirSync, writeFileSync } from "node:fs";

const out = "docs/examples/assets";
mkdirSync(`${out}/taro`, { recursive: true });
mkdirSync(`${out}/hanako`, { recursive: true });
mkdirSync(`${out}/bg`, { recursive: true });

type Expr = "normal" | "surprised" | "smile" | "shock" | "back";
function character(kind: "taro" | "hanako", expr: Expr) {
  const W = 1000, H = 1400;
  const c = createCanvas(W, H);
  const g = c.getContext("2d");
  g.lineJoin = "round"; g.lineCap = "round";
  const ink = "#111";
  // body
  g.fillStyle = kind === "taro" ? "#fff" : "#fff";
  g.strokeStyle = ink; g.lineWidth = 9;
  g.beginPath();
  g.moveTo(330, 700); g.bezierCurveTo(260, 760, 200, 1000, 170, 1400); g.lineTo(830, 1400); g.bezierCurveTo(800, 1000, 740, 760, 670, 700); g.closePath();
  g.fill(); g.stroke();
  // collar
  g.beginPath(); g.moveTo(420, 700); g.lineTo(500, 830); g.lineTo(580, 700); g.stroke();
  if (kind === "taro") { g.fillStyle = "#222"; g.beginPath(); g.moveTo(480, 800); g.lineTo(520, 800); g.lineTo(540, 1050); g.lineTo(500, 1100); g.lineTo(460, 1050); g.closePath(); g.fill(); }
  // neck
  g.fillStyle = "#fff"; g.beginPath(); g.moveTo(450, 600); g.lineTo(450, 710); g.lineTo(550, 710); g.lineTo(550, 600); g.fill(); g.beginPath(); g.moveTo(450, 600); g.lineTo(450, 705); g.moveTo(550, 600); g.lineTo(550, 705); g.stroke();
  // hanako long hair behind
  if (kind === "hanako") { g.fillStyle = "#3a3a3a"; g.beginPath(); g.moveTo(250, 380); g.bezierCurveTo(200, 700, 230, 900, 300, 950); g.lineTo(700, 950); g.bezierCurveTo(770, 900, 800, 700, 750, 380); g.closePath(); g.fill(); g.stroke(); }
  // face
  g.fillStyle = "#fff"; g.lineWidth = 10;
  g.beginPath(); g.ellipse(500, 400, 215, 245, 0, 0, Math.PI * 2); g.fill(); g.stroke();
  if (expr === "back") {
    g.fillStyle = kind === "taro" ? "#1a1a1a" : "#3a3a3a";
    g.beginPath(); g.ellipse(500, 380, 225, 255, 0, 0, Math.PI * 2); g.fill(); g.stroke();
  } else {
    // eyes
    const ey = 420;
    for (const ex of [420, 580]) {
      g.lineWidth = 8;
      if (expr === "smile") { g.beginPath(); g.arc(ex, ey + 10, 34, Math.PI * 1.1, Math.PI * 1.9); g.stroke(); continue; }
      const rx = expr === "surprised" || expr === "shock" ? 30 : 26;
      const ry = expr === "surprised" || expr === "shock" ? 44 : 40;
      g.fillStyle = "#fff"; g.beginPath(); g.ellipse(ex, ey, rx, ry, 0, 0, Math.PI * 2); g.fill(); g.stroke();
      g.fillStyle = ink; const pr = expr === "shock" ? 8 : 18; g.beginPath(); g.ellipse(ex, ey + 6, pr, pr * 1.2, 0, 0, Math.PI * 2); g.fill();
      if (expr !== "shock") { g.fillStyle = "#fff"; g.beginPath(); g.arc(ex - 7, ey - 6, 6, 0, Math.PI * 2); g.fill(); }
    }
    // brows
    g.lineWidth = 9; g.beginPath();
    const by = expr === "surprised" || expr === "shock" ? 330 : 350;
    g.moveTo(375, by); g.quadraticCurveTo(420, by - 18, 465, by); g.moveTo(535, by); g.quadraticCurveTo(580, by - 18, 625, by); g.stroke();
    // mouth
    g.lineWidth = 8;
    if (expr === "surprised") { g.fillStyle = "#222"; g.beginPath(); g.ellipse(500, 535, 22, 30, 0, 0, Math.PI * 2); g.fill(); }
    else if (expr === "shock") { g.fillStyle = "#222"; g.beginPath(); g.moveTo(450, 530); g.lineTo(550, 530); g.lineTo(530, 570); g.lineTo(470, 570); g.closePath(); g.fill(); }
    else if (expr === "smile") { g.beginPath(); g.arc(500, 510, 45, Math.PI * 0.15, Math.PI * 0.85); g.stroke(); }
    else { g.beginPath(); g.moveTo(470, 535); g.quadraticCurveTo(500, 545, 530, 535); g.stroke(); }
    // nose
    g.lineWidth = 6; g.beginPath(); g.moveTo(500, 455); g.lineTo(492, 480); g.stroke();
    // hair front
    g.fillStyle = kind === "taro" ? "#1a1a1a" : "#3a3a3a"; g.lineWidth = 9;
    g.beginPath();
    if (kind === "taro") {
      g.moveTo(275, 420); g.bezierCurveTo(250, 200, 400, 120, 520, 140); g.bezierCurveTo(680, 150, 760, 260, 725, 420);
      for (let i = 0; i < 7; i++) { const x = 700 - i * 60; g.lineTo(x, 300 + (i % 2) * 40); g.lineTo(x - 30, 260 + (i % 2) * 50); }
    } else {
      g.moveTo(270, 450); g.bezierCurveTo(240, 180, 420, 120, 520, 140); g.bezierCurveTo(690, 150, 770, 280, 730, 450); g.bezierCurveTo(690, 330, 600, 270, 520, 260); g.bezierCurveTo(450, 290, 360, 320, 270, 450);
    }
    g.closePath(); g.fill(); g.stroke();
  }
  return c;
}

const save = async (c: ReturnType<typeof createCanvas>, p: string) => writeFileSync(p, await c.encode("png"));
for (const e of ["normal", "surprised", "shock"] as Expr[]) await save(character("taro", e), `${out}/taro/${e}.png`);
for (const e of ["smile", "back", "normal"] as Expr[]) await save(character("hanako", e), `${out}/hanako/${e}.png`);

// corridor background (line art, perspective)
{
  const W = 2400, H = 1600; const c = createCanvas(W, H); const g = c.getContext("2d");
  g.fillStyle = "#fff"; g.fillRect(0, 0, W, H); g.strokeStyle = "#111"; g.lineWidth = 4;
  const vx = 1300, vy = 700;
  for (const [x, y] of [[0, 0], [W, 0], [0, H], [W, H]]) { g.beginPath(); g.moveTo(vx, vy); g.lineTo(x, y); g.stroke(); }
  g.strokeRect(vx - 260, vy - 180, 520, 360);
  for (let i = 0; i < 9; i++) { const t = i / 9; const x = vx - 260 - (vx - 260) * t * 1.0; g.beginPath(); g.moveTo(x, vy - 180 - (vy - 180) * t); g.lineTo(x, vy + 180 + (H - vy - 180) * t); g.stroke(); }
  for (let i = 0; i < 6; i++) { const t = (i + 1) / 7; const x = vx + 260 + (W - vx - 260) * t; g.beginPath(); g.moveTo(x, vy - 180 - (vy - 180) * t); g.lineTo(x, vy + 180 + (H - vy - 180) * t); g.stroke(); }
  g.lineWidth = 2; for (let i = 0; i < 14; i++) { const y = vy + 180 + (H - vy - 180) * Math.pow(i / 14, 1.6); g.beginPath(); g.moveTo(0, y + (vy - y) * 0); g.lineTo(W, y); g.stroke(); }
  // windows
  g.lineWidth = 3; for (let i = 0; i < 4; i++) { const x0 = 1700 + i * 170; g.strokeRect(x0, 300 - i * 40, 120, 260 + i * 60); }
  await save(c, `${out}/bg/corridor.png`);
}
// classroom (gray tones, photo-like)
{
  const W = 2400, H = 1600; const c = createCanvas(W, H); const g = c.getContext("2d");
  const gr = g.createLinearGradient(0, 0, 0, H); gr.addColorStop(0, "#e8e8e8"); gr.addColorStop(1, "#b8b8b8"); g.fillStyle = gr; g.fillRect(0, 0, W, H);
  g.fillStyle = "#8a8a8a"; g.fillRect(0, 1100, W, 500);
  g.fillStyle = "#f6f6f6"; for (let i = 0; i < 4; i++) g.fillRect(150 + i * 560, 180, 420, 600);
  g.strokeStyle = "#555"; g.lineWidth = 6; for (let i = 0; i < 4; i++) { g.strokeRect(150 + i * 560, 180, 420, 600); g.beginPath(); g.moveTo(360 + i * 560, 180); g.lineTo(360 + i * 560, 780); g.stroke(); }
  g.fillStyle = "#6a6a6a"; for (let r = 0; r < 3; r++) for (let i = 0; i < 6; i++) g.fillRect(100 + i * 390 + r * 30, 1000 + r * 180, 300, 40);
  await save(c, `${out}/bg/classroom.png`);
}
// cats & owner for sns example (simple)
for (const [name, expr] of [["cat_sleep", "smile"], ["cat_wake", "surprised"], ["cat_run", "normal"]] as const) {
  const c = createCanvas(900, 700); const g = c.getContext("2d"); g.lineWidth = 10; g.strokeStyle = "#3b2f2f"; g.fillStyle = "#f2c38b"; g.lineJoin = "round";
  g.beginPath(); g.ellipse(470, 470, 300, 170, 0, 0, Math.PI * 2); g.fill(); g.stroke();
  g.beginPath(); g.ellipse(360, 320, 170, 150, 0, 0, Math.PI * 2); g.fill(); g.stroke();
  g.beginPath(); g.moveTo(230, 230); g.lineTo(250, 110); g.lineTo(320, 190); g.moveTo(400, 180); g.lineTo(470, 100); g.lineTo(490, 230); g.fill(); g.stroke();
  g.fillStyle = "#3b2f2f"; if (expr === "smile") { g.beginPath(); g.arc(300, 320, 25, Math.PI * 1.1, Math.PI * 1.9); g.arc(420, 320, 25, Math.PI * 1.1, Math.PI * 1.9); g.stroke(); } else { g.beginPath(); g.arc(300, 310, expr === "surprised" ? 26 : 16, 0, Math.PI * 2); g.arc(420, 310, expr === "surprised" ? 26 : 16, 0, Math.PI * 2); g.fill(); }
  await save(c, `${out}/${name}.png`);
}
{
  const c = character("hanako", "normal"); await save(c, `${out}/owner.png`);
}
console.log("ok");
