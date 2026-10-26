/**
 * Sending mail through Fastmail's JMAP API: the weekly email (weekly.js).
 *
 * Copied from the Tasks app (worker/jmap.js there, itself from the Japan planner),
 * which sends its morning digest this way, with two changes: the endpoint cache
 * lives in this Worker's CACHE, and the sender and recipients are WEEKLY_FROM and
 * WEEKLY_TO. Kept as a copy rather than shared, because the Workers deploy
 * independently and a shared file between them would be a build step none has.
 *
 * Chosen over an email provider so the digest goes out from the mailbox we
 * already pay for: no extra account, no DNS records on laurencekellett.co.uk,
 * and mail from our own domain that our own inbox already trusts.
 *
 * The flow is the standard JMAP one:
 *   1. GET /jmap/session          -> apiUrl + account id
 *   2. Identity/get + Mailbox/query -> who we send as, and where Drafts/Sent are
 *   3. Email/set + EmailSubmission/set in a single request: create the draft
 *      and submit it, then file the sent copy in Sent.
 *
 * Steps 1 and 2 are cached in KV for a day; they never change between sends.
 */

const SESSION_URL = 'https://api.fastmail.com/jmap/session';
const CACHE_KEY = 'jmap_endpoints_v1';
const CACHE_TTL = 60 * 60 * 24;

const CAPS = [
  'urn:ietf:params:jmap:core',
  'urn:ietf:params:jmap:mail',
  'urn:ietf:params:jmap:submission',
];

async function post(apiUrl, token, methodCalls) {
  const r = await fetch(apiUrl, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ using: CAPS, methodCalls }),
  });
  const body = await r.text();
  if (!r.ok) throw new Error(`JMAP ${r.status}: ${body.slice(0, 400)}`);
  let parsed;
  try { parsed = JSON.parse(body); } catch { throw new Error(`JMAP returned non-JSON: ${body.slice(0, 200)}`); }
  // A JMAP 200 can still carry per-method errors, which would otherwise look
  // like a clean send.
  for (const [name, res] of parsed.methodResponses || []) {
    if (name === 'error') throw new Error(`JMAP method error: ${JSON.stringify(res).slice(0, 300)}`);
  }
  return parsed;
}

function response(parsed, callId) {
  const hit = (parsed.methodResponses || []).find(m => m[2] === callId);
  return hit ? hit[1] : null;
}

async function discover(env, token, fromAddress) {
  const cached = await env.CACHE.get(CACHE_KEY, 'json');
  if (cached && cached.from === fromAddress) return cached;

  const sr = await fetch(SESSION_URL, { headers: { Authorization: `Bearer ${token}` } });
  if (!sr.ok) {
    throw new Error(`Fastmail session ${sr.status}: ${(await sr.text()).slice(0, 300)}` +
      (sr.status === 401 ? '. The FASTMAIL_TOKEN secret is missing, wrong, or lacks mail scope.' : ''));
  }
  const session = await sr.json();
  const accountId = session.primaryAccounts && session.primaryAccounts['urn:ietf:params:jmap:mail'];
  if (!accountId) throw new Error('No mail account on this Fastmail token.');

  const parsed = await post(session.apiUrl, token, [
    ['Identity/get', { accountId }, 'i'],
    ['Mailbox/query', { accountId, filter: { role: 'drafts' } }, 'd'],
    ['Mailbox/query', { accountId, filter: { role: 'sent' } }, 's'],
  ]);

  const identities = (response(parsed, 'i') || {}).list || [];
  // mayDelete is false on the account's own primary identity, which is the one
  // we want; aliases we can't actually send as are filtered out by Fastmail.
  const identity = identities.find(x => x.email.toLowerCase() === fromAddress.toLowerCase())
    || identities.find(x => x.email && !x.email.includes('+'))
    || identities[0];
  if (!identity) throw new Error('No sending identity available on this Fastmail account.');
  if (identity.email.toLowerCase() !== fromAddress.toLowerCase()) {
    throw new Error(`Fastmail has no identity for ${fromAddress}. ` +
      `Available: ${identities.map(x => x.email).join(', ')}. ` +
      `Set WEEKLY_FROM in wrangler.toml to one of those.`);
  }

  const draftsId = ((response(parsed, 'd') || {}).ids || [])[0];
  const sentId = ((response(parsed, 's') || {}).ids || [])[0];
  if (!draftsId) throw new Error('Could not find the Drafts mailbox.');

  const out = { apiUrl: session.apiUrl, accountId, identityId: identity.id,
                identityEmail: identity.email, identityName: identity.name || '', draftsId, sentId,
                from: fromAddress };
  await env.CACHE.put(CACHE_KEY, JSON.stringify(out), { expirationTtl: CACHE_TTL });
  return out;
}

/**
 * @param to  array of { name?, email }
 * @returns   the submission id, for logging
 */
export async function sendMail(env, { to, subject, html, text, headers }) {
  const token = env.FASTMAIL_TOKEN;
  if (!token) throw new Error('FASTMAIL_TOKEN is not set. Run: wrangler secret put FASTMAIL_TOKEN');
  if (!to || !to.length) throw new Error('No recipients configured. Set WEEKLY_TO in wrangler.toml.');

  const from = env.WEEKLY_FROM;
  if (!from) throw new Error('WEEKLY_FROM is not set in wrangler.toml.');

  const ep = await discover(env, token, from);

  const draft = {
    from: [{ name: ep.identityName || undefined, email: ep.identityEmail }],
    to,
    subject,
    keywords: { $draft: true },
    mailboxIds: { [ep.draftsId]: true },
    bodyValues: {
      text: { value: text, charset: 'utf-8' },
      html: { value: html, charset: 'utf-8' },
    },
    textBody: [{ partId: 'text', type: 'text/plain' }],
    htmlBody: [{ partId: 'html', type: 'text/html' }],
  };

  // Custom headers, for anything that needs to be filtered on rather than read. JMAP sets these
  // through a "header:Name:asText" property, the asText form because it lets the server handle
  // encoding and folding rather than this file having to get RFC 5322 right.
  for (const [name, value] of Object.entries(headers || {})) {
    draft[`header:${name}:asText`] = String(value);
  }

  // Mail to yourself is already in your mailbox once it is delivered, so filing a second copy in
  // Sent doubles it: same Message-ID, one copy in Inbox and one in Sent, and any threaded view
  // shows the pair. That is what "the digest arrived twice" turned out to be. When every recipient
  // is the sender, the local copy is destroyed after submission instead, leaving the delivered one.
  // For mail to anyone else the Sent copy is the point, and that path is unchanged.
  const selfOnly = to.every((t) => String(t.email || '').toLowerCase() === ep.identityEmail.toLowerCase());

  const submission = {
    accountId: ep.accountId,
    create: { send: { emailId: '#draft', identityId: ep.identityId } },
  };
  if (selfOnly) {
    // The submission is already queued by the time this runs, so destroying the draft cannot
    // unsend anything: it only removes the copy that would have become the duplicate.
    submission.onSuccessDestroyEmail = ['#send'];
  } else {
    // Once sent, drop the draft flag and move the copy from Drafts into Sent, so
    // the mailbox looks like any other message we sent by hand.
    const onSuccessUpdateEmail = { '#send': {
      [`mailboxIds/${ep.draftsId}`]: null,
      'keywords/$draft': null,
      'keywords/$seen': true,
    } };
    if (ep.sentId) onSuccessUpdateEmail['#send'][`mailboxIds/${ep.sentId}`] = true;
    submission.onSuccessUpdateEmail = onSuccessUpdateEmail;
  }

  const parsed = await post(ep.apiUrl, token, [
    ['Email/set', { accountId: ep.accountId, create: { draft } }, 'e'],
    ['EmailSubmission/set', submission, 's'],
  ]);

  const emailRes = response(parsed, 'e') || {};
  if (emailRes.notCreated && emailRes.notCreated.draft) {
    throw new Error(`Fastmail refused the draft: ${JSON.stringify(emailRes.notCreated.draft)}`);
  }
  const subRes = response(parsed, 's') || {};
  if (subRes.notCreated && subRes.notCreated.send) {
    throw new Error(`Fastmail refused to send: ${JSON.stringify(subRes.notCreated.send)}`);
  }
  return ((subRes.created || {}).send || {}).id || 'sent';
}

/** Clears the cached ids, after a token or identity change. */
export async function forgetEndpoints(env) {
  if (env.CACHE) await env.CACHE.delete(CACHE_KEY);
}
