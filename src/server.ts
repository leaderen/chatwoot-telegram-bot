import express from 'express';
import axios from 'axios';
import http from 'http';
import https from 'https';
import { config } from './config';
import { bot } from './bot';
import { saveMapping, saveTopic, getTopic, deleteTopic } from './database';

export const app = express();
app.use(express.json({ limit: '2mb' }));

type ChatwootAttachment = {
    id?: number;
    file_type?: string;
    content_type?: string;
    file_name?: string;
    file_size?: number;
    size?: number;
    url?: string;
    file_url?: string;
    download_url?: string;
    data_url?: string;
    thumb_url?: string;
};

const TELEGRAM_MAX_FILE_SIZE_BYTES = 45 * 1024 * 1024; // 留一点余量，避免 Bot API 50MB 限制触发失败
const ATTACHMENT_CONCURRENCY = 2;

const httpAgent = new http.Agent({ keepAlive: true, maxSockets: 50 });
const httpsAgent = new https.Agent({ keepAlive: true, maxSockets: 50 });

// 专用于下载附件：连接复用 + 超时，避免卡死
const downloadClient = axios.create({
    timeout: 20_000,
    maxRedirects: 5,
    httpAgent,
    httpsAgent,
    headers: {
        api_access_token: config.chatwootAccessToken,
    },
    // 防止误把超大文件拉进内存（即便最终不转发）
    maxContentLength: TELEGRAM_MAX_FILE_SIZE_BYTES + 1024 * 1024,
    maxBodyLength: TELEGRAM_MAX_FILE_SIZE_BYTES + 1024 * 1024,
    validateStatus: (s) => s >= 200 && s < 400,
});

async function mapWithConcurrencyLimit<T>(items: T[], limit: number, worker: (item: T, index: number) => Promise<void>) {
    if (items.length === 0) return;
    const realLimit = Math.max(1, Math.min(limit, items.length));
    let idx = 0;

    const runners = Array.from({ length: realLimit }, async () => {
        while (true) {
            const current = idx++;
            if (current >= items.length) return;
            await worker(items[current], current);
        }
    });

    await Promise.allSettled(runners);
}

function extractAttachments(event: any): ChatwootAttachment[] {
    if (Array.isArray(event?.attachments)) return event.attachments as ChatwootAttachment[];
    if (Array.isArray(event?.message?.attachments)) return event.message.attachments as ChatwootAttachment[];
    return [];
}

function pickAttachmentUrl(att: ChatwootAttachment): string | undefined {
    return att.data_url || att.file_url || att.download_url || att.url || att.thumb_url;
}

function parseDataUrl(dataUrl: string): { mimeType?: string; buffer: Buffer } | null {
    // 例：data:image/png;base64,iVBORw0...
    const m = /^data:([^;]+);base64,(.*)$/s.exec(dataUrl);
    if (!m) return null;
    const mimeType = m[1];
    const base64 = m[2];
    return { mimeType, buffer: Buffer.from(base64, 'base64') };
}

function guessTelegramSendKind(att: ChatwootAttachment, mimeType?: string): 'photo' | 'video' | 'audio' | 'document' {
    const ft = (att.file_type || '').toLowerCase();
    const mt = (mimeType || att.content_type || '').toLowerCase();

    if (ft === 'image' || mt.startsWith('image/')) return 'photo';
    if (ft === 'video' || mt.startsWith('video/')) return 'video';
    if (ft === 'audio' || mt.startsWith('audio/')) return 'audio';
    return 'document';
}

async function downloadAttachment(att: ChatwootAttachment): Promise<{ buffer: Buffer; mimeType?: string; filename: string; size: number; sourceUrl?: string }> {
    const filename = att.file_name || `attachment-${att.id || Date.now()}`;

    const url = pickAttachmentUrl(att);
    if (!url) {
        throw new Error('附件缺少可下载的 URL（data_url/file_url/download_url/url）');
    }

    if (url.startsWith('data:')) {
        const parsed = parseDataUrl(url);
        if (!parsed) throw new Error('无法解析 data_url');
        const size = parsed.buffer.length;
        return { buffer: parsed.buffer, mimeType: parsed.mimeType, filename, size };
    }

    // 先根据声明的大小做快速拦截
    const declaredSize = typeof att.file_size === 'number' ? att.file_size : (typeof att.size === 'number' ? att.size : undefined);
    if (declaredSize && declaredSize > TELEGRAM_MAX_FILE_SIZE_BYTES) {
        return { buffer: Buffer.alloc(0), filename, size: declaredSize, sourceUrl: url };
    }

    // 尝试下载：很多 Chatwoot 文件 URL 是签名链接可直接访问；若需要鉴权，补上 api_access_token 头
    const resp = await downloadClient.get<ArrayBuffer>(url, {
        responseType: 'arraybuffer',
    });

    const buffer = Buffer.from(resp.data);
    const size = buffer.length;
    const mimeTypeHeader = (resp.headers?.['content-type'] as string | undefined) || undefined;

    return { buffer, mimeType: mimeTypeHeader || att.content_type, filename, size, sourceUrl: url };
}

// ============ Forum Topics 支持 ============

/**
 * 获取或创建对话对应的 Forum Topic
 * 如果未配置 Forum 群组则返回 undefined，保持原有行为
 */
async function getOrCreateTopic(conversationId: number, accountId: number, senderName: string): Promise<number | undefined> {
    if (!config.telegramForumChatId) return undefined;

    const existing = getTopic(conversationId);
    if (existing) return existing.telegram_topic_id;

    try {
        // 创建新话题，名称包含客户名和对话 ID
        const topicName = `🗨️ ${senderName} #${conversationId}`;
        const result = await bot.telegram.createForumTopic(config.telegramForumChatId, topicName);
        const topicId = result.message_thread_id;
        saveTopic(conversationId, accountId, topicId, topicName);
        console.log(`创建新话题: ${topicName} (topic_id: ${topicId})`);

        // 发送欢迎消息（带 Inline Keyboard）
        await sendWelcomeMessage(conversationId, accountId, topicId);

        return topicId;
    } catch (err) {
        console.error('创建 Forum Topic 失败:', err);
        return undefined;
    }
}

/**
 * 构建 Forum 模式下的 Inline Keyboard
 * 注意：ReplyKeyboardMarkup 在 Forum Topics 中不起作用（Telegram API 限制）
 * 因此改用 InlineKeyboardMarkup，它会附加在每条消息上
 */
function buildForumInlineKeyboard(conversationId: number, accountId: number) {
    return {
        inline_keyboard: [
            [
                { text: '✅ 标记已解决', callback_data: `resolve:${conversationId}:${accountId}` },
                { text: '🔓 重新打开', callback_data: `reopen:${conversationId}:${accountId}` },
            ],
            [
                { text: '📱 在 Chatwoot 中查看', url: `${config.chatwootBaseUrl}/app/accounts/${accountId}/conversations/${conversationId}` },
            ],
        ],
    };
}

/**
 * 发送欢迎消息（带 Inline Keyboard）
 */
async function sendWelcomeMessage(conversationId: number, accountId: number, topicId: number) {
    if (!config.telegramForumChatId) return;

    const welcomeText = `💬 **新对话已开始**\n\n点击下方按钮管理此对话：`;

    try {
        await bot.telegram.sendMessage(
            config.telegramForumChatId,
            welcomeText,
            {
                message_thread_id: topicId,
                parse_mode: 'Markdown',
                reply_markup: buildForumInlineKeyboard(conversationId, accountId),
            }
        );
        console.log(`话题欢迎消息已发送 (topic_id: ${topicId})`);
    } catch (err) {
        console.error('发送欢迎消息失败:', err);
    }
}

/**
 * 关闭对话对应的 Forum Topic
 */
async function closeTopicForConversation(conversationId: number): Promise<boolean> {
    if (!config.telegramForumChatId) return false;

    const topic = getTopic(conversationId);
    if (!topic) return false;

    try {
        await bot.telegram.closeForumTopic(config.telegramForumChatId, topic.telegram_topic_id);
        console.log(`关闭话题: ${topic.topic_name} (topic_id: ${topic.telegram_topic_id})`);
        return true;
    } catch (err) {
        console.error('关闭 Forum Topic 失败:', err);
        return false;
    }
}

// ============ 附件发送 ============

async function sendAttachmentToTelegram(params: {
    chatId: string;
    att: ChatwootAttachment;
    conversationId: number;
    accountId: number;
    chatwootMessageId?: number;
    messageThreadId?: number;  // Forum Topic ID
}) {
    const { chatId, att, conversationId, accountId, chatwootMessageId, messageThreadId } = params;

    // 构建发送选项（如果有 topic ID 则添加）
    const sendOptions: { message_thread_id?: number } = {};
    if (messageThreadId) {
        sendOptions.message_thread_id = messageThreadId;
    }

    // 优先尝试让 Telegram 直接拉取 URL（省带宽/内存/CPU）。失败再 fallback 到本地下载+上传。
    const directUrl = pickAttachmentUrl(att);
    if (directUrl && !directUrl.startsWith('data:')) {
        const kind = guessTelegramSendKind(att, att.content_type);
        try {
            if (kind === 'photo') {
                const sent = await bot.telegram.sendPhoto(chatId, directUrl, sendOptions);
                saveMapping(sent.message_id, conversationId, accountId, chatwootMessageId);
                return;
            }
            if (kind === 'video') {
                const sent = await bot.telegram.sendVideo(chatId, directUrl, sendOptions);
                saveMapping(sent.message_id, conversationId, accountId, chatwootMessageId);
                return;
            }
            if (kind === 'audio') {
                const sent = await bot.telegram.sendAudio(chatId, directUrl, sendOptions);
                saveMapping(sent.message_id, conversationId, accountId, chatwootMessageId);
                return;
            }
            const sent = await bot.telegram.sendDocument(chatId, directUrl, sendOptions);
            saveMapping(sent.message_id, conversationId, accountId, chatwootMessageId);
            return;
        } catch (err) {
            // URL 直传失败（常见原因：需要鉴权 header、URL 仅内网可见、URL 过期等），继续走 fallback
            console.warn('附件 URL 直传失败，改用下载+上传:', err);
        }
    }

    let downloaded: { buffer: Buffer; mimeType?: string; filename: string; size: number; sourceUrl?: string };
    try {
        downloaded = await downloadAttachment(att);
    } catch (err) {
        console.error('附件下载失败:', err);
        const url = pickAttachmentUrl(att);
        const fallbackText = `📎 附件下载失败：${att.file_name || att.id || ''}\n${url ? `链接：${url}` : ''}`;
        const sent = await bot.telegram.sendMessage(chatId, fallbackText, sendOptions);
        saveMapping(sent.message_id, conversationId, accountId, chatwootMessageId);
        return;
    }

    // 太大就不上传，改发链接
    if (downloaded.size > TELEGRAM_MAX_FILE_SIZE_BYTES || downloaded.buffer.length === 0) {
        const url = downloaded.sourceUrl || pickAttachmentUrl(att);
        const sent = await bot.telegram.sendMessage(
            chatId,
            `📎 附件过大，无法直接转发到 Telegram（${Math.ceil(downloaded.size / 1024 / 1024)}MB）\n文件：${downloaded.filename}\n${url ? `下载链接：${url}` : ''}`,
            sendOptions
        );
        saveMapping(sent.message_id, conversationId, accountId, chatwootMessageId);
        return;
    }

    const kind = guessTelegramSendKind(att, downloaded.mimeType);
    const inputFile = { source: downloaded.buffer, filename: downloaded.filename };

    try {
        if (kind === 'photo') {
            const sent = await bot.telegram.sendPhoto(chatId, inputFile, sendOptions);
            saveMapping(sent.message_id, conversationId, accountId, chatwootMessageId);
        } else if (kind === 'video') {
            const sent = await bot.telegram.sendVideo(chatId, inputFile, sendOptions);
            saveMapping(sent.message_id, conversationId, accountId, chatwootMessageId);
        } else if (kind === 'audio') {
            const sent = await bot.telegram.sendAudio(chatId, inputFile, sendOptions);
            saveMapping(sent.message_id, conversationId, accountId, chatwootMessageId);
        } else {
            const sent = await bot.telegram.sendDocument(chatId, inputFile, sendOptions);
            saveMapping(sent.message_id, conversationId, accountId, chatwootMessageId);
        }
    } catch (err) {
        console.error('附件发送到 Telegram 失败:', err);
        const url = downloaded.sourceUrl || pickAttachmentUrl(att);
        const sent = await bot.telegram.sendMessage(
            chatId,
            `📎 附件发送失败：${downloaded.filename}\n${url ? `链接：${url}` : ''}`,
            sendOptions
        );
        saveMapping(sent.message_id, conversationId, accountId, chatwootMessageId);
    }
}

// ============ 消息处理 ============

async function handleMessageCreated(event: any) {
    const messageType = event?.message_type;
    // Allow incoming (user) and outgoing (agent/bot)
    if (messageType !== 'incoming' && messageType !== 'outgoing') return;

    const conversationId = event?.conversation?.id;
    const accountId = event?.account?.id;
    if (!conversationId || !accountId) return;

    const attachments = extractAttachments(event);
    const messageContent = event?.content || (attachments.length > 0 ? '[附件]' : '[无内容]');
    const senderName = event?.sender?.name || '未知';
    const senderEmail = event?.sender?.email || '';

    // 尝试获取或创建 Forum Topic（如果配置了 Forum 群组）
    const topicId = await getOrCreateTopic(conversationId, accountId, senderName);
    const isForumMode = !!topicId && !!config.telegramForumChatId;

    // 目标聊天 ID 和消息选项
    const chatId = isForumMode ? config.telegramForumChatId : config.telegramAdminId;
    const sendOptions: { parse_mode: 'Markdown'; message_thread_id?: number; reply_markup?: any } = {
        parse_mode: 'Markdown',
    };
    if (topicId) {
        sendOptions.message_thread_id = topicId;
    }

    // 消息格式
    let text = '';
    const attachmentHint = attachments.length > 0 ? `\n📎 附件：${attachments.length} 个` : '';
    if (messageType === 'incoming') {
        text = `👤 **${senderName}** (${senderEmail})\n💬 ${messageContent}${attachmentHint}`;
    } else {
        text = `🤖 **${senderName}** (客服/AI)\n📤 ${messageContent}${attachmentHint}`;
    }

    // 为消息附加 Inline Keyboard（Forum 模式和原有模式都适用）
    if (isForumMode) {
        // Forum 模式：使用带 conversationId 的 callback_data，支持更多操作
        sendOptions.reply_markup = buildForumInlineKeyboard(conversationId, accountId);
    } else {
        // 原有模式：简化的 inline keyboard
        const inlineKeyboard = [
            [
                { text: '✅ 标记已解决', callback_data: 'resolve' },
            ],
            [
                { text: '📱 在 Chatwoot 中查看', url: `${config.chatwootBaseUrl}/app/accounts/${accountId}/conversations/${conversationId}` },
            ],
        ];
        sendOptions.reply_markup = { inline_keyboard: inlineKeyboard };
    }

    try {
        const sentMessage = await bot.telegram.sendMessage(chatId, text, sendOptions);
        saveMapping(sentMessage.message_id, conversationId, accountId, event?.id);

        // 发送附件（如有）
        await mapWithConcurrencyLimit(attachments, ATTACHMENT_CONCURRENCY, async (att) => {
            await sendAttachmentToTelegram({
                chatId,
                att,
                conversationId,
                accountId,
                chatwootMessageId: event?.id,
                messageThreadId: topicId,
            });
        });
    } catch (error: any) {
        console.error('Failed to send message to Telegram:', error);

        // 处理话题已删除的情况
        if (error?.response?.description?.includes('TOPIC_DELETED') || error?.message?.includes('TOPIC_DELETED')) {
            console.log(`检测到话题已删除 (conversation_id: ${conversationId})，清理数据库映射`);
            deleteTopic(conversationId);

            // 尝试创建新话题并重新发送
            try {
                const newTopicId = await getOrCreateTopic(conversationId, accountId, senderName);
                if (newTopicId && config.telegramForumChatId) {
                    console.log(`为对话 ${conversationId} 创建了新话题 (topic_id: ${newTopicId})，重新发送消息`);
                    const newSendOptions = { ...sendOptions, message_thread_id: newTopicId };
                    const sentMessage = await bot.telegram.sendMessage(config.telegramForumChatId, text, newSendOptions);
                    saveMapping(sentMessage.message_id, conversationId, accountId, event?.id);
                }
            } catch (retryError) {
                console.error('重新创建话题并发送消息失败:', retryError);
            }
        }
    }
}

/**
 * 处理对话状态变更（如 resolved）
 */
async function handleConversationStatusChanged(event: any) {
    const conversationId = event?.id || event?.conversation?.id;
    const status = event?.status;

    if (!conversationId) return;

    // 当对话被标记为 resolved 时，关闭对应的 Forum Topic
    if (status === 'resolved') {
        const closed = await closeTopicForConversation(conversationId);
        if (closed) {
            console.log(`对话 #${conversationId} 已解决，话题已关闭`);
        }
    }
}

// ============ Webhook 路由 ============

app.post('/webhook', (req, res) => {
    const event = req.body;
    // 先快速 ACK，避免 Chatwoot 因下载附件导致超时重试
    res.sendStatus(200);

    const eventType = event?.event;

    if (eventType === 'message_created') {
        void handleMessageCreated(event);
    } else if (eventType === 'conversation_status_changed') {
        void handleConversationStatusChanged(event);
    }
});

// 导出供测试使用
export const __debugHandleMessageCreated = handleMessageCreated;
export { closeTopicForConversation };

