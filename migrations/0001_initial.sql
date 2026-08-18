PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS email_logs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    email TEXT NOT NULL,
    domain TEXT NOT NULL,
    ip TEXT,
    created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS messages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    email TEXT NOT NULL,
    message_id TEXT NOT NULL UNIQUE,
    from_addr TEXT,
    subject TEXT,
    received_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_email_logs_email
ON email_logs(email);

CREATE INDEX IF NOT EXISTS idx_email_logs_domain
ON email_logs(domain);

CREATE INDEX IF NOT EXISTS idx_email_logs_ip
ON email_logs(ip);

CREATE INDEX IF NOT EXISTS idx_email_logs_created_at
ON email_logs(created_at);

CREATE INDEX IF NOT EXISTS idx_messages_email
ON messages(email);

CREATE INDEX IF NOT EXISTS idx_messages_message_id
ON messages(message_id);

CREATE INDEX IF NOT EXISTS idx_messages_received_at
ON messages(received_at);

CREATE INDEX IF NOT EXISTS idx_messages_email_received
ON messages(email, received_at DESC);
