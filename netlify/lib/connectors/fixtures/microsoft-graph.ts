/**
 * Microsoft Graph v1.0 responses, recorded from a test mailbox and trimmed
 * (ids shortened, addresses replaced). Used by microsoft.test.ts.
 */

export const ME = { "@odata.context": "https://graph.microsoft.com/v1.0/$metadata#users(mail,userPrincipalName)/$entity", mail: "jordan@contoso.example", userPrincipalName: "jordan@contoso.example" };

export const FOLDERS: Record<string, { id: string }> = {
  inbox: { id: "AAMk-inbox" },
  sentitems: { id: "AAMk-sent" },
  drafts: { id: "AAMk-drafts" },
  deleteditems: { id: "AAMk-deleted" },
  junkemail: { id: "AAMk-junk" },
  archive: { id: "AAMk-archive" },
};

export const FOLDER_LIST = {
  value: [
    { id: "AAMk-inbox", displayName: "Inbox" },
    { id: "AAMk-sent", displayName: "Sent Items" },
    { id: "AAMk-deleted", displayName: "Deleted Items" },
    { id: "AAMk-receipts", displayName: "Receipts" },
  ],
};

const addr = (name: string, address: string) => ({ emailAddress: { name, address } });

/** /me/messages?$filter=receivedDateTime ge …&$orderby=receivedDateTime desc: newest first, one page with more after it. */
export const RECENT_PAGE_1 = {
  value: [
    {
      id: "msg-3",
      conversationId: "conv-A",
      subject: "RE: Budget for Q1",
      from: addr("Priya Shah", "priya@contoso.example"),
      toRecipients: [addr("Jordan", "jordan@contoso.example")],
      ccRecipients: [],
      receivedDateTime: "2026-11-06T09:30:00Z",
      bodyPreview: "Works for me. Let's lock it in on Friday.",
      isRead: false,
      isDraft: false,
      parentFolderId: "AAMk-inbox",
      flag: { flagStatus: "flagged" },
      importance: "high",
      inferenceClassification: "focused",
      categories: ["Finance"],
      webLink: "https://outlook.office365.com/owa/?ItemID=msg-3&exvsurl=1&viewmodel=ReadMessageItem",
      hasAttachments: true,
    },
    {
      id: "msg-junk",
      conversationId: "conv-J",
      subject: "You won",
      from: addr("Prize", "win@spam.example"),
      receivedDateTime: "2026-11-06T08:00:00Z",
      bodyPreview: "Claim now",
      isRead: false,
      isDraft: false,
      parentFolderId: "AAMk-junk",
      webLink: "https://outlook.office365.com/owa/?ItemID=msg-junk",
    },
    {
      id: "msg-draft",
      conversationId: "conv-D",
      subject: "half-written",
      receivedDateTime: "2026-11-06T07:00:00Z",
      isDraft: true,
      parentFolderId: "AAMk-drafts",
    },
  ],
  "@odata.nextLink": "https://graph.microsoft.com/v1.0/me/messages?$skip=3&$filter=receivedDateTime+ge+2026-11-04T10%3a00%3a00.000Z",
};

export const RECENT_PAGE_2 = {
  value: [
    {
      id: "msg-2",
      conversationId: "conv-A",
      subject: "Budget for Q1",
      from: addr("Jordan", "jordan@contoso.example"),
      toRecipients: [addr("Priya Shah", "priya@contoso.example")],
      receivedDateTime: "2026-11-05T17:00:00Z",
      bodyPreview: "How about £40k?",
      isRead: true,
      isDraft: false,
      parentFolderId: "AAMk-sent",
      webLink: "https://outlook.office365.com/owa/?ItemID=msg-2",
    },
    {
      id: "msg-9",
      conversationId: "conv-B",
      subject: "Your order has been dispatched",
      from: addr("Shop", "orders@shop.example"),
      toRecipients: [addr("", "jordan@contoso.example")],
      receivedDateTime: "2026-11-05T12:00:00Z",
      bodyPreview: "Tracking number 1Z999",
      isRead: true,
      isDraft: false,
      parentFolderId: "AAMk-inbox",
      inferenceClassification: "other",
      webLink: "https://outlook.office365.com/owa/?ItemID=msg-9",
    },
  ],
};

/** /me/messages?$filter=conversationId eq 'conv-A' with Prefer: outlook.body-content-type="text" (Graph's order isn't by date). */
export const CONVERSATION_A = {
  value: [
    {
      ...RECENT_PAGE_1.value[0],
      body: {
        contentType: "text",
        content:
          "Works for me. Let's lock it in on Friday.\r\n\r\nPriya\r\n\r\n________________________________\r\nFrom: Jordan <jordan@contoso.example>\r\nSent: Thursday, November 5, 2026 5:00 PM\r\nTo: Priya Shah <priya@contoso.example>\r\nSubject: Budget for Q1\r\n\r\nHow about £40k?",
      },
      uniqueBody: { contentType: "text", content: "Works for me. Let's lock it in on Friday.\r\n\r\nPriya\r\n" },
    },
    {
      ...RECENT_PAGE_2.value[0],
      body: { contentType: "text", content: "How about £40k?\r\n\r\nOn Wed, 4 Nov 2026 at 10:00, Priya Shah <priya@contoso.example> wrote:\r\n> What should the Q1 budget be?\r\n" },
      uniqueBody: null,
    },
    { id: "msg-draft-A", conversationId: "conv-A", isDraft: true, receivedDateTime: "2026-11-06T10:00:00Z", parentFolderId: "AAMk-drafts" },
  ],
};

export const ATTACHMENTS_MSG_3 = {
  value: [
    { "@odata.type": "#microsoft.graph.fileAttachment", name: "Q1 budget.xlsx", isInline: false },
    { "@odata.type": "#microsoft.graph.fileAttachment", name: "image001.png", isInline: true },
  ],
};

/** /me/calendar/calendarView: a weekly standup expanded into occurrences, an all-day event and an out-of-office block. */
export const CALENDAR_VIEW = {
  value: [
    {
      id: "evt-standup-1",
      subject: "Standup",
      bodyPreview: "",
      start: { dateTime: "2026-11-09T09:00:00.0000000", timeZone: "UTC" },
      end: { dateTime: "2026-11-09T09:15:00.0000000", timeZone: "UTC" },
      isAllDay: false,
      isCancelled: false,
      showAs: "busy",
      type: "occurrence",
      seriesMasterId: "evt-standup",
      location: { displayName: "Teams" },
      organizer: addr("Priya Shah", "priya@contoso.example"),
      isOrganizer: false,
      attendees: [
        { type: "required", status: { response: "accepted" }, ...addr("Priya Shah", "priya@contoso.example") },
        { type: "required", status: { response: "tentativelyAccepted" }, ...addr("Jordan", "jordan@contoso.example") },
        { type: "resource", status: { response: "accepted" }, ...addr("Room 4", "room4@contoso.example") },
      ],
      responseStatus: { response: "tentativelyAccepted" },
      onlineMeeting: { joinUrl: "https://teams.microsoft.com/l/meetup-join/abc" },
      webLink: "https://outlook.office365.com/owa/?itemid=evt-standup-1",
    },
    {
      id: "evt-standup-2",
      subject: "Standup",
      start: { dateTime: "2026-11-16T09:00:00.0000000", timeZone: "UTC" },
      end: { dateTime: "2026-11-16T09:15:00.0000000", timeZone: "UTC" },
      type: "occurrence",
      seriesMasterId: "evt-standup",
      organizer: addr("Priya Shah", "priya@contoso.example"),
      responseStatus: { response: "accepted" },
      webLink: "https://outlook.office365.com/owa/?itemid=evt-standup-2",
    },
    {
      id: "evt-holiday",
      subject: "Bank holiday",
      start: { dateTime: "2026-11-10T00:00:00.0000000", timeZone: "UTC" },
      end: { dateTime: "2026-11-11T00:00:00.0000000", timeZone: "UTC" },
      isAllDay: true,
      showAs: "free",
      type: "singleInstance",
      isOrganizer: true,
      responseStatus: { response: "organizer" },
      webLink: "https://outlook.office365.com/owa/?itemid=evt-holiday",
    },
    {
      id: "evt-oof",
      subject: "Dentist",
      start: { dateTime: "2026-11-11T14:00:00.0000000", timeZone: "UTC" },
      end: { dateTime: "2026-11-11T15:00:00.0000000", timeZone: "UTC" },
      showAs: "oof",
      isOrganizer: true,
      responseStatus: { response: "organizer" },
    },
  ],
};

export const EVENT_DETAIL = {
  ...CALENDAR_VIEW.value[0],
  body: { contentType: "text", content: "Daily standup.\r\n\r\n\r\n\r\nJoin on Teams" },
  recurrence: null,
  hasAttachments: true,
  lastModifiedDateTime: "2026-11-01T08:00:00.1234567Z",
};

/** Token endpoint replies. */
export const TOKEN_RENEWED = { token_type: "Bearer", scope: "Mail.Read User.Read", expires_in: 3599, ext_expires_in: 3599, access_token: "at-new", refresh_token: "rt-new" };
export const TOKEN_INVALID_GRANT = {
  error: "invalid_grant",
  error_description:
    "AADSTS70008: The provided authorization code or refresh token has expired due to inactivity. Send a new interactive authorization request for this user and resource.\r\nTrace ID: 0000\r\nCorrelation ID: 0000\r\nTimestamp: 2026-11-06 10:00:00Z",
  error_codes: [70008],
};
export const TOKEN_SECRET_EXPIRED = {
  error: "invalid_client",
  error_description: "AADSTS7000222: The provided client secret keys for app '0000' are expired.\r\nTrace ID: 0000",
  error_codes: [7000222],
};

export const GRAPH_ACCESS_DENIED = { error: { code: "ErrorAccessDenied", message: "Access is denied. Check credentials and try again." } };
export const GRAPH_NOT_FOUND = { error: { code: "ErrorItemNotFound", message: "The specified object was not found in the store." } };
export const GRAPH_NO_MAILBOX = { error: { code: "MailboxNotEnabledForRESTAPI", message: "The mailbox is either inactive, soft-deleted, or is hosted on-premise." } };
export const GRAPH_THROTTLED = { error: { code: "ApplicationThrottled", message: "Application is over its MailboxConcurrency limit." } };
export const GRAPH_EXPIRED_TOKEN = { error: { code: "InvalidAuthenticationToken", message: "Lifetime validation failed, the token is expired." } };

/** Captured live on 7 Nov 2026 (request ids shortened): Graph with an unreadable token, and Entra's token endpoint refusing a malformed refresh. */
export const LIVE_GRAPH_401 = {
  error: { code: "InvalidAuthenticationToken", message: "Protocol 'Bearer' failed to validate because The token could not be read.", innerError: { date: "2026-11-07T00:14:19", "request-id": "be273010" } },
};
export const LIVE_TOKEN_MALFORMED = {
  error: "invalid_grant",
  error_description: "AADSTS9002313: Invalid request. Request is malformed or invalid. Trace ID: acb56c97 Correlation ID: 47d8d28b Timestamp: 2026-11-07 00:14:20Z",
  error_codes: [9002313],
  timestamp: "2026-11-07 00:14:20Z",
  error_uri: "https://login.microsoftonline.com/error?code=9002313",
};
