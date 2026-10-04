// @vitest-environment node
import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { GoogleAuth, Impersonated } from 'google-auth-library';
import { describe, expect, it, vi } from 'vitest';
import { BODEGA_EVENT_ID, BODEGA_PREVIEW_HOSTS } from './provision-bodega-preview.mjs';
import { getApplicationDefaultAccessToken, verifyBodegaHostnameDocuments } from './verify-deploy-hostnames.mjs';

const routingDocument = (host) => ({
  name: `projects/fiveacross/databases/(default)/documents/hostnames/${host}`,
  fields: {
    eventId: { stringValue: BODEGA_EVENT_ID },
    status: { stringValue: 'active' },
  },
});

describe('Five Across deploy hostname verification', () => {
  it('obtains the deploy token through an impersonation-aware Google Auth client', async () => {
    const getAccessToken = vi.fn(async () => 'impersonated-access-token');
    const createAuth = vi.fn(() => ({ getAccessToken }));

    await expect(getApplicationDefaultAccessToken(createAuth)).resolves.toBe('impersonated-access-token');
    expect(createAuth).toHaveBeenCalledWith({
      scopes: ['https://www.googleapis.com/auth/datastore'],
    });
    expect(getAccessToken).toHaveBeenCalledOnce();
  });

  it('fails closed when deploy token acquisition never settles', async () => {
    vi.useFakeTimers();
    const createAuth = vi.fn(() => ({
      getAccessToken: vi.fn(() => new Promise(() => {})),
    }));

    try {
      const result = getApplicationDefaultAccessToken(createAuth, 10);
      const rejection = expect(result).rejects.toThrow(
        'Application Default Credentials access token acquisition timed out after 10 ms.',
      );

      await vi.advanceTimersByTimeAsync(10);
      await rejection;
    } finally {
      vi.useRealTimers();
    }
  });

  it('clears the deploy token timeout when credential acquisition settles normally', async () => {
    vi.useFakeTimers();
    const createAuth = vi.fn(() => ({
      getAccessToken: vi.fn(async () => 'impersonated-access-token'),
    }));

    try {
      await expect(getApplicationDefaultAccessToken(createAuth, 10)).resolves.toBe('impersonated-access-token');
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it('handles a credential rejection that arrives after the deploy token timeout', async () => {
    vi.useFakeTimers();
    let rejectAccessToken;
    const accessToken = new Promise((_, reject) => {
      rejectAccessToken = reject;
    });
    const createAuth = vi.fn(() => ({
      getAccessToken: vi.fn(() => accessToken),
    }));

    try {
      const result = getApplicationDefaultAccessToken(createAuth, 10);
      const rejection = expect(result).rejects.toThrow(
        'Application Default Credentials access token acquisition timed out after 10 ms.',
      );

      await vi.advanceTimersByTimeAsync(10);
      await rejection;
      rejectAccessToken(new Error('late credential failure'));
      await vi.advanceTimersByTimeAsync(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it('hard-stops the command after a token timeout even when transport handles remain active', () => {
    const moduleUrl = pathToFileURL(resolve('scripts/verify-deploy-hostnames.mjs')).href;
    const childSource = `
      import net from 'node:net';
      import {
        getApplicationDefaultAccessToken,
        runBodegaHostnameVerificationCommand,
      } from ${JSON.stringify(moduleUrl)};

      const server = net.createServer(() => {});
      await new Promise((resolveListen) => server.listen(0, '127.0.0.1', resolveListen));
      const socket = net.connect(server.address().port, '127.0.0.1');
      await new Promise((resolveConnect) => socket.once('connect', resolveConnect));

      await runBodegaHostnameVerificationCommand({
        projectId: 'fiveacross',
        acquireAccessToken: () => getApplicationDefaultAccessToken(
          () => ({ getAccessToken: () => new Promise(() => {}) }),
          20,
        ),
      });
    `;
    const result = spawnSync(process.execPath, ['--input-type=module', '--eval', childSource], {
      encoding: 'utf8',
      timeout: 1_000,
    });

    expect(result.error).toBeUndefined();
    expect(result.signal).toBeNull();
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('Application Default Credentials access token acquisition timed out after 20 ms.');
  });

  it('uses a Google Auth version that recognizes the wrapper impersonation credential shape', () => {
    const auth = new GoogleAuth({
      scopes: ['https://www.googleapis.com/auth/datastore'],
    });
    const client = auth.fromJSON({
      type: 'impersonated_service_account',
      service_account_impersonation_url:
        'https://iamcredentials.googleapis.com/v1/projects/-/serviceAccounts/firebase-deployer@fiveacross.iam.gserviceaccount.com:generateAccessToken',
      source_credentials: {
        type: 'authorized_user',
        client_id: 'fixture-client-id',
        client_secret: 'fixture-client-secret',
        refresh_token: 'fixture-refresh-token',
      },
    });

    expect(client).toBeInstanceOf(Impersonated);
  });

  it('fails closed when the command is not running under the explicit Five Across project', () => {
    const result = spawnSync(process.execPath, [resolve('scripts/verify-deploy-hostnames.mjs')], {
      encoding: 'utf8',
      env: { ...process.env, GOOGLE_CLOUD_PROJECT: 'gaycruisebingo' },
    });

    expect(result.status).toBe(1);
    expect(result.stderr).toContain('Five Across project');
  });

  it('rejects a project other than the Five Across production project before reading', async () => {
    const fetchImpl = vi.fn();

    await expect(
      verifyBodegaHostnameDocuments({
        projectId: 'gaycruisebingo',
        accessToken: 'test-access-token',
        fetchImpl,
      }),
    ).rejects.toThrow('Five Across project');

    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it.each(['missing', 'inactive', 'repointed', 'private-root', 'private-preview', 'invalid-preview', 'wrong-name'])('refuses deployment when the public projection is %s despite a valid canonical row', async (failure) => {
    const host = BODEGA_PREVIEW_HOSTS[0];
    const fetchImpl = vi.fn(async (url) => {
      const requestedHost = decodeURIComponent(new URL(url).pathname.split('/').at(-1));
      const row = routingDocument(requestedHost);
      if (url.includes('/publicHostnames/')) {
        if (failure === 'missing') return new Response('', { status: 404 });
        row.name = row.name.replace('/hostnames/', '/publicHostnames/');
        if (failure === 'wrong-name') row.name += '-other';
        if (failure === 'invalid-preview') row.fields.preview = { arrayValue: { values: [] } };
        if (failure === 'inactive') row.fields.status = { stringValue: 'disabled' };
        if (failure === 'repointed') row.fields.eventId = { stringValue: 'other-event' };
        if (failure === 'private-root') row.fields.operatorNote = { stringValue: 'private' };
        if (failure === 'private-preview') row.fields.preview = { mapValue: { fields: { privateEmail: { stringValue: 'private' } } } };
      }
      return Response.json(row);
    });
    await expect(verifyBodegaHostnameDocuments({ projectId: 'fiveacross', accessToken: 'test-access-token', fetchImpl })).rejects.toThrow(host);
  });

  it.each(['adultContent', 'edition', 'canonicalHost', 'preview', 'missing-field', 'extra-approved-field'])('refuses a public %s value that differs from the authoritative canonical projection', async (failure) => {
    const fetchImpl = vi.fn(async (url) => {
      const host = decodeURIComponent(new URL(url).pathname.split('/').at(-1));
      const row = routingDocument(host);
      Object.assign(row.fields, {
        adultContent: { booleanValue: true }, edition: { stringValue: 'fiveacross' },
        canonicalHost: { stringValue: 'bodega-bay.fiveacross.app' },
        preview: { mapValue: { fields: { eventName: { stringValue: 'Bodega' }, days: { arrayValue: { values: [{ mapValue: { fields: { futureDisplayMetadata: { stringValue: 'preserved' } } } }] } } } } },
      });
      if (url.includes('/publicHostnames/')) {
        row.name = row.name.replace('/hostnames/', '/publicHostnames/');
        if (failure === 'adultContent') row.fields.adultContent.booleanValue = false;
        if (failure === 'edition') row.fields.edition.stringValue = 'vacay';
        if (failure === 'canonicalHost') row.fields.canonicalHost.stringValue = 'wrong.example';
        if (failure === 'preview') row.fields.preview.mapValue.fields.eventName.stringValue = 'Stale';
        if (failure === 'missing-field') delete row.fields.adultContent;
        if (failure === 'extra-approved-field') row.fields.slug = { stringValue: 'invented' };
      } else {
        row.fields.privateRecovery = { stringValue: 'secret' };
        row.fields.preview.mapValue.fields.internalNote = { stringValue: 'secret' };
      }
      return Response.json(row);
    });
    await expect(verifyBodegaHostnameDocuments({ projectId: 'fiveacross', accessToken: 'test-access-token', fetchImpl })).rejects.toThrow(/projection.*match/i);
  });

  it('accepts exact full projections with reordered map keys and unchanged nested days values', async () => {
    const fetchImpl = vi.fn(async url => {
      const host = decodeURIComponent(new URL(url).pathname.split('/').at(-1));
      const row = routingDocument(host);
      Object.assign(row.fields, {
        canonicalHost: { stringValue: 'bodega-bay.fiveacross.app' }, edition: { stringValue: 'fiveacross' },
        adultContent: { booleanValue: true }, slug: { stringValue: 'bodega-bay' }, isCanonical: { booleanValue: false },
        preview: { mapValue: { fields: {
          eventName: { stringValue: 'Quoted “Bodega”\nBay' }, dateRange: { stringValue: 'Aug 7–9' }, hostedBy: { stringValue: 'Kim' },
          days: { arrayValue: { values: [{ mapValue: { fields: { index: { integerValue: '3' }, optionalLabel: { nullValue: null }, observedAt: { timestampValue: '2026-08-07T06:00:00.000000001Z' }, futureDisplayMetadata: { mapValue: { fields: { label: { stringValue: 'preserved' } } } } } } }] } },
        } } },
      });
      if (url.includes('/publicHostnames/')) {
        row.name = row.name.replace('/hostnames/', '/publicHostnames/');
        row.fields = Object.fromEntries(Object.entries(row.fields).reverse());
        row.fields.preview.mapValue.fields = Object.fromEntries(Object.entries(row.fields.preview.mapValue.fields).reverse());
      } else {
        row.fields.pathNamespace = { stringValue: 'fiveacross.app' };
        row.fields.preview.mapValue.fields.internalNote = { stringValue: 'private' };
      }
      return Response.json(row);
    });
    await expect(verifyBodegaHostnameDocuments({ projectId: 'fiveacross', accessToken: 'test-access-token', fetchImpl })).resolves.toEqual(BODEGA_PREVIEW_HOSTS);
    expect(fetchImpl.mock.calls.every(([url]) => !new URL(url).search)).toBe(true);
  });

  it('reads every serving Bodega host in canonical inventory order', async () => {
    const fetchImpl = vi.fn(async (url, options) => {
      const host = BODEGA_PREVIEW_HOSTS[Math.floor((fetchImpl.mock.calls.length - 1) / 2)];
      expect(url).toContain('/v1/projects/fiveacross/databases/(default)/documents/');
      expect(options.headers).toEqual({
        Authorization: 'Bearer test-access-token',
      });
      expect(options.signal).toBeInstanceOf(AbortSignal);
      const row = routingDocument(host);
      row.fields.preview = { mapValue: { fields: { eventName: { stringValue: 'Bodega' }, days: { arrayValue: { values: [] } } } } };
      if (url.includes('/publicHostnames/')) {
        row.name = row.name.replace('/hostnames/', '/publicHostnames/');
      }
      return new Response(JSON.stringify(row), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    });

    await expect(
      verifyBodegaHostnameDocuments({
        projectId: 'fiveacross',
        accessToken: 'test-access-token',
        fetchImpl,
      }),
    ).resolves.toEqual(BODEGA_PREVIEW_HOSTS);

    expect(fetchImpl.mock.calls.map(([url]) => decodeURIComponent(url))).toEqual(
      BODEGA_PREVIEW_HOSTS.flatMap((host) => [
        `https://firestore.googleapis.com/v1/projects/fiveacross/databases/(default)/documents/hostnames/${host}`,
        `https://firestore.googleapis.com/v1/projects/fiveacross/databases/(default)/documents/publicHostnames/${host}`,
      ]),
    );
  });

  it('fails closed when a serving hostname document is missing', async () => {
    const host = BODEGA_PREVIEW_HOSTS[0];
    const fetchImpl = vi.fn(
      async () =>
        new Response('secret response body', {
          status: 404,
        }),
    );

    await expect(
      verifyBodegaHostnameDocuments({
        projectId: 'fiveacross',
        accessToken: 'secret-access-token',
        fetchImpl,
      }),
    ).rejects.toThrow(`Hostname document is missing for ${host}.`);
  });

  it('fails closed without exposing a malformed document body', async () => {
    const host = BODEGA_PREVIEW_HOSTS[0];
    const fetchImpl = vi.fn(async () => new Response('secret malformed body', { status: 200 }));

    await expect(
      verifyBodegaHostnameDocuments({
        projectId: 'fiveacross',
        accessToken: 'secret-access-token',
        fetchImpl,
      }),
    ).rejects.toThrow(`Hostname document is malformed for ${host}.`);
  });

  it('fails closed when a hostname response does not match the requested document schema', async () => {
    const host = BODEGA_PREVIEW_HOSTS[0];
    const malformedDocument = {
      name: 'projects/fiveacross/databases/(default)/documents/hostnames/different-host.example',
      fields: { status: { stringValue: 'active' } },
    };
    const fetchImpl = vi.fn(async () => Response.json(malformedDocument));

    await expect(
      verifyBodegaHostnameDocuments({
        projectId: 'fiveacross',
        accessToken: 'test-access-token',
        fetchImpl,
      }),
    ).rejects.toThrow(`Hostname document is malformed for ${host}.`);
  });

  it('fails closed when a serving hostname is inactive', async () => {
    const host = BODEGA_PREVIEW_HOSTS[0];
    const document = routingDocument(host);
    document.fields.status.stringValue = 'disabled';
    const fetchImpl = vi.fn(async () => Response.json(document));

    await expect(
      verifyBodegaHostnameDocuments({
        projectId: 'fiveacross',
        accessToken: 'test-access-token',
        fetchImpl,
      }),
    ).rejects.toThrow(`Hostname document is not active for ${host}.`);
  });

  it('fails closed when a serving hostname resolves to another Event', async () => {
    const host = BODEGA_PREVIEW_HOSTS[0];
    const document = routingDocument(host);
    document.fields.eventId.stringValue = 'another-event';
    const fetchImpl = vi.fn(async () => Response.json(document));

    await expect(
      verifyBodegaHostnameDocuments({
        projectId: 'fiveacross',
        accessToken: 'test-access-token',
        fetchImpl,
      }),
    ).rejects.toThrow(`Hostname document resolves to the wrong Event for ${host}.`);
  });

  it('fails closed on project or authorization failure without exposing credentials or response data', async () => {
    const host = BODEGA_PREVIEW_HOSTS[0];
    const fetchImpl = vi.fn(async () => new Response('secret response body', { status: 403 }));

    let caught;
    try {
      await verifyBodegaHostnameDocuments({
        projectId: 'fiveacross',
        accessToken: 'secret-access-token',
        fetchImpl,
      });
    } catch (error) {
      caught = error;
    }

    expect(caught).toEqual(new Error(`Hostname document read failed for ${host} (HTTP 403).`));
    expect(caught.message).not.toContain('secret-access-token');
    expect(caught.message).not.toContain('secret response body');
  });

  it('fails closed without exposing details from a failed HTTP boundary', async () => {
    const host = BODEGA_PREVIEW_HOSTS[0];
    const fetchImpl = vi.fn(async () => {
      throw new Error('transport included secret-access-token and document data');
    });

    await expect(
      verifyBodegaHostnameDocuments({
        projectId: 'fiveacross',
        accessToken: 'secret-access-token',
        fetchImpl,
      }),
    ).rejects.toThrow(`Hostname document read failed for ${host}.`);
  });
});
