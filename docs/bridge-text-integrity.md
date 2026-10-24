# Bridge text integrity contract

## Supported response payload

Task-context `publish_response` and ordinary conversation-v2 replies accept one
plain, user-visible text response of at most **1,200 UTF-16 code units**. This is
not 1,200 bytes or grapheme clusters: `中` uses one unit, `😀` uses two, and a
joined emoji can use several. Whitespace-only text, unpaired UTF-16 surrogates,
C0 controls other than TAB/CR/LF, DEL/C1 and explicit bidi embedding/isolate
controls are rejected before a response is accepted. Valid combining marks,
emoji modifiers, zero-width joiners, TAB, CR and LF are retained.

The SDK withholds unsupported text; direct source requests are rejected. No
response receipt or outgoing delivery is created for an invalid response.
There is no automatic truncation, summary, chunking, attachment conversion or
fallback to another context. Media, rich documents and replies over the limit
are unsupported by this contract. A provider host must surface withholding or
rejection rather than report successful synchronization. “Every response” is
an opt-in reporting category, not support for arbitrary lengths or formats.

## Channel formatting and receipts

Discord dedicated response cards escape Markdown and neutralize mention
syntax without cutting the escaped body. The worst case is 2,400 UTF-16 units,
plus two zero-width edge sentinels to keep supported edge whitespace inside
the embed rather than at its trim boundary. The description is at most 2,402
units; bounded title/footer plus description remain below the aggregate
6,000-unit embed budget. No message splitting occurs. `allowed_mentions` is
empty. Ordinary legacy task-view presentation remains separate from the
lossless dedicated response-body renderer.

QQ plain text contains the complete accepted body between a bounded source
header and optional receipt-specific instruction hint. Its 4,000-unit gateway
check is a **local bound**, not a verified official QQ maximum. A provider can
still reject content; known length errors remain `not_sent`, never `sent`.

Provider acceptance only establishes a valid provider receipt. It does not
prove exact provider rendering, visual equivalence, or recipient confirmation.
Discord documents provider-side Unicode/formatting changes; QQ does not echo
the delivered body. The local tests prove payload preservation and honest
receipt classification, not a live recipient readback.

## Commands, retries and idempotency

QQ command parsers remove optional whitespace before `/rivule` or
`/rivule-chat`, not inside or after the instruction. The entire extracted
instruction counts toward the same 1,200-unit limit, including its final LF.
The core preserves the exact accepted instruction for source claim.

One stable source response ID identifies one immutable response and receipt.
Identical retries reuse that receipt; changed content conflicts. Discord only
retries a known bounded rate-limit rejection, preserving the full logical
message. Unknown sends are not automatically retried. QQ known failures are
terminal for that receipt and unknown sends pause dispatch pending the
separate owner-review flow. There is no partial multi-chunk success state.

## Evidence

Offline tests cover real production render/dispatch, worst-case escaping,
Chinese and joined/modified emoji, whitespace, boundary rejection before
persistence, exact QQ commands, duplicate response IDs, Discord rate-limit
retry versus unknown no-retry, and the actual QQ HTTP length-rejection mapper.
No live channel messages or provider hooks were installed for these tests.

Official references checked during the audit:
- [Discord embed limits](https://docs.discord.com/developers/resources/message#embed-limits): description 4,096, aggregate embed text 6,000; edge whitespace trimming.
- [Discord Create Message](https://docs.discord.com/developers/resources/message#create-message): content limit and provider-side formatting/Unicode caveats.
- [QQ C2C send API](https://bot.q.qq.com/wiki/develop/api-v2/autogen/api/v2_users_user_openid_messages.post.html): plain text `msg_type: 0`, length-related errors without a published numeric text maximum on this page.
