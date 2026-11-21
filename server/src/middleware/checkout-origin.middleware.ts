import type { RequestHandler } from "express";

function getAllowedOrigin(): string {
    const configuredOrigin =
        process.env.CLIENT_URL || "http://localhost:5173";

    const url = new URL(configuredOrigin);

    if (
        !["http:", "https:"].includes(url.protocol) ||
        url.username ||
        url.password ||
        url.pathname !== "/" ||
        url.search ||
        url.hash
    ) {
        throw new Error(
            "CLIENT_URL must be a valid frontend origin."
        );
    }

    if (
        process.env.NODE_ENV === "production" &&
        url.protocol !== "https:"
    ) {
        throw new Error(
            "Production CLIENT_URL must use HTTPS."
        );
    }

    return url.origin;
}

export const requireCheckoutOrigin: RequestHandler =
    (req, res, next) => {
        let allowedOrigin: string;

        try {
            allowedOrigin = getAllowedOrigin();
        } catch (error) {
            next(error);
            return;
        }

        const origin = req.get("Origin");

        // Browser checkout requests must include Origin.
        // Do not accept Origin: null or missing Origin.
        if (!origin || origin !== allowedOrigin) {
            res.status(403).json({
                success: false,
                code: "CHECKOUT_ORIGIN_DENIED",
                message: "Checkout request origin is not permitted."
            });
            return;
        }

        const referer = req.get("Referer");

        if (referer) {
            try {
                if (new URL(referer).origin !== allowedOrigin) {
                    res.status(403).json({
                        success: false,
                        code: "CHECKOUT_REFERER_DENIED",
                        message:
                            "Checkout request referrer is not permitted."
                    });
                    return;
                }
            } catch {
                res.status(403).json({
                    success: false,
                    code: "CHECKOUT_REFERER_INVALID",
                    message: "Invalid checkout request referrer."
                });
                return;
            }
        }

        next();
    };