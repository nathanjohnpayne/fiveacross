const REQUIRED_ENTRYPOINT = 'RegistryLookupEntrypoint';

function parseStringValue(block, key) {
  const matches = [...block.matchAll(new RegExp(`^\\s*${key}\\s*=\\s*"([^"]*)"\\s*$`, 'gm'))];
  if (matches.length !== 1) return null;
  return matches[0][1];
}

export function validateHarnessServiceBinding(config) {
  const serviceBlocks = config.split(/^\s*\[\[services\]\]\s*$/m);
  if (serviceBlocks.length !== 2) {
    throw new Error(`harness must bind exactly once to ${REQUIRED_ENTRYPOINT}`);
  }
  const block = serviceBlocks[1];
  const binding = parseStringValue(block, 'binding');
  const service = parseStringValue(block, 'service');
  const entrypoint = parseStringValue(block, 'entrypoint');
  if (
    binding !== 'REGISTRY' ||
    service !== 'five-across-event-registry' ||
    entrypoint !== REQUIRED_ENTRYPOINT
  ) {
    throw new Error(`harness must bind explicitly to ${REQUIRED_ENTRYPOINT}`);
  }
  return { binding, service, entrypoint };
}
