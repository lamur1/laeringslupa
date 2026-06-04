'use strict';

const DEFAULTS = {
  visible: true,
  loginGreen: 3,
  loginYellow: 7,
  submissionGreen: 7,
  submissionYellow: 14,
  lessonThreshold: 50,
  rowHighlight: false,
  gradingMode: 'teacher',
  copyLinkMode: 'both',
  showFundingBadge: false
};

const ids = ['loginGreen', 'loginYellow', 'submissionGreen', 'submissionYellow', 'lessonThreshold'];

chrome.storage.sync.get(DEFAULTS, (cfg) => {
  document.getElementById('toggle-visible').checked        = cfg.visible !== false;
  document.getElementById('toggle-highlight').checked      = cfg.rowHighlight !== false;
  document.getElementById('toggle-funding-badge').checked  = cfg.showFundingBadge === true;
  setSettingsEnabled(cfg.visible !== false);
  ids.forEach((id) => {
    const el = document.getElementById(id);
    if (el) el.value = cfg[id] ?? DEFAULTS[id];
  });
  setGradingMode(cfg.gradingMode || 'teacher');
  setCopyLinkMode(cfg.copyLinkMode || 'both');
  updateTynnLabel();
});

chrome.storage.local.get('cak_last_updated', (r) => {
  const el = document.getElementById('cache-status');
  if (!el) return;
  if (r.cak_last_updated) {
    const d    = new Date(r.cak_last_updated);
    const diff = Math.round((Date.now() - d) / 60000);
    const tid  = d.toLocaleTimeString('no-NO', { hour: '2-digit', minute: '2-digit' });
    el.textContent = diff < 2
      ? `Oppdatert nettopp (${tid})`
      : `Oppdatert for ${diff} min siden (${tid})`;
  } else {
    el.textContent = 'Ikke hentet ennå';
  }
});

document.getElementById('toggle-visible').addEventListener('change', (e) => {
  const visible = e.target.checked;
  document.getElementById('toggle-text').textContent = visible ? 'Vis' : 'Skjul';
  setSettingsEnabled(visible);
  save({ visible });
});

document.getElementById('toggle-highlight').addEventListener('change', (e) => {
  save({ rowHighlight: e.target.checked });
});

document.getElementById('toggle-funding-badge').addEventListener('change', (e) => {
  save({ showFundingBadge: e.target.checked });
});

// ─── Seksjonsvelger ───────────────────────────────────────────────────────────
chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
  if (!tabs[0]) return;
  const m = (tabs[0].url || '').match(/\/courses\/(\d+)/);
  if (!m) return;
  chrome.storage.local.get(`cak_sections_${m[1]}`, result => {
    const sections = result[`cak_sections_${m[1]}`] || [];
    if (!sections.length) return;
    const sel = document.getElementById('section-select');
    sections.forEach(s => {
      const opt = document.createElement('option');
      opt.value = s.id;
      opt.textContent = s.name;
      sel.appendChild(opt);
    });
    chrome.storage.sync.get('selectedSection', r => {
      if (r.selectedSection) sel.value = r.selectedSection;
    });
  });
});

document.getElementById('section-select').addEventListener('change', (e) => {
  const val = e.target.value || null;
  chrome.storage.sync.set({ selectedSection: val }, () => {
    // Slett all cache for dette kurset og hent ny data
    chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
      if (!tabs[0]) return;
      const m = (tabs[0].url || '').match(/\/courses\/(\d+)/);
      if (!m) return;
      const courseId = m[1];
      // Fjern alle seksjons-cacher for dette kurset
      chrome.storage.local.get(null, items => {
        const keysToRemove = Object.keys(items).filter(k => k.startsWith(`cak_data_${courseId}`));
        chrome.storage.local.remove(keysToRemove, () => {
          document.getElementById('cache-status').textContent = 'Oppdaterer…';
          chrome.tabs.reload(tabs[0].id);
          window.close();
        });
      });
    });
  });
});

document.getElementById('btn-refresh').addEventListener('click', () => {
  chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
    if (tabs[0]) {
      const m = (tabs[0].url || '').match(/\/courses\/(\d+)/);
      if (m) {
        chrome.storage.local.get(null, items => {
          const keysToRemove = Object.keys(items).filter(k => k.startsWith(`cak_data_${m[1]}`));
          chrome.storage.local.remove(keysToRemove, () => {
            document.getElementById('cache-status').textContent = 'Oppdaterer…';
            chrome.tabs.reload(tabs[0].id);
            window.close();
          });
        });
      }
    }
  });
});

function updateTynnLabel() {
  const yellow = parseInt(document.getElementById('loginYellow').value) || DEFAULTS.loginYellow;
  const el = document.getElementById('label-tynn');
  if (el) el.textContent = `${yellow + 1}–15 dager`;
}

ids.forEach((id) => {
  const el = document.getElementById(id);
  if (!el) return;
  el.addEventListener('change', () => {
    const val = Math.max(1, parseInt(el.value, 10) || DEFAULTS[id]);
    el.value = val;
    save({ [id]: val });
    if (id === 'loginYellow') updateTynnLabel();
  });
});

document.getElementById('grading-mode').addEventListener('click', (e) => {
  const btn = e.target.closest('.seg-btn');
  if (!btn) return;
  const val = btn.dataset.val;
  setGradingMode(val);
  save({ gradingMode: val });
});

function setGradingMode(val) {
  document.querySelectorAll('#grading-mode .seg-btn').forEach(b => {
    b.classList.toggle('active', b.dataset.val === val);
  });
}

function setCopyLinkMode(val) {
  document.querySelectorAll('#copy-link-mode .seg-btn').forEach(b => {
    b.classList.toggle('active', b.dataset.val === val);
  });
}

function save(changes) {
  chrome.storage.sync.set(changes);
}

function setSettingsEnabled(enabled) {
  const body = document.getElementById('settings-body');
  if (!body) return;
  body.classList.toggle('disabled-overlay', !enabled);
}

// ─── Copy-link-mode segmentknapper ────────────────────────────────────────
document.getElementById('copy-link-mode').addEventListener('click', (e) => {
  const btn = e.target.closest('.seg-btn');
  if (!btn) return;
  const val = btn.dataset.val;
  setCopyLinkMode(val);
  save({ copyLinkMode: val });
});

// ─── Fargekategori-filtrering ──────────────────────────────────────────────
function loadColorStats() {
  chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
    if (!tabs[0]) return;
    const isGradebook = /\/courses\/\d+\/gradebook/.test(tabs[0].url || '');
    if (!isGradebook) {
      document.getElementById('filter-status').textContent = 'Åpne vurderingsoversikten for å bruke';
      return;
    }
    chrome.tabs.sendMessage(tabs[0].id, { type: 'GET_COLOR_STATS' }, (resp) => {
      if (chrome.runtime.lastError || !resp || resp.loading) {
        document.getElementById('filter-status').textContent = 'Henter elevdata…';
        setTimeout(loadColorStats, 2000);
        return;
      }
      document.getElementById('badge-green').textContent  = resp.green.length;
      document.getElementById('badge-yellow').textContent = resp.yellow.length;
      document.getElementById('badge-red').textContent    = resp.red.length;
      const total = resp.green.length + resp.yellow.length + resp.red.length;
      document.getElementById('filter-status').textContent =
        total > 0
          ? `${total} elev${total === 1 ? '' : 'er'} med fargemerking`
          : 'Ingen elever med fargemerking ennå';
      ['filter-green', 'filter-yellow', 'filter-red', 'filter-clear', 'filter-lesson-count'].forEach(id => {
        document.getElementById(id).disabled = false;
      });
    });
  });
}

['green', 'yellow', 'red'].forEach(color => {
  const btn = document.getElementById(`filter-${color}`);
  if (!btn) return;
  btn.addEventListener('click', () => {
    btn.disabled = true;
    chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
      if (!tabs[0]) { btn.disabled = false; return; }
      chrome.tabs.sendMessage(tabs[0].id, { type: 'FILTER_BY_COLOR', category: color }, (resp) => {
        btn.disabled = false;
        if (chrome.runtime.lastError || !resp) return;
        const el = document.getElementById('filter-feedback');
        if (el) {
          el.textContent = resp.count > 0
            ? `Filtrerte frem ${resp.count} elev${resp.count === 1 ? '' : 'er'}`
            : 'Ingen elever i denne kategorien';
          setTimeout(() => { el.textContent = ''; }, 3000);
        }
      });
    });
  });
});

document.getElementById('filter-lesson-count').addEventListener('click', () => {
  const btn = document.getElementById('filter-lesson-count');
  const val = parseInt(document.getElementById('lesson-count-input').value, 10);
  if (isNaN(val)) return;
  btn.disabled = true;
  chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
    if (!tabs[0]) { btn.disabled = false; return; }
    chrome.tabs.sendMessage(tabs[0].id, { type: 'FILTER_BY_LESSON_COUNT', maxGodkjent: val }, (resp) => {
      btn.disabled = false;
      if (chrome.runtime.lastError || !resp) return;
      const clearBtn = document.getElementById('filter-lesson-count-clear');
      const el = document.getElementById('filter-lesson-feedback');
      if (resp.count > 0) {
        if (clearBtn) clearBtn.style.display = '';
        if (el) {
          el.textContent = `Filtrerte frem ${resp.count} elev${resp.count === 1 ? '' : 'er'}`;
          setTimeout(() => { el.textContent = ''; }, 3000);
        }
      } else {
        if (el) {
          el.textContent = 'Ingen elever i denne kategorien';
          setTimeout(() => { el.textContent = ''; }, 3000);
        }
      }
    });
  });
});

document.getElementById('filter-lesson-count-clear').addEventListener('click', () => {
  const clearBtn = document.getElementById('filter-lesson-count-clear');
  clearBtn.disabled = true;
  chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
    if (!tabs[0]) { clearBtn.disabled = false; return; }
    chrome.tabs.sendMessage(tabs[0].id, { type: 'CLEAR_COLOR_FILTER' }, (resp) => {
      clearBtn.disabled = false;
      clearBtn.style.display = 'none';
      const el = document.getElementById('filter-lesson-feedback');
      if (el) {
        el.textContent = 'Filter nullstilt';
        setTimeout(() => { el.textContent = ''; }, 2000);
      }
    });
  });
});

document.getElementById('filter-clear').addEventListener('click', () => {
  const btn = document.getElementById('filter-clear');
  btn.disabled = true;
  chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
    if (!tabs[0]) { btn.disabled = false; return; }
    chrome.tabs.sendMessage(tabs[0].id, { type: 'CLEAR_COLOR_FILTER' }, (resp) => {
      btn.disabled = false;
      const el = document.getElementById('filter-feedback');
      if (el) {
        el.textContent = resp && resp.removed > 0
          ? `Fjernet ${resp.removed} elev${resp.removed === 1 ? '' : 'er'} fra filteret`
          : 'Ingen aktive filtre';
        setTimeout(() => { el.textContent = ''; }, 2500);
      }
    });
  });
});

loadColorStats();
