
import en from "./en";
import ta from "./ta";
import si from "./si";

export type Language = "en" | "ta" | "si";

const translations = { en, ta, si };

export function getTranslations(language: Language) {
    return translations[language];
}
