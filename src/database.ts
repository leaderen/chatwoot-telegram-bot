import Database from 'better-sqlite3';
import { config } from './config';

const db = new Database(config.dbPath);

// 当前数据库版本（每次架构变更时递增）
const CURRENT_DB_VERSION = 2;

// ============ 预编译语句（延迟初始化） ============
let insertMappingStmt: any;
let selectMappingStmt: any;
let insertTopicStmt: any;
let selectTopicStmt: any;
let deleteTopicStmt: any;
let selectTopicByTopicIdStmt: any;

/**
 * 获取当前数据库版本
 */
function getDatabaseVersion(): number {
  try {
    const result = db.prepare('SELECT version FROM schema_version LIMIT 1').get() as { version: number } | undefined;
    return result?.version || 0;
  } catch (error) {
    // schema_version 表不存在，说明是新数据库
    return 0;
  }
}

/**
 * 设置数据库版本
 */
function setDatabaseVersion(version: number): void {
  db.prepare('INSERT OR REPLACE INTO schema_version (id, version, updated_at) VALUES (1, ?, CURRENT_TIMESTAMP)').run(version);
}

/**
 * 创建版本管理表
 */
function createSchemaVersionTable(): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS schema_version (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      version INTEGER NOT NULL,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )
  `);
}

/**
 * 迁移到版本 1：创建基础 messages 表
 */
function migrateToVersion1(): void {
  console.log('📦 迁移数据库到版本 1：创建 messages 表');
  db.exec(`
    CREATE TABLE IF NOT EXISTS messages (
      telegram_message_id INTEGER PRIMARY KEY,
      chatwoot_conversation_id INTEGER NOT NULL,
      chatwoot_account_id INTEGER,
      chatwoot_message_id INTEGER
    )
  `);
}

/**
 * 迁移到版本 2：创建 topics 表（Forum 话题功能）
 */
function migrateToVersion2(): void {
  console.log('📦 迁移数据库到版本 2：创建 topics 表');
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

/**
 * 执行数据库迁移
 */
function runMigrations(currentVersion: number): void {
  console.log(`🔍 当前数据库版本: ${currentVersion}, 目标版本: ${CURRENT_DB_VERSION}`);

  if (currentVersion === CURRENT_DB_VERSION) {
    console.log('✅ 数据库已是最新版本');
    return;
  }

  // 使用事务确保迁移的原子性
  const migrate = db.transaction(() => {
    // 按顺序执行所有必要的迁移
    if (currentVersion < 1) {
      migrateToVersion1();
      setDatabaseVersion(1);
    }

    if (currentVersion < 2) {
      migrateToVersion2();
      setDatabaseVersion(2);
    }

    // 未来的迁移在这里添加
    // if (currentVersion < 3) {
    //   migrateToVersion3();
    //   setDatabaseVersion(3);
    // }
  });

  try {
    migrate();
    console.log(`✅ 数据库迁移成功！当前版本: ${CURRENT_DB_VERSION}`);
  } catch (error) {
    console.error('❌ 数据库迁移失败:', error);
    throw error;
  }
}

/**
 * 初始化预编译语句
 */
function initPreparedStatements(): void {
  // Messages
  insertMappingStmt = db.prepare(
    'INSERT OR REPLACE INTO messages (telegram_message_id, chatwoot_conversation_id, chatwoot_account_id, chatwoot_message_id) VALUES (?, ?, ?, ?)'
  );
  selectMappingStmt = db.prepare('SELECT * FROM messages WHERE telegram_message_id = ?');

  // Topics
  insertTopicStmt = db.prepare(
    'INSERT OR REPLACE INTO topics (chatwoot_conversation_id, chatwoot_account_id, telegram_topic_id, topic_name) VALUES (?, ?, ?, ?)'
  );
  selectTopicStmt = db.prepare('SELECT telegram_topic_id, topic_name, chatwoot_account_id FROM topics WHERE chatwoot_conversation_id = ?');
  deleteTopicStmt = db.prepare('DELETE FROM topics WHERE chatwoot_conversation_id = ?');
  selectTopicByTopicIdStmt = db.prepare('SELECT chatwoot_conversation_id, chatwoot_account_id, topic_name FROM topics WHERE telegram_topic_id = ?');
}

/**
 * 初始化数据库
 * 自动处理新数据库创建和旧数据库迁移
 */
export function initDb() {
  console.log('🚀 初始化数据库...');

  // 配置 SQLite 性能优化参数
  db.pragma('journal_mode = WAL');      // 写前日志模式，提升并发性能
  db.pragma('synchronous = NORMAL');     // 平衡性能与可靠性
  db.pragma('temp_store = MEMORY');      // 临时数据存储在内存
  db.pragma('busy_timeout = 5000');      // 锁等待超时 5 秒
  db.pragma('cache_size = -64000');      // 页面缓存 ~64MB

  // 创建版本管理表
  createSchemaVersionTable();

  // 获取当前数据库版本
  const currentVersion = getDatabaseVersion();

  // 执行迁移（如果需要）
  runMigrations(currentVersion);

  // 初始化预编译语句（在所有表创建之后）
  initPreparedStatements();

  console.log('✅ 数据库初始化完成');
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
