'use strict';

// ─── Læringslupa service worker ───────────────────────────────────────────────
//
// Køyrer ein alarm kvart 15. minutt og sender SOFT_REFRESH til alle opne
// gradebook-faner. Content script handterer hentinga — berre innleveringsdata
// (cak_data_) blir oppdatert; leksjonsdata (cak_mod_) ligg urørt i cache.

const ALARM_NAME    = 'lupa_refresh';
const ALARM_MINUTES = 15;

chrome.runtime.onInstalled.addListener(() => {
  chrome.alarms.create(ALARM_NAME, { periodInMinutes: ALARM_MINUTES });
});

chrome.runtime.onStartup.addListener(() => {
  // Sørg for at alarmen alltid køyrer, òg etter nettlesar-restart
  chrome.alarms.get(ALARM_NAME, (existing) => {
    if (!existing) {
      chrome.alarms.create(ALARM_NAME, { periodInMinutes: ALARM_MINUTES });
    }
  });
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
