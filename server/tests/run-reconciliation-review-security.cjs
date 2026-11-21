"use strict";

const assert = require("node:assert/strict");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const root = path.resolve(__dirname, "..", "..");

process.chdir(root);

require("dotenv/config");

// Safety preflight before executing any test.
assert.equal(process.env.DB_NAME, "noteto_dev");
assert.equal(Number(process.env.DB_PORT), 3307);
assert.equal(process.env.DB_USER, "noteto_services");

assert.ok(
    ["localhost", "127.0.0.1", "::1"].includes(
        String(process.env.DB_HOST)
    ),
    "STOP: Development database must be local."
);

console.log(
    "PASSED: Safe development configuration verified."
);

const testFile = path.join(
    __dirname,
    "payment-reconciliation-review.security.test.ts"
);

const scenarios = [
    {
        name: "disabled",
        nodeEnv: "development",
        flag: "false"
    },
    {
        name: "enabled",
        nodeEnv: "development",
        flag: "true"
    },
    {
        name: "production",
        nodeEnv: "production",
        flag: "true"
    }
];

for (const scenario of scenarios) {
    console.log("");
    console.log(
        "=== SECURITY REGRESSION: " +
        scenario.name +
        " ==="
    );

    const childEnvironment = {
        ...process.env,

        NODE_ENV: scenario.nodeEnv,

        NOTETO_ENABLE_RECONCILIATION_REVIEW:
            scenario.flag,

        NOTETO_REVIEW_TEST_MODE:
            scenario.name
    };

    const result = spawnSync(
        process.execPath,
        [
            "--import",
            "tsx",
            "--test",
            testFile
        ],
        {
            cwd: root,
            env: childEnvironment,
            stdio: "inherit",
            shell: false,
            windowsHide: true,
            timeout: 30000
        }
    );

    if (result.error) {
        throw result.error;
    }

    assert.equal(
        result.status,
        0,
        "STOP: Security regression failed: " +
        scenario.name
    );

    console.log(
        "PASSED: " +
        scenario.name +
        " security regression."
    );
}

console.log("");
console.log(
    "PASSED: All three reconciliation security scenarios."
);

console.log(
    "INFO: Original process environment was not modified."
);

console.log(
    "INFO: No real database queries or financial writes."
);