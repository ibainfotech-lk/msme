
import type { Request, Response, NextFunction } from "express";
import { getTranslations, type Language } from "../locales";

const UUID_PATTERN =
    /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function requireAuth(
    req: Request,
    res: Response,
    next: NextFunction
) {
    const userId = req.session?.userId;

    const requestedLanguage = req.body?.preferred_language;

    const language: Language =
        requestedLanguage === "ta" || requestedLanguage === "si"
            ? requestedLanguage
            : "en";

    const t = getTranslations(language);

    if (
        typeof userId !== "string" ||
        !UUID_PATTERN.test(userId)
    ) {
        return res.status(401).json({
            success: false,
            code: "UNAUTHORIZED",
            message: t.unauthorized,
        });
    }

    next();
}
