-- Noteto migration 008
-- Durable payment gateway initiation tracking.
-- Does not modify existing payment outcome statuses.

ALTER TABLE platform_payment_transactions
    ADD COLUMN initiation_status
        ENUM(
            'RESERVED',
            'INITIATING',
            'INITIATED',
            'UNKNOWN',
            'FAILED'
        ) NOT NULL DEFAULT 'RESERVED',

    ADD COLUMN merchant_reference
        VARCHAR(191) NULL,

    ADD COLUMN gateway_order_id
        VARCHAR(191) NULL,

    ADD COLUMN initiation_started_at
        DATETIME(3) NULL,

    ADD COLUMN initiation_completed_at
        DATETIME(3) NULL;

ALTER TABLE platform_payment_transactions
    ADD UNIQUE KEY uq_payment_merchant_reference
        (merchant_reference),

    ADD UNIQUE KEY uq_payment_gateway_order
        (gateway, gateway_order_id),

    ADD KEY idx_payment_initiation_recovery
        (initiation_status, initiation_started_at);
