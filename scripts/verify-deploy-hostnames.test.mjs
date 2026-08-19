// @vitest-environment node
import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { BODEGA_EVENT_ID, BODEGA_PREVIEW_HOSTS } from './provision-bodega-preview.mjs';
import { verifyBodegaHostnameDocuments } from './verify-deploy-hostnames.mjs';

const routingDocument = (host) => ({
  name: `projects/fiveacross/databases/(default)/documents/hostnames/${host}`,
  fields: {
    eventId: { stringValue: BODEGA_EVENT_ID },
    status: { stringValue: 'active' },
  },
});

describe('Five Across deploy hostname verification', () => {
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

  it('reads every serving Bodega host in canonical inventory order', async () => {
    const fetchImpl = vi.fn(async (url, options) => {
      const host = BODEGA_PREVIEW_HOSTS[fetchImpl.mock.calls.length - 1];
      expect(url).toContain('/v1/projects/fiveacross/databases/(default)/documents/hostnames/');
      expect(options.headers).toEqual({ Authorization: 'Bearer test-access-token' });
      expect(options.signal).toBeInstanceOf(AbortSignal);
      return new Response(JSON.stringify(routingDocument(host)), {
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
      BODEGA_PREVIEW_HOSTS.map(
        (host) =>
          `https://firestore.googleapis.com/v1/projects/fiveacross/databases/(default)/documents/hostnames/${host}?mask.fieldPaths=eventId&mask.fieldPaths=status`,
      ),
    );
  });

  it('fails closed when a serving hostname document is missing', async () => {
    const host = BODEGA_PREVIEW_HOSTS[0];
    const fetchImpl = vi.fn(async () =>
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
