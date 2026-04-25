#!/usr/bin/env node
/**
 * Drive Dex end-to-end via raw CDP — no MCP dependency.
 * Navigates welcome → project → click "Start Autonomous Loop".
 */
const CDP_PORT = 9333;
const PROJECT_PARENT = "/home/lukas/Projects/Github/lukaskellerstein";
const PROJECT_NAME = "dex-ecommerce";

const resp = await fetch(`http://localhost:${CDP_PORT}/json`);
const targets = await resp.json();
const page = targets.find((t) => t.type === "page");
if (!page) {
  console.error("No page target on CDP port", CDP_PORT);
  process.exit(1);
}
const ws = new WebSocket(page.webSocketDebuggerUrl);
let id = 1;
const pending = new Map();
ws.addEventListener("message", (ev) => {
  const msg = JSON.parse(ev.data);
  const r = pending.get(msg.id);
  if (r) {
    pending.delete(msg.id);
    if (msg.error) r.reject(new Error(JSON.stringify(msg.error)));
    else r.resolve(msg.result);
  }
});
function send(method, params = {}) {
  return new Promise((resolve, reject) => {
    const thisId = id++;
    pending.set(thisId, { resolve, reject });
    ws.send(JSON.stringify({ id: thisId, method, params }));
  });
}
await new Promise((r) => ws.addEventListener("open", r, { once: true }));
console.log("[cdp] connected");
await send("Runtime.enable");

async function run(expr) {
  const r = await send("Runtime.evaluate", {
    expression: `(async () => { ${expr} })()`,
    awaitPromise: true,
    returnByValue: true,
  });
  if (r.exceptionDetails) {
    throw new Error("eval: " + JSON.stringify(r.exceptionDetails));
  }
  return r.result.value;
}

async function clickButtonByText(text) {
  return await run(`
    const btn = [...document.querySelectorAll('button')].find(b => b.textContent.trim() === ${JSON.stringify(text)});
    if (!btn) return { clicked: false, text: ${JSON.stringify(text)} };
    btn.click();
    return { clicked: true, text: ${JSON.stringify(text)} };
  `);
}

async function fillInput(placeholderOrIndex, value) {
  return await run(`
    const inputs = [...document.querySelectorAll('input[type="text"], input:not([type])')];
    const i = inputs[${typeof placeholderOrIndex === "number" ? placeholderOrIndex : 0}];
    if (!i) return { filled: false };
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
    setter.call(i, ${JSON.stringify(value)});
    i.dispatchEvent(new Event('input', { bubbles: true }));
    i.dispatchEvent(new Event('change', { bubbles: true }));
    return { filled: true, value: ${JSON.stringify(value)} };
  `);
}

async function snapshot() {
  return await run(`
    const buttons = [...document.querySelectorAll('button')].map(b => b.textContent.trim()).filter(Boolean);
    const inputs = [...document.querySelectorAll('input')].map(i => ({ value: i.value, placeholder: i.placeholder }));
    return { buttons, inputs };
  `);
}

console.log("[cdp] snapshot", await snapshot());

// Fill welcome screen (Location input then Name)
await fillInput(0, PROJECT_PARENT);
await fillInput(1, PROJECT_NAME);
await new Promise((r) => setTimeout(r, 300));

// Click Open Existing (or New — whichever shows)
let r = await clickButtonByText("Open Existing");
if (!r.clicked) r = await clickButtonByText("New");
console.log("[cdp] open:", r);
await new Promise((r) => setTimeout(r, 800));

// Click Start Autonomous Loop
r = await clickButtonByText("Start Autonomous Loop");
console.log("[cdp] start:", r);

ws.close();
