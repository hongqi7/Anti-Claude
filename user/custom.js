/**
 * Anti-Claude — user/custom.js
 * Non-invasive runtime UX extension for Google Antigravity Desktop 2.0:
 * 1. Unfolds outer `worked-for-collapsible` end-of-turn wrapper so interleaved narration & tool summaries stay inline.
 * 2. Adds smooth 190ms collapse transition when React unmounts finished `tool-group-collapsible` panels.
 * 3. Renders an in-place reactive Claude `TodoWrite` checklist card (`- [ ]` pending / `- [/]` active / `- [x]` completed),
 *    deduplicating and merging all checklist updates within the same turn into a single card.
 * 4. Attaches orbiting official-blue dots + live `1s / 2s...` elapsed timer exclusively to the actively executing step row.
 *
 * Feature switches (user/config.json -> "modules", all default true):
 *   claudeUxStepUnfold, claudeUxCollapseAnimation, claudeUxTodoCard, claudeUxRunningTimer,
 *   claudeUxContextRing, claudeUxModelMenu
 */
(function () {
  const CFG_ROOT = (typeof ctx !== 'undefined' && ctx && (ctx.config || ctx)) || {};
  const MODS =
    (typeof ctx !== 'undefined' && ctx && (ctx.modules || (ctx.config && ctx.config.modules))) || {};
  const CFG_UI_STATE =
    CFG_ROOT.uiState && typeof CFG_ROOT.uiState === 'object' && !Array.isArray(CFG_ROOT.uiState)
      ? CFG_ROOT.uiState
      : {};
  const cfgUiPrefsTs = Number(CFG_ROOT.uiPrefsUpdatedAt) > 0 ? Number(CFG_ROOT.uiPrefsUpdatedAt) : 0;
  const MODULE_STORAGE_KEY = 'ag_claude_ux_modules_v1';
  const VALID_CJK_SCALES = ['94.5', '95', '100'];
  function normalizeCjkScale(v) {
    const s = String(v == null ? '' : v).trim().replace(/%$/, '');
    return VALID_CJK_SCALES.includes(s) ? s : null;
  }
  function loadLocalModuleOverrides() {
    try {
      const raw = typeof localStorage === 'object' && localStorage ? localStorage.getItem(MODULE_STORAGE_KEY) : null;
      const parsed = raw ? JSON.parse(raw) : null;
      return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
    } catch {
      return {};
    }
  }
  const rawLocalModOverrides = loadLocalModuleOverrides();
  const localOverrideTs = Number(rawLocalModOverrides._ts) > 0 ? Number(rawLocalModOverrides._ts) : 0;
  /* Trust localStorage overrides when daemon has never saved ui-prefs yet (migrates pre-existing in-session toggles)
     or when localStorage carries a newer/equal timestamp; discard stale overrides from reused ephemeral ports. */
  const trustLocalOverrides = cfgUiPrefsTs === 0 || localOverrideTs >= cfgUiPrefsTs;
  let localModOverrides = trustLocalOverrides ? rawLocalModOverrides : {};
  if (!trustLocalOverrides) {
    try {
      if (typeof localStorage === 'object' && localStorage) {
        localStorage.removeItem(MODULE_STORAGE_KEY);
        localStorage.removeItem('ag_claude_ux_recent_collapsed');
        localStorage.removeItem('ag_claude_ux_unified_recents_collapsed');
      }
    } catch {}
  }
  const needsInitialPrefsSync =
    trustLocalOverrides &&
    ((cfgUiPrefsTs === 0 && Object.keys(localModOverrides).some((k) => k !== '_ts')) ||
      (cfgUiPrefsTs > 0 && localOverrideTs > cfgUiPrefsTs));
  let currentCjkScale =
    normalizeCjkScale(localModOverrides.cjkFontScale) ||
    normalizeCjkScale(CFG_ROOT.cjkFontScale) ||
    '95';
  function effectiveModBool(key, defaultVal = true) {
    if (Object.prototype.hasOwnProperty.call(localModOverrides, key)) {
      return Boolean(localModOverrides[key]);
    }
    if (Object.prototype.hasOwnProperty.call(MODS, key)) {
      return Boolean(MODS[key]);
    }
    return defaultVal;
  }
  const FEAT = {
    i18n: effectiveModBool('i18n', false),
    stepUnfold: effectiveModBool('claudeUxStepUnfold', true),
    collapseAnim: effectiveModBool('claudeUxCollapseAnimation', true),
    todoCard: effectiveModBool('claudeUxTodoCard', true),
    runningTimer: effectiveModBool('claudeUxRunningTimer', true),
    contextRing: effectiveModBool('claudeUxContextRing', true),
    modelMenu: effectiveModBool('claudeUxModelMenu', true),
    inlineUndo: effectiveModBool('claudeUxInlineUndo', true),
    folderStatus: effectiveModBool('claudeUxFolderStatus', true),
    recentSection: effectiveModBool('claudeUxRecentSection', false),
    projects: effectiveModBool('claudeUxProjects', true),
    hideSidebarProjects: effectiveModBool('claudeUxHideSidebarProjects', true),
    customizations: effectiveModBool('claudeUxCustomizations', true)
  };
  const L = (zh, en) => (FEAT.i18n ? zh : en);

  /* an older instance that was never cleaned up (no ctx.onCleanup) must not keep running */
  if (typeof window.__agClaudeUxDispose === 'function') {
    try {
      window.__agClaudeUxDispose();
    } catch {}
  }

  /* Set root locale to zh-CN for Simplified Chinese CJK glyph fallback and track active UI language */
  const docRoot = document.documentElement;
  const origDocLang = docRoot ? docRoot.getAttribute('lang') : null;
  const hadDocLang = docRoot ? docRoot.hasAttribute('lang') : false;
  if (docRoot && origDocLang !== 'zh-CN') {
    docRoot.setAttribute('lang', 'zh-CN');
  }
  if (docRoot) {
    docRoot.setAttribute('data-ag-ux-lang', FEAT.i18n ? 'zh' : 'en');
    docRoot.setAttribute('data-ag-cjk-scale', currentCjkScale);
  }

  const userToggled = new WeakSet();
  const autoExpandCount = new WeakMap();
  const openSnapshots = new WeakMap();
  const runningTimers = new WeakMap();
  const paneLastActiveTs = new WeakMap();
  const paneUndockTimers = new WeakMap();
  const todoParseCache = new WeakMap();
  let timerIntervalId = null;
  let rafPending = false;

  /* ---- lifecycle: every async callback is tracked and becomes a no-op after cleanup ---- */
  let disposed = false;
  const pendingRafs = new Set();
  const pendingTimeouts = new Set();
  function frame(fn) {
    if (disposed) return 0;
    const id = requestAnimationFrame((ts) => {
      pendingRafs.delete(id);
      if (!disposed) fn(ts);
    });
    pendingRafs.add(id);
    return id;
  }
  function later(fn, ms) {
    if (disposed) return 0;
    const id = setTimeout(() => {
      pendingTimeouts.delete(id);
      if (!disposed) fn();
    }, ms);
    pendingTimeouts.add(id);
    return id;
  }
  function cancelLater(id) {
    if (!id) return;
    clearTimeout(id);
    pendingTimeouts.delete(id);
  }

  const SVG_PENDING =
    '<svg class="ag-todo-ico ag-todo-pending" width="15" height="15" viewBox="0 0 16 16" fill="none" aria-hidden="true"><circle cx="8" cy="8" r="6.3" stroke="currentColor" stroke-width="1.35"/></svg>';
  const SVG_ACTIVE =
    '<svg class="ag-todo-ico ag-todo-active" width="15" height="15" viewBox="0 0 16 16" fill="none" aria-hidden="true"><circle cx="8" cy="8" r="6.3" stroke="currentColor" stroke-opacity="0.32" stroke-width="1.4"/><path d="M8 1.7a6.3 6.3 0 0 1 6.3 6.3" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg>';
  const SVG_DONE =
    '<svg class="ag-todo-ico ag-todo-done" width="15" height="15" viewBox="0 0 16 16" fill="none" aria-hidden="true"><circle cx="8" cy="8" r="7.1" fill="currentColor"/><path class="ag-todo-done-check" d="M5.05 8.15l1.95 1.95 3.95-4.1" stroke="#FFFFFF" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round"/></svg>';

  const PAST_LABEL_RE = /^(?:Explored|Ran\b|Edited\b|Done\b|已探索|已运行|已编辑|已完成)/i;

  const onDocClick = (e) => {
    if (!e.isTrusted) return;
    const btn = e.target && e.target.closest && e.target.closest('button[data-testid="worked-for-collapsible"]');
    if (btn) userToggled.add(btn);
  };
  document.addEventListener('click', onDocClick, true);

  function captureOpenToolPanels() {
    /* Keep a reference to the live panel node (no innerHTML serialisation per frame).
       It is cloned only at the moment React collapses it. */
    const openBtns = document.querySelectorAll('button[data-testid="tool-group-collapsible"][aria-expanded="true"]');
    for (const btn of openBtns) {
      const panel = btn.nextElementSibling;
      if (!panel || panel.classList.contains('ag-collapse-ghost')) continue;
      const snap = openSnapshots.get(btn);
      if (!snap || snap.panel !== panel) openSnapshots.set(btn, { panel });
    }
  }

  function animateCollapseIfNeeded(btn) {
    const snap = openSnapshots.get(btn);
    if (!snap) return;
    openSnapshots.delete(btn);
    if (btn.getAttribute('aria-expanded') !== 'false') return;
    const parent = btn.parentElement;
    if (!parent || parent.querySelector(':scope > .ag-collapse-ghost')) return;
    const src = snap.panel;
    if (!src || !src.firstChild) return;

    const ghost = document.createElement('div');
    ghost.className = `${src.className} ag-collapse-ghost`;
    ghost.setAttribute('aria-hidden', 'true');
    for (const n of Array.from(src.childNodes)) ghost.appendChild(n.cloneNode(true));
    ghost.querySelectorAll('[id]').forEach((el) => el.removeAttribute('id'));
    ghost.style.opacity = '1';
    ghost.style.transform = 'translateY(0)';
    btn.insertAdjacentElement('afterend', ghost);

    const rectH = ghost.getBoundingClientRect ? ghost.getBoundingClientRect().height : 0;
    const height = Math.min(Math.ceil(rectH || ghost.scrollHeight || 0), 360);
    if (height <= 8) {
      ghost.remove();
      return;
    }
    ghost.style.maxHeight = `${height}px`;
    /* Commit starting box in the same frame so collapse begins immediately with zero 2-frame stall */
    void ghost.offsetHeight;
    ghost.classList.add('is-collapsing');

    let cleaned = false;
    const cleanup = () => {
      if (cleaned) return;
      cleaned = true;
      ghost.removeEventListener('transitionend', onEnd);
      if (ghost.parentNode) ghost.remove();
    };
    const onEnd = (ev) => {
      if (ev && ev.target === ghost && ev.propertyName === 'max-height') cleanup();
    };
    ghost.addEventListener('transitionend', onEnd);
    setTimeout(cleanup, 220); /* intentionally untracked: must also run after dispose */
  }

  function parseTodoUlUncached(ul) {
    const allLis = Array.from(ul.children).filter((el) => el.tagName === 'LI');
    const lis = allLis.filter((el) => el.classList.contains('task-list-item'));
    if (lis.length < 2 || lis.length > 15 || lis.length !== allLis.length) return null;

    const items = [];
    for (const li of lis) {
      const iconBox = li.querySelector(':scope > div:first-child, :scope > p:first-child > div:first-child');
      let status = 'pending';
      if (li.classList.contains('task-checked')) {
        status = 'completed';
      } else if (iconBox && iconBox.classList.contains('bg-primary')) {
        status = 'in_progress';
      }
      const clone = li.cloneNode(true);
      const firstDiv = clone.querySelector(':scope > div:first-child, :scope > p:first-child > div:first-child');
      if (firstDiv) firstDiv.remove();
      const checkedSpan = clone.querySelector(':scope > span.task-checked-content, :scope > p > span.task-checked-content');
      const labelHtml = (checkedSpan ? checkedSpan.innerHTML : clone.innerHTML).trim();
      if (!labelHtml) return null;
      items.push({ status, html: labelHtml });
    }
    return items;
  }

  function parseTodoUl(ul) {
    if (!ul.classList || !ul.classList.contains('contains-task-list')) return null;
    if (ul.closest('pre, code, [data-testid="user-input-step"], .agy-user-bubble')) return null;
    if (ul.closest('[data-testid="tool-group-collapsible"] + div')) return null;
    if (ul.closest('.ag-claude-todo-card, .ag-collapse-ghost')) return null;

    /* cheap signature: item count + status classes + inline tag count + text; avoids re-cloning unchanged lists every sync */
    const sig = `${ul.children.length}|${ul.querySelectorAll(':scope > li.task-checked').length}|${
      ul.querySelectorAll(':scope > li > div.bg-primary:first-child, :scope > li > p:first-child > div.bg-primary:first-child').length
    }|${ul.querySelectorAll('code, strong, em, a, del, span').length}|${ul.textContent}`;
    const cached = todoParseCache.get(ul);
    if (cached && cached.sig === sig) return cached.items;
    const items = parseTodoUlUncached(ul);
    todoParseCache.set(ul, { sig, items });
    return items;
  }

  function normalizeTodoText(html) {
    return html
      .replace(/<[^>]*>/g, '')
      .replace(/\s+/g, ' ')
      .trim()
      .toLowerCase();
  }

  function isChecklistEvolution(prevItems, nextItems) {
    if (!prevItems || !nextItems) return false;
    const a = prevItems.map((it) => normalizeTodoText(it.html));
    const b = nextItems.map((it) => normalizeTodoText(it.html));
    let matches = 0;
    for (const txtB of b) {
      if (!txtB) continue;
      const hit = a.some(
        (txtA) =>
          txtA === txtB ||
          (txtA.length >= 6 && txtB.length >= 6 && (txtA.includes(txtB.slice(0, 6)) || txtB.includes(txtA.slice(0, 6))))
      );
      if (hit) matches += 1;
    }
    return matches >= Math.max(1, Math.ceil(Math.min(a.length, b.length) * 0.4));
  }

  function iconForStatus(status) {
    return status === 'completed' ? SVG_DONE : status === 'in_progress' ? SVG_ACTIVE : SVG_PENDING;
  }

  function patchCardDom(card, items, paused) {
    if (paused) card.setAttribute('data-ag-todo-paused', 'true');
    else card.removeAttribute('data-ag-todo-paused');
    const sig = JSON.stringify(items);
    if (card.getAttribute('data-ag-todo-sig') === sig) return;
    card.setAttribute('data-ag-todo-sig', sig);

    const existingRows = Array.from(card.children).filter((el) => el.classList.contains('ag-claude-todo-row'));
    if (existingRows.length === items.length) {
      for (let i = 0; i < items.length; i++) {
        const row = existingRows[i];
        const it = items[i];
        const prevStatus = row.getAttribute('data-status');
        if (prevStatus !== it.status) {
          row.setAttribute('data-status', it.status);
          const ico = row.querySelector(':scope > .ag-todo-ico');
          if (ico) {
            ico.outerHTML = iconForStatus(it.status);
          }
        }
        const lbl = row.querySelector(':scope > .ag-claude-todo-label');
        if (lbl && lbl.innerHTML !== it.html) {
          lbl.innerHTML = it.html;
        }
      }
      return;
    }

    card.innerHTML = items
      .map(
        (it) =>
          `<div class="ag-claude-todo-row" data-status="${it.status}">${iconForStatus(it.status)}<span class="ag-claude-todo-label">${it.html}</span></div>`
      )
      .join('');
  }

  function removeInlineMount(ul) {
    if (ul.nextElementSibling && ul.nextElementSibling.hasAttribute('data-ag-todo-mount')) {
      ul.nextElementSibling.remove();
    }
  }

  function markMergedUl(ul) {
    ul.removeAttribute('data-ag-todo-primary');
    ul.setAttribute('data-ag-todo-merged', 'true');
    removeInlineMount(ul);
    const pWrap = ul.parentElement;
    if (pWrap && pWrap.children.length === 1) {
      pWrap.setAttribute('data-ag-todo-empty-wrap', 'true');
    }
  }

  function restoreNativeUl(ul) {
    ul.removeAttribute('data-ag-todo-primary');
    ul.removeAttribute('data-ag-todo-merged');
    removeInlineMount(ul);
    const pWrap = ul.parentElement;
    if (pWrap) pWrap.removeAttribute('data-ag-todo-empty-wrap');
  }

  function renderInlineTodoCard(anchorUl, items, paused) {
    anchorUl.setAttribute('data-ag-todo-primary', 'true');
    anchorUl.removeAttribute('data-ag-todo-merged');
    let card = anchorUl.nextElementSibling;
    if (!card || !card.hasAttribute('data-ag-todo-mount')) {
      card = document.createElement('div');
      card.className = 'ag-claude-todo-card';
      card.setAttribute('data-ag-todo-mount', 'true');
      anchorUl.insertAdjacentElement('afterend', card);
    }
    patchCardDom(card, items, paused);
  }

  /* One pane = one composer input box + its conversation. Computed once per sync (panes are few). */
  const INPUT_BOX_SEL = '[id="antigravity.agentSidePanelInputBox"]';
  function collectPanes() {
    const panes = [];
    for (const inputBox of document.querySelectorAll(INPUT_BOX_SEL)) {
      let cur = inputBox.parentElement;
      for (let i = 0; i < 16 && cur; i++, cur = cur.parentElement) {
        if (cur.querySelector('[data-testid="agent-response"]')) {
          if (cur.querySelectorAll(INPUT_BOX_SEL).length === 1) panes.push({ root: cur, inputBox });
          break;
        }
      }
    }
    return panes;
  }

  function paneFor(el, panes) {
    for (const p of panes) if (p.root.contains(el)) return p;
    return null;
  }

  const AGENT_WORKING_H6_RE = /^(?:Agent\s+working|Agent\s*正在执行|Agent\s*正在工作|正在工作)$/i;
  function paneHasWorkingHeading(root) {
    if (!root || !root.querySelectorAll) return false;
    const turns = root.querySelectorAll('[data-testid="agent-response"]');
    if (!turns.length) return false;
    const lastTurn = turns[turns.length - 1];
    const h6 = lastTurn.querySelector(':scope > h6.sr-only, :scope > h6');
    if (!h6) return false;
    const origMap = window.__ag_orig_text_map;
    const raw =
      (origMap && h6.firstChild && origMap.get(h6.firstChild) && origMap.get(h6.firstChild).origRaw) ||
      h6.textContent ||
      '';
    return AGENT_WORKING_H6_RE.test(raw.trim());
  }

  function isPaneActivelyGenerating(pane) {
    if (!pane) return false;
    /* Composer replaces `input-cancel-button` with the send/queue arrow whenever the user drafts a follow-up
       or attaches an image mid-turn, so also check the active turn's native `<h6>Agent working</h6>` heading. */
    const isActive =
      Boolean(pane.inputBox.querySelector('button[data-testid="input-cancel-button"]')) ||
      paneHasWorkingHeading(pane.root);
    const now = Date.now();
    if (isActive) {
      paneLastActiveTs.set(pane.root, now);
      const pendingTimer = paneUndockTimers.get(pane.root);
      if (pendingTimer) {
        cancelLater(pendingTimer);
        paneUndockTimers.delete(pane.root);
      }
      return true;
    }
    const lastTs = paneLastActiveTs.get(pane.root) || 0;
    if (now - lastTs < 280) {
      if (!paneUndockTimers.has(pane.root)) {
        const tid = later(() => {
          paneUndockTimers.delete(pane.root);
          scheduleSync();
        }, 300);
        paneUndockTimers.set(pane.root, tid);
      }
      return true;
    }
    return false;
  }

  function renderLiveDockedTodoCard(turnEl, items) {
    if (!turnEl) return false;
    let dock = turnEl.querySelector(':scope > [data-ag-todo-dock="true"]');
    if (!dock) {
      dock = document.createElement('div');
      dock.className = 'ag-claude-todo-live-dock';
      dock.setAttribute('data-ag-todo-dock', 'true');
      turnEl.appendChild(dock);
    } else if (turnEl.lastElementChild !== dock) {
      turnEl.appendChild(dock);
    }
    let card = dock.querySelector(':scope > .ag-claude-todo-card');
    if (!card) {
      card = document.createElement('div');
      card.className = 'ag-claude-todo-card';
      card.setAttribute('data-ag-todo-mount', 'true');
      dock.appendChild(card);
    }
    patchCardDom(card, items, false);
    return dock;
  }

  function isAllTodoCompleted(items) {
    return Boolean(items && items.length > 0 && items.every((it) => it.status === 'completed'));
  }

  function hasActiveTodo(items) {
    return Boolean(items && items.some((it) => it.status === 'in_progress'));
  }

  /*
   * Per-turn checklist memory. Antigravity virtualises the step stream: once a mid-turn narration scrolls out
   * of its render window the node (and its checklist) is unmounted, leaving only the turn's first list and the
   * final summary in the DOM. Every checklist version seen while mounted is remembered here, keyed by content
   * signature (so a version re-mounted by scrolling up keeps its original order). The newest version is the one
   * with the most progress; ties go to the one seen last.
   */
  const turnTodoMemory = new WeakMap();
  let todoSeenSeq = 0;
  function todoSignature(items) {
    return items.map((it) => `${it.status.charAt(0)}:${normalizeTodoText(it.html)}`).join('|');
  }
  function todoProgress(items) {
    let score = 0;
    for (const it of items) score += it.status === 'completed' ? 2 : it.status === 'in_progress' ? 1 : 0;
    return score;
  }
  function rememberTurnTodo(turnEl, items) {
    if (!turnEl || !items) return;
    let mem = turnTodoMemory.get(turnEl);
    if (!mem) {
      mem = new Map();
      turnTodoMemory.set(turnEl, mem);
    }
    const sig = todoSignature(items);
    if (!mem.has(sig)) mem.set(sig, { seq: ++todoSeenSeq, items, progress: todoProgress(items) });
  }
  function latestRememberedTodo(turnEl, baseItems) {
    const mem = turnEl && turnTodoMemory.get(turnEl);
    if (!mem || !baseItems) return null;
    let best = null;
    for (const rec of mem.values()) {
      if (!isChecklistEvolution(baseItems, rec.items)) continue;
      if (!best || rec.progress > best.progress || (rec.progress === best.progress && rec.seq > best.seq)) best = rec;
    }
    if (!best || todoProgress(baseItems) > best.progress) return null;
    return best.items;
  }

  /*
   * Mid-turn narration is frequently NOT rendered as markdown: Antigravity stores the text that accompanies tool
   * calls in the planner step's `thinking` field and shows it inside the (often collapsed) tool group, so no
   * <ul class="contains-task-list"> ever exists for it. Read checklists straight from the step data instead.
   */
  const TASK_LINE_RE = /^\s*(?:[-*+]|\d+[.)])\s+\[([ xX/])\]\s+(.+?)\s*$/;
  function stripFencedCode(md) {
    return String(md || '')
      .replace(/```[\s\S]*?```/g, '')
      .replace(/~~~[\s\S]*?~~~/g, '');
  }
  function stripAllCode(md) {
    return stripFencedCode(md).replace(/`[^`\n]+`/g, '');
  }
  function renderInlineMd(text) {
    return escapeHtml(text)
      .replace(/`([^`]+)`/g, '<code>$1</code>')
      .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
  }
  function extractTaskLists(md) {
    const lists = [];
    let cur = null;
    const flush = () => {
      if (cur && cur.length >= 2 && cur.length <= 15) lists.push(cur);
      cur = null;
    };
    for (const line of stripFencedCode(md).split('\n')) {
      const m = line.match(TASK_LINE_RE);
      if (m) {
        if (!cur) cur = [];
        const mark = m[1];
        cur.push({
          status: mark === '/' ? 'in_progress' : mark === ' ' ? 'pending' : 'completed',
          html: renderInlineMd(m[2])
        });
      } else if (line.trim() || cur === null) {
        flush();
      }
    }
    flush();
    return lists;
  }
  /*
   * The turn container's props hold the complete, ordered step list (independent of what is mounted).
   * Crucial React 18/19 detail: `turnEl.__reactFiber$` is bound at initial mount and is NOT swapped when React
   * commits to `fiber.alternate`; we therefore inspect BOTH `f` and `f.alternate` and pick the fresher step array.
   * Mid-turn progress is signalled via an invisible HTML comment `<!-- todo:N/M -->` (never shown in prose), with
   * fenced & inline code stripped first so prose examples like `` `〔进度 2/4〕` `` can never pollute progress state.
   */
  const PROGRESS_RE =
    /<!--\s*todo\s*:\s*(\d+)\s*\/\s*(\d+)\s*-->|〔\s*进度\s*(\d+)\s*\/\s*(\d+)\s*〕|\[\s*progress\s*(\d+)\s*\/\s*(\d+)\s*\]/gi;
  const TODO_DONE_RE = /<!--\s*todo\s*:\s*done(?:\s*\/\s*\d+)?\s*-->/i;
  const LEGACY_MARKER_LINE_RE = /^\s*(?:〔\s*进度\s*\d+\s*\/\s*\d+\s*〕|\[\s*progress\s*\d+\s*\/\s*\d+\s*\])[^\n]*$/i;
  const turnProgressByTotal = new WeakMap();
  const turnTodoDone = new WeakSet();
  const stepScanState = new WeakMap();

  function hideLegacyProgressParagraphs() {
    for (const p of document.querySelectorAll('[data-testid="agent-response"] p')) {
      if (p.hasAttribute('data-ag-todo-marker-line')) continue;
      if (LEGACY_MARKER_LINE_RE.test((p.textContent || '').trim())) {
        p.setAttribute('data-ag-todo-marker-line', 'true');
        const pWrap = p.parentElement;
        if (pWrap && pWrap.children.length === 1) {
          pWrap.setAttribute('data-ag-todo-empty-wrap', 'true');
        }
      }
    }
  }

  function stepsFromFiberBranch(f) {
    const p = f && f.memoizedProps;
    return p && p.container && Array.isArray(p.container.steps) ? p.container.steps : null;
  }

  function stepTailSig(steps) {
    if (!steps || !steps.length) return 0;
    const last = steps[steps.length - 1];
    const v = last && last.step && last.step.value;
    const txt = v && typeof v === 'object' ? v.modifiedResponse || v.response || '' : '';
    return steps.length * 1000000 + txt.length;
  }

  function turnStepsOf(turnEl) {
    const fk = Object.keys(turnEl).find((k) => k.startsWith('__reactFiber$'));
    let f = fk ? turnEl[fk] : null;
    let best = null;
    for (let i = 0; i < 8 && f; i++, f = f.return) {
      const a = stepsFromFiberBranch(f);
      const b = stepsFromFiberBranch(f.alternate);
      const pick = stepTailSig(b) > stepTailSig(a) ? b : a;
      if (pick && stepTailSig(pick) > stepTailSig(best)) {
        best = pick;
      }
      if (best) break;
    }
    return best;
  }

  function turnContinuesChecklist(turnEl, baseItems) {
    if (!turnEl || !baseItems || !baseItems.length) return false;
    const mem = turnTodoMemory.get(turnEl);
    if (mem && mem.size > 0) {
      for (const rec of mem.values()) {
        if (isChecklistEvolution(baseItems, rec.items)) return true;
      }
      return false;
    }
    const byTotal = turnProgressByTotal.get(turnEl);
    return Boolean(byTotal && byTotal.has(baseItems.length));
  }

  function recordProgressMarker(turnEl, total, n) {
    if (!turnEl || !(n >= 1 && total >= n && total <= 15)) return false;
    let byTotal = turnProgressByTotal.get(turnEl);
    if (!byTotal) {
      byTotal = new Map();
      turnProgressByTotal.set(turnEl, byTotal);
    }
    const prev = byTotal.get(total) || 0;
    if (n > prev) {
      byTotal.set(total, n);
      return true;
    }
    return false;
  }

  function harvestStepChecklists(turnEl, isLiveTurn = true) {
    if (!turnEl) return false;
    const steps = turnStepsOf(turnEl);
    if (!steps || !steps.length) return false;
    let changed = false;
    const lastIdx = steps.length - 1;
    for (let idx = 0; idx < steps.length; idx++) {
      const s = steps[idx];
      const v = s && s.step && s.step.case === 'plannerResponse' ? s.step.value : null;
      if (!v || typeof v !== 'object') continue;
      const text = v.modifiedResponse || v.response || '';
      if (!text) continue;
      /* Re-evaluate the trailing planner step on live turns in case SSE appended `<!-- todo:N/M -->` without a DOM childList mutation */
      if ((!isLiveTurn || idx < lastIdx) && stepScanState.get(v) === text.length) continue;
      stepScanState.set(v, text.length);

      for (const items of extractTaskLists(text)) {
        const before = latestRememberedTodo(turnEl, items);
        rememberTurnTodo(turnEl, items);
        const after = latestRememberedTodo(turnEl, items);
        if (after && (!before || todoSignature(after) !== todoSignature(before))) changed = true;
      }

      const cleanText = stripAllCode(text);
      if (TODO_DONE_RE.test(cleanText) && !turnTodoDone.has(turnEl)) {
        turnTodoDone.add(turnEl);
        changed = true;
      }
      PROGRESS_RE.lastIndex = 0;
      let m;
      while ((m = PROGRESS_RE.exec(cleanText))) {
        const n = Number(m[1] || m[3] || m[5]);
        const total = Number(m[2] || m[4] || m[6]);
        if (recordProgressMarker(turnEl, total, n)) changed = true;
      }
    }
    return changed;
  }

  function harvestDomTodoComments(turnEl) {
    if (!turnEl || !document.createTreeWalker || typeof NodeFilter === 'undefined') return;
    try {
      const walker = document.createTreeWalker(turnEl, NodeFilter.SHOW_COMMENT);
      let node;
      while ((node = walker.nextNode())) {
        const raw = `<!--${node.nodeValue || ''}-->`;
        if (TODO_DONE_RE.test(raw)) turnTodoDone.add(turnEl);
        PROGRESS_RE.lastIndex = 0;
        let m;
        while ((m = PROGRESS_RE.exec(raw))) {
          recordProgressMarker(turnEl, Number(m[2] || m[4] || m[6]), Number(m[1] || m[3] || m[5]));
        }
      }
    } catch {}
  }

  function applyProgressMarker(turnEls, items) {
    if (!items || !items.length) return items;
    const list = Array.isArray(turnEls) ? turnEls : [turnEls];
    for (const t of list) {
      if (t && turnTodoDone.has(t)) {
        return items.map((it) => ({ status: 'completed', html: it.html }));
      }
    }
    let maxN = 0;
    for (const t of list) {
      const byTotal = t && turnProgressByTotal.get(t);
      const n = byTotal ? byTotal.get(items.length) || 0 : 0;
      if (n > maxN) maxN = n;
    }
    if (!maxN) return items;
    const next = items.map((it, i) => ({
      status: i < maxN - 1 ? 'completed' : i === maxN - 1 ? 'in_progress' : 'pending',
      html: it.html
    }));
    return todoProgress(next) > todoProgress(items) ? next : items;
  }

  const CANCELLED_TURN_RE = /(?:^|\s)(?:cancelled|canceled|interrupted|stopped by user|已取消|已中断|已停止)(?:\s|$)/i;
  function isFinalPhaseNaturallyDone(items, turnEls) {
    if (!items || items.length < 2) return false;
    const lastIdx = items.length - 1;
    if (items[lastIdx].status !== 'in_progress') return false;
    for (let i = 0; i < lastIdx; i++) {
      if (items[i].status !== 'completed') return false;
    }
    const list = Array.isArray(turnEls) ? turnEls : [turnEls];
    let reachedFinal = false;
    for (const t of list) {
      const byTotal = t && turnProgressByTotal.get(t);
      if (byTotal && (byTotal.get(items.length) || 0) >= items.length) {
        reachedFinal = true;
      }
    }
    if (!reachedFinal) return false;
    const lastTurn = list[list.length - 1];
    if (lastTurn && CANCELLED_TURN_RE.test((lastTurn.textContent || '').slice(-160))) return false;
    return true;
  }

  const paneSliceActiveOrigins = new WeakMap();
  const paneSliceLastLen = new WeakMap();

  function sliceStepsFromBranch(f) {
    const ts = f && f.memoizedProps && f.memoizedProps.trajectorySlice;
    return ts && Array.isArray(ts.stepsInSlice) ? ts.stepsInSlice : null;
  }

  function harvestPaneSliceOrigins(pane) {
    if (!pane || !pane.root) return;
    const vp = pane.root.querySelector('[data-testid="autoscroll-viewport"]');
    if (!vp) return;
    const fk = Object.keys(vp).find((k) => k.startsWith('__reactFiber$'));
    let f = fk ? vp[fk] : null;
    let sliceSteps = null;
    for (let i = 0; i < 12 && f; i++, f = f.return) {
      const a = sliceStepsFromBranch(f);
      const b = sliceStepsFromBranch(f.alternate);
      const pick = (b ? b.length : 0) > (a ? a.length : 0) ? b : a;
      if (pick && pick.length) {
        sliceSteps = pick;
        break;
      }
    }
    if (!sliceSteps) return;
    if (paneSliceLastLen.get(pane.root) === sliceSteps.length && paneSliceActiveOrigins.has(pane.root)) return;
    paneSliceLastLen.set(pane.root, sliceSteps.length);

    let origins = paneSliceActiveOrigins.get(pane.root);
    if (!origins) {
      origins = new Map();
      paneSliceActiveOrigins.set(pane.root, origins);
    }
    const openMarkerTotals = new Set();
    for (let i = 0; i < sliceSteps.length; i++) {
      const s = sliceSteps[i];
      const v = s && s.step && s.step.case === 'plannerResponse' ? s.step.value : null;
      if (!v || typeof v !== 'object') continue;
      const text = v.modifiedResponse || v.response || '';
      if (!text) continue;

      const cleanText = stripAllCode(text);
      PROGRESS_RE.lastIndex = 0;
      let m;
      while ((m = PROGRESS_RE.exec(cleanText))) {
        const total = Number(m[2] || m[4] || m[6]);
        if (total >= 2) openMarkerTotals.add(total);
      }

      for (const items of extractTaskLists(text)) {
        if (hasActiveTodo(items)) {
          origins.set(todoSignature(items), items);
        } else if (isAllTodoCompleted(items) && openMarkerTotals.has(items.length)) {
          origins.set(todoSignature(items), items);
          openMarkerTotals.delete(items.length);
        }
      }
    }
  }

  function paneHasSliceActiveOrigin(pane, items) {
    const origins = pane && paneSliceActiveOrigins.get(pane.root);
    if (!origins || !items) return false;
    for (const originItems of origins.values()) {
      if (isChecklistEvolution(originItems, items)) return true;
    }
    return false;
  }

  function turnHasActiveTodoOrigin(turnEl, items) {
    if (!turnEl || !items) return false;
    const mem = turnTodoMemory.get(turnEl);
    if (!mem) return false;
    for (const rec of mem.values()) {
      if (hasActiveTodo(rec.items) && isChecklistEvolution(rec.items, items)) return true;
    }
    return false;
  }

  function turnHasUnclaimedProgressMarker(turnEl, total) {
    const byTotal = turnEl && turnProgressByTotal.get(turnEl);
    if (!byTotal || !byTotal.has(total)) return false;
    const mem = turnTodoMemory.get(turnEl);
    if (!mem) return true;
    for (const rec of mem.values()) {
      if (rec.items.length === total && isAllTodoCompleted(rec.items)) return false;
    }
    return true;
  }

  /*
   * When mid-turn planner steps are collapsed (`worked-for-collapsible` / `progress-updates-collapsible`) or
   * earlier turns in a multi-turn task are virtual-scroll unmounted by `autoscroll-viewport` (`v2.33.0+`),
   * only the final all-`[x]` `<ul>` may be mounted in the DOM. Check:
   *  1) `turnTodoMemory` (`[/]` evolution) or own `<!-- todo:N/M -->` marker on `turnEl`;
   *  2) preceding mounted `paneTurns` (`[/]` evolution, or an unclaimed `<!-- todo:N/M -->` sub-turn not yet closed);
   *  3) unmounted `[/]` origins in `trajectorySlice.stepsInSlice` on `autoscroll-viewport`.
   * Ordinary `[ ] / [x]` answer checklists (which never had an `[/]` step or `<!-- todo:N/M -->`) stay untouched.
   */
  function findStepActiveOriginTurns(pane, paneTurns, turnEl, items) {
    if (!items) return { matched: false, turns: [] };
    if (turnEl) {
      const ownMarkers = turnProgressByTotal.get(turnEl);
      if ((ownMarkers && ownMarkers.has(items.length)) || turnHasActiveTodoOrigin(turnEl, items)) {
        return { matched: true, turns: [turnEl] };
      }
    }
    if (paneTurns && paneTurns.length) {
      const endIdx = turnEl ? paneTurns.indexOf(turnEl) : -1;
      const upper = endIdx >= 0 ? endIdx : paneTurns.length;
      let seenInterveningCompletedSameLen = false;
      for (let i = upper - 1; i >= 0; i--) {
        const prevTurn = paneTurns[i];
        if (turnHasActiveTodoOrigin(prevTurn, items)) {
          return { matched: true, turns: turnEl ? [prevTurn, turnEl] : [prevTurn] };
        }
        if (!seenInterveningCompletedSameLen && turnHasUnclaimedProgressMarker(prevTurn, items.length)) {
          return { matched: true, turns: turnEl ? [prevTurn, turnEl] : [prevTurn] };
        }
        const prevMem = turnTodoMemory.get(prevTurn);
        if (prevMem) {
          for (const rec of prevMem.values()) {
            if (rec.items.length === items.length && isAllTodoCompleted(rec.items)) {
              seenInterveningCompletedSameLen = true;
            }
          }
        }
      }
    }
    if (pane && paneHasSliceActiveOrigin(pane, items)) {
      return { matched: true, turns: turnEl ? [turnEl] : [] };
    }
    return { matched: false, turns: [] };
  }

  function bestRememberedInTurn(turnEl) {
    const mem = turnEl && turnTodoMemory.get(turnEl);
    if (!mem || mem.size === 0) return null;
    let best = null;
    for (const rec of mem.values()) {
      if (!best || rec.progress > best.progress || (rec.progress === best.progress && rec.seq > best.seq)) {
        best = rec;
      }
    }
    return best;
  }

  /**
   * Only *execution-progress* checklists are taken over:
   *  - a cluster starts with a list containing an active `[/]` item (either mounted in DOM or recorded in
   *    `container.steps` when Knowledge Work mode hides mid-turn steps);
   *  - later lists join it when they evolve from it (same items) or, across turns, when they still look like
   *    progress (`[/]` present or 100% done).
   * Ordinary answer checklists (materials, review points: only `[ ]` / `[x]`, no `[/]` anywhere) stay native.
   * A taken-over list is never hidden without a visible replacement card.
   */
  function syncTodoCards(panes) {
    const touched = new Set();
    const activeDocks = new Set();

    if (FEAT.todoCard) {
      hideLegacyProgressParagraphs();

      const paneMeta = new Map();
      for (const pane of panes) {
        const paneLive = isPaneActivelyGenerating(pane);
        const paneTurns = Array.from(pane.root.querySelectorAll('[data-testid="agent-response"]'));
        const latestPaneTurn = paneTurns.length ? paneTurns[paneTurns.length - 1] : null;
        harvestPaneSliceOrigins(pane);
        for (const tEl of paneTurns) {
          harvestStepChecklists(tEl, paneLive && tEl === latestPaneTurn);
          harvestDomTodoComments(tEl);
        }
        paneMeta.set(pane, { paneLive, paneTurns, latestPaneTurn });
      }

      const byPane = new Map();
      for (const ul of document.querySelectorAll('ul.contains-task-list')) {
        const items = parseTodoUl(ul);
        if (!items) continue;
        const turnEl = ul.closest('[data-testid="agent-response"]');
        const pane = turnEl ? paneFor(turnEl, panes) : null;
        if (turnEl && !pane) harvestStepChecklists(turnEl, false);
        const key = pane || ul; /* orphan lists form their own group */
        let group = byPane.get(key);
        if (!group) {
          group = { pane, entries: [] };
          byPane.set(key, group);
        }
        group.entries.push({ ul, items, turnEl });
        rememberTurnTodo(turnEl, items);
      }

      const handledLiveTurns = new Set();

      for (const group of byPane.values()) {
        const meta = group.pane ? paneMeta.get(group.pane) : null;
        const paneTurns = meta ? meta.paneTurns : null;
        const paneLive = Boolean(meta && meta.paneLive);
        const latestPaneTurn = meta ? meta.latestPaneTurn : null;

        const clusters = [];
        for (const entry of group.entries) {
          const last = clusters[clusters.length - 1];
          const active = hasActiveTodo(entry.items);
          let join = false;
          if (last) {
            const evolved = isChecklistEvolution(last.items, entry.items);
            const sameTurn = Boolean(entry.turnEl && last.lastTurnEl === entry.turnEl);
            if (sameTurn) {
              join = evolved;
            } else {
              const looksLikeProgress = active || isAllTodoCompleted(entry.items);
              join = evolved || (!isAllTodoCompleted(last.items) && looksLikeProgress);
            }
          }
          if (join) {
            last.lists.push(entry.ul);
            last.items = entry.items;
            if (entry.turnEl) {
              last.lastTurnEl = entry.turnEl;
              if (!last.turnEls.includes(entry.turnEl)) last.turnEls.push(entry.turnEl);
            }
          } else {
            const origin = active
              ? { matched: true, turns: entry.turnEl ? [entry.turnEl] : [] }
              : findStepActiveOriginTurns(group.pane, paneTurns, entry.turnEl, entry.items);
            if (origin.matched) {
              clusters.push({
                lists: [entry.ul],
                items: entry.items,
                lastTurnEl: entry.turnEl || null,
                turnEls: origin.turns.length ? origin.turns : entry.turnEl ? [entry.turnEl] : []
              });
            }
          }
          /* else: ordinary checklist, left untouched */
        }

        for (let i = 0; i < clusters.length; i++) {
          const cluster = clusters[i];
          for (const ul of cluster.lists) touched.add(ul);

          /* Only relay a prior incomplete checklist into latestPaneTurn when latestPaneTurn itself signals
             continuation (`<!-- todo:N/M -->` or an evolved checklist), preventing old cards from resurrecting on fresh prompts */
          const isLastCluster = i === clusters.length - 1;
          const relayedIntoLatest =
            paneLive &&
            isLastCluster &&
            Boolean(latestPaneTurn) &&
            cluster.lastTurnEl !== latestPaneTurn &&
            !isAllTodoCompleted(cluster.items) &&
            turnContinuesChecklist(latestPaneTurn, cluster.items);
          const candidateTurns =
            relayedIntoLatest && !cluster.turnEls.includes(latestPaneTurn)
              ? [...cluster.turnEls, latestPaneTurn]
              : cluster.turnEls;

          /* Scan forward across mounted turns in case a later step / split turn recorded completion (`all-[x]` or `<!-- todo:done -->`) */
          const firstTurnIdx = paneTurns && cluster.turnEls.length ? paneTurns.indexOf(cluster.turnEls[0]) : -1;
          const memoryScanTurns = paneTurns && firstTurnIdx >= 0 ? paneTurns.slice(firstTurnIdx) : candidateTurns;
          const nextClusterStartTurn = i + 1 < clusters.length ? clusters[i + 1].turnEls[0] : null;
          const progressScanTurns = [];
          for (const tEl of memoryScanTurns) {
            if (nextClusterStartTurn && tEl === nextClusterStartTurn) break;
            const remembered = latestRememberedTodo(tEl, cluster.items);
            if (remembered) cluster.items = remembered;
            if (
              candidateTurns.includes(tEl) ||
              turnTodoDone.has(tEl) ||
              (turnProgressByTotal.get(tEl) && turnProgressByTotal.get(tEl).has(cluster.items.length))
            ) {
              progressScanTurns.push(tEl);
            }
          }
          cluster.items = applyProgressMarker(progressScanTurns.length ? progressScanTurns : candidateTurns, cluster.items);
          const completed =
            isAllTodoCompleted(cluster.items) ||
            (!paneLive && isFinalPhaseNaturallyDone(cluster.items, progressScanTurns.length ? progressScanTurns : candidateTurns));

          const isDockedLiveCluster =
            paneLive &&
            !completed &&
            isLastCluster &&
            Boolean(latestPaneTurn) &&
            (cluster.lastTurnEl === latestPaneTurn || relayedIntoLatest);
          const mountedDock = isDockedLiveCluster ? renderLiveDockedTodoCard(latestPaneTurn, cluster.items) : null;

          if (mountedDock) {
            handledLiveTurns.add(latestPaneTurn);
            activeDocks.add(mountedDock);
            for (const ul of cluster.lists) markMergedUl(ul);
          } else if (completed) {
            /* Completed task: disappear cleanly (like Claude Desktop) and keep original checklist <ul> nodes hidden */
            for (const ul of cluster.lists) markMergedUl(ul);
          } else {
            /* Interrupted / paused mid-way: keep a visible Paused card at the latest list */
            const anchorUl = cluster.lists[cluster.lists.length - 1];
            for (let j = 0; j < cluster.lists.length - 1; j++) markMergedUl(cluster.lists[j]);
            renderInlineTodoCard(anchorUl, cluster.items, true);
          }
        }
      }

      /* Fallback when ALL <ul> nodes in the live turn were unmounted off-screen or hidden in Knowledge Work mode */
      for (const pane of panes) {
        const meta = paneMeta.get(pane);
        if (!meta || !meta.paneLive || !meta.latestPaneTurn || handledLiveTurns.has(meta.latestPaneTurn)) continue;
        const { paneTurns, latestPaneTurn } = meta;
        let best = bestRememberedInTurn(latestPaneTurn);
        let turnScope = [latestPaneTurn];
        if (!best && paneTurns.length >= 2) {
          const prevTurn = paneTurns[paneTurns.length - 2];
          const prevBest = bestRememberedInTurn(prevTurn);
          if (
            prevBest &&
            !isAllTodoCompleted(prevBest.items) &&
            turnContinuesChecklist(latestPaneTurn, prevBest.items)
          ) {
            best = prevBest;
            turnScope = [prevTurn, latestPaneTurn];
          }
        }
        if (best && (hasActiveTodo(best.items) || turnScope.some((t) => turnHasActiveTodoOrigin(t, best.items)))) {
          const items = applyProgressMarker(turnScope, best.items);
          if (!isAllTodoCompleted(items)) {
            const mountedDock = renderLiveDockedTodoCard(latestPaneTurn, items);
            if (mountedDock) activeDocks.add(mountedDock);
          }
        }
      }
    }

    /* release lists we no longer own (re-render, rule change, feature off) */
    for (const ul of document.querySelectorAll('ul[data-ag-todo-merged], ul[data-ag-todo-primary]')) {
      if (!touched.has(ul)) restoreNativeUl(ul);
    }
    for (const card of document.querySelectorAll('[data-ag-todo-mount]')) {
      if (card.parentElement && card.parentElement.hasAttribute('data-ag-todo-dock')) continue;
      const prev = card.previousElementSibling;
      if (!prev || !prev.hasAttribute('data-ag-todo-primary')) card.remove();
    }
    for (const dock of document.querySelectorAll('[data-ag-todo-dock="true"]')) {
      if (!activeDocks.has(dock)) dock.remove();
    }
  }

  function isActivelyRunningRow(el, isLastCandidate, turnGenerating) {
    if (!turnGenerating || !isLastCandidate) return false;
    if (el.getAttribute('data-testid') === 'ephemeral-tool-status') return true;
    const span = el.querySelector(':scope > span[title], :scope > span[data-ag-orig-title]');
    const raw =
      (span && (span.getAttribute('data-ag-orig-title') || span.getAttribute('title'))) ||
      el.getAttribute('data-ag-orig-aria-label') ||
      el.getAttribute('aria-label') ||
      el.textContent ||
      '';
    return !PAST_LABEL_RE.test(raw.trim());
  }

  function syncRunningToolIndicators(panesArg) {
    if (disposed) return;
    const candidates = FEAT.runningTimer
      ? Array.from(document.querySelectorAll('button[data-testid="tool-group-collapsible"], [data-testid="ephemeral-tool-status"]'))
      : [];
    const panes = panesArg || collectPanes();
    const globalGenerating =
      Boolean(document.querySelector('button[data-testid="input-cancel-button"]')) ||
      panes.some((p) => paneHasWorkingHeading(p.root));

    /* "last row" and "generating" are evaluated per pane, so a busy pane never lights up another one */
    const lastInPane = new Map();
    const paneOfEl = new Map();
    for (const el of candidates) {
      const pane = paneFor(el, panes);
      paneOfEl.set(el, pane);
      lastInPane.set(pane, el);
    }
    const generatingCache = new Map();
    const paneGenerating = (pane) => {
      if (!pane) return panes.length === 0 && globalGenerating;
      if (!generatingCache.has(pane)) {
        generatingCache.set(
          pane,
          Boolean(pane.inputBox.querySelector('button[data-testid="input-cancel-button"]')) ||
            paneHasWorkingHeading(pane.root)
        );
      }
      return generatingCache.get(pane);
    };

    let activeCount = 0;
    const now = Date.now();
    for (const el of candidates) {
      const pane = paneOfEl.get(el);
      const isRunning = isActivelyRunningRow(el, lastInPane.get(pane) === el, paneGenerating(pane));
      let orbit = el.querySelector(':scope > .ag-orbit-dots');
      let timerEl = el.querySelector(':scope > .ag-elapsed-timer');

      if (isRunning) {
        activeCount += 1;
        let startTs = runningTimers.get(el);
        if (!startTs) {
          startTs = now;
          runningTimers.set(el, startTs);
        }
        if (!orbit) {
          orbit = document.createElement('span');
          orbit.className = 'ag-orbit-dots';
          orbit.setAttribute('aria-hidden', 'true');
          orbit.innerHTML = '<i></i><i></i>';
          el.insertBefore(orbit, el.firstChild);
        }
        const secs = Math.max(1, Math.floor((now - startTs) / 1000));
        if (!timerEl) {
          timerEl = document.createElement('span');
          timerEl.className = 'ag-elapsed-timer';
          const chevron = el.querySelector(':scope > svg');
          if (chevron) {
            el.insertBefore(timerEl, chevron);
          } else {
            el.appendChild(timerEl);
          }
        }
        const txt = `${secs}s`;
        if (timerEl.textContent !== txt) timerEl.textContent = txt;
      } else {
        if (orbit) orbit.remove();
        if (timerEl) timerEl.remove();
        runningTimers.delete(el);
      }
    }
    /* stale indicators on rows that are no longer candidates */
    if (!FEAT.runningTimer) {
      document.querySelectorAll('.ag-orbit-dots, .ag-elapsed-timer').forEach((n) => n.remove());
    }

    const keepPolling = activeCount > 0 || (FEAT.todoCard && globalGenerating);
    if (keepPolling && !timerIntervalId) {
      timerIntervalId = setInterval(() => {
        const ps = collectPanes();
        syncTodoCards(ps);
        syncRunningToolIndicators(ps);
      }, 450);
    } else if (!keepPolling && timerIntervalId) {
      clearInterval(timerIntervalId);
      timerIntervalId = null;
    }
  }

  /* Inline code & file-mention pill CJK boundary hygiene:
   * 1. Strips redundant ASCII spaces (`" "`) between boxed pills (`:not(pre) > code`, `bdi.context-scope-mention`)
   *    and adjacent CJK characters / fullwidth punctuation so pills don't push `，。；：（）` away with double gaps.
   * 2. Attaches U+2060 WORD JOINER between atomic inline pills (`inline-flex` file mentions) and adjacent CJK
   *    closing/middle punctuation (`、，。！？；：）》」』】`) or opening brackets (`（《「『【`) so punctuation never wraps to line start.
   * Mutates `Text.nodeValue` only (zero childList mutations, zero React Fiber interference) and restores on `dispose()`. */
  const pillSiblingOrig = new WeakMap();
  const WORD_JOINER = '\u2060';
  const CJK_OR_FULL_PUNCT_END_SPACE_RE = /([\u4e00-\u9fff\u3000-\u303f\uff01-\uff60“‘])[ \t]+$/;
  const CJK_OR_FULL_PUNCT_LEAD_SPACE_RE = /^[ \t]+([\u4e00-\u9fff\u3000-\u303f\uff01-\uff60”’])/;
  const CJK_OPEN_PUNCT_END_RE = /[（《「『【〈“‘]$/;
  const CJK_CLOSE_OR_MID_PUNCT_START_RE = /^[、，。！？；：）》」』】〉”’—…]/;

  function syncInlinePillBoundaries() {
    if (disposed) return;
    const pills = document.querySelectorAll(
      '[data-testid="planner-response-text"] :is(:not(pre) > code, bdi.context-scope-mention), ' +
        '[data-markdown-root] :is(:not(pre) > code, bdi.context-scope-mention), ' +
        '.select-text :is(:not(pre) > code, bdi.context-scope-mention), ' +
        '.prose :is(:not(pre) > code, bdi.context-scope-mention)'
    );
    for (const pill of pills) {
      if (pill.closest('[contenteditable="true"], [data-lexical-editor="true"], pre, ul.contains-task-list, .ag-claude-todo-card')) {
        continue;
      }

      const prev = pill.previousSibling;
      if (prev && prev.nodeType === 3) {
        const cur = prev.nodeValue || '';
        let next = cur.replace(CJK_OR_FULL_PUNCT_END_SPACE_RE, '$1');
        if (CJK_OPEN_PUNCT_END_RE.test(next) && !next.endsWith(WORD_JOINER)) {
          next += WORD_JOINER;
        }
        if (next !== cur) {
          if (!pillSiblingOrig.has(prev)) pillSiblingOrig.set(prev, cur);
          prev.nodeValue = next;
        }
      }

      const fol = pill.nextSibling;
      if (fol && fol.nodeType === 3) {
        const cur = fol.nodeValue || '';
        const withoutWj = cur.startsWith(WORD_JOINER) ? cur.slice(1) : cur;
        let next = withoutWj.replace(CJK_OR_FULL_PUNCT_LEAD_SPACE_RE, '$1');
        if (CJK_CLOSE_OR_MID_PUNCT_START_RE.test(next)) {
          next = WORD_JOINER + next;
        }
        if (next !== cur) {
          if (!pillSiblingOrig.has(fol)) pillSiblingOrig.set(fol, cur);
          fol.nodeValue = next;
        }
      }
    }
  }

  function restoreInlinePillBoundaries() {
    const pills = document.querySelectorAll(':not(pre) > code, bdi.context-scope-mention');
    for (const pill of pills) {
      for (const node of [pill.previousSibling, pill.nextSibling]) {
        if (node && node.nodeType === 3 && pillSiblingOrig.has(node)) {
          node.nodeValue = pillSiblingOrig.get(node);
          pillSiblingOrig.delete(node);
        }
      }
    }
  }

  let lastSyncTs = 0;
  function syncStepStream() {
    rafPending = false;
    if (disposed) return;
    lastSyncTs = Date.now();
    if (FEAT.stepUnfold) {
      const workedBtns = document.querySelectorAll('button[data-testid="worked-for-collapsible"]');
      for (const btn of workedBtns) {
        const wrap = btn.parentElement;
        if (wrap && !wrap.hasAttribute('data-ag-inline-stream')) {
          wrap.setAttribute('data-ag-inline-stream', 'true');
        }
        if (btn.getAttribute('aria-expanded') === 'false' && !userToggled.has(btn)) {
          /* bounded: never fight the app in a click loop if it keeps re-collapsing the same node */
          const n = autoExpandCount.get(btn) || 0;
          if (n < 3) {
            autoExpandCount.set(btn, n + 1);
            btn.click();
          }
        }
      }
    }
    if (FEAT.collapseAnim) captureOpenToolPanels();
    const panes = collectPanes();
    syncTodoCards(panes);
    syncRunningToolIndicators(panes);
    syncInlinePillBoundaries();
    if (FEAT.contextRing) {
      ensureMetricsWrapped();
      ensureComposerContextRing();
      syncCompactVisualState(false);
    } else {
      const oldRing = document.getElementById('ag-claude-ctx-ring');
      if (oldRing) oldRing.remove();
      if (typeof closeQuotaPopover === 'function') closeQuotaPopover();
    }
    syncModelTriggerDisplay();
    syncSidebarEnhancements();
    syncProjectsWorkspace();
    reconcileSettingsPanel();
  }

  /* ==========================================================================
   * 5. Claude-Style Composer Context Ring + Live Plan Quota Popover + Slim Pill
   *    - Strips `Ctx ...`, `Out ...` & `+N sub` from `#ag-live-metrics-pill` while keeping `tok/s · TTFT`
   *    - Transforms `#ag-live-metrics-tooltip` into a compact 272px two-section Claude popover (with TTFT)
   *    - Mounts radial context progress ring right beside the Model Selector
   *    - Clicking opens real-time Usage Popover (`retrieveUserQuotaSummary` 5h & weekly buckets)
   * ========================================================================== */
  const RING_CIRC = 2 * Math.PI * 7;
  const SVG_COMPACT_ICON =
    '<svg width="11" height="11" viewBox="0 0 16 16" fill="none" aria-hidden="true">' +
    '<path d="M4.5 2.75L8 6.25L11.5 2.75M4.5 13.25L8 9.75L11.5 13.25" stroke="currentColor" stroke-width="1.55" stroke-linecap="round" stroke-linejoin="round"/>' +
    '</svg>';
  const SVG_COMPACT_DONE =
    '<svg width="11" height="11" viewBox="0 0 16 16" fill="none" aria-hidden="true">' +
    '<path d="M3.5 8.3L6.6 11.4L12.6 4.8" stroke="currentColor" stroke-width="1.65" stroke-linecap="round" stroke-linejoin="round"/>' +
    '</svg>';
  const QUOTA_CACHE_STORAGE_KEY = 'ag_claude_ux_quota_cache_v1';
  function loadPersistedQuotaSnapshot() {
    try {
      const raw = typeof localStorage === 'object' && localStorage ? localStorage.getItem(QUOTA_CACHE_STORAGE_KEY) : null;
      const parsed = raw ? JSON.parse(raw) : null;
      if (!parsed || typeof parsed !== 'object' || !Array.isArray(parsed.groups) || parsed.groups.length === 0) return null;
      return parsed;
    } catch {
      return null;
    }
  }
  function serializeQuotaGroups(groups) {
    if (!Array.isArray(groups)) return [];
    return groups.map((g) => ({
      displayName: String(g.displayName || ''),
      buckets: Array.isArray(g.buckets)
        ? g.buckets.map((b) => ({
            displayName: b && b.displayName ? String(b.displayName) : '',
            window: b && b.window ? String(b.window) : '',
            description: b && b.description ? String(b.description) : '',
            remainingFraction:
              b && b.remaining && b.remaining.case === 'remainingFraction' && typeof b.remaining.value === 'number'
                ? b.remaining.value
                : b && typeof b.remainingFraction === 'number'
                  ? b.remainingFraction
                  : 1,
            resetTime:
              b && b.resetTime && b.resetTime.seconds !== undefined
                ? { seconds: String(b.resetTime.seconds) }
                : undefined
          }))
        : []
    }));
  }
  const initialQuotaSnap = loadPersistedQuotaSnapshot();
  let cachedQuotaSvc = null;
  let cachedUserTierName = initialQuotaSnap ? String(initialQuotaSnap.tierName || '') : '';
  let cachedUserAccountKey = initialQuotaSnap ? String(initialQuotaSnap.accountKey || '') : '';
  let cachedQuotaGroups = initialQuotaSnap ? initialQuotaSnap.groups : null;
  let lastQuotaFetchTs = 0;
  let quotaFetchInFlight = null;
  let quotaHoldTimer = 0;
  let quotaWarmupDone = false;
  let quotaPopoverOpen = false;
  let selectedQuotaGroupIdx = -1;
  function persistQuotaSnapshot() {
    if (!Array.isArray(cachedQuotaGroups) || cachedQuotaGroups.length === 0) return;
    try {
      if (typeof localStorage === 'object' && localStorage) {
        localStorage.setItem(
          QUOTA_CACHE_STORAGE_KEY,
          JSON.stringify({
            accountKey: cachedUserAccountKey || '',
            tierName: cachedUserTierName || '',
            ts: Date.now(),
            groups: serializeQuotaGroups(cachedQuotaGroups)
          })
        );
      }
    } catch {}
  }
  let latestCtxState = { pct: 0, ratioText: '', outText: '', hasData: false, cascadeId: '' };
  let manualCompactPending = { cascadeId: '', startedAt: 0 };
  let compactedStaleSigByCid = new Map();
  let compactedMetaByCid = new Map();
  let lastObservedCompactKey = '';
  let compactPollTimerId = null;

  function getActiveCascadeId() {
    const m = (window.location.pathname || '').match(/\/c\/([0-9a-f-]+)/i);
    if (m) return m[1];
    if (window.__ag_watched_cascade_id) return String(window.__ag_watched_cascade_id);
    const sel = document.querySelector('[data-testid="conversation-row-sidebar"][data-selected="true"]');
    return (sel && sel.getAttribute('data-cascade-id')) || '';
  }

  function discoverAgentInputProps() {
    const inputBox = document.getElementById('antigravity.agentSidePanelInputBox');
    if (!inputBox) return null;
    const fk = Object.keys(inputBox).find((k) => k.startsWith('__reactFiber$'));
    let f = fk ? inputBox[fk] : null;
    for (let i = 0; i < 45 && f; i++, f = f.return) {
      const pr = f.memoizedProps;
      if (pr && typeof pr.handleSubmit === 'function') return pr;
    }
    return null;
  }

  function discoverComposerContextFromInputBox() {
    const inputBox = document.getElementById('antigravity.agentSidePanelInputBox');
    if (!inputBox) return null;
    const fk = Object.keys(inputBox).find((k) => k.startsWith('__reactFiber$'));
    let f = fk ? inputBox[fk] : null;
    for (let i = 0; i < 45 && f; i++, f = f.return) {
      const pr = f.memoizedProps;
      if (pr && pr.value && pr.value.inputBoxRef) return pr.value;
      let dep = f.dependencies ? f.dependencies.firstContext : null;
      while (dep) {
        const v = dep.memoizedValue;
        if (v && typeof v === 'object' && v.inputBoxRef) return v;
        dep = dep.next;
      }
    }
    return null;
  }

  function isPaneCurrentlyRunning(agentPropsArg) {
    const pr = agentPropsArg !== undefined ? agentPropsArg : discoverAgentInputProps();
    if (pr && typeof pr.isRunning === 'boolean') return pr.isRunning;
    return Boolean(document.querySelector('button[data-testid="input-cancel-button"]'));
  }

  function isCompactUserStepObj(s) {
    if (!s || (s.type !== 14 && (!s.step || s.step.case !== 'userInput'))) return false;
    const val = s.step && s.step.value;
    if (!val) return false;
    if (/^\s*\/compact\b/i.test(String(val.userResponse || ''))) return true;
    if (Array.isArray(val.items)) {
      return val.items.some(
        (it) =>
          it &&
          it.chunk &&
          it.chunk.case === 'item' &&
          it.chunk.value &&
          it.chunk.value.scopeItem &&
          it.chunk.value.scopeItem.case === 'slashCommand' &&
          it.chunk.value.scopeItem.value &&
          it.chunk.value.scopeItem.value.info &&
          it.chunk.value.scopeItem.value.info.name === 'compact'
      );
    }
    return false;
  }

  function isDomCompactUserStep(stepEl) {
    if (!stepEl) return false;
    if (stepEl.querySelector('[data-uri="slashCommand:compact"]')) return true;
    const contentEl = stepEl.querySelector('[data-testid="user-message-content"]');
    const raw = ((contentEl || stepEl).textContent || '').trim();
    return /^\/?compact$/i.test(raw);
  }

  function domTurnHasAssistantContent(turnEl) {
    if (!turnEl) return false;
    return Boolean(
      turnEl.querySelector(
        'button[data-testid="worked-for-collapsible"], [data-testid="thinking-collapsible-trigger"], button[data-testid="tool-group-collapsible"], [data-testid="ephemeral-tool-status"], .prose, p, pre, ul, ol'
      )
    );
  }

  function currentCtxStaleSig() {
    if (!latestCtxState.hasData) return '';
    return `${latestCtxState.ratioText}|${latestCtxState.outText}|${latestCtxState.pct}`;
  }

  function parseTokenLabelToCount(label) {
    const m = String(label || '').trim().match(/^([\d.]+)\s*([kKmM])?$/);
    if (!m) return 0;
    const num = Number(m[1]);
    if (!Number.isFinite(num) || num <= 0) return 0;
    const unit = (m[2] || '').toLowerCase();
    if (unit === 'm') return Math.round(num * 1000000);
    if (unit === 'k') return Math.round(num * 1000);
    return Math.round(num);
  }

  function extractCheckpointUsage(stepObj) {
    const meta = stepObj && stepObj.metadata;
    const usage =
      (meta && meta.modelUsage) ||
      (meta && Array.isArray(meta.retryInfos) && meta.retryInfos[0] && meta.retryInfos[0].usage) ||
      null;
    if (!usage) return { preTokens: 0, summaryTokens: 0 };
    const toTok = (v) => {
      const n = typeof v === 'bigint' ? Number(v) : Number(v || 0);
      return Number.isFinite(n) && n > 0 ? n : 0;
    };
    const preTokens = toTok(usage.inputTokens) + toTok(usage.cacheReadTokens);
    const respTok = toTok(usage.responseOutputTokens);
    const outTok = toTok(usage.outputTokens);
    return {
      preTokens,
      summaryTokens: respTok > 0 ? respTok : outTok
    };
  }

  /* Real-time /compact detector:
   * `daemon.mjs` reads `gen_metadata` (whose last row right after `/compact` is the summarization call itself, e.g. 483k/94%),
   * and `CHECKPOINT` (`step_type = 23`) writes no post-compact `gen_metadata` row until the user sends a new message.
   * Inspecting live `trajectorySlice` (with DOM fallback) lets the ring, popover & tooltip reflect `compacting` / `compacted` immediately. */
  function detectCompactStatus(curCidArg) {
    const curCid = curCidArg !== undefined ? curCidArg : getActiveCascadeId();
    const agentProps = discoverAgentInputProps();
    const running = isPaneCurrentlyRunning(agentProps);
    const cidKey = curCid || '__active__';
    const curSig = currentCtxStaleSig();

    const viewports = document.querySelectorAll('[data-testid="autoscroll-viewport"], .overflow-y-auto');
    for (const vp of viewports) {
      const fk = Object.keys(vp).find((k) => k.startsWith('__reactFiber$'));
      let f = fk ? vp[fk] : null;
      for (let i = 0; i < 35 && f; i++, f = f.return) {
        const p = f.memoizedProps;
        const slice = p && p.trajectorySlice;
        if (!slice || !Array.isArray(slice.stepsInSlice)) continue;
        if (curCid && slice.conversationId && slice.conversationId !== curCid) break;

        const arr = slice.stepsInSlice;
        let lastCompactUserIdx = -1;
        let lastCheckpointIdx = -1;
        let lastCheckpointStep = null;
        let lastRegularUserIdx = -1;
        let lastPlannerIdx = -1;

        for (let idx = 0; idx < arr.length; idx++) {
          const s = arr[idx];
          if (!s) continue;
          const sc = (s.step && s.step.case) || '';
          if (sc === 'checkpoint' || s.type === 23) {
            lastCheckpointIdx = idx;
            lastCheckpointStep = s;
          } else if (sc === 'userInput' || s.type === 14) {
            if (isCompactUserStepObj(s)) lastCompactUserIdx = idx;
            else lastRegularUserIdx = idx;
          } else if (sc === 'plannerResponse' || s.type === 15) {
            lastPlannerIdx = idx;
          }
        }

        const anchorIdx = Math.max(lastCompactUserIdx, lastCheckpointIdx);
        if (anchorIdx >= 0 && lastRegularUserIdx < anchorIdx && lastPlannerIdx < anchorIdx) {
          manualCompactPending = { cascadeId: '', startedAt: 0 };
          const cpStatus = lastCheckpointStep ? lastCheckpointStep.status : undefined;
          const cpFailed = Boolean(
            (lastCheckpointStep && lastCheckpointStep.step && lastCheckpointStep.step.value && lastCheckpointStep.step.value.modelSummarizationFailed) ||
              (typeof cpStatus === 'number' && cpStatus > 3)
          );
          if (cpFailed) {
            compactedStaleSigByCid.delete(cidKey);
            compactedMetaByCid.delete(cidKey);
            return 'idle';
          }
          if (running || (typeof cpStatus === 'number' && cpStatus > 0 && cpStatus < 3)) {
            if (lastCheckpointStep) {
              const cpUsage = extractCheckpointUsage(lastCheckpointStep);
              if (cpUsage.preTokens > 0 || cpUsage.summaryTokens > 0) {
                compactedMetaByCid.set(cidKey, cpUsage);
              }
            }
            return 'compacting';
          }
          if (curSig) compactedStaleSigByCid.set(cidKey, curSig);
          compactedMetaByCid.set(cidKey, extractCheckpointUsage(lastCheckpointStep));
          return 'compacted';
        }

        if (anchorIdx >= 0 && lastRegularUserIdx > anchorIdx) {
          const staleSig = compactedStaleSigByCid.get(cidKey);
          if (staleSig && curSig && staleSig === curSig && running) {
            return 'compacted';
          }
          if (staleSig && curSig && staleSig !== curSig) {
            compactedStaleSigByCid.delete(cidKey);
          }
          compactedMetaByCid.delete(cidKey);
        }

        if (
          manualCompactPending.cascadeId === cidKey &&
          Date.now() - manualCompactPending.startedAt < 15000
        ) {
          return 'compacting';
        }
        return 'idle';
      }
    }

    /* DOM fallback (covers jsdom unit tests & early mounts before trajectorySlice attaches) */
    const flowNodes = Array.from(
      document.querySelectorAll('[data-testid="user-input-step"], [data-testid="agent-response"]')
    );
    let lastUserFlowIdx = -1;
    for (let i = flowNodes.length - 1; i >= 0; i--) {
      if (flowNodes[i].getAttribute('data-testid') === 'user-input-step') {
        lastUserFlowIdx = i;
        break;
      }
    }
    if (lastUserFlowIdx >= 0 && isDomCompactUserStep(flowNodes[lastUserFlowIdx])) {
      const hasReplyAfter = flowNodes
        .slice(lastUserFlowIdx + 1)
        .some((el) => el.getAttribute('data-testid') === 'agent-response' && domTurnHasAssistantContent(el));
      if (!hasReplyAfter) {
        manualCompactPending = { cascadeId: '', startedAt: 0 };
        if (running) return 'compacting';
        if (curSig) compactedStaleSigByCid.set(cidKey, curSig);
        return 'compacted';
      }
    }

    const staleSig = compactedStaleSigByCid.get(cidKey);
    if (staleSig && curSig) {
      if (staleSig === curSig && running) return 'compacted';
      if (staleSig !== curSig) {
        compactedStaleSigByCid.delete(cidKey);
        compactedMetaByCid.delete(cidKey);
      }
    }

    if (
      manualCompactPending.cascadeId === cidKey &&
      Date.now() - manualCompactPending.startedAt < 15000
    ) {
      return 'compacting';
    }
    return 'idle';
  }

  function extractCompactLabels(ctxState, curCidArg) {
    const curCid = curCidArg !== undefined ? curCidArg : getActiveCascadeId();
    const cidKey = curCid || '__active__';
    const rawRatio = String((ctxState && ctxState.ratioText) || '');
    const parts = rawRatio.split('/');
    const preUsedFromRatio = (parts[0] || '').trim();
    const limitLabel = (parts[1] || '').trim();
    const limitTokens = parseTokenLabelToCount(limitLabel);
    const cpMeta = compactedMetaByCid.get(cidKey) || null;
    const preUsed =
      (cpMeta && cpMeta.preTokens > 0 ? fmtCompactTokens(cpMeta.preTokens) : '') || preUsedFromRatio;
    const summaryLabel =
      cpMeta && cpMeta.summaryTokens > 0 ? fmtCompactTokens(cpMeta.summaryTokens) : '';
    const summaryPct =
      cpMeta && cpMeta.summaryTokens > 0 && limitTokens > 0
        ? Math.max(1, Math.min(100, Math.round((cpMeta.summaryTokens / limitTokens) * 100)))
        : 0;
    return { preUsed, limitLabel, summaryLabel, summaryPct };
  }

  function ensureCompactPollTimer() {
    if (compactPollTimerId || disposed) return;
    compactPollTimerId = setInterval(() => {
      if (disposed) {
        clearInterval(compactPollTimerId);
        compactPollTimerId = null;
        return;
      }
      const st = detectCompactStatus();
      syncCompactVisualState(false);
      if (st !== 'compacting' && !quotaPopoverOpen) {
        clearInterval(compactPollTimerId);
        compactPollTimerId = null;
      }
    }, 500);
    if (compactPollTimerId && typeof compactPollTimerId.unref === 'function') {
      compactPollTimerId.unref();
    }
  }

  function syncCompactVisualState(forceRender) {
    if (disposed || !FEAT.contextRing) return;
    const curCid = getActiveCascadeId();
    const st = detectCompactStatus(curCid);
    const running = isPaneCurrentlyRunning();
    const { summaryLabel } = extractCompactLabels(latestCtxState, curCid);
    const key = `${curCid}|${st}|${running ? '1' : '0'}|${summaryLabel}`;
    if (!forceRender && key === lastObservedCompactKey) return;
    lastObservedCompactKey = key;

    if (st === 'compacting') ensureCompactPollTimer();

    if (window.__ag_last_metrics && typeof window.__ag_render_metrics === 'function') {
      try {
        window.__ag_render_metrics(window.__ag_last_metrics);
        return;
      } catch {}
    }
    updateComposerRingVisuals();
    if (quotaPopoverOpen) renderQuotaPopoverBody();
  }

  async function triggerConversationCompact() {
    if (disposed) return false;
    const curCid = getActiveCascadeId();
    const cidKey = curCid || '__active__';
    const curStatus = detectCompactStatus(curCid);
    if (curStatus === 'compacting' || curStatus === 'compacted') return false;

    const agentProps = discoverAgentInputProps();
    if (isPaneCurrentlyRunning(agentProps)) return false;

    manualCompactPending = { cascadeId: cidKey, startedAt: Date.now() };
    syncCompactVisualState(true);
    ensureCompactPollTimer();

    try {
      if (agentProps && typeof agentProps.handleSubmit === 'function') {
        const slashItems = Array.isArray(agentProps.slashCommandItems) ? agentProps.slashCommandItems : [];
        const compactDef = slashItems.find(
          (x) => x && (x.title === 'compact' || (x.info && x.info.name === 'compact'))
        );
        const slashInfo = (compactDef && compactDef.info) || {
          $typeName: 'exa.codeium_common_pb.SlashCommandInfo',
          name: 'compact',
          modelFacingText: '',
          type: 1,
          icon: 'collapse_all',
          displayName: '',
          logo: ''
        };
        const submitItems = [
          {
            $typeName: 'exa.codeium_common_pb.TextOrScopeItem',
            chunk: {
              case: 'item',
              value: {
                $typeName: 'exa.codeium_common_pb.ContextScopeItem',
                scopeItem: {
                  case: 'slashCommand',
                  value: {
                    $typeName: 'exa.codeium_common_pb.SlashCommandScopeItem',
                    argumentValues: {},
                    info: slashInfo
                  }
                }
              }
            }
          },
          {
            $typeName: 'exa.codeium_common_pb.TextOrScopeItem',
            chunk: {
              case: 'text',
              value: ' '
            }
          }
        ];
        await agentProps.handleSubmit(submitItems, [], () => {});
        syncCompactVisualState(true);
        return true;
      }

      const compCtx = discoverComposerContextFromInputBox();
      if (compCtx && !composerHasExistingDraft(compCtx)) {
        setComposerText(compCtx, '/compact ');
        const ref = compCtx.inputBoxRef && compCtx.inputBoxRef.current;
        if (ref && typeof ref.submit === 'function') {
          ref.submit();
          syncCompactVisualState(true);
          return true;
        }
      }
    } catch {}

    manualCompactPending = { cascadeId: '', startedAt: 0 };
    syncCompactVisualState(true);
    return false;
  }

  function fmtCompactTokens(n) {
    if (!Number.isFinite(n) || n < 0) return '';
    if (n < 1000) return String(Math.round(n));
    const k = n / 1000;
    return (k >= 100 ? String(Math.round(k)) : k.toFixed(1).replace(/\.0$/, '')) + 'k';
  }

  function fmtDurationSec(sec) {
    if (!Number.isFinite(sec) || sec < 0) return '';
    if (sec >= 60) {
      const total = Math.round(sec);
      const mins = Math.floor(total / 60);
      const rem = total % 60;
      return `${mins}m ${rem}s`;
    }
    return `${sec.toFixed(1)}s`;
  }

  function cacheTierForRate(rate) {
    if (!Number.isFinite(rate)) return '';
    const pct = Math.round(rate);
    if (pct >= 90) return 'high';
    if (pct >= 85) return 'mid';
    return 'low';
  }

  function parseMetricsTooltipData(rawTooltip) {
    if (!rawTooltip || typeof rawTooltip !== 'string') return null;
    const tmp = document.createElement('div');
    tmp.innerHTML = rawTooltip;
    const data = {
      streamTps: NaN,
      isBuffered: false,
      ttftSec: NaN,
      isHold: false,
      stepDur: NaN,
      lastCacheRate: NaN,
      stepOut: NaN,
      turnSteps: 1,
      turnOut: NaN,
      turnDur: NaN,
      sessionTurns: 1,
      sessionCalls: 1,
      ctxRatio: '',
      ctxPct: '',
      sessionCacheRate: NaN,
      sessionTotalOut: '',
      subLabel: '',
      subSub: '',
      warnHtml: ''
    };

    const secHdr = tmp.querySelector('.ag-tt-hdr.ag-tt-sec');
    if (secHdr) {
      const m = (secHdr.textContent || '').match(/(\d+)\s*轮提问\s*\/\s*(\d+)\s*次/);
      if (m) {
        data.sessionTurns = Number(m[1]) || 1;
        data.sessionCalls = Number(m[2]) || 1;
      }
    }

    tmp.querySelectorAll('.ag-tt-row').forEach((row) => {
      const lbl = (row.querySelector('.ag-tt-lbl')?.textContent || '').trim();
      const val = (row.querySelector('.ag-tt-val')?.textContent || '').trim();
      if (!lbl) return;

      if (lbl === '生成速度') {
        const sm = val.match(/流式\s*([\d.]+)\s*tok\/s/i);
        if (sm) {
          data.streamTps = Number(sm[1]);
          data.isBuffered = false;
        } else {
          const em = val.match(/([\d.]+)\s*tok\/s/i);
          if (em) {
            data.streamTps = Number(em[1]);
            data.isBuffered = true;
          }
        }
      } else if (lbl === '响应耗时') {
        const fm = val.match(/(TTFT|等待)\s*([\d.]+)s/i);
        if (fm) {
          data.isHold = fm[1] === '等待';
          data.ttftSec = Number(fm[2]);
        }
        const tm = val.match(/总计\s*([\d.]+)s/i);
        if (tm) data.stepDur = Number(tm[1]);
      } else if (lbl === '当前上下文') {
        const cm = val.match(/,\s*([\d.]+)%\)/);
        if (cm) data.lastCacheRate = Number(cm[1]);
      } else if (lbl === '本步输出量') {
        const om = val.match(/^([\d,]+)/);
        if (om) data.stepOut = Number(om[1].replace(/,/g, ''));
      } else if (/^本轮合计/.test(lbl)) {
        const sm = lbl.match(/\((\d+)\s*步\)/);
        if (sm) data.turnSteps = Number(sm[1]) || 1;
        const om = val.match(/^输出\s*([\d,]+)/);
        if (om) data.turnOut = Number(om[1].replace(/,/g, ''));
        const dm = val.match(/耗时\s*([\d.]+)s/i);
        if (dm) data.turnDur = Number(dm[1]);
      } else if (lbl === '压缩水位线') {
        const wm = val.match(/^(.+?)\s*\((\d+%)\)/);
        if (wm) {
          data.ctxRatio = wm[1].trim();
          data.ctxPct = wm[2];
        }
      } else if (lbl === '累计输入量') {
        const hm = val.match(/命中率\s*([\d.]+)%/);
        if (hm) data.sessionCacheRate = Number(hm[1]);
      } else if (/^子\s*Agent/i.test(lbl)) {
        const cm = lbl.match(/\((\d+)/);
        const syncing = lbl.includes('同步中');
        if (cm) {
          data.subLabel = `+${cm[1]} 个`;
          const outM = val.match(/输出\s*([^\s·]+)/);
          if (outM) data.subSub = `输出 ${outM[1]}`;
          else if (syncing) data.subSub = '同步中';
        } else if (syncing) {
          data.subLabel = '同步中';
        }
      } else if (lbl === '累计输出量') {
        const om = val.match(/总计\s*([^\s(]+)/);
        if (om) data.sessionTotalOut = om[1];
      }
    });

    const warnEl = tmp.querySelector('.ag-tt-warn');
    if (warnEl) data.warnHtml = warnEl.outerHTML;

    if (!Number.isFinite(data.streamTps) && !data.ctxRatio) return null;
    return data;
  }

  function buildSlimMetricsTooltipHtml(d, ctxFallback, compactStatus) {
    const esc = (s) =>
      String(s || '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;');
    const row = (lbl, valHtml) =>
      `<div class="ag-ux-tt-row"><span class="ag-ux-tt-lbl">${esc(lbl)}</span><span class="ag-ux-tt-val">${valHtml}</span></div>`;

    const steps = d.turnSteps > 1 ? d.turnSteps : 1;
    const durVal = Number.isFinite(d.turnDur) ? d.turnDur : d.stepDur;
    const outVal = Number.isFinite(d.turnOut) ? d.turnOut : d.stepOut;
    const tpsText =
      Number.isFinite(d.streamTps) && d.streamTps > 0
        ? d.streamTps < 1
          ? d.streamTps.toFixed(1)
          : String(Math.round(d.streamTps))
        : '';
    const speedHtml = tpsText
      ? `${tpsText} tok/s${d.isBuffered ? `<span class="ag-ux-tt-sub">${L('缓冲', 'buffered')}</span>` : ''}`
      : '—';
    const ttftHtml = Number.isFinite(d.ttftSec) ? fmtDurationSec(d.ttftSec) : '';
    const durHtml = fmtDurationSec(durVal) || '—';
    const outHtml = fmtCompactTokens(outVal) || '—';

    const ctxRatio = d.ctxRatio || ctxFallback.ratioText || '';
    const ctxPct = d.ctxPct || (ctxFallback.hasData ? `${ctxFallback.pct}%` : '');
    const { preUsed, limitLabel, summaryLabel } = extractCompactLabels(
      { ratioText: ctxRatio },
      ctxFallback && ctxFallback.cascadeId
    );
    let ctxHtml = '—';
    if (compactStatus === 'compacting') {
      ctxHtml = `${L('压缩中…', 'Compacting…')}${preUsed ? `<span class="ag-ux-tt-sub">${L('原 ', 'was ')}${esc(preUsed)}</span>` : ''}`;
    } else if (compactStatus === 'compacted') {
      ctxHtml =
        summaryLabel && limitLabel
          ? `${esc(summaryLabel)} / ${esc(limitLabel)}<span class="ag-ux-tt-sub">${L('已压缩', 'Compacted')}${preUsed ? ` · ${L('原 ', 'was ')}${esc(preUsed)}` : ''}</span>`
          : `${L('已压缩', 'Compacted')}${preUsed ? `<span class="ag-ux-tt-sub">${L('原 ', 'was ')}${esc(preUsed)}</span>` : ''}`;
    } else if (ctxRatio) {
      ctxHtml = `${esc(ctxRatio)}${ctxPct ? `<span class="ag-ux-tt-sub">${esc(ctxPct)}</span>` : ''}`;
    }

    const lastCache = Number.isFinite(d.lastCacheRate) ? `${Math.round(d.lastCacheRate)}%` : '';
    const lastTier = cacheTierForRate(d.lastCacheRate);
    const sessCache = Number.isFinite(d.sessionCacheRate) ? `${Math.round(d.sessionCacheRate)}%` : '';
    const sessTier = cacheTierForRate(d.sessionCacheRate);
    const cacheHtml = lastCache
      ? `<span class="ag-ux-tt-cache" data-cache-tier="${lastTier}">${lastCache}</span>${sessCache ? `<span class="ag-ux-tt-sub">${L('累计 ', 'avg ')}${sessCache}</span>` : ''}`
      : sessCache
        ? `<span class="ag-ux-tt-cache" data-cache-tier="${sessTier}">${sessCache}</span>`
        : '—';

    const sec1List = [row(L('生成速度', 'Speed'), speedHtml)];
    if (ttftHtml) {
      sec1List.push(row(d.isHold ? L('首包等待', 'Hold') : L('首字耗时', 'TTFT'), ttftHtml));
    }
    sec1List.push(row(L('本轮耗时', 'Duration'), durHtml), row(L('本轮输出', 'Output'), outHtml));

    const sec2List = [row(L('上下文', 'Context'), ctxHtml), row(L('缓存命中', 'Cache hit'), cacheHtml)];
    if ((d.sessionTurns > 1 || d.subLabel) && d.sessionTotalOut) {
      sec2List.push(row(L('累计输出', 'Total out'), esc(d.sessionTotalOut)));
    }
    if (d.subLabel) {
      const subDisplay = FEAT.i18n ? d.subLabel : d.subLabel.replace(/\s*个$/, '').replace('同步中', 'syncing');
      const subSubDisplay = FEAT.i18n ? d.subSub : String(d.subSub || '').replace(/^输出\s+/, 'out ').replace('同步中', 'syncing');
      sec2List.push(
        row(
          L('子 Agent', 'Subagents'),
          `${esc(subDisplay)}${subSubDisplay ? `<span class="ag-ux-tt-sub">${esc(subSubDisplay)}</span>` : ''}`
        )
      );
    }

    return (
      `<div class="ag-ux-tt">` +
      `<div class="ag-ux-tt-sec">` +
      `<div class="ag-ux-tt-hdr"><span class="ag-ux-tt-title">${L('本轮响应', 'This turn')}</span><span class="ag-ux-tt-badge">${FEAT.i18n ? `${steps} 步` : `${steps} ${steps === 1 ? 'step' : 'steps'}`}</span></div>` +
      sec1List.join('') +
      `</div>` +
      `<div class="ag-ux-tt-div"></div>` +
      `<div class="ag-ux-tt-sec">` +
      `<div class="ag-ux-tt-hdr"><span class="ag-ux-tt-title">${L('当前会话', 'Session')}</span><span class="ag-ux-tt-badge">${FEAT.i18n ? `${d.sessionTurns} 轮` : `${d.sessionTurns} ${d.sessionTurns === 1 ? 'turn' : 'turns'}`}</span></div>` +
      sec2List.join('') +
      `</div>` +
      (d.warnHtml || '') +
      `</div>`
    );
  }

  function parseAndSlimMetricsPayload(payload) {
    if (!payload || typeof payload !== 'object') return payload;
    const rawInline = payload.__agOrigInlineHtml || payload.inlineHtml || '';
    const rawTooltip = payload.__agOrigTooltipHtml || payload.tooltipHtml || '';
    const curCid = getActiveCascadeId();

    if (payload.hasData && rawInline && (!curCid || payload.cascadeId === curCid)) {
      const parsedTt = parseMetricsTooltipData(rawTooltip);
      const tmp = document.createElement('div');
      tmp.innerHTML = rawInline;
      let ratioText = '';
      let pct = 0;
      let outText = '';

      const kids = Array.from(tmp.children);
      for (let i = 0; i < kids.length; i++) {
        const el = kids[i];
        const txt = (el.textContent || '').trim();
        if (/^0(?:\.0+)?\s*tok\/s$/i.test(txt)) {
          if (parsedTt && Number.isFinite(parsedTt.streamTps) && parsedTt.streamTps > 0 && parsedTt.streamTps < 1) {
            el.textContent = `${parsedTt.streamTps.toFixed(1)} tok/s`;
          } else {
            const next = el.nextElementSibling;
            if (next && next.classList.contains('ag-sep')) next.remove();
            else if (el.previousElementSibling && el.previousElementSibling.classList.contains('ag-sep')) {
              el.previousElementSibling.remove();
            }
            el.remove();
          }
        } else if (/^(TTFT|Hold)\s+([\d.]+)s$/i.test(txt)) {
          const dm = txt.match(/^(TTFT|Hold)\s+([\d.]+)s$/i);
          const sec = dm ? Number(dm[2]) : NaN;
          if (Number.isFinite(sec) && sec >= 60) {
            el.textContent = `${dm[1]} ${fmtDurationSec(sec)}`;
          }
        } else if (/^Ctx\b/i.test(txt)) {
          const m = txt.match(/Ctx\s+([^\s(]+)\s*(?:\((\d+)%\))?/i);
          if (m) {
            ratioText = m[1].replace('/', ' / ');
            pct = Math.max(0, Math.min(100, Number(m[2] || 0)));
          }
          const prev = el.previousElementSibling;
          if (prev && prev.classList.contains('ag-sep')) prev.remove();
          el.remove();
        } else if (/^Out\b/i.test(txt)) {
          outText = txt;
          const prev = el.previousElementSibling;
          if (prev && prev.classList.contains('ag-sep')) prev.remove();
          el.remove();
        } else if (el.classList.contains('ag-sub-badge') || /^\+?\d+\s*sub\b/i.test(txt)) {
          const prev = el.previousElementSibling;
          if (prev && prev.classList.contains('ag-sep')) prev.remove();
          el.remove();
        }
      }
      while (tmp.firstElementChild && tmp.firstElementChild.classList.contains('ag-sep')) {
        tmp.firstElementChild.remove();
      }

      latestCtxState = {
        pct,
        ratioText,
        outText,
        hasData: Boolean(ratioText),
        cascadeId: payload.cascadeId || curCid
      };

      const compactStatus = detectCompactStatus(curCid);
      const nextTooltipHtml = parsedTt
        ? buildSlimMetricsTooltipHtml(parsedTt, latestCtxState, compactStatus)
        : rawTooltip;
      const slimmed = Object.assign({}, payload, {
        __agOrigInlineHtml: rawInline,
        __agOrigTooltipHtml: rawTooltip,
        inlineHtml: tmp.innerHTML,
        tooltipHtml: nextTooltipHtml
      });
      return slimmed;
    }

    if (!curCid || payload.cascadeId !== curCid || !payload.hasData) {
      latestCtxState = { pct: 0, ratioText: '', outText: '', hasData: false, cascadeId: curCid };
    }
    return payload;
  }

  function positionMetricsTooltip(pill, tt) {
    if (!pill || !tt || !tt.querySelector('.ag-ux-tt')) return;
    const textEl = pill.querySelector('#ag-live-metrics-text');
    const anchor = textEl && textEl.offsetWidth > 0 ? textEl : pill;
    const r = anchor.getBoundingClientRect();
    const pillRect = pill.getBoundingClientRect();
    const ttWidth = 272;
    const isBottomRow = pill.getAttribute('data-ag-row-mode') === 'bottom';
    const idealLeft = isBottomRow ? r.left + r.width / 2 - ttWidth / 2 : r.left;
    const left = Math.round(Math.max(12, Math.min(idealLeft, window.innerWidth - ttWidth - 16)));
    const bottomPx = Math.round(
      Math.max(8, Math.min(window.innerHeight - pillRect.top + 8, window.innerHeight - (tt.offsetHeight || 220) - 12))
    );
    tt.style.left = `${left}px`;
    tt.style.bottom = `${bottomPx}px`;
  }

  const onMetricsPillMouseEnter = (e) => {
    if (disposed || !FEAT.contextRing) return;
    const pill = e.target && e.target.closest && e.target.closest('#ag-live-metrics-pill');
    if (!pill) return;
    const syncPos = () => {
      const tt = document.getElementById('ag-live-metrics-tooltip');
      if (tt) positionMetricsTooltip(pill, tt);
    };
    syncPos();
    queueMicrotask(syncPos);
  };

  const onMetricsPillMouseLeave = (e) => {
    if (disposed) return;
    const pill = e.target && e.target.closest && e.target.closest('#ag-live-metrics-pill');
    if (!pill) return;
    const tt = document.getElementById('ag-live-metrics-tooltip');
    if (tt && tt.getAttribute('data-ag-pinned') === '1') {
      tt.setAttribute('data-visible', '1');
    }
  };

  const onMetricsPillClick = (e) => {
    if (disposed || !FEAT.contextRing) return;
    const pill = e.target && e.target.closest && e.target.closest('#ag-live-metrics-pill');
    const tt = document.getElementById('ag-live-metrics-tooltip');
    if (!tt) return;
    if (pill) {
      e.preventDefault();
      e.stopPropagation();
      const willPin = tt.getAttribute('data-ag-pinned') !== '1';
      if (willPin) {
        positionMetricsTooltip(pill, tt);
        tt.setAttribute('data-ag-pinned', '1');
        tt.setAttribute('data-visible', '1');
      } else {
        tt.removeAttribute('data-ag-pinned');
        tt.removeAttribute('data-visible');
      }
      return;
    }
    if (tt.getAttribute('data-ag-pinned') === '1' && !tt.contains(e.target)) {
      tt.removeAttribute('data-ag-pinned');
      tt.removeAttribute('data-visible');
    }
  };

  document.addEventListener('mouseenter', onMetricsPillMouseEnter, true);
  document.addEventListener('mouseleave', onMetricsPillMouseLeave, true);
  document.addEventListener('click', onMetricsPillClick, true);

  /* Wrapped lazily (retried every sync) so load order vs. the upstream runtime does not matter.
     A stale wrapper left by an older instance is unwrapped first; after dispose or feature toggle-off ours restores original HTML. */
  let ownMetricsWrapper = null;
  function ensureMetricsWrapped() {
    let cur = window.__ag_render_metrics;
    if (typeof cur !== 'function' || cur === ownMetricsWrapper) return;
    while (cur && cur.__agSlimWrapped && typeof cur.__agOrig === 'function') cur = cur.__agOrig;
    const origRenderMetrics = cur;
    const wrappedRender = function (payload) {
      if (disposed || !FEAT.contextRing) {
        const rawPayload =
          payload && typeof payload === 'object'
            ? Object.assign({}, payload, {
                inlineHtml: payload.__agOrigInlineHtml !== undefined ? payload.__agOrigInlineHtml : payload.inlineHtml,
                tooltipHtml: payload.__agOrigTooltipHtml !== undefined ? payload.__agOrigTooltipHtml : payload.tooltipHtml
              })
            : payload;
        return origRenderMetrics.call(this, rawPayload);
      }
      const slimPayload = parseAndSlimMetricsPayload(payload);
      const ret = origRenderMetrics.call(this, slimPayload);
      if (payload && payload.__agOrigInlineHtml === undefined && window.__ag_last_metrics === slimPayload) {
        window.__ag_last_metrics.__agOrigInlineHtml = payload.inlineHtml;
      }
      if (payload && payload.__agOrigTooltipHtml === undefined && window.__ag_last_metrics === slimPayload) {
        window.__ag_last_metrics.__agOrigTooltipHtml = payload.tooltipHtml;
      }
      updateComposerRingVisuals();
      if (quotaPopoverOpen) renderQuotaPopoverBody();
      return ret;
    };
    wrappedRender.__agSlimWrapped = true;
    wrappedRender.__agOrig = origRenderMetrics;
    ownMetricsWrapper = wrappedRender;
    window.__ag_render_metrics = wrappedRender;

    if (window.__ag_last_metrics) {
      window.__ag_render_metrics(window.__ag_last_metrics);
    }
  }
  ensureMetricsWrapped();

  function discoverQuotaService(refreshAccount = false) {
    if (!refreshAccount && cachedQuotaSvc && cachedUserTierName && cachedUserAccountKey) return cachedQuotaSvc;
    const inputBox = document.getElementById('antigravity.agentSidePanelInputBox');
    if (!inputBox) return cachedQuotaSvc;
    const fk = Object.keys(inputBox).find((k) => k.startsWith('__reactFiber$'));
    let f = fk ? inputBox[fk] : null;
    const seen = new Set();
    let foundSvc = null;
    let foundTierName = '';
    let foundTierId = '';
    let foundEmail = '';

    const walkObj = (obj, depth) => {
      if (!obj || typeof obj !== 'object' || depth > 4 || seen.has(obj)) return;
      seen.add(obj);
      try {
        if (!foundSvc && typeof obj.retrieveUserQuotaSummary === 'function') {
          foundSvc = obj;
        }
        if (!foundTierName && obj.userTier && typeof obj.userTier.name === 'string' && obj.userTier.name.trim()) {
          foundTierName = obj.userTier.name.trim();
          foundTierId = typeof obj.userTier.id === 'string' ? obj.userTier.id.trim() : '';
          foundEmail = typeof obj.email === 'string' ? obj.email : typeof obj.userEmail === 'string' ? obj.userEmail : '';
        }
      } catch {}
      let keys = [];
      try {
        keys = Object.keys(obj).slice(0, 40);
      } catch {}
      for (const k of keys) {
        try {
          const v = obj[k];
          if (v && typeof v === 'object') walkObj(v, depth + 1);
        } catch {}
      }
    };

    for (let n = 0; n < 45 && f; n++, f = f.return) {
      walkObj(f.memoizedProps, 0);
      walkObj(f.memoizedState, 0);
      let dep = f.dependencies ? f.dependencies.firstContext : null;
      while (dep) {
        walkObj(dep.memoizedValue, 0);
        dep = dep.next;
      }
      if ((!foundSvc || !foundTierName) && f.alternate) {
        walkObj(f.alternate.memoizedProps, 0);
        walkObj(f.alternate.memoizedState, 0);
        let altDep = f.alternate.dependencies ? f.alternate.dependencies.firstContext : null;
        while (altDep) {
          walkObj(altDep.memoizedValue, 0);
          altDep = altDep.next;
        }
      }
      if (foundSvc && foundTierName) break;
    }

    if (foundSvc) cachedQuotaSvc = foundSvc;
    if (foundTierName) {
      const nextAccountKey = `${foundEmail}|${foundTierId}|${foundTierName}`;
      if (cachedUserAccountKey && cachedUserAccountKey !== nextAccountKey) {
        cachedQuotaGroups = null;
        lastQuotaFetchTs = 0;
        selectedQuotaGroupIdx = -1;
      }
      cachedUserTierName = foundTierName;
      cachedUserAccountKey = nextAccountKey;
    }
    return cachedQuotaSvc;
  }

  function invokeQuotaSummaryRpc(svc, forceRefresh) {
    const fn = svc && svc.retrieveUserQuotaSummary;
    if (typeof fn !== 'function') return Promise.resolve(null);
    let wantsBool = false;
    try {
      wantsBool = fn.length === 1 && /forceRefresh/.test(Function.prototype.toString.call(fn));
    } catch {}
    const arg = wantsBool ? Boolean(forceRefresh) : { forceRefresh: Boolean(forceRefresh) };
    return new Promise((resolve) => resolve(svc.retrieveUserQuotaSummary(arg)));
  }

  function fetchQuotaSummary(forceRefresh = false) {
    const svc = discoverQuotaService();
    if (!svc) return Promise.resolve(cachedQuotaGroups || []);
    const now = Date.now();
    if (!forceRefresh && cachedQuotaGroups && now - lastQuotaFetchTs < 5000) {
      return Promise.resolve(cachedQuotaGroups);
    }
    if (quotaFetchInFlight) return quotaFetchInFlight;

    quotaFetchInFlight = invokeQuotaSummaryRpc(svc, forceRefresh)
      .then((res) => {
        if (disposed) return [];
        const rawGroups = (res && res.response && res.response.groups) || (res && res.groups) || [];
        cachedQuotaGroups = rawGroups.filter((g) => g && Array.isArray(g.buckets) && g.buckets.length > 0);
        lastQuotaFetchTs = Date.now();
        persistQuotaSnapshot();
        if (quotaHoldTimer) {
          cancelLater(quotaHoldTimer);
          quotaHoldTimer = 0;
        }
        const popEl = document.getElementById('ag-claude-quota-popover');
        if (popEl) popEl.removeAttribute('data-loading-hold');
        if (quotaPopoverOpen) renderQuotaPopoverBody();
        return cachedQuotaGroups;
      })
      .catch(() => {
        cachedQuotaSvc = null; /* service object may belong to an unmounted tree: rediscover next time */
        if (quotaHoldTimer) {
          cancelLater(quotaHoldTimer);
          quotaHoldTimer = 0;
        }
        const popEl = document.getElementById('ag-claude-quota-popover');
        if (popEl) popEl.removeAttribute('data-loading-hold');
        return cachedQuotaGroups || [];
      })
      .finally(() => {
        quotaFetchInFlight = null;
      });
    return quotaFetchInFlight;
  }

  function formatResetLabel(bucket, usedPct) {
    const win = String(bucket.window || '').trim().toLowerCase();
    const secStr = bucket.resetTime && bucket.resetTime.seconds !== undefined ? String(bucket.resetTime.seconds) : '';
    const resetMs = secStr ? Number(secStr) * 1000 : 0;

    if (win === '5h' && usedPct === 0 && !bucket.description) {
      return L('从发送第一条消息时起算', 'Starts on first message');
    }
    if (!resetMs || Number.isNaN(resetMs)) {
      return usedPct === 0 ? L('从发送第一条消息时起算', 'Starts on first message') : '';
    }
    const diffMs = resetMs - Date.now();
    if (diffMs <= 60000) return L('即将重置', 'Resets soon');

    if (win === 'weekly') {
      const dt = new Date(resetMs);
      const weekdaysZh = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];
      const weekdaysEn = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
      const hh = String(dt.getHours()).padStart(2, '0');
      const mm = String(dt.getMinutes()).padStart(2, '0');
      return FEAT.i18n ? `${weekdaysZh[dt.getDay()]} ${hh}:${mm} 重置` : `Resets ${weekdaysEn[dt.getDay()]} ${hh}:${mm}`;
    }

    const totalMins = Math.floor(diffMs / 60000);
    const hrs = Math.floor(totalMins / 60);
    const mins = totalMins % 60;
    if (hrs > 0) {
      if (FEAT.i18n) return mins > 0 ? `${hrs} 小时 ${mins} 分后重置` : `${hrs} 小时后重置`;
      return mins > 0 ? `Resets in ${hrs}h ${mins}m` : `Resets in ${hrs}h`;
    }
    const m = Math.max(1, mins);
    return FEAT.i18n ? `${m} 分钟后重置` : `Resets in ${m}m`;
  }

  function localizeGroupShortName(name) {
    const s = String(name || '').trim();
    if (!s) return L('全部模型', 'All models');
    if (/^gemini(?:\s+models?)?$/i.test(s)) return L('Gemini 模型', 'Gemini');
    if (/claude/i.test(s) && /gpt/i.test(s)) return 'Claude / GPT';
    if (/^claude(?:\s+models?)?$/i.test(s)) return L('Claude 模型', 'Claude');
    return s;
  }

  function detectDefaultGroupIndex(groups) {
    if (!groups || groups.length <= 1) return 0;
    const inputBox = document.getElementById('antigravity.agentSidePanelInputBox');
    const trigger = inputBox && inputBox.querySelector('button[data-testid="model-selector-trigger"]');
    const txt = ((trigger ? trigger.textContent : inputBox ? inputBox.textContent : '') || '').trim().toLowerCase();
    const specificIdx = groups.findIndex((g) => {
      const dn = String(g.displayName || '').trim().toLowerCase();
      return dn && !/^gemini(?:\s+models?)?$/.test(dn) && !(/claude/.test(dn) && /gpt/.test(dn)) && txt.includes(dn);
    });
    if (specificIdx >= 0) return specificIdx;
    const want3p = /claude|sonnet|opus|gpt/i.test(txt);
    const exactFamilyIdx = groups.findIndex((g) => {
      const dn = String(g.displayName || '').trim();
      return want3p ? /claude|gpt/i.test(dn) : /^gemini(?:\s+models?)?$/i.test(dn);
    });
    if (exactFamilyIdx >= 0) return exactFamilyIdx;
    const broadIdx = groups.findIndex((g) =>
      want3p ? /claude|gpt/i.test(g.displayName || '') : /gemini/i.test(g.displayName || '')
    );
    return broadIdx >= 0 ? broadIdx : 0;
  }

  function barColorForPct(pct, warnAt = 70, critAt = 85) {
    if (pct >= critAt) return '#DC2626';
    if (pct >= warnAt) return '#D97706';
    return 'var(--primary, #2F75C3)';
  }

  function ensureQuotaPopover() {
    let pop = document.getElementById('ag-claude-quota-popover');
    if (pop) return pop;
    pop = document.createElement('div');
    pop.id = 'ag-claude-quota-popover';
    pop.setAttribute('data-ag-i18n-ignore', '1');
    pop.setAttribute('data-open', 'false');
    pop.addEventListener('click', (e) => {
      const compactBtn = e.target.closest('[data-ag-qp-compact]');
      if (compactBtn) {
        e.preventDefault();
        e.stopPropagation();
        if (!compactBtn.disabled) triggerConversationCompact();
        return;
      }
      const tabBtn = e.target.closest('[data-ag-quota-tab]');
      if (tabBtn) {
        e.stopPropagation();
        selectedQuotaGroupIdx = Number(tabBtn.getAttribute('data-ag-quota-tab')) || 0;
        renderQuotaPopoverBody();
        return;
      }
      const viewAll = e.target.closest('[data-ag-quota-view-all]');
      if (viewAll) {
        e.stopPropagation();
        closeQuotaPopover();
        const settingsBtn = document.querySelector('button[data-testid="settings-button"]');
        if (settingsBtn) {
          settingsBtn.click();
          let tries = 0;
          const jumpModels = () => {
            const modelsBtn = document.querySelector('button[data-testid="settings-nav-item-Models"]');
            if (modelsBtn) {
              modelsBtn.click();
            } else if (++tries < 12) {
              frame(jumpModels);
            }
          };
          frame(jumpModels);
        }
      }
    });
    document.body.appendChild(pop);
    return pop;
  }

  function positionQuotaPopover() {
    const ring = document.getElementById('ag-claude-ctx-ring');
    const pop = document.getElementById('ag-claude-quota-popover');
    if (!ring || !pop) return;
    const r = ring.getBoundingClientRect();
    const popW = 344;
    const left = Math.max(12, Math.min(Math.round(r.left - 84), window.innerWidth - popW - 14));
    const bottom = Math.max(12, Math.round(window.innerHeight - r.top + 10));
    pop.style.left = `${left}px`;
    pop.style.bottom = `${bottom}px`;
  }

  function renderQuotaPopoverBody() {
    const pop = ensureQuotaPopover();
    const curCid = getActiveCascadeId();
    const hasCtx = Boolean(curCid && latestCtxState.cascadeId === curCid && latestCtxState.hasData);
    const compactStatus = detectCompactStatus(curCid);
    const paneRunning = isPaneCurrentlyRunning();
    const { preUsed, limitLabel, summaryLabel, summaryPct } = extractCompactLabels(latestCtxState, curCid);

    let ctxPct = hasCtx ? latestCtxState.pct : 0;
    let ctxPctLabel = `${ctxPct}%`;
    let ctxSub = hasCtx
      ? `${latestCtxState.ratioText}${latestCtxState.outText ? ` · ${latestCtxState.outText}` : ''}`
      : L('当前会话暂无消耗', 'No usage yet');
    let ctxColor = barColorForPct(ctxPct, 70, 85);
    let fillCompactingAttr = '';
    let compactBtnHtml = '';

    if (compactStatus === 'compacting') {
      ctxPct = 14;
      ctxPctLabel = '…';
      ctxSub = preUsed ? L(`正在压缩 ${preUsed}…`, `Compacting ${preUsed}…`) : L('正在生成压缩摘要…', 'Summarizing context…');
      ctxColor = 'var(--primary, #2F75C3)';
      fillCompactingAttr = ' data-compacting="true"';
      compactBtnHtml = `<button type="button" class="ag-qp-compact-btn" data-ag-qp-compact="true" data-state="compacting" disabled title="${escapeHtml(L('正在总结历史并压缩上下文…', 'Summarizing history and compacting context…'))}">${SVG_COMPACT_ICON}<span>${L('压缩中…', 'Compacting…')}</span></button>`;
    } else if (compactStatus === 'compacted') {
      if (summaryLabel && limitLabel) {
        ctxPct = Math.max(2, summaryPct);
        ctxPctLabel = `${summaryPct}%`;
        ctxSub = `${summaryLabel} / ${limitLabel}`;
      } else {
        ctxPct = hasCtx ? 2 : 0;
        ctxPctLabel = '—';
        ctxSub = L('已完成压缩 · 下轮刷新', 'Compacted · refreshes next turn');
      }
      ctxColor = 'var(--primary, #2F75C3)';
      const doneTitle =
        preUsed && summaryLabel
          ? L(
              `已将 ${preUsed} 上下文压缩为 ${summaryLabel} 摘要，发下一条消息即按新上下文计费`,
              `Compacted ${preUsed} into a ${summaryLabel} summary; refreshes on next message`
            )
          : L('当前对话历史已完成压缩，发下一条消息即按新上下文计费', 'Context compacted; refreshes on next message');
      compactBtnHtml = `<button type="button" class="ag-qp-compact-btn" data-ag-qp-compact="true" data-state="compacted" disabled title="${escapeHtml(doneTitle)}">${SVG_COMPACT_DONE}<span>${L('已压缩', 'Compacted')}</span></button>`;
    } else if (!hasCtx) {
      compactBtnHtml = `<button type="button" class="ag-qp-compact-btn" data-ag-qp-compact="true" data-state="empty" disabled title="${escapeHtml(L('当前会话暂无可压缩上下文', 'No context to compact yet'))}">${SVG_COMPACT_ICON}<span>${L('压缩', 'Compact')}</span></button>`;
    } else if (paneRunning) {
      compactBtnHtml = `<button type="button" class="ag-qp-compact-btn" data-ag-qp-compact="true" data-state="busy" disabled title="${escapeHtml(L('请等待当前回复结束后再压缩上下文', 'Wait for the current response to finish before compacting'))}">${SVG_COMPACT_ICON}<span>${L('压缩', 'Compact')}</span></button>`;
    } else {
      const urgentAttr = ctxPct >= 85 ? ' data-urgent="crit"' : ctxPct >= 70 ? ' data-urgent="warn"' : '';
      compactBtnHtml = `<button type="button" class="ag-qp-compact-btn" data-ag-qp-compact="true" data-state="ready"${urgentAttr} title="${escapeHtml(L('立即执行 /compact 压缩当前对话上下文', 'Run /compact to compress this conversation context'))}">${SVG_COMPACT_ICON}<span>${L('压缩', 'Compact')}</span></button>`;
    }

    discoverQuotaService();
    const tierShort = cachedUserTierName
      ? cachedUserTierName.replace(/^Google\s+AI\s+/i, '').trim() || cachedUserTierName
      : '';
    const tierSuffix = tierShort ? ` · ${escapeHtml(tierShort)}` : '';

    const groups = cachedQuotaGroups || [];
    if (groups.length > 0 && (selectedQuotaGroupIdx < 0 || selectedQuotaGroupIdx >= groups.length)) {
      selectedQuotaGroupIdx = detectDefaultGroupIndex(groups);
    }

    let tabsHtml = '';
    if (groups.length > 1) {
      tabsHtml = `<div class="ag-qp-tabs">${groups
        .map((g, idx) => {
          const active = idx === selectedQuotaGroupIdx ? ' data-active="true"' : '';
          return `<button type="button" class="ag-qp-tab" data-ag-quota-tab="${idx}"${active}>${escapeHtml(localizeGroupShortName(
            g.displayName
          ))}</button>`;
        })
        .join('')}</div>`;
    }

    let quotaRowsHtml = '';
    if (!cachedQuotaGroups && quotaFetchInFlight) {
      quotaRowsHtml = `<div class="ag-qp-empty">${L('正在读取实时套餐限额…', 'Loading plan usage…')}</div>`;
    } else if (groups.length === 0) {
      quotaRowsHtml = `<div class="ag-qp-empty">${L('暂无可用套餐限额数据', 'No plan usage data available')}</div>`;
    } else {
      const grp = groups[selectedQuotaGroupIdx] || groups[0];
      const grpShort = localizeGroupShortName(grp.displayName);
      const sortedBuckets = (grp.buckets || []).slice().sort((a, b) => {
        const rank = (w) => (w === '5h' ? 0 : w === 'daily' ? 1 : 2);
        return rank(String(a.window || '').toLowerCase()) - rank(String(b.window || '').toLowerCase());
      });

      quotaRowsHtml = sortedBuckets
        .map((b) => {
          const rem =
            b.remaining && b.remaining.case === 'remainingFraction' && typeof b.remaining.value === 'number'
              ? b.remaining.value
              : typeof b.remainingFraction === 'number'
                ? b.remainingFraction
                : 1;
          const usedPct = Math.max(0, Math.min(100, Math.round((1 - rem) * 100)));
          const win = String(b.window || '').trim().toLowerCase();
          const title =
            win === '5h'
              ? L('5 小时限额', '5-hour limit')
              : win === 'weekly'
                ? L(`每周 · ${grpShort}`, `Weekly · ${grpShort}`)
                : win === 'daily'
                  ? L(`每日 · ${grpShort}`, `Daily · ${grpShort}`)
                  : b.displayName || L('使用限额', 'Usage limit');
          const resetTxt = formatResetLabel(b, usedPct);
          const fillCol = barColorForPct(usedPct, 75, 90);
          return `<div class="ag-qp-item">
            <div class="ag-qp-row">
              <span class="ag-qp-title">${escapeHtml(title)}</span>
              <span class="ag-qp-meta"><span class="ag-qp-reset">${escapeHtml(resetTxt)}</span><span class="ag-qp-pct">${usedPct}%</span></span>
            </div>
            <div class="ag-qp-track"><div class="ag-qp-fill" style="width:${usedPct}%;background:${fillCol}"></div></div>
          </div>`;
        })
        .join('');
    }

    pop.innerHTML = `
      <div class="ag-qp-hdr">
        <span class="ag-qp-tier">${L('套餐使用限额', 'Plan usage')}${tierSuffix}</span>
        <button type="button" class="ag-qp-all" data-ag-quota-view-all="true">
          <span>${L('查看全部', 'View all')}</span>
          <svg width="12" height="12" viewBox="0 0 16 16" fill="none" aria-hidden="true"><path d="M3.5 8h9m0 0L8.8 4.3M12.5 8l-3.7 3.7" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg>
        </button>
      </div>
      <div class="ag-qp-item">
        <div class="ag-qp-row">
          <span class="ag-qp-title-group">
            <span class="ag-qp-title">${L('当前上下文', 'Context window')}</span>
            ${compactBtnHtml}
          </span>
          <span class="ag-qp-meta"><span class="ag-qp-reset">${escapeHtml(ctxSub)}</span><span class="ag-qp-pct">${escapeHtml(ctxPctLabel)}</span></span>
        </div>
        <div class="ag-qp-track"><div class="ag-qp-fill"${fillCompactingAttr} style="width:${ctxPct}%;background:${ctxColor}"></div></div>
      </div>
      <div class="ag-qp-divider"></div>
      ${tabsHtml}
      <div class="ag-qp-group-list">${quotaRowsHtml}</div>
    `;
    positionQuotaPopover();
  }

  function openQuotaPopover() {
    if (typeof closeClaudeModelPopover === 'function' && modelPopoverOpen) {
      closeClaudeModelPopover();
    }
    quotaPopoverOpen = true;
    selectedQuotaGroupIdx = -1;
    discoverQuotaService(true);
    const needForce = !cachedQuotaGroups || Date.now() - lastQuotaFetchTs > 5000;
    fetchQuotaSummary(needForce);
    const ring = document.getElementById('ag-claude-ctx-ring');
    if (ring) ring.setAttribute('data-open', 'true');
    const pop = ensureQuotaPopover();
    if (!cachedQuotaGroups && quotaFetchInFlight) {
      pop.setAttribute('data-loading-hold', 'true');
      cancelLater(quotaHoldTimer);
      quotaHoldTimer = later(() => {
        quotaHoldTimer = 0;
        pop.removeAttribute('data-loading-hold');
      }, 90);
    } else {
      pop.removeAttribute('data-loading-hold');
    }
    renderQuotaPopoverBody();
    pop.setAttribute('data-open', 'true');
    positionQuotaPopover();
  }

  function closeQuotaPopover() {
    quotaPopoverOpen = false;
    cancelLater(quotaHoldTimer);
    quotaHoldTimer = 0;
    const ring = document.getElementById('ag-claude-ctx-ring');
    if (ring) ring.setAttribute('data-open', 'false');
    const pop = document.getElementById('ag-claude-quota-popover');
    if (pop) {
      pop.removeAttribute('data-loading-hold');
      pop.setAttribute('data-open', 'false');
    }
  }

  function updateComposerRingVisuals() {
    const ring = document.getElementById('ag-claude-ctx-ring');
    if (!ring) return;
    const curCid = getActiveCascadeId();
    const hasCtx = Boolean(curCid && latestCtxState.cascadeId === curCid && latestCtxState.hasData);
    const compactStatus = detectCompactStatus(curCid);
    const { preUsed, limitLabel, summaryLabel, summaryPct } = extractCompactLabels(latestCtxState, curCid);
    const arc = ring.querySelector('.ag-ctx-ring-arc');

    if (compactStatus === 'compacting') {
      const pct = 18;
      if (arc) {
        arc.style.strokeDashoffset = (RING_CIRC * (1 - pct / 100)).toFixed(2);
        arc.style.strokeOpacity = '1';
      }
      ring.setAttribute('data-level', 'normal');
      ring.setAttribute('data-compact-state', 'compacting');
      ring.title = preUsed
        ? L(`正在压缩上下文 (原 ${preUsed})… · 点击查看状态`, `Compacting context (was ${preUsed})… · Click for status`)
        : L('正在压缩上下文… · 点击查看状态', 'Compacting context… · Click for status');
      return;
    }

    if (compactStatus === 'compacted') {
      const pct = summaryPct > 0 ? Math.max(2, summaryPct) : hasCtx ? 2 : 0;
      if (arc) {
        arc.style.strokeDashoffset = (RING_CIRC * (1 - pct / 100)).toFixed(2);
        arc.style.strokeOpacity = pct <= 0 ? '0' : '1';
      }
      ring.setAttribute('data-level', 'normal');
      ring.setAttribute('data-compact-state', 'compacted');
      ring.title =
        summaryLabel && limitLabel
          ? L(
              `当前上下文 ${summaryLabel} / ${limitLabel} (${summaryPct}%${preUsed ? ` · 原 ${preUsed} 已压缩` : ''}) · 点击查看套餐限额`,
              `Context ${summaryLabel} / ${limitLabel} (${summaryPct}%${preUsed ? ` · compacted from ${preUsed}` : ''}) · Click for plan usage`
            )
          : L('当前上下文已压缩 · 点击查看套餐限额', 'Context compacted · Click for plan usage');
      return;
    }

    ring.removeAttribute('data-compact-state');
    const pct = hasCtx ? latestCtxState.pct : 0;
    if (arc) {
      const offset = RING_CIRC * (1 - pct / 100);
      arc.style.strokeDashoffset = offset.toFixed(2);
      arc.style.strokeOpacity = pct <= 0 ? '0' : '1';
      let level = 'normal';
      if (pct >= 85) level = 'crit';
      else if (pct >= 70) level = 'warn';
      ring.setAttribute('data-level', level);
    }
    ring.title = hasCtx
      ? L(
          `当前上下文 ${latestCtxState.ratioText} (${pct}%) · 点击查看套餐限额`,
          `Context ${latestCtxState.ratioText} (${pct}%) · Click for plan usage`
        )
      : L('当前会话暂无上下文消耗 · 点击查看套餐限额', 'No context usage yet · Click for plan usage');
  }

  function ensureComposerContextRing() {
    const inputBox = document.getElementById('antigravity.agentSidePanelInputBox');
    if (!inputBox) return;

    /* On the Home `/` screen, the composer has a top project/location row that ALSO matches
       `div.flex.min-w-0.flex-1.items-center`; anchor off `model-selector-trigger` first so the
       ring always mounts beside the model picker in the bottom toolbar instead of top-right. */
    const modelBtn = inputBox.querySelector('button[data-testid="model-selector-trigger"]');
    let modelWrap = null;
    if (modelBtn) {
      const bar = modelBtn.closest('div.flex.min-w-0.flex-1.items-center') || modelBtn.parentElement;
      if (bar) {
        let cur = modelBtn;
        while (cur && cur.parentElement && cur.parentElement !== bar) cur = cur.parentElement;
        if (cur && cur.parentElement === bar) modelWrap = cur;
      }
    }
    if (!modelWrap) {
      const leftGroup = inputBox.querySelector('div.flex.min-w-0.flex-1.items-center');
      if (leftGroup) {
        modelWrap = Array.from(leftGroup.children).find(
          (ch) => ch.tagName === 'DIV' && ch.id !== 'ag-live-metrics-pill' && ch.querySelector('button')
        );
      }
    }
    if (!modelWrap) return;

    let ring = document.getElementById('ag-claude-ctx-ring');
    let newlyInserted = false;
    if (!ring) {
      newlyInserted = true;
      ring = document.createElement('button');
      ring.id = 'ag-claude-ctx-ring';
      ring.type = 'button';
      ring.setAttribute('data-no-drag', '');
      ring.setAttribute('data-ag-i18n-ignore', '1');
      ring.setAttribute('data-open', quotaPopoverOpen ? 'true' : 'false');
      ring.setAttribute('aria-label', L('上下文与套餐使用限额', 'Context window & plan usage'));
      ring.innerHTML =
        '<svg width="15" height="15" viewBox="0 0 20 20" aria-hidden="true">' +
        '<circle class="ag-ctx-ring-track" cx="10" cy="10" r="7" fill="none" stroke-width="2.15"/>' +
        `<circle class="ag-ctx-ring-arc" cx="10" cy="10" r="7" fill="none" stroke-width="2.15" stroke-linecap="round" stroke-dasharray="${RING_CIRC.toFixed(
          2
        )}" stroke-dashoffset="${RING_CIRC.toFixed(2)}"/>` +
        '</svg>';
      ring.addEventListener('pointerenter', () => {
        if (!quotaPopoverOpen && (!cachedQuotaGroups || Date.now() - lastQuotaFetchTs > 12000)) {
          fetchQuotaSummary(false);
        }
      });
      ring.addEventListener('click', (e) => {
        e.stopPropagation();
        if (quotaPopoverOpen) {
          closeQuotaPopover();
        } else {
          openQuotaPopover();
        }
      });
    }

    if (modelWrap.nextElementSibling !== ring) {
      modelWrap.insertAdjacentElement('afterend', ring);
      newlyInserted = true;
    }

    updateComposerRingVisuals();

    if (!quotaWarmupDone && discoverQuotaService(false)) {
      quotaWarmupDone = true;
      later(() => {
        if (!disposed && FEAT.contextRing && (!cachedQuotaGroups || Date.now() - lastQuotaFetchTs > 15000)) {
          fetchQuotaSummary(false);
        }
      }, 120);
    }

    if (newlyInserted && typeof window.__ag_ensure_metrics_pill_fn === 'function') {
      frame(() => {
        if (typeof window.__ag_ensure_metrics_pill_fn === 'function') {
          window.__ag_ensure_metrics_pill_fn(true);
        }
      });
    }
  }

  const onOutsidePopoverPointerDown = (e) => {
    if (!quotaPopoverOpen) return;
    const pop = document.getElementById('ag-claude-quota-popover');
    const ring = document.getElementById('ag-claude-ctx-ring');
    if ((pop && pop.contains(e.target)) || (ring && ring.contains(e.target))) return;
    closeQuotaPopover();
  };
  const onPopoverKeyDown = (e) => {
    if (quotaPopoverOpen && e.key === 'Escape') {
      closeQuotaPopover();
    }
  };
  const onWindowResizePopover = () => {
    if (quotaPopoverOpen) positionQuotaPopover();
    if (modelPopoverOpen) positionModelPopovers();
  };
  document.addEventListener('pointerdown', onOutsidePopoverPointerDown, true);
  document.addEventListener('keydown', onPopoverKeyDown, true);
  window.addEventListener('resize', onWindowResizePopover);

  /* ==========================================================================
   * 6. Claude-Style Stratified Model Selector Popover
   *    - Replaces crowded 9-row flat native list & noisy `新 / 快速` badges
   *    - Top: `模型 · 本次会话` + 4 core Gemini models (full names, `1-4` keys, blue `✓`)
   *    - Bottom: unified `思考强度 >` flyout (`Low/Medium/High/XHigh`) & `更多模型 >` flyout
   *    - Calls Antigravity's native React Fiber `setSelectedModel(option)` directly
   * ========================================================================== */
  const EFFORT_LABEL_RE = /^(.*?)\s*\((Low|Medium|High|XHigh|Extra|Max)\)\s*$/i;
  const EFFORT_NORM = { low: 'Low', medium: 'Medium', high: 'High', xhigh: 'XHigh', extra: 'XHigh', max: 'Max' };
  const EFFORT_DISPLAY = { XHigh: 'Extra' };
  const EFFORT_RANK = { Low: 0, Medium: 1, High: 2, XHigh: 3, Max: 4 };
  const EFFORT_DESC = {
    Low: ['最快响应，轻量日常问答', 'Fastest response for everyday tasks'],
    Medium: ['速度与推理均衡（默认）', 'Balanced speed and reasoning (default)'],
    High: ['深度推演与复杂问题排障', 'Deep analysis for complex problems'],
    XHigh: ['极限长链深度推理', 'Maximum extended reasoning'],
    Max: ['最高推理强度', 'Maximum reasoning effort']
  };
  function displayEffortDesc(effort) {
    const pair = effort && EFFORT_DESC[effort];
    return pair ? L(pair[0], pair[1]) : '';
  }
  function displayEffortLabel(effort) {
    return (effort && EFFORT_DISPLAY[effort]) || effort;
  }
  const SVG_CM_CHECK =
    '<svg class="ag-cm-check" width="15" height="15" viewBox="0 0 16 16" fill="none" aria-hidden="true"><path d="M3.2 8.4L6.5 11.7L13 4.5" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg>';
  const SVG_CM_CHEVRON =
    '<svg width="13" height="13" viewBox="0 0 16 16" fill="none" aria-hidden="true"><path d="M6 3.5L10.5 8L6 12.5" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg>';

  let modelPopoverOpen = false;
  let activeModelSubmenu = null; // null | 'effort' | 'more'
  let activeModelTriggerBtn = null;
  let lastPreferredEffort = 'Medium';
  let currentCatalogSnapshot = null;

  function escapeHtml(str) {
    return String(str || '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  function findModelTriggerBtn() {
    if (activeModelTriggerBtn && document.body.contains(activeModelTriggerBtn)) {
      return activeModelTriggerBtn;
    }
    return document.querySelector('button[data-testid="model-selector-trigger"]');
  }

  function syncModelTriggerDisplay() {
    if (disposed || !FEAT.modelMenu) return;
    const btns = document.querySelectorAll('button[data-testid="model-selector-trigger"]');
    for (const btn of btns) {
      if (btn.getAttribute('data-ag-i18n-ignore') !== '1') {
        btn.setAttribute('data-ag-i18n-ignore', '1');
      }
      const walker = document.createTreeWalker(btn, NodeFilter.SHOW_TEXT);
      let node;
      while ((node = walker.nextNode())) {
        const raw = node.nodeValue;
        if (!raw) continue;
        let next = raw.replace(/编排器\s*\(([^)]+)\)/g, 'Orchestrator ($1)');
        next = next.replace(/\b(?:Extra High|XHigh)\b/g, 'Extra');
        if (next !== raw) node.nodeValue = next;
      }
    }
  }

  function buildReduxModelSelectorApi() {
    try {
      const { store } = resolveProjectsStoreAndBindings();
      if (!store || typeof store.getState !== 'function') return null;
      const st = store.getState();
      const rawCfgs =
        (st && st.userStatus && st.userStatus.cascadeModelConfigData && st.userStatus.cascadeModelConfigData.clientModelConfigs) || [];
      if (!Array.isArray(rawCfgs) || rawCfgs.length === 0) return null;
      const modelOptions = [];
      for (const c of rawCfgs) {
        if (!c || !c.label) continue;
        const val = c.modelOrAlias && c.modelOrAlias.choice ? c.modelOrAlias.choice.value : c.value;
        modelOptions.push({
          label: c.label,
          value: val,
          modelId: c.modelId || '',
          disabled: Boolean(c.disabled)
        });
      }
      if (!modelOptions.length) return null;
      const rawCustom =
        st && st.customModels && Array.isArray(st.customModels.models)
          ? st.customModels.models
          : Array.isArray(st && st.customModels)
            ? st.customModels
            : [];
      const customModels = rawCustom
        .filter((c) => c && c.label)
        .map((c) => ({
          label: c.label,
          value: c.value,
          modelId: c.modelId || '',
          customLabel: c.label,
          disabled: Boolean(c.disabled)
        }));
      const def = (st && st.modelSelection && st.modelSelection.default) || null;
      const defVal = def && def.model;
      const selectedModel =
        (def && def.customLabel ? customModels.find((m) => m.value === defVal && m.label === def.customLabel) : null) ||
        modelOptions.find((m) => m.value === defVal) ||
        customModels.find((m) => m.value === defVal) ||
        modelOptions.find((m) => !m.disabled) ||
        modelOptions[0];
      return {
        modelOptions,
        customModels,
        selectedModel,
        open: false,
        setIsOpen: () => {},
        setSelectedModel: (opt) => {
          if (!opt || opt.value === undefined || typeof store.dispatch !== 'function') return;
          store.dispatch({
            type: 'modelSelection/modelPicked',
            payload: {
              model: opt.value,
              ...(opt.customLabel ? { customLabel: opt.customLabel } : {})
            }
          });
        }
      };
    } catch {
      return null;
    }
  }

  function discoverModelSelectorApi(btnEl) {
    const isProjectTrigger = Boolean(
      (btnEl && btnEl.hasAttribute && btnEl.hasAttribute('data-ag-pd-model-trigger')) ||
      (!btnEl && activeModelTriggerBtn && activeModelTriggerBtn.hasAttribute && activeModelTriggerBtn.hasAttribute('data-ag-pd-model-trigger'))
    );
    const nativeBtn = document.querySelector('button[data-testid="model-selector-trigger"]');
    const readNativeApi = (btn) => {
      if (!btn) return null;
      const fk = Object.keys(btn).find((k) => k.startsWith('__reactFiber$'));
      let f = fk ? btn[fk] : null;
      for (let i = 0; i < 26 && f; i++, f = f.return) {
        const p = f.memoizedProps;
        if (p && typeof p.setSelectedModel === 'function' && Array.isArray(p.modelOptions) && p.modelOptions.length > 0) {
          return p;
        }
      }
      return null;
    };

    if (isProjectTrigger) {
      const reduxApi = buildReduxModelSelectorApi();
      const nativeApi = readNativeApi(nativeBtn);
      if (reduxApi) {
        if (nativeApi) {
          return {
            ...reduxApi,
            setSelectedModel: (opt) => {
              reduxApi.setSelectedModel(opt);
              const match = nativeApi.modelOptions.find(
                (o) => o && ((opt.value !== undefined && o.value === opt.value) || o.label === opt.label)
              );
              try {
                nativeApi.setSelectedModel(match || opt);
              } catch {}
            }
          };
        }
        return reduxApi;
      }
      if (nativeApi) return nativeApi;
      return null;
    }

    const candidates = [];
    if (btnEl) candidates.push(btnEl);
    if (nativeBtn && !candidates.includes(nativeBtn)) candidates.push(nativeBtn);
    const activeBtn = findModelTriggerBtn();
    if (activeBtn && !activeBtn.hasAttribute('data-ag-pd-model-trigger') && !candidates.includes(activeBtn)) {
      candidates.push(activeBtn);
    }
    for (const btn of candidates) {
      const api = readNativeApi(btn);
      if (api) return api;
    }
    return buildReduxModelSelectorApi();
  }

  function formatProjectComposerModelParts(api) {
    const resolvedApi = api || buildReduxModelSelectorApi() || discoverModelSelectorApi();
    if (resolvedApi) {
      const cat = buildModelCatalog(resolvedApi);
      if (cat.activeFamily) {
        const name = cat.activeFamily.baseName;
        const eff = cat.activeVariant && cat.activeVariant.effort ? displayEffortLabel(cat.activeVariant.effort) : '';
        return { name, effort: eff };
      }
    }
    const nativeBtn = document.querySelector('button[data-testid="model-selector-trigger"]');
    const raw = nativeBtn ? (nativeBtn.textContent || '').trim().replace(/\s+/g, ' ') : '';
    if (!raw) return { name: L('默认模型', 'Default model'), effort: '' };
    const m = raw.match(/^(.*?)\s+(Low|Medium|High|Extra High|XHigh|Extra|Minimal)$/i);
    if (m) return { name: m[1].trim(), effort: displayEffortLabel(EFFORT_NORM[m[2].toLowerCase()] || m[2]) };
    return { name: raw, effort: '' };
  }

  function syncProjectDetailModelTrigger() {
    const pdBtn = document.getElementById('ag-pd-model-btn');
    if (!pdBtn) return;
    const api = discoverModelSelectorApi(pdBtn);
    const parts = formatProjectComposerModelParts(api);
    const nameEl = pdBtn.querySelector('.ag-pd-model-name');
    const effEl = pdBtn.querySelector('.ag-pd-model-effort');
    if (nameEl) nameEl.textContent = parts.name;
    if (effEl) {
      effEl.textContent = parts.effort;
      effEl.style.display = parts.effort ? '' : 'none';
    }
  }

  function applyModelSelectionOption(api, targetOpt) {
    if (!targetOpt) return;
    if (api && typeof api.setSelectedModel === 'function') {
      try {
        api.setSelectedModel(targetOpt);
      } catch {}
    }
    if (targetOpt.value !== undefined) {
      try {
        const { store } = resolveProjectsStoreAndBindings();
        if (store && typeof store.dispatch === 'function') {
          store.dispatch({
            type: 'modelSelection/modelPicked',
            payload: {
              model: targetOpt.value,
              ...(targetOpt.customLabel ? { customLabel: targetOpt.customLabel } : {})
            }
          });
        }
      } catch {}
    }
    later(() => {
      syncModelTriggerDisplay();
      syncProjectDetailModelTrigger();
    }, 30);
  }

  function buildModelCatalog(api) {
    const rawOpts = (api.modelOptions || []).filter((o) => o && !o.disabled && o.label);
    const customOpts = Array.isArray(api.customModels)
      ? api.customModels.filter((o) => o && !o.disabled && o.label)
      : [];
    const allOpts = rawOpts.concat(customOpts);

    const familyMap = new Map();
    for (const opt of allOpts) {
      const normalizedLabel = String(opt.label).replace(/编排器\s*\(([^)]+)\)/g, 'Orchestrator ($1)');
      const m = normalizedLabel.match(EFFORT_LABEL_RE);
      const baseName = m ? m[1].trim() : normalizedLabel.trim();
      const effort = m ? EFFORT_NORM[m[2].toLowerCase()] || m[2] : null;
      let fam = familyMap.get(baseName);
      if (!fam) {
        fam = { baseName, variants: [] };
        familyMap.set(baseName, fam);
      }
      fam.variants.push({ effort, opt });
    }

    for (const fam of familyMap.values()) {
      fam.variants.sort((a, b) => {
        const ra = a.effort && EFFORT_RANK[a.effort] !== undefined ? EFFORT_RANK[a.effort] : 99;
        const rb = b.effort && EFFORT_RANK[b.effort] !== undefined ? EFFORT_RANK[b.effort] : 99;
        return ra - rb;
      });
    }

    const families = Array.from(familyMap.values());
    const isOrch = (f) => /orchestrator/i.test(f.baseName);
    const isCoreGemini = (f) => /^gemini\b/i.test(f.baseName) && !isOrch(f);

    const coreRank = (name) => {
      if (/carbon/i.test(name)) return 0;
      if (/neon/i.test(name)) return 1;
      if (/argon/i.test(name)) return 2;
      if (/hydrogen/i.test(name)) return 3;
      if (/flash/i.test(name)) return 4;
      return 10;
    };

    const primaryFamilies = families
      .filter(isCoreGemini)
      .sort((a, b) => coreRank(a.baseName) - coreRank(b.baseName))
      .slice(0, 5);

    const primarySet = new Set(primaryFamilies);
    const moreFamilies = families
      .filter((f) => !primarySet.has(f))
      .map((f) => ({
        group: isOrch(f) ? 'orch' : 'other',
        fam: f
      }))
      .sort((a, b) => (a.group === b.group ? 0 : a.group === 'orch' ? -1 : 1));

    const sel = api.selectedModel || null;
    let activeFamily = null;
    let activeVariant = null;

    if (sel) {
      for (const fam of families) {
        for (const v of fam.variants) {
          if (
            (sel.value !== undefined && v.opt.value === sel.value) ||
            (sel.modelId && v.opt.modelId === sel.modelId) ||
            v.opt.label === sel.label
          ) {
            activeFamily = fam;
            activeVariant = v;
            break;
          }
        }
        if (activeFamily) break;
      }
    }

    if (!activeFamily && primaryFamilies.length > 0) {
      activeFamily = primaryFamilies[0];
      activeVariant = activeFamily.variants[0] || null;
    }

    if (activeVariant && activeVariant.effort) {
      lastPreferredEffort = activeVariant.effort;
    }

    return {
      primaryFamilies,
      moreFamilies,
      activeFamily,
      activeVariant
    };
  }

  function pickVariantForFamily(fam, desiredEffort) {
    if (!fam || !fam.variants.length) return null;
    if (desiredEffort) {
      const exact = fam.variants.find((v) => v.effort === desiredEffort);
      if (exact) return exact.opt;
      if (desiredEffort === 'XHigh' || desiredEffort === 'Max') {
        const high = fam.variants.find((v) => v.effort === 'High');
        if (high) return high.opt;
      }
    }
    const med = fam.variants.find((v) => v.effort === 'Medium');
    return (med || fam.variants[0]).opt;
  }

  function ensureModelPopovers() {
    let mainPop = document.getElementById('ag-claude-model-popover');
    if (!mainPop) {
      mainPop = document.createElement('div');
      mainPop.id = 'ag-claude-model-popover';
      mainPop.setAttribute('data-ag-i18n-ignore', '1');
      mainPop.setAttribute('data-open', 'false');
      mainPop.addEventListener('mouseover', (e) => {
        const row = e.target.closest('[data-ag-cm-hover]');
        if (!row) return;
        const kind = row.getAttribute('data-ag-cm-hover');
        const nextSub = kind === 'none' ? null : kind;
        if (activeModelSubmenu !== nextSub) {
          activeModelSubmenu = nextSub;
          renderModelPopovers();
        }
      });
      mainPop.addEventListener('click', (e) => {
        e.stopPropagation();
        const famBtn = e.target.closest('[data-ag-cm-family]');
        if (famBtn) {
          const baseName = famBtn.getAttribute('data-ag-cm-family');
          const api = discoverModelSelectorApi();
          if (api) {
            const cat = buildModelCatalog(api);
            const fam = cat.primaryFamilies.find((f) => f.baseName === baseName);
            const targetOpt = pickVariantForFamily(fam, lastPreferredEffort);
            if (targetOpt) applyModelSelectionOption(api, targetOpt);
          }
          closeClaudeModelPopover();
          return;
        }
        const subTrigger = e.target.closest('[data-ag-cm-subtrigger]');
        if (subTrigger) {
          if (subTrigger.getAttribute('data-disabled') === 'true') return;
          const kind = subTrigger.getAttribute('data-ag-cm-subtrigger');
          activeModelSubmenu = activeModelSubmenu === kind ? null : kind;
          renderModelPopovers();
        }
      });
      document.body.appendChild(mainPop);
    }

    let subPop = document.getElementById('ag-claude-model-subpop');
    if (!subPop) {
      subPop = document.createElement('div');
      subPop.id = 'ag-claude-model-subpop';
      subPop.setAttribute('data-ag-i18n-ignore', '1');
      subPop.setAttribute('data-open', 'false');
      subPop.addEventListener('click', (e) => {
        e.stopPropagation();
        const effBtn = e.target.closest('[data-ag-cm-effort]');
        if (effBtn) {
          const eff = effBtn.getAttribute('data-ag-cm-effort');
          const api = discoverModelSelectorApi();
          if (api) {
            const cat = buildModelCatalog(api);
            if (cat.activeFamily) {
              const v = cat.activeFamily.variants.find((x) => x.effort === eff);
              if (v && v.opt) {
                lastPreferredEffort = eff;
                applyModelSelectionOption(api, v.opt);
              }
            }
          }
          closeClaudeModelPopover();
          return;
        }
        const moreBtn = e.target.closest('[data-ag-cm-more-family]');
        if (moreBtn) {
          const baseName = moreBtn.getAttribute('data-ag-cm-more-family');
          const api = discoverModelSelectorApi();
          if (api) {
            const cat = buildModelCatalog(api);
            const entry = cat.moreFamilies.find((x) => x.fam.baseName === baseName);
            const targetOpt = entry ? pickVariantForFamily(entry.fam, lastPreferredEffort) : null;
            if (targetOpt) applyModelSelectionOption(api, targetOpt);
          }
          closeClaudeModelPopover();
        }
      });
      document.body.appendChild(subPop);
    }

    return { mainPop, subPop };
  }

  function positionModelPopovers() {
    const btn = findModelTriggerBtn();
    const mainPop = document.getElementById('ag-claude-model-popover');
    const subPop = document.getElementById('ag-claude-model-subpop');
    if (!btn || !mainPop) return;

    const r = btn.getBoundingClientRect();
    const mainW = 254;
    const openBelow = btn.hasAttribute('data-ag-pd-model-trigger') || r.top < 320;
    const rawLeft = openBelow ? Math.round(r.right - mainW) : Math.round(r.left);
    const left = Math.max(12, Math.min(rawLeft, window.innerWidth - mainW - 14));
    mainPop.style.left = `${left}px`;
    if (openBelow) {
      const top = Math.max(12, Math.min(Math.round(r.bottom + 8), window.innerHeight - 280));
      mainPop.style.top = `${top}px`;
      mainPop.style.bottom = 'auto';
      mainPop.style.transformOrigin = 'top right';
    } else {
      const bottom = Math.max(12, Math.round(window.innerHeight - r.top + 8));
      mainPop.style.top = 'auto';
      mainPop.style.bottom = `${bottom}px`;
      mainPop.style.transformOrigin = 'bottom left';
    }

    if (subPop && subPop.getAttribute('data-open') === 'true') {
      const mr = mainPop.getBoundingClientRect();
      const subW = 236;
      let subLeft = Math.round(mr.right + 6);
      if (subLeft + subW > window.innerWidth - 10) {
        subLeft = Math.max(10, Math.round(mr.left - subW - 6));
      }
      subPop.style.left = `${subLeft}px`;
      if (openBelow) {
        subPop.style.top = mainPop.style.top;
        subPop.style.bottom = 'auto';
      } else {
        subPop.style.top = 'auto';
        subPop.style.bottom = mainPop.style.bottom;
      }
    }
  }

  function renderModelPopoversRaw() {
    const api = discoverModelSelectorApi();
    if (!api) return;
    const { mainPop, subPop } = ensureModelPopovers();
    const cat = buildModelCatalog(api);
    currentCatalogSnapshot = cat;

    const multiEfforts = cat.activeFamily
      ? cat.activeFamily.variants.filter((v) => Boolean(v.effort))
      : [];
    const hasAdjustableEffort = multiEfforts.length > 1;
    const curEffortText =
      cat.activeVariant && cat.activeVariant.effort
        ? displayEffortLabel(cat.activeVariant.effort)
        : hasAdjustableEffort
          ? displayEffortLabel(lastPreferredEffort)
          : L('固定', 'Fixed');

    const activeInMore = cat.moreFamilies.some((x) => cat.activeFamily && x.fam.baseName === cat.activeFamily.baseName);

    const primaryRowsHtml = cat.primaryFamilies
      .map((fam, idx) => {
        const isSelected = Boolean(cat.activeFamily && cat.activeFamily.baseName === fam.baseName);
        const rightHtml = isSelected ? SVG_CM_CHECK : `<span class="ag-cm-key">${idx + 1}</span>`;
        return `<button type="button" class="ag-cm-row" data-ag-cm-hover="none" data-ag-cm-family="${escapeHtml(
          fam.baseName
        )}">
          <span>${escapeHtml(fam.baseName)}</span>
          ${rightHtml}
        </button>`;
      })
      .join('');

    const effSubActive = activeModelSubmenu === 'effort' && hasAdjustableEffort ? ' data-active-sub="true"' : '';
    const effDisabled = hasAdjustableEffort ? '' : ' data-disabled="true"';
    const moreSubActive = activeModelSubmenu === 'more' ? ' data-active-sub="true"' : '';

    mainPop.innerHTML = `
      <div class="ag-cm-sec-hdr">${L('模型 · 本次会话', 'Models · This chat')}</div>
      <div>${primaryRowsHtml}</div>
      <div class="ag-cm-divider"></div>
      <button type="button" class="ag-cm-row" data-ag-cm-hover="${
        hasAdjustableEffort ? 'effort' : 'none'
      }" data-ag-cm-subtrigger="effort"${effSubActive}${effDisabled}>
        <span>${L('思考强度', 'Thinking effort')}</span>
        <span class="ag-cm-right"><span>${escapeHtml(curEffortText)}</span>${
          hasAdjustableEffort ? SVG_CM_CHEVRON : ''
        }</span>
      </button>
      <button type="button" class="ag-cm-row" data-ag-cm-hover="more" data-ag-cm-subtrigger="more"${moreSubActive}>
        <span style="display:inline-flex;align-items:center;gap:6px;">
          <span>${L('更多模型', 'More models')}</span>
          ${activeInMore ? '<span class="ag-cm-dot"></span>' : ''}
        </span>
        <span class="ag-cm-right">
          ${SVG_CM_CHEVRON}
        </span>
      </button>
    `;

    if (activeModelSubmenu === 'effort' && hasAdjustableEffort) {
      const famTitle = cat.activeFamily ? cat.activeFamily.baseName : '';
      subPop.innerHTML =
        `<div class="ag-cm-sec-hdr">${L('思考强度', 'Thinking effort')} · ${escapeHtml(famTitle)}</div>` +
        multiEfforts
          .map((v) => {
            const on = Boolean(cat.activeVariant && v.effort === cat.activeVariant.effort);
            const desc = displayEffortDesc(v.effort);
            const label = displayEffortLabel(v.effort);
            return `<button type="button" class="ag-cm-row" data-ag-cm-effort="${escapeHtml(v.effort)}">
              <span>
                <span style="display:block;line-height:1.25;">${escapeHtml(label)}</span>
                ${desc ? `<span class="ag-cm-sub-desc" style="display:block;">${escapeHtml(desc)}</span>` : ''}
              </span>
              ${on ? SVG_CM_CHECK : ''}
            </button>`;
          })
          .join('');
      subPop.setAttribute('data-open', 'true');
    } else if (activeModelSubmenu === 'more' && cat.moreFamilies.length > 0) {
      let lastGrp = '';
      subPop.innerHTML = cat.moreFamilies
        .map(({ group, fam }) => {
          let hdr = '';
          if (group !== lastGrp) {
            const groupLabel = group === 'orch' ? L('多智能体编排', 'Orchestrators') : L('其他模型', 'Other models');
            hdr = `${lastGrp ? '<div class="ag-cm-divider"></div>' : ''}<div class="ag-cm-sec-hdr">${escapeHtml(
              groupLabel
            )}</div>`;
            lastGrp = group;
          }
          const on = Boolean(cat.activeFamily && cat.activeFamily.baseName === fam.baseName);
          return `${hdr}<button type="button" class="ag-cm-row" style="min-height:34px;font-size:13.5px;" data-ag-cm-more-family="${escapeHtml(
            fam.baseName
          )}">
            <span>${escapeHtml(fam.baseName)}</span>
            ${on ? SVG_CM_CHECK : ''}
          </button>`;
        })
        .join('');
      subPop.setAttribute('data-open', 'true');
    } else {
      subPop.setAttribute('data-open', 'false');
    }

    positionModelPopovers();
  }

  /* ---- menu accessibility: roles, inert when closed, focus preserved across re-renders ---- */
  const MENU_KEY_ATTRS = ['data-ag-cm-family', 'data-ag-cm-subtrigger', 'data-ag-cm-effort', 'data-ag-cm-more-family'];
  let focusBeforeModelMenu = null;
  let lastKeyToggleTs = 0;

  function menuFocusKey(el) {
    if (!el || !el.getAttribute) return null;
    for (const a of MENU_KEY_ATTRS) if (el.hasAttribute(a)) return [a, el.getAttribute(a)];
    return null;
  }

  function findMenuRowByKey(key) {
    if (!key) return null;
    for (const id of ['ag-claude-model-popover', 'ag-claude-model-subpop']) {
      const pop = document.getElementById(id);
      if (!pop) continue;
      for (const row of pop.querySelectorAll(`[${key[0]}]`)) if (row.getAttribute(key[0]) === key[1]) return row;
    }
    return null;
  }

  function isInModelMenu(el) {
    return Boolean(el && el.closest && el.closest('#ag-claude-model-popover, #ag-claude-model-subpop'));
  }

  function syncMenuA11y() {
    for (const id of ['ag-claude-model-popover', 'ag-claude-model-subpop']) {
      const pop = document.getElementById(id);
      if (!pop) continue;
      const open = pop.getAttribute('data-open') === 'true';
      pop.setAttribute('role', 'menu');
      pop.setAttribute('aria-hidden', open ? 'false' : 'true');
      if (open) pop.removeAttribute('inert');
      else pop.setAttribute('inert', '');
      pop.querySelectorAll('.ag-cm-row').forEach((row) => {
        row.setAttribute('role', 'menuitem');
        row.setAttribute('tabindex', '-1');
        if (row.getAttribute('data-disabled') === 'true') row.setAttribute('aria-disabled', 'true');
      });
      pop.querySelectorAll('[data-ag-cm-subtrigger]').forEach((row) => {
        row.setAttribute('aria-haspopup', 'menu');
        row.setAttribute('aria-expanded', row.hasAttribute('data-active-sub') ? 'true' : 'false');
      });
    }
  }

  function renderModelPopovers() {
    const active = document.activeElement;
    const key = isInModelMenu(active) ? menuFocusKey(active) : null;
    renderModelPopoversRaw();
    syncMenuA11y();
    if (key) {
      const row = findMenuRowByKey(key);
      if (row) row.focus();
    }
  }

  function menuRows(pop) {
    return pop ? Array.from(pop.querySelectorAll('.ag-cm-row')).filter((r) => r.getAttribute('data-disabled') !== 'true') : [];
  }

  function focusFirstRow(pop, preferSelected) {
    const rows = menuRows(pop);
    if (!rows.length) return;
    const sel = preferSelected ? rows.find((r) => r.querySelector('.ag-cm-check')) : null;
    (sel || rows[0]).focus();
  }

  function openClaudeModelPopover(btnEl, opts = {}) {
    const btn = btnEl || findModelTriggerBtn();
    const api = discoverModelSelectorApi(btn);
    if (!api) return false;
    if (quotaPopoverOpen) closeQuotaPopover();
    if (api.open && typeof api.setIsOpen === 'function') {
      try {
        api.setIsOpen(false);
      } catch {}
    }
    focusBeforeModelMenu = document.activeElement && document.activeElement !== document.body ? document.activeElement : btn;
    activeModelTriggerBtn = btn;
    modelPopoverOpen = true;
    activeModelSubmenu = null;
    if (btn) {
      btn.setAttribute('data-ag-model-open', 'true');
      btn.setAttribute('aria-expanded', 'true');
    }
    const { mainPop } = ensureModelPopovers();
    renderModelPopoversRaw();
    mainPop.setAttribute('data-open', 'true');
    syncMenuA11y();
    positionModelPopovers();
    if (opts.focus) focusFirstRow(mainPop, true);
    return true;
  }

  function closeClaudeModelPopover(opts = {}) {
    const hadFocus = isInModelMenu(document.activeElement);
    modelPopoverOpen = false;
    activeModelSubmenu = null;
    currentCatalogSnapshot = null;
    if (activeModelTriggerBtn) {
      activeModelTriggerBtn.removeAttribute('data-ag-model-open');
      activeModelTriggerBtn.setAttribute('aria-expanded', 'false');
    }
    document.querySelectorAll('button[data-ag-model-open]').forEach((el) => el.removeAttribute('data-ag-model-open'));
    const mainPop = document.getElementById('ag-claude-model-popover');
    const subPop = document.getElementById('ag-claude-model-subpop');
    if (mainPop) mainPop.setAttribute('data-open', 'false');
    if (subPop) subPop.setAttribute('data-open', 'false');
    syncMenuA11y();
    if (opts.returnFocus || hadFocus) {
      const target =
        focusBeforeModelMenu && document.body.contains(focusBeforeModelMenu) ? focusBeforeModelMenu : activeModelTriggerBtn;
      if (target && typeof target.focus === 'function') target.focus();
    }
    focusBeforeModelMenu = null;
  }

  function toggleClaudeModelPopover(btnEl, opts) {
    if (modelPopoverOpen) {
      closeClaudeModelPopover({ returnFocus: Boolean(opts && opts.focus) });
      return true;
    }
    return openClaudeModelPopover(btnEl, opts);
  }

  const TRIGGER_SEL = 'button[data-testid="model-selector-trigger"], button[data-ag-pd-model-trigger="true"]';

  const onModelTriggerPointerDown = (e) => {
    if (!FEAT.modelMenu) return;
    const trigger = e.target && e.target.closest && e.target.closest(TRIGGER_SEL);
    if (trigger) {
      if (e.button !== undefined && e.button !== 0) return;
      const api = discoverModelSelectorApi(trigger);
      if (!api) return;
      e.preventDefault();
      e.stopPropagation();
      e.stopImmediatePropagation();
      toggleClaudeModelPopover(trigger);
      return;
    }
    if (!modelPopoverOpen) return;
    if (isInModelMenu(e.target)) return;
    closeClaudeModelPopover();
  };

  /* Mouse: the menu already toggled on pointerdown, so swallow the follow-up mousedown/click.
     Keyboard / assistive tech: activation arrives as a click with detail === 0 -> toggle here. */
  const onModelTriggerSwallowMouseClick = (e) => {
    if (!FEAT.modelMenu) return;
    const trigger = e.target && e.target.closest && e.target.closest(TRIGGER_SEL);
    if (!trigger) return;
    const api = discoverModelSelectorApi(trigger);
    if (!api) return;
    e.preventDefault();
    e.stopPropagation();
    e.stopImmediatePropagation();
    if (e.type === 'click' && e.detail === 0 && Date.now() - lastKeyToggleTs > 1000) {
      lastKeyToggleTs = Date.now();
      toggleClaudeModelPopover(trigger, { focus: true });
    }
  };

  const onModelPopoverKeyDown = (e) => {
    if (disposed || !FEAT.modelMenu) return;
    const plain = !e.metaKey && !e.ctrlKey && !e.altKey;
    if ((e.metaKey || e.ctrlKey) && !e.shiftKey && !e.altKey && e.key === '/') {
      const btn = findModelTriggerBtn();
      if (btn && discoverModelSelectorApi(btn)) {
        e.preventDefault();
        e.stopPropagation();
        e.stopImmediatePropagation();
        toggleClaudeModelPopover(btn, { focus: true });
        return;
      }
    }

    const trig = e.target && e.target.closest && e.target.closest(TRIGGER_SEL);
    if (trig && plain && (e.key === 'Enter' || e.key === ' ' || e.key === 'ArrowDown' || e.key === 'ArrowUp')) {
      if (discoverModelSelectorApi(trig)) {
        e.preventDefault();
        e.stopPropagation();
        e.stopImmediatePropagation();
        lastKeyToggleTs = Date.now();
        if (modelPopoverOpen && e.key.startsWith('Arrow')) {
          focusFirstRow(document.getElementById('ag-claude-model-popover'), true);
        } else {
          toggleClaudeModelPopover(trig, { focus: true });
        }
        return;
      }
    }

    if (!modelPopoverOpen) return;
    const mainPop = document.getElementById('ag-claude-model-popover');
    const subPop = document.getElementById('ag-claude-model-subpop');
    const active = document.activeElement;
    const inSub = Boolean(subPop && subPop.contains(active));
    const inMain = Boolean(mainPop && mainPop.contains(active));
    const stop = () => {
      e.preventDefault();
      e.stopPropagation();
      e.stopImmediatePropagation();
    };

    if (e.key === 'Escape') {
      stop();
      if (inSub && activeModelSubmenu) {
        const kind = activeModelSubmenu;
        activeModelSubmenu = null;
        renderModelPopovers();
        const t = mainPop && mainPop.querySelector(`[data-ag-cm-subtrigger="${kind}"]`);
        if (t) t.focus();
      } else {
        closeClaudeModelPopover({ returnFocus: true });
      }
      return;
    }
    if (e.key === 'Tab' && (inMain || inSub)) {
      stop();
      closeClaudeModelPopover({ returnFocus: true });
      return;
    }
    if (plain && (e.key === 'ArrowDown' || e.key === 'ArrowUp')) {
      stop();
      const rows = menuRows(inSub ? subPop : mainPop);
      if (!rows.length) return;
      const down = e.key === 'ArrowDown';
      let idx = rows.indexOf(active);
      idx = idx < 0 ? (down ? 0 : rows.length - 1) : (idx + (down ? 1 : -1) + rows.length) % rows.length;
      rows[idx].focus();
      return;
    }
    if (plain && e.key === 'ArrowRight' && inMain && active.hasAttribute('data-ag-cm-subtrigger')) {
      stop();
      if (active.getAttribute('data-disabled') === 'true') return;
      activeModelSubmenu = active.getAttribute('data-ag-cm-subtrigger');
      renderModelPopovers();
      focusFirstRow(subPop, true);
      return;
    }
    if (plain && e.key === 'ArrowLeft' && inSub) {
      stop();
      const kind = activeModelSubmenu;
      activeModelSubmenu = null;
      renderModelPopovers();
      const t = mainPop && mainPop.querySelector(`[data-ag-cm-subtrigger="${kind}"]`);
      if (t) t.focus();
      return;
    }
    if (plain && /^[1-5]$/.test(e.key)) {
      const idx = Number(e.key) - 1;
      const api = discoverModelSelectorApi();
      if (api) {
        const cat = currentCatalogSnapshot || buildModelCatalog(api);
        const fam = cat.primaryFamilies[idx];
        if (fam) {
          stop();
          const targetOpt = pickVariantForFamily(fam, lastPreferredEffort);
          if (targetOpt) applyModelSelectionOption(api, targetOpt);
          closeClaudeModelPopover({ returnFocus: true });
        }
      }
    }
  };

  document.addEventListener('pointerdown', onModelTriggerPointerDown, true);
  document.addEventListener('mousedown', onModelTriggerSwallowMouseClick, true);
  document.addEventListener('click', onModelTriggerSwallowMouseClick, true);
  document.addEventListener('keydown', onModelPopoverKeyDown, true);

  /* ==========================================================================
   * 7. Inline Undo & Edit (Claude-Style Message In-Bubble Re-Edit)
   *    - Intercepts `button[data-testid="revert-button"]` to expand a clean
   *      in-bubble editor without wiping downstream turns until confirmed.
   *    - 100% delegates file revert previews & Lexical state to native host.
   * ========================================================================== */
  let activeInlineEdit = null;
  let inlineUndoBusy = false;

  function activeReactFiber(el) {
    if (!el) return null;
    const fk = Object.keys(el).find((k) => k.startsWith('__reactFiber$'));
    let fiber = fk ? el[fk] : null;
    let top = fiber;
    while (top && top.return) top = top.return;
    if (top && top.stateNode && top.stateNode.current && top.stateNode.current !== top) {
      fiber = (fiber && fiber.alternate) || fiber;
    }
    return fiber;
  }

  function resolveNativeRevertTarget(button) {
    let state = null;
    let context = null;
    let session;
    let index;
    let text;
    for (let f = activeReactFiber(button), depth = 0; f && depth < 65; f = f.return, depth++) {
      const props = f.memoizedProps;
      if (!state && props && props.revertState) state = props.revertState;
      if (session === undefined && props && typeof props.cascadeId === 'string') session = props.cascadeId;
      if (index === undefined && props && Number.isInteger(props.userStepIndex)) index = props.userStepIndex;
      if (text === undefined && props && Array.isArray(props.items)) {
        text = props.items
          .filter((it) => it && it.chunk && it.chunk.case === 'text')
          .map((it) => it.chunk.value || '')
          .join('');
      }
      for (let d = f.dependencies && f.dependencies.firstContext; d; d = d.next) {
        const val = d.memoizedValue;
        if (!context && val && val.stepHandler && val.stepHandler.getRevertPreviews && val.inputBoxRef) {
          context = val;
        }
      }
      if (state && context && session && index !== undefined && text !== undefined) break;
    }
    if (!state || !state.canRevert || !state.revertPreviewState || !state.revertPreviewState.revert || !context || !session || index === undefined) {
      return null;
    }
    if (text === undefined) {
      const stepEl = button.closest && button.closest('[data-testid="user-input-step"]');
      const q =
        stepEl &&
        stepEl.querySelector('[data-testid="user-message-content"] [data-quotable="true"], [data-testid="user-message-content"]');
      text = (q && q.textContent) || '';
    }
    return { state: state.revertPreviewState, context, session, index, text };
  }

  function getComposerLexicalRoot(context) {
    const ref = context && context.inputBoxRef && context.inputBoxRef.current;
    return ref && ref.lexicalRef && ref.lexicalRef.current && ref.lexicalRef.current.getRootElement
      ? ref.lexicalRef.current.getRootElement()
      : null;
  }

  function composerHasExistingDraft(context) {
    const rootEl = getComposerLexicalRoot(context);
    if (rootEl && (rootEl.textContent || '').trim()) return true;
    const ref = context && context.inputBoxRef && context.inputBoxRef.current;
    const media = ref && typeof ref.getMediaAttachments === 'function' ? ref.getMediaAttachments() : null;
    return Boolean(media && media.length);
  }

  function setComposerText(context, text) {
    const value = String(text ?? '');
    const ref = context && context.inputBoxRef && context.inputBoxRef.current;
    const ed = ref && ref.lexicalRef && ref.lexicalRef.current;
    if (ed && ed._nodes && typeof ed.update === 'function') {
      const ParaNode = ed._nodes.get('paragraph') && ed._nodes.get('paragraph').klass;
      const TextNode = ed._nodes.get('text') && ed._nodes.get('text').klass;
      const LineBreakNode = ed._nodes.get('linebreak') && ed._nodes.get('linebreak').klass;
      if (ParaNode && TextNode) {
        ed.update(
          () => {
            const rootNode = ed.getEditorState()._nodeMap.get('root')?.getWritable?.();
            if (!rootNode) return;
            rootNode.clear();
            const p = new ParaNode();
            value.split(/\r?\n/).forEach((line, i) => {
              if (i > 0 && LineBreakNode) p.append(new LineBreakNode());
              if (line) p.append(new TextNode(line));
            });
            rootNode.append(p);
            if (typeof p.selectEnd === 'function') p.selectEnd();
          },
          { discrete: true }
        );
        return;
      }
    }
    const el = getComposerLexicalRoot(context);
    if (el) el.textContent = value;
  }

  async function performNativeRevert(target) {
    const handler = target.context.stepHandler;
    const orig = handler.revertToIndex;
    let pending;
    handler.revertToIndex = function (...args) {
      const res = orig.apply(this, args);
      if (args[0] === target.session && args[1] === target.index - 1) {
        pending = Promise.resolve(res);
      }
      return res;
    };
    try {
      target.state.revert();
    } finally {
      handler.revertToIndex = orig;
    }
    if (!pending) throw new Error('revert_not_dispatched');
    await pending;
    await new Promise((r) => setTimeout(r, 0));
  }

  async function submitComposerAfterRevert(context, composerEl) {
    await new Promise((r) => setTimeout(r, 360));
    if (disposed) return;
    const ref = context && context.inputBoxRef && context.inputBoxRef.current;
    if (ref && typeof ref.submit === 'function') {
      ref.submit();
      return;
    }
    const scope =
      (getComposerLexicalRoot(context) && getComposerLexicalRoot(context).closest('[data-testid="agent-input-box"]')) ||
      composerEl ||
      document;
    const sendBtn = scope.querySelector(
      'button[data-testid="input-send-button"]:not(:disabled), button[aria-label="Send message"]:not(:disabled), button[aria-label*="发送"]:not(:disabled)'
    );
    if (sendBtn) sendBtn.click();
  }

  function closeInlineEdit(restoreFocus) {
    if (!activeInlineEdit) return;
    const { button, bubble, contentEl, hosts, editorBox } = activeInlineEdit;
    activeInlineEdit = null;
    inlineUndoBusy = false;
    if (editorBox && editorBox.parentNode) editorBox.remove();
    if (bubble) bubble.classList.remove('ag-claude-editing-bubble');
    if (hosts) hosts.forEach((h) => h.classList.remove('ag-claude-editing-host'));
    if (contentEl) {
      contentEl.hidden = false;
      contentEl.classList.remove('ag-claude-inline-hidden');
    }
    if (restoreFocus && button && button.isConnected && typeof button.focus === 'function') {
      button.focus({ preventScroll: true });
    }
  }

  function renderInlineEditMeta(stObj) {
    if (!stObj || activeInlineEdit !== stObj) return;
    const { editorBox, button } = stObj;
    const metaEl = editorBox.querySelector('[data-ag-inline-meta]');
    const filesEl = editorBox.querySelector('[data-ag-inline-files]');
    if (!metaEl) return;
    const cur = resolveNativeRevertTarget(button) || stObj.target;
    const rState = cur.state;
    const convOnly = stObj.conversationOnly !== undefined ? stObj.conversationOnly : Boolean(rState.conversationOnly);
    const loading = !convOnly && stObj.preview === null && !stObj.previewError;
    const fileSummary = convOnly
      ? L('仅撤回对话 · 保留文件修改', 'Chat only · keep file edits')
      : loading
        ? L('正在检查变更文件…', 'Checking modified files…')
        : stObj.previewError
          ? L('文件预览获取失败', 'Failed to preview file changes')
          : stObj.preview && stObj.preview.length
            ? L(`还原 ${stObj.preview.length} 个文件`, `Revert ${stObj.preview.length} ${stObj.preview.length === 1 ? 'file' : 'files'}`)
            : L('无关联文件变更', 'No modified files');
    const hasMedia = Boolean(
      stObj.bubble && stObj.bubble.querySelector('.agy-user-bubble-header, img, [data-testid*="attachment"], [data-testid*="media"]')
    );
    metaEl.innerHTML =
      (rState.conversationOnlyRevertEnabled
        ? `<button type="button" class="ag-claude-switch" role="switch" data-ag-revert-files-switch aria-label="${escapeHtml(L('同步撤回文件修改', 'Revert modified files'))}" aria-checked="${!convOnly}"><span></span></button><span>${L('同步撤回文件', 'Revert files')}</span><span style="opacity:0.45">·</span>`
        : '') +
      `<span>${escapeHtml(fileSummary)}</span>` +
      (hasMedia
        ? `<span style="opacity:0.75" title="${escapeHtml(L('重发时自动保留原消息图片/附件；如需增删附件请点「移至底栏」', 'Keeps original attachments on resend; click Move to input to edit attachments'))}">· ${L('保留原附件', 'Keep attachments')}</span>`
        : '');

    if (filesEl) {
      if (!convOnly && !loading && !stObj.previewError && stObj.preview && stObj.preview.length) {
        const chips = stObj.preview
          .slice(0, 8)
          .map((p) => {
            const raw = String(p.fileUri || p.uri || 'file');
            const base = decodeURIComponent(raw.split('/').pop() || raw);
            return `<span class="ag-claude-inline-file-chip">${escapeHtml(base)}</span>`;
          })
          .join('');
        const extra = stObj.preview.length > 8 ? `<span class="ag-claude-inline-file-chip">+${stObj.preview.length - 8}</span>` : '';
        filesEl.innerHTML = `<div>${L(`撤回此步将一并还原以下 ${stObj.preview.length} 个文件至提问前状态：`, `Reverting will restore these ${stObj.preview.length} ${stObj.preview.length === 1 ? 'file' : 'files'}:`)}</div><div class="ag-claude-inline-file-chips">${chips}${extra}</div>`;
      } else {
        filesEl.innerHTML = '';
      }
    }

    const sw = metaEl.querySelector('[data-ag-revert-files-switch]');
    if (sw) {
      sw.addEventListener('click', () => {
        const latest = resolveNativeRevertTarget(button) || stObj.target;
        const nextConvOnly = !(stObj.conversationOnly ?? Boolean(latest.state.conversationOnly));
        stObj.conversationOnly = nextConvOnly;
        if (typeof latest.state.setConversationOnly === 'function') {
          latest.state.setConversationOnly(nextConvOnly);
        }
        if (!nextConvOnly && !stObj.previewLoaded && !stObj.previewError) {
          stObj.preview = null;
          renderInlineEditMeta(stObj);
          loadInlineRevertPreview(stObj);
          return;
        }
        renderInlineEditMeta(stObj);
      });
    }
  }

  async function loadInlineRevertPreview(stObj) {
    if (!stObj || stObj.previewLoading) return;
    stObj.previewLoading = true;
    try {
      const preview = await stObj.target.context.stepHandler.getRevertPreviews(stObj.target.session, stObj.target.index - 1);
      if (activeInlineEdit !== stObj) return;
      stObj.preview = Array.isArray(preview) ? preview : [];
      stObj.previewLoaded = true;
    } catch (err) {
      if (activeInlineEdit !== stObj) return;
      stObj.previewError = String((err && err.message) || err);
    } finally {
      stObj.previewLoading = false;
    }
    renderInlineEditMeta(stObj);
  }

  async function applyInlineUndo(shouldSubmit) {
    const stObj = activeInlineEdit;
    if (!stObj || inlineUndoBusy) return;
    let current = resolveNativeRevertTarget(stObj.button) || stObj.target;
    if (!current) return;
    inlineUndoBusy = true;
    const { editorBox } = stObj;
    const ta = editorBox.querySelector('.ag-claude-inline-textarea');
    if (ta) {
      stObj.draftText = ta.value;
      ta.disabled = true;
    }
    editorBox.querySelectorAll('button').forEach((b) => {
      b.disabled = true;
    });
    const warnEl = editorBox.querySelector('[data-ag-inline-warn]');
    if (warnEl) warnEl.textContent = shouldSubmit ? L('正在撤回并重发…', 'Reverting and resending…') : L('正在移至底栏…', 'Moving to composer…');

    const rootEl = getComposerLexicalRoot(current.context);
    const composerEl = (rootEl && rootEl.closest('[data-testid="agent-input-box"]')) || null;
    try {
      if (
        current.state &&
        current.state.conversationOnlyRevertEnabled &&
        stObj.conversationOnly !== undefined &&
        current.state.conversationOnly !== stObj.conversationOnly
      ) {
        current.state.setConversationOnly(stObj.conversationOnly);
        await new Promise((r) => setTimeout(r, 30));
        current = resolveNativeRevertTarget(stObj.button) || current;
      }
      await performNativeRevert(current);
      if (disposed || activeInlineEdit !== stObj) return;
      setComposerText(current.context, stObj.draftText);
      closeInlineEdit(false);
      if (shouldSubmit) {
        await submitComposerAfterRevert(current.context, composerEl);
      } else {
        const nextRoot = getComposerLexicalRoot(current.context);
        if (nextRoot && typeof nextRoot.focus === 'function') nextRoot.focus();
      }
    } catch (err) {
      inlineUndoBusy = false;
      if (activeInlineEdit !== stObj) return;
      if (ta) ta.disabled = false;
      editorBox.querySelectorAll('button').forEach((b) => {
        b.disabled = false;
      });
      if (warnEl) warnEl.textContent = L('撤回失败，请重试', 'Revert failed, please try again');
    }
  }

  function openInlineEdit(button, target) {
    const stepEl = button.closest && button.closest('[data-testid="user-input-step"]');
    const bubble = (stepEl && stepEl.querySelector('[data-testid="user-message-bubble"]')) || button.parentElement;
    if (!bubble) return;
    const contentEl = bubble.querySelector('[data-testid="user-message-content"]');
    const hosts = [];
    for (let el = bubble.parentElement; el && el !== stepEl; el = el.parentElement) {
      const cls = String(el.className || '');
      if (el.classList.contains('agy-user-bubble-frame') || cls.includes('max-w-')) {
        hosts.push(el);
      }
    }
    bubble.classList.add('ag-claude-editing-bubble');
    hosts.forEach((h) => h.classList.add('ag-claude-editing-host'));
    if (contentEl) {
      contentEl.hidden = true;
      contentEl.classList.add('ag-claude-inline-hidden');
    }

    const editorBox = document.createElement('div');
    editorBox.className = 'ag-claude-inline-editor';
    editorBox.setAttribute('data-ag-i18n-ignore', '1');
    editorBox.setAttribute('role', 'region');
    editorBox.setAttribute('aria-label', L('原地编辑消息', 'Edit message inline'));
    editorBox.addEventListener('click', (ev) => ev.stopPropagation());

    const convOnly = Boolean(target.state && target.state.conversationOnly);
    const stObj = {
      button,
      target,
      bubble,
      contentEl,
      hosts,
      editorBox,
      draftText: target.text || '',
      conversationOnly: convOnly,
      preview: convOnly ? [] : null,
      previewError: '',
      previewLoaded: convOnly,
      previewLoading: false
    };
    activeInlineEdit = stObj;

    editorBox.innerHTML = `
      <textarea class="ag-claude-inline-textarea" aria-label="${escapeHtml(L('编辑消息内容', 'Edit message'))}" rows="1"></textarea>
      <div class="ag-claude-inline-files" data-ag-inline-files></div>
      <div class="ag-claude-inline-footer">
        <div class="ag-claude-inline-meta">
          <span data-ag-inline-meta style="display:inline-flex;align-items:center;gap:7px;flex-wrap:wrap"></span>
          <span class="ag-claude-inline-warn" data-ag-inline-warn role="status"></span>
        </div>
        <div class="ag-claude-inline-actions">
          <button type="button" class="ag-claude-inline-btn" data-ag-inline-cancel>${L('取消', 'Cancel')}</button>
          <button type="button" class="ag-claude-inline-btn" data-ag-inline-bottom title="${escapeHtml(L('撤回并移回底部输入框（可增删图片附件或切换模型）', 'Revert and move to bottom input (to edit attachments or switch model)'))}">${L('移至底栏', 'Move to input')}</button>
          <button type="button" class="ag-claude-inline-btn" data-primary="true" data-ag-inline-send>${L('重发', 'Resend')}</button>
        </div>
      </div>
    `;
    bubble.appendChild(editorBox);

    const ta = editorBox.querySelector('.ag-claude-inline-textarea');
    ta.value = stObj.draftText;
    const autoResize = () => {
      ta.style.height = 'auto';
      const h = Number(ta.scrollHeight) || 26;
      ta.style.height = `${Math.min(240, Math.max(26, h))}px`;
    };
    autoResize();
    ta.addEventListener('input', () => {
      stObj.draftText = ta.value;
      autoResize();
    });
    ta.addEventListener('keydown', (ev) => {
      if (ev.key === 'Enter' && !ev.shiftKey && !ev.isComposing && ev.keyCode !== 229) {
        ev.preventDefault();
        ev.stopPropagation();
        applyInlineUndo(true);
      } else if (ev.key === 'Escape') {
        ev.preventDefault();
        ev.stopPropagation();
        closeInlineEdit(true);
      }
    });
    editorBox.querySelector('[data-ag-inline-cancel]').addEventListener('click', () => closeInlineEdit(true));
    editorBox.querySelector('[data-ag-inline-bottom]').addEventListener('click', () => applyInlineUndo(false));
    editorBox.querySelector('[data-ag-inline-send]').addEventListener('click', () => applyInlineUndo(true));

    renderInlineEditMeta(stObj);
    if (composerHasExistingDraft(target.context)) {
      const warnEl = editorBox.querySelector('[data-ag-inline-warn]');
      if (warnEl) warnEl.textContent = L('将覆盖底栏现有草稿', 'Will replace current composer draft');
    }
    if (typeof ta.focus === 'function') {
      ta.focus({ preventScroll: true });
      const len = ta.value.length;
      if (typeof ta.setSelectionRange === 'function') ta.setSelectionRange(len, len);
    }
    if (!convOnly) loadInlineRevertPreview(stObj);
  }

  const onRevertButtonClick = (e) => {
    if (disposed || !FEAT.inlineUndo) return;
    const btn = e.target && e.target.closest && e.target.closest('button[data-testid="revert-button"]');
    if (!btn || btn.disabled || btn.getAttribute('aria-disabled') === 'true') return;
    const target = resolveNativeRevertTarget(btn);
    if (!target) return;
    e.preventDefault();
    e.stopPropagation();
    e.stopImmediatePropagation();
    if (inlineUndoBusy) return;
    if (activeInlineEdit && activeInlineEdit.button === btn) {
      closeInlineEdit(true);
      return;
    }
    closeInlineEdit(false);
    openInlineEdit(btn, target);
  };

  const onInlineEditDocKeyDown = (e) => {
    if (disposed || !activeInlineEdit || inlineUndoBusy) return;
    if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      e.stopImmediatePropagation();
      closeInlineEdit(true);
    }
  };

  document.addEventListener('click', onRevertButtonClick, true);
  document.addEventListener('keydown', onInlineEditDocKeyDown, true);

  /* ==========================================================================
   * 8. Sidebar Enhancements: Collapsed Project Status Badges + Top Recents
   *    - Purely reads in-memory Redux `trajectorySummaries` (0 network calls).
   *    - Badges automatically fade on hover to yield to native `+ / ⋯` actions.
   *    - Top `最近对话` sorts `pending > running > recent` with 0ms router switch.
   * ========================================================================== */
  const SIDEBAR_IGNORED_TYPES = new Set([21, 22, 23]);
  const PENDING_TERM_SVG =
    '<svg viewBox="0 0 16 16" width="12" height="12" fill="none" stroke="currentColor" stroke-width="1.55" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3.5 5l3 3-3 3"/><path d="M8 11h4.5"/></svg>';
  const PENDING_LOCK_SVG =
    '<svg viewBox="0 0 16 16" width="12" height="12" fill="none" stroke="currentColor" stroke-width="1.45" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="3.5" y="7" width="9" height="6" rx="1.5"/><path d="M5.5 7V5a2.5 2.5 0 0 1 5 0v2"/></svg>';
  const PENDING_BELL_SVG =
    '<svg viewBox="0 0 16 16" width="12" height="12" fill="none" stroke="currentColor" stroke-width="1.45" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M11.5 6.5a3.5 3.5 0 1 0-7 0c0 3.2-1.3 4.3-1.3 4.3h9.6s-1.3-1.1-1.3-4.3"/><path d="M6.8 13a1.3 1.3 0 0 0 2.4 0"/></svg>';
  const RECENT_PLUS_SVG =
    '<svg viewBox="0 0 16 16" width="13" height="13" fill="none" stroke="currentColor" stroke-width="1.55" stroke-linecap="round" aria-hidden="true"><path d="M8 3.2v9.6M3.2 8h9.6"/></svg>';
  const RECENT_PIN_SVG =
    '<svg viewBox="0 0 16 16" width="13" height="13" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M9.7 2.8l3.5 3.5-1.4 1.4-.9-.3-2.6 2.6.4 1.6-1.1 1.1-2.5-2.5-2.6 2.6-.7-.7 2.6-2.6-2.5-2.5 1.1-1.1 1.6.4 2.6-2.6-.3-.9z"/></svg>';
  const RECENT_MORE_SVG =
    '<svg viewBox="0 0 16 16" width="13" height="13" fill="currentColor" aria-hidden="true"><circle cx="3.5" cy="8" r="1.2"/><circle cx="8" cy="8" r="1.2"/><circle cx="12.5" cy="8" r="1.2"/></svg>';
  const RECENT_FOLDER_SVG =
    '<svg viewBox="0 0 16 16" width="13" height="13" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M2.2 4.4A1.2 1.2 0 0 1 3.4 3.2h3.1l1.2 1.3h4.9a1.2 1.2 0 0 1 1.2 1.2v6.1a1.2 1.2 0 0 1-1.2 1.2H3.4a1.2 1.2 0 0 1-1.2-1.2V4.4z"/></svg>';
  const RECENT_RENAME_SVG =
    '<svg viewBox="0 0 16 16" width="13" height="13" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M11.3 2.7l2 2-7.8 7.8-2.6.6.6-2.6 7.8-7.8z"/></svg>';
  const RECENT_ARCHIVE_SVG =
    '<svg viewBox="0 0 16 16" width="13" height="13" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="2.2" y="3" width="11.6" height="2.8" rx="0.8"/><path d="M3.2 5.8v6.4a1 1 0 0 0 1 1h7.6a1 1 0 0 0 1-1V5.8"/><path d="M6.4 8.8h3.2"/></svg>';
  const RECENT_TRASH_SVG =
    '<svg viewBox="0 0 16 16" width="13" height="13" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 4.5h10M6 4.5V3.3a.8.8 0 0 1 .8-.8h2.4a.8.8 0 0 1 .8.8v1.2"/><path d="M4.2 4.5l.7 8.1a1 1 0 0 0 1 .9h4.2a1 1 0 0 0 1-.9l.7-8.1"/></svg>';

  let sidebarStoreRef = null;
  let sidebarStoreUnsub = null;
  let sidebarSyncTimer = 0;
  let cachedSidebarActionsCtx = null;
  let recentExpanded = false;
  let recentPageLimit = 50;
  let recentLastSig = '';
  let recentRenamingId = '';
  let recentMenuState = null;
  let recentMenuDocBound = false;
  let recentItemsById = new Map();
  let recentCollapsed = (() => {
    try {
      if (trustLocalOverrides && typeof localStorage === 'object' && localStorage) {
        const v = localStorage.getItem('ag_claude_ux_recent_collapsed');
        if (v === '1' || v === '0') return v === '1';
      }
    } catch {}
    return Boolean(CFG_UI_STATE.recentCollapsed);
  })();
  let unifiedRecentCollapsed = (() => {
    try {
      if (trustLocalOverrides && typeof localStorage === 'object' && localStorage) {
        const v = localStorage.getItem('ag_claude_ux_unified_recents_collapsed');
        if (v === '1' || v === '0') return v === '1';
      }
    } catch {}
    return Boolean(CFG_UI_STATE.unifiedRecentCollapsed);
  })();

  function protoSeconds(ts) {
    if (!ts) return 0;
    if (typeof ts === 'number') return ts;
    if (ts.seconds !== undefined && ts.seconds !== null) return Number(ts.seconds) || 0;
    return 0;
  }

  function pendingSubkindOf(waitingStep) {
    const tool = String((waitingStep && waitingStep.metadata && waitingStep.metadata.toolCall && waitingStep.metadata.toolCall.name) || '')
      .split(':')
      .pop();
    if (tool === 'ask_permission') {
      try {
        const args = JSON.parse((waitingStep.metadata && waitingStep.metadata.toolCall && waitingStep.metadata.toolCall.argumentsJson) || '{}');
        if (args.command || args.CommandLine) return 'terminal';
        if (args.read_file || args.write_file || args.Path || args.AbsolutePath || args.TargetFile) return 'lock';
      } catch {}
      return 'lock';
    }
    if (/run_command|command/i.test(tool)) return 'terminal';
    return 'bell';
  }

  function hasIndexKey(idxCol, id) {
    if (!idxCol || !id) return false;
    if (typeof idxCol.has === 'function') return idxCol.has(id);
    if (Array.isArray(idxCol)) return idxCol.includes(id);
    if (typeof idxCol === 'object') return Object.prototype.hasOwnProperty.call(idxCol, id);
    return false;
  }

  function getIndexSize(idxCol) {
    if (!idxCol) return 0;
    if (typeof idxCol.size === 'number') return idxCol.size;
    if (Array.isArray(idxCol)) return idxCol.length;
    if (typeof idxCol === 'object') return Object.keys(idxCol).length;
    return 0;
  }

  function isSummaryPinned(id, summary, state) {
    if (summary && summary.annotations && summary.annotations.pinned) return true;
    const idxPinned =
      state && state.trajectorySummaries && state.trajectorySummaries.indexes && state.trajectorySummaries.indexes.pinned;
    return hasIndexKey(idxPinned, id);
  }

  function isSidebarVisibleSummary(id, summary, state) {
    if (!id || !summary) return false;
    if (summary.annotations && summary.annotations.archived) return false;
    if (summary.trajectoryMetadata && summary.trajectoryMetadata.parentConversationId) return false;
    if (summary.trajectoryMetadata && summary.trajectoryMetadata.isBattleModeFork) return false;
    if (
      summary.trajectoryMetadata &&
      summary.trajectoryMetadata.sourceMetadata &&
      summary.trajectoryMetadata.sourceMetadata.hideFromConversationList
    ) {
      return false;
    }
    if (SIDEBAR_IGNORED_TYPES.has(summary.trajectoryType)) return false;
    /* Antigravity partitions top-level conversations between `indexes.pinned` and `indexes.sidebar`
     * (`indexes.sidebar` excludes pinned conversations). Pinned items and external summaries are still visible. */
    if (isSummaryPinned(id, summary, state)) return true;
    const primarySummaries = state && state.trajectorySummaries && state.trajectorySummaries.summaries;
    if (primarySummaries && !Object.prototype.hasOwnProperty.call(primarySummaries, id)) {
      return true;
    }
    const idxSidebar =
      state && state.trajectorySummaries && state.trajectorySummaries.indexes && state.trajectorySummaries.indexes.sidebar;
    if (idxSidebar && getIndexSize(idxSidebar) > 0 && !hasIndexKey(idxSidebar, id)) {
      return false;
    }
    return true;
  }

  /* Left sidebar & Recents rely on native CSS `text-autospace: normal` (1/8em optical boundary, matching right-pane prose
   * without mutating DOM text nodes or polluting copied conversation titles with extra ASCII spaces). */
  function restoreLegacySidebarCjkNodes() {
    document.querySelectorAll('[data-ag-orig-cjk]').forEach((el) => {
      const orig = el.getAttribute('data-ag-orig-cjk');
      el.removeAttribute('data-ag-orig-cjk');
      if (orig !== null && el.childNodes.length === 1 && el.firstChild && el.firstChild.nodeType === 3) {
        el.firstChild.nodeValue = orig;
      }
    });
  }

  function classifySidebarConversation(id, summary, state, activeId, hasFocus) {
    if (!isSidebarVisibleSummary(id, summary, state)) return null;

    const summaries = (state && state.trajectorySummaries && state.trajectorySummaries.summaries) || {};
    const byParent = state && state.trajectorySummaries && state.trajectorySummaries.indexes && state.trajectorySummaries.indexes.byParent;
    let waitingStep = (summary.waitingSteps && summary.waitingSteps[0]) || null;
    const rawChildren = byParent && byParent[id];
    if (!waitingStep && rawChildren) {
      const childIds =
        typeof rawChildren[Symbol.iterator] === 'function'
          ? rawChildren
          : typeof rawChildren === 'object'
            ? Object.keys(rawChildren)
            : [];
      for (const cid of childIds) {
        const ch = summaries[cid];
        if (ch && ch.waitingSteps && ch.waitingSteps.length) {
          waitingStep = ch.waitingSteps[0];
          break;
        }
      }
    }
    const title = String((summary.annotations && summary.annotations.title) || summary.summary || id);
    if (waitingStep) {
      return { kind: 'pending', subkind: pendingSubkindOf(waitingStep), title };
    }

    const status = summary.status ?? 0;
    const isWorking =
      !summary.killed && (status === 2 || status === 3 || status === 4 || Boolean(summary.hasRunningSubagents));
    const isBgWorking =
      !summary.killed && (status === 1 || status === 0) && !summary.hasRunningSubagents && Boolean(summary.notFullyIdle);
    if (isWorking || isBgWorking) {
      return { kind: 'running', subkind: 'orbit', title };
    }

    if (!summary.notFullyIdle) {
      const marked = Boolean(summary.annotations && summary.annotations.markedAsUnread);
      const isFocusedHere = activeId === id && hasFocus;
      if (marked || !isFocusedHere) {
        const lastMod = protoSeconds(summary.lastModifiedTime);
        const remoteView = protoSeconds(summary.annotations && summary.annotations.lastUserViewTime);
        const localView = Number((state && state.conversation && state.conversation.localLastViewedTimes && state.conversation.localLastViewedTimes[id]) || 0);
        if (marked || (lastMod > 0 && lastMod > Math.max(remoteView, localView))) {
          return { kind: 'unread', subkind: 'dot', title };
        }
      }
    }
    return null;
  }

  function pendingGlyphSvg(subkind) {
    if (subkind === 'terminal') return PENDING_TERM_SVG;
    if (subkind === 'lock') return PENDING_LOCK_SVG;
    return PENDING_BELL_SVG;
  }

  function findSidebarBindings() {
    const sidebar = document.querySelector('[data-testid="conversation-list-sidebar"]');
    if (!sidebar) return null;
    let f = activeReactFiber(sidebar.firstElementChild || sidebar) || activeReactFiber(sidebar);
    let store = null;
    let router = null;
    let stepHandler = null;
    let actionsCtx = cachedSidebarActionsCtx;
    const groupsById = new Map();
    const projectLabels = new Map();

    const scanFiber = (startFiber, maxDepth) => {
      for (let cur = startFiber, d = 0; cur && d < maxDepth; d++, cur = cur.return) {
        const p = cur.memoizedProps;
        if (p && p.sidebarStore && !store) store = p.sidebarStore;
        if (p && p.sidebarRouter && !router) router = p.sidebarRouter;
        if (p && p.sidebarActions && !actionsCtx) actionsCtx = p.sidebarActions;
        if (p && Array.isArray(p.sidebarGroups) && !groupsById.size) {
          for (const g of p.sidebarGroups) {
            if (g && g.id) {
              groupsById.set(g.id, g.conversationIds || []);
              if (g.label || g.name) projectLabels.set(g.id, g.label || g.name);
            }
          }
        }
        if (!groupsById.size) {
          for (let s = cur.memoizedState; s; s = s.next) {
            const v = s.memoizedState;
            if (Array.isArray(v) && v.length && v[0] && Array.isArray(v[0].conversationIds)) {
              for (const g of v) {
                if (g && g.id) {
                  groupsById.set(g.id, g.conversationIds || []);
                  const lbl = g.label || g.name || g.title;
                  if (lbl) projectLabels.set(g.id, lbl);
                }
              }
              if (groupsById.size) break;
            }
          }
        }
        for (let dep = cur.dependencies && cur.dependencies.firstContext; dep; dep = dep.next) {
          const mv = dep.memoizedValue;
          if (!store && mv && mv.store && typeof mv.store.getState === 'function') {
            const st = mv.store.getState();
            if (st && st.trajectorySummaries && st.trajectorySummaries.summaries) {
              store = mv.store;
            }
          }
          if (!router && mv && typeof mv.navigate === 'function' && mv.state && mv.state.location) {
            router = mv;
          }
          if (!stepHandler && mv && mv.stepHandler && typeof mv.stepHandler.openConversation === 'function') {
            stepHandler = mv.stepHandler;
          }
          if (
            !actionsCtx &&
            mv &&
            (typeof mv.updateConversationAnnotations === 'function' || typeof mv.deleteCascadeTrajectory === 'function')
          ) {
            actionsCtx = mv;
          }
        }
        if (store && router && actionsCtx && groupsById.size) break;
      }
    };

    scanFiber(f, 36);
    if (!actionsCtx) {
      const anyRow = sidebar.querySelector('[data-testid="conversation-row-sidebar"]');
      if (anyRow) scanFiber(activeReactFiber(anyRow), 36);
    }
    if (!store) return null;
    if (actionsCtx) cachedSidebarActionsCtx = actionsCtx;

    const st = store.getState && store.getState();
    const rawProjects = (st && st.sidebarProjects && st.sidebarProjects.projects) || [];
    for (const p of rawProjects) {
      if (!p || !p.id || p.id === 'outside-of-project') continue;
      const lbl = p.id === 'default-cli-project' ? L('CLI 项目', 'CLI Project') : String(p.name || '').trim();
      if (lbl && !projectLabels.has(p.id)) projectLabels.set(p.id, lbl);
    }
    for (const hdr of sidebar.querySelectorAll('button[data-testid="project-header"]')) {
      const drop = hdr.closest('[data-sidebar-section-drop-id]');
      const pid = drop && drop.getAttribute('data-sidebar-section-drop-id');
      const lbl = hdr.getAttribute('data-project-label') || (hdr.textContent || '').trim();
      if (pid && lbl && !projectLabels.has(pid)) projectLabels.set(pid, lbl);
    }
    return { sidebar, store, router, stepHandler, actionsCtx, groupsById, projectLabels };
  }

  function resolveProjectHeaderId(btn) {
    const drop = btn.closest('[data-sidebar-section-drop-id]');
    if (drop) {
      const id = drop.getAttribute('data-sidebar-section-drop-id');
      if (id) return id;
    }
    for (let f = activeReactFiber(btn), d = 0; f && d < 10; f = f.return, d++) {
      const p = f.memoizedProps;
      if (p && typeof p.projectId === 'string' && p.projectId) return p.projectId;
      if (p && typeof p.brandedProjectId === 'string' && p.brandedProjectId) return p.brandedProjectId;
    }
    return '';
  }

  function clearAllFolderBadges() {
    document.querySelectorAll('.ag-claude-folder-badges').forEach((el) => el.remove());
    document.querySelectorAll('button[data-testid="project-header"][data-ag-folder-tip]').forEach((btn) => {
      const orig = btn.getAttribute('data-ag-orig-folder-title');
      btn.removeAttribute('data-ag-folder-tip');
      btn.removeAttribute('data-ag-orig-folder-title');
      if (orig) btn.setAttribute('title', orig);
      else btn.removeAttribute('title');
    });
  }

  function syncFolderStatusBadges(bindings, state, activeId, hasFocus) {
    if (!FEAT.folderStatus || !bindings) {
      clearAllFolderBadges();
      return;
    }
    const summaries = (state && state.trajectorySummaries && state.trajectorySummaries.summaries) || {};
    const headers = bindings.sidebar.querySelectorAll('button[data-testid="project-header"]');
    for (const btn of headers) {
      const host = btn.closest('.group\\/header') || btn.parentElement;
      if (!host) continue;
      if (!host.style.position && !host.classList.contains('relative')) {
        host.style.position = 'relative';
      }
      const collapsed = btn.getAttribute('aria-expanded') === 'false';
      const pid = collapsed ? resolveProjectHeaderId(btn) : '';
      const convIds = pid ? bindings.groupsById.get(pid) : null;
      let badgeWrap = host.querySelector(':scope > .ag-claude-folder-badges');

      if (!collapsed || !convIds || !convIds.length) {
        if (badgeWrap) badgeWrap.remove();
        if (btn.hasAttribute('data-ag-folder-tip')) {
          const orig = btn.getAttribute('data-ag-orig-folder-title');
          btn.removeAttribute('data-ag-folder-tip');
          btn.removeAttribute('data-ag-orig-folder-title');
          if (orig) btn.setAttribute('title', orig);
          else btn.removeAttribute('title');
        }
        continue;
      }

      const buckets = {
        pending: { kind: 'pending', count: 0, subkind: null, titles: [] },
        running: { kind: 'running', count: 0, subkind: 'orbit', titles: [] },
        unread: { kind: 'unread', count: 0, subkind: 'dot', titles: [] }
      };
      const seen = new Set();
      for (const cid of convIds) {
        if (!cid || seen.has(cid)) continue;
        seen.add(cid);
        const cls = classifySidebarConversation(cid, summaries[cid], state, activeId, hasFocus);
        if (!cls) continue;
        const b = buckets[cls.kind];
        b.count += 1;
        if (!b.subkind) b.subkind = cls.subkind;
        if (b.titles.length < 3 && cls.title) b.titles.push(cls.title);
      }

      const active = ['pending', 'running', 'unread'].map((k) => buckets[k]).filter((b) => b.count > 0);
      if (!active.length) {
        if (badgeWrap) badgeWrap.remove();
        if (btn.hasAttribute('data-ag-folder-tip')) {
          const orig = btn.getAttribute('data-ag-orig-folder-title');
          btn.removeAttribute('data-ag-folder-tip');
          btn.removeAttribute('data-ag-orig-folder-title');
          if (orig) btn.setAttribute('title', orig);
          else btn.removeAttribute('title');
        }
        continue;
      }

      const kindLabels = FEAT.i18n
        ? { pending: '待处理', running: '运行中', unread: '已完成未读' }
        : { pending: 'pending', running: 'running', unread: 'unread' };
      const summaryLine = active
        .map((b) => (FEAT.i18n ? `${b.count} 个${kindLabels[b.kind]}` : `${b.count} ${kindLabels[b.kind]}`))
        .join(' · ');
      const detailLines = active
        .flatMap((b) => b.titles.map((t) => `${kindLabels[b.kind]}${FEAT.i18n ? '：' : ': '}${t}`))
        .slice(0, 4);
      const tip = detailLines.length ? `${summaryLine}\n${detailLines.join('\n')}` : summaryLine;
      if (!btn.hasAttribute('data-ag-folder-tip')) {
        const orig = btn.getAttribute('title');
        if (orig) btn.setAttribute('data-ag-orig-folder-title', orig);
        btn.setAttribute('data-ag-folder-tip', 'true');
      }
      if (btn.getAttribute('title') !== tip) btn.setAttribute('title', tip);

      const html = active
        .slice(0, 2)
        .map((b) => {
          const ico =
            b.kind === 'pending'
              ? pendingGlyphSvg(b.subkind)
              : b.kind === 'running'
                ? '<span class="ag-folder-orbit"></span>'
                : '<span class="ag-claude-unread-dot"></span>';
          return `<span class="ag-claude-folder-badge" data-kind="${b.kind}">${ico}<span>${b.count}</span></span>`;
        })
        .join('');

      if (!badgeWrap) {
        badgeWrap = document.createElement('div');
        badgeWrap.className = 'ag-claude-folder-badges';
        badgeWrap.setAttribute('aria-hidden', 'true');
        host.appendChild(badgeWrap);
      }
      const sig = `${active.map((b) => `${b.kind}:${b.subkind}:${b.count}`).join('|')}`;
      if (badgeWrap.getAttribute('data-ag-sig') !== sig) {
        badgeWrap.setAttribute('data-ag-sig', sig);
        badgeWrap.innerHTML = html;
      }
    }
  }

  function formatRelativeAge(sec, nowSec) {
    if (!sec) return '';
    const diff = Math.max(0, nowSec - sec);
    if (diff < 60) return L('刚刚', 'now');
    if (diff < 3600) return `${Math.floor(diff / 60)}m`;
    if (diff < 86400) return `${Math.floor(diff / 3600)}h`;
    return `${Math.floor(diff / 86400)}d`;
  }

  function getSidebarListHost(sidebar) {
    if (!sidebar) return { host: null, container: null };
    const p = sidebar.parentElement;
    const isDedicatedWrap = Boolean(
      p &&
        p !== document.body &&
        !p.classList.contains('bg-sidebar') &&
        !p.querySelector('[data-testid="automations-button"], [data-testid="new-conversation-button"]')
    );
    const host = isDedicatedWrap ? p : sidebar;
    return { host, container: host && host.parentElement };
  }

  function resolveSummaryProjectInfo(summary, projectLabels, state) {
    const meta = (summary && summary.trajectoryMetadata) || {};
    const pid = String(meta.projectId || (summary && summary.projectId) || '');
    if (pid && pid !== 'outside-of-project') {
      if (projectLabels && projectLabels.has(pid)) return { id: pid, name: projectLabels.get(pid) };
      const rawProjects = (state && state.sidebarProjects && state.sidebarProjects.projects) || [];
      const found = rawProjects.find((p) => p && p.id === pid);
      if (found) {
        const nm = found.id === 'default-cli-project' ? L('CLI 项目', 'CLI Project') : String(found.name || '').trim();
        if (nm) return { id: pid, name: nm };
      }
      const uri = (meta.workspaceUris && meta.workspaceUris[0]) || '';
      const fallback = decodeURIComponent(String(uri).split('/').filter(Boolean).pop() || '');
      return { id: pid, name: fallback };
    }
    const wsUri = (meta.workspaceUris && meta.workspaceUris[0]) || '';
    if (wsUri) {
      const rawProjects = (state && state.sidebarProjects && state.sidebarProjects.projects) || [];
      const found = rawProjects.find((p) => p && Array.isArray(p.folderUris) && p.folderUris.includes(wsUri));
      if (found && found.id && found.id !== 'outside-of-project') {
        const nm = found.id === 'default-cli-project' ? L('CLI 项目', 'CLI Project') : String(found.name || '').trim();
        if (nm) return { id: found.id, name: nm };
      }
    }
    return { id: '', name: '' };
  }

  function navigateSidebarConversation(id, bindings) {
    if (!id) return;
    if (bindings && bindings.router && typeof bindings.router.navigate === 'function') {
      try {
        bindings.router.navigate({ to: '/c/$cascadeId', params: { cascadeId: id } });
        return;
      } catch {}
    }
    if (bindings && bindings.stepHandler && typeof bindings.stepHandler.openConversation === 'function') {
      try {
        bindings.stepHandler.openConversation(id);
        return;
      } catch {}
    }
    const link = document.querySelector(`a[href*="/c/${id}"]`);
    if (link && typeof link.click === 'function') {
      link.click();
      return;
    }
    if (typeof history === 'object' && typeof history.pushState === 'function') {
      history.pushState(null, '', `/c/${id}`);
      window.dispatchEvent(new PopStateEvent('popstate'));
    }
  }

  function triggerNewConversationFromSidebar(bindings) {
    const newBtn = document.querySelector('[data-testid="new-conversation-button"], a[href="/"]');
    if (newBtn && typeof newBtn.click === 'function') {
      try {
        newBtn.click();
        return;
      } catch {}
    }
    if (bindings && bindings.router && typeof bindings.router.navigate === 'function') {
      try {
        bindings.router.navigate({ to: '/' });
        return;
      } catch {}
    }
    if (typeof history === 'object' && typeof history.pushState === 'function') {
      history.pushState(null, '', '/');
      window.dispatchEvent(new PopStateEvent('popstate'));
    }
  }

  function getSidebarActionsCtx(bindings) {
    return (bindings && bindings.actionsCtx) || cachedSidebarActionsCtx || null;
  }

  async function mutateRecentConversationAnnotation(id, patch, bindings) {
    const act = getSidebarActionsCtx(bindings);
    if (!id || !act || typeof act.updateConversationAnnotations !== 'function') return false;
    try {
      await act.updateConversationAnnotations(id, patch, true);
      recentLastSig = '';
      scheduleSidebarSync();
      return true;
    } catch {
      return false;
    }
  }

  async function deleteRecentConversation(id, bindings) {
    const act = getSidebarActionsCtx(bindings);
    if (!id || !act || typeof act.deleteCascadeTrajectory !== 'function') return false;
    try {
      const wasActive = getActiveCascadeId() === id;
      await act.deleteCascadeTrajectory(id);
      if (wasActive) triggerNewConversationFromSidebar(bindings);
      recentLastSig = '';
      scheduleSidebarSync();
      return true;
    } catch {
      return false;
    }
  }

  function closeRecentRowMenu() {
    recentMenuState = null;
    const menu = document.getElementById('ag-recent-row-menu');
    if (menu) menu.remove();
    if (recentMenuDocBound) {
      document.removeEventListener('mousedown', onRecentMenuDocDown, true);
      document.removeEventListener('keydown', onRecentMenuDocKey, true);
      window.removeEventListener('resize', closeRecentRowMenu);
      recentMenuDocBound = false;
    }
  }

  function onRecentMenuDocDown(ev) {
    const t = ev && ev.target;
    if (t && t.closest && t.closest('#ag-recent-row-menu, [data-ag-recent-menu]')) return;
    closeRecentRowMenu();
  }

  function onRecentMenuDocKey(ev) {
    if (ev && ev.key === 'Escape') {
      ev.preventDefault();
      ev.stopPropagation();
      closeRecentRowMenu();
    }
  }

  function startRecentInlineRename(id) {
    if (!id) return;
    closeRecentRowMenu();
    recentRenamingId = id;
    recentLastSig = '';
    syncSidebarEnhancements();
    frame(() => {
      const input = document.querySelector('#ag-claude-recent-section [data-ag-recent-rename-input]');
      if (input) {
        input.focus();
        try {
          input.select();
        } catch {}
      }
    });
  }

  function commitRecentInlineRename(input, commit) {
    if (!input) return;
    const id = input.getAttribute('data-ag-recent-rename-input') || recentRenamingId;
    const orig = input.getAttribute('data-orig-title') || '';
    const nextVal = String(input.value || '').trim();
    recentRenamingId = '';
    recentLastSig = '';
    if (commit && id && nextVal && nextVal !== orig) {
      mutateRecentConversationAnnotation(id, { title: nextVal }, findSidebarBindings());
    }
    syncSidebarEnhancements();
  }

  function renderRecentRowMenu() {
    const st = recentMenuState;
    if (!st) {
      closeRecentRowMenu();
      return;
    }
    let menu = document.getElementById('ag-recent-row-menu');
    if (!menu) {
      menu = document.createElement('div');
      menu.id = 'ag-recent-row-menu';
      menu.setAttribute('role', 'menu');
      menu.setAttribute('data-ag-i18n-ignore', '1');
      menu.addEventListener('click', (ev) => {
        const btn = ev.target && ev.target.closest && ev.target.closest('[data-ag-rm-act]');
        if (!btn || !recentMenuState) return;
        ev.preventDefault();
        ev.stopPropagation();
        const act = btn.getAttribute('data-ag-rm-act');
        const cur = recentMenuState;
        const bindings = findSidebarBindings();
        if (act === 'open-project' && cur.projectId) {
          closeRecentRowMenu();
          if (FEAT.projects) openProjectsView(cur.projectId);
          return;
        }
        if (act === 'pin') {
          closeRecentRowMenu();
          mutateRecentConversationAnnotation(cur.id, { pinned: true }, bindings);
          return;
        }
        if (act === 'rename') {
          startRecentInlineRename(cur.id);
          return;
        }
        if (act === 'archive') {
          closeRecentRowMenu();
          mutateRecentConversationAnnotation(cur.id, { archived: true }, bindings);
          return;
        }
        if (act === 'delete') {
          if (!cur.confirmDelete) {
            cur.confirmDelete = true;
            renderRecentRowMenu();
            return;
          }
          closeRecentRowMenu();
          deleteRecentConversation(cur.id, bindings);
        }
      });
      document.body.appendChild(menu);
    }

    const canMutate = Boolean(getSidebarActionsCtx(findSidebarBindings()));
    const projPart =
      st.projectName && st.projectId && FEAT.projects
        ? `<button type="button" class="ag-rm-item ag-rm-project" data-ag-rm-act="open-project" title="${escapeHtml(L('打开所属项目', 'Open project'))}">${RECENT_FOLDER_SVG}<span class="ag-rm-label">${escapeHtml(st.projectName)}</span></button><div class="ag-rm-sep"></div>`
        : st.projectName
          ? `<div class="ag-rm-meta">${RECENT_FOLDER_SVG}<span class="ag-rm-label">${escapeHtml(st.projectName)}</span></div><div class="ag-rm-sep"></div>`
          : '';
    const delLabel = st.confirmDelete ? L('确认删除？', 'Confirm delete?') : L('删除', 'Delete');
    menu.innerHTML =
      projPart +
      `<button type="button" class="ag-rm-item" data-ag-rm-act="pin"${canMutate ? '' : ' disabled'}>${RECENT_PIN_SVG}<span class="ag-rm-label">${escapeHtml(L('置顶对话', 'Pin'))}</span></button>` +
      `<button type="button" class="ag-rm-item" data-ag-rm-act="rename"${canMutate ? '' : ' disabled'}>${RECENT_RENAME_SVG}<span class="ag-rm-label">${escapeHtml(L('重命名', 'Rename'))}</span></button>` +
      `<button type="button" class="ag-rm-item" data-ag-rm-act="archive"${canMutate ? '' : ' disabled'}>${RECENT_ARCHIVE_SVG}<span class="ag-rm-label">${escapeHtml(L('归档', 'Archive'))}</span></button>` +
      `<div class="ag-rm-sep"></div>` +
      `<button type="button" class="ag-rm-item ag-rm-danger" data-ag-rm-act="delete" data-confirm="${st.confirmDelete ? '1' : '0'}"${canMutate ? '' : ' disabled'}>${RECENT_TRASH_SVG}<span class="ag-rm-label">${escapeHtml(delLabel)}</span></button>`;

    const menuW = 196;
    const menuH = Math.max(152, menu.offsetHeight || 176);
    const vw = window.innerWidth || 1200;
    const vh = window.innerHeight || 800;
    const left = Math.min(Math.max(8, st.x), Math.max(8, vw - menuW - 8));
    const top = st.y + menuH > vh - 8 ? Math.max(8, st.y - menuH) : Math.max(8, st.y);
    menu.style.left = `${Math.round(left)}px`;
    menu.style.top = `${Math.round(top)}px`;

    if (!recentMenuDocBound) {
      document.addEventListener('mousedown', onRecentMenuDocDown, true);
      document.addEventListener('keydown', onRecentMenuDocKey, true);
      window.addEventListener('resize', closeRecentRowMenu);
      recentMenuDocBound = true;
    }
  }

  function openRecentRowMenu(item, x, y) {
    if (!item || !item.id) return;
    if (recentMenuState && recentMenuState.id === item.id) {
      closeRecentRowMenu();
      return;
    }
    recentMenuState = {
      id: item.id,
      title: item.title,
      projectId: item.projectId || '',
      projectName: item.project || '',
      x,
      y,
      confirmDelete: false
    };
    renderRecentRowMenu();
  }

  function removeRecentSection() {
    closeRecentRowMenu();
    recentRenamingId = '';
    const el = document.getElementById('ag-claude-recent-section');
    if (el) el.remove();
    recentLastSig = '';
  }

  function syncRecentSection(bindings, state, activeId, hasFocus) {
    const isUnified = Boolean(FEAT.hideSidebarProjects);
    if ((!isUnified && !FEAT.recentSection) || !bindings) {
      removeRecentSection();
      return;
    }
    const { host: sbParent, container: sbGrand } = getSidebarListHost(bindings.sidebar);
    if (!sbParent || !sbGrand) return;

    const summaries = (state && state.trajectorySummaries && state.trajectorySummaries.summaries) || {};
    const list = [];
    for (const [id, summary] of Object.entries(summaries)) {
      if (!isSidebarVisibleSummary(id, summary, state)) continue;
      if (isSummaryPinned(id, summary, state)) continue;
      const rawTitle = (summary.annotations && summary.annotations.title) || summary.summary;
      if (!rawTitle) continue;
      const title = String(rawTitle);
      const updatedAt = Math.max(protoSeconds(summary.lastModifiedTime), protoSeconds(summary.createdTime));
      const status = classifySidebarConversation(id, summary, state, activeId, hasFocus);
      const priority = status && status.kind === 'pending' ? 3 : status && status.kind === 'running' ? 2 : 1;
      const projInfo = resolveSummaryProjectInfo(summary, bindings.projectLabels, state);
      list.push({
        id,
        title,
        project: projInfo.name,
        projectId: projInfo.id,
        updatedAt,
        status,
        priority
      });
    }
    if (!list.length && !isUnified) {
      removeRecentSection();
      return;
    }
    list.sort((a, b) => b.priority - a.priority || b.updatedAt - a.updatedAt);
    recentItemsById = new Map(list.map((it) => [it.id, it]));
    const limit = isUnified ? recentPageLimit : recentExpanded ? 8 : 4;
    const items = list.slice(0, limit);
    const total = list.length;
    const nowBucket = Math.floor(Date.now() / 30000);
    const nowSec = Math.floor(Date.now() / 1000);
    const mode = isUnified ? 'unified' : 'compact';

    let sec = document.getElementById('ag-claude-recent-section');
    const desiredRef = isUnified ? sbParent.nextSibling : sbParent;
    const wrongParent = !sec || sec.parentElement !== sbGrand;
    const wrongPosition =
      sec &&
      sec.parentElement === sbGrand &&
      (isUnified ? sec.previousSibling !== sbParent : sec.nextSibling !== sbParent);

    if (wrongParent) {
      if (sec) sec.remove();
      sec = document.createElement('section');
      sec.id = 'ag-claude-recent-section';
      sec.setAttribute('data-ag-i18n-ignore', '1');
      sec.setAttribute('aria-label', L('最近对话', 'Recents'));
      sec.addEventListener('click', (ev) => {
        const newBtn = ev.target && ev.target.closest && ev.target.closest('[data-ag-recent-new]');
        if (newBtn) {
          ev.preventDefault();
          ev.stopPropagation();
          closeRecentRowMenu();
          triggerNewConversationFromSidebar(findSidebarBindings() || bindings);
          return;
        }
        const hdr = ev.target && ev.target.closest && ev.target.closest('[data-ag-recent-toggle]');
        if (hdr) {
          if (sec.getAttribute('data-mode') === 'unified') {
            unifiedRecentCollapsed = !unifiedRecentCollapsed;
            try {
              localStorage.setItem('ag_claude_ux_unified_recents_collapsed', unifiedRecentCollapsed ? '1' : '0');
            } catch {}
          } else {
            recentCollapsed = !recentCollapsed;
            try {
              localStorage.setItem('ag_claude_ux_recent_collapsed', recentCollapsed ? '1' : '0');
            } catch {}
          }
          persistUiPrefsToDaemon();
          recentLastSig = '';
          syncSidebarEnhancements();
          return;
        }
        const more = ev.target && ev.target.closest && ev.target.closest('[data-ag-recent-more]');
        if (more) {
          if (sec.getAttribute('data-mode') === 'unified') {
            recentPageLimit += 50;
          } else {
            recentExpanded = !recentExpanded;
          }
          recentLastSig = '';
          syncSidebarEnhancements();
          return;
        }
        const pinBtn = ev.target && ev.target.closest && ev.target.closest('[data-ag-recent-pin]');
        if (pinBtn) {
          ev.preventDefault();
          ev.stopPropagation();
          closeRecentRowMenu();
          const cid = pinBtn.getAttribute('data-ag-recent-pin');
          mutateRecentConversationAnnotation(cid, { pinned: true }, findSidebarBindings() || bindings);
          return;
        }
        const menuBtn = ev.target && ev.target.closest && ev.target.closest('[data-ag-recent-menu]');
        if (menuBtn) {
          ev.preventDefault();
          ev.stopPropagation();
          const cid = menuBtn.getAttribute('data-ag-recent-menu');
          const item = recentItemsById.get(cid);
          const r = menuBtn.getBoundingClientRect();
          openRecentRowMenu(item, r.right + 4, r.bottom + 4);
          return;
        }
        if (ev.target && ev.target.closest && ev.target.closest('[data-ag-recent-rename-input]')) {
          ev.stopPropagation();
          return;
        }
        const row = ev.target && ev.target.closest && ev.target.closest('[data-ag-recent-id]');
        if (row) {
          const cid = row.getAttribute('data-ag-recent-id');
          if (recentRenamingId && recentRenamingId === cid) return;
          closeRecentRowMenu();
          const curBindings = findSidebarBindings() || bindings;
          navigateSidebarConversation(cid, curBindings);
          scheduleSidebarSync();
        }
      });
      sec.addEventListener('contextmenu', (ev) => {
        if (sec.getAttribute('data-mode') !== 'unified') return;
        const row = ev.target && ev.target.closest && ev.target.closest('[data-ag-recent-id]');
        if (!row) return;
        const cid = row.getAttribute('data-ag-recent-id');
        if (recentRenamingId && recentRenamingId === cid) return;
        const item = recentItemsById.get(cid);
        if (!item) return;
        ev.preventDefault();
        ev.stopPropagation();
        openRecentRowMenu(item, ev.clientX + 2, ev.clientY + 2);
      });
      sec.addEventListener('keydown', (ev) => {
        const input = ev.target && ev.target.closest && ev.target.closest('[data-ag-recent-rename-input]');
        if (input) {
          if (ev.key === 'Enter') {
            ev.preventDefault();
            ev.stopPropagation();
            commitRecentInlineRename(input, true);
          } else if (ev.key === 'Escape') {
            ev.preventDefault();
            ev.stopPropagation();
            commitRecentInlineRename(input, false);
          }
          return;
        }
        const row = ev.target && ev.target.closest && ev.target.closest('[data-ag-recent-id]');
        if (row && (ev.key === 'Enter' || ev.key === ' ')) {
          ev.preventDefault();
          const cid = row.getAttribute('data-ag-recent-id');
          navigateSidebarConversation(cid, findSidebarBindings() || bindings);
          scheduleSidebarSync();
        }
      });
      sec.addEventListener(
        'blur',
        (ev) => {
          const input = ev.target && ev.target.closest && ev.target.closest('[data-ag-recent-rename-input]');
          if (input) commitRecentInlineRename(input, true);
        },
        true
      );
      sbGrand.insertBefore(sec, desiredRef);
      recentLastSig = '';
    } else if (wrongPosition) {
      sbGrand.insertBefore(sec, desiredRef);
      recentLastSig = '';
    }

    if (sec.getAttribute('data-mode') !== mode) {
      sec.setAttribute('data-mode', mode);
      recentLastSig = '';
    }

    if (recentRenamingId && sec.querySelector('[data-ag-recent-rename-input]')) {
      return;
    }

    const isCollapsed = isUnified ? unifiedRecentCollapsed : recentCollapsed;
    const sig = `${mode}|${FEAT.i18n ? 1 : 0}|${isCollapsed ? 1 : 0}|${isUnified ? recentPageLimit : recentExpanded ? 1 : 0}|${recentRenamingId}|${activeId}|${nowBucket}|${total}|${items
      .map((it) => `${it.id}:${it.title}:${it.project}:${it.status ? `${it.status.kind}-${it.status.subkind}` : 'idle'}:${Math.floor(it.updatedAt / 60)}`)
      .join(';')}`;
    if (sig === recentLastSig) return;
    recentLastSig = sig;
    sec.setAttribute('aria-label', L('最近对话', 'Recents'));

    const headerHtml = isUnified
      ? `<div class="ag-recent-hdr-bar"><button type="button" class="ag-recent-hdr" data-ag-recent-toggle aria-expanded="${!isCollapsed}"><span>${L('最近对话', 'Recents')}</span><span class="ag-recent-chevron">▾</span></button><button type="button" class="ag-recent-new-btn" data-ag-recent-new title="${escapeHtml(L('新建对话', 'New conversation'))}" aria-label="${escapeHtml(L('新建对话', 'New conversation'))}">${RECENT_PLUS_SVG}</button></div>`
      : `<button type="button" class="ag-recent-hdr" data-ag-recent-toggle aria-expanded="${!isCollapsed}"><span>${L('最近对话', 'Recents')}</span><span class="ag-recent-chevron">▾</span></button>`;

    const moreHtml = isUnified
      ? total > items.length
        ? `<button type="button" class="ag-recent-more" data-ag-recent-more>${escapeHtml(
            FEAT.i18n ? `显示更多（还有 ${total - items.length} 条）` : `Show more (${total - items.length} left)`
          )}</button>`
        : ''
      : total > 4
        ? `<button type="button" class="ag-recent-more" data-ag-recent-more>${recentExpanded ? L('收起', 'Show less') : L('展开更多', 'Show more')}</button>`
        : '';

    const rowsHtml = isCollapsed
      ? ''
      : items.length
        ? `<div class="ag-recent-list">${items
            .map((it) => {
              const isAct = it.id === activeId;
              const isRenaming = isUnified && recentRenamingId === it.id;
              const age = formatRelativeAge(it.updatedAt, nowSec);
              let sideHtml = `<span>${escapeHtml(age)}</span>`;
              if (it.status && it.status.kind === 'pending') {
                sideHtml = `<span class="ag-claude-folder-badge" data-kind="pending">${pendingGlyphSvg(it.status.subkind)}</span>`;
              } else if (it.status && it.status.kind === 'running') {
                sideHtml = '<span class="ag-folder-orbit"></span>';
              } else if (it.status && it.status.kind === 'unread') {
                sideHtml = `<span class="ag-claude-unread-dot"></span>${age ? `<span>${escapeHtml(age)}</span>` : ''}`;
              }
              const tip = it.project ? `${it.title}\n${L('所属项目：', 'Project: ')}${it.project}` : it.title;
              const actionsHtml =
                isUnified && !isRenaming
                  ? `<div class="ag-recent-actions"><button type="button" class="ag-recent-act-btn" data-ag-recent-pin="${escapeHtml(it.id)}" title="${escapeHtml(L('置顶对话', 'Pin'))}" aria-label="${escapeHtml(L('置顶对话', 'Pin'))}">${RECENT_PIN_SVG}</button><button type="button" class="ag-recent-act-btn" data-ag-recent-menu="${escapeHtml(it.id)}" title="${escapeHtml(L('更多选项', 'More options'))}" aria-label="${escapeHtml(L('更多选项', 'More options'))}">${RECENT_MORE_SVG}</button></div>`
                  : '';
              const mainInner = isRenaming
                ? `<input type="text" class="ag-recent-rename-input" data-ag-recent-rename-input="${escapeHtml(it.id)}" data-orig-title="${escapeHtml(it.title)}" value="${escapeHtml(it.title)}" />`
                : `<div class="ag-recent-title">${escapeHtml(it.title)}</div>`;
              return `<div class="ag-recent-row" role="button" tabindex="0" data-ag-recent-id="${escapeHtml(it.id)}" data-active="${isAct ? 'true' : 'false'}"${it.project ? ` data-has-project="true"` : ''}${isRenaming ? ' data-renaming="true"' : ''} title="${escapeHtml(tip)}"><div class="ag-recent-main">${mainInner}</div>${isRenaming ? '' : `<div class="ag-recent-side">${sideHtml}</div>${actionsHtml}`}</div>`;
            })
            .join('')}</div>` + moreHtml
        : `<div class="ag-recent-empty">${escapeHtml(L('暂无最近对话', 'No recent conversations'))}</div>`;

    sec.innerHTML = `${headerHtml}${rowsHtml}`;
  }

  function scheduleSidebarSync() {
    if (disposed || sidebarSyncTimer) return;
    sidebarSyncTimer = later(() => {
      sidebarSyncTimer = 0;
      syncSidebarEnhancements();
    }, 90);
  }

  function syncSidebarEnhancements() {
    if (disposed) return;
    restoreLegacySidebarCjkNodes();
    const unifiedRecentsOn = Boolean(FEAT.hideSidebarProjects);
    if (!FEAT.folderStatus && !FEAT.recentSection && !unifiedRecentsOn) {
      if (sidebarStoreUnsub) {
        sidebarStoreUnsub();
        sidebarStoreUnsub = null;
        sidebarStoreRef = null;
      }
      clearAllFolderBadges();
      removeRecentSection();
      return;
    }
    const bindings = findSidebarBindings();
    if (!bindings) return;
    if (sidebarStoreRef !== bindings.store) {
      if (sidebarStoreUnsub) sidebarStoreUnsub();
      sidebarStoreRef = bindings.store;
      if (typeof bindings.store.subscribe === 'function') {
        sidebarStoreUnsub = bindings.store.subscribe(() => {
          scheduleSidebarSync();
          if (FEAT.hideSidebarProjects) syncSidebarHideNativeProjects();
        });
      } else {
        sidebarStoreUnsub = null;
      }
    }
    const state = bindings.store.getState();
    const activeId = getActiveCascadeId();
    const hasFocus = typeof document.hasFocus === 'function' ? document.hasFocus() : true;
    syncFolderStatusBadges(bindings, state, activeId, hasFocus);
    syncRecentSection(bindings, state, activeId, hasFocus);
  }

  const onWindowSidebarEvent = () => scheduleSidebarSync();
  window.addEventListener('focus', onWindowSidebarEvent);
  window.addEventListener('blur', onWindowSidebarEvent);
  window.addEventListener('popstate', onWindowSidebarEvent);

  /* ==========================================================================
   * 8b. Live Zero-Reload UI Localization Engine (`i18n`, off / English by default)
   *     - Reuses upstream `ctx.dict` / `window.__ag_i18n_dict` and `window.__ag_orig_text_map`
   *     - Toggling `i18n` in Settings immediately translates or restores all native Antigravity
   *       text nodes & title/placeholder/aria-label attributes with zero page reload.
   * ========================================================================== */
  const UX_I18N_BASE_EXCLUDE =
    'code, pre, kbd, samp, textarea, input, style, script, noscript, [contenteditable="true"], [data-markdown-root], [data-testid="user-message-content"], .agy-user-bubble, .monaco-editor, .monaco-diff-editor, .xterm, [class*="onyx-key"], .prose, .markdown, [class*="chat-message"], [class*="group/file-title"], [data-testid="conversation-row-sidebar"] a[href^="/c/"], [data-testid="conversation-row-sidebar"] span.truncate, [data-testid="conversation-navigator-turn"], .msg-body, #raw, [data-testid="swarm-raw"], #swarm-title, #ag-live-metrics-pill, #ag-live-metrics-tooltip, [data-ag-i18n-ignore="1"], #ag-claude-model-popover, #ag-claude-model-subpop, #ag-claude-quota-popover, #ag-claude-ux-settings-nav, #ag-claude-ux-settings-panel, #ag-claude-recent-section, #ag-recent-row-menu, #ag-project-action-menu, [data-testid="model-selector-trigger"], [data-testid="model-selector-menu"], [data-testid="permissions-selector-trigger"]';
  const UX_I18N_ATTR_EXCLUDE =
    'code, pre, kbd, samp, style, script, noscript, [data-markdown-root], [data-testid="user-message-content"], .agy-user-bubble, .monaco-editor, .monaco-diff-editor, .xterm, #ag-live-metrics-pill, #ag-live-metrics-tooltip, [data-ag-i18n-ignore="1"], #ag-claude-model-popover, #ag-claude-model-subpop, #ag-claude-quota-popover, #ag-claude-ux-settings-nav, #ag-claude-ux-settings-panel, #ag-claude-recent-section, #ag-recent-row-menu, #ag-project-action-menu, [data-testid="model-selector-trigger"], [data-testid="permissions-selector-trigger"]';
  let uxI18nObserver = null;
  let uxI18nFlushTimer = 0;
  let uxI18nDirtyRoots = new Set();
  let uxI18nDictRef = null;
  let uxI18nDictCi = null;

  function getUxI18nExcludeSelector() {
    const extra =
      typeof ctx !== 'undefined' && ctx && ctx.config && ctx.config.selectors && ctx.config.selectors.excludeI18n
        ? String(ctx.config.selectors.excludeI18n).trim()
        : '';
    return extra ? `${UX_I18N_BASE_EXCLUDE}, ${extra}` : UX_I18N_BASE_EXCLUDE;
  }

  function getUxI18nDict() {
    const d =
      (typeof ctx !== 'undefined' && ctx && ctx.dict && typeof ctx.dict === 'object' ? ctx.dict : null) ||
      (window.__ag_i18n_dict && typeof window.__ag_i18n_dict === 'object' ? window.__ag_i18n_dict : null);
    if (!d) return null;
    if (d !== uxI18nDictRef) {
      uxI18nDictRef = d;
      uxI18nDictCi = Object.create(null);
      for (const k of Object.keys(d)) {
        const v = d[k];
        if (typeof v === 'string') uxI18nDictCi[k.toLowerCase()] = v;
      }
    }
    return d;
  }

  function getOrigTextMap() {
    if (!window.__ag_orig_text_map) {
      window.__ag_orig_text_map = new WeakMap();
    }
    return window.__ag_orig_text_map;
  }

  const UX_RE_EPHEMERAL_SUMMARY =
    /^(Explored(?:\s+(?:\d+\s+)?(?:files?|artifacts?)(?:\s+and\s+(?:\d+\s+)?(?:files?|artifacts?))?)?|Ran\s+(?:\d+\s+)?commands?|Edited(?:\s+(?:\d+\s+)?(?:files?|artifacts?)(?:\s+and\s+(?:\d+\s+)?(?:files?|artifacts?))?)?)(?:,\s*(explored(?:\s+(?:\d+\s+)?(?:files?|artifacts?)(?:\s+and\s+(?:\d+\s+)?(?:files?|artifacts?))?)?|ran\s+(?:\d+\s+)?commands?|edited(?:\s+(?:\d+\s+)?(?:files?|artifacts?)(?:\s+and\s+(?:\d+\s+)?(?:files?|artifacts?))?)?))*$/i;
  const UX_EPHEMERAL_CLAUSE_MAP = {
    explored: '已探索',
    'explored file': '已探索文件',
    'explored files': '已探索文件',
    'explored artifact': '已探索 Artifact',
    'explored artifacts': '已探索 Artifact',
    'explored file and artifact': '已探索文件与 Artifact',
    'explored files and artifact': '已探索文件与 Artifact',
    'explored file and artifacts': '已探索文件与 Artifact',
    'explored files and artifacts': '已探索文件与 Artifact',
    'ran command': '已运行命令',
    'ran commands': '已运行命令',
    edited: '已编辑',
    'edited file': '已编辑文件',
    'edited files': '已编辑文件',
    'edited artifact': '已编辑 Artifact',
    'edited artifacts': '已编辑 Artifact',
    'edited file and artifact': '已编辑文件与 Artifact',
    'edited files and artifact': '已编辑文件与 Artifact',
    'edited file and artifacts': '已编辑文件与 Artifact',
    'edited files and artifacts': '已编辑文件与 Artifact'
  };
  const UX_RE_EPHEMERAL_COUNT = /^(explored|edited|ran)\s+(\d+)\s+(files?|artifacts?|commands?)$/i;
  const UX_RE_EPHEMERAL_ACTIVE = /^(Editing|Reading|Listing|Searching)\s+(.+)$/;
  const UX_EPHEMERAL_VERB_MAP = { Editing: '正在编辑', Reading: '正在读取', Listing: '正在列出', Searching: '正在搜索' };
  const UX_EPHEMERAL_NOUN_MAP = {
    file: '文件',
    files: '文件',
    artifact: 'Artifact',
    artifacts: 'Artifact',
    'file and artifact': '文件与 Artifact',
    'files and artifact': '文件与 Artifact',
    'file and artifacts': '文件与 Artifact',
    'files and artifacts': '文件与 Artifact'
  };
  const UX_RE_RUNNING_FOR = /^Running\s+for\s+([<0-9smhd]+(?:\s+\d+[smhd])*)$/i;
  const UX_RE_RUNNING_CMD = /^Running\s+(?!commands?\b|processes\b|for\b|\(Dev\b)(.+)$/;

  function translateUxEphemeralClause(clause) {
    const low = clause.trim().toLowerCase();
    if (UX_EPHEMERAL_CLAUSE_MAP[low]) return UX_EPHEMERAL_CLAUSE_MAP[low];
    const mCount = low.match(UX_RE_EPHEMERAL_COUNT);
    if (mCount) {
      const vMap = { explored: '已探索', edited: '已编辑', ran: '已运行' };
      const nMap = { file: '个文件', files: '个文件', artifact: '个 Artifact', artifacts: '个 Artifact', command: '条命令', commands: '条命令' };
      return `${vMap[mCount[1]]} ${mCount[2]} ${nMap[mCount[3]]}`;
    }
    return clause.trim();
  }

  function uxI18nLookup(trimmed, contextEl) {
    const dict = getUxI18nDict();
    if (!dict || !trimmed) return null;
    if (typeof dict[trimmed] === 'string') return dict[trimmed];
    if (uxI18nDictCi && typeof uxI18nDictCi[trimmed.toLowerCase()] === 'string') {
      return uxI18nDictCi[trimmed.toLowerCase()];
    }
    if (trimmed.endsWith('.')) {
      const base = trimmed.slice(0, -1);
      const hit =
        (typeof dict[base] === 'string' && dict[base]) ||
        (uxI18nDictCi && typeof uxI18nDictCi[base.toLowerCase()] === 'string' && uxI18nDictCi[base.toLowerCase()]);
      if (hit) return hit.endsWith('。') ? hit : `${hit}。`;
    }
    /* High-frequency dynamic Antigravity UI strings when runtime.js i18n is disabled */
    if (!/[A-Za-z]/.test(trimmed) || trimmed.length > 140) return null;
    let m;
    if (UX_RE_EPHEMERAL_SUMMARY.test(trimmed)) {
      return trimmed.split(/,\s*/).map((part) => translateUxEphemeralClause(part)).join('、');
    }
    const inHdr = Boolean(contextEl && contextEl.closest && contextEl.closest('header, [data-testid="breadcrumb-segment"]'));
    if (!inHdr && (m = trimmed.match(UX_RE_EPHEMERAL_ACTIVE))) {
      const noun = UX_EPHEMERAL_NOUN_MAP[m[2].toLowerCase()];
      const verbZh = UX_EPHEMERAL_VERB_MAP[m[1]];
      return noun ? (/^[A-Za-z0-9]/.test(noun) ? `${verbZh} ${noun}` : `${verbZh}${noun}`) : `${verbZh} ${m[2]}`;
    }
    if ((m = trimmed.match(UX_RE_RUNNING_FOR))) return `已运行 ${m[1]}`;
    if (!inHdr && (m = trimmed.match(UX_RE_RUNNING_CMD))) return `正在运行 ${m[1]}`;
    if ((m = trimmed.match(/^(\d+)\s+files?\s+changed$/i))) return `${m[1]} 个文件变更`;
    if ((m = trimmed.match(/^(\d+)\s+tools?$/i))) return `${m[1]} 个工具`;
    if ((m = trimmed.match(/^(\d+)\s+updates?$/i))) return `${m[1]} 条进展`;
    if ((m = trimmed.match(/^Worked\s+for\s+(.+)$/i))) return `已工作 ${m[1]}`;
    if ((m = trimmed.match(/^Working\s+for\s+(.+)$/i))) return `正在工作 ${m[1]}`;
    if ((m = trimmed.match(/^Thought\s+for\s+(.+)$/i))) return `已思考 ${m[1]}`;
    if ((m = trimmed.match(/^Thinking\s+for\s+(.+)$/i))) return `正在思考 ${m[1]}`;
    if ((m = trimmed.match(/^(\d+)\s+(seconds?|minutes?|hours?|days?)\s+ago$/i))) {
      const unitMap = { second: '秒', seconds: '秒', minute: '分钟', minutes: '分钟', hour: '小时', hours: '小时', day: '天', days: '天' };
      return `${m[1]} ${unitMap[m[2].toLowerCase()] || m[2]}前`;
    }
    if ((m = trimmed.match(/^(\d+(?:\.\d+)?)%\s+left$/i))) return `${m[1]}% 剩余`;
    return null;
  }

  function uxRestoreAllTranslations(root) {
    const scope = root || document.body;
    if (!scope) return;
    const origMap = getOrigTextMap();
    try {
      const walker = document.createTreeWalker(scope, NodeFilter.SHOW_TEXT);
      let node;
      while ((node = walker.nextNode())) {
        const rec = origMap.get(node);
        if (rec) {
          if (node.nodeValue === rec.lastVal) {
            node.nodeValue = rec.origRaw;
          }
          origMap.delete(node);
        }
      }
      const attrNames = ['title', 'placeholder', 'aria-label'];
      const els = scope.querySelectorAll
        ? scope.querySelectorAll(
            '[data-ag-orig-title], [data-ag-orig-title-last], [data-ag-orig-placeholder], [data-ag-orig-placeholder-last], [data-ag-orig-aria-label], [data-ag-orig-aria-label-last]'
          )
        : [];
      for (const el of els) {
        for (const attr of attrNames) {
          const origAttr = `data-ag-orig-${attr}`;
          const lastAttr = `${origAttr}-last`;
          if (el.hasAttribute(origAttr) || el.hasAttribute(lastAttr)) {
            const savedOrig = el.getAttribute(origAttr);
            const savedLast = el.getAttribute(lastAttr);
            const cur = el.getAttribute(attr);
            if (savedOrig !== null && (savedLast === null || cur === savedLast)) {
              el.setAttribute(attr, savedOrig);
            }
            el.removeAttribute(origAttr);
            el.removeAttribute(lastAttr);
          }
        }
      }
    } catch {}
  }

  function uxTranslateSubtree(root) {
    if (!root || !FEAT.i18n || disposed) return;
    if (!getUxI18nDict()) return;
    const exclSel = getUxI18nExcludeSelector();
    const origMap = getOrigTextMap();
    const isExcluded = (el) => {
      if (!el || el.nodeType !== 1) return true;
      try {
        return Boolean(el.closest(exclSel));
      } catch {
        return Boolean(el.closest(UX_I18N_BASE_EXCLUDE));
      }
    };
    try {
      const translateText = (node) => {
        if (!node || node.nodeType !== 3) return;
        const p = node.parentElement;
        if (!p || isExcluded(p)) return;
        const cur = node.nodeValue;
        if (!cur) return;
        const rec = origMap.get(node);
        if (rec && rec.lastVal === cur) return;
        const origRaw = rec && rec.lastVal === cur ? rec.origRaw : cur;
        const trimmed = origRaw.trim();
        if (!trimmed) return;
        const hit = uxI18nLookup(trimmed, p);
        if (typeof hit === 'string' && hit !== trimmed) {
          const next = origRaw.replace(trimmed, () => hit);
          origMap.set(node, { origRaw, lastVal: next, ver: 'ux' });
          if (node.nodeValue !== next) node.nodeValue = next;
        }
      };

      if (root.nodeType === 3) {
        translateText(root);
        return;
      }
      if (root.nodeType === 1 && isExcluded(root)) return;
      const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
      let node;
      while ((node = walker.nextNode())) translateText(node);

      const attrTargets = [];
      if (root.nodeType === 1 && root.matches && root.matches('[title], [placeholder], [aria-label]')) {
        attrTargets.push(root);
      }
      if (root.querySelectorAll) {
        root.querySelectorAll('[title], [placeholder], [aria-label]').forEach((el) => attrTargets.push(el));
      }
      for (const el of attrTargets) {
        try {
          if (el.closest(UX_I18N_ATTR_EXCLUDE)) continue;
        } catch {}
        for (const attr of ['title', 'placeholder', 'aria-label']) {
          const cur = el.getAttribute(attr);
          if (!cur) continue;
          const origAttr = `data-ag-orig-${attr}`;
          const lastAttr = `${origAttr}-last`;
          const savedOrig = el.getAttribute(origAttr);
          const savedLast = el.getAttribute(lastAttr);
          if (savedOrig !== null && savedLast === cur) continue;
          const origVal = savedOrig !== null && savedLast === cur ? savedOrig : cur;
          const hit = uxI18nLookup(origVal.trim(), el);
          if (typeof hit === 'string' && hit !== origVal.trim()) {
            const nextVal = origVal.replace(origVal.trim(), () => hit);
            if (savedOrig !== origVal) el.setAttribute(origAttr, origVal);
            el.setAttribute(lastAttr, nextVal);
            if (cur !== nextVal) el.setAttribute(attr, nextVal);
          }
        }
      }
    } catch {}
  }

  function stopUxI18nObserver() {
    if (uxI18nObserver) {
      try {
        uxI18nObserver.disconnect();
      } catch {}
      uxI18nObserver = null;
    }
    if (uxI18nFlushTimer) {
      cancelLater(uxI18nFlushTimer);
      uxI18nFlushTimer = 0;
    }
    uxI18nDirtyRoots.clear();
  }

  function applyUiI18nState(enabled) {
    if (docRoot) {
      docRoot.setAttribute('data-ag-ux-lang', enabled ? 'zh' : 'en');
    }
    if (!enabled) {
      stopUxI18nObserver();
      if (window.__ag_i18n_observer) {
        try {
          window.__ag_i18n_observer.disconnect();
        } catch {}
        window.__ag_i18n_observer = null;
      }
      if (document.body) uxRestoreAllTranslations(document.body);
      return;
    }
    if (document.body) {
      uxTranslateSubtree(document.body);
      if (!uxI18nObserver && typeof MutationObserver !== 'undefined') {
        uxI18nObserver = new MutationObserver((mutations) => {
          if (disposed || !FEAT.i18n) return;
          const roots = new Set();
          for (const m of mutations) {
            if (m.type === 'characterData' && m.target) {
              roots.add(m.target);
            } else if (m.type === 'childList') {
              for (const n of m.addedNodes) {
                if (n.nodeType === 1 || n.nodeType === 3) roots.add(n);
              }
            } else if (m.type === 'attributes' && m.target && m.target.nodeType === 1) {
              roots.add(m.target);
            }
          }
          if (!roots.size) return;
          for (const r of roots) {
            if (!r || !r.isConnected) continue;
            let covered = false;
            let p = r.parentElement;
            while (p && p !== document.body) {
              if (roots.has(p)) {
                covered = true;
                break;
              }
              p = p.parentElement;
            }
            if (!covered) uxTranslateSubtree(r);
          }
          if (uxI18nObserver) uxI18nObserver.takeRecords();
        });
        uxI18nObserver.observe(document.body, {
          childList: true,
          subtree: true,
          characterData: true,
          attributes: true,
          attributeFilter: ['title', 'placeholder', 'aria-label']
        });
      }
    }
  }

  /* ==========================================================================
   * 9. Native Settings -> `UI Enhancements` / `界面增强` Live Module Toggle Panel
   *    - Injects `settings-nav-item-ClaudeUX` right after `Appearance` (`外观`)
   *      inside `[data-testid="settings-sidebar"]`.
   *    - Toggles persist to `localStorage` and take effect in 0ms without reload.
   * ========================================================================== */
  const CJK_SCALE_OPTIONS = [
    ['94.5', '94.5%'],
    ['95', '95%'],
    ['100', '100%']
  ];

  const SETTINGS_GROUPS = [
    {
      id: 'lang-typo',
      headingZh: '语言与排印',
      headingEn: 'Language & Typography',
      items: [
        [
          'i18n',
          'i18n',
          '中文界面汉化',
          'Chinese UI Localization',
          '将 Antigravity 原生界面与增强面板切换为简体中文（默认关闭，保持英文原版界面）',
          'Translate Antigravity UI and enhancement panels into Simplified Chinese (English by default)'
        ]
      ]
    },
    {
      headingZh: '对话与过程流增强',
      headingEn: 'Conversation & Stream',
      items: [
        [
          'claudeUxModelMenu',
          'modelMenu',
          '分层模型选择器 (⌘/)',
          'Layered Model Picker (⌘/)',
          '精简主列表为 5 款主力模型，独立拆分思考强度与更多模型二级菜单',
          'Compact 5-model primary list with dedicated Thinking effort & More models flyouts'
        ],
        [
          'claudeUxContextRing',
          'contextRing',
          '上下文圆环与套餐限额浮层 (◎)',
          'Context Ring & Plan Usage Popover (◎)',
          '模型旁显示占用圆环，点击查看 5 小时 / 每周真实限额与一键压缩',
          'Shows context ring beside the model selector with live 5-hour / weekly quotas and one-click Compact'
        ],
        [
          'claudeUxTodoCard',
          'todoCard',
          '流内 TodoWrite 实时进度卡片',
          'Inline TodoWrite Progress Card',
          '将多阶段任务清单渲染为圆角白卡，兼容虚拟滚动与知识工作模式',
          'Renders multi-step checklists as reactive rounded cards across virtualized turns'
        ],
        [
          'claudeUxStepUnfold',
          'stepUnfold',
          '自动展开回合步骤折叠',
          'Auto-Expand Turn Steps',
          '回合结束时保持中间进展与工具摘要平铺可见，不被外层折叠吞没',
          'Keeps mid-turn narration and tool summaries inline instead of collapsing them at turn end'
        ],
        [
          'claudeUxRunningTimer',
          'runningTimer',
          '运行中官方蓝旋转点与实时读秒',
          'Live Running Dots & Elapsed Timer',
          '在正在执行的工具步骤行挂载官方蓝双点旋转与 1s / 2s 读秒器',
          'Shows orbiting blue dots and live elapsed seconds on actively executing tool rows'
        ],
        [
          'claudeUxCollapseAnimation',
          'collapseAnim',
          '工具面板平滑收起动画',
          'Smooth Tool Panel Collapse',
          '收拢工具详情面板时补齐 190ms 丝滑过渡动画',
          'Adds a 190ms smooth collapse transition when closing tool detail panels'
        ]
      ]
    },
    {
      headingZh: '侧边栏与消息编辑增强',
      headingEn: 'Sidebar & Editing',
      items: [
        [
          'claudeUxInlineUndo',
          'inlineUndo',
          '原地撤回重编消息',
          'In-Bubble Undo & Edit',
          '点击撤回时在原气泡直接展开编辑框，支持变更文件还原预览与原附件保留',
          'Expands an inline editor inside the user bubble with file-revert preview and attachment preservation'
        ],
        [
          'claudeUxFolderStatus',
          'folderStatus',
          '折叠项目状态聚合角标',
          'Collapsed Project Status Badges',
          '项目文件夹折叠时在右侧安静汇总待审批、运行中与已完成未读状态',
          'Summarizes pending, running, and unread sessions beside collapsed project folders'
        ],
        [
          'claudeUxProjects',
          'projects',
          '项目工作区与本地上下文',
          'Projects Workspace & Local Context',
          '在「自动化任务」与「技能与自定义」之间加入 Claude 风格项目入口，纯本地管理指令（AGENTS.md）、参考文件与定时任务',
          'Adds a Claude-style Projects nav entry between Automations and Skills to manage local AGENTS.md, context files & scheduled tasks'
        ],
        [
          'claudeUxHideSidebarProjects',
          'hideSidebarProjects',
          '侧栏统一「最近对话」',
          'Unified Sidebar Recents',
          '隐藏原生「项目」与「对话」分组，保留置顶对话并在下方用全量混排的「最近对话」统一展示全部项目与普通对话（关闭即恢复原生分组）',
          'Replaces native Projects & standalone Conversations with a single Claude-style Recents list mixing all project and standalone chats'
        ],
        [
          'claudeUxCustomizations',
          'customizations',
          '技能与自定义页优化及导入',
          'Customizations Layout & Skill Importer',
          '为「技能与自定义」页增加分类标签切换、防卡片硬切底线、技能卡片化排版以及「+ 添加技能 / 打开技能目录」快捷入口',
          'Adds category tabs, sticky header divider, framed skill cards, and local + Add Skill / Open Folder actions to Customizations'
        ]
      ]
    }
  ];

  let settingsSidebarRef = null;
  let settingsRightRef = null;
  let settingsNavWrap = null;
  let settingsNavBtn = null;
  let settingsPanelEl = null;
  let settingsToastTimer = 0;
  let settingsStatsOpen = false;
  let settingsStatsProjOpen = false;
  let settingsStatsUnlinkedOpen = false;
  let settingsStatsBtnWrap = null;

  function renderSettingsPanelContent(panel) {
    if (!panel) return;
    panel.setAttribute('aria-label', L('界面增强设置', 'UI Enhancements Settings'));
    panel.innerHTML = `
      <div class="ag-cux-settings-wrap">
        <div style="display:flex;align-items:flex-start;justify-content:space-between;gap:12px">
          <div>
            <h2 class="text-2xl m-0" style="color:var(--foreground)">${L('界面增强', 'UI Enhancements')}</h2>
            <div class="ag-cux-settings-desc" style="margin-top:4px">${L(
              '管理 Anti-Claude 语言、视觉、过程流与侧边栏效率模块，点击开关即时生效并跨重启自动记忆。',
              'Configure Anti-Claude language, layout, execution stream, and sidebar modules. Changes apply immediately and persist across restarts.'
            )}</div>
          </div>
          <span class="ag-cux-toast" data-ag-cux-toast data-visible="false">${L('✓ 已保存并即时生效', '✓ Saved and applied')}</span>
        </div>
        ${SETTINGS_GROUPS.map(
          (grp) => `
          <div style="display:flex;flex-direction:column;gap:8px">
            <h3 class="m-0">${escapeHtml(L(grp.headingZh, grp.headingEn))}</h3>
            <div class="ag-cux-settings-group">
              ${grp.items
                .map(
                  ([modKey, featKey, titleZh, titleEn, descZh, descEn]) => `
                <div class="ag-cux-settings-row">
                  <div style="min-width:0">
                    <div class="ag-cux-settings-title">${escapeHtml(L(titleZh, titleEn))}</div>
                    <div class="ag-cux-settings-desc">${escapeHtml(L(descZh, descEn))}</div>
                  </div>
                  <button type="button" class="ag-claude-switch" role="switch" data-ag-cux-switch="${modKey}" data-ag-cux-feat="${featKey}" aria-label="${escapeHtml(L(titleZh, titleEn))}" aria-checked="${Boolean(FEAT[featKey])}"><span></span></button>
                </div>`
                )
                .join('')}
              ${
                grp.id === 'lang-typo'
                  ? `
                <div class="ag-cux-settings-row">
                  <div style="min-width:0">
                    <div class="ag-cux-settings-title">${escapeHtml(L('中文字体字高校准', 'CJK Optical Font Scale'))}</div>
                    <div class="ag-cux-settings-desc">${escapeHtml(
                      L(
                        '调整苹方汉字与西文的视觉字高比例：94.5%（Apple 官网排印）、95%（均衡默认）、100%（系统原生字高）',
                        'Calibrate CJK glyph height relative to Latin text: 94.5% (Apple typography), 95% (balanced default), or 100% (native)'
                      )
                    )}</div>
                  </div>
                  <div class="ag-cux-seg-group" role="radiogroup" aria-label="${escapeHtml(
                    L('中文字体字高校准', 'CJK Optical Font Scale')
                  )}">
                    ${CJK_SCALE_OPTIONS.map(
                      ([val, label]) =>
                        `<button type="button" class="ag-cux-seg-btn" role="radio" data-ag-cux-cjk-scale="${val}" aria-checked="${
                          currentCjkScale === val
                        }">${label}</button>`
                    ).join('')}
                  </div>
                </div>`
                  : ''
              }
            </div>
          </div>`
        ).join('')}
      </div>
    `;
    panel.querySelectorAll('[data-ag-cux-switch]').forEach((sw) => {
      sw.addEventListener('click', () => {
        const modKey = sw.getAttribute('data-ag-cux-switch');
        const featKey = sw.getAttribute('data-ag-cux-feat');
        setModuleOverride(modKey, featKey, !FEAT[featKey]);
      });
    });
    panel.querySelectorAll('[data-ag-cux-cjk-scale]').forEach((btn) => {
      btn.addEventListener('click', () => {
        setCjkScaleOverride(btn.getAttribute('data-ag-cux-cjk-scale'));
      });
    });
  }

  function applyImmediateFeatureEffects(featKey, on) {
    if (featKey === 'i18n') {
      applyUiI18nState(on);
      if (settingsNavBtn) {
        settingsNavBtn.innerHTML = `<span class="truncate">${L('界面增强', 'UI Enhancements')}</span>`;
      }
      if (settingsPanelEl && !settingsPanelEl.hidden) {
        renderSettingsPanelContent(settingsPanelEl);
      }
      syncSettingsStatsGroup();
      if (modelPopoverOpen) renderModelPopovers();
      if (quotaPopoverOpen) renderQuotaPopoverBody();
      updateComposerRingVisuals();
      if (typeof window.__ag_render_metrics === 'function' && window.__ag_last_metrics) {
        try {
          window.__ag_render_metrics(window.__ag_last_metrics);
        } catch {}
      }
      recentLastSig = '';
      if (activeInlineEdit) renderInlineEditMeta(activeInlineEdit);
      refreshProjectsLanguageUi();
      syncCustomizationsEnhancement();
    } else if (featKey === 'projects') {
      if (!on) teardownProjectsWorkspace();
      else syncProjectsWorkspace();
    } else if (featKey === 'hideSidebarProjects') {
      syncSidebarHideNativeProjects();
    } else if (featKey === 'customizations') {
      if (!on) teardownCustomizationsEnhancement();
      else syncCustomizationsEnhancement();
    } else if (featKey === 'modelMenu' && !on) {
      closeClaudeModelPopover();
    } else if (featKey === 'contextRing') {
      if (!on) {
        const ring = document.getElementById('ag-claude-ctx-ring');
        if (ring) ring.remove();
        closeQuotaPopover();
        const tt = document.getElementById('ag-live-metrics-tooltip');
        if (tt) tt.removeAttribute('data-ag-pinned');
      }
      if (typeof window.__ag_render_metrics === 'function' && window.__ag_last_metrics) {
        try {
          window.__ag_render_metrics(window.__ag_last_metrics);
        } catch {}
      }
    } else if (featKey === 'todoCard' && !on) {
      document.querySelectorAll('[data-ag-todo-dock]').forEach((d) => d.remove());
      document.querySelectorAll('ul[data-ag-todo-primary], ul[data-ag-todo-merged]').forEach((u) => restoreNativeUl(u));
    } else if (featKey === 'runningTimer' && !on) {
      document.querySelectorAll('.ag-orbit-dots, .ag-elapsed-timer').forEach((n) => n.remove());
    } else if (featKey === 'inlineUndo' && !on) {
      closeInlineEdit(false);
    }
    syncSidebarEnhancements();
    scheduleSync();
  }

  function flashSettingsSavedToast() {
    if (!settingsPanelEl) return;
    const toast = settingsPanelEl.querySelector('[data-ag-cux-toast]');
    if (!toast) return;
    toast.setAttribute('data-visible', 'true');
    cancelLater(settingsToastTimer);
    settingsToastTimer = later(() => {
      toast.setAttribute('data-visible', 'false');
    }, 1400);
  }

  let prefsSyncRetryTimer = 0;
  function persistUiPrefsToDaemon(explicitTs = 0) {
    const updatedAt = explicitTs > 0 ? explicitTs : Date.now();
    localModOverrides._ts = updatedAt;
    try {
      if (typeof localStorage === 'object' && localStorage) {
        localStorage.setItem(MODULE_STORAGE_KEY, JSON.stringify(localModOverrides));
      }
    } catch {}
    if (typeof window.__agProjectCall !== 'function') return;
    const modulesPayload = {};
    for (const grp of SETTINGS_GROUPS) {
      for (const [modKey, featKey] of grp.items) {
        modulesPayload[modKey] = Boolean(FEAT[featKey]);
      }
    }
    const reqPayload = {
      updatedAt,
      modules: modulesPayload,
      cjkFontScale: currentCjkScale,
      uiState: {
        recentCollapsed: Boolean(recentCollapsed),
        unifiedRecentCollapsed: Boolean(unifiedRecentCollapsed)
      }
    };
    window
      .__agProjectCall('saveUiPrefs', reqPayload, 5000)
      .then((res) => {
        if (disposed) return;
        if (!res || !res.ok) {
          cancelLater(prefsSyncRetryTimer);
          prefsSyncRetryTimer = later(() => {
            if (!disposed && typeof window.__agProjectCall === 'function') {
              window.__agProjectCall('saveUiPrefs', reqPayload, 5000).catch(() => {});
            }
          }, 450);
        }
      })
      .catch(() => {});
  }

  function setCjkScaleOverride(rawScale) {
    const next = normalizeCjkScale(rawScale);
    if (!next) return;
    currentCjkScale = next;
    localModOverrides.cjkFontScale = next;
    persistUiPrefsToDaemon();
    if (docRoot) {
      docRoot.setAttribute('data-ag-cjk-scale', next);
    }
    syncSettingsSwitchesUi();
    flashSettingsSavedToast();
  }

  function setModuleOverride(modKey, featKey, nextBool) {
    localModOverrides[modKey] = Boolean(nextBool);
    FEAT[featKey] = Boolean(nextBool);
    persistUiPrefsToDaemon();
    applyImmediateFeatureEffects(featKey, FEAT[featKey]);
    syncSettingsSwitchesUi();
    flashSettingsSavedToast();
  }

  function syncSettingsSwitchesUi() {
    if (!settingsPanelEl) return;
    for (const grp of SETTINGS_GROUPS) {
      for (const [modKey, featKey] of grp.items) {
        const sw = settingsPanelEl.querySelector(`[data-ag-cux-switch="${modKey}"]`);
        if (sw) sw.setAttribute('aria-checked', String(Boolean(FEAT[featKey])));
      }
    }
    settingsPanelEl.querySelectorAll('[data-ag-cux-cjk-scale]').forEach((btn) => {
      btn.setAttribute('aria-checked', String(btn.getAttribute('data-ag-cux-cjk-scale') === currentCjkScale));
    });
  }

  function closeClaudeUxSettingsPane() {
    if (settingsRightRef) settingsRightRef.removeAttribute('data-ag-claude-settings-open');
    if (settingsSidebarRef) settingsSidebarRef.removeAttribute('data-ag-claude-nav-open');
    if (settingsNavBtn) {
      settingsNavBtn.classList.remove('bg-sidebar-secondary');
      settingsNavBtn.removeAttribute('aria-current');
    }
    if (settingsPanelEl) settingsPanelEl.hidden = true;
  }

  function onNativeSettingsNavClick(e) {
    if (
      e.target &&
      e.target.closest &&
      !e.target.closest('#ag-claude-ux-settings-nav, #ag-settings-stats-wrap, [data-ag-stats-subhdr="1"]') &&
      e.target.closest('button')
    ) {
      closeClaudeUxSettingsPane();
      requestAnimationFrame(() => syncSettingsStatsGroup());
    }
  }

  function openClaudeUxSettingsPane() {
    if (!settingsSidebarRef || !settingsRightRef || !settingsNavBtn) return;
    settingsSidebarRef.setAttribute('data-ag-claude-nav-open', 'true');
    settingsRightRef.setAttribute('data-ag-claude-settings-open', 'true');
    settingsNavBtn.classList.add('bg-sidebar-secondary');
    settingsNavBtn.setAttribute('aria-current', 'page');
    syncSettingsStatsGroup(settingsSidebarRef);

    if (!settingsPanelEl || settingsPanelEl.parentElement !== settingsRightRef) {
      if (settingsPanelEl) settingsPanelEl.remove();
      const panel = document.createElement('div');
      panel.id = 'ag-claude-ux-settings-panel';
      panel.setAttribute('data-ag-i18n-ignore', '1');
      panel.setAttribute('role', 'region');
      settingsRightRef.appendChild(panel);
      settingsPanelEl = panel;
    }
    renderSettingsPanelContent(settingsPanelEl);
    settingsPanelEl.hidden = false;
    syncSettingsSwitchesUi();
    settingsRightRef.scrollTop = 0;
  }

  const SVG_SETTINGS_CHEVRON =
    '<svg width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4.5 6.2L8 9.8l3.5-3.6"/></svg>';

  function cleanupSettingsStatsGroup(sb) {
    if (settingsStatsBtnWrap && settingsStatsBtnWrap.parentNode) settingsStatsBtnWrap.remove();
    settingsStatsBtnWrap = null;
    const root = sb || null;
    if (!root) return;
    root.querySelectorAll('.ag-settings-subhdr-chev').forEach((el) => el.remove());
    root
      .querySelectorAll(
        '[data-ag-stats-hidden], [data-ag-stats-subhdr], [data-ag-stats-list], [data-ag-stats-open], [data-ag-stats-active], [data-ag-stats-passthrough]'
      )
      .forEach((el) => {
        el.removeAttribute('data-ag-stats-hidden');
        el.removeAttribute('data-ag-stats-subhdr');
        el.removeAttribute('data-ag-stats-list');
        el.removeAttribute('data-ag-stats-open');
        el.removeAttribute('data-ag-stats-active');
        el.removeAttribute('data-ag-stats-passthrough');
        el.removeAttribute('role');
        el.removeAttribute('tabindex');
        el.removeAttribute('aria-expanded');
      });
  }

  function syncSettingsStatsGroup(sb) {
    const sidebar = sb || settingsSidebarRef || document.querySelector('[data-testid="settings-sidebar"]');
    if (!sidebar || disposed) return;

    let projHdr = null;
    let projList = null;
    let unlinkedHdr = null;
    let unlinkedList = null;

    for (const h2 of sidebar.querySelectorAll('h2')) {
      const txt = (h2.textContent || '').trim();
      const wrap = h2.parentElement;
      if (!wrap || wrap === sidebar) continue;
      if (!projHdr && /^(Projects|项目)$/i.test(txt)) {
        wrap.removeAttribute('data-ag-stats-passthrough');
        projHdr = wrap;
        const next = wrap.nextElementSibling;
        if (next && !next.querySelector('h2')) {
          next.removeAttribute('data-ag-stats-passthrough');
          projList = next;
        }
      } else if (!unlinkedHdr && /^(Not in Project|Outside of Project|未关联项目)$/i.test(txt)) {
        wrap.removeAttribute('data-ag-stats-passthrough');
        unlinkedHdr = wrap;
        const next = wrap.nextElementSibling;
        if (next && !next.querySelector('h2')) {
          next.removeAttribute('data-ag-stats-passthrough');
          unlinkedList = next;
        }
      } else {
        wrap.setAttribute('data-ag-stats-passthrough', '1');
        const next = wrap.nextElementSibling;
        if (next && !next.querySelector('h2')) next.setAttribute('data-ag-stats-passthrough', '1');
      }
    }

    const firstAnchor = projHdr || unlinkedHdr;
    if (!firstAnchor || !firstAnchor.parentElement) {
      cleanupSettingsStatsGroup(sidebar);
      return;
    }

    /* Mount top-level "统计 / Stats" collapsible row styled identically to native Settings nav items */
    const nativeNavBtn =
      sidebar.querySelector('button[data-testid="settings-nav-item-Browser"]') ||
      sidebar.querySelector('button[data-testid="settings-nav-item-Appearance"]') ||
      sidebar.querySelector('button[data-testid^="settings-nav-item-"]:not([data-testid="settings-nav-item-Stats"])');
    const navWrapCls = (nativeNavBtn && nativeNavBtn.parentElement && nativeNavBtn.parentElement.className) || 'relative group/nav-item mx-2';
    const navBtnCls = nativeNavBtn
      ? (nativeNavBtn.className || '').replace(/\bbg-sidebar-secondary\b/g, 'hover:bg-sidebar-muted')
      : '';

    if (!settingsStatsBtnWrap || !settingsStatsBtnWrap.isConnected || settingsStatsBtnWrap.parentElement !== firstAnchor.parentElement) {
      if (settingsStatsBtnWrap && settingsStatsBtnWrap.parentNode) settingsStatsBtnWrap.remove();
      const wrap = document.createElement('div');
      wrap.id = 'ag-settings-stats-wrap';
      wrap.setAttribute('data-ag-i18n-ignore', '1');
      wrap.className = navWrapCls;
      wrap.innerHTML = `<button type="button" id="ag-settings-stats-toggle" data-testid="settings-nav-item-Stats" class="${escapeHtml(navBtnCls)} ag-settings-stats-toggle" aria-expanded="${
        settingsStatsOpen ? 'true' : 'false'
      }"><span class="transition-colors select-none truncate flex-1 ag-settings-stats-lbl">${L('统计', 'Stats')}</span><span class="ag-settings-stats-chev" aria-hidden="true">${SVG_SETTINGS_CHEVRON}</span></button>`;
      wrap.querySelector('#ag-settings-stats-toggle').addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation();
        settingsStatsOpen = !settingsStatsOpen;
        syncSettingsStatsGroup(sidebar);
      });
      firstAnchor.insertAdjacentElement('beforebegin', wrap);
      settingsStatsBtnWrap = wrap;
    }

    const claudePaneOpen = sidebar.hasAttribute('data-ag-claude-nav-open');
    const projHasActive = !claudePaneOpen && Boolean(projList && projList.querySelector('.bg-sidebar-secondary'));
    const unlinkedHasActive = !claudePaneOpen && Boolean(unlinkedList && unlinkedList.querySelector('.bg-sidebar-secondary'));

    const statsToggle = settingsStatsBtnWrap.querySelector('#ag-settings-stats-toggle');
    if (statsToggle) {
      statsToggle.setAttribute('aria-expanded', settingsStatsOpen ? 'true' : 'false');
      statsToggle.setAttribute('data-open', settingsStatsOpen ? 'true' : 'false');
      statsToggle.classList.toggle('bg-sidebar-secondary', !settingsStatsOpen && (projHasActive || unlinkedHasActive));
      const lbl = statsToggle.querySelector('.ag-settings-stats-lbl');
      if (lbl) lbl.textContent = L('统计', 'Stats');
    }

    const bindSubHdr = (hdrEl, isOpen, hasActiveChild, onToggle) => {
      if (!hdrEl) return;
      hdrEl.setAttribute('data-ag-stats-subhdr', '1');
      hdrEl.setAttribute('data-ag-stats-open', isOpen ? 'true' : 'false');
      hdrEl.setAttribute('data-ag-stats-active', !isOpen && hasActiveChild ? 'true' : 'false');
      hdrEl.setAttribute('role', 'button');
      hdrEl.setAttribute('tabindex', '0');
      hdrEl.setAttribute('aria-expanded', isOpen ? 'true' : 'false');
      if (!hdrEl.querySelector('.ag-settings-subhdr-chev')) {
        const chev = document.createElement('span');
        chev.className = 'ag-settings-subhdr-chev';
        chev.setAttribute('data-ag-i18n-ignore', '1');
        chev.setAttribute('aria-hidden', 'true');
        chev.innerHTML = SVG_SETTINGS_CHEVRON;
        hdrEl.appendChild(chev);
      }
      if (settingsStatsOpen) hdrEl.removeAttribute('data-ag-stats-hidden');
      else hdrEl.setAttribute('data-ag-stats-hidden', '1');
      if (!hdrEl.__agStatsBound) {
        hdrEl.__agStatsBound = true;
        hdrEl.addEventListener('click', (e) => {
          e.preventDefault();
          e.stopPropagation();
          onToggle();
        });
        hdrEl.addEventListener('keydown', (e) => {
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault();
            e.stopPropagation();
            onToggle();
          }
        });
      }
    };

    bindSubHdr(projHdr, settingsStatsProjOpen, projHasActive, () => {
      settingsStatsProjOpen = !settingsStatsProjOpen;
      syncSettingsStatsGroup(sidebar);
    });
    if (projList) {
      projList.setAttribute('data-ag-stats-list', '1');
      if (settingsStatsOpen && settingsStatsProjOpen) projList.removeAttribute('data-ag-stats-hidden');
      else projList.setAttribute('data-ag-stats-hidden', '1');
    }

    bindSubHdr(unlinkedHdr, settingsStatsUnlinkedOpen, unlinkedHasActive, () => {
      settingsStatsUnlinkedOpen = !settingsStatsUnlinkedOpen;
      syncSettingsStatsGroup(sidebar);
    });
    if (unlinkedList) {
      unlinkedList.setAttribute('data-ag-stats-list', '1');
      if (settingsStatsOpen && settingsStatsUnlinkedOpen) unlinkedList.removeAttribute('data-ag-stats-hidden');
      else unlinkedList.setAttribute('data-ag-stats-hidden', '1');
    }
  }

  function detachSettingsPanel() {
    closeClaudeUxSettingsPane();
    cleanupSettingsStatsGroup(settingsSidebarRef || document.querySelector('[data-testid="settings-sidebar"]'));
    if (settingsSidebarRef) {
      settingsSidebarRef.removeEventListener('click', onNativeSettingsNavClick, true);
    }
    if (settingsNavWrap && settingsNavWrap.parentNode) settingsNavWrap.remove();
    if (settingsPanelEl && settingsPanelEl.parentNode) settingsPanelEl.remove();
    settingsSidebarRef = null;
    settingsRightRef = null;
    settingsNavWrap = null;
    settingsNavBtn = null;
    settingsPanelEl = null;
  }

  function reconcileSettingsPanel() {
    if (disposed) return;
    const sb = document.querySelector('[data-testid="settings-sidebar"]');
    if (!sb) {
      if (settingsSidebarRef || settingsStatsBtnWrap) {
        settingsStatsOpen = false;
        settingsStatsProjOpen = false;
        settingsStatsUnlinkedOpen = false;
        detachSettingsPanel();
      }
      return;
    }
    if (settingsNavWrap && settingsNavWrap.isConnected && settingsSidebarRef === sb) {
      syncSettingsStatsGroup(sb);
      return;
    }
    if (settingsSidebarRef && settingsSidebarRef !== sb) {
      detachSettingsPanel();
    }

    const anchorBtn =
      sb.querySelector('button[data-testid="settings-nav-item-Appearance"]') ||
      sb.querySelector('button[data-testid="settings-nav-item-General"]') ||
      sb.querySelector('button[data-testid^="settings-nav-item-"]:not([data-testid="settings-nav-item-Stats"])');
    const splitRoot = sb.closest('[data-split-root="true"], [data-split-root]') || (sb.parentElement && sb.parentElement.parentElement && sb.parentElement.parentElement.parentElement);
    const rightOuter = splitRoot && splitRoot.children && splitRoot.children.length >= 2 ? splitRoot.children[splitRoot.children.length - 1] : null;
    const rightContent = (rightOuter && rightOuter.firstElementChild) || rightOuter;
    if (!anchorBtn || !anchorBtn.parentElement || !anchorBtn.parentElement.parentElement || !rightContent) {
      syncSettingsStatsGroup(sb);
      return;
    }

    settingsSidebarRef = sb;
    settingsRightRef = rightContent;
    const navWrap = document.createElement('div');
    navWrap.id = 'ag-claude-ux-settings-nav';
    navWrap.setAttribute('data-ag-i18n-ignore', '1');
    navWrap.className = anchorBtn.parentElement.className || 'relative group/nav-item mx-2';

    const btn = document.createElement('button');
    btn.type = 'button';
    btn.setAttribute('data-testid', 'settings-nav-item-ClaudeUX');
    btn.className = (anchorBtn.className || '').replace(/\bbg-sidebar-secondary\b/g, 'hover:bg-sidebar-muted');
    btn.innerHTML = `<span class="truncate">${L('界面增强', 'UI Enhancements')}</span>`;
    btn.addEventListener('click', () => openClaudeUxSettingsPane());
    navWrap.appendChild(btn);

    anchorBtn.parentElement.insertAdjacentElement('afterend', navWrap);
    sb.addEventListener('click', onNativeSettingsNavClick, true);
    settingsNavWrap = navWrap;
    settingsNavBtn = btn;
    syncSettingsStatsGroup(sb);
  }

  /* ==========================================================================
   * 10. Claude-Style Projects Workspace & Pure-Local Context Manager
   *     - Mounts a `Projects` (`项目`) nav entry with Claude's stacked-box icon
   *       between `Automations` (`automations-button`) and `Skills` (`/customizations`).
   *     - Opens a right-pane Projects card wall reading real `sidebarProjects.projects`.
   *     - Clicking any project opens a Claude-style pure-local config modal for
   *       `Instructions` & `Add files` (written directly to `<dir>/AGENTS.md` +
   *       `<dir>/.anti-claude/files/` via `window.__agProjectCall`).
   * ========================================================================== */
  const SVG_CLAUDE_PROJECTS_ICON =
    '<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.35" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
    '<path d="M5.25 2.75h5.5"/>' +
    '<path d="M3.75 5.25h8.5"/>' +
    '<path d="M2.6 7.75h10.8l-.68 4.8a1.4 1.4 0 0 1-1.39 1.2H4.67a1.4 1.4 0 0 1-1.39-1.2l-.68-4.8Z"/>' +
    '</svg>';

  const SVG_PROJ_SEARCH_ICON =
    '<svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" aria-hidden="true"><circle cx="7.2" cy="7.2" r="4.6"/><path d="M10.8 10.8l2.8 2.8"/></svg>';

  let projectsViewOpen = false;
  let activeProjectId = null; // null = Level 1 grid; string = Level 2 project detail workspace
  let projectsSearchQuery = '';
  let projectsSortMode = 'recent'; // 'recent' | 'name'
  let projectsContextMap = {};
  let projectsNativeMtimeMap = {};
  const projectComposerDrafts = new Map();
  const projectComposerMentions = new Map(); // projectId -> Map<token, { token, label, kind, scopeItem }>
  const projectComposerMedia = new Map(); // projectId -> Array<{ id, file, name, mimeType, dataUrl, bytes }>
  let pdMediaSeq = 0;
  let cascadeRpcSvcRef = null;
  let pdMentionState = {
    open: false,
    projectId: '',
    startIdx: -1,
    endIdx: -1,
    rawQuery: '',
    category: '',
    subQuery: '',
    items: [],
    activeIndex: 0,
    loading: false,
    reqSeq: 0
  };
  const pdMentionCache = {
    rulesByKey: new Map(),
    pluginsByKey: new Map(),
    hasDriveProvider: null
  };
  let projectsSidebarRo = null;
  let projectsSidebarRoTarget = null;
  let projectsViewEl = null;
  let projectsModalEl = null;
  let projectsModalState = null; // { project, dirPath, instructions, hasOtherAgentsMd, saving, error }
  let projectsDocListenerBound = false;
  let projectsContextBusy = false;
  let projectFolderDropdownOpen = false;
  let projectFolderSearch = '';
  let projectSelectedFolderPath = '';
  let newProjectWatchCleanup = null;
  let projectMgmtSvcRef = null;
  let projectMenuState = null; // { project, x, y, confirmDelete }
  let projectMenuDocBound = false;
  const optimisticallyDeletedProjectIds = new Set();
  const optimisticProjectNames = new Map();

  const SVG_PROJ_SETTINGS =
    '<svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.35" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="8" cy="8" r="2.2"/><path d="M8 1.9v1.5M8 12.6v1.5M1.9 8h1.5M12.6 8h1.5M3.7 3.7l1.1 1.1M11.2 11.2l1.1 1.1M12.3 3.7l-1.1 1.1M4.8 11.2l-1.1 1.1"/></svg>';

  const SVG_PD_MENTION_FILE =
    '<svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.35" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 2.2h5.2L12.5 5.5v8.3a1 1 0 0 1-1 1h-7.5a1 1 0 0 1-1-1V3.2a1 1 0 0 1 1-1Z"/><path d="M9 2.2v3.4h3.4"/></svg>';
  const SVG_PD_MENTION_RULE =
    '<svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.35" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3.2 2.6A1.4 1.4 0 0 1 4.6 1.2h8.2v12.2H4.6a1.4 1.4 0 0 0-1.4 1.4V2.6Z"/><path d="M3.2 13.4A1.4 1.4 0 0 1 4.6 12h8.2"/><path d="M6 4.8h4.2M6 7.4h4.2"/></svg>';
  const SVG_PD_MENTION_CHAT =
    '<svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.35" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M2.5 3.5a1.5 1.5 0 0 1 1.5-1.5h8a1.5 1.5 0 0 1 1.5 1.5v6a1.5 1.5 0 0 1-1.5 1.5H6.2L3.2 13.6V11H4a1.5 1.5 0 0 1-1.5-1.5v-6Z"/></svg>';
  const SVG_PD_MENTION_PLUGIN =
    '<svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M6.3 2.5a1.5 1.5 0 0 1 3 0v.9h2.2a1 1 0 0 1 1 1v2.2h.9a1.5 1.5 0 0 1 0 3h-.9v2.2a1 1 0 0 1-1 1H9.3v-.9a1.5 1.5 0 0 0-3 0v.9H3.5a1 1 0 0 1-1-1V9.6h.9a1.5 1.5 0 0 0 0-3h-.9V4.4a1 1 0 0 1 1-1h2.8v-.9Z"/></svg>';
  const SVG_PD_MENTION_DRIVE =
    '<svg width="14" height="14" viewBox="0 0 24 24" aria-hidden="true"><path fill="#0066DA" d="M3.4 18.5l2.5 4.3c.3.5.7.9 1.2 1.1L12 15.5H2c0 .6.2 1.1.5 1.6l.9 1.4z"/><path fill="#00AC47" d="M12 7.2L7.1 15.5H2l6.9-12c.5-.3 1-.5 1.6-.5h3c.6 0 1.1.2 1.6.5L12 7.2z"/><path fill="#EA4335" d="M16.9 23.9c.5-.2.9-.6 1.2-1.1l3.4-5.9c.3-.5.5-1 .5-1.6h-10l4.9 8.6z"/><path fill="#00832D" d="M12 7.2l3.1-4.2c-.5-.3-1-.5-1.6-.5h-3c-.6 0-1.1.2-1.6.5L12 7.2z"/><path fill="#2684FC" d="M12 15.5h10l-3.1-5.4L15.8 15l-3.8.5z"/><path fill="#FFBA00" d="M22 15.5c0-.6-.2-1.1-.5-1.6L15.1 2.7c-.3-.5-.7-.9-1.2-1.1L12 7.2l4.9 8.3H22z"/></svg>';

  function encodePathToFileUri(absPath) {
    const raw = String(absPath || '').trim();
    if (!raw) return '';
    if (raw.startsWith('file://')) return raw;
    const norm = raw.replace(/\\/g, '/');
    const withLead = norm.startsWith('/') ? norm : `/${norm}`;
    const parts = withLead.split('/').map((seg, i) => {
      if (i === 1 && /^[A-Za-z]:$/.test(seg)) return seg;
      return encodeURIComponent(seg);
    });
    return `file://${parts.join('/')}`;
  }

  function resolveCascadeRpcService() {
    if (
      cascadeRpcSvcRef &&
      (typeof cascadeRpcSvcRef.searchFiles === 'function' ||
        typeof cascadeRpcSvcRef.getAllRules === 'function' ||
        typeof cascadeRpcSvcRef.getAllPlugins === 'function')
    ) {
      return cascadeRpcSvcRef;
    }
    const rootEl = document.getElementById('root');
    const anchors = [
      document.querySelector('.bg-sidebar'),
      document.querySelector('[data-testid="automations-button"]'),
      document.querySelector('[data-testid="project-header"]'),
      rootEl && rootEl.firstElementChild
    ];
    const isRpc = (v) =>
      v &&
      typeof v === 'object' &&
      (typeof v.searchFiles === 'function' || typeof v.getAllRules === 'function' || typeof v.getAllPlugins === 'function');
    for (const anchor of anchors) {
      let cur = anchor ? activeReactFiber(anchor) : null;
      for (let d = 0; cur && d < 42; d++, cur = cur.return) {
        const pv = cur.memoizedProps && cur.memoizedProps.value;
        if (isRpc(pv)) {
          cascadeRpcSvcRef = pv;
          return pv;
        }
        for (let dep = cur.dependencies && cur.dependencies.firstContext; dep; dep = dep.next) {
          if (isRpc(dep.memoizedValue)) {
            cascadeRpcSvcRef = dep.memoizedValue;
            return dep.memoizedValue;
          }
        }
      }
    }
    return null;
  }

  function getProjectMentionMap(projectId, create = false) {
    if (!projectId) return null;
    let m = projectComposerMentions.get(projectId);
    if (!m && create) {
      m = new Map();
      projectComposerMentions.set(projectId, m);
    }
    return m || null;
  }

  function iconForMentionKind(kind, logoUrl = '') {
    if (logoUrl && /^(https?:|data:|blob:)/i.test(logoUrl)) {
      return `<img src="${escapeHtml(logoUrl)}" alt="" />`;
    }
    if (kind === 'directory') return SVG_PROJ_FOLDER_OPEN;
    if (kind === 'file') return SVG_PD_MENTION_FILE;
    if (kind === 'rule') return SVG_PD_MENTION_RULE;
    if (kind === 'conversation') return SVG_PD_MENTION_CHAT;
    if (kind === 'drive') return SVG_PD_MENTION_DRIVE;
    return SVG_PD_MENTION_PLUGIN;
  }

  function closePdMentionMenu() {
    pdMentionState.open = false;
    pdMentionState.items = [];
    pdMentionState.loading = false;
    pdMentionState.reqSeq += 1;
    const pop = document.getElementById('ag-pd-mention-popover');
    if (pop) {
      pop.setAttribute('data-open', 'false');
      pop.innerHTML = '';
    }
  }

  function parsePdMentionTrigger(text, caretPos) {
    const pos = typeof caretPos === 'number' ? caretPos : String(text || '').length;
    const before = String(text || '').slice(0, pos);
    const catMatch = before.match(/(?:^|[\s(\[{"'，。；：！？])@(files|rules|conversation|drive):([^@\n]*)$/i);
    if (catMatch) {
      const sub = catMatch[2] || '';
      const cat = catMatch[1].toLowerCase();
      const tokenLen = 1 + catMatch[1].length + 1 + sub.length;
      return {
        startIdx: pos - tokenLen,
        endIdx: pos,
        rawQuery: `${cat}:${sub}`,
        category: cat,
        subQuery: sub
      };
    }
    const rootMatch = before.match(/(?:^|[\s(\[{"'，。；：！？])@([^\s@\n\[]*)$/);
    if (rootMatch) {
      const q = rootMatch[1] || '';
      return {
        startIdx: pos - 1 - q.length,
        endIdx: pos,
        rawQuery: q,
        category: '',
        subQuery: q
      };
    }
    return null;
  }

  function getProjectWorkspaceUris(project) {
    if (!project) return [];
    const dirs = [];
    if (project.dirPath) dirs.push(project.dirPath);
    const ctx = project.dirPath ? projectsContextMap[project.dirPath] : null;
    if (ctx && Array.isArray(ctx.extraFolders)) {
      for (const ef of ctx.extraFolders) {
        if (ef && ef.absPath && !dirs.includes(ef.absPath)) dirs.push(ef.absPath);
      }
    }
    return dirs.map(encodePathToFileUri).filter(Boolean);
  }

  function collectMentionConversationOptions(project, filterQuery) {
    const { store } = resolveProjectsStoreAndBindings();
    const state = store ? store.getState() : null;
    const summaries = Object.assign(
      {},
      (state && state.trajectorySummaries && state.trajectorySummaries.summaries) || {},
      (state && state.trajectorySummaries && state.trajectorySummaries.externalSummaries) || {}
    );
    const projNameById = new Map();
    const rawProjs = (state && state.sidebarProjects && state.sidebarProjects.projects) || [];
    for (const rp of rawProjs) {
      if (rp && rp.id && rp.name) projNameById.set(rp.id, rp.name);
    }
    const q = String(filterQuery || '').trim().toLowerCase();
    const rows = [];
    for (const [cid, sum] of Object.entries(summaries)) {
      if (!sum || !isSidebarVisibleSummary(cid, sum, state)) continue;
      const title = String((sum.annotations && sum.annotations.title) || sum.summary || '').trim();
      if (!title) continue;
      const bodyPreview = String(sum.summary || '').trim();
      if (q && !title.toLowerCase().includes(q) && !bodyPreview.toLowerCase().includes(q)) continue;
      const pid = sum.projectId || (sum.trajectoryMetadata && sum.trajectoryMetadata.projectId) || '';
      const inCurrentProj = Boolean(project && project.id && pid === project.id);
      const isPinned = isSummaryPinned(cid, sum, state);
      const ownerLabel = inCurrentProj
        ? L('本项目', 'This project')
        : pid && pid !== 'outside-of-project' && projNameById.get(pid)
          ? projNameById.get(pid)
          : L('项目外对话', 'Outside of project');
      const lastSec = protoSeconds(sum.lastModifiedTime);
      const timeStr = lastSec ? formatProjectTimeAgo(lastSec) : '';
      rows.push({
        kind: 'conversation',
        label: title,
        desc: [isPinned ? L('置顶', 'Pinned') : '', ownerLabel, timeStr].filter(Boolean).join(' · '),
        inCurrentProj,
        isPinned,
        lastSec,
        scopeItem: {
          $typeName: 'exa.codeium_common_pb.ContextScopeItem',
          scopeItem: {
            case: 'conversation',
            value: Object.assign(
              {
                $typeName: 'exa.codeium_common_pb.ConversationScopeItem',
                id: cid,
                title,
                source: ''
              },
              sum.lastModifiedTime ? { lastModifiedTime: sum.lastModifiedTime } : {}
            )
          }
        }
      });
    }
    rows.sort((a, b) => {
      if (a.inCurrentProj !== b.inCurrentProj) return a.inCurrentProj ? -1 : 1;
      if (a.isPinned !== b.isPinned) return a.isPinned ? -1 : 1;
      return b.lastSec - a.lastSec;
    });
    return rows.slice(0, 60);
  }

  async function fetchPdMentionRules(workspaceUris) {
    const key = workspaceUris.join('|') || '__global__';
    const cached = pdMentionCache.rulesByKey.get(key);
    if (cached && Date.now() - cached.ts < 15000) return cached.items;
    const rt = resolveCascadeRpcService();
    if (!rt || typeof rt.getAllRules !== 'function') return [];
    try {
      const memories = (await rt.getAllRules(workspaceUris)) || [];
      const items = memories
        .map((d) => {
          if (!d) return null;
          const isProjScope = d.scope && d.scope.scope && d.scope.scope.case === 'projectScope';
          const rulePath = isProjScope ? d.scope.scope.value.absoluteFilePath : d.memoryId || d.rulePath || '';
          const ruleName = isProjScope ? d.scope.scope.value.filePath : d.memoryId || d.ruleName || '';
          const rawContent = d.memory && d.memory.case === 'textMemory' ? d.memory.value.content : d.description || '';
          const oneLine = String(rawContent || '')
            .replace(/<!--[\s\S]*?-->/g, ' ')
            .replace(/[#>*`\-\r\n]+/g, ' ')
            .replace(/\s+/g, ' ')
            .trim()
            .slice(0, 120);
          if (!ruleName) return null;
          return {
            kind: 'rule',
            label: ruleName,
            desc: oneLine || rulePath,
            scopeItem: {
              $typeName: 'exa.codeium_common_pb.ContextScopeItem',
              scopeItem: {
                case: 'rule',
                value: {
                  $typeName: 'exa.codeium_common_pb.RuleScopeItem',
                  rulePath,
                  ruleName,
                  description: String(rawContent || '')
                }
              }
            }
          };
        })
        .filter(Boolean);
      pdMentionCache.rulesByKey.set(key, { ts: Date.now(), items });
      return items;
    } catch {
      return [];
    }
  }

  async function fetchPdMentionPlugins(workspaceUris) {
    const key = workspaceUris.join('|') || '__global__';
    const cached = pdMentionCache.pluginsByKey.get(key);
    if (cached && Date.now() - cached.ts < 15000) return cached.items;
    const rt = resolveCascadeRpcService();
    if (!rt || typeof rt.getAllPlugins !== 'function') return [];
    try {
      const res = await rt.getAllPlugins({ workspaceUris });
      const rawList = Array.isArray(res) ? res : (res && Array.isArray(res.plugins) ? res.plugins : []);
      const items = rawList
        .filter(
          (p) =>
            p &&
            (p.name || p.displayName) &&
            p.enabled !== false &&
            ((Array.isArray(p.skills) && p.skills.length) ||
              (Array.isArray(p.workflows) && p.workflows.length) ||
              (Array.isArray(p.agents) && p.agents.length) ||
              (Array.isArray(p.rules) && p.rules.length) ||
              (Array.isArray(p.mcpServers) && p.mcpServers.length) ||
              (Array.isArray(p.sidecars) && p.sidecars.length) ||
              Boolean(p.hooksJson && String(p.hooksJson).trim()) ||
              !('skills' in p))
        )
        .map((p) => ({
          kind: 'plugin',
          label: p.displayName || p.name,
          desc: String(p.description || '').replace(/\s+/g, ' ').trim(),
          logo: p.logo || '',
          scopeItem: {
            $typeName: 'exa.codeium_common_pb.ContextScopeItem',
            scopeItem: {
              case: 'plugin',
              value: {
                $typeName: 'exa.codeium_common_pb.PluginScopeItem',
                name: p.name || p.displayName,
                displayName: p.displayName || p.name,
                path: p.path || '',
                logo: p.logo || ''
              }
            }
          }
        }));
      pdMentionCache.pluginsByKey.set(key, { ts: Date.now(), items });
      return items;
    } catch {
      return [];
    }
  }

  async function fetchPdMentionProjectFiles(project, subQuery, seq) {
    const wsUris = getProjectWorkspaceUris(project);
    if (!wsUris.length) return [];
    const rt = resolveCascadeRpcService();
    const q = String(subQuery || '').trim();
    const out = [];
    const seenUris = new Set();

    if (rt && typeof rt.searchFiles === 'function') {
      const batches = await Promise.all(
        wsUris.map(async (wsUri, idx) => {
          try {
            const res = await rt.searchFiles({
              query: q,
              workspaceUri: wsUri,
              includeDirectories: true,
              cancelToken: BigInt(6767 + seq * 10 + idx),
              maxResults: 28
            });
            return (res && Array.isArray(res.results) ? res.results : []).map((u) => ({ wsUri, u }));
          } catch {
            return [];
          }
        })
      );
      for (const { wsUri, u } of batches.flat()) {
        if (!u || !u.absoluteUri || seenUris.has(u.absoluteUri)) continue;
        seenUris.add(u.absoluteUri);
        const relMap = u.workspaceUrisToRelativePaths || {};
        const relPath = relMap[wsUri] || Object.values(relMap)[0] || decodeFileUriToPath(u.absoluteUri);
        const cleanRel = String(relPath || '').replace(/\/+$/, '');
        const baseName = cleanRel.split(/[\\/]/).pop() || cleanRel;
        const isDir = Number(u.numFiles || 0) > 1;
        out.push({
          kind: isDir ? 'directory' : 'file',
          label: baseName,
          desc: cleanRel !== baseName ? cleanRel : formatShortHomePath(decodeFileUriToPath(u.absoluteUri)),
          scopeItem: {
            $typeName: 'exa.codeium_common_pb.ContextScopeItem',
            scopeItem: {
              case: isDir ? 'directory' : 'file',
              value: {
                $typeName: 'exa.codeium_common_pb.PathScopeItem',
                absoluteUri: u.absoluteUri,
                workspaceUrisToRelativePaths: Object.assign({}, relMap),
                numFiles: Number(u.numFiles || 0)
              }
            }
          }
        });
      }
    }

    /* Also surface attached project context files if not already returned */
    const ctx = project.dirPath ? projectsContextMap[project.dirPath] : null;
    if (ctx && Array.isArray(ctx.files)) {
      const primaryUri = encodePathToFileUri(project.dirPath);
      const qLower = q.toLowerCase();
      for (const cf of ctx.files) {
        if (!cf || !cf.name) continue;
        if (qLower && !cf.name.toLowerCase().includes(qLower) && !String(cf.relPath || '').toLowerCase().includes(qLower)) continue;
        const abs = cf.absPath || (project.dirPath && cf.relPath ? `${project.dirPath.replace(/\/+$/, '')}/${cf.relPath}` : '');
        const uri = encodePathToFileUri(abs);
        if (!uri || seenUris.has(uri)) continue;
        seenUris.add(uri);
        const rel = cf.relPath || cf.name;
        out.push({
          kind: 'file',
          label: cf.name,
          desc: rel,
          scopeItem: {
            $typeName: 'exa.codeium_common_pb.ContextScopeItem',
            scopeItem: {
              case: 'file',
              value: {
                $typeName: 'exa.codeium_common_pb.PathScopeItem',
                absoluteUri: uri,
                workspaceUrisToRelativePaths: primaryUri ? { [primaryUri]: rel } : {},
                numFiles: 0
              }
            }
          }
        });
      }
    }
    return out.slice(0, 28);
  }

  async function fetchPdMentionDriveItems(subQuery) {
    const rt = resolveCascadeRpcService();
    if (!rt || typeof rt.searchContext !== 'function') return [];
    try {
      const res = await rt.searchContext({ providerLabel: 'drive', query: String(subQuery || '').trim() });
      const items = (res && (res.items || res.results)) || [];
      return items.slice(0, 20).map((it) => {
        const label = it.label || it.itemLabel || it.title || it.name || it.uri || 'Google Drive';
        const desc = it.description || it.subtitle || it.uri || '';
        return {
          kind: 'drive',
          label,
          desc,
          scopeItem: it.scopeItem && it.scopeItem.$typeName
            ? it.scopeItem
            : {
                $typeName: 'exa.codeium_common_pb.ContextScopeItem',
                scopeItem: {
                  case: 'dynamicContext',
                  value: {
                    $typeName: 'exa.codeium_common_pb.DynamicContextScopeItem',
                    providerLabel: 'drive',
                    itemLabel: label,
                    itemValue: it.value || it.itemValue || it.id || '',
                    uri: it.uri || it.url || ''
                  }
                }
              }
        };
      });
    } catch {
      return [];
    }
  }

  function renderPdMentionPopover() {
    const pop = document.getElementById('ag-pd-mention-popover');
    if (!pop) return;
    if (!pdMentionState.open) {
      pop.setAttribute('data-open', 'false');
      pop.innerHTML = '';
      return;
    }
    pop.setAttribute('data-open', 'true');
    const items = pdMentionState.items || [];
    if (pdMentionState.activeIndex >= items.length) {
      pdMentionState.activeIndex = Math.max(0, items.length - 1);
    }

    const catLabels = {
      files: L('项目文件', 'Project files'),
      rules: L('项目规则', 'Rules'),
      conversation: L('历史对话', 'Conversations'),
      drive: 'Google Drive'
    };

    let html = '';
    if (pdMentionState.category) {
      html += `<div class="ag-pd-mention-sec-hdr">
        <button type="button" class="ag-pd-mention-back" data-ag-pd-m-back="true">← ${escapeHtml(L('返回分类', 'Back'))}</button>
        <span>${escapeHtml(catLabels[pdMentionState.category] || pdMentionState.category)}</span>
      </div>`;
    }

    if (!items.length) {
      const emptyMsg = pdMentionState.loading
        ? L('正在加载选项…', 'Loading options…')
        : L('没有匹配的引用项', 'No matching items');
      html += `<div class="ag-pd-mention-empty">${escapeHtml(emptyMsg)}</div>`;
    } else {
      let lastSection = '';
      items.forEach((it, idx) => {
        if (it.section && it.section !== lastSection && !pdMentionState.category) {
          lastSection = it.section;
          html += `<div class="ag-pd-mention-sec-hdr"><span>${escapeHtml(it.section)}</span></div>`;
        }
        const active = idx === pdMentionState.activeIndex;
        const iconHtml = iconForMentionKind(it.kind, it.logo || '');
        html += `<button type="button" class="ag-pd-mention-row" role="option" aria-selected="${active ? 'true' : 'false'}" data-active="${active ? 'true' : 'false'}" data-ag-pd-m-idx="${idx}">
          <span class="ag-pd-mention-icon">${iconHtml}</span>
          <span class="ag-pd-mention-label">${escapeHtml(it.label)}</span>
          ${it.desc ? `<span class="ag-pd-mention-desc">${escapeHtml(it.desc)}</span>` : '<span class="ag-pd-mention-desc"></span>'}
          ${it.isCategory ? '<span class="ag-pd-mention-chev">›</span>' : ''}
        </button>`;
      });
    }

    pop.innerHTML = html;

    pop.querySelectorAll('img').forEach((img) => {
      img.addEventListener(
        'error',
        () => {
          if (img.parentElement) img.parentElement.innerHTML = SVG_PD_MENTION_PLUGIN;
        },
        { once: true }
      );
    });

    const backBtn = pop.querySelector('[data-ag-pd-m-back]');
    if (backBtn) {
      backBtn.addEventListener('mousedown', (e) => {
        e.preventDefault();
        e.stopPropagation();
        resetPdMentionToRoot();
      });
    }

    pop.querySelectorAll('[data-ag-pd-m-idx]').forEach((row) => {
      const idx = Number(row.getAttribute('data-ag-pd-m-idx'));
      row.addEventListener('mouseenter', () => {
        if (pdMentionState.activeIndex !== idx) {
          pdMentionState.activeIndex = idx;
          pop.querySelectorAll('[data-ag-pd-m-idx]').forEach((r2, i2) => {
            r2.setAttribute('data-active', i2 === idx ? 'true' : 'false');
            r2.setAttribute('aria-selected', i2 === idx ? 'true' : 'false');
          });
        }
      });
      row.addEventListener('mousedown', (e) => {
        /* mousedown + preventDefault keeps focus inside #ag-pd-composer-input cleanly */
        e.preventDefault();
        e.stopPropagation();
        applyPdMentionSelection(idx);
      });
    });

    const activeRow = pop.querySelector('.ag-pd-mention-row[data-active="true"]');
    if (activeRow && typeof activeRow.scrollIntoView === 'function') {
      try {
        activeRow.scrollIntoView({ block: 'nearest' });
      } catch {}
    }
  }

  function syncPdMentionPills(project, compInput) {
    const bar = document.getElementById('ag-pd-mention-pills');
    if (!bar || !project) return;
    const mMap = getProjectMentionMap(project.id, false);
    const val = String((compInput && compInput.value) || '');
    if (!mMap || !mMap.size || !val) {
      if (mMap && !val) mMap.clear();
      bar.style.display = 'none';
      bar.innerHTML = '';
      return;
    }
    const activeEntries = [];
    for (const [token, entry] of [...mMap.entries()]) {
      if (val.includes(token)) {
        activeEntries.push(entry);
      } else {
        mMap.delete(token);
      }
    }
    if (!activeEntries.length) {
      bar.style.display = 'none';
      bar.innerHTML = '';
      return;
    }
    bar.style.display = 'flex';
    bar.innerHTML = activeEntries
      .map(
        (en) => `<span class="ag-pd-mention-pill" data-ag-pd-pill-tok="${escapeHtml(en.token)}">
          <span class="ag-pd-mention-pill-icon">${iconForMentionKind(en.kind, en.logo || '')}</span>
          <span class="ag-pd-mention-pill-lbl">${escapeHtml(en.label)}</span>
          <button type="button" class="ag-pd-mention-pill-rm" data-ag-pd-pill-rm="${escapeHtml(en.token)}" aria-label="${escapeHtml(L('移除引用', 'Remove mention'))}">×</button>
        </span>`
      )
      .join('');

    bar.querySelectorAll('[data-ag-pd-pill-rm]').forEach((btn) => {
      btn.addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation();
        const tok = btn.getAttribute('data-ag-pd-pill-rm');
        if (!tok || !compInput) return;
        const nextVal = compInput.value
          .split(tok)
          .join('')
          .replace(/  +/g, ' ');
        compInput.value = nextVal;
        mMap.delete(tok);
        compInput.dispatchEvent(new Event('input', { bubbles: true }));
        compInput.focus();
      });
    });
  }

  function getProjectMediaList(projectId, create = false) {
    if (!projectId) return null;
    let list = projectComposerMedia.get(projectId);
    if (!list && create) {
      list = [];
      projectComposerMedia.set(projectId, list);
    }
    return list || null;
  }

  function inferComposerImageMime(file) {
    const rawType = String((file && file.type) || '').trim().toLowerCase();
    if (rawType.startsWith('image/')) return rawType;
    const name = String((file && file.name) || '').trim().toLowerCase();
    if (/\.(jpe?g)$/.test(name)) return 'image/jpeg';
    if (/\.gif$/.test(name)) return 'image/gif';
    if (/\.webp$/.test(name)) return 'image/webp';
    if (/\.svg$/.test(name)) return 'image/svg+xml';
    if (/\.bmp$/.test(name)) return 'image/bmp';
    if (/\.avif$/.test(name)) return 'image/avif';
    if (/\.heic$/.test(name)) return 'image/heic';
    if (/\.tiff?$/.test(name)) return 'image/tiff';
    if (/\.png$/.test(name)) return 'image/png';
    return '';
  }

  function extractComposerImageFiles(dt) {
    if (!dt) return [];
    const out = [];
    if (dt.items && typeof dt.items.length === 'number') {
      for (let i = 0; i < dt.items.length; i++) {
        const it = dt.items[i];
        if (!it || it.kind !== 'file' || typeof it.getAsFile !== 'function') continue;
        const f = it.getAsFile();
        if (f && inferComposerImageMime(f)) out.push(f);
      }
    }
    if (!out.length && dt.files && typeof dt.files.length === 'number') {
      for (let i = 0; i < dt.files.length; i++) {
        const f = dt.files[i];
        if (f && inferComposerImageMime(f)) out.push(f);
      }
    }
    return out;
  }

  function uint8ToBase64(bytes) {
    if (!bytes || !bytes.length) return '';
    let bin = '';
    for (let i = 0; i < bytes.length; i++) {
      bin += String.fromCharCode(bytes[i]);
    }
    return typeof btoa === 'function' ? btoa(bin) : '';
  }

  async function readBlobBytes(file) {
    if (!file) return new Uint8Array(0);
    if (typeof file.arrayBuffer === 'function') {
      const ab = await file.arrayBuffer();
      return new Uint8Array(ab);
    }
    if (typeof FileReader !== 'undefined') {
      return new Promise((resolve) => {
        const reader = new FileReader();
        reader.onload = () => resolve(reader.result ? new Uint8Array(reader.result) : new Uint8Array(0));
        reader.onerror = () => resolve(new Uint8Array(0));
        reader.readAsArrayBuffer(file);
      });
    }
    return new Uint8Array(0);
  }

  async function stagePdComposerImageFiles(project, rawFiles, onUpdated) {
    if (!project || !project.id || !rawFiles || !rawFiles.length) return 0;
    const list = getProjectMediaList(project.id, true);
    const maxTotal = 10;
    const maxBytes = 20 * 1024 * 1024;
    let added = 0;
    for (const f of Array.from(rawFiles)) {
      if (list.length >= maxTotal) break;
      const mimeType = inferComposerImageMime(f);
      if (!mimeType) continue;
      if (typeof f.size === 'number' && f.size > maxBytes) continue;
      const bytes = await readBlobBytes(f);
      if (!bytes.length || bytes.length > maxBytes) continue;
      const id = `pdm-${++pdMediaSeq}`;
      const ext = (mimeType.split('/')[1] || 'png').replace(/\+.*$/, '').replace('jpeg', 'jpg');
      const rawName = String(f.name || '').trim();
      const name = !rawName || /^image\.[a-z0-9]+$/i.test(rawName) ? `pasted-image-${pdMediaSeq}.${ext}` : rawName;
      const normalizedFile =
        typeof File === 'function' ? new File([bytes], name, { type: mimeType }) : f;
      const dataUrl = `data:${mimeType};base64,${uint8ToBase64(bytes)}`;
      list.push({ id, file: normalizedFile, name, mimeType, dataUrl, bytes });
      added += 1;
    }
    if (added > 0 && typeof onUpdated === 'function') {
      onUpdated();
    }
    return added;
  }

  function syncPdMediaStrip(project, onMutated) {
    const strip = document.getElementById('ag-pd-media-strip');
    if (!strip || !project) return;
    const list = getProjectMediaList(project.id, false);
    if (!list || !list.length) {
      strip.style.display = 'none';
      strip.innerHTML = '';
      return;
    }
    strip.style.display = 'flex';
    strip.innerHTML = list
      .map(
        (m) => `<div class="ag-pd-media-card" data-ag-pd-media-id="${escapeHtml(m.id)}" title="${escapeHtml(m.name)}">
          <img class="ag-pd-media-img" src="${escapeHtml(m.dataUrl)}" alt="${escapeHtml(m.name)}" />
          <button type="button" class="ag-pd-media-rm" data-ag-pd-media-rm="${escapeHtml(m.id)}" aria-label="${escapeHtml(L('移除图片', 'Remove image'))}">×</button>
        </div>`
      )
      .join('');
    strip.querySelectorAll('[data-ag-pd-media-rm]').forEach((btn) => {
      btn.addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation();
        const mid = btn.getAttribute('data-ag-pd-media-rm');
        const cur = getProjectMediaList(project.id, false);
        if (!cur || !mid) return;
        const idx = cur.findIndex((x) => x.id === mid);
        if (idx >= 0) cur.splice(idx, 1);
        if (!cur.length) projectComposerMedia.delete(project.id);
        syncPdMediaStrip(project, onMutated);
        if (typeof onMutated === 'function') onMutated();
      });
    });
  }

  function resetPdMentionToRoot() {
    const compInput = document.getElementById('ag-pd-composer-input');
    if (!compInput || !pdMentionState.open) return;
    const val = compInput.value || '';
    const start = pdMentionState.startIdx;
    const end = pdMentionState.endIdx;
    if (start < 0 || end < start) return;
    const nextVal = `${val.slice(0, start)}@${val.slice(end)}`;
    compInput.value = nextVal;
    const nextCaret = start + 1;
    compInput.focus();
    try {
      compInput.setSelectionRange(nextCaret, nextCaret);
    } catch {}
    compInput.dispatchEvent(new Event('input', { bubbles: true }));
  }

  function movePdMentionSelection(delta) {
    if (!pdMentionState.open || !pdMentionState.items.length) return;
    const len = pdMentionState.items.length;
    pdMentionState.activeIndex = (pdMentionState.activeIndex + delta + len) % len;
    renderPdMentionPopover();
  }

  function applyPdMentionSelection(index) {
    if (!pdMentionState.open) return;
    const item = pdMentionState.items[index];
    const compInput = document.getElementById('ag-pd-composer-input');
    const allProjects = collectNativeProjects();
    const project = allProjects.find((p) => p.id === pdMentionState.projectId);
    if (!item || !compInput || !project) return;

    const val = compInput.value || '';
    const start = pdMentionState.startIdx;
    const end = pdMentionState.endIdx;
    if (start < 0 || end < start) return;

    if (item.isCategory && item.categoryTrigger) {
      const replacement = `@${item.categoryTrigger}:`;
      compInput.value = `${val.slice(0, start)}${replacement}${val.slice(end)}`;
      const nextCaret = start + replacement.length;
      compInput.focus();
      try {
        compInput.setSelectionRange(nextCaret, nextCaret);
      } catch {}
      compInput.dispatchEvent(new Event('input', { bubbles: true }));
      return;
    }

    const cleanLabel = String(item.label || '').replace(/[\[\]\r\n]+/g, ' ').trim() || 'item';
    const token = `@[${cleanLabel}]`;
    const mMap = getProjectMentionMap(project.id, true);
    mMap.set(token, {
      token,
      label: cleanLabel,
      kind: item.kind || 'plugin',
      logo: item.logo || '',
      scopeItem: item.scopeItem
    });
    const afterChar = val.slice(end, end + 1);
    const trailingSpace = afterChar && /\s/.test(afterChar) ? '' : ' ';
    const inserted = `${token}${trailingSpace}`;
    compInput.value = `${val.slice(0, start)}${inserted}${val.slice(end)}`;
    const nextCaret = start + inserted.length;
    closePdMentionMenu();
    compInput.focus();
    try {
      compInput.setSelectionRange(nextCaret, nextCaret);
    } catch {}
    compInput.dispatchEvent(new Event('input', { bubbles: true }));
  }

  async function updatePdMentionMenuForInput(project, compInput) {
    if (!project || !compInput) {
      closePdMentionMenu();
      return;
    }
    const parsed = parsePdMentionTrigger(compInput.value || '', compInput.selectionStart);
    if (!parsed) {
      if (pdMentionState.open) closePdMentionMenu();
      return;
    }

    const seq = ++pdMentionState.reqSeq;
    const sameCategory = pdMentionState.open && pdMentionState.category === parsed.category && pdMentionState.rawQuery === parsed.rawQuery;
    pdMentionState.open = true;
    pdMentionState.projectId = project.id;
    pdMentionState.startIdx = parsed.startIdx;
    pdMentionState.endIdx = parsed.endIdx;
    pdMentionState.rawQuery = parsed.rawQuery;
    pdMentionState.category = parsed.category;
    pdMentionState.subQuery = parsed.subQuery;
    if (!sameCategory) pdMentionState.activeIndex = 0;

    const wsUris = getProjectWorkspaceUris(project);
    const hasLocalFolder = wsUris.length > 0;
    const browseSecTitle = L('分类浏览', 'Browse');
    const pluginSecTitle = L('扩展插件', 'Plugins');

    const baseCategories = [
      ...(hasLocalFolder
        ? [
            {
              isCategory: true,
              categoryTrigger: 'files',
              kind: 'file',
              section: browseSecTitle,
              label: L('项目文件', 'Project files'),
              desc: L('浏览本项目文件夹中的文件与目录', 'Browse files & folders in project')
            }
          ]
        : []),
      {
        isCategory: true,
        categoryTrigger: 'rules',
        kind: 'rule',
        section: browseSecTitle,
        label: L('项目规则', 'Rules'),
        desc: L('浏览规则', 'Browse rules')
      },
      {
        isCategory: true,
        categoryTrigger: 'conversation',
        kind: 'conversation',
        section: browseSecTitle,
        label: L('历史对话', 'Conversations'),
        desc: L('搜索并引用任意对话（含项目外对话）', 'Search conversations')
      },
      {
        isCategory: true,
        categoryTrigger: 'drive',
        kind: 'drive',
        section: browseSecTitle,
        label: 'Google Drive',
        desc: L('搜索云端硬盘文档', 'Search Google Drive')
      }
    ];

    /* 1. Drilled into a specific category (`@files:`, `@rules:`, `@conversation:`, `@drive:`) */
    if (parsed.category === 'conversation') {
      pdMentionState.loading = false;
      pdMentionState.items = collectMentionConversationOptions(project, parsed.subQuery);
      renderPdMentionPopover();
      return;
    }

    if (parsed.category === 'rules') {
      pdMentionState.loading = true;
      renderPdMentionPopover();
      const rules = await fetchPdMentionRules(wsUris);
      if (disposed || pdMentionState.reqSeq !== seq) return;
      const q = parsed.subQuery.trim().toLowerCase();
      pdMentionState.loading = false;
      pdMentionState.items = q
        ? rules.filter((r) => r.label.toLowerCase().includes(q) || String(r.desc || '').toLowerCase().includes(q))
        : rules;
      renderPdMentionPopover();
      return;
    }

    if (parsed.category === 'files') {
      pdMentionState.loading = true;
      renderPdMentionPopover();
      const files = await fetchPdMentionProjectFiles(project, parsed.subQuery, seq);
      if (disposed || pdMentionState.reqSeq !== seq) return;
      pdMentionState.loading = false;
      pdMentionState.items = files;
      renderPdMentionPopover();
      return;
    }

    if (parsed.category === 'drive') {
      pdMentionState.loading = true;
      renderPdMentionPopover();
      const driveItems = await fetchPdMentionDriveItems(parsed.subQuery);
      if (disposed || pdMentionState.reqSeq !== seq) return;
      pdMentionState.loading = false;
      pdMentionState.items = driveItems;
      renderPdMentionPopover();
      return;
    }

    /* 2. Root `@` (`rawQuery === ""`) -> instant Browse categories + Plugins (matching native @ menu) */
    const q = parsed.subQuery.trim().toLowerCase();
    if (!q) {
      const cachedPlugins = pdMentionCache.pluginsByKey.get(wsUris.join('|') || '__global__');
      pdMentionState.loading = !cachedPlugins;
      pdMentionState.items = [
        ...baseCategories,
        ...((cachedPlugins ? cachedPlugins.items : []).map((p) => Object.assign({}, p, { section: pluginSecTitle })))
      ];
      renderPdMentionPopover();
      const plugins = await fetchPdMentionPlugins(wsUris);
      if (disposed || pdMentionState.reqSeq !== seq) return;
      pdMentionState.loading = false;
      pdMentionState.items = [
        ...baseCategories,
        ...plugins.map((p) => Object.assign({}, p, { section: pluginSecTitle }))
      ];
      renderPdMentionPopover();
      return;
    }

    /* 3. Direct filter `@<q>` -> search Categories + Conversations + Project Files + Rules + Plugins in parallel! */
    const catHits = baseCategories.filter(
      (c) =>
        c.categoryTrigger.startsWith(q) ||
        c.label.toLowerCase().includes(q) ||
        String(c.desc || '').toLowerCase().includes(q)
    );
    const convHits = collectMentionConversationOptions(project, q)
      .slice(0, 6)
      .map((c) => Object.assign({}, c, { section: L('历史对话', 'Conversations') }));

    pdMentionState.loading = true;
    pdMentionState.items = [...catHits, ...convHits];
    renderPdMentionPopover();

    const [fileHits, ruleAll, pluginAll] = await Promise.all([
      hasLocalFolder ? fetchPdMentionProjectFiles(project, q, seq) : Promise.resolve([]),
      fetchPdMentionRules(wsUris),
      fetchPdMentionPlugins(wsUris)
    ]);
    if (disposed || pdMentionState.reqSeq !== seq) return;

    const ruleHits = ruleAll
      .filter((r) => r.label.toLowerCase().includes(q) || String(r.desc || '').toLowerCase().includes(q))
      .slice(0, 6)
      .map((r) => Object.assign({}, r, { section: L('项目规则', 'Rules') }));
    const pluginHits = pluginAll
      .filter((p) => p.label.toLowerCase().includes(q) || String(p.desc || '').toLowerCase().includes(q))
      .slice(0, 6)
      .map((p) => Object.assign({}, p, { section: pluginSecTitle }));
    const taggedFiles = fileHits.slice(0, 8).map((f) => Object.assign({}, f, { section: L('项目文件', 'Project files') }));

    pdMentionState.loading = false;
    pdMentionState.items = [...catHits, ...taggedFiles, ...convHits, ...ruleHits, ...pluginHits];
    renderPdMentionPopover();
  }

  function buildComposerSubmitChunks(rawPrompt, mentionEntries = []) {
    const prompt = String(rawPrompt || '');
    if (!prompt.trim()) return [];
    const valid = (Array.isArray(mentionEntries) ? mentionEntries : []).filter(
      (e) => e && e.token && e.scopeItem && prompt.includes(e.token)
    );
    if (!valid.length) {
      return [{ $typeName: 'exa.codeium_common_pb.TextOrScopeItem', chunk: { case: 'text', value: prompt } }];
    }
    /* Sort longest token first to prevent prefix collisions */
    const sorted = valid.slice().sort((a, b) => b.token.length - a.token.length);
    const chunks = [];
    let cursor = 0;
    while (cursor < prompt.length) {
      let bestIdx = -1;
      let bestEntry = null;
      for (const en of sorted) {
        const idx = prompt.indexOf(en.token, cursor);
        if (idx !== -1 && (bestIdx === -1 || idx < bestIdx)) {
          bestIdx = idx;
          bestEntry = en;
        }
      }
      if (bestIdx === -1 || !bestEntry) {
        const tail = prompt.slice(cursor);
        if (tail) {
          chunks.push({ $typeName: 'exa.codeium_common_pb.TextOrScopeItem', chunk: { case: 'text', value: tail } });
        }
        break;
      }
      if (bestIdx > cursor) {
        chunks.push({
          $typeName: 'exa.codeium_common_pb.TextOrScopeItem',
          chunk: { case: 'text', value: prompt.slice(cursor, bestIdx) }
        });
      }
      chunks.push({
        $typeName: 'exa.codeium_common_pb.TextOrScopeItem',
        chunk: { case: 'item', value: bestEntry.scopeItem }
      });
      cursor = bestIdx + bestEntry.token.length;
    }
    return chunks;
  }

  function clearNewProjectWatcher() {
    if (typeof newProjectWatchCleanup === 'function') {
      const fn = newProjectWatchCleanup;
      newProjectWatchCleanup = null;
      try {
        fn();
      } catch {}
    }
  }

  const SVG_PROJ_CHEVRON =
    '<svg width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4.5 6.2L8 9.8l3.5-3.6"/></svg>';

  const SVG_PROJ_FOLDER_ADD =
    '<svg width="15" height="15" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M2 4.5A1.5 1.5 0 0 1 3.5 3h3l1.3 1.5h4.7A1.5 1.5 0 0 1 14 6v2.2M2 4.5v7A1.5 1.5 0 0 0 3.5 13H8"/><path d="M11.5 9.2v4.6M9.2 11.5h4.6"/></svg>';

  const SVG_PROJ_SEND_ARROW =
    '<svg width="15" height="15" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M8 12.5V3.5M4 7.2L8 3.2l4 4"/></svg>';

  const SVG_PROJ_FOLDER_OPEN =
    '<svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M2 4.5A1.5 1.5 0 0 1 3.5 3h3l1.3 1.5h4.7A1.5 1.5 0 0 1 14 6v5.5a1.5 1.5 0 0 1-1.5 1.5h-9A1.5 1.5 0 0 1 2 11.5v-7Z"/></svg>';

  const SVG_PROJ_PLUS =
    '<svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" aria-hidden="true"><path d="M8 3.2v9.6M3.2 8h9.6"/></svg>';

  const SVG_PROJ_EDIT =
    '<svg width="13.5" height="13.5" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M11.2 2.4a1.4 1.4 0 0 1 2 2L5.5 12.1 2.7 13l.9-2.8 7.6-7.8Z"/></svg>';

  function decodeFileUriToPath(uri) {
    const s = String(uri || '').trim();
    if (!s) return '';
    if (!/^file:\/\//i.test(s)) return s;
    try {
      let p = decodeURIComponent(new URL(s).pathname);
      if (/^\/[A-Za-z]:/.test(p)) p = p.slice(1);
      return p;
    } catch {
      return '';
    }
  }

  function formatShortHomePath(absPath) {
    const p = String(absPath || '').trim();
    if (!p) return '';
    return p.replace(/^\/Users\/[^/]+/, '~').replace(/^\/home\/[^/]+/, '~').replace(/^[A-Za-z]:\\Users\\[^\\]+/i, '~');
  }

  function formatProjectTimeAgo(sec) {
    const s = Number(sec) || 0;
    if (!s) return '';
    const diff = Math.max(0, Math.floor(Date.now() / 1000) - s);
    if (diff < 60) return L('刚刚', 'now');
    if (diff < 3600) {
      const mins = Math.floor(diff / 60);
      return FEAT.i18n ? `${mins} 分钟前` : `${mins}m`;
    }
    if (diff < 86400) {
      const hrs = Math.floor(diff / 3600);
      return FEAT.i18n ? `${hrs} 小时前` : `${hrs}h`;
    }
    const days = Math.floor(diff / 86400);
    if (days < 30) return FEAT.i18n ? `${days} 天前` : `${days}d ago`;
    const dt = new Date(s * 1000);
    return FEAT.i18n ? `${dt.getMonth() + 1}月${dt.getDate()}日` : `${dt.getMonth() + 1}/${dt.getDate()}`;
  }

  function resolveProjectsStoreAndBindings() {
    let bindings = findSidebarBindings();
    let store = (bindings && bindings.store) || sidebarStoreRef || null;
    let router = (bindings && bindings.router) || null;
    if (!store || !router) {
      const rootEl = document.getElementById('root');
      const anchors = [
        document.querySelector('[data-testid="project-header"]'),
        document.querySelector('[data-testid="automations-button"]'),
        document.querySelector('.bg-sidebar'),
        rootEl && rootEl.firstElementChild
      ];
      for (const anchor of anchors) {
        let f = anchor ? activeReactFiber(anchor) : null;
        for (let d = 0; f && d < 42 && (!store || !router); d++, f = f.return) {
          const mp = f.memoizedProps;
          if (!store && mp && mp.sidebarStore && typeof mp.sidebarStore.getState === 'function') {
            store = mp.sidebarStore;
          }
          if (!router && mp && mp.sidebarRouter && typeof mp.sidebarRouter.navigate === 'function') {
            router = mp.sidebarRouter;
          }
          if (!router && mp && mp.value && typeof mp.value.navigate === 'function' && mp.value.state && mp.value.state.location) {
            router = mp.value;
          }
          for (let dep = f.dependencies && f.dependencies.firstContext; dep; dep = dep.next) {
            const mv = dep.memoizedValue;
            if (!store && mv && mv.store && typeof mv.store.getState === 'function') {
              store = mv.store;
            }
            if (!router && mv && typeof mv.navigate === 'function' && mv.state && mv.state.location) {
              router = mv;
            }
          }
        }
        if (store && router) break;
      }
    }
    if (!bindings && (store || router)) {
      bindings = { store, router, stepHandler: null, actionsCtx: null, groupsById: new Map(), projectLabels: new Map() };
    } else if (bindings && router && !bindings.router) {
      bindings = Object.assign({}, bindings, { router });
    }
    return { store, bindings };
  }

  function collectProjectConversations(project, state) {
    if (!project || !state) return [];
    const summaries = (state.trajectorySummaries && state.trajectorySummaries.summaries) || {};
    const byProject = state.trajectorySummaries && state.trajectorySummaries.indexes && state.trajectorySummaries.indexes.byProject;
    const rawIds = byProject && byProject[project.id];
    const candidateIds = new Set();

    if (rawIds) {
      const arr =
        typeof rawIds[Symbol.iterator] === 'function'
          ? Array.from(rawIds)
          : typeof rawIds === 'object'
            ? Object.keys(rawIds)
            : [];
      for (const id of arr) candidateIds.add(id);
    }

    const normDir = String(project.dirPath || '').replace(/\/+$/, '');
    for (const [cid, sum] of Object.entries(summaries)) {
      if (!sum) continue;
      const pid = sum.projectId || (sum.trajectoryMetadata && sum.trajectoryMetadata.projectId) || '';
      if (pid === project.id) {
        candidateIds.add(cid);
        continue;
      }
      if (normDir) {
        const wsList = (sum.workspaces || []).concat((sum.trajectoryMetadata && sum.trajectoryMetadata.workspaces) || []);
        for (const ws of wsList) {
          const rawUri = ws && (ws.workspaceFolderAbsoluteUri || ws.uri || ws);
          const norm = typeof rawUri === 'string' ? decodeFileUriToPath(rawUri).replace(/\/+$/, '') : '';
          if (norm && norm === normDir) {
            candidateIds.add(cid);
            break;
          }
        }
      }
    }

    const items = [];
    for (const cid of candidateIds) {
      const sum = summaries[cid];
      if (!sum || !isSidebarVisibleSummary(cid, sum, state)) continue;
      const title = String((sum.annotations && sum.annotations.title) || sum.summary || '').trim();
      if (!title) continue;
      const lastSec = protoSeconds(sum.lastModifiedTime);
      const status = sum.status ?? 0;
      const waiting = Boolean(sum.waitingSteps && sum.waitingSteps.length);
      const running = !sum.killed && (status === 2 || status === 3 || status === 4 || Boolean(sum.hasRunningSubagents));
      items.push({
        id: cid,
        title,
        lastSec,
        pinned: isSummaryPinned(cid, sum, state),
        waiting,
        running
      });
    }
    items.sort((a, b) => (a.pinned !== b.pinned ? (a.pinned ? -1 : 1) : b.lastSec - a.lastSec));
    return items;
  }

  function resolveProjectManagementService() {
    if (projectMgmtSvcRef && typeof projectMgmtSvcRef.deleteProject === 'function') {
      return projectMgmtSvcRef;
    }
    const rootEl = document.getElementById('root');
    const anchors = [
      document.querySelector('.bg-sidebar'),
      document.querySelector('[data-testid="automations-button"]'),
      document.querySelector('[data-testid="project-header"]'),
      rootEl && rootEl.firstElementChild
    ];
    const pickSvc = (val) => {
      if (!val || typeof val !== 'object') return null;
      if (val.core && val.core.projectManagementService && typeof val.core.projectManagementService.deleteProject === 'function') {
        return val.core.projectManagementService;
      }
      if (typeof val.deleteProject === 'function') return val;
      return null;
    };
    for (const anchor of anchors) {
      let cur = anchor ? activeReactFiber(anchor) : null;
      for (let d = 0; cur && d < 42; d++, cur = cur.return) {
        const fromProps = pickSvc(cur.memoizedProps && cur.memoizedProps.value);
        if (fromProps) {
          projectMgmtSvcRef = fromProps;
          return fromProps;
        }
        for (let dep = cur.dependencies && cur.dependencies.firstContext; dep; dep = dep.next) {
          const fromDep = pickSvc(dep.memoizedValue);
          if (fromDep) {
            projectMgmtSvcRef = fromDep;
            return fromDep;
          }
        }
      }
    }
    return null;
  }

  function getRawNativeProjectRecord(projectId, svc) {
    const pm = svc || resolveProjectManagementService();
    if (pm && typeof pm.getProjectStateProvider === 'function') {
      try {
        const prov = pm.getProjectStateProvider(projectId);
        const st = prov && typeof prov.getState === 'function' ? prov.getState() : null;
        if (st && st.project && typeof st.project === 'object') return st.project;
      } catch {}
    }
    if (pm && pm.projectsStateProvider && typeof pm.projectsStateProvider.getState === 'function') {
      try {
        const list = pm.projectsStateProvider.getState() || [];
        const hit = list.find((item) => item && item.project && item.project.id === projectId);
        if (hit && hit.project) return hit.project;
      } catch {}
    }
    return null;
  }

  async function renameNativeProject(project, nextName) {
    const trimmed = String(nextName || '').trim();
    if (!project || !project.id || project.isBuiltin || !trimmed) return { ok: false, error: 'invalid_name' };
    const pm = resolveProjectManagementService();
    if (!pm || typeof pm.updateProject !== 'function') return { ok: false, error: 'service_unavailable' };
    const raw = getRawNativeProjectRecord(project.id, pm) || {
      $typeName: 'exa.project_pb.Project',
      id: project.id,
      name: project.name
    };
    optimisticProjectNames.set(project.id, trimmed);
    if (projectsViewOpen) renderProjectsView();
    try {
      await pm.updateProject(Object.assign({}, raw, { name: trimmed }));
      if (!disposed) {
        if (projectsViewOpen) renderProjectsView();
        scheduleSidebarSync();
      }
      return { ok: true };
    } catch (err) {
      optimisticProjectNames.delete(project.id);
      if (!disposed && projectsViewOpen) renderProjectsView();
      return { ok: false, error: String((err && err.message) || err || 'rename_failed') };
    }
  }

  async function archiveNativeProject(project) {
    if (!project || !project.id || project.isBuiltin) return false;
    const pm = resolveProjectManagementService();
    if (!pm || typeof pm.updateProject !== 'function') return false;
    const raw = getRawNativeProjectRecord(project.id, pm);
    if (!raw) return false;
    optimisticallyDeletedProjectIds.add(project.id);
    if (activeProjectId === project.id) {
      activeProjectId = null;
      projectSelectedFolderPath = '';
    }
    if (projectsViewOpen) renderProjectsView();
    try {
      await pm.updateProject(Object.assign({}, raw, { archived: true }));
      if (!disposed) {
        if (projectsViewOpen) renderProjectsView();
        scheduleSidebarSync();
      }
      return true;
    } catch {
      optimisticallyDeletedProjectIds.delete(project.id);
      if (!disposed && projectsViewOpen) renderProjectsView();
      return false;
    }
  }

  async function deleteNativeProject(project) {
    if (!project || !project.id || project.isBuiltin) return false;
    const pm = resolveProjectManagementService();
    if (!pm || typeof pm.deleteProject !== 'function') return false;
    const { bindings } = resolveProjectsStoreAndBindings();
    optimisticallyDeletedProjectIds.add(project.id);
    optimisticProjectNames.delete(project.id);
    projectComposerDrafts.delete(project.id);
    if (activeProjectId === project.id) {
      activeProjectId = null;
      projectFolderDropdownOpen = false;
      projectFolderSearch = '';
      projectSelectedFolderPath = '';
    }
    if (projectsViewOpen) renderProjectsView();
    try {
      await pm.deleteProject(project.id);
      const router = bindings && bindings.router;
      const loc = router && router.state && router.state.location;
      if (router && typeof router.navigate === 'function' && loc && loc.search && loc.search.project === project.id) {
        try {
          router.navigate({
            to: loc.pathname || '/',
            search: (prev) => {
              const next = Object.assign({}, prev || {});
              delete next.project;
              return next;
            },
            replace: true
          });
        } catch {}
      }
      if (!disposed) {
        if (projectsViewOpen) renderProjectsView();
        scheduleSidebarSync();
      }
      return true;
    } catch {
      optimisticallyDeletedProjectIds.delete(project.id);
      if (!disposed && projectsViewOpen) renderProjectsView();
      return false;
    }
  }

  function openNativeProjectSettings(project) {
    if (!project || !project.id || project.isBuiltin) return;
    const { bindings } = resolveProjectsStoreAndBindings();
    const router = bindings && bindings.router;
    if (router && typeof router.navigate === 'function') {
      try {
        router.navigate({
          search: (prev) =>
            Object.assign({}, prev || {}, {
              settingsOpen: 'true',
              settingsProjectId: project.id
            })
        });
        return;
      } catch {}
    }
    const settingsBtn = document.querySelector('[data-testid="settings-button"]');
    if (settingsBtn) settingsBtn.click();
  }

  function closeProjectActionMenu() {
    projectMenuState = null;
    const menu = document.getElementById('ag-project-action-menu');
    if (menu) menu.remove();
    document.querySelectorAll('[data-ag-proj-menu][data-menu-open], [data-ag-pd-proj-menu][data-menu-open]').forEach((b) => {
      b.removeAttribute('data-menu-open');
    });
    if (projectMenuDocBound) {
      document.removeEventListener('mousedown', onProjectMenuDocDown, true);
      window.removeEventListener('resize', closeProjectActionMenu);
      projectMenuDocBound = false;
    }
  }

  function onProjectMenuDocDown(ev) {
    const t = ev && ev.target;
    if (t && t.closest && t.closest('#ag-project-action-menu, [data-ag-proj-menu], [data-ag-pd-proj-menu]')) return;
    closeProjectActionMenu();
  }

  function renderProjectActionMenu() {
    const st = projectMenuState;
    if (!st || !st.project) {
      closeProjectActionMenu();
      return;
    }
    let menu = document.getElementById('ag-project-action-menu');
    if (!menu) {
      menu = document.createElement('div');
      menu.id = 'ag-project-action-menu';
      menu.setAttribute('role', 'menu');
      menu.setAttribute('data-ag-i18n-ignore', '1');
      menu.addEventListener('click', (ev) => {
        const btn = ev.target && ev.target.closest && ev.target.closest('[data-ag-pm-act]');
        if (!btn || !projectMenuState) return;
        ev.preventDefault();
        ev.stopPropagation();
        const act = btn.getAttribute('data-ag-pm-act');
        const cur = projectMenuState;
        const proj = cur.project;
        if (act === 'rename') {
          closeProjectActionMenu();
          openRenameProjectModal(proj);
          return;
        }
        if (act === 'reveal') {
          closeProjectActionMenu();
          if (proj.dirPath && typeof window.__agProjectCall === 'function') {
            window.__agProjectCall('revealFile', { dirPath: proj.dirPath, targetPath: proj.dirPath }, 8000);
          }
          return;
        }
        if (act === 'settings') {
          closeProjectActionMenu();
          openNativeProjectSettings(proj);
          return;
        }
        if (act === 'archive') {
          closeProjectActionMenu();
          archiveNativeProject(proj);
          return;
        }
        if (act === 'delete') {
          if (!cur.confirmDelete) {
            cur.confirmDelete = true;
            renderProjectActionMenu();
            return;
          }
          closeProjectActionMenu();
          deleteNativeProject(proj);
        }
      });
      document.body.appendChild(menu);
    }

    const proj = st.project;
    const pm = resolveProjectManagementService();
    const canUpdate = Boolean(!proj.isBuiltin && pm && typeof pm.updateProject === 'function');
    const canDelete = Boolean(!proj.isBuiltin && pm && typeof pm.deleteProject === 'function');
    const canReveal = Boolean(proj.dirPath && typeof window.__agProjectCall === 'function');
    const revealLabel = /Win/i.test((navigator && navigator.platform) || '')
      ? L('在资源管理器中显示', 'Show in Explorer')
      : L('在访达中显示', 'Reveal in Finder');
    const delLabel = st.confirmDelete
      ? L('确认删除？（保留本地文件）', 'Confirm delete? (keeps files)')
      : L('删除项目', 'Delete project');

    let itemsHtml = '';
    itemsHtml += `<button type="button" class="ag-rm-item" data-ag-pm-act="rename"${canUpdate ? '' : ' disabled'}>${RECENT_RENAME_SVG}<span class="ag-rm-label">${escapeHtml(L('重命名项目', 'Rename project'))}</span></button>`;
    if (proj.dirPath) {
      itemsHtml += `<button type="button" class="ag-rm-item" data-ag-pm-act="reveal"${canReveal ? '' : ' disabled'}>${RECENT_FOLDER_SVG}<span class="ag-rm-label">${escapeHtml(revealLabel)}</span></button>`;
    }
    itemsHtml += `<button type="button" class="ag-rm-item" data-ag-pm-act="settings"${!proj.isBuiltin ? '' : ' disabled'}>${SVG_PROJ_SETTINGS}<span class="ag-rm-label">${escapeHtml(L('项目权限设置', 'Project settings'))}</span></button>`;
    if (canUpdate && getRawNativeProjectRecord(proj.id, pm)) {
      itemsHtml += `<button type="button" class="ag-rm-item" data-ag-pm-act="archive">${RECENT_ARCHIVE_SVG}<span class="ag-rm-label">${escapeHtml(L('归档项目', 'Archive project'))}</span></button>`;
    }
    itemsHtml += `<div class="ag-rm-sep"></div>`;
    itemsHtml += `<button type="button" class="ag-rm-item ag-rm-danger" data-ag-pm-act="delete" data-confirm="${st.confirmDelete ? '1' : '0'}"${canDelete ? '' : ' disabled'}>${RECENT_TRASH_SVG}<span class="ag-rm-label">${escapeHtml(delLabel)}</span></button>`;

    menu.innerHTML = itemsHtml;

    const menuW = 216;
    const menuH = Math.max(140, menu.offsetHeight || 168);
    const vw = window.innerWidth || 1200;
    const vh = window.innerHeight || 800;
    const left = Math.min(Math.max(8, st.x), Math.max(8, vw - menuW - 8));
    const top = st.y + menuH > vh - 8 ? Math.max(8, st.y - menuH) : Math.max(8, st.y);
    menu.style.left = `${Math.round(left)}px`;
    menu.style.top = `${Math.round(top)}px`;

    if (!projectMenuDocBound) {
      document.addEventListener('mousedown', onProjectMenuDocDown, true);
      window.addEventListener('resize', closeProjectActionMenu);
      projectMenuDocBound = true;
    }
  }

  function openProjectActionMenu(project, x, y, triggerBtn = null) {
    if (!project || !project.id || project.isBuiltin) return;
    closeRecentRowMenu();
    if (projectMenuState && projectMenuState.project && projectMenuState.project.id === project.id && triggerBtn) {
      closeProjectActionMenu();
      return;
    }
    closeProjectActionMenu();
    if (triggerBtn) triggerBtn.setAttribute('data-menu-open', 'true');
    projectMenuState = { project, x, y, confirmDelete: false };
    renderProjectActionMenu();
  }

  function openRenameProjectModal(project) {
    if (!project || !project.id || project.isBuiltin) return;
    closeProjectsModal();
    projectsModalState = {
      kind: 'renameProject',
      project,
      name: project.name || '',
      saving: false,
      error: ''
    };
    renderRenameProjectModal();
  }

  function renderRenameProjectModal() {
    if (!projectsModalState || projectsModalState.kind !== 'renameProject') return;
    if (!projectsModalEl || !projectsModalEl.isConnected) {
      projectsModalEl = document.createElement('div');
      projectsModalEl.id = 'ag-claude-project-modal';
      projectsModalEl.setAttribute('data-ag-i18n-ignore', '1');
      projectsModalEl.addEventListener('click', (e) => {
        if (e.target === projectsModalEl) closeProjectsModal();
      });
      document.body.appendChild(projectsModalEl);
    }
    const st = projectsModalState;
    const errHtml = st.error ? `<div class="ag-pm-error">${escapeHtml(st.error)}</div>` : '';
    projectsModalEl.innerHTML = `
      <div class="ag-pm-dialog" role="dialog" aria-modal="true" aria-label="${escapeHtml(L('重命名项目', 'Rename project'))}">
        <div class="ag-pm-hdr">
          <div class="ag-pm-title-wrap">
            <span class="ag-pm-icon">${SVG_CLAUDE_PROJECTS_ICON}</span>
            <h2 class="ag-pm-title">${escapeHtml(L('重命名项目', 'Rename project'))}</h2>
          </div>
          <button type="button" class="ag-pm-close" data-ag-pm-close="true" aria-label="${escapeHtml(L('关闭', 'Close'))}">×</button>
        </div>
        <div class="ag-pm-field">
          <input id="ag-pm-rename-input" class="ag-pm-input" type="text" value="${escapeHtml(st.name)}" placeholder="${escapeHtml(L('输入项目名称…', 'Enter project name…'))}" />
        </div>
        ${errHtml}
        <div class="ag-pm-footer">
          <button type="button" class="ag-pm-secondary-btn" data-ag-pm-close="true">${L('取消', 'Cancel')}</button>
          <button type="button" class="ag-pm-primary-btn" data-ag-pm-rename-save="true" ${st.saving || !String(st.name || '').trim() ? 'disabled' : ''}>${
            st.saving ? L('保存中…', 'Saving…') : L('保存', 'Save')
          }</button>
        </div>
      </div>
    `;
    const input = projectsModalEl.querySelector('#ag-pm-rename-input');
    const saveBtn = projectsModalEl.querySelector('[data-ag-pm-rename-save]');
    const doSubmit = async () => {
      if (!projectsModalState || projectsModalState.kind !== 'renameProject' || projectsModalState.saving) return;
      const nextName = String(projectsModalState.name || '').trim();
      if (!nextName) return;
      if (nextName === st.project.name) {
        closeProjectsModal();
        return;
      }
      projectsModalState.saving = true;
      projectsModalState.error = '';
      renderRenameProjectModal();
      const res = await renameNativeProject(st.project, nextName);
      if (disposed || !projectsModalState || projectsModalState.kind !== 'renameProject') return;
      if (res && res.ok) {
        closeProjectsModal();
      } else {
        projectsModalState.saving = false;
        projectsModalState.error = L('重命名失败：', 'Rename failed: ') + String((res && res.error) || 'unknown');
        renderRenameProjectModal();
      }
    };
    if (input) {
      input.focus();
      try {
        input.select();
      } catch {}
      input.addEventListener('input', () => {
        if (!projectsModalState || projectsModalState.kind !== 'renameProject') return;
        projectsModalState.name = input.value;
        if (saveBtn) saveBtn.disabled = !input.value.trim();
      });
      input.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') {
          e.preventDefault();
          doSubmit();
        }
      });
    }
    projectsModalEl.querySelectorAll('[data-ag-pm-close]').forEach((b) => {
      b.addEventListener('click', () => closeProjectsModal());
    });
    if (saveBtn) {
      saveBtn.addEventListener('click', () => doSubmit());
    }
  }

  function collectNativeProjects() {
    const { store } = resolveProjectsStoreAndBindings();
    const state = store ? store.getState() : null;
    const rawProjects = (state && state.sidebarProjects && state.sidebarProjects.projects) || [];
    const presentRawIds = new Set();
    const out = [];
    for (const p of rawProjects) {
      if (!p || !p.id) continue;
      presentRawIds.add(p.id);
      if (optimisticallyDeletedProjectIds.has(p.id) || p.archived) continue;
      const rawName = String(p.name || '').trim();
      if (!rawName || rawName === 'swarm/swarm_board' || p.id === 'outside-of-project') continue;
      const isCliProject = p.id === 'default-cli-project';
      const uris = Array.isArray(p.folderUris) ? p.folderUris : [];
      const dirPath = uris.length ? decodeFileUriToPath(uris[0]) : '';
      const optName = optimisticProjectNames.get(p.id);
      if (optName && optName === rawName) optimisticProjectNames.delete(p.id);
      const name = isCliProject ? L('CLI 项目', 'CLI Project') : optName || rawName;
      const base = {
        id: p.id,
        name,
        dirPath,
        shortPath: formatShortHomePath(dirPath),
        isVirtual: !dirPath,
        isCliProject,
        isBuiltin: isCliProject
      };
      const chats = collectProjectConversations(base, state);
      out.push({
        ...base,
        chats,
        chatCount: chats.length,
        lastSec: chats.length ? chats[0].lastSec : 0
      });
    }
    for (const delId of [...optimisticallyDeletedProjectIds]) {
      if (!presentRawIds.has(delId)) optimisticallyDeletedProjectIds.delete(delId);
    }
    return out;
  }

  function positionProjectsOverlay() {
    if (!projectsViewEl || !projectsViewOpen) return;
    const sidebar = document.querySelector('.bg-sidebar');
    let leftPx = 0;
    if (sidebar) {
      const r = sidebar.getBoundingClientRect();
      if (r.width > 20 && r.right > 0 && r.right < window.innerWidth - 160) {
        leftPx = Math.round(r.right);
      }
    }
    const collapsed = leftPx < 220;
    const safeLeftPad = collapsed ? Math.max(24, 224 - leftPx) : 24;
    projectsViewEl.style.left = `${leftPx}px`;
    projectsViewEl.setAttribute('data-sidebar-collapsed', collapsed ? 'true' : 'false');
    projectsViewEl.style.setProperty('--ag-proj-topbar-pl', `${safeLeftPad}px`);
  }

  function ensureProjectsSidebarObserver() {
    if (typeof ResizeObserver === 'undefined') return;
    const sb = document.querySelector('.bg-sidebar');
    if (!sb || projectsSidebarRoTarget === sb) return;
    if (projectsSidebarRo) {
      try {
        projectsSidebarRo.disconnect();
      } catch {}
    }
    projectsSidebarRoTarget = sb;
    projectsSidebarRo = new ResizeObserver(() => positionProjectsOverlay());
    try {
      projectsSidebarRo.observe(sb);
    } catch {}
  }

  function updateProjectsNavActiveVisual() {
    const btn = document.getElementById('ag-claude-projects-nav-btn');
    if (!btn) return;
    btn.setAttribute('data-active', projectsViewOpen ? 'true' : 'false');
    btn.setAttribute('aria-current', projectsViewOpen ? 'page' : 'false');
    const lbl = btn.querySelector('.ag-proj-nav-label');
    if (lbl) lbl.textContent = L('项目', 'Projects');
  }

  function closeProjectsModal() {
    projectsModalState = null;
    if (projectsModalEl) {
      projectsModalEl.remove();
      projectsModalEl = null;
    }
  }

  function closeProjectsView() {
    clearNewProjectWatcher();
    closeProjectActionMenu();
    closePdMentionMenu();
    if (!projectsViewOpen && !projectsModalEl) return;
    closeProjectsModal();
    projectFolderDropdownOpen = false;
    projectFolderSearch = '';
    projectsViewOpen = false;
    if (projectsViewEl) {
      projectsViewEl.setAttribute('data-open', 'false');
    }
    updateProjectsNavActiveVisual();
  }

  function isNativeModalDialogOpen() {
    const dialogs = document.querySelectorAll('[role="dialog"], .agy-dialog');
    for (const el of dialogs) {
      if (!el || !el.isConnected || el.closest('#ag-claude-project-modal, #ag-claude-projects-view')) continue;
      if (el.getAttribute('aria-hidden') === 'true') continue;
      try {
        const cs = window.getComputedStyle(el);
        if (cs && (cs.display === 'none' || cs.visibility === 'hidden')) continue;
      } catch {}
      return true;
    }
    return false;
  }

  function onProjectsGlobalClick(e) {
    if (!projectsViewOpen) return;
    const t = e.target;
    if (!t || !t.closest) return;
    if (t.closest('[data-testid="sidebar-toggle"]')) {
      frame(() => {
        ensureProjectsSidebarObserver();
        positionProjectsOverlay();
      });
      later(() => {
        ensureProjectsSidebarObserver();
        positionProjectsOverlay();
      }, 160);
      later(() => {
        ensureProjectsSidebarObserver();
        positionProjectsOverlay();
      }, 320);
      return;
    }
    if (pdMentionState.open && !t.closest('.ag-pd-composer-anchor, #ag-pd-mention-popover')) {
      closePdMentionMenu();
    }
    if (projectFolderDropdownOpen && !t.closest('[data-ag-pd-folder-menu], [data-ag-pd-folder-toggle]')) {
      projectFolderDropdownOpen = false;
      projectFolderSearch = '';
      if (projectsViewEl) {
        const openMenu = projectsViewEl.querySelector('[data-ag-pd-folder-menu]');
        if (openMenu) openMenu.remove();
        const toggleBtn = projectsViewEl.querySelector('[data-ag-pd-folder-toggle]');
        if (toggleBtn) toggleBtn.setAttribute('data-open', 'false');
      }
    }
    if (
      t.closest(
        '#ag-claude-projects-nav-btn, #ag-claude-projects-view, #ag-claude-project-modal, #ag-claude-model-popover, #ag-claude-model-subpop, #ag-recent-row-menu, #ag-project-action-menu, .agy-dialog, [role="dialog"]'
      )
    ) {
      return;
    }
    if (
      t.closest(
        'a[href="/"], [data-testid="new-conversation-button"], [data-testid="automations-button"], a[href="/customizations"], [data-testid="settings-button"], [data-testid="conversation-row-sidebar"], #ag-claude-recent-section [data-ag-recent-new]'
      ) ||
      (t.closest('#ag-claude-recent-section .ag-recent-row') &&
        !t.closest('[data-ag-recent-pin], [data-ag-recent-menu], [data-ag-recent-rename-input]'))
    ) {
      closeProjectsView();
    }
  }

  function onProjectsGlobalKeyDown(e) {
    if (e.key !== 'Escape') return;
    if (pdMentionState.open) {
      e.preventDefault();
      e.stopPropagation();
      closePdMentionMenu();
    } else if (projectMenuState) {
      e.preventDefault();
      e.stopPropagation();
      closeProjectActionMenu();
    } else if (projectsModalEl) {
      e.preventDefault();
      e.stopPropagation();
      closeProjectsModal();
    } else if (isNativeModalDialogOpen()) {
      return;
    } else if (projectFolderDropdownOpen) {
      e.preventDefault();
      e.stopPropagation();
      projectFolderDropdownOpen = false;
      projectFolderSearch = '';
      renderProjectsView();
    } else if (projectsViewOpen && activeProjectId) {
      e.preventDefault();
      e.stopPropagation();
      activeProjectId = null;
      projectSelectedFolderPath = '';
      renderProjectsView();
    } else if (projectsViewOpen) {
      e.preventDefault();
      e.stopPropagation();
      closeProjectsView();
    }
  }

  function findNativeNewProjectEntryAction(addBtn) {
    if (!addBtn) return null;
    let f = activeReactFiber(addBtn);
    for (let d = 0; f && d < 24; d++, f = f.return) {
      for (let h = f.memoizedState; h; h = h.next) {
        const ms = h.memoizedState;
        const list = Array.isArray(ms) && Array.isArray(ms[0]) ? ms[0] : Array.isArray(ms) ? ms : null;
        if (!list || !list.length) continue;
        for (const it of list) {
          if (!it || typeof it !== 'object' || it.disabled || typeof it.onClick !== 'function') continue;
          const lbl = String(it.label || it.title || '').trim();
          if (
            it.type === 'NEW_PROJECT' ||
            /^(new project|create(?: new)? project|新建项目)$/i.test(lbl)
          ) {
            return () => it.onClick();
          }
        }
      }
    }
    return null;
  }

  function armNewProjectCompletionWatcher(store, bindings) {
    clearNewProjectWatcher();
    if (!projectsViewOpen || !store || typeof store.subscribe !== 'function' || typeof store.getState !== 'function') {
      return;
    }
    const beforeIds = new Set(collectNativeProjects().map((p) => p.id));
    const readSearchProj = () => {
      const loc = bindings && bindings.router && bindings.router.state && bindings.router.state.location;
      return (loc && loc.search && loc.search.project) || '';
    };
    const beforeSearchProj = readSearchProj();
    let sawDialogOpen = false;
    let closeGraceTimer = 0;

    const focusProjectInOverlay = (proj) => {
      clearNewProjectWatcher();
      if (disposed || !projectsViewOpen || !proj) return;
      activeProjectId = proj.id;
      projectSelectedFolderPath = proj.dirPath || '';
      renderProjectsView();
      refreshProjectsContexts([proj]);
    };

    const unsub = store.subscribe(() => {
      if (disposed || !projectsViewOpen) {
        clearNewProjectWatcher();
        return;
      }
      const st = store.getState();
      const isOpen = Boolean(st && st.newProject && st.newProject.isOpen);
      if (isOpen) {
        sawDialogOpen = true;
        if (closeGraceTimer) {
          clearTimeout(closeGraceTimer);
          closeGraceTimer = 0;
        }
      }
      const curProjects = collectNativeProjects();
      const created = curProjects.find((p) => p.id && !beforeIds.has(p.id));
      if (created) {
        focusProjectInOverlay(created);
        return;
      }
      const nextSearchProj = readSearchProj();
      if (sawDialogOpen && !isOpen && nextSearchProj && nextSearchProj !== beforeSearchProj) {
        const selectedExisting = curProjects.find((p) => p.id === nextSearchProj);
        if (selectedExisting) {
          focusProjectInOverlay(selectedExisting);
          return;
        }
      }
      if (sawDialogOpen && !isOpen && !closeGraceTimer) {
        closeGraceTimer = later(() => {
          clearNewProjectWatcher();
        }, 2500);
      }
    });

    const maxTimer = later(() => {
      clearNewProjectWatcher();
    }, 300000);

    newProjectWatchCleanup = () => {
      if (closeGraceTimer) {
        clearTimeout(closeGraceTimer);
        closeGraceTimer = 0;
      }
      if (maxTimer) clearTimeout(maxTimer);
      if (typeof unsub === 'function') unsub();
    };
  }

  function triggerNativeNewProject() {
    const addBtn = document.querySelector('[data-testid="sidebar-add-project-button"]');
    const { store, bindings } = resolveProjectsStoreAndBindings();
    const directEntryAction = findNativeNewProjectEntryAction(addBtn);
    const st = store && typeof store.getState === 'function' ? store.getState() : null;
    const hasNewProjectSlice = Boolean(
      st && st.newProject && typeof st.newProject === 'object' && store && typeof store.dispatch === 'function'
    );

    if (directEntryAction) {
      armNewProjectCompletionWatcher(store, bindings);
      directEntryAction();
      return;
    }

    if (hasNewProjectSlice) {
      armNewProjectCompletionWatcher(store, bindings);
      store.dispatch({ type: 'newProject/reset' });
      store.dispatch({ type: 'newProject/setCurrentStep', payload: 'folderSelection' });
      store.dispatch({ type: 'newProject/setIsOpen', payload: true });
      return;
    }

    if (!addBtn) return;

    const isMultiMenuTrigger =
      addBtn.hasAttribute('data-base-ui-click-trigger') ||
      addBtn.getAttribute('aria-haspopup') === 'dialog' ||
      addBtn.getAttribute('aria-haspopup') === 'menu';

    if (isMultiMenuTrigger) {
      armNewProjectCompletionWatcher(store, bindings);
      addBtn.click();
      later(() => {
        if (disposed) return;
        const popups = document.querySelectorAll('[data-popover-popup], [role="menu"], [role="dialog"]');
        for (const pop of popups) {
          if (!pop || pop.closest('#ag-claude-project-modal, #ag-claude-projects-view, .agy-dialog')) continue;
          const items = pop.querySelectorAll('button, [role="menuitem"], [role="option"], .main-row-trigger');
          for (const item of items) {
            const txt = String(item.textContent || '').trim();
            if (/^(new project|create(?: new)? project|新建项目)$/i.test(txt)) {
              item.click();
              return;
            }
          }
        }
      }, 24);
      return;
    }

    closeProjectsView();
    addBtn.click();
  }

  function openConversationFromProject(cid) {
    const { bindings } = resolveProjectsStoreAndBindings();
    closeProjectsView();
    if (cid) navigateSidebarConversation(cid, bindings);
  }

  function buildFallbackMediaObjects(mediaList) {
    const zeroTs = typeof BigInt === 'function' ? BigInt(0) : 0;
    return mediaList.map((m) => ({
      $typeName: 'exa.codeium_common_pb.Media',
      mimeType: m.mimeType || 'image/png',
      description: m.name || 'pasted-image.png',
      payload: { case: 'inlineData', value: m.bytes || new Uint8Array(0) },
      uri: '',
      thumbnail: m.bytes || new Uint8Array(0),
      durationSeconds: 0,
      mediaId: '',
      displayName: '',
      startTimeMs: zeroTs,
      endTimeMs: zeroTs,
      fps: 0,
      mediaResolution: 0,
      contentLayers: [],
      documentContentLayers: [],
      visibleCells: '',
      spreadsheetContentLayers: []
    }));
  }

  function startNewChatInProject(project, initialPrompt = '', mentionEntries = [], mediaEntries = []) {
    const { store, bindings } = resolveProjectsStoreAndBindings();
    const prompt = String(initialPrompt || '').trim();
    const submitChunks = buildComposerSubmitChunks(prompt, mentionEntries);
    const mediaList = Array.isArray(mediaEntries) ? mediaEntries.filter(Boolean) : [];
    const prevInputBox = document.getElementById('antigravity.agentSidePanelInputBox');
    const prevPath =
      bindings && bindings.router && bindings.router.state && bindings.router.state.location
        ? bindings.router.state.location.pathname
        : '';
    const wasOnHome = prevPath === '/';

    if (store && typeof store.dispatch === 'function' && project && project.id) {
      try {
        store.dispatch({ type: 'newConvoResourceSelector/setMagicWorkspaceSelected', payload: false });
        store.dispatch({ type: 'newConvoResourceSelector/setPseudoProjectSelected', payload: false });
        store.dispatch({ type: 'newConvoResourceSelector/setLastSelectedProject', payload: project.id });
      } catch {}
    }
    if (modelPopoverOpen) closeClaudeModelPopover();
    closeProjectsView();
    if (bindings && bindings.router && typeof bindings.router.navigate === 'function') {
      try {
        bindings.router.navigate({
          to: '/',
          search: project && project.id ? { project: project.id } : {}
        });
      } catch {}
    } else {
      const newBtn = document.querySelector('[data-testid="new-conversation-button"]');
      if (newBtn) newBtn.click();
    }

    if (!submitChunks.length && !mediaList.length) return;
    let tries = 0;
    let landedAtTry = -1;
    let submitting = false;
    const trySubmit = () => {
      if (disposed || submitting) return;
      const loc = bindings && bindings.router && bindings.router.state && bindings.router.state.location;
      const atHome = !loc || loc.pathname === '/';
      const projectMatched = !loc || !project || !project.id || (loc.search && loc.search.project === project.id);
      const box = document.getElementById('antigravity.agentSidePanelInputBox');
      const readyDom = Boolean(box && (wasOnHome || box !== prevInputBox || tries >= 16));
      if (!atHome || !projectMatched || !readyDom) {
        if (++tries < 35) later(trySubmit, 70);
        return;
      }
      /* Give the newly mounted Home composer one extra tick so its project & workspace hooks settle */
      if (landedAtTry === -1) {
        landedAtTry = tries;
        later(trySubmit, 140);
        return;
      }
      let handleSubmit = null;
      let inputBoxRef = null;
      let f = activeReactFiber(box);
      for (let d = 0; f && d < 36 && (!handleSubmit || !inputBoxRef); d++, f = f.return) {
        const mp = f.memoizedProps;
        if (!handleSubmit && mp && typeof mp.handleSubmit === 'function') {
          handleSubmit = mp.handleSubmit;
        }
        if (!inputBoxRef && mp && mp.inputBoxRef && mp.inputBoxRef.current) {
          inputBoxRef = mp.inputBoxRef.current;
        }
      }
      if (handleSubmit) {
        submitting = true;
        (async () => {
          let resolvedMedia = [];
          if (mediaList.length) {
            if (
              inputBoxRef &&
              typeof inputBoxRef.attachFiles === 'function' &&
              typeof inputBoxRef.getMediaAttachments === 'function'
            ) {
              try {
                if (typeof inputBoxRef.setMediaAttachments === 'function') {
                  inputBoxRef.setMediaAttachments([]);
                }
                const filesToAttach = mediaList.map((m) =>
                  typeof File === 'function' && !(m.file instanceof File)
                    ? new File([m.bytes || new Uint8Array(0)], m.name || 'pasted-image.png', {
                        type: m.mimeType || 'image/png'
                      })
                    : m.file
                );
                await inputBoxRef.attachFiles(filesToAttach);
                const deadline = Date.now() + 1500;
                while (Date.now() < deadline) {
                  const curAtt = inputBoxRef.getMediaAttachments() || [];
                  if (curAtt.length >= filesToAttach.length && curAtt.every((a) => Boolean(a && a.uri))) {
                    break;
                  }
                  await new Promise((r) => setTimeout(r, 40));
                }
                resolvedMedia = (inputBoxRef.getMediaAttachments() || []).slice();
              } catch {}
            }
            if (!resolvedMedia.length) {
              resolvedMedia = buildFallbackMediaObjects(mediaList);
            }
          }
          const clearEditor = () => {
            if (inputBoxRef && typeof inputBoxRef.setMediaAttachments === 'function') {
              try {
                inputBoxRef.setMediaAttachments([]);
                if (typeof inputBoxRef.forgetTrackedUploads === 'function') {
                  inputBoxRef.forgetTrackedUploads();
                }
              } catch {}
            }
          };
          try {
            await handleSubmit(submitChunks, resolvedMedia, clearEditor);
          } catch {} finally {
            if (mediaList.length) clearEditor();
          }
        })();
        return;
      }
      if (++tries < 35) later(trySubmit, 70);
    };
    later(trySubmit, 110);
  }

  async function saveProjectContextDelta(project, mutator) {
    if (!project || !project.dirPath || projectsContextBusy || typeof window.__agProjectCall !== 'function') {
      return { ok: false, error: 'busy_or_unavailable' };
    }
    projectsContextBusy = true;
    try {
      let cur = projectsContextMap[project.dirPath];
      if (!cur || !cur.ok) {
        cur = await window.__agProjectCall('readContext', { dirPath: project.dirPath }, 8000);
      }
      const existingFiles = (cur && Array.isArray(cur.files) ? cur.files : []).map((f) => ({
        action: 'keep',
        relPath: f.relPath,
        name: f.name,
        absPath: f.absPath
      }));
      const existingFolders = (cur && Array.isArray(cur.extraFolders) ? cur.extraFolders : []).map((f) => ({
        name: f.name,
        absPath: f.absPath
      }));
      const draft = {
        instructions: (cur && cur.instructions) || '',
        files: existingFiles,
        extraFolders: existingFolders
      };
      const updated =
        typeof mutator === 'function'
          ? mutator(draft)
          : mutator && typeof mutator === 'object'
            ? Object.assign({}, draft, mutator)
            : null;
      if (!updated) return { ok: true, skipped: true };
      const saved = await window.__agProjectCall(
        'saveContext',
        {
          dirPath: project.dirPath,
          instructions: updated.instructions,
          files: updated.files.map((x) =>
            x.action === 'keep'
              ? { action: 'keep', relPath: x.relPath, name: x.name }
              : x.action === 'add'
                ? { action: 'add', sourcePath: x.sourcePath, name: x.name }
                : { action: 'addContent', name: x.name, base64: x.base64 }
          ),
          extraFolders: updated.extraFolders
        },
        30000
      );
      if (!disposed && saved && saved.ok) {
        projectsContextMap[project.dirPath] = saved;
        if (projectsViewOpen) renderProjectsView();
      }
      return saved || { ok: false, error: 'save_failed' };
    } finally {
      projectsContextBusy = false;
    }
  }

  async function saveFilesDeltaForProject(project, mutator) {
    return saveProjectContextDelta(project, (draft) => {
      const nextFiles = mutator(draft.files);
      if (!nextFiles) return null;
      return Object.assign({}, draft, { files: nextFiles });
    });
  }

  async function pickAndAddFolderToProject(project) {
    if (!project || !project.dirPath || typeof window.__agProjectCall !== 'function') return;
    const picked = await window.__agProjectCall('pickFolder', {}, 120000);
    if (disposed || !picked || !picked.ok || picked.canceled || !picked.folderPath) return;
    const fp = picked.folderPath;
    if (fp === project.dirPath) {
      projectSelectedFolderPath = fp;
      projectFolderDropdownOpen = false;
      if (projectsViewOpen) renderProjectsView();
      return;
    }
    await saveProjectContextDelta(project, (draft) => {
      const next = draft.extraFolders.slice();
      if (!next.some((f) => f.absPath === fp)) {
        next.push({ name: picked.name || fp.split(/[\\/]/).pop() || fp, absPath: fp });
      }
      return Object.assign({}, draft, { extraFolders: next });
    });
    projectSelectedFolderPath = fp;
    projectFolderDropdownOpen = false;
    if (projectsViewOpen) renderProjectsView();
  }

  async function removeExtraFolderFromProject(project, absPath) {
    if (!project || !absPath) return;
    if (projectSelectedFolderPath === absPath) projectSelectedFolderPath = project.dirPath;
    await saveProjectContextDelta(project, (draft) =>
      Object.assign({}, draft, { extraFolders: draft.extraFolders.filter((f) => f.absPath !== absPath) })
    );
  }

  async function pickAndAddFilesToProject(project) {
    if (!project || !project.dirPath || typeof window.__agProjectCall !== 'function') return;
    const picked = await window.__agProjectCall('pickFiles', {}, 120000);
    if (disposed || !picked || !picked.ok || !Array.isArray(picked.paths) || !picked.paths.length) return;
    await saveFilesDeltaForProject(project, (ops) => {
      const next = ops.slice();
      for (const p of picked.paths) {
        if (!next.some((x) => x.absPath === p || x.sourcePath === p)) {
          next.push({ action: 'add', sourcePath: p, name: p.split(/[\\/]/).pop() || p });
        }
      }
      return next;
    });
  }

  async function addDroppedFilesToProject(project, fileList) {
    if (!project || !project.dirPath || !fileList || !fileList.length) return;
    const en = window.electronNative;
    const additions = [];
    for (const f of Array.from(fileList)) {
      if (!f) continue;
      let realPath = '';
      if (en && typeof en.getPathForFile === 'function') {
        try {
          realPath = en.getPathForFile(f) || '';
        } catch {}
      }
      if (!realPath && typeof f.path === 'string' && f.path) realPath = f.path;
      if (realPath) {
        additions.push({ action: 'add', sourcePath: realPath, name: f.name || realPath.split(/[\\/]/).pop() });
      } else if (typeof FileReader !== 'undefined' && f.size <= 25 * 1024 * 1024) {
        const b64 = await new Promise((resolve) => {
          const reader = new FileReader();
          reader.onload = () => {
            const s = String(reader.result || '');
            const i = s.indexOf(',');
            resolve(i >= 0 ? s.slice(i + 1) : '');
          };
          reader.onerror = () => resolve('');
          reader.readAsDataURL(f);
        });
        if (b64) additions.push({ action: 'addContent', name: f.name, base64: b64 });
      }
    }
    if (!additions.length) return;
    await saveFilesDeltaForProject(project, (ops) => ops.concat(additions));
  }

  async function removeFileFromProject(project, relPath) {
    if (!project || !relPath) return;
    await saveFilesDeltaForProject(project, (ops) => ops.filter((x) => x.relPath !== relPath));
  }

  async function refreshProjectsContexts(projects) {
    if (typeof window.__agProjectCall !== 'function') return;
    const paths = projects.map((p) => p.dirPath).filter(Boolean);
    const projectIds = projects.map((p) => p.id).filter(Boolean);
    if (!paths.length && !projectIds.length) return;
    const res = await window.__agProjectCall('listContexts', { paths, projectIds }, 8000);
    if (disposed || !res || !res.ok) return;
    if (res.contexts) projectsContextMap = Object.assign({}, projectsContextMap, res.contexts);
    if (res.projectMtimes) projectsNativeMtimeMap = Object.assign({}, projectsNativeMtimeMap, res.projectMtimes);
    if (projectsViewOpen) renderProjectsView();
  }

  function ensureProjectsViewEl() {
    if (projectsViewEl && projectsViewEl.isConnected) return projectsViewEl;
    const el = document.createElement('section');
    el.id = 'ag-claude-projects-view';
    el.setAttribute('data-ag-i18n-ignore', '1');
    el.setAttribute('data-open', 'false');
    el.setAttribute('aria-label', L('项目工作区', 'Projects Workspace'));
    document.body.appendChild(el);
    projectsViewEl = el;
    return el;
  }

  function renderProjectDetailView(el, project) {
    const hasLocalDir = Boolean(project.dirPath);
    const ctx = hasLocalDir ? projectsContextMap[project.dirPath] : null;
    const instructions = ctx && typeof ctx.instructions === 'string' ? ctx.instructions.trim() : '';
    const files = ctx && Array.isArray(ctx.files) ? ctx.files : [];
    const extraFolders = ctx && Array.isArray(ctx.extraFolders) ? ctx.extraFolders : [];
    const allFolders = hasLocalDir
      ? [
          { name: project.name, absPath: project.dirPath, primary: true },
          ...extraFolders.map((f) => ({ name: f.name || f.absPath.split(/[\\/]/).pop(), absPath: f.absPath, primary: false }))
        ]
      : [];
    const activeFolder = allFolders.length
      ? allFolders.find((f) => f.absPath === projectSelectedFolderPath) || allFolders[0]
      : { name: project.name, absPath: '', primary: true };
    const folderTriggerLabel =
      extraFolders.length > 0 && activeFolder.primary
        ? FEAT.i18n
          ? `${activeFolder.name}（+${extraFolders.length} 个文件夹）`
          : `${activeFolder.name} (+${extraFolders.length})`
        : activeFolder.name;

    const modelParts = formatProjectComposerModelParts(buildReduxModelSelectorApi() || discoverModelSelectorApi());

    const chatsHtml = project.chats.length
      ? project.chats
          .map((c) => {
            const statusDot = c.waiting
              ? `<span class="ag-pd-dot ag-pd-dot-wait" title="${escapeHtml(L('待确认', 'Waiting'))}"></span>`
              : c.running
                ? `<span class="ag-pd-dot ag-pd-dot-run" title="${escapeHtml(L('运行中', 'Running'))}"></span>`
                : '';
            const pinBadge = c.pinned
              ? `<span class="ag-pd-chat-pin" title="${escapeHtml(L('已置顶', 'Pinned'))}">${RECENT_PIN_SVG}</span>`
              : '';
            const timeTxt = c.lastSec ? formatProjectTimeAgo(c.lastSec) : '';
            return `<button type="button" class="ag-pd-chat-row" data-ag-pd-chat="${escapeHtml(c.id)}">
              <div class="ag-pd-chat-main">
                <span class="ag-pd-chat-title">${statusDot}${pinBadge}${escapeHtml(c.title)}</span>
              </div>
              <span class="ag-pd-chat-time">${escapeHtml(timeTxt)}</span>
            </button>`;
          })
          .join('')
      : `<div class="ag-pd-chat-empty">${L(
          '这个项目下还没有历史对话，在上方输入内容即可直接开始第一场对话。',
          'No conversations in this project yet. Start one above.'
        )}</div>`;

    const instBodyHtml = instructions
      ? `<div class="ag-pd-inst-preview">${escapeHtml(instructions)}</div>`
      : `<div class="ag-pd-card-muted">${L(
          '添加项目指令，定制 AI 在本项目中的工作方式与背景约束',
          'Add instructions to tailor responses in this project'
        )}</div>`;

    const filesBodyHtml = files.length
      ? `<div class="ag-pd-file-list">${files
          .map((f) => {
            const modeTag = f.inlined
              ? `<span class="ag-pm-tag ag-pm-tag-inline">${L('自动内联', 'Inline')}</span>`
              : `<span class="ag-pm-tag">${L('按需读取', 'On-demand')}</span>`;
            return `<div class="ag-pd-file-row">
              <button type="button" class="ag-pd-file-name" data-ag-pd-reveal-file="${escapeHtml(f.absPath || '')}" title="${escapeHtml(f.absPath || f.name)}">${escapeHtml(f.name)}</button>
              <span class="ag-pd-file-meta">${modeTag}<span>${escapeHtml(f.sizeText || '')}</span></span>
              <button type="button" class="ag-pd-file-del" data-ag-pd-rm-file="${escapeHtml(f.relPath)}" aria-label="${escapeHtml(L('移除文件', 'Remove file'))}">×</button>
            </div>`;
          })
          .join('')}</div>`
      : `<div class="ag-pd-card-muted">${L(
          '尚未添加参考文件。点右上角 + 或直接把文件拖到这里。',
          'No context added yet. Click + or drop files here.'
        )}</div>`;

    const scheduledTasks = ctx && Array.isArray(ctx.scheduledTasks) ? ctx.scheduledTasks : [];
    const formatSchedFreq = (t) => {
      const f = String((t && t.frequency) || 'manual');
      if (f === 'manual') return L('手动', 'Manual');
      if (f === 'hourly') return `${L('每小时', 'Hourly')} :${String(t.minute || 0).padStart(2, '0')}`;
      if (f === 'daily') return `${L('每天', 'Daily')} ${t.time || '09:00'}`;
      if (f === 'weekdays') return `${L('工作日', 'Weekdays')} ${t.time || '09:00'}`;
      if (f === 'weekly') {
        const dowsZh = ['日', '一', '二', '三', '四', '五', '六'];
        const dowsEn = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
        const idx = Math.min(6, Math.max(0, Number(t.dayOfWeek) || 1));
        return `${L(`每周${dowsZh[idx]}`, `Weekly ${dowsEn[idx]}`)} ${t.time || '09:00'}`;
      }
      return t.customCron || 'Cron';
    };
    const hasSyncedCron = scheduledTasks.some((t) => t && t.frequency !== 'manual');
    const scheduledBodyHtml = scheduledTasks.length
      ? `<div class="ag-pd-sched-list">${scheduledTasks
          .map((t) => {
            const freqLabel = formatSchedFreq(t);
            const isAuto = t.frequency && t.frequency !== 'manual';
            return `<div class="ag-pd-sched-row" data-ag-pd-sched-id="${escapeHtml(t.id)}">
              <button type="button" class="ag-pd-sched-main" data-ag-pd-edit-sched="${escapeHtml(t.id)}" title="${escapeHtml(t.description || t.name)}">
                <div class="ag-pd-sched-top">
                  <span class="ag-pd-sched-name">${escapeHtml(t.name)}</span>
                  <span class="ag-pm-tag${isAuto ? ' ag-pm-tag-inline' : ''}">${escapeHtml(freqLabel)}</span>
                </div>
                ${t.description ? `<div class="ag-pd-sched-desc">${escapeHtml(t.description)}</div>` : ''}
              </button>
              <button type="button" class="ag-pd-sched-run" data-ag-pd-run-sched="${escapeHtml(t.id)}" title="${escapeHtml(L('立即运行一次', 'Run now'))}" aria-label="${escapeHtml(L('立即运行', 'Run now'))}">▶</button>
              <button type="button" class="ag-pd-file-del" data-ag-pd-del-sched="${escapeHtml(t.id)}" aria-label="${escapeHtml(L('删除定时任务', 'Delete scheduled task'))}">×</button>
            </div>`;
          })
          .join('')}</div>${
          hasSyncedCron
            ? `<button type="button" class="ag-pd-sched-auto-link" data-ag-pd-open-automations="true">${L(
                '在「自动化任务」中启用与管理 ↗',
                'Enable & manage in Automations ↗'
              )}</button>`
            : ''
        }`
      : `<div class="ag-pd-card-muted">${L(
          '为这个项目设置定期自动执行的任务。',
          'Set up recurring tasks for this project.'
        )}</div>`;

    const fq = projectFolderSearch.trim().toLowerCase();
    const filteredFolders = allFolders.filter(
      (f) => !fq || f.name.toLowerCase().includes(fq) || f.absPath.toLowerCase().includes(fq)
    );
    const folderMenuHtml = projectFolderDropdownOpen
      ? `<div class="ag-pd-folder-menu" data-ag-pd-folder-menu="true">
          <div class="ag-pd-fm-search">
            ${SVG_PROJ_SEARCH_ICON}
            <input id="ag-pd-fm-search-input" type="search" value="${escapeHtml(projectFolderSearch)}" placeholder="${escapeHtml(L('搜索文件夹…', 'Search folders…'))}" />
          </div>
          <div class="ag-pd-fm-list">${filteredFolders
            .map((fld) => {
              const isSelected = fld.absPath === activeFolder.absPath;
              return `<div class="ag-pd-fm-item" data-selected="${isSelected ? 'true' : 'false'}" data-ag-pd-select-folder="${escapeHtml(fld.absPath)}">
                <span class="ag-pd-fm-icon">${SVG_PROJ_FOLDER_OPEN}</span>
                <div class="ag-pd-fm-text">
                  <div class="ag-pd-fm-name">${escapeHtml(fld.name)}${fld.primary ? ` <span class="ag-pd-fm-badge">${L('主目录', 'Primary')}</span>` : ''}</div>
                  <div class="ag-pd-fm-path">${escapeHtml(fld.absPath)}</div>
                </div>
                ${
                  fld.primary
                    ? ''
                    : `<button type="button" class="ag-pd-file-del" data-ag-pd-rm-folder="${escapeHtml(fld.absPath)}" aria-label="${escapeHtml(L('移除文件夹', 'Remove folder'))}">×</button>`
                }
              </div>`;
            })
            .join('')}</div>
          <div class="ag-pd-fm-divider"></div>
          <button type="button" class="ag-pd-fm-add" data-ag-pd-add-folder="true">
            ${SVG_PROJ_FOLDER_ADD}
            <span>${L('添加文件夹', 'Add folder')}</span>
          </button>
        </div>`
      : '';

    const prevFmSearch = el.querySelector('#ag-pd-fm-search-input');
    const hadFmFocus = prevFmSearch && document.activeElement === prevFmSearch;
    const fmSelStart = hadFmFocus ? prevFmSearch.selectionStart : null;

    const prevComp = el.getAttribute('data-ag-pd-proj-id') === project.id ? el.querySelector('#ag-pd-composer-input') : null;
    const hadCompFocus = Boolean(prevComp && document.activeElement === prevComp);
    const compSelStart = hadCompFocus ? prevComp.selectionStart : null;
    const compSelEnd = hadCompFocus ? prevComp.selectionEnd : null;
    if (prevComp) {
      if (prevComp.value) projectComposerDrafts.set(project.id, prevComp.value);
      else projectComposerDrafts.delete(project.id);
    }
    const savedDraft = projectComposerDrafts.get(project.id) || '';
    el.setAttribute('data-ag-pd-proj-id', project.id);

    el.innerHTML = `
      <div class="ag-pd-topbar">
        <nav class="ag-pd-breadcrumb" aria-label="Breadcrumb">
          <button type="button" class="ag-pd-crumb-root" data-ag-pd-back="true">${L('项目', 'Projects')}</button>
          <span class="ag-pd-crumb-sep">/</span>
          <span class="ag-pd-crumb-cur">${escapeHtml(project.name)}</span>
        </nav>
      </div>
      <div class="ag-pd-shell">
        <div class="ag-pd-title-row">
          <h1 class="ag-pd-title">${escapeHtml(project.name)}</h1>
          ${
            !project.isBuiltin
              ? `<button type="button" class="ag-pd-more-btn" data-ag-pd-proj-menu="true" aria-label="${escapeHtml(L('项目操作', 'Project options'))}" title="${escapeHtml(L('更多操作', 'More options'))}">${RECENT_MORE_SVG}</button>`
              : ''
          }
        </div>
        <div class="ag-pd-columns">
          <div class="ag-pd-left">
            <div class="ag-pd-composer-anchor">
              <div class="ag-pd-composer-wrap">
                <div class="ag-pd-composer-box" data-ag-pd-composer-box="true">
                  <div id="ag-pd-media-strip" class="ag-pd-media-strip" style="display:none"></div>
                  <div id="ag-pd-mention-pills" class="ag-pd-mention-pills" style="display:none"></div>
                  <textarea id="ag-pd-composer-input" class="ag-pd-composer-input" rows="2" placeholder="${escapeHtml(
                    L('想在这个项目里处理什么？（输入 @ 引用，支持直接粘贴图片）', 'What would you like to work on? (Type @ to mention, paste images directly)')
                  )}">${escapeHtml(savedDraft)}</textarea>
                  <div class="ag-pd-composer-foot">
                    ${
                      hasLocalDir
                        ? `<button type="button" class="ag-pd-composer-add" data-ag-pd-composer-add="true" title="${escapeHtml(L('添加参考文件到本项目', 'Add context files to project'))}" aria-label="${escapeHtml(L('添加参考文件', 'Add files'))}">${SVG_PROJ_PLUS}</button>`
                        : '<span></span>'
                    }
                    <div class="ag-pd-composer-right">
                      <button type="button" id="ag-pd-model-btn" class="ag-pd-model-btn" data-ag-pd-model-trigger="true" aria-haspopup="menu" aria-expanded="false">
                        <span class="ag-pd-model-name">${escapeHtml(modelParts.name)}</span>
                        <span class="ag-pd-model-effort"${modelParts.effort ? '' : ' style="display:none"'}>${escapeHtml(modelParts.effort)}</span>
                        <span class="ag-pd-model-chev">${SVG_PROJ_CHEVRON}</span>
                      </button>
                      <button type="button" class="ag-pd-send-btn" data-ag-pd-send="true" aria-label="${escapeHtml(L('发送', 'Send'))}" disabled>${SVG_PROJ_SEND_ARROW}</button>
                    </div>
                  </div>
                </div>
                ${
                  hasLocalDir
                    ? `<div class="ag-pd-folder-bar">
                        <button type="button" class="ag-pd-folder-trigger" data-ag-pd-folder-toggle="true" data-open="${projectFolderDropdownOpen ? 'true' : 'false'}" title="${escapeHtml(activeFolder.absPath)}">
                          <span class="ag-pd-folder-strip-icon">${SVG_CLAUDE_PROJECTS_ICON}</span>
                          <span class="ag-pd-folder-strip-path">${escapeHtml(folderTriggerLabel)}</span>
                          <span class="ag-pd-folder-chevron">${SVG_PROJ_CHEVRON}</span>
                        </button>
                      </div>`
                    : `<div class="ag-pd-folder-bar">
                        <span class="ag-pd-virtual-note">${SVG_CLAUDE_PROJECTS_ICON}<span>${
                          project.isCliProject
                            ? L('终端 CLI 会话分组（未绑定本地文件夹）', 'CLI session container (no local folder)')
                            : L('未绑定本地文件夹', 'No local folder linked')
                        }</span></span>
                      </div>`
                }
              </div>
              ${hasLocalDir ? folderMenuHtml : ''}
              <div id="ag-pd-mention-popover" class="ag-pd-mention-popover" role="listbox" data-open="false"></div>
            </div>

            <div class="ag-pd-recents">
              <div class="ag-pd-recents-hdr">${L('最近对话', 'Recents')}</div>
              <div class="ag-pd-chat-list">${chatsHtml}</div>
            </div>
          </div>

          <aside class="ag-pd-right">
            <div class="ag-pd-sidecard">
              <div class="ag-pd-section"${hasLocalDir ? ' data-ag-pd-inst-sec="true"' : ''}>
                <div class="ag-pd-sec-hdr">
                  <span class="ag-pd-sec-title">${L('项目指令', 'Instructions')}</span>
                  ${
                    hasLocalDir
                      ? `<button type="button" class="ag-pd-sec-btn" data-ag-pd-edit-inst="true" aria-label="${escapeHtml(L('编辑项目指令', 'Edit instructions'))}">${
                          instructions ? SVG_PROJ_EDIT : SVG_PROJ_PLUS
                        }</button>`
                      : ''
                  }
                </div>
                ${
                  hasLocalDir
                    ? instBodyHtml
                    : `<div class="ag-pd-card-muted">${L('该分组无对应本地文件夹，暂不支持写入项目级 AGENTS.md。', 'Virtual container without a local folder.')}</div>`
                }
              </div>

              <div class="ag-pd-section${hasLocalDir ? ' ag-pd-drop-sec' : ''}"${hasLocalDir ? ' data-ag-pd-ctx-drop="true"' : ''}>
                <div class="ag-pd-sec-hdr">
                  <span class="ag-pd-sec-title">${L('参考文件', 'Context')}</span>
                  ${
                    hasLocalDir
                      ? `<button type="button" class="ag-pd-sec-btn" data-ag-pd-add-files="true" aria-label="${escapeHtml(L('添加参考文件', 'Add context files'))}">${SVG_PROJ_PLUS}</button>`
                      : ''
                  }
                </div>
                ${
                  hasLocalDir
                    ? filesBodyHtml
                    : `<div class="ag-pd-card-muted">${L('仅绑定本地文件夹的项目支持添加参考文件。', 'Available for projects linked to a local folder.')}</div>`
                }
              </div>

              <div class="ag-pd-section" data-ag-pd-sched-sec="true">
                <div class="ag-pd-sec-hdr">
                  <span class="ag-pd-sec-title">${L('定时任务', 'Scheduled')}</span>
                  ${
                    hasLocalDir
                      ? `<button type="button" class="ag-pd-sec-btn" data-ag-pd-add-sched="true" aria-label="${escapeHtml(L('创建定时任务', 'Create scheduled task'))}">${SVG_PROJ_PLUS}</button>`
                      : ''
                  }
                </div>
                ${
                  hasLocalDir
                    ? scheduledBodyHtml
                    : `<div class="ag-pd-card-muted">${L('仅绑定本地文件夹的项目支持创建项目定时任务。', 'Available for projects linked to a local folder.')}</div>`
                }
              </div>
            </div>
          </aside>
        </div>
      </div>
    `;

    const backBtn = el.querySelector('[data-ag-pd-back]');
    if (backBtn) {
      backBtn.addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation();
        closeProjectActionMenu();
        closePdMentionMenu();
        activeProjectId = null;
        projectFolderDropdownOpen = false;
        projectFolderSearch = '';
        projectSelectedFolderPath = '';
        renderProjectsView();
      });
    }

    const pdTitleRow = el.querySelector('.ag-pd-title-row');
    if (pdTitleRow && !project.isBuiltin) {
      pdTitleRow.addEventListener('contextmenu', (e) => {
        e.preventDefault();
        e.stopPropagation();
        openProjectActionMenu(project, e.clientX, e.clientY);
      });
    }

    const pdMoreBtn = el.querySelector('[data-ag-pd-proj-menu]');
    if (pdMoreBtn && !project.isBuiltin) {
      pdMoreBtn.addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation();
        const r = pdMoreBtn.getBoundingClientRect();
        openProjectActionMenu(project, Math.max(8, Math.round(r.right - 216)), Math.round(r.bottom + 6), pdMoreBtn);
      });
    }

    const folderToggleBtn = el.querySelector('[data-ag-pd-folder-toggle]');
    if (folderToggleBtn) {
      folderToggleBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        projectFolderDropdownOpen = !projectFolderDropdownOpen;
        if (!projectFolderDropdownOpen) projectFolderSearch = '';
        renderProjectsView();
      });
    }

    const fmSearchInput = el.querySelector('#ag-pd-fm-search-input');
    if (fmSearchInput) {
      if (hadFmFocus) {
        fmSearchInput.focus();
        if (typeof fmSelStart === 'number') {
          try {
            fmSearchInput.setSelectionRange(fmSelStart, fmSelStart);
          } catch {}
        }
      }
      fmSearchInput.addEventListener('input', () => {
        projectFolderSearch = fmSearchInput.value || '';
        renderProjectsView();
      });
    }

    el.querySelectorAll('[data-ag-pd-select-folder]').forEach((item) => {
      item.addEventListener('click', (e) => {
        if (e.target.closest('button')) return;
        projectSelectedFolderPath = item.getAttribute('data-ag-pd-select-folder') || project.dirPath;
        projectFolderDropdownOpen = false;
        projectFolderSearch = '';
        renderProjectsView();
      });
    });

    el.querySelectorAll('[data-ag-pd-add-folder]').forEach((b) => {
      b.addEventListener('click', (e) => {
        e.stopPropagation();
        pickAndAddFolderToProject(project);
      });
    });

    el.querySelectorAll('[data-ag-pd-rm-folder]').forEach((b) => {
      b.addEventListener('click', (e) => {
        e.stopPropagation();
        removeExtraFolderFromProject(project, b.getAttribute('data-ag-pd-rm-folder'));
      });
    });

    const compAddBtn = el.querySelector('[data-ag-pd-composer-add]');
    if (compAddBtn) {
      compAddBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        pickAndAddFilesToProject(project);
      });
    }

    const compBox = el.querySelector('[data-ag-pd-composer-box]');
    const compInput = el.querySelector('#ag-pd-composer-input');
    const sendBtn = el.querySelector('[data-ag-pd-send]');
    const dispatchPrompt = () => {
      const raw = ((compInput && compInput.value) || '').trim();
      const mediaArr = (getProjectMediaList(project.id, false) || []).slice();
      if (!raw && !mediaArr.length) return;
      const mMap = getProjectMentionMap(project.id, false);
      const mentionEntries = mMap ? [...mMap.values()] : [];
      projectComposerDrafts.delete(project.id);
      projectComposerMedia.delete(project.id);
      if (mMap) mMap.clear();
      closePdMentionMenu();
      const finalPrompt =
        activeFolder && !activeFolder.primary && activeFolder.absPath
          ? raw
            ? `[${L('关联文件夹', 'Linked folder')}: ${activeFolder.absPath}]\n${raw}`
            : `[${L('关联文件夹', 'Linked folder')}: ${activeFolder.absPath}]`
          : raw;
      startNewChatInProject(project, finalPrompt, mentionEntries, mediaArr);
    };
    if (compInput && sendBtn) {
      if (compInput.value !== savedDraft) compInput.value = savedDraft;
      const syncSend = () => {
        if (compInput.value) projectComposerDrafts.set(project.id, compInput.value);
        else projectComposerDrafts.delete(project.id);
        const hasMedia = Boolean((getProjectMediaList(project.id, false) || []).length);
        sendBtn.disabled = !compInput.value.trim() && !hasMedia;
        syncPdMediaStrip(project, () => {
          const stillHasMedia = Boolean((getProjectMediaList(project.id, false) || []).length);
          sendBtn.disabled = !compInput.value.trim() && !stillHasMedia;
        });
        syncPdMentionPills(project, compInput);
        compInput.style.height = 'auto';
        compInput.style.height = `${Math.min(180, Math.max(48, compInput.scrollHeight))}px`;
      };
      syncSend();
      if (hadCompFocus && !hadFmFocus) {
        compInput.focus();
        if (typeof compSelStart === 'number' && typeof compSelEnd === 'number') {
          try {
            compInput.setSelectionRange(compSelStart, compSelEnd);
          } catch {}
        }
      }
      if (pdMentionState.open && pdMentionState.projectId === project.id) {
        renderPdMentionPopover();
      }
      compInput.addEventListener('input', () => {
        syncSend();
        updatePdMentionMenuForInput(project, compInput);
      });
      compInput.addEventListener('click', () => {
        updatePdMentionMenuForInput(project, compInput);
      });
      compInput.addEventListener('paste', (e) => {
        const imgs = extractComposerImageFiles(e.clipboardData);
        if (!imgs.length) return;
        e.preventDefault();
        e.stopPropagation();
        stagePdComposerImageFiles(project, imgs, syncSend);
      });
      if (compBox) {
        compBox.addEventListener('dragover', (e) => {
          if (e.dataTransfer && Array.from(e.dataTransfer.types || []).includes('Files')) {
            e.preventDefault();
            compBox.setAttribute('data-drag', 'true');
          }
        });
        compBox.addEventListener('dragleave', (e) => {
          if (!compBox.contains(e.relatedTarget)) {
            compBox.removeAttribute('data-drag');
          }
        });
        compBox.addEventListener('drop', (e) => {
          compBox.removeAttribute('data-drag');
          const imgs = extractComposerImageFiles(e.dataTransfer);
          if (!imgs.length) return;
          e.preventDefault();
          e.stopPropagation();
          stagePdComposerImageFiles(project, imgs, syncSend);
        });
      }
      compInput.addEventListener('keydown', (e) => {
        if (pdMentionState.open && !e.isComposing) {
          if (e.key === 'ArrowDown') {
            e.preventDefault();
            movePdMentionSelection(1);
            return;
          }
          if (e.key === 'ArrowUp') {
            e.preventDefault();
            movePdMentionSelection(-1);
            return;
          }
          if ((e.key === 'Enter' && !e.shiftKey) || e.key === 'Tab') {
            if (pdMentionState.items.length > 0) {
              e.preventDefault();
              e.stopPropagation();
              applyPdMentionSelection(pdMentionState.activeIndex);
              return;
            }
          }
          if (e.key === 'Escape') {
            e.preventDefault();
            e.stopPropagation();
            closePdMentionMenu();
            return;
          }
        }
        const hasMedia = Boolean((getProjectMediaList(project.id, false) || []).length);
        if (e.key === 'Enter' && !e.shiftKey && !e.isComposing && (compInput.value.trim() || hasMedia)) {
          e.preventDefault();
          dispatchPrompt();
        }
      });
      sendBtn.addEventListener('click', dispatchPrompt);
    }

    el.querySelectorAll('[data-ag-pd-chat]').forEach((btn) => {
      btn.addEventListener('click', () => {
        openConversationFromProject(btn.getAttribute('data-ag-pd-chat'));
      });
    });

    const editInstBtn = el.querySelector('[data-ag-pd-edit-inst]');
    const instSec = el.querySelector('[data-ag-pd-inst-sec]');
    const openInst = () => openProjectInstructionsModal(project);
    if (editInstBtn) editInstBtn.addEventListener('click', (e) => (e.stopPropagation(), openInst()));
    if (instSec) {
      instSec.addEventListener('click', (e) => {
        if (!e.target.closest('button')) openInst();
      });
    }

    const addFilesBtn = el.querySelector('[data-ag-pd-add-files]');
    if (addFilesBtn) {
      addFilesBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        pickAndAddFilesToProject(project);
      });
    }

    const dropSec = el.querySelector('[data-ag-pd-ctx-drop]');
    if (dropSec) {
      dropSec.addEventListener('dragover', (e) => {
        e.preventDefault();
        dropSec.setAttribute('data-drag', 'true');
      });
      dropSec.addEventListener('dragleave', () => dropSec.removeAttribute('data-drag'));
      dropSec.addEventListener('drop', (e) => {
        e.preventDefault();
        dropSec.removeAttribute('data-drag');
        if (e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files.length) {
          addDroppedFilesToProject(project, e.dataTransfer.files);
        }
      });
    }

    el.querySelectorAll('[data-ag-pd-reveal-file]').forEach((b) => {
      b.addEventListener('click', () => {
        const p = b.getAttribute('data-ag-pd-reveal-file');
        if (p && typeof window.__agProjectCall === 'function') {
          window.__agProjectCall('revealFile', { dirPath: project.dirPath, targetPath: p }, 5000);
        }
      });
    });

    el.querySelectorAll('[data-ag-pd-rm-file]').forEach((b) => {
      b.addEventListener('click', (e) => {
        e.stopPropagation();
        removeFileFromProject(project, b.getAttribute('data-ag-pd-rm-file'));
      });
    });

    const addSchedBtn = el.querySelector('[data-ag-pd-add-sched]');
    if (addSchedBtn) {
      addSchedBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        openProjectScheduledModal(project, null);
      });
    }

    const schedById = new Map(scheduledTasks.map((t) => [t.id, t]));
    el.querySelectorAll('[data-ag-pd-edit-sched]').forEach((b) => {
      b.addEventListener('click', () => {
        const task = schedById.get(b.getAttribute('data-ag-pd-edit-sched'));
        if (task) openProjectScheduledModal(project, task);
      });
    });

    el.querySelectorAll('[data-ag-pd-run-sched]').forEach((b) => {
      b.addEventListener('click', (e) => {
        e.stopPropagation();
        const task = schedById.get(b.getAttribute('data-ag-pd-run-sched'));
        if (task) runProjectScheduledTask(project, task);
      });
    });

    el.querySelectorAll('[data-ag-pd-del-sched]').forEach((b) => {
      b.addEventListener('click', (e) => {
        e.stopPropagation();
        const task = schedById.get(b.getAttribute('data-ag-pd-del-sched'));
        if (task) deleteProjectScheduledTaskFromUi(project, task);
      });
    });

    const openAutoBtn = el.querySelector('[data-ag-pd-open-automations]');
    if (openAutoBtn) {
      openAutoBtn.addEventListener('click', () => {
        closeProjectsView();
        const autoNav = document.querySelector('[data-testid="automations-button"]');
        if (autoNav) autoNav.click();
      });
    }
  }

  function renderProjectsView() {
    const el = ensureProjectsViewEl();
    const prevProjId = el.getAttribute('data-ag-pd-proj-id');
    const prevComp = prevProjId ? el.querySelector('#ag-pd-composer-input') : null;
    if (prevProjId && prevComp) {
      if (prevComp.value) projectComposerDrafts.set(prevProjId, prevComp.value);
      else projectComposerDrafts.delete(prevProjId);
    }
    const allProjects = collectNativeProjects();
    if (activeProjectId) {
      const target = allProjects.find((p) => p.id === activeProjectId);
      if (target) {
        renderProjectDetailView(el, target);
        return;
      }
      activeProjectId = null;
    }
    el.removeAttribute('data-ag-pd-proj-id');

    const q = projectsSearchQuery.trim().toLowerCase();
    const filtered = allProjects
      .filter((p) => !q || p.name.toLowerCase().includes(q) || p.shortPath.toLowerCase().includes(q))
      .sort((a, b) => {
        if (projectsSortMode === 'name') return a.name.localeCompare(b.name, 'zh-Hans-CN');
        const ctxA = a.dirPath ? projectsContextMap[a.dirPath] : null;
        const ctxB = b.dirPath ? projectsContextMap[b.dirPath] : null;
        const tA = Math.max(
          a.lastSec * 1000,
          Number(projectsNativeMtimeMap[a.id] || 0),
          ctxA ? Number(ctxA.lastModifiedMs || 0) : 0
        );
        const tB = Math.max(
          b.lastSec * 1000,
          Number(projectsNativeMtimeMap[b.id] || 0),
          ctxB ? Number(ctxB.lastModifiedMs || 0) : 0
        );
        return tB - tA || a.name.localeCompare(b.name, 'zh-Hans-CN');
      });

    const cardsHtml = filtered.length
      ? filtered
          .map((p) => {
            const ctx = p.dirPath ? projectsContextMap[p.dirPath] : null;
            const hasInst = Boolean(ctx && ctx.instructions && ctx.instructions.trim());
            const fileCount = ctx && Array.isArray(ctx.files) ? ctx.files.length : 0;
            const nativeProjMs = Number(projectsNativeMtimeMap[p.id] || 0);
            const ctxActivityMs = ctx ? Math.max(Number(ctx.lastModifiedMs || 0), Number(ctx.dirMtimeMs || 0)) : 0;
            const effectiveSec = p.lastSec || Math.floor(Math.max(nativeProjMs, ctxActivityMs) / 1000);
            const timeLabel = effectiveSec ? formatProjectTimeAgo(effectiveSec) : L('刚刚', 'now');
            const chatLabel = FEAT.i18n
              ? `${p.chatCount} 个对话`
              : `${p.chatCount} ${p.chatCount === 1 ? 'chat' : 'chats'}`;
            const metaText = `${timeLabel} · ${chatLabel}`;
            const badges = [];
            if (hasInst) badges.push(`<span class="ag-proj-badge ag-proj-badge-accent">${L('已设指令', 'Instructions')}</span>`);
            if (fileCount > 0) {
              badges.push(
                `<span class="ag-proj-badge">${FEAT.i18n ? `${fileCount} 个文件` : `${fileCount} ${fileCount === 1 ? 'file' : 'files'}`}</span>`
              );
            }
            const moreBtnHtml = !p.isBuiltin
              ? `<button type="button" class="ag-proj-card-more" data-ag-proj-menu="${escapeHtml(p.id)}" aria-label="${escapeHtml(L('项目操作', 'Project options'))}" title="${escapeHtml(L('更多操作', 'More options'))}">${RECENT_MORE_SVG}</button>`
              : '';
            const metaTitleAttr = p.shortPath ? ` title="${escapeHtml(p.shortPath)}"` : '';
            return `<article class="ag-proj-card" data-ag-proj-id="${escapeHtml(p.id)}" tabindex="0">
              <div class="ag-proj-card-head">
                <div class="ag-proj-card-title">${escapeHtml(p.name)}</div>
                ${moreBtnHtml}
              </div>
              <div class="ag-proj-card-foot">
                <span class="ag-proj-card-meta"${metaTitleAttr}>${escapeHtml(metaText)}</span>
                ${badges.length ? `<div class="ag-proj-card-badges">${badges.join('')}</div>` : ''}
              </div>
            </article>`;
          })
          .join('')
      : `<div class="ag-proj-empty">${
          q
            ? L(`没有匹配「${projectsSearchQuery}」的项目`, `No projects matching "${projectsSearchQuery}"`)
            : L('还没有本地项目文件夹，点击右上角「新建项目」添加一个吧。', 'No local project folders yet. Click "New project" to add one.')
        }</div>`;

    const sortLabel = projectsSortMode === 'recent' ? L('最近活跃', 'Recent') : L('按名称', 'Name');
    const prevSearchEl = el.querySelector('#ag-proj-search-input');
    const hadSearchFocus = prevSearchEl && document.activeElement === prevSearchEl;
    const selStart = hadSearchFocus ? prevSearchEl.selectionStart : null;

    el.innerHTML = `
      <div class="ag-proj-shell">
        <header class="ag-proj-header">
          <h1 class="ag-proj-heading">${L('项目', 'Projects')}</h1>
          <div class="ag-proj-header-controls">
            <label class="ag-proj-search-wrap">
              ${SVG_PROJ_SEARCH_ICON}
              <input id="ag-proj-search-input" type="search" value="${escapeHtml(projectsSearchQuery)}" placeholder="${escapeHtml(L('搜索项目…', 'Search projects…'))}" />
            </label>
            <button type="button" class="ag-proj-sort-btn" data-ag-proj-sort="true" title="${escapeHtml(L('切换排序方式', 'Toggle sort order'))}">⇅ ${escapeHtml(sortLabel)}</button>
            <button type="button" class="ag-proj-new-btn" data-ag-proj-new="true">${L('新建项目', 'New project')}</button>
          </div>
        </header>
        <div class="ag-proj-grid">${cardsHtml}</div>
      </div>
    `;

    const searchInput = el.querySelector('#ag-proj-search-input');
    if (searchInput) {
      if (hadSearchFocus) {
        searchInput.focus();
        if (typeof selStart === 'number') {
          try {
            searchInput.setSelectionRange(selStart, selStart);
          } catch {}
        }
      }
      searchInput.addEventListener('input', () => {
        projectsSearchQuery = searchInput.value || '';
        renderProjectsView();
      });
    }

    const sortBtn = el.querySelector('[data-ag-proj-sort]');
    if (sortBtn) {
      sortBtn.addEventListener('click', () => {
        projectsSortMode = projectsSortMode === 'recent' ? 'name' : 'recent';
        renderProjectsView();
      });
    }

    const newBtn = el.querySelector('[data-ag-proj-new]');
    if (newBtn) {
      newBtn.addEventListener('click', () => triggerNativeNewProject());
    }

    const byId = new Map(allProjects.map((p) => [p.id, p]));
    const enterProject = (proj) => {
      activeProjectId = proj.id;
      renderProjectsView();
      if (proj.dirPath && typeof window.__agProjectCall === 'function') {
        const prevSig = JSON.stringify(projectsContextMap[proj.dirPath] || null);
        window.__agProjectCall('readContext', { dirPath: proj.dirPath }, 8000).then((fresh) => {
          if (!disposed && fresh && fresh.ok) {
            projectsContextMap[proj.dirPath] = fresh;
            if (projectsViewOpen && activeProjectId === proj.id && JSON.stringify(fresh) !== prevSig) {
              renderProjectsView();
            }
          }
        });
      }
    };

    el.querySelectorAll('.ag-proj-card').forEach((card) => {
      const proj = byId.get(card.getAttribute('data-ag-proj-id'));
      if (!proj) return;
      card.addEventListener('click', (e) => {
        if (e.target && e.target.closest && e.target.closest('[data-ag-proj-menu]')) return;
        closeProjectActionMenu();
        enterProject(proj);
      });
      if (!proj.isBuiltin) {
        card.addEventListener('contextmenu', (e) => {
          e.preventDefault();
          e.stopPropagation();
          openProjectActionMenu(proj, e.clientX, e.clientY);
        });
        const moreBtn = card.querySelector('[data-ag-proj-menu]');
        if (moreBtn) {
          moreBtn.addEventListener('click', (e) => {
            e.preventDefault();
            e.stopPropagation();
            const r = moreBtn.getBoundingClientRect();
            openProjectActionMenu(proj, Math.max(8, Math.round(r.right - 216)), Math.round(r.bottom + 6), moreBtn);
          });
        }
      }
      card.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' && !(e.target && e.target.closest && e.target.closest('[data-ag-proj-menu]'))) {
          e.preventDefault();
          closeProjectActionMenu();
          enterProject(proj);
        }
      });
    });
  }

  async function openProjectInstructionsModal(project) {
    if (!project || !project.dirPath) return;
    closeProjectsModal();
    const cached = projectsContextMap[project.dirPath] || null;
    const modalRef = {
      kind: 'instructions',
      project,
      dirPath: project.dirPath,
      instructions: cached ? cached.instructions || '' : '',
      hasOtherAgentsMd: Boolean(cached && cached.hasOtherAgentsMd),
      userEdited: false,
      saving: false,
      error: ''
    };
    projectsModalState = modalRef;
    renderProjectContextModal();

    if (typeof window.__agProjectCall === 'function') {
      const fresh = await window.__agProjectCall('readContext', { dirPath: project.dirPath }, 8000);
      if (disposed || projectsModalState !== modalRef) return;
      if (fresh && fresh.ok) {
        projectsContextMap[project.dirPath] = fresh;
        const nextOther = Boolean(fresh.hasOtherAgentsMd);
        const needRender = !modalRef.userEdited || modalRef.hasOtherAgentsMd !== nextOther;
        if (!modalRef.userEdited) {
          modalRef.instructions = fresh.instructions || '';
        }
        modalRef.hasOtherAgentsMd = nextOther;
        if (needRender && !modalRef.userEdited) {
          renderProjectContextModal();
        }
      }
    }
  }

  function renderProjectContextModal() {
    if (!projectsModalState) return;
    if (!projectsModalEl || !projectsModalEl.isConnected) {
      projectsModalEl = document.createElement('div');
      projectsModalEl.id = 'ag-claude-project-modal';
      projectsModalEl.setAttribute('data-ag-i18n-ignore', '1');
      projectsModalEl.addEventListener('click', (e) => {
        if (e.target === projectsModalEl) closeProjectsModal();
      });
      document.body.appendChild(projectsModalEl);
    }

    const st = projectsModalState;
    const noteHtml = st.hasOtherAgentsMd
      ? `<div class="ag-pm-note">${L('检测到该目录已有 AGENTS.md，保存时仅更新 Anti-Claude 区块，保留你原有的全部规则。', 'Existing AGENTS.md detected — your custom rules outside the Anti-Claude block are preserved.')}</div>`
      : '';
    const errHtml = st.error ? `<div class="ag-pm-error">${escapeHtml(st.error)}</div>` : '';

    projectsModalEl.innerHTML = `
      <div class="ag-pm-dialog" role="dialog" aria-modal="true" aria-label="${escapeHtml(L('设置项目指令', 'Set project instructions'))}">
        <div class="ag-pm-hdr">
          <div class="ag-pm-title-wrap">
            <span class="ag-pm-icon">${SVG_CLAUDE_PROJECTS_ICON}</span>
            <h2 class="ag-pm-title">${escapeHtml(L('项目指令', 'Instructions'))} · ${escapeHtml(st.project.name)}</h2>
          </div>
          <button type="button" class="ag-pm-close" data-ag-pm-close="true" aria-label="${escapeHtml(L('关闭', 'Close'))}">×</button>
        </div>
        <p class="ag-pm-desc">${L(
          '填写在这个项目文件夹下每场对话自动遵循的背景、角色与规范。保存后写入项目 AGENTS.md，100% 本地生效。',
          'Define background context, style, and constraints applied automatically to every chat in this project (saved locally to AGENTS.md).'
        )}</p>
        <div class="ag-pm-field">
          <textarea id="ag-pm-instructions" class="ag-pm-textarea" rows="8" placeholder="${escapeHtml(
            L('例如：本项目是某案件卷宗/法考科目/工程报价，回答时请遵循……', 'Tell the agent how to work in this project…')
          )}">${escapeHtml(st.instructions)}</textarea>
          ${noteHtml}
        </div>
        ${errHtml}
        <div class="ag-pm-footer">
          <button type="button" class="ag-pm-secondary-btn" data-ag-pm-close="true">${L('取消', 'Cancel')}</button>
          <button type="button" class="ag-pm-primary-btn" data-ag-pm-save="true" ${st.saving ? 'disabled' : ''}>${
            st.saving ? L('保存中…', 'Saving…') : L('保存指令', 'Save instructions')
          }</button>
        </div>
      </div>
    `;

    const textarea = projectsModalEl.querySelector('#ag-pm-instructions');
    if (textarea) {
      textarea.focus();
      textarea.addEventListener('input', () => {
        if (projectsModalState) {
          projectsModalState.instructions = textarea.value;
          projectsModalState.userEdited = true;
        }
      });
    }

    projectsModalEl.querySelectorAll('[data-ag-pm-close]').forEach((b) => {
      b.addEventListener('click', () => closeProjectsModal());
    });

    const saveBtn = projectsModalEl.querySelector('[data-ag-pm-save]');
    if (saveBtn) {
      saveBtn.addEventListener('click', async () => {
        if (!projectsModalState || projectsModalState.saving) return;
        if (typeof window.__agProjectCall !== 'function') {
          projectsModalState.error = L('本地写入桥接不可用，请重启 Anti-Claude 守护进程', 'Local write bridge unavailable');
          renderProjectContextModal();
          return;
        }
        projectsModalState.saving = true;
        projectsModalState.error = '';
        renderProjectContextModal();
        /* Submit only `instructions` so in-flight context loads can never overwrite existing attachments or folders */
        const res = await window.__agProjectCall(
          'saveContext',
          {
            dirPath: projectsModalState.dirPath,
            instructions: projectsModalState.instructions
          },
          20000
        );
        if (disposed || !projectsModalState) return;
        if (res && res.ok) {
          projectsContextMap[projectsModalState.dirPath] = res;
          closeProjectsModal();
          if (projectsViewOpen) renderProjectsView();
        } else {
          projectsModalState.saving = false;
          projectsModalState.error = L('保存失败：', 'Save failed: ') + String((res && res.error) || 'unknown');
          renderProjectContextModal();
        }
      });
    }
  }

  function runProjectScheduledTask(project, task) {
    if (!project || !task) return;
    const raw = String(task.instructions || '').trim();
    if (!raw) return;
    const normProj = String(project.dirPath || '').replace(/\/+$/, '');
    const normTaskDir = String(task.folderPath || '').replace(/\/+$/, '');
    const finalPrompt =
      normTaskDir && normTaskDir !== normProj
        ? `[${L('关联文件夹', 'Linked folder')}: ${normTaskDir}]\n${raw}`
        : raw;
    startNewChatInProject(project, finalPrompt);
  }

  async function deleteProjectScheduledTaskFromUi(project, task) {
    if (!project || !project.dirPath || !task || typeof window.__agProjectCall !== 'function') return;
    const res = await window.__agProjectCall(
      'deleteScheduledTask',
      { dirPath: project.dirPath, taskId: task.id, sidecarId: task.sidecarId || '' },
      10000
    );
    if (!disposed && res && res.ok) {
      projectsContextMap[project.dirPath] = res;
      if (projectsViewOpen) renderProjectsView();
    }
  }

  function openProjectScheduledModal(project, existingTask = null) {
    if (!project || !project.dirPath) return;
    closeProjectsModal();
    const tz = (() => {
      try {
        return Intl.DateTimeFormat().resolvedOptions().timeZone || 'Asia/Shanghai';
      } catch {
        return 'Asia/Shanghai';
      }
    })();
    projectsModalState = {
      kind: 'scheduled',
      project,
      dirPath: project.dirPath,
      editingId: existingTask ? existingTask.id : '',
      sidecarId: existingTask ? existingTask.sidecarId || '' : '',
      name: existingTask ? existingTask.name || '' : '',
      description: existingTask ? existingTask.description || '' : '',
      instructions: existingTask ? existingTask.instructions || '' : '',
      folderPath: (existingTask && existingTask.folderPath) || projectSelectedFolderPath || project.dirPath,
      model: existingTask ? existingTask.model || '' : '',
      frequency: existingTask ? existingTask.frequency || 'manual' : 'manual',
      time: existingTask ? existingTask.time || '09:00' : '09:00',
      dayOfWeek: existingTask && Number.isFinite(Number(existingTask.dayOfWeek)) ? Number(existingTask.dayOfWeek) : 1,
      minute: existingTask && Number.isFinite(Number(existingTask.minute)) ? Number(existingTask.minute) : 0,
      customCron: existingTask ? existingTask.customCron || '0 9 * * *' : '0 9 * * *',
      timezone: (existingTask && existingTask.timezone) || tz,
      saving: false,
      error: ''
    };
    renderProjectScheduledModal();
  }

  function renderProjectScheduledModal() {
    if (!projectsModalState || projectsModalState.kind !== 'scheduled') return;
    if (!projectsModalEl || !projectsModalEl.isConnected) {
      projectsModalEl = document.createElement('div');
      projectsModalEl.id = 'ag-claude-project-modal';
      projectsModalEl.setAttribute('data-ag-i18n-ignore', '1');
      projectsModalEl.addEventListener('click', (e) => {
        if (e.target === projectsModalEl) closeProjectsModal();
      });
      document.body.appendChild(projectsModalEl);
    }

    const st = projectsModalState;
    const isEdit = Boolean(st.editingId);
    const ctx = projectsContextMap[st.dirPath] || null;
    const extraFolders = ctx && Array.isArray(ctx.extraFolders) ? ctx.extraFolders : [];
    const folderOptions = [
      { absPath: st.dirPath, label: `${st.project.name} (${L('主目录', 'Primary')})` },
      ...extraFolders.map((f) => ({ absPath: f.absPath, label: f.name || f.absPath }))
    ];
    if (st.folderPath && !folderOptions.some((o) => o.absPath === st.folderPath)) {
      const segs = st.folderPath.split('/').filter(Boolean);
      folderOptions.push({ absPath: st.folderPath, label: segs[segs.length - 1] || st.folderPath });
    }

    const modelOptions = [
      { value: '', label: L('默认模型', 'Default model') },
      { value: 'gemini-4-neon-high', label: 'Gemini 4 Neon High' },
      { value: 'gemini-4-argon-high', label: 'Gemini 4 Argon High' },
      { value: 'gemini-4-carbon-high', label: 'Gemini 4 Carbon High' },
      { value: 'gemini-4-hydrogen-low', label: 'Gemini 4 Hydrogen Low' }
    ];
    if (st.model && !modelOptions.some((m) => m.value === st.model)) {
      modelOptions.push({ value: st.model, label: st.model });
    }

    const freqOptions = [
      { value: 'manual', label: L('手动', 'Manual') },
      { value: 'hourly', label: L('每小时', 'Hourly') },
      { value: 'daily', label: L('每天', 'Daily') },
      { value: 'weekdays', label: L('工作日（周一至周五）', 'Weekdays (Mon–Fri)') },
      { value: 'weekly', label: L('每周', 'Weekly') },
      { value: 'custom', label: L('自定义 Cron', 'Custom cron') }
    ];

    let freqExtraHtml = '';
    if (st.frequency === 'hourly') {
      const mins = [0, 15, 30, 45];
      freqExtraHtml = `<select id="ag-sched-minute" class="ag-sched-select" aria-label="${escapeHtml(L('分钟', 'Minute'))}">${mins
        .map((m) => `<option value="${m}"${Number(st.minute) === m ? ' selected' : ''}>:${String(m).padStart(2, '0')}</option>`)
        .join('')}</select>`;
    } else if (st.frequency === 'daily' || st.frequency === 'weekdays') {
      freqExtraHtml = `<input id="ag-sched-time" class="ag-sched-time-input" type="time" value="${escapeHtml(st.time || '09:00')}" />`;
    } else if (st.frequency === 'weekly') {
      const days = [
        { v: 1, l: L('周一', 'Monday') },
        { v: 2, l: L('周二', 'Tuesday') },
        { v: 3, l: L('周三', 'Wednesday') },
        { v: 4, l: L('周四', 'Thursday') },
        { v: 5, l: L('周五', 'Friday') },
        { v: 6, l: L('周六', 'Saturday') },
        { v: 0, l: L('周日', 'Sunday') }
      ];
      freqExtraHtml = `<select id="ag-sched-dow" class="ag-sched-select" aria-label="${escapeHtml(L('星期', 'Day of week'))}">${days
        .map((d) => `<option value="${d.v}"${Number(st.dayOfWeek) === d.v ? ' selected' : ''}>${escapeHtml(d.l)}</option>`)
        .join('')}</select><input id="ag-sched-time" class="ag-sched-time-input" type="time" value="${escapeHtml(st.time || '09:00')}" />`;
    } else if (st.frequency === 'custom') {
      freqExtraHtml = `<input id="ag-sched-cron" class="ag-sched-cron-input" type="text" value="${escapeHtml(st.customCron || '0 9 * * *')}" placeholder="0 9 * * *" />`;
    }

    const canSave = Boolean(st.name.trim() && st.description.trim() && st.instructions.trim() && !st.saving);
    const errHtml = st.error ? `<div class="ag-pm-error">${escapeHtml(st.error)}</div>` : '';
    const autoHintHtml =
      st.frequency !== 'manual'
        ? `<div class="ag-sched-hint">${escapeHtml(
            L(
              `保存后同步写入 Antigravity 原生「自动化任务」（时区 ${st.timezone}），可在左侧「自动化任务」中启用调度，或直接点 ▶ 立即试跑。`,
              `Syncs to Antigravity Automations (${st.timezone}). Enable it in the Automations dashboard or click ▶ to run now.`
            )
          )}</div>`
        : '';

    projectsModalEl.innerHTML = `
      <div class="ag-pm-dialog ag-pm-sched-dialog" role="dialog" aria-modal="true" aria-label="${escapeHtml(
        isEdit ? L('编辑定时任务', 'Edit scheduled task') : L('创建定时任务', 'Create scheduled task')
      )}">
        <div class="ag-pm-hdr ag-sched-hdr">
          <h2 class="ag-pm-title">${escapeHtml(
            isEdit ? L('编辑定时任务', 'Edit scheduled task') : L('创建定时任务', 'Create scheduled task')
          )}</h2>
          <button type="button" class="ag-pm-close" data-ag-pm-close="true" aria-label="${escapeHtml(L('关闭', 'Close'))}">×</button>
        </div>

        <div class="ag-sched-field">
          <label class="ag-sched-label" for="ag-sched-name">${L('名称', 'Name')} <span class="ag-sched-req">*</span></label>
          <input id="ag-sched-name" class="ag-sched-input" type="text" value="${escapeHtml(st.name)}" placeholder="daily-briefing" />
        </div>

        <div class="ag-sched-field">
          <label class="ag-sched-label" for="ag-sched-desc">${L('描述', 'Description')} <span class="ag-sched-req">*</span></label>
          <input id="ag-sched-desc" class="ag-sched-input" type="text" value="${escapeHtml(st.description)}" placeholder="${escapeHtml(
            L('汇总今日日程与待办事项', 'Summarize my calendar and inbox for the day')
          )}" />
        </div>

        <div class="ag-sched-field">
          <label class="ag-sched-label" for="ag-sched-instructions">${L('执行指令', 'Instructions')} <span class="ag-sched-req">*</span></label>
          <div class="ag-sched-inst-box">
            <textarea id="ag-sched-instructions" class="ag-sched-textarea" rows="5" placeholder="${escapeHtml(
              L('汇总今日日程与未读邮件，标出需要优先处理的紧急事项。', 'Summarize my calendar and unread emails. Flag anything urgent.')
            )}">${escapeHtml(st.instructions)}</textarea>
            <div class="ag-sched-inst-bar">
              <label class="ag-sched-picker-wrap">
                <span class="ag-sched-picker-icon">${SVG_CLAUDE_PROJECTS_ICON}</span>
                <select id="ag-sched-folder" class="ag-sched-inline-select" aria-label="${escapeHtml(L('工作文件夹', 'Work in a folder'))}">
                  ${folderOptions
                    .map(
                      (o) =>
                        `<option value="${escapeHtml(o.absPath)}"${o.absPath === st.folderPath ? ' selected' : ''}>${escapeHtml(o.label)}</option>`
                    )
                    .join('')}
                  <option value="__add_folder__">${L('+ 添加文件夹…', '+ Add folder…')}</option>
                </select>
              </label>
              <label class="ag-sched-picker-wrap ag-sched-picker-model">
                <select id="ag-sched-model" class="ag-sched-inline-select" aria-label="${escapeHtml(L('模型', 'Model'))}">
                  ${modelOptions
                    .map(
                      (m) =>
                        `<option value="${escapeHtml(m.value)}"${m.value === st.model ? ' selected' : ''}>${escapeHtml(m.label)}</option>`
                    )
                    .join('')}
                </select>
              </label>
            </div>
          </div>
        </div>

        <div class="ag-sched-freq-row">
          <label class="ag-sched-label ag-sched-freq-lbl" for="ag-sched-freq">${L('执行频率', 'Frequency')}</label>
          <div class="ag-sched-freq-controls">
            <select id="ag-sched-freq" class="ag-sched-select">
              ${freqOptions
                .map(
                  (o) =>
                    `<option value="${escapeHtml(o.value)}"${o.value === st.frequency ? ' selected' : ''}>${escapeHtml(o.label)}</option>`
                )
                .join('')}
            </select>
            ${freqExtraHtml}
          </div>
        </div>

        ${autoHintHtml}
        ${errHtml}

        <div class="ag-pm-footer ag-sched-footer">
          ${
            isEdit
              ? `<button type="button" class="ag-sched-del-btn" data-ag-sched-del="true" ${st.saving ? 'disabled' : ''}>${L('删除任务', 'Delete')}</button>`
              : '<span></span>'
          }
          <div class="ag-sched-footer-right">
            <button type="button" class="ag-pm-secondary-btn" data-ag-pm-close="true">${L('取消', 'Cancel')}</button>
            <button type="button" class="ag-pm-primary-btn" data-ag-sched-save="true" ${canSave ? '' : 'disabled'}>${
              st.saving ? L('保存中…', 'Saving…') : L('保存', 'Save')
            }</button>
          </div>
        </div>
      </div>
    `;

    const nameEl = projectsModalEl.querySelector('#ag-sched-name');
    const descEl = projectsModalEl.querySelector('#ag-sched-desc');
    const instEl = projectsModalEl.querySelector('#ag-sched-instructions');
    const saveBtn = projectsModalEl.querySelector('[data-ag-sched-save]');
    const syncSaveDisabled = () => {
      if (!saveBtn || !projectsModalState) return;
      saveBtn.disabled = !(
        projectsModalState.name.trim() &&
        projectsModalState.description.trim() &&
        projectsModalState.instructions.trim() &&
        !projectsModalState.saving
      );
    };
    if (nameEl) {
      if (!isEdit && !st.name) nameEl.focus();
      nameEl.addEventListener('input', () => {
        if (!projectsModalState) return;
        projectsModalState.name = nameEl.value;
        syncSaveDisabled();
      });
    }
    if (descEl) {
      descEl.addEventListener('input', () => {
        if (!projectsModalState) return;
        projectsModalState.description = descEl.value;
        syncSaveDisabled();
      });
    }
    if (instEl) {
      instEl.addEventListener('input', () => {
        if (!projectsModalState) return;
        projectsModalState.instructions = instEl.value;
        syncSaveDisabled();
      });
    }

    const folderSel = projectsModalEl.querySelector('#ag-sched-folder');
    if (folderSel) {
      folderSel.addEventListener('change', async () => {
        if (!projectsModalState) return;
        if (folderSel.value === '__add_folder__') {
          if (typeof window.__agProjectCall === 'function') {
            try {
              const picked = await window.__agProjectCall('pickFolder', {}, 120000);
              if (!disposed && projectsModalState && picked && picked.ok && !picked.canceled && picked.folderPath) {
                const nextPath = picked.folderPath;
                if (nextPath !== projectsModalState.dirPath) {
                  const saveRes = await saveProjectContextDelta(projectsModalState.project, (draft) => {
                    const nextExtra = draft.extraFolders.slice();
                    if (!nextExtra.some((f) => f.absPath === nextPath)) {
                      nextExtra.push({
                        name: picked.name || nextPath.split(/[\\/]/).pop() || nextPath,
                        absPath: nextPath
                      });
                    }
                    return Object.assign({}, draft, { extraFolders: nextExtra });
                  });
                  if (projectsModalState) {
                    if (saveRes && saveRes.ok === false) {
                      projectsModalState.error =
                        L('关联文件夹保存失败：', 'Failed to link folder: ') + String(saveRes.error || 'unknown');
                    } else {
                      projectsModalState.folderPath = nextPath;
                      projectsModalState.error = '';
                    }
                  }
                } else if (projectsModalState) {
                  projectsModalState.folderPath = nextPath;
                  projectsModalState.error = '';
                }
              }
            } catch (err) {
              if (projectsModalState) {
                projectsModalState.error =
                  L('关联文件夹保存失败：', 'Failed to link folder: ') + String((err && err.message) || err);
              }
            }
          }
          renderProjectScheduledModal();
          return;
        }
        projectsModalState.folderPath = folderSel.value || projectsModalState.dirPath;
      });
    }

    const modelSel = projectsModalEl.querySelector('#ag-sched-model');
    if (modelSel) {
      modelSel.addEventListener('change', () => {
        if (projectsModalState) projectsModalState.model = modelSel.value || '';
      });
    }

    const freqSel = projectsModalEl.querySelector('#ag-sched-freq');
    if (freqSel) {
      freqSel.addEventListener('change', () => {
        if (!projectsModalState) return;
        projectsModalState.frequency = freqSel.value || 'manual';
        renderProjectScheduledModal();
      });
    }

    const minSel = projectsModalEl.querySelector('#ag-sched-minute');
    if (minSel) {
      minSel.addEventListener('change', () => {
        if (projectsModalState) projectsModalState.minute = Number(minSel.value) || 0;
      });
    }
    const timeEl = projectsModalEl.querySelector('#ag-sched-time');
    if (timeEl) {
      timeEl.addEventListener('input', () => {
        if (projectsModalState) projectsModalState.time = timeEl.value || '09:00';
      });
    }
    const dowSel = projectsModalEl.querySelector('#ag-sched-dow');
    if (dowSel) {
      dowSel.addEventListener('change', () => {
        if (projectsModalState) projectsModalState.dayOfWeek = Number(dowSel.value);
      });
    }
    const cronEl = projectsModalEl.querySelector('#ag-sched-cron');
    if (cronEl) {
      cronEl.addEventListener('input', () => {
        if (projectsModalState) projectsModalState.customCron = cronEl.value;
      });
    }

    projectsModalEl.querySelectorAll('[data-ag-pm-close]').forEach((b) => {
      b.addEventListener('click', () => closeProjectsModal());
    });

    const delBtn = projectsModalEl.querySelector('[data-ag-sched-del]');
    if (delBtn) {
      delBtn.addEventListener('click', async () => {
        if (!projectsModalState || projectsModalState.saving) return;
        projectsModalState.saving = true;
        renderProjectScheduledModal();
        await deleteProjectScheduledTaskFromUi(projectsModalState.project, {
          id: projectsModalState.editingId,
          sidecarId: projectsModalState.sidecarId
        });
        if (!disposed) closeProjectsModal();
      });
    }

    if (saveBtn) {
      saveBtn.addEventListener('click', async () => {
        if (!projectsModalState || projectsModalState.saving) return;
        if (typeof window.__agProjectCall !== 'function') {
          projectsModalState.error = L('本地写入桥接不可用，请重启 Anti-Claude 守护进程', 'Local write bridge unavailable');
          renderProjectScheduledModal();
          return;
        }
        projectsModalState.saving = true;
        projectsModalState.error = '';
        renderProjectScheduledModal();
        const res = await window.__agProjectCall(
          'saveScheduledTask',
          {
            dirPath: projectsModalState.dirPath,
            task: {
              id: projectsModalState.editingId || undefined,
              sidecarId: projectsModalState.sidecarId || undefined,
              name: projectsModalState.name,
              description: projectsModalState.description,
              instructions: projectsModalState.instructions,
              folderPath: projectsModalState.folderPath,
              model: projectsModalState.model,
              frequency: projectsModalState.frequency,
              time: projectsModalState.time,
              dayOfWeek: projectsModalState.dayOfWeek,
              minute: projectsModalState.minute,
              customCron: projectsModalState.customCron,
              timezone: projectsModalState.timezone
            }
          },
          20000
        );
        if (disposed || !projectsModalState) return;
        if (res && res.ok) {
          projectsContextMap[projectsModalState.dirPath] = res;
          closeProjectsModal();
          if (projectsViewOpen) renderProjectsView();
        } else {
          projectsModalState.saving = false;
          projectsModalState.error = L('保存失败：', 'Save failed: ') + String((res && res.error) || 'unknown');
          renderProjectScheduledModal();
        }
      });
    }
  }

  function openProjectsView(targetProjectId) {
    projectsViewOpen = true;
    activeProjectId = typeof targetProjectId === 'string' && targetProjectId ? targetProjectId : null;
    projectSelectedFolderPath = '';
    ensureProjectsSidebarObserver();
    const el = ensureProjectsViewEl();
    renderProjectsView();
    positionProjectsOverlay();
    el.setAttribute('data-open', 'true');
    updateProjectsNavActiveVisual();
    refreshProjectsContexts(collectNativeProjects());
  }

  function toggleProjectsView() {
    if (projectsViewOpen && activeProjectId) {
      activeProjectId = null;
      renderProjectsView();
    } else if (projectsViewOpen) {
      closeProjectsView();
    } else {
      openProjectsView();
    }
  }

  function refreshProjectsLanguageUi() {
    updateProjectsNavActiveVisual();
    if (projectsViewOpen) renderProjectsView();
    if (projectMenuState) renderProjectActionMenu();
    if (projectsModalState) {
      if (projectsModalState.kind === 'scheduled') renderProjectScheduledModal();
      else if (projectsModalState.kind === 'renameProject') renderRenameProjectModal();
      else renderProjectContextModal();
    }
  }

  let sidebarHideScrollEl = null;
  let sidebarListLayoutMo = null;
  let sidebarListLayoutTarget = null;

  function syncPinnedSidebarRowTooltips(root) {
    const scope = root || document;
    const rows = scope.querySelectorAll('[data-testid="conversation-row-sidebar"][data-pinned="true"][data-subtext]');
    for (const row of rows) {
      const subtext = String(row.getAttribute('data-subtext') || '').trim();
      const link = row.querySelector('a[href]');
      if (!subtext) {
        if (link && link.getAttribute('data-ag-pin-tip') === '1') {
          link.removeAttribute('title');
          link.removeAttribute('data-ag-pin-tip');
        }
        continue;
      }
      const titleSpan = row.querySelector('.flex-col > span');
      const baseTitle = String((link && link.getAttribute('aria-label')) || (titleSpan && titleSpan.textContent) || '').trim();
      const tip = baseTitle ? `${baseTitle}\n${L('所属项目：', 'Project: ')}${subtext}` : `${L('所属项目：', 'Project: ')}${subtext}`;
      const target = link || row;
      if (target.getAttribute('title') !== tip) {
        target.setAttribute('title', tip);
        target.setAttribute('data-ag-pin-tip', '1');
      }
    }
  }

  function clearPinnedSidebarRowTooltips() {
    document.querySelectorAll('[data-ag-pin-tip="1"]').forEach((el) => {
      el.removeAttribute('title');
      el.removeAttribute('data-ag-pin-tip');
    });
  }

  function parseVirtualTranslateY(el) {
    if (!el) return 0;
    const tf = String((el.style && el.style.transform) || '');
    const m = tf.match(/translateY\(([-\d.]+)px\)/i);
    if (m) return Number(m[1]) || 0;
    return 0;
  }

  function clearSidebarHideNativeProjects() {
    if (sidebarHideScrollEl) {
      sidebarHideScrollEl.removeEventListener('scroll', onSidebarHideScroll);
      sidebarHideScrollEl = null;
    }
    if (sidebarListLayoutMo) {
      try {
        sidebarListLayoutMo.disconnect();
      } catch {}
      sidebarListLayoutMo = null;
      sidebarListLayoutTarget = null;
    }
    const scrollBox = document.querySelector('[data-testid="conversation-list-sidebar"]');
    const { host: sbParent } = getSidebarListHost(scrollBox);
    if (sbParent) {
      sbParent.removeAttribute('data-ag-sb-unified');
      sbParent.style.removeProperty('--ag-sb-pinned-height');
    }
    if (scrollBox && scrollBox !== sbParent) {
      scrollBox.removeAttribute('data-ag-sb-unified');
      scrollBox.style.removeProperty('--ag-sb-pinned-height');
    }
    const list = scrollBox && scrollBox.firstElementChild;
    if (!list) return;
    list.style.removeProperty('--ag-sb-proj-shift');
    delete list.dataset.agProjIdx;
    delete list.dataset.agConvIdx;
    delete list.dataset.agProjShift;
    delete list.dataset.agCutIdx;
    delete list.dataset.agPinnedH;
    for (const child of list.children) {
      child.removeAttribute('data-ag-sb-hide-proj');
      child.removeAttribute('data-ag-sb-shift-up');
    }
  }

  function onSidebarHideScroll() {
    syncSidebarHideNativeProjects();
  }

  function syncSidebarHideNativeProjects() {
    const scrollBox = document.querySelector('[data-testid="conversation-list-sidebar"]');
    if (scrollBox && !disposed) {
      syncPinnedSidebarRowTooltips(scrollBox);
    }
    if (disposed || !FEAT.hideSidebarProjects) {
      clearSidebarHideNativeProjects();
      return;
    }
    const { host: sbParent } = getSidebarListHost(scrollBox);
    const list = scrollBox && scrollBox.firstElementChild;
    if (!scrollBox || !sbParent || !list) return;

    if (sidebarHideScrollEl !== scrollBox) {
      if (sidebarHideScrollEl) sidebarHideScrollEl.removeEventListener('scroll', onSidebarHideScroll);
      sidebarHideScrollEl = scrollBox;
      scrollBox.addEventListener('scroll', onSidebarHideScroll, { passive: true });
    }
    if (typeof MutationObserver !== 'undefined' && sidebarListLayoutTarget !== list) {
      if (sidebarListLayoutMo) {
        try {
          sidebarListLayoutMo.disconnect();
        } catch {}
      }
      sidebarListLayoutTarget = list;
      sidebarListLayoutMo = new MutationObserver((muts) => {
        if (disposed || !FEAT.hideSidebarProjects) return;
        for (const m of muts) {
          if (m.attributeName === 'data-subtext') {
            syncPinnedSidebarRowTooltips(scrollBox);
            return;
          }
          if (m.attributeName === 'style' && m.target && m.target.parentElement === list) {
            syncSidebarHideNativeProjects();
            return;
          }
        }
      });
      sidebarListLayoutMo.observe(list, {
        subtree: true,
        attributes: true,
        attributeFilter: ['style', 'data-subtext']
      });
    }
    if (scrollBox.scrollTop > 0) {
      try {
        scrollBox.scrollTop = 0;
      } catch {}
    }

    const indexed = [];
    for (const child of list.children) {
      const rawIdx = child.getAttribute('data-index');
      if (rawIdx === null || rawIdx === '') continue;
      const idx = Number(rawIdx);
      if (Number.isFinite(idx)) indexed.push({ idx, el: child });
    }
    if (!indexed.length) return;
    indexed.sort((a, b) => a.idx - b.idx);

    const isPinnedHdrText = (txt) => /^(pinned|置顶对话)$/i.test(String(txt || '').trim());
    let cutItem = indexed.find((x) => Boolean(x.el.querySelector('[data-testid="sidebar-add-project-button"]')));
    if (!cutItem) {
      cutItem = indexed.find((x) => {
        const sh = x.el.querySelector('[data-testid="section-header"]');
        return Boolean(sh && !isPinnedHdrText(sh.textContent));
      });
    }

    if (cutItem) {
      const pinnedH = cutItem.idx === 0 ? 0 : Math.max(0, Math.round(parseVirtualTranslateY(cutItem.el)));
      list.dataset.agCutIdx = String(cutItem.idx);
      list.dataset.agPinnedH = String(pinnedH);
    }

    if (list.dataset.agCutIdx === undefined) {
      // Only pinned section exists in virtual list (no native Projects/Conversations headers rendered)
      const hasPinnedHdr = indexed.some((x) => {
        const sh = x.el.querySelector('[data-testid="section-header"]');
        return Boolean(sh && isPinnedHdrText(sh.textContent));
      });
      if (!hasPinnedHdr) return;
      const last = indexed[indexed.length - 1];
      const estH = Math.max(0, Math.round(parseVirtualTranslateY(last.el) + ((last.el.getBoundingClientRect && last.el.getBoundingClientRect().height) || 33) + 12));
      sbParent.setAttribute('data-ag-sb-unified', estH > 0 ? 'pinned' : 'empty');
      sbParent.style.setProperty('--ag-sb-pinned-height', `${estH}px`);
      for (const { el } of indexed) {
        el.removeAttribute('data-ag-sb-hide-proj');
        el.removeAttribute('data-ag-sb-shift-up');
      }
      return;
    }

    const cutIdx = Number(list.dataset.agCutIdx);
    const pinnedH = Number(list.dataset.agPinnedH) || 0;
    sbParent.setAttribute('data-ag-sb-unified', pinnedH > 0 ? 'pinned' : 'empty');
    sbParent.style.setProperty('--ag-sb-pinned-height', `${pinnedH}px`);
    list.style.removeProperty('--ag-sb-proj-shift');

    for (const { idx, el } of indexed) {
      el.removeAttribute('data-ag-sb-shift-up');
      if (idx >= cutIdx) {
        el.setAttribute('data-ag-sb-hide-proj', '1');
      } else {
        el.removeAttribute('data-ag-sb-hide-proj');
      }
    }
  }

  function teardownProjectsWorkspace() {
    closeProjectsView();
    projectMgmtSvcRef = null;
    cascadeRpcSvcRef = null;
    projectComposerMentions.clear();
    projectComposerMedia.clear();
    pdMentionCache.rulesByKey.clear();
    pdMentionCache.pluginsByKey.clear();
    optimisticallyDeletedProjectIds.clear();
    optimisticProjectNames.clear();
    const btn = document.getElementById('ag-claude-projects-nav-btn');
    if (btn) btn.remove();
    if (projectsViewEl) {
      projectsViewEl.remove();
      projectsViewEl = null;
    }
    if (projectsSidebarRo) {
      try {
        projectsSidebarRo.disconnect();
      } catch {}
      projectsSidebarRo = null;
      projectsSidebarRoTarget = null;
    }
    if (projectsDocListenerBound) {
      document.removeEventListener('click', onProjectsGlobalClick, true);
      document.removeEventListener('keydown', onProjectsGlobalKeyDown, true);
      window.removeEventListener('resize', positionProjectsOverlay);
      projectsDocListenerBound = false;
    }
  }

  /* ==========================================================================
   * 10. Claude-Style Customizations Enhancement (`claudeUxCustomizations`)
   *     - Non-destructively adds category tabs (Skills / Plugins / MCP / Agents / All)
   *       on `/customizations/installed`, crisp sticky header border (no clipped cards),
   *       framed Claude card rows for Skills & Rules, and local `+ Add skill` + Open Folder.
   * ========================================================================== */
  let custActiveCat = 'skills';
  let custUserPickedCat = false;
  let custSearchInputRef = null;

  function onCustSearchInput() {
    syncCustomizationsEnhancement();
  }

  function teardownCustomizationsEnhancement() {
    if (custSearchInputRef) {
      custSearchInputRef.removeEventListener('input', onCustSearchInput);
      custSearchInputRef = null;
    }
    const bar = document.getElementById('ag-cust-cat-bar');
    if (bar) bar.remove();
    const skillActions = document.getElementById('ag-cust-skill-actions');
    if (skillActions) skillActions.remove();
    const agentActions = document.getElementById('ag-cust-agent-actions');
    if (agentActions) agentActions.remove();
    document.querySelectorAll('[data-ag-cust-page]').forEach((el) => {
      el.removeAttribute('data-ag-cust-page');
      el.removeAttribute('data-ag-cust-tab');
      el.removeAttribute('data-ag-cust-searching');
    });
    document.querySelectorAll('[data-ag-cust-sticky]').forEach((el) => el.removeAttribute('data-ag-cust-sticky'));
    document.querySelectorAll('[data-ag-cust-sec]').forEach((el) => {
      el.removeAttribute('data-ag-cust-sec');
      el.removeAttribute('data-ag-cust-hidden');
    });
  }

  function classifyCustomizationsSection(sec) {
    if (!sec) return '';
    if (sec.getAttribute('data-testid') === 'customizations-installed-plugins') return 'plugins';
    if (sec.querySelector('[data-testid="skills-rules-filter"]')) return 'skills';
    if (sec.querySelector('[data-testid="add-mcp-button"]')) return 'mcp';
    const h3 = sec.querySelector('h3');
    const txt = h3 ? (h3.textContent || '').trim() : '';
    if (/Skills\s*&\s*Rules|技能与规则/i.test(txt)) return 'skills';
    if (/Custom Agents|自定义.*Agent|自定义智能体|自定义代理/i.test(txt)) return 'agents';
    if (/MCP/i.test(txt)) return 'mcp';
    if (/Installed Plugins|Plugins|已安装插件|插件/i.test(txt)) return 'plugins';
    return '';
  }

  function openAddSkillModal() {
    closeProjectsModal();
    projectsModalState = {
      kind: 'addSkill',
      mode: 'create',
      name: '',
      description: '',
      instructions: '',
      saving: false,
      error: '',
      successMsg: '',
      createdDir: ''
    };
    renderAddSkillModal();
  }

  function renderAddSkillModal() {
    if (!projectsModalState || projectsModalState.kind !== 'addSkill') return;
    if (!projectsModalEl || !projectsModalEl.isConnected) {
      projectsModalEl = document.createElement('div');
      projectsModalEl.id = 'ag-claude-project-modal';
      projectsModalEl.setAttribute('data-ag-i18n-ignore', '1');
      projectsModalEl.addEventListener('click', (e) => {
        if (e.target === projectsModalEl) closeProjectsModal();
      });
      document.body.appendChild(projectsModalEl);
    }

    const st = projectsModalState;
    const isCreate = st.mode === 'create';
    const canSave = Boolean(st.name.trim() && st.description.trim() && st.instructions.trim() && !st.saving);
    const errHtml = st.error ? `<div class="ag-pm-error">${escapeHtml(st.error)}</div>` : '';
    const okHtml = st.successMsg
      ? `<div class="ag-cust-ok-banner"><span>${escapeHtml(st.successMsg)}</span>${
          st.createdDir
            ? `<button type="button" class="ag-cust-ok-open" data-ag-skill-reveal="${escapeHtml(st.createdDir)}">${L('打开目录', 'Open folder')}</button>`
            : ''
        }</div>`
      : '';

    const bodyHtml = isCreate
      ? `
        <div class="ag-sched-field">
          <label class="ag-sched-label" for="ag-skill-name">${L('技能名称', 'Skill name')} <span class="ag-sched-req">*</span></label>
          <input id="ag-skill-name" class="ag-sched-input" type="text" value="${escapeHtml(st.name)}" placeholder="contract-audit" />
        </div>
        <div class="ag-sched-field">
          <label class="ag-sched-label" for="ag-skill-desc">${L('触发描述', 'Description')} <span class="ag-sched-req">*</span></label>
          <input id="ag-skill-desc" class="ag-sched-input" type="text" value="${escapeHtml(st.description)}" placeholder="${escapeHtml(
            L('说明何时自动激活该技能（例如：审查商事合同条款并标出风险点）', 'Describe when the agent should activate this skill')
          )}" />
        </div>
        <div class="ag-sched-field">
          <label class="ag-sched-label" for="ag-skill-body">${L('技能正文（SKILL.md）', 'Instructions (SKILL.md)')} <span class="ag-sched-req">*</span></label>
          <textarea id="ag-skill-body" class="ag-pm-textarea" rows="6" placeholder="${escapeHtml(
            L('# 执行步骤\n1. 先通读用户提供的材料……', '# Workflow\n1. Read the user material carefully...')
          )}">${escapeHtml(st.instructions)}</textarea>
        </div>
        <div class="ag-sched-hint">${L(
          '保存到 ~/.gemini/config/skills/<技能名称>/SKILL.md，Antigravity 会自动扫描识别。',
          'Saved to ~/.gemini/config/skills/<name>/SKILL.md and auto-discovered by Antigravity.'
        )}</div>
      `
      : `
        <div class="ag-cust-import-box">
          <div class="ag-cust-import-title">${L('从本机文件夹导入技能', 'Import a local skill folder')}</div>
          <p class="ag-cust-import-desc">${L(
            '选择一个包含 SKILL.md 的本地技能文件夹，系统将自动完整复制到 ~/.gemini/config/skills/ 目录中。',
            'Pick a local folder containing SKILL.md. It will be copied into ~/.gemini/config/skills/ automatically.'
          )}</p>
          <div class="ag-cust-import-btns">
            <button type="button" class="ag-pm-primary-btn" data-ag-skill-import="true" ${st.saving ? 'disabled' : ''}>${
              st.saving ? L('导入中…', 'Importing…') : L('选择技能文件夹导入…', 'Choose skill folder…')
            }</button>
            <button type="button" class="ag-pm-secondary-btn" data-ag-skill-open-dir="true">${L('打开技能目录', 'Open skills folder')}</button>
          </div>
        </div>
      `;

    projectsModalEl.innerHTML = `
      <div class="ag-pm-dialog ag-pm-sched-dialog" role="dialog" aria-modal="true" aria-label="${escapeHtml(L('添加技能', 'Add skill'))}">
        <div class="ag-pm-hdr ag-sched-hdr">
          <h2 class="ag-pm-title">${L('添加技能', 'Add skill')}</h2>
          <button type="button" class="ag-pm-close" data-ag-pm-close="true" aria-label="${escapeHtml(L('关闭', 'Close'))}">×</button>
        </div>
        <div class="ag-cust-modal-tabs">
          <button type="button" class="ag-cust-mtab" data-ag-skill-mode="create" data-active="${isCreate ? 'true' : 'false'}">${L('新建技能', 'Create skill')}</button>
          <button type="button" class="ag-cust-mtab" data-ag-skill-mode="import" data-active="${!isCreate ? 'true' : 'false'}">${L('导入本地目录', 'Import folder')}</button>
        </div>
        ${bodyHtml}
        ${okHtml}
        ${errHtml}
        <div class="ag-pm-footer ag-sched-footer">
          <button type="button" class="ag-pm-secondary-btn" data-ag-skill-open-dir="true">${L('打开 ~/.gemini/config/skills', 'Open skills folder')}</button>
          <div class="ag-sched-footer-right">
            <button type="button" class="ag-pm-secondary-btn" data-ag-pm-close="true">${L('关闭', 'Close')}</button>
            ${
              isCreate
                ? `<button type="button" class="ag-pm-primary-btn" data-ag-skill-save="true" ${canSave ? '' : 'disabled'}>${
                    st.saving ? L('创建中…', 'Creating…') : L('创建技能', 'Create skill')
                  }</button>`
                : ''
            }
          </div>
        </div>
      </div>
    `;

    projectsModalEl.querySelectorAll('[data-ag-pm-close]').forEach((b) => {
      b.addEventListener('click', () => closeProjectsModal());
    });
    projectsModalEl.querySelectorAll('[data-ag-skill-mode]').forEach((b) => {
      b.addEventListener('click', () => {
        if (!projectsModalState) return;
        projectsModalState.mode = b.getAttribute('data-ag-skill-mode') || 'create';
        projectsModalState.error = '';
        renderAddSkillModal();
      });
    });
    projectsModalEl.querySelectorAll('[data-ag-skill-open-dir]').forEach((b) => {
      b.addEventListener('click', () => {
        if (typeof window.__agProjectCall === 'function') {
          window.__agProjectCall('openSkillsDir', {}, 5000);
        }
      });
    });
    const revealBtn = projectsModalEl.querySelector('[data-ag-skill-reveal]');
    if (revealBtn) {
      revealBtn.addEventListener('click', () => {
        const p = revealBtn.getAttribute('data-ag-skill-reveal');
        if (p && typeof window.__agProjectCall === 'function') {
          window.__agProjectCall('revealFile', { targetPath: p }, 5000);
        }
      });
    }

    const nameEl = projectsModalEl.querySelector('#ag-skill-name');
    const descEl = projectsModalEl.querySelector('#ag-skill-desc');
    const bodyEl = projectsModalEl.querySelector('#ag-skill-body');
    const saveBtn = projectsModalEl.querySelector('[data-ag-skill-save]');
    const syncBtn = () => {
      if (!saveBtn || !projectsModalState) return;
      saveBtn.disabled = !(
        projectsModalState.name.trim() &&
        projectsModalState.description.trim() &&
        projectsModalState.instructions.trim() &&
        !projectsModalState.saving
      );
    };
    if (nameEl) {
      if (!st.name) nameEl.focus();
      nameEl.addEventListener('input', () => {
        if (!projectsModalState) return;
        projectsModalState.name = nameEl.value;
        syncBtn();
      });
    }
    if (descEl) {
      descEl.addEventListener('input', () => {
        if (!projectsModalState) return;
        projectsModalState.description = descEl.value;
        syncBtn();
      });
    }
    if (bodyEl) {
      bodyEl.addEventListener('input', () => {
        if (!projectsModalState) return;
        projectsModalState.instructions = bodyEl.value;
        syncBtn();
      });
    }
    if (saveBtn) {
      saveBtn.addEventListener('click', async () => {
        if (!projectsModalState || projectsModalState.saving) return;
        if (typeof window.__agProjectCall !== 'function') {
          projectsModalState.error = L('本地写入桥接不可用，请重启 Anti-Claude 守护进程', 'Local write bridge unavailable');
          renderAddSkillModal();
          return;
        }
        projectsModalState.saving = true;
        projectsModalState.error = '';
        projectsModalState.successMsg = '';
        renderAddSkillModal();
        const res = await window.__agProjectCall(
          'createLocalSkill',
          {
            name: projectsModalState.name,
            description: projectsModalState.description,
            instructions: projectsModalState.instructions
          },
          15000
        );
        if (disposed || !projectsModalState) return;
        projectsModalState.saving = false;
        if (res && res.ok) {
          projectsModalState.name = '';
          projectsModalState.description = '';
          projectsModalState.instructions = '';
          projectsModalState.createdDir = res.dirPath || '';
          projectsModalState.successMsg = L(`已创建技能「${res.folderName}」，重新进入页面或稍候即可在列表中看到。`, `Skill "${res.folderName}" created successfully.`);
          renderAddSkillModal();
        } else {
          const code = (res && res.error) || 'unknown';
          projectsModalState.error =
            code === 'skill_already_exists'
              ? L('同名技能目录已存在，请换一个名称。', 'A skill with this folder name already exists.')
              : L('创建失败：', 'Create failed: ') + String(code);
          renderAddSkillModal();
        }
      });
    }

    const importBtn = projectsModalEl.querySelector('[data-ag-skill-import]');
    if (importBtn) {
      importBtn.addEventListener('click', async () => {
        if (!projectsModalState || projectsModalState.saving) return;
        if (typeof window.__agProjectCall !== 'function') {
          projectsModalState.error = L('本地写入桥接不可用', 'Local write bridge unavailable');
          renderAddSkillModal();
          return;
        }
        projectsModalState.saving = true;
        projectsModalState.error = '';
        projectsModalState.successMsg = '';
        renderAddSkillModal();
        const res = await window.__agProjectCall('importLocalSkill', {}, 120000);
        if (disposed || !projectsModalState) return;
        projectsModalState.saving = false;
        if (res && res.ok && res.canceled) {
          renderAddSkillModal();
          return;
        }
        if (res && res.ok) {
          projectsModalState.createdDir = res.dirPath || '';
          projectsModalState.successMsg = res.alreadyInstalled
            ? L(`「${res.folderName}」已在全局技能目录中。`, `"${res.folderName}" is already in the skills folder.`)
            : L(`已成功导入技能「${res.folderName}」。`, `Imported skill "${res.folderName}" successfully.`);
          renderAddSkillModal();
        } else {
          const code = (res && res.error) || 'unknown';
          projectsModalState.error =
            code === 'missing_skill_md'
              ? L('所选文件夹根目录未找到 SKILL.md，请选择包含 SKILL.md 的技能目录。', 'No SKILL.md found in the selected folder.')
              : L('导入失败：', 'Import failed: ') + String(code);
          renderAddSkillModal();
        }
      });
    }
  }

  function openAddAgentModal() {
    closeProjectsModal();
    projectsModalState = {
      kind: 'addAgent',
      mode: 'create',
      name: '',
      description: '',
      roleMode: 'subagent',
      tools: ['read_file', 'search_web'],
      systemPrompt: '',
      saving: false,
      error: '',
      successMsg: '',
      createdPath: ''
    };
    renderAddAgentModal();
  }

  function renderAddAgentModal() {
    if (!projectsModalState || projectsModalState.kind !== 'addAgent') return;
    if (!projectsModalEl || !projectsModalEl.isConnected) {
      projectsModalEl = document.createElement('div');
      projectsModalEl.id = 'ag-claude-project-modal';
      projectsModalEl.setAttribute('data-ag-i18n-ignore', '1');
      projectsModalEl.addEventListener('click', (e) => {
        if (e.target === projectsModalEl) closeProjectsModal();
      });
      document.body.appendChild(projectsModalEl);
    }

    const st = projectsModalState;
    const isCreate = st.mode === 'create';
    const canSave = Boolean(st.name.trim() && st.description.trim() && st.systemPrompt.trim() && !st.saving);
    const errHtml = st.error ? `<div class="ag-pm-error">${escapeHtml(st.error)}</div>` : '';
    const okHtml = st.successMsg
      ? `<div class="ag-cust-ok-banner"><span>${escapeHtml(st.successMsg)}</span>${
          st.createdPath
            ? `<button type="button" class="ag-cust-ok-open" data-ag-agent-reveal="${escapeHtml(st.createdPath)}">${L('在 Finder 查看', 'Reveal')}</button>`
            : ''
        }</div>`
      : '';

    const toolDefs = [
      ['read_file', L('读取文件', 'Read files'), 'read_file'],
      ['search_web', L('联网检索', 'Web search'), 'search_web'],
      ['edit_file', L('编辑文件', 'Edit files'), 'edit_file'],
      ['write_file', L('创建/写入文件', 'Write files'), 'write_file'],
      ['run_command', L('运行命令', 'Run shell'), 'run_command'],
      ['manage_task', L('管理后台任务', 'Manage tasks'), 'manage_task']
    ];
    const selectedSet = new Set(Array.isArray(st.tools) ? st.tools : ['read_file']);
    const hasPreset = (arr) => arr.length === selectedSet.size && arr.every((t) => selectedSet.has(t));

    const bodyHtml = isCreate
      ? `
        <div class="ag-agent-grid-2">
          <div class="ag-sched-field">
            <label class="ag-sched-label" for="ag-agent-name">${L('子 Agent 名称', 'Agent name')} <span class="ag-sched-req">*</span></label>
            <input id="ag-agent-name" class="ag-sched-input" type="text" value="${escapeHtml(st.name)}" placeholder="contract-reviewer" />
          </div>
          <div class="ag-sched-field">
            <label class="ag-sched-label" for="ag-agent-role">${L('角色模式', 'Role mode')}</label>
            <select id="ag-agent-role" class="ag-sched-select ag-agent-full-select">
              <option value="subagent"${st.roleMode === 'subagent' ? ' selected' : ''}>${L('仅子 Agent（推荐，后台委派）', 'Subagent only (Recommended)')}</option>
              <option value="both"${st.roleMode === 'both' ? ' selected' : ''}>${L('子 Agent + 主 Agent', 'Both subagent & main agent')}</option>
              <option value="main_only"${st.roleMode === 'main_only' ? ' selected' : ''}>${L('仅主 Agent', 'Main agent only')}</option>
            </select>
          </div>
        </div>

        <div class="ag-sched-field">
          <label class="ag-sched-label" for="ag-agent-desc">${L('职责描述（主 AI 据此判断何时委派）', 'Description (when to delegate)')} <span class="ag-sched-req">*</span></label>
          <input id="ag-agent-desc" class="ag-sched-input" type="text" value="${escapeHtml(st.description)}" placeholder="${escapeHtml(
            L('例如：专注核对合同与证据原件的只读审计专员，输出逐条出处与风险点', 'Specialized reviewer for contracts and evidence citations')
          )}" />
        </div>

        <div class="ag-sched-field">
          <div class="ag-agent-tools-hdr">
            <label class="ag-sched-label" style="margin-bottom:0 !important;">${L('工具权限（tools）', 'Tool permissions')}</label>
            <div class="ag-agent-presets">
              <button type="button" class="ag-agent-preset-btn" data-ag-agent-preset="readonly" data-active="${hasPreset(['read_file', 'search_web']) ? 'true' : 'false'}">${L('只读研究', 'Read-only')}</button>
              <button type="button" class="ag-agent-preset-btn" data-ag-agent-preset="editor" data-active="${hasPreset(['read_file', 'edit_file', 'write_file', 'search_web']) ? 'true' : 'false'}">${L('文档编辑', 'Editor')}</button>
              <button type="button" class="ag-agent-preset-btn" data-ag-agent-preset="full" data-active="${hasPreset(['read_file', 'edit_file', 'write_file', 'run_command', 'manage_task', 'search_web']) ? 'true' : 'false'}">${L('完整执行', 'Full tools')}</button>
            </div>
          </div>
          <div class="ag-agent-tools-grid">
            ${toolDefs
              .map(
                ([key, label, code]) => `<label class="ag-agent-tool-chk">
                  <input type="checkbox" data-ag-agent-tool="${key}"${selectedSet.has(key) ? ' checked' : ''} />
                  <span>${escapeHtml(label)}</span>
                  <code>${code}</code>
                </label>`
              )
              .join('')}
          </div>
        </div>

        <div class="ag-sched-field">
          <label class="ag-sched-label" for="ag-agent-prompt">${L('系统提示词（角色设定、工作流程与输出要求）', 'System prompt')} <span class="ag-sched-req">*</span></label>
          <textarea id="ag-agent-prompt" class="ag-pm-textarea" rows="5" placeholder="${escapeHtml(
            L('你是一名严谨的专职审查员。收到任务后：\n1. 逐句核对原始文件；\n2. 仅输出有明确出处的结论……', 'You are a focused specialist subagent. When invoked:\n1. Verify every claim against source files...')
          )}">${escapeHtml(st.systemPrompt)}</textarea>
        </div>
        <div class="ag-sched-hint">${L(
          '自动生成官方格式 ~/.gemini/config/agents/<名称>.md（避免与 self / browser / research 等内置名重名）；模型由主 AI 委派时动态指定（官方 agents/*.md 不设固定 model 字段）。',
          'Saves to ~/.gemini/config/agents/<name>.md using native frontmatter (model is chosen dynamically at invoke time; official agents/*.md does not take a fixed model field).'
        )}</div>
      `
      : `
        <div class="ag-cust-import-box">
          <div class="ag-cust-import-title">${L('导入已有子 Agent 定义文件（.md）', 'Import existing agent Markdown (.md)')}</div>
          <p class="ag-cust-import-desc">${L(
            '选择一个或多个 .md 文件（例如从 Claude Code ~/.claude/agents/ 导出的子 Agent），自动复制到 ~/.gemini/config/agents/。',
            'Pick one or more .md agent files to copy directly into ~/.gemini/config/agents/.'
          )}</p>
          <div class="ag-cust-import-btns">
            <button type="button" class="ag-pm-primary-btn" data-ag-agent-import="true" ${st.saving ? 'disabled' : ''}>${
              st.saving ? L('导入中…', 'Importing…') : L('选择 .md 文件导入…', 'Choose .md file(s)…')
            }</button>
            <button type="button" class="ag-pm-secondary-btn" data-ag-agent-open-dir="true">${L('打开目录', 'Open agents folder')}</button>
          </div>
        </div>
      `;

    projectsModalEl.innerHTML = `
      <div class="ag-pm-dialog ag-pm-sched-dialog" role="dialog" aria-modal="true" aria-label="${escapeHtml(L('新建子 Agent', 'New subagent'))}">
        <div class="ag-pm-hdr ag-sched-hdr">
          <h2 class="ag-pm-title">${L('新建子 Agent', 'New subagent')}</h2>
          <button type="button" class="ag-pm-close" data-ag-pm-close="true" aria-label="${escapeHtml(L('关闭', 'Close'))}">×</button>
        </div>
        <div class="ag-cust-modal-tabs">
          <button type="button" class="ag-cust-mtab" data-ag-agent-mode="create" data-active="${isCreate ? 'true' : 'false'}">${L('新建配置', 'Create')}</button>
          <button type="button" class="ag-cust-mtab" data-ag-agent-mode="import" data-active="${!isCreate ? 'true' : 'false'}">${L('导入 .md 文件', 'Import .md')}</button>
        </div>
        ${bodyHtml}
        ${okHtml}
        ${errHtml}
        <div class="ag-pm-footer ag-sched-footer">
          <button type="button" class="ag-pm-secondary-btn" data-ag-agent-open-dir="true">${L('打开 ~/.gemini/config/agents', 'Open agents folder')}</button>
          <div class="ag-sched-footer-right">
            <button type="button" class="ag-pm-secondary-btn" data-ag-pm-close="true">${L('关闭', 'Close')}</button>
            ${
              isCreate
                ? `<button type="button" class="ag-pm-primary-btn" data-ag-agent-save="true" ${canSave ? '' : 'disabled'}>${
                    st.saving ? L('创建中…', 'Creating…') : L('创建子 Agent', 'Create subagent')
                  }</button>`
                : ''
            }
          </div>
        </div>
      </div>
    `;

    projectsModalEl.querySelectorAll('[data-ag-pm-close]').forEach((b) => {
      b.addEventListener('click', () => closeProjectsModal());
    });
    projectsModalEl.querySelectorAll('[data-ag-agent-mode]').forEach((b) => {
      b.addEventListener('click', () => {
        if (!projectsModalState) return;
        projectsModalState.mode = b.getAttribute('data-ag-agent-mode') || 'create';
        projectsModalState.error = '';
        renderAddAgentModal();
      });
    });
    projectsModalEl.querySelectorAll('[data-ag-agent-open-dir]').forEach((b) => {
      b.addEventListener('click', () => {
        if (typeof window.__agProjectCall === 'function') {
          window.__agProjectCall('openAgentsDir', {}, 5000);
        }
      });
    });
    const revealBtn = projectsModalEl.querySelector('[data-ag-agent-reveal]');
    if (revealBtn) {
      revealBtn.addEventListener('click', () => {
        const p = revealBtn.getAttribute('data-ag-agent-reveal');
        if (p && typeof window.__agProjectCall === 'function') {
          window.__agProjectCall('revealFile', { targetPath: p }, 5000);
        }
      });
    }

    const nameEl = projectsModalEl.querySelector('#ag-agent-name');
    const roleEl = projectsModalEl.querySelector('#ag-agent-role');
    const descEl = projectsModalEl.querySelector('#ag-agent-desc');
    const promptEl = projectsModalEl.querySelector('#ag-agent-prompt');
    const saveBtn = projectsModalEl.querySelector('[data-ag-agent-save]');
    const syncBtn = () => {
      if (!saveBtn || !projectsModalState) return;
      saveBtn.disabled = !(
        projectsModalState.name.trim() &&
        projectsModalState.description.trim() &&
        projectsModalState.systemPrompt.trim() &&
        !projectsModalState.saving
      );
    };
    if (nameEl) {
      if (!st.name) nameEl.focus();
      nameEl.addEventListener('input', () => {
        if (!projectsModalState) return;
        projectsModalState.name = nameEl.value;
        syncBtn();
      });
    }
    if (roleEl) {
      roleEl.addEventListener('change', () => {
        if (projectsModalState) projectsModalState.roleMode = roleEl.value || 'subagent';
      });
    }
    if (descEl) {
      descEl.addEventListener('input', () => {
        if (!projectsModalState) return;
        projectsModalState.description = descEl.value;
        syncBtn();
      });
    }
    if (promptEl) {
      promptEl.addEventListener('input', () => {
        if (!projectsModalState) return;
        projectsModalState.systemPrompt = promptEl.value;
        syncBtn();
      });
    }

    projectsModalEl.querySelectorAll('[data-ag-agent-preset]').forEach((b) => {
      b.addEventListener('click', () => {
        if (!projectsModalState) return;
        const p = b.getAttribute('data-ag-agent-preset');
        if (p === 'readonly') projectsModalState.tools = ['read_file', 'search_web'];
        else if (p === 'editor') projectsModalState.tools = ['read_file', 'edit_file', 'write_file', 'search_web'];
        else projectsModalState.tools = ['read_file', 'edit_file', 'write_file', 'run_command', 'manage_task', 'search_web'];
        renderAddAgentModal();
      });
    });

    projectsModalEl.querySelectorAll('[data-ag-agent-tool]').forEach((chk) => {
      chk.addEventListener('change', () => {
        if (!projectsModalState) return;
        const set = new Set(projectsModalState.tools || []);
        const key = chk.getAttribute('data-ag-agent-tool');
        if (chk.checked) set.add(key);
        else set.delete(key);
        projectsModalState.tools = Array.from(set);
      });
    });

    if (saveBtn) {
      saveBtn.addEventListener('click', async () => {
        if (!projectsModalState || projectsModalState.saving) return;
        if (typeof window.__agProjectCall !== 'function') {
          projectsModalState.error = L('本地写入桥接不可用，请重启 Anti-Claude 守护进程', 'Local write bridge unavailable');
          renderAddAgentModal();
          return;
        }
        projectsModalState.saving = true;
        projectsModalState.error = '';
        projectsModalState.successMsg = '';
        renderAddAgentModal();
        const res = await window.__agProjectCall(
          'createLocalAgent',
          {
            name: projectsModalState.name,
            description: projectsModalState.description,
            roleMode: projectsModalState.roleMode,
            tools: projectsModalState.tools,
            systemPrompt: projectsModalState.systemPrompt
          },
          15000
        );
        if (disposed || !projectsModalState) return;
        projectsModalState.saving = false;
        if (res && res.ok) {
          projectsModalState.name = '';
          projectsModalState.description = '';
          projectsModalState.systemPrompt = '';
          projectsModalState.createdPath = res.filePath || res.dirPath || '';
          projectsModalState.successMsg = L(
            `已创建子 Agent「${res.name}」（~/.gemini/config/agents/${res.name}.md），稍候或重进页面即可看到。`,
            `Subagent "${res.name}" created in ~/.gemini/config/agents/${res.name}.md.`
          );
          renderAddAgentModal();
        } else {
          const code = (res && res.error) || 'unknown';
          projectsModalState.error =
            code === 'reserved_agent_name'
              ? L('该名称与系统内置 Agent（self / browser / research 等）冲突，请换一个名称。', 'Name conflicts with a built-in agent (self, browser, research, etc.).')
              : code === 'agent_already_exists'
                ? L('同名子 Agent 文件已存在，请换一个名称。', 'An agent with this name already exists.')
                : L('创建失败：', 'Create failed: ') + String(code);
          renderAddAgentModal();
        }
      });
    }

    const importBtn = projectsModalEl.querySelector('[data-ag-agent-import]');
    if (importBtn) {
      importBtn.addEventListener('click', async () => {
        if (!projectsModalState || projectsModalState.saving) return;
        if (typeof window.__agProjectCall !== 'function') {
          projectsModalState.error = L('本地写入桥接不可用', 'Local write bridge unavailable');
          renderAddAgentModal();
          return;
        }
        projectsModalState.saving = true;
        projectsModalState.error = '';
        projectsModalState.successMsg = '';
        renderAddAgentModal();
        const res = await window.__agProjectCall('importLocalAgent', {}, 120000);
        if (disposed || !projectsModalState) return;
        projectsModalState.saving = false;
        if (res && res.ok && res.canceled) {
          renderAddAgentModal();
          return;
        }
        if (res && res.ok) {
          const names = (res.imported || []).map((x) => x.name).join('、');
          projectsModalState.createdPath = (res.imported && res.imported[0] && res.imported[0].filePath) || res.dirPath || '';
          projectsModalState.successMsg = L(`已成功导入子 Agent：${names}`, `Imported subagent(s): ${names}`);
          renderAddAgentModal();
        } else {
          const code = (res && res.error) || 'unknown';
          projectsModalState.error =
            code === 'missing_md_file'
              ? L('请选择 .md 格式的子 Agent 定义文件。', 'Please select .md agent definition file(s).')
              : L('导入失败：', 'Import failed: ') + String(code);
          renderAddAgentModal();
        }
      });
    }
  }

  function syncCustomizationsEnhancement() {
    if (disposed || !FEAT.customizations) {
      teardownCustomizationsEnhancement();
      return;
    }
    const searchInput = document.querySelector('[data-testid="customizations-search"]');
    if (!searchInput) {
      teardownCustomizationsEnhancement();
      return;
    }
    const stickyHdr = searchInput.closest('.sticky');
    const scrollRoot = stickyHdr && stickyHdr.parentElement;
    const bodyWrap = stickyHdr && stickyHdr.nextElementSibling;
    if (!stickyHdr || !scrollRoot || !bodyWrap) return;

    if (custSearchInputRef !== searchInput) {
      if (custSearchInputRef) custSearchInputRef.removeEventListener('input', onCustSearchInput);
      custSearchInputRef = searchInput;
      searchInput.addEventListener('input', onCustSearchInput);
    }

    const instTab = document.querySelector('[data-testid="plugins-tab-installed"]');
    const browseTab = document.querySelector('[data-testid="plugins-tab-browse"]');
    const isBrowse = Boolean(browseTab && browseTab.getAttribute('aria-current') === 'page');
    const isInstalled = !isBrowse && (Boolean(instTab && instTab.getAttribute('aria-current') === 'page') || !browseTab);

    scrollRoot.setAttribute('data-ag-cust-page', '1');
    scrollRoot.setAttribute('data-ag-cust-tab', isInstalled ? 'installed' : 'browse');
    stickyHdr.setAttribute('data-ag-cust-sticky', '1');

    const searching = Boolean((searchInput.value || '').trim());
    if (searching) scrollRoot.setAttribute('data-ag-cust-searching', '1');
    else scrollRoot.removeAttribute('data-ag-cust-searching');

    if (!isInstalled) {
      const oldBar = document.getElementById('ag-cust-cat-bar');
      if (oldBar) oldBar.remove();
      const oldAct = document.getElementById('ag-cust-skill-actions');
      if (oldAct) oldAct.remove();
      const oldAgentAct = document.getElementById('ag-cust-agent-actions');
      if (oldAgentAct) oldAgentAct.remove();
      return;
    }

    const sections = Array.from(bodyWrap.querySelectorAll('section'));
    const foundByCat = new Map();
    for (const sec of sections) {
      const cat = classifyCustomizationsSection(sec);
      if (!cat) continue;
      sec.setAttribute('data-ag-cust-sec', cat);
      const cntEl = sec.querySelector('[data-testid="customization-section-count"]');
      const countTxt = cntEl ? (cntEl.textContent || '').trim() : '';
      foundByCat.set(cat, { sec, countTxt });
    }

    const orderedCats = ['skills', 'plugins', 'mcp', 'agents'].filter((c) => foundByCat.has(c));
    if (orderedCats.length === 0) return;

    if (!custUserPickedCat && foundByCat.has('skills')) {
      custActiveCat = 'skills';
    } else if (custActiveCat !== 'all' && !foundByCat.has(custActiveCat)) {
      custActiveCat = orderedCats[0] || 'all';
    }

    const catLabels = {
      all: L('全部', 'All'),
      skills: L('技能与规则', 'Skills & Rules'),
      plugins: L('已安装插件', 'Plugins'),
      mcp: L('MCP 服务器', 'MCP Servers'),
      agents: L('自定义 Agent', 'Agents')
    };

    const hdrInner = stickyHdr.firstElementChild || stickyHdr;
    let catBar = document.getElementById('ag-cust-cat-bar');
    if (!catBar || !hdrInner.contains(catBar)) {
      if (catBar) catBar.remove();
      catBar = document.createElement('div');
      catBar.id = 'ag-cust-cat-bar';
      catBar.setAttribute('data-ag-i18n-ignore', '1');
      catBar.setAttribute('role', 'tablist');
      hdrInner.appendChild(catBar);
    }

    const tabsSpec = [...orderedCats, 'all'];
    const sig = tabsSpec.map((k) => `${k}:${k === custActiveCat ? 1 : 0}:${foundByCat.get(k)?.countTxt || ''}:${FEAT.i18n ? 1 : 0}`).join('|');
    if (catBar.dataset.agSig !== sig) {
      catBar.dataset.agSig = sig;
      catBar.innerHTML = tabsSpec
        .map((k) => {
          const active = k === custActiveCat;
          const cnt = k !== 'all' ? foundByCat.get(k)?.countTxt || '' : '';
          return `<button type="button" role="tab" class="ag-cust-cat-tab" data-ag-cust-cat="${k}" data-active="${active ? 'true' : 'false'}" aria-selected="${active ? 'true' : 'false'}"><span>${escapeHtml(
            catLabels[k] || k
          )}</span>${cnt ? `<span class="ag-cust-cat-cnt">${escapeHtml(cnt)}</span>` : ''}</button>`;
        })
        .join('');
      catBar.querySelectorAll('[data-ag-cust-cat]').forEach((b) => {
        b.addEventListener('click', () => {
          custUserPickedCat = true;
          custActiveCat = b.getAttribute('data-ag-cust-cat') || 'all';
          syncCustomizationsEnhancement();
          try {
            scrollRoot.scrollTop = 0;
          } catch {}
        });
      });
    }

    for (const [cat, { sec }] of foundByCat.entries()) {
      const shouldHide = !searching && custActiveCat !== 'all' && cat !== custActiveCat;
      if (shouldHide) sec.setAttribute('data-ag-cust-hidden', '1');
      else sec.removeAttribute('data-ag-cust-hidden');
    }

    /* Inject native-missing "+ Add skill" & "Open skills folder" buttons into Skills & Rules header */
    const skillsEntry = foundByCat.get('skills');
    if (skillsEntry && skillsEntry.sec) {
      const skillsSec = skillsEntry.sec;
      const filterBtn = skillsSec.querySelector('[data-testid="skills-rules-filter"]');
      const hdrRow = (filterBtn && filterBtn.parentElement) || (skillsSec.firstElementChild && skillsSec.firstElementChild);
      if (hdrRow) {
        let actWrap = document.getElementById('ag-cust-skill-actions');
        if (!actWrap || !hdrRow.contains(actWrap)) {
          if (actWrap) actWrap.remove();
          actWrap = document.createElement('div');
          actWrap.id = 'ag-cust-skill-actions';
          actWrap.setAttribute('data-ag-i18n-ignore', '1');
          actWrap.innerHTML =
            `<button type="button" id="ag-cust-open-skills-dir-btn" class="ag-cust-act-icon" title="${escapeHtml(
              L('打开技能目录 (~/.gemini/config/skills)', 'Open skills folder')
            )}" aria-label="${escapeHtml(L('打开技能目录', 'Open skills folder'))}">${SVG_PROJ_FOLDER_OPEN}</button>` +
            `<button type="button" id="ag-cust-add-skill-btn" class="ag-cust-act-btn">${SVG_PROJ_PLUS}<span>${L('添加技能', 'Add skill')}</span></button>`;
          if (filterBtn && filterBtn.parentElement === hdrRow) {
            filterBtn.insertAdjacentElement('beforebegin', actWrap);
          } else {
            hdrRow.appendChild(actWrap);
          }
          actWrap.querySelector('#ag-cust-open-skills-dir-btn')?.addEventListener('click', (e) => {
            e.stopPropagation();
            if (typeof window.__agProjectCall === 'function') {
              window.__agProjectCall('openSkillsDir', {}, 5000);
            }
          });
          actWrap.querySelector('#ag-cust-add-skill-btn')?.addEventListener('click', (e) => {
            e.stopPropagation();
            openAddSkillModal();
          });
        } else {
          const addLbl = actWrap.querySelector('#ag-cust-add-skill-btn span');
          if (addLbl) addLbl.textContent = L('添加技能', 'Add skill');
        }
      }
    }

    /* Inject native-missing "+ New subagent" & "Open agents folder" buttons into Custom Agents header */
    const agentsEntry = foundByCat.get('agents');
    if (agentsEntry && agentsEntry.sec) {
      const agentsSec = agentsEntry.sec;
      const hdrRow = agentsSec.firstElementChild;
      if (hdrRow) {
        let actWrap = document.getElementById('ag-cust-agent-actions');
        if (!actWrap || !hdrRow.contains(actWrap)) {
          if (actWrap) actWrap.remove();
          actWrap = document.createElement('div');
          actWrap.id = 'ag-cust-agent-actions';
          actWrap.className = 'ag-cust-hdr-actions';
          actWrap.setAttribute('data-ag-i18n-ignore', '1');
          actWrap.innerHTML =
            `<button type="button" id="ag-cust-open-agents-dir-btn" class="ag-cust-act-icon" title="${escapeHtml(
              L('打开子 Agent 目录 (~/.gemini/config/agents)', 'Open agents folder')
            )}" aria-label="${escapeHtml(L('打开子 Agent 目录', 'Open agents folder'))}">${SVG_PROJ_FOLDER_OPEN}</button>` +
            `<button type="button" id="ag-cust-add-agent-btn" class="ag-cust-act-btn">${SVG_PROJ_PLUS}<span>${L('新建子 Agent', 'New subagent')}</span></button>`;
          hdrRow.appendChild(actWrap);
          actWrap.querySelector('#ag-cust-open-agents-dir-btn')?.addEventListener('click', (e) => {
            e.stopPropagation();
            if (typeof window.__agProjectCall === 'function') {
              window.__agProjectCall('openAgentsDir', {}, 5000);
            }
          });
          actWrap.querySelector('#ag-cust-add-agent-btn')?.addEventListener('click', (e) => {
            e.stopPropagation();
            openAddAgentModal();
          });
        } else {
          const addLbl = actWrap.querySelector('#ag-cust-add-agent-btn span');
          if (addLbl) addLbl.textContent = L('新建子 Agent', 'New subagent');
        }
      }
    }
  }

  function syncProjectsWorkspace() {
    syncSidebarHideNativeProjects();
    syncCustomizationsEnhancement();
    if (!FEAT.projects) {
      teardownProjectsWorkspace();
      return;
    }
    const autoBtn = document.querySelector('[data-testid="automations-button"]');
    if (!autoBtn || !autoBtn.parentElement) return;
    let navBtn = document.getElementById('ag-claude-projects-nav-btn');
    if (!navBtn) {
      navBtn = document.createElement('button');
      navBtn.type = 'button';
      navBtn.id = 'ag-claude-projects-nav-btn';
      navBtn.setAttribute('data-testid', 'claude-projects-nav-button');
      navBtn.setAttribute('data-ag-i18n-ignore', '1');
      navBtn.className = autoBtn.className;
      navBtn.innerHTML =
        `<span class="shrink-0 flex items-center">${SVG_CLAUDE_PROJECTS_ICON}</span>` +
        `<span class="truncate ag-proj-nav-label">${L('项目', 'Projects')}</span>`;
      navBtn.addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation();
        toggleProjectsView();
      });
    }
    /* Keep positioned directly between Automations (`automations-button`) and Skills (`/customizations`) */
    if (navBtn.previousElementSibling !== autoBtn) {
      autoBtn.insertAdjacentElement('afterend', navBtn);
    }
    updateProjectsNavActiveVisual();
    if (!projectsDocListenerBound) {
      projectsDocListenerBound = true;
      document.addEventListener('click', onProjectsGlobalClick, true);
      document.addEventListener('keydown', onProjectsGlobalKeyDown, true);
      window.addEventListener('resize', positionProjectsOverlay);
    }
    if (projectsViewOpen) {
      ensureProjectsSidebarObserver();
      positionProjectsOverlay();
    }
    syncSidebarHideNativeProjects();
  }

  /* ---- scheduling: rAF-coalesced, throttled, and blind to our own DOM writes ---- */
  const MIN_SYNC_GAP_MS = 80;
  let throttleTimer = 0;
  function scheduleSync() {
    if (disposed || rafPending || throttleTimer) return;
    const wait = MIN_SYNC_GAP_MS - (Date.now() - lastSyncTs);
    if (wait > 0) {
      throttleTimer = later(() => {
        throttleTimer = 0;
        scheduleSync();
      }, wait);
      return;
    }
    rafPending = true;
    frame(syncStepStream);
  }

  const OWN_SEL =
    '.ag-claude-todo-card, .ag-claude-todo-live-dock, .ag-collapse-ghost, .ag-orbit-dots, .ag-elapsed-timer, #ag-claude-ctx-ring, #ag-claude-quota-popover, #ag-claude-model-popover, #ag-claude-model-subpop, .ag-claude-inline-editor, .ag-claude-folder-badges, #ag-claude-recent-section, #ag-recent-row-menu, #ag-project-action-menu, #ag-claude-ux-settings-nav, #ag-claude-ux-settings-panel, #ag-settings-stats-wrap, .ag-settings-subhdr-chev, #ag-claude-projects-nav-btn, #ag-claude-projects-view, #ag-claude-project-modal';
  const CLASS_WATCH_SEL =
    'ul.contains-task-list, [id="antigravity.agentSidePanelInputBox"], [data-testid="tool-group-collapsible"], [data-testid="worked-for-collapsible"], [data-testid="progress-updates-collapsible"], [data-testid="ephemeral-tool-status"]';

  function isOwnNode(n) {
    const el = n && (n.nodeType === 1 ? n : n.parentElement);
    return Boolean(el && el.closest && el.closest(OWN_SEL));
  }

  function isOwnChildListMutation(m) {
    if (isOwnNode(m.target)) return true;
    const total = m.addedNodes.length + m.removedNodes.length;
    if (!total) return true;
    for (const n of m.addedNodes) if (!isOwnNode(n)) return false;
    for (const n of m.removedNodes) if (!isOwnNode(n)) return false;
    return true;
  }

  const observer = new MutationObserver((mutations) => {
    if (disposed) return;
    let needSync = false;
    let sawChildList = false;
    for (const m of mutations) {
      if (m.type === 'attributes') {
        const t = m.target;
        if (!t || !t.getAttribute) continue;
        if (m.attributeName === 'aria-expanded') {
          if (FEAT.collapseAnim && t.getAttribute('data-testid') === 'tool-group-collapsible') {
            const exp = t.getAttribute('aria-expanded');
            if (exp === 'false') {
              animateCollapseIfNeeded(t);
            } else if (exp === 'true' && t.parentElement) {
              t.parentElement.querySelectorAll(':scope > .ag-collapse-ghost').forEach((g) => g.remove());
            }
          }
          if (!isOwnNode(t)) needSync = true;
        } else if (m.attributeName === 'class') {
          if (!isOwnNode(t) && t.closest && t.closest(CLASS_WATCH_SEL)) needSync = true;
        }
      } else if (m.type === 'childList') {
        if (!isOwnChildListMutation(m)) {
          needSync = true;
          sawChildList = true;
        }
      }
    }
    /* Synchronously translate & reconcile Settings in the microtask BEFORE Frame 0 paints so nothing ever flashes */
    if (sawChildList) {
      const sbNow = document.querySelector('[data-testid="settings-sidebar"]');
      if (sbNow !== settingsSidebarRef || sbNow) {
        if (FEAT.i18n && sbNow) {
          const dlgRoot = sbNow.closest('[role="dialog"]') || sbNow.closest('[data-split-root]') || sbNow.parentElement || sbNow;
          uxTranslateSubtree(dlgRoot);
        }
        reconcileSettingsPanel();
      }
    }
    if (needSync) scheduleSync();
  });

  let bodyEnhancementsMounted = false;
  let pendingBodyReadyCleanup = null;

  function mountBodyEnhancements() {
    if (disposed || bodyEnhancementsMounted || !document.body) return false;
    bodyEnhancementsMounted = true;
    window.__ag_custom_js_mounted = true;
    if (pendingBodyReadyCleanup) {
      pendingBodyReadyCleanup();
      pendingBodyReadyCleanup = null;
    }
    applyUiI18nState(FEAT.i18n);
    if (needsInitialPrefsSync) {
      persistUiPrefsToDaemon(localOverrideTs || Date.now());
    }
    observer.observe(document.body, {
      subtree: true,
      childList: true,
      attributes: true,
      attributeFilter: ['aria-expanded', 'class']
    });
    syncStepStream();
    return true;
  }

  if (!mountBodyEnhancements()) {
    const onBodyReady = () => {
      mountBodyEnhancements();
    };
    window.addEventListener('DOMContentLoaded', onBodyReady, { once: true });
    document.addEventListener('readystatechange', onBodyReady);
    let docElObs = null;
    if (typeof MutationObserver === 'function' && document.documentElement) {
      docElObs = new MutationObserver(() => {
        if (document.body) mountBodyEnhancements();
      });
      docElObs.observe(document.documentElement, { childList: true });
    }
    pendingBodyReadyCleanup = () => {
      window.removeEventListener('DOMContentLoaded', onBodyReady);
      document.removeEventListener('readystatechange', onBodyReady);
      if (docElObs) {
        docElObs.disconnect();
        docElObs = null;
      }
    };
  }

  function dispose() {
    if (disposed) return;
    disposed = true;
    window.__ag_custom_js_mounted = false;
    if (pendingBodyReadyCleanup) {
      pendingBodyReadyCleanup();
      pendingBodyReadyCleanup = null;
    }
    projectComposerDrafts.clear();
    observer.disconnect();
    stopUxI18nObserver();
    for (const id of pendingRafs) cancelAnimationFrame(id);
    pendingRafs.clear();
    for (const id of pendingTimeouts) clearTimeout(id);
    pendingTimeouts.clear();
    if (timerIntervalId) {
      clearInterval(timerIntervalId);
      timerIntervalId = null;
    }
    if (compactPollTimerId) {
      clearInterval(compactPollTimerId);
      compactPollTimerId = null;
    }
    compactedMetaByCid.clear();
    compactedStaleSigByCid.clear();
    document.removeEventListener('click', onDocClick, true);
    document.removeEventListener('pointerdown', onOutsidePopoverPointerDown, true);
    document.removeEventListener('keydown', onPopoverKeyDown, true);
    document.removeEventListener('pointerdown', onModelTriggerPointerDown, true);
    document.removeEventListener('mousedown', onModelTriggerSwallowMouseClick, true);
    document.removeEventListener('click', onModelTriggerSwallowMouseClick, true);
    document.removeEventListener('keydown', onModelPopoverKeyDown, true);
    document.removeEventListener('click', onRevertButtonClick, true);
    document.removeEventListener('keydown', onInlineEditDocKeyDown, true);
    document.removeEventListener('mouseenter', onMetricsPillMouseEnter, true);
    document.removeEventListener('mouseleave', onMetricsPillMouseLeave, true);
    document.removeEventListener('click', onMetricsPillClick, true);
    window.removeEventListener('resize', onWindowResizePopover);
    window.removeEventListener('focus', onWindowSidebarEvent);
    window.removeEventListener('blur', onWindowSidebarEvent);
    window.removeEventListener('popstate', onWindowSidebarEvent);
    if (sidebarStoreUnsub) {
      sidebarStoreUnsub();
      sidebarStoreUnsub = null;
      sidebarStoreRef = null;
    }
    closeInlineEdit(false);
    clearAllFolderBadges();
    removeRecentSection();
    clearSidebarHideNativeProjects();
    teardownCustomizationsEnhancement();
    teardownProjectsWorkspace();
    detachSettingsPanel();
    const ttEl = document.getElementById('ag-live-metrics-tooltip');
    if (ttEl) {
      ttEl.removeAttribute('data-ag-pinned');
      ttEl.removeAttribute('data-visible');
    }
    if (ownMetricsWrapper && window.__ag_render_metrics === ownMetricsWrapper) {
      window.__ag_render_metrics = ownMetricsWrapper.__agOrig;
      if (window.__ag_last_metrics && typeof window.__ag_last_metrics === 'object') {
        if (window.__ag_last_metrics.__agOrigInlineHtml !== undefined) {
          window.__ag_last_metrics.inlineHtml = window.__ag_last_metrics.__agOrigInlineHtml;
        }
        if (window.__ag_last_metrics.__agOrigTooltipHtml !== undefined) {
          window.__ag_last_metrics.tooltipHtml = window.__ag_last_metrics.__agOrigTooltipHtml;
        }
      }
      if (typeof window.__ag_render_metrics === 'function' && window.__ag_last_metrics) {
        try {
          window.__ag_render_metrics(window.__ag_last_metrics);
        } catch {}
      }
    }
    document
      .querySelectorAll(
        '.ag-collapse-ghost, .ag-orbit-dots, .ag-elapsed-timer, [data-ag-todo-mount], [data-ag-todo-dock], #ag-claude-ctx-ring, #ag-claude-quota-popover, #ag-claude-model-popover, #ag-claude-model-subpop'
      )
      .forEach((el) => el.remove());
    document
      .querySelectorAll(
        '[data-ag-todo-primary], [data-ag-todo-merged], [data-ag-todo-empty-wrap], [data-ag-todo-marker-line], [data-ag-model-open], [data-ag-inline-stream]'
      )
      .forEach((el) => {
        el.removeAttribute('data-ag-todo-primary');
        el.removeAttribute('data-ag-todo-merged');
        el.removeAttribute('data-ag-todo-empty-wrap');
        el.removeAttribute('data-ag-todo-marker-line');
        el.removeAttribute('data-ag-model-open');
        el.removeAttribute('data-ag-inline-stream');
      });
    restoreInlinePillBoundaries();
    restoreLegacySidebarCjkNodes();
    clearSidebarHideNativeProjects();
    clearPinnedSidebarRowTooltips();
    if (docRoot && docRoot.getAttribute('lang') === 'zh-CN') {
      if (hadDocLang && origDocLang !== null) docRoot.setAttribute('lang', origDocLang);
      else docRoot.removeAttribute('lang');
    }
    if (docRoot) {
      docRoot.removeAttribute('data-ag-ux-lang');
      docRoot.removeAttribute('data-ag-cjk-scale');
    }
    if (window.__agClaudeUxDispose === dispose) window.__agClaudeUxDispose = null;
  }

  window.__agClaudeUxDispose = dispose;
  if (typeof ctx !== 'undefined' && ctx && typeof ctx.onCleanup === 'function') {
    ctx.onCleanup(dispose);
  }
})();
