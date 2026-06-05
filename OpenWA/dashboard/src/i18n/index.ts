import i18n from 'i18next';
import { initReactI18next } from 'react-i18next';
import LanguageDetector from 'i18next-browser-languagedetector';
import en from './locales/en.json';
import fr from './locales/fr.json';
import ar from './locales/ar.json';

// Order matters here — this is the order the language picker shows in
// its dropdown (EN → FR → AR). EN is the default for new operators;
// FR + AR cover the bulk of codhelix's francophone-Africa + Maghreb
// target audience. (Hebrew was removed per operator request — the
// he.json file is kept on disk for reference but no longer wired in.)
export const supportedLanguages = ['en', 'fr', 'ar'] as const;
export type SupportedLanguage = (typeof supportedLanguages)[number];

// Arabic flows right-to-left. We set document.dir='rtl' so CSS that
// uses logical properties (margin-inline-start, padding-inline-end,
// etc.) automatically mirrors. Components that still use left/right
// physical properties need a manual sweep — kept as a follow-up.
export const rtlLanguages: SupportedLanguage[] = ['ar'];

void i18n
  .use(LanguageDetector)
  .use(initReactI18next)
  .init({
    resources: {
      en: { translation: en },
      fr: { translation: fr },
      ar: { translation: ar },
    },
    fallbackLng: 'en',
    supportedLngs: supportedLanguages as unknown as string[],
    nonExplicitSupportedLngs: true,
    interpolation: { escapeValue: false },
    detection: {
      order: ['localStorage', 'navigator'],
      lookupLocalStorage: 'openwa_language',
      caches: ['localStorage'],
    },
    react: { useSuspense: false },
  });

function applyDirection(lang: string) {
  const base = (lang || 'en').split('-')[0] as SupportedLanguage;
  const dir = rtlLanguages.includes(base) ? 'rtl' : 'ltr';
  if (typeof document !== 'undefined') {
    document.documentElement.lang = base;
    document.documentElement.dir = dir;
  }
}

applyDirection(i18n.language);
i18n.on('languageChanged', applyDirection);

export default i18n;
