import Database from 'better-sqlite3';
import { config } from './config';

const db = new Database(config.dbPath);

export function initDb() {
  // 更适合高频写入的 SQLite 设置（默认 rollback journal + FULL 同步会更慢）
  // WAL: 读写并发更好、写入吞吐更高；NORMAL 同步在大多数场景更平衡性能与可靠性
  db.pragma('journal_mode = WAL');
  db.pragma('synchronous = NORMAL');
  db.pragma('temp_store = MEMORY');
  // 允许在锁竞争时等待一段时间，避免偶发 SQLITE_BUSY
  db.pragma('busy_timeout = 5000');
  // 负数表示 KB，给 SQLite page cache 一些空间（按需可调）
  db.pragma('cache_size = -64000'); // ~64MB

  db.exec(`
    CREATE TABLE IF NOT EXISTS messages (
      telegram_message_id INTEGER PRIMARY KEY,
      chatwoot_conversation_id INTEGER NOT NULL,
      chatwoot_account_id INTEGER,
      chatwoot_message_id INTEGER
    )
  `);

  // Forum Topics 映射表：对话 ID <-> 话题 ID
  db.exec(`
    CREATE TABLE IF NOT EXISTS topics (
      chatwoot_conversation_id INTEGER PRIMARY KEY,
      chatwoot_account_id INTEGER,
      telegram_topic_id INTEGER NOT NULL,
      topic_name TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )
  `);
}

// ============ Messages 映射 ============

export function saveMapping(telegramMessageId: number, conversationId: number, accountId?: number, chatwootMessageId?: number) {
  insertMappingStmt.run(telegramMessageId, conversationId, accountId, chatwootMessageId);
}

export function getMapping(telegramMessageId: number) {
  return selectMappingStmt.get(telegramMessageId) as { chatwoot_conversation_id: number; chatwoot_account_id?: number; chatwoot_message_id?: number } | undefined;
}

// ============ Topics 映射 ============

export function saveTopic(conversationId: number, accountId: number | undefined, topicId: number, topicName: string) {
  insertTopicStmt.run(conversationId, accountId, topicId, topicName);
}

export function getTopic(conversationId: number) {
  return selectTopicStmt.get(conversationId) as { telegram_topic_id: number; topic_name: string; chatwoot_account_id?: number } | undefined;
}

export function deleteTopic(conversationId: number) {
  deleteTopicStmt.run(conversationId);
}

export function getTopicByTopicId(telegramTopicId: number) {
  return selectTopicByTopicIdStmt.get(telegramTopicId) as { chatwoot_conversation_id: number; chatwoot_account_id?: number; topic_name: string } | undefined;
}

// ============ 预编译语句 ============

// Messages
const insertMappingStmt = db.prepare(
  'INSERT OR REPLACE INTO messages (telegram_message_id, chatwoot_conversation_id, chatwoot_account_id, chatwoot_message_id) VALUES (?, ?, ?, ?)'
);
const selectMappingStmt = db.prepare('SELECT * FROM messages WHERE telegram_message_id = ?');

// Topics
const insertTopicStmt = db.prepare(
  'INSERT OR REPLACE INTO topics (chatwoot_conversation_id, chatwoot_account_id, telegram_topic_id, topic_name) VALUES (?, ?, ?, ?)'
);
const selectTopicStmt = db.prepare('SELECT telegram_topic_id, topic_name, chatwoot_account_id FROM topics WHERE chatwoot_conversation_id = ?');
const deleteTopicStmt = db.prepare('DELETE FROM topics WHERE chatwoot_conversation_id = ?');
const selectTopicByTopicIdStmt = db.prepare('SELECT chatwoot_conversation_id, chatwoot_account_id, topic_name FROM topics WHERE telegram_topic_id = ?');

