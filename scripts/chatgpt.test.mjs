import assert from 'node:assert/strict';
import { createHash, generateKeyPairSync, sign } from 'node:crypto';
import { test } from 'node:test';
import {
  ISSUER, REDIRECT_URI, RESOURCE, SCOPES, SafeError, buildAuthorizationUrl,
  createTransaction, credentialFromTokens, parseAdminToken, parseArgs,
  startCallbackListener, validateCallback, verifyIdToken,
} from './chatgpt.mjs';

const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const jwks = { keys: [{ ...publicKey.export({ format: 'jwk' }), kid: 'test-signing-key', alg: 'RS256', use: 'sig' }] };
const now = Date.now();
const expected = { clientId: 'oaiapp_test', nonce: 'test-nonce', now };
const claims = { iss: ISSUER, sub: 'test-subject', aud: expected.clientId, exp: Math.floor(now / 1000) + 3600, iat: Math.floor(now / 1000), nonce: expected.nonce, email: 'test@example.com' };

function signedToken(changes = {}, headerChanges = {}) {
  const header = Buffer.from(JSON.stringify({ alg: 'RS256', kid: 'test-signing-key', ...headerChanges })).toString('base64url');
  const payload = Buffer.from(JSON.stringify({ ...claims, ...changes })).toString('base64url');
  const data = `${header}.${payload}`;
  return `${data}.${sign('RSA-SHA256', Buffer.from(data), privateKey).toString('base64url')}`;
}

test('initial authorization uses dynamic registration with fresh PKCE and required plan scopes', () => {
  const transaction = createTransaction();
  const another = createTransaction();
  assert.notEqual(transaction.state, another.state);
  assert.notEqual(transaction.nonce, another.nonce);
  assert.equal(transaction.challenge, createHash('sha256').update(transaction.verifier).digest('base64url'));
  const url = new URL(buildAuthorizationUrl(transaction, 'urn:uuid:test'));
  assert.equal(url.origin, ISSUER);
  assert.equal(url.searchParams.get('client_id'), 'dynamic_agent_client');
  assert.equal(url.searchParams.get('agent_name_hint'), 'isobot');
  assert.equal(url.searchParams.get('ext_agent_host_id'), 'urn:uuid:test');
  assert.equal(url.searchParams.get('redirect_uri'), REDIRECT_URI);
  assert.equal(url.searchParams.get('resource'), RESOURCE);
  assert.deepEqual(url.searchParams.get('scope').split(' '), SCOPES);
});

test('returning sign-in reuses the issued registration and its account hints', () => {
  const transaction = createTransaction();
  const registration = { clientId: 'oaiapp_saved', idToken: 'secret-hint', email: 'test@example.com' };
  const url = new URL(buildAuthorizationUrl(transaction, 'urn:uuid:test', registration));
  assert.equal(url.searchParams.get('client_id'), registration.clientId);
  assert.equal(url.searchParams.get('id_token_hint'), registration.idToken);
  assert.equal(url.searchParams.get('login_hint'), registration.email);
  assert.equal(url.searchParams.has('agent_name_hint'), false);
  const signedOut = new URL(buildAuthorizationUrl(transaction, 'urn:uuid:test', { clientId: registration.clientId }));
  assert.equal(signedOut.searchParams.get('client_id'), registration.clientId);
  assert.equal(signedOut.searchParams.has('id_token_hint'), false);
});

test('callback rejects mismatched state, missing issued IDs, altered registrations, and errors', () => {
  const transaction = createTransaction();
  const callback = new URL(REDIRECT_URI);
  callback.search = new URLSearchParams({ code: 'test-code', state: transaction.state, client_id: 'oaiapp_test' });
  assert.deepEqual(validateCallback(callback, transaction), { code: 'test-code', clientId: 'oaiapp_test' });
  callback.searchParams.set('state', 'wrong-state');
  assert.throws(() => validateCallback(callback, transaction), SafeError);
  callback.searchParams.set('state', transaction.state);
  assert.throws(() => validateCallback(callback, transaction, { clientId: 'oaiapp_saved' }), SafeError);
  callback.searchParams.delete('client_id');
  assert.throws(() => validateCallback(callback, transaction), SafeError);
  assert.equal(validateCallback(callback, transaction, { clientId: 'oaiapp_saved' }).clientId, 'oaiapp_saved');
  callback.searchParams.set('error', 'access_denied');
  assert.throws(() => validateCallback(callback, transaction, { clientId: 'oaiapp_saved' }), SafeError);
  callback.searchParams.delete('error');
  callback.searchParams.set('client_id', 'dynamic_agent_client');
  assert.throws(() => validateCallback(callback, transaction), SafeError);
  assert.throws(() => validateCallback(callback, transaction, undefined, transaction.expiresAt), SafeError);
});

test('identity verification checks real signatures and rejects each invalid OIDC claim', () => {
  assert.deepEqual(verifyIdToken(signedToken(), jwks, expected), claims);
  for (const change of [
    { iss: 'https://example.com' }, { aud: 'oaiapp_other' }, { exp: now / 1000 - 60 },
    { nonce: 'other-nonce' }, { sub: '' }, { iat: now / 1000 + 60 }, { nbf: now / 1000 + 60 },
    { aud: [expected.clientId, 'oaiapp_other'] }, { azp: 'oaiapp_other' },
  ]) assert.throws(() => verifyIdToken(signedToken(change), jwks, expected), SafeError);
  assert.throws(() => verifyIdToken(signedToken({}, { alg: 'none' }), jwks, expected), SafeError);
  assert.throws(() => verifyIdToken(signedToken({}, { kid: 'unknown-key' }), jwks, expected), SafeError);
  const token = signedToken();
  const [header, payload, signature] = token.split('.');
  const tamperedPayload = Buffer.from(JSON.stringify({ ...claims, sub: 'other-subject' })).toString('base64url');
  assert.throws(() => verifyIdToken(`${header}.${tamperedPayload}.${signature}`, jwks, expected), SafeError);
});

test('credential import requires granted scopes and converts token expiry into milliseconds', () => {
  const tokens = { access_token: 'access-secret', refresh_token: 'refresh-secret', id_token: signedToken(), token_type: 'Bearer', scope: SCOPES.join(' '), expires_in: 3600 };
  const credential = credentialFromTokens(tokens, claims, expected.clientId, now);
  assert.equal(credential.expires, now + 3600000);
  assert.equal(credential.subject, claims.sub);
  assert.deepEqual(credential.scopes, SCOPES);
  assert.equal(credentialFromTokens({ ...tokens, earliest_refresh_at: Math.floor(now / 1000) + 3000 }, claims, expected.clientId, now).earliestRefreshAt, (Math.floor(now / 1000) + 3000) * 1000);
  assert.throws(() => credentialFromTokens({ ...tokens, earliest_refresh_at: 'invalid' }, claims, expected.clientId, now), SafeError);
  assert.throws(() => credentialFromTokens({ ...tokens, scope: 'openid profile email' }, claims, expected.clientId, now), SafeError);
  assert.throws(() => credentialFromTokens({ ...tokens, refresh_token: undefined }, claims, expected.clientId, now), SafeError);
  assert.throws(() => credentialFromTokens({ ...tokens, expires_in: -1 }, claims, expected.clientId, now), SafeError);
});

test('admin env parser reads only the dedicated token without evaluating other assignments', () => {
  const token = 'a'.repeat(48);
  assert.equal(parseAdminToken(`OTHER_SECRET=never-use-this\nexport CHATGPT_ADMIN_TOKEN='${token}'\n`), token);
  assert.throws(() => parseAdminToken('CHATGPT_ADMIN_TOKEN=too-short'), SafeError);
  assert.throws(() => parseAdminToken(`CHATGPT_ADMIN_TOKEN=${token}\nCHATGPT_ADMIN_TOKEN=${token}`), SafeError);
});

test('CLI options reject sending admin credentials over insecure non-local HTTP', () => {
  assert.equal(parseArgs(['status', '--worker', 'http://127.0.0.1:8787']).worker, 'http://127.0.0.1:8787');
  assert.equal(parseArgs(['model', 'gpt-test']).model, 'gpt-test');
  assert.equal(parseArgs(['workers-ai']).command, 'workers-ai');
  assert.throws(() => parseArgs(['login', '--worker', 'http://example.com']), SafeError);
  assert.throws(() => parseArgs(['login', '--worker', 'https://user:secret@example.com']), SafeError);
  assert.throws(() => parseArgs(['login', '--worker', 'https://example.com?token=secret']), SafeError);
  assert.throws(() => parseArgs(['model']), SafeError);
});

test('loopback launch keeps token hints out of the visible URL and rejects forged callback state', async () => {
  const transaction = createTransaction();
  const authorizationUrl = buildAuthorizationUrl(transaction, 'urn:uuid:test', { clientId: expected.clientId, idToken: 'retained-token-secret' });
  const listener = await startCallbackListener(transaction, { clientId: expected.clientId }, authorizationUrl);
  try {
    assert.equal(listener.launchUrl.includes('retained-token-secret'), false);
    const launch = await fetch(listener.launchUrl, { redirect: 'manual' });
    assert.equal(launch.status, 302);
    assert.equal(launch.headers.get('location'), authorizationUrl);
    const bad = await fetch(`${REDIRECT_URI}?code=forged&state=wrong-state`);
    assert.equal(bad.status, 400);
    const callback = await fetch(`${REDIRECT_URI}?${new URLSearchParams({ code: 'test-code', state: transaction.state })}`);
    assert.equal(callback.status, 200);
    assert.deepEqual(await listener.callback, { code: 'test-code', clientId: expected.clientId });
    const repeated = await fetch(`${REDIRECT_URI}?${new URLSearchParams({ code: 'test-code', state: transaction.state })}`);
    assert.equal(repeated.status, 410);
  } finally { listener.close(); }
});
