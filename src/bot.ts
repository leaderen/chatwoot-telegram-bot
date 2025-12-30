import { Telegraf } from 'telegraf';
import { config } from './config';
import { getMapping, getTopic, getTopicByTopicId, deleteTopic } from './database';
import { createMessage, toggleConversationStatus } from './chatwoot';

export const bot = new Telegraf(config.telegramToken);

// ============ 文本消息处理（回复客户） ============

bot.on('text', async (ctx) => {
    const fromId = ctx.from.id.toString();

    // Forum 模式：检查是否来自 Forum 群组
    const isFromForum = config.telegramForumChatId && ctx.chat.id.toString() === config.telegramForumChatId;

    // 原有模式：仅限 Admin
    if (!isFromForum && fromId !== config.telegramAdminId) {
        return;
    }

    // 获取回复的消息
    const replyTo = ctx.message.reply_to_message;

    // Forum 模式下，可以通过话题 ID 获取对话映射
    if (isFromForum) {
        const threadId = ctx.message.message_thread_id;
        if (threadId) {
            const topicMapping = getTopicByTopicId(threadId);
            if (topicMapping) {
                try {
                    await createMessage(topicMapping.chatwoot_conversation_id, ctx.message.text);
                    // 静默成功，减少噪音
                } catch (error) {
                    console.error('Failed to send message to Chatwoot:', error);
                    await ctx.reply('发送消息到 Chatwoot 失败，请检查日志。');
                }
                return;
            }
        }
    }

    // 原有模式：必须回复消息
    if (!replyTo) {
        if (!isFromForum) {
            await ctx.reply('请回复客户消息来发送回复。');
        }
        return;
    }

    const mapping = getMapping(replyTo.message_id);
    if (!mapping) {
        await ctx.reply('找不到与此消息关联的会话。可能已过期或不是来自机器人。');
        return;
    }

    try {
        await createMessage(mapping.chatwoot_conversation_id, ctx.message.text);
        // 静默成功
    } catch (error) {
        console.error('Failed to send message to Chatwoot:', error);
        await ctx.reply('发送消息到 Chatwoot 失败，请检查日志。');
    }
});

// ============ 按钮回调处理 ============

bot.on('callback_query', async (ctx) => {
    // @ts-ignore
    const data = ctx.callbackQuery.data as string;
    // @ts-ignore
    const messageId = ctx.callbackQuery.message?.message_id;

    if (!data) return;

    // Forum 模式：resolve:conversationId:accountId
    if (data.startsWith('resolve:')) {
        const parts = data.split(':');
        const conversationId = parseInt(parts[1], 10);
        const accountId = parseInt(parts[2], 10);

        if (conversationId) {
            try {
                await toggleConversationStatus(conversationId, 'resolved');
                await ctx.answerCbQuery('会话已解决，话题将自动关闭！✅');
                await ctx.editMessageReplyMarkup({ inline_keyboard: [] });

                // 话题关闭由 webhook 的 conversation_status_changed 事件处理
            } catch (error) {
                console.error('Failed to resolve conversation:', error);
                await ctx.answerCbQuery('解决失败，请重试。');
            }
        }
        return;
    }

    // Forum 模式：close_topic:conversationId
    if (data.startsWith('close_topic:')) {
        const conversationId = parseInt(data.split(':')[1], 10);
        const topic = getTopic(conversationId);

        if (topic && config.telegramForumChatId) {
            try {
                await bot.telegram.closeForumTopic(config.telegramForumChatId, topic.telegram_topic_id);
                await ctx.answerCbQuery('话题已关闭！🔒');
                console.log(`手动关闭话题: ${topic.topic_name}`);
            } catch (error) {
                console.error('Failed to close topic:', error);
                await ctx.answerCbQuery('关闭话题失败。');
            }
        } else {
            await ctx.answerCbQuery('找不到对应的话题。');
        }
        return;
    }

    // 原有模式：resolve（无参数）
    if (data === 'resolve' && messageId) {
        const mapping = getMapping(messageId);
        if (mapping) {
            try {
                await toggleConversationStatus(mapping.chatwoot_conversation_id, 'resolved');
                await ctx.answerCbQuery('会话已解决！✅');
                await ctx.editMessageReplyMarkup({ inline_keyboard: [] });
                await ctx.reply(`会话 #${mapping.chatwoot_conversation_id} 已标记为已解决。`);
            } catch (error) {
                console.error('Failed to resolve conversation:', error);
                await ctx.answerCbQuery('解决失败。');
            }
        } else {
            await ctx.answerCbQuery('消息已过期或未知。');
        }
        return;
    }
});

// Launch logic will be in index.ts or separate init function

