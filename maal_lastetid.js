// ─────────────────────────────────────────────────────────────────────────────
// Læringslupa — lastetidsmåling (Performance API-versjon)
// Køyr dette i konsollen NÅR SIDA ER FERDIG LASTA — ingen spesiell rekkefølge.
// ─────────────────────────────────────────────────────────────────────────────

(function () {
  const nav = performance.getEntriesByType('navigation')[0];
  const t0  = nav ? nav.startTime : 0;

  const ms = (tid) => Math.round(tid - t0);

  console.log('%c═══ Læringslupa lastetidsmåling ═══', 'color:#2e7d32;font-weight:bold;font-size:13px');

  // ── 1. Sidelivssyklus ─────────────────────────────────────────────────────
  if (nav) {
    console.log('%c── Sideinnlasting ──', 'color:#555;font-weight:bold');
    console.log(`  DOM ferdig:        ${Math.round(nav.domContentLoadedEventEnd)} ms`);
    console.log(`  Sida heilt lasta:  ${Math.round(nav.loadEventEnd)} ms`);
  }

  // ── 2. Canvas API-kall ────────────────────────────────────────────────────
  const apiKall = performance.getEntriesByType('resource')
    .filter(e => e.name.includes('/api/v1/'))
    .map(e => ({
      url:      e.name.replace(location.origin, '').replace(/([?&]per_page=\d+)/, '$1'),
      start:    Math.round(e.startTime),
      varighet: Math.round(e.duration),
      slutt:    Math.round(e.startTime + e.duration)
    }))
    .sort((a, b) => a.start - b.start);

  console.log(`\n%c── Canvas API-kall (${apiKall.length} totalt) ──`, 'color:#555;font-weight:bold');
  apiKall.forEach(k => {
    const kort = k.url.length > 70 ? k.url.slice(0, 70) + '…' : k.url;
    console.log(`  +${String(k.start).padStart(5)} ms  ${String(k.varighet).padStart(5)} ms  ${kort}`);
  });

  // ── 3. Parallelle vs. sekvensielle kall ───────────────────────────────────
  console.log('\n%c── Analyse ──', 'color:#555;font-weight:bold');

  if (apiKall.length >= 2) {
    // Finn kall som overlapper i tid (parallelle)
    let parallelle = 0;
    for (let i = 0; i < apiKall.length; i++) {
      for (let j = i + 1; j < apiKall.length; j++) {
        if (apiKall[i].slutt > apiKall[j].start) parallelle++;
      }
    }
    console.log(`  Parallelle kall-par: ${parallelle}`);
    console.log(`  Sekvensielle kall:   ${apiKall.length - parallelle}`);
  }

  // Tyngste kall
  const tyngst = [...apiKall].sort((a, b) => b.varighet - a.varighet)[0];
  if (tyngst) {
    console.log(`  Tyngste kall:  ${tyngst.varighet} ms → ${tyngst.url.split('?')[0].replace(location.origin,'')}`);
  }

  // Totaltid frå første til siste API-kall
  if (apiKall.length >= 2) {
    const apiStart = apiKall[0].start;
    const apiSlutt = apiKall[apiKall.length - 1].slutt;
    console.log(`  API-vindauge:  ${apiStart} ms → ${apiSlutt} ms (${apiSlutt - apiStart} ms totalt)`);
  }

  // ── 4. CAK-overlay timing ─────────────────────────────────────────────────
  console.log('\n%c── DOM-tilstand no ──', 'color:#555;font-weight:bold');
  const cakCeller = document.querySelectorAll('.cak-cell').length;
  const slickRows = document.querySelectorAll('.slick-row').length;
  console.log(`  .slick-row:  ${slickRows}`);
  console.log(`  .cak-cell:   ${cakCeller}`);
  if (cakCeller === 0) console.log('  %c⚠ Ingen cak-celler — lupa er ikkje ferdig eller ikkje aktiv', 'color:orange');

  console.log('\n%c═══ Ferdig ═══', 'color:#2e7d32;font-weight:bold');
})();
