
import type {
    Request,
    Response,
    NextFunction,
} from "express";

import { getTranslations, type Language } from "../locales";

function getRequestLanguage(req: Request): Language {
    // Read the selected language from the request header.
    const header = req.headers["accept-language"]?.toLowerCase();

    if (header?.includes("ta")) return "ta";
    if (header?.includes("si")) return "si";

    return "en";
}

export function notFoundHandler(
    req: Request,
    res: Response
) {
    const t = getTranslations(getRequestLanguage(req));

    return res.status(404).json({
        success: false,
        code: "NOT_FOUND",
        message: t.notFound,
    });
}

export function errorHandler(
    error: Error,
    req: Request,
    res: Response,
    next: NextFunction
) {
    console.error(error);

    if (res.headersSent) {
        return next(error);
    }

    const t = getTranslations(getRequestLanguage(req));

    return res.status(500).json({
        success: false,
        code: "SERVER_ERROR",
        message: t.serverError,
    });
}
