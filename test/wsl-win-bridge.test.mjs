import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  resolveConversationDirForCascade,
  collectOverviewSnapshot
} from '../core/daemon.mjs';

test('[wsl-bridge] resolveConversationDirForCascade selects fallback WSL dir when primary Windows dir lacks the db', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ac-wsl-conv-'));
  try {
    const winConv = path.join(tmp, 'win-conversations');
    const wslConv = path.join(tmp, 'wsl-conversations');
    fs.mkdirSync(winConv, { recursive: true });
    fs.mkdirSync(wslConv, { recursive: true });

    const cid = '11111111-2222-3333-4444-555555555555';
    const otherCid = '22222222-3333-4444-5555-666666666666';
    fs.writeFileSync(path.join(winConv, `${otherCid}.db`), 'win');
    fs.writeFileSync(path.join(wslConv, `${cid}.db`), 'wsl');

    assert.equal(resolveConversationDirForCascade(cid, [winConv, wslConv]), wslConv);
    assert.equal(resolveConversationDirForCascade(otherCid, [winConv, wslConv]), winConv);
    assert.equal(
      resolveConversationDirForCascade('aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee', [winConv, wslConv]),
      winConv
    );
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('[wsl-bridge] collectOverviewSnapshot discovers directory-based plugins and merges extraGeminiDirs MCP/rules/skills', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ac-wsl-overview-'));
  try {
    const winGemini = path.join(tmp, 'win-gemini');
    const wslGemini = path.join(tmp, 'wsl-gemini');
    fs.mkdirSync(path.join(winGemini, 'config', 'plugins'), { recursive: true });
    fs.mkdirSync(path.join(wslGemini, 'config', 'plugins', 'migrated-settings', 'rules'), { recursive: true });
    fs.mkdirSync(path.join(wslGemini, 'config', 'plugins', 'migrated-settings', 'skills', 'demo-skill'), { recursive: true });
    fs.mkdirSync(path.join(wslGemini, 'config', 'plugins', 'disabled-plugin'), { recursive: true });

    // WSL config.json omits migrated-settings (enabled by presence) and disables disabled-plugin
    fs.writeFileSync(
      path.join(wslGemini, 'config', 'config.json'),
      JSON.stringify({ plugins: { swarm: { enabled: true }, 'disabled-plugin': { enabled: false } } })
    );
    fs.writeFileSync(
      path.join(wslGemini, 'config', 'plugins', 'migrated-settings', 'mcp_config.json'),
      JSON.stringify({
        mcpServers: {
          memory: { command: 'node', args: ['mem.js'] },
          'cpa-models': { command: 'node', args: ['cpa.js'] },
          'off-mcp': { command: 'node', disabled: true }
        }
      })
    );
    fs.writeFileSync(
      path.join(wslGemini, 'config', 'plugins', 'disabled-plugin', 'mcp_config.json'),
      JSON.stringify({ mcpServers: { shouldNotAppear: { command: 'node' } } })
    );
    fs.writeFileSync(
      path.join(wslGemini, 'config', 'plugins', 'migrated-settings', 'rules', 'sample.md'),
      '# rule'
    );
    fs.writeFileSync(
      path.join(wslGemini, 'config', 'plugins', 'migrated-settings', 'skills', 'demo-skill', 'SKILL.md'),
      '---\nname: demo-skill\n---'
    );

    const snap = collectOverviewSnapshot({}, {
      geminiDir: winGemini,
      configDir: path.join(winGemini, 'config'),
      skillsDir: path.join(winGemini, 'config', 'skills'),
      agentsDir: path.join(winGemini, 'config', 'agents'),
      builtinSkillsDir: path.join(winGemini, 'antigravity', 'builtin', 'skills'),
      extraGeminiDirs: [wslGemini],
      skipGit: true
    });

    assert.equal(snap.ok, true);
    const connIds = snap.connectors.map((c) => c.id).sort();
    assert.deepEqual(connIds, ['cpa-models', 'memory']);
    assert.equal(snap.rules.some((r) => r.label === 'migrated-settings/sample.md'), true);
    assert.equal(snap.skills.items.some((s) => s.name === 'demo-skill'), true);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});
