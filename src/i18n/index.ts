/**
 * Chronicle i18n configuration
 *
 * All user-facing strings live in locale JSON files.
 * No string is ever hardcoded in a component.
 *
 * Language is auto-detected from the browser/OS.
 * Users can override in Settings.
 */

import i18n from 'i18next'
import { initReactI18next } from 'react-i18next'
import LanguageDetector from 'i18next-browser-languagedetector'

import en from './locales/en.json'
import fr from './locales/fr.json'

export const defaultNS = 'translation'

i18n
  .use(LanguageDetector)
  .use(initReactI18next)
  .init({
    resources: {
      en: { translation: en },
      fr: { translation: fr },
    },
    fallbackLng: 'en',
    defaultNS,
    interpolation: {
      escapeValue: false, // React handles XSS
    },
    detection: {
      order: ['localStorage', 'navigator'],
      caches: ['localStorage'],
    },
  })

export default i18n
