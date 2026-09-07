const REQUIRED_ENTRYPOINT = 'RegistryLookupEntrypoint';
const REGISTRY_SERVICE = 'five-across-event-registry';

function parseStringValue(block, key) {
  const matches = [...block.matchAll(new RegExp(`^\\s*${key}\\s*=\\s*"([^"]*)"\\s*$`, 'gm'))];
  if (matches.length !== 1) return null;
  return matches[0][1];
}

/**
 * The registry's lookup binding, validated from a Wrangler configuration.
 *
 * ONE validator, two consumers — the private synthetic harness and the public
 * Event router — for the same reason `src/slug.ts` is one list with two
 * consumers: the two configurations make the same capability claim, and two
 * validators that could disagree about what "bound to the lookup entrypoint"
 * means would let the more permissive one ship. An omitted or `default`
 * entrypoint binds the registry's default export instead, which is the signed
 * sync/audit/recovery control plane, so both spellings are refused here rather
 * than left to review.
 */
export function validateRegistryLookupBinding(config, subject) {
  const serviceBlocks = config.split(/^\s*\[\[services\]\]\s*$/m);
  if (serviceBlocks.length !== 2) {
    throw new Error(`${subject} must bind exactly once to ${REQUIRED_ENTRYPOINT}`);
  }
  const block = serviceBlocks[1];
  const binding = parseStringValue(block, 'binding');
  const service = parseStringValue(block, 'service');
  const entrypoint = parseStringValue(block, 'entrypoint');
  if (binding !== 'REGISTRY' || service !== REGISTRY_SERVICE || entrypoint !== REQUIRED_ENTRYPOINT) {
    throw new Error(`${subject} must bind explicitly to ${REQUIRED_ENTRYPOINT}`);
  }
  return { binding, service, entrypoint };
}

export function validateHarnessServiceBinding(config) {
  return validateRegistryLookupBinding(config, 'harness');
}

export function validateRouterServiceBinding(config) {
  return validateRegistryLookupBinding(config, 'the Event router');
}
