/**
 * Notification types and the config fields each one takes.
 *
 * Uptime Kuma has no schema for these. A notification row stores whatever object it is sent
 * (Notification.save() does JSON.stringify), and each provider reads its own property names
 * off that object when an alert fires. So a channel saved with `webhookURL` where slack reads
 * `slackwebhookURL` is accepted, listed, and silent. These tables are what
 * listNotificationTypes and getNotificationTypeFields answer from.
 *
 * NOTIFICATION_TYPES is every key of NotificationFormList in Uptime Kuma's
 * src/components/notifications/index.js, with the label its dialog shows. The type string is
 * case-sensitive and inconsistent upstream (slack, PagerDuty, rocket.chat, GoogleChat).
 *
 * NOTIFICATION_TYPE_FIELDS covers the commonly used providers, read off what each file in
 * server/notification-providers/ dereferences. "Required" means the provider uses the value
 * unconditionally; anything guarded or defaulted is optional. A type with no entry is still
 * accepted by createNotification: refusing one because this table is behind upstream would be
 * a worse failure than saving it.
 */

export const NOTIFICATION_TYPES: ReadonlyArray<{ type: string; name: string }> = [
  { type: 'alerta', name: 'Alerta' },
  { type: 'AlertNow', name: 'AlertNow' },
  { type: 'AliyunSMS', name: 'AliyunSMS' },
  { type: 'apprise', name: 'Apprise (50+ notification services)' },
  { type: 'bale', name: 'Bale' },
  { type: 'Bark', name: 'Bark' },
  { type: 'bearsms', name: 'BearSMS (Israel)' },
  { type: 'Bitrix24', name: 'Bitrix24' },
  { type: 'ClickUp', name: 'ClickUp' },
  { type: 'clicksendsms', name: 'ClickSend SMS' },
  { type: 'CallMeBot', name: 'CallMeBot (WhatsApp, Telegram Call, Facebook Messenger)' },
  { type: 'amootsms', name: 'Amoot SMS' },
  { type: 'smsc', name: 'SMSC' },
  { type: 'smsir', name: 'SMS.IR' },
  { type: 'DingDing', name: 'DingDing' },
  { type: 'discord', name: 'Discord' },
  { type: 'fluxer', name: 'Fluxer' },
  { type: 'Elks', name: '46elks' },
  { type: 'egosms', name: 'EgoSMS (Uganda)' },
  { type: 'Feishu', name: 'Feishu' },
  { type: 'FreeMobile', name: 'FreeMobile (mobile.free.fr)' },
  { type: 'GoogleChat', name: 'Google Chat (Google Workspace)' },
  { type: 'GoogleSheets', name: 'Google Sheets' },
  { type: 'gorush', name: 'Gorush' },
  { type: 'gotify', name: 'Gotify' },
  { type: 'GrafanaOncall', name: 'Grafana Oncall' },
  { type: 'HomeAssistant', name: 'Home Assistant' },
  { type: 'Indigo', name: 'Indigo' },
  { type: 'HeiiOnCall', name: 'Heii On-Call' },
  { type: 'Keep', name: 'Keep' },
  { type: 'Kook', name: 'Kook' },
  { type: 'line', name: 'LINE Messenger' },
  { type: 'lunasea', name: 'LunaSea' },
  { type: 'matrix', name: 'Matrix' },
  { type: 'mattermost', name: 'Mattermost' },
  { type: 'nextcloudtalk', name: 'Nextcloud Talk' },
  { type: 'nostr', name: 'Nostr' },
  { type: 'notifyapp', name: 'Notify!' },
  { type: 'ntfy', name: 'Ntfy' },
  { type: 'octopush', name: 'Octopush' },
  { type: 'OneChat', name: 'OneChat' },
  { type: 'OneBot', name: 'OneBot' },
  { type: 'Onesender', name: 'Onesender' },
  { type: 'Ooredoo', name: 'Ooredoo (Maldives)' },
  { type: 'Opsgenie', name: 'Opsgenie' },
  { type: 'OpsiMate', name: 'OpsiMate' },
  { type: 'JiraServiceManagement', name: 'Jira Service Management' },
  { type: 'PagerDuty', name: 'PagerDuty' },
  { type: 'FlashDuty', name: 'FlashDuty' },
  { type: 'Flowtriq', name: 'Flowtriq' },
  { type: 'PagerTree', name: 'PagerTree' },
  { type: 'pinglet', name: 'Pinglet' },
  { type: 'plivo', name: 'Plivo' },
  { type: 'promosms', name: 'PromoSMS' },
  { type: 'pumble', name: 'Pumble' },
  { type: 'pushbullet', name: 'Pushbullet' },
  { type: 'PushByTechulus', name: 'Push by Techulus' },
  { type: 'PushDeer', name: 'PushDeer' },
  { type: 'pushover', name: 'Pushover' },
  { type: 'PushPlus', name: 'PushPlus' },
  { type: 'pushy', name: 'Pushy' },
  { type: 'rocket.chat', name: 'Rocket.Chat' },
  { type: 'serwersms', name: 'SerwerSMS.pl' },
  { type: 'signal', name: 'Signal' },
  { type: 'signalgrid', name: 'Signalgrid' },
  { type: 'SIGNL4', name: 'SIGNL4' },
  { type: 'SMSGateway', name: 'SMS Gateway' },
  { type: 'SMSManager', name: 'SmsManager (smsmanager.cz)' },
  { type: 'SMSPartner', name: 'SMS Partner' },
  { type: 'slack', name: 'Slack' },
  { type: 'squadcast', name: 'SquadCast' },
  { type: 'SMSEagle', name: 'SMSEagle' },
  { type: 'smtp', name: 'Email (SMTP)' },
  { type: 'MicrosoftGraph', name: 'Microsoft Graph Email' },
  { type: 'stackfield', name: 'Stackfield' },
  { type: 'teams', name: 'Microsoft Teams' },
  { type: 'telegram', name: 'Telegram' },
  { type: 'Teltonika', name: 'Teltonika SMS Gateway' },
  { type: 'telnyx', name: 'Telnyx' },
  { type: 'threema', name: 'Threema' },
  { type: 'twilio', name: 'Twilio' },
  { type: 'Splunk', name: 'Splunk' },
  { type: 'SpugPush', name: 'SpugPush' },
  { type: 'webhook', name: 'Webhook' },
  { type: 'WeCom', name: 'WeCom' },
  { type: 'GoAlert', name: 'GoAlert' },
  { type: 'ServerChan', name: 'ServerChan' },
  { type: 'ZohoCliq', name: 'ZohoCliq' },
  { type: 'SevenIO', name: 'SevenIO' },
  { type: 'whapi', name: 'WhatsApp (Whapi)' },
  { type: 'evolution', name: 'WhatsApp (Evolution)' },
  { type: 'openwa', name: 'WhatsApp (OpenWA)' },
  { type: 'notifery', name: 'Notifery' },
  { type: 'waha', name: 'WhatsApp (WAHA)' },
  { type: 'Whatsapp360messenger', name: 'WhatsApp (360messenger)' },
  { type: 'gtxmessaging', name: 'GtxMessaging' },
  { type: 'Cellsynt', name: 'Cellsynt' },
  { type: 'WPush', name: 'WPush (wpush.cn)' },
  { type: 'WxPusher', name: 'WxPusher SPT Push' },
  { type: 'SendGrid', name: 'SendGrid' },
  { type: 'TurboSMTP', name: 'TurboSMTP' },
  { type: 'Brevo', name: 'Brevo' },
  { type: 'Resend', name: 'Resend' },
  { type: 'YZJ', name: 'YZJ' },
  { type: 'SMSPlanet', name: 'SMSPlanet.pl' },
  { type: 'Webpush', name: 'Webpush' },
  { type: 'HaloPSA', name: 'Halo PSA' },
  { type: 'max', name: 'MAX Messenger' },
  { type: 'VK', name: 'VK' },
  { type: 'VKTeams', name: 'VKTeams' },
  { type: 'Milky', name: 'Milky (QQ)' },
];

export interface NotificationField {
  name: string;
  description: string;
}

interface NotificationTypeFields {
  required: NotificationField[];
  optional: NotificationField[];
  notes?: string[];
}

const f = (name: string, description: string): NotificationField => ({ name, description });

export const NOTIFICATION_TYPE_FIELDS: Record<string, NotificationTypeFields> = {
  slack: {
    required: [f('slackwebhookURL', 'Slack incoming webhook URL. A credential.')],
    optional: [
      f('slackchannel', 'Channel to post to, overriding the webhook default'),
      f('slackusername', 'Username the message is posted as'),
      f('slackiconemo', 'Emoji used as the icon, e.g. ":warning:"'),
      f('slackchannelnotify', 'Notify the channel (@channel) on each alert'),
      f('slackrichmessage', 'Send a rich message with action buttons'),
      f('slackIncludeGroupName', "Include the monitor's group in the message (default: true)"),
      f('slackUseTemplate', 'Use slackTemplate instead of the default message'),
      f('slackTemplate', 'LiquidJS template for the message'),
    ],
  },
  discord: {
    required: [f('discordWebhookUrl', 'Discord webhook URL. A credential.')],
    optional: [
      f('discordUsername', 'Bot display name (default: Uptime Kuma)'),
      f('discordPrefixMessage', 'Text put before each message, e.g. a role mention'),
      f('discordChannelType', '"postToThread" or "createNewForumPost"; omit for a normal channel'),
      f('threadId', 'Thread to post to (discordChannelType "postToThread")'),
      f('postName', 'Title of the forum post (discordChannelType "createNewForumPost")'),
      f('discordSuppressNotifications', 'Send without a push notification'),
      f('disableUrl', "Leave the monitor's URL out of the message"),
      f('discordUseMessageTemplate', 'Use discordMessageTemplate instead of the default message'),
      f('discordMessageTemplate', 'LiquidJS template for the message'),
    ],
  },
  ntfy: {
    required: [f('ntfyserverurl', 'ntfy server URL, e.g. https://ntfy.sh'), f('ntfytopic', 'Topic to publish to')],
    optional: [
      f('ntfyPriority', 'Priority 1-5 for alerts (default: 4)'),
      f('ntfyPriorityDown', 'Priority 1-5 used for DOWN alerts'),
      f('ntfyAuthenticationMethod', '"usernamePassword" or "accessToken"; omit for none'),
      f('ntfyusername', 'Username (ntfyAuthenticationMethod "usernamePassword")'),
      f('ntfypassword', 'Password (ntfyAuthenticationMethod "usernamePassword"). A credential.'),
      f('ntfyaccesstoken', 'Access token (ntfyAuthenticationMethod "accessToken"). A credential.'),
      f('ntfyIcon', 'URL of an icon shown with the notification'),
      f('ntfyCall', 'Phone number to call, sent as the X-Call header'),
      f('ntfyUseTemplate', 'Use ntfyCustomTitle and ntfyCustomMessage instead of the default text'),
      f('ntfyCustomTitle', 'LiquidJS template for the title'),
      f('ntfyCustomMessage', 'LiquidJS template for the message'),
    ],
  },
  telegram: {
    required: [
      f('telegramBotToken', 'Bot token from @BotFather. A credential.'),
      f('telegramChatID', 'Chat, group or channel ID to send to'),
    ],
    optional: [
      f('telegramMessageThreadID', 'Topic (thread) ID in a forum group'),
      f('telegramSendSilently', 'Send without a sound (default: false)'),
      f('telegramProtectContent', 'Block forwarding and saving (default: false)'),
      f('telegramServerUrl', 'Bot API server (default: https://api.telegram.org)'),
      f('telegramUseTemplate', 'Use telegramTemplate instead of the default message'),
      f('telegramTemplate', 'LiquidJS template for the message'),
      f('telegramTemplateParseMode', 'Parse mode for the template: "HTML", "MarkdownV2" or "plain"'),
    ],
  },
  webhook: {
    required: [f('webhookURL', 'URL the alert is sent to')],
    optional: [
      f('httpMethod', '"post" (default) or "get"; with get the data is sent as query parameters'),
      f('webhookContentType', '"json" (default), "form-data" or "custom"'),
      f('webhookCustomBody', 'LiquidJS template for the body (webhookContentType "custom")'),
      f('webhookAdditionalHeaders', 'Extra request headers, as a JSON object in a string. May hold credentials.'),
    ],
  },
  smtp: {
    required: [f('smtpHost', 'SMTP server hostname'), f('smtpFrom', 'From address')],
    optional: [
      f('smtpPort', 'SMTP port, e.g. 587, or 465 with smtpSecure'),
      f('smtpSecure', 'Connect with TLS from the start (port 465). false uses STARTTLS when offered.'),
      f('smtpIgnoreTLSError', 'Accept an invalid TLS certificate'),
      f('smtpUsername', 'Username, if the server needs authentication'),
      f('smtpPassword', 'Password, if the server needs authentication. A credential.'),
      f('smtpTo', 'Recipient addresses, comma-separated'),
      f('smtpCC', 'CC addresses, comma-separated'),
      f('smtpBCC', 'BCC addresses, comma-separated'),
      f('customSubject', 'LiquidJS template for the subject'),
      f('customBody', 'LiquidJS template for the body'),
      f('htmlBody', 'Send customBody as HTML'),
    ],
    notes: ['At least one of smtpTo, smtpCC and smtpBCC is needed for the mail to go anywhere.'],
  },
  teams: {
    required: [f('webhookUrl', 'Microsoft Teams workflow or incoming webhook URL. A credential.')],
    optional: [f('teamsEnableTags', "Include the monitor's tags in the card (default: false)")],
  },
  pushover: {
    required: [
      f('pushoveruserkey', 'Pushover user or group key. A credential.'),
      f('pushoverapptoken', 'Pushover application API token. A credential.'),
    ],
    optional: [
      f('pushoverdevice', 'Device name to send to; omit for all devices'),
      f('pushovertitle', 'Message title'),
      f('pushoverpriority', 'Priority from -2 to 2'),
      f('pushoversounds', 'Notification sound for DOWN alerts'),
      f('pushoversounds_up', 'Notification sound for UP alerts'),
      f('pushoverttl', 'Seconds before the message is deleted from devices'),
    ],
  },
  gotify: {
    required: [
      f('gotifyserverurl', 'Gotify server URL'),
      f('gotifyapplicationToken', 'Gotify application token. A credential.'),
    ],
    optional: [f('gotifyPriority', 'Message priority (default: 8)')],
  },
  matrix: {
    required: [
      f('homeserverUrl', 'Matrix homeserver URL, e.g. https://matrix.org'),
      f('internalRoomId', 'Internal room ID, e.g. !abc123:matrix.org'),
      f('accessToken', 'Access token of the sending account. A credential.'),
    ],
    optional: [
      f('matrixUseTemplate', 'Use matrixTemplate instead of the default message'),
      f('matrixTemplate', 'LiquidJS template for the message'),
    ],
  },
  PagerDuty: {
    required: [
      f('pagerdutyIntegrationUrl', 'Events API URL, normally https://events.pagerduty.com/v2/enqueue'),
      f('pagerdutyIntegrationKey', 'Integration (routing) key of the PagerDuty service. A credential.'),
    ],
    optional: [
      f('pagerdutyPriority', 'Severity: "info", "warning" (default), "error" or "critical"'),
      f('pagerdutyAutoResolve', 'What an UP does: "resolve", "acknowledge", or "0" to do nothing'),
    ],
  },
  Opsgenie: {
    required: [f('opsgenieApiKey', 'Opsgenie API integration key. A credential.')],
    optional: [f('opsgenieRegion', '"us" (default) or "eu"'), f('opsgeniePriority', 'Priority 1-5 (default: 3)')],
  },
  mattermost: {
    required: [f('mattermostWebhookUrl', 'Mattermost incoming webhook URL. A credential.')],
    optional: [
      f('mattermostusername', 'Username the message is posted as (default: Uptime Kuma)'),
      f('mattermostchannel', 'Channel to post to, overriding the webhook default'),
      f('mattermosticonemo', 'Emoji used as the icon'),
      f('mattermosticonurl', 'URL of an image used as the icon'),
    ],
  },
  signal: {
    required: [
      f('signalURL', 'signal-cli-rest-api send endpoint, e.g. http://host:8080/v2/send'),
      f('signalNumber', 'Sending phone number, with country code'),
      f('signalRecipients', 'Recipient numbers or group IDs, comma-separated'),
    ],
    optional: [
      f('signalUseTemplate', 'Use signalTemplate instead of the default message'),
      f('signalTemplate', 'LiquidJS template for the message'),
    ],
  },
  apprise: {
    required: [f('appriseURL', 'Apprise URL of the destination service. Usually holds a credential.')],
    optional: [f('title', 'Message title')],
    notes: ['Needs the apprise CLI installed where Uptime Kuma runs; the official Docker image includes it.'],
  },
  GoogleChat: {
    required: [f('googleChatWebhookURL', 'Google Chat space webhook URL. A credential.')],
    optional: [
      f('googleChatMaxRetries', 'Retries when rate-limited (default: 1, at most 10)'),
      f('googleChatUseTemplate', 'Use googleChatTemplate instead of the default message'),
      f('googleChatTemplate', 'LiquidJS template for the message'),
    ],
  },
  HomeAssistant: {
    required: [
      f('homeAssistantUrl', 'Home Assistant base URL'),
      f('longLivedAccessToken', 'Long-lived access token. A credential.'),
    ],
    optional: [f('notificationService', 'Name of the notify service to call (default: notify)')],
  },
  pushbullet: {
    required: [f('pushbulletAccessToken', 'Pushbullet access token. A credential.')],
    optional: [],
  },
  'rocket.chat': {
    required: [f('rocketwebhookURL', 'Rocket.Chat incoming webhook URL. A credential.')],
    optional: [
      f('rocketchannel', 'Channel to post to, overriding the webhook default'),
      f('rocketusername', 'Username the message is posted as'),
      f('rocketiconemo', 'Emoji used as the icon'),
    ],
  },
};

/** Fields every notification type takes, passed as arguments rather than inside config. */
export const COMMON_NOTIFICATION_FIELDS = ['name', 'isDefault', 'applyExisting'];

const KNOWN_TYPES = new Map(NOTIFICATION_TYPES.map((t) => [t.type, t]));
const BY_LOWERCASE = new Map(NOTIFICATION_TYPES.map((t) => [t.type.toLowerCase(), t.type]));

export const findNotificationType = (type: string) => KNOWN_TYPES.get(type);

/**
 * The exact spelling of a type given in the wrong case ("pagerduty", "Slack"), or undefined
 * when the type is spelled right or matches nothing. Uptime Kuma looks a provider up by its
 * exact name, so a wrong-case type saves a channel that can never send.
 */
export function miscasedNotificationType(type: string): string | undefined {
  if (KNOWN_TYPES.has(type)) return undefined;
  return BY_LOWERCASE.get(type.toLowerCase());
}

/** The documented required fields of `type` that `config` leaves out or leaves empty. */
export function missingNotificationFields(type: string, config: Record<string, unknown>): string[] {
  const fields = NOTIFICATION_TYPE_FIELDS[type];
  if (!fields) return [];
  return fields.required
    .map((field) => field.name)
    .filter((name) => {
      const value = config[name];
      return value === undefined || value === null || value === '';
    });
}

/**
 * A config key that is a required field of `type` in the wrong case (`slackWebhookUrl` for
 * `slackwebhookURL`), mapped to the right spelling. These are the misspellings that cost the
 * most: the channel saves and never sends.
 */
export function miscasedNotificationFields(type: string, config: Record<string, unknown>): Record<string, string> {
  const fields = NOTIFICATION_TYPE_FIELDS[type];
  if (!fields) return {};
  const byLower = new Map(
    [...fields.required, ...fields.optional].map((field) => [field.name.toLowerCase(), field.name])
  );
  const out: Record<string, string> = {};
  for (const key of Object.keys(config)) {
    const right = byLower.get(key.toLowerCase());
    if (right !== undefined && right !== key && !(right in config)) out[key] = right;
  }
  return out;
}
