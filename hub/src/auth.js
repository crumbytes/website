import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { createLocalJWKSet, jwtVerify } from 'jose';
import { writeAudit } from './audit.js';
import { one } from './db.js';

const token = (bytes = 32) => randomBytes(bytes).toString('base64url');
export const sha256 = value => createHash('sha256').update(value).digest('hex');
export const safeEqual = (a, b) => {
  const left = Buffer.from(sha256(String(a)));
  const right = Buffer.from(sha256(String(b)));
  return timingSafeEqual(left, right);
};

class LoginDenied extends Error {
  constructor(reason) {
    super(reason);
    this.reason = reason;
  }
}
export { LoginDenied };

// OpenID Connect authorization code flow with PKCE. The hub stores no staff
// passwords: identity and MFA stay with the identity provider, and only staff
// provisioned in advance can sign in.
export function createAuth({ db, config, fetchImpl = fetch, now = () => new Date() }) {
  const { oidc, session } = config;

  async function discover() {
    const response = await fetchImpl(`${oidc.issuer.replace(/\/$/, '')}/.well-known/openid-configuration`, { signal: AbortSignal.timeout(8000) });
    if (!response.ok) throw new LoginDenied('discovery_failed');
    const metadata = await response.json();
    if (metadata.issuer !== oidc.issuer) throw new LoginDenied('issuer_mismatch');
    return metadata;
  }

  return {
    async beginLogin() {
      const metadata = await discover();
      const state = token();
      const binding = token();
      const nonce = token();
      const verifier = token(48);
      await db.as('hub_auth', null, async tx => {
        await tx.query(`delete from hub.oidc_login_states where expires_at < $1`, [now()]);
        await tx.query(
          `insert into hub.oidc_login_states (state_hash, binding_hash, nonce, code_verifier, expires_at)
           values ($1, $2, $3, $4, $5)`,
          [sha256(state), sha256(binding), nonce, verifier, new Date(now().getTime() + 10 * 60 * 1000)]
        );
      });
      const url = new URL(metadata.authorization_endpoint);
      url.search = new URLSearchParams({
        response_type: 'code', client_id: oidc.clientId, redirect_uri: oidc.redirectUri, scope: 'openid email profile',
        state, nonce, code_challenge: createHash('sha256').update(verifier).digest('base64url'), code_challenge_method: 'S256'
      }).toString();
      return { redirectUrl: url.href, binding };
    },

    async completeLogin({ code, state, binding, requestId }) {
      try {
        if (!code || !state || !binding) throw new LoginDenied('missing_parameters');
        // Single use: the state row is gone whether or not the rest succeeds.
        const pending = await db.as('hub_auth', null, async tx => one(await tx.query(
          `delete from hub.oidc_login_states where state_hash = $1 and binding_hash = $2 and expires_at > $3
           returning nonce, code_verifier`, [sha256(state), sha256(binding), now()])));
        if (!pending) throw new LoginDenied('invalid_state');

        const metadata = await discover();
        const form = new URLSearchParams({
          grant_type: 'authorization_code', code, redirect_uri: oidc.redirectUri,
          client_id: oidc.clientId, code_verifier: pending.code_verifier
        });
        if (oidc.clientSecret) form.set('client_secret', oidc.clientSecret);
        const tokenResponse = await fetchImpl(metadata.token_endpoint, {
          method: 'POST', body: form, signal: AbortSignal.timeout(8000),
          headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' }
        });
        if (!tokenResponse.ok) throw new LoginDenied('token_exchange_failed');
        const { id_token: idToken } = await tokenResponse.json();
        if (typeof idToken !== 'string') throw new LoginDenied('missing_id_token');

        const jwks = await (await fetchImpl(metadata.jwks_uri, { signal: AbortSignal.timeout(8000) })).json();
        let claims;
        try {
          ({ payload: claims } = await jwtVerify(idToken, createLocalJWKSet(jwks), {
            issuer: oidc.issuer, audience: oidc.clientId, algorithms: ['RS256', 'ES256', 'PS256'],
            currentDate: now(), requiredClaims: ['sub', 'exp', 'iat']
          }));
        } catch {
          throw new LoginDenied('invalid_id_token');
        }
        if (claims.nonce !== pending.nonce) throw new LoginDenied('nonce_mismatch');
        if (oidc.requiredAmr && !(Array.isArray(claims.amr) && claims.amr.includes(oidc.requiredAmr))) {
          throw new LoginDenied('mfa_required');
        }
        return await db.as('hub_auth', null, tx => openSession(tx, claims, requestId));
      } catch (error) {
        if (!(error instanceof LoginDenied)) throw error;
        await db.as('hub_auth', null, tx => writeAudit(tx, {
          actorType: 'anonymous', action: 'auth.login', outcome: 'denied', requestId, metadata: { reason: error.reason }
        }));
        throw error;
      }
    },

    async resolveSession(rawToken) {
      if (!rawToken) return null;
      return db.as('hub_auth', null, async tx => {
        const row = one(await tx.query(
          `select s.id as session_id, s.csrf_token, s.last_seen_at, u.id, u.email, u.display_name, u.role
           from hub.staff_sessions s join hub.staff_users u on u.id = s.staff_id
           where s.token_hash = $1 and s.revoked_at is null and s.idle_expires_at > $2
             and s.absolute_expires_at > $2 and u.status = 'active'`,
          [sha256(rawToken), now()]));
        if (!row) return null;
        // Slide the idle window at most once a minute to limit write load.
        if (now().getTime() - new Date(row.last_seen_at).getTime() > 60000) {
          await tx.query(
            `update hub.staff_sessions set last_seen_at = $2, idle_expires_at = least($3, absolute_expires_at) where token_hash = $1`,
            [sha256(rawToken), now(), new Date(now().getTime() + session.idleMinutes * 60000)]);
        }
        return {
          staff: { id: row.id, email: row.email, display_name: row.display_name, role: row.role },
          csrfToken: row.csrf_token,
          sessionId: row.session_id
        };
      });
    },

    async logout(rawToken, staff, requestId) {
      await db.as('hub_auth', null, async tx => {
        await tx.query(`update hub.staff_sessions set revoked_at = $2 where token_hash = $1 and revoked_at is null`, [sha256(rawToken), now()]);
        await writeAudit(tx, { staffId: staff.id, action: 'auth.logout', requestId });
      });
    }
  };

  async function openSession(tx, claims, requestId) {
    let staff = one(await tx.query(
      `select id, status from hub.staff_users where oidc_issuer = $1 and oidc_subject = $2`, [oidc.issuer, claims.sub]));
    if (!staff) {
      // First sign-in binds the identity to the record an admin provisioned.
      if (claims.email_verified !== true || typeof claims.email !== 'string') throw new LoginDenied('email_not_verified');
      staff = one(await tx.query(
        `select id, status from hub.staff_users where email = $1 and oidc_subject is null`, [claims.email.toLowerCase()]));
      if (!staff) throw new LoginDenied('not_provisioned');
      await tx.query(`update hub.staff_users set oidc_issuer = $2, oidc_subject = $3 where id = $1`, [staff.id, oidc.issuer, claims.sub]);
    }
    if (staff.status !== 'active') throw new LoginDenied('staff_disabled');
    const raw = token();
    const issued = now();
    await tx.query(
      `insert into hub.staff_sessions (token_hash, staff_id, csrf_token, created_at, last_seen_at, idle_expires_at, absolute_expires_at, mfa_reported)
       values ($1, $2, $3, $4, $4, $5, $6, $7)`,
      [sha256(raw), staff.id, token(), issued, new Date(issued.getTime() + session.idleMinutes * 60000),
        new Date(issued.getTime() + session.absoluteMinutes * 60000),
        Array.isArray(claims.amr) && claims.amr.some(item => ['mfa', 'otp', 'hwk', 'swk', 'fido'].includes(item))]);
    await tx.query(`update hub.staff_users set last_login_at = $2 where id = $1`, [staff.id, issued]);
    await writeAudit(tx, { staffId: staff.id, action: 'auth.login', requestId });
    return { sessionToken: raw };
  }
}
