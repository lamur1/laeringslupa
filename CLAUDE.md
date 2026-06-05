# Læringslupa — CLAUDE.md

Chrome-utvidelse (MV3) for Canvas LMS. Legg til ei svevande aktivitetskolonne i gradebook som viser innloggings- og innleveringsaktivitet per elev. Utvikla for Globalskolen — norsk nettskule for barn i utlandet.

## Prosjektstruktur

| Fil | Rolle |
|-----|-------|
| `content.js` | Hovudfil — all logikk, DOM-manipulasjon, Canvas API-henting |
| `background.js` | Service worker — alarm kvart 15. min, sender SOFT_REFRESH til opne faner |
| `popup.html` / `popup.js` | Innstillingspanel (toggle-ar, filtrering, seksjonval) |
| `manifest.json` | MV3, permissions: storage, tabs, clipboardWrite, alarms |
| `sensor.js` | Content script (world: MAIN) — wrapper window.fetch, snapper Canvas-svar |
| `gen_icons.py` | Genererer icon16/48/128.png — køyr ved ikonendring |

## Cache-arkitektur

To separate cacher i `chrome.storage.local`:

| Nøkkel | Innhald | TTL |
|--------|---------|-----|
| `cak_data_{courseId}` | Innleveringar, innlogging, karakterar | 15 min |
| `cak_mod_{courseId}` | Leksjonsgjennomføring per elev | 2 timar |

**Viktig:**
- `fetchData(forceRefresh)` skal ALDRI nullstille `moduleCompletionCache = {}` — dette øydelegg data som `backgroundLoadModuleCompletion` har henta og fører til at grøne barar forsvinn.
- `loadModuleCache()` skal ALDRI erstatte heile `moduleCompletionCache` med `cached.data` — bruk merge: overskriv berre elevar som IKKJE allereie ligg i `moduleCompletionCache` (fersk sesjondata har prioritet over lagra cache).
- `backgroundLoadModuleCompletion` hentar alltid fersk data frå Canvas API for alle elevar kvar sideinnlasting. `freshModuleSids` (Set) hindrar dobbelhenting same sesjon. `cak_mod_` brukast berre til hurtig startvisning medan henting pågår.
- "Oppdater"-knappen og `forceRefresh` rører ALDRI `cak_mod_` i storage.

## Kritiske designreglar

Desse reglane vart brotne 20.04.2026 og kosta ein økt å rette opp:

- **GRØNN BAR** = berre `must_view` (Vis-krav) — lærestoff utan dato.
  Filtrer ALLTID på `completion_requirement.type === 'must_view'`.
  Aldri alle `completion_requirement` — då trekkjast innleveringar inn.

- **PRIKKER** = `must_submit` (innleveringar med dato).
  Brukar `missing`-flagg og `due_at` frå Canvas API.

- **FREMTIDSPRIKKER** = `futureCount` minus allereie leverte — aldri `isStarted`-sjekk.

- **FRITATT** (`excused`) = eigen grå solid prikk (`fill="#b0bec5" stroke="#607d8b"`) over grunnlinja i batteriet.
  Canvas kan ha `excused: true` samstundes som `workflow_state === 'submitted'` — sjekk alltid BEGGE:
  `const isExcused = sub?.workflow_state === 'excused' || sub?.excused === true;`
  Fritatte innleveringar skal IKKJE teljast i `venter`-teljaren.

- **SNITT VISNING** = `sum(fullførte must_view-sider) / sum(totale must_view-sider)` berre over leksjonar der `completed > 0`.
  Uleste leksjonar inngår IKKJE i nemnaren. Aldri bruk `activeMods` som filter — det dreg inn leksjonar med 0% visning og gjev for lågt snitt.


## Arkitektur — tre lag (lag 1+2 er implementert, lag 3 er neste)

### Lag 1 — To-lags cache ✅
`cak_data_` (15 min) for innleveringar, `cak_mod_` (1t) for leksjonsdata.
"Oppdater" tømer berre `cak_data_` — leksjonsdata overlever og kolonnen lastar raskt.
`cak_mod_` brukast KUN til hurtig startvisning; `backgroundLoadModuleCompletion` hentar alltid fersk data i bakgrunnen.

### Lag 2 — Service worker ✅
`background.js` køyrer alarm kvart 5. min og sender `SOFT_REFRESH` til alle opne gradebook-faner.
Content script handterer hentinga og lastar modulcache på nytt etterpå.

### Lag 3 — Sanntidssensor ✅

Dette er det revolusjonerande laget. Canvas er ein SPA — alle endringar går via `fetch()`/`XHR` i nettlesaren. Ein content script med `world: 'MAIN'` kan wrappe `window.fetch` og lytte på alle Canvas sine eigne API-kall.

**Dataflyten:**
```
Lærar trykker "Fullført" på ei innlevering
        ↓
Canvas sender PUT /api/v1/courses/:id/assignments/:id/submissions/:user_id
                  { grade: 'complete' }
        ↓
Sensoren snapper opp svaret frå Canvas
        ↓
① studentData i minnet oppdaterer seg — firkanten blir grønn med ein gong
② cak_data_ i chrome.storage.local blir oppdatert
        ↓
Kolonnen oppdaterer seg — ingen klikk, ingen ventetid, ingen sideinnlasting
```

**Endepunkt å lytte på:**
- `PUT .../submissions/:user_id` — innlevering fullført/ikkje fullført
- `POST .../module_item_completions` — modul fullført
- `POST .../module_items/:id/mark_done` — manuell fullføring

**Implementert:**
- `sensor.js` (world: MAIN) wrapper `window.fetch` og postar til content script via `window.postMessage`
- Content script lyttar på `message`-event og kallar `patchStudentFromSubmission` / `patchStudentFromModuleCompletion`
- `subMissingSet` er ein `Set` i minnet, men må serialiserast til array i JSON (cak_data_) og deserialiseras tilbake ved lesing

**Resultat:** Læringslupa oppdaterer seg saumlaust medan lærar jobbar — og om sida lastar på nytt er cachen allereie fersk.

## Versjonering

Format: `YYYY.M.D.HHMM` — bruk alltid faktisk dato og klokkeslett ved ny versjon i `manifest.json`.

## Språk

All tekst i UI og kode er på norsk (bokmål i kode, nynorsk er ok i kommentarar).
