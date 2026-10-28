// dsh-decay-memory —— 会淡忘的记忆（DeepSeek Harness 插件）
//
// 设计来自一张「小肥鱼大脑」的图：记忆是一条条神经元，被提起就重新点亮，
// 不被提起就随时间一点点淡下去——先缩短，最后剩下省略号消失。
//
// 每条记忆：
//   id        短 id，工具里用来引用
//   text      正文
//   category  topic | fact | preference | todo | impression | other
//   pinned    true = 📌 永不淡忘、永不淘汰
//   w         强度（0~1），每次被提起 +0.4，封顶 1
//   ts        最近一次被提起的时间（毫秒）
//   n         被提起的次数
//
// 当前强度 = w * 0.5 ^ (已过天数 / halfLifeDays)   （默认半衰期 200 天）
//   强度 >= fadeBelow        → 完整显示
//   强度 <  fadeBelow        → 正文按比例缩短，标「（记忆渐淡）」
//   强度 <  dropBelow        → 真正删除（📌 除外）
//
// 对模型暴露的工具：memory_add / memory_search / memory_touch / memory_forget /
// memory_pin / memory_stats。每轮把排在前面的记忆注入系统提示词。

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { renderPage } from './page.js';

export const name = 'dsh-decay-memory';
export const inject = ['systemPrompt', 'tools', 'webServer'];

const DEFAULTS = {
  halfLifeDays: 200,
  fadeBelow: 0.5,
  dropBelow: 0.06,
  maxEntries: 24,
  promptMaxEntries: 12,
  promptMaxChars: 2000,
  promptEnabled: true,
  stateFile: ''
};

const CATEGORIES = ['topic', 'fact', 'preference', 'todo', 'impression', 'other'];

function cfgOf(config) {
  const c = { ...DEFAULTS };
  for (const key of Object.keys(DEFAULTS)) {
    const v = config?.[key];
    if (v === undefined || v === null) continue;
    if (key === 'stateFile' || key === 'promptEnabled') c[key] = v;
    else {
      const n = Number(v);
      if (Number.isFinite(n)) c[key] = n;
    }
  }
  c.halfLifeDays = Math.max(1, c.halfLifeDays);
  c.fadeBelow = Math.min(0.99, Math.max(0.05, c.fadeBelow));
  c.dropBelow = Math.min(0.5, Math.max(0.005, c.dropBelow));
  c.maxEntries = Math.max(4, Math.min(200, Math.round(c.maxEntries)));
  c.promptMaxEntries = Math.max(1, Math.min(50, Math.round(c.promptMaxEntries)));
  c.promptMaxChars = Math.max(200, Math.min(20000, Math.round(c.promptMaxChars)));
  return c;
}

function statePath(config) {
  const custom = String(config?.stateFile || '').trim();
  if (custom) return custom;
  const home = process.env.DSH_HOME || path.join(os.homedir(), '.dsh');
  return path.join(home, 'decay-memory', 'memory.json');
}

function loadState(file) {
  try {
    const raw = fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, '');
    const parsed = JSON.parse(raw);
    const entries = Array.isArray(parsed?.entries) ? parsed.entries : [];
    return {
      version: 1,
      settings: parsed?.settings && typeof parsed.settings === 'object' ? parsed.settings : {},
      entries: entries
        .filter((e) => e && typeof e.text === 'string' && e.text.trim())
        .map((e) => ({
          id: String(e.id || newId()),
          text: String(e.text).slice(0, 2000),
          category: CATEGORIES.includes(e.category) ? e.category : 'other',
          pinned: e.pinned === true,
          w: Number.isFinite(Number(e.w)) ? Math.min(1, Math.max(0, Number(e.w))) : 1,
          ts: Number.isFinite(Number(e.ts)) ? Number(e.ts) : Date.now(),
          n: Number.isFinite(Number(e.n)) ? Number(e.n) : 0,
          createdAt: Number.isFinite(Number(e.createdAt)) ? Number(e.createdAt) : Date.now()
        }))
    };
  } catch {
    return { version: 1, entries: [] };
  }
}

function saveState(file, state) {
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const tmp = `${file}.tmp-${process.pid}-${Date.now()}`;
    fs.writeFileSync(tmp, JSON.stringify(state, null, 1), 'utf8');
    fs.renameSync(tmp, file);
    return true;
  } catch {
    return false;
  }
}

function newId() {
  return randomBytes(4).toString('hex');
}

function weightOf(entry, cfg) {
  if (entry.pinned) return 1;
  const days = Math.max(0, (Date.now() - (Number(entry.ts) || Date.now())) / 86400000);
  return (Number(entry.w) || 0) * Math.pow(0.5, days / cfg.halfLifeDays);
}

function touchEntry(entry, cfg, boost = 0.4) {
  // 「提起即点亮」：在当前（已衰减的）强度上加一点，封顶 1；时间戳刷新为现在。
  const current = weightOf(entry, cfg);
  entry.w = Math.min(1, Math.max(0, current) + boost);
  entry.ts = Date.now();
  entry.n = (Number(entry.n) || 0) + 1;
}

function fadeText(text, weight, cfg) {
  const raw = String(text || '');
  if (weight >= cfg.fadeBelow) return { text: raw, faded: false };
  const ratio = Math.max(0.12, weight / cfg.fadeBelow);
  const keep = Math.max(6, Math.round(raw.length * ratio));
  return { text: `${raw.slice(0, keep)}…`, faded: true };
}

function sortByWeight(entries, cfg) {
  return entries
    .map((e) => ({ e, w: weightOf(e, cfg) }))
    .sort((a, b) => {
      if (a.e.pinned !== b.e.pinned) return a.e.pinned ? -1 : 1;
      return b.w - a.w;
    });
}

function prune(state, cfg) {
  // 1) 太弱的直接消失（📌 永不淘汰）
  state.entries = state.entries.filter((e) => e.pinned || weightOf(e, cfg) >= cfg.dropBelow);
  // 2) 超过上限时先忘最弱的一条
  while (state.entries.length > cfg.maxEntries) {
    let worst = -1;
    let worstW = Infinity;
    for (let i = 0; i < state.entries.length; i++) {
      const e = state.entries[i];
      if (e.pinned) continue;
      const w = weightOf(e, cfg);
      if (w < worstW) {
        worstW = w;
        worst = i;
      }
    }
    if (worst < 0) break;
    state.entries.splice(worst, 1);
  }
}

function findEntry(state, ref) {
  const r = String(ref || '').trim();
  if (!r) return null;
  return (
    state.entries.find((e) => e.id === r) ||
    state.entries.find((e) => e.text === r) ||
    state.entries.find((e) => e.text.includes(r)) ||
    null
  );
}

function grams(text) {
  const t = String(text || '').replace(/[^\p{Script=Han}A-Za-z0-9]/gu, '');
  const out = new Set();
  for (let i = 0; i + 1 < t.length; i++) out.add(t.slice(i, i + 2));
  return out;
}

function touchByText(state, text, cfg, boost = 0.4) {
  const body = grams(text);
  if (body.size < 2) return [];
  const touched = [];
  for (const entry of state.entries) {
    if (entry.pinned) continue;
    const eg = grams(entry.text);
    let overlap = 0;
    for (const g of eg) {
      if (body.has(g)) {
        overlap++;
        if (overlap >= 2) break;
      }
    }
    if (overlap >= 2) {
      touchEntry(entry, cfg, boost);
      touched.push(entry);
    }
  }
  return touched;
}

function formatForPrompt(state, cfg) {
  const ranked = sortByWeight(state.entries, cfg).slice(0, cfg.promptMaxEntries);
  if (!ranked.length) return '';
  const lines = ['【记忆（会随时间淡忘：被提起就变牢，不提就慢慢变短）】'];
  for (const { e, w } of ranked) {
    const pinMark = e.pinned ? '📌' : '';
    const fade = fadeText(e.text, w, cfg);
    const fadeMark = fade.faded ? '（记忆渐淡）' : '';
    const ageMin = Math.max(0, Math.round((Date.now() - (e.ts || Date.now())) / 60000));
    const ago = ageMin < 60 ? '刚刚' : ageMin < 1440 ? `${Math.round(ageMin / 60)}小时前` : `${Math.round(ageMin / 1440)}天前`;
    lines.push(`- [${e.id}] ${pinMark}${fade.text}${fadeMark}（${e.category}；${ago}）`);
  }
  let text = lines.join('\n');
  if (text.length > cfg.promptMaxChars) text = `${text.slice(0, cfg.promptMaxChars)}\n…（更多记忆被省略）`;
  return text;
}

function textOutput(value) {
  return [{ type: 'text', text: typeof value === 'string' ? value : JSON.stringify(value, null, 2) }];
}

const OBJECT_OUTPUT = { type: 'object', additionalProperties: true };

/**
 * @param {import('@deepseek-ai/cordis').Context} ctx
 * @param {object} config
 */
export function apply(ctx, config) {
  const file = statePath(cfgOf(config));
  let state = loadState(file);
  let cfg = cfgOf({ ...config, ...(state.settings || {}) });

  const persist = () => {
    prune(state, cfg);
    saveState(file, state);
  };

  // ── 每轮注入记忆 ───────────────────────────────────────────────
  if (cfg.promptEnabled) {
    ctx.inject(['systemPrompt'], (prompted) => {
      prompted.get('systemPrompt').section({
        name: 'decay-memory',
        order: 149,
        text: () => formatForPrompt(state, cfg)
      });
    });
  }

  // ── 模型工具面 ────────────────────────────────────────────────
  ctx.tools.register({
    name: 'memory_add',
    description: '记住一件事。已经存在的相同内容会被「重新点亮」而不是重复添加。pinned 的条目永不淡忘。',
    parameters: {
      type: 'object',
      properties: {
        text: { type: 'string', description: '要记住的内容，尽量具体、可复用（人名/约定/偏好/待办）。' },
        category: { type: 'string', enum: CATEGORIES, description: '记忆类别，默认 other。' },
        pinned: { type: 'boolean', description: 'true = 📌 永久保留，永不淡忘。' }
      },
      required: ['text']
    },
    output: { schema: OBJECT_OUTPUT, render: (_a, v) => textOutput(v) },
    execute: async (args) => {
      const text = String(args?.text || '').trim();
      if (!text) throw new Error('text 不能为空');
      const category = CATEGORIES.includes(args?.category) ? args.category : 'other';
      const existing = state.entries.find((e) => e.text === text);
      if (existing) {
        touchEntry(existing, cfg, 0.4);
        if (args?.pinned === true) existing.pinned = true;
        persist();
        return { ok: true, action: 'touched', id: existing.id, weight: Number(weightOf(existing, cfg).toFixed(3)) };
      }
      const entry = {
        id: newId(),
        text: text.slice(0, 2000),
        category,
        pinned: args?.pinned === true,
        w: 1,
        ts: Date.now(),
        n: 1,
        createdAt: Date.now()
      };
      state.entries.push(entry);
      persist();
      return { ok: true, action: 'added', id: entry.id, count: state.entries.length };
    }
  });

  ctx.tools.register({
    name: 'memory_search',
    description: '检索记忆（按强度和文字匹配排序）。检索到时会把这些记忆重新点亮。',
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string', description: '关键词或一句话。留空则按强度列出前几条。' },
        limit: { type: 'number', description: '最多返回几条，默认 8。' }
      }
    },
    output: { schema: OBJECT_OUTPUT, render: (_a, v) => textOutput(v) },
    execute: async (args) => {
      const limit = Math.max(1, Math.min(30, Math.round(Number(args?.limit) || 8)));
      const q = String(args?.query || '').trim();
      const qg = grams(q);
      const hits = [];
      for (const e of state.entries) {
        let score = weightOf(e, cfg);
        if (qg.size >= 2) {
          const eg = grams(e.text);
          let overlap = 0;
          for (const g of eg) if (qg.has(g)) overlap++;
          if (overlap === 0) continue;
          score += Math.min(1, overlap / 10);
        } else if (!q) {
          // 空查询 = 按强度列
        } else {
          if (!e.text.includes(q)) continue;
          score += 0.2;
        }
        if (e.pinned) score += 0.5;
        hits.push({ e, score });
      }
      hits.sort((a, b) => b.score - a.score);
      const selected = hits.slice(0, limit);
      for (const { e } of selected) touchEntry(e, cfg, 0.4);
      persist();
      if (!selected.length) return { ok: true, found: 0, items: [] };
      return {
        ok: true,
        found: selected.length,
        items: selected.map(({ e }) => ({
          id: e.id,
          text: fadeText(e.text, weightOf(e, cfg), cfg).text,
          category: e.category,
          pinned: e.pinned,
          weight: Number(weightOf(e, cfg).toFixed(3)),
          touched: e.n
        }))
      };
    }
  });

  ctx.tools.register({
    name: 'memory_touch',
    description: '把一条记忆重新点亮（当对话里又提到了它）。',
    parameters: {
      type: 'object',
      properties: {
        ref: { type: 'string', description: '记忆 id 或正文片段。' }
      },
      required: ['ref']
    },
    output: { schema: OBJECT_OUTPUT, render: (_a, v) => textOutput(v) },
    execute: async (args) => {
      const entry = findEntry(state, args?.ref);
      if (!entry) return { ok: false, error: '没找到这条记忆' };
      touchEntry(entry, cfg, 0.4);
      persist();
      return { ok: true, id: entry.id, weight: Number(weightOf(entry, cfg).toFixed(3)), times: entry.n };
    }
  });

  ctx.tools.register({
    name: 'memory_forget',
    description: '删掉一条记忆（真删，不可恢复）。一般不用，太弱的东西会自己淡掉。',
    parameters: {
      type: 'object',
      properties: { ref: { type: 'string', description: '记忆 id 或正文片段。' } },
      required: ['ref']
    },
    output: { schema: OBJECT_OUTPUT, render: (_a, v) => textOutput(v) },
    execute: async (args) => {
      const entry = findEntry(state, args?.ref);
      if (!entry) return { ok: false, error: '没找到这条记忆' };
      if (entry.pinned) return { ok: false, error: '这条是 📌 永久记忆，先取消 pin 才能删' };
      state.entries = state.entries.filter((e) => e.id !== entry.id);
      persist();
      return { ok: true, removed: entry.id };
    }
  });

  ctx.tools.register({
    name: 'memory_pin',
    description: '把一条记忆设为/取消 📌 永久保留（永不淡忘、永不淘汰）。',
    parameters: {
      type: 'object',
      properties: {
        ref: { type: 'string', description: '记忆 id 或正文片段。' },
        pinned: { type: 'boolean', description: 'true = 永久保留；false = 取消。默认 true。' }
      },
      required: ['ref']
    },
    output: { schema: OBJECT_OUTPUT, render: (_a, v) => textOutput(v) },
    execute: async (args) => {
      const entry = findEntry(state, args?.ref);
      if (!entry) return { ok: false, error: '没找到这条记忆' };
      entry.pinned = args?.pinned !== false;
      if (entry.pinned) {
        entry.w = 1;
        entry.ts = Date.now();
      }
      persist();
      return { ok: true, id: entry.id, pinned: entry.pinned };
    }
  });

  ctx.tools.register({
    name: 'memory_stats',
    description: '看一眼记忆系统的状态：条数、📌 数、最弱/最强的几条（用于判断该不该清理）。',
    parameters: { type: 'object', properties: {} },
    output: { schema: OBJECT_OUTPUT, render: (_a, v) => textOutput(v) },
    execute: async () => {
      const ranked = sortByWeight(state.entries, cfg);
      return {
        ok: true,
        page: '/decay-memory',
        halfLifeDays: cfg.halfLifeDays,
        count: state.entries.length,
        pinned: state.entries.filter((e) => e.pinned).length,
        weakest: ranked.slice(-3).reverse().map(({ e, w }) => ({ id: e.id, text: e.text.slice(0, 30), weight: Number(w.toFixed(3)) })),
        strongest: ranked.slice(0, 3).map(({ e, w }) => ({ id: e.id, text: e.text.slice(0, 30), weight: Number(w.toFixed(3)) }))
      };
    }
  });


  // ── 设置页（host 直接提供 HTML + JSON API，不需要打包 client 插件）──────
  const stateView = () => ({
    ok: true,
    config: {
      halfLifeDays: cfg.halfLifeDays,
      fadeBelow: cfg.fadeBelow,
      dropBelow: cfg.dropBelow,
      maxEntries: cfg.maxEntries,
      promptMaxEntries: cfg.promptMaxEntries,
      promptMaxChars: cfg.promptMaxChars,
      promptEnabled: cfg.promptEnabled,
      stateFile: file
    },
    entries: sortByWeight(state.entries, cfg).map(({ e, w }) => ({
      id: e.id,
      text: e.text,
      category: e.category,
      pinned: e.pinned,
      weight: Number(w.toFixed(3)),
      faded: w < cfg.fadeBelow,
      ts: e.ts,
      n: e.n,
      createdAt: e.createdAt
    })),
    pinnedCount: state.entries.filter((e) => e.pinned).length
  });

  const json = (response, code, obj) => {
    const body = Buffer.from(JSON.stringify(obj), 'utf8');
    response.writeHead(code, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
    response.end(body);
  };

  const readJson = (request) =>
    new Promise((resolve, reject) => {
      const chunks = [];
      let size = 0;
      request.on('data', (c) => {
        size += c.length;
        if (size > 64 * 1024) {
          reject(new Error('请求体太大'));
          request.destroy();
          return;
        }
        chunks.push(c);
      });
      request.on('end', () => {
        try {
          resolve(chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {});
        } catch {
          reject(new Error('请求体不是合法 JSON'));
        }
      });
      request.on('error', reject);
    });

  const applySettings = (patch) => {
    const next = { ...(state.settings || {}) };
    for (const key of ['halfLifeDays', 'fadeBelow', 'dropBelow', 'maxEntries', 'promptMaxEntries', 'promptMaxChars']) {
      const n = Number(patch?.[key]);
      if (Number.isFinite(n)) next[key] = n;
    }
    if (typeof patch?.promptEnabled === 'boolean') next.promptEnabled = patch.promptEnabled;
    state.settings = next;
    cfg = cfgOf({ ...config, ...next });
    saveState(file, state);
  };

  const handleAction = (body) => {
    const op = String(body?.op || '');
    if (op === 'add') {
      const text = String(body?.text || '').trim();
      if (!text) throw new Error('text 不能为空');
      const existing = state.entries.find((e) => e.text === text);
      if (existing) {
        touchEntry(existing, cfg, 0.4);
      } else {
        state.entries.push({
          id: newId(),
          text: text.slice(0, 2000),
          category: CATEGORIES.includes(body?.category) ? body.category : 'other',
          pinned: body?.pinned === true,
          w: 1,
          ts: Date.now(),
          n: 1,
          createdAt: Date.now()
        });
      }
      persist();
      return stateView();
    }
    const entry = findEntry(state, body?.id);
    if (!entry) throw new Error('没找到这条记忆');
    if (op === 'touch') {
      touchEntry(entry, cfg, 0.4);
    } else if (op === 'pin') {
      entry.pinned = body?.pinned === undefined ? !entry.pinned : body.pinned === true;
      if (entry.pinned) {
        entry.w = 1;
        entry.ts = Date.now();
      }
    } else if (op === 'forget') {
      if (entry.pinned) throw new Error('📌 的记忆先取消 pin 再删');
      state.entries = state.entries.filter((e) => e.id !== entry.id);
    } else {
      throw new Error('未知操作');
    }
    persist();
    return stateView();
  };

  const makeHandler = (kind) => async (request, response) => {
    try {
      if (request.method === 'GET' && kind === 'page') {
        const html = renderPage();
        response.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
        response.end(html);
        return;
      }
      if (request.method === 'GET' && kind === 'state') {
        json(response, 200, stateView());
        return;
      }
      if (request.method === 'POST' && kind === 'config') {
        const body = await readJson(request);
        applySettings(body);
        json(response, 200, stateView());
        return;
      }
      if (request.method === 'POST' && kind === 'action') {
        const body = await readJson(request);
        json(response, 200, handleAction(body));
        return;
      }
      response.writeHead(405, { allow: kind === 'page' || kind === 'state' ? 'GET' : 'POST' });
      response.end();
    } catch (error) {
      json(response, 400, { ok: false, error: String(error?.message || error) });
    }
  };

  let disposeRoutes = null;
  ctx.inject(['webServer'], (hostCtx) => {
    const register = (path, kind) => hostCtx.webServer.register({ kind: 'exact', path, handler: makeHandler(kind) });
    const disposers = [
      register('/decay-memory', 'page'),
      register('/decay-memory/api/state', 'state'),
      register('/decay-memory/api/config', 'config'),
      register('/decay-memory/api/action', 'action')
    ];
    disposeRoutes = () => {
      for (const off of disposers) {
        try {
          off?.();
        } catch {}
      }
    };
  });
  if (typeof ctx.on === 'function') {
    ctx.on('dispose', () => {
      try {
        disposeRoutes?.();
      } catch {}
    });
  }
}
// 给本地测试用（不参与 DSH 装配）
export const __test = { cfgOf, weightOf, touchEntry, fadeText, prune, grams, touchByText, formatForPrompt, loadState, saveState };
