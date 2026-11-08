import { getTranslations, type Language } from "../locales";
const language: Language =
    req.body.preferred_language === "ta" ||
        req.body.preferred_language === "si"
        ? req.body.preferred_language
        : "en";

const t = getTranslations(language);