import type { OpenClawConfig } from "../../../src/config/config.js";
import type { PluginRuntime } from "../../../src/plugins/runtime/types.js";
import { routeReply } from "../../../src/auto-reply/reply/route-reply.js";
import { parseAgentSessionKey } from "../../../src/routing/session-key.js";

/**
 * Extract channel information from sessionKey
 * Format examples:
 * - agent:main:slack:channel:c123
 * - agent:main:telegram:group:123
 * - agent:main:discord:dm:u123
 * - agent:main:slack:channel:c1:thread:123
 * - agent:main:telegram:group:123:topic:99
 */
function extractChannelInfo(sessionKey: string): {
  provider?: string;
  to?: string;
  accountId?: string;
  threadId?: string | number;
} {
  const parsed = parseAgentSessionKey(sessionKey);
  if (!parsed) {
    return {};
  }

  const rest = parsed.rest || "";
  const parts = rest.split(":").filter(Boolean);

  if (parts.length < 2) {
    return {};
  }

  // First part is the provider (slack, telegram, discord, etc.)
  const provider = parts[0];
  // Second part is the type (channel, group, dm, etc.)
  const type = parts[1];
  // Third part is the ID
  const to = parts[2];

  if (!provider || !to) {
    return {};
  }

  // Extract optional thread/topic/account info
  let accountId: string | undefined;
  let threadId: string | number | undefined;

  for (let i = 3; i < parts.length; i += 2) {
    const key = parts[i];
    const value = parts[i + 1];
    if (key === "thread" || key === "topic") {
      threadId = value ? (isNaN(Number(value)) ? value : Number(value)) : undefined;
    } else if (key === "account") {
      accountId = value;
    }
  }

  return { provider, to, accountId, threadId };
}

/**
 * Extract channel info from messages if sessionKey doesn't contain it
 */
function extractChannelFromMessages(messages: unknown[]): {
  provider?: string;
  to?: string;
  accountId?: string;
  threadId?: string | number;
} | null {
  // Look for the most recent message with channel info
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i];
    if (!msg || typeof msg !== "object") continue;

    const msgObj = msg as Record<string, unknown>;

    // Check for OriginatingChannel/OriginatingTo (used by route-reply)
    const origChannel = msgObj.OriginatingChannel || msgObj.originatingChannel;
    const origTo = msgObj.OriginatingTo || msgObj.originatingTo;

    if (typeof origChannel === "string" && typeof origTo === "string") {
      if (origChannel.toLowerCase() === "telegram") {
        return {
          provider: "telegram",
          to: origTo,
          accountId: msgObj.accountId as string | undefined,
          threadId: msgObj.threadId as string | number | undefined,
        };
      }
    }

    // Check for sessionKey in message
    const sessionKey = msgObj.sessionKey;
    if (typeof sessionKey === "string" && sessionKey.includes("telegram")) {
      const info = extractChannelInfo(sessionKey);
      if (info.provider && info.to) {
        return info;
      }
    }

    // Check for channel/provider fields
    const channel = msgObj.channel || msgObj.provider;
    const to = msgObj.to || msgObj.chatId || msgObj.groupId || msgObj.userId;
    if (
      typeof channel === "string" &&
      channel.toLowerCase() === "telegram" &&
      typeof to === "string"
    ) {
      return {
        provider: "telegram",
        to: String(to),
        accountId: msgObj.accountId as string | undefined,
        threadId: msgObj.threadId as string | number | undefined,
      };
    }
  }
  return null;
}

/**
 * Get all active Telegram channels/groups from config
 */
function getTelegramChannels(config: OpenClawConfig): Array<{
  to: string;
  accountId?: string;
}> {
  const channels: Array<{ to: string; accountId?: string }> = [];
  const telegramConfig = config.channels?.telegram;

  if (!telegramConfig?.enabled) {
    return channels;
  }

  // For now, we'll try to send to the default account
  // In the future, we could enumerate all active chats/groups
  // For Telegram, we typically send to the chat that triggered the conversation
  // This is a simplified approach - in production you might want to track active chats

  return channels;
}

export async function sendNotification(
  message: string,
  sessionKey: string | undefined,
  config: OpenClawConfig,
  runtime: PluginRuntime,
  messages?: unknown[],
): Promise<{ success: boolean; error?: string }> {
  let channelInfo: {
    provider?: string;
    to?: string;
    accountId?: string;
    threadId?: string | number;
  } | null = null;

  // Try to extract from sessionKey first
  if (sessionKey) {
    channelInfo = extractChannelInfo(sessionKey);
  }

  // If sessionKey doesn't have channel info, try to extract from messages
  if ((!channelInfo?.provider || !channelInfo?.to) && messages && messages.length > 0) {
    const msgChannelInfo = extractChannelFromMessages(messages);
    if (msgChannelInfo?.provider && msgChannelInfo.to) {
      channelInfo = msgChannelInfo;
    }
  }

  // If still no channel info, try to send to default Telegram channel if enabled
  if (!channelInfo?.provider || !channelInfo?.to) {
    // Check if Telegram is enabled
    if (config.channels?.telegram?.enabled) {
      // Try to use the default account or find the most recent Telegram chat
      // For now, we'll log that we can't determine the specific channel
      // In a production system, you might want to maintain a list of active chats
      // or use the runtime API to get active channels
      const errorMsg = `Could not determine Telegram channel from sessionKey or messages. SessionKey: ${sessionKey || "undefined"}. Telegram is enabled but no channel info found in messages.`;
      return {
        success: false,
        error: errorMsg,
      };
    }
    return {
      success: false,
      error: "Could not extract provider or destination from sessionKey or messages",
    };
  }

  try {
    // Route the reply
    const result = await routeReply({
      payload: { text: message },
      channel: channelInfo.provider as any,
      to: channelInfo.to,
      accountId: channelInfo.accountId,
      threadId: channelInfo.threadId,
      cfg: config,
      sessionKey: sessionKey || undefined,
      mirror: false, // Don't mirror notification messages
    });

    if (!result.ok) {
      return { success: false, error: result.error || "Failed to send notification" };
    }

    return { success: true };
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    return { success: false, error };
  }
}
