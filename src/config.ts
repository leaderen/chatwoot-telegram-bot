import dotenv from 'dotenv';
dotenv.config();

export const config = {
    port: process.env.PORT || 3000,
    telegramToken: process.env.TELEGRAM_TOKEN || '',
    telegramAdminId: process.env.TELEGRAM_ADMIN_ID || '',
    telegramForumChatId: process.env.TELEGRAM_FORUM_CHAT_ID || '',  // Forum 群组 ID（可选）
    chatwootAccessToken: process.env.CHATWOOT_ACCESS_TOKEN || '',
    chatwootBaseUrl: process.env.CHATWOOT_BASE_URL || 'https://app.chatwoot.com',
    chatwootAccountId: process.env.CHATWOOT_ACCOUNT_ID || '',
    dbPath: process.env.DB_PATH || 'mappings.db',
};

if (!config.telegramToken) {
    console.warn('WARNING: TELEGRAM_TOKEN is not set.');
}
