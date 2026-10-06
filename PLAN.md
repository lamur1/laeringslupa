# PLAN.md — Port fra Chrome-utvidelse til Canvas tema-JS

Status: **utsatt / valgfri** (per august 2026). Kartlagt, ikke påbegynt.
Bug-fiksen i fremdriftsfilteret er alt levert (commit `1e61f86`) — denne porten er en
egen, uavhengig oppgave om distribusjon, ikke en feilretting.

## Mål

Fjerne behovet for at lærere laster ned og oppdaterer utvidelsen lokalt. Læringslupa
flyttes fra Chrome-utvidelse til én tema-injisert JS-fil (`laeringslupa.js`), lastet av
den eksisterende `loader.js` i Canvas tema-editor via **fast fil-ID** fra kurs 76 —
samme distribusjonsmodell som difftag/forgrening. Da oppdaterer man én fil sentralt, og
alle lærere får ny versjon ved neste sidelasting. Ingen nedlasting, ingen Reload.

## Beslutninger tatt

- **Kursomfang:** alle kurs, kun rolle-gatet (lærer) + gradebook/kursside. INGEN kursliste
  (Læringslupa er generisk nyttig i enhver gradebook — slipper semester-churn).
  Beta-test i kurs 601 først er et midlertidig teststeg, ikke en permanent grense.
- **Loader:** Læringslupa legges til som enda en modul i den ENE eksisterende loaderen
  (Canvas har bare én JS-slot per tema). difftag/forgrening beholder sine kurslister;
  Læringslupa får regelen «last for alle lærere».
- **UI-krav:** lærer skal få et menyikon (som difftags ◈, f.eks. 🔍 Læringslupa) i
  `#section-tabs` som åpner et in-page-panel med visnings- og innstillingsvalg — dagens
  `popup.html` flyttes inn som modal.

## Coupling som må portes (kjernelogikken er uendret)

Målt bruk av Chrome-utvidelses-API i dag:

| I dag | Blir til |
|---|---|
| `manifest.json` content_scripts (3 match-mønstre) | Kjøretids path-sjekk i fila (erGradebook / erAnnenKursside) |
| `sensor.js` (world: MAIN, document_start) | Foldes inn øverst — tema-JS er MAIN world; `window.fetch`-wrap inline |
| `background.js` + `chrome.alarms` + `chrome.tabs.sendMessage` | `setInterval` (~5 min) mens gradebook-fane er åpen; hver fane oppdaterer seg selv |
| `chrome.storage.sync` (innstillinger, 6 felt) | `localStorage['cak_cfg']` (JSON). Mister cross-device sync — greit |
| `chrome.storage.local` (cak_data_, cak_mod_, cak_sections_, selectedSection, cak_last_updated) | `localStorage` via liten `store.get/set/remove`-shim med JSON.stringify/parse |
| `chrome.storage.onChanged` | `window`-event `'storage'` (fyrer på tvers av faner, samme origin) |
| `chrome.runtime.getURL('icons/icon48.png')` + `images/` | Inline `data:`-URI (base64) |
| `chrome.runtime.onMessage` (GET_COLOR_STATS, FILTER_BY_COLOR, FILTER_BY_LESSON_COUNT, CLEAR_COLOR_FILTER, SOFT_REFRESH) | Bortfaller — panelet er i samme kontekst, kaller funksjonene direkte. Handlerne finnes i content.js ~2430 |
| `navigator.clipboard` | Uendret (fungerer i side ved brukerklikk) |

## Menyikon + panel (popup → in-page)

- Injiser menypunkt i `#section-tabs`, rollegatet, med MutationObserver for SPA-navigasjon
  (samme mønster som difftag). Klikk åpner modal.
- Panelet overtar hele dagens popup.html: Visning (vis/skjul kolonne, radmarkering,
  funding-badge), Terskler (login grønn/gul, innlevering grønn/gul, leksjonsterskel),
  segmentknapper (gradingMode, copyLinkMode), seksjonsvelger, Oppdater-knapp, cache-status,
  fargefilter (grønn/gul/rød + leksjonstelling).
- Gamle `sendMessage`-kall (popup.js) → direkte funksjonskall.

## Kritiske vakter / risiko

1. **Rollesjekk er nå sikkerhetsgrensen.** Temaet lastes for ALLE, elever inkludert.
   `erAutorisert` må gate at scriptet i det hele tatt kjører for elever. Canvas nekter
   uansett elever andres data server-side (403), men scriptet skal ikke forsøke.
2. **Sensor-timing** er den ene reelle tekniske risikoen. `window.fetch`-wrappen må ligge
   før Canvas rekker sine første kall. Loaderen injiserer litt senere enn utvidelsens
   `document_start`. Sensoren fanger hovedsakelig lærerhandlinger (retting) ETTER last, og
   førstegangsdata henter scriptet selv — trolig uproblematisk, men VERIFISER i beta.
   (difftag dokumenterer allerede at fetch-wrap ikke fanger Canvas' interne fetch pålitelig
   — samme begrensning som i dag, ingen regresjon.)
3. **Sidevekt** i hvert kurs (nå: alle) ved lasting.
4. **GDPR:** elevaktivitet cachet i localStorage (samme fotavtrykk som i dag) — vær bevisst.

## Faseinndeling

- **Fase 0** — `store`-shim + `cfg` over localStorage + `'storage'`-event. Gjør resten mekanisk.
- **Fase 1** — fold inn sensor.js; fjern background.js; alarm → setInterval.
- **Fase 2** — injisert menyikon + panel; popup-meldinger → direkte kall.
- **Fase 3** — rolle- og path-gate; inline assets (icons/images som data-URI).
- **Fase 4** — loader-kobling: last opp `laeringslupa.js` til kurs 76 (Erstatt fil → behold
  ID → synlighet «Institusjonsmedlemmer»), beta-test i 601, deretter live.

## Testing

Ikke lenger en utvidelse → testes via beta-temaets loader: pek loaderen i BETA på den nye
fil-ID-en, verifiser i kurs 601, oppdater live-loaderen først når godkjent.

## Rydding når porten er ferdig

- Fjern manifest.json, background.js, sensor.js, popup.html/js, gen_icons.py fra
  distribusjonen (behold gjerne i git-historikk).
- Slett port-delen av denne PLAN.md og pekeren i CLAUDE.md når porten er landet
  (unngå foreldet doc). NB: «Fremtidsinnspill» nedenfor er en EGEN, uavhengig sak —
  ikke slett den sammen med porten.

---

# Fremtidsinnspill — tag-tilhørighet i Læringslupa (sept 2026)

Status: **idé, avklart og mocket — ikke bygget.** Uavhengig av porten over. Koblet til
difftag-prosjektet (gs-difftag), som eier differensieringstaggene.

## Idé

Vise elevens/innleveringenes differensieringstag i Læringslupa ved å ta i bruk en visuell
kanal som i dag er ledig: **formen** på batteri-prikkene. I dag er alle prikker sirkler.

**Bærende prinsipp — to uavhengige kanaler:**
- **Form = tag** til den enkelte innleveringen: sirkel = uten tag, diamant = spor A (◆),
  firkant = spor B (■). Skolen bruker ◆/■ som spor-ikoner.
- **Farge + kant + fyll + posisjon = status** (helt uendret): grønn vurdert, oransje
  venter, lilla fritatt (over grunnlinjen); mørk mangler, grå fremtidig (under).

**Viktig avklaring:** formen følger innleveringens/innholdets tag, IKKE elevens ene spor.
Én elev kan derfor ha en MIKS av sirkel/diamant/firkant i samme batteri (f.eks. en vurdert
sirkel + en vurdert diamant i samme leksjon). Det er dette som gjør per-prikk-form
meningsfullt i enkeltelevens hover (ikke redundant slik en «ett spor per elev»-modell
ville vært).

## Hvorfor det er teknisk rent og billig

Prikkene i `makeBatterySvg` (content.js ~1643) er `<circle>` med `fill` + `stroke` +
`stroke-width`. Status ligger i disse attributtene + over/under-posisjon. Fordi `<rect>`
(firkant) og `<polygon>` (diamant) tar NØYAKTIG de samme attributtene, abstraheres prikken
til én hjelpefunksjon:

    tegnPrikk(cx, cy, r, { fill, stroke, strokeWidth, form })   // 'sirkel' | 'diamant' | 'firkant'

Status-logikken røres ikke — den sender samme verdier inn, bare til formen tag-en bestemmer.
De ~5 stedene som skriver `<circle>` rutes gjennom hjelperen.

## Verifisert faktum om dagens prikker (fill finnes)

Fra koden — status er fill + kant + kantbredde, ikke bare linje:

| Status | fill | stroke | bredde | posisjon |
|---|---|---|---|---|
| Vurdert | white | #3b6d11 grønn | 0.8 | over |
| Venter | white | #e65100 oransje | 1.8 | over |
| Fritatt | white | #7B3FA5 lilla | 1.8 | over |
| Mangler | white | #3a3a3a mørk | 0.8 | under |
| Fremtidig | #dedad4 grå | #888780 grå | 1.0 | under |

Radius konstant r=3.

## Forbehold å teste FØR bygging

1. **Lik visuell vekt ved r=3.** Firkant med halvside r ser større ut enn sirkel radius r;
   diamant mindre. Skaler til lik opplevd flate (firkant ≈ 0,88·2r, diamant-diagonal ≈
   1,15·2r). Marginene er små ved r=3 — verifiser på ekte størrelse.
2. **Form-kollisjon i Læringslupas eget vokabular.** Cellen bruker allerede ring (sirkel)
   for innlogging og FIRKANT for siste innlevering. Når ■-sporet også er firkant, kan en
   firkant leses som «innleveringsstatus». Lav risiko i batteriet (åpenbart leksjons-prikker),
   men reell hvis form-per-tag noen gang tas videre til CELLEN. Diamant/sirkel skiller best;
   firkant/diamant er paret å teste tett stablet.
3. **Emoji-fallback.** Virker bare for geometriske tagger (◆/■). Difftag tillater vilkårlig
   emoji (🏃) — de kan ikke tegnes som fylt/kantet SVG-prikk. Fall tilbake til sirkel for
   ikke-geometriske tagger.
4. **Datakobling.** Læringslupa må hente non-collaborative groups + innholdets tag-overrides
   (samme datamodell som difftag). Ett ekstra, cachbart API-kall. Kobler Læringslupa til
   difftags modell — samme forfatter/skole, akseptabelt, men en bevisst avhengighet.

## Beslektet, større gevinst (ikke bygget)

Tag-pille i hover-OVERSKRIFTEN (kompakt) og form-per-tag i selve KOLONNECELLEN (der rader =
ulike elever) gir klasseskann av spor + fremdrift samtidig. Hover er lærer-only, så ingen
elevsynlighet å veie. Se difftags synlighetsbeslutning separat.

Tre mockuper laget i chat (sept 2026): (a) form × status-rutenett, (b) batteri med status
over/under grunnlinjen, (c) batteri med blandede former per tag. Ikke lagret som filer.

## Oppløsning etter difftag-brief (2.10.2026)

Difftag fikk «fradeling + frys ved tag-bytte» (beta; kun pilot-kurs 571 i live → INGEN HAST).
Det endrer hva Læringslupa må lese. To ting falt på plass:

**A. Speil elevens faktiske visning (ikke tag).** Innhold tildeles nå med NAVN (navneliste i
tildelingsfeltet), ikke bare via tag. Læringslupa skal derfor speile det eleven FAKTISK er
tildelt, ikke utlede fra tag. Da forsvinner fantom-mangler/oppblåst «etterskudd» av seg selv.

Audit av dagens kode (2.10) — tre reelle bruddpunkt når frys går live i et kurs Læringslupa
brukes i (Læringslupa har i dag NULL override-/visibility-bevissthet):
- Nevnerne teller rått alle modul-oppgaver, ikke per-elev-tildelte: `pastDueDenom`
  (content.js:724), `deliveredPerMod` (829), `futureCount` (1759). → oppblåst «leksjoner
  etter» + fantom fremtids-/mangel-prikker for fradelte og «tildelt ingen»-elementer.
  (Prikkene OVER linja er delvis vernet, fordi de lener seg på Canvas' per-tildelte
  `missing`-flagg — men nevnerne gjør ikke det.)
- `workflow_state === 'deleted'` håndteres ikke → skjult arbeid (fradeling/ut-inn) kan bli
  lest som manglende. Må ekskluderes eksplisitt.
- «Tildelt ingen» (`only_visible_to_overrides` + 0 overrides) må telle som ikke-eksisterende.
Fiksretning: filtrer til elevens faktisk tildelte elementer (`include[]=assignment_visibility`
— men mellomlagret/laggy — eller per-elev override-sjekk). Punkt 4 (modulstatus bakover) er
lav risiko: Læringslupa bruker completion-TALL, ikke `state`-strengen. Punkt 5 (tittel-ikoner)
trygt: `parseLessonNum` tar første talløp hvor som helst; spor-ikoner er sifferfrie.

**B. Datakilde for form-per-tag er LØST.** Difftag stempler nå spor-ikonet i selve tittelen,
persistent. Spor-ikonene er geometriske, så mappingen er naturlig:
- 🔷 (blått diamant-emoji) = spor A → diamant-prikk
- 🟦 (blått firkant-emoji) = spor B → firkant-prikk
- ingen spor-ikon (felles innhold) → sirkel
Les formen fra elementets tittel (FØRSTE ikon = spor; andre = område 👀📝📚💬 — form skal
nøkle på SPOR, ikke område). Fallback hvis tittel mangler ikon: override-tittel
`DTA-frys g<id> <tagnavn>`, gruppe-override på ufryste element, eller `frys`/`aktivert` i
difftags tag-register.

**Konvergens:** form-per-tag krever at Læringslupa leser PER ELEMENT, per elev (hvilket
element, hvilket spor) — nøyaktig samme per-elev-tildelings-bevissthet som A trenger. Én
refaktor gir begge. Strukturendring: dagens telling er per MODUL (`deliveredPerMod` = antall)
→ må bli per ELEMENT (hvilket, med spor). Og en elev kan ha ulikt spor per OMRÅDE i samme
leksjon → ekte miks av diamant/firkant i én kolonne (ikke redundant).

**Åpent før bygging:** mer enn to spor. I dag 🔷/🟦. Tredje spor-ikon → trengs form-mapping
eller fallback (f.eks. sirkel + farge). Lås før koding.
