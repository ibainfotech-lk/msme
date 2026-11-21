
import type { Request } from "express";
import { getTranslations, type Language } from "../locales";

export function getRequestLanguage(req: Request): Language {
    const preferredLanguage = req.body?.preferred_language;

    if (
        preferredLanguage === "ta" ||
        preferredLanguage === "si"
    ) {
        return preferredLanguage;
    }

    return "en";
}

export function getRequestTranslations(req: Request) {
    return getTranslations(getRequestLanguage(req));
}
