#!/usr/bin/env node

import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { fetchPinnedPublicKey } from './public-key.mjs';

export const PIN_PUBLIC_KEY_USAGE =
  'node scripts/event-router-registry/pin-public-key.mjs ' +
  '--role=<publisher|recovery|source-attestor|regional-probe> ' +
  '--subject=<numeric-google-subject> --epoch-or-slot=<positive-decimal-or-reviewed-slot> ' +
  '--key-version=<exact-kms-version-resource> --kms-response=<path|->';

const ARGUMENTS = Object.freeze({
  '--role': 'role',
  '--subject': 'subject',
  '--epoch-or-slot': 'epochOrSlot',
  '--key-version': 'keyVersion',
  '--kms-response': 'kmsResponsePath',
});

export function parsePinPublicKeyArgs(args) {
  const parsed = {};
  for (const argument of args) {
    const separator = argument.indexOf('=');
    if (separator <= 0) throw new Error(`unknown argument: ${argument}`);
    const flag = argument.slice(0, separator);
    const field = ARGUMENTS[flag];
    if (field === undefined) throw new Error(`unknown argument: ${flag}`);
    if (Object.hasOwn(parsed, field)) throw new Error(`duplicate argument: ${flag}`);
    const value = argument.slice(separator + 1);
    if (value.length === 0 || /[\r\n\0]/.test(value)) throw new Error(`invalid argument: ${flag}`);
    parsed[field] = value;
  }
  const required = ['role', 'subject', 'epochOrSlot', 'keyVersion', 'kmsResponsePath'];
  for (const field of required) {
    if (!Object.hasOwn(parsed, field)) throw new Error(`missing argument: ${field}`);
  }
  return {
    request: {
      role: parsed.role,
      subject: parsed.subject,
      epochOrSlot: parsed.epochOrSlot,
      keyVersion: parsed.keyVersion,
    },
    kmsResponsePath: parsed.kmsResponsePath,
  };
}

function validateKmsPublicKeyResponse(response) {
  if (typeof response !== 'object' || response === null || Array.isArray(response)) {
    throw new Error('KMS getPublicKey response must be an object');
  }
  const required = ['name', 'algorithm', 'pem', 'pemCrc32c'];
  const allowed = new Set([...required, 'protectionLevel', 'publicKeyFormat']);
  const unknown = Object.keys(response).filter((field) => !allowed.has(field));
  if (unknown.length > 0) {
    throw new Error(`KMS getPublicKey response has unknown fields: ${unknown.sort().join(', ')}`);
  }
  if (required.some((field) => !Object.hasOwn(response, field))) {
    throw new Error(`KMS getPublicKey response requires ${required.join(', ')}`);
  }
  for (const field of ['name', 'algorithm', 'pem', 'pemCrc32c']) {
    if (typeof response[field] !== 'string' || response[field].length === 0) {
      throw new Error(`KMS getPublicKey response has invalid ${field}`);
    }
  }
  if (
    Object.hasOwn(response, 'protectionLevel') &&
    (typeof response.protectionLevel !== 'string' || response.protectionLevel.length === 0)
  ) {
    throw new Error('KMS getPublicKey response has invalid protectionLevel');
  }
  if (
    Object.hasOwn(response, 'publicKeyFormat') &&
    !['PUBLIC_KEY_FORMAT_UNSPECIFIED', 'PEM'].includes(response.publicKeyFormat)
  ) {
    throw new Error('KMS getPublicKey response must use the PEM field');
  }
  return response;
}

export async function pinPublicKeyFromResponse(request, deps) {
  if (typeof deps?.getPublicKey !== 'function') {
    throw new Error('an injected provisioning-only getPublicKey reader is required');
  }
  let calls = 0;
  const record = await fetchPinnedPublicKey(request, {
    getPublicKey: async (name) => {
      calls += 1;
      if (calls > 1) throw new Error('public-key provisioning may read exactly one KMS version');
      return validateKmsPublicKeyResponse(await deps.getPublicKey(name));
    },
  });
  if (calls !== 1) throw new Error('public-key provisioning must read exactly one KMS version');
  return record;
}

async function defaultReadText(path) {
  return readFile(path === '-' ? 0 : path, 'utf8');
}

export async function runPinPublicKeyCli(args, deps = {}) {
  const { request, kmsResponsePath } = parsePinPublicKeyArgs(args);
  const readText = deps.readText ?? defaultReadText;
  const writeStdout = deps.writeStdout ?? ((text) => process.stdout.write(text));
  let response;
  try {
    response = JSON.parse(await readText(kmsResponsePath));
  } catch (error) {
    throw new Error('KMS getPublicKey response must be valid JSON', { cause: error });
  }
  const record = await pinPublicKeyFromResponse(request, {
    getPublicKey: async (name) => {
      if (response?.name !== name) throw new Error('KMS response is not for the requested version');
      return response;
    },
  });
  writeStdout(`${JSON.stringify(record, null, 2)}\n`);
  return record;
}

const isMain =
  typeof process.argv[1] === 'string' && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url));

if (isMain) {
  if (process.argv.length === 3 && process.argv[2] === '--help') {
    process.stdout.write(`${PIN_PUBLIC_KEY_USAGE}\n`);
  } else {
    runPinPublicKeyCli(process.argv.slice(2)).catch((error) => {
      process.stderr.write(`${error.message}\n${PIN_PUBLIC_KEY_USAGE}\n`);
      process.exitCode = 1;
    });
  }
}
