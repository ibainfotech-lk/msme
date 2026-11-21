
-- Noteto Step 8J.96X
-- Migration: 20261117_003_session_store
-- Target: MySQL 8.4 / noteto_dev
--
-- Compatible with express-mysql-session 2.1.8.
-- Session expiration is stored as Unix seconds.
-- Schema changes must be performed by the migration account.

CREATE TABLE `sessions` (
    `session_id` VARCHAR(128)
        COLLATE utf8mb4_bin NOT NULL,

    `expires` INT UNSIGNED NOT NULL,

    `data` MEDIUMTEXT
        COLLATE utf8mb4_bin NULL,

    PRIMARY KEY (`session_id`),

    INDEX `idx_sessions_expires` (`expires`)
) ENGINE=InnoDB
  DEFAULT CHARACTER SET utf8mb4
  COLLATE utf8mb4_bin;
