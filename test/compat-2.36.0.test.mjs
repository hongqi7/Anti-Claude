/**
 * Compatibility regression for Antigravity v2.36.0:
 * 1. New official model-selector Fiber props `locked` (boolean) and `hideThinkingEffort` (boolean)
 *    must be recognized without flagging unknown-field drift on the Native menu row.
 * 2. When `locked === true`, the custom layered menu MUST step aside (hard gap) instead of
 *    intercepting the trigger click.
 * 3. When `hideThinkingEffort === true`, the custom layered menu MUST omit the Thinking effort row.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

let JSDOM = null;
try {
  JSDOM = createRequire(import.meta.url)('jsdom').JSDOM;
} catch {}
const skipDom = JSDOM ? false : 'jsdom not installed';

function bootDom(extraApi = {}) {
  const customJsSrc = fs.readFileSync(path.join(REPO, 'user', 'custom.js'), 'utf8');
  const dom = new JSDOM(
    `<!doctype html><html><body>
      <div id="root">
        <div id="antigravity.agentSidePanelInputBox">
          <button type="button" data-testid="model-selector-trigger">Gemini 4 Neon High</button>
        </div>
      </div>
    </body></html>`,
    { runScripts: 'outside-only', url: 'https://127.0.0.1:61999/' }
  );
  const { window } = dom;
  const doc = window.document;
  const modelOptions = [
    { label: 'Gemini 4 Neon (High)', modelId: 'gemini-4-neon-high', value: 1532, disabled: false },
    { label: 'Gemini 4 Neon (XHigh)', modelId: 'gemini-4-neon-xhigh', value: 1535, disabled: false },
    { label: 'Gemini 4 Carbon (High)', modelId: 'gemini-4-carbon-high', value: 1520, disabled: false }
  ];
  const api = {
    modelOptions,
    selectedModel: modelOptions[0],
    setSelectedModel: () => {},
    open: false,
    setIsOpen: () => {},
    locked: false,
    hideThinkingEffort: false,
    ...extraApi
  };
  const triggerBtn = doc.querySelector('button[data-testid="model-selector-trigger"]');
  triggerBtn.__reactFiber$v236 = { memoizedProps: { value: api }, return: null };
  window.ctx = { dict: {}, modules: { i18n: true, claudeUxModelMenu: true }, onCleanup: () => {} };
  window.eval(customJsSrc);
  return { dom, window, doc, triggerBtn };
}

test('[v2.36 locked & hideThinkingEffort] default false flags produce no drift dot on Native menu row', { skip: skipDom }, async () => {
  const { dom, window, doc, triggerBtn } = bootDom({ locked: false, hideThinkingEffort: false });
  try {
    triggerBtn.dispatchEvent(new window.MouseEvent('pointerdown', { bubbles: true, button: 0 }));
    await new Promise((r) => setTimeout(r, 30));

    const mainPop = doc.getElementById('ag-claude-model-popover');
    assert.equal(mainPop.getAttribute('data-open'), 'true');

    const nativeRow = mainPop.querySelector('[data-ag-cm-native="1"]');
    assert.ok(nativeRow, 'native menu row is present');
    assert.equal(nativeRow.getAttribute('data-ag-cm-native-gaps'), null, 'locked/hideThinkingEffort must NOT trigger unknown-field drift');
    assert.equal(nativeRow.querySelector('.ag-cm-dot'), null, 'native menu row must NOT show drift dot');
    assert.ok(mainPop.querySelector('[data-ag-cm-subtrigger="effort"]'), 'Thinking effort row stays visible when hideThinkingEffort is false');
  } finally {
    try { window.__agClaudeUxDispose(); } catch {}
    dom.window.close();
  }
});

test('[v2.36 locked=true] locked model selector defers to native menu instead of opening custom popover', { skip: skipDom }, async () => {
  const { dom, window, doc, triggerBtn } = bootDom({ locked: true });
  try {
    triggerBtn.dispatchEvent(new window.MouseEvent('pointerdown', { bubbles: true, button: 0 }));
    await new Promise((r) => setTimeout(r, 30));

    const mainPop = doc.getElementById('ag-claude-model-popover');
    assert.equal(
      mainPop === null || mainPop.getAttribute('data-open') !== 'true',
      true,
      'locked=true must NOT open the custom layered menu'
    );
  } finally {
    try { window.__agClaudeUxDispose(); } catch {}
    dom.window.close();
  }
});

test('[v2.36 hideThinkingEffort=true] hides Thinking effort row from custom popover', { skip: skipDom }, async () => {
  const { dom, window, doc, triggerBtn } = bootDom({ hideThinkingEffort: true });
  try {
    triggerBtn.dispatchEvent(new window.MouseEvent('pointerdown', { bubbles: true, button: 0 }));
    await new Promise((r) => setTimeout(r, 30));

    const mainPop = doc.getElementById('ag-claude-model-popover');
    assert.equal(mainPop.getAttribute('data-open'), 'true');
    assert.equal(
      mainPop.querySelector('[data-ag-cm-subtrigger="effort"]'),
      null,
      'Thinking effort row must be omitted when hideThinkingEffort is true'
    );
  } finally {
    try { window.__agClaudeUxDispose(); } catch {}
    dom.window.close();
  }
});
