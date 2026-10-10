#!/usr/bin/env node
// Public-client flow: https://developers.openai.com/siwc/token-sharing-open-source/sign-in
import { createHash, createPublicKey, randomBytes, randomUUID, timingSafeEqual, verify } from 'node:crypto';
import { constants } from 'node:fs';
import { chmod, link, lstat, mkdir, open, rename, rm } from 'node:fs/promises';
import { createServer } from 'node:http';
import { dirname, join, resolve } from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

export const ISSUER = 'https://auth.openai.com';
export const RESOURCE = 'https://api.openai.com/v1';
export const REDIRECT_URI = 'http://127.0.0.1:1455/auth/callback';
export const SCOPES = ['openid', 'profile', 'email', 'offline_access', 'resource.invoke', 'chatgpt.tokens.use.direct'];
const DEFAULT_WORKER = 'https://isobot-pi.costream.workers.dev';
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const TIMEOUT_MS = 10 * 60 * 1000;

export class SafeError extends Error {}

const isObject = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const clientIdIsIssued = value => typeof value === 'string' && value !== 'dynamic_agent_client' && /^[A-Za-z0-9_.:-]{1,256}$/.test(value);
const nonempty = value => typeof value === 'string' && value.length > 0;
const equal = (a, b) => typeof a === 'string' && typeof b === 'string' && Buffer.byteLength(a) === Buffer.byteLength(b) && timingSafeEqual(Buffer.from(a), Buffer.from(b));

export function createTransaction() {
  const verifier = randomBytes(64).toString('base64url');
  return {
    verifier,
    challenge: createHash('sha256').update(verifier).digest('base64url'),
    state: randomBytes(32).toString('base64url'),
    nonce: randomBytes(32).toString('base64url'),
    redirectUri: REDIRECT_URI,
    expiresAt: Date.now() + TIMEOUT_MS,
  };
}

export function buildAuthorizationUrl(transaction, hostId, registration, authorizationEndpoint = `${ISSUER}/api/accounts/authorize`) {
  const url = new URL(authorizationEndpoint);
  url.search = new URLSearchParams({
    client_id: registration?.clientId ?? 'dynamic_agent_client',
    ext_agent_host_id: hostId,
    response_type: 'code',
    redirect_uri: transaction.redirectUri,
    scope: SCOPES.join(' '),
    resource: RESOURCE,
    state: transaction.state,
    nonce: transaction.nonce,
    code_challenge_method: 'S256',
    code_challenge: transaction.challenge,
  }).toString();
  if (registration) {
    if (registration.idToken) url.searchParams.set('id_token_hint', registration.idToken);
    if (registration.email) url.searchParams.set('login_hint', registration.email);
  } else {
    url.searchParams.set('agent_name_hint', 'isobot');
  }
  return url.toString();
}

export function validateCallback(url, transaction, registration, now = Date.now()) {
  const params = new URL(url).searchParams;
  if (params.getAll('state').length !== 1 || !equal(params.get('state'), transaction.state)) {
    throw new SafeError('The sign-in callback state did not match.');
  }
  if (now >= transaction.expiresAt) throw new SafeError('The sign-in attempt expired. Run login again.');
  for (const key of ['code', 'client_id', 'error']) {
    if (params.getAll(key).length > 1) throw new SafeError('The sign-in callback was invalid.');
  }
  if (params.has('error')) throw new SafeError('ChatGPT authorization was declined or failed. Run login again to authorize plan usage.');
  const code = params.get('code');
  if (!nonempty(code) || code.length > 8192) throw new SafeError('The sign-in callback did not contain a valid code.');
  const suppliedClientId = params.get('client_id');
  const clientId = suppliedClientId ?? registration?.clientId;
  if (!clientIdIsIssued(clientId)) throw new SafeError('Registration did not return an issued client ID. Run login again.');
  if (registration && clientId !== registration.clientId) throw new SafeError('The sign-in callback changed the selected registration.');
  return { code, clientId };
}

// OpenAI currently advertises RS256. Pin it instead of accepting token-selected algorithms.
export function verifyIdToken(idToken, jwks, { clientId, nonce, issuer = ISSUER, now = Date.now() }) {
  try {
    if (typeof idToken !== 'string' || idToken.length > 65536) throw new Error();
    const segments = idToken.split('.');
    if (segments.length !== 3 || segments.some(value => !/^[A-Za-z0-9_-]+$/.test(value))) throw new Error();
    const header = JSON.parse(Buffer.from(segments[0], 'base64url').toString('utf8'));
    if (!isObject(header) || header.alg !== 'RS256' || !nonempty(header.kid) || header.crit !== undefined) throw new Error();
    const keys = jwks?.keys?.filter(key => key.kid === header.kid && key.kty === 'RSA' && (!key.alg || key.alg === 'RS256') && (!key.use || key.use === 'sig') && (!key.key_ops || key.key_ops.includes('verify')));
    if (keys?.length !== 1) throw new Error();
    const key = createPublicKey({ key: keys[0], format: 'jwk' });
    if (!verify('RSA-SHA256', Buffer.from(`${segments[0]}.${segments[1]}`), key, Buffer.from(segments[2], 'base64url'))) throw new Error();
    const claims = JSON.parse(Buffer.from(segments[1], 'base64url').toString('utf8'));
    const seconds = now / 1000;
    const audience = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
    if (!isObject(claims) || claims.iss !== issuer || !audience.includes(clientId)) throw new Error();
    if (audience.length > 1 && claims.azp !== clientId) throw new Error();
    if (claims.azp !== undefined && claims.azp !== clientId) throw new Error();
    if (!Number.isFinite(claims.exp) || claims.exp <= seconds - 5) throw new Error();
    if (!Number.isFinite(claims.iat) || claims.iat > seconds + 5) throw new Error();
    if (claims.nbf !== undefined && (!Number.isFinite(claims.nbf) || claims.nbf > seconds + 5)) throw new Error();
    if (!nonempty(claims.sub) || !equal(claims.nonce, nonce)) throw new Error();
    if (claims.email !== undefined && typeof claims.email !== 'string') throw new Error();
    return claims;
  } catch {
    throw new SafeError('OpenAI identity-token validation failed. No credentials were imported.');
  }
}

export function credentialFromTokens(tokens, identity, clientId, now = Date.now()) {
  if (!isObject(tokens) || !nonempty(tokens.access_token) || !nonempty(tokens.refresh_token) || !nonempty(tokens.id_token) || typeof tokens.token_type !== 'string' || tokens.token_type.toLowerCase() !== 'bearer') {
    throw new SafeError('OpenAI did not return complete subscription credentials.');
  }
  const scopes = typeof tokens.scope === 'string' ? [...new Set(tokens.scope.split(/\s+/).filter(Boolean))] : [];
  if (!SCOPES.every(scope => scopes.includes(scope))) {
    throw new SafeError('ChatGPT plan usage was not fully authorized. Run login again and grant the requested permissions.');
  }
  if (!Number.isFinite(tokens.expires_in) || tokens.expires_in <= 0 || tokens.expires_in > 365 * 86400) {
    throw new SafeError('OpenAI returned an invalid credential expiration.');
  }
  let earliestRefreshAt;
  if (tokens.earliest_refresh_at !== undefined) {
    const value = tokens.earliest_refresh_at;
    earliestRefreshAt = typeof value === 'number' ? (value < 1e12 ? value * 1000 : value)
      : typeof value === 'string' ? Date.parse(value) : NaN;
    if (!Number.isSafeInteger(earliestRefreshAt) || earliestRefreshAt <= 0) throw new SafeError('OpenAI returned an invalid refresh window.');
  }
  return {
    type: 'oauth', access: tokens.access_token, refresh: tokens.refresh_token,
    expires: now + tokens.expires_in * 1000, clientId, scopes,
    idToken: tokens.id_token, subject: identity.sub,
    ...(identity.email ? { email: identity.email } : {}),
    ...(earliestRefreshAt === undefined ? {} : { earliestRefreshAt }),
  };
}

export function parseAdminToken(contents) {
  const values = contents.split(/\r?\n/).flatMap(line => {
    const match = line.match(/^\s*(?:export\s+)?CHATGPT_ADMIN_TOKEN\s*=\s*(.*?)\s*$/);
    if (!match) return [];
    let value = match[1];
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) value = value.slice(1, -1);
    else value = value.replace(/\s+#.*$/, '').trim();
    return [value];
  });
  if (values.length !== 1 || !/^[\x21-\x7e]{32,4096}$/.test(values[0]) || /["'`\\]/.test(values[0])) {
    throw new SafeError('.env.chatgpt must contain one CHATGPT_ADMIN_TOKEN with at least 32 characters.');
  }
  return values[0];
}

async function readProtectedFile(path, optional = false) {
  let file;
  try {
    file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    const stat = await file.stat();
    if (!stat.isFile() || (stat.mode & 0o077) !== 0 || stat.size > 128 * 1024) throw new SafeError('ChatGPT local files must be regular files with owner-only permissions (chmod 600).');
    return await file.readFile('utf8');
  } catch (error) {
    if (optional && error?.code === 'ENOENT') return undefined;
    if (error instanceof SafeError) throw error;
    throw new SafeError('Could not read a protected ChatGPT local file. Check its path and permissions.');
  } finally {
    await file?.close();
  }
}

async function readRegistration(path, worker) {
  const contents = await readProtectedFile(path, true);
  if (contents === undefined) return undefined;
  let data;
  try { data = JSON.parse(contents); } catch { throw new SafeError('ChatGPT registration metadata is invalid.'); }
  if (!isObject(data) || !clientIdIsIssued(data.clientId) || data.issuer !== ISSUER || !nonempty(data.subject) || (data.idToken !== undefined && !nonempty(data.idToken))) {
    throw new SafeError('ChatGPT registration metadata is invalid.');
  }
  return data.worker === worker ? data : undefined;
}

async function ensureDirectory(path) {
  await mkdir(path, { recursive: true, mode: 0o700 });
  const stat = await lstat(path);
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new SafeError('The .chatgpt metadata path must be a directory.');
  await chmod(path, 0o700);
}

async function writeProtectedJson(path, value, exclusive = false) {
  const temporary = `${path}.${randomUUID()}.tmp`;
  try {
    const file = await open(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, 0o600);
    try { await file.writeFile(`${JSON.stringify(value, null, 2)}\n`); await file.sync(); } finally { await file.close(); }
    if (exclusive) await link(temporary, path);
    else await rename(temporary, path);
  } finally {
    await rm(temporary, { force: true });
  }
}

async function getHostId(directory) {
  await ensureDirectory(directory);
  const path = join(directory, 'host.json');
  const contents = await readProtectedFile(path, true);
  if (contents !== undefined) {
    let data;
    try { data = JSON.parse(contents); } catch { throw new SafeError('ChatGPT host metadata is invalid.'); }
    if (!/^urn:uuid:[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(data?.hostId)) throw new SafeError('ChatGPT host metadata is invalid.');
    return data.hostId;
  }
  const hostId = `urn:uuid:${randomUUID()}`;
  try {
    // Publish atomically without overwriting an ID assigned by a concurrent command.
    await writeProtectedJson(path, { hostId }, true);
    return hostId;
  } catch (error) {
    if (error?.code !== 'EEXIST') throw error;
    return getHostId(directory);
  }
}

async function fetchJson(url, init, failure) {
  let response;
  try { response = await fetch(url, { ...init, redirect: 'error', signal: AbortSignal.timeout(20000) }); }
  catch { throw new SafeError(`${failure} Check the network connection and try again.`); }
  if (!response.ok) throw new SafeError(`${failure} (HTTP ${response.status}).`);
  try { return await response.json(); } catch { throw new SafeError(`${failure} The server response was invalid.`); }
}

async function discovery() {
  const document = await fetchJson(`${ISSUER}/.well-known/openid-configuration`, undefined, 'OpenAI discovery failed.');
  if (document.issuer !== ISSUER || !document.id_token_signing_alg_values_supported?.includes('RS256')) throw new SafeError('OpenAI discovery returned an unsupported configuration.');
  for (const field of ['authorization_endpoint', 'token_endpoint', 'jwks_uri']) {
    let url;
    try { url = new URL(document[field]); } catch { throw new SafeError('OpenAI discovery returned an invalid endpoint.'); }
    if (url.origin !== ISSUER || url.username || url.password || url.hash) throw new SafeError('OpenAI discovery returned an untrusted endpoint.');
  }
  return document;
}

export async function startCallbackListener(transaction, registration, authorizationUrl) {
  const launchPath = `/auth/start/${randomBytes(24).toString('base64url')}`;
  let resolveCallback, rejectCallback, consumed = false, timer;
  const callback = new Promise((resolve, reject) => { resolveCallback = resolve; rejectCallback = reject; });
  const server = createServer((request, response) => {
    response.setHeader('Cache-Control', 'no-store');
    response.setHeader('Referrer-Policy', 'no-referrer');
    response.setHeader('Content-Security-Policy', "default-src 'none'");
    let url;
    try { url = new URL(request.url, transaction.redirectUri); } catch { response.writeHead(400).end('Invalid request.'); return; }
    if (request.method !== 'GET') { response.writeHead(405).end('GET required.'); return; }
    if (url.pathname === launchPath && !consumed) {
      response.writeHead(302, { Location: authorizationUrl }).end();
      return;
    }
    if (url.pathname !== '/auth/callback') { response.writeHead(404).end('Not found.'); return; }
    if (consumed) { response.writeHead(410).end('This sign-in attempt has ended.'); return; }
    if (!equal(url.searchParams.get('state'), transaction.state) || url.searchParams.getAll('state').length !== 1) {
      response.writeHead(400).end('The sign-in state did not match.');
      return;
    }
    consumed = true;
    clearTimeout(timer);
    try {
      const result = validateCallback(url, transaction, registration);
      response.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' }).end('Returned to isobot. Checking authorization in the terminal; you can close this tab.');
      resolveCallback(result);
    } catch (error) {
      response.writeHead(400, { 'Content-Type': 'text/plain; charset=utf-8' }).end('Sign-in did not complete. Return to the terminal.');
      rejectCallback(error);
    }
  });
  await new Promise((resolve, reject) => {
    server.once('error', error => reject(new SafeError(error.code === 'EACCES' || error.code === 'EPERM'
      ? 'The local callback listener was blocked. Run login from a terminal that permits listening on 127.0.0.1:1455.'
      : 'Could not listen on 127.0.0.1:1455. Stop another sign-in listener and retry.')));
    server.listen(1455, '127.0.0.1', resolve);
  });
  const interrupted = () => rejectCallback(new SafeError('ChatGPT sign-in was cancelled.'));
  process.once('SIGINT', interrupted);
  process.once('SIGTERM', interrupted);
  timer = setTimeout(() => rejectCallback(new SafeError('ChatGPT sign-in expired. Run login again.')), Math.max(1, transaction.expiresAt - Date.now()));
  return {
    callback,
    launchUrl: `http://127.0.0.1:1455${launchPath}`,
    close: () => {
      clearTimeout(timer);
      process.removeListener('SIGINT', interrupted);
      process.removeListener('SIGTERM', interrupted);
      server.close();
      server.closeAllConnections();
    },
  };
}

export function parseArgs(args) {
  const options = { command: undefined, worker: DEFAULT_WORKER, open: true, newAccount: false };
  const positional = [];
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--worker') {
      if (!args[i + 1] || args[i + 1].startsWith('--')) throw new SafeError('--worker needs a URL.');
      options.worker = args[++i];
    } else if (args[i] === '--no-open') options.open = false;
    else if (args[i] === '--new-account') options.newAccount = true;
    else if (args[i] === '--help' || args[i] === '-h') options.command = 'help';
    else if (args[i].startsWith('-')) throw new SafeError('Unknown option. Use --help for usage.');
    else positional.push(args[i]);
  }
  options.command ??= positional.shift() ?? 'help';
  if (options.command === 'model') options.model = positional.shift();
  if (!['help', 'login', 'status', 'disconnect', 'models', 'model', 'workers-ai'].includes(options.command) || positional.length || (options.command === 'model' && !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/.test(options.model ?? ''))) throw new SafeError('Invalid command. Use --help for usage.');
  if (options.newAccount && options.command !== 'login') throw new SafeError('--new-account is only available with login.');
  let worker;
  try { worker = new URL(options.worker); } catch { throw new SafeError('--worker needs a valid URL.'); }
  if (worker.username || worker.password || worker.search || worker.hash || (worker.protocol !== 'https:' && !(worker.protocol === 'http:' && ['127.0.0.1', 'localhost', '[::1]'].includes(worker.hostname)))) throw new SafeError('--worker must use HTTPS, or HTTP on a loopback address, without URL credentials.');
  options.worker = worker.toString().replace(/\/+$/, '');
  return options;
}

async function loadAdminToken() {
  const value = process.env.CHATGPT_ADMIN_TOKEN;
  if (value !== undefined) {
    if (!/^[\x21-\x7e]{32,4096}$/.test(value)) throw new SafeError('CHATGPT_ADMIN_TOKEN must contain at least 32 characters.');
    return value;
  }
  const contents = await readProtectedFile(join(ROOT, '.env.chatgpt'), true);
  if (contents === undefined) throw new SafeError('Set CHATGPT_ADMIN_TOKEN or create a mode-600 .env.chatgpt file before connecting.');
  return parseAdminToken(contents);
}

async function workerRequest(options, adminToken, path, method = 'GET', body) {
  return fetchJson(`${options.worker}/api/chatgpt/${path}`, {
    method, headers: { Authorization: `Bearer ${adminToken}`, Accept: 'application/json', ...(body ? { 'Content-Type': 'application/json' } : {}) },
    ...(body ? { body: JSON.stringify(body) } : {}),
  }, 'The isobot ChatGPT management request failed.');
}

function printStatus(data) {
  // Never dump upstream JSON: only these management fields may reach the terminal.
  const safe = {};
  for (const field of ['connected', 'reconnectRequired', 'selectedModel', 'expiresAt', 'revision', 'email']) {
    const value = data?.[field];
    if (['string', 'boolean', 'number'].includes(typeof value)) safe[field] = value;
  }
  console.log(JSON.stringify(safe, null, 2));
}

function openBrowser(url) {
  if (process.platform !== 'darwin') return;
  const child = spawn('open', [url], { stdio: 'ignore', detached: true });
  child.on('error', () => {});
  child.unref();
}

async function login(options, adminToken) {
  // Check deployment and admin authorization before asking the user to sign in.
  await workerRequest(options, adminToken, 'connection');
  const directory = join(ROOT, '.chatgpt');
  await getHostId(directory);
  const host = await workerRequest(options, adminToken, 'host');
  if (!/^urn:uuid:[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(host?.hostId)) {
    throw new SafeError('The remote Pi host identifier was invalid.');
  }
  const hostId = host.hostId;
  const registrationPath = join(directory, 'connection.json');
  const registration = options.newAccount ? undefined : await readRegistration(registrationPath, options.worker);
  const configuration = await discovery();
  const transaction = createTransaction();
  const authorizationUrl = buildAuthorizationUrl(transaction, hostId, registration, configuration.authorization_endpoint);
  const listener = await startCallbackListener(transaction, registration, authorizationUrl);
  try {
    // The actual URL can contain a retained ID-token hint. Keep it out of output and process arguments.
    console.log(`Continue with ChatGPT in your browser:\n${listener.launchUrl}\nWaiting up to 10 minutes for your sign-in.`);
    if (options.open) openBrowser(listener.launchUrl);
    const { code, clientId } = await listener.callback;
    const tokens = await fetchJson(configuration.token_endpoint, {
      method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
      body: new URLSearchParams({ grant_type: 'authorization_code', client_id: clientId, code, code_verifier: transaction.verifier, redirect_uri: transaction.redirectUri, resource: RESOURCE }),
    }, 'OpenAI code exchange failed. Run login again for a fresh authorization.');
    const jwks = await fetchJson(configuration.jwks_uri, undefined, 'OpenAI signing keys could not be loaded.');
    const identity = verifyIdToken(tokens.id_token, jwks, { clientId, nonce: transaction.nonce, issuer: configuration.issuer });
    if (registration && identity.sub !== registration.subject) throw new SafeError('The signed-in account differs from the selected registration. Use login --new-account to connect another account.');
    const credential = credentialFromTokens(tokens, identity, clientId);
    await workerRequest(options, adminToken, 'connection', 'PUT', { credential });
    // Only metadata and the verified ID-token hint are kept here. Access and refresh tokens belong to the credential DO.
    await writeProtectedJson(registrationPath, {
      issuer: identity.iss, clientId, subject: identity.sub,
      ...(identity.email ? { email: identity.email } : {}),
      idToken: tokens.id_token, worker: options.worker, remoteHostId: hostId, savedAt: new Date().toISOString(),
    });
    console.log('ChatGPT is connected. Run "npm run chatgpt -- models", then "npm run chatgpt -- model <slug>" to choose and activate an account model.');
  } finally { listener.close(); }
}

export async function main(args = process.argv.slice(2)) {
  const options = parseArgs(args);
  if (options.command === 'help') {
    console.log('Usage: npm run chatgpt -- <login|status|disconnect|models|model <slug>|workers-ai> [--worker URL]\nLogin options: --no-open --new-account\nRequires CHATGPT_ADMIN_TOKEN in the environment or a mode-600 .env.chatgpt file.');
    return;
  }
  const adminToken = await loadAdminToken();
  if (options.command === 'login') return login(options, adminToken);
  if (options.command === 'status') return printStatus(await workerRequest(options, adminToken, 'connection'));
  if (options.command === 'model') return printStatus(await workerRequest(options, adminToken, 'model', 'POST', { model: options.model }));
  if (options.command === 'workers-ai') return printStatus(await workerRequest(options, adminToken, 'workers-ai', 'POST'));
  if (options.command === 'models') {
    const data = await workerRequest(options, adminToken, 'models');
    const models = Array.isArray(data) ? data : data?.models ?? data?.data;
    if (!Array.isArray(models)) throw new SafeError('The account model list was invalid.');
    console.log(JSON.stringify(models.flatMap(model => {
      const id = typeof model === 'string' ? model : model?.id;
      return typeof id === 'string' && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/.test(id) ? [id] : [];
    }), null, 2));
    return;
  }
  const result = await workerRequest(options, adminToken, 'connection', 'DELETE');
  const registrationPath = join(ROOT, '.chatgpt', 'connection.json');
  const registration = await readRegistration(registrationPath, options.worker);
  if (registration) {
    // Signing out removes the account hint but retains the issued registration and stable host.
    const { idToken: _discardedIdToken, ...metadata } = registration;
    await writeProtectedJson(registrationPath, metadata);
  }
  console.log('ChatGPT is disconnected from isobot.');
  if (result?.revoked !== true) console.log('Remote revocation was not confirmed; disconnect isobot in ChatGPT Settings.');
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  main().catch(error => {
    console.error(error instanceof SafeError ? error.message : 'ChatGPT command failed. No credentials were printed; check the configuration and try again.');
    process.exitCode = 1;
  });
}
