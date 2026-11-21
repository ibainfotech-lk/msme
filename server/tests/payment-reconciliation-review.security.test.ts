import "dotenv/config";

import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";

import express from "express";
import session from "express-session";

import pool from "../src/config/database";

import reviewRouter from
    "../src/modules/payments/payment-reconciliation-review.routes";

import { requireAuth } from
    "../src/middleware/auth.middleware";

import { requireBusinessAccess } from
    "../src/middleware/business-access.middleware";

import {
    getPaymentReconciliationReviewController
} from "../src/modules/payments/payment-reconciliation-review.controller";

type FailureMode =
    | "deny"
    | "membership-error"
    | "permission-error";

interface RouterLayer {
    route?: {
        path: string;
        methods: Record<string, boolean>;
        stack: Array<{ handle: unknown }>;
    };
}

test("Noteto reconciliation review security regression", async () => {
    const mode = process.env.NOTETO_REVIEW_TEST_MODE;

    assert.ok(
        ["disabled", "enabled", "production"].includes(
            String(mode)
        ),
        "STOP: Invalid test scenario."
    );

    const expectedEnvironment =
        mode === "production" ? "production" : "development";

    const expectedFlag =
        mode === "disabled" ? "false" : "true";

    assert.equal(process.env.NODE_ENV, expectedEnvironment);

    assert.equal(
        process.env.NOTETO_ENABLE_RECONCILIATION_REVIEW,
        expectedFlag
    );

    const enabled = mode === "enabled";

    const layers = (
        reviewRouter as unknown as { stack: RouterLayer[] }
    ).stack.filter(layer => Boolean(layer.route));

    assert.equal(layers.length, enabled ? 1 : 0);

    if (enabled) {
        const route = layers[0].route!;

        assert.equal(
            route.path,
            "/business/:businessId/payments/:paymentId/reconciliation-review"
        );

        assert.equal(route.methods.get, true);
        assert.equal(route.stack.length, 4);

        assert.strictEqual(route.stack[0].handle, requireAuth);

        assert.strictEqual(
            route.stack[1].handle,
            requireBusinessAccess
        );

        assert.equal(
            typeof route.stack[2].handle,
            "function"
        );

        assert.strictEqual(
            route.stack[3].handle,
            getPaymentReconciliationReviewController
        );
    }

    console.log("PASSED: Router feature flag and middleware order.");

    const database = pool as any;

    const originalExecute = database.execute;
    const originalQuery = database.query;

    const userId = randomUUID();
    const businessId = randomUUID();
    const otherBusinessId = randomUUID();
    const paymentId = randomUUID();
    const nonce = randomUUID();

    let failureMode: FailureMode = "deny";
    let membershipQueries = 0;
    let permissionQueries = 0;

    database.execute = async (
        sql: unknown,
        params: unknown
    ): Promise<any> => {
        assert.equal(typeof sql, "string");

        assert.match(
            sql as string,
            /^\s*SELECT\b/i,
            "STOP: Unexpected SQL operation."
        );

        assert.ok(Array.isArray(params));

        const statement = sql as string;
        const values = params as unknown[];

        if (/AS\s+role_name\b/i.test(statement)) {
            membershipQueries++;

            assert.equal(values[1], userId);

            if (failureMode === "membership-error") {
                throw new Error(
                    "TEST_ONLY_MEMBERSHIP_QUERY_FAILURE"
                );
            }

            if (values[0] !== businessId) {
                return [[], []];
            }

            return [[{
                business_id: businessId,
                role_name: "VIEWER",
                business_status: "ACTIVE"
            }], []];
        }

        if (/AS\s+permission_key\b/i.test(statement)) {
            permissionQueries++;

            assert.equal(values[0], userId);
            assert.equal(values[1], businessId);
            assert.equal(values[2], "billing.manage");

            if (failureMode === "permission-error") {
                throw new Error(
                    "TEST_ONLY_PERMISSION_QUERY_FAILURE"
                );
            }

            return [[], []];
        }

        throw new Error(
            "STOP: Unexpected database query."
        );
    };

    database.query = async () => {
        throw new Error(
            "STOP: Real database queries are prohibited."
        );
    };

    console.log("PASSED: Database query interception installed.");

    const store = new session.MemoryStore();

    const app = express();
    const server = createServer(app);

    let sessionId: string | undefined;

    try {
        app.use(
            session({
                name: "noteto.sid",
                secret: randomUUID() + randomUUID(),
                store,
                resave: false,
                saveUninitialized: false,
                cookie: {
                    httpOnly: true,
                    secure: false,
                    sameSite: "lax",
                    maxAge: 86400000
                }
            })
        );

        if (enabled) {
            app.post(
                "/__security_test/mint",
                (req, res, next) => {
                    if (req.get("x-test-nonce") !== nonce) {
                        res.status(403).json({
                            success: false,
                            code: "TEST_ACCESS_DENIED"
                        });
                        return;
                    }

                    req.session.userId = userId;
                    sessionId = req.sessionID;

                    req.session.save(error => {
                        if (error) {
                            next(error);
                            return;
                        }

                        res.json({ success: true });
                    });
                }
            );
        }

        app.use("/__security_test", reviewRouter);

        app.use((
            _error: unknown,
            _req: express.Request,
            res: express.Response,
            _next: express.NextFunction
        ) => {
            res.status(500).json({
                success: false,
                code: "TEST_INTERNAL_ERROR"
            });
        });

        await new Promise<void>((resolve, reject) => {
            server.once("error", reject);

            server.listen(0, "127.0.0.1", () => {
                resolve();
            });
        });

        const address = server.address() as AddressInfo;

        assert.ok(address.port > 0);

        const base = `http://127.0.0.1:${address.port}`;

        const reviewPath =
            `/__security_test/business/${businessId}` +
            `/payments/${paymentId}/reconciliation-review`;

        async function request(
            path: string,
            method = "GET",
            cookie?: string,
            includeNonce = false
        ) {
            const headers: Record<string, string> = {
                Connection: "close"
            };

            if (cookie) headers.Cookie = cookie;

            if (includeNonce) {
                headers["x-test-nonce"] = nonce;
            }

            const response = await fetch(base + path, {
                method,
                headers,
                redirect: "manual",
                signal: AbortSignal.timeout(10000)
            });

            const text = await response.text();

            let body: any = null;

            try {
                body = JSON.parse(text);
            } catch {
                // Express default 404 page is HTML.
            }

            return {
                status: response.status,
                body,
                cookie: response.headers.get("set-cookie")
            };
        }

        async function expect(
            label: string,
            path: string,
            cookie: string | undefined,
            expectedStatus: number,
            expectedCode?: string,
            expectedMembership?: number,
            expectedPermission?: number
        ) {
            membershipQueries = 0;
            permissionQueries = 0;

            const result = await request(path, "GET", cookie);

            assert.equal(result.status, expectedStatus, label);

            if (expectedCode) {
                assert.equal(result.body?.success, false, label);
                assert.equal(result.body?.code, expectedCode, label);
            }

            if (expectedMembership !== undefined) {
                assert.equal(
                    membershipQueries,
                    expectedMembership,
                    label
                );
            }

            if (expectedPermission !== undefined) {
                assert.equal(
                    permissionQueries,
                    expectedPermission,
                    label
                );
            }

            console.log(`PASSED: ${label}.`);
        }

        if (!enabled) {
            await expect(
                "Disabled router returns HTTP 404",
                reviewPath,
                undefined,
                404,
                undefined,
                0,
                0
            );

            await expect(
                "Disabled router ignores identity spoofing",
                reviewPath + `?userId=${userId}`,
                undefined,
                404,
                undefined,
                0,
                0
            );

            await expect(
                "Disabled router ignores forged cookies",
                reviewPath,
                `noteto.sid=${userId}`,
                404,
                undefined,
                0,
                0
            );
        } else {
            await expect(
                "Missing session denied",
                reviewPath,
                undefined,
                401,
                "UNAUTHORIZED",
                0,
                0
            );

            await expect(
                "Query-string identity spoofing denied",
                reviewPath + `?userId=${userId}`,
                undefined,
                401,
                "UNAUTHORIZED",
                0,
                0
            );

            await expect(
                "Unsigned identity cookie denied",
                reviewPath,
                `noteto.sid=${userId}`,
                401,
                "UNAUTHORIZED",
                0,
                0
            );

            const unauthorizedMint = await request(
                "/__security_test/mint",
                "POST"
            );

            assert.equal(unauthorizedMint.status, 403);

            console.log("PASSED: Session mint restricted to test.");

            const mint = await request(
                "/__security_test/mint",
                "POST",
                undefined,
                true
            );

            assert.equal(mint.status, 200);
            assert.equal(mint.body?.success, true);
            assert.ok(mint.cookie);
            assert.ok(sessionId);

            assert.match(mint.cookie, /HttpOnly/i);
            assert.match(mint.cookie, /SameSite=Lax/i);

            const signedCookie = mint.cookie.split(";")[0];

            assert.ok(signedCookie.startsWith("noteto.sid="));

            console.log("PASSED: Signed test session created.");

            await expect(
                "Tampered signed cookie denied",
                reviewPath,
                signedCookie + "tampered",
                401,
                "UNAUTHORIZED",
                0,
                0
            );

            failureMode = "deny";

            await expect(
                "Cross-business access denied",
                `/__security_test/business/${otherBusinessId}` +
                `/payments/${paymentId}/reconciliation-review`,
                signedCookie,
                403,
                "BUSINESS_ACCESS_DENIED",
                1,
                0
            );

            await expect(
                "Missing billing.manage denied",
                reviewPath,
                signedCookie,
                403,
                "PERMISSION_DENIED",
                1,
                1
            );

            failureMode = "membership-error";

            await expect(
                "Membership database failure denies access",
                reviewPath,
                signedCookie,
                500,
                "AUTHORIZATION_ERROR",
                1,
                0
            );

            failureMode = "permission-error";

            await expect(
                "Permission database failure denies access",
                reviewPath,
                signedCookie,
                500,
                "PERMISSION_CHECK_ERROR",
                1,
                1
            );
        }

        console.log(
            "PASSED: All security checks for mode " + mode + "."
        );

        console.log(
            "INFO: No real database queries or financial writes."
        );
    } finally {
        try {
            if (server.listening) {
                server.closeIdleConnections();

                await new Promise<void>((resolve, reject) => {
                    server.close(error => {
                        if (error) reject(error);
                        else resolve();
                    });
                });

                console.log("PASSED: Isolated HTTP server closed.");
            }

            if (sessionId) {
                await new Promise<void>((resolve, reject) => {
                    store.destroy(sessionId!, error => {
                        if (error) reject(error);
                        else resolve();
                    });
                });
            }

            const sessions = await new Promise<any>(
                (resolve, reject) => {
                    store.all((error, data) => {
                        if (error) reject(error);
                        else resolve(data);
                    });
                }
            );

            assert.equal(Object.keys(sessions).length, 0);

            console.log("PASSED: Session store cleanup.");
        } finally {
            if (typeof (store as any).stopInterval === "function") {
                (store as any).stopInterval();
            }

            database.execute = originalExecute;
            database.query = originalQuery;

            await pool.end();

            console.log("PASSED: Database interception restored.");
        }
    }
});