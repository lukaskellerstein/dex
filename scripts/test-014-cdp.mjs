#!/usr/bin/env node
/**
 * 014 UI test driver — drives the running Electron app via raw CDP. No MCP
 * dependency. Used by the test scenarios under `docs/tests/branch-management/`.
 *
 * Subcommands:
 *   open                          — drive welcome screen submit (project name remembered)
 *   snap                          — list testids (badges, deletes, modals, errors, toasts)
 *   eval <expr>                   — evaluate arbitrary JS body (caller supplies `return`)
 *   click <testid>                — synthetic click on element with that testid
 *   rclick <testid>               — synthetic contextmenu on the badge's <rect> child
 *   modal <testid>                — return text+html snippet of element with testid
 *   wait <testid> [ms] [--gone]   — poll for element to appear (or disappear)
 *   reload                        — full page reload (renderer only — does NOT restart main)
 *
 * Examples:
 *   node scripts/test-014-cdp.mjs open
 *   node scripts/test-014-cdp.mjs snap
 *   node scripts/test-014-cdp.mjs rclick "branch-badge-dex/2026-05-04-cflict-a"
 *   node scripts/test-014-cdp.mjs click "promote-confirm"
 *   node scripts/test-014-cdp.mjs wait "resolver-progress-status" 30000
 *   node scripts/test-014-cdp.mjs wait "resolver-progress-status" 5000 --gone
 *   node scripts/test-014-cdp.mjs eval "return await window.dexAPI.checkpoints.listTimeline('/path/to/project');"
 *
 * Exit codes:
 *   0 — success (output is JSON on stdout)
 *   1 — eval threw or no page target
 *   2 — unknown command
 */
const CDP_PORT = 9333;

async function getPage() {
  const resp = await fetch(`http://localhost:${CDP_PORT}/json`);
  const targets = await resp.json();
  const page = targets.find((t) => t.type === "page");
  if (!page) throw new Error("no page target on CDP " + CDP_PORT);
  return page;
}

async function connect() {
  const page = await getPage();
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
  await send("Runtime.enable");
  return {
    eval: async (expr) => {
      const r = await send("Runtime.evaluate", {
        expression: `(async () => { ${expr} })()`,
        awaitPromise: true,
        returnByValue: true,
      });
      if (r.exceptionDetails) {
        throw new Error("eval: " + JSON.stringify(r.exceptionDetails));
      }
      return r.result.value;
    },
    close: () => ws.close(),
  };
}

const argv = process.argv.slice(2);
const cmd = argv[0];
const cdp = await connect();
try {
  if (cmd === "open") {
    const result = await cdp.eval(`
      await new Promise(r => setTimeout(r, 400));
      const submit = document.querySelector('[data-testid="welcome-submit"]');
      if (!submit) return { error: 'no welcome-submit button — already on project page?' };
      submit.click();
      await new Promise(r => setTimeout(r, 1500));
      const badges = [...document.querySelectorAll('[data-testid^="branch-badge-"]')]
        .map(b => b.dataset.testid);
      const deletes = [...document.querySelectorAll('[data-testid^="delete-branch-"]')]
        .filter(el => /^delete-branch-(?!cancel|confirm|lost-steps)/.test(el.dataset.testid))
        .map(b => b.dataset.testid);
      return { badges, deletes };
    `);
    console.log(JSON.stringify(result, null, 2));
  } else if (cmd === "snap") {
    const result = await cdp.eval(`
      const counts = { badges: [], deletes: [], modals: [], context: [] };
      for (const el of document.querySelectorAll('[data-testid]')) {
        const t = el.dataset.testid;
        if (t.startsWith('branch-badge-')) counts.badges.push(t);
        else if (t.startsWith('delete-branch-') && /^delete-branch-(?!cancel|confirm|lost-steps)/.test(t)) counts.deletes.push(t);
        else if (t === 'branch-context-menu' || t.startsWith('promote-menu-item-')) counts.context.push(t);
        else if (t.startsWith('promote-') || t.startsWith('resolver-')) counts.modals.push(t);
        else if (t === 'delete-branch-lost-steps' || t === 'delete-branch-cancel' || t === 'delete-branch-confirm') counts.modals.push(t);
      }
      const alerts = [...document.querySelectorAll('[role="alert"]')].map(a => a.textContent);
      const toasts = [...document.querySelectorAll('[role="status"]')].map(a => a.textContent);
      return { ...counts, alerts, toasts, url: location.href };
    `);
    console.log(JSON.stringify(result, null, 2));
  } else if (cmd === "eval") {
    const expr = argv.slice(1).join(" ");
    const result = await cdp.eval(expr);
    console.log(JSON.stringify(result, null, 2));
  } else if (cmd === "click") {
    const testid = argv[1];
    const result = await cdp.eval(`
      const el = document.querySelector('[data-testid="' + ${JSON.stringify(testid)} + '"]');
      if (!el) return { found: false };
      el.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
      return { found: true };
    `);
    console.log(JSON.stringify(result, null, 2));
  } else if (cmd === "rclick") {
    const testid = argv[1];
    const result = await cdp.eval(`
      const el = document.querySelector('[data-testid="' + ${JSON.stringify(testid)} + '"]');
      if (!el) return { found: false };
      const target = el.querySelector('rect') ?? el;
      target.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 200, clientY: 200 }));
      return { found: true };
    `);
    console.log(JSON.stringify(result, null, 2));
  } else if (cmd === "modal") {
    const testid = argv[1];
    const result = await cdp.eval(`
      const el = document.querySelector('[data-testid="' + ${JSON.stringify(testid)} + '"]');
      if (!el) return { found: false };
      return { found: true, text: el.textContent.slice(0, 600) };
    `);
    console.log(JSON.stringify(result, null, 2));
  } else if (cmd === "wait") {
    const testid = argv[1];
    const ms = Number(argv[2] ?? 5000);
    const gone = argv.includes("--gone");
    const result = await cdp.eval(`
      const target = ${JSON.stringify(testid)};
      const start = Date.now();
      const deadline = start + ${ms};
      while (Date.now() < deadline) {
        const present = !!document.querySelector('[data-testid="' + target + '"]');
        if (${gone} ? !present : present) {
          return { ok: true, elapsed: Date.now() - start };
        }
        await new Promise(r => setTimeout(r, 200));
      }
      return { ok: false, elapsed: ${ms} };
    `);
    console.log(JSON.stringify(result, null, 2));
  } else if (cmd === "reload") {
    await cdp.eval(`location.reload();`);
    console.log(JSON.stringify({ reloaded: true }));
  } else {
    console.error("unknown cmd: " + cmd);
    console.error("usage: test-014-cdp.mjs <open|snap|eval|click|rclick|modal|wait|reload> [args...]");
    process.exit(2);
  }
} finally {
  cdp.close();
}
