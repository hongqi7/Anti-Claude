/**
 * Regression test suite for v2.6.2 code audit findings (Reports 1 & 2, items #1–#16 + security & minor items).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const INSTALL = path.join(REPO, 'install.mjs');
const HERMETIC_DAEMON_STATE = fs.mkdtempSync(path.join(os.tmpdir(), 'ac-daemon-state-'));
process.env.ANTI_CLAUDE_STATE_DIR = HERMETIC_DAEMON_STATE;
process.on('exit', () => {
  try {
    fs.rmSync(HERMETIC_DAEMON_STATE, { recursive: true, force: true });
  } catch {}
});

let JSDOM = null;
try {
  JSDOM = createRequire(process.env.JSDOM_FROM || import.meta.url)('jsdom').JSDOM;
} catch {}
const skipDom = JSDOM ? false : 'jsdom not installed';

function parseTrailingJson(s) {
  const str = String(s || '');
  const starts = str.startsWith('{') ? [0] : [];
  for (let i = str.indexOf('\n{'); i !== -1; i = str.indexOf('\n{', i + 1)) starts.push(i + 1);
  for (let j = starts.length - 1; j >= 0; j--) {
    try {
      return JSON.parse(str.slice(starts[j]).trim());
    } catch {}
  }
  return null;
}

function makeSandboxHome() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'ac-audit-home-'));
  const agy = path.join(home, '.gemini', 'antigravity');
  fs.mkdirSync(agy, { recursive: true });
  fs.writeFileSync(path.join(agy, 'antigravity_state.pbtxt'), 'product_skin: PRODUCT_SKIN_NON_TECHNICAL\n');
  fs.mkdirSync(path.join(home, '.gemini', 'config'), { recursive: true });
  fs.writeFileSync(
    path.join(home, '.gemini', 'config', 'config.json'),
    JSON.stringify({ userSettings: { verboseConversationSteps: false } })
  );
  fs.writeFileSync(path.join(home, '.gemini', 'AGENTS.md'), '# my global rules\n');
  return {
    home,
    cleanup: () => fs.rmSync(home, { recursive: true, force: true })
  };
}

function runInstallCli(home, args, extraEnv = {}) {
  const r = spawnSync(process.execPath, [INSTALL, ...args], {
    encoding: 'utf8',
    env: {
      ...process.env,
      HOME: home,
      ANTI_CLAUDE_NO_NETWORK: '1',
      ANTI_CLAUDE_NO_LAUNCHD: '1',
      ANTI_CLAUDE_NO_CDP: '1',
      ANTI_CLAUDE_NO_FONTS: '1',
      ANTI_CLAUDE_NO_CLI: '1',
      FAKE_VERIFY_OK: '1',
      ...extraEnv
    }
  });
  return { status: r.status, out: parseTrailingJson(r.stdout), stdout: r.stdout, stderr: r.stderr };
}

/* -------------------------------------------------------------------------- */
/* Daemon, PID, Bootstrap, Project Context, Sidecars, YAML & Security         */
/* -------------------------------------------------------------------------- */

test('[Audit #1 & #9-R2] partial saveProjectContext updates instructions without deleting attachments, and clearing strips --- divider', async () => {
  const daemon = await import(pathToFileURL(path.join(REPO, 'core', 'daemon.mjs')).href);
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ac-proj-partial-'));
  const projDir = path.join(tmpRoot, 'my-proj');
  const linkedDir = path.join(tmpRoot, 'linked-lib');
  const extSrc = path.join(tmpRoot, 'spec.md');
  fs.mkdirSync(projDir, { recursive: true });
  fs.mkdirSync(linkedDir, { recursive: true });
  fs.writeFileSync(extSrc, '# Spec Document\nImportant details.\n');
  fs.writeFileSync(path.join(projDir, 'AGENTS.md'), '# Existing Project Rules\nKeep me intact.\n');

  try {
    const initial = daemon.saveProjectContext({
      dirPath: projDir,
      instructions: 'Initial instructions',
      files: [{ action: 'add', sourcePath: extSrc, name: 'spec.md' }],
      extraFolders: [{ name: 'linked-lib', absPath: linkedDir }]
    });
    assert.equal(initial.ok, true);
    assert.equal(initial.files.length, 1);
    assert.equal(initial.extraFolders.length, 1);
    const managedPath = initial.files[0].absPath;
    assert.equal(fs.existsSync(managedPath), true, 'managed attachment copy created');

    /* Partial update with ONLY `instructions` (omitting `files` and `extraFolders`) must preserve both */
    const afterInstOnly = daemon.saveProjectContext({
      dirPath: projDir,
      instructions: 'Updated instructions only'
    });
    assert.equal(afterInstOnly.ok, true);
    assert.equal(afterInstOnly.instructions, 'Updated instructions only');
    assert.equal(afterInstOnly.files.length, 1, 'attachment preserved on instructions-only save');
    assert.equal(afterInstOnly.extraFolders.length, 1, 'linked folder preserved on instructions-only save');
    assert.equal(fs.existsSync(managedPath), true, 'managed copy on disk still exists');

    /* Clearing all project context removes managed block AND the `---` divider without leaving frontmatter residue */
    const cleared = daemon.saveProjectContext({
      dirPath: projDir,
      instructions: '',
      files: [],
      extraFolders: []
    });
    assert.equal(cleared.ok, true);
    assert.equal(cleared.files.length, 0);
    assert.equal(fs.existsSync(managedPath), false, 'explicit empty files array removes managed copy');
    const finalAgents = fs.readFileSync(path.join(projDir, 'AGENTS.md'), 'utf8');
    assert.equal(finalAgents, '# Existing Project Rules\nKeep me intact.\n');
    assert.equal(finalAgents.startsWith('---'), false, 'no orphan --- left at top of AGENTS.md');
  } finally {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  }
});

test('[Audit #7 & R2-#1] PID management never kills unrelated processes and reclaims stale reused PIDs', async () => {
  const daemon = await import(pathToFileURL(path.join(REPO, 'core', 'daemon.mjs')).href);
  const tmpState = fs.mkdtempSync(path.join(os.tmpdir(), 'ac-pid-test-'));
  const pidFile = path.join(tmpState, 'daemon.pid');
  const killed = [];

  try {
    assert.equal(
      daemon.isOwnDaemonProcess(42424, {
        killProbe: () => true,
        commandReader: () => 'sleep 60'
      }),
      false,
      'sleep 60 is not recognized as Anti-Claude daemon'
    );
    assert.equal(
      daemon.isOwnDaemonProcess(42425, {
        killProbe: () => true,
        commandReader: () => '/opt/homebrew/bin/node /Users/dev/Anti-Claude/core/daemon.mjs --user-dir /x'
      }),
      true,
      'node core/daemon.mjs is recognized as Anti-Claude daemon'
    );

    /* Stale PID reused by unrelated process (`sleep 60`): must NOT send SIGTERM */
    fs.writeFileSync(pidFile, '42424\n');
    daemon.claimPidFile({
      pidFile,
      stateDir: tmpState,
      runOnce: false,
      bindExit: false,
      isDaemonFn: () => false,
      killFn: (pid, sig) => killed.push([pid, sig])
    });
    assert.equal(killed.length, 0, 'unrelated process was not killed');
    assert.equal(fs.readFileSync(pidFile, 'utf8').trim(), String(process.pid));

    /* checkPidOwnership reclaims PID file instead of exiting when owner is a live non-daemon PID */
    fs.writeFileSync(pidFile, '42424\n');
    let supersededCalled = false;
    const status = daemon.checkPidOwnership({
      pidFile,
      stateDir: tmpState,
      runOnce: false,
      isDaemonFn: () => false,
      onSuperseded: () => {
        supersededCalled = true;
      }
    });
    assert.equal(status, 'reclaimed_stale');
    assert.equal(supersededCalled, false);
    assert.equal(fs.readFileSync(pidFile, 'utf8').trim(), String(process.pid));
  } finally {
    fs.rmSync(tmpState, { recursive: true, force: true });
  }
});

test('[Audit #5] macOS cold-boot waitForMacRelaunchReady waits past 900ms SingletonLock release and launches cleanly', async () => {
  const daemon = await import(pathToFileURL(path.join(REPO, 'core', 'daemon.mjs')).href);
  let clockMs = 0;
  let opened = 0;

  const res = await daemon.waitForMacRelaunchReady({
    targetPid: 66954,
    isProcessAlive: () => clockMs < 150, // exits at 150ms
    listMainProcs: async () => [], // no replacement process
    hasLock: () => clockMs < 950, // SingletonLock lingers until 950ms (> 350ms initial settle)
    onReadyToOpen: async () => {
      opened += 1;
    },
    nowFn: () => clockMs,
    sleepFn: async (ms) => {
      clockMs += ms;
    },
    pollMs: 120,
    initialSettleMs: 350
  });

  assert.equal(res.relaunched, true);
  assert.equal(opened, 1, 'relaunch executed once SingletonLock cleared at ~950ms');
  assert.ok(clockMs >= 950 && clockMs < 2000);

  /* Also verify abort when Electron's own replacement process spawns during settle */
  let openedWhenReplaced = 0;
  const replaced = await daemon.waitForMacRelaunchReady({
    targetPid: 66955,
    isProcessAlive: () => false,
    listMainProcs: async () => [{ pid: 67001, age: 0, hasCdp: false }],
    hasLock: () => true,
    onReadyToOpen: async () => {
      openedWhenReplaced += 1;
    },
    nowFn: () => 0,
    sleepFn: async () => {}
  });
  assert.equal(replaced.relaunched, false);
  assert.equal(replaced.reason, 'replaced_by_other_instance');
  assert.equal(openedWhenReplaced, 0);
});

test('[Audit #14 & R2-#8] editing native scheduled task preserves multi-folder workspace_uris; foreign sidecar delete is rejected', async () => {
  const daemon = await import(pathToFileURL(path.join(REPO, 'core', 'daemon.mjs')).href);
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ac-sidecar-test-'));
  const projA = path.join(tmpRoot, 'proj-a');
  const projB = path.join(tmpRoot, 'proj-b');
  const unrelatedDir = path.join(tmpRoot, 'other-proj');
  const sidecarsDir = path.join(tmpRoot, 'sidecars');
  fs.mkdirSync(projA, { recursive: true });
  fs.mkdirSync(projB, { recursive: true });
  fs.mkdirSync(unrelatedDir, { recursive: true });

  try {
    const uriA = pathToFileURL(projA).href;
    const uriB = pathToFileURL(projB).href;
    const uriOther = pathToFileURL(unrelatedDir).href;

    const nativeScDir = path.join(sidecarsDir, 'native-multi-ws');
    fs.mkdirSync(nativeScDir, { recursive: true });
    fs.writeFileSync(
      path.join(nativeScDir, 'sidecar.json'),
      JSON.stringify(
        {
          builtin: 'schedule',
          display_name: 'Old Name',
          description: 'Multi-workspace job',
          args: ['CRON_TZ=Asia/Shanghai 0 9 * * *', 'agentapi', 'new-conversation', '--', 'Check status'],
          restart_policy: 'always',
          agent_permissions: { workspace_uris: [uriA, uriB] }
        },
        null,
        2
      )
    );

    const foreignScDir = path.join(sidecarsDir, 'foreign-automation');
    fs.mkdirSync(foreignScDir, { recursive: true });
    fs.writeFileSync(
      path.join(foreignScDir, 'sidecar.json'),
      JSON.stringify({
        builtin: 'schedule',
        display_name: 'Foreign Job',
        args: ['0 8 * * *', 'agentapi', 'new-conversation', '--', 'Do other work'],
        agent_permissions: { workspace_uris: [uriOther] }
      })
    );

    /* Rename native task without changing folderPath -> both workspace_uris must survive */
    const saved = daemon.saveProjectScheduledTask(
      {
        dirPath: projA,
        task: {
          id: 'sidecar:native-multi-ws',
          sidecarId: 'native-multi-ws',
          name: 'Renamed Multi-WS Job',
          description: 'Multi-workspace job',
          instructions: 'Check status',
          folderPath: projA,
          frequency: 'daily',
          time: '09:00',
          timezone: 'Asia/Shanghai'
        }
      },
      { sidecarsDir }
    );
    assert.equal(saved.ok, true);
    const updatedSc = JSON.parse(fs.readFileSync(path.join(nativeScDir, 'sidecar.json'), 'utf8'));
    assert.equal(updatedSc.display_name, 'Renamed Multi-WS Job');
    assert.deepEqual(updatedSc.agent_permissions.workspace_uris, [uriA, uriB], 'both workspace_uris preserved');

    /* Attempting to delete a sidecar belonging to another project must be blocked */
    const delForeign = daemon.deleteProjectScheduledTask(
      { dirPath: projA, taskId: 'sidecar:foreign-automation', sidecarId: 'foreign-automation' },
      { sidecarsDir }
    );
    assert.equal(delForeign.ok, false);
    assert.equal(delForeign.error, 'sidecar_not_in_project');
    assert.equal(fs.existsSync(foreignScDir), true, 'foreign sidecar untouched');
  } finally {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  }
});

test('[Audit R2-#10] createLocalSkill & createLocalAgent escape colons, hashes, backslashes, and quotes in YAML frontmatter', async () => {
  const daemon = await import(pathToFileURL(path.join(REPO, 'core', 'daemon.mjs')).href);
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ac-yaml-test-'));
  const skillsDir = path.join(tmpRoot, 'skills');
  const agentsDir = path.join(tmpRoot, 'agents');

  try {
    const sk = daemon.createLocalSkill(
      {
        name: 'Audit: Check #1',
        description: 'Path C:\\Users\\test\\notes and "quoted" value',
        instructions: 'Run check.'
      },
      { skillsDir }
    );
    assert.equal(sk.ok, true);
    const skillMd = fs.readFileSync(sk.skillMdPath, 'utf8');
    assert.match(skillMd, /^---\nname: "Audit: Check #1"\ndescription: "Path C:\\\\Users\\\\test\\\\notes and \\"quoted\\" value"\n---/);

    const ag = daemon.createLocalAgent(
      {
        name: 'reviewer-pro',
        description: 'Handles C:\\temp\\x: #tag "safe"',
        systemPrompt: 'Review carefully.'
      },
      { agentsDir }
    );
    assert.equal(ag.ok, true);
    const agentMd = fs.readFileSync(ag.filePath, 'utf8');
    assert.match(agentMd, /description: "Handles C:\\\\temp\\\\x: #tag \\"safe\\""/);
  } finally {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  }
});

test('[Audit #4, #8 & R2-#3, R2-#7] CDP host verification: loading retry, Electron-only probe, context-scoped RPC auth & navigation revocation', async () => {
  const daemon = await import(pathToFileURL(path.join(REPO, 'core', 'daemon.mjs')).href);
  const realWS = globalThis.WebSocket;

  /* 1. Origin & non-Electron Chrome spoofing guards */
  assert.equal(daemon.isAllowedOrigin('file:///Users/alice/Downloads/evil.html'), false, 'arbitrary file:// rejected');
  assert.equal(
    daemon.isAllowedOrigin('file:///Applications/Antigravity.app/Contents/Resources/app/out/vs/code/electron-sandbox/workbench/workbench.html'),
    true
  );
  assert.equal(daemon.isAllowedOrigin('vscode-file://vscode-app/workbench.html'), true);

  if (JSDOM) {
    const spoofDom = new JSDOM('<!doctype html><body data-agy-theme="dark"></body>', {
      runScripts: 'outside-only',
      url: 'http://127.0.0.1:3000/',
      userAgent: 'Mozilla/5.0 Chrome/134.0.0.0 Safari/537.36'
    });
    spoofDom.window.__APP_CONFIG__ = { productName: 'antigravity' };
    assert.equal(
      spoofDom.window.eval(daemon.HOST_IDENTITY_PROBE_EXPR),
      'non_host',
      'regular Chrome tab spoofing __APP_CONFIG__ and data-agy-theme is rejected'
    );
    spoofDom.window.close();
  }

  /* 2. Slow-loading window (`loading` x3) is NOT blacklisted, then attaches once ready;
        subframe context & post-navigation context cannot invoke __agProjectRpc */
  daemon.rebuildBundleIfNeeded();
  daemon.attachedTargets.clear();
  daemon.skippedNonHostTargets.clear();

  let probeMode = 'loading';
  const rpcReplies = [];
  let lastSocket = null;

  class FakeCdpSocket extends EventTarget {
    static OPEN = 1;
    constructor() {
      super();
      this.readyState = 1;
      lastSocket = this;
      queueMicrotask(() => this.dispatchEvent(new Event('open')));
    }
    emitEvent(method, params) {
      this.dispatchEvent(new MessageEvent('message', { data: JSON.stringify({ method, params }) }));
    }
    send(raw) {
      const { id, method, params } = JSON.parse(raw);
      const reply = (result = {}) =>
        this.dispatchEvent(new MessageEvent('message', { data: JSON.stringify({ id, result }) }));
      queueMicrotask(() => {
        if (method === 'Page.getFrameTree') {
          reply({ frameTree: { frame: { id: 'main-frame' } } });
        } else if (method === 'Runtime.enable') {
          this.emitEvent('Runtime.executionContextCreated', {
            context: { id: 101, origin: 'http://127.0.0.1:5199', auxData: { frameId: 'main-frame', isDefault: true, type: 'default' } }
          });
          this.emitEvent('Runtime.executionContextCreated', {
            context: { id: 202, origin: 'https://untrusted.example', auxData: { frameId: 'sub-frame', isDefault: true, type: 'default' } }
          });
          reply({});
        } else if (method === 'Runtime.evaluate') {
          if (String(params.expression).startsWith('window.__ag_project_rpc_resolve &&')) {
            rpcReplies.push(params.expression);
            reply({ result: { value: undefined } });
          } else if (String(params.expression).includes("return 'swarm'")) {
            reply({ result: { value: probeMode } });
          } else {
            reply({ result: { value: 'dark' } });
          }
        } else {
          reply({});
        }
      });
    }
    close() {
      this.readyState = 3;
      this.dispatchEvent(new Event('close'));
    }
  }

  const fakePage = {
    id: 'target-slow-1',
    type: 'page',
    url: 'http://127.0.0.1:5199/',
    webSocketDebuggerUrl: 'ws://127.0.0.1:5199/devtools/page/target-slow-1'
  };
  const fakeEndpoint = { channel: 'test', portFile: '', fallbackPort: 0, conversationsDir: os.tmpdir() };

  try {
    globalThis.WebSocket = FakeCdpSocket;

    /* Pass 1: window returns 'loading' 3 times -> must NOT enter skippedNonHostTargets */
    await daemon.attachTarget(fakePage, fakeEndpoint);
    assert.equal(daemon.attachedTargets.size, 0);
    assert.equal(daemon.skippedNonHostTargets.has(fakePage.id), false, 'loading window is not added to skippedNonHostTargets');

    /* Pass 2: window is now 'host' -> attaches cleanly with main context 101 */
    probeMode = 'host';
    await daemon.attachTarget(fakePage, fakeEndpoint);
    assert.equal(daemon.attachedTargets.size, 1, 'slow window attached on subsequent pass');
    const entry = daemon.attachedTargets.get(fakePage.id);
    assert.equal(entry.trustedContextId, 101);
    assert.ok(entry.rpcToken.length >= 32);

    const tmpProj = fs.mkdtempSync(path.join(os.tmpdir(), 'ac-rpc-sec-'));
    try {
      /* Subframe context (202) attempting RPC even with stolen token -> silently dropped */
      lastSocket.emitEvent('Runtime.bindingCalled', {
        name: '__agProjectRpc',
        executionContextId: 202,
        payload: JSON.stringify({ reqId: 'sub_1', action: 'readContext', payload: { dirPath: tmpProj }, token: entry.rpcToken })
      });
      await new Promise((r) => setTimeout(r, 30));
      assert.equal(rpcReplies.length, 0, 'subframe executionContextId rejected');

      /* Main context (101) without valid token -> rejected with unauthorized_context */
      lastSocket.emitEvent('Runtime.bindingCalled', {
        name: '__agProjectRpc',
        executionContextId: 101,
        payload: JSON.stringify({ reqId: 'bad_tok', action: 'readContext', payload: { dirPath: tmpProj }, token: 'wrong' })
      });
      await new Promise((r) => setTimeout(r, 30));
      assert.equal(rpcReplies.length, 1);
      assert.match(rpcReplies[0], /unauthorized_context/);

      /* Main context (101) with valid token -> succeeds */
      lastSocket.emitEvent('Runtime.bindingCalled', {
        name: '__agProjectRpc',
        executionContextId: 101,
        payload: JSON.stringify({ reqId: 'ok_1', action: 'readContext', payload: { dirPath: tmpProj }, token: entry.rpcToken })
      });
      await new Promise((r) => setTimeout(r, 30));
      assert.equal(rpcReplies.length, 2);
      assert.match(rpcReplies[1], /"ok_1"/);
      assert.match(rpcReplies[1], /"ok":true/);

      /* Top-level navigation to untrusted page immediately revokes authorization */
      const oldToken = entry.rpcToken;
      probeMode = 'non_host';
      lastSocket.emitEvent('Page.frameNavigated', {
        frame: { id: 'main-frame', url: 'https://evil.example/phish' }
      });
      assert.equal(entry.hostConfirmed, false, 'hostConfirmed revoked synchronously on top-level navigation');
      assert.equal(entry.rpcToken, '', 'rpcToken cleared synchronously on top-level navigation');

      lastSocket.emitEvent('Runtime.bindingCalled', {
        name: '__agProjectRpc',
        executionContextId: 101,
        payload: JSON.stringify({ reqId: 'after_nav', action: 'readContext', payload: { dirPath: tmpProj }, token: oldToken })
      });
      await new Promise((r) => setTimeout(r, 90));
      assert.equal(rpcReplies.length, 2, 'post-navigation RPC call blocked');
    } finally {
      fs.rmSync(tmpProj, { recursive: true, force: true });
    }
  } finally {
    for (const [, e] of daemon.attachedTargets.entries()) {
      try {
        e.ws.close();
      } catch {}
    }
    daemon.attachedTargets.clear();
    daemon.skippedNonHostTargets.clear();
    globalThis.WebSocket = realWS;
  }
});

/* -------------------------------------------------------------------------- */
/* Installer, Migration, Backup, CLI Scope, Validation & Subcommand Tests     */
/* -------------------------------------------------------------------------- */

test('[Audit #2 & R2-#2] first-time install preserves standalone theme-patch user files and archives extra custom files', () => {
  const h = makeSandboxHome();
  try {
    const legacyPatchDir = path.join(h.home, '.gemini', 'antigravity', 'theme-patch');
    const legacyUserDir = path.join(legacyPatchDir, 'user');
    fs.mkdirSync(legacyUserDir, { recursive: true });
    fs.writeFileSync(path.join(legacyUserDir, 'custom.css'), '/* standalone theme-patch custom css */\n');
    fs.writeFileSync(path.join(legacyUserDir, 'my-extra-snippet.css'), 'body { --my-var: 1; }\n');

    const inst = runInstallCli(h.home, ['install']);
    assert.equal(inst.status, 0, inst.stderr);
    assert.ok(inst.out.legacyMigration.backupDir, 'standalone theme-patch archived to backupDir');
    assert.equal(
      fs.readFileSync(path.join(inst.out.legacyMigration.backupDir, 'user', 'my-extra-snippet.css'), 'utf8'),
      'body { --my-var: 1; }\n',
      'custom extra file preserved in archive'
    );
    assert.equal(
      fs.readFileSync(path.join(inst.out.legacyMigration.backupDir, 'user', 'custom.css'), 'utf8'),
      '/* standalone theme-patch custom css */\n'
    );

    /* Uninstalling restores the user's pre-existing custom.css */
    const un = runInstallCli(h.home, ['uninstall']);
    assert.equal(un.status, 0, un.stderr);
    assert.equal(
      fs.readFileSync(path.join(h.home, '.gemini', 'antigravity', 'anti-claude', 'user', 'custom.css'), 'utf8'),
      '/* standalone theme-patch custom css */\n',
      'pre-existing standalone custom.css restored on uninstall'
    );
  } finally {
    h.cleanup();
  }
});

test('[Audit #3] migrating from v1 with user-modified CSS preserves modified CSS and writes new template to incoming/', () => {
  const h = makeSandboxHome();
  try {
    const agy = path.join(h.home, '.gemini', 'antigravity');
    const legacyUserDir = path.join(agy, 'theme-patch', 'user');
    const legacyBak = path.join(legacyUserDir, '.backup-before-claude-ux');
    fs.mkdirSync(legacyBak, { recursive: true });
    for (const f of ['custom.css', 'custom.js', 'config.json', 'i18n.override.json']) {
      fs.writeFileSync(path.join(legacyBak, f), `/* stock ${f} */\n`);
      fs.copyFileSync(path.join(REPO, 'user', f), path.join(legacyUserDir, f));
    }
    /* User customized v1 custom.css */
    fs.writeFileSync(path.join(legacyUserDir, 'custom.css'), '/* user v1 custom css modification */\n.my-rule { color: red; }\n');

    const up = runInstallCli(h.home, ['sync-upgrade']);
    assert.equal(up.status, 0, up.stderr);
    const liveCss = fs.readFileSync(path.join(agy, 'anti-claude', 'user', 'custom.css'), 'utf8');
    assert.match(liveCss, /user v1 custom css modification/, 'modified v1 CSS was NOT overwritten');
    assert.equal(
      fs.existsSync(path.join(agy, 'anti-claude', 'incoming', 'custom.css')),
      true,
      'new template saved alongside in incoming/custom.css for comparison'
    );
  } finally {
    h.cleanup();
  }
});

test('[Audit #9 & #10 & R2-#5] --cli-only does not disable existing desktop upgrades; uninstall preserves local-saves backups', () => {
  const h = makeSandboxHome();
  try {
    const cliDir = path.join(h.home, '.gemini', 'antigravity-cli');
    fs.mkdirSync(cliDir, { recursive: true });

    /* 1. Install Desktop first */
    const inst = runInstallCli(h.home, ['install']);
    assert.equal(inst.status, 0, inst.stderr);

    /* 2. Run `install --cli-only` on top of existing Desktop install */
    const cliInst = runInstallCli(h.home, ['install', '--cli-only']);
    assert.equal(cliInst.status, 0, cliInst.stderr);
    assert.equal(cliInst.out.mode, 'desktop+cli', 'existing desktop mode preserved');

    /* Remove desktop custom.css -> sync-upgrade must still restore it! */
    const cssPath = path.join(h.home, '.gemini', 'antigravity', 'anti-claude', 'user', 'custom.css');
    fs.rmSync(cssPath, { force: true });
    const sync = runInstallCli(h.home, ['sync-upgrade', '--force']);
    assert.equal(sync.status, 0, sync.stderr);
    assert.equal(fs.existsSync(cssPath), true, 'desktop CSS restored by sync-upgrade after --cli-only');

    /* Positive flags re-enable previously disabled options */
    runInstallCli(h.home, ['install', '--no-step-unlock', '--no-agents-rule']);
    const reEnabled = runInstallCli(h.home, ['install', '--step-unlock', '--agents-rule']);
    assert.equal(reEnabled.status, 0);
    const st = JSON.parse(
      fs.readFileSync(path.join(h.home, '.gemini', 'antigravity', 'anti-claude', 'install-state.json'), 'utf8')
    );
    assert.equal(st.options.stepUnlock, true);
    assert.equal(st.options.agentsRule, true);

    /* 3. Edit CSS, run `sync-upgrade --overwrite-local` (creates only copy in local-saves/), then `uninstall` */
    fs.appendFileSync(cssPath, '\n/* precious local tweak before overwrite */\n');
    const ov = runInstallCli(h.home, ['sync-upgrade', '--overwrite-local']);
    assert.equal(ov.status, 0);

    const un = runInstallCli(h.home, ['uninstall']);
    assert.equal(un.status, 0, un.stderr);
    assert.ok(un.out.files.savedLocalEdits.length >= 1, 'local-saves backup preserved and listed on uninstall');
    const preservedFile = un.out.files.savedLocalEdits.find((p) => p.endsWith('custom.css'));
    assert.ok(preservedFile && fs.existsSync(preservedFile), 'preserved backup exists outside removed state dir');
    assert.match(fs.readFileSync(preservedFile, 'utf8'), /precious local tweak before overwrite/);
  } finally {
    h.cleanup();
  }
});

test('[Audit #11 & R2-M6] validateSourceRoot rejects missing/corrupt JSON and unknown CLI subcommand exits non-zero', async () => {
  const installer = await import(pathToFileURL(INSTALL).href);
  const fakeRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ac-bad-src-'));
  try {
    fs.mkdirSync(path.join(fakeRoot, 'core'), { recursive: true });
    fs.mkdirSync(path.join(fakeRoot, 'user'), { recursive: true });
    fs.mkdirSync(path.join(fakeRoot, 'cli'), { recursive: true });
    fs.mkdirSync(path.join(fakeRoot, 'rules'), { recursive: true });
    for (const rel of ['install.mjs', 'core/daemon.mjs', 'core/runtime.js', 'user/custom.js', 'cli/statusline.mjs']) {
      fs.writeFileSync(path.join(fakeRoot, rel), 'export const ok = 1;\n');
    }
    fs.writeFileSync(path.join(fakeRoot, 'core', 'base.css'), '/* css */\n');
    fs.writeFileSync(path.join(fakeRoot, 'rules', 'claude-execution-sync.md'), '# rule\n');
    /* 1 invalid JSON + 2 missing JSON files */
    fs.writeFileSync(path.join(fakeRoot, 'core', 'i18n.json'), '{corrupt json');

    const res = installer.validateSourceRoot(fakeRoot);
    assert.equal(res.ok, false, 'validation must fail on corrupt and missing JSON');
    assert.equal(res.problems.length, 3);
  } finally {
    fs.rmSync(fakeRoot, { recursive: true, force: true });
  }

  const h = makeSandboxHome();
  try {
    const typo = runInstallCli(h.home, ['isntall']);
    assert.equal(typo.status, 1, 'unknown subcommand exits with status 1');
    assert.match(JSON.stringify(typo.out), /unknown command: isntall/);
  } finally {
    h.cleanup();
  }
});

/* -------------------------------------------------------------------------- */
/* Runtime, Early Body Injection, Hot-Disable, Projects Drafts & CLI Width    */
/* -------------------------------------------------------------------------- */

test('[Audit #6 & #15 & R2-#4] early pre-body injection mounts full UI once body attaches; hot-disable stops route metrics callbacks', { skip: skipDom }, async () => {
  const runtimeSrc = fs.readFileSync(path.join(REPO, 'core', 'runtime.js'), 'utf8');
  const customJsSrc = fs.readFileSync(path.join(REPO, 'user', 'custom.js'), 'utf8');

  const runRuntime = (win, bootOverrides = {}) => {
    const payload = {
      version: 'anti-claude-test',
      platform: 'darwin',
      enabled: true,
      config: { selectors: { inputBoxId: 'custom.composerBox' } },
      modules: { i18n: false, metrics: true, customCss: true, customJs: true },
      themeVars: {},
      darkThemeVars: {},
      cssText: '/* base */',
      customCss: '/* user */',
      customJs: customJsSrc,
      dict: {},
      ...bootOverrides
    };
    const script = runtimeSrc.replace('(__AG_BOOT_PAYLOAD__);', () => `(${JSON.stringify(payload)});`);
    return win.eval(script);
  };

  const dom = new JSDOM('<!doctype html><html><head></head></html>', {
    runScripts: 'outside-only',
    url: 'http://127.0.0.1/c/11111111-2222-3333-4444-555555555555',
    pretendToBeVisual: true
  });
  const { window } = dom;
  window.__APP_CONFIG__ = { productName: 'antigravity' };
  /* Remove default body created by HTML5 parser to simulate pre-body document_start execution */
  window.document.body.remove();
  assert.equal(window.document.body, null);

  const metricsRequests = [];
  window.__agRequestMetrics = (cid) => metricsRequests.push(cid);

  try {
    /* Inject BEFORE body exists */
    runRuntime(window);
    assert.ok(window.document.getElementById('ag-custom-fonts'), 'styles mounted in head before body exists');
    assert.equal(window.__ag_custom_js_mounted, false);

    /* Now attach body containing a live checklist + sidebar + custom composer selector */
    const body = window.document.createElement('body');
    body.innerHTML = `
      <aside class="bg-sidebar"><button data-testid="automations-button">Automations</button></aside>
      <section>
        <div data-testid="agent-response">
          <ul class="contains-task-list">
            <li class="task-list-item"><div class="bg-primary"></div>Step 1</li>
            <li class="task-list-item"><div></div>Step 2</li>
          </ul>
        </div>
        <div id="custom.composerBox">
          <div class="agy-composer-footer"><div><span>Model</span></div><div><button data-testid="send-button"></button></div></div>
        </div>
      </section>
    `;
    window.document.documentElement.appendChild(body);
    await new Promise((r) => setTimeout(r, 20));

    assert.equal(window.__ag_custom_js_mounted, true, 'custom.js mounted automatically once body appeared');
    assert.ok(window.document.querySelector('.ag-claude-todo-card'), 'TodoWrite card rendered after pre-body injection');
    assert.ok(window.document.getElementById('ag-claude-projects-nav-btn'), 'Projects nav entry mounted after pre-body injection');
    assert.ok(window.document.getElementById('ag-live-metrics-pill'), 'metrics pill honored boot.config.selectors.inputBoxId');
    const countBeforeDisable = metricsRequests.length;
    assert.ok(countBeforeDisable >= 1);

    /* Hot-disable runtime (`enabled: false`), then navigate to a new chat route */
    runRuntime(window, { enabled: false });
    assert.equal(window.document.getElementById('ag-live-metrics-pill'), null, 'metrics pill removed on disable');

    window.history.pushState({}, '', '/c/aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee');
    await new Promise((r) => setTimeout(r, 180));

    assert.equal(metricsRequests.length, countBeforeDisable, 'no metrics requests fired after hot-disable');
    assert.equal(window.document.getElementById('ag-live-metrics-pill'), null, 'no metrics DOM node re-inserted after hot-disable');
  } finally {
    window.close();
  }
});

test('[Audit #1, #12 & #13 UI] Projects workspace preserves compose draft on folder menu open, saves instructions safely while loading, and links new folder in Scheduled modal', { skip: skipDom }, async () => {
  const customJsSrc = fs.readFileSync(path.join(REPO, 'user', 'custom.js'), 'utf8');
  const dom = new JSDOM(
    `<!doctype html><body>
      <aside class="bg-sidebar">
        <div data-testid="project-header"></div>
        <button data-testid="automations-button">Automations</button>
      </aside>
      <main><div id="antigravity.agentSidePanelInputBox"></div></main>
    </body>`,
    { runScripts: 'outside-only', url: 'http://127.0.0.1/', pretendToBeVisual: true }
  );
  const { window } = dom;
  const doc = window.document;

  /* Mock Redux store on project-header fiber */
  const fakeStore = {
    getState: () => ({
      sidebarProjects: {
        projects: [{ id: 'proj-1', name: 'Alpha Case', folderUris: ['file:///tmp/alpha-case'] }]
      },
      trajectorySummaries: { summaries: {}, indexes: { byProject: {} } }
    }),
    subscribe: () => () => {},
    dispatch: () => {}
  };
  const headerEl = doc.querySelector('[data-testid="project-header"]');
  headerEl.__reactFiber$test = {
    dependencies: { firstContext: { memoizedValue: { store: fakeStore }, next: null } },
    return: null
  };

  const rpcCalls = [];
  let resolveSlowRead = null;
  window.__agProjectCall = (action, payload) => {
    rpcCalls.push({ action, payload: JSON.parse(JSON.stringify(payload || {})) });
    if (action === 'listContexts') {
      /* Delay initial listContexts so cache is NOT populated yet when user edits instructions */
      return new Promise((r) => {
        resolveSlowRead = () =>
          r({
            ok: true,
            contexts: {
              '/tmp/alpha-case': {
                ok: true,
                dirPath: '/tmp/alpha-case',
                instructions: 'Old',
                files: [{ name: 'contract.pdf', relPath: '.anti-claude/files/contract.pdf', managedCopy: true }],
                extraFolders: [{ name: 'shared', absPath: '/tmp/shared' }],
                scheduledTasks: []
              }
            }
          });
      });
    }
    if (action === 'readContext') {
      return new Promise((r) => setTimeout(() => r({
        ok: true,
        dirPath: '/tmp/alpha-case',
        instructions: 'Old',
        files: [{ name: 'contract.pdf', relPath: '.anti-claude/files/contract.pdf', managedCopy: true }],
        extraFolders: [{ name: 'shared', absPath: '/tmp/shared' }],
        scheduledTasks: []
      }), 80));
    }
    if (action === 'pickFolder') {
      return Promise.resolve({ ok: true, canceled: false, folderPath: '/tmp/newly-linked', name: 'newly-linked' });
    }
    if (action === 'saveContext') {
      return Promise.resolve({
        ok: true,
        dirPath: payload.dirPath,
        instructions: payload.instructions ?? 'Old',
        files: [{ name: 'contract.pdf', relPath: '.anti-claude/files/contract.pdf', managedCopy: true }],
        extraFolders: payload.extraFolders || [{ name: 'shared', absPath: '/tmp/shared' }],
        scheduledTasks: []
      });
    }
    return Promise.resolve({ ok: true });
  };

  window.ctx = { modules: { i18n: false }, onCleanup: () => {} };
  window.eval(customJsSrc);

  try {
    /* Open Projects -> click Alpha Case card */
    doc.getElementById('ag-claude-projects-nav-btn').click();
    doc.querySelector('.ag-proj-card').click();

    /* #1 UI: Immediately open Instructions modal BEFORE context cache resolves, edit, and click Save */
    doc.querySelector('[data-ag-pd-edit-inst]').click();
    const instBox = doc.getElementById('ag-pm-instructions');
    instBox.value = 'New instructions while loading';
    instBox.dispatchEvent(new window.Event('input', { bubbles: true }));
    doc.querySelector('[data-ag-pm-save]').click();
    await new Promise((r) => setTimeout(r, 20));

    const instSaveCall = rpcCalls.find((c) => c.action === 'saveContext');
    assert.ok(instSaveCall, 'saveContext called');
    assert.equal(instSaveCall.payload.instructions, 'New instructions while loading');
    assert.equal(instSaveCall.payload.files, undefined, 'instructions modal never submits empty files: []');
    assert.equal(instSaveCall.payload.extraFolders, undefined, 'instructions modal never submits empty extraFolders: []');

    if (resolveSlowRead) resolveSlowRead();
    await new Promise((r) => setTimeout(r, 20));

    /* #12: Type unsent chat draft -> click folder dropdown -> draft & Send button stay intact */
    const comp = doc.getElementById('ag-pd-composer-input');
    comp.value = 'Draft message that must not disappear';
    comp.dispatchEvent(new window.Event('input', { bubbles: true }));
    assert.equal(doc.querySelector('[data-ag-pd-send]').disabled, false);

    doc.querySelector('[data-ag-pd-folder-toggle]').click();
    const compAfterMenu = doc.getElementById('ag-pd-composer-input');
    assert.equal(compAfterMenu.value, 'Draft message that must not disappear', 'unsent compose draft preserved when opening folder menu');
    assert.equal(doc.querySelector('[data-ag-pd-send]').disabled, false);

    /* #13: Open Scheduled Task modal -> select `+ Add folder…` -> links new folder without TypeError */
    doc.querySelector('[data-ag-pd-add-sched]').click();
    const folderSel = doc.getElementById('ag-sched-folder');
    folderSel.value = '__add_folder__';
    folderSel.dispatchEvent(new window.Event('change', { bubbles: true }));
    await new Promise((r) => setTimeout(r, 120));

    const updatedFolderSel = doc.getElementById('ag-sched-folder');
    assert.equal(updatedFolderSel.value, '/tmp/newly-linked', 'newly picked folder added and selected in scheduled modal');
    assert.equal(doc.querySelector('.ag-pm-error'), null, 'no mutator error displayed');
  } finally {
    window.close();
  }
});

test('[Audit #16] CLI statusline measures CJK East Asian display column width accurately', async () => {
  const { formatStatusLine, stringDisplayWidth } = await import(pathToFileURL(path.join(REPO, 'cli', 'statusline.mjs')).href);

  assert.equal(stringDisplayWidth('测试模型 · 项目功能开发测试分支'), 31);

  const out28 = formatStatusLine(
    {
      model: { display_name: '测试模型' },
      vcs: { branch: '项目功能开发测试分支', dirty: false },
      terminal_width: 28
    },
    { noColor: true }
  );
  assert.ok(
    stringDisplayWidth(out28) <= 26,
    `expected display width <= 26 on 28-col terminal, got ${stringDisplayWidth(out28)} ("${out28}")`
  );
  assert.equal(out28, '测试模型');

  const ultraLong = formatStatusLine(
    {
      model: { display_name: '超长中文测试模型名称超过二十八列终端宽度上限' },
      terminal_width: 28
    },
    { noColor: false }
  );
  assert.ok(stringDisplayWidth(ultraLong) <= 26, `truncated CJK model width <= 26, got ${stringDisplayWidth(ultraLong)}`);
});

test('[v2.33 New Project] clicking New project bypasses sidebar multi-item popover, keeps Projects view open on Escape, enters created project, and falls back to Redux when sidebar button is virtualized out', { skip: skipDom }, async () => {
  const customJsSrc = fs.readFileSync(path.join(REPO, 'user', 'custom.js'), 'utf8');
  const dom = new JSDOM(
    `<!doctype html><body>
      <aside class="bg-sidebar">
        <div data-testid="project-header"></div>
        <button data-testid="automations-button">Automations</button>
        <button data-testid="sidebar-add-project-button" data-base-ui-click-trigger="" aria-haspopup="dialog"></button>
      </aside>
      <main><div id="antigravity.agentSidePanelInputBox"></div></main>
    </body>`,
    { runScripts: 'outside-only', url: 'http://127.0.0.1/', pretendToBeVisual: true }
  );
  const { window } = dom;
  const doc = window.document;

  const listeners = new Set();
  const dispatched = [];
  const state = {
    newProject: { currentStep: 'folderSelection', selectedFolders: [], isOpen: false },
    sidebarProjects: {
      projects: [{ id: 'proj-existing', name: 'Existing Project', folderUris: ['file:///tmp/existing'] }]
    },
    trajectorySummaries: { summaries: {}, indexes: { byProject: {} } }
  };
  const notify = () => {
    for (const fn of [...listeners]) fn();
  };
  const fakeStore = {
    getState: () => state,
    subscribe: (fn) => {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
    dispatch: (act) => {
      dispatched.push(act);
      if (act?.type === 'newProject/setIsOpen') {
        state.newProject.isOpen = Boolean(act.payload);
        notify();
      }
    }
  };

  const headerEl = doc.querySelector('[data-testid="project-header"]');
  headerEl.__reactFiber$test = {
    dependencies: { firstContext: { memoizedValue: { store: fakeStore }, next: null } },
    return: null
  };

  let sidebarPopoverClicked = 0;
  let newProjEntryCalled = 0;
  let sshEntryCalled = 0;
  const addBtn = doc.querySelector('[data-testid="sidebar-add-project-button"]');
  addBtn.addEventListener('click', () => {
    sidebarPopoverClicked += 1;
  });
  addBtn.__reactFiber$test = {
    memoizedState: null,
    return: {
      memoizedState: {
        memoizedState: [
          [
            {
              type: 'NEW_PROJECT',
              label: 'New Project',
              disabled: false,
              onClick: () => {
                newProjEntryCalled += 1;
                state.newProject.isOpen = true;
                const dlg = doc.createElement('div');
                dlg.className = 'agy-dialog';
                dlg.setAttribute('role', 'dialog');
                doc.body.appendChild(dlg);
                notify();
              }
            },
            {
              type: 'SSH_HOST',
              label: 'SSH Host…',
              disabled: false,
              onClick: () => {
                sshEntryCalled += 1;
              }
            }
          ]
        ],
        next: null
      },
      return: null
    }
  };

  window.__agProjectCall = async () => ({
    ok: true,
    contexts: {},
    instructions: '',
    files: [],
    extraFolders: [],
    scheduledTasks: []
  });
  window.ctx = { modules: { i18n: false }, onCleanup: () => {} };
  window.eval(customJsSrc);

  try {
    doc.getElementById('ag-claude-projects-nav-btn').click();
    const view = doc.getElementById('ag-claude-projects-view');
    assert.equal(view.getAttribute('data-open'), 'true');

    /* 1. Clicking New project invokes NEW_PROJECT entry directly without clicking the sidebar popover trigger or closing Projects view */
    view.querySelector('[data-ag-proj-new]').click();
    assert.equal(newProjEntryCalled, 1, 'invoked NEW_PROJECT entry handler directly');
    assert.equal(sshEntryCalled, 0, 'did not invoke SSH_HOST');
    assert.equal(sidebarPopoverClicked, 0, 'did not trigger sidebar Base UI dropdown menu');
    assert.equal(view.getAttribute('data-open'), 'true', 'Projects view remains open behind the native modal');

    /* 2. Pressing Escape while native .agy-dialog is open does NOT close Projects view */
    const escWhileModal = new window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true });
    doc.dispatchEvent(escWhileModal);
    assert.equal(view.getAttribute('data-open'), 'true', 'Escape does not dismiss Projects view while native dialog is open');

    /* 3. Completing project creation automatically enters the newly created project detail view */
    doc.querySelector('.agy-dialog').remove();
    state.newProject.isOpen = false;
    state.sidebarProjects.projects.push({
      id: 'proj-brand-new',
      name: 'Brand New Case',
      folderUris: ['file:///tmp/brand-new-case']
    });
    notify();

    assert.equal(view.getAttribute('data-open'), 'true');
    assert.equal(
      view.querySelector('.ag-pd-crumb-cur')?.textContent?.trim(),
      'Brand New Case',
      'automatically navigated into the newly created project detail workspace'
    );

    /* 4. Return to Projects grid, remove sidebar-add-project-button (virtual scroll unmounted), and verify Redux fallback */
    view.querySelector('[data-ag-pd-back]').click();
    addBtn.remove();
    dispatched.length = 0;
    view.querySelector('[data-ag-proj-new]').click();
    assert.deepEqual(
      dispatched.map((a) => a.type),
      ['newProject/reset', 'newProject/setCurrentStep', 'newProject/setIsOpen'],
      'dispatches native newProject Redux actions when sidebar button is virtualized out of DOM'
    );
    assert.equal(state.newProject.isOpen, true);
  } finally {
    window.close();
  }
});

test('[Projects Context Menu & Topbar] right-click / more menu renames & deletes projects (including folderless Skip projects), and collapsed sidebar applies safe topbar inset', { skip: skipDom }, async () => {
  const customJsSrc = fs.readFileSync(path.join(REPO, 'user', 'custom.js'), 'utf8');
  const dom = new JSDOM(
    `<!doctype html><body>
      <div id="root">
        <div class="app-shell">
          <aside class="bg-sidebar">
            <div data-testid="project-header"></div>
            <button data-testid="automations-button">Automations</button>
          </aside>
          <main><div id="antigravity.agentSidePanelInputBox"></div></main>
        </div>
      </div>
    </body>`,
    { runScripts: 'outside-only', url: 'http://127.0.0.1/?project=proj-folderless', pretendToBeVisual: true }
  );
  const { window } = dom;
  const doc = window.document;

  const state = {
    sidebarProjects: {
      projects: [
        { id: 'proj-legal', name: '李小丽法务', folderUris: ['file:///tmp/lixiaoli'] },
        { id: 'proj-folderless', name: '1', folderUris: [] },
        { id: 'default-cli-project', name: 'CLI Project', folderUris: [] }
      ]
    },
    trajectorySummaries: { summaries: {}, indexes: { byProject: {} } }
  };

  const deletedIds = [];
  const updatedProjects = [];
  const rawRecords = new Map([
    ['proj-legal', { $typeName: 'exa.project_pb.Project', id: 'proj-legal', name: '李小丽法务' }],
    ['proj-folderless', { $typeName: 'exa.project_pb.Project', id: 'proj-folderless', name: '1' }]
  ]);
  const mockPmSvc = {
    getProjectStateProvider: (id) => ({
      getState: () => ({ project: rawRecords.get(id) || null })
    }),
    updateProject: async (proj) => {
      updatedProjects.push(proj);
      rawRecords.set(proj.id, proj);
      const hit = state.sidebarProjects.projects.find((p) => p.id === proj.id);
      if (hit) Object.assign(hit, { name: proj.name, archived: Boolean(proj.archived) });
    },
    deleteProject: async (id) => {
      deletedIds.push(id);
      rawRecords.delete(id);
      state.sidebarProjects.projects = state.sidebarProjects.projects.filter((p) => p.id !== id);
    }
  };

  const navigated = [];
  const mockRouter = {
    state: { location: { pathname: '/', search: { project: 'proj-folderless' } } },
    navigate: (opts) => {
      navigated.push(opts);
      if (opts && typeof opts.search === 'function') {
        mockRouter.state.location.search = opts.search(mockRouter.state.location.search);
      }
    }
  };
  const fakeStore = {
    getState: () => state,
    subscribe: () => () => {},
    dispatch: () => {}
  };

  const sidebarEl = doc.querySelector('.bg-sidebar');
  sidebarEl.__reactFiber$test = {
    memoizedProps: { sidebarStore: fakeStore, sidebarRouter: mockRouter },
    dependencies: {
      firstContext: {
        memoizedValue: { store: fakeStore },
        next: {
          memoizedValue: { core: { projectManagementService: mockPmSvc } },
          next: null
        }
      }
    },
    return: null
  };
  doc.querySelector('[data-testid="project-header"]').__reactFiber$test = sidebarEl.__reactFiber$test;

  window.__agProjectCall = async () => ({
    ok: true,
    contexts: {},
    instructions: '',
    files: [],
    extraFolders: [],
    scheduledTasks: []
  });
  window.ctx = { modules: { i18n: true }, onCleanup: () => {} };
  window.eval(customJsSrc);

  try {
    doc.getElementById('ag-claude-projects-nav-btn').click();
    const view = doc.getElementById('ag-claude-projects-view');
    /* JSDOM sidebar has 0x0 rect -> simulates collapsed sidebar (leftPx = 0) */
    assert.equal(view.getAttribute('data-sidebar-collapsed'), 'true');
    assert.equal(view.style.getPropertyValue('--ag-proj-topbar-pl'), '224px');

    /* Folderless user project "1" is shown alongside folder project & CLI Project, while CLI Project has no destructive menu */
    const cards = [...view.querySelectorAll('.ag-proj-card')];
    assert.equal(cards.length, 3);
    const cliCard = cards.find((c) => c.getAttribute('data-ag-proj-id') === 'default-cli-project');
    assert.equal(cliCard.querySelector('[data-ag-proj-menu]'), null, 'builtin CLI Project hides destructive menu');

    /* Right-click on "李小丽法务" card opens #ag-project-action-menu -> Rename updates title immediately */
    const legalCard = cards.find((c) => c.getAttribute('data-ag-proj-id') === 'proj-legal');
    legalCard.dispatchEvent(new window.MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 320, clientY: 220 }));
    const menu = doc.getElementById('ag-project-action-menu');
    assert.ok(menu, 'right-click opened #ag-project-action-menu');
    menu.querySelector('[data-ag-pm-act="rename"]').click();
    assert.equal(doc.getElementById('ag-project-action-menu'), null, 'context menu closed on rename');

    const renameInput = doc.getElementById('ag-pm-rename-input');
    assert.ok(renameInput, 'rename modal opened');
    renameInput.value = '李小丽法务（二审）';
    renameInput.dispatchEvent(new window.Event('input', { bubbles: true }));
    doc.querySelector('[data-ag-pm-rename-save]').click();
    await new Promise((r) => setTimeout(r, 20));

    assert.equal(updatedProjects.length, 1);
    assert.equal(updatedProjects[0].name, '李小丽法务（二审）');
    assert.match(view.querySelector('[data-ag-proj-id="proj-legal"]').textContent, /李小丽法务（二审）/);

    /* Enter folderless project "1" -> verify breadcrumb back works -> re-enter and delete via Detail ⋯ menu (2-step confirm) */
    view.querySelector('[data-ag-proj-id="proj-folderless"]').click();
    assert.equal(view.querySelector('.ag-pd-crumb-cur')?.textContent?.trim(), '1');
    view.querySelector('[data-ag-pd-back]').click();
    assert.ok(view.querySelector('.ag-proj-grid'), 'clicking breadcrumb root returns to Projects grid');

    view.querySelector('[data-ag-proj-id="proj-folderless"]').click();
    view.querySelector('[data-ag-pd-proj-menu]').click();
    const detailMenu = doc.getElementById('ag-project-action-menu');
    assert.ok(detailMenu, 'detail header ⋯ button opened #ag-project-action-menu');
    detailMenu.querySelector('[data-ag-pm-act="delete"]').click();
    assert.equal(
      detailMenu.querySelector('[data-ag-pm-act="delete"]').getAttribute('data-confirm'),
      '1',
      'first click arms confirmation'
    );
    assert.equal(deletedIds.length, 0, 'does not delete on first click');

    detailMenu.querySelector('[data-ag-pm-act="delete"]').click();
    await new Promise((r) => setTimeout(r, 20));
    assert.deepEqual(deletedIds, ['proj-folderless'], 'second click invokes projectManagementService.deleteProject');
    assert.ok(view.querySelector('.ag-proj-grid'), 'deleting active project returns cleanly to Projects grid');
    assert.equal(view.querySelector('[data-ag-proj-id="proj-folderless"]'), null, 'deleted project card removed immediately');
    assert.equal(mockRouter.state.location.search.project, undefined, 'active URL search.project cleared when deleted');
  } finally {
    window.close();
  }
});

test('[Project @ Mentions] typing @ in Project Detail opens Browse & Plugins menu, drills into Conversations/Files, renders removable pills, and submits structured TextOrScopeItem chunks', { skip: skipDom }, async () => {
  const customJsSrc = fs.readFileSync(path.join(REPO, 'user', 'custom.js'), 'utf8');
  const dom = new JSDOM(
    `<!doctype html><body>
      <div id="root">
        <div class="app-shell">
          <aside class="bg-sidebar">
            <div data-testid="project-header"></div>
            <button data-testid="automations-button">Automations</button>
          </aside>
          <main><div id="antigravity.agentSidePanelInputBox"></div></main>
        </div>
      </div>
    </body>`,
    { runScripts: 'outside-only', url: 'http://127.0.0.1/', pretendToBeVisual: true }
  );
  const { window } = dom;
  const doc = window.document;

  const state = {
    sidebarProjects: {
      projects: [{ id: 'proj-agy', name: '技术（Antigravity）', folderUris: ['file:///tmp/agy-tech'] }]
    },
    trajectorySummaries: {
      summaries: {
        'conv-outside-1': {
          projectId: 'outside-of-project',
          summary: '讨论反重力 UI 改造方案',
          lastModifiedTime: { seconds: 1795152000 },
          annotations: { title: '反重力界面改造' }
        }
      },
      indexes: { byProject: {} }
    }
  };

  const mockRpcSvc = {
    getAllPlugins: async () => ({
      plugins: [
        {
          name: 'bm-bridge',
          displayName: 'Basic Memory（反重力版）',
          description: '共享记忆桥接插件',
          path: 'file:///Users/demo/.gemini/config/plugins/bm-bridge',
          logo: '',
          skills: ['bm-orient']
        }
      ]
    }),
    getAllRules: async () => [
      {
        memoryId: 'user_global',
        memory: { case: 'textMemory', value: { content: 'Always sync progress.' } }
      }
    ],
    searchFiles: async ({ query, workspaceUri }) => ({
      results: [
        {
          $typeName: 'exa.codeium_common_pb.PathScopeItem',
          absoluteUri: `${workspaceUri}/notes.md`,
          workspaceUrisToRelativePaths: { [workspaceUri]: 'notes.md' },
          numFiles: 0
        }
      ].filter((r) => !query || r.absoluteUri.includes(query))
    })
  };

  const mockRouter = {
    state: { location: { pathname: '/', search: { project: 'proj-agy' } } },
    navigate: (opts) => {
      if (opts && opts.to) {
        mockRouter.state.location = { pathname: opts.to, search: opts.search || {} };
      }
    }
  };
  const fakeStore = { getState: () => state, subscribe: () => () => {}, dispatch: () => {} };

  const sidebarEl = doc.querySelector('.bg-sidebar');
  sidebarEl.__reactFiber$test = {
    memoizedProps: { sidebarStore: fakeStore, sidebarRouter: mockRouter },
    dependencies: {
      firstContext: {
        memoizedValue: { store: fakeStore },
        next: { memoizedValue: mockRpcSvc, next: null }
      }
    },
    return: null
  };
  doc.querySelector('[data-testid="project-header"]').__reactFiber$test = sidebarEl.__reactFiber$test;

  const submittedCalls = [];
  const inputBoxEl = doc.getElementById('antigravity.agentSidePanelInputBox');
  inputBoxEl.__reactFiber$test = {
    memoizedProps: {
      handleSubmit: (chunks, media, flag) => {
        submittedCalls.push({ chunks, media, flag });
      }
    },
    return: null
  };

  window.__agProjectCall = async () => ({
    ok: true,
    contexts: {},
    instructions: '',
    files: [],
    extraFolders: [],
    scheduledTasks: []
  });
  window.ctx = { modules: { i18n: true }, onCleanup: () => {} };
  window.eval(customJsSrc);

  try {
    doc.getElementById('ag-claude-projects-nav-btn').click();
    const view = doc.getElementById('ag-claude-projects-view');
    view.querySelector('[data-ag-proj-id="proj-agy"]').click();
    await new Promise((r) => setTimeout(r, 10));

    const comp = doc.getElementById('ag-pd-composer-input');
    const pop = doc.getElementById('ag-pd-mention-popover');

    /* 1. Typing `@` opens root menu with Browse categories + Plugins */
    comp.value = '@';
    comp.setSelectionRange(1, 1);
    comp.dispatchEvent(new window.Event('input', { bubbles: true }));
    await new Promise((r) => setTimeout(r, 30));

    assert.equal(pop.getAttribute('data-open'), 'true', 'typing @ opens mention popover');
    assert.match(pop.textContent, /项目文件/, 'shows Project files browse category');
    assert.match(pop.textContent, /项目规则/, 'shows Rules browse category');
    assert.match(pop.textContent, /历史对话/, 'shows Conversations browse category');
    assert.match(pop.textContent, /Basic Memory（反重力版）/, 'shows installed plugins inline');

    /* 2. Select Conversations category -> drills into @conversation: -> pick Outside of Project chat "反重力界面改造" */
    const convCatIdx = [...pop.querySelectorAll('.ag-pd-mention-row')].findIndex((r) => /历史对话/.test(r.textContent));
    assert.ok(convCatIdx >= 0);
    pop.querySelector(`[data-ag-pd-m-idx="${convCatIdx}"]`).dispatchEvent(new window.MouseEvent('mousedown', { bubbles: true }));
    assert.equal(comp.value, '@conversation:', 'selecting category inserts @conversation: prefix');
    assert.match(pop.textContent, /反重力界面改造/, 'lists Outside of Project conversation');

    /* Press Enter to select highlighted conversation */
    comp.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
    assert.equal(comp.value, '@[反重力界面改造] ', 'inserts bracketed mention token');
    assert.equal(pop.getAttribute('data-open'), 'false', 'popover closes after leaf selection');
    assert.equal(doc.querySelectorAll('.ag-pd-mention-pill').length, 1, 'renders removable mention pill above input');

    /* 3. Add text + a project file mention `@files:notes` */
    comp.value = '结合 @[反重力界面改造] 更新 @files:notes';
    comp.setSelectionRange(comp.value.length, comp.value.length);
    comp.dispatchEvent(new window.Event('input', { bubbles: true }));
    await new Promise((r) => setTimeout(r, 30));
    assert.equal(pop.getAttribute('data-open'), 'true');
    assert.match(pop.textContent, /notes\.md/, 'searches project files via searchFiles');
    comp.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Tab', bubbles: true, cancelable: true }));

    assert.equal(comp.value, '结合 @[反重力界面改造] 更新 @[notes.md] ');
    assert.equal(doc.querySelectorAll('.ag-pd-mention-pill').length, 2, 'renders 2 mention pills');

    /* 4. Submit -> verifies structured TextOrScopeItem[] chunks passed to native handleSubmit */
    doc.querySelector('[data-ag-pd-send]').click();
    await new Promise((r) => setTimeout(r, 320));

    assert.equal(submittedCalls.length, 1, 'native handleSubmit invoked');
    const chunks = submittedCalls[0].chunks;
    assert.deepEqual(
      Array.from(chunks, (c) => c.chunk.case),
      ['text', 'item', 'text', 'item'],
      'interleaves text chunks and ContextScopeItem chunks accurately'
    );
    assert.equal(chunks[1].chunk.value.scopeItem.case, 'conversation');
    assert.equal(chunks[1].chunk.value.scopeItem.value.id, 'conv-outside-1');
    assert.equal(chunks[3].chunk.value.scopeItem.case, 'file');
    assert.equal(chunks[3].chunk.value.scopeItem.value.absoluteUri, 'file:///tmp/agy-tech/notes.md');
  } finally {
    window.close();
  }
});

test('[Pinned History & Image Paste] Pinned conversations (excluded from indexes.sidebar) appear in @ Conversations & Project chats, and Project composer supports pasting images', { skip: skipDom }, async () => {
  const customJsSrc = fs.readFileSync(path.join(REPO, 'user', 'custom.js'), 'utf8');
  const dom = new JSDOM(
    `<!doctype html><html><body>
      <div id="root">
        <div class="bg-sidebar">
          <button data-testid="automations-button">Automations</button>
          <div data-sidebar-section-drop-id="proj-agy">
            <button data-testid="project-header" data-project-label="技术（Antigravity）">技术（Antigravity）</button>
          </div>
        </div>
        <div id="antigravity.agentSidePanelInputBox"></div>
      </div>
    </body></html>`,
    { url: 'http://localhost:3310/', pretendToBeVisual: true, runScripts: 'outside-only' }
  );
  const { window } = dom;
  const doc = window.document;

  /* Mirror real Antigravity Redux: `indexes.sidebar` ONLY contains unpinned conversations,
   * while pinned conversations live in `indexes.pinned` (`inSidebarIdx === false`). */
  const state = {
    sidebarProjects: {
      projects: [
        {
          id: 'proj-agy',
          name: '技术（Antigravity）',
          folderUris: ['file:///tmp/agy-tech']
        },
        {
          id: 'proj-empty',
          name: '李小丽法务',
          folderUris: ['file:///Users/demo/Desktop/李小丽法务']
        },
        {
          id: 'default-cli-project',
          name: 'CLI Project',
          folderUris: []
        }
      ]
    },
    trajectorySummaries: {
      summaries: {
        'conv-unpinned-outside': {
          projectId: 'outside-of-project',
          summary: '普通未置顶会话',
          lastModifiedTime: { seconds: 1795152000 },
          annotations: { title: '反重力界面改造' }
        },
        'conv-pinned-outside': {
          projectId: 'outside-of-project',
          summary: 'LLM 读书笔记',
          lastModifiedTime: { seconds: 1790000000 },
          annotations: { title: '大模型学习', pinned: true }
        },
        'conv-pinned-proj': {
          projectId: 'proj-agy',
          summary: '项目内置顶记录',
          lastModifiedTime: { seconds: 1791000000 },
          annotations: { title: '置顶架构纪要' }
        }
      },
      indexes: {
        byProject: { 'proj-agy': ['conv-pinned-proj'] },
        sidebar: { 'conv-unpinned-outside': true },
        pinned: { 'conv-pinned-outside': true, 'conv-pinned-proj': true }
      }
    }
  };

  const mockRouter = {
    state: { location: { pathname: '/', search: { project: 'proj-agy' } } },
    navigate: (opts) => {
      if (opts && opts.to) {
        mockRouter.state.location = { pathname: opts.to, search: opts.search || {} };
      }
    }
  };
  const fakeStore = { getState: () => state, subscribe: () => () => {}, dispatch: () => {} };

  const sidebarEl = doc.querySelector('.bg-sidebar');
  sidebarEl.__reactFiber$test = {
    memoizedProps: { sidebarStore: fakeStore, sidebarRouter: mockRouter },
    dependencies: { firstContext: { memoizedValue: { store: fakeStore }, next: null } },
    return: null
  };
  doc.querySelector('[data-testid="project-header"]').__reactFiber$test = sidebarEl.__reactFiber$test;

  let currentAttachments = [];
  const attachedFileCalls = [];
  const submittedCalls = [];
  const mockInputBoxRef = {
    current: {
      attachFiles: async (files) => {
        attachedFileCalls.push(files);
        currentAttachments = Array.from(files).map((f, idx) => ({
          $typeName: 'exa.codeium_common_pb.Media',
          mimeType: f.type || 'image/png',
          description: f.name || `img-${idx}.png`,
          uri: `file:///tmp/tempmediaStorage/pasted_${idx}.png`
        }));
      },
      getMediaAttachments: () => currentAttachments,
      setMediaAttachments: (next) => {
        currentAttachments = typeof next === 'function' ? next(currentAttachments) : next;
      },
      forgetTrackedUploads: () => {}
    }
  };

  /* Mirror real Antigravity fiber hierarchy: handleSubmit on inner fiber, inputBoxRef higher up */
  const inputBoxEl = doc.getElementById('antigravity.agentSidePanelInputBox');
  inputBoxEl.__reactFiber$test = {
    memoizedProps: {
      handleSubmit: async (chunks, media, clearEditor) => {
        submittedCalls.push({ chunks, media });
        if (typeof clearEditor === 'function') clearEditor();
      }
    },
    return: {
      memoizedProps: { inputBoxRef: mockInputBoxRef },
      return: null
    }
  };

  window.__agProjectCall = async (action) => ({
    ok: true,
    contexts: {},
    projectMtimes:
      action === 'listContexts'
        ? {
            'proj-empty': Date.now() - 2 * 3600 * 1000,
            'default-cli-project': Date.now() - 5 * 86400 * 1000
          }
        : {},
    instructions: '',
    files: [],
    extraFolders: [],
    scheduledTasks: []
  });
  window.ctx = { modules: { i18n: true }, onCleanup: () => {} };
  window.eval(customJsSrc);

  try {
    doc.getElementById('ag-claude-projects-nav-btn').click();
    await new Promise((r) => setTimeout(r, 20));
    const view = doc.getElementById('ag-claude-projects-view');

    /* Verify ALL project cards uniformly show `<时间> · <N 个对话>` (even 0-chat local & CLI projects, never raw folder path) */
    const emptyCardMeta = view.querySelector('[data-ag-proj-id="proj-empty"] .ag-proj-card-meta').textContent.trim();
    const cliCardMeta = view.querySelector('[data-ag-proj-id="default-cli-project"] .ag-proj-card-meta').textContent.trim();
    assert.equal(emptyCardMeta, '2 小时前 · 0 个对话', '0-chat folder project shows unified time + 0 chats instead of path');
    assert.equal(cliCardMeta, '5 天前 · 0 个对话', 'CLI project shows unified time + 0 chats instead of blank');

    view.querySelector('[data-ag-proj-id="proj-agy"]').click();
    await new Promise((r) => setTimeout(r, 15));

    /* 1. Project Detail conversation list includes pinned project conversation despite not being in indexes.sidebar */
    const projChatListText = view.querySelector('.ag-pd-chat-list').textContent;
    assert.match(projChatListText, /置顶架构纪要/, 'pinned project conversation appears in project chat list');

    /* 2. `@conversation:` includes pinned outside-of-project conversation "大模型学习" AND pinned project chat */
    const comp = doc.getElementById('ag-pd-composer-input');
    const pop = doc.getElementById('ag-pd-mention-popover');
    const sendBtn = doc.querySelector('[data-ag-pd-send]');
    comp.value = '@conversation:';
    comp.setSelectionRange(comp.value.length, comp.value.length);
    comp.dispatchEvent(new window.Event('input', { bubbles: true }));
    await new Promise((r) => setTimeout(r, 15));

    assert.equal(pop.getAttribute('data-open'), 'true');
    assert.match(pop.textContent, /大模型学习/, 'pinned outside-of-project chat is listed in Conversations');
    assert.match(pop.textContent, /置顶/, 'pinned conversation displays Pinned badge in subtitle');

    /* Clear input so text is empty -> verify image-only paste enables Send and renders thumbnail */
    comp.value = '';
    comp.dispatchEvent(new window.Event('input', { bubbles: true }));
    assert.equal(sendBtn.disabled, true, 'send disabled when both text and media are empty');

    const pngBytes = Uint8Array.from(
      Buffer.from(
        'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==',
        'base64'
      )
    );
    const imgFile = new window.File([pngBytes], 'image.png', { type: 'image/png' });
    const pasteEv = new window.Event('paste', { bubbles: true, cancelable: true });
    Object.defineProperty(pasteEv, 'clipboardData', {
      value: {
        items: [{ kind: 'file', type: 'image/png', getAsFile: () => imgFile }],
        files: [imgFile]
      }
    });
    comp.dispatchEvent(pasteEv);
    await new Promise((r) => setTimeout(r, 30));

    assert.equal(pasteEv.defaultPrevented, true, 'paste event default prevented for image');
    const strip = doc.getElementById('ag-pd-media-strip');
    assert.equal(strip.querySelectorAll('.ag-pd-media-card').length, 1, 'renders pasted image thumbnail card');
    assert.equal(sendBtn.disabled, false, 'pasting image enables send button even with empty text');

    /* Test removing image via × button disables send again, then paste + text and submit */
    strip.querySelector('[data-ag-pd-media-rm]').click();
    assert.equal(strip.querySelectorAll('.ag-pd-media-card').length, 0, 'clicking remove deletes thumbnail');
    assert.equal(sendBtn.disabled, true, 'removing last image with empty text disables send button');

    const pasteEv2 = new window.Event('paste', { bubbles: true, cancelable: true });
    Object.defineProperty(pasteEv2, 'clipboardData', {
      value: {
        items: [{ kind: 'file', type: 'image/png', getAsFile: () => imgFile }],
        files: [imgFile]
      }
    });
    comp.dispatchEvent(pasteEv2);
    await new Promise((r) => setTimeout(r, 30));
    comp.value = '看看这张报错截图';
    comp.dispatchEvent(new window.Event('input', { bubbles: true }));

    sendBtn.click();
    await new Promise((r) => setTimeout(r, 360));

    assert.equal(attachedFileCalls.length, 1, 'delegates pasted File to native inputBoxRef.attachFiles');
    assert.equal(submittedCalls.length, 1, 'invokes native handleSubmit');
    assert.equal(submittedCalls[0].chunks[0].chunk.value, '看看这张报错截图');
    assert.equal(submittedCalls[0].media.length, 1, 'passes resolved Media attachment to handleSubmit');
    assert.equal(submittedCalls[0].media[0].uri, 'file:///tmp/tempmediaStorage/pasted_0.png');
    assert.equal(currentAttachments.length, 0, 'cleans up composer media state after submit');
  } finally {
    window.close();
  }
});

test('[Pinned Sidebar Single-Line] hides redundant project folder subtitle line in Pinned Conversations, exposes project on hover tooltip, and compacts --ag-sb-pinned-height on virtual translateY reflow', { skip: skipDom }, async () => {
  const customCssSrc = fs.readFileSync(path.join(REPO, 'user', 'custom.css'), 'utf8');
  assert.match(
    customCssSrc,
    /\[data-testid="conversation-row-sidebar"\]\[data-pinned="true"\][\s\S]*?svg\[data-project-glyph\][\s\S]*?display:\s*none\s*!important/,
    'custom.css hides redundant project folder subtitle line inside Pinned Conversations'
  );

  const customJsSrc = fs.readFileSync(path.join(REPO, 'user', 'custom.js'), 'utf8');
  const dom = new JSDOM(
    `<!doctype html><html><body>
      <div class="bg-sidebar">
        <div data-testid="conversation-list-sidebar">
          <div class="w-full relative" style="height: 220px;">
            <div data-index="0" style="position: sticky; top: 0px;"><div data-testid="section-header">置顶对话</div></div>
            <div data-index="1" style="position: absolute; transform: translateY(24px);">
              <div data-testid="conversation-row-sidebar" data-pinned="true" data-subtext="技术（Antigravity）">
                <a href="/c/c-pin-1" aria-label="Fix Bugs in Chat History"></a>
                <div class="flex-col">
                  <span>Fix Bugs in Chat History</span>
                  <span><svg data-project-glyph="folder"></svg>技术（Antigravity）</span>
                </div>
              </div>
            </div>
            <div data-index="2" style="position: absolute; transform: translateY(159px);">
              <div data-testid="section-header"><span>项目</span><button data-testid="sidebar-add-project-button"></button></div>
            </div>
          </div>
        </div>
      </div>
    </body></html>`,
    { url: 'http://127.0.0.1/', pretendToBeVisual: true, runScripts: 'outside-only' }
  );
  const { window } = dom;
  const doc = window.document;
  window.ctx = { modules: { i18n: true, claudeUxHideSidebarProjects: true }, onCleanup: () => {} };
  window.eval(customJsSrc);

  try {
    const sb = doc.querySelector('[data-testid="conversation-list-sidebar"]');
    const link = doc.querySelector('[data-testid="conversation-row-sidebar"] a[href]');
    assert.equal(
      link.getAttribute('title'),
      'Fix Bugs in Chat History\n所属项目：技术（Antigravity）',
      'preserves owning project name in hover tooltip'
    );
    assert.equal(sb.style.getPropertyValue('--ag-sb-pinned-height'), '159px');

    /* Simulate TanStack Virtual ResizeObserver compacting translateY from 159px -> 139px after 2nd line hides */
    doc.querySelector('[data-index="2"]').setAttribute('style', 'position: absolute; transform: translateY(139px);');
    await new Promise((r) => setTimeout(r, 20));
    assert.equal(
      sb.style.getPropertyValue('--ag-sb-pinned-height'),
      '139px',
      'automatically shrinks --ag-sb-pinned-height when virtualizer compacts pinned row height'
    );
  } finally {
    window.close();
  }
});

test('[Language Persistence Across Ephemeral Port Restarts] persists Chinese/English UI mode & CJK scale to daemon ui-prefs.json across random 127.0.0.1:<port> restarts and discards stale reused-port localStorage', { skip: skipDom }, async () => {
  const daemon = await import(pathToFileURL(path.join(REPO, 'core', 'daemon.mjs')).href);
  const customJsSrc = fs.readFileSync(path.join(REPO, 'user', 'custom.js'), 'utf8');
  const uiPrefsPath = path.join(HERMETIC_DAEMON_STATE, 'ui-prefs.json');
  const userDir = path.join(HERMETIC_DAEMON_STATE, 'user');
  fs.mkdirSync(userDir, { recursive: true });
  fs.copyFileSync(path.join(REPO, 'user', 'config.json'), path.join(userDir, 'config.json'));
  fs.rmSync(uiPrefsPath, { force: true });

  const openSimulatedWindow = (port, preseedLocalStorage = null) => {
    daemon.rebuildBundleIfNeeded();
    const boot = daemon.getCachedBootPayload();
    const dom = new JSDOM(
      `<!doctype html><html><body>
        <div data-split-root="true">
          <div>
            <div data-testid="settings-sidebar">
              <div class="flex flex-col gap-0.5">
                <div class="group/nav-item"><button type="button" data-testid="settings-nav-item-General" class="bg-sidebar-secondary"><span>General</span></button></div>
                <div class="group/nav-item"><button type="button" data-testid="settings-nav-item-Appearance"><span>Appearance</span></button></div>
              </div>
            </div>
          </div>
          <div>
            <div id="settings-right-host"><div>Native Content</div></div>
          </div>
        </div>
      </body></html>`,
      { url: `https://127.0.0.1:${port}/`, pretendToBeVisual: true, runScripts: 'outside-only' }
    );
    const { window } = dom;
    if (preseedLocalStorage) {
      window.localStorage.setItem('ag_claude_ux_modules_v1', JSON.stringify(preseedLocalStorage));
    }
    window.__agProjectCall = async (action, payload) => {
      if (action === 'saveUiPrefs') {
        const res = daemon.saveUiPrefs(payload);
        daemon.rebuildBundleIfNeeded();
        return res;
      }
      return { ok: false, error: 'unsupported' };
    };
    window.ctx = {
      config: boot.config,
      modules: boot.modules,
      dict: boot.dict,
      onCleanup: () => {}
    };
    window.eval(customJsSrc);
    return dom;
  };

  let dom1 = null;
  let dom2 = null;
  let dom3 = null;
  let dom4 = null;
  try {
    /* 1. Boot on port 51016 with legacy unsynced localStorage { i18n: true } -> auto-migrates to ui-prefs.json */
    dom1 = openSimulatedWindow(51016, { i18n: true, cjkFontScale: '94.5' });
    await new Promise((r) => setTimeout(r, 30));
    assert.equal(dom1.window.document.documentElement.getAttribute('data-ag-ux-lang'), 'zh');
    assert.equal(dom1.window.document.documentElement.getAttribute('data-ag-cjk-scale'), '94.5');
    assert.equal(fs.existsSync(uiPrefsPath), true, 'auto-migrates existing session localStorage to ui-prefs.json');
    const saved1 = JSON.parse(fs.readFileSync(uiPrefsPath, 'utf8'));
    assert.equal(saved1.modules.i18n, true);
    assert.equal(saved1.cjkFontScale, '94.5');

    /* 2. Simulate Antigravity restart on a brand-new ephemeral port 58432 (empty localStorage) -> stays Chinese! */
    dom2 = openSimulatedWindow(58432);
    assert.equal(
      dom2.window.document.documentElement.getAttribute('data-ag-ux-lang'),
      'zh',
      'new random port restart keeps Chinese mode without resetting to English'
    );
    assert.equal(dom2.window.document.documentElement.getAttribute('data-ag-cjk-scale'), '94.5');

    /* 3. User opens UI Enhancements on port 58432 and switches i18n OFF (back to English) */
    const navBtn = dom2.window.document.querySelector('button[data-testid="settings-nav-item-ClaudeUX"]');
    assert.ok(navBtn, 'mounts UI Enhancements settings nav button');
    navBtn.click();
    const i18nSwitch = dom2.window.document.querySelector('[data-ag-cux-switch="i18n"]');
    assert.equal(i18nSwitch.getAttribute('aria-checked'), 'true');
    i18nSwitch.click();
    await new Promise((r) => setTimeout(r, 30));
    assert.equal(dom2.window.document.documentElement.getAttribute('data-ag-ux-lang'), 'en');
    const saved2 = JSON.parse(fs.readFileSync(uiPrefsPath, 'utf8'));
    assert.equal(saved2.modules.i18n, false, 'persists English selection to disk');

    /* 4. Restart on BOTH a new port (61200) AND a reused old port (51016 with stale _ts) -> both boot in English! */
    dom3 = openSimulatedWindow(61200);
    assert.equal(dom3.window.document.documentElement.getAttribute('data-ag-ux-lang'), 'en');

    dom4 = openSimulatedWindow(51016, { i18n: true, _ts: saved1.updatedAt });
    assert.equal(
      dom4.window.document.documentElement.getAttribute('data-ag-ux-lang'),
      'en',
      'discards stale localStorage when OS reuses an older ephemeral port'
    );
  } finally {
    if (dom1) dom1.window.close();
    if (dom2) dom2.window.close();
    if (dom3) dom3.window.close();
    if (dom4) dom4.window.close();
    fs.rmSync(uiPrefsPath, { force: true });
  }
});
