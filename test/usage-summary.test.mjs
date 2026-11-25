import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { collectUsageSummary, parseConversationMetrics } from '../core/daemon.mjs';

let DatabaseSync = null;
try {
  ({ DatabaseSync } = createRequire(import.meta.url)('node:sqlite'));
} catch {}

function encodeVarint(v) {
  const bytes = [];
  let n = BigInt(v);
  while (n >= 0x80n) {
    bytes.push(Number((n & 0x7fn) | 0x80n));
    n >>= 7n;
  }
  bytes.push(Number(n));
  return Buffer.from(bytes);
}

function pbFieldVarint(field, val) {
  return Buffer.concat([encodeVarint((field << 3) | 0), encodeVarint(val)]);
}

function pbFieldBytes(field, buf) {
  return Buffer.concat([encodeVarint((field << 3) | 2), encodeVarint(buf.length), buf]);
}

function makeGenMetadataBlob({ inTok, outTok, cacheRead, maxCtx = 256000 }) {
  const usage = Buffer.concat([
    inTok ? pbFieldVarint(2, inTok) : Buffer.alloc(0),
    outTok ? pbFieldVarint(3, outTok) : Buffer.alloc(0),
    cacheRead ? pbFieldVarint(5, cacheRead) : Buffer.alloc(0)
  ]);
  const ctxWin = pbFieldVarint(4, maxCtx);
  const chatStart = pbFieldBytes(10, ctxWin);
  const ttft = pbFieldVarint(1, 2);
  const stream = pbFieldVarint(1, 4);
  const chat = Buffer.concat([
    pbFieldBytes(4, usage),
    pbFieldBytes(9, chatStart),
    pbFieldBytes(11, ttft),
    pbFieldBytes(12, stream)
  ]);
  return pbFieldBytes(1, chat);
}

function makeStepMetaBlob(unixSec) {
  return pbFieldBytes(1, pbFieldVarint(1, unixSec));
}

test('[usage-summary] aggregates cross-day conversation DB accurately into 14-day ledger and detects cache collapse', { skip: !DatabaseSync }, () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ac-usage-test-'));
  try {
    const convDir = path.join(tmp, 'conversations');
    const cacheFile = path.join(tmp, 'usage-ledger-cache.json');
    fs.mkdirSync(convDir, { recursive: true });

    const cid = '33333333-4444-5555-6666-777777777777';
    const dbPath = path.join(convDir, `${cid}.db`);
    const db = new DatabaseSync(dbPath);
    db.exec(`
      CREATE TABLE gen_metadata (idx INTEGER PRIMARY KEY, data BLOB);
      CREATE TABLE steps (idx INTEGER PRIMARY KEY, step_type INTEGER, metadata BLOB);
    `);

    const nowMs = new Date(2026, 10, 25, 10, 0, 0).getTime(); // 2026-11-25 10:00 local
    const yesterdaySec = Math.floor(new Date(2026, 10, 24, 21, 0, 0).getTime() / 1000);
    const todaySec1 = Math.floor(new Date(2026, 10, 25, 8, 30, 0).getTime() / 1000);
    const todaySec2 = Math.floor(new Date(2026, 10, 25, 9, 0, 0).getTime() / 1000);

    const insGen = db.prepare('INSERT INTO gen_metadata (idx, data) VALUES (?, ?)');
    const insStep = db.prepare('INSERT INTO steps (idx, step_type, metadata) VALUES (?, ?, ?)');

    // Turn 1 (yesterday): warm cache 90% (10k in + 90k cache + 2k out = 102k)
    insStep.run(0, 14, Buffer.alloc(0));
    insStep.run(1, 15, makeStepMetaBlob(yesterdaySec));
    insGen.run(0, makeGenMetadataBlob({ inTok: 10000, cacheRead: 90000, outTok: 2000 }));

    // Turn 2 (today): warm cache 95% (5k in + 95k cache + 1k out = 101k)
    insStep.run(2, 14, Buffer.alloc(0));
    insStep.run(3, 15, makeStepMetaBlob(todaySec1));
    insGen.run(1, makeGenMetadataBlob({ inTok: 5000, cacheRead: 95000, outTok: 1000 }));

    // Turn 3 (today): sharp cache collapse on large input (40k in + 5k cache = 45k ctx, 11.1% hit while session avg >= 75%)
    insStep.run(4, 14, Buffer.alloc(0));
    insStep.run(5, 15, makeStepMetaBlob(todaySec2));
    insGen.run(2, makeGenMetadataBlob({ inTok: 40000, cacheRead: 5000, outTok: 1000 }));
    db.close();

    // 1. Check cache collapse flag in parseConversationMetrics
    const metrics = parseConversationMetrics(cid, convDir);
    assert.equal(metrics.hasData, true);
    assert.equal(metrics.stats.cacheCollapsed, true, 'Hot session dropping to 11.1% on 45k input must flag cacheCollapsed');

    // 2. Check 14-day cross-day aggregation
    const sum = collectUsageSummary({
      days: 14,
      nowMs,
      conversationsDirs: [convDir],
      cacheFile
    });
    assert.equal(sum.ok, true);
    assert.equal(sum.partial, false);
    assert.equal(sum.dailyHistory.length, 14);
    assert.equal(sum.todayDate, '2026-11-25');
    assert.equal(sum.today.totalTokens, 101000 + 46000);
    assert.equal(sum.today.activeSessions, 1);
    assert.equal(sum.today.calls, 2);

    const yest = sum.dailyHistory.find((d) => d.date === '2026-11-24');
    assert.ok(yest);
    assert.equal(yest.totalTokens, 102000);
    assert.equal(yest.cacheHitRate, 90);
    assert.equal(sum.totalWindowTokens, 102000 + 147000);

    // 3. Verify disk cache was persisted
    assert.equal(fs.existsSync(cacheFile), true);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});
