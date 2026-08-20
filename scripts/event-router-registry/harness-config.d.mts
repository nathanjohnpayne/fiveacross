export type HarnessServiceBinding = {
  binding: 'REGISTRY';
  service: 'five-across-event-registry';
  entrypoint: 'RegistryLookupEntrypoint';
};

export function validateHarnessServiceBinding(config: string): HarnessServiceBinding;
