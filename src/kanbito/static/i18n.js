/**
 * Internationalization (i18n) for Kanbito using i18next
 */

// Available languages
const LANGUAGES = {
  en: '🇺🇸 English',
  zh: '🇨🇳 中文',
  hi: '🇮🇳 हिन्दी',
  es: '🇦🇷 Español',
  ar: '🇪🇬 العربية',
  it: '🇮🇹 Italiano',
  fr: '🇫🇷 Français',
  de: '🇩🇪 Deutsch',
  pt: '🇧🇷 Português',
  ja: '🇯🇵 日本語',
  ko: '🇰🇷 한국어',
  ru: '🇷🇺 Русский',
  id: '🇮🇩 Bahasa Indonesia',
  tr: '🇹🇷 Türkçe',
  vi: '🇻🇳 Tiếng Việt',
  pl: '🇵🇱 Polski',
  bn: '🇧🇩 বাংলা',
  he: '🇮🇱 עברית',
  fa: '🇮🇷 فارسی',
  ur: '🇵🇰 اردو'
};

// RTL languages
const RTL_LANGUAGES = ['ar', 'he', 'fa', 'ur'];

// Update document direction based on language
function updateDocumentDirection(lang) {
  const isRTL = RTL_LANGUAGES.includes(lang);
  document.documentElement.dir = isRTL ? 'rtl' : 'ltr';
  document.documentElement.lang = lang;
}

// Current language - default to English for first-time users
let currentLang = 'en';
let i18nReady = false;
let i18nReadyCallbacks = [];

// Initialize i18next
async function initI18n() {
  // Check saved language preference first
  let savedLang = 'en';
  try {
    const res = await fetch('/api/settings');
    const settings = await res.json();
    if (settings.language && LANGUAGES[settings.language]) {
      savedLang = settings.language;
    }
  } catch (e) {
    // Default to English if can't load settings
  }

  currentLang = savedLang;
  updateDocumentDirection(savedLang);

  // Load the required language translations (with cache-busting)
  let translations = {};
  try {
    const res = await fetch(`/static/locales/${savedLang}.json?v=${Date.now()}`);
    translations = await res.json();
  } catch (e) {
    console.error(`Failed to load ${savedLang} translations:`, e);
  }

  // Initialize i18next with the saved language (or English for first-time)
  await i18next.init({
    lng: savedLang,
    fallbackLng: 'en',
    resources: {
      [savedLang]: { translation: translations }
    },
    interpolation: {
      escapeValue: false
    }
  });

  i18nReady = true;

  // Translate static elements
  translateStaticElements();

  // Call any waiting callbacks
  for (const cb of i18nReadyCallbacks) {
    cb();
  }
  i18nReadyCallbacks = [];
}

// Translate static HTML elements with data-i18n attributes
function translateStaticElements() {
  // Translate text content
  document.querySelectorAll('[data-i18n]').forEach(el => {
    const key = el.dataset.i18n;
    const translated = t(key);
    if (translated && translated !== key) {
      el.textContent = translated;
    }
  });

  // Translate placeholders
  document.querySelectorAll('[data-i18n-placeholder]').forEach(el => {
    const key = el.dataset.i18nPlaceholder;
    const translated = t(key);
    if (translated && translated !== key) {
      el.placeholder = translated;
    }
  });

  // Translate title attributes
  document.querySelectorAll('[data-i18n-title]').forEach(el => {
    const key = el.dataset.i18nTitle;
    const translated = t(key);
    if (translated && translated !== key) {
      el.title = translated;
    }
  });
}

// Wait for i18n to be ready
function onI18nReady(callback) {
  if (i18nReady) {
    callback();
  } else {
    i18nReadyCallbacks.push(callback);
  }
}

// Translation function (shorthand)
function t(key, options) {
  if (!i18nReady) {
    // Return key as fallback if not ready
    return key.split('.').pop();
  }
  return i18next.t(key, options);
}

// Change language
async function changeLanguage(lang) {
  if (!LANGUAGES[lang]) return;

  // Load translation if not already loaded
  if (!i18next.hasResourceBundle(lang, 'translation')) {
    try {
      const res = await fetch(`/static/locales/${lang}.json?v=${Date.now()}`);
      const translations = await res.json();
      i18next.addResourceBundle(lang, 'translation', translations);
    } catch (e) {
      console.error(`Failed to load ${lang} translations:`, e);
      return;
    }
  }

  currentLang = lang;
  updateDocumentDirection(lang);
  await i18next.changeLanguage(lang);

  // Re-translate static elements
  translateStaticElements();

  // Save to settings
  try {
    await fetch('/api/settings', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ language: lang })
    });
  } catch (e) {
    console.error('Failed to save language setting:', e);
  }
}

// Get current language
function getCurrentLanguage() {
  return currentLang;
}

// Get available languages
function getAvailableLanguages() {
  return LANGUAGES;
}

// Check if language has been set (for first-run detection)
async function isLanguageSet() {
  try {
    const res = await fetch('/api/settings');
    const settings = await res.json();
    return !!settings.language;
  } catch (e) {
    return false;
  }
}

// Show language selection dialog
async function showLanguageSelector() {
  return new Promise((resolve) => {
    const backdrop = document.createElement('div');
    backdrop.className = 'modal-backdrop open';
    backdrop.id = 'langSelectorBackdrop';

    const modal = document.createElement('div');
    modal.className = 'modal lang-selector-modal';
    modal.innerHTML = `
      <h2>Select Language / Seleccionar Idioma</h2>
      <div class="lang-options">
        ${Object.entries(LANGUAGES).map(([code, name]) => `
          <button class="lang-option" data-lang="${code}">
            ${name}
          </button>
        `).join('')}
      </div>
    `;

    backdrop.appendChild(modal);
    document.body.appendChild(backdrop);

    modal.querySelectorAll('.lang-option').forEach(btn => {
      btn.addEventListener('click', async () => {
        const lang = btn.dataset.lang;
        await changeLanguage(lang);
        backdrop.remove();
        resolve(lang);
      });
    });
  });
}
