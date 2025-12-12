import { Telegraf } from 'telegraf';
import { config } from './config';
import { getMapping } from './database';
import { createMessage, toggleConversationStatus } from './chatwoot';

export const bot = new Telegraf(config.telegramToken);

bot.on('text', async (ctx) => {
    // We only care about messages from the admin
    if (ctx.from.id.toString() !== config.telegramAdminId) {
        return;
    }

    const replyTo = ctx.message.reply_to_message;
    if (!replyTo) {
        await ctx.reply('请回复客户消息来发送回复。');
        return;
    }

    const mapping = getMapping(replyTo.message_id);
    if (!mapping) {
        await ctx.reply('找不到与此消息关联的会话。可能已过期或不是来自机器人。');
        return;
    }

    try {
        await createMessage(mapping.chatwoot_conversation_id, ctx.message.text);
        // Optionally confirm success, or stay silent to reduce noise
        // await ctx.reply('已发送！');
    } catch (error) {
        console.error('Failed to send message to Chatwoot:', error);
        await ctx.reply('发送消息到 Chatwoot 失败，请检查日志。');
    }
});

bot.on('callback_query', async (ctx) => {
    // @ts-ignore
    const data = ctx.callbackQuery.data;
    // @ts-ignore
    const messageId = ctx.callbackQuery.message?.message_id;

    if (data === 'resolve' && messageId) {
        const mapping = getMapping(messageId);
        if (mapping) {
            try {
                await toggleConversationStatus(mapping.chatwoot_conversation_id, 'resolved');
                await ctx.answerCbQuery('会话已解决！✅');
                // Optionally edit the message to show it's resolved
                await ctx.editMessageReplyMarkup({ inline_keyboard: [] }); // Remove buttons
                await ctx.reply(`会话 #${mapping.chatwoot_conversation_id} 已标记为已解决。`);
            } catch (error) {
                console.error('Failed to resolve conversation:', error);
                await ctx.answerCbQuery('解决失败。');
            }
        } else {
            await ctx.answerCbQuery('消息已过期或未知。');
        }
    }
});

// Launch logic will be in index.ts or separate init function
