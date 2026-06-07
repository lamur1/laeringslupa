# Læringslupa — Utviklardokumentasjon

## Cache-arkitektur

To cacher i `chrome.storage.local` (overlever fane-reload):

| Nøkkel | Innhald | TTL | Tømt av |
|--------|---------|-----|---------|
| `cak_data_{courseId}` | Innleveringar, innlogging, karakterar per elev | 15 min | Oppdater-knapp, automatisk utløp |
| `cak_mod_{courseId}` | Leksjonsgjennomføring per elev | 60 min | Automatisk utløp |

To in-memory-strukturar (nullstillt ved kvar sideinnlasting):

| Variabel | Innhald | Nullstilt ved |
|----------|---------|--------------|
| `moduleCompletionCache` | Moduldata per elev (frå API eller cak_mod_) | Sideinnlasting |
| `freshModuleSids` | Elevar der moduldata er henta fersk denne sesjonen | Sideinnlasting |

---

## Oppdateringsmetodar

### 1. Oppdater-knappen (i dropdown-panelet)

**Kva skjer:**
1. `cak_data_` for dette kurset vert sletta frå `chrome.storage.local`
2. Fanen lastar heilt på nytt (`tabs.reload()`)
3. `init()` køyrer — same som Cmd+R nedanfor, men med tom submissions-cache

**Kva vert henta på nytt:** Alt — submissions, moduldata, innlogging
**Synleg for brukar:** Sida lastar på nytt

---

### 2. Cmd+R (vanleg reload)

**Kva skjer:**
1. Fanen lastar på nytt
2. `init()` køyrer:
   - `fetchData()` → les `cak_data_` frå storage. Om cache er fersk (< 15 min): brukar cachet data direkte. Om utløpt: henter alt frå Canvas API og skriv ny cache.
   - `loadModuleCache()` → les `cak_mod_` frå storage og køyrer `recalcDotsFromModules` for elevar som ikkje allereie er i `moduleCompletionCache`
   - `backgroundLoadModuleCompletion()` → henter alltid fersk moduldata frå Canvas API for alle elevar (med `student_id`), uavhengig av `cak_mod_`. `freshModuleSids` er tom etter reload, så alle elevar vert henta.
3. Etter 3 sekund: `fetchData(true)` køyrer stille og sikrar ferske submissions

**Kva vert henta på nytt:** Moduldata alltid. Submissions berre om cache er utløpt.
**Synleg for brukar:** Sida lastar på nytt

---

### 3. Cmd+Shift+R (hard reset)

**Kva skjer:**
Tømer nettlesarens eiga cache (HTML, CSS, JS-filer) og lastar på nytt.
`chrome.storage.local` er **ikkje** berørt — `cak_data_` og `cak_mod_` overlever.

Etter innlasting: identisk med Cmd+R.

**Kva vert henta på nytt:** Same som Cmd+R — submissions berre om cache er utløpt, moduldata alltid.
**Synleg for brukar:** Sida lastar på nytt

> **NB:** Hard reset tømer ikkje submissions-cachen. For å tvinge fram ferske submissions, bruk Oppdater-knappen.

---

### 4. Stille oppdatering kvart 5. minutt (background.js alarm)

**Kva skjer:**
1. `background.js` sender `SOFT_REFRESH` til alle opne gradebook-faner
2. Content script handterer meldinga:
   - `fetchData(true)` → hoppar over cache-sjekk, henter alltid ferske submissions, innlogging og karakterar frå Canvas API. Skriv ny `cak_data_`.
   - `loadModuleCache()` → les `cak_mod_`. Elevar som allereie ligg i `moduleCompletionCache` (i minnet) vert ikkje prosesserte på nytt.
   - `updateOverlay()` → grafikken oppdaterer seg stille

**Kva vert henta på nytt:** Submissions alltid. Moduldata **ikkje** (henta ved forrige sideinnlasting og ligg i minnet).
**Synleg for brukar:** Grafikken oppdaterer seg utan synleg sidelasting. Animasjon i tittelcella viser at oppdatering pågår.

---

## Samanlikning

| | Oppdater-knapp | Cmd+R | Cmd+Shift+R | Stille (5 min) |
|---|---|---|---|---|
| Sida lastar på nytt | Ja | Ja | Ja | Nei |
| `cak_data_` tømt | Ja | Nei | Nei | Nei |
| `cak_mod_` tømt | Nei | Nei | Nei | Nei |
| Submissions henta frå API | Alltid | Berre om utløpt | Berre om utløpt | Alltid |
| Moduldata henta frå API | Alltid | Alltid | Alltid | Nei |
| `moduleCompletionCache` nullstilt | Ja (reload) | Ja (reload) | Ja (reload) | Nei |
| `freshModuleSids` nullstilt | Ja (reload) | Ja (reload) | Ja (reload) | Nei |

---

## Oppstartssekvens (init)

```
init()
  ├── await fetchData()          → submissions (cache eller API)
  ├── await loadModuleCache()    → moduldata frå cak_mod_ (hurtigstart)
  ├── updateOverlay()            → første visning
  ├── backgroundLoadModuleCompletion()  → fersk moduldata frå API (bakgrunn, alle elevar)
  └── setTimeout(3s):
        await fetchData(true)    → alltid ferske submissions
        await loadModuleCache()
        updateOverlay()
```

`backgroundLoadModuleCompletion` køyrer parallelt og oppdaterer grafikken elev for elev etter kvart som data kjem inn. Kvar elev som er ferdig henta vert lagt i `freshModuleSids` — vert ikkje henta på nytt same sesjon (t.d. av den stille 5-min-oppdateringa).

---

## Cache-serialisering

`cak_data_` lagrar `studentData` som JSON. `Set`-objekt overlever ikkje JSON-runden direkte:

| Felt | Serialisert som | Gjenoppretta ved lesing |
|------|----------------|------------------------|
| `subMissingSet` | Array `[...]` | `new Set(array)` |
| `subExcusedSet` | Array `[...]` | `new Set(array)` (må leggast til i gjenoppretting) |
| `deliveredPerMod`, `excusedPerMod`, `venterPerMod`, `skippedPerMod` | Vanleg objekt `{}` | Direkte, ingen konvertering |

> **Obs:** `subExcusedSet` må serialiserast og gjenopprettast på same måte som `subMissingSet`. Sjå serialiseringsblokken i `fetchData` og gjenopprettingsblokken ved cache-lesing.
