
-- Noteto Step 8J.96N
-- Add user profile and language preference fields.
-- Target: MySQL 8.4 / noteto_dev

ALTER TABLE `users`
    ADD COLUMN `full_name`
        VARCHAR(150)
        COLLATE utf8mb4_unicode_ci
        NULL,
    ADD COLUMN `preferred_language`
        ENUM('en', 'ta', 'si')
        COLLATE utf8mb4_unicode_ci
        NOT NULL DEFAULT 'en';