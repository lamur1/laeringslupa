// ============================================================
// DESIGNREGLER — ikke endre uten å forstå konsekvensene:
//
// GRØNN BAR = kun must_view (Vis-krav) — lærestoff uten dato.
//             Filtrer ALLTID på: completion_requirement.type === 'must_view'
//             Aldri alle completion_requirement — da trekkes innleveringer inn.
//
// PRIKKER    = must_submit (innleveringer med dato) — vises under streken.
//             Bruker missing-flagg og due_at fra Canvas API.
//
// FREMTIDSPRIKKER = futureCount minus allerede leverte — aldri isStarted-sjekk.
//
// Disse reglene ble brutt 20.04.2026 og kostet en økt å rette opp.
// ============================================================

(function () {
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

  let cfg = { ...DEFAULTS };
  let studentData = {};
  let overlayEl = null;
  let tooltipEl = null;
  let tooltipFontSize = null;
  let lastTipEvent = null;
  let attachedViewport = null;
  let headerAttachedParent = null;
  let isUpdating = false;
  let sortActive  = false;
  let cellCache      = new Map(); // sid -> cak-cell element
  let headerCellEl   = null;
  let loadingBarEl   = null;
  let isLoading      = false;
  let moduleCompletionCache = {}; // sid -> [{id, name, total, completed}] | false
  let freshModuleSids       = new Set(); // sids som er henta fersk frå API denne sesjonen
  let moduleDeadlineMap     = {}; // modId -> latest due_at Date | null
  let currentHoverSid = null;
  let studentNames = {}; // sid -> name
  let moduleMapGlobal = {}; // modId -> [assignments] (modul-nivå for kopieringslenker)
  let moduleNameMapGlobal = {}; // modId -> name

  const COPY_SVG  = '<svg width="13" height="13" viewBox="0 0 13 13" fill="none" stroke="currentColor" stroke-width="1.1" stroke-linecap="round" stroke-linejoin="round"><rect x="4" y="0.5" width="8.5" height="8.5" rx="1.3"/><rect x="0.5" y="4" width="8.5" height="8.5" rx="1.3" fill="white" stroke="currentColor"/></svg>';
  const CHECK_SVG = '<svg width="13" height="13" viewBox="0 0 13 13" fill="none" stroke="#3b6d11" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="1.5,7 5,10.5 11.5,2.5"/></svg>';
  const SAVE_SVG  = '<svg width="13" height="13" viewBox="0 0 13 13" fill="none" stroke="currentColor" stroke-width="1.1" stroke-linecap="round" stroke-linejoin="round"><line x1="6.5" y1="1.5" x2="6.5" y2="8.5"/><polyline points="4,6.5 6.5,9 9,6.5"/><line x1="2" y1="11.5" x2="11" y2="11.5"/></svg>';

  function getColW() { return cfg.showFundingBadge ? 155 : 130; }

  chrome.storage.sync.get(DEFAULTS, (saved) => {
    cfg = { ...DEFAULTS, ...saved };
    waitForGradebook();
  });

  // Hent seksjoner direkte fra Canvas API og cache i chrome.storage.local.
  (function cacheSections() {
    const courseMatch = location.pathname.match(/\/courses\/(\d+)/);
    if (!courseMatch) return;
    const cId = courseMatch[1];
    fetch(`/api/v1/courses/${cId}/sections?per_page=100`)
      .then(r => r.ok ? r.json() : [])
      .then(sections => {
        if (!Array.isArray(sections) || !sections.length) return;
        chrome.storage.local.set({
          [`cak_sections_${cId}`]: sections.map(s => ({ id: String(s.id), name: s.name }))
        });
      })
      .catch(() => {});
  })();

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'sync') return; // berre brukarinnstillingar, ikkje lokal cache
    for (const key in changes) cfg[key] = changes[key].newValue;
    invalidateCache();
    updateOverlay();
  });

  // ─── Vent på gradebook ────────────────────────────────────────────────────
  function waitForGradebook() {
    const check = () => {
      const canvas = findFrozenCanvas();
      if (canvas && canvas.querySelectorAll('.slick-row').length > 0) {
        setTimeout(init, 800);
      } else {
        setTimeout(check, 600);
      }
    };
    check();
  }

  async function init() {
    injectStyles();
    createTooltip();
    createOverlay();
    await fetchData();
    await loadModuleCache();
    invalidateCache();
    updateOverlay();
    observeChanges();
    // Canvas fortsetter å justere grid etter init — forsinkede re-renders fanger dette
    setTimeout(updateOverlay, 1500);
    setTimeout(updateOverlay, 4000);
    // Last modulvisningsdata i bakgrunnen — fyller visningsbar etter hvert
    backgroundLoadModuleCompletion();
    // Bakgrunnsoppdatering: hent alltid ferske aktivitetsdata kort tid etter
    // den raske cache-visinga — sikrar at sirkel og firkant viser korrekt tilstand
    // utan å vente opp til 5 minutt på SOFT_REFRESH
    setTimeout(async () => {
      try {
        await fetchData(true);
        await loadModuleCache();
        invalidateCache();
        updateOverlay();
      } catch (_) {}
    }, 3000);
  }

  // ─── Statsstøtte-badge ────────────────────────────────────────────────────
  function fundingBadgeActive() {
    return cfg.showFundingBadge && Object.keys(moduleMapGlobal).length >= 12;
  }

  function getFundingBadge(godkjent) {
    if (!fundingBadgeActive() || godkjent === undefined || godkjent === null) return null;
    if (godkjent === 0) return null;
    if (godkjent >= 12) return { cls: 'green', label: '✓ ' + godkjent, color: '#2e7d32', border: '#2e7d32', bg: '#2e7d32' };
    if (godkjent >= 10) return { cls: 'yellow', label: String(godkjent), color: '#b07d00', border: '#e6a817', bg: '#e6a817' };
    return { cls: 'red', label: String(godkjent), color: '#c0392b', border: '#c0392b', bg: '#c0392b' };
  }

  // ─── Les modulcache frå persistent lagring ───────────────────────────────
  async function loadModuleCache() {
    const courseId = getCourseId();
    if (!courseId) return;
    const key = `cak_mod_${courseId}`;
    const cacheTime = 60 * 60 * 1000;
    try {
      const cached = await new Promise(res => chrome.storage.local.get(key, r => res(r[key])));
      if (!cached || (Date.now() - cached.ts) >= cacheTime) return;
      // Slå saman i staden for å erstatte: bevar fersk data for elevar der
      // backgroundLoadModuleCompletion allereie har henta ny data denne sesjonen.
      // moduleCompletionCache.hasOwnProperty(sid) = fersk henting pågår/ferdig → ikkje overskriv.
      for (const [sid, data] of Object.entries(cached.data)) {
        if (moduleCompletionCache.hasOwnProperty(sid)) continue; // fersk sesjondata — behald
        moduleCompletionCache[sid] = data;
        if (!studentData[sid] || !Array.isArray(data)) continue;
        if (studentData[sid].avgViewPct === undefined) {
          studentData[sid].avgViewPct = calcAvgViewPct(data, studentData[sid]?.activeMods);
        }
        recalcDotsFromModules(sid, data);
      }
    } catch (e) {}
  }

  // ─── CSS ──────────────────────────────────────────────────────────────────
  function injectStyles() {
    const existing = document.getElementById('cak-styles');
    if (existing) existing.remove();
    const s = document.createElement('style');
    s.id = 'cak-styles';
    s.textContent = `
      #cak-overlay {
        position: absolute;
        z-index: 250;
        top: 0;
        pointer-events: none;
        overflow: visible;
        border: 1px solid #c0beb5;
        border-top: none;
        border-radius: 0 0 7px 7px;
        box-shadow: 0 3px 12px rgba(0,0,0,0.14), 0 1px 4px rgba(0,0,0,0.07);
      }
      .cak-col-header {
        position: absolute;
        display: flex;
        align-items: center;
        justify-content: center;
        gap: 5px;
        background: #1a1f1a;
        border: 1px solid #1a1f1a;
        border-radius: 7px 7px 0 0;
        box-shadow: 0 -3px 8px rgba(0,0,0,0.18), 0 -1px 3px rgba(0,0,0,0.10);
        box-sizing: border-box;
        font-size: 11px;
        color: #fff;
        font-family: LatoWeb, Lato, sans-serif;
        font-weight: 600;
        letter-spacing: 0.03em;
        z-index: 251;
      }
      .cak-cell {
        position: absolute;
        left: 0;
        display: flex;
        align-items: center;
        justify-content: center;
        gap: 5px;
        border-bottom: 0.5px solid #eceae2;
        box-sizing: border-box;
        width: 100%;
        cursor: default;
        pointer-events: all;
        padding: 0 5px;
      }
      .cak-cell-icons {
        display: inline-flex;
        align-items: center;
        justify-content: center;
        gap: 5px;
        padding: 2px 4px;
        border-radius: 7px;
        background: rgba(255, 255, 255, 0.58);
        border: 0.5px solid rgba(211, 209, 199, 0.7);
      }
      .cak-col-header-loading {
        overflow: hidden;
      }
      .cak-col-header-loading::after {
        content: '';
        position: absolute;
        top: 0; left: -100%;
        width: 60%; height: 100%;
        background: linear-gradient(90deg, transparent, rgba(255,255,255,0.18), transparent);
        animation: cak-shimmer 1.6s ease-in-out infinite;
        pointer-events: none;
      }
      @keyframes cak-shimmer {
        0%   { left: -60%; }
        100% { left: 160%; }
      }
      .cak-col-header-done {
        overflow: hidden;
      }
      .cak-col-header-done::after {
        content: '';
        position: absolute;
        inset: 0;
        background: rgba(255,255,255,0.25);
        animation: cak-salute 0.75s ease-out forwards;
        pointer-events: none;
      }
      @keyframes cak-salute {
        0%   { opacity: 0; }
        25%  { opacity: 1; }
        100% { opacity: 0; }
      }
      .cak-cell:hover {
        background: rgba(59, 109, 17, 0.08) !important;
        box-shadow: inset 3px 0 0 #3b6d11;
      }
      .cak-ring {
        display: inline-block;
        width: 18px; height: 18px;
        border-radius: 50%;
        box-sizing: border-box;
        flex-shrink: 0;
      }
      /* Fylt sirkel = nylig innlogget → tom ring = lenge siden. Redundant koding: fyllgrad + kanttykkelse */
      .cak-ring-4 { background: #639922; border: 2px solid #3b6d11; }
      .cak-ring-3 { background: conic-gradient(#639922 0deg 270deg, #dddbd3 270deg 360deg); border: 1.5px solid #b4b2a9; }
      .cak-ring-2 { background: conic-gradient(#97c459 0deg 180deg, #dddbd3 180deg 360deg); border: 1px solid #b4b2a9; }
      .cak-ring-1 { background: #dddbd3; border: 0.75px solid #b4b2a9; }
      .cak-mark {
        display: inline-block;
        width: 14px;
        height: 14px;
        border-radius: 2px;
        box-sizing: border-box;
        flex-shrink: 0;
      }
      /* Fylt firkant = nylig levert → tom firkant = lenge siden / aldri */
      .cak-v    { background: #639922; border: 1.5px solid #3b6d11; }
      .cak-dash { background: linear-gradient(90deg, #888780 50%, #e8e6de 50%); border: 1px solid #b4b2a9; }
      .cak-x    { background: rgba(198, 40, 40, 0.10); border: 1.5px solid #a32d2d; }
      .cak-loading-bar {
        position: absolute;
        top: 0;
        left: 0;
        width: 3px;
        bottom: 0;
        z-index: 10;
        overflow: hidden;
        border-radius: 1px;
      }
      .cak-loading-bar::after {
        content: '';
        position: absolute;
        top: -40%;
        left: 0;
        width: 100%;
        height: 40%;
        background: linear-gradient(180deg, transparent, #3b6d11, #639922, transparent);
        animation: cak-sweep 1.4s ease-in-out infinite;
      }
      @keyframes cak-sweep {
        0%   { top: -40%; }
        100% { top: 100%; }
      }
      #cak-tooltip {
        position: fixed;
        background: #fff;
        border: 1px solid #c8c5bc;
        border-radius: 6px;
        padding: 6px 11px 10px;
        font-size: 11px;
        color: #2d3b45;
        font-family: LatoWeb, Lato, sans-serif;
        white-space: nowrap;
        z-index: 9999;
        pointer-events: none;
        display: none;
        box-shadow: 0 2px 8px rgba(0,0,0,0.13);
        line-height: 1.8;
        min-width: 180px;
      }
      .cak-copy-btn, .cak-save-btn {
        position: absolute;
        right: 4px;
        display: inline-flex;
        align-items: center;
        justify-content: center;
        width: 15px;
        height: 15px;
        border-radius: 3px;
        color: #c0beb5;
        cursor: pointer;
        opacity: 0;
        transition: opacity .15s, color .15s, background .15s;
        pointer-events: all;
      }
      .cak-copy-btn { top: 3px; }
      .cak-save-btn { bottom: 3px; }
      .cak-cell:hover .cak-copy-btn,
      .cak-cell:hover .cak-save-btn { opacity: 1; }
      .cak-copy-btn:hover { color: #5f5e5a !important; background: rgba(0,0,0,0.06); }
      .cak-save-btn:hover  { color: #3b6d11  !important; background: rgba(0,0,0,0.06); }
      .cak-copy-btn.cak-copied { color: #3b6d11 !important; opacity: 1; }
      .cak-funding-pill {
        margin-left: auto;
        font-size: 9px;
        font-weight: 700;
        padding: 1px 5px;
        border-radius: 8px;
        letter-spacing: 0.02em;
        flex-shrink: 0;
        white-space: nowrap;
        pointer-events: none;
      }
      .cak-funding-green  { background: #fff; color: #2e7d32; border: 1.5px solid #2e7d32; }
      .cak-funding-yellow { background: #fff; color: #b07d00; border: 1.5px solid #e6a817; }
      .cak-funding-red    { background: #fff; color: #c0392b; border: 1.5px solid #c0392b; }
      .cak-funding-cell-green  { background: #f2faf2 !important; box-shadow: inset 0 0 0 1.5px #4caf50; }
      .cak-funding-cell-yellow { background: #fffbf0 !important; box-shadow: inset 0 0 0 1.5px #e6a817; }
      .cak-funding-cell-red    { background: #fff5f5 !important; box-shadow: inset 0 0 0 1.5px #c0392b; }
      .cak-view-bar-wrap {
        position: absolute;
        bottom: 0;
        left: 0;
        width: 100%;
        height: 2px;
        overflow: hidden;
      }
      .cak-view-bar-fill {
        height: 100%;
        background: linear-gradient(90deg, #b8d98a, #639922);
        border-radius: 0 1px 1px 0;
        transition: width 0.5s ease;
        width: 0;
      }
      .cak-view-bar-loading .cak-view-bar-fill {
        width: 100%;
        background: #d3d1c7;
        animation: cak-pulse-bar 1.8s ease-in-out infinite;
      }
      @keyframes cak-pulse-bar {
        0%, 100% { opacity: 0.4; }
        50% { opacity: 0.9; }
      }
    `;
    document.head.appendChild(s);
  }

  // ─── Tooltip ──────────────────────────────────────────────────────────────
  function createTooltip() {
    const existing = document.getElementById('cak-tooltip');
    if (existing) existing.remove(); // fjern fra forrige IIFE-kjøring
    tooltipEl = document.createElement('div');
    tooltipEl.id = 'cak-tooltip';
    document.body.appendChild(tooltipEl);
  }
  function showTip(e, html, fontSize) {
    tooltipEl.innerHTML = html;
    if (fontSize) tooltipEl.style.fontSize = fontSize;
    tooltipEl.style.display = 'block';
    lastTipEvent = e;
    moveTip(e);
  }
  function moveTip(e) {
    const tipH  = tooltipEl.offsetHeight;
    const tipW  = tooltipEl.offsetWidth;
    const above = e.clientY - tipH - 8;
    const top   = above >= 0 ? above : e.clientY + 20;
    const left  = (e.clientX + 14 + tipW > window.innerWidth)
      ? e.clientX - tipW - 14
      : e.clientX + 14;
    tooltipEl.style.left = left + 'px';
    tooltipEl.style.top  = top  + 'px';
  }
  function hideTip() { tooltipEl.style.display = 'none'; }

  // ─── Overlay ──────────────────────────────────────────────────────────────
  function createOverlay() {
    const existing = document.getElementById('cak-overlay');
    if (existing) { existing.remove(); overlayEl = null; attachedViewport = null; }
    if (headerCellEl) { headerCellEl.remove(); headerCellEl = null; headerAttachedParent = null; }
    overlayEl = document.createElement('div');
    overlayEl.id = 'cak-overlay';
    document.body.appendChild(overlayEl);
  }

  function attachOverlayToViewport(frozenCanvas) {
    const viewport = frozenCanvas.parentElement;
    if (!viewport || viewport === attachedViewport) return;
    if (getComputedStyle(viewport).position === 'static') {
      viewport.style.position = 'relative';
    }
    viewport.appendChild(overlayEl);
    attachedViewport = viewport;
  }

  // ─── Hent data fra Canvas API (med lokal cache) ───────────────────────────
  async function fetchData(forceRefresh = false) {
    const courseId = getCourseId();
    if (!courseId) return;

    // Les valgt seksjon fra lagrede innstillinger
    const sectionId = await new Promise(res =>
      chrome.storage.sync.get('selectedSection', r => res(r.selectedSection || null))
    );

    const cacheKey  = sectionId ? `cak_data_${courseId}_s${sectionId}` : `cak_data_${courseId}`;
    const cacheTime = 15 * 60 * 1000; // 15 min — leksjonsdata (cak_mod_) har eigen 2t-cache
    // Merk: moduleCompletionCache rørast IKKJE ved forceRefresh —
    // moduldata har eigen TTL via cak_mod_ og blir oppdatert av backgroundLoadModuleCompletion.
    // Å tømme moduleCompletionCache her ville øydeleggje pågåande bakgrunnslasting
    // og føre til at grøne barar forsvinn når oppdateringa er ferdig.

    // Sjekk cache først
    if (!forceRefresh) {
      try {
        const cached = await new Promise(res =>
          chrome.storage.local.get(cacheKey, r => res(r[cacheKey]))
        );
        if (cached && (Date.now() - cached.ts) < cacheTime) {
          studentData = cached.data;
          // Gjenopprett subMissingSet frå serialisert array
          for (const s of Object.values(studentData)) {
            if (Array.isArray(s.subMissingSet)) s.subMissingSet = new Set(s.subMissingSet);
          }
          updateCacheStatus(new Date(cached.ts));
          return;
        }
      } catch (e) {}
    }

    // Velg API-base avhengig av seksjon
    const enrollBase = sectionId
      ? `/api/v1/sections/${sectionId}/enrollments`
      : `/api/v1/courses/${courseId}/enrollments`;
    const subBase = sectionId
      ? `/api/v1/sections/${sectionId}/students/submissions`
      : `/api/v1/courses/${courseId}/students/submissions`;

    try {
      isLoading = true;

      // Fase 1: rask data — vis ringer med en gang
      const [enrollments, assignments, modules] = await Promise.all([
        paginate(`${enrollBase}?type[]=StudentEnrollment&include[]=last_activity_at&per_page=100`),
        paginate(`/api/v1/courses/${courseId}/assignments?per_page=100`),
        paginate(`/api/v1/courses/${courseId}/modules?include[]=items&include[]=content_details&per_page=100`)
      ]);

      enrollments.forEach((e) => {
        const sid = String(e.user_id);
        if (!studentData[sid]) studentData[sid] = {};
        studentData[sid].lastActivity = e.last_activity_at
          ? new Date(e.last_activity_at) : null;
      });
      invalidateCache();
      updateOverlay(); // Vis ringer umiddelbart — indikator vises i hodet

      // Fase 2: innleveringer (tung) — fullfør datagrunnlaget
      const submissions = await paginate(`${subBase}?student_ids[]=all&per_page=100`);

      processStudentData(enrollments, submissions, assignments, modules);
      isLoading = false;
      invalidateCache();
      updateOverlay();

      const courseId2 = getCourseId();
      if (courseId2) {
        // Serialiser subMissingSet (Set) til array slik at JSON-runden overlever
        const serialised = {};
        for (const [sid, s] of Object.entries(studentData)) {
          serialised[sid] = {
            ...s,
            subMissingSet: s.subMissingSet instanceof Set ? [...s.subMissingSet] : []
          };
        }
        chrome.storage.local.set({ [cacheKey]: { ts: Date.now(), data: serialised } });
      }
      updateCacheStatus(new Date());

    } catch (err) {
      isLoading = false;
      console.warn('[Canvas Aktivitetskolonne] Feil ved henting av data:', err);
    }
  }

  function processStudentData(enrollments, submissions, assignments, modules) {
    // Oppslag-kart: assignment-ID og discussion-ID → assignment
    const assignmentById = {};
    const discussionIdToAssignment = {};
    assignments.forEach(a => {
      assignmentById[String(a.id)] = a;
      if (a.discussion_topic) {
        discussionIdToAssignment[String(a.discussion_topic.id)] = a;
      }
    });

    // Hent elevnavn fra enrollment-data (Canvas inkluderer user-objekt som standard)
    enrollments.forEach((e) => {
      const sid = String(e.user_id);
      if (e.user && e.user.name && !studentNames[sid]) {
        studentNames[sid] = e.user.name;
      }
    });

    // Bygg moduleMap: modId → [assignment, ...] — inkluderer oppgaver, NQ og diskusjoner
    moduleMapGlobal = {};
    moduleNameMapGlobal = {};
    const moduleAssignmentIds = new Set();
    modules.forEach(mod => {
      moduleNameMapGlobal[String(mod.id)] = mod.name;
      const modAssignments = [];
      (mod.items || []).forEach(item => {
        let asgn = null;
        if (item.type === 'Assignment' || item.type === 'Quiz') {
          asgn = assignmentById[String(item.content_id)];
        } else if (item.type === 'Discussion') {
          asgn = discussionIdToAssignment[String(item.content_id)];
        } else if (item.type === 'ExternalTool' && item.content_id) {
          // New Quizzes og andre LTI-er: hent frist fra content_details direkte på item.
          // Faller tilbake på assignment hvis Canvas har laget en for dette content_id.
          const dueAt = (item.content_details && item.content_details.due_at)
                     || (assignmentById[String(item.content_id)] && assignmentById[String(item.content_id)].due_at);
          if (dueAt) {
            asgn = assignmentById[String(item.content_id)] || {
              id:                  item.content_id,
              name:                item.title || 'Ekstern oppgave',
              due_at:              dueAt,
              omit_from_final_grade: false,
              grading_type:        'points',
              submission_types:    ['external_tool']
            };
          }
        }
        if (asgn && asgn.published !== false) {
          moduleAssignmentIds.add(String(asgn.id));
          modAssignments.push(asgn);
        }
      });
      if (modAssignments.length > 0) {
        moduleMapGlobal[String(mod.id)] = modAssignments;
      }
    });

    const hasAnyDeadlines = [...moduleAssignmentIds].some(id => assignmentById[id]?.due_at);

    // Bygg modId -> seneste due_at for stiplet visning av fremtidige leksjoner
    moduleDeadlineMap = {};
    Object.entries(moduleMapGlobal).forEach(([modId, assignments]) => {
      const dates = assignments.map(a => a.due_at ? new Date(a.due_at) : null).filter(Boolean);
      moduleDeadlineMap[modId] = dates.length > 0 ? new Date(Math.max(...dates)) : null;
    });

    enrollments.forEach((e) => {
      const sid = String(e.user_id);
      if (!studentData[sid]) studentData[sid] = {};
      studentData[sid].lastActivity = e.last_activity_at
        ? new Date(e.last_activity_at) : null;
    });

    const byStudent = {};
    submissions.forEach((s) => {
      const sid = String(s.user_id);
      if (!byStudent[sid]) byStudent[sid] = [];
      byStudent[sid].push(s);
    });

    // Bygg oppslagstabell: assignmentId → 'auto' | 'teacher'
    // pass_fail med grade='complete'/'pass' er alltid lærergradet — grader_id er upålitelig
    // (Canvas bruker grader_id=-15 når karakter settes via karakterboken i stedet for SpeedGrader)
    // Fallback: grader_id-fortegn, deretter external_tool-heuristikk
    // Bygg oppslagstabell: assignmentId → 'auto' | 'teacher'
    // pass_fail/complete_incomplete er alltid lærergradet — grader_id er upålitelig
    // (Canvas bruker grader_id=-15 ved karaktersetting via karakterboken)
    // NQ-settet bygges først, uavhengig av grader_id-logikken.
    // NQ identifiseres via external_tool_tag_attributes.url som inneholder 'quiz-lti'.
    // Klassisk quiz (online_quiz) brukes ikke på Globalskolen og ignoreres.
    const nqIds = new Set();
    Object.values(assignmentById).forEach(a => {
      if ((a.submission_types || []).includes('external_tool') &&
          a.external_tool_tag_attributes?.url?.includes('quiz-lti')) {
        nqIds.add(String(a.id));
      }
    });

    const assignmentTypeMap = {};
    Object.values(assignmentById).forEach(a => {
      const aid = String(a.id);
      if (nqIds.has(aid)) {
        assignmentTypeMap[aid] = 'nq';
      } else if (a.grading_type === 'pass_fail' || a.grading_type === 'complete_incomplete') {
        assignmentTypeMap[aid] = 'teacher';
      }
    });
    submissions.forEach(s => {
      const aid = String(s.assignment_id);
      if (assignmentTypeMap[aid]) return; // NQ og pass_fail allerede satt
      if (s.grader_id == null) return;
      assignmentTypeMap[aid] = Number(s.grader_id) < 0 ? 'auto' : 'teacher';
    });

    Object.entries(byStudent).forEach(([sid, subs]) => {
      if (!studentData[sid]) studentData[sid] = {};

      // Lagre Mangler-sett for bakgrunnsoppdatering av prikker
      studentData[sid].subMissingSet = new Set(
        subs.filter(s => s.missing === true).map(s => String(s.assignment_id))
      );

      // Siste innlevering — graded_at og updated_at som fallback for pass_fail/NQ
      const submitted = subs.filter(s =>
        s.submitted_at || s.graded_at ||
        (s.updated_at && (s.grade === 'complete' || s.grade === 'pass' || s.workflow_state === 'graded'))
      );
      if (submitted.length) {
        const latest = submitted.reduce((a, b) => {
          const da = new Date(a.submitted_at || a.graded_at || a.updated_at);
          const db = new Date(b.submitted_at || b.graded_at || b.updated_at);
          return da > db ? a : b;
        });
        studentData[sid].lastSubmission = new Date(latest.submitted_at || latest.graded_at || latest.updated_at);
      }

      // Gruppert per modul (leksjon) — én modul = én leksjon
      const lessons = {};
      let hoppetOver = 0;
      const skippedPerMod = {};
      const missingByMod = {};
      Object.entries(moduleMapGlobal).forEach(([modId, modAssignments]) => {
        modAssignments.forEach(asgn => {
          if (!asgn.due_at) return;
          if (!lessons[modId]) lessons[modId] = { total: 0, delivered: 0, missing: 0, ahead: 0, fullfort: 0, fullfortPastDue: 0, venter: 0, pastDue: 0, pastDueDenom: 0 };
          lessons[modId].total++;

          const sub = subs.find(s => String(s.assignment_id) === String(asgn.id));
          const now = Date.now();
          const due = new Date(asgn.due_at);

          if (due <= now) {
            lessons[modId].pastDue++;
            const aType = assignmentTypeMap[String(asgn.id)];
            const modeRelevant = cfg.gradingMode === 'both'   ? true
                               : cfg.gradingMode === 'auto'   ? aType === 'nq'
                               :                                aType === 'teacher';
            if (modeRelevant) lessons[modId].pastDueDenom++;
          }

          // Mangler-sjekk: sub.missing overstyrer alltid — også ved levering.
          // Lærer som manuelt setter «Mangler» etter levering gir signal om at mer må gjøres.
          // Canvas endrer automatisk fra «Mangler» til «Sen» ved levering etter frist.
          const isExcused = sub?.workflow_state === 'excused' || sub?.excused === true;
          const hasActivity = sub && (
            sub.submitted_at ||
            sub.graded_at ||
            sub.workflow_state === 'submitted' ||
            sub.workflow_state === 'graded' ||
            sub.workflow_state === 'complete' ||
            (sub.grade && sub.grade !== null)
          );
          const isMissing = !isExcused && (
            (sub && sub.missing === true) ||
            (!sub && due <= now)           // defensiv fallback: ingen sub-objekt
          );

          const isDelivered = !isMissing && hasActivity;

          if (isDelivered) {
            lessons[modId].delivered++;
            const isGraded = !!(
              sub.workflow_state === 'graded' ||
              sub.workflow_state === 'complete' ||
              sub.graded_at
            );
            // NQ-basert godkjenningslogikk:
            // NQ er fullført når den er levert (isDelivered) — auto-retting eller essay,
            // lærer underkjenner ved å sette «Mangler» manuelt.
            // Ikke-NQ (innleveringer, diskusjoner) er fullført når lærer har vurdert (isGraded).
            // gradingMode filtrerer hvilke oppgavetyper som teller, ikke hva som er fullført.
            const isNQ = assignmentTypeMap[String(asgn.id)] === 'nq';
            const isFullfort = (
              cfg.gradingMode === 'both' ? (isNQ ? isDelivered : isGraded) :
              cfg.gradingMode === 'auto' ? (isNQ && isDelivered) :
              /* unntatt NQ */             (!isNQ && isGraded)
            );
            if (isFullfort) lessons[modId].fullfort++;
            if (isFullfort && due <= now) lessons[modId].fullfortPastDue++;
            if (!isExcused && (sub.workflow_state === 'submitted' || sub.workflow_state === 'pending_review')) lessons[modId].venter++;
            if (isExcused) lessons[modId].excused = (lessons[modId].excused || 0) + 1;
            if (due > now)  lessons[modId].ahead++;
          } else if (isMissing) {
            lessons[modId].missing++;
            hoppetOver++;
            skippedPerMod[modId] = (skippedPerMod[modId] || 0) + 1;
            // Spor hvilke spesifikke oppgaver som mangler (for kopieringslenker)
            if (!missingByMod[modId]) missingByMod[modId] = [];
            missingByMod[modId].push({
              id: String(asgn.id),
              name: asgn.name,
              dueAt: asgn.due_at,
              isNQ: assignmentTypeMap[String(asgn.id)] === 'nq'
            });
          }
        });
      });

      let netDelta     = 0;
      let hasAnyLesson = false;
      let godkjent     = 0;
      let venterVurdering = 0;
      let totalt       = 0;
      let leksjonerMedPassertFrist = 0;
      let godkjentAvPasserte = 0;
      const threshold  = (cfg.lessonThreshold || 50) / 100;

      Object.entries(lessons).forEach(([modId, l]) => {
        if (l.total === 0) return;
        const completionFullfort = l.pastDueDenom > 0 ? l.fullfortPastDue / l.pastDueDenom : 0;
        // CAK-DEBUG: fjern etter feilsøking
        if (l.pastDue > 0) console.log('[CAK]', moduleNameMapGlobal[modId] || modId, 'denom:', l.pastDueDenom, 'fullfort:', l.fullfortPastDue, 'delivered:', l.delivered, 'completionFullfort:', completionFullfort.toFixed(2));

        if (l.pastDueDenom > 0) {
          leksjonerMedPassertFrist++;
          if (completionFullfort >= threshold) godkjentAvPasserte++;
        }

        if (l.delivered === 0 && l.missing === 0) return;
        hasAnyLesson = true;
        totalt++;
        const aheadAndDelivered = l.pastDue === 0 && (l.ahead || 0) > 0;
        if (completionFullfort >= threshold || aheadAndDelivered) godkjent++;
        venterVurdering += l.venter || 0;
        if (l.pastDueDenom === 0 && l.ahead > 0) {
          netDelta += 1;                     // alt levert med fremtidig frist — i forkant
        } else if (completionFullfort >= threshold) {
          if (l.ahead > 0) netDelta += 1;   // passerte frister ok + noe ekstra i forkant
        } else {
          netDelta -= 1;                     // passerte frister ikke oppfylt — på etterskudd
        }
      });

      const leksjonerEtter = leksjonerMedPassertFrist > 0
        ? Math.max(0, leksjonerMedPassertFrist - godkjentAvPasserte)
        : null;

      // Per-modul leverte oppgaver (for batteriprikker) — identisk filter som elevvisning:
      // kun oppgaver med frist som teller i sluttkarakteren (ikke frivillige).
      const deliveredPerMod = {};
      Object.entries(moduleMapGlobal).forEach(([modId, modAssigns]) => {
        const relevant = modAssigns.filter(a => a.due_at && !a.omit_from_final_grade);
        let count = 0;
        relevant.forEach(a => {
          const sub = subs.find(s => String(s.assignment_id) === String(a.id));
          const hasActivity = sub && (
            sub.submitted_at || sub.graded_at ||
            sub.workflow_state === 'submitted' ||
            sub.workflow_state === 'graded' ||
            sub.workflow_state === 'complete' ||
            (sub.grade && sub.grade !== null)
          );
          const isForcedMiss = !!(sub && sub.missing === true);
          const isExcused    = !!(sub?.workflow_state === 'excused' || sub?.excused === true);
          if (hasActivity && !isForcedMiss && !isExcused) count++;
        });
        if (count > 0) deliveredPerMod[modId] = count;
      });

      // Aktive moduler (for snitt-visning) — beholder opprinnelig logikk
      const activeMods = [];
      Object.entries(lessons).forEach(([modId, l]) => {
        if (l.delivered > 0 || l.missing > 0) activeMods.push(modId);
      });
      studentData[sid].deliveredPerMod = deliveredPerMod;
      studentData[sid].activeMods      = activeMods;
      const venterPerMod  = {};
      const excusedPerMod = {};
      Object.entries(lessons).forEach(([modId, l]) => {
        if ((l.venter  || 0) > 0) venterPerMod[modId]  = l.venter;
        if ((l.excused || 0) > 0) excusedPerMod[modId] = l.excused;
      });
      studentData[sid].venterPerMod  = venterPerMod;
      studentData[sid].excusedPerMod = excusedPerMod;

      // Direkte telling fra submissions — workflow_state 'submitted'/'pending_review'
      // er Canvas sin kanoniske tilstand for "levert, venter vurdering".
      // NB: Canvas kan halde på workflow_state='submitted' sjølv etter at lærar set
      // karakter (t.d. for NQ/quiz). Ekskluder difor innleveringar som har fått karakter
      // (grade sett eller graded_at finst) — desse er allereie vurderte.
      const venterVurderingDirekt = subs.filter(s =>
        (s.workflow_state === 'submitted' || s.workflow_state === 'pending_review') &&
        !s.grade && !s.graded_at
      ).length;

      if (hasAnyLesson) {
        studentData[sid].deadlineDelta   = netDelta;
        studentData[sid].deadlineCount   = totalt;
        studentData[sid].godkjent        = godkjent;
        studentData[sid].leksjonerEtter  = leksjonerEtter;
        studentData[sid].venterVurdering = venterVurderingDirekt;
        studentData[sid].hoppetOver      = hoppetOver;
        studentData[sid].skippedPerMod   = skippedPerMod;
        studentData[sid].missingByMod    = missingByMod;
        studentData[sid].totalt          = totalt;
      } else if (hasAnyDeadlines) {
        studentData[sid].deadlineDelta = null;
        studentData[sid].hasDeadlines  = true;
      }
    });
  }

  async function paginate(url) {
    let results = [];
    let next = url;
    while (next) {
      const resp = await fetch(next, { credentials: 'include' });
      if (!resp.ok) {
        if (resp.status === 403) {
          const err = new Error('403 Forbidden');
          err.status = 403;
          throw err;
        }
        break;
      }
      results = results.concat(await resp.json());
      const link = resp.headers.get('Link') || '';
      const m = link.match(/<([^>]+)>;\s*rel="next"/);
      next = m ? m[1] : null;
    }
    return results;
  }

  // ─── Cache-invalidering ───────────────────────────────────────────────────
  function invalidateCache() {
    for (const cell of cellCache.values()) cell.remove();
    cellCache.clear();
    if (headerCellEl) { headerCellEl.remove(); headerCellEl = null; headerAttachedParent = null; }
  }

  // ─── Tegn overlay (smart diff — gjenbruker eksisterende celler) ───────────
  function updateOverlay() {
    if (!overlayEl || isUpdating) return;
    isUpdating = true;

    requestAnimationFrame(() => {
      try {
        if (!cfg.visible) {
          overlayEl.style.display = 'none';
          document.querySelectorAll('.slick-row').forEach(row => {
            const firstCell = row.querySelector('.slick-cell');
            if (firstCell) firstCell.style.backgroundColor = '';
          });
          return;
        }
        overlayEl.style.display = '';

        const frozenCanvas = findFrozenCanvas();
        if (!frozenCanvas) { setTimeout(updateOverlay, 800); return; }

        const rows = frozenCanvas.querySelectorAll('.slick-row');
        if (!rows.length) { setTimeout(updateOverlay, 500); return; }

        attachOverlayToViewport(frozenCanvas);

        const firstCell = rows[0].querySelector('.slick-cell');
        if (!firstCell) return;
        const colWidth  = firstCell.offsetWidth;
        const rowHeight = rows[0].offsetHeight || 35;

        if (!tooltipFontSize) {
          const sampleNameEl =
            rows[0].querySelector('a[href*="/users/"]') ||
            rows[0].querySelector('a[href*="/grades/"]') ||
            rows[0].querySelector('.slick-cell') ||
            null;
          const cs = sampleNameEl ? getComputedStyle(sampleNameEl) : null;
          tooltipFontSize = cs && cs.fontSize ? cs.fontSize : null;
        }

        // Høyde: finn laveste faktiske rad-posisjon
        let maxBottom = 0;
        rows.forEach(r => {
          const top = parseInt(r.style.top, 10) || 0;
          const h   = r.offsetHeight || rowHeight;
          if (top + h > maxBottom) maxBottom = top + h;
        });
        overlayEl.style.left   = (colWidth - getColW() - 4) + 'px';
        overlayEl.style.width  = getColW() + 'px';
        overlayEl.style.height = maxBottom + 'px';

        // Laste-indikator: shimmer på header, salutt når ferdig
        if (headerCellEl) {
          if (isLoading) {
            headerCellEl.classList.add('cak-col-header-loading');
            headerCellEl.classList.remove('cak-col-header-done');
          } else if (headerCellEl.classList.contains('cak-col-header-loading')) {
            headerCellEl.classList.remove('cak-col-header-loading');
            headerCellEl.classList.add('cak-col-header-done');
            setTimeout(() => headerCellEl?.classList.remove('cak-col-header-done'), 750);
          }
        }

        // Header — separat element i foreldrenoden (utanfor viewport sitt overflow)
        const canvasHeader = findFrozenHeader();
        if (canvasHeader) {
          const viewport   = frozenCanvas.parentElement;
          const parentEl   = viewport.parentElement;
          const hRect      = canvasHeader.getBoundingClientRect();
          const parentRect = parentEl.getBoundingClientRect();
          const oRect      = overlayEl.getBoundingClientRect();

          if (!headerCellEl) {
            headerCellEl = document.createElement('div');
            headerCellEl.className           = 'cak-col-header';
            headerCellEl.style.cursor        = 'default';
            headerCellEl.style.pointerEvents = 'none';
          }
          if (headerAttachedParent !== parentEl) {
            if (getComputedStyle(parentEl).position === 'static') {
              parentEl.style.position = 'relative';
            }
            parentEl.appendChild(headerCellEl);
            headerAttachedParent = parentEl;
          }

          headerCellEl.style.top    = (hRect.top - parentRect.top + parentEl.scrollTop) + 'px';
          headerCellEl.style.left   = (oRect.left - parentRect.left) + 'px';
          headerCellEl.style.width  = getColW() + 'px';
          headerCellEl.style.height = hRect.height + 'px';

          const iconUrl = chrome.runtime.getURL('icons/icon48.png');
          headerCellEl.innerHTML =
            `<img src="${iconUrl}" style="width:20px;height:20px;border-radius:4px;flex-shrink:0;">Læringslupa`;
          headerCellEl.title = '';
        }

        // Bygg liste over synlige rader med posisjon og student-ID
        // Ekstraher navn fra DOM som fallback dersom API-data mangler
        const rowItems = [];
        rows.forEach((row) => {
          const sid    = extractStudentId(row);
          const rowTop = parseInt(row.style.top, 10) || 0;
          if (sid && !studentNames[sid]) {
            const link = row.querySelector('a[href*="/grades/"]') || row.querySelector('a[href*="/users/"]');
            if (link) studentNames[sid] = link.textContent.trim();
          }
          rowItems.push({ sid, rowTop, row });
        });

        // Hvis sortering er aktiv: sorter etter prioritetspoeng men behold Canvas-slots
        let displayOrder = [...rowItems];
        if (sortActive) {
          const slots = rowItems.map(r => r.rowTop).sort((a, b) => a - b);
          const sorted = [...rowItems].sort((a, b) => {
            const sa = a.sid ? priorityScore(a.sid) : 99999;
            const sb = b.sid ? priorityScore(b.sid) : 99999;
            return sb - sa;
          });
          displayOrder = sorted.map((item, i) => ({
            ...item,
            rowTop: slots[i]
          }));
        }

        // Smart diff: flytt eksisterende celler, opprett nye, fjern foreldreløse
        const activeSids = new Set();

        displayOrder.forEach(({ sid, rowTop, row }) => {
          const key = sid || ('__row__' + rowTop);
          activeSids.add(key);

          // Trafikklys-tint på navnecellen — alltid oppdatert (kun repaint, ikke reflow)
          const firstRowCell = row.querySelector('.slick-cell');
          if (sid && firstRowCell) {
            const data = studentData[sid] || {};
            const tint = cfg.rowHighlight
              ? activityCellTint(data.leksjonerEtter, data.hasDeadlines)
              : null;
            firstRowCell.style.backgroundColor = tint || '';
          }

          if (cellCache.has(key)) {
            // Bare oppdater posisjon — ingen ny DOM-bygging
            const cached = cellCache.get(key);
            cached.style.top    = rowTop + 'px';
            cached.style.height = rowHeight + 'px';
          } else {
            // Bygg ny celle
            const cell       = document.createElement('div');
            cell.className   = 'cak-cell';
            cell.style.top   = rowTop + 'px';
            cell.style.height = rowHeight + 'px';
            cell.style.background = 'transparent';

            if (sid) {
              const data      = studentData[sid] || {};
              const loginDays = daysSince(data.lastActivity);
              const subDays   = daysSince(data.lastSubmission);
              const delta     = data.deadlineDelta;

              const ring     = document.createElement('span');
              ring.className = 'cak-ring ' + ringClass(loginDays);

              const mark     = document.createElement('span');
              mark.className = 'cak-mark ' + markClass(subDays);

              const tlWrap = document.createElement('div');
              tlWrap.style.cssText = 'display:inline-flex;align-items:center;justify-content:center;background:#f5f4ee;border:0.5px solid #d3d1c7;border-radius:5px;padding:2px 4px;height:22px;flex-shrink:0';
              tlWrap.appendChild(makeTimelineSvg(delta, data.hasDeadlines));

              const iconsWrap = document.createElement('div');
              iconsWrap.className = 'cak-cell-icons';
              iconsWrap.appendChild(ring);
              iconsWrap.appendChild(mark);
              iconsWrap.appendChild(tlWrap);
              cell.appendChild(iconsWrap);

              // Statsstøtte-badge
              const badge = getFundingBadge(data.godkjent);
              if (badge) {
                const pill = document.createElement('span');
                pill.className = 'cak-funding-pill cak-funding-' + badge.cls;
                pill.textContent = badge.label;
                cell.appendChild(pill);
              }

              // Visningsbar — 3px grønn stripe i bunnen viser snitt visningsprosent
              const viewBarWrap = document.createElement('div');
              const viewBarFill = document.createElement('div');
              viewBarFill.className = 'cak-view-bar-fill';
              const avgPct = data.avgViewPct;
              if (avgPct !== null && avgPct !== undefined) {
                viewBarFill.style.width = avgPct + '%';
                viewBarWrap.className = 'cak-view-bar-wrap';
              } else if (avgPct === undefined) {
                viewBarWrap.className = 'cak-view-bar-wrap cak-view-bar-loading';
              } else {
                // null — lastet, men ingen must-view-sider i passerte leksjoner
                viewBarWrap.className = 'cak-view-bar-wrap';
              }
              viewBarWrap.appendChild(viewBarFill);
              cell.appendChild(viewBarWrap);

              // Kopieringsknapp — vises ved hover, absolutt posisjonert til høyre i cellen
              const copyBtn = document.createElement('span');
              copyBtn.className = 'cak-copy-btn';
              copyBtn.title = 'Kopier til utklippstavlen';
              copyBtn.innerHTML = COPY_SVG;
              copyBtn.addEventListener('click', (e) => {
                e.stopPropagation();
                const d       = studentData[sid] || {};
                const lDays   = daysSince(d.lastActivity);
                const sDays   = daysSince(d.lastSubmission);
                const name    = studentNames[sid] || '';
                const batData = moduleCompletionCache.hasOwnProperty(sid)
                  ? moduleCompletionCache[sid] : null;
                const { plain, html } = buildCopyContent(
                  name, lDays, sDays, d.deadlineDelta, d.deadlineCount,
                  d.godkjent, d.venterVurdering, d.totalt, d.leksjonerEtter,
                  d.hoppetOver, d.missingByMod || {}, batData, d.skippedPerMod || {}
                );
                const clipItems = { 'text/plain': new Blob([plain], { type: 'text/plain' }) };
                if (html) clipItems['text/html'] = new Blob([html], { type: 'text/html' });
                navigator.clipboard.write([new ClipboardItem(clipItems)]).then(() => {
                  copyBtn.innerHTML = CHECK_SVG;
                  copyBtn.classList.add('cak-copied');
                  setTimeout(() => {
                    copyBtn.innerHTML = COPY_SVG;
                    copyBtn.classList.remove('cak-copied');
                  }, 1800);
                }).catch(() => {
                  // Fallback: plain text
                  navigator.clipboard.writeText(plain).catch(() => {});
                });
              });
              cell.appendChild(copyBtn);

              // Nedlastingsknapp — lager PNG-kort av elevdata
              const saveBtn = document.createElement('span');
              saveBtn.className = 'cak-save-btn';
              saveBtn.title = 'Last ned som bilde (PNG)';
              saveBtn.innerHTML = SAVE_SVG;
              saveBtn.addEventListener('click', async (ev) => {
                ev.stopPropagation();
                saveBtn.style.color = '#ba7517';
                try {
                  // Sørg for at batteridataen er lastet
                  if (!moduleCompletionCache.hasOwnProperty(sid)) {
                    moduleCompletionCache[sid] = await fetchModuleCompletion(sid).catch(() => false);
                  }
                  await downloadStudentCard(sid);
                } catch (e) {
                  console.warn('[CAK] PNG-nedlasting feilet:', e);
                }
                saveBtn.style.color = '';
              });
              cell.appendChild(saveBtn);

              cell.addEventListener('mouseenter', async (e) => {
                currentHoverSid = sid;
                highlightRow(sid, true);
                const d         = studentData[sid] || {};
                const lDays     = daysSince(d.lastActivity);
                const sDays     = daysSince(d.lastSubmission);

                // Vis umiddelbart med "laster" for batteri
                const cached = moduleCompletionCache.hasOwnProperty(sid)
                  ? moduleCompletionCache[sid]
                  : null; // null = laster
                showTip(e, buildTooltip(lDays, sDays, d.deadlineDelta,
                  d.deadlineCount, d.godkjent, d.venterVurdering,
                  d.totalt, d.leksjonerEtter, cached, d.hoppetOver, d.skippedPerMod,
                  d.deliveredPerMod, d.activeMods, d.venterPerMod, d.excusedPerMod), tooltipFontSize);

                // Hent moduldata hvis ikke cachet
                if (!moduleCompletionCache.hasOwnProperty(sid)) {
                  try {
                    moduleCompletionCache[sid] = await fetchModuleCompletion(sid);
                  } catch (err) {
                    moduleCompletionCache[sid] = false;
                  }
                  // Sett avgViewPct og oppdater baren nå som data er lastet
                  if (studentData[sid]) {
                    studentData[sid].avgViewPct = calcAvgViewPct(moduleCompletionCache[sid], studentData[sid]?.activeMods);
                    updateViewBar(sid);
                  }
                  if (currentHoverSid === sid && tooltipEl.style.display !== 'none') {
                    tooltipEl.innerHTML = buildTooltip(lDays, sDays, d.deadlineDelta,
                      d.deadlineCount, d.godkjent, d.venterVurdering,
                      d.totalt, d.leksjonerEtter, moduleCompletionCache[sid], d.hoppetOver, d.skippedPerMod,
                      d.deliveredPerMod, d.activeMods, d.venterPerMod, d.excusedPerMod);
                    if (lastTipEvent) moveTip(lastTipEvent);
                  }
                }
              });
              cell.addEventListener('mousemove',  moveTip);
              cell.addEventListener('mouseleave', () => { currentHoverSid = null; highlightRow(sid, false); hideTip(); });
            }

            cellCache.set(key, cell);
            overlayEl.appendChild(cell);
          }
        });

        // Fjern celler som ikke lenger er synlige
        for (const [key, cell] of cellCache) {
          if (!activeSids.has(key)) {
            cell.remove();
            cellCache.delete(key);
          }
        }

      } finally {
        setTimeout(() => { isUpdating = false; }, 0);
      }
    });
  }

  // ─── Tidslinje SVG ────────────────────────────────────────────────────────
  function makeTimelineSvg(delta, hasDeadlines) {
    const W = 56, H = 16, mid = W / 2;
    const barH = 3, barY = (H - barH) / 2;
    const margin = 3;

    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.setAttribute('width', W);
    svg.setAttribute('height', H);
    svg.setAttribute('viewBox', `0 0 ${W} ${H}`);
    svg.style.flexShrink = '0';

    // Gradientdefinisjoner
    const defs = document.createElementNS('http://www.w3.org/2000/svg', 'defs');

    const gGreen = document.createElementNS('http://www.w3.org/2000/svg', 'linearGradient');
    gGreen.setAttribute('id', 'cak-bar-green');
    gGreen.setAttribute('x1', '0%'); gGreen.setAttribute('x2', '100%');
    gGreen.setAttribute('y1', '0%'); gGreen.setAttribute('y2', '0%');
    [['0%', '#97c459'], ['100%', '#3b6d11']].forEach(([offset, color]) => {
      const s = document.createElementNS('http://www.w3.org/2000/svg', 'stop');
      s.setAttribute('offset', offset); s.setAttribute('stop-color', color);
      gGreen.appendChild(s);
    });

    const gRed = document.createElementNS('http://www.w3.org/2000/svg', 'linearGradient');
    gRed.setAttribute('id', 'cak-bar-red');
    gRed.setAttribute('x1', '100%'); gRed.setAttribute('x2', '0%');
    gRed.setAttribute('y1', '0%');   gRed.setAttribute('y2', '0%');
    [['0%', '#e57373'], ['100%', '#a32d2d']].forEach(([offset, color]) => {
      const s = document.createElementNS('http://www.w3.org/2000/svg', 'stop');
      s.setAttribute('offset', offset); s.setAttribute('stop-color', color);
      gRed.appendChild(s);
    });

    defs.appendChild(gGreen);
    defs.appendChild(gRed);
    svg.appendChild(defs);

    // Horisontal linje
    const line = document.createElementNS('http://www.w3.org/2000/svg', 'line');
    line.setAttribute('x1', String(margin));
    line.setAttribute('y1', '8');
    line.setAttribute('x2', String(W - margin));
    line.setAttribute('y2', '8');
    line.setAttribute('stroke', '#d3d1c7');
    line.setAttribute('stroke-width', '1.5');
    svg.appendChild(line);

    // Loddrett midtstrek
    const tick = document.createElementNS('http://www.w3.org/2000/svg', 'rect');
    tick.setAttribute('x', String(mid - 1.2));
    tick.setAttribute('y', '2');
    tick.setAttribute('width', '2.4');
    tick.setAttribute('height', '12');
    tick.setAttribute('rx', '1');
    tick.setAttribute('fill', (delta === undefined && !hasDeadlines) ? '#e0dfd8' : '#888780');
    svg.appendChild(tick);

    if (delta === undefined && !hasDeadlines) {
      // Ingen frister — stiplet sirkel
      const c = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
      c.setAttribute('cx', String(mid));
      c.setAttribute('cy', '8');
      c.setAttribute('r', '4.5');
      c.setAttribute('fill', 'none');
      c.setAttribute('stroke', '#c8c6be');
      c.setAttribute('stroke-width', '1.5');
      c.setAttribute('stroke-dasharray', '2.5,2');
      svg.appendChild(c);
      return svg;
    }

    if (delta === null) {
      // Har frister men ikke levert — full rød bar til venstre
      const bar = document.createElementNS('http://www.w3.org/2000/svg', 'rect');
      bar.setAttribute('x', String(margin));
      bar.setAttribute('y', String(barY));
      bar.setAttribute('width', String(mid - margin - 1));
      bar.setAttribute('height', String(barH));
      bar.setAttribute('rx', '1.5');
      bar.setAttribute('fill', 'url(#cak-bar-red)');
      svg.appendChild(bar);
      return svg;
    }

    // Delta = 0 → bare midtstreken, ingen bar
    if (delta === 0) return svg;

    const clamped   = Math.max(-5, Math.min(5, delta));
    const halfRange = mid - margin - 2;
    const barLen    = Math.max(4, (Math.abs(clamped) / 5) * halfRange);

    const bar = document.createElementNS('http://www.w3.org/2000/svg', 'rect');
    bar.setAttribute('y', String(barY));
    bar.setAttribute('height', String(barH));
    bar.setAttribute('rx', '1.5');

    if (delta > 0) {
      bar.setAttribute('x', String(mid + 2));
      bar.setAttribute('width', String(barLen));
      bar.setAttribute('fill', 'url(#cak-bar-green)');
    } else {
      bar.setAttribute('x', String(mid - barLen - 2));
      bar.setAttribute('width', String(barLen));
      bar.setAttribute('fill', 'url(#cak-bar-red)');
    }

    svg.appendChild(bar);
    return svg;
  }

  function dotColor(delta) {
    if (delta === null || delta === undefined) return '#a32d2d';
    if (delta >= 1)  return '#3b6d11'; // foran — minst én leksjon foran
    if (delta === 0) return '#639922'; // i rute
    if (delta >= -2) return '#ba7517'; // litt etter
    return '#a32d2d';                  // klart etter
  }

  function activityCellTint(leksjonerEtter, hasDeadlines) {
    // Ingen frister i kurset → ingen trafikklys-farge
    if (leksjonerEtter === null && !hasDeadlines) return null;
    // Har frister men ikke levert / mangler grunnlag → rød
    if (leksjonerEtter === null) return 'rgba(198, 40, 40, 0.20)';

    // 0-1 etter → ingen farge, 2 → grønn, 3 → gul, 4+ → rød
    if (leksjonerEtter <= 1)  return null;
    if (leksjonerEtter === 2) return 'rgba(46, 125, 50, 0.18)';
    if (leksjonerEtter === 3) return 'rgba(251, 192, 45, 0.20)';
    return 'rgba(198, 40, 40, 0.23)';
  }

  // ─── DOM-selektorer ───────────────────────────────────────────────────────
  function findFrozenCanvas() {
    const candidates = [
      '.slick-viewport.slick-viewport-bottom.slick-viewport-left .grid-canvas',
      '.slick-viewport.slick-viewport-top.slick-viewport-left .grid-canvas',
      '.container_0 .slick-viewport .grid-canvas',
      '.grid-canvas-left',
      '.grid-canvas'
    ];
    for (const sel of candidates) {
      const el = document.querySelector(sel);
      if (el && el.querySelector('.slick-row')) return el;
    }
    return null;
  }

  function findFrozenHeader() {
    const candidates = [
      '.slick-header.slick-header-left',
      '.container_0 .slick-header',
      '.slick-header-left',
      '.slick-header'
    ];
    for (const sel of candidates) {
      const el = document.querySelector(sel);
      if (el) return el;
    }
    return null;
  }

  function extractStudentId(row) {
    const gradesLink = row.querySelector('a[href*="/grades/"]');
    if (gradesLink) {
      const m = gradesLink.href.match(/\/grades\/(\d+)/);
      if (m) return m[1];
    }
    const usersLink = row.querySelector('a[href*="/users/"]');
    if (usersLink) {
      const m = usersLink.href.match(/\/users\/(\d+)/);
      if (m) return m[1];
    }
    return row.getAttribute('data-student-id') || null;
  }

  // ─── Hjelpere ─────────────────────────────────────────────────────────────
  function daysSince(date) {
    if (!date) return null;
    const d = date instanceof Date ? date : new Date(date);
    if (isNaN(d.getTime())) return null;
    return Math.floor((Date.now() - d.getTime()) / 86400000);
  }

  function ringClass(days) {
    if (days === null)           return 'cak-ring-1';
    if (days <= cfg.loginGreen)  return 'cak-ring-4';
    if (days <= cfg.loginYellow) return 'cak-ring-3';
    if (days <= 15)              return 'cak-ring-2';
    return 'cak-ring-1';
  }

  function markClass(days) {
    if (days === null)                return 'cak-x';
    if (days <= cfg.submissionGreen)  return 'cak-v';
    if (days <= cfg.submissionYellow) return 'cak-dash';
    return 'cak-x';
  }

  function markChar(days) {
    if (days === null)                return '✗';
    if (days <= cfg.submissionGreen)  return '✓';
    if (days <= cfg.submissionYellow) return '–';
    return '✗';
  }

  function highlightRow(sid, on) {
    const frozenCanvas = findFrozenCanvas();
    if (!frozenCanvas) return;
    for (const row of frozenCanvas.querySelectorAll('.slick-row')) {
      if (extractStudentId(row) === sid) {
        const cells = row.querySelectorAll('.slick-cell');
        cells.forEach((cell, idx) => {
          if (on) {
            cell.style.backgroundColor = 'rgba(59, 109, 17, 0.07)';
          } else {
            // Gjenopprett trafikklys-farge på første celle hvis rowHighlight er aktiv
            if (idx === 0 && cfg.rowHighlight) {
              const data = studentData[sid] || {};
              cell.style.backgroundColor = activityCellTint(data.leksjonerEtter, data.hasDeadlines) || '';
            } else {
              cell.style.backgroundColor = '';
            }
          }
        });
        break;
      }
    }
  }

  // ─── Bakgrunnslasting av modulvisningsdata ────────────────────────────────
  // Hentar alltid fersk data frå Canvas API for alle elevar.
  // cak_mod_ brukast berre til rask startvisning — ikkje til å hoppe over henting.
  // freshModuleSids hindrar dobbelhenting innanfor same sideinnlasting.
  async function backgroundLoadModuleCompletion() {
    const sids = Object.keys(studentData);
    for (const sid of sids) {
      if (freshModuleSids.has(sid)) continue; // allereie henta fersk denne sesjonen
      try {
        moduleCompletionCache[sid] = await fetchModuleCompletion(sid);
        freshModuleSids.add(sid);
      } catch (e) {
        moduleCompletionCache[sid] = false;
        freshModuleSids.add(sid);
        if (e.status === 403) break; // Canvas har blokkert student_id-tilgang — avbryt heile løkka
      }
      const pct = calcAvgViewPct(moduleCompletionCache[sid], studentData[sid]?.activeMods);
      if (studentData[sid]) {
        studentData[sid].avgViewPct = pct;
        // Oppdater prikke-logikk med completion_requirement.completed per elev —
        // samme signal som elevvisningen bruker
        if (Array.isArray(moduleCompletionCache[sid])) {
          recalcDotsFromModules(sid, moduleCompletionCache[sid]);
        }
      }
      updateViewBar(sid);
    }
    // Lagre ferdig modulcache til persistent lagring
    const courseId = getCourseId();
    if (courseId) {
      chrome.storage.local.set({ [`cak_mod_${courseId}`]: { ts: Date.now(), data: moduleCompletionCache } });
    }
  }

  function calcAvgViewPct(modules, _activeMods) {
    if (!modules || !Array.isArray(modules)) return null;
    // Snitt visning: sum(fullført must_view-sider) / sum(totalt must_view-sider)
    // berre over leksjonar eleven faktisk har opna (completed > 0).
    // Uleste leksjonar inngår ikkje i nemnaren — berre det eleven har byrja på tel.
    const opened = modules.filter(m => m.total > 0 && m.completed > 0);
    if (opened.length === 0) return null;
    const totalItems     = opened.reduce((acc, m) => acc + m.total, 0);
    const completedItems = opened.reduce((acc, m) => acc + m.completed, 0);
    return Math.round(completedItems / totalItems * 100);
  }

  function updateViewBar(sid) {
    const cell = cellCache.get(sid);
    if (!cell) return;
    const wrap = cell.querySelector('.cak-view-bar-wrap');
    if (!wrap) return;
    const fill = wrap.querySelector('.cak-view-bar-fill');
    const pct  = studentData[sid]?.avgViewPct;
    wrap.classList.remove('cak-view-bar-loading');
    if (pct !== null && pct !== undefined) {
      fill.style.width = pct + '%';
    } else {
      fill.style.width = '0';
    }
  }

  async function fetchModuleCompletion(sid) {
    const courseId = getCourseId();
    const modules  = await paginate(
      `/api/v1/courses/${courseId}/modules?include[]=items&student_id=${sid}&per_page=100`
    );
    return modules.map(mod => {
      const viewItems = (mod.items || []).filter(i => i.completion_requirement && i.completion_requirement.type === 'must_view');
      const completed = viewItems.filter(i => i.completion_requirement.completed).length;
      // Prikke-items: krav som ikke er must_view (levering, bidrag, poeng)
      // must_mark_done er ikke i bruk på skolen og utelates
      const dotItems  = (mod.items || []).filter(i =>
        i.content_id &&
        i.completion_requirement &&
        i.completion_requirement.type !== 'must_view' &&
        i.completion_requirement.type !== 'must_mark_done'
      ).map(i => ({
        contentId: String(i.content_id),
        completed: !!i.completion_requirement.completed
      }));
      return { id: String(mod.id), name: mod.name, total: viewItems.length, completed, dotItems };
    });
  }

  // Oppdater deliveredPerMod/skippedPerMod med completion_requirement.completed per elev.
  // Kjøres etter bakgrunnshentering av moduldata med student_id — gir samme signal som elevvisningen.
  function recalcDotsFromModules(sid, modules) {
    const raw = studentData[sid]?.subMissingSet;
    const missingSet = raw instanceof Set ? raw : new Set(Object.keys(raw || {}));
    const now = new Date();
    // Bygg due_at-oppslagstabell fra moduleMapGlobal
    const dueDateById = {};
    Object.values(moduleMapGlobal).forEach(assignments => {
      assignments.forEach(a => { dueDateById[String(a.id)] = a.due_at; });
    });
    const newDelivered = {};
    const newSkipped   = {};
    modules.forEach(mod => {
      let delivered = 0, missing = 0;
      (mod.dotItems || []).forEach(di => {
        const isForcedMiss = missingSet.has(di.contentId);
        const dueAt        = dueDateById[di.contentId];
        if (!dueAt) return; // Oppgåvar utan datofrist skal ikkje gje prikk
        const due          = new Date(dueAt);
        const isPastDue    = due <= now;
        if (di.completed && !isForcedMiss) {
          delivered++;
        } else if (isForcedMiss || isPastDue) {
          missing++;
        }
      });
      if (delivered > 0) newDelivered[mod.id] = delivered;
      if (missing > 0)   newSkipped[mod.id]   = missing;
    });
    studentData[sid].deliveredPerMod = newDelivered;
    studentData[sid].skippedPerMod   = newSkipped;
    studentData[sid].hoppetOver      = Object.values(newSkipped).reduce((a, b) => a + b, 0);
  }

  function detectSemesterOffset() {
    const text = [
      document.title,
      document.querySelector('#breadcrumbs')?.textContent,
      document.querySelector('.context_title')?.textContent,
    ].filter(Boolean).join(' ').toLowerCase();
    return /vår|vaar/.test(text) ? 15 : 0;
  }

  function parseLessonNum(name) {
    const m = (name || '').match(/\d+/);
    return m ? parseInt(m[0], 10) : null;
  }

  function makeBatterySvg(modules, skippedPerMod = {}, deliveredPerMod = {}, lessonOffset = 0, venterPerMod = {}, excusedPerMod = {}) {
    const labelH = 16;  // plass til leksjonsnummer øverst (45°-rotert tekst)
    const upH = 55, downH = 55;
    const totalH = labelH + upH + downH;
    const midY   = labelH + upH;
    const barW = 7, gap = 11;
    const now  = new Date();
    const n    = modules.length;
    const W    = n * (barW + gap) - gap;

    const defs = `<defs>
      <linearGradient id="cak-v-green" x1="0" x2="0" y1="${midY}" y2="${labelH}" gradientUnits="userSpaceOnUse">
        <stop offset="0%" stop-color="#97c459"/>
        <stop offset="100%" stop-color="#3b6d11"/>
      </linearGradient>
      <pattern id="cak-hatch" patternUnits="userSpaceOnUse" width="4" height="4" patternTransform="rotate(45 0 0)">
        <line x1="0" y1="0" x2="0" y2="4" stroke="#9e9c96" stroke-width="0.8"/>
      </pattern>
    </defs>`;

    let bars = '';

    // 100%-markering øverst (svak stiplet linje)
    bars += `<line x1="0" y1="${labelH + 1}" x2="${W}" y2="${labelH + 1}" stroke="#d3d1c7" stroke-width="0.5" stroke-dasharray="2,3"/>`;
    // Midtlinje / nullpunkt
    bars += `<line x1="0" y1="${midY}" x2="${W}" y2="${midY}" stroke="#888780" stroke-width="1"/>`;

    // Finn posisjon for nå-linje — mellom siste passerte og første fremtidige leksjon
    let nowLineX = null;
    for (let i = 0; i < modules.length - 1; i++) {
      const dueA = moduleDeadlineMap[modules[i].id] || null;
      const dueB = moduleDeadlineMap[modules[i + 1].id] || null;
      if (dueA && dueA <= now && (!dueB || dueB > now)) {
        nowLineX = (i + 1) * (barW + gap) - gap / 2;
        break;
      }
    }
    if (nowLineX !== null) {
      bars += `<line x1="${nowLineX}" y1="-12" x2="${nowLineX}" y2="${totalH}" stroke="#888780" stroke-width="0.8" stroke-dasharray="3,2" opacity="0.7"/>`;
      bars += `<text x="${nowLineX}" y="-14" font-size="6.5" fill="#888780" text-anchor="middle" dominant-baseline="auto">Nå</text>`;
    }

    // Barer
    modules.forEach((mod, i) => {
      const x   = i * (barW + gap);
      const cx  = x + barW / 2;
      const num = parseLessonNum(mod.name) ?? (i + 1 + lessonOffset);
      const due       = moduleDeadlineMap[mod.id] || null;
      const isPastDue = due && due <= now;
      const isStarted = mod.total > 0 && mod.completed > 0;

      // Leksjonsnummer — rotert loddrett i labelH-sonen over søylen
      bars += `<text transform="rotate(-45,${cx},${labelH / 2})" x="${cx}" y="${labelH / 2}" font-size="9" fill="#444441" text-anchor="middle" dominant-baseline="central">${num}</text>`;

      if (isStarted) {
        // Grønn bar vokser oppover — intensitet øker mot 100%
        const pct   = mod.completed / mod.total;
        const fillH = Math.max(2, Math.round(pct * upH));
        bars += `<rect x="${x}" y="${midY - fillH}" width="${barW}" height="${fillH}" rx="2" fill="url(#cak-v-green)"/>`;
      } else if (isPastDue) {
        // Passert frist, ikke påbegynt — grå med svak skravering (nøytral)
        bars += `<rect x="${x}" y="${midY}" width="${barW}" height="${downH}" rx="2" fill="#d3d1c7"/>`;
        bars += `<rect x="${x}" y="${midY}" width="${barW}" height="${downH}" rx="2" fill="url(#cak-hatch)"/>`;
      } else {
        // Fremtidig / ikke påbegynt — stiplet grå kontur ned
        bars += `<rect x="${x}" y="${midY}" width="${barW}" height="${downH}" rx="2" fill="none" stroke="#c8c6be" stroke-width="1" stroke-dasharray="3,2"/>`;
      }
    });

    // Prikker over midtlinjen — leverte oppgaver (oransje kant = venter vurdering, grønn kant = vurdert)
    modules.forEach((mod, i) => {
      const total  = (deliveredPerMod || {})[mod.id] || 0;
      if (total === 0) return;
      const venter  = (venterPerMod || {})[mod.id] || 0;
      const vurdert = Math.max(0, total - venter);
      const cx      = i * (barW + gap) + barW / 2;
      const r = 3, dotGap = 2;
      const maxDots = Math.floor(upH / (r * 2 + dotGap));
      let d = 0;
      for (let v = 0; v < Math.min(venter, maxDots); v++, d++) {
        const cy = midY - r - 2 - d * (r * 2 + dotGap);
        bars += `<circle cx="${cx}" cy="${cy}" r="${r}" fill="white" stroke="#e65100" stroke-width="1.8"/>`;
      }
      for (let g = 0; g < Math.min(vurdert, maxDots - d); g++, d++) {
        const cy = midY - r - 2 - d * (r * 2 + dotGap);
        bars += `<circle cx="${cx}" cy="${cy}" r="${r}" fill="white" stroke="#3b6d11" stroke-width="0.8"/>`;
      }
      // Fritatt-prikkar: stipla grå kant — tydeleg skilt frå venter (oransje) og vurdert (grøn)
      const excused = (excusedPerMod || {})[mod.id] || 0;
      for (let e = 0; e < Math.min(excused, maxDots - d); e++, d++) {
        const cy = midY - r - 2 - d * (r * 2 + dotGap);
        bars += `<circle cx="${cx}" cy="${cy}" r="${r}" fill="white" stroke="#e09b00" stroke-width="1.8"/>`;
      }
    });

    // Prikker under midtlinjen — manglende innleveringer (mørk kant)
    modules.forEach((mod, i) => {
      const count = (skippedPerMod || {})[mod.id] || 0;
      if (count === 0) return;
      const cx      = i * (barW + gap) + barW / 2;
      const r = 3, dotGap = 2;
      const maxDots = Math.floor(downH / (r * 2 + dotGap));
      const dots    = Math.min(count, maxDots);
      for (let d = 0; d < dots; d++) {
        const cy = midY + r + 2 + d * (r * 2 + dotGap);
        bars += `<circle cx="${cx}" cy="${cy}" r="${r}" fill="white" stroke="#3a3a3a" stroke-width="0.8"/>`;
      }
    });

    // Prikker under midtlinjen — fremtidige leksjoner (stiplet kant, forhåndsvisning)
    modules.forEach((mod, i) => {
      const due       = moduleDeadlineMap[mod.id] || null;
      const isPastDue = due && due <= now;
      if (isPastDue) return;
      const futureCount      = (moduleMapGlobal[mod.id] || []).filter(a => a.due_at && !a.omit_from_final_grade).length;
      const alreadyDelivered = (deliveredPerMod || {})[mod.id] || 0;
      const remaining        = futureCount - alreadyDelivered;
      if (remaining <= 0) return;
      const cx      = i * (barW + gap) + barW / 2;
      const r = 3, dotGap = 2;
      const maxDots = Math.floor(downH / (r * 2 + dotGap));
      const dots    = Math.min(remaining, maxDots);
      for (let d = 0; d < dots; d++) {
        const cy = midY + r + 2 + d * (r * 2 + dotGap);
        bars += `<circle cx="${cx}" cy="${cy}" r="${r}" fill="#dedad4" stroke="#888780" stroke-width="1"/>`;
      }
    });

    return `<svg width="${W}" height="${totalH}" viewBox="0 0 ${W} ${totalH}"
      overflow="visible" style="display:block;margin-top:20px;min-width:${W}px">${defs}${bars}</svg>`;
  }

  function buildTooltip(loginDays, subDays, delta, count, godkjent, venterVurdering, totalt, leksjonerEtter, batteryModules, hoppetOver, skippedPerMod, deliveredPerMod, activeMods, venterPerMod, excusedPerMod) {
    const l = loginDays === null
      ? 'Ikke innlogget ennå'
      : `Innlogget: ${loginDays} dag${loginDays === 1 ? '' : 'er'} siden`;
    const s = subDays === null
      ? 'Ikke levert oppgaver ennå'
      : `Innlevert: ${subDays} dag${subDays === 1 ? '' : 'er'} siden`;
    let d = 'Ingen frister i kurset';
    if (delta === null) {
      d = 'Har frister — ikke levert';
    } else if (delta !== undefined) {
      const terskel = cfg.lessonThreshold || 50;
      if (totalt > 0) {
        const pending = venterVurdering || 0;
        const pendingWord = pending === 1 ? 'innlevering' : 'innleveringer';
        const pendingDot = pending > 0
          ? `<svg width="9" height="9" viewBox="0 0 9 9" style="vertical-align:middle;margin-right:3px"><circle cx="4.5" cy="4.5" r="3.5" fill="white" stroke="#e65100" stroke-width="1.8"/></svg>`
          : '';
        const badge = getFundingBadge(godkjent);
        const leksjonStr = badge
          ? `<span style="display:inline-flex;align-items:center;gap:6px;vertical-align:middle"><span style="display:inline-block;background:#fff;color:${badge.color};border:1.5px solid ${badge.border};font-size:10px;font-weight:700;padding:1px 6px;border-radius:8px;">${badge.label}</span><span style="color:#5f5e5a;font-size:12px;">leksjoner fullført · Terskel: ${terskel}%</span></span>`
          : `${godkjent} av 15 leksjoner Fullført · Terskel: ${terskel}%`;
        d = leksjonStr + `<br>${pendingDot}${pending} ${pendingWord} venter vurdering`;
        if (delta > 0) {
          const leks = delta === 1 ? '1 leksjon' : `${delta} leksjoner`;
          d += `<br>I forkant — levert i ${leks} med fremtidig frist`;
        }
        if (leksjonerEtter >= 2) {
          const leks = leksjonerEtter === 1 ? '1 leksjon' : `${leksjonerEtter} leksjoner`;
          d += `<br>På etterskudd — ${leks} etter skoleruta`;
        }
      } else {
        d = 'I rute — ingen leksjoner under terskel';
      }
    }
    let battery = '';
    let avgViewLine = '';
    if (batteryModules === null) {
      battery = '<div style="margin-top:7px;border-top:0.5px solid #e8e6de;padding-top:6px;color:#888780;font-size:11px;">Laster lærestoffvisning…</div>';
    } else if (batteryModules && batteryModules.length > 0) {
      const avgPct = calcAvgViewPct(batteryModules, activeMods);
      if (avgPct !== null) {
        const viewColor = avgPct >= 60 ? '#3b6d11' : avgPct >= 30 ? '#5f5e5a' : '#a32d2d';
        avgViewLine = `<br><span style="color:${viewColor}">Snitt visning: ${avgPct}\u00a0%</span>`;
      }
      const relevant = batteryModules.filter(m => m.total > 0);
      if (relevant.length > 0) {
        battery = '<div style="margin-top:7px;border-top:0.5px solid #e8e6de;padding-top:5px">'
          + '<div style="font-size:11px;color:#5f5e5a;margin-bottom:4px">Lærestoff sett per leksjon</div>'
          + makeBatterySvg(batteryModules, skippedPerMod || {}, deliveredPerMod || {}, detectSemesterOffset(), venterPerMod || {}, excusedPerMod || {})
          + '</div>';
      }
    }

    const skipped = hoppetOver > 0
      ? `<br><span style="color:#c62828"><svg width="9" height="9" viewBox="0 0 9 9" style="vertical-align:middle;margin-right:3px"><circle cx="4.5" cy="4.5" r="3.5" fill="white" stroke="#3a3a3a" stroke-width="1"/></svg>${hoppetOver} innlevering${hoppetOver === 1 ? '' : 'er'} med status Mangler</span>`
      : '';

    return `${l}<br>${s}<br>${d}${avgViewLine}${skipped}${battery}`;
  }

  function updateCacheStatus(date) {
    chrome.storage.local.set({ cak_last_updated: date.getTime() });
  }

  function getCourseId() {
    const m = location.pathname.match(/\/courses\/(\d+)/);
    return m ? m[1] : null;
  }

  // ─── Sortering ────────────────────────────────────────────────────────────
  function toggleSort() {
    sortActive = !sortActive;
    updateOverlay();
  }

  function priorityScore(sid) {
    const data = studentData[sid];
    if (!data) return 99999;
    const login = daysSince(data.lastActivity);
    const sub   = daysSince(data.lastSubmission);
    const delta = data.deadlineDelta;
    const loginScore = (login === null ? 60 : login) * 1.0;
    const subScore   = (sub   === null ? 60 : sub)   * 1.5;
    const deadScore  = (delta === null ? 30 :
                        delta === undefined ? 0 :
                        Math.max(0, -delta)) * 2.0;
    return loginScore + subScore + deadScore;
  }

  // ─── Observer — ignorerer egne DOM-endringer ──────────────────────────────
  function observeChanges() {
    const debouncedUpdate = debounce(() => {
      if (!isUpdating) updateOverlay();
    }, 150);

    // Observer på Canvas sin grid — ikke på hele body
    const gridRoot = document.querySelector(
      '#gradebook_grid, .Gradebook__GradebookBody, #application'
    ) || document.body;

    new MutationObserver((mutations) => {
      const fromUs = mutations.every(m =>
        overlayEl && (overlayEl.contains(m.target) || m.target === overlayEl)
      );
      if (!fromUs) {
        debouncedUpdate();
      }
    }).observe(gridRoot, { childList: true, subtree: true, attributes: false });

    document.querySelectorAll('.slick-viewport').forEach((vp) => {
      vp.addEventListener('scroll', debouncedUpdate, { passive: true });
    });
    window.addEventListener('scroll', debouncedUpdate, { passive: true });
    window.addEventListener('resize', debouncedUpdate, { passive: true });

    // ResizeObserver på grid-canvas: fanger rad-tillegg og høyde-endringer
    // som MutationObserver (childList) kan misse under Canvas sin init-sekvens
    const frozenCanvas = findFrozenCanvas();
    if (frozenCanvas && window.ResizeObserver) {
      new ResizeObserver(debouncedUpdate).observe(frozenCanvas);
    }
  }

  function debounce(fn, ms) {
    let t;
    return (...args) => { clearTimeout(t); t = setTimeout(() => fn(...args), ms); };
  }

  // ─── PNG-kort nedlasting ──────────────────────────────────────────────────
  async function downloadStudentCard(sid) {
    const d      = studentData[sid] || {};
    const name   = studentNames[sid] || 'Ukjent elev';
    const lDays  = daysSince(d.lastActivity);
    const sDays  = daysSince(d.lastSubmission);
    const batData = moduleCompletionCache.hasOwnProperty(sid) ? moduleCompletionCache[sid] : null;

    const svgStr = buildStudentCardSvg(
      name, lDays, sDays, d.deadlineDelta, d.godkjent, d.totalt,
      d.leksjonerEtter, d.venterVurdering, d.hoppetOver,
      d.missingByMod || {}, batData, d.skippedPerMod || {},
      d.deliveredPerMod || {}, d.activeMods, d.venterPerMod || {}, d.excusedPerMod || {}
    );

    const blob = await svgToPng(svgStr);
    const url  = URL.createObjectURL(blob);
    const a    = document.createElement('a');
    a.href     = url;
    a.download = `${name.replace(/[^a-zA-ZæøåÆØÅ0-9 ]/g, '_')}.png`;
    a.click();
    URL.revokeObjectURL(url);
  }

  function xmlEsc(str) {
    return String(str)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;')
      .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }

  function buildStudentCardSvg(name, lDays, sDays, delta, godkjent, totalt,
      leksjonerEtter, venterVurdering, hoppetOver, missingByMod, batData, skippedPerMod,
      deliveredPerMod, activeMods, venterPerMod, excusedPerMod) {
    const W      = 340;
    const pad    = 14;
    const lineH  = 17;
    const font   = 'Lato, Arial, sans-serif';
    const courseId = getCourseId();
    const linkMode = cfg.copyLinkMode || 'both';

    // Tekstlinjer
    const textLines = [];
    textLines.push({ t: lDays === null ? 'Ikke innlogget ennå' : `Innlogget: ${lDays} dag${lDays===1?'':'er'} siden`, col:'#5f5e5a' });
    textLines.push({ t: sDays === null ? 'Ikke levert oppgaver ennå' : `Innlevert: ${sDays} dag${sDays===1?'':'er'} siden`, col:'#5f5e5a' });

    if (delta === undefined && !totalt) {
      textLines.push({ t: 'Ingen frister i kurset', col: '#888780' });
    } else if (delta === null) {
      textLines.push({ t: 'Har frister — ikke levert', col: '#a32d2d' });
    } else if (totalt > 0) {
      const terskel = cfg.lessonThreshold || 50;
      const pending = venterVurdering || 0;
      textLines.push({ t: `${godkjent} av 15 leksjoner fullført · Terskel: ${terskel}%`, col:'#2c2c2a' });
      if (pending > 0) textLines.push({ t: `${pending} innlevering${pending===1?'':'er'} venter vurdering`, col:'#888780' });
      if (delta > 0)  textLines.push({ t: `I forkant — ${delta} leksjon${delta===1?'':'er'} med fremtidig frist`, col:'#3b6d11' });
      if (leksjonerEtter >= 2) textLines.push({ t: `På etterskudd — ${leksjonerEtter} leksjon${leksjonerEtter===1?'':'er'} etter skoleruta`, col:'#a32d2d' });
    } else {
      textLines.push({ t: 'I rute — ingen leksjoner under terskel', col:'#3b6d11' });
    }
    if (hoppetOver > 0) textLines.push({ t: `${hoppetOver} innlevering${hoppetOver===1?'':'er'} med status Mangler`, col:'#c62828' });

    // Manglende innleveringslenker som tekst (bare for SVG — lenker vises ikke i PNG)
    const linkTextLines = [];
    if (courseId && missingByMod && Object.keys(missingByMod).length > 0) {
      Object.entries(missingByMod).forEach(([modId, asgns]) => {
        const modName = moduleNameMapGlobal[modId] || `Leksjon ${modId}`;
        asgns.forEach(a => {
          const include = linkMode==='both' ? true : linkMode==='auto' ? a.isNQ : !a.isNQ;
          if (!include) return;
          const due = a.dueAt ? new Date(a.dueAt).toLocaleDateString('no-NO') : '';
          linkTextLines.push({ t: `${modName}: ${a.name}${due ? ' ('+due+')' : ''}`, col:'#5f5e5a', size:10 });
        });
      });
    }

    // Batteridiagram
    let batParts = null;
    if (batData && batData.length > 0 && batData.some(m => m.total > 0)) {
      const batSvg = makeBatterySvg(batData, skippedPerMod || {}, deliveredPerMod || {}, detectSemesterOffset(), venterPerMod || {}, excusedPerMod || {});
      batParts = extractSvgContent(batSvg);
    }

    // Beregn høyde
    const headerH = 36;
    const textH   = textLines.length * lineH + 10;
    const linkH   = linkTextLines.length > 0 ? linkTextLines.length * 14 + 20 : 0;
    const batH    = batParts ? batParts.height + 26 : 0;
    const totalH  = headerH + textH + linkH + batH + pad + 20;

    // Bygg SVG
    let defs = '';
    let body = '';

    // Bakgrunn
    body += `<rect width="${W}" height="${totalH}" fill="#fff" rx="7"/>`;
    body += `<rect width="${W}" height="${totalH}" fill="none" stroke="#d3d1c7" stroke-width="1" rx="7"/>`;

    // Topptekst (header)
    body += `<rect width="${W}" height="${headerH}" fill="#eeecea" rx="7"/>`;
    body += `<rect y="${headerH-12}" width="${W}" height="12" fill="#eeecea"/>`;
    body += `<line x1="0" y1="${headerH}" x2="${W}" y2="${headerH}" stroke="#c0beb5" stroke-width="0.5"/>`;
    body += `<text x="${pad}" y="22" font-size="13" font-weight="bold" font-family="${xmlEsc(font)}" fill="#2c2c2a">${xmlEsc(name)}</text>`;

    // Tekstlinjer
    let y = headerH + 14;
    textLines.forEach(line => {
      const size = line.size || 11;
      body += `<text x="${pad}" y="${y}" font-size="${size}" font-family="${xmlEsc(font)}" fill="${line.col}">${xmlEsc(line.t)}</text>`;
      y += lineH;
    });

    // Lenkeliste (bare tekst i PNG)
    if (linkTextLines.length > 0) {
      y += 6;
      body += `<line x1="${pad}" y1="${y}" x2="${W-pad}" y2="${y}" stroke="#e8e6de" stroke-width="0.5"/>`;
      y += 12;
      body += `<text x="${pad}" y="${y}" font-size="10" font-family="${xmlEsc(font)}" fill="#888780">Innleveringsoppgaver med passert frist:</text>`;
      y += 14;
      linkTextLines.forEach(line => {
        body += `<text x="${pad+4}" y="${y}" font-size="10" font-family="${xmlEsc(font)}" fill="${line.col}">${xmlEsc(line.t)}</text>`;
        y += 14;
      });
    }

    // Batteridiagram
    if (batParts) {
      y += 6;
      body += `<line x1="${pad}" y1="${y}" x2="${W-pad}" y2="${y}" stroke="#e8e6de" stroke-width="0.5"/>`;
      y += 12;
      body += `<text x="${pad}" y="${y}" font-size="10" font-family="${xmlEsc(font)}" fill="#888780">Lærestoff sett per leksjon</text>`;
      y += 8;
      defs += batParts.defs;
      body += `<g transform="translate(${pad},${y})">${batParts.inner}</g>`;
    }

    // Tidsstempel nederst
    const ts = norskTidsstempel();
    body += `<text x="${W - pad}" y="${totalH - 6}" font-size="9" font-family="${xmlEsc(font)}" fill="#b4b2a9" text-anchor="end">Hentet ${xmlEsc(ts)}</text>`;

    return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${totalH}"><defs>${defs}</defs>${body}</svg>`;
  }

  // ─── Norsk tidsstempel ─────────────────────────────────────────────────────
  function norskTidsstempel() {
    const n  = new Date();
    const hh = String(n.getHours()).padStart(2, '0');
    const mm = String(n.getMinutes()).padStart(2, '0');
    const dd = String(n.getDate()).padStart(2, '0');
    const mo = String(n.getMonth() + 1).padStart(2, '0');
    return `Kl. ${hh}.${mm} ${dd}.${mo}.${n.getFullYear()}`;
  }

  // Trekker ut defs, inner-innhold, bredde og høyde fra en SVG-streng
  function extractSvgContent(svgStr) {
    const defsM = svgStr.match(/<defs>([\s\S]*?)<\/defs>/);
    const defs  = defsM ? defsM[1] : '';
    const inner = svgStr
      .replace(/<svg[^>]*>/,  '')
      .replace('</svg>', '')
      .replace(/<defs>[\s\S]*?<\/defs>/, '');
    const wM = svgStr.match(/width="(\d+(?:\.\d+)?)"/);
    const hM = svgStr.match(/height="(\d+(?:\.\d+)?)"/);
    return { defs, inner, width: wM ? parseFloat(wM[1]) : 200, height: hM ? parseFloat(hM[1]) : 126 };
  }

  // Konverterer SVG-streng til PNG Blob via canvas
  function svgToPng(svgStr) {
    return new Promise((resolve, reject) => {
      const blob = new Blob([svgStr], { type: 'image/svg+xml' });
      const url  = URL.createObjectURL(blob);
      const img  = new Image();
      img.onload = () => {
        const canvas = document.createElement('canvas');
        const scale  = window.devicePixelRatio || 1;
        canvas.width  = img.naturalWidth  * scale;
        canvas.height = img.naturalHeight * scale;
        const ctx = canvas.getContext('2d');
        ctx.scale(scale, scale);
        ctx.fillStyle = '#ffffff';
        ctx.fillRect(0, 0, img.naturalWidth, img.naturalHeight);
        ctx.drawImage(img, 0, 0);
        URL.revokeObjectURL(url);
        canvas.toBlob(resolve, 'image/png');
      };
      img.onerror = (e) => { URL.revokeObjectURL(url); reject(e); };
      img.src = url;
    });
  }

  // ─── Fargekategori-klassifisering ─────────────────────────────────────────
  function colorCategory(sid) {
    const data  = studentData[sid] || {};
    const lEtter = data.leksjonerEtter;
    const hasDL  = data.hasDeadlines;
    if (lEtter === null && !hasDL) return null; // ingen frister
    if (lEtter === null)           return 'red'; // frister men ikke levert
    if (lEtter <= 1)               return null;  // i rute
    if (lEtter === 2)              return 'green';
    if (lEtter === 3)              return 'yellow';
    return 'red'; // 4+
  }

  // ─── Bygg innhold for kopiering (plain text + HTML med SVG) ──────────────
  function buildCopyContent(name, loginDays, subDays, delta, count, godkjent,
      venterVurdering, totalt, leksjonerEtter, hoppetOver, missingByMod,
      batteryModules, skippedPerMod) {
    const courseId = getCourseId();

    // ─── Tekst-linjer ──
    const fornavn = name ? name.split(' ')[0] : '';
    const lines = [];
    lines.push('📌 Globalskolen, viktig påminnelse - ønsker svar');
    lines.push('');
    lines.push(`Hei, ${fornavn} og foresatte,`);
    lines.push('');
    lines.push('Håper dere har det bra.');
    lines.push('');
    lines.push(`Nederst finner dere en oversikt som viser innleveringer som ikke er levert enda – de har status "Mangler" i Canvas. Det er viktig at ${fornavn} gjør en ekstra innsats nå med å jobbe med disse oppgavene/leksjonene for å komme i mål med semesteret.`);
    lines.push('');
    lines.push('Oversikten over lærestoff og alle oppgaver er ellers samlet under «Moduler/Leksjoner» i menyen.');
    lines.push('');
    lines.push('Jeg ønsker svar på denne meldingen slik at jeg vet at den er mottatt og lest. Hvis tiden er for knapp, kan vi gjøre avtale om andre innleveringsfrister.');
    lines.push('');
    lines.push('Ha en fin uke videre!');
    lines.push('');
    lines.push('Med vennlig hilsen');
    lines.push('');
    lines.push('Globalskolen');

    // ─── Lenker til manglende oppgaver ──
    const linkMode = cfg.copyLinkMode || 'both';
    const linkLines = [];
    const linkHtmlItems = [];
    if (courseId && missingByMod && Object.keys(missingByMod).length > 0) {
      Object.entries(missingByMod).forEach(([modId, asgns]) => {
        const modName = moduleNameMapGlobal[modId] || `Leksjon ${modId}`;
        const modLines = [];
        const modHtml  = [];
        asgns.forEach(a => {
          const include = linkMode === 'both'
            ? true
            : linkMode === 'auto'   ? a.isNQ
            : /* unntatt NQ */        !a.isNQ;
          if (!include) return;
          const url    = `${location.origin}/courses/${courseId}/assignments/${a.id}`;
          const due    = a.dueAt ? new Date(a.dueAt).toLocaleDateString('no-NO') : '';
          const dueStr = due ? ` (frist: ${due})` : '';
          modLines.push(`  ${a.name}${dueStr}\n  ${url}`);
          modHtml.push(`<li><a href="${url}">${a.name}</a>${due ? ' — <em>frist: ' + due + '</em>' : ''}</li>`);
        });
        if (modLines.length > 0) {
          linkLines.push(`${modName}:`);
          linkLines.push(...modLines);
          linkLines.push(''); // tom linje mellom leksjoner
          linkHtmlItems.push(`<li><strong>${modName}</strong><ul style="margin:2px 0 6px">${modHtml.join('')}</ul></li>`);
        }
      });
    }
    if (linkLines.length > 0) {
      lines.push('');
      lines.push('Innleveringsoppgaver med passert frist:');
      lines.push(...linkLines);
    }

    const ts = norskTidsstempel();
    lines.push('');
    lines.push(`Hentet ${ts}`);

    const plainText = lines.join('\n');

    // ─── HTML-versjon ──
    // Bygges fra lines-arrayen (samme kilde som plainText) for å sikre at
    // intro-teksten er identisk enten man limer inn i Canvas, e-post eller Office 365.
    // Lenker legges til som klikkbar <ul> fra linkHtmlItems.
    const introLineCount = lines.length - 2 - (linkLines.length > 0 ? 2 + linkLines.length : 0);
    const introLines = lines.slice(0, introLineCount);
    let htmlBody = '';
    let currentPara = [];
    for (const line of introLines) {
      if (line === '') {
        if (currentPara.length > 0) {
          htmlBody += `<p style="font-family:sans-serif;font-size:13px;font-weight:normal;line-height:1.6;margin:0 0 10px">${currentPara.join('<br>')}</p>`;
          currentPara = [];
        }
      } else {
        currentPara.push(line);
      }
    }
    if (currentPara.length > 0) {
      htmlBody += `<p style="font-family:sans-serif;font-size:13px;font-weight:normal;line-height:1.6;margin:0 0 10px">${currentPara.join('<br>')}</p>`;
    }

    if (linkHtmlItems.length > 0) {
      htmlBody += `<p style="font-family:sans-serif;font-size:13px;margin:8px 0 4px"><strong>Innleveringsoppgaver med passert frist:</strong></p>`;
      htmlBody += `<ul style="font-family:sans-serif;font-size:13px;margin:0;padding-left:20px;line-height:1.7">${linkHtmlItems.join('')}</ul>`;
    }

    htmlBody += `<p style="font-family:sans-serif;font-size:10px;color:#b4b2a9;margin:10px 0 0">Hentet ${ts}</p>`;

    const htmlContent = `<!DOCTYPE html><html><body>${htmlBody}</body></html>`;
    return { plain: plainText, html: htmlContent };
  }

  // ─── Filtrer etter maks godkjente leksjoner ───────────────────────────────
  async function filterByLessonCount(maxGodkjent) {
    const input = document.querySelector('#student-names-filter');
    if (!input) return 0;

    const targets = Object.entries(studentNames)
      .filter(([sid]) => {
        const data = studentData[sid] || {};
        // Elever uten noen leksjondata ekskluderes; de med 0 godkjente inkluderes
        const g = data.godkjent ?? (data.hasDeadlines ? 0 : undefined);
        return g !== undefined && g <= maxGodkjent;
      })
      .map(([, name]) => name.trim().toLowerCase());
    if (targets.length === 0) return 0;

    const filterWrap = input.closest('[class*="Select"]')
      || input.closest('[class*="select"]')
      || input.parentElement?.parentElement;
    if (filterWrap) {
      const removeBtns = filterWrap.querySelectorAll(
        '[class*="close"], [aria-label*="emove"], [aria-label*="jern"], [aria-label*="Clear"]'
      );
      removeBtns.forEach(b => b.click());
      if (removeBtns.length > 0) await new Promise(r => setTimeout(r, 200));
    }

    let clicked = 0;
    for (const targetName of targets) {
      input.click();
      input.focus();
      await new Promise(r => setTimeout(r, 300));
      const listboxId = input.getAttribute('aria-controls') || input.getAttribute('aria-owns');
      const listbox   = (listboxId ? document.getElementById(listboxId) : null)
        || document.querySelector('[role="listbox"]');
      if (!listbox) break;
      const opt = Array.from(listbox.querySelectorAll('[role="option"]'))
        .find(o => o.textContent.trim().toLowerCase() === targetName);
      if (opt) {
        opt.click();
        await new Promise(r => setTimeout(r, 120));
        clicked++;
      }
    }
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    return clicked;
  }

  // ─── Filtrer elevliste i Canvas ────────────────────────────────────────────
  async function filterByColor(category) {
    const input = document.querySelector('#student-names-filter');
    if (!input) return 0;

    const targets = Object.entries(studentNames)
      .filter(([sid]) => colorCategory(sid) === category)
      .map(([, name]) => name.trim().toLowerCase());
    if (targets.length === 0) return 0;

    // Fjern eksisterende valgte elever (klikk fjern-knapper på tags)
    const filterWrap = input.closest('[class*="Select"]')
      || input.closest('[class*="select"]')
      || input.parentElement?.parentElement;
    if (filterWrap) {
      const removeBtns = filterWrap.querySelectorAll(
        '[class*="close"], [aria-label*="emove"], [aria-label*="jern"], [aria-label*="Clear"]'
      );
      removeBtns.forEach(b => b.click());
      if (removeBtns.length > 0) await new Promise(r => setTimeout(r, 200));
    }

    // Åpne og velg én og én elev — dropdown lukker seg etter hvert klikk
    let clicked = 0;
    for (const targetName of targets) {
      input.click();
      input.focus();
      await new Promise(r => setTimeout(r, 300));

      const listboxId = input.getAttribute('aria-controls') || input.getAttribute('aria-owns');
      const listbox   = (listboxId ? document.getElementById(listboxId) : null)
        || document.querySelector('[role="listbox"]');
      if (!listbox) break;

      const opt = Array.from(listbox.querySelectorAll('[role="option"]'))
        .find(o => o.textContent.trim().toLowerCase() === targetName);
      if (opt) {
        opt.click();
        await new Promise(r => setTimeout(r, 120));
        clicked++;
      }
    }

    // Lukk nedtrekkslisten
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    return clicked;
  }

  // ─── Nullstill fargefilter i Canvas ────────────────────────────────────────
  async function clearColorFilter() {
    const input = document.querySelector('#student-names-filter');
    if (!input) return 0;

    // Presis selektor for tag-fjernknapper i Instructure UI
    const SEL = '[aria-label*="emove"], [aria-label*="Fjern"], [aria-label*="jern"], [class*="dismiss"]';

    // Klatre oppover DOM-treet til vi finner containeren som har fjernknapper
    let container = input.parentElement;
    for (let up = 0; up < 8 && container && container !== document.body; up++) {
      if (container.querySelector(SEL)) break;
      container = container.parentElement;
    }

    let removed = 0;

    if (container && container.querySelector(SEL)) {
      // Klikk første fjernknapp i loop til ingen er igjen
      for (let attempt = 0; attempt < 60; attempt++) {
        const btn = container.querySelector(SEL);
        if (!btn) break;
        btn.click();
        await new Promise(r => setTimeout(r, 150));
        removed++;
      }
    } else {
      // Fallback: Backspace fjerner siste valgte tag i Instructure UI Select
      const tagCount = Object.keys(studentData).filter(sid => colorCategory(sid) !== null).length;
      if (tagCount === 0) return 0;
      input.focus();
      await new Promise(r => setTimeout(r, 100));
      for (let i = 0; i < Math.min(tagCount, 50); i++) {
        input.dispatchEvent(new KeyboardEvent('keydown', {
          key: 'Backspace', code: 'Backspace', keyCode: 8, bubbles: true
        }));
        await new Promise(r => setTimeout(r, 150));
        removed++;
      }
    }

    return removed;
  }

  // ─── Lag 3 — Sanntidssensor ───────────────────────────────────────────────
  // Mottek meldingar frå sensor.js (world: MAIN) og oppdaterer studentData
  // direkte utan full re-fetch. Gjev umiddelbar visuell respons.

  function patchStudentFromSubmission(sid, sub) {
    const student = studentData[sid];
    if (!student) return;

    // Oppdater siste innleveringstidspunkt
    const ts = sub.submitted_at || sub.graded_at;
    if (ts) {
      const d = new Date(ts);
      if (!student.lastSubmission || d > student.lastSubmission) {
        student.lastSubmission = d;
      }
    }

    // Oppdater manglande-sett (handterer både Set og JSON-deserialisert objekt)
    if (sub.assignment_id) {
      if (!(student.subMissingSet instanceof Set)) {
        student.subMissingSet = new Set(Object.keys(student.subMissingSet || {}));
      }
      if (sub.missing === true) {
        student.subMissingSet.add(sub.assignment_id);
      } else if (sub.missing === false) {
        student.subMissingSet.delete(sub.assignment_id);
      }
      // null = Canvas-responsen inneheld ikkje missing-felt — rør ikkje subMissingSet
    }

    // Rekn om over/under-streken i batterigrafikken basert på oppdatert subMissingSet
    if (Array.isArray(moduleCompletionCache[sid])) {
      recalcDotsFromModules(sid, moduleCompletionCache[sid]);
    }

    // Oppdater venterVurdering — Canvas kan halde workflow_state='submitted' sjølv etter
    // vurdering (særleg NQ/quiz). Bruk grade/graded_at for å avgjere om det er vurdert.
    const erNåVurdert = !!(sub.grade || sub.graded_at);
    if (erNåVurdert && student.venterVurdering > 0) {
      student.venterVurdering--;
    }

    // Fjern cella frå cache → tvingar re-render av nettopp denne cella
    cellCache.delete(sid);
    updateOverlay();
  }

  async function patchStudentFromModuleCompletion(sid) {
    if (!studentData[sid]) return;
    try {
      const modules = await fetchModuleCompletion(sid);
      moduleCompletionCache[sid] = modules;
      studentData[sid].avgViewPct = calcAvgViewPct(modules, studentData[sid]?.activeMods);
      recalcDotsFromModules(sid, modules);

      // Skriv oppdatert modul-cache til storage
      const courseId = getCourseId();
      if (courseId) {
        chrome.storage.local.set({
          [`cak_mod_${courseId}`]: { ts: Date.now(), data: moduleCompletionCache }
        });
      }
    } catch (_) {}
    cellCache.delete(sid);
    updateOverlay();
  }

  window.addEventListener('message', (event) => {
    if (event.source !== window || !event.data?._cak) return;
    const { type, userId, submission } = event.data;
    if (!userId) return;
    if (type === 'submission') {
      patchStudentFromSubmission(userId, submission);
    } else if (type === 'module_completion') {
      patchStudentFromModuleCompletion(userId);
    }
  });

  // ─── Meldingslytter fra popup ──────────────────────────────────────────────
  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (msg.type === 'GET_COLOR_STATS') {
      if (isLoading) {
        sendResponse({ loading: true, green: [], yellow: [], red: [] });
        return true;
      }
      const green = [], yellow = [], red = [];
      for (const sid of Object.keys(studentData)) {
        const cat  = colorCategory(sid);
        const name = studentNames[sid];
        if (!name || !cat) continue;
        if (cat === 'green')  green.push({ sid, name });
        if (cat === 'yellow') yellow.push({ sid, name });
        if (cat === 'red')    red.push({ sid, name });
      }
      sendResponse({ loading: false, green, yellow, red });
      return true;
    }
    if (msg.type === 'GET_SECTIONS') {
      const sections = (typeof ENV !== 'undefined' && ENV.GRADEBOOK_OPTIONS?.sections) || [];
      sendResponse({ sections: sections.map(s => ({ id: String(s.id), name: s.name })) });
      return true;
    }
    if (msg.type === 'SOFT_REFRESH') {
      fetchData(true)
        .then(() => loadModuleCache())
        .then(() => { invalidateCache(); updateOverlay(); sendResponse({ ok: true }); })
        .catch(() => sendResponse({ ok: false }));
      return true;
    }
    if (msg.type === 'FILTER_BY_LESSON_COUNT') {
      filterByLessonCount(msg.maxGodkjent).then(count => sendResponse({ count }));
      return true;
    }
    if (msg.type === 'FILTER_BY_COLOR') {
      filterByColor(msg.category).then(count => sendResponse({ count }));
      return true;
    }
    if (msg.type === 'CLEAR_COLOR_FILTER') {
      clearColorFilter().then(removed => sendResponse({ removed }));
      return true;
    }
  });

})();
