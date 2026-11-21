
import "express-session";

declare module "express-session" {
    interface SessionData {
        userId?: string;
        verifiedPhone?: string;
        verifiedPhoneAt?: number;
    }
}