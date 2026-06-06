// sensor.js — køyrer i world:'MAIN', har tilgang til window.fetch
// Snapper opp Canvas API-svar og varslar content script via postMessage.
// Lyttar på:
//   PUT .../assignments/:aid/submissions/:userId — innlevering vurdert
//   POST .../module_item_completions            — leksjonsgjennomføring
(function () {
  'use strict';

  const SUB_PUT  = /\/api\/v1\/courses\/\d+\/assignments\/\d+\/submissions\/(\d+)/;
  const MOD_COMP = /\/api\/v1\/courses\/\d+\/module_item_completions/;

  const orig = window.fetch.bind(window);

  window.fetch = async function (...args) {
    const resp = await orig(...args);

    const req    = args[0];
    const init   = args[1] || {};
    const url    = typeof req === 'string' ? req
                 : req instanceof Request  ? req.url
                 : '';
    const method = (
      init.method ||
      (req instanceof Request ? req.method : '') ||
      'GET'
    ).toUpperCase();

    if (!resp.ok || !url.includes('/api/v1/')) return resp;

    try {
      // PUT .../submissions/:userId — lærar set karakter/fullført
      if (method === 'PUT') {
        const m = url.match(SUB_PUT);
        if (m) {
          resp.clone().json().then(data => {
            window.postMessage({
              _cak: 1,
              type:   'submission',
              userId: m[1],
              submission: {
                assignment_id:  String(data.assignment_id || ''),
                submitted_at:   data.submitted_at  || null,
                graded_at:      data.graded_at     || null,
                workflow_state: data.workflow_state || null,
                missing:        data.missing ?? null,
                grade:          data.grade         || null,
              }
            }, '*');
          }).catch(() => {});
        }
      }

      // POST .../module_item_completions — leksjon fullført
      if (method === 'POST' && MOD_COMP.test(url)) {
        resp.clone().json().then(data => {
          const uid =
            data?.user_id ??
            data?.module_item_completions?.[0]?.user_id ??
            null;
          if (uid) {
            window.postMessage({ _cak: 1, type: 'module_completion', userId: String(uid) }, '*');
          }
        }).catch(() => {});
      }
    } catch (_) {}

    return resp;
  };
})();
