import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import noble from '@abandonware/noble';

const BLE_DEVICE_NAMES = new Set(
  (process.env.QWEN_BLE_DEVICE_NAME || 'QwenToken,Qwen Usage')
    .split(',').map(s => s.trim())
);
const SERVICE_UUID = '00112233445566778899aabbccddeeff';
const DATA_CHAR_UUID = '00112233445566778899aabbccddee01';
const INTERVAL_MS = Number(process.env.QWEN_BLE_PUSH_MS ?? 1000);
const RECENT_DAYS = Number(process.env.QWEN_BLE_SCAN_DAYS ?? 7);
const ACTIVE_GAP_MS = 5 * 60 * 1000;
const STATUS_FILE = '/tmp/qwen-token-status.json';
const OFFSET_FILE = '/tmp/qwen-token-offsets.json';

let dataChar = null;
let bleConnected = false;
let bleDevice = '';
let connectedPeripheral = null;
let scanTimer = null;
let pushTimer = null;
let connecting = false;

// Incremental read state: tracks per-file byte offsets and accumulated stats
let fileOffsets = new Map();
let accStats = null;
let accDayStr = '';

function parseEnvFile(file) {
  try {
    const out = {};
    for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
      const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/);
      if (!m) continue;
      out[m[1]] = m[2].replace(/^['"]|['"]$/g, '');
    }
    return out;
  } catch {
    return {};
  }
}

function runtimeDir() {
  const home = os.homedir();
  const qwenHome = process.env.QWEN_HOME ?? parseEnvFile(path.join(home, '.qwen', '.env')).QWEN_HOME ?? path.join(home, '.qwen');
  const homeEnv = parseEnvFile(path.join(home, '.env'));
  return process.env.QWEN_RUNTIME_DIR ?? parseEnvFile(path.join(qwenHome, '.env')).QWEN_RUNTIME_DIR ?? homeEnv.QWEN_RUNTIME_DIR ?? qwenHome;
}

function usageFiles() {
  const dir = path.join(runtimeDir(), 'usage');
  const cutoff = Date.now() - (RECENT_DAYS + 1) * 24 * 60 * 60 * 1000;
  const files = [];
  try {
    if (!fs.existsSync(dir)) return files;
    for (const name of fs.readdirSync(dir)) {
      if (!/^token-usage-\d{4}-\d{2}\.jsonl$/.test(name)) continue;
      const file = path.join(dir, name);
      const stat = fs.statSync(file);
      if (stat.mtimeMs >= cutoff) files.push({ file, stat });
    }
  } catch {
    // Keep the bridge alive if a usage file is rotated while scanning.
  }
  return files.sort((a, b) => b.stat.mtimeMs - a.stat.mtimeMs);
}

function loadOffsets() {
  try {
    const raw = fs.readFileSync(OFFSET_FILE, 'utf8');
    const obj = JSON.parse(raw);
    fileOffsets = new Map(Object.entries(obj.offsets ?? {}));
    accStats = obj.accStats ?? null;
    accDayStr = obj.accDayStr ?? '';
  } catch {
    fileOffsets = new Map();
    accStats = null;
    accDayStr = '';
  }
}

function saveOffsets() {
  try {
    fs.writeFileSync(OFFSET_FILE, JSON.stringify({
      offsets: Object.fromEntries(fileOffsets),
      accStats,
      accDayStr,
    }));
  } catch (err) {
    console.error('[offset] save failed:', err.message);
  }
}

function readNewLines(file) {
  const stat = fs.statSync(file);
  const prevOffset = fileOffsets.get(file) ?? 0;
  // File was truncated or rotated — reset offset and read from beginning
  if (stat.size < prevOffset) {
    fileOffsets.set(file, 0);
  }
  const effectiveOffset = fileOffsets.get(file) ?? 0;
  if (stat.size <= effectiveOffset) return '';
  const fd = fs.openSync(file, 'r');
  try {
    const len = stat.size - effectiveOffset;
    const buf = Buffer.alloc(len);
    fs.readSync(fd, buf, 0, len, effectiveOffset);
    fileOffsets.set(file, stat.size);
    let content = buf.toString('utf8');
    // Skip partial first line when resuming mid-file
    if (effectiveOffset > 0) {
      const nl = content.indexOf('\n');
      if (nl >= 0) content = content.slice(nl + 1);
      else content = '';
    }
    return content;
  } finally {
    fs.closeSync(fd);
  }
}

function emptyAcc() {
  return {
    todayTotal: 0, todayInput: 0, todayOutput: 0,
    todayCached: 0, todayThought: 0,
    callsToday: 0, weekTotal: 0,
    sessions: [], sessionEvents: {}, modelTotals: {},
    latest: null,
  };
}

function clampPct(n) {
  return Math.max(0, Math.min(100, Math.round(n)));
}

function formatStamp(ms) {
  const d = new Date(ms);
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  const hh = String(d.getHours()).padStart(2, '0');
  const mi = String(d.getMinutes()).padStart(2, '0');
  const ss = String(d.getSeconds()).padStart(2, '0');
  return `${mm}-${dd} ${hh}:${mi}:${ss}`;
}

function modelName(rec) {
  return String(rec.model ?? 'qwen').replace(/[|\r\n]/g, ' ').trim().slice(0, 23) || 'qwen';
}

function activeMinutes(sessionEvents) {
  let activeMs = 0;
  for (const events of sessionEvents.values()) {
    events.sort((a, b) => a - b);
    for (let i = 1; i < events.length; i++) {
      const delta = events[i] - events[i - 1];
      if (delta > 0) activeMs += Math.min(delta, ACTIVE_GAP_MS);
    }
  }
  return Math.round(activeMs / 60000);
}

function topModels(modelTotals, todayTotal) {
  const rows = [...modelTotals.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 3)
    .map(([model, total]) => ({
      model,
      pct: todayTotal > 0 ? clampPct((total / todayTotal) * 100) : 0,
    }));
  while (rows.length < 3) rows.push({ model: '--', pct: 0 });
  return rows;
}

function buildReport() {
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const yyyy = today.getFullYear();
  const mm = String(today.getMonth() + 1).padStart(2, '0');
  const dd = String(today.getDate()).padStart(2, '0');
  const todayDateStr = `${yyyy}-${mm}-${dd}`;
  const weekCutoff = Date.now() - RECENT_DAYS * 24 * 60 * 60 * 1000;
  const files = usageFiles();

  // Reset accumulated stats on day change
  if (!accStats || accDayStr !== todayDateStr) {
    accStats = emptyAcc();
    accDayStr = todayDateStr;
    fileOffsets.clear();
  }

  // Incremental read: only process new bytes since last scan
  for (const { file } of files) {
    const content = readNewLines(file);
    if (!content) continue;
    for (const line of content.split(/\r?\n/)) {
      if (!line.trim()) continue;
      let rec;
      try {
        rec = JSON.parse(line);
      } catch {
        continue;
      }
      if (typeof rec.inputTokens !== 'number') continue;

      const ts = Date.parse(rec.timestamp ?? '');
      const isToday = rec.localDate === todayDateStr;
      const isWeek = Number.isFinite(ts) && ts >= weekCutoff;

      if (isToday) {
        accStats.callsToday++;
        if (rec.sessionId && !accStats.sessions.includes(rec.sessionId)) {
          accStats.sessions.push(rec.sessionId);
        }

        const key = String(rec.sessionId ?? '');
        if (Number.isFinite(ts)) {
          if (!accStats.sessionEvents[key]) accStats.sessionEvents[key] = [];
          accStats.sessionEvents[key].push(ts);
        }

        accStats.todayTotal += rec.totalTokens ?? 0;
        accStats.todayInput += rec.inputTokens ?? 0;
        accStats.todayOutput += rec.outputTokens ?? 0;
        accStats.todayCached += rec.cachedTokens ?? 0;
        accStats.todayThought += rec.thoughtsTokens ?? 0;

        const model = modelName(rec);
        accStats.modelTotals[model] = (accStats.modelTotals[model] ?? 0) + (rec.totalTokens ?? 0);
      }

      if (isWeek) {
        accStats.weekTotal += rec.totalTokens ?? 0;
      }

      if (Number.isFinite(ts) && (!accStats.latest || ts > accStats.latest.ts)) {
        accStats.latest = {
          ts,
          input: rec.inputTokens ?? 0,
          total: rec.totalTokens ?? 0,
          model: modelName(rec),
        };
      }
    }
  }

  saveOffsets();

  const now = Date.now();
  const latest = accStats.latest;
  const latestTs = latest?.ts ?? now;
  const modelTotals = new Map(Object.entries(accStats.modelTotals));
  const sessionEvents = new Map(Object.entries(accStats.sessionEvents));
  const models = topModels(modelTotals, accStats.todayTotal);
  return {
    todayTotal: accStats.todayTotal,
    ctxPct: 0,
    callsToday: accStats.callsToday,
    errorsToday: 0,
    sessionsToday: accStats.sessions.length,
    cacheRate: accStats.todayInput > 0 ? clampPct((accStats.todayCached / accStats.todayInput) * 100) : 0,
    activeMinutes: activeMinutes(sessionEvents),
    currentTokens: latest?.input ?? 0,
    lastCallTokens: latest?.total ?? 0,
    todayInput: accStats.todayInput,
    todayOutput: accStats.todayOutput,
    todayCached: accStats.todayCached,
    todayThought: accStats.todayThought,
    model: latest?.model ?? 'qwen',
    models,
    updatedAt: formatStamp(now),
    ageSec: Math.max(0, Math.round((now - latestTs) / 1000)),
    weekTotal: accStats.weekTotal,
  };
}

function toPayload(r) {
  return [
    3,
    r.todayTotal,
    r.sessionsToday,
    r.todayCached,
    r.cacheRate,
    r.activeMinutes,
    r.updatedAt,
    r.models[0].model,
    r.models[0].pct,
    r.models[1].model,
    r.models[1].pct,
    r.models[2].model,
    r.models[2].pct,
    r.errorsToday,
    r.ageSec,
    r.todayOutput,
    r.weekTotal,
    r.todayInput,
  ].join('|');
}

function writeStatusFile(report) {
  const status = {
    ...report,
    bleConnected,
    bleDevice,
    timestamp: Date.now(),
  };
  try {
    fs.writeFileSync(STATUS_FILE, JSON.stringify(status));
  } catch (err) {
    console.error('[status] write failed:', err.message);
  }
}

async function pushTick() {
  const report = buildReport();
  writeStatusFile(report);
  if (!dataChar) return;
  const payload = toPayload(report);
  await new Promise((resolve, reject) => {
    dataChar.write(Buffer.from(payload), false, (err) => err ? reject(err) : resolve());
  });
  console.log(`[ble] wrote ${payload}`);
}

function startPushLoop() {
  clearInterval(pushTimer);
  pushTick().catch((err) => console.error('[ble] write failed:', err.message));
  pushTimer = setInterval(() => {
    pushTick().catch((err) => console.error('[ble] write failed:', err.message));
  }, INTERVAL_MS);
}

async function discoverCharacteristic(peripheral) {
  const services = await new Promise((resolve, reject) => {
    peripheral.discoverServices([SERVICE_UUID], (err, svcs) => err ? reject(err) : resolve(svcs));
  });
  if (!services[0]) throw new Error('service not found');
  const chars = await new Promise((resolve, reject) => {
    services[0].discoverCharacteristics([DATA_CHAR_UUID], (err, cs) => err ? reject(err) : resolve(cs));
  });
  if (!chars[0]) throw new Error('data characteristic not found');
  return chars[0];
}

function connect(peripheral) {
  if (connecting || dataChar) return;
  connecting = true;
  noble.stopScanning();
  console.log(`[ble] connecting ${peripheral.advertisement.localName ?? peripheral.id}`);

  const timeout = setTimeout(() => {
    console.error('[ble] connect timeout');
    try { peripheral.disconnect(); } catch {}
    connecting = false;
    startScan();
  }, 10000);

  peripheral.connect(async (err) => {
    clearTimeout(timeout);
    connecting = false;
    if (err) {
      console.error('[ble] connect failed:', err.message);
      startScan();
      return;
    }
    connectedPeripheral = peripheral;
    bleDevice = peripheral.advertisement.localName ?? 'unknown';
    peripheral.once('disconnect', () => {
      console.log('[ble] disconnected');
      dataChar = null;
      connectedPeripheral = null;
      bleConnected = false;
      startScan();
    });
    try {
      dataChar = await discoverCharacteristic(peripheral);
      bleConnected = true;
      console.log('[ble] ready');
    } catch (e) {
      console.error('[ble] discover failed:', e.message);
      try { peripheral.disconnect(); } catch {}
      startScan();
    }
  });
}

function startScan() {
  if (dataChar || connecting) return;
  clearTimeout(scanTimer);
  console.log(`[ble] scanning for ${[...BLE_DEVICE_NAMES].join(' or ')}`);
  try {
    noble.startScanning([], false);
  } catch (e) {
    console.error('[ble] scan start failed:', e.message);
  }
  scanTimer = setTimeout(() => {
    noble.stopScanning();
    startScan();
  }, 15000);
}

noble.on('stateChange', (state) => {
  console.log(`[ble] adapter state: ${state}`);
  if (state === 'poweredOn') startScan();
  else noble.stopScanning();
});

noble.on('discover', (peripheral) => {
  const name = peripheral.advertisement.localName;
  if (!BLE_DEVICE_NAMES.has(name)) return;
  connect(peripheral);
});

loadOffsets();
startPushLoop();

function shutdown() {
  clearInterval(pushTimer);
  clearInterval(scanTimer);
  if (connectedPeripheral) {
    connectedPeripheral.disconnect(() => {
      noble.stopScanning();
      process.exit(0);
    });
    setTimeout(() => process.exit(0), 2000);
  } else {
    process.exit(0);
  }
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
