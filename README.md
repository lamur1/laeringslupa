# Læringslupa

Chrome-utvidelse for Canvas LMS. Legger til en svevende aktivitetskolonne i karakterboken som gir læreren et øyeblikksbilde av hver elevs innlogging, innleveringsstatus og fremdrift — uten å forlate oversikten.

Utviklet for [Globalskolen](https://www.globalskolen.no) — norsk nettskole for barn i utlandet.

---

## Installasjon

1. Last ned og pakk ut mappen
2. Åpne Chrome → `chrome://extensions`
3. Slå på **Utviklermodus** (øverst til høyre)
4. Klikk **Last inn upakket** og velg mappen
5. Åpne karakterboken i et Canvas-kurs — kolonnen vises automatisk

---

## Slik leser du kolonnen

Kolonnen svever på høyre kant av navnekolonnen. Hver celle inneholder:

| Symbol | Betyr |
|--------|-------|
| **Ring** | Innlogging — fylling viser hvor nylig (full = ≤3 dager, tom = lenge siden) |
| **Firkant** | Siste innlevering — grønn = nylig, grå = en stund siden, rød = lenge/aldri |
| **Tidslinje** | Grønn bar høyre = i forkant, rød bar venstre = på etterskudd |
| **Grønn stripe (bunn)** | Snitt visningsprosent for lærestoff eleven har åpnet |

Hold musen over en celle for fullstendig detalj og batteridiagram.

---

## Batteridiagrammet

Diagrammet i hover-vinduet viser én søyle per leksjon:

- **Grønn søyle** → andel av Canvas-sider med visningskrav eleven har fullført
- **Grå skravering** → fristen passert, ikke lest
- **Stiplet kontur** → fremtidig leksjon
- **Prikker over streken** → innleveringer levert (oransje = venter vurdering, grønn = vurdert, grå = fritatt)
- **Sirkler under streken** → innleveringer som mangler

**Snitt visning** beregnes som `sum(fullførte sider) / sum(totale sider)` kun for leksjoner eleven har åpnet.

---

## Innstillinger

Klikk utvidelsesikonet for å åpne innstillingspanelet.

| Innstilling | Standard |
|-------------|----------|
| Grense grønn ring (innlogging) | ≤ 3 dager |
| Grense gul ring (innlogging) | ≤ 7 dager |
| Grense grønn firkant (innlevering) | ≤ 7 dager |
| Grense grå firkant (innlevering) | ≤ 14 dager |
| Leksjon godkjent ved | ≥ 50 % karaktersatt |
| Fargemerking av rader | Av |
| Kopieringslenker (purremelding) | Alle oppgavetyper |

---

## Teknisk

- Manifest V3
- Aktiveres kun på `*.instructure.com/courses/*/gradebook*`
- Data caches lokalt i `chrome.storage.local`:
  - Innleveringer og aktivitet: 15 min (`cak_data_`)
  - Leksjonsvisningsdata: 1 time (`cak_mod_`)
- Sanntidssensor (`sensor.js`) wrapper `window.fetch` og oppdager når lærer setter karakter — kolonnen oppdateres umiddelbart uten sideopplasting

---

## Personvern

Elevdata forlater aldri Canvas sine egne servere. Ingen data sendes til tredjepart. Kun brukerinnstillinger synkroniseres mellom maskiner via `chrome.storage.sync`.

---

MIT-lisens
