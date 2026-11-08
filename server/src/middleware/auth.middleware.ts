
import type { Request, Response, NextFunction } from "express";
import { getTranslations, type Language } from "../locales";

export function requireAuth(
    req: Request,
    res: Response,
    next: NextFunction
) {
    const userId = req.session?.userId;

    // Validate the language provided with the request.
    const requestedLanguage = req.body?.preferred_language;

    const language: Language =
        requestedLanguage === "ta" || requestedLanguage === "si"
            ? requestedLanguage
            : "en";

    const t = getTranslations(language);

    if (
        userId === undefined ||
        userId === null ||
        !/^\d+$/.test(String(userId)) ||
        !Number.isSafeInteger(Number(userId)) ||
        Number(userId) <= 0
    ) {
        return res.status(401).json({
            success: false,
            code: "UNAUTHORIZED",
            message: t.unauthorized,
        });
    }

    next();
}
