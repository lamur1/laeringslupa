'use strict';

// ─── Læringslupa service worker ───────────────────────────────────────────────
//
// Køyrer ein alarm kvart 5. minutt og sender SOFT_REFRESH til alle opne
// gradebook-faner. Content script handterer hentinga — berre innleveringsdata
// (cak_data_) blir oppdatert; leksjonsdata (cak_mod_) ligg urørt i cache.

const ALARM_NAME    = 'lupa_refresh';
const ALARM_MINUTES = 5;

chrome.runtime.onInstalled.addListener((details) => {
  chrome.alarms.create(ALARM_NAME, { periodInMinutes: ALARM_MINUTES });

  // Engangs-vask: fjern alt tidlegare lagra i chrome.storage.local — inkludert
  // elevdata-cachar (cak_data_/cak_mod_) frå tidlegare versjonar. Frå og med denne
  // versjonen lever elevdata berre i minnet; local inneheld berre ufarleg
  // cache-metadata (seksjonsnamn, tidsstempel), som fyllast på nytt automatisk.
  // Innstillingar ligg i chrome.storage.sync og vert IKKJE rørt. Køyrer ved
  // installasjon og ved kvar oppdatering/reload av utvidinga.
  if (details.reason === 'install' || details.reason === 'update') {
    chrome.storage.local.clear();
  }
});

chrome.runtime.onStartup.addListener(() => {
  // Sørg for at alarmen alltid køyrer, òg etter nettlesar-restart
  chrome.alarms.get(ALARM_NAME, (existing) => {
    if (!existing) {
      chrome.alarms.create(ALARM_NAME, { periodInMinutes: ALARM_MINUTES });
    }
  });
});

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg.type === 'GET_ALARM_TIME') {
    chrome.alarms.get(ALARM_NAME, alarm => {
      sendResponse({ scheduledTime: alarm ? alarm.scheduledTime : null });
    });
    return true; // async svar
  }
});

chrome.alarms.onAlarm.addListener(async (alarm) => {
  if (alarm.name !== ALARM_NAME) return;

  let tabs;
  try {
    tabs = await chrome.tabs.query({ url: '*://*.instructure.com/courses/*/gradebook*' });
  } catch (e) {
    return;
  }

  for (const tab of tabs) {
    try {
      chrome.tabs.sendMessage(tab.id, { type: 'SOFT_REFRESH' });
    } catch (e) {
      // Fana kan vere lukka eller content script ikkje lasta — ignorer
    }
  }
});
